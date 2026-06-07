// remote.rs — Embedded HTTP + WebSocket server for mobile remote control
use crate::AppState;
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use rust_embed::Embed;
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex};
use tokio_tungstenite::tungstenite::Message;

// ── Embedded PWA static files ──────────────────────────────────
#[derive(Embed)]
#[folder = "remote-ui/"]
struct RemoteAssets;

// ── Types ──────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteServerState {
    pub running: bool,
    pub pin: String,
    pub port: u16,
    pub ip: String,
    pub connected_clients: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

pub struct RemoteServer {
    pub shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    pub pin: String,
    pub port: u16,
    pub event_tx: broadcast::Sender<String>,
    pub client_count: Arc<Mutex<usize>>,
}

impl Default for RemoteServer {
    fn default() -> Self {
        let (event_tx, _) = broadcast::channel::<String>(256);
        Self {
            shutdown_tx: None,
            pin: String::new(),
            port: 9395,
            event_tx,
            client_count: Arc::new(Mutex::new(0)),
        }
    }
}

// ── PIN generation ─────────────────────────────────────────────
pub fn generate_pin() -> String {
    let mut rng = rand::thread_rng();
    format!("{:04}", rng.gen_range(0..10000))
}

// ── Get LAN IP ─────────────────────────────────────────────────
pub fn get_local_ip() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

// ── MIME type helper ───────────────────────────────────────────
fn mime_for_path(path: &str) -> &'static str {
    if path.ends_with(".html") { "text/html; charset=utf-8" }
    else if path.ends_with(".css") { "text/css; charset=utf-8" }
    else if path.ends_with(".js") { "application/javascript; charset=utf-8" }
    else if path.ends_with(".json") { "application/json" }
    else if path.ends_with(".png") { "image/png" }
    else if path.ends_with(".ico") { "image/x-icon" }
    else if path.ends_with(".svg") { "image/svg+xml" }
    else { "application/octet-stream" }
}

// ── Start the remote server ────────────────────────────────────
pub async fn start_server(
    app_handle: AppHandle,
    port: u16,
    pin: String,
    event_tx: broadcast::Sender<String>,
    client_count: Arc<Mutex<usize>>,
    mut shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("[Remote] Failed to bind to port {}: {}", port, e);
            return;
        }
    };
    log::info!("[Remote] Server listening on {}", addr);

    loop {
        tokio::select! {
            _ = &mut shutdown_rx => {
                log::info!("[Remote] Server shutting down");
                break;
            }
            result = listener.accept() => {
                match result {
                    Ok((stream, addr)) => {
                        let app = app_handle.clone();
                        let pin = pin.clone();
                        let etx = event_tx.clone();
                        let cc = Arc::clone(&client_count);
                        tokio::spawn(async move {
                            handle_connection(stream, addr, app, pin, etx, cc).await;
                        });
                    }
                    Err(e) => {
                        log::error!("[Remote] Accept error: {}", e);
                    }
                }
            }
        }
    }
}

// ── Handle a single TCP connection (HTTP or WebSocket) ─────────
async fn handle_connection(
    stream: tokio::net::TcpStream,
    addr: SocketAddr,
    app_handle: AppHandle,
    pin: String,
    event_tx: broadcast::Sender<String>,
    client_count: Arc<Mutex<usize>>,
) {
    // Peek at the first bytes to decide: is this an HTTP upgrade or a plain HTTP request?
    // We use hyper for HTTP parsing
    let io = hyper_util::rt::TokioIo::new(stream);

    let app = app_handle.clone();
    let pin_clone = pin.clone();
    let etx = event_tx.clone();
    let cc = Arc::clone(&client_count);

    let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
        let app = app.clone();
        let pin = pin_clone.clone();
        let etx = etx.clone();
        let cc = Arc::clone(&cc);
        async move {
            handle_request(req, addr, app, pin, etx, cc).await
        }
    });

    if let Err(e) = hyper::server::conn::http1::Builder::new()
        .serve_connection(io, service)
        .with_upgrades()
        .await
    {
        if !e.to_string().contains("connection closed") {
            log::error!("[Remote] Connection error from {}: {}", addr, e);
        }
    }
}

type HttpResponse = hyper::Response<http_body_util::Full<hyper::body::Bytes>>;

// ── Route HTTP requests ────────────────────────────────────────
async fn handle_request(
    req: hyper::Request<hyper::body::Incoming>,
    addr: SocketAddr,
    app_handle: AppHandle,
    pin: String,
    event_tx: broadcast::Sender<String>,
    client_count: Arc<Mutex<usize>>,
) -> Result<HttpResponse, std::convert::Infallible> {
    let path = req.uri().path().to_string();

    // WebSocket upgrade for /ws
    if path == "/ws" {
        // Check for WebSocket upgrade headers
        let is_upgrade = req.headers()
            .get("upgrade")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_lowercase().contains("websocket"))
            .unwrap_or(false);

        if is_upgrade {
            return handle_ws_upgrade(req, addr, app_handle, pin, event_tx, client_count).await;
        }
    }

    // Serve static files
    let file_path = if path == "/" || path.is_empty() {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    if let Some(file) = RemoteAssets::get(file_path) {
        let mime = mime_for_path(file_path);
        let response = hyper::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Cache-Control", "no-cache")
            .header("Access-Control-Allow-Origin", "*")
            .body(http_body_util::Full::new(hyper::body::Bytes::from(file.data.to_vec())))
            .unwrap();
        Ok(response)
    } else {
        let response = hyper::Response::builder()
            .status(404)
            .header("Content-Type", "text/plain")
            .body(http_body_util::Full::new(hyper::body::Bytes::from("404 Not Found")))
            .unwrap();
        Ok(response)
    }
}

// ── WebSocket upgrade + handler ────────────────────────────────
async fn handle_ws_upgrade(
    req: hyper::Request<hyper::body::Incoming>,
    addr: SocketAddr,
    app_handle: AppHandle,
    pin: String,
    event_tx: broadcast::Sender<String>,
    client_count: Arc<Mutex<usize>>,
) -> Result<HttpResponse, std::convert::Infallible> {
    // Derive the WebSocket accept key
    let ws_key = req.headers()
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let _version = req.headers()
        .get("sec-websocket-version")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("13")
        .to_string();

    // Compute the accept key manually
    use std::io::Write;
    let mut hasher_input = Vec::new();
    write!(hasher_input, "{}258EAFA5-E914-47DA-95CA-C5AB0DC85B11", ws_key).unwrap();

    // Use a simple SHA-1 from tokio_tungstenite's dependency
    let accept_key = tokio_tungstenite::tungstenite::handshake::derive_accept_key(ws_key.as_bytes());

    // We need to spawn the WebSocket handler after the upgrade
    let app = app_handle.clone();
    let pin = pin.clone();
    let etx = event_tx.clone();
    let cc = Arc::clone(&client_count);

    tokio::spawn(async move {
        // Wait a moment for the upgrade to complete, then get the connection via hyper's upgrade
        match hyper::upgrade::on(req).await {
            Ok(upgraded) => {
                let io = hyper_util::rt::TokioIo::new(upgraded);
                let ws_stream = tokio_tungstenite::WebSocketStream::from_raw_socket(
                    io,
                    tokio_tungstenite::tungstenite::protocol::Role::Server,
                    None,
                ).await;

                log::info!("[Remote] WebSocket connected from {}", addr);
                handle_websocket(ws_stream, addr, app, pin, etx, cc).await;
            }
            Err(e) => {
                log::error!("[Remote] WebSocket upgrade failed from {}: {}", addr, e);
            }
        }
    });

    // Return the 101 Switching Protocols response
    let response = hyper::Response::builder()
        .status(101)
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Accept", accept_key)
        .body(http_body_util::Full::new(hyper::body::Bytes::new()))
        .unwrap();

    Ok(response)
}

// ── WebSocket session handler ──────────────────────────────────
async fn handle_websocket<S>(
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
    addr: SocketAddr,
    app_handle: AppHandle,
    pin: String,
    event_tx: broadcast::Sender<String>,
    client_count: Arc<Mutex<usize>>,
)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut ws_tx, mut ws_rx) = ws_stream.split();
    let mut authenticated = false;
    let mut event_rx = event_tx.subscribe();

    // Increment client count
    {
        let mut count = client_count.lock().await;
        *count += 1;
    }
    emit_remote_status(&app_handle).await;

    loop {
        tokio::select! {
            // Messages from the mobile client
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                            if ws_msg.msg_type == "auth" {
                                if ws_msg.pin.as_deref() == Some(&pin) {
                                    authenticated = true;
                                    let resp = serde_json::json!({
                                        "type": "auth_result",
                                        "success": true
                                    });
                                    let _ = ws_tx.send(Message::Text(resp.to_string().into())).await;

                                    // Send initial state snapshot
                                    if let Some(snapshot) = build_state_snapshot(&app_handle).await {
                                        let _ = ws_tx.send(Message::Text(snapshot.into())).await;
                                    }
                                } else {
                                    let resp = serde_json::json!({
                                        "type": "auth_result",
                                        "success": false,
                                        "message": "Invalid PIN"
                                    });
                                    let _ = ws_tx.send(Message::Text(resp.to_string().into())).await;
                                }
                            } else if ws_msg.msg_type == "set_config" && authenticated {
                                if let Some(data) = ws_msg.data {
                                    let result = dispatch_set_config(data, &app_handle).await;
                                    if let Err(e) = result {
                                        let resp = serde_json::json!({
                                            "type": "error",
                                            "message": e
                                        });
                                        let _ = ws_tx.send(Message::Text(resp.to_string().into())).await;
                                    }
                                }
                            } else if ws_msg.msg_type == "command" && authenticated {
                                if let Some(action) = &ws_msg.action {
                                    let result = dispatch_command(action, ws_msg.data.clone(), &app_handle).await;
                                    if let Err(e) = result {
                                        let resp = serde_json::json!({
                                            "type": "error",
                                            "message": e
                                        });
                                        let _ = ws_tx.send(Message::Text(resp.to_string().into())).await;
                                    }
                                }
                            } else if !authenticated {
                                let resp = serde_json::json!({
                                    "type": "error",
                                    "message": "Not authenticated. Send auth message first."
                                });
                                let _ = ws_tx.send(Message::Text(resp.to_string().into())).await;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ws_tx.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    Some(Err(e)) => {
                        log::error!("[Remote] WebSocket error from {}: {}", addr, e);
                        break;
                    }
                    _ => {}
                }
            }
            // Events from the backend to forward to authenticated clients
            event = event_rx.recv() => {
                if authenticated {
                    match event {
                        Ok(json_str) => {
                            if ws_tx.send(Message::Text(json_str.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            log::warn!("[Remote] Client {} lagged by {} events", addr, n);
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    }

    log::info!("[Remote] WebSocket disconnected from {}", addr);

    // Decrement client count
    {
        let mut count = client_count.lock().await;
        *count = count.saturating_sub(1);
    }
    emit_remote_status(&app_handle).await;
}

// ── Dispatch commands from mobile client ───────────────────────
async fn dispatch_command(
    action: &str,
    data: Option<serde_json::Value>,
    app_handle: &AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();

    match action {
        "start_poll" => {
            // Same logic as the start_poll command
            {
                let mut poll = state.poll.lock().await;
                poll.status = crate::poll::PollStatus::Running;
                let update = poll.build_update();
                let _ = app_handle.emit("poll_update", &update);
                crate::broadcast_poll_update(&state, &update).await;
            }

            let auth = state.auth.lock().await;
            if let Some(token) = &auth.access_token {
                let token = token.clone();
                drop(auth);

                let (tx, rx) = tokio::sync::broadcast::channel::<crate::websocket::WsControl>(4);
                {
                    let mut ws_mgr = state.ws_manager.lock().await;
                    if let Some(old_tx) = &ws_mgr.control_tx {
                        let _ = old_tx.send(crate::websocket::WsControl::Stop);
                    }
                    ws_mgr.control_tx = Some(tx);
                }

                let poll_arc = Arc::clone(&state.poll);
                let app_clone = app_handle.clone();
                tokio::spawn(async move {
                    crate::websocket::run_websocket(token, poll_arc, app_clone, rx).await;
                });
            } else {
                drop(auth);
                return Err("Not authenticated with Restream.".to_string());
            }
            Ok(())
        }
        "pause_poll" => {
            let mut poll = state.poll.lock().await;
            if poll.status == crate::poll::PollStatus::Running {
                poll.status = crate::poll::PollStatus::Paused;
                let update = poll.build_update();
                drop(poll);
                let _ = app_handle.emit("poll_update", &update);
                crate::broadcast_poll_update(&state, &update).await;
            }
            Ok(())
        }
        "resume_poll" => {
            let mut poll = state.poll.lock().await;
            if poll.status == crate::poll::PollStatus::Paused {
                poll.status = crate::poll::PollStatus::Running;
                let update = poll.build_update();
                drop(poll);
                let _ = app_handle.emit("poll_update", &update);
                crate::broadcast_poll_update(&state, &update).await;
            }
            Ok(())
        }
        "stop_poll" => {
            // Stop WebSocket
            {
                let ws_mgr = state.ws_manager.lock().await;
                if let Some(tx) = &ws_mgr.control_tx {
                    let _ = tx.send(crate::websocket::WsControl::Stop);
                }
            }

            let (update, history_entry) = {
                let mut poll = state.poll.lock().await;

                let entry = if poll.total_votes > 0 {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let snapshot = poll.build_update();
                    Some(crate::poll::PollHistoryEntry {
                        id: format!("hist_{}", now),
                        timestamp: now,
                        question: snapshot.question.clone(),
                        results: snapshot.options.clone(),
                        total_votes: snapshot.total_votes,
                    })
                } else {
                    None
                };

                poll.status = crate::poll::PollStatus::Idle;
                poll.reset_votes();
                let update = poll.build_update();
                (update, entry)
            };

            let _ = app_handle.emit("poll_update", &update);
            crate::broadcast_poll_update(&state, &update).await;

            if let Some(entry) = history_entry {
                {
                    let mut hist = state.poll_history.lock().await;
                    hist.insert(0, entry);
                }
                crate::persist_history(app_handle, &state).await;
                let _ = app_handle.emit("history_updated", serde_json::json!({}));
            }
            Ok(())
        }
        "reset_poll" => {
            let mut poll = state.poll.lock().await;
            poll.reset_votes();
            let update = poll.build_update();
            drop(poll);
            let _ = app_handle.emit("poll_update", &update);
            crate::broadcast_poll_update(&state, &update).await;
            Ok(())
        }
        "next_poll" => {
            // Stop WebSocket
            {
                let ws_mgr = state.ws_manager.lock().await;
                if let Some(tx) = &ws_mgr.control_tx {
                    let _ = tx.send(crate::websocket::WsControl::Stop);
                }
            }

            // Snapshot current poll into history
            let history_entry = {
                let mut poll = state.poll.lock().await;
                let entry = if poll.total_votes > 0 {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let snapshot = poll.build_update();
                    Some(crate::poll::PollHistoryEntry {
                        id: format!("hist_{}", now),
                        timestamp: now,
                        question: snapshot.question.clone(),
                        results: snapshot.options.clone(),
                        total_votes: snapshot.total_votes,
                    })
                } else {
                    None
                };
                poll.status = crate::poll::PollStatus::Idle;
                entry
            };

            if let Some(entry) = history_entry {
                {
                    let mut hist = state.poll_history.lock().await;
                    hist.insert(0, entry);
                }
                crate::persist_history(app_handle, &state).await;
                let _ = app_handle.emit("history_updated", serde_json::json!({}));
            }

            let poll_id = {
                let mut queue = state.poll_queue.lock().await;
                if queue.is_empty() {
                    return Err("Queue is empty".to_string());
                }
                queue.remove(0)
            };

            {
                let mut idx = state.queue_index.lock().await;
                *idx = 0;
            }

            crate::persist_queue(app_handle, &state).await;
            broadcast_queue_update(&state).await;
            let _ = app_handle.emit("queue_updated", serde_json::json!({}));

            let saved_polls = state.saved_polls.lock().await;
            let found = saved_polls.iter().find(|p| p.id == poll_id).cloned();
            drop(saved_polls);

            if let Some(saved) = found {
                {
                    let mut poll = state.poll.lock().await;
                    poll.config = saved.config.clone();
                    poll.total_votes = 0;
                    poll.voted_users.clear();
                    for opt in &mut poll.config.options {
                        opt.votes = 0;
                    }
                    let update = poll.build_update();
                    drop(poll);
                    let _ = app_handle.emit("poll_update", &update);
                    crate::broadcast_poll_update(&state, &update).await;
                }

                Ok(())
            } else {
                Err(format!("Poll {} not found in library", poll_id))
            }
        }
        "load_poll" => {
            let poll_id = data.and_then(|v| v.as_str().map(|s| s.to_string()))
                .ok_or_else(|| "Missing poll_id data".to_string())?;

            let saved_polls = state.saved_polls.lock().await;
            let found = saved_polls.iter().find(|p| p.id == poll_id).cloned();
            drop(saved_polls);

            if let Some(saved) = found {
                let mut poll = state.poll.lock().await;
                poll.config = saved.config.clone();
                poll.total_votes = 0;
                poll.voted_users.clear();
                for opt in &mut poll.config.options {
                    opt.votes = 0;
                }
                let update = poll.build_update();
                drop(poll);
                let _ = app_handle.emit("poll_update", &update);
                crate::broadcast_poll_update(&state, &update).await;
                Ok(())
            } else {
                Err(format!("Poll {} not found in library", poll_id))
            }
        }
        "set_queue" => {
            let ids_val = data.and_then(|v| v.as_array().cloned())
                .ok_or_else(|| "Missing queue ids array".to_string())?;
            let ids: Vec<String> = ids_val.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();

            {
                let mut queue = state.poll_queue.lock().await;
                *queue = ids;
            }
            {
                let mut idx = state.queue_index.lock().await;
                *idx = 0;
            }
            crate::persist_queue(app_handle, &state).await;

            broadcast_queue_update(&state).await;
            let _ = app_handle.emit("queue_updated", serde_json::json!({}));
            Ok(())
        }
        "save_poll" => {
            let payload = data.ok_or_else(|| "Missing data payload".to_string())?;
            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("Remote Poll").to_string();
            let config_val = payload.get("config").ok_or_else(|| "Missing config data".to_string())?;
            let config: crate::poll::PollConfig = serde_json::from_value(config_val.clone())
                .map_err(|e| format!("Invalid poll config: {}", e))?;

            let id = format!("poll_{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis());
            let saved = crate::poll::SavedPoll { id: id.clone(), name, config };
            {
                let mut polls = state.saved_polls.lock().await;
                polls.push(saved.clone());
            }
            crate::persist_polls(app_handle, &state).await;

            broadcast_library_update(&state).await;
            let _ = app_handle.emit("library_updated", serde_json::json!({}));
            Ok(())
        }
        "save_and_queue" => {
            let payload = data.ok_or_else(|| "Missing data payload".to_string())?;
            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("Remote Poll").to_string();
            let config_val = payload.get("config").ok_or_else(|| "Missing config data".to_string())?;
            let config: crate::poll::PollConfig = serde_json::from_value(config_val.clone())
                .map_err(|e| format!("Invalid poll config: {}", e))?;

            let id = format!("poll_{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis());
            let saved = crate::poll::SavedPoll { id: id.clone(), name, config };
            {
                let mut polls = state.saved_polls.lock().await;
                polls.push(saved.clone());
            }
            {
                let mut queue = state.poll_queue.lock().await;
                queue.push(id.clone());
            }
            crate::persist_polls(app_handle, &state).await;
            crate::persist_queue(app_handle, &state).await;

            broadcast_library_update(&state).await;
            broadcast_queue_update(&state).await;

            let _ = app_handle.emit("library_updated", serde_json::json!({}));
            let _ = app_handle.emit("queue_updated", serde_json::json!({}));
            Ok(())
        }
        "delete_poll" => {
            let poll_id = data.and_then(|v| v.as_str().map(|s| s.to_string()))
                .ok_or_else(|| "Missing poll_id data".to_string())?;

            {
                let mut polls = state.saved_polls.lock().await;
                polls.retain(|p| p.id != poll_id);
            }
            {
                let mut queue = state.poll_queue.lock().await;
                queue.retain(|i| i != &poll_id);
            }
            crate::persist_polls(app_handle, &state).await;
            crate::persist_queue(app_handle, &state).await;

            broadcast_library_update(&state).await;
            broadcast_queue_update(&state).await;

            let _ = app_handle.emit("library_updated", serde_json::json!({}));
            let _ = app_handle.emit("queue_updated", serde_json::json!({}));
            Ok(())
        }
        "get_state" => {
            // State snapshot is sent as part of event forwarding
            Ok(())
        }
        _ => Err(format!("Unknown action: {}", action)),
    }
}

// ── Handle set_config from mobile client ───────────────────────
async fn dispatch_set_config(data: serde_json::Value, app_handle: &AppHandle) -> Result<(), String> {
    let state = app_handle.state::<AppState>();

    // Parse the incoming config
    let question = data.get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let options_val = data.get("options")
        .and_then(|v| v.as_array())
        .ok_or("Missing options array")?;

    if options_val.is_empty() {
        return Err("At least one option is required".to_string());
    }

    let colors = ["#6c63ff", "#ff6584", "#43e97b", "#f59e0b", "#a78bfa", "#ec4899", "#06b6d4", "#84cc16"];

    let new_options: Vec<crate::poll::PollOption> = options_val.iter().enumerate().map(|(i, opt)| {
        let label = opt.get("label").and_then(|v| v.as_str()).unwrap_or("Option").to_string();
        let keywords: Vec<String> = opt.get("keywords")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|k| k.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_else(|| vec![format!("{}", i + 1)]);
        let color = opt.get("color").and_then(|v| v.as_str())
            .unwrap_or(colors[i % colors.len()])
            .to_string();
        let id = opt.get("id").and_then(|v| v.as_str())
            .unwrap_or(&format!("opt{}", i + 1))
            .to_string();

        crate::poll::PollOption {
            id,
            label,
            keywords,
            color,
            votes: 0,
        }
    }).collect();

    // Apply the new config (same logic as set_poll_config command)
    let mut poll = state.poll.lock().await;
    let old_votes: std::collections::HashMap<String, u64> = poll
        .config
        .options
        .iter()
        .map(|o| (o.id.clone(), o.votes))
        .collect();

    poll.config.question = question;
    poll.config.options = new_options;

    // Preserve vote counts for options with matching IDs
    for option in &mut poll.config.options {
        if let Some(&votes) = old_votes.get(&option.id) {
            option.votes = votes;
        }
    }
    poll.total_votes = poll.config.options.iter().map(|o| o.votes).sum();

    let update = poll.build_update();
    drop(poll);

    let _ = app_handle.emit("poll_update", &update);
    crate::broadcast_poll_update(&state, &update).await;

    // Also broadcast the updated config so editor stays in sync
    let poll2 = state.poll.lock().await;
    let remote = state.remote.lock().await;
    if remote.shutdown_tx.is_some() {
        let config_data = serde_json::json!({
            "question": poll2.config.question,
            "options": poll2.config.options.iter().map(|o| serde_json::json!({
                "id": o.id,
                "label": o.label,
                "keywords": o.keywords,
                "color": o.color
            })).collect::<Vec<_>>()
        });
        crate::remote::broadcast_event(&remote.event_tx, "config_update", &config_data);
    }

    Ok(())
}

// ── Build a full state snapshot for the mobile client ──────────
async fn build_state_snapshot(app_handle: &AppHandle) -> Option<String> {
    let state = app_handle.try_state::<AppState>()?;
    let poll = state.poll.lock().await;
    let poll_update = poll.build_update();
    drop(poll);

    let auth = state.auth.lock().await;
    let is_auth = auth.is_authenticated;
    drop(auth);

    let poll2 = state.poll.lock().await;
    let config_data = serde_json::json!({
        "question": poll2.config.question,
        "options": poll2.config.options.iter().map(|o| serde_json::json!({
            "id": o.id,
            "label": o.label,
            "keywords": o.keywords,
            "color": o.color
        })).collect::<Vec<_>>()
    });
    drop(poll2);

    let saved_polls = state.saved_polls.lock().await.clone();
    let queue = state.poll_queue.lock().await.clone();
    let queue_idx = *state.queue_index.lock().await;

    let snapshot = serde_json::json!({
        "type": "state_snapshot",
        "data": {
            "poll": poll_update,
            "config": config_data,
            "auth_status": is_auth,
            "saved_polls": saved_polls,
            "queue": queue,
            "queue_index": queue_idx
        }
    });

    Some(snapshot.to_string())
}

// ── Emit remote status event to desktop UI ─────────────────────
async fn emit_remote_status(app_handle: &AppHandle) {
    if let Some(state) = app_handle.try_state::<AppState>() {
        let remote = state.remote.lock().await;
        let count = *remote.client_count.lock().await;
        let status = RemoteServerState {
            running: remote.shutdown_tx.is_some(),
            pin: remote.pin.clone(),
            port: remote.port,
            ip: get_local_ip(),
            connected_clients: count,
        };
        drop(remote);
        let _ = app_handle.emit("remote_status", &status);
    }
}

// ── Public: broadcast an event to all connected mobile clients ─
pub fn broadcast_event(event_tx: &broadcast::Sender<String>, event_type: &str, data: &serde_json::Value) {
    let msg = serde_json::json!({
        "type": event_type,
        "data": data
    });
    // Ignore errors (no subscribers = no clients connected)
    let _ = event_tx.send(msg.to_string());
}

pub async fn broadcast_library_update(state: &AppState) {
    let remote = state.remote.lock().await;
    if remote.shutdown_tx.is_some() {
        let saved_polls = state.saved_polls.lock().await.clone();
        broadcast_event(&remote.event_tx, "library_update", &serde_json::to_value(saved_polls).unwrap_or_default());
    }
}

pub async fn broadcast_queue_update(state: &AppState) {
    let remote = state.remote.lock().await;
    if remote.shutdown_tx.is_some() {
        let queue = state.poll_queue.lock().await.clone();
        let idx = *state.queue_index.lock().await;
        let data = serde_json::json!({
            "queue": queue,
            "queue_index": idx
        });
        broadcast_event(&remote.event_tx, "queue_update", &data);
    }
}

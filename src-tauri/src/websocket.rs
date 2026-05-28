// websocket.rs — Restream Chat WebSocket client
use crate::poll::PollState;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::{Mutex, broadcast};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Deserialize)]
struct RestreamEvent {
    action: Option<String>,
    #[serde(rename = "eventType")]
    event_type: Option<String>,
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub enum WsControl {
    Stop,
}

pub struct WebSocketManager {
    pub control_tx: Option<broadcast::Sender<WsControl>>,
}

impl Default for WebSocketManager {
    fn default() -> Self {
        Self { control_tx: None }
    }
}

pub async fn run_websocket(
    access_token: String,
    poll_state: Arc<Mutex<PollState>>,
    app_handle: tauri::AppHandle,
    mut control_rx: broadcast::Receiver<WsControl>,
) {
    let url = format!(
        "wss://chat.api.restream.io/ws?accessToken={}",
        access_token
    );

    let mut retry_delay = 1u64;
    const MAX_RETRY: u64 = 30;

    loop {
        log::info!("Connecting to Restream WebSocket...");
        let _ = app_handle.emit("ws_status", "connecting");

        match connect_async(&url).await {
            Ok((ws_stream, _)) => {
                log::info!("WebSocket connected");
                retry_delay = 1;
                let _ = app_handle.emit("ws_status", "connected");

                let (mut write, mut read) = ws_stream.split();

                loop {
                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    // Handle heartbeat inline so we can use `write`
                                    if text.contains("\"heartbeat\"") {
                                        let _ = write.send(Message::Text(
                                            r#"{"action":"heartbeat"}"#.to_string().into()
                                        )).await;
                                    }
                                    handle_message(text.as_str(), &poll_state, &app_handle).await;
                                }
                                Some(Ok(Message::Ping(data))) => {
                                    let _ = write.send(Message::Pong(data)).await;
                                }
                                Some(Ok(Message::Close(_))) | None => {
                                    log::warn!("WebSocket closed by server");
                                    break;
                                }
                                Some(Err(e)) => {
                                    log::error!("WebSocket error: {}", e);
                                    break;
                                }
                                _ => {}
                            }
                        }
                        ctrl = control_rx.recv() => {
                            match ctrl {
                                Ok(WsControl::Stop) | Err(_) => {
                                    log::info!("WebSocket stopping by control signal");
                                    let _ = write.send(Message::Close(None)).await;
                                    let _ = app_handle.emit("ws_status", "disconnected");
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("WebSocket connection failed: {}", e);
            }
        }

        let _ = app_handle.emit("ws_status", "reconnecting");

        // Check for stop signal during retry wait
        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_secs(retry_delay)) => {}
            ctrl = control_rx.recv() => {
                match ctrl {
                    Ok(WsControl::Stop) | Err(_) => {
                        let _ = app_handle.emit("ws_status", "disconnected");
                        return;
                    }
                }
            }
        }

        retry_delay = (retry_delay * 2).min(MAX_RETRY);
    }
}

async fn handle_message(
    text: &str,
    poll_state: &Arc<Mutex<PollState>>,
    app_handle: &tauri::AppHandle,
) {
    // Log every raw message for debugging (truncated to 500 chars)
    let preview = if text.len() > 500 { &text[..500] } else { text };
    log::info!("[WS RAW] {}", preview);

    let event: RestreamEvent = match serde_json::from_str(text) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[WS] Failed to parse message: {} | raw: {}", e, preview);
            return;
        }
    };

    // Restream uses either "action" or "eventType" field
    let action = event.action.as_deref()
        .or(event.event_type.as_deref())
        .unwrap_or("");

    log::info!("[WS] action='{}'", action);

    match action {
        // Platform chat (YouTube, Twitch, etc) — action="event", text in payload.eventPayload
        "event" | "chatMessage" | "chat_message" => {
            if let Some(payload) = &event.payload {
                if let Some(inner) = payload.get("eventPayload") {
                    process_chat_event(inner, poll_state, app_handle).await;
                } else {
                    process_chat_event(payload, poll_state, app_handle).await;
                }
            }
        }
        // Restream Studio dashboard messages — action="reply_created", text in payload.text
        "reply_created" => {
            if let Some(payload) = &event.payload {
                process_chat_event(payload, poll_state, app_handle).await;
            }
        }
        "connection_info" | "connectionInfo" => {
            log::info!("[WS] Connection info: {:?}", event.payload);
        }
        // Heartbeat is handled inline in the loop
        "heartbeat" => {}
        other => {
            log::info!("[WS] Unhandled action: '{}'", other);
        }
    }
}

async fn process_chat_event(
    payload: &serde_json::Value,
    poll_state: &Arc<Mutex<PollState>>,
    app_handle: &tauri::AppHandle,
) {
    log::info!("[WS] Processing chat event payload: {}", payload);

    // Restream chat message format:
    // { "action": "chatMessage", "payload": { "text": "...", "user": { "name": "...", "platform": "twitch" }, "messageId": "..." } }
    let author = payload
        .get("user")
        .and_then(|u| u.get("name").or_else(|| u.get("displayName")).or_else(|| u.get("username")))
        .and_then(|v| v.as_str())
        // fallbacks for older/alternative formats
        .or_else(|| payload.get("author").and_then(|a| a.get("username").or_else(|| a.get("displayName")).or_else(|| a.get("name"))).and_then(|v| v.as_str()))
        .or_else(|| payload.get("authorName").and_then(|v| v.as_str()))
        .or_else(|| payload.get("username").and_then(|v| v.as_str()))
        .unwrap_or("unknown");

    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("message").and_then(|v| v.as_str()))
        .or_else(|| payload.get("body").and_then(|v| v.as_str()))
        .unwrap_or("");

    let platform = payload
        .get("user").and_then(|u| u.get("platform")).and_then(|v| v.as_str())
        .or_else(|| payload.get("platform").and_then(|v| v.as_str()))
        .or_else(|| payload.get("channelId").and_then(|v| v.as_str()))
        .unwrap_or("unknown");

    log::info!("[WS] Chat: author='{}' text='{}' platform='{}'", author, text, platform);

    if text.is_empty() {
        return;
    }

    // Emit raw chat message to frontend for debug log
    let chat_msg = serde_json::json!({
        "author": author,
        "text": text,
        "platform": platform,
        "matched": serde_json::Value::Null
    });
    let _ = app_handle.emit("chat_message", &chat_msg);

    // Process through poll engine
    let mut state = poll_state.lock().await;
    if let Some(update) = state.process_message(author, text) {
        drop(state);
        let _ = app_handle.emit("poll_update", &update);
    }
}

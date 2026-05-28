// lib.rs — Tauri app builder, state, and command registration
mod auth;
mod poll;
mod settings;
mod websocket;

use auth::AuthState;
use poll::{PollConfig, PollHistoryEntry, PollState, PollStatus, PollUpdate, SavedPoll};
use settings::AppSettings;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex, broadcast};
use websocket::{WebSocketManager, WsControl};

pub struct AppState {
    pub poll: Arc<Mutex<PollState>>,
    pub auth: Arc<Mutex<AuthState>>,
    pub settings: Arc<Mutex<AppSettings>>,
    pub ws_manager: Arc<Mutex<WebSocketManager>>,
    pub saved_polls: Arc<Mutex<Vec<SavedPoll>>>,
    pub poll_queue: Arc<Mutex<Vec<String>>>,      // ordered list of saved poll IDs
    pub queue_index: Arc<Mutex<usize>>,            // current position in queue
    pub poll_history: Arc<Mutex<Vec<PollHistoryEntry>>>,
}

// ─────────────────────────────────────────────────────────────
// Poll Commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn start_poll(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut poll = state.poll.lock().await;
        poll.status = PollStatus::Running;
        let update = poll.build_update();
        let _ = app_handle.emit("poll_update", &update);
    }

    // Connect WebSocket if we have a token
    let auth = state.auth.lock().await;
    if let Some(token) = &auth.access_token {
        let token = token.clone();
        drop(auth);

        let (tx, rx) = broadcast::channel::<WsControl>(4);
        {
            let mut ws_mgr = state.ws_manager.lock().await;
            // Stop any existing connection
            if let Some(old_tx) = &ws_mgr.control_tx {
                let _ = old_tx.send(WsControl::Stop);
            }
            ws_mgr.control_tx = Some(tx);
        }

        let poll_arc = Arc::clone(&state.poll);
        let app_clone = app_handle.clone();
        tokio::spawn(async move {
            websocket::run_websocket(token, poll_arc, app_clone, rx).await;
        });
    } else {
        drop(auth);
        return Err("Not authenticated. Please connect to Restream first.".to_string());
    }

    Ok(())
}

#[tauri::command]
async fn pause_poll(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut poll = state.poll.lock().await;
    if poll.status == PollStatus::Running {
        poll.status = PollStatus::Paused;
        let update = poll.build_update();
        drop(poll);
        let _ = app_handle.emit("poll_update", &update);
    }
    Ok(())
}

#[tauri::command]
async fn resume_poll(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut poll = state.poll.lock().await;
    if poll.status == PollStatus::Paused {
        poll.status = PollStatus::Running;
        let update = poll.build_update();
        drop(poll);
        let _ = app_handle.emit("poll_update", &update);
    }
    Ok(())
}

#[tauri::command]
async fn stop_poll(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Stop WebSocket
    {
        let ws_mgr = state.ws_manager.lock().await;
        if let Some(tx) = &ws_mgr.control_tx {
            let _ = tx.send(WsControl::Stop);
        }
    }

    let (update, history_entry) = {
        let mut poll = state.poll.lock().await;

        // Snapshot results before stopping (only if there were votes)
        let entry = if poll.total_votes > 0 {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let snapshot = poll.build_update();
            Some(PollHistoryEntry {
                id: format!("hist_{}", now),
                timestamp: now,
                question: snapshot.question.clone(),
                results: snapshot.options.clone(),
                total_votes: snapshot.total_votes,
            })
        } else {
            None
        };

        poll.status = PollStatus::Idle;
        poll.reset_votes();
        let update = poll.build_update();
        (update, entry)
    };

    let _ = app_handle.emit("poll_update", &update);

    // Save to history
    if let Some(entry) = history_entry {
        {
            let mut hist = state.poll_history.lock().await;
            hist.insert(0, entry); // newest first
        }
        persist_history(&app_handle, &state).await;
        let _ = app_handle.emit("history_updated", serde_json::json!({}));
    }

    Ok(())
}

#[tauri::command]
async fn reset_poll(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut poll = state.poll.lock().await;
    poll.reset_votes();
    let update = poll.build_update();
    drop(poll);
    let _ = app_handle.emit("poll_update", &update);
    Ok(())
}

#[tauri::command]
async fn set_poll_config(
    config: PollConfig,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut poll = state.poll.lock().await;
    // Preserve vote counts if IDs match
    let old_votes: std::collections::HashMap<String, u64> = poll
        .config
        .options
        .iter()
        .map(|o| (o.id.clone(), o.votes))
        .collect();

    poll.config = config;
    for option in &mut poll.config.options {
        if let Some(&votes) = old_votes.get(&option.id) {
            option.votes = votes;
        }
    }
    // Recalculate total
    poll.total_votes = poll.config.options.iter().map(|o| o.votes).sum();
    let update = poll.build_update();
    drop(poll);
    let _ = app_handle.emit("poll_update", &update);
    Ok(())
}

#[tauri::command]
async fn get_poll_config(state: State<'_, AppState>) -> Result<PollConfig, String> {
    let poll = state.poll.lock().await;
    Ok(poll.config.clone())
}

#[tauri::command]
async fn get_poll_update(state: State<'_, AppState>) -> Result<PollUpdate, String> {
    let poll = state.poll.lock().await;
    Ok(poll.build_update())
}

// ─────────────────────────────────────────────────────────────
// Poll Library & Queue Commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_saved_polls(state: State<'_, AppState>) -> Result<Vec<SavedPoll>, String> {
    let polls = state.saved_polls.lock().await;
    Ok(polls.clone())
}

#[tauri::command]
async fn save_poll(
    name: String,
    config: PollConfig,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<SavedPoll, String> {
    let id = format!("poll_{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());
    let saved = SavedPoll { id: id.clone(), name, config };
    {
        let mut polls = state.saved_polls.lock().await;
        polls.push(saved.clone());
    }
    persist_polls(&app_handle, &state).await;
    Ok(saved)
}

#[tauri::command]
async fn delete_poll(
    id: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut polls = state.saved_polls.lock().await;
        polls.retain(|p| p.id != id);
    }
    // Also remove from queue
    {
        let mut queue = state.poll_queue.lock().await;
        queue.retain(|i| i != &id);
    }
    persist_polls(&app_handle, &state).await;
    persist_queue(&app_handle, &state).await;
    Ok(())
}

#[tauri::command]
async fn get_queue(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let queue = state.poll_queue.lock().await;
    Ok(queue.clone())
}

#[tauri::command]
async fn set_queue(
    ids: Vec<String>,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut queue = state.poll_queue.lock().await;
        *queue = ids;
    }
    // Reset queue index to 0 when queue is changed
    {
        let mut idx = state.queue_index.lock().await;
        *idx = 0;
    }
    persist_queue(&app_handle, &state).await;
    Ok(())
}

#[tauri::command]
async fn next_poll_in_queue(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // Stop current poll + WebSocket
    {
        let ws_mgr = state.ws_manager.lock().await;
        if let Some(tx) = &ws_mgr.control_tx {
            let _ = tx.send(WsControl::Stop);
        }
    }

    // Snapshot current poll into history (if it has votes)
    let history_entry = {
        let mut poll = state.poll.lock().await;
        let entry = if poll.total_votes > 0 {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let snapshot = poll.build_update();
            Some(PollHistoryEntry {
                id: format!("hist_{}", now),
                timestamp: now,
                question: snapshot.question.clone(),
                results: snapshot.options.clone(),
                total_votes: snapshot.total_votes,
            })
        } else {
            None
        };
        poll.status = PollStatus::Idle;
        entry
    };

    if let Some(entry) = history_entry {
        {
            let mut hist = state.poll_history.lock().await;
            hist.insert(0, entry);
        }
        persist_history(&app_handle, &state).await;
        let _ = app_handle.emit("history_updated", serde_json::json!({}));
    }

    let queue = state.poll_queue.lock().await.clone();
    if queue.is_empty() {
        return Err("Queue is empty".to_string());
    }

    let idx = {
        let i = state.queue_index.lock().await.clone();
        i
    };

    if idx >= queue.len() {
        return Err("End of queue reached".to_string());
    }

    let poll_id = &queue[idx];
    let saved_polls = state.saved_polls.lock().await;
    let found = saved_polls.iter().find(|p| &p.id == poll_id).cloned();
    drop(saved_polls);

    if let Some(saved) = found {
        // Load config into active poll (fresh votes)
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
        }

        // Advance index
        {
            let mut i = state.queue_index.lock().await;
            *i += 1;
        }

        let next_idx = state.queue_index.lock().await.clone();
        Ok(serde_json::json!({
            "loaded": saved.name,
            "remaining": queue.len().saturating_sub(next_idx)
        }))
    } else {
        Err(format!("Poll {} not found in library", poll_id))
    }
}

async fn persist_polls(app_handle: &AppHandle, state: &AppState) {
    let polls = state.saved_polls.lock().await;
    let store = tauri_plugin_store::StoreBuilder::new(app_handle, "polls.json").build();
    if let Ok(store) = store {
        let _ = store.set("saved_polls", serde_json::to_value(&*polls).unwrap_or_default());
        let _ = store.save();
    }
}

async fn persist_queue(app_handle: &AppHandle, state: &AppState) {
    let queue = state.poll_queue.lock().await;
    let store = tauri_plugin_store::StoreBuilder::new(app_handle, "polls.json").build();
    if let Ok(store) = store {
        let _ = store.set("poll_queue", serde_json::to_value(&*queue).unwrap_or_default());
        let _ = store.save();
    }
}

async fn persist_history(app_handle: &AppHandle, state: &AppState) {
    let hist = state.poll_history.lock().await;
    let store = tauri_plugin_store::StoreBuilder::new(app_handle, "history.json").build();
    if let Ok(store) = store {
        let _ = store.set("poll_history", serde_json::to_value(&*hist).unwrap_or_default());
        let _ = store.save();
    }
}

#[tauri::command]
async fn get_history(state: State<'_, AppState>) -> Result<Vec<PollHistoryEntry>, String> {
    let hist = state.poll_history.lock().await;
    Ok(hist.clone())
}

#[tauri::command]
async fn clear_history(app_handle: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut hist = state.poll_history.lock().await;
        hist.clear();
    }
    persist_history(&app_handle, &state).await;
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Auth Commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn login(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (client_id, client_secret) = {
        let settings = state.settings.lock().await;
        (settings.client_id.clone(), settings.client_secret.clone())
    };

    if client_id.is_empty() || client_secret.is_empty() {
        return Err("Client ID and Client Secret must be set in Connection settings.".to_string());
    }

    let auth_arc = Arc::clone(&state.auth);
    let app_for_opener = app_handle.clone();

    match auth::start_oauth_flow(&client_id, &client_secret, auth_arc, move |url| {
        use tauri_plugin_opener::OpenerExt;
        app_for_opener
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| format!("Failed to open browser: {}", e))
    })
    .await
    {
        Ok(token) => {
            // Save tokens to store
            save_tokens_to_store(&app_handle, &state).await;
            let _ = app_handle.emit("auth_status", serde_json::json!({"authenticated": true}));
            Ok(token)
        }
        Err(e) => {
            let _ = app_handle.emit("auth_status", serde_json::json!({"authenticated": false, "error": e}));
            Err(e)
        }
    }
}

#[tauri::command]
async fn logout(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Stop WebSocket first
    {
        let ws_mgr = state.ws_manager.lock().await;
        if let Some(tx) = &ws_mgr.control_tx {
            let _ = tx.send(WsControl::Stop);
        }
    }

    let mut auth = state.auth.lock().await;
    *auth = AuthState::default();
    drop(auth);

    let _ = app_handle.emit("auth_status", serde_json::json!({"authenticated": false}));
    Ok(())
}

#[tauri::command]
async fn force_refresh(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (client_id, client_secret) = {
        let settings = state.settings.lock().await;
        (settings.client_id.clone(), settings.client_secret.clone())
    };

    let rt = {
        let auth = state.auth.lock().await;
        auth.refresh_token.clone()
    };

    if let Some(refresh_tok) = rt {
        let auth_arc = Arc::clone(&state.auth);
        match auth::refresh_token(&refresh_tok, &client_id, &client_secret, auth_arc).await {
            Ok(_) => {
                save_tokens_to_store(&app_handle, &state).await;
                let _ = app_handle.emit("auth_status", serde_json::json!({"authenticated": true}));
                Ok(())
            }
            Err(e) => Err(e),
        }
    } else {
        Err("No refresh token available. Please connect again.".to_string())
    }
}

#[tauri::command]
async fn get_auth_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let auth = state.auth.lock().await;
    Ok(serde_json::json!({
        "authenticated": auth.is_authenticated,
        "expires_at": auth.expires_at
    }))
}

async fn save_tokens_to_store(app_handle: &AppHandle, state: &AppState) {
    let auth = state.auth.lock().await;
    let store = tauri_plugin_store::StoreBuilder::new(app_handle, "auth.json").build();
    if let Ok(store) = store {
        if let Some(token) = &auth.access_token {
            let _ = store.set("access_token", serde_json::Value::String(token.clone()));
        }
        if let Some(token) = &auth.refresh_token {
            let _ = store.set("refresh_token", serde_json::Value::String(token.clone()));
        }
        if let Some(exp) = auth.expires_at {
            let _ = store.set("expires_at", serde_json::json!(exp));
        }
        let _ = store.save();
    }
}

// ─────────────────────────────────────────────────────────────
// Settings Commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().await;
    Ok(settings.clone())
}

#[tauri::command]
async fn save_settings(
    new_settings: AppSettings,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().await;
        *settings = new_settings.clone();
    }

    // Persist to store
    let store = tauri_plugin_store::StoreBuilder::new(&app_handle, "settings.json").build();
    if let Ok(store) = store {
        let _ = store.set("settings", serde_json::to_value(&new_settings).unwrap());
        let _ = store.save();
    }

    let _ = app_handle.emit("settings_updated", &new_settings);
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Window Commands
// ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn set_always_on_top(
    enabled: bool,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().await;
        settings.always_on_top = enabled;
    }
    if let Some(window) = app_handle.get_webview_window("poll-overlay") {
        window
            .set_always_on_top(enabled)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn set_click_through(
    enabled: bool,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let mut settings = state.settings.lock().await;
        settings.click_through = enabled;
    }
    if let Some(window) = app_handle.get_webview_window("poll-overlay") {
        window
            .set_ignore_cursor_events(enabled)
            .map_err(|e| e.to_string())?;
    }
    let _ = app_handle.emit("click_through_changed", enabled);
    Ok(())
}

#[tauri::command]
async fn register_keybind(
    shortcut: String,
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // Save keybind
    {
        let mut settings = state.settings.lock().await;
        settings.click_through_keybind = shortcut.clone();
    }

    // Try to unregister any old shortcut first
    let _ = app_handle.global_shortcut().unregister_all();

    let app_clone = app_handle.clone();

    // Register new shortcut
    app_handle
        .global_shortcut()
        .on_shortcut(shortcut.as_str(), move |_app, _shortcut, _event| {
            let app = app_clone.clone();
            tauri::async_runtime::spawn(async move {
                let _ = app.emit("toggle_click_through", ());
            });
        })
        .map_err(|e| format!("Failed to register shortcut: {}", e))?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────
// Token Auto-Refresh
// ─────────────────────────────────────────────────────────────

/// Spawns a background task that checks every 5 minutes whether the
/// access token is about to expire (within 10 minutes) and refreshes
/// it silently using the saved refresh token. Users never need to
/// manually reconnect as long as they have a valid refresh token.
fn spawn_token_refresh_task(app_handle: AppHandle) {
    tokio::spawn(async move {
        let mut first_run = true;
        loop {
            if first_run {
                // On startup: wait a moment for state to fully load, then check immediately.
                // This handles the case where the app hasn't been opened in days and
                // the access token has expired (but the refresh token is still valid).
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                first_run = false;
            } else {
                tokio::time::sleep(tokio::time::Duration::from_secs(300)).await; // every 5 min
            }

            let (refresh_tok, client_id, client_secret, expires_at, is_auth) = {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let auth = state.auth.lock().await;
                    let settings = state.settings.lock().await;
                    (
                        auth.refresh_token.clone(),
                        settings.client_id.clone(),
                        settings.client_secret.clone(),
                        auth.expires_at,
                        auth.is_authenticated,
                    )
                } else {
                    continue;
                }
            };

            if !is_auth {
                continue; // not logged in, nothing to refresh
            }

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            // Refresh if token expires within 10 minutes
            let should_refresh = expires_at.map(|exp| exp < now + 600).unwrap_or(false);

            if !should_refresh {
                continue;
            }

            let Some(rt) = refresh_tok else {
                log::warn!("[Auth] Token expiring but no refresh token available — user must reconnect");
                let _ = app_handle.emit("auth_status", serde_json::json!({"authenticated": false, "error": "Token expired. Please reconnect."}));
                continue;
            };

            if client_id.is_empty() || client_secret.is_empty() {
                continue;
            }

            log::info!("[Auth] Access token expiring soon, refreshing automatically...");

            if let Some(state) = app_handle.try_state::<AppState>() {
                let auth_arc = Arc::clone(&state.auth);
                match auth::refresh_token(&rt, &client_id, &client_secret, auth_arc).await {
                    Ok(_) => {
                        log::info!("[Auth] Token refreshed successfully");
                        // Persist the new tokens
                        let auth_store = tauri_plugin_store::StoreBuilder::new(&app_handle, "auth.json").build();
                        if let Ok(store) = auth_store {
                            let auth = state.auth.lock().await;
                            if let Some(t) = &auth.access_token {
                                let _ = store.set("access_token", serde_json::Value::String(t.clone()));
                            }
                            if let Some(t) = &auth.refresh_token {
                                let _ = store.set("refresh_token", serde_json::Value::String(t.clone()));
                            }
                            if let Some(exp) = auth.expires_at {
                                let _ = store.set("expires_at", serde_json::json!(exp));
                            }
                            let _ = store.save();
                        }
                    }
                    Err(e) => {
                        log::error!("[Auth] Token refresh failed: {}", e);
                        let _ = app_handle.emit("auth_status", serde_json::json!({"authenticated": false, "error": "Token refresh failed. Please reconnect."}));
                    }
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────
// App Entry Point
// ─────────────────────────────────────────────────────────────

pub fn run() {
    let poll_state = Arc::new(Mutex::new(PollState::default()));
    let auth_state = Arc::new(Mutex::new(AuthState::default()));
    let settings_state = Arc::new(Mutex::new(AppSettings::default()));
    let ws_manager = Arc::new(Mutex::new(WebSocketManager::default()));
    let saved_polls = Arc::new(Mutex::new(Vec::<SavedPoll>::new()));
    let poll_queue = Arc::new(Mutex::new(Vec::<String>::new()));
    let queue_index = Arc::new(Mutex::new(0usize));
    let poll_history = Arc::new(Mutex::new(Vec::<PollHistoryEntry>::new()));

    let app_state = AppState {
        poll: Arc::clone(&poll_state),
        auth: Arc::clone(&auth_state),
        settings: Arc::clone(&settings_state),
        ws_manager: Arc::clone(&ws_manager),
        saved_polls: Arc::clone(&saved_polls),
        poll_queue: Arc::clone(&poll_queue),
        queue_index: Arc::clone(&queue_index),
        poll_history: Arc::clone(&poll_history),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            // Poll
            start_poll,
            pause_poll,
            resume_poll,
            stop_poll,
            reset_poll,
            set_poll_config,
            get_poll_config,
            get_poll_update,
            // Library & Queue
            get_saved_polls,
            save_poll,
            delete_poll,
            get_queue,
            set_queue,
            next_poll_in_queue,
            // History
            get_history,
            clear_history,
            // Auth
            login,
            logout,
            force_refresh,
            get_auth_status,
            // Settings
            get_settings,
            save_settings,
            // Window
            set_always_on_top,
            set_click_through,
            register_keybind,
        ])
        .setup(|app| {
            // Load persisted settings on startup
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                load_persisted_state(&app_handle).await;
                // Start background token auto-refresh after state is loaded
                spawn_token_refresh_task(app_handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn load_persisted_state(app_handle: &AppHandle) {
    // Load settings
    let store = tauri_plugin_store::StoreBuilder::new(app_handle, "settings.json").build();
    if let Ok(store) = store {
        if let Some(val) = store.get("settings") {
            if let Ok(settings) = serde_json::from_value::<AppSettings>(val.clone()) {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    let mut s = state.settings.lock().await;
                    // Apply always-on-top from saved settings
                    let aot = settings.always_on_top;
                    *s = settings;
                    drop(s);
                    // poll-overlay window doesn't exist yet on startup — it applies
                    // settings (including always-on-top) when it first opens.
                }
            }
        }
    }

    // Load auth tokens
    let auth_store = tauri_plugin_store::StoreBuilder::new(app_handle, "auth.json").build();
    if let Ok(auth_store) = auth_store {
        if let Some(state) = app_handle.try_state::<AppState>() {
            let mut auth = state.auth.lock().await;
            if let Some(val) = auth_store.get("access_token") {
                auth.access_token = val.as_str().map(String::from);
            }
            if let Some(val) = auth_store.get("refresh_token") {
                auth.refresh_token = val.as_str().map(String::from);
            }
            if let Some(val) = auth_store.get("expires_at") {
                auth.expires_at = val.as_u64();
            }
            auth.is_authenticated = auth.access_token.is_some();

            let is_auth = auth.is_authenticated;
            drop(auth);
            let _ = app_handle.emit("auth_status", serde_json::json!({"authenticated": is_auth}));
        }
    }

    // Emit initial poll state
    if let Some(state) = app_handle.try_state::<AppState>() {
        let poll = state.poll.lock().await;
        let update = poll.build_update();
        drop(poll);
        let _ = app_handle.emit("poll_update", &update);

        // Emit settings
        let settings = state.settings.lock().await;
        let _ = app_handle.emit("settings_updated", &*settings);
    }

    // Load saved polls and queue
    let polls_store = tauri_plugin_store::StoreBuilder::new(app_handle, "polls.json").build();
    if let Ok(polls_store) = polls_store {
        if let Some(state) = app_handle.try_state::<AppState>() {
            if let Some(val) = polls_store.get("saved_polls") {
                if let Ok(polls) = serde_json::from_value::<Vec<SavedPoll>>(val.clone()) {
                    let mut sp = state.saved_polls.lock().await;
                    *sp = polls;
                }
            }
            if let Some(val) = polls_store.get("poll_queue") {
                if let Ok(queue) = serde_json::from_value::<Vec<String>>(val.clone()) {
                    let mut pq = state.poll_queue.lock().await;
                    *pq = queue;
                }
            }
        }
    }

    // Load poll history
    let hist_store = tauri_plugin_store::StoreBuilder::new(app_handle, "history.json").build();
    if let Ok(hist_store) = hist_store {
        if let Some(state) = app_handle.try_state::<AppState>() {
            if let Some(val) = hist_store.get("poll_history") {
                if let Ok(hist) = serde_json::from_value::<Vec<PollHistoryEntry>>(val.clone()) {
                    let mut ph = state.poll_history.lock().await;
                    *ph = hist;
                }
            }
        }
    }
}

// auth.rs — OAuth 2.0 flow with local redirect server
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AuthState {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<u64>, // Unix timestamp
    pub is_authenticated: bool,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
pub struct AuthStatus {
    pub is_authenticated: bool,
    pub access_token: Option<String>,
}

/// Returns the auth URL so the caller can open it with tauri-plugin-opener
pub fn build_auth_url(client_id: &str) -> (String, String) {
    let redirect_uri = "http://localhost:17394/callback";
    let state_token = generate_state_token();
    let auth_url = format!(
        "https://api.restream.io/login?response_type=code&client_id={}&redirect_uri={}&scope=chat%3Aread&state={}",
        client_id,
        urlencoding::encode(redirect_uri),
        state_token
    );
    (auth_url, state_token)
}

pub async fn start_oauth_flow(
    client_id: &str,
    client_secret: &str,
    auth_state: Arc<Mutex<AuthState>>,
    auth_url_opened: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    let redirect_uri = "http://localhost:17394/callback";
    let (auth_url, state_token) = build_auth_url(client_id);

    // Open browser via caller-supplied opener (avoids cmd /c start & quoting issues)
    auth_url_opened(&auth_url)?;

    // Start local callback server
    let code = start_callback_server(17394, &state_token).await?;

    // Exchange code for tokens
    let tokens = exchange_code_for_tokens(&code, client_id, client_secret, redirect_uri).await?;

    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + tokens.expires_in.unwrap_or(3600);

    let mut state = auth_state.lock().await;
    state.access_token = Some(tokens.access_token.clone());
    state.refresh_token = tokens.refresh_token;
    state.expires_at = Some(expires_at);
    state.is_authenticated = true;

    Ok(tokens.access_token)
}

async fn start_callback_server(port: u16, expected_state: &str) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .await
        .map_err(|e| format!("Failed to bind callback server: {}", e))?;

    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("Failed to accept connection: {}", e))?;

    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]).to_string();

    // Parse the GET line for ?code=...&state=...
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");
    let query = path.split('?').nth(1).unwrap_or("");

    let mut code = None;
    let mut state = None;
    for param in query.split('&') {
        let mut parts = param.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let val = parts.next().unwrap_or("");
        match key {
            "code" => code = Some(val.to_string()),
            "state" => state = Some(val.to_string()),
            _ => {}
        }
    }

    // Send success response
    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
        <html><body style='font-family:sans-serif;background:#0f0f1e;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>\
        <div style='text-align:center'><h1 style='color:#6c63ff'>✓ Authorization Successful</h1>\
        <p>You can close this window and return to Stream Poll.</p></div></body></html>";
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| e.to_string())?;

    let code = code.ok_or("No authorization code received")?;
    let returned_state = state.ok_or("No state parameter received")?;

    if returned_state != expected_state {
        return Err("State mismatch — possible CSRF attack".to_string());
    }

    Ok(code)
}

async fn exchange_code_for_tokens(
    code: &str,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", redirect_uri),
    ];

    let response = client
        .post("https://api.restream.io/oauth/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Token exchange error: {}", body));
    }

    response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

#[allow(dead_code)]
pub async fn refresh_token(
    refresh_tok: &str,
    client_id: &str,
    client_secret: &str,
    auth_state: Arc<Mutex<AuthState>>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_tok),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ];

    let response = client
        .post("https://api.restream.io/oauth/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Refresh failed: {}", e))?;

    let tokens: TokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {}", e))?;

    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + tokens.expires_in.unwrap_or(3600);

    let mut state = auth_state.lock().await;
    state.access_token = Some(tokens.access_token.clone());
    if let Some(rt) = tokens.refresh_token {
        state.refresh_token = Some(rt);
    }
    state.expires_at = Some(expires_at);
    state.is_authenticated = true;

    Ok(tokens.access_token)
}

fn generate_state_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}", ts)
}

// Simple URL encoding helper (avoid extra dep)
mod urlencoding {
    pub fn encode(input: &str) -> String {
        let mut encoded = String::new();
        for byte in input.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    encoded.push(byte as char);
                }
                _ => {
                    encoded.push_str(&format!("%{:02X}", byte));
                }
            }
        }
        encoded
    }
}

use pocket_serve_manager::api_client::Auth;
use pocket_serve_manager::server::{AppState, serve_app};
use tracing::{info};
use tracing_subscriber::{EnvFilter, fmt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    fmt().with_env_filter(EnvFilter::from_default_env()).init();

    info!("pocket-serve-manager starting");

    // The port opencode serve listens on
    let opencode_port: u16 = std::env::var("POCKET_OPencode_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4096);

    // The port this manager listens on (for the TS bot)
    let manager_port: u16 = std::env::var("POCKET_MANAGER_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4097);

    // Shared secret for the manager API (required in production)
    let manager_token = std::env::var("POCKET_MANAGER_TOKEN").ok();

    // Serve binary: try `opencode` from PATH, fall back to desktop CLI
    let serve_binary = std::env::var("POCKET_SERVE_BINARY")
        .ok()
        .map(|v| v.split_whitespace().map(String::from).collect::<Vec<_>>())
        .unwrap_or_else(default_serve_binary);

    info!("opencode port={} manager port={} token_set={}", opencode_port, manager_port, manager_token.is_some());

    // Build the HTTP server app
    let state = AppState::new(opencode_port, serve_binary.clone(), Auth::from_env(), manager_token.clone());
    state.ensure_running().await;
    let app = serve_app(state);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", manager_port)).await?;
    info!("manager HTTP server listening on 127.0.0.1:{}", manager_port);

    axum::serve(listener, app).await?;
    Ok(())
}

fn default_serve_binary() -> Vec<String> {
    // Check if `opencode.exe` is on PATH
    let check = std::process::Command::new("cmd")
        .args(["/c", "where opencode.exe >nul 2>&1"])
        .output();
    if let Ok(out) = check {
        if out.status.success() {
            return vec!["cmd".into(), "/c".into(), "opencode".into(), "serve".into()];
        }
    }
    // Fall back to the opencode desktop app CLI
    vec![
        "cmd".into(),
        "/c".into(),
        r#"C:/Users/Admin/AppData/Roaming/ai.opencode.desktop/cli/2.2.0-x64/opencode-cli.exe"#.into(),
        "serve".into(),
    ]
}

use axum::{
    extract::{Path, Request, State, WebSocketUpgrade},
    http::{header, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{error, info, warn};

use crate::api_client::{ApiClient, Auth, PromptRequest};
use crate::serve_manager::ServeManager;

/// Shared application state.
#[derive(Clone)]
pub struct AppState {
    pub manager: Arc<ServeManager>,
    pub api: ApiClient,
    pub manager_token: Option<String>,
}

impl AppState {
    pub fn new(port: u16, serve_binary: Vec<String>, auth: Auth, manager_token: Option<String>) -> Self {
        Self {
            manager: Arc::new(ServeManager::new(port, serve_binary)),
            api: ApiClient::new(port, auth),
            manager_token,
        }
    }

    /// Ensure opencode serve is running (logs error but does not abort startup).
    pub async fn ensure_running(&self) {
        match self.manager.ensure_running().await {
            Ok(()) => info!("opencode serve is healthy"),
            Err(e) => error!("failed to start opencode serve: {}", e),
        }
    }
}

/// Build the axum router with all routes.
pub fn serve_app(state: AppState) -> Router {
    let token = state.manager_token.clone();

    // Restrict CORS to same-origin (127.0.0.1) — never permissive on a control plane.
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin("http://127.0.0.1".parse::<axum::http::HeaderValue>().unwrap())
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    Router::new()
        .route("/health", get(health_handler))
        .route("/serve/health", get(serve_health_handler))
        .route("/sessions", get(list_sessions_handler).post(create_session_handler))
        .route(
            "/sessions/{session_id}/prompt",
            post(prompt_handler).get(prompt_ws_handler),
        )
        .route("/sessions/{session_id}/diff", get(diff_handler))
        .route(
            "/sessions/{session_id}/interrupt",
            post(interrupt_handler),
        )
        .route("/models", get(models_handler))
        .route("/agents", get(agents_handler))
        // Bearer-token auth middleware (no-op when POCKET_MANAGER_TOKEN is unset)
        .layer(middleware::from_fn(move |request: Request, next: middleware::Next| {
            let token = token.clone();
            async move {
                if let Some(t) = &token {
                    let expected = format!("Bearer {}", t);
                    let auth = request
                        .headers()
                        .get(header::AUTHORIZATION)
                        .and_then(|v| v.to_str().ok());
                    if auth != Some(expected.as_str()) {
                        warn!("manager API request rejected: missing or invalid bearer token");
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                }
                Ok(next.run(request).await)
            }
        }))
        .layer(cors)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

/// GET /health — manager health.
async fn health_handler() -> impl IntoResponse {
    Json(HealthResponse { status: "ok".to_string() })
}

/// GET /serve/health — opencode serve health.
async fn serve_health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let health = state.api.health().await;
    let status = match health {
        crate::serve_manager::HealthState::Ok => "ok",
        crate::serve_manager::HealthState::Auth => "auth",
        crate::serve_manager::HealthState::Down => "down",
    };
    Json(ServeHealthResponse {
        status: status.to_string(),
    })
}

/// POST /sessions — create a session.
#[derive(Deserialize)]
pub struct CreateSessionBody {
    pub title: Option<String>,
}

async fn create_session_handler(
    State(state): State<AppState>,
    Json(body): Json<CreateSessionBody>,
) -> Result<Json<CreateSessionResponse>, StatusCode> {
    match state.api.create_session(body.title).await {
        Ok(id) => Ok(Json(CreateSessionResponse { id })),
        Err(e) => {
            error!("create session failed: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[derive(Serialize)]
pub struct CreateSessionResponse {
    pub id: String,
}

/// GET /sessions — list sessions.
async fn list_sessions_handler(State(state): State<AppState>) -> Result<Json<Vec<crate::api_client::SessionSummary>>, StatusCode> {
    match state.api.list_sessions().await {
        Ok(sessions) => Ok(Json(sessions)),
        Err(e) => {
            error!("list sessions failed: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[derive(Serialize, Clone)]
pub struct SessionSummary {
    pub id: String,
    pub title: Option<String>,
}

/// POST /sessions/{id}/prompt — send a prompt (non-streaming, returns full response).
#[derive(Deserialize)]
pub struct PromptBody {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
}

async fn prompt_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<PromptBody>,
) -> Result<String, StatusCode> {
    let prompt_req = PromptRequest {
        parts: vec![crate::api_client::PromptPart {
            r#type: "text".to_string(),
            text: body.text,
        }],
        model: body.model,
        agent: body.agent,
        system: body.system,
    };
    match state.api.prompt(&session_id, &prompt_req).await {
        Ok(text) => Ok(text),
        Err(e) => {
            error!("prompt failed for session {}: {}", session_id, e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// GET /sessions/{id}/prompt — WebSocket for streaming prompt events.
async fn prompt_ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Response {
    info!("websocket prompt for session {}", session_id);
    ws.on_upgrade(move |socket| {
        let api = state.api.clone();
        async move {
            // For WS streaming we currently just acknowledge the connection.
            // Full streaming prompt body would need to be sent by client over WS first.
            let _ = api;
            let _ = session_id;
            let _ = socket;
        }
    })
}

/// GET /sessions/{id}/diff — get diff.
async fn diff_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<String, StatusCode> {
    match state.api.get_diff(&session_id).await {
        Ok(text) => Ok(text),
        Err(e) => {
            error!("diff failed for session {}: {}", session_id, e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// POST /sessions/{id}/interrupt — abort a session.
async fn interrupt_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Result<(), StatusCode> {
    match state.api.interrupt(&session_id).await {
        Ok(()) => Ok(()),
        Err(e) => {
            error!("interrupt failed for session {}: {}", session_id, e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// GET /models — list models.
async fn models_handler(State(state): State<AppState>) -> Result<Json<crate::api_client::ModelList>, StatusCode> {
    match state.api.list_models().await {
        Ok(models) => Ok(Json(models)),
        Err(e) => {
            error!("list models failed: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// GET /agents — list agents.
async fn agents_handler(State(state): State<AppState>) -> Result<Json<crate::api_client::AgentList>, StatusCode> {
    match state.api.list_agents().await {
        Ok(agents) => Ok(Json(agents)),
        Err(e) => {
            error!("list agents failed: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
}

#[derive(Serialize)]
struct ServeHealthResponse {
    status: String,
}

use crate::serve_manager::{HealthState, ServeManager};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{warn};

/// Authentication for the V2 opencode server.
///
/// V2 uses a single password (`OPENCODE_PASSWORD`) instead of V1's
/// `OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`. Basic auth is sent
/// with username "opencode" and the configured password.
#[derive(Debug, Clone)]
pub struct Auth {
    password: Option<String>,
}

impl Auth {
    pub fn from_env() -> Self {
        let password = std::env::var("OPENCODE_PASSWORD").ok();
        Self { password }
    }

    fn apply(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.password {
            Some(pass) => req.basic_auth("opencode", Some(pass.clone())),
            None => req,
        }
    }
}

/// Server info returned by `GET /api/info`.
#[derive(Debug, Deserialize)]
pub struct ServerInfo {
    pub version: Option<String>,
    #[allow(dead_code)]
    pub status: Option<String>,
}

/// Session summary returned by `GET /api/session`.
#[derive(Debug, Deserialize, Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub title: Option<String>,
}

/// Request to create a session.
#[derive(Debug, Serialize)]
pub struct CreateSessionRequest {
    pub title: Option<String>,
}

/// Response from creating a session.
#[derive(Debug, Deserialize)]
pub struct CreateSessionResponse {
    pub id: String,
}

/// Model listing returned by `GET /api/model`.
#[derive(Debug, Deserialize, Serialize)]
pub struct ModelList {
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ModelEntry {
    pub id: String,
    pub provider_id: Option<String>,
}

/// Agent listing returned by `GET /api/agent`.
#[derive(Debug, Deserialize, Serialize)]
pub struct AgentList {
    pub agents: Vec<AgentEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AgentEntry {
    pub id: String,
    pub name: Option<String>,
}

/// Prompt parts for the V2 API.
#[derive(Debug, Serialize)]
pub struct PromptPart {
    pub r#type: String,
    pub text: String,
}

/// Request body for `POST /api/session/{id}/prompt`.
#[derive(Debug, Serialize)]
pub struct PromptRequest {
    pub parts: Vec<PromptPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
}

/// Client for the opencode V2 HTTP API.
#[derive(Clone)]
pub struct ApiClient {
    base_url: String,
    auth: Auth,
    client: reqwest::Client,
}

impl ApiClient {
    pub fn new(port: u16, auth: Auth) -> Self {
        Self {
            base_url: format!("http://127.0.0.1:{}", port),
            auth,
            client: reqwest::Client::new(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// Health check via `GET /api/info`.
    pub async fn health(&self) -> HealthState {
        match self.client.get(self.url("/api/info")).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    HealthState::Ok
                } else if status == reqwest::StatusCode::UNAUTHORIZED {
                    HealthState::Auth
                } else {
                    HealthState::Down
                }
            }
            Err(e) if e.is_connect() => HealthState::Down,
            Err(_) => HealthState::Down,
        }
    }

    /// Get server info.
    pub async fn server_info(&self) -> anyhow::Result<ServerInfo> {
        let resp = self.auth.apply(self.client.get(self.url("/api/info"))).send().await?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("server info: HTTP {}", resp.status()));
        }
        Ok(resp.json().await?)
    }

    /// Create a session via `POST /api/session`.
    pub async fn create_session(&self, title: Option<String>) -> anyhow::Result<String> {
        let req = CreateSessionRequest { title };
        let resp = self
            .auth
            .apply(self.client.post(self.url("/api/session")).json(&req))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("create session: HTTP {}", resp.status()));
        }
        let parsed: CreateSessionResponse = resp.json().await?;
        Ok(parsed.id)
    }

    /// List sessions via `GET /api/session`.
    pub async fn list_sessions(&self) -> anyhow::Result<Vec<SessionSummary>> {
        let resp = self.auth.apply(self.client.get(self.url("/api/session"))).send().await?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("list sessions: HTTP {}", resp.status()));
        }
        Ok(resp.json().await?)
    }

    /// Send a prompt via `POST /api/session/{id}/prompt`.
    /// Returns raw response text (may be SSE stream or JSON).
    pub async fn prompt(&self, session_id: &str, body: &PromptRequest) -> anyhow::Result<String> {
        let resp = self
            .auth
            .apply(self.client.post(self.url(&format!("/api/session/{}/prompt", session_id))).json(body))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("prompt: HTTP {}", resp.status()));
        }
        Ok(resp.text().await?)
    }

    /// Interrupt (abort) a session via `POST /api/session/{id}/interrupt`.
    pub async fn interrupt(&self, session_id: &str) -> anyhow::Result<()> {
        let resp = self
            .auth
            .apply(self.client.post(self.url(&format!("/api/session/{}/interrupt", session_id))))
            .send()
            .await?;
        if !resp.status().is_success() {
            warn!("interrupt: HTTP {}", resp.status());
        }
        Ok(())
    }

    /// Get diff via `GET /api/session/{id}/diff`.
    pub async fn get_diff(&self, session_id: &str) -> anyhow::Result<String> {
        let resp = self
            .auth
            .apply(self.client.get(self.url(&format!("/api/session/{}/diff", session_id))))
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("diff: HTTP {}", resp.status()));
        }
        Ok(resp.text().await?)
    }

    /// List models via `GET /api/model`.
    pub async fn list_models(&self) -> anyhow::Result<ModelList> {
        let resp = self.auth.apply(self.client.get(self.url("/api/model"))).send().await?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("list models: HTTP {}", resp.status()));
        }
        Ok(resp.json().await?)
    }

    /// List agents via `GET /api/agent`.
    pub async fn list_agents(&self) -> anyhow::Result<AgentList> {
        let resp = self.auth.apply(self.client.get(self.url("/api/agent"))).send().await?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("list agents: HTTP {}", resp.status()));
        }
        Ok(resp.json().await?)
    }
}

/// High-level wrapper combining ServeManager + ApiClient.
pub struct OpencodeService {
    serve_manager: Arc<ServeManager>,
    api_client: ApiClient,
}

impl OpencodeService {
    pub fn new(port: u16, serve_binary: Vec<String>, auth: Auth) -> Self {
        Self {
            serve_manager: Arc::new(ServeManager::new(port, serve_binary)),
            api_client: ApiClient::new(port, auth),
        }
    }

    pub fn serve_manager(&self) -> Arc<ServeManager> {
        self.serve_manager.clone()
    }

    pub fn api_client(&self) -> &ApiClient {
        &self.api_client
    }

    /// Ensure serve is running, then return health state.
    pub async fn ensure_healthy(&self) -> anyhow::Result<HealthState> {
        self.serve_manager.ensure_running().await?;
        Ok(self.api_client.health().await)
    }
}

impl Default for Auth {
    fn default() -> Self {
        Self::from_env()
    }
}

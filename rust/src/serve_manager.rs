use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Child;
use tokio::sync::Mutex;
use tokio::time::sleep;
use tracing::{info, warn};

/// Manages the lifecycle of an `opencode serve` process.
///
/// Responsibilities:
/// - Spawn `opencode serve` on a configured port
/// - Health-check via the V2 `GET /api/info` endpoint
/// - Self-heal: detect auth mismatches (401) and restart the serve process
/// - Refuse to kill non-opencode processes squatting the port
#[derive(Clone)]
pub struct ServeManager {
    port: u16,
    serve_binary: Vec<String>,
    /// Child process handle for the serve we spawned (if any)
    child: Arc<Mutex<Option<Child>>>,
}

impl ServeManager {
    pub fn new(port: u16, serve_binary: Vec<String>) -> Self {
        Self {
            port,
            serve_binary,
            child: Arc::new(Mutex::new(None)),
        }
    }

    /// Ensure opencode serve is healthy on the configured port.
    ///
    /// Tri-state health:
    /// - "ok" (2xx) → already healthy, return
    /// - "auth" (401) → wrong credentials; if an opencode process holds the port, kill it and respawn
    /// - "down" (refused/other) → spawn fresh and poll until healthy
    pub async fn ensure_running(&self) -> anyhow::Result<()> {
        let state = self.health_state().await?;
        match state {
            HealthState::Ok => {
                info!("opencode serve already healthy on port {}", self.port);
                return Ok(());
            }
            HealthState::Auth => {
                info!("opencode serve on port {} rejects credentials — checking port owner", self.port);
                self.handle_auth_mismatch().await?;
            }
            HealthState::Down => {
                info!("opencode serve on port {} is down — spawning fresh", self.port);
            }
        }

        // Spawn fresh serve process
        self.spawn_serve().await?;

        // Poll until healthy (desktop CLI cold-start can be ~90s)
        let timeout = Duration::from_secs(120);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            sleep(Duration::from_millis(500)).await;
            match self.health_state().await? {
                HealthState::Ok => {
                    info!("opencode serve is healthy on port {}", self.port);
                    return Ok(());
                }
                HealthState::Auth => {
                    // Still rejecting credentials after spawn — unexpected, keep trying
                    warn!("opencode serve still rejecting credentials after spawn");
                }
                HealthState::Down => {}
            }
            if tokio::time::Instant::now() > deadline {
                return Err(anyhow::anyhow!(
                    "opencode serve did not come up on port {} within {:?}",
                    self.port,
                    timeout
                ));
            }
        }
    }

    /// Check health of the opencode serve API.
    async fn health_state(&self) -> anyhow::Result<HealthState> {
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/api/info", self.port);
        match client.get(&url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    Ok(HealthState::Ok)
                } else if status == reqwest::StatusCode::UNAUTHORIZED {
                    Ok(HealthState::Auth)
                } else {
                    Ok(HealthState::Down)
                }
            }
            Err(e) if e.is_connect() => Ok(HealthState::Down),
            Err(_) => Ok(HealthState::Down),
        }
    }

    /// Handle an auth mismatch: find the port owner, kill it if it's opencode,
    /// then respawn. Refuse to kill non-opencode processes.
    async fn handle_auth_mismatch(&self) -> anyhow::Result<()> {
        let owner = self.find_port_owner().await;
        match owner {
            None => {
                return Err(anyhow::anyhow!(
                    "opencode serve on port {} rejects credentials and no process was found holding the port — free the port and retry",
                    self.port
                ));
            }
            Some(ref o) if !o.image.to_lowercase().contains("opencode") => {
                return Err(anyhow::anyhow!(
                    "port {} is held by {} (pid {}), not opencode — refusing to kill it. Free the port and retry",
                    self.port, o.image, o.pid
                ));
            }
            Some(o) => {
                info!("killing stale opencode serve pid={} image={}", o.pid, o.image);
                self.kill_pid(o.pid)?;
            }
        }
        Ok(())
    }

    /// Spawn a fresh `opencode serve` process.
    async fn spawn_serve(&self) -> anyhow::Result<()> {
        let mut cmd = if self.serve_binary[0] == "cmd" {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/c");
            for arg in &self.serve_binary[2..] {
                c.arg(arg);
            }
            c
        } else {
            let mut c = tokio::process::Command::new(&self.serve_binary[0]);
            for arg in &self.serve_binary[1..] {
                c.arg(arg);
            }
            c
        };

        cmd.arg("--port")
            .arg(self.port.to_string())
            .arg("--hostname")
            .arg("127.0.0.1")
            .arg("--log-level")
            .arg("WARN")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .stdin(std::process::Stdio::null());

        info!("spawning opencode serve: {:?}", cmd);
        let child = cmd.spawn()?;
        *self.child.lock().await = Some(child);
        Ok(())
    }

    /// Kill the managed child process if any.
    pub async fn stop(&self) -> anyhow::Result<()> {
        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        Ok(())
    }

    /// Find the process owning the TCP port.
    async fn find_port_owner(&self) -> Option<PortOwner> {
        let output = match tokio::process::Command::new("cmd")
            .args(["/c", "netstat", "-ano", "-p", "TCP"])
            .output()
            .await
        {
            Ok(o) => o,
            Err(_) => return None,
        };
        let out = String::from_utf8_lossy(&output.stdout);
        let mut pid: Option<u32> = None;
        for line in out.lines() {
            let caps: Vec<&str> = line.split_whitespace().collect();
            if caps.len() < 5 {
                continue;
            }
            // Format: Proto  Local Address          Foreign Address        State       PID
            // TCP    0.0.0.0:4096             0.0.0.0:0              LISTENING   1234
            let local = caps[1];
            let port_part = local.rsplit(':').next()?;
            let port: u16 = match port_part.trim_end_matches([']', ')']).parse() {
                Ok(p) => p,
                Err(_) => continue,
            };
            if port != self.port {
                continue;
            }
            // State is typically index 3, PID index 4
            pid = caps.last().and_then(|p| p.parse().ok());
            break;
        }

        let pid = pid?;
        let image = self.tasklist_image(pid).await?;
        Some(PortOwner { pid, image })
    }

    /// Query tasklist for the image name of a PID.
    async fn tasklist_image(&self, pid: u32) -> Option<String> {
        let output = tokio::process::Command::new("cmd")
            .args([
                "/c",
                &format!("tasklist /FI \"PID eq {}\" /FO CSV /NH", pid),
            ])
            .output()
            .await
            .ok()?;
        let out = String::from_utf8_lossy(&output.stdout);
        let line = out.lines().next()?;
        // CSV: "opencode.exe","1234","Console",...,"running"
        let image = line.split(',').next()?.trim().trim_matches('"');
        if image.is_empty() {
            None
        } else {
            Some(image.to_string())
        }
    }

    /// Kill a process by PID.
    fn kill_pid(&self, pid: u32) -> anyhow::Result<()> {
        // Use taskkill for reliable Windows process termination
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status()?;
        if status.success() {
            info!("taskkill pid={} succeeded", pid);
        } else {
            warn!("taskkill pid={} returned non-success", pid);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum HealthState {
    Ok,
    Auth,
    Down,
}

#[derive(Debug, Clone)]
struct PortOwner {
    pid: u32,
    image: String,
}

/// In-flight prompt sessions tracked by the manager.
/// Maps session ID -> (opencode session ID, last activity timestamp)
#[derive(Default)]
pub struct SessionMap {
    inner: Mutex<HashMap<String, SessionInfo>>,
}

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub opencode_session_id: String,
    pub last_activity: std::time::SystemTime,
}

impl SessionMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, session_id: String, opencode_session_id: String) {
        self.inner.try_lock().unwrap().insert(
            session_id,
            SessionInfo {
                opencode_session_id,
                last_activity: std::time::SystemTime::now(),
            },
        );
    }

    pub fn get(&self, session_id: &str) -> Option<String> {
        self.inner.try_lock().unwrap().get(session_id).map(|s| s.opencode_session_id.clone())
    }

    pub fn remove(&self, session_id: &str) {
        self.inner.try_lock().unwrap().remove(session_id);
    }
}

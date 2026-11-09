use axum::extract::ws::{Message, WebSocket};
use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use serde::Serialize;
use tracing::{debug, error, info};

/// An SSE event forwarded to a WebSocket client.
#[derive(Debug, Clone, Serialize)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// Proxy an opencode SSE stream into a WebSocket, sending each SSE `data:` line
/// as a JSON text message.
pub async fn proxy_sse_to_websocket(
    client: reqwest::Client,
    url: String,
    headers: Option<HeaderMap>,
    mut ws: WebSocket,
) {
    info!("proxying SSE stream {} -> websocket", url);

    let mut req = client.get(&url);
    if let Some(h) = headers {
        req = req.headers(h);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            error!("SSE request failed: {}", e);
            let _ = ws.send(Message::Close(None)).await;
            return;
        }
    };

    if !resp.status().is_success() {
        error!("SSE stream returned HTTP {}", resp.status());
        let _ = ws.send(Message::Close(None)).await;
        return;
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(idx) = buf.find("\n\n") {
                    let event_block = buf[..idx].to_string();
                    buf.drain(..=idx + 1);
                    if let Some(event) = parse_sse_block(&event_block) {
                        let payload = serde_json::to_string(&event).unwrap_or_default();
                        if ws.send(Message::Text(payload.into())).await.is_err() {
                            debug!("websocket closed, stopping SSE proxy");
                            return;
                        }
                    }
                }
            }
            Err(e) => {
                error!("SSE stream error: {}", e);
                break;
            }
        }
    }

    if !buf.trim().is_empty() {
        if let Some(event) = parse_sse_block(&buf) {
            let payload = serde_json::to_string(&event).unwrap_or_default();
            let _ = ws.send(Message::Text(payload.into())).await;
        }
    }

    let _ = ws.send(Message::Close(None)).await;
    info!("SSE proxy stream ended");
}

/// Parse a raw SSE block into an SseEvent.
fn parse_sse_block(block: &str) -> Option<SseEvent> {
    let mut event: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();

    for line in block.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim());
        }
    }

    if data_lines.is_empty() {
        return None;
    }

    Some(SseEvent {
        event,
        data: data_lines.join("\n"),
    })
}

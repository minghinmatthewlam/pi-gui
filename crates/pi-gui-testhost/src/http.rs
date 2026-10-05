//! One port for both: a request asking to upgrade becomes a WebSocket session; any other
//! request is a file from the built renderer.

use crate::App;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const MAX_HEADER_BYTES: usize = 64 * 1024;

pub async fn serve(app: Rc<App>, mut stream: TcpStream) {
    // Peek, so the WebSocket handshake can read the request itself.
    let mut buffer = vec![0u8; MAX_HEADER_BYTES];
    let head = loop {
        let Ok(read) = stream.peek(&mut buffer).await else {
            return;
        };
        if read == 0 {
            return;
        }
        let bytes = &buffer[..read];
        if let Some(end) = find(bytes, b"\r\n\r\n") {
            break String::from_utf8_lossy(&bytes[..end]).into_owned();
        }
        if read == buffer.len() {
            return;
        }
        // The rest of the header has not arrived yet.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    };
    let is_upgrade = head.lines().skip(1).any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("upgrade:") && lower.contains("websocket")
    });
    if is_upgrade {
        match tokio_tungstenite::accept_async(stream).await {
            Ok(socket) => crate::session::run(app, socket).await,
            Err(error) => eprintln!("[pi-gui-testhost] WebSocket handshake failed: {error}"),
        }
        return;
    }
    let end = find(&buffer, b"\r\n\r\n").unwrap_or(0) + 4;
    let mut consumed = vec![0u8; end];
    if stream.read_exact(&mut consumed).await.is_err() {
        return;
    }
    let target = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/");
    let response = match resolve(&app.renderer_dir, target) {
        Some(path) => match tokio::fs::read(&path).await {
            Ok(body) => response(200, content_type(&path), &body),
            Err(_) => response(404, "text/plain", b"Not found"),
        },
        None => response(404, "text/plain", b"Not found"),
    };
    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The file a request names inside `root`; never outside it.
fn resolve(root: &Path, target: &str) -> Option<PathBuf> {
    let path = target.split(['?', '#']).next().unwrap_or("/");
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let relative = Path::new(path);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return None;
    }
    Some(root.join(relative))
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn response(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let mut bytes = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_stay_inside_the_renderer() {
        let root = Path::new("/r");
        assert_eq!(resolve(root, "/"), Some(PathBuf::from("/r/index.html")));
        assert_eq!(
            resolve(root, "/index.html?testhost=ws://x"),
            Some(PathBuf::from("/r/index.html"))
        );
        assert_eq!(
            resolve(root, "/assets/a.js"),
            Some(PathBuf::from("/r/assets/a.js"))
        );
        assert_eq!(resolve(root, "/../etc/passwd"), None);
    }
}

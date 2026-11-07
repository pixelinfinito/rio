//! Versioned authenticated transport for the Cloudflare review endpoint.
use anyhow::{Context, Result, ensure};
use rio_core::Report;
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
mod snapshot;
pub use snapshot::{
    MAX_BODY_BYTES, MAX_CONTENT_BYTES, MAX_FILE_BYTES, MAX_TREE_PATHS, SnapshotUpload,
    format_bytes, format_count,
};

/// A non-success HTTP status from the endpoint. Bodies are never echoed: they
/// may contain raw provider or tool output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HttpStatus(pub u16);
impl std::fmt::Display for HttpStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Rio endpoint returned HTTP {}", self.0)
    }
}
impl std::error::Error for HttpStatus {}
/// The HTTP status of an endpoint error, if the endpoint answered at all.
pub fn http_status(error: &anyhow::Error) -> Option<u16> {
    error.downcast_ref::<HttpStatus>().map(|status| status.0)
}
/// Endpoint-issued ids are restricted so they cannot alter the request path.
fn path_id(id: &str) -> Result<&str> {
    ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "invalid id {id:?}"
    );
    Ok(id)
}
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: reqwest::Url,
    token: String,
}
impl Client {
    pub fn new(endpoint: &str, token: String) -> Result<Self> {
        let mut base = reqwest::Url::parse(endpoint)?;
        ensure!(
            base.scheme() == "https"
                || (base.scheme() == "http"
                    && matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))),
            "endpoint requires HTTPS (except loopback)"
        );
        ensure!(
            base.username().is_empty()
                && base.password().is_none()
                && base.query().is_none()
                && base.fragment().is_none(),
            "endpoint must not contain credentials, query or fragment"
        );
        ensure!(
            token.len() >= 24,
            "RIO_API_TOKEN must contain at least 24 characters"
        );
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base,
            token,
        })
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let body = body
            .map(serde_json::to_vec)
            .transpose()?
            .map(|body| ("application/json", body));
        self.send_url(method, self.base.join(path)?, body, None)
            .await
    }
    async fn send_url(
        &self,
        method: reqwest::Method,
        url: reqwest::Url,
        body: Option<(&str, Vec<u8>)>,
        timeout: Option<Duration>,
    ) -> Result<Value> {
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(&self.token)
            .header("rio-protocol", "1");
        if let Some((content_type, body)) = body {
            request = request.header("content-type", content_type).body(body);
        }
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let mut response = request.send().await.context("contacting Rio endpoint")?;
        let status = response.status();
        // Do not echo server bodies: they may contain raw provider or tool output.
        if !status.is_success() {
            return Err(HttpStatus(status.as_u16()).into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= 16 * 1024 * 1024,
                "endpoint response too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    pub async fn submit(&self, submission: &Value) -> Result<String> {
        let result = self
            .request(reqwest::Method::POST, "v1/reviews", Some(submission))
            .await?;
        let id = result["id"]
            .as_str()
            .context("review response omitted id")?;
        ensure!(
            id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "invalid review id"
        );
        Ok(id.into())
    }
    pub async fn cancel(&self, id: &str) -> Result<()> {
        self.request(
            reqwest::Method::POST,
            &format!("v1/reviews/{id}/cancel"),
            Some(&json!({})),
        )
        .await?;
        Ok(())
    }
    pub async fn wait(
        &self,
        id: &str,
        cancellation: CancellationToken,
        timeout: Duration,
    ) -> Result<Report> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if cancellation.is_cancelled() || tokio::time::Instant::now() >= deadline {
                self.cancel(id).await?;
                anyhow::bail!(
                    "endpoint review cancelled; partial evidence is retained at review {id}"
                );
            }
            let status = self
                .request(reqwest::Method::GET, &format!("v1/reviews/{id}"), None)
                .await?;
            match status["status"].as_str() {
                Some("complete" | "partial") => {
                    return Ok(serde_json::from_value(
                        self.request(
                            reqwest::Method::GET,
                            &format!("v1/reviews/{id}/report"),
                            None,
                        )
                        .await?,
                    )?);
                }
                Some("error" | "cancelled") => {
                    anyhow::bail!("endpoint review did not complete: {id}")
                }
                Some("queued" | "running") => {}
                _ => anyhow::bail!("unknown endpoint review status"),
            }
            tokio::select! { _=cancellation.cancelled()=>{}, _=tokio::time::sleep(Duration::from_secs(1))=>{} }
        }
    }
    /// Current generation of a lineage (`GET /v1/lineages`), or `None` when the
    /// endpoint has no such lineage (HTTP 404).
    pub async fn lineage(
        &self,
        repository: &str,
        kind: &str,
        reference: &str,
    ) -> Result<Option<Value>> {
        let mut url = self.base.join("v1/lineages")?;
        url.query_pairs_mut()
            .append_pair("repository", repository)
            .append_pair("kind", kind)
            .append_pair("ref", reference);
        match self.send_url(reqwest::Method::GET, url, None, None).await {
            Ok(value) => Ok(Some(value)),
            Err(error) if http_status(&error) == Some(404) => Ok(None),
            Err(error) => Err(error),
        }
    }
    /// Records an author response (`POST /v1/findings/{id}/feedback`).
    pub async fn feedback(&self, id: &str, body: &Value) -> Result<Value> {
        self.request(
            reqwest::Method::POST,
            &format!("v1/findings/{}/feedback", path_id(id)?),
            Some(body),
        )
        .await
    }
    pub async fn audit(&self, id: &str) -> Result<Value> {
        self.request(
            reqwest::Method::GET,
            &format!("v1/reviews/{id}/audit"),
            None,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_requires_https_except_loopback_and_no_credentials() {
        for endpoint in [
            "http://example.com",
            "https://user:password@example.com",
            "https://example.com/?token=x",
            "file:///tmp/review",
        ] {
            assert!(Client::new(endpoint, "long-enough-api-token-32-characters".into()).is_err());
        }
        assert!(
            Client::new(
                "http://127.0.0.1:8787",
                "long-enough-api-token-32-characters".into()
            )
            .is_ok()
        );
    }
    #[tokio::test]
    async fn lineage_404_is_absent_and_feedback_errors_keep_their_status() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut lines = Vec::new();
            for (status, body) in [
                ("404 Not Found", "{}"),
                ("200 OK", r#"{"round":2}"#),
                ("404 Not Found", "{}"),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket.read(&mut chunk).unwrap();
                    bytes.extend_from_slice(&chunk[..n]);
                }
                let text = String::from_utf8_lossy(&bytes).to_string();
                let header_end = text.find("\r\n\r\n").unwrap();
                let length = text[..header_end]
                    .to_lowercase()
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: ").map(str::to_owned))
                    .map(|l| l.parse::<usize>().unwrap())
                    .unwrap_or(0);
                while bytes.len() < header_end + 4 + length {
                    let n = socket.read(&mut chunk).unwrap();
                    bytes.extend_from_slice(&chunk[..n]);
                }
                lines.push(text.lines().next().unwrap().to_owned());
                write!(socket,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            lines
        });
        let client = Client::new(
            &format!("http://{address}"),
            "long-enough-api-token-32-characters".into(),
        )
        .unwrap();
        assert_eq!(
            client
                .lineage("github.com/o/r", "branch", "feature/x y")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            client
                .lineage("github.com/o/r", "branch", "feature/x y")
                .await
                .unwrap(),
            Some(json!({"round":2}))
        );
        let error = client
            .feedback("8c1e", &json!({"reason":"wrong"}))
            .await
            .unwrap_err();
        assert_eq!(http_status(&error), Some(404));
        assert!(client.feedback("../reviews", &json!({})).await.is_err());
        let lines = server.join().unwrap();
        assert_eq!(
            lines[0],
            "GET /v1/lineages?repository=github.com%2Fo%2Fr&kind=branch&ref=feature%2Fx+y HTTP/1.1"
        );
        assert_eq!(lines[2], "POST /v1/findings/8c1e/feedback HTTP/1.1");
    }
}

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
/// Pause between status polls of a running endpoint review.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

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
        if !status.is_success() {
            // Server bodies may contain raw provider or tool output and are never
            // echoed. The endpoint's own short `error` field is the exception.
            let detail = response
                .bytes()
                .await
                .ok()
                .filter(|body| body.len() <= 16 * 1024)
                .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
                .and_then(|value| value["error"].as_str().map(str::to_owned))
                .filter(|error| {
                    !error.is_empty()
                        && error.len() <= 200
                        && error.chars().all(|c| c == ' ' || c.is_ascii_graphic())
                });
            let error = anyhow::Error::from(HttpStatus(status.as_u16()));
            return Err(match detail {
                Some(detail) => error.context(format!("endpoint error: {detail}")),
                None => error,
            });
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
        self.wait_observed(id, cancellation, timeout, None).await
    }
    /// Like `wait`, and sends the review's progress events as they are recorded.
    pub async fn wait_observed(
        &self,
        id: &str,
        cancellation: CancellationToken,
        timeout: Duration,
        events: Option<&tokio::sync::mpsc::UnboundedSender<rio_core::ReviewEvent>>,
    ) -> Result<Report> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut cursor = 0;
        loop {
            // Progress is best effort: a failed poll never fails the review.
            if let Some(sender) = events
                && let Ok((next, batch)) = self.events(id, cursor).await
            {
                cursor = next;
                for event in batch {
                    let _ = sender.send(event);
                }
            }
            if cancellation.is_cancelled() || tokio::time::Instant::now() >= deadline {
                self.cancel(id).await?;
                anyhow::bail!(
                    "endpoint review cancelled; partial evidence is retained at review {id}"
                );
            }
            let status = match self
                .polled(&format!("v1/reviews/{id}"), deadline, &cancellation)
                .await
            {
                Ok(status) => status,
                // Interrupted or out of time: the loop's first check cancels and reports.
                Err(_)
                    if cancellation.is_cancelled() || tokio::time::Instant::now() >= deadline =>
                {
                    continue;
                }
                Err(error) => {
                    // The review must not outlive a client that stopped waiting for it.
                    let _ = self.cancel(id).await;
                    return Err(error);
                }
            };
            match status["status"].as_str() {
                Some("complete" | "partial") => {
                    return Ok(serde_json::from_value(
                        self.polled(&format!("v1/reviews/{id}/report"), deadline, &cancellation)
                            .await?,
                    )?);
                }
                Some("error" | "cancelled") => {
                    // The endpoint's own short reason (for example
                    // fork_requires_self_hosted_runner); never a raw body.
                    let reason = status["error"]
                        .as_str()
                        .filter(|e| {
                            !e.is_empty()
                                && e.len() <= 300
                                && e.chars().all(|c| c == ' ' || c.is_ascii_graphic())
                        })
                        .map(|e| format!(" ({e})"))
                        .unwrap_or_default();
                    anyhow::bail!("endpoint review did not complete: {id}{reason}")
                }
                // A pull request review is prepared on the endpoint first.
                Some("queued" | "running" | "preparing") => {}
                _ => anyhow::bail!("unknown endpoint review status"),
            }
            tokio::select! { _=cancellation.cancelled()=>{}, _=tokio::time::sleep(POLL_INTERVAL)=>{} }
        }
    }
    /// A polling GET that rides out transient failures (connection resets,
    /// timeouts, 429, 5xx) with capped backoff until `deadline`; other errors
    /// end the wait at once.
    async fn polled(
        &self,
        path: &str,
        deadline: tokio::time::Instant,
        cancellation: &CancellationToken,
    ) -> Result<Value> {
        let mut delay = Duration::from_millis(500);
        loop {
            // Each GET, body included, ends at the deadline or on cancellation.
            let result = tokio::select! {
                _ = cancellation.cancelled() => anyhow::bail!("endpoint review wait interrupted"),
                result = tokio::time::timeout_at(deadline, self.request(reqwest::Method::GET, path, None)) => match result {
                    Ok(result) => result,
                    Err(_) => anyhow::bail!("endpoint review wait timed out"),
                },
            };
            match result {
                Err(error)
                    if snapshot::retryable(&error)
                        && tokio::time::Instant::now() + delay < deadline =>
                {
                    tokio::select! {
                        _ = cancellation.cancelled() => anyhow::bail!("endpoint review wait interrupted"),
                        _ = tokio::time::sleep(delay) => {}
                    }
                    delay = (delay * 2).min(Duration::from_secs(15));
                }
                result => return result,
            }
        }
    }
    /// Events recorded after `cursor` (`GET /v1/reviews/{id}/events`), and the new cursor.
    pub async fn events(&self, id: &str, cursor: u64) -> Result<(u64, Vec<rio_core::ReviewEvent>)> {
        let mut url = self
            .base
            .join(&format!("v1/reviews/{}/events", path_id(id)?))?;
        url.query_pairs_mut()
            .append_pair("after", &cursor.to_string());
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .header("rio-protocol", "1")
            .send()
            .await
            .context("contacting Rio endpoint")?;
        let status = response.status();
        if !status.is_success() {
            return Err(anyhow::Error::from(HttpStatus(status.as_u16())));
        }
        let bytes = response.bytes().await?;
        ensure!(
            bytes.len() <= 16 * 1024 * 1024,
            "endpoint response too large"
        );
        let (last, events) = parse_events(&String::from_utf8_lossy(&bytes));
        Ok((last.unwrap_or(cursor).max(cursor), events))
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
    async fn get_query(&self, path: &str, query: &[(&str, &str)]) -> Result<Value> {
        let mut url = self.base.join(path)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        self.send_url(reqwest::Method::GET, url, None, None).await
    }
    /// The repository finding registry (`GET /v1/findings`).
    pub async fn findings(&self, query: &[(&str, &str)]) -> Result<Value> {
        self.get_query("v1/findings", query).await
    }
    /// Delete hosted browser evidence for one review and revoke its links.
    pub async fn prune_qa_evidence(&self, review: &str) -> Result<Value> {
        self.request(
            reqwest::Method::DELETE,
            &format!("v1/qa/reviews/{}/evidence", path_id(review)?),
            None,
        )
        .await
    }
    /// Suppression proposals (`GET /v1/suppressions`).
    pub async fn suppressions(&self, query: &[(&str, &str)]) -> Result<Value> {
        self.get_query("v1/suppressions", query).await
    }
    /// Marks a proposal `applied` or `declined` (`POST /v1/suppressions/{id}`).
    pub async fn decide_suppression(&self, id: &str, body: &Value) -> Result<Value> {
        self.request(
            reqwest::Method::POST,
            &format!("v1/suppressions/{}", path_id(id)?),
            Some(body),
        )
        .await
    }
    /// Asks the endpoint to prepare and review a pull request (`POST /v1/pulls`).
    pub async fn pull_review(
        &self,
        repository: &str,
        number: u64,
        publish: bool,
    ) -> Result<String> {
        let result = self
            .request(
                reqwest::Method::POST,
                "v1/pulls",
                Some(&json!({"repository": repository, "number": number, "publish": publish})),
            )
            .await?;
        Ok(path_id(
            result["id"]
                .as_str()
                .context("pull request response omitted id")?,
        )?
        .into())
    }
    /// The endpoint's GitHub App state for a repository (`GET /v1/github/installation`).
    pub async fn github_installation(&self, repository: &str) -> Result<Value> {
        self.get_query("v1/github/installation", &[("repository", repository)])
            .await
    }
    /// Sets the app's webhook secret through the endpoint (`POST /v1/github/hook-config`).
    pub async fn hook_config(&self, body: &Value) -> Result<Value> {
        self.request(reqwest::Method::POST, "v1/github/hook-config", Some(body))
            .await
    }
    /// Consent to publish a finished `ask` review (`POST /v1/reviews/{id}/publish`).
    pub async fn publish(&self, id: &str) -> Result<()> {
        self.request(
            reqwest::Method::POST,
            &format!("v1/reviews/{}/publish", path_id(id)?),
            Some(&json!({})),
        )
        .await?;
        Ok(())
    }
    /// What publishing a finished review would post, without posting
    /// (`POST /v1/reviews/{id}/publish?dry_run=1`): bodies, anchors and the check run.
    pub async fn publish_preview(&self, id: &str) -> Result<Value> {
        let mut url = self
            .base
            .join(&format!("v1/reviews/{}/publish", path_id(id)?))?;
        url.query_pairs_mut().append_pair("dry_run", "1");
        let body = serde_json::to_vec(&json!({}))?;
        self.send_url(
            reqwest::Method::POST,
            url,
            Some(("application/json", body)),
            None,
        )
        .await
    }
    pub async fn report(&self, id: &str) -> Result<Report> {
        Ok(serde_json::from_value(
            self.request(
                reqwest::Method::GET,
                &format!("v1/reviews/{}/report", path_id(id)?),
                None,
            )
            .await?,
        )?)
    }
    /// The endpoint's version (`GET /health`), without authentication.
    pub async fn health(&self) -> Result<Value> {
        let response = self
            .http
            .get(self.base.join("health")?)
            .bearer_auth(&self.token)
            .send()
            .await
            .context("contacting Rio endpoint")?;
        ensure!(
            response.status().is_success(),
            HttpStatus(response.status().as_u16())
        );
        Ok(response.json().await?)
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

/// Server-sent events as `ReviewEvent`s, and the last event id. Events this
/// client does not know, or whose data does not match, are skipped.
pub fn parse_events(text: &str) -> (Option<u64>, Vec<rio_core::ReviewEvent>) {
    let mut last = None;
    let mut events = Vec::new();
    for block in text.split("\n\n") {
        let (mut name, mut data) = (None, None);
        for line in block.lines() {
            if let Some(id) = line.strip_prefix("id: ") {
                last = id.trim().parse().ok().or(last);
            } else if let Some(event) = line.strip_prefix("event: ") {
                name = Some(event.trim());
            } else if let Some(value) = line.strip_prefix("data: ") {
                data = serde_json::from_str::<Value>(value).ok();
            }
        }
        let (Some(name), Some(Value::Object(mut fields))) = (name, data) else {
            continue;
        };
        // Local tool output never arrives from an endpoint.
        if name == "log" {
            continue;
        }
        fields.insert("event".into(), Value::String(name.into()));
        if let Ok(event) = serde_json::from_value(Value::Object(fields)) {
            events.push(event);
        }
    }
    (last, events)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_sent_events_parse_into_review_events_and_skip_the_unknown() {
        let text = "id: 3\nevent: agent:started\ndata: {\"agent\":\"security\"}\n\n\
            id: 4\nevent: finding:verified\ndata: {\"id\":\"x\",\"voters\":3}\n\n\
            id: 5\nevent: verify:progress\ndata: {\"done\":1,\"total\":2}\n\n\
            id: 6\nevent: log\ndata: {\"source\":\"x\",\"line\":\"y\"}\n\n\
            id: 7\nevent: future:thing\ndata: {}\n\n";
        let (last, events) = parse_events(text);
        assert_eq!(last, Some(7));
        assert_eq!(
            events,
            vec![
                rio_core::ReviewEvent::AgentStarted {
                    agent: "security".into()
                },
                rio_core::ReviewEvent::VerifyProgress { done: 1, total: 2 },
            ]
        );
        assert_eq!(parse_events(""), (None, vec![]));
    }
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
    async fn waiting_rides_out_a_dropped_poll_and_a_5xx() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut lines = Vec::new();
            for reply in [
                None,
                Some(("503 Service Unavailable", "{}")),
                Some(("200 OK", r#"{"status":"error","error":"boom"}"#)),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket.read(&mut chunk).unwrap();
                    bytes.extend_from_slice(&chunk[..n]);
                }
                lines.push(
                    String::from_utf8_lossy(&bytes)
                        .lines()
                        .next()
                        .unwrap()
                        .to_owned(),
                );
                // None: the connection drops without a response, like a reset.
                if let Some((status, body)) = reply {
                    write!(socket,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
            }
            lines
        });
        let client = Client::new(
            &format!("http://{address}"),
            "long-enough-api-token-32-characters".into(),
        )
        .unwrap();
        let error = client
            .wait("r1", CancellationToken::new(), Duration::from_secs(60))
            .await
            .unwrap_err();
        assert_eq!(
            format!("{error:#}"),
            "endpoint review did not complete: r1 (boom)"
        );
        assert_eq!(
            server.join().unwrap(),
            vec!["GET /v1/reviews/r1 HTTP/1.1"; 3]
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
                ("400 Bad Request", r#"{"error":"request too large"}"#),
                ("400 Bad Request", "{\"error\":\"x\\nsecret\"}"),
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
        // The endpoint's short error text is surfaced; anything else is not echoed.
        let error = client
            .feedback("8c1e", &json!({"reason":"wrong"}))
            .await
            .unwrap_err();
        assert_eq!(http_status(&error), Some(400));
        assert_eq!(
            format!("{error:#}"),
            "endpoint error: request too large: Rio endpoint returned HTTP 400"
        );
        let error = client
            .feedback("8c1e", &json!({"reason":"wrong"}))
            .await
            .unwrap_err();
        assert_eq!(http_status(&error), Some(400));
        assert_eq!(format!("{error:#}"), "Rio endpoint returned HTTP 400");
        assert!(client.feedback("../reviews", &json!({})).await.is_err());
        let lines = server.join().unwrap();
        assert_eq!(
            lines[0],
            "GET /v1/lineages?repository=github.com%2Fo%2Fr&kind=branch&ref=feature%2Fx+y HTTP/1.1"
        );
        assert_eq!(lines[2], "POST /v1/findings/8c1e/feedback HTTP/1.1");
    }
}

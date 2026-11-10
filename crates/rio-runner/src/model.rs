//! Model jobs: a self-hosted council member's request, sent to the
//! OpenAI-compatible endpoint this runner advertises, so the evidence pack never
//! leaves the account. Nothing but the request in the job reaches the endpoint.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::time::Duration;

/// Validate the operator's endpoint: http(s), no credentials, query or fragment.
pub fn endpoint(value: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(value).context("invalid model endpoint")?;
    // Plain HTTP only on loopback: the request carries the pack and the key.
    ensure!(
        (url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "model endpoint must be https (or http on loopback) without credentials, query or fragment"
    );
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}

/// The chat completion request for a model job.
pub fn request(job: &Value) -> Result<Value> {
    let model = &job["model"];
    let field = |name: &str| {
        model[name]
            .as_str()
            .with_context(|| format!("model job without {name}"))
    };
    Ok(json!({
        "model": field("model")?,
        "messages": [
            {"role": "system", "content": field("system")?},
            {"role": "user", "content": field("content")?},
        ],
        "max_tokens": model["max_tokens"].as_u64().unwrap_or(8192).min(32768),
        "response_format": {"type": "json_object"},
    }))
}

/// The completion the Worker expects: the reply and token counts as the artifact.
pub fn result(job: &Value, response: &Value) -> Result<Value> {
    let content = response["choices"][0]["message"]["content"]
        .as_str()
        .context("model endpoint returned no message content")?;
    // Null when the endpoint reports no usage: the Worker then keeps the
    // whole reservation rather than recording a free call.
    let usage = |name: &str| {
        response["usage"][name]
            .as_u64()
            .map_or(Value::Null, Value::from)
    };
    let mut artifact = json!({
        "content": content,
        "input_tokens": usage("prompt_tokens"),
        "output_tokens": usage("completion_tokens"),
    });
    // Passed through as the endpoint's raw JSON value, never `as_u64`, which
    // would hide a negative or fractional count: the Worker validates it.
    let cached = &response["usage"]["prompt_tokens_details"]["cached_tokens"];
    if !cached.is_null() {
        artifact["cached_input_tokens"] = cached.clone();
    }
    Ok(json!({
        "outcome": "exited",
        "job_id": job["job_id"],
        "attempt": job["attempt"],
        "version": job["version"],
        "exit_code": 0,
        "stdout": "",
        "stderr": "",
        "timed_out": false,
        "truncated": false,
        "artifact": artifact,
    }))
}

/// Serve one model job; errors become a runner failure the Worker records as
/// the member's vendor error, never a failed review.
pub async fn serve(endpoint: Option<&reqwest::Url>, job: &Value) -> Value {
    let failure = |message: &str, timed_out: bool| {
        json!({"outcome":"runner_failed","job_id":job["job_id"],"attempt":job["attempt"],
            "version":job["version"],"exit_code":125,"stdout":"","stderr":message,
            "timed_out":timed_out,"truncated":false})
    };
    let Some(endpoint) = endpoint else {
        return failure("runner has no model endpoint", false);
    };
    let wall = job["limits"]["wall_ms"]
        .as_u64()
        .unwrap_or(90_000)
        .min(120_000);
    let attempt = async {
        let body = request(job)?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(wall))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let mut call = client.post(endpoint.join("chat/completions")?).json(&body);
        if let Ok(key) = std::env::var("RIO_MODEL_API_KEY") {
            call = call.bearer_auth(key);
        }
        let response = call.send().await?;
        ensure!(
            response.status().is_success(),
            "model endpoint returned HTTP {}",
            response.status()
        );
        result(job, &response.json().await?)
    };
    match attempt.await {
        Ok(value) => value,
        Err(error) => {
            let timed_out = error
                .downcast_ref::<reqwest::Error>()
                .is_some_and(reqwest::Error::is_timeout);
            // The error class only; never the request, which holds the pack.
            failure(
                if timed_out {
                    "model endpoint timed out"
                } else {
                    "model endpoint call failed"
                },
                timed_out,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn job() -> Value {
        json!({"job_id": "j1", "attempt": 1, "version": "head", "kind": "model",
            "limits": {"wall_ms": 5000},
            "model": {"model": "llama-4", "system": "You are the skeptic.",
                "content": "<repository_data label=\"hypothesis\">PACK</repository_data>",
                "max_tokens": 1024}})
    }

    #[test]
    fn endpoints_must_be_plain_http_urls() {
        assert!(endpoint("http://127.0.0.1:8080/v1").is_ok());
        assert_eq!(
            endpoint("https://models.internal/v1").unwrap().path(),
            "/v1/"
        );
        for bad in [
            "ftp://x/v1",
            "https://user:pw@x/v1",
            "https://x/v1?k=1",
            "not a url",
            "http://models.internal/v1",
        ] {
            assert!(endpoint(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn requests_carry_only_the_job_request_and_results_carry_usage() {
        let body = request(&job()).unwrap();
        assert_eq!(body["model"], "llama-4");
        assert_eq!(body["messages"][1]["content"], job()["model"]["content"]);
        let done = result(
            &job(),
            &json!({"choices": [{"message": {"content": "{\"real\":\"no\"}"}}],
                "usage": {"prompt_tokens": 900, "completion_tokens": 40}}),
        )
        .unwrap();
        assert_eq!(done["artifact"]["content"], "{\"real\":\"no\"}");
        assert_eq!(done["artifact"]["input_tokens"], 900);
        assert!(result(&job(), &json!({"choices": []})).is_err());
        let unknown = result(
            &job(),
            &json!({"choices": [{"message": {"content": "{}"}}]}),
        )
        .unwrap();
        assert!(unknown["artifact"]["input_tokens"].is_null());
        assert!(unknown["artifact"].get("cached_input_tokens").is_none());
    }

    #[test]
    fn cached_tokens_pass_through_as_the_raw_value() {
        let cached = |value: Value| {
            result(
                &job(),
                &json!({"choices": [{"message": {"content": "{}"}}],
                    "usage": {"prompt_tokens": 5000, "completion_tokens": 40,
                        "prompt_tokens_details": {"cached_tokens": value}}}),
            )
            .unwrap()["artifact"]["cached_input_tokens"]
                .clone()
        };
        assert_eq!(cached(json!(4096)), json!(4096));
        assert_eq!(cached(json!(-1)), json!(-1));
        assert_eq!(cached(json!(12.5)), json!(12.5));
        assert!(cached(Value::Null).is_null());
    }

    #[tokio::test]
    async fn a_model_job_goes_only_to_the_advertised_endpoint() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = vec![0u8; 65536];
            let mut request = Vec::new();
            loop {
                let n = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..n]);
                let text = String::from_utf8_lossy(&request);
                if let Some(head) = text.find("\r\n\r\n") {
                    let length = text[..head]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= head + 4 + length {
                        break;
                    }
                }
            }
            let body = r#"{"choices":[{"message":{"content":"{}"}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            String::from_utf8(request).unwrap()
        });
        let url = endpoint(&format!("http://{address}/v1")).unwrap();
        let done = serve(Some(&url), &job()).await;
        let request = server.join().unwrap();
        assert!(
            request.starts_with("POST /v1/chat/completions"),
            "{request}"
        );
        assert!(request.contains("PACK"));
        assert_eq!(done["outcome"], "exited");
        assert_eq!(done["artifact"]["output_tokens"], 1);
        // Without an advertised endpoint the job fails and nothing is sent.
        let failed = serve(None, &job()).await;
        assert_eq!(failed["outcome"], "runner_failed");
        assert!(!failed.to_string().contains("PACK"));
    }
}

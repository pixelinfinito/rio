mod common;
use common::*;
use rio_adapters::*;
use rio_core::{AdvisorySeverity, CheckOutcome, FailureReason, SkipReason};
use rio_git::{Tree, diff};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

struct Server {
    base: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    running: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    fn new(handler: impl Fn(&str, &Value, usize) -> (u16, Value) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let running = Arc::new(AtomicBool::new(true));
        let log = requests.clone();
        let live = running.clone();
        let thread = std::thread::spawn(move || {
            while live.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                // macOS inherits the listener's nonblocking mode on accept.
                // Reads must wait for the client to finish sending the request.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let header_end;
                loop {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    bytes.push(byte[0]);
                    if bytes.ends_with(b"\r\n\r\n") {
                        header_end = bytes.len();
                        break;
                    }
                }
                let header = String::from_utf8_lossy(&bytes).into_owned();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                bytes.resize(header_end + length, 0);
                stream.read_exact(&mut bytes[header_end..]).unwrap();
                let body = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[header_end..]).unwrap()
                };
                let path = header
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let ordinal = {
                    let mut requests = log.lock().unwrap();
                    requests.push((path.to_owned(), body.clone()));
                    requests.len()
                };
                let (status, body) = handler(path, &body, ordinal);
                let body = serde_json::to_vec(&body).unwrap();
                write!(stream, "HTTP/1.1 {status} response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                stream.write_all(&body).unwrap();
            }
        });
        Self {
            base,
            requests,
            running,
            thread: Some(thread),
        }
    }
    fn count(&self, path: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(request, _)| request == path)
            .count()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn package() -> AuditPackage {
    AuditPackage {
        ecosystem: Ecosystem::Npm,
        name: "sample".into(),
        version: "1.5.0".into(),
        path: "package-lock.json".into(),
    }
}
fn advisory(id: &str, alias: &str) -> Value {
    json!({"id":id,"aliases":[alias],"modified":"2026-01-01T00:00:00Z","database_specific":{"severity":"HIGH"},"affected":[{"package":{"ecosystem":"npm","name":"sample"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"},{"fixed":"1.6.0"},{"introduced":"2.0.0"},{"fixed":"2.1.0"}]}]}]})
}

#[tokio::test]
async fn pagination_alias_grouping_and_modified_cache_avoid_duplicate_detail_requests() {
    let server = Server::new(|path, body, _| match path {
        "/v1/querybatch" if body["queries"][0]["page_token"].is_null() => {
            assert_eq!(body["queries"][0]["package"]["ecosystem"], "npm");
            (
                200,
                json!({"results":[{"vulns":[{"id":"GHSA-a","modified":"2026-01-01"}],"next_page_token":"next"}]}),
            )
        }
        "/v1/querybatch" => {
            assert_eq!(body["queries"][0]["page_token"], "next");
            (
                200,
                json!({"results":[{"vulns":[{"id":"PYSEC-b","modified":"2026-01-01"}]}]}),
            )
        }
        "/v1/vulns/GHSA-a" => (200, advisory("GHSA-a", "PYSEC-b")),
        "/v1/vulns/PYSEC-b" => (200, advisory("PYSEC-b", "GHSA-a")),
        _ => (404, json!({})),
    });
    let cache = tempfile::tempdir().unwrap();
    let client = OsvClient::with_base(cache.path().into(), server.base.clone()).unwrap();
    for _ in 0..2 {
        let outcome = client
            .audit(&[package()], false, CancellationToken::new())
            .await;
        assert!(
            matches!(outcome, CheckOutcome::Findings { .. }),
            "{outcome:?}"
        );
        assert_eq!(outcome.details().findings.len(), 1);
        let finding = &outcome.details().findings[0];
        let advisory = finding.advisory.as_ref().unwrap();
        assert_eq!(advisory.id, "GHSA-a");
        assert_eq!(advisory.aliases, ["PYSEC-b"]);
        assert_eq!(advisory.severity, AdvisorySeverity::High);
        assert_eq!(advisory.fixed_version, "1.6.0");
        assert_eq!(finding.rule_id, "dependency/vulnerable_dependency");
    }
    assert_eq!(server.count("/v1/querybatch"), 4);
    assert_eq!(server.count("/v1/vulns/GHSA-a"), 1);
    assert_eq!(server.count("/v1/vulns/PYSEC-b"), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(cache.path().join("osv/GHSA-a.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn incomplete_details_keep_findings_with_unknown_metadata_and_retry() {
    let server = Server::new(|path, _, _| {
        if path == "/v1/querybatch" {
            (
                200,
                json!({"results":[{"vulns":[{"id":"GHSA-missing","modified":"today"}]}]}),
            )
        } else {
            (503, json!({"message":"unavailable"}))
        }
    });
    let cache = tempfile::tempdir().unwrap();
    let client = OsvClient::with_base(cache.path().into(), server.base.clone()).unwrap();
    let outcome = client
        .audit(&[package()], false, CancellationToken::new())
        .await;
    assert!(
        matches!(
            outcome,
            CheckOutcome::Failed {
                reason: FailureReason::PartialData,
                ..
            }
        ),
        "{outcome:?}"
    );
    assert_eq!(outcome.details().findings.len(), 1);
    let advisory = outcome.details().findings[0].advisory.as_ref().unwrap();
    assert_eq!(advisory.severity, AdvisorySeverity::Unknown);
    assert_eq!(advisory.fixed_version, "unknown");
    assert_eq!(server.count("/v1/vulns/GHSA-missing"), 3);
}

#[tokio::test]
async fn offline_and_nothing_to_audit_make_no_requests_and_batch_failure_is_visible() {
    let server = Server::new(|_, _, _| (503, json!({})));
    let cache = tempfile::tempdir().unwrap();
    let client = OsvClient::with_base(cache.path().into(), server.base.clone()).unwrap();
    assert!(matches!(
        client
            .audit(&[package()], true, CancellationToken::new())
            .await,
        CheckOutcome::Skipped {
            reason: SkipReason::Offline,
            ..
        }
    ));
    assert!(matches!(
        client.audit(&[], false, CancellationToken::new()).await,
        CheckOutcome::Skipped {
            reason: SkipReason::NothingToAudit,
            ..
        }
    ));
    assert_eq!(server.count("/v1/querybatch"), 0);
    assert!(matches!(
        client
            .audit(&[package()], false, CancellationToken::new())
            .await,
        CheckOutcome::Failed {
            reason: FailureReason::NetworkError,
            ..
        }
    ));
    assert_eq!(server.count("/v1/querybatch"), 3);
}

#[test]
fn cvss_only_unknown_severity_and_fixed_versions_are_derived_from_applicable_ranges() {
    assert_eq!(
        advisory_severity(
            &json!({"severity":[{"type":"CVSS_V3","score":"CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"}]})
        ),
        AdvisorySeverity::Critical
    );
    assert_eq!(
        advisory_severity(
            &json!({"severity":[{"type":"CVSS_V4","score":"CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"}]})
        ),
        AdvisorySeverity::Critical
    );
    assert_eq!(
        advisory_severity(
            &json!({"severity":[{"type":"CVSS_V4","score":"CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:U"}]})
        ),
        AdvisorySeverity::Critical
    );
    assert_eq!(advisory_severity(&json!({})), AdvisorySeverity::Unknown);
    assert_eq!(
        advisory_fixed_version(&advisory("GHSA-a", ""), &package()),
        "1.6.0"
    );
    let mut later = package();
    later.version = "2.0.5".into();
    assert_eq!(
        advisory_fixed_version(&advisory("GHSA-a", ""), &later),
        "2.1.0"
    );
    later.version = "1.8.0".into();
    assert_eq!(
        advisory_fixed_version(&advisory("GHSA-a", ""), &later),
        "unknown"
    );
}

#[test]
fn only_added_upgraded_and_downgraded_versions_are_queried_and_unpinned_requirements_are_not_guessed()
 {
    let base: Tree = [(
        "requirements.txt".into(),
        entry("one==1.0\ntwo==2.0\nthree==3.0\n"),
    )]
    .into();
    let head: Tree = [(
        "requirements.txt".into(),
        entry("one==1.1\ntwo==1.9\nthree==3.0\nfour==4.0\nunpinned>=1\n"),
    )]
    .into();
    let change = changes(base, head);
    let diff = diff(&change, &[]).unwrap();
    let plan = dependency_audit_plan(&change.base, &change.head, &diff).unwrap();
    assert_eq!(
        plan.packages
            .iter()
            .map(|package| package.name.as_str())
            .collect::<Vec<_>>(),
        ["four", "one", "two"]
    );
    assert!(plan.notes.iter().any(|note| note.contains("unpinned")));
    assert!(
        dependency_audit_plan(&change.head, &change.head, &rio_git::Diff::default())
            .unwrap()
            .packages
            .is_empty()
    );
}

#[tokio::test]
async fn cancellation_during_network_retry_is_prompt_and_visible() {
    let cache = tempfile::tempdir().unwrap();
    let client = OsvClient::with_base(cache.path().into(), "http://127.0.0.1:9".into()).unwrap();
    let cancellation = CancellationToken::new();
    cancellation.cancel();
    let started = Instant::now();
    assert!(matches!(
        client.audit(&[package()], false, cancellation).await,
        CheckOutcome::Cancelled { .. }
    ));
    assert!(started.elapsed() < Duration::from_secs(1));
}

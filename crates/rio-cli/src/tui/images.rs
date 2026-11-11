//! Downloads of QA screenshots for the cell detail (terminal-ui "QA
//! screenshots in the cell detail"): an endpoint run's signed URL, fetched
//! when its cell is opened and kept in the run cache's `qa-images`, which is
//! pruned to a week and 200 MB after each download.

use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// The largest screenshot accepted, well above a full-page mobile capture.
const MAX_BYTES: usize = 25 * 1024 * 1024;
/// Downloads older than this are removed; their signed links expired anyway.
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
/// The most `qa-images` keeps; the oldest downloads go first.
const MAX_TOTAL: u64 = 200 * 1024 * 1024;

/// Download the PNG at `url` into `dir`; the error is what the pane shows.
pub async fn fetch_image(url: &str, dir: &Path) -> Result<PathBuf, String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| "the screenshot link is not a URL".to_owned())?;
    let loopback = parsed
        .host_str()
        .is_some_and(|h| h == "127.0.0.1" || h == "localhost");
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err("screenshots are only downloaded over https".into());
    }
    // One file per object: the signature in the query changes, the object does not.
    let mut object = parsed.clone();
    object.set_query(None);
    let name = format!("{}.png", blake3::hash(object.as_str().as_bytes()).to_hex());
    let dir = dir.join("qa-images");
    let path = dir.join(name);
    if std::fs::read(&path).is_ok_and(|bytes| bytes.starts_with(PNG)) {
        return Ok(path);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(parsed.clone())
        .send()
        .await
        .map_err(|_| "the screenshot could not be downloaded".to_owned())?;
    match response.status().as_u16() {
        200 => {}
        401 | 403 | 404 | 410 => {
            return Err("the evidence link has expired; the full report has fresh links".into());
        }
        status => return Err(format!("the evidence store answered HTTP {status}")),
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("the screenshot is larger than 25 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !bytes.starts_with(PNG) {
        return Err("the evidence link did not return a PNG".into());
    }
    rio_git::private_directory(&dir).map_err(|e| format!("{e:#}"))?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    prune(&dir, &path, SystemTime::now(), MAX_AGE, MAX_TOTAL);
    Ok(path)
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Remove downloads older than `max_age`, then the oldest until the folder
/// holds at most `max_total` bytes. `keep` (the file just written) stays.
fn prune(dir: &Path, keep: &Path, now: SystemTime, max_age: Duration, max_total: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "png"))
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            Some((meta.modified().ok()?, meta.len(), e.path()))
        })
        .collect();
    files.sort();
    let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
    for (modified, len, path) in files {
        let old = now.duration_since(modified).is_ok_and(|age| age > max_age);
        if path != keep && (old || total > max_total) && std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// A loopback server answering each path with a status and a body.
    fn serve(routes: Vec<(&'static str, u16, Vec<u8>)>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(routes.len()) {
                let mut stream = stream.unwrap();
                let mut request = [0; 2048];
                let n = stream.read(&mut request).unwrap();
                let line = String::from_utf8_lossy(&request[..n]);
                let path = line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("")
                    .split('?')
                    .next()
                    .unwrap()
                    .to_owned();
                let (_, status, body) = routes.iter().find(|(p, _, _)| *p == path).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn a_signed_screenshot_is_kept_once_per_object_and_failures_are_named() {
        let png = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/evaluation/qa-evidence/missing-cancel.png"
        ))
        .unwrap();
        let base = serve(vec![
            ("/ok.png", 200, png.clone()),
            ("/expired.png", 403, b"<Error>AccessDenied</Error>".to_vec()),
            ("/page.png", 200, b"<html>login</html>".to_vec()),
            ("/ok.png", 200, png.clone()),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let first = fetch_image(&format!("{base}/ok.png?sig=1"), dir.path())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), png);
        let expired = fetch_image(&format!("{base}/expired.png?sig=1"), dir.path()).await;
        assert_eq!(
            expired.unwrap_err(),
            "the evidence link has expired; the full report has fresh links"
        );
        let page = fetch_image(&format!("{base}/page.png"), dir.path()).await;
        assert_eq!(page.unwrap_err(), "the evidence link did not return a PNG");
        // A new signature for the same object reuses the same file.
        let again = fetch_image(&format!("{base}/ok.png?sig=2"), dir.path())
            .await
            .unwrap();
        assert_eq!(first, again);
        assert_eq!(
            fetch_image("http://evidence.example/x.png", dir.path())
                .await
                .unwrap_err(),
            "screenshots are only downloaded over https"
        );
    }

    #[tokio::test]
    async fn a_kept_screenshot_is_not_downloaded_again() {
        let png = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/evaluation/qa-evidence/missing-cancel.png"
        ))
        .unwrap();
        // The server answers once; a second request would hang and fail.
        let base = serve(vec![("/ok.png", 200, png)]);
        let dir = tempfile::tempdir().unwrap();
        let first = fetch_image(&format!("{base}/ok.png?sig=1"), dir.path())
            .await
            .unwrap();
        let again = fetch_image(&format!("{base}/ok.png?sig=expired"), dir.path())
            .await
            .unwrap();
        assert_eq!(first, again);
    }

    #[test]
    fn prune_drops_old_downloads_then_the_oldest_over_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let write = |name: &str, len: usize, age_days: u64| {
            let path = dir.path().join(name);
            std::fs::write(&path, vec![0u8; len]).unwrap();
            let file = std::fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(now - Duration::from_secs(age_days * 86400))
                .unwrap();
            path
        };
        let stale = write("stale.png", 10, 9);
        let oldest = write("oldest.png", 40, 3);
        let older = write("older.png", 40, 2);
        let newest = write("newest.png", 40, 0);
        let other = write("notes.txt", 10, 30);
        prune(dir.path(), &newest, now, MAX_AGE, 90);
        assert!(!stale.exists(), "older than a week");
        assert!(!oldest.exists(), "over the cap, oldest first");
        assert!(older.exists() && newest.exists());
        assert!(other.exists(), "only downloads are pruned");
    }
}

//! Content-addressed hosted snapshot upload: the CLI side of the "Snapshot
//! protocol" in `docs/cloudflare.md`.
use crate::{Client, http_status};
use anyhow::{Context, Result, ensure};
use rio_git::Tree;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    ops::Range,
    sync::Mutex,
    time::Duration,
};

const MIB: u64 = 1024 * 1024;
/// Endpoint limits, checked before anything is uploaded.
pub const MAX_TREE_PATHS: usize = 300_000;
pub const MAX_FILE_BYTES: u64 = 64 * MIB;
pub const MAX_CONTENT_BYTES: u64 = 1024 * MIB;
pub const MAX_BODY_BYTES: usize = 8 * MIB as usize;
/// Larger contents are uploaded alone, in parts of `MAX_BODY_BYTES`.
pub const MAX_PACKED_CONTENT: usize = 7 * MIB as usize;
const MAX_PACK_ENTRIES: usize = 2_000;
const MAX_MISSING_BATCH: usize = 10_000;
const MODES: [u32; 3] = [0o100644, 0o100755, 0o120000];
/// Submodule entries carry a commit id, not content; the diff reports them as
/// `submodule_not_reviewed` and the snapshot omits them.
const GITLINK: u32 = 0o160000;
const PARALLEL_REQUESTS: usize = 4;
const RETRIES: u32 = 3;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const JSON: &str = "application/json";
const OCTETS: &str = "application/octet-stream";

/// A registered snapshot and what it cost to upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotUpload {
    pub id: String,
    /// Paths across both trees.
    pub files: usize,
    /// Distinct contents across both trees and their total size.
    pub contents: usize,
    pub bytes: u64,
    /// Contents the endpoint did not hold yet, uploaded by this call.
    pub uploaded_contents: usize,
    pub uploaded_bytes: u64,
}

struct Limits {
    paths: usize,
    file: u64,
    content: u64,
    body: usize,
}
const LIMITS: Limits = Limits {
    paths: MAX_TREE_PATHS,
    file: MAX_FILE_BYTES,
    content: MAX_CONTENT_BYTES,
    body: MAX_BODY_BYTES,
};

/// One canonical manifest line; field order is the wire key order.
#[derive(Serialize)]
struct Line<'a> {
    version: &'a str,
    path: &'a str,
    hash: &'a str,
    mode: u32,
    size: u64,
}
#[derive(Serialize)]
struct IndexEntry<'a> {
    hash: &'a str,
    size: usize,
}

type Content<'a> = (&'a str, &'a [u8]);

struct Prepared<'a> {
    id: String,
    manifest: Vec<u8>,
    /// Chunks of whole manifest lines, each at most the body limit.
    chunks: Vec<Range<usize>>,
    /// Distinct contents in first-seen manifest order.
    contents: Vec<(String, &'a [u8])>,
    files: usize,
}

/// Hashes, deduplicates and checks both trees, and builds the canonical manifest.
fn prepare<'a>(base: &'a Tree, head: &'a Tree, limits: &Limits) -> Result<Prepared<'a>> {
    let trees = [("base", base), ("head", head)];
    for (version, tree) in trees {
        ensure!(
            tree.len() <= limits.paths,
            "snapshot exceeds the limit of {} paths per tree: the {version} tree has {} paths",
            format_count(limits.paths as u64),
            format_count(tree.len() as u64)
        );
    }
    for (version, tree) in trees {
        for (path, entry) in tree.iter().filter(|(_, e)| e.mode != GITLINK) {
            let size = entry.content.len() as u64;
            ensure!(
                size <= limits.file,
                "snapshot exceeds the per-file limit of {}: {path} ({version}) is {} ({} bytes)",
                format_bytes(limits.file),
                format_bytes(size),
                format_count(size)
            );
            ensure!(
                MODES.contains(&entry.mode),
                "unsupported file mode {:o} for {path} ({version})",
                entry.mode
            );
        }
    }
    let mut seen = HashMap::<blake3::Hash, usize>::new();
    let mut contents = Vec::<(String, &[u8])>::new();
    let mut bytes = 0u64;
    let mut manifest = Vec::new();
    let (mut chunks, mut chunk_start) = (Vec::new(), 0);
    for (version, tree) in trees {
        // `Tree` is a `BTreeMap<String, _>`: paths iterate in UTF-8 byte order.
        for (path, entry) in tree.iter().filter(|(_, e)| e.mode != GITLINK) {
            let index = *seen
                .entry(blake3::hash(&entry.content))
                .or_insert_with_key(|hash| {
                    bytes += entry.content.len() as u64;
                    contents.push((hash.to_hex().to_string(), entry.content.as_slice()));
                    contents.len() - 1
                });
            let line_start = manifest.len();
            serde_json::to_writer(
                &mut manifest,
                &Line {
                    version,
                    path,
                    hash: &contents[index].0,
                    mode: entry.mode,
                    size: entry.content.len() as u64,
                },
            )?;
            manifest.push(b'\n');
            ensure!(
                manifest.len() - line_start <= limits.body,
                "snapshot exceeds the request body limit of {}: the manifest line for {path} ({version}) is {}",
                format_bytes(limits.body as u64),
                format_bytes((manifest.len() - line_start) as u64)
            );
            if manifest.len() - chunk_start > limits.body {
                chunks.push(chunk_start..line_start);
                chunk_start = line_start;
            }
        }
    }
    if chunk_start < manifest.len() {
        chunks.push(chunk_start..manifest.len());
    }
    ensure!(
        bytes <= limits.content,
        "snapshot exceeds the limit of {} of distinct content across base and head: it has {} ({} bytes)",
        format_bytes(limits.content),
        format_bytes(bytes),
        format_count(bytes)
    );
    Ok(Prepared {
        id: blake3::hash(&manifest).to_hex().to_string(),
        manifest,
        chunks,
        contents,
        files: trees
            .iter()
            .map(|(_, tree)| tree.values().filter(|e| e.mode != GITLINK).count())
            .sum(),
    })
}

#[derive(Debug, PartialEq)]
enum Upload<'a> {
    Pack(Vec<Content<'a>>),
    Parts(Content<'a>),
}

/// Length of one serialized index entry, without the separating comma.
fn index_entry_len(size: usize) -> usize {
    r#"{"hash":"","size":}"#.len() + 64 + size.to_string().len()
}

/// Groups contents into packs within the entry and body limits; contents over
/// `MAX_PACKED_CONTENT` are uploaded alone in parts.
fn plan_uploads<'a>(contents: impl IntoIterator<Item = Content<'a>>) -> Vec<Upload<'a>> {
    let mut uploads = Vec::new();
    let (mut pack, mut index, mut data) = (Vec::new(), 0, 0);
    for (hash, content) in contents {
        if content.len() > MAX_PACKED_CONTENT {
            uploads.push(Upload::Parts((hash, content)));
            continue;
        }
        let entry = index_entry_len(content.len()) + usize::from(!pack.is_empty());
        // 4-byte length prefix, `[` and `]`, index entries, then contents.
        if !pack.is_empty()
            && (pack.len() == MAX_PACK_ENTRIES
                || 4 + 2 + index + entry + data + content.len() > MAX_BODY_BYTES)
        {
            uploads.push(Upload::Pack(std::mem::take(&mut pack)));
            (index, data) = (0, 0);
        }
        index += index_entry_len(content.len()) + usize::from(!pack.is_empty());
        data += content.len();
        pack.push((hash, content));
    }
    if !pack.is_empty() {
        uploads.push(Upload::Pack(pack));
    }
    uploads
}

/// `PUT /v1/packs` body: big-endian index length, index JSON, contents.
fn pack_body(pack: &[Content<'_>]) -> Result<Vec<u8>> {
    let index = serde_json::to_vec(
        &pack
            .iter()
            .map(|(hash, content)| IndexEntry {
                hash,
                size: content.len(),
            })
            .collect::<Vec<_>>(),
    )?;
    let mut body =
        Vec::with_capacity(4 + index.len() + pack.iter().map(|(_, c)| c.len()).sum::<usize>());
    body.extend_from_slice(&u32::try_from(index.len())?.to_be_bytes());
    body.extend_from_slice(&index);
    for (_, content) in pack {
        body.extend_from_slice(content);
    }
    Ok(body)
}

/// Runs `task` over `items` with at most `PARALLEL_REQUESTS` in flight, keeping
/// item order in the results and stopping at the first error.
async fn parallel<T, R, F, Fut>(items: Vec<T>, task: F) -> Result<Vec<R>>
where
    F: Fn(T) -> Fut,
    Fut: Future<Output = Result<R>>,
{
    let queue = Mutex::new(items.into_iter().enumerate());
    let results = Mutex::new(Vec::new());
    let worker = || async {
        loop {
            let next = queue.lock().unwrap().next();
            let Some((index, item)) = next else {
                return Ok::<_, anyhow::Error>(());
            };
            let result = task(item).await?;
            results.lock().unwrap().push((index, result));
        }
    };
    const _: () = assert!(PARALLEL_REQUESTS == 4);
    tokio::try_join!(worker(), worker(), worker(), worker())?;
    let mut results = results.into_inner().unwrap();
    results.sort_by_key(|(index, _)| *index);
    Ok(results.into_iter().map(|(_, result)| result).collect())
}

/// Connection errors, timeouts, HTTP 429 and 5xx; never other statuses.
fn retryable(error: &anyhow::Error) -> bool {
    match http_status(error) {
        Some(status) => status == 429 || status >= 500,
        None => error.chain().any(|cause| {
            cause
                .downcast_ref::<reqwest::Error>()
                .is_some_and(|e| e.is_connect() || e.is_timeout() || e.is_request() || e.is_body())
        }),
    }
}

impl Client {
    /// Sends an idempotent request, retrying transient failures with backoff.
    async fn send_retrying(
        &self,
        method: reqwest::Method,
        url: reqwest::Url,
        body: (&'static str, &[u8]),
        timeout: Option<Duration>,
    ) -> Result<Value> {
        let mut attempt = 0;
        loop {
            let result = self
                .send_url(
                    method.clone(),
                    url.clone(),
                    Some((body.0, body.1.to_vec())),
                    timeout,
                )
                .await;
            match result {
                Err(error) if attempt < RETRIES && retryable(&error) => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(250 << (attempt - 1))).await;
                }
                result => return result,
            }
        }
    }
    async fn send_json_retrying(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &Value,
    ) -> Result<Value> {
        self.send_retrying(
            method,
            self.base.join(path)?,
            (JSON, &serde_json::to_vec(body)?),
            Some(UPLOAD_TIMEOUT),
        )
        .await
    }
    /// The hashes of `batch` the endpoint does not hold for this tenant.
    async fn missing(&self, batch: &[(String, &[u8])]) -> Result<Vec<String>> {
        let hashes: Vec<&str> = batch.iter().map(|(hash, _)| hash.as_str()).collect();
        let result = self
            .send_json_retrying(
                reqwest::Method::POST,
                "v1/contents/missing",
                &json!({ "hashes": hashes }),
            )
            .await?;
        let requested: HashSet<&str> = hashes.into_iter().collect();
        result["missing"]
            .as_array()
            .context("missing-contents response omitted missing")?
            .iter()
            .map(|hash| {
                let hash = hash.as_str().filter(|hash| requested.contains(hash));
                Ok(hash
                    .context("missing-contents response named an unknown hash")?
                    .to_owned())
            })
            .collect()
    }
    async fn upload(&self, upload: Upload<'_>) -> Result<()> {
        match upload {
            Upload::Pack(pack) => {
                self.send_retrying(
                    reqwest::Method::PUT,
                    self.base.join("v1/packs")?,
                    (OCTETS, &pack_body(&pack)?),
                    Some(UPLOAD_TIMEOUT),
                )
                .await?;
            }
            Upload::Parts((hash, content)) => {
                let created = self
                    .send_json_retrying(
                        reqwest::Method::POST,
                        &format!("v1/contents/{hash}/uploads"),
                        &json!({ "size": content.len() }),
                    )
                    .await?;
                if created["present"] == true {
                    return Ok(());
                }
                let id = created["upload"]
                    .as_str()
                    .context("upload response omitted upload")?;
                let mut parts = Vec::new();
                for (index, part) in content.chunks(MAX_BODY_BYTES).enumerate() {
                    let number = index as u64 + 1;
                    let mut url = self
                        .base
                        .join(&format!("v1/contents/{hash}/uploads/{number}"))?;
                    url.query_pairs_mut().append_pair("upload", id);
                    let result = self
                        .send_retrying(
                            reqwest::Method::PUT,
                            url,
                            (OCTETS, part),
                            Some(UPLOAD_TIMEOUT),
                        )
                        .await?;
                    ensure!(
                        result["part"].as_u64() == Some(number),
                        "part upload response named another part"
                    );
                    let etag = result["etag"]
                        .as_str()
                        .context("part upload response omitted etag")?;
                    parts.push(json!({ "part": number, "etag": etag }));
                }
                let mut url = self
                    .base
                    .join(&format!("v1/contents/{hash}/uploads/complete"))?;
                url.query_pairs_mut().append_pair("upload", id);
                self.send_retrying(
                    reqwest::Method::POST,
                    url,
                    (
                        JSON,
                        &serde_json::to_vec(&json!({ "size": content.len(), "parts": parts }))?,
                    ),
                    Some(UPLOAD_TIMEOUT),
                )
                .await?;
            }
        }
        Ok(())
    }
    /// Uploads both complete trees: remote checks build the repository, so review
    /// exclusions cannot be dropped. Limits are checked before any request, then
    /// only contents the endpoint lacks are uploaded and the manifest is sealed.
    pub async fn upload_snapshot(&self, base: &Tree, head: &Tree) -> Result<SnapshotUpload> {
        let prepared = prepare(base, head, &LIMITS)?;
        let missing: HashSet<String> = parallel(
            prepared.contents.chunks(MAX_MISSING_BATCH).collect(),
            |batch| self.missing(batch),
        )
        .await?
        .into_iter()
        .flatten()
        .collect();
        let new: Vec<Content<'_>> = prepared
            .contents
            .iter()
            .filter(|(hash, _)| missing.contains(hash))
            .map(|(hash, content)| (hash.as_str(), *content))
            .collect();
        let uploaded_bytes = new.iter().map(|(_, c)| c.len() as u64).sum();
        let uploaded_contents = new.len();
        parallel(plan_uploads(new), |upload| self.upload(upload)).await?;
        let (id, manifest) = (&prepared.id, &prepared.manifest);
        parallel(
            prepared.chunks.iter().enumerate().collect(),
            |(n, range)| {
                let url = self.base.join(&format!("v1/manifests/{id}/chunks/{n}"));
                async move {
                    self.send_retrying(
                        reqwest::Method::PUT,
                        url?,
                        (OCTETS, &manifest[range.clone()]),
                        Some(UPLOAD_TIMEOUT),
                    )
                    .await
                }
            },
        )
        .await?;
        let sealed = self
            .send_json_retrying(
                reqwest::Method::POST,
                &format!("v1/manifests/{id}/seal"),
                &json!({ "chunks": prepared.chunks.len() }),
            )
            .await?;
        ensure!(
            sealed["id"].as_str() == Some(id),
            "endpoint sealed a different snapshot id"
        );
        Ok(SnapshotUpload {
            id: prepared.id.clone(),
            files: prepared.files,
            contents: prepared.contents.len(),
            bytes: prepared.contents.iter().map(|(_, c)| c.len() as u64).sum(),
            uploaded_contents,
            uploaded_bytes,
        })
    }
}

/// `12.3 MiB`-style sizes for limits and upload statistics.
pub fn format_bytes(bytes: u64) -> String {
    let (value, unit) = match bytes {
        0..1024 => return format!("{bytes} B"),
        1024..MIB => (bytes as f64 / 1024.0, "KiB"),
        MIB..0x4000_0000 => (bytes as f64 / MIB as f64, "MiB"),
        _ => (bytes as f64 / (1024 * MIB) as f64, "GiB"),
    };
    let value = format!("{value:.1}");
    format!("{} {unit}", value.strip_suffix(".0").unwrap_or(&value))
}
/// `20,104`-style counts.
pub fn format_count(count: u64) -> String {
    let digits = count.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rio_git::TreeEntry;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
    };

    fn tree<const N: usize>(files: [(&str, &[u8]); N]) -> Tree {
        files
            .into_iter()
            .map(|(path, content)| {
                (
                    path.to_owned(),
                    TreeEntry {
                        mode: 0o100644,
                        object_id: String::new(),
                        content: content.to_vec(),
                    },
                )
            })
            .collect()
    }
    fn hash(content: &[u8]) -> String {
        blake3::hash(content).to_hex().to_string()
    }

    #[test]
    fn manifest_is_canonical_sorted_by_bytes_and_stable() {
        let mut base = tree([("b.txt", b"same\n"), ("é.txt", b"x"), ("z.txt", b"x")]);
        base.insert(
            "link".into(),
            TreeEntry {
                mode: 0o120000,
                object_id: String::new(),
                content: b"b.txt".to_vec(),
            },
        );
        let head = tree([("a\"q.txt", b"new\n"), ("b.txt", b"same\n")]);
        let prepared = prepare(&base, &head, &LIMITS).unwrap();
        let text = String::from_utf8(prepared.manifest.clone()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[0],
            format!(
                r#"{{"version":"base","path":"b.txt","hash":"{}","mode":33188,"size":5}}"#,
                hash(b"same\n")
            )
        );
        assert_eq!(
            lines[1],
            format!(
                r#"{{"version":"base","path":"link","hash":"{}","mode":40960,"size":5}}"#,
                hash(b"b.txt")
            )
        );
        // "z" (0x7a) sorts before "é" (0xc3 0xa9) in UTF-8 byte order.
        assert!(lines[2].contains(r#""path":"z.txt""#));
        assert!(lines[3].contains(r#""path":"é.txt""#));
        assert!(lines[4].starts_with(r#"{"version":"head","path":"a\"q.txt","#));
        assert!(lines[5].starts_with(r#"{"version":"head","path":"b.txt","#));
        assert!(text.ends_with('\n') && lines.len() == 6);
        assert_eq!(prepared.id, hash(&prepared.manifest));
        assert_eq!(prepared.chunks, vec![0..prepared.manifest.len()]);
        // Shared contents ("same\n" in both trees, "x" twice) are listed once.
        assert_eq!(prepared.contents.len(), 4);
        assert_eq!(prepared.files, 6);
        assert_eq!(
            prepare(&base.clone(), &head.clone(), &LIMITS).unwrap().id,
            prepared.id
        );
        let mut changed = head.clone();
        changed.get_mut("b.txt").unwrap().mode = 0o100755;
        assert_ne!(prepare(&base, &changed, &LIMITS).unwrap().id, prepared.id);
    }

    #[test]
    fn manifest_chunks_hold_whole_lines_within_the_body_limit() {
        let files: Tree = (0..2_000)
            .map(|i| {
                (
                    format!("{i:04}-{}", "p".repeat(200)),
                    TreeEntry {
                        mode: 0o100644,
                        object_id: String::new(),
                        content: i.to_string().into_bytes(),
                    },
                )
            })
            .collect();
        let limits = Limits {
            body: 64 * 1024,
            ..LIMITS
        };
        let prepared = prepare(&files, &files, &limits).unwrap();
        assert!(prepared.chunks.len() > 5);
        assert_eq!(prepared.chunks[0].start, 0);
        assert_eq!(prepared.chunks.last().unwrap().end, prepared.manifest.len());
        for pair in prepared.chunks.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        for chunk in &prepared.chunks {
            assert!(chunk.len() <= limits.body);
            assert_eq!(prepared.manifest[chunk.end - 1], b'\n');
        }
        let error = prepare(
            &files,
            &files,
            &Limits {
                body: 100,
                ..LIMITS
            },
        )
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains("request body limit of 100 B"), "{error}");
    }

    #[test]
    fn limits_are_checked_before_uploading_and_named() {
        let big = vec![0u8; MAX_FILE_BYTES as usize + 1];
        let mut head = tree([("ok.txt", b"x")]);
        head.insert(
            "assets/big.bin".into(),
            TreeEntry {
                mode: 0o100644,
                object_id: String::new(),
                content: big,
            },
        );
        let error = prepare(&Tree::new(), &head, &LIMITS)
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("per-file limit of 64 MiB"), "{error}");
        assert!(
            error.contains("assets/big.bin (head) is 64 MiB (67,108,865 bytes)"),
            "{error}"
        );

        let many: Tree = (0..=MAX_TREE_PATHS)
            .map(|i| {
                (
                    i.to_string(),
                    TreeEntry {
                        mode: 0o100644,
                        object_id: String::new(),
                        content: Vec::new(),
                    },
                )
            })
            .collect();
        let error = prepare(&many, &Tree::new(), &LIMITS)
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains("limit of 300,000 paths per tree: the base tree has 300,001 paths"),
            "{error}"
        );

        let limits = Limits {
            content: 1024,
            ..LIMITS
        };
        let base = tree([("a", &[1u8; 600][..]), ("b", &[1u8; 600][..])]);
        // Identical contents count once.
        assert!(prepare(&base, &base, &limits).is_ok());
        let head = tree([("a", &[2u8; 600][..])]);
        let error = prepare(&base, &head, &limits).err().unwrap().to_string();
        assert!(
            error.contains("limit of 1 KiB of distinct content across base and head: it has 1.2 KiB (1,200 bytes)"),
            "{error}"
        );
        // Submodule entries are omitted rather than rejected or uploaded.
        let mut gitlink = tree([("sub", b"x"), ("file", b"y")]);
        gitlink.get_mut("sub").unwrap().mode = 0o160000;
        let empty = Tree::new();
        let prepared = prepare(&gitlink, &empty, &LIMITS).unwrap();
        let manifest = String::from_utf8(prepared.manifest.clone()).unwrap();
        assert!(manifest.contains("\"path\":\"file\""), "{manifest}");
        assert!(!manifest.contains("sub"), "{manifest}");
        assert_eq!(prepared.files, 1);
        assert!(prepare(&tree([("other", b"z")]), &Tree::new(), &LIMITS).is_ok());
    }

    #[test]
    fn packs_respect_entry_and_body_limits_and_route_large_contents_to_parts() {
        let small: Vec<(String, Vec<u8>)> = (0..2_001u32)
            .map(|i| (hash(&i.to_be_bytes()), i.to_be_bytes().to_vec()))
            .collect();
        let uploads = plan_uploads(small.iter().map(|(h, c)| (h.as_str(), c.as_slice())));
        assert_eq!(uploads.len(), 2);
        let Upload::Pack(first) = &uploads[0] else {
            panic!()
        };
        assert_eq!(first.len(), MAX_PACK_ENTRIES);
        let body = pack_body(&first[..2]).unwrap();
        let length = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
        let index: Value = serde_json::from_slice(&body[4..4 + length]).unwrap();
        assert_eq!(
            index,
            json!([{"hash": small[0].0, "size": 4}, {"hash": small[1].0, "size": 4}])
        );
        assert_eq!(&body[4 + length..], [0, 0, 0, 0, 0, 0, 0, 1]);
        let body = pack_body(first).unwrap();
        let length = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
        // The planner's index length estimate is exact.
        assert_eq!(
            length,
            2 + first.len() - 1
                + first
                    .iter()
                    .map(|(_, c)| index_entry_len(c.len()))
                    .sum::<usize>()
        );

        let contents: Vec<(String, Vec<u8>)> = [
            3 * MIB as usize,
            3 * MIB as usize,
            MAX_PACKED_CONTENT,
            MAX_PACKED_CONTENT + 1,
            9 * MIB as usize,
            1,
        ]
        .into_iter()
        .enumerate()
        .map(|(i, size)| {
            let content = vec![i as u8; size];
            (hash(&content), content)
        })
        .collect();
        let uploads = plan_uploads(contents.iter().map(|(h, c)| (h.as_str(), c.as_slice())));
        let shape: Vec<Vec<usize>> = uploads
            .iter()
            .map(|upload| match upload {
                Upload::Pack(pack) => pack.iter().map(|(_, c)| c.len()).collect(),
                Upload::Parts((_, c)) => vec![usize::MAX, c.len()],
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                vec![3 * MIB as usize, 3 * MIB as usize],
                vec![usize::MAX, MAX_PACKED_CONTENT + 1],
                vec![usize::MAX, 9 * MIB as usize],
                vec![MAX_PACKED_CONTENT, 1],
            ]
        );
        for upload in &uploads {
            if let Upload::Pack(pack) = upload {
                assert!(pack_body(pack).unwrap().len() <= MAX_BODY_BYTES);
            }
        }
    }

    #[test]
    fn formats_sizes_and_counts() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(145 * MIB), "145 MiB");
        assert_eq!(format_bytes(12 * MIB + 300 * 1024), "12.3 MiB");
        assert_eq!(format_bytes(MAX_CONTENT_BYTES), "1 GiB");
        assert_eq!(format_count(20_104), "20,104");
        assert_eq!(format_count(1_000_000), "1,000,000");
        assert_eq!(format_count(999), "999");
    }

    type Log = Arc<Mutex<Vec<(String, String, Vec<u8>)>>>;
    /// A loopback endpoint answering `handler(method, path, body)`, one
    /// connection at a time, until `requests` have been served.
    fn serve(
        requests: usize,
        mut handler: impl FnMut(&str, &str, &[u8]) -> (u16, Value) + Send + 'static,
    ) -> (String, Log, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let log: Log = Arc::default();
        let record = log.clone();
        let thread = std::thread::spawn(move || {
            let mut served = 0;
            while served < requests {
                let (mut stream, _) = listener.accept().unwrap();
                // Accepted sockets inherit non-blocking mode on macOS and BSD.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 65536];
                let (end, headers) = loop {
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let h = String::from_utf8_lossy(&bytes[..end]).to_string();
                        let length = h
                            .to_lowercase()
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length: "))
                            .and_then(|l| l.parse::<usize>().ok())
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break (end, h);
                        }
                    }
                };
                let lower = headers.to_lowercase();
                // Ignore unrelated local probes of the ephemeral port.
                if !lower.contains("authorization: bearer long-enough-api-token-32-characters") {
                    continue;
                }
                assert!(lower.contains("rio-protocol: 1"));
                served += 1;
                let mut first = headers.lines().next().unwrap().split_whitespace();
                let method = first.next().unwrap().to_owned();
                let path = first.next().unwrap().to_owned();
                let body = bytes[end + 4..].to_vec();
                let (status, response) = handler(&method, &path, &body);
                record.lock().unwrap().push((method, path, body));
                let response = serde_json::to_vec(&response).unwrap();
                write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
                stream.write_all(&response).unwrap();
            }
        });
        (url, log, thread)
    }
    fn client(url: &str) -> Client {
        Client::new(url, "long-enough-api-token-32-characters".into()).unwrap()
    }
    /// Index hashes of a pack body.
    fn pack_hashes(body: &[u8]) -> Vec<String> {
        let length = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
        let index: Vec<Value> = serde_json::from_slice(&body[4..4 + length]).unwrap();
        index
            .iter()
            .map(|e| e["hash"].as_str().unwrap().to_owned())
            .collect()
    }

    #[tokio::test]
    async fn uploads_only_missing_contents_once_and_retries_transient_failures() {
        let base = tree([("a.txt", b"one\n"), ("shared.txt", b"shared\n")]);
        let mut head = tree([("a.txt", b"two\n"), ("shared.txt", b"shared\n")]);
        let large = vec![7u8; 9 * MIB as usize];
        head.insert(
            "large.bin".into(),
            TreeEntry {
                mode: 0o100644,
                object_id: String::new(),
                content: large.clone(),
            },
        );
        let (stored, large_hash) = (hash(b"one\n"), hash(&large));
        let id = hash(&prepare(&base, &head, &LIMITS).unwrap().manifest);
        let mut failed = HashSet::new();
        let expected_id = id.clone();
        // missing, pack, create upload, 2 parts, complete, chunk (503, 201), seal
        let (url, log, server) = serve(9, move |method, path, body| {
            if path == "/v1/contents/missing" {
                let request: Value = serde_json::from_slice(body).unwrap();
                let missing: Vec<&Value> = request["hashes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|h| *h != &json!(stored))
                    .collect();
                return (200, json!({ "missing": missing }));
            }
            if path.starts_with("/v1/manifests/")
                && path.contains("/chunks/")
                && failed.insert(path.to_owned())
            {
                return (503, json!({}));
            }
            match (method, path.split('?').next().unwrap()) {
                ("PUT", "/v1/packs") => (201, json!({"pack":"p","contents":2})),
                ("POST", p) if p.ends_with("/uploads/complete") => {
                    assert!(path.ends_with("?upload=u%2F1+x"));
                    let request: Value = serde_json::from_slice(body).unwrap();
                    assert_eq!(
                        request,
                        json!({"size": 9 * MIB, "parts": [
                        {"part": 1, "etag": "e1"}, {"part": 2, "etag": "e2"}]})
                    );
                    (201, json!({}))
                }
                ("POST", p) if p.ends_with("/uploads") => (201, json!({"upload":"u/1 x"})),
                ("PUT", p) if p.contains("/uploads/") => {
                    let part = p.rsplit('/').next().unwrap().parse::<u64>().unwrap();
                    (200, json!({"part": part, "etag": format!("e{part}")}))
                }
                ("PUT", _) => (201, json!({})),
                ("POST", p) if p.ends_with("/seal") => {
                    assert_eq!(body, br#"{"chunks":1}"#);
                    (201, json!({ "id": expected_id }))
                }
                other => panic!("unexpected {other:?}"),
            }
        });
        let upload = client(&url).upload_snapshot(&base, &head).await.unwrap();
        server.join().unwrap();
        assert_eq!(
            upload,
            SnapshotUpload {
                id: id.clone(),
                files: 5,
                contents: 4,
                bytes: 4 + 4 + 7 + 9 * MIB,
                uploaded_contents: 3,
                uploaded_bytes: 4 + 7 + 9 * MIB,
            }
        );
        let log = log.lock().unwrap();
        let paths: Vec<String> = log.iter().map(|(m, p, _)| format!("{m} {p}")).collect();
        assert_eq!(paths[0], "POST /v1/contents/missing");
        // "shared\n" is in both trees but packed once; the stored content is skipped.
        let pack = log.iter().find(|(_, p, _)| p == "/v1/packs").unwrap();
        let mut packed = pack_hashes(&pack.2);
        packed.sort();
        let mut expected = vec![hash(b"two\n"), hash(b"shared\n")];
        expected.sort();
        assert_eq!(packed, expected);
        let parts: Vec<usize> = log
            .iter()
            .filter(|(m, p, _)| {
                m == "PUT" && p.starts_with(&format!("/v1/contents/{large_hash}/uploads/"))
            })
            .map(|(_, _, body)| body.len())
            .collect();
        assert_eq!(parts, vec![8 * MIB as usize, MIB as usize]);
        let chunk = format!("PUT /v1/manifests/{id}/chunks/0");
        assert_eq!(paths.iter().filter(|p| **p == chunk).count(), 2);
        assert_eq!(
            paths.last().unwrap(),
            &format!("POST /v1/manifests/{id}/seal")
        );
    }

    #[tokio::test]
    async fn client_errors_are_not_retried_and_nothing_uploads_after_them() {
        let (url, log, server) = serve(1, |_, _, _| (400, json!({"error":"invalid"})));
        let base = tree([("a.txt", b"one\n")]);
        let error = client(&url)
            .upload_snapshot(&base, &base)
            .await
            .unwrap_err();
        server.join().unwrap();
        assert_eq!(http_status(&error), Some(400));
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn present_large_contents_and_sealed_manifests_upload_nothing_more() {
        let mut head = Tree::new();
        head.insert(
            "large.bin".into(),
            TreeEntry {
                mode: 0o100755,
                object_id: String::new(),
                content: vec![1u8; MAX_PACKED_CONTENT + 1],
            },
        );
        let id = hash(&prepare(&Tree::new(), &head, &LIMITS).unwrap().manifest);
        let sealed = id.clone();
        let (url, log, server) = serve(4, move |_, path, body| {
            if path == "/v1/contents/missing" {
                let request: Value = serde_json::from_slice(body).unwrap();
                (200, json!({ "missing": request["hashes"] }))
            } else if path.ends_with("/uploads") {
                (200, json!({"present": true}))
            } else if path.ends_with("/seal") {
                (200, json!({ "id": sealed }))
            } else {
                (201, json!({}))
            }
        });
        let upload = client(&url)
            .upload_snapshot(&Tree::new(), &head)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(upload.id, id);
        assert_eq!(log.lock().unwrap().len(), 4);
    }
}

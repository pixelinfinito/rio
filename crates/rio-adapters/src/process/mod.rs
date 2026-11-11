//! All executable checks and version probes use the same bounded supervisor.
#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

use std::{
    collections::BTreeMap,
    ffi::OsString,
    io,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use rio_core::{CancellationReason, FailureReason};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::mpsc,
    time::{Instant, sleep, timeout},
};
use tokio_util::sync::CancellationToken;

use crate::retained_raw;

#[derive(Debug, Clone)]
pub struct ToolCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: BTreeMap<OsString, OsString>,
    pub timeout: Duration,
    /// Maximum parsed bytes per stream, independently for stdout and stderr.
    pub output_limit: usize,
}

impl ToolCommand {
    pub fn new(program: PathBuf, cwd: PathBuf) -> Self {
        Self {
            program,
            args: Vec::new(),
            cwd,
            env: BTreeMap::new(),
            timeout: Duration::from_secs(240),
            output_limit: 256 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone)]
pub enum Termination {
    Exited { code: Option<i32> },
    Failed { reason: FailureReason, hint: String },
    Cancelled { reason: CancellationReason },
}

pub struct ProcessResult {
    pub termination: Termination,
    /// Unredacted bytes are private parser input; persist only `raw_*` fields.
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub raw_stdout: Vec<u8>,
    pub raw_stderr: Vec<u8>,
    pub wall_time: Duration,
    pub cleanup_confirmed: bool,
    pub survivors: Vec<String>,
}

#[derive(Default)]
struct Captured {
    bytes: Vec<u8>,
    error: Option<String>,
}

async fn collect(
    mut stream: impl AsyncRead + Unpin,
    captured: Arc<Mutex<Captured>>,
    limit: usize,
    exceeded: mpsc::Sender<()>,
    tap: Option<(String, OutputTap)>,
) {
    let mut buffer = [0u8; 8192];
    let mut notified = false;
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) => return,
            Ok(count) => {
                if let Some((program, tap)) = &tap {
                    tap(program, &buffer[..count]);
                }
                let over_limit = {
                    let mut captured = captured.lock().unwrap();
                    let available = limit.saturating_sub(captured.bytes.len());
                    captured
                        .bytes
                        .extend_from_slice(&buffer[..count.min(available)]);
                    count > available
                };
                if over_limit && !notified {
                    let _ = exceeded.send(()).await;
                    notified = true;
                }
            }
            Err(error) => {
                captured.lock().unwrap().error = Some(error.to_string());
                return;
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct ProcessSupervisor {
    active: Arc<Mutex<BTreeMap<u32, Arc<platform::ProcessTree>>>>,
    /// Receives each chunk of tool output as it is read, with the program's
    /// file name; the interactive UI shows it as a step log.
    tap: Arc<Mutex<Option<OutputTap>>>,
}

/// A receiver of tool output: `(program, chunk)`.
pub type OutputTap = Arc<dyn Fn(&str, &[u8]) + Send + Sync>;

impl ProcessSupervisor {
    /// Send every tool's output to `tap` as it arrives, in addition to capturing it.
    pub fn tap_output(&self, tap: OutputTap) {
        *self.tap.lock().unwrap() = Some(tap);
    }
}

struct Registration {
    supervisor: ProcessSupervisor,
    pid: u32,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(tree) = self.supervisor.active.lock().unwrap().remove(&self.pid) {
            tree.kill();
        }
    }
}

impl ProcessSupervisor {
    /// Used on the second interrupt. Every group/job is killed immediately;
    /// ordinary cancellation still awaits group/job exit before tree cleanup.
    pub fn kill_all(&self) {
        for tree in self.active.lock().unwrap().values() {
            tree.kill();
        }
    }

    pub async fn run(
        &self,
        request: ToolCommand,
        cancellation: CancellationToken,
    ) -> ProcessResult {
        let started = Instant::now();
        let empty_failure = |error: io::Error| ProcessResult {
            termination: Termination::Failed {
                reason: FailureReason::SpawnFailed,
                hint: format!("{}: {error}", request.program.display()),
            },
            stdout: Vec::new(),
            stderr: Vec::new(),
            raw_stdout: Vec::new(),
            raw_stderr: Vec::new(),
            wall_time: started.elapsed(),
            cleanup_confirmed: true,
            survivors: Vec::new(),
        };
        if cancellation.is_cancelled() {
            let mut result = empty_failure(io::Error::other("cancelled before spawn"));
            result.termination = Termination::Cancelled {
                reason: CancellationReason::Interrupted,
            };
            return result;
        }
        let tree = match platform::ProcessTree::new() {
            Ok(tree) => Arc::new(tree),
            Err(error) => return empty_failure(error),
        };
        let mut command = Command::new(&request.program);
        command
            .args(&request.args)
            .current_dir(&request.cwd)
            .envs(&request.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        tree.configure(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => return empty_failure(error),
        };
        if let Err(error) = tree.attach(&child) {
            tree.kill();
            let _ = child.kill().await;
            let _ = child.wait().await;
            return empty_failure(error);
        }
        let pid = child.id().expect("a newly spawned child has a process id");
        self.active.lock().unwrap().insert(pid, tree.clone());
        let _registration = Registration {
            supervisor: self.clone(),
            pid,
        };
        let stdout = Arc::new(Mutex::new(Captured::default()));
        let stderr = Arc::new(Mutex::new(Captured::default()));
        let (exceeded, mut exceeded_rx) = mpsc::channel(2);
        let tap = self.tap.lock().unwrap().clone().map(|tap| {
            let program = request
                .program
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            (program, tap)
        });
        let stdout_reader = tokio::spawn(collect(
            child.stdout.take().unwrap(),
            stdout.clone(),
            request.output_limit,
            exceeded.clone(),
            tap.clone(),
        ));
        let stderr_reader = tokio::spawn(collect(
            child.stderr.take().unwrap(),
            stderr.clone(),
            request.output_limit,
            exceeded,
            tap,
        ));
        let deadline = sleep(request.timeout);
        tokio::pin!(deadline);
        let mut observation = tokio::time::interval(Duration::from_millis(100));
        let mut termination = loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => break Termination::Cancelled {reason:CancellationReason::Interrupted},
                Some(()) = exceeded_rx.recv() => break Termination::Failed {reason:FailureReason::OutputLimit,hint:format!("tool output exceeded {} bytes per stream",request.output_limit)},
                _ = &mut deadline => break Termination::Cancelled {reason:CancellationReason::Timeout},
                result = child.wait() => break match result {
                    Ok(status) => Termination::Exited {code:status.code()},
                    Err(error) => Termination::Failed {reason:FailureReason::ToolCrashed,hint:error.to_string()},
                },
                _ = observation.tick() => tree.observe(),
            }
        };
        tree.observe();
        let cleanup_confirmed = cleanup(&tree, &mut child).await;
        // A descendant that escaped its group may still hold an output handle.
        // Reader deadlines cannot keep a cancelled check alive indefinitely.
        for reader in [stdout_reader, stderr_reader] {
            let abort = reader.abort_handle();
            if timeout(Duration::from_millis(500), reader).await.is_err() {
                abort.abort();
            }
        }
        if exceeded_rx.try_recv().is_ok() && matches!(termination, Termination::Exited { .. }) {
            termination = Termination::Failed {
                reason: FailureReason::OutputLimit,
                hint: format!(
                    "tool output exceeded {} bytes per stream",
                    request.output_limit
                ),
            };
        }
        let take = |capture: &Arc<Mutex<Captured>>| {
            let mut captured = capture.lock().unwrap();
            (std::mem::take(&mut captured.bytes), captured.error.take())
        };
        let (stdout, stdout_error) = take(&stdout);
        let (stderr, stderr_error) = take(&stderr);
        if let Some(error) = stdout_error.or(stderr_error)
            && matches!(termination, Termination::Exited { .. })
        {
            termination = Termination::Failed {
                reason: FailureReason::ToolCrashed,
                hint: format!("could not read tool output: {error}"),
            };
        }
        let survivors = tree.survivors();
        if cleanup_confirmed && survivors.is_empty() {
            tree.disarm();
        }
        ProcessResult {
            termination,
            raw_stdout: retained_raw(&stdout, 16 * 1024 * 1024),
            raw_stderr: retained_raw(&stderr, 16 * 1024 * 1024),
            stdout,
            stderr,
            wall_time: started.elapsed(),
            cleanup_confirmed: cleanup_confirmed && survivors.is_empty(),
            survivors,
        }
    }
}

async fn cleanup(tree: &platform::ProcessTree, child: &mut Child) -> bool {
    tree.terminate();
    let grace = Instant::now() + Duration::from_secs(5);
    // Reap the leader before adopted children so Tokio owns its wait status.
    if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
        tree.kill();
    }
    loop {
        tree.reap();
        if !tree.alive() {
            return true;
        }
        if Instant::now() >= grace {
            break;
        }
        sleep(Duration::from_millis(20)).await;
    }
    tree.kill();
    let _ = timeout(Duration::from_secs(5), child.wait()).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        tree.reap();
        if !tree.alive() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(Duration::from_millis(20)).await;
    }
}

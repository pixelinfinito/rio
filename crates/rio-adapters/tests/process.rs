use rio_adapters::{ProcessSupervisor, Termination, ToolCommand};
use rio_core::{CancellationReason, FailureReason};
use std::{fs, path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

fn python() -> PathBuf {
    if cfg!(windows) {
        "python".into()
    } else {
        "python3".into()
    }
}
fn command(root: &std::path::Path, code: &str) -> ToolCommand {
    let mut command = ToolCommand::new(python(), root.into());
    command.args = vec!["-c".into(), code.into()];
    command
}
fn exists(pid: u32) -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(pid)]),
        true,
    );
    system.process(sysinfo::Pid::from_u32(pid)).is_some()
}

#[tokio::test]
async fn completed_process_captures_streams_and_redacts_raw_output() {
    let root = tempfile::tempdir().unwrap();
    let value = format!("ghp_{}", "Ab1".repeat(12));
    let code = format!("import sys; print({value:?}); print('stderr',file=sys.stderr)");
    let result = ProcessSupervisor::default()
        .run(command(root.path(), &code), CancellationToken::new())
        .await;
    assert!(matches!(
        result.termination,
        Termination::Exited { code: Some(0) }
    ));
    assert!(String::from_utf8_lossy(&result.stdout).contains(&value));
    assert!(!String::from_utf8_lossy(&result.raw_stdout).contains(&value));
    assert_eq!(String::from_utf8_lossy(&result.stderr).trim(), "stderr");
    assert!(result.cleanup_confirmed, "{:?}", result.survivors);
}

#[tokio::test]
async fn timeout_terminates_a_long_lived_grandchild_before_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let code = "import subprocess,sys,time,pathlib; p=subprocess.Popen([sys.executable,'-c', 'import time; time.sleep(3600)']); pathlib.Path('child.pid').write_text(str(p.pid)); time.sleep(3600)";
    let mut request = command(root.path(), code);
    // Concurrent Python startup on Windows runners can take several seconds.
    // The worker still sleeps for an hour, so this exercises timeout cleanup.
    request.timeout = Duration::from_secs(if cfg!(windows) { 15 } else { 3 });
    let result = ProcessSupervisor::default()
        .run(request, CancellationToken::new())
        .await;
    assert!(
        matches!(
            result.termination,
            Termination::Cancelled {
                reason: CancellationReason::Timeout
            }
        ),
        "{:?}",
        result.termination
    );
    let pid = fs::read_to_string(root.path().join("child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        !exists(pid),
        "grandchild {pid} survived: {:?}",
        result.survivors
    );
    assert!(result.cleanup_confirmed, "{:?}", result.survivors);
}

#[tokio::test]
async fn cancellation_terminates_all_workers_and_never_started_work_is_cancelled() {
    let root = tempfile::tempdir().unwrap();
    let code = "import subprocess,sys,time,pathlib; p=subprocess.Popen([sys.executable,'-c', 'import time; time.sleep(3600)']); pathlib.Path('child.pid').write_text(str(p.pid)); time.sleep(3600)";
    let cancellation = CancellationToken::new();
    let task = {
        let cancellation = cancellation.clone();
        let request = command(root.path(), code);
        tokio::spawn(async move {
            ProcessSupervisor::default()
                .run(request, cancellation)
                .await
        })
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !root.path().join("child.pid").exists() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    cancellation.cancel();
    let result = task.await.unwrap();
    assert!(matches!(
        result.termination,
        Termination::Cancelled {
            reason: CancellationReason::Interrupted
        }
    ));
    let pid = fs::read_to_string(root.path().join("child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!exists(pid), "grandchild {pid} survived");
    assert!(result.cleanup_confirmed, "{:?}", result.survivors);
    let result = ProcessSupervisor::default()
        .run(
            command(root.path(), "raise RuntimeError('must not start')"),
            cancellation,
        )
        .await;
    assert!(matches!(
        result.termination,
        Termination::Cancelled {
            reason: CancellationReason::Interrupted
        }
    ));
    assert!(result.stdout.is_empty() && result.stderr.is_empty());
}

#[tokio::test]
async fn per_stream_output_limit_is_a_failure_and_other_checks_continue() {
    let root = tempfile::tempdir().unwrap();
    let mut request = command(
        root.path(),
        "import sys,time; sys.stdout.write('a'*100000); sys.stdout.flush(); time.sleep(3600)",
    );
    request.output_limit = 4096;
    let supervisor = ProcessSupervisor::default();
    let (limited, other) = tokio::join!(
        supervisor.run(request, CancellationToken::new()),
        supervisor.run(
            command(root.path(), "print('done')"),
            CancellationToken::new()
        )
    );
    assert!(matches!(
        limited.termination,
        Termination::Failed {
            reason: FailureReason::OutputLimit,
            ..
        }
    ));
    assert_eq!(limited.stdout.len(), 4096);
    assert!(limited.cleanup_confirmed, "{:?}", limited.survivors);
    assert!(matches!(
        other.termination,
        Termination::Exited { code: Some(0) }
    ));
}

#[tokio::test]
async fn failed_spawn_has_a_path_hint_and_no_lingering_tree() {
    let root = tempfile::tempdir().unwrap();
    let mut request = command(root.path(), "");
    request.program = root.path().join("does-not-exist");
    let result = ProcessSupervisor::default()
        .run(request, CancellationToken::new())
        .await;
    assert!(
        matches!(&result.termination,Termination::Failed {reason:FailureReason::SpawnFailed,hint} if hint.contains("does-not-exist"))
    );
    assert!(result.cleanup_confirmed);
}

#[cfg(unix)]
#[tokio::test]
async fn sigterm_resistant_descendants_are_force_killed_after_grace() {
    let root = tempfile::tempdir().unwrap();
    let code = "import subprocess,sys,time,pathlib,signal; signal.signal(signal.SIGTERM,signal.SIG_IGN); p=subprocess.Popen([sys.executable,'-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(3600)']); pathlib.Path('child.pid').write_text(str(p.pid)); time.sleep(3600)";
    let mut request = command(root.path(), code);
    request.timeout = Duration::from_millis(500);
    let result = ProcessSupervisor::default()
        .run(request, CancellationToken::new())
        .await;
    assert!(matches!(
        result.termination,
        Termination::Cancelled {
            reason: CancellationReason::Timeout
        }
    ));
    let pid = fs::read_to_string(root.path().join("child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!exists(pid));
    assert!(result.cleanup_confirmed, "{:?}", result.survivors);
}

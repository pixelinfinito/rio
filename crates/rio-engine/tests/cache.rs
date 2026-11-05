use fs4::fs_std::FileExt;
use rio_core::{Report, ReportStatus};
use rio_engine::*;
use std::{collections::BTreeSet, fs, time::Duration};

#[test]
fn live_references_survive_pruning_then_unreferenced_entries_are_removed() {
    let temp = tempfile::tempdir().unwrap();
    let options = CacheOptions::for_repository(temp.path());
    let run = RunCache::begin(options.clone(), "1234567890abcdef".into()).unwrap();
    run.reference("heads/shared/tree").unwrap();
    fs::create_dir_all(options.dir.join("heads/shared/tree")).unwrap();
    fs::write(options.dir.join("heads/shared/tree/source"), "keep").unwrap();
    fs::create_dir_all(options.dir.join("heads/unused/tree")).unwrap();
    // Pruning is best effort and can skip a contended lock. In particular,
    // concurrently spawned children can briefly inherit locks before exec.
    let prune_until = |options: &CacheOptions, done: &dyn Fn() -> bool| {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            prune_cache(options, None).unwrap();
            if done() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "cache pruning did not converge"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    prune_until(&options, &|| !options.dir.join("heads/unused").exists());
    assert!(options.dir.join("heads/shared/tree/source").exists());
    drop(run);
    prune_cache(&options, None).unwrap();
    // Retained run records still reference this source.
    assert!(options.dir.join("heads/shared/tree/source").exists());
    let mut expired = options.clone();
    expired.max_age = Duration::ZERO;
    prune_until(&expired, &|| !options.dir.join("heads/shared").exists());
}
#[test]
fn dead_temporary_writes_are_never_read_and_live_entry_writes_are_protected() {
    let temp = tempfile::tempdir().unwrap();
    let options = CacheOptions::for_repository(temp.path());
    let run = RunCache::begin(options.clone(), "1234567890abcdef".into()).unwrap();
    let directory = options.dir.join("baselines/base");
    fs::create_dir_all(&directory).unwrap();
    let dead = directory.join("dead.tmp-crashed");
    fs::write(&dead, "partial").unwrap();
    let live = directory.join("live.tmp-inflight");
    fs::write(&live, "partial").unwrap();
    let lock = rio_git::private_file(&directory.join("live.lock"), false).unwrap();
    FileExt::lock_exclusive(&lock).unwrap();
    prune_cache(&options, None).unwrap();
    assert!(!dead.exists());
    assert!(live.exists());
    drop(lock);
    prune_cache(&options, None).unwrap();
    assert!(!live.exists());
    drop(run);
}
#[test]
fn size_eviction_reachability_and_prune_lock_are_respected() {
    let temp = tempfile::tempdir().unwrap();
    let mut options = CacheOptions::for_repository(temp.path());
    let run = RunCache::begin(options.clone(), "1234567890abcdef".into()).unwrap();
    fs::create_dir_all(options.dir.join("baselines/reachable/tree")).unwrap();
    fs::write(
        options.dir.join("baselines/reachable/tree/a"),
        vec![0; 10000],
    )
    .unwrap();
    fs::create_dir_all(options.dir.join("baselines/unreachable/tree")).unwrap();
    let lock = rio_git::private_file(&options.dir.join("prune.lock"), false).unwrap();
    FileExt::lock_exclusive(&lock).unwrap();
    let reachable = BTreeSet::from(["reachable".into()]);
    prune_cache(&options, Some(&reachable)).unwrap();
    assert!(options.dir.join("baselines/unreachable").exists());
    drop(lock);
    prune_cache(&options, Some(&reachable)).unwrap();
    assert!(!options.dir.join("baselines/unreachable").exists());
    assert!(options.dir.join("baselines/reachable/tree/a").exists());
    options.max_size = 1000;
    prune_cache(&options, None).unwrap();
    assert!(!options.dir.join("baselines/reachable").exists());
    drop(run);
}
#[test]
fn independent_runs_publish_complete_records_and_latest_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let options = CacheOptions::for_repository(temp.path());
    let first = RunCache::begin(options.clone(), "1234567890abcdef".into()).unwrap();
    let second = RunCache::begin(options.clone(), first.review_id.clone()).unwrap();
    assert_ne!(first.run_id, second.run_id);
    assert_ne!(first.path, second.path);
    first
        .finish(&Report::empty(ReportStatus::Complete))
        .unwrap();
    second
        .finish(&Report::empty(ReportStatus::Partial))
        .unwrap();
    assert_eq!(
        fs::read_to_string(options.dir.join(&first.review_id).join("latest")).unwrap(),
        second.run_id
    );
    assert_eq!(fs::read(options.dir.join(".gitignore")).unwrap(), b"*\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&options.dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(first.path.join("report.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn crash_writer() {
    let Some(directory) = std::env::var_os("RIO_TEST_CRASH_CACHE") else {
        return;
    };
    let mut options = CacheOptions::for_repository(std::path::Path::new("."));
    options.dir = directory.into();
    let run = RunCache::begin(options.clone(), "1234567890abcdef".into()).unwrap();
    run.reference("baselines/base/typecheck/result.json")
        .unwrap();
    let path = options.dir.join("baselines/base/typecheck");
    fs::create_dir_all(&path).unwrap();
    let lock = rio_git::private_file(&path.join("result.json.lock"), false).unwrap();
    FileExt::lock_exclusive(&lock).unwrap();
    fs::write(
        path.join(format!("result.json.tmp-{}", run.run_id)),
        "incomplete JSON",
    )
    .unwrap();
    fs::write(options.dir.join("writer.ready"), "ready").unwrap();
    std::thread::sleep(Duration::from_secs(60));
    drop(lock);
}
#[test]
fn process_killed_during_baseline_publication_is_recovered() {
    let temp = tempfile::tempdir().unwrap();
    let options = CacheOptions::for_repository(temp.path());
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_writer", "--nocapture"])
        .env("RIO_TEST_CRASH_CACHE", &options.dir)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while !options.dir.join("writer.ready").exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(
        !options
            .dir
            .join("baselines/base/typecheck/result.json")
            .exists()
    );
    prune_cache(&options, None).unwrap();
    assert!(
        fs::read_dir(options.dir.join("active"))
            .unwrap()
            .next()
            .is_none()
    );
    assert!(
        !fs::read_dir(options.dir.join("baselines/base/typecheck"))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp-"))
    );
}

#[test]
fn pruning_a_latest_run_repairs_the_pointer() {
    let temp = tempfile::tempdir().unwrap();
    let options = CacheOptions::for_repository(temp.path());
    let first = RunCache::begin(options.clone(), "1234567890abcdef".into()).unwrap();
    first
        .finish(&Report::empty(ReportStatus::Complete))
        .unwrap();
    let second = RunCache::begin(options.clone(), first.review_id.clone()).unwrap();
    second
        .finish(&Report::empty(ReportStatus::Complete))
        .unwrap();
    fs::remove_dir_all(&second.path).unwrap();
    drop(second);
    prune_cache(&options, None).unwrap();
    assert_eq!(
        fs::read_to_string(options.dir.join(&first.review_id).join("latest")).unwrap(),
        first.run_id
    );
}

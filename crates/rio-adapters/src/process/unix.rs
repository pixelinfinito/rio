use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
    },
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tokio::process::{Child, Command};

pub struct ProcessTree {
    pid: AtomicU32,
    observed: Mutex<BTreeMap<u32, u64>>,
}

impl ProcessTree {
    pub fn new() -> io::Result<Self> {
        #[cfg(target_os = "linux")]
        {
            static SUBREAPER: std::sync::OnceLock<Result<(), i32>> = std::sync::OnceLock::new();
            let result = SUBREAPER.get_or_init(|| {
                // SAFETY: this changes only the caller's subreaper flag; no pointers.
                if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error()
                        .raw_os_error()
                        .unwrap_or(libc::EINVAL))
                }
            });
            if let Err(code) = result {
                return Err(io::Error::from_raw_os_error(*code));
            }
        }
        Ok(Self {
            pid: AtomicU32::new(0),
            observed: Mutex::new(BTreeMap::new()),
        })
    }
    pub fn configure(&self, command: &mut Command) {
        command.process_group(0);
    }
    pub fn attach(&self, child: &Child) -> io::Result<()> {
        self.pid.store(
            child
                .id()
                .ok_or_else(|| io::Error::other("child exited before attachment"))?,
            Ordering::Release,
        );
        self.observe();
        Ok(())
    }
    fn signal(&self, signal: i32) {
        let pid = self.pid.load(Ordering::Acquire);
        if pid != 0 {
            // SAFETY: a negative pid names only the freshly created child group.
            unsafe { libc::kill(-(pid as i32), signal) };
        }
    }
    pub fn disarm(&self) {
        self.pid.store(0, Ordering::Release);
    }
    pub fn terminate(&self) {
        self.signal(libc::SIGTERM);
    }
    pub fn kill(&self) {
        self.signal(libc::SIGKILL);
    }
    pub fn alive(&self) -> bool {
        let pid = self.pid.load(Ordering::Acquire);
        // SAFETY: signal 0 probes the existence of our child group without mutation.
        pid != 0
            && (unsafe { libc::kill(-(pid as i32), 0) } == 0
                || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }
    pub fn reap(&self) {
        #[cfg(target_os = "linux")]
        {
            let pid = self.pid.load(Ordering::Acquire);
            if pid == 0 {
                return;
            }
            loop {
                // SAFETY: only non-blocking waits for our own adopted group members.
                let reaped =
                    unsafe { libc::waitpid(-(pid as i32), std::ptr::null_mut(), libc::WNOHANG) };
                if reaped <= 0 {
                    break;
                }
            }
        }
    }
    fn snapshot() -> System {
        let mut system = System::new();
        // Only PID, parent and start identity are needed for supervision.
        // Avoid refreshing executable paths, memory, CPU and every OS thread
        // twice per observation, especially with many concurrent reviews.
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        system
    }
    pub fn observe(&self) {
        let root = self.pid.load(Ordering::Acquire);
        if root == 0 {
            return;
        }
        let system = Self::snapshot();
        let mut descendants = BTreeSet::from([root]);
        loop {
            let before = descendants.len();
            for (pid, process) in system.processes() {
                if process
                    .parent()
                    .is_some_and(|parent| descendants.contains(&parent.as_u32()))
                {
                    descendants.insert(pid.as_u32());
                }
            }
            if descendants.len() == before {
                break;
            }
        }
        let mut observed = self.observed.lock().unwrap();
        for pid in descendants {
            if let Some(process) = system.process(Pid::from_u32(pid)) {
                observed.insert(pid, process.start_time());
            }
        }
    }
    pub fn survivors(&self) -> Vec<String> {
        let system = Self::snapshot();
        self.observed
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(pid, start)| {
                let process = system.process(Pid::from_u32(*pid))?;
                (process.start_time() == *start).then(|| {
                    format!(
                        "pid {pid} ({}) survived its process group",
                        process.name().to_string_lossy()
                    )
                })
            })
            .collect()
    }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.kill();
    }
}

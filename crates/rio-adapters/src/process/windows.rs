use std::{
    io,
    mem::{size_of, zeroed},
    sync::atomic::{AtomicU32, Ordering},
};
use tokio::process::{Child, Command};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        },
        Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED},
    },
};

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process: HANDLE) -> i32;
}

pub struct ProcessTree {
    job: HANDLE,
    pid: AtomicU32,
}
// SAFETY: job handles support concurrent Job Object APIs. The owned handle is
// closed only after all Arc owners have released the tree.
unsafe impl Send for ProcessTree {}
unsafe impl Sync for ProcessTree {}

impl ProcessTree {
    pub fn new() -> io::Result<Self> {
        // SAFETY: null security/name pointers use documented default attributes.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the POD structure is valid when zero-initialized.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: buffer and size describe the matching job information class.
        if unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error);
        }
        Ok(Self {
            job,
            pid: AtomicU32::new(0),
        })
    }
    pub fn configure(&self, command: &mut Command) {
        command.creation_flags(CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP);
    }
    pub fn attach(&self, child: &Child) -> io::Result<()> {
        let handle = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("missing suspended process handle"))?
            as HANDLE;
        // SAFETY: handle is a live suspended child; it cannot execute before
        // successful job assignment and the following resume call.
        if unsafe { AssignProcessToJobObject(self.job, handle) } == 0 {
            return Err(io::Error::last_os_error());
        }
        self.pid.store(child.id().unwrap_or(0), Ordering::Release);
        if unsafe { NtResumeProcess(handle) } < 0 {
            return Err(io::Error::other("could not resume assigned process"));
        }
        Ok(())
    }
    pub fn disarm(&self) {}
    pub fn terminate(&self) {
        self.kill();
    }
    pub fn kill(&self) {
        unsafe { TerminateJobObject(self.job, 1) };
    }
    pub fn alive(&self) -> bool {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        let success = unsafe {
            QueryInformationJobObject(
                self.job,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        success == 0 || info.ActiveProcesses > 0
    }
    pub fn reap(&self) {}
    pub fn observe(&self) {}
    pub fn survivors(&self) -> Vec<String> {
        if self.alive() {
            vec![format!(
                "job for pid {} still contains live processes",
                self.pid.load(Ordering::Acquire)
            )]
        } else {
            Vec::new()
        }
    }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.kill();
        unsafe { CloseHandle(self.job) };
    }
}

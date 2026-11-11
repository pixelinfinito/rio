//! The interactive UI host (terminal-ui): when it opens, and the effects it runs.

use std::io::IsTerminal;

/// Whether a command opens the interactive UI: standard input and output are
/// terminals, no `--format`, no `--no-tui`, `RIO_TUI` is not `0` and `CI` is
/// unset or empty. Otherwise the command streams exactly as before.
pub fn interactive(format_given: bool, no_tui: bool) -> bool {
    selected(Selection {
        format_given,
        no_tui,
        stdin_terminal: std::io::stdin().is_terminal(),
        stdout_terminal: std::io::stdout().is_terminal(),
        rio_tui: std::env::var("RIO_TUI").ok(),
        ci: std::env::var("CI").ok(),
    })
}

#[derive(Debug, Clone, Default)]
pub struct Selection {
    pub format_given: bool,
    pub no_tui: bool,
    pub stdin_terminal: bool,
    pub stdout_terminal: bool,
    pub rio_tui: Option<String>,
    pub ci: Option<String>,
}

pub fn selected(s: Selection) -> bool {
    s.stdin_terminal
        && s.stdout_terminal
        && !s.format_given
        && !s.no_tui
        && s.rio_tui.as_deref() != Some("0")
        && s.ci.as_deref().is_none_or(str::is_empty)
}

/// `rio review` in the interactive UI: the start screen, the live run, the
/// findings hub and what it opens, then the summary printed after it closes.
pub async fn review(args: crate::ReviewArgs, started: String) -> u8 {
    let start = match review::start_data(&args).await {
        Ok(start) => start,
        // Without a repository or a valid configuration there is nothing to
        // show: stream the error exactly as without the UI.
        Err(()) => return crate::stream_review(args, started).await,
    };
    let theme = rio_tui::Theme::select(args.no_color, args.ascii);
    let shared = review::Shared::new(&args, started);
    let runtime = tokio::runtime::Handle::current();
    let host_shared = shared.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let on_report = review::findings_builder(host_shared.clone());
        let mut app = rio_tui::App::new(rio_tui::review::start_with(start, on_report), theme);
        app.globals = Some(rio_tui::guide::globals());
        let (reply, messages) = std::sync::mpsc::channel();
        let mut host = review::ReviewHost::new(host_shared, runtime, reply.clone());
        let mut guard = rio_tui::terminal::Guard::enter()?;
        // Diagnostics written to stderr would tear the screen: while the UI
        // is open they become the live screen's stderr tail.
        let capture = StderrCapture::start(reply.clone());
        let result = rio_tui::terminal::run(&mut guard, &mut app, &messages, &reply, &mut host);
        drop(capture);
        drop(guard);
        if host.killed {
            // The second Ctrl-C: tools are killed; leave at once.
            std::process::exit(130);
        }
        // Quitting during a run stops it (an endpoint review is cancelled)
        // before the process exits.
        host.stop();
        result.map(|()| host.killed)
    })
    .await;
    match outcome {
        Ok(Ok(true)) => 130,
        Ok(Ok(false)) => shared.finish(),
        Ok(Err(error)) => {
            eprintln!("rio: the interactive UI failed: {error}");
            3
        }
        Err(error) => {
            rio_tui::terminal::restore();
            eprintln!("rio: the interactive UI failed: {error}");
            3
        }
    }
}

/// `rio qa` in the interactive UI: Q1 (journeys), then the live matrix, cell
/// detail and UX recommendations, then the summary printed after it closes.
/// Returns the exit code `rio qa` returns without the UI.
pub async fn qa(args: crate::ReviewArgs) -> u8 {
    let started = crate::utc_now();
    let data = match qa::journeys_data(&args) {
        Ok(data) => data,
        // Without a repository or a readable QA config there is nothing to
        // show: stream the error exactly as without the UI.
        Err(()) => return crate::stream_review(args, started).await,
    };
    let theme = rio_tui::Theme::select(args.no_color, args.ascii);
    let shared = review::Shared::for_qa(&args, started);
    let runtime = tokio::runtime::Handle::current();
    let host_shared = shared.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let mut app = rio_tui::App::new(rio_tui::qa::journeys(data), theme);
        app.globals = Some(rio_tui::guide::globals());
        let (reply, messages) = std::sync::mpsc::channel();
        let mut host = review::ReviewHost::new(host_shared, runtime, reply.clone());
        let mut guard = rio_tui::terminal::Guard::enter()?;
        // How screenshots are drawn is asked once, in the alternate screen,
        // before any key is read; local runs keep them in the run cache.
        app.session.images = rio_tui::images::Images::detect(&theme);
        if let Some(root) = review::cache_root() {
            app.session.images.set_local_root(root);
        }
        let capture = StderrCapture::start(reply.clone());
        let result = rio_tui::terminal::run(&mut guard, &mut app, &messages, &reply, &mut host);
        drop(capture);
        drop(guard);
        if host.killed {
            std::process::exit(130);
        }
        host.stop();
        result.map(|()| host.killed)
    })
    .await;
    match outcome {
        Ok(Ok(true)) => 130,
        Ok(Ok(false)) => shared.finish(),
        Ok(Err(error)) => {
            eprintln!("rio: the interactive UI failed: {error}");
            3
        }
        Err(error) => {
            rio_tui::terminal::restore();
            eprintln!("rio: the interactive UI failed: {error}");
            3
        }
    }
}

/// `rio init` in the interactive UI: mode, configure with the plan, deploy
/// with progress, the failure or the deployed result, or connect an existing
/// endpoint. After it closes: the GitHub App step when `--github-app` was
/// given, the summary, and the exit code `rio init` returns without the UI.
pub async fn init(github_app: bool, github_org: Option<String>) -> u8 {
    let data = init::init_data().await;
    let theme = rio_tui::Theme::select(false, false);
    let runtime = tokio::runtime::Handle::current();
    let outcome = tokio::task::spawn_blocking(move || {
        let handoff = data.handoff.clone();
        let mut app = rio_tui::App::new(rio_tui::init::choose_mode(data), theme);
        app.globals = Some(rio_tui::guide::globals());
        let (reply, messages) = std::sync::mpsc::channel();
        let mut host = init::InitHost::new(runtime, reply.clone(), handoff);
        let mut guard = rio_tui::terminal::Guard::enter()?;
        let capture = StderrCapture::start(reply.clone());
        let result = rio_tui::terminal::run(&mut guard, &mut app, &messages, &reply, &mut host);
        drop(capture);
        drop(guard);
        if host.killed {
            // The stopped step stays recorded in the user config.
            std::process::exit(130);
        }
        host.stop();
        let ended = host.ended.lock().unwrap_or_else(|e| e.into_inner()).clone();
        result.map(|()| (ended, host.first_review))
    })
    .await;
    let (ended, first_review) = match outcome {
        Ok(Ok(ended)) => ended,
        Ok(Err(error)) => {
            eprintln!("rio: the interactive UI failed: {error}");
            return 3;
        }
        Err(error) => {
            rio_tui::terminal::restore();
            eprintln!("rio: the interactive UI failed: {error}");
            return 3;
        }
    };
    let next = if first_review {
        "Next: rio review opens the review start screen."
    } else {
        "Next: rio review"
    };
    match ended {
        init::Ended::Deployed(endpoint) => {
            let file = crate::config::config_directory()
                .map(|d| d.join("config.toml").display().to_string())
                .unwrap_or_default();
            let _ = crate::write_stdout(
                format!("Rio deployed: {endpoint}\nSaved account and resource choices in {file}\n{next}\n")
                    .as_bytes(),
            );
            if github_app {
                return crate::run_github_app_step(true, github_org, None, false).await;
            }
            0
        }
        init::Ended::Stopped(step, error) => {
            eprintln!("Deployment failed: stopped at {step}: {error}");
            eprintln!("rio deploy resumes it (completed resources are reused).");
            3
        }
        init::Ended::Connected(file) => {
            let _ = crate::write_stdout(
                format!("Rio endpoint configured in {file}\n{next}\n").as_bytes(),
            );
            0
        }
        init::Ended::ConnectFailed(error) => {
            eprintln!("{error}");
            2
        }
        init::Ended::Local => {
            let _ = crate::write_stdout(
                b"Nothing was written. Reviews run locally: rio review --offline\n",
            );
            0
        }
        init::Ended::Nothing => {
            if let Some(step) = crate::deployment::pending() {
                eprintln!("A deployment stopped at {step}; rio deploy resumes it.");
            } else {
                eprintln!("rio init: nothing was changed.");
            }
            0
        }
    }
}

/// `rio review --pr` in a terminal, once the endpoint review finished: the
/// findings hub on its report, with `P` (publish preview, then `y`), then the
/// summary. Returns the exit code the streaming path returns.
pub async fn pull_request(
    args: crate::ReviewArgs,
    started: String,
    report: rio_core::Report,
    policy: rio_core::CompiledFailOn,
    id: String,
    number: u64,
) -> u8 {
    let theme = rio_tui::Theme::select(args.no_color, args.ascii);
    let shared = review::Shared::for_pull_request(&args, started, report, policy, id, number);
    let runtime = tokio::runtime::Handle::current();
    let host_shared = shared.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let data = host_shared.findings().expect("the report is held");
        let report = data.report.clone();
        let mut app = rio_tui::App::new(rio_tui::review::findings(data), theme);
        app.session.report = Some(report);
        app.globals = Some(rio_tui::guide::globals());
        let (reply, messages) = std::sync::mpsc::channel();
        let mut host = review::ReviewHost::new(host_shared, runtime, reply.clone());
        let mut guard = rio_tui::terminal::Guard::enter()?;
        let capture = StderrCapture::start(reply.clone());
        let result = rio_tui::terminal::run(&mut guard, &mut app, &messages, &reply, &mut host);
        drop(capture);
        drop(guard);
        if host.killed {
            std::process::exit(130);
        }
        host.stop();
        result
    })
    .await;
    match outcome {
        Ok(Ok(())) => shared.finish(),
        Ok(Err(error)) => {
            eprintln!("rio: the interactive UI failed: {error}");
            3
        }
        Err(error) => {
            rio_tui::terminal::restore();
            eprintln!("rio: the interactive UI failed: {error}");
            3
        }
    }
}

pub mod images;
pub mod init;
pub mod qa;
pub mod review;
pub mod team;

/// Standard error redirected into the UI as `log` lines from `stderr`.
struct StderrCapture {
    #[cfg(unix)]
    saved: libc::c_int,
}

impl StderrCapture {
    #[cfg(unix)]
    fn start(reply: std::sync::mpsc::Sender<rio_tui::Msg>) -> Option<Self> {
        use std::io::BufRead;
        use std::os::fd::FromRawFd;
        let mut fds = [0; 2];
        // SAFETY: plain descriptor calls; every descriptor opened here is
        // either handed to `File` (closed on drop) or restored in `drop`.
        unsafe {
            if libc::pipe(fds.as_mut_ptr()) != 0 {
                return None;
            }
            let saved = libc::dup(2);
            if saved < 0 || libc::dup2(fds[1], 2) < 0 {
                libc::close(fds[0]);
                libc::close(fds[1]);
                return None;
            }
            libc::close(fds[1]);
            let reader = std::fs::File::from_raw_fd(fds[0]);
            std::thread::spawn(move || {
                for line in std::io::BufReader::new(reader).lines() {
                    let Ok(line) = line else { break };
                    let _ = reply.send(rio_tui::Msg::Review(rio_core::ReviewEvent::Log {
                        source: "stderr".into(),
                        line: rio_core::redact(&line),
                    }));
                }
            });
            Some(Self { saved })
        }
    }

    #[cfg(not(unix))]
    fn start(_reply: std::sync::mpsc::Sender<rio_tui::Msg>) -> Option<Self> {
        None
    }
}

impl Drop for StderrCapture {
    fn drop(&mut self) {
        #[cfg(unix)]
        // SAFETY: restores the descriptor saved in `start`.
        unsafe {
            libc::dup2(self.saved, 2);
            libc::close(self.saved);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal() -> Selection {
        Selection {
            stdin_terminal: true,
            stdout_terminal: true,
            ..Selection::default()
        }
    }

    #[test]
    fn opens_only_in_an_interactive_terminal_without_an_opt_out() {
        assert!(selected(terminal()));
        assert!(selected(Selection {
            ci: Some(String::new()),
            rio_tui: Some("1".into()),
            ..terminal()
        }));
        for off in [
            Selection {
                stdin_terminal: false,
                ..terminal()
            },
            Selection {
                stdout_terminal: false,
                ..terminal()
            },
            Selection {
                format_given: true,
                ..terminal()
            },
            Selection {
                no_tui: true,
                ..terminal()
            },
            Selection {
                rio_tui: Some("0".into()),
                ..terminal()
            },
            Selection {
                ci: Some("true".into()),
                ..terminal()
            },
            Selection {
                ci: Some("1".into()),
                ..terminal()
            },
        ] {
            assert!(!selected(off.clone()), "{off:?}");
        }
    }
}

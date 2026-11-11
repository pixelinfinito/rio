//! The real terminal: raw mode and the alternate screen, always restored.

use std::{
    io::{self, Stdout},
    sync::mpsc::{Receiver, Sender},
    time::{Duration, Instant},
};

use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    crossterm::{
        event::{self, Event, KeyEventKind},
        execute,
        terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
    },
};

use crate::app::{App, Effect, Msg};

/// Raw mode and the alternate screen while alive; restored on drop.
pub struct Guard {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl Guard {
    /// Clear the screen and repaint everything on the next draw. Unlike
    /// `Terminal::clear`, this never asks the terminal where its cursor is,
    /// which a terminal that does not answer would turn into an error.
    fn clear(&mut self) -> io::Result<()> {
        use ratatui::backend::{Backend, ClearType};
        self.terminal.backend_mut().clear_region(ClearType::All)?;
        // The last frame becomes the (reset) buffer drawn into, so the next
        // draw differs from an empty one in every cell.
        self.terminal.swap_buffers();
        Ok(())
    }
}

/// Leave raw mode and the alternate screen; safe to call more than once.
pub fn restore() {
    let _ = disable_raw_mode();
    let _ = execute!(io::stdout(), LeaveAlternateScreen);
}

/// Run `restore` before the previous panic hook, so a panic anywhere leaves
/// the terminal usable before its message prints.
pub fn restore_on_panic(restore: fn()) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        previous(info);
    }));
}

impl Guard {
    pub fn enter() -> io::Result<Self> {
        restore_on_panic(restore);
        enable_raw_mode()?;
        execute!(io::stdout(), EnterAlternateScreen)?;
        let terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
        Ok(Self { terminal })
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        restore();
        let _ = self.terminal.show_cursor();
    }
}

/// Runs effects for the UI; outcomes come back as messages on `reply`.
pub trait Host {
    fn run(&mut self, effect: Effect, reply: &Sender<Msg>);
    /// The screen must be redrawn from scratch (after an editor or pager ran).
    fn take_redraw(&mut self) -> bool {
        false
    }
    /// The host ended the session itself (a hand-off to another command).
    fn finished(&mut self) -> bool {
        false
    }
}

/// Leave the UI for another full-screen program; `resume` returns to it.
pub fn suspend() {
    restore();
}

/// Return to the UI after `suspend`.
pub fn resume() -> io::Result<()> {
    enable_raw_mode()?;
    execute!(io::stdout(), EnterAlternateScreen)
}

const TICK: Duration = Duration::from_millis(250);

/// Draw, read keys and messages, apply effects, until the app is done.
pub fn run(
    guard: &mut Guard,
    app: &mut App,
    messages: &Receiver<Msg>,
    reply: &Sender<Msg>,
    host: &mut dyn Host,
) -> io::Result<()> {
    let mut last_tick = Instant::now();
    let mut last_top = app.top().title();
    while !app.done && !host.finished() {
        // Image protocols draw bitmaps over the grid, which a diff-based redraw
        // does not erase: a new screen starts from a clear terminal.
        let top = app.top().title();
        let images_moved = app.session.images.enabled() && top != last_top;
        last_top = top;
        if host.take_redraw() || images_moved {
            guard.clear()?;
        }
        guard.terminal.draw(|frame| {
            let area = frame.area();
            app.draw(frame.buffer_mut(), area);
        })?;
        let timeout = TICK.saturating_sub(last_tick.elapsed());
        let mut batch = Vec::new();
        if event::poll(timeout)?
            && let Event::Key(key) = event::read()?
            && key.kind != KeyEventKind::Release
        {
            batch.push(Msg::Key(key));
        }
        batch.extend(messages.try_iter());
        if last_tick.elapsed() >= TICK {
            batch.push(Msg::Tick);
            last_tick = Instant::now();
        }
        for msg in batch {
            for effect in app.update(msg) {
                host.run(effect, reply);
            }
        }
    }
    Ok(())
}

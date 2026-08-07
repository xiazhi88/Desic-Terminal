use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Cooperative cancellation handle for CPU-bound research and backtest loops.
/// It deliberately has no async-runtime dependency, so it can also be used by
/// a blocking Tauri worker or a managed Python process supervisor.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

/// Persistable state values for a long-running backtest job. Persistence and
/// task scheduling remain in the app layer; this crate supplies an atomic,
/// deterministic state machine for worker code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BacktestJobState {
    Queued,
    Running,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
}

impl BacktestJobState {
    fn code(self) -> u8 {
        match self {
            Self::Queued => 0,
            Self::Running => 1,
            Self::Cancelling => 2,
            Self::Completed => 3,
            Self::Cancelled => 4,
            Self::Failed => 5,
        }
    }

    fn from_code(code: u8) -> Self {
        match code {
            1 => Self::Running,
            2 => Self::Cancelling,
            3 => Self::Completed,
            4 => Self::Cancelled,
            5 => Self::Failed,
            _ => Self::Queued,
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

/// A point-in-time progress snapshot suitable for bounded UI events. Workers
/// should emit snapshots at coarse intervals rather than once per bar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestJobProgress {
    pub state: BacktestJobState,
    pub completed_steps: u64,
    pub total_steps: u64,
    pub cancellation_requested: bool,
}

/// Thread-safe job control. Invalid transitions are intentionally ignored by
/// terminal methods so a late worker cannot overwrite a completed/cancelled
/// outcome after a supervisor has already persisted it.
#[derive(Debug, Clone)]
pub struct BacktestJobControl {
    token: CancellationToken,
    state: Arc<AtomicU8>,
    completed_steps: Arc<AtomicU64>,
    total_steps: Arc<AtomicU64>,
}

impl Default for BacktestJobControl {
    fn default() -> Self {
        Self::new(0)
    }
}

impl BacktestJobControl {
    pub fn new(total_steps: u64) -> Self {
        Self {
            token: CancellationToken::default(),
            state: Arc::new(AtomicU8::new(BacktestJobState::Queued.code())),
            completed_steps: Arc::new(AtomicU64::new(0)),
            total_steps: Arc::new(AtomicU64::new(total_steps)),
        }
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.token.clone()
    }

    pub fn start(&self) -> bool {
        self.state
            .compare_exchange(
                BacktestJobState::Queued.code(),
                BacktestJobState::Running.code(),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub fn request_cancel(&self) {
        self.token.cancel();
        let mut state = self.state();
        while !state.is_terminal() {
            match self.state.compare_exchange(
                state.code(),
                BacktestJobState::Cancelling.code(),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(actual) => state = BacktestJobState::from_code(actual),
            }
        }
    }

    pub fn record_progress(&self, completed_steps: u64) {
        let total = self.total_steps.load(Ordering::Acquire);
        self.completed_steps
            .store(completed_steps.min(total), Ordering::Release);
    }

    pub fn complete(&self) {
        self.finish(if self.token.is_cancelled() {
            BacktestJobState::Cancelled
        } else {
            BacktestJobState::Completed
        });
    }

    pub fn cancel_complete(&self) {
        self.finish(BacktestJobState::Cancelled);
    }

    pub fn fail(&self) {
        self.finish(BacktestJobState::Failed);
    }

    pub fn state(&self) -> BacktestJobState {
        BacktestJobState::from_code(self.state.load(Ordering::Acquire))
    }

    pub fn progress(&self) -> BacktestJobProgress {
        BacktestJobProgress {
            state: self.state(),
            completed_steps: self.completed_steps.load(Ordering::Acquire),
            total_steps: self.total_steps.load(Ordering::Acquire),
            cancellation_requested: self.token.is_cancelled(),
        }
    }

    fn finish(&self, target: BacktestJobState) {
        let mut state = self.state();
        while !state.is_terminal() {
            match self.state.compare_exchange(
                state.code(),
                target.code(),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(actual) => state = BacktestJobState::from_code(actual),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_visible_to_worker_and_ui() {
        let control = BacktestJobControl::new(10);
        assert!(control.start());
        control.record_progress(4);
        control.request_cancel();

        assert!(control.cancellation_token().is_cancelled());
        assert_eq!(control.progress().state, BacktestJobState::Cancelling);
        assert_eq!(control.progress().completed_steps, 4);

        control.cancel_complete();
        control.complete();
        assert_eq!(control.progress().state, BacktestJobState::Cancelled);
    }
}

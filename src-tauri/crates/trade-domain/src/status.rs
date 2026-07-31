use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalOutcome {
    NoOp,
    Succeeded,
    Partial,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedTerminalState {
    pub outcome: TerminalOutcome,
    pub terminal: bool,
}

/// Normalizes persisted, exchange, and command status aliases without treating
/// accepted or in-flight work as terminal success.
pub fn normalize_terminal_state(raw: &str) -> NormalizedTerminalState {
    let normalized = raw
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .replace(' ', "_");
    match normalized.as_str() {
        "no_op" | "noop" | "nothing_to_do" | "already_absent" | "not_applicable" => {
            NormalizedTerminalState {
                outcome: TerminalOutcome::NoOp,
                terminal: true,
            }
        }
        "succeeded" | "success" | "successful" | "completed" | "complete" | "filled"
        | "canceled" | "cancelled" | "closed" => NormalizedTerminalState {
            outcome: TerminalOutcome::Succeeded,
            terminal: true,
        },
        "partial" | "partially_succeeded" | "partial_success" => NormalizedTerminalState {
            outcome: TerminalOutcome::Partial,
            terminal: true,
        },
        "partially_filled" => NormalizedTerminalState {
            outcome: TerminalOutcome::Partial,
            terminal: false,
        },
        "failed" | "failure" | "error" | "rejected" | "expired" => NormalizedTerminalState {
            outcome: TerminalOutcome::Failed,
            terminal: true,
        },
        _ => NormalizedTerminalState {
            outcome: TerminalOutcome::Unknown,
            terminal: false,
        },
    }
}

pub fn normalize_terminal_outcome(raw: &str) -> TerminalOutcome {
    normalize_terminal_state(raw).outcome
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyTargetState {
    pub target_id: String,
    pub status: TerminalOutcome,
    pub terminal: bool,
}

impl EmergencyTargetState {
    pub fn from_raw(target_id: impl Into<String>, raw_status: &str) -> Self {
        let normalized = normalize_terminal_state(raw_status);
        Self {
            target_id: target_id.into(),
            status: normalized.outcome,
            terminal: normalized.terminal,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyOperationState {
    pub operation: String,
    pub targets: Vec<EmergencyTargetState>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyStatusCounts {
    pub total: usize,
    pub succeeded: usize,
    pub partial: usize,
    pub failed: usize,
    pub unknown: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyOperationSummary {
    pub operation: String,
    pub status: TerminalOutcome,
    pub counts: EmergencyStatusCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmergencyOperationsSummary {
    pub status: TerminalOutcome,
    pub operations: Vec<EmergencyOperationSummary>,
    pub target_counts: EmergencyStatusCounts,
}

/// Summarizes concrete emergency targets. `NoOp` is reserved for an empty
/// target list; a non-empty list succeeds only when every target is terminal
/// and succeeded.
pub fn summarize_emergency_targets(targets: &[EmergencyTargetState]) -> TerminalOutcome {
    summarize_target_refs(targets.iter()).0
}

pub fn summarize_emergency_operation(
    operation: &EmergencyOperationState,
) -> EmergencyOperationSummary {
    let (status, counts) = summarize_target_refs(operation.targets.iter());
    EmergencyOperationSummary {
        operation: operation.operation.clone(),
        status,
        counts,
    }
}

pub fn summarize_emergency_operations(
    operations: &[EmergencyOperationState],
) -> EmergencyOperationsSummary {
    let summaries = operations
        .iter()
        .map(summarize_emergency_operation)
        .collect::<Vec<_>>();
    let (status, target_counts) = summarize_target_refs(
        operations
            .iter()
            .flat_map(|operation| operation.targets.iter()),
    );
    EmergencyOperationsSummary {
        status,
        operations: summaries,
        target_counts,
    }
}

fn summarize_target_refs<'a>(
    targets: impl Iterator<Item = &'a EmergencyTargetState>,
) -> (TerminalOutcome, EmergencyStatusCounts) {
    let mut counts = EmergencyStatusCounts::default();
    for target in targets {
        counts.total += 1;
        match effective_target_outcome(target) {
            TerminalOutcome::Succeeded => counts.succeeded += 1,
            TerminalOutcome::Partial => counts.partial += 1,
            TerminalOutcome::Failed => counts.failed += 1,
            TerminalOutcome::Unknown | TerminalOutcome::NoOp => counts.unknown += 1,
        }
    }

    let status = if counts.total == 0 {
        TerminalOutcome::NoOp
    } else if counts.unknown > 0 {
        TerminalOutcome::Unknown
    } else if counts.succeeded == counts.total {
        TerminalOutcome::Succeeded
    } else if counts.partial > 0 || counts.succeeded > 0 {
        TerminalOutcome::Partial
    } else {
        TerminalOutcome::Failed
    };
    (status, counts)
}

fn effective_target_outcome(target: &EmergencyTargetState) -> TerminalOutcome {
    match (target.terminal, target.status) {
        (true, TerminalOutcome::Succeeded) => TerminalOutcome::Succeeded,
        (_, TerminalOutcome::Partial) => TerminalOutcome::Partial,
        (true, TerminalOutcome::Failed) => TerminalOutcome::Failed,
        _ => TerminalOutcome::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(id: &str, status: TerminalOutcome, terminal: bool) -> EmergencyTargetState {
        EmergencyTargetState {
            target_id: id.to_string(),
            status,
            terminal,
        }
    }

    #[test]
    fn terminal_normalization_keeps_in_flight_states_unknown() {
        assert_eq!(
            normalize_terminal_state("cancelled"),
            NormalizedTerminalState {
                outcome: TerminalOutcome::Succeeded,
                terminal: true,
            }
        );
        assert_eq!(
            normalize_terminal_state("accepted"),
            NormalizedTerminalState {
                outcome: TerminalOutcome::Unknown,
                terminal: false,
            }
        );
        assert_eq!(
            normalize_terminal_state("partially-filled"),
            NormalizedTerminalState {
                outcome: TerminalOutcome::Partial,
                terminal: false,
            }
        );
    }

    #[test]
    fn no_op_is_only_returned_for_no_targets() {
        assert_eq!(summarize_emergency_targets(&[]), TerminalOutcome::NoOp);
        assert_eq!(
            summarize_emergency_targets(&[target("order-1", TerminalOutcome::NoOp, true)]),
            TerminalOutcome::Unknown
        );
    }

    #[test]
    fn every_target_must_be_terminal_and_succeeded() {
        assert_eq!(
            summarize_emergency_targets(&[
                target("order-1", TerminalOutcome::Succeeded, true),
                target("position-1", TerminalOutcome::Succeeded, true),
            ]),
            TerminalOutcome::Succeeded
        );
        assert_eq!(
            summarize_emergency_targets(&[target("order-1", TerminalOutcome::Succeeded, false,)]),
            TerminalOutcome::Unknown
        );
    }

    #[test]
    fn mixed_results_are_partial_and_unconfirmed_results_are_unknown() {
        assert_eq!(
            summarize_emergency_targets(&[
                target("order-1", TerminalOutcome::Succeeded, true),
                target("order-2", TerminalOutcome::Failed, true),
            ]),
            TerminalOutcome::Partial
        );
        assert_eq!(
            summarize_emergency_targets(&[
                target("order-1", TerminalOutcome::Failed, true),
                target("order-2", TerminalOutcome::Unknown, false),
            ]),
            TerminalOutcome::Unknown
        );
        assert_eq!(
            summarize_emergency_targets(&[
                target("order-1", TerminalOutcome::Succeeded, true),
                target("order-2", TerminalOutcome::Unknown, false),
            ]),
            TerminalOutcome::Unknown
        );
        assert_eq!(
            summarize_emergency_targets(&[
                target("order-1", TerminalOutcome::Failed, true),
                target("order-2", TerminalOutcome::Failed, true),
            ]),
            TerminalOutcome::Failed
        );
    }

    #[test]
    fn operations_roll_up_by_targets_and_ignore_empty_operations() {
        let summary = summarize_emergency_operations(&[
            EmergencyOperationState {
                operation: "cancel_orders".to_string(),
                targets: vec![],
            },
            EmergencyOperationState {
                operation: "close_positions".to_string(),
                targets: vec![target(
                    "BTC-USDT-SWAP:long",
                    TerminalOutcome::Succeeded,
                    true,
                )],
            },
        ]);

        assert_eq!(summary.status, TerminalOutcome::Succeeded);
        assert_eq!(summary.operations[0].status, TerminalOutcome::NoOp);
        assert_eq!(summary.target_counts.total, 1);
        assert_eq!(summary.target_counts.succeeded, 1);
    }
}

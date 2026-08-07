use std::fmt;

/// Errors returned by the pure systematic domain layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SystematicError {
    InvalidArgument { field: &'static str, reason: String },
    InvalidState { reason: String },
    DataContractViolation { reason: String },
    OutputContractViolation { reason: String },
    Serialization { reason: String },
}

impl SystematicError {
    pub(crate) fn invalid_argument(field: &'static str, reason: impl Into<String>) -> Self {
        Self::InvalidArgument {
            field,
            reason: reason.into(),
        }
    }

    pub(crate) fn data_contract(reason: impl Into<String>) -> Self {
        Self::DataContractViolation {
            reason: reason.into(),
        }
    }

    pub(crate) fn output_contract(reason: impl Into<String>) -> Self {
        Self::OutputContractViolation {
            reason: reason.into(),
        }
    }
}

impl fmt::Display for SystematicError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgument { field, reason } => {
                write!(formatter, "invalid {field}: {reason}")
            }
            Self::InvalidState { reason } => write!(formatter, "invalid state: {reason}"),
            Self::DataContractViolation { reason } => {
                write!(formatter, "market-data contract violation: {reason}")
            }
            Self::OutputContractViolation { reason } => {
                write!(formatter, "strategy-output contract violation: {reason}")
            }
            Self::Serialization { reason } => write!(formatter, "serialization failed: {reason}"),
        }
    }
}

impl std::error::Error for SystematicError {}

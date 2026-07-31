//! Reference-counted market subscription planning for chart consumers.
//!
//! This module deliberately has no Tauri, WebSocket, or Tokio dependency. The
//! market-stream owner can apply the returned [`MarketSubscriptionDiff`] to its
//! transport while this registry remains deterministic and straightforward to
//! test. A consumer is normally a main chart, detached chart window, or a pane
//! inside a chart workspace.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// A public-market channel requested by a chart consumer.
///
/// Values are ordered so subscriptions and diffs have stable output. This is
/// useful for logging and prevents reconnect plans from changing order between
/// equivalent requests.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MarketChannel {
    Ticker,
    Candles(String),
    Trades,
    OrderBook { depth: u16 },
    FundingRate,
    MarkPrice,
    OpenInterest,
}

impl MarketChannel {
    pub fn candles(timeframe: impl Into<String>) -> Self {
        Self::Candles(timeframe.into())
    }

    pub fn order_book(depth: u16) -> Self {
        Self::OrderBook { depth }
    }
}

/// A concrete symbol/channel subscription sent to the market transport.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MarketSubscription {
    pub symbol: String,
    pub channel: MarketChannel,
}

/// The desired symbol/channel set for one chart consumer.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarketConsumerRequest {
    pub symbols: BTreeSet<String>,
    pub channels: BTreeSet<MarketChannel>,
}

impl MarketConsumerRequest {
    pub fn new(
        symbols: impl IntoIterator<Item = impl Into<String>>,
        channels: impl IntoIterator<Item = MarketChannel>,
    ) -> Self {
        Self {
            symbols: symbols
                .into_iter()
                .map(Into::into)
                .map(|symbol| symbol.trim().to_owned())
                .filter(|symbol| !symbol.is_empty())
                .collect(),
            channels: channels.into_iter().collect(),
        }
    }

    fn subscriptions(&self) -> BTreeSet<MarketSubscription> {
        self.symbols
            .iter()
            .flat_map(|symbol| {
                self.channels
                    .iter()
                    .cloned()
                    .map(move |channel| MarketSubscription {
                        symbol: symbol.clone(),
                        channel,
                    })
            })
            .collect()
    }
}

/// The minimal transport operations required after changing consumer state.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarketSubscriptionDiff {
    /// Subscriptions whose reference count changed from zero to one.
    pub subscribe: Vec<MarketSubscription>,
    /// Subscriptions whose reference count changed from one to zero.
    pub unsubscribe: Vec<MarketSubscription>,
    /// Reference counts after the operation, for diagnostics and consumers
    /// that need to inspect the complete effective subscription set.
    pub reference_counts: BTreeMap<MarketSubscription, usize>,
}

impl MarketSubscriptionDiff {
    pub fn is_noop(&self) -> bool {
        self.subscribe.is_empty() && self.unsubscribe.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MarketConsumerRegistryError {
    EmptyConsumerId,
}

impl fmt::Display for MarketConsumerRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyConsumerId => formatter.write_str("market consumer id cannot be empty"),
        }
    }
}

impl std::error::Error for MarketConsumerRegistryError {}

/// Tracks each market-data consumer and calculates reference-counted diffs.
///
/// Updating a consumer is replace-not-append: a pane changing from BTC to ETH
/// releases the BTC channels it no longer needs and adds only the new ETH
/// channels. A subscription is emitted only when its first consumer arrives;
/// it is removed only after its final consumer leaves.
#[derive(Debug, Default)]
pub struct MarketConsumerRegistry {
    consumers: BTreeMap<String, MarketConsumerRequest>,
    reference_counts: BTreeMap<MarketSubscription, usize>,
}

impl MarketConsumerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds or replaces a consumer's requested channels.
    pub fn add_or_update(
        &mut self,
        consumer_id: impl AsRef<str>,
        request: MarketConsumerRequest,
    ) -> Result<MarketSubscriptionDiff, MarketConsumerRegistryError> {
        let consumer_id = normalized_consumer_id(consumer_id.as_ref())?;
        self.consumers.insert(consumer_id, request);

        Ok(self.reconcile())
    }

    /// Removes a consumer. Removing an unknown consumer is a no-op.
    pub fn remove(&mut self, consumer_id: impl AsRef<str>) -> MarketSubscriptionDiff {
        let consumer_id = consumer_id.as_ref().trim();
        let Some(_) = self.consumers.remove(consumer_id) else {
            return self.snapshot_diff();
        };
        self.reconcile()
    }

    #[allow(dead_code)]
    pub fn consumer(&self, consumer_id: impl AsRef<str>) -> Option<&MarketConsumerRequest> {
        self.consumers.get(consumer_id.as_ref().trim())
    }

    pub fn consumer_count(&self) -> usize {
        self.consumers.len()
    }

    #[allow(dead_code)]
    pub fn reference_count(&self, subscription: &MarketSubscription) -> usize {
        self.reference_counts
            .get(subscription)
            .copied()
            .unwrap_or(0)
    }

    pub fn reference_counts(&self) -> &BTreeMap<MarketSubscription, usize> {
        &self.reference_counts
    }

    fn reconcile(&mut self) -> MarketSubscriptionDiff {
        // Rebuilding from requests makes replacement atomic and avoids subtle
        // decrement/increment ordering bugs when a request has overlapping
        // symbol/channel pairs. Consumer counts are small compared with the
        // market event rate, so this stays off the hot path.
        let next_counts = count_subscriptions(self.consumers.values());
        let subscribe = next_counts
            .keys()
            .filter(|subscription| !self.reference_counts.contains_key(*subscription))
            .cloned()
            .collect();
        let unsubscribe = self
            .reference_counts
            .keys()
            .filter(|subscription| !next_counts.contains_key(*subscription))
            .cloned()
            .collect();

        self.reference_counts = next_counts;
        MarketSubscriptionDiff {
            subscribe,
            unsubscribe,
            reference_counts: self.reference_counts.clone(),
        }
    }

    fn snapshot_diff(&self) -> MarketSubscriptionDiff {
        MarketSubscriptionDiff {
            reference_counts: self.reference_counts.clone(),
            ..MarketSubscriptionDiff::default()
        }
    }
}

fn normalized_consumer_id(value: &str) -> Result<String, MarketConsumerRegistryError> {
    let value = value.trim();
    if value.is_empty() {
        Err(MarketConsumerRegistryError::EmptyConsumerId)
    } else {
        Ok(value.to_owned())
    }
}

fn count_subscriptions<'a>(
    requests: impl IntoIterator<Item = &'a MarketConsumerRequest>,
) -> BTreeMap<MarketSubscription, usize> {
    let mut reference_counts = BTreeMap::new();
    for request in requests {
        for subscription in request.subscriptions() {
            *reference_counts.entry(subscription).or_insert(0) += 1;
        }
    }
    reference_counts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        symbol: &str,
        channels: impl IntoIterator<Item = MarketChannel>,
    ) -> MarketConsumerRequest {
        MarketConsumerRequest::new([symbol], channels)
    }

    fn ticker(symbol: &str) -> MarketSubscription {
        MarketSubscription {
            symbol: symbol.to_owned(),
            channel: MarketChannel::Ticker,
        }
    }

    #[test]
    fn four_panes_for_the_same_symbol_require_one_transport_subscription() {
        let mut registry = MarketConsumerRegistry::new();

        for pane in 1..=4 {
            let diff = registry
                .add_or_update(
                    format!("window-a:pane-{pane}"),
                    request(
                        "BTC-USDT-SWAP",
                        [MarketChannel::Ticker, MarketChannel::candles("1m")],
                    ),
                )
                .unwrap();

            if pane == 1 {
                assert_eq!(diff.subscribe.len(), 2);
            } else {
                assert!(diff.is_noop());
            }
        }

        assert_eq!(registry.reference_count(&ticker("BTC-USDT-SWAP")), 4);
        assert_eq!(registry.reference_counts().len(), 2);
    }

    #[test]
    fn changing_one_pane_only_diffs_the_changed_symbol() {
        let mut registry = MarketConsumerRegistry::new();
        registry
            .add_or_update("pane-a", request("BTC-USDT-SWAP", [MarketChannel::Ticker]))
            .unwrap();
        registry
            .add_or_update("pane-b", request("BTC-USDT-SWAP", [MarketChannel::Ticker]))
            .unwrap();

        let diff = registry
            .add_or_update("pane-a", request("ETH-USDT-SWAP", [MarketChannel::Ticker]))
            .unwrap();

        assert_eq!(diff.subscribe, vec![ticker("ETH-USDT-SWAP")]);
        assert!(diff.unsubscribe.is_empty());
        assert_eq!(registry.reference_count(&ticker("BTC-USDT-SWAP")), 1);
        assert_eq!(registry.reference_count(&ticker("ETH-USDT-SWAP")), 1);
    }

    #[test]
    fn removing_final_consumer_unsubscribes_but_removing_shared_consumer_does_not() {
        let mut registry = MarketConsumerRegistry::new();
        registry
            .add_or_update("pane-a", request("BTC-USDT-SWAP", [MarketChannel::Ticker]))
            .unwrap();
        registry
            .add_or_update("pane-b", request("BTC-USDT-SWAP", [MarketChannel::Ticker]))
            .unwrap();

        assert!(registry.remove("pane-a").is_noop());
        let final_diff = registry.remove("pane-b");
        assert_eq!(final_diff.unsubscribe, vec![ticker("BTC-USDT-SWAP")]);
        assert!(final_diff.reference_counts.is_empty());
    }

    #[test]
    fn request_replacement_removes_only_unneeded_channels() {
        let mut registry = MarketConsumerRegistry::new();
        registry
            .add_or_update(
                "pane-a",
                request(
                    "BTC-USDT-SWAP",
                    [
                        MarketChannel::Ticker,
                        MarketChannel::Trades,
                        MarketChannel::order_book(50),
                    ],
                ),
            )
            .unwrap();

        let diff = registry
            .add_or_update(
                "pane-a",
                request(
                    "BTC-USDT-SWAP",
                    [MarketChannel::Ticker, MarketChannel::Trades],
                ),
            )
            .unwrap();

        assert!(diff.subscribe.is_empty());
        assert_eq!(
            diff.unsubscribe,
            vec![MarketSubscription {
                symbol: "BTC-USDT-SWAP".to_owned(),
                channel: MarketChannel::order_book(50),
            }]
        );
    }

    #[test]
    fn duplicate_symbols_and_channels_are_deduplicated_before_counting() {
        let request = MarketConsumerRequest::new(
            ["BTC-USDT-SWAP", "BTC-USDT-SWAP", "  BTC-USDT-SWAP  "],
            [MarketChannel::Ticker, MarketChannel::Ticker],
        );
        let mut registry = MarketConsumerRegistry::new();
        let diff = registry.add_or_update("pane-a", request).unwrap();

        assert_eq!(diff.subscribe, vec![ticker("BTC-USDT-SWAP")]);
        assert_eq!(registry.reference_count(&ticker("BTC-USDT-SWAP")), 1);
    }

    #[test]
    fn empty_consumer_id_does_not_mutate_registry() {
        let mut registry = MarketConsumerRegistry::new();
        let error = registry
            .add_or_update("   ", request("BTC-USDT-SWAP", [MarketChannel::Ticker]))
            .unwrap_err();

        assert_eq!(error, MarketConsumerRegistryError::EmptyConsumerId);
        assert_eq!(registry.consumer_count(), 0);
    }
}

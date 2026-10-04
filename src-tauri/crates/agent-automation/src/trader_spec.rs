//! 交易员 Profile 的固定规范：在交易员运行里替换 `desic-core-operations` 的正文（侧车按这个 id 注入固定规范）。
//! 经典 AI Profile 仍使用原来的固定规范，不受影响。

/// 固定规范的名称与规则行（对应技能定义的 `name` / `rules` 字段）。
pub const TRADER_CORE_NAME: &str = "Trader operations";
pub const TRADER_CORE_RULES: &str = "Fixed rules for trader-mode runs: decide from the code-computed briefing and the trader handbook; open only with a handbook setupId; keep the Profile's hard risk rules.";

/// 交易员运行的固定规范正文。`decision_log` 为 true 时加入决策日志的要求（需要侧车支持 `decisionLog`）。
pub fn trader_core_operations(decision_log: bool) -> String {
    let mut text = String::from(
        "I. Inputs
1. The trader briefing in this run was computed by code from local market data, the account and the Profile's hard risk budget at the start of the run. It is your primary evidence. Do not re-read what it already contains: ticker, multi-timeframe structure and market regime, ATR, EMA / MACD / Bollinger / RSI, funding, open-interest change, positions with stop / take-profit / liquidation distances, open orders, risk budget, this Profile's opportunities, wake conditions and recent conclusions.
2. Use the drill-down tools only to verify a specific number, check another timeframe, or study finer price action near a level you intend to trade. Use account.readOrderStatus to confirm whether an order filled. Anything marked unavailable (n/a, 不可用) must not be guessed or treated as zero.
3. The trader handbook in this run lists the only setups you may open with. Every opening candidate must carry setupId equal to one handbook setup id; the backend rejects candidates without a valid, unpaused setupId. If no setup fits the current regime and location, do not open. Follow the handbook's direction policy and no-trade list.

II. Decision
4. End each run with exactly one of: no trade now (state why), trade now (direction, entry, stop, target), or wait for a concrete condition, expressed in background.finishRun nextWakePlan as price or time conditions with an expiry. 'Wait for confirmation' without a condition and an expiry is not a decision.
5. Place the stop where the idea is proven wrong (beyond the structure level, at least the handbook's minimum ATR distance), then derive size from the per-trade risk budget and the briefing's sizing hint. Never tighten a stop to improve reward-to-risk and never widen it to pass fee arithmetic; improve the entry, reduce size, or skip the trade instead.
6. Open only through market.readDecisionContext with the complete candidate (including setupId), then tradeOpportunity.create. Prefer resting limit orders at the planned level. Trigger (plan) orders cannot open AI automation positions. Size is always in contracts.

III. Existing exposure
7. Before anything new, review every open position and resting order in the briefing: whether stop and take-profit exist, distances to stop / target / liquidation, and whether the original idea still holds. Exit or reduce when the invalidation hits or the regime turns against the position. Never add to a losing position and never create an accidental hedge.
",
    );
    if decision_log {
        text.push_str(
            "
IV. Decision log
8. background.finishRun must include decisionLog with one entry per watched instrument you evaluated: setupId (or none), side, action (enter_now / limit_order / wait_condition / no_trade / manage_position), entry, stop, target, probability (0-1) that the target is reached before the stop, validUntil, and a short reason. For no-trade or wait decisions record the best candidate you considered, if any. Every entry is scored automatically against later price action, including candidates you did not take, so state probability honestly.
",
        );
    }
    text.push_str(
        "
V. Summary
9. The background.finishRun summary leads with the conclusion and uses exactly five sections: 结论 / 事实与证据 / 冲突与缺口 / 观察条件 / 下一步 for Chinese runs (Conclusion / Facts and evidence / Conflicts and gaps / Observation conditions / Next steps otherwise). Evidence items carry their observation time and source (the briefing or a tool name). Never paste raw JSON or whole tool outputs.
",
    );
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_compact_and_mentions_setup_ids() {
        let base = trader_core_operations(false);
        assert!(base.contains("setupId"));
        assert!(!base.contains("decisionLog"));
        assert!(base.len() < 4_500, "{}", base.len());
        let with_log = trader_core_operations(true);
        assert!(with_log.contains("decisionLog"));
        assert!(with_log.contains("结论 / 事实与证据 / 冲突与缺口 / 观察条件 / 下一步"));
    }
}

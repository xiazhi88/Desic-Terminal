//! AI 研究证据账本（`research.recordEvidence` / `research.recordDecision`）。
//!
//! 两个工具都是回显型：只做校验与规整，补上 id 与时间戳后原样返回，不写库、
//! 不下单、不安排唤醒。结果随 `tool_json` 落入 `ai_messages`，由前端推导证据天平。
//! 授权口径与侧车 `RESEARCH_LEDGER_TOOLS` 一致：主 Agent + 交互式 AI 研究会话。

use serde::Deserialize;
use serde_json::{json, Value};

const MAX_ITEMS: usize = 24;
const MAX_SOURCE_REFS: usize = 8;
const MAX_WAKE_CONDITIONS: usize = 6;
const MAX_WAKE_MINUTES: u32 = 10_080;

pub(crate) fn is_ledger_tool(canonical: &str) -> bool {
    matches!(canonical, "research.recordEvidence" | "research.recordDecision")
}

pub(crate) fn authorize(
    canonical: &str,
    is_main: bool,
    in_run: bool,
    strategy_session_kind: &str,
) -> Result<(), String> {
    if !is_ledger_tool(canonical) {
        return Err(format!("未知的证据账本工具：{canonical}"));
    }
    if !is_main {
        return Err(format!("{canonical} 仅允许主 Agent 调用"));
    }
    if in_run {
        return Err(format!("{canonical} 仅用于交互式 AI 研究，后台 / 复盘 Run 一律拒绝"));
    }
    if strategy_session_kind != "trading-research" {
        return Err(format!("{canonical} 仅用于 AI 研究会话"));
    }
    Ok(())
}

pub(crate) fn execute(
    canonical: &str,
    input: Value,
    session_id: &str,
    now_ms: i64,
) -> Result<Value, String> {
    match canonical {
        "research.recordEvidence" => record_evidence(input, session_id, now_ms),
        "research.recordDecision" => record_decision(input, session_id, now_ms),
        other => Err(format!("未知的证据账本工具：{other}")),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EvidenceInput {
    inst_id: Option<String>,
    items: Vec<EvidenceItemInput>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EvidenceItemInput {
    id: String,
    claim: String,
    stance: String,
    weight: f64,
    source_refs: Vec<String>,
    revision_note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DecisionInput {
    inst_id: Option<String>,
    outcome: String,
    reason: String,
    wake_conditions: Option<Vec<WakeConditionInput>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WakeConditionInput {
    kind: String,
    price: Option<f64>,
    after_minutes: Option<u32>,
    note: Option<String>,
}

fn bounded_text(value: &str, field: &str, max_chars: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field} 不能为空"));
    }
    if trimmed.chars().count() > max_chars {
        return Err(format!("{field} 超过 {max_chars} 字符"));
    }
    Ok(trimmed.to_string())
}

fn optional_text(value: Option<String>, field: &str, max_chars: usize) -> Result<Option<String>, String> {
    match value.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(text) => bounded_text(text, field, max_chars).map(Some),
    }
}

fn record_evidence(input: Value, session_id: &str, now_ms: i64) -> Result<Value, String> {
    let request: EvidenceInput =
        serde_json::from_value(input).map_err(|err| format!("research.recordEvidence 参数无效：{err}"))?;
    if request.items.is_empty() || request.items.len() > MAX_ITEMS {
        return Err(format!("items 数量必须在 1–{MAX_ITEMS} 之间"));
    }
    let mut items = Vec::with_capacity(request.items.len());
    for (index, item) in request.items.into_iter().enumerate() {
        let label = format!("items[{index}]");
        let id = bounded_text(&item.id, &format!("{label}.id"), 64)?;
        let claim = bounded_text(&item.claim, &format!("{label}.claim"), 400)?;
        if !matches!(item.stance.as_str(), "bull" | "bear" | "neutral" | "constraint") {
            return Err(format!("{label}.stance 必须是 bull / bear / neutral / constraint"));
        }
        if !item.weight.is_finite() || !(0.0..=3.0).contains(&item.weight) {
            return Err(format!("{label}.weight 必须在 0–3 之间"));
        }
        if item.source_refs.is_empty() || item.source_refs.len() > MAX_SOURCE_REFS {
            return Err(format!("{label}.sourceRefs 数量必须在 1–{MAX_SOURCE_REFS} 之间"));
        }
        let mut source_refs = Vec::with_capacity(item.source_refs.len());
        for source in &item.source_refs {
            let reference = bounded_text(source, &format!("{label}.sourceRefs"), 32)?;
            if !source_refs.contains(&reference) {
                source_refs.push(reference);
            }
        }
        items.push(json!({
            "id": id,
            "claim": claim,
            "stance": item.stance,
            "weight": (item.weight * 100.0).round() / 100.0,
            "sourceRefs": source_refs,
            "revisionNote": optional_text(item.revision_note, &format!("{label}.revisionNote"), 200)?,
        }));
    }
    Ok(json!({
        "ledgerId": format!("ledger-{session_id}-{now_ms}"),
        "sessionId": session_id,
        "instId": optional_text(request.inst_id, "instId", 64)?,
        "items": items,
        "recordedAt": now_ms,
        "displayOnly": true
    }))
}

fn record_decision(input: Value, session_id: &str, now_ms: i64) -> Result<Value, String> {
    let request: DecisionInput =
        serde_json::from_value(input).map_err(|err| format!("research.recordDecision 参数无效：{err}"))?;
    if !matches!(request.outcome.as_str(), "long" | "short" | "abstain" | "hold") {
        return Err("outcome 必须是 long / short / abstain / hold".to_string());
    }
    let reason = bounded_text(&request.reason, "reason", 600)?;
    let conditions = request.wake_conditions.unwrap_or_default();
    if conditions.len() > MAX_WAKE_CONDITIONS {
        return Err(format!("wakeConditions 最多 {MAX_WAKE_CONDITIONS} 条"));
    }
    let mut wake_conditions = Vec::with_capacity(conditions.len());
    for (index, condition) in conditions.into_iter().enumerate() {
        let label = format!("wakeConditions[{index}]");
        let note = optional_text(condition.note, &format!("{label}.note"), 200)?;
        match condition.kind.as_str() {
            "price_above" | "price_below" => {
                let price = condition
                    .price
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .ok_or_else(|| format!("{label}.price 必须是正数"))?;
                wake_conditions.push(json!({ "kind": condition.kind, "price": price, "note": note }));
            }
            "time" => {
                let minutes = condition
                    .after_minutes
                    .filter(|value| (1..=MAX_WAKE_MINUTES).contains(value))
                    .ok_or_else(|| format!("{label}.afterMinutes 必须在 1–{MAX_WAKE_MINUTES} 之间"))?;
                wake_conditions.push(json!({
                    "kind": "time",
                    "afterMinutes": minutes,
                    "dueAt": now_ms + i64::from(minutes) * 60_000,
                    "note": note
                }));
            }
            _ => return Err(format!("{label}.kind 必须是 price_above / price_below / time")),
        }
    }
    Ok(json!({
        "decisionId": format!("decision-{session_id}-{now_ms}"),
        "sessionId": session_id,
        "instId": optional_text(request.inst_id, "instId", 64)?,
        "outcome": request.outcome,
        "reason": reason,
        "wakeConditions": wake_conditions,
        "recordedAt": now_ms,
        "displayOnly": true
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_limits_to_main_interactive_research() {
        assert!(authorize("research.recordEvidence", true, false, "trading-research").is_ok());
        assert!(authorize("research.recordDecision", false, false, "trading-research").is_err());
        assert!(authorize("research.recordEvidence", true, true, "trading-research").is_err());
        assert!(authorize("research.recordEvidence", true, false, "editor").is_err());
        assert!(authorize("research.recordEvidence", true, false, "none").is_err());
        assert!(authorize("research.somethingElse", true, false, "trading-research").is_err());
    }

    #[test]
    fn evidence_is_normalized_and_echoed() {
        let result = execute(
            "research.recordEvidence",
            json!({
                "instId": " BTC-USDT-SWAP ",
                "items": [{
                    "id": "b1",
                    "claim": " 4H 仍处下降通道 ",
                    "stance": "bear",
                    "weight": 2.456,
                    "sourceRefs": ["E1", "E1", "E3"]
                }]
            }),
            "s1",
            1_000,
        )
        .expect("valid ledger");
        assert_eq!(result["instId"], "BTC-USDT-SWAP");
        assert_eq!(result["items"][0]["claim"], "4H 仍处下降通道");
        assert_eq!(result["items"][0]["weight"], 2.46);
        assert_eq!(result["items"][0]["sourceRefs"], json!(["E1", "E3"]));
        assert_eq!(result["displayOnly"], true);
    }

    #[test]
    fn evidence_rejects_bad_input() {
        let base = |item: Value| json!({ "items": [item] });
        let valid = json!({ "id": "a", "claim": "c", "stance": "bull", "weight": 1, "sourceRefs": ["E1"] });
        assert!(record_evidence(base(valid.clone()), "s", 0).is_ok());
        let mut bad_stance = valid.clone();
        bad_stance["stance"] = json!("maybe");
        assert!(record_evidence(base(bad_stance), "s", 0).is_err());
        let mut bad_weight = valid.clone();
        bad_weight["weight"] = json!(3.5);
        assert!(record_evidence(base(bad_weight), "s", 0).is_err());
        let mut no_refs = valid.clone();
        no_refs["sourceRefs"] = json!([]);
        assert!(record_evidence(base(no_refs), "s", 0).is_err());
        let mut unknown = valid.clone();
        unknown["extra"] = json!(true);
        assert!(record_evidence(base(unknown), "s", 0).is_err());
        assert!(record_evidence(json!({ "items": [] }), "s", 0).is_err());
    }

    #[test]
    fn decision_validates_wake_conditions() {
        let result = record_decision(
            json!({
                "outcome": "abstain",
                "reason": "证据冲突",
                "wakeConditions": [
                    { "kind": "price_below", "price": 63800 },
                    { "kind": "time", "afterMinutes": 240, "note": "定时复查" }
                ]
            }),
            "s1",
            60_000,
        )
        .expect("valid decision");
        assert_eq!(result["wakeConditions"][1]["dueAt"], 60_000 + 240 * 60_000);
        assert!(record_decision(json!({ "outcome": "buy", "reason": "x" }), "s", 0).is_err());
        assert!(record_decision(
            json!({ "outcome": "long", "reason": "x", "wakeConditions": [{ "kind": "price_above" }] }),
            "s",
            0
        )
        .is_err());
        assert!(record_decision(
            json!({ "outcome": "long", "reason": "x", "wakeConditions": [{ "kind": "time", "afterMinutes": 0 }] }),
            "s",
            0
        )
        .is_err());
    }
}

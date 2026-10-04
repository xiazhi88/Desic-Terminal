// Profile 配置页「按当前账户换算」的计算口径（src/lib/riskPreview.ts）。
import { computeRiskPreview, floorToLot } from "../src/lib/riskPreview.ts";

const failures = [];
const near = (label, actual, expected, eps = 1e-6) => {
  if (actual === null || Math.abs(actual - expected) > eps) failures.push(`${label}: ${actual} != ${expected}`);
};
const equal = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
};

const btc = (atr1h) => ({ instId: "BTC-USDT-SWAP", last: 85_000, ctVal: 0.01, ctValCcy: "BTC", minSz: 0.01, lotSz: 0.01, atr1h });
const facts = (equity, available, symbols, todayRealizedPnl = 0) => ({
  accountId: "acc", accountError: null, equityUsdt: equity, availableUsdt: available, snapshotAgeSeconds: 2, todayRealizedPnl, assumedTakerFeePct: 0.05, symbols
});
const inputs = { riskPerTradePct: 5, dailyLossLimitPct: 10, maxSingleTradeMarginPct: 30, targetLeverage: 20 };

// 100 U、20 倍、单笔 5%、保证金上限 30%：
{
  const preview = computeRiskPreview(facts(100, 100, [btc(200), btc(1000)], -3), inputs);
  near("risk budget", preview.riskBudget, 5);
  near("daily limit", preview.dailyLimit, 10);
  near("daily remaining after -3", preview.dailyRemaining, 7);
  near("margin cap", preview.marginCap, 30);
  const [tight, wide] = preview.rows;
  // 止损 200：每张 2 + 0.85 手续费 = 2.85 U；风险允许 1.75 张，保证金上限只允许 0.70 张 → 0.70 张（保证金先卡住）。
  near("tight risk per contract", tight.riskPerContract, 2.85);
  equal("tight max by risk", tight.maxByRisk, 1.75);
  equal("tight max by margin", tight.maxByMargin, 0.7);
  equal("tight max", tight.maxContracts, 0.7);
  equal("tight binding", tight.binding, "margin");
  near("tight risk at max", tight.riskAtMax, 1.995);
  equal("tight status", tight.status, "ok");
  // 止损 1000：每张 10.85 U；风险只允许 0.46 张 → 0.46 张（风险预算先卡住），约亏 5 U。
  equal("wide max", wide.maxContracts, 0.46);
  equal("wide binding", wide.binding, "risk");
  near("wide risk at max", wide.riskAtMax, 4.991);
}

// 实盘 9.31 U、可用 0.15 U：最小 0.01 张要 0.425 U 保证金 → 可用余额不足。
{
  const preview = computeRiskPreview(facts(9.31, 0.15, [btc(200)]), inputs);
  near("min margin", preview.rows[0].minMargin, 0.425);
  equal("available too low", preview.rows[0].status, "available_too_low");
  equal("no max when cannot open", preview.rows[0].maxContracts, null);
}

// 单笔 1%（0.0931 U）、止损 1000：最小仓位就要亏 0.1085 U → 风险预算太小。
{
  const preview = computeRiskPreview(facts(9.31, 9.31, [btc(1000)]), { ...inputs, riskPerTradePct: 1 });
  equal("risk budget too small", preview.rows[0].status, "risk_budget_too_small");
}

// 保证金上限 1%（0.1 U）低于最小仓位所需 0.425 U。
{
  const preview = computeRiskPreview(facts(10, 10, [btc(200)]), { ...inputs, maxSingleTradeMarginPct: 1 });
  equal("margin cap too low", preview.rows[0].status, "margin_cap_too_low");
}

// 没有账户 / 缺数据：不给数字，标 no_data。
{
  const preview = computeRiskPreview(facts(null, null, [btc(200)]), inputs);
  equal("no account", preview.rows[0].status, "no_data");
  equal("no budget", preview.riskBudget, null);
}

equal("floor to lot", floorToLot(0.70588, 0.01), 0.7);
equal("floor to lot exact", floorToLot(1.75, 0.01), 1.75);

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log("[risk-preview] ok");

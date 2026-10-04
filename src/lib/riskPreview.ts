/**
 * Profile 配置页「按当前账户换算」：把硬风控的百分比换成具体金额与张数，并提前看出能不能开最小仓位。
 *
 * 口径与下单链路的风控一致：
 * - 单笔风险 = 止损亏损 + 来回两次手续费，按账户权益的百分比封顶；与杠杆无关。
 * - 单笔保证金 ≤ 权益 ×「最大单笔开仓占比」，且不超过可用 USDT；保证金 = 名义价值 ÷ 杠杆。
 * - 日亏线按当天（北京时间）已平仓的已实现盈亏计算，账户级。
 * 止损距离按 1×ATR(1h) 估算（交易手册要求至少这么远）；手续费按吃单费率估算。只用于展示，不参与风控判定。
 */

export type RiskFactsSymbol = {
  instId: string;
  last: number | null;
  ctVal: number | null;
  ctValCcy: string | null;
  minSz: number | null;
  lotSz: number | null;
  atr1h: number | null;
};

export type RiskFacts = {
  accountId: string | null;
  accountError: string | null;
  equityUsdt: number | null;
  availableUsdt: number | null;
  snapshotAgeSeconds: number | null;
  todayRealizedPnl: number | null;
  assumedTakerFeePct: number;
  symbols: RiskFactsSymbol[];
};

export type RiskPreviewInputs = {
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  maxSingleTradeMarginPct: number;
  targetLeverage: number;
};

export type RiskPreviewStatus = "ok" | "available_too_low" | "margin_cap_too_low" | "risk_budget_too_small" | "no_data";

export type RiskPreviewRow = {
  instId: string;
  last: number | null;
  minSize: number | null;
  minNotional: number | null;
  minMargin: number | null;
  stopDistance: number | null;
  riskPerContract: number | null;
  maxByRisk: number | null;
  maxByMargin: number | null;
  maxContracts: number | null;
  riskAtMax: number | null;
  riskPctAtMax: number | null;
  /// 最小仓位按 1×ATR 止损的风险（含费）。
  minRisk: number | null;
  binding: "risk" | "margin" | null;
  status: RiskPreviewStatus;
};

export type RiskPreview = {
  equity: number | null;
  available: number | null;
  riskBudget: number | null;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  marginCap: number | null;
  marginCapByEquity: number | null;
  rows: RiskPreviewRow[];
};

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 按张数步长向下取整（避免 0.7000000001 这类浮点误差）。 */
export function floorToLot(value: number, lot: number): number {
  if (!(lot > 0) || !Number.isFinite(value)) return 0;
  const steps = Math.floor(value / lot + 1e-9);
  const decimals = Math.max(0, Math.min(8, Math.ceil(-Math.log10(lot))));
  return Number((steps * lot).toFixed(decimals));
}

export function computeRiskPreview(facts: RiskFacts, inputs: RiskPreviewInputs): RiskPreview {
  const equity = finite(facts.equityUsdt) ? facts.equityUsdt : null;
  const available = finite(facts.availableUsdt) ? facts.availableUsdt : null;
  const riskBudget = equity === null ? null : (equity * inputs.riskPerTradePct) / 100;
  const dailyLimit = equity === null ? null : (equity * inputs.dailyLossLimitPct) / 100;
  // 熔断条件是「今日已实现 ≤ −权益×日亏线」，所以还能亏 = 权益×日亏线 + 今日已实现（亏损为负）。
  const dailyRemaining = dailyLimit === null ? null : Math.max(0, dailyLimit + (finite(facts.todayRealizedPnl) ? facts.todayRealizedPnl : 0));
  const marginCapByEquity = equity === null ? null : (equity * inputs.maxSingleTradeMarginPct) / 100;
  const marginCap = marginCapByEquity === null ? null : available === null ? marginCapByEquity : Math.min(marginCapByEquity, available);
  const leverage = Math.max(1, inputs.targetLeverage);
  const feeRate = Math.max(0, facts.assumedTakerFeePct) / 100;

  const rows = facts.symbols.map((symbol): RiskPreviewRow => {
    const empty: RiskPreviewRow = {
      instId: symbol.instId,
      last: symbol.last,
      minSize: symbol.minSz,
      minNotional: null,
      minMargin: null,
      stopDistance: symbol.atr1h,
      riskPerContract: null,
      maxByRisk: null,
      maxByMargin: null,
      maxContracts: null,
      riskAtMax: null,
      riskPctAtMax: null,
      minRisk: null,
      binding: null,
      status: "no_data"
    };
    if (!finite(symbol.last) || !finite(symbol.ctVal) || !finite(symbol.minSz) || equity === null || riskBudget === null || marginCap === null || marginCapByEquity === null) {
      return empty;
    }
    const lot = finite(symbol.lotSz) && symbol.lotSz > 0 ? symbol.lotSz : symbol.minSz;
    const contractNotional = symbol.last * symbol.ctVal;
    const minNotional = symbol.minSz * contractNotional;
    const minMargin = minNotional / leverage;
    const row: RiskPreviewRow = { ...empty, minNotional, minMargin };
    const maxByMargin = floorToLot((marginCap * leverage) / contractNotional, lot);
    row.maxByMargin = maxByMargin;
    if (finite(symbol.atr1h) && symbol.atr1h > 0) {
      const riskPerContract = symbol.atr1h * symbol.ctVal + 2 * feeRate * contractNotional;
      const maxByRisk = floorToLot(riskBudget / riskPerContract, lot);
      const maxContracts = Math.min(maxByRisk, maxByMargin);
      row.riskPerContract = riskPerContract;
      row.maxByRisk = maxByRisk;
      row.minRisk = symbol.minSz * riskPerContract;
      row.binding = maxByRisk <= maxByMargin ? "risk" : "margin";
      if (maxContracts >= symbol.minSz - 1e-12) {
        row.maxContracts = maxContracts;
        row.riskAtMax = maxContracts * riskPerContract;
        row.riskPctAtMax = (row.riskAtMax / equity) * 100;
      }
    }
    // 开不了最小仓位时，按最先卡住的那一条说明原因。
    if (available !== null && minMargin > available) row.status = "available_too_low";
    else if (minMargin > marginCapByEquity) row.status = "margin_cap_too_low";
    else if (row.minRisk !== null && row.minRisk > riskBudget) row.status = "risk_budget_too_small";
    else row.status = row.riskPerContract === null ? "no_data" : "ok";
    return row;
  });

  return { equity, available, riskBudget, dailyLimit, dailyRemaining, marginCap, marginCapByEquity, rows };
}

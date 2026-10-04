import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { BookOpen, Crosshair, Loader2, PauseCircle, PlayCircle } from "lucide-react";
import { loadTraderRunDecisions, loadTraderScorecard, setTraderSetupPause, type TraderDecisionRow, type TraderHandbook, type TraderScorecardData } from "../../lib/ai";
import "./trader-scorecard.css";

const DAY_MS = 86_400_000;
const RANGES = [30, 90] as const;

type ProfileOption = { id: string; name: string };

function formatR(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}R`;
}

function formatPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return value >= 1000 ? value.toFixed(1) : value >= 1 ? value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : value.toPrecision(4);
}

function formatTime(ms: number) {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 交易员 Profile 的成绩单：决策日志（含没执行的候选）按之后的 K 线自动结算后，按「形态 × 日线阶段 × 方向」汇总。
 * 「建议暂停」只是提醒；暂停 / 恢复由用户在这里手动操作，会生成新的手册版本。
 * `previewData` 只给预览页用（浏览器里没有桌面命令）。
 */
export function TraderScorecard({ profiles, previewData }: { profiles: ProfileOption[]; previewData?: TraderScorecardData }) {
  const { i18n } = useTranslation();
  const chinese = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase().startsWith("zh");
  const tx = useCallback((zh: string, en: string) => (chinese ? zh : en), [chinese]);
  const [profileId, setProfileId] = useState<string>("");
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<TraderScorecardData | null>(previewData ?? null);
  const [loading, setLoading] = useState(!previewData);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [handbookOpen, setHandbookOpen] = useState(false);

  const reload = useCallback(async () => {
    if (previewData) return;
    setLoading(true);
    const result = await loadTraderScorecard(profileId || null, Date.now() - days * DAY_MS).catch(() => null);
    setData(result);
    setLoading(false);
  }, [days, previewData, profileId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const regimeLabel = (value: string | null | undefined) =>
    value === "up" ? tx("日线上升", "Daily up") : value === "down" ? tx("日线下降", "Daily down") : value === "mixed" ? tx("日线不明", "Daily mixed") : tx("阶段不明", "Regime n/a");
  const sideLabel = (value: string | null | undefined) => (value === "long" ? tx("做多", "Long") : value === "short" ? tx("做空", "Short") : "--");
  const actionLabel = (value: string) =>
    ({
      enter_now: tx("现在做", "Enter now"),
      limit_order: tx("挂限价", "Limit order"),
      wait_condition: tx("等条件", "Wait"),
      no_trade: tx("不做", "No trade"),
      manage_position: tx("管理持仓", "Manage")
    })[value] ?? value;
  const shadowLabel = (row: TraderDecisionRow) =>
    row.shadowStatus === "resolved"
      ? `${formatR(row.shadowR, 1)}${row.exitKind ? ` · ${row.exitKind === "target" ? tx("到目标", "target") : row.exitKind === "stop" ? tx("止损", "stop") : tx("超时", "timeout")}` : ""}`
      : row.shadowStatus === "pending"
        ? tx("待结算", "Pending")
        : row.shadowStatus === "unfilled"
          ? tx("未成交", "Unfilled")
          : row.shadowStatus === "skipped"
            ? tx("不结算", "Not settled")
            : tx("无效", "Invalid");

  const handbook: TraderHandbook | null = data?.handbook.content ?? null;
  const pausedFor = useCallback(
    (setupId: string, regime: string, side: string) =>
      handbook?.paused.find((entry) => entry.setupId === setupId && (entry.regime ?? null) === regime && (entry.side ?? null) === side) ?? null,
    [handbook]
  );
  const togglePause = useCallback(async (setupId: string, regime: string, side: string, paused: boolean) => {
    if (previewData) return;
    const key = `${setupId}|${regime}|${side}`;
    setBusyKey(key);
    await setTraderSetupPause({
      setupId,
      regime,
      side,
      paused,
      reason: paused ? tx("在成绩单页手动暂停", "Paused from the scorecard") : null
    }).catch(() => null);
    setBusyKey(null);
    void reload();
  }, [previewData, reload, tx]);

  const card = data?.scorecard;
  const calibration = useMemo(() => (card?.calibration ?? []).filter((bucket) => bucket.n > 0), [card]);

  return (
    <section className="trader-scorecard" data-trader-scorecard>
      <header className="trader-scorecard__head">
        <div className="trader-scorecard__title">
          <Crosshair size={15} />
          <strong>{tx("交易员成绩单", "Trader scorecard")}</strong>
          <span>{tx("每条决策（包括没执行的候选）都按之后的 1 分钟 K 线自动结算；平均 R 已向 0 收缩（×n/(n+10)），样本少时别当真。", "Every decision, including untaken candidates, is settled against later 1-minute candles; average R is shrunk toward 0 (×n/(n+10)), so small samples mean little.")}</span>
        </div>
        <div className="trader-scorecard__controls">
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)} aria-label={tx("交易员 Profile", "Trader Profile")}>
            <option value="">{tx("全部交易员 Profile", "All trader Profiles")}</option>
            {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          <div className="automation-segmented compact" role="tablist">
            {RANGES.map((value) => (
              <button type="button" role="tab" key={value} aria-selected={days === value} className={days === value ? "active" : ""} onClick={() => setDays(value)}>
                {tx(`${value} 天`, `${value} days`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {loading && !data ? (
        <div className="trader-scorecard__empty"><Loader2 className="spin" size={16} />{tx("正在读取成绩单…", "Loading scorecard…")}</div>
      ) : !card ? (
        <div className="trader-scorecard__empty">{tx("成绩单暂不可用。", "Scorecard unavailable.")}</div>
      ) : (
        <>
          <div className="trader-scorecard__stats">
            <div><span>{tx("决策", "Decisions")}</span><strong>{card.decisions}</strong></div>
            <div><span>{tx("已结算", "Settled")}</span><strong>{card.resolved}</strong></div>
            <div><span>{tx("真实成交", "Real fills")}</span><strong>{card.executed}</strong></div>
            <div><span>{tx("待结算", "Pending")}</span><strong>{data?.pending ?? 0}</strong></div>
            <div><span>{tx("交易手册", "Handbook")}</span><strong>v{data?.handbook.version ?? 1}</strong></div>
          </div>

          <div className="trader-scorecard__block">
            <h4>{tx("按形态 × 日线阶段 × 方向", "By setup × daily regime × side")}</h4>
            {card.groups.length === 0 ? (
              <p className="trader-scorecard__note">{tx("还没有已结算的形态决策。", "No settled setup decisions yet.")}</p>
            ) : (
              <table data-scorecard-groups>
                <thead>
                  <tr>
                    <th>{tx("形态", "Setup")}</th>
                    <th>{tx("阶段", "Regime")}</th>
                    <th>{tx("方向", "Side")}</th>
                    <th>n</th>
                    <th>{tx("胜率", "Win rate")}</th>
                    <th>{tx("平均", "Avg")}</th>
                    <th>{tx("收缩后", "Shrunk")}</th>
                    <th>{tx("真实成交", "Real")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {card.groups.map((group) => {
                    const paused = pausedFor(group.setupId, group.regime, group.side);
                    const key = `${group.setupId}|${group.regime}|${group.side}`;
                    return (
                      <tr key={key} className={clsx(group.flagged && "is-flagged", paused && "is-paused")} data-scorecard-group={key}>
                        <th scope="row">{group.setupId}{group.flagged ? <em>{tx("建议暂停", "Suggest pause")}</em> : null}</th>
                        <td>{regimeLabel(group.regime)}</td>
                        <td>{sideLabel(group.side)}</td>
                        <td>{group.n}</td>
                        <td>{group.n ? `${Math.round((group.wins / group.n) * 100)}%` : "--"}</td>
                        <td className={group.avgR >= 0 ? "is-up" : "is-down"}>{formatR(group.avgR)}</td>
                        <td className={group.shrunkAvgR >= 0 ? "is-up" : "is-down"}>{formatR(group.shrunkAvgR)}</td>
                        <td>{group.realN ? `${group.realN} · ${formatR(group.realAvgR)}` : "--"}</td>
                        <td>
                          <button
                            type="button"
                            className="trader-scorecard__pause"
                            disabled={busyKey === key}
                            onClick={() => void togglePause(group.setupId, group.regime, group.side, !paused)}
                            title={paused ? tx("恢复：重新允许这个范围开仓", "Resume opening in this scope") : tx("暂停：这个范围的开仓会被拒绝，影子记账照常", "Pause: opens in this scope are rejected; shadow scoring continues")}
                          >
                            {paused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
                            {paused ? tx("恢复", "Resume") : tx("暂停", "Pause")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="trader-scorecard__grid">
            <div className="trader-scorecard__block">
              <h4>{tx("信心校准", "Confidence calibration")}</h4>
              {calibration.length === 0 ? (
                <p className="trader-scorecard__note">{tx("样本不足。", "Not enough samples.")}</p>
              ) : (
                <table>
                  <thead><tr><th>{tx("预估把握", "Stated")}</th><th>{tx("实际兑现", "Realized")}</th><th>n</th></tr></thead>
                  <tbody>
                    {calibration.map((bucket) => (
                      <tr key={bucket.lo}>
                        <td>{Math.round(bucket.predicted * 100)}%</td>
                        <td className={bucket.realized + 0.1 < bucket.predicted ? "is-down" : undefined}>{Math.round(bucket.realized * 100)}%</td>
                        <td>{bucket.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="trader-scorecard__block">
              <h4>{tx("「不做」的打分", "Untaken candidates")}</h4>
              <dl>
                <div><dt>{tx("候选数", "Candidates")}</dt><dd>{card.waits.n}</dd></div>
                <div><dt>{tx("错过的盈利", "Missed")}</dt><dd className="is-up">{formatR(card.waits.missedR, 1)}</dd></div>
                <div><dt>{tx("躲过的亏损", "Avoided")}</dt><dd>{card.waits.avoidedR.toFixed(1)}R</dd></div>
              </dl>
            </div>
            <div className="trader-scorecard__block">
              <h4>{tx("方向纪律（软规则）", "Direction policy (soft)")}</h4>
              <dl>
                <div><dt>{tx("违反纪律", "Against")}</dt><dd>{card.compliance.againstN} · {formatR(card.compliance.againstAvgR)}</dd></div>
                <div><dt>{tx("顺纪律", "Aligned")}</dt><dd>{card.compliance.alignedN} · {formatR(card.compliance.alignedAvgR)}</dd></div>
                <div><dt>{tx("形态不适用当前阶段", "Setup off-regime")}</dt><dd>{card.compliance.regimeMismatchN}</dd></div>
              </dl>
            </div>
          </div>

          <div className="trader-scorecard__block">
            <h4>{tx("最近的决策", "Recent decisions")}</h4>
            {data && data.recent.length > 0 ? (
              <table className="trader-scorecard__recent" data-scorecard-recent>
                <thead>
                  <tr>
                    <th>{tx("时间", "Time")}</th>
                    <th>{tx("品种", "Instrument")}</th>
                    <th>{tx("形态", "Setup")}</th>
                    <th>{tx("决定", "Decision")}</th>
                    <th>{tx("入场 / 止损 / 目标", "Entry / stop / target")}</th>
                    <th>{tx("把握", "Prob.")}</th>
                    <th>{tx("影子结果", "Shadow")}</th>
                    <th>{tx("真实", "Real")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((row) => (
                    <tr key={row.id} className={clsx(row.againstDirection && "is-against")} title={row.reason ?? undefined}>
                      <td>{formatTime(row.createdAt)}</td>
                      <td>{row.instId.replace("-USDT-SWAP", "")}</td>
                      <td>{row.setupId ?? "--"}{row.againstDirection ? <em>{tx("逆势", "against")}</em> : null}</td>
                      <td>{sideLabel(row.side)} · {actionLabel(row.action)}</td>
                      <td>{formatPrice(row.entry)} / {formatPrice(row.stop)} / {formatPrice(row.target)}</td>
                      <td>{row.probability === null ? "--" : `${Math.round(row.probability * 100)}%`}</td>
                      <td className={(row.shadowR ?? 0) >= 0 ? undefined : "is-down"}>{shadowLabel(row)}</td>
                      <td className={(row.realR ?? 0) >= 0 ? undefined : "is-down"}>{formatR(row.realR, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="trader-scorecard__note">{tx("还没有决策日志。交易员 Profile 每轮收尾都会记下评估过的品种。", "No decision logs yet. Trader Profiles record every evaluated instrument when a run finishes.")}</p>
            )}
          </div>

          {handbook ? (
            <details className="trader-scorecard__handbook" open={handbookOpen} onToggle={(event) => setHandbookOpen((event.currentTarget as HTMLDetailsElement).open)} data-scorecard-handbook>
              <summary><BookOpen size={13} />{tx(`交易手册 v${data?.handbook.version ?? 1}`, `Trader handbook v${data?.handbook.version ?? 1}`)}</summary>
              <p><strong>{tx("方向纪律：", "Direction policy: ")}</strong>{handbook.directionPolicy}</p>
              {handbook.setups.map((setup) => (
                <div key={setup.id} className="trader-scorecard__setup">
                  <strong>{setup.id} · {setup.name}</strong>
                  <span>{tx("入场：", "Entry: ")}{setup.entry}</span>
                  <span>{tx("止损：", "Stop: ")}{setup.stop}</span>
                  <span>{tx("目标：", "Target: ")}{setup.target}</span>
                  <span>{tx("失效：", "Invalidation: ")}{setup.invalidation}</span>
                </div>
              ))}
              <p><strong>{tx("不做清单：", "No-trade list: ")}</strong>{handbook.noTradeRules.map((item) => item.text).join(" ")}</p>
              <p><strong>{tx("持仓管理：", "Management: ")}</strong>{handbook.managementRules.map((item) => item.text).join(" ")}</p>
              {handbook.paused.length > 0 ? (
                <p><strong>{tx("已暂停：", "Paused: ")}</strong>{handbook.paused.map((entry) => `${entry.setupId}（${[entry.regime ? regimeLabel(entry.regime) : null, entry.side ? sideLabel(entry.side) : null].filter(Boolean).join(" · ") || tx("全部", "all")}）`).join("，")}</p>
              ) : null}
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

/** 运行详情里的决策日志（只有交易员运行才有）。 */
export function TraderRunDecisionLog({ rows }: { rows: TraderDecisionRow[] }) {
  const { i18n } = useTranslation();
  const chinese = (i18n.resolvedLanguage ?? i18n.language ?? "").toLowerCase().startsWith("zh");
  const tx = (zh: string, en: string) => (chinese ? zh : en);
  if (rows.length === 0) return null;
  return (
    <div className="trader-run-decisions" data-run-decision-log>
      <strong>{tx("决策日志", "Decision log")}</strong>
      {rows.map((row) => (
        <div key={row.id} className={clsx("trader-run-decisions__row", row.againstDirection && "is-against")}>
          <span>{row.instId}</span>
          <span>{row.setupId ?? "--"}</span>
          <span>{row.side === "long" ? tx("做多", "long") : row.side === "short" ? tx("做空", "short") : "--"} · {row.action}</span>
          <span>{formatPrice(row.entry)} / {formatPrice(row.stop)} / {formatPrice(row.target)}</span>
          <span>{row.probability === null ? "--" : `${Math.round(row.probability * 100)}%`}</span>
          <span>{row.shadowStatus === "resolved" ? formatR(row.shadowR, 1) : row.shadowStatus}</span>
          {row.reason ? <small>{row.reason}</small> : null}
        </div>
      ))}
    </div>
  );
}

/** 按运行 id 读取决策日志并展示；读不到（预览页、经典运行）时不显示。 */
export function TraderRunDecisionLoader({ runId }: { runId: string }) {
  const [rows, setRows] = useState<TraderDecisionRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadTraderRunDecisions(runId)
      .then((result) => {
        if (!cancelled) setRows(result ?? []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);
  return <TraderRunDecisionLog rows={rows} />;
}

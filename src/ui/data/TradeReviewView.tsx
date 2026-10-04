import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { fetchAiAutomationReviewDetail, fetchPositionEpisodes, fetchTradeReviewNotes, fetchTradeReviewProtection, saveTradeReviewNote } from "../../lib/okx";
import { logger } from "../../lib/logger";
import {
  buildHeatmap,
  buildReviewTrades,
  computeExcursion,
  deriveFindings,
  describeTrade,
  leverageBuckets,
  matchesFilter,
  MIN_SAMPLE,
  replayBar,
  sourceLabel,
  stopBuckets,
  sum,
  winRate,
  type Bucket,
  type FindingFilter,
  type ReviewTrade,
  type TradeSource,
  type UiText,
} from "../../lib/tradeReviewModel";
import type { AiAutomationReviewDetail, PositionEpisode, TradeReviewNote, TradeReviewProtection } from "../../types";
import { fmtNumber, fmtPercent, fmtSigned, formatDuration, tone } from "./format";
import { TradeReviewChart } from "./TradeReviewChart";
import "./data-pro.css";
import "./trade-review.css";

type Props = {
  account: { id: string; environment: string } | null;
  startTime: number | null;
  endTime: number | null;
  symbol: string;
  refreshRevision: string;
  /** 从别处（账户绩效）跳来时直接打开这一笔。 */
  focusTradeId?: string | null;
  onOpenAiResearch?: () => void;
};

const PRESET_TAGS = ["突破", "回踩", "追单", "抄底", "消息", "计划内"];
const SOURCE_FILTERS: ("all" | TradeSource)[] = ["all", "manual", "ai", "strategy"];

function useUiText(): UiText {
  const { i18n } = useTranslation();
  const chinese = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith("zh");
  return (zh, en) => (chinese ? zh : en);
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtPrice = (value: number | null) => (value === null ? "--" : value >= 1000 ? value.toFixed(1) : value >= 10 ? value.toFixed(2) : value.toFixed(4));

// ───────────── 习惯统计 ─────────────

function Heatmap({ trades, uiText }: { trades: readonly ReviewTrade[]; uiText: UiText }) {
  const cells = useMemo(() => buildHeatmap(trades), [trades]);
  const max = Math.max(1, ...cells.flat().map((cell) => Math.abs(cell.pnl)));
  const days = [uiText("一", "Mon"), uiText("二", "Tue"), uiText("三", "Wed"), uiText("四", "Thu"), uiText("五", "Fri"), uiText("六", "Sat"), uiText("日", "Sun")];
  return (
    <div className="tr-heat">
      <span />
      {["0–4", "4–8", "8–12", "12–16", "16–20", "20–24"].map((label) => <span key={label} className="tr-heat-h">{label}</span>)}
      {cells.map((row, index) => (
        <div key={index} className="tr-heat-row">
          <span className="tr-heat-h">{days[index]}</span>
          {row.map((cell, column) =>
            cell.n < 2 ? (
              <i key={column} className="is-na" title={uiText(`${cell.n} 笔，样本不足`, `${cell.n} trades, too few`)}>{cell.n ? "·" : ""}</i>
            ) : (
              <i
                key={column}
                className={`is-${tone(cell.pnl)}`}
                style={{ ["--level" as string]: Math.min(1, 0.2 + (Math.abs(cell.pnl) / max) * 0.75) }}
                title={`${cell.n} · ${fmtSigned(cell.pnl, 0)}U`}
              >
                {fmtSigned(cell.pnl, 0)}
              </i>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

function BucketBars({ rows, kind, uiText }: { rows: { label: string; bucket: Bucket }[]; kind: "winrate" | "avg"; uiText: UiText }) {
  const maxAvg = Math.max(1e-9, ...rows.map((row) => Math.abs(row.bucket.avg)));
  return (
    <ul className="tr-bars">
      {rows.map(({ label, bucket }) => (
        <li key={label}>
          <span>{label}</span>
          {!bucket.enough ? (
            <small className="tr-weak">{uiText(`样本不足（${bucket.trades.length} 笔）`, `Too few (${bucket.trades.length})`)}</small>
          ) : kind === "winrate" ? (
            <>
              <div className="tr-track"><i style={{ width: `${bucket.winRate * 100}%` }} /><b /></div>
              <small>{fmtPercent(bucket.winRate * 100, 0)} · {bucket.trades.length}</small>
            </>
          ) : (
            <>
              <div className="tr-track is-diverge"><b /><i className={`is-${tone(bucket.avg)}`} style={{ width: `${(Math.abs(bucket.avg) / maxAvg) * 50}%`, [bucket.avg >= 0 ? "left" : "right"]: "50%" } as React.CSSProperties} /></div>
              <small className={`is-${tone(bucket.avg)}`}>{fmtSigned(bucket.avg, 1)}U/{uiText("笔", "trade")}</small>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

// ───────────── 单笔抽屉 ─────────────

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.floor(element.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function TradeDrawer({ trade, accountId, uiText, onClose, onSaveMeta, onOpenAiResearch }: {
  trade: ReviewTrade;
  accountId: string;
  uiText: UiText;
  onClose: () => void;
  onSaveMeta: (tradeId: string, tags: string[], note: string) => void;
  onOpenAiResearch?: () => void;
}) {
  const [detail, setDetail] = useState<AiAutomationReviewDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [chartRef, chartWidth] = useWidth<HTMLDivElement>();
  const [tags, setTags] = useState(trade.tags);
  const [note, setNote] = useState(trade.note);
  const [newTag, setNewTag] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setTags(trade.tags);
    setNote(trade.note);
    setSaved(false);
  }, [trade.id, trade.tags, trade.note]);

  useEffect(() => {
    let active = true;
    setState("loading");
    setDetail(null);
    void fetchAiAutomationReviewDetail({ accountId, episodeId: trade.id, bar: replayBar(trade.holdMs), candleLimit: 700 })
      .then((result) => {
        if (!active) return;
        setDetail(result);
        setState(result ? "ready" : "failed");
      })
      .catch((error) => {
        logger.warn("trade review detail failed", { error: String(error) });
        if (active) setState("failed");
      });
    return () => {
      active = false;
    };
  }, [accountId, trade.id, trade.holdMs]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const excursion = useMemo(() => (detail ? computeExcursion(trade, detail.candles) : null), [detail, trade]);
  const verdicts = useMemo(() => describeTrade(trade, excursion, uiText), [trade, excursion, uiText]);

  const commit = (nextTags: string[], nextNote: string) => {
    setSaved(false);
    onSaveMeta(trade.id, nextTags, nextNote);
    window.setTimeout(() => setSaved(true), 150);
  };
  const toggleTag = (tag: string) => {
    const next = tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag].slice(0, 8);
    setTags(next);
    commit(next, note);
  };
  const addTag = () => {
    const value = newTag.trim().slice(0, 12);
    if (!value || tags.includes(value)) return;
    const next = [...tags, value].slice(0, 8);
    setTags(next);
    setNewTag("");
    commit(next, note);
  };

  return (
    <>
      <div className="tr-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="tr-drawer" role="dialog" aria-label={uiText("单笔交易复盘", "Trade review")}>
        <header className="tr-drawer-head">
          <div>
            <h3>
              <b>{trade.base}</b>
              <span className={clsx("tr-side", `is-${trade.side}`)}>{trade.side === "long" ? uiText("做多", "Long") : uiText("做空", "Short")}</span>
              <small>{trade.leverage ? `${trade.leverage}x · ` : ""}{sourceLabel(trade.source, uiText)}</small>
            </h3>
            <p>{fmtTime(trade.openTime)} → {fmtTime(trade.closeTime)} · {formatDuration(trade.holdMs, uiText)}</p>
          </div>
          <div className={clsx("tr-drawer-pnl", `is-${tone(trade.netPnl)}`)}>
            {fmtSigned(trade.netPnl)}
            <small>{uiText(`手续费 ${fmtNumber(trade.fees)} · 资金费 ${fmtSigned(trade.fundingFee)}`, `Fees ${fmtNumber(trade.fees)} · Funding ${fmtSigned(trade.fundingFee)}`)}</small>
          </div>
          <button type="button" className="tr-x" onClick={onClose} aria-label={uiText("关闭", "Close")}>×</button>
        </header>

        <div className="tr-drawer-body">
          <div ref={chartRef} className="tr-chart-box">
            {state === "loading" && <div className="tr-chart-empty">{uiText("正在读取这笔交易附近的 K 线…", "Loading candles around this trade…")}</div>}
            {state === "failed" && <div className="tr-chart-empty">{uiText("无法读取 K 线（桌面应用外或本地没有数据）。", "Candles unavailable (outside the desktop app, or no local data).")}</div>}
            {state === "ready" && detail && <TradeReviewChart trade={trade} candles={detail.candles} width={chartWidth} uiText={uiText} />}
          </div>
          {detail?.warnings.length ? <p className="tr-note-warn">{detail.warnings.slice(0, 2).join("；")}</p> : null}

          <div className="tr-kv">
            <div><small>{uiText("开仓均价", "Entry")}</small><b>{fmtPrice(trade.entry)}</b></div>
            <div><small>{uiText("平仓均价", "Exit")}</small><b>{fmtPrice(trade.exit)}</b></div>
            <div><small>{uiText("最多浮亏", "Worst drawdown")}</small><b className="is-neg">{excursion ? `${excursion.maePct.toFixed(2)}%` : "--"}</b></div>
            <div><small>{uiText("最多浮盈", "Best run-up")}</small><b className="is-pos">{excursion ? `+${excursion.mfePct.toFixed(2)}%` : "--"}</b></div>
          </div>

          <ul className="tr-verdicts">
            {verdicts.map((verdict, index) => <li key={index} className={`is-${verdict.tone}`}>{verdict.text}</li>)}
          </ul>

          <h4 className="tr-label">{uiText("标签（会进入习惯统计）", "Tags (feed the habit stats)")}</h4>
          <div className="tr-tagbox">
            {[...new Set([...PRESET_TAGS, ...tags])].map((tag) => (
              <button key={tag} type="button" className={clsx("tr-tag", tags.includes(tag) && "is-on")} onClick={() => toggleTag(tag)}>{tag}</button>
            ))}
            <input value={newTag} maxLength={12} placeholder={uiText("+ 自定义，回车", "+ custom, Enter")} onChange={(event) => setNewTag(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addTag()} />
          </div>

          <h4 className="tr-label">{uiText("笔记", "Note")} {saved && <em>{uiText("已保存", "Saved")}</em>}</h4>
          <textarea
            value={note}
            maxLength={2000}
            placeholder={uiText("当时为什么开这笔？下次想怎么做？（只保存在本机）", "Why did you take it? What would you do differently? (stored locally)")}
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => note !== trade.note && commit(tags, note)}
          />
          {trade.source === "ai" && onOpenAiResearch && (
            <button type="button" className="tr-link" onClick={onOpenAiResearch}>{uiText("这笔由 AI 开仓：在 AI 自动化里查看它的完整复盘 →", "Opened by AI: see its full review in AI Automation →")}</button>
          )}
        </div>
      </aside>
    </>
  );
}

// ───────────── 主视图 ─────────────

export function TradeReviewView({ account, startTime, endTime, symbol, refreshRevision, focusTradeId, onOpenAiResearch }: Props) {
  const uiText = useUiText();
  const [episodes, setEpisodes] = useState<PositionEpisode[] | null>(null);
  const [notes, setNotes] = useState<TradeReviewNote[]>([]);
  const [protections, setProtections] = useState<TradeReviewProtection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [source, setSource] = useState<"all" | TradeSource>("all");
  const [filter, setFilter] = useState<FindingFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusTradeId) setSelectedId(focusTradeId);
  }, [focusTradeId]);
  const accountId = account?.id ?? "";

  useEffect(() => {
    if (!accountId) return;
    let active = true;
    setLoading(true);
    setError("");
    void Promise.all([fetchPositionEpisodes({ accountId, limit: 200 }), fetchTradeReviewNotes(accountId)])
      .then(async ([list, savedNotes]) => {
        if (!active) return;
        setEpisodes(list ?? []);
        setNotes(savedNotes ?? []);
        const closed = (list ?? []).filter((item) => item.status === "closed" && item.closeTime);
        if (closed.length > 0) {
          const found = await fetchTradeReviewProtection({
            accountId,
            episodes: closed.slice(0, 300).map((item) => ({ episodeId: item.id, instId: item.instId, side: item.episodeSide, openTime: item.openTime, closeTime: item.closeTime })),
          }).catch(() => null);
          if (active && found) setProtections(found);
        }
      })
      .catch((reason) => {
        logger.error("load trade review failed", reason);
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [accountId, refreshRevision]);

  const allTrades = useMemo(() => buildReviewTrades(episodes ?? [], notes, protections), [episodes, notes, protections]);
  const scoped = useMemo(
    () =>
      allTrades.filter((trade) => {
        if (startTime !== null && trade.closeTime < startTime) return false;
        if (endTime !== null && trade.closeTime > endTime) return false;
        if (symbol && trade.instId !== symbol) return false;
        return source === "all" || trade.source === source;
      }),
    [allTrades, startTime, endTime, symbol, source],
  );
  const findings = useMemo(() => deriveFindings(scoped, uiText), [scoped, uiText]);
  const stops = useMemo(() => stopBuckets(scoped), [scoped]);
  const levs = useMemo(() => leverageBuckets(scoped), [scoped]);
  const shown = useMemo(() => scoped.filter((trade) => matchesFilter(trade, filter)).sort((a, b) => b.openTime - a.openTime), [scoped, filter]);
  const selected = selectedId ? allTrades.find((trade) => trade.id === selectedId) ?? null : null;

  const saveMeta = useCallback(
    (tradeId: string, tags: string[], note: string) => {
      void saveTradeReviewNote({ accountId, episodeId: tradeId, tags, note })
        .then((saved) => {
          setNotes((current) => {
            const rest = current.filter((item) => item.episodeId !== tradeId);
            return saved ? [...rest, saved] : rest;
          });
        })
        .catch((reason) => logger.error("save trade review note failed", reason));
    },
    [accountId],
  );

  const counts = {
    all: scoped.length,
    win: scoped.filter((trade) => trade.netPnl > 0).length,
    loss: scoped.filter((trade) => trade.netPnl < 0).length,
    revenge: scoped.filter((trade) => trade.revenge).length,
    nostop: scoped.filter((trade) => trade.hadStop === false).length,
  };
  const jump = (next: FindingFilter) => {
    setFilter(next);
    window.setTimeout(() => tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  if (!account) return <div className="dp-empty">{uiText("先配置账户，再来复盘。", "Configure an account first.")}</div>;

  return (
    <div className="tr">
      <div className="tr-summary">
        <div className="tr-source" role="radiogroup" aria-label={uiText("交易来源", "Order source")}>
          {SOURCE_FILTERS.map((item) => (
            <button key={item} type="button" role="radio" aria-checked={source === item} className={clsx(source === item && "is-on")} onClick={() => { setSource(item); setFilter("all"); }}>
              {item === "all" ? uiText("全部来源", "All sources") : sourceLabel(item, uiText)}
            </button>
          ))}
        </div>
        <span className="tr-weak">
          {loading ? uiText("读取中…", "Loading…") : uiText(`${scoped.length} 笔已平仓 · 胜率 ${fmtPercent(winRate(scoped) * 100, 0)} · 合计 ${fmtSigned(sum(scoped), 0)}U`, `${scoped.length} closed · win ${fmtPercent(winRate(scoped) * 100, 0)} · ${fmtSigned(sum(scoped), 0)}U`)}
        </span>
      </div>
      {error && <p className="tr-note-warn">{error}</p>}

      <h3 className="tr-section">{uiText("体检结论", "Review findings")} <small>{uiText("规则生成 · 每条都能点开看到对应交易 · 最多 3 条", "Rule-based · every finding opens its trades · at most 3")}</small></h3>
      <div className="tr-findings">
        {findings.length === 0 && !loading && (
          <div className="tr-finding is-info">
            <div className="tr-ic">·</div>
            <div><h4>{scoped.length < MIN_SAMPLE ? uiText(`这个区间只有 ${scoped.length} 笔，样本不足，暂不下结论`, `Only ${scoped.length} trades here, too few to conclude`) : uiText("没有发现明显的习惯问题", "No obvious habit problems found")}</h4><p>{uiText(`每类情形至少需要 ${MIN_SAMPLE} 笔才会给出结论。`, `Each pattern needs at least ${MIN_SAMPLE} trades before a conclusion is shown.`)}</p></div>
          </div>
        )}
        {findings.map((finding) => (
          <div key={finding.id} className={clsx("tr-finding", `is-${finding.tone}`)}>
            <div className="tr-ic">{finding.tone === "warn" ? "!" : finding.tone === "ok" ? "✓" : "·"}</div>
            <div>
              <h4>{finding.title}</h4>
              {finding.desc && <p>{finding.desc}</p>}
            </div>
            {finding.filter && <button type="button" className="tr-go" onClick={() => jump(finding.filter!)}>{uiText(`看这 ${finding.count} 笔 →`, `See ${finding.count} →`)}</button>}
          </div>
        ))}
      </div>

      <h3 className="tr-section">{uiText("交易习惯", "Habits")}</h3>
      <div className="tr-habits">
        <div className="dp-card">
          <header><strong>{uiText("星期 × 时段盈亏", "Weekday × time-of-day PnL")}</strong><span>{uiText("少于 2 笔的格子不着色", "Cells under 2 trades stay blank")}</span></header>
          <div className="tr-card-body"><Heatmap trades={scoped} uiText={uiText} /></div>
        </div>
        <div className="dp-card">
          <header><strong>{uiText("不同杠杆的胜率", "Win rate by leverage")}</strong><span>{uiText("中线 = 50%", "Midline = 50%")}</span></header>
          <div className="tr-card-body"><BucketBars kind="winrate" rows={levs.map((bucket) => ({ label: bucket.key, bucket }))} uiText={uiText} /></div>
        </div>
        <div className="dp-card">
          <header><strong>{uiText("带止损 vs 没止损", "With vs without a stop")}</strong><span>{uiText("每笔平均盈亏", "Average PnL per trade")}</span></header>
          <div className="tr-card-body">
            <BucketBars kind="avg" rows={[{ label: uiText("带止损", "Stop"), bucket: stops.withStop }, { label: uiText("没止损", "No stop"), bucket: stops.withoutStop }]} uiText={uiText} />
            <p className="tr-weak tr-foot">{stops.coverage < 0.5 ? uiText("止损信息只匹配到一部分交易（条件单历史没同步全），暂不下结论。", "Stop info is matched for only part of the trades, so no conclusion.") : uiText("止损信息由条件单历史匹配得出，属于估计。", "Stop info is matched from algo-order history and is an estimate.")}</p>
          </div>
        </div>
      </div>

      <h3 className="tr-section" ref={undefined}>{uiText("全部交易", "All trades")} <small>{uiText("点击一行打开单笔复盘 · 最近 200 笔", "Click a row to open its replay · latest 200")}</small></h3>
      <div className="dp-card tr-table-card" ref={tableRef}>
        <div className="tr-filters">
          {([["all", uiText("全部", "All")], ["win", uiText("盈利", "Wins")], ["loss", uiText("亏损", "Losses")], ["revenge", uiText("追单", "Re-entries")], ["nostop", uiText("没设止损", "No stop")]] as [FindingFilter, string][]).map(([key, label]) => (
            <button key={key} type="button" className={clsx("tr-pill", filter === key && "is-on")} onClick={() => setFilter(key)}>{label}<em>{counts[key as keyof typeof counts]}</em></button>
          ))}
          {filter.startsWith("sym:") && <button type="button" className="tr-pill is-on" onClick={() => setFilter("all")}>{filter.slice(4)} ✕</button>}
        </div>
        {shown.length === 0 ? (
          <div className="dp-empty is-small">{loading ? uiText("读取中…", "Loading…") : uiText("这个区间没有符合条件的已平仓位。可以先同步历史，或放宽时间范围。", "No closed positions match. Sync history or widen the range.")}</div>
        ) : (
          <div className="tr-table-wrap">
            <table className="tr-table">
              <thead>
                <tr>
                  <th>{uiText("开仓时间", "Opened")}</th><th>{uiText("品种", "Market")}</th><th>{uiText("方向", "Side")}</th><th>{uiText("持仓", "Held")}</th><th>{uiText("来源", "Source")}</th>
                  <th className="is-num">{uiText("净盈亏", "Net PnL")}</th><th className="is-num">{uiText("手续费", "Fees")}</th><th>{uiText("标签", "Tags")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((trade) => (
                  <tr key={trade.id} className={clsx(selectedId === trade.id && "is-sel")} onClick={() => setSelectedId(trade.id)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && setSelectedId(trade.id)}>
                    <td className="is-mono">{fmtTime(trade.openTime)}</td>
                    <td><b>{trade.base}</b>{trade.leverage ? <small> {trade.leverage}x</small> : null}</td>
                    <td><span className={clsx("tr-side", `is-${trade.side}`)}>{trade.side === "long" ? uiText("多", "L") : uiText("空", "S")}</span></td>
                    <td className="is-mono">{formatDuration(trade.holdMs, uiText)}</td>
                    <td className="tr-weak">{sourceLabel(trade.source, uiText)}</td>
                    <td className={clsx("is-num", "is-mono", `is-${tone(trade.netPnl)}`)}>{fmtSigned(trade.netPnl)}</td>
                    <td className="is-num is-mono tr-weak">{fmtNumber(trade.fees)}</td>
                    <td>
                      {trade.revenge && <span className="tr-tag is-auto">{uiText("追单", "Re-entry")}</span>}
                      {trade.hadStop === false && <span className="tr-tag is-auto">{uiText("无止损", "No stop")}</span>}
                      {trade.tags.map((tag) => <span key={tag} className="tr-tag is-mine">{tag}</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && account && <TradeDrawer trade={selected} accountId={account.id} uiText={uiText} onClose={() => setSelectedId(null)} onSaveMeta={saveMeta} onOpenAiResearch={onOpenAiResearch} />}
    </div>
  );
}

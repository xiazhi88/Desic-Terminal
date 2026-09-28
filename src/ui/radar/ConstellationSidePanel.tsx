import { useEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { ArrowUpRight, GitCompareArrows, X } from "lucide-react";
import type { MarketRadarRow } from "../../lib/marketRadar";
import { radarSectorName } from "../../lib/radarSectors";
import { rankChangeOver, type ConstellationFactor, type ConstellationModel } from "./constellationModel";
import { COMPARE_SERIES } from "./radarConstellationEngine";

// 星图右侧面板（移植自市场星图原型）：无选中时是市场总览（宽度 / 板块强弱 / 排名异动），
// 点击星点显示该合约在当前回放时刻的证据，⇧ 圈选或 ⌘ 点击进入比较。
// 全部数值取自当前帧的快照；不构成方向判断。

type Text = (zh: string, en: string) => string;

const INK = { ink: "#f4f4fa", ink2: "#b9bacb", ink3: "#7e8096", ink4: "#53556a", hair: "rgba(200, 200, 230, 0.075)", hair2: "rgba(200, 200, 230, 0.13)" };
const NUM_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";
const UI_FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";

type Props = {
  model: ConstellationModel;
  frame: number;
  rows: MarketRadarRow[];
  chinese: boolean;
  text: Text;
  selected: number;
  compare: number[];
  categoryFocus: string | null;
  factorName: (factor: ConstellationFactor) => string;
  onSelect: (index: number) => void;
  onCategoryFocus: (category: string | null) => void;
  onAddCompare: (index: number) => void;
  onRemoveCompare: (index: number) => void;
  onClearCompare: () => void;
  onOpenSymbol: (instId: string) => void;
};

function fitCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const context = canvas.getContext("2d");
  context?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, w: rect.width, h: rect.height };
}

const signedPct = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const pctClass = (value: number) => (value > 0 ? "is-rise" : value < 0 ? "is-fall" : "");
const compactUsd = (value: number) => (value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `$${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : `$${value.toFixed(0)}`);

export function formatFrameTime(time: number | undefined, full = false) {
  if (time === undefined) return "--";
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${full ? `${date.getFullYear()}-` : ""}${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ConstellationSidePanel(props: Props) {
  if (props.compare.length > 0) return <ComparePanel {...props} />;
  if (props.selected >= 0) return <DetailPanel {...props} />;
  return <OverviewPanel {...props} />;
}

function OverviewPanel({ model, frame, chinese, text, categoryFocus, onSelect, onCategoryFocus }: Props) {
  const f = Math.max(0, Math.min(model.frames - 1, Math.round(frame)));
  const valid = model.validCount[f] ?? 0;
  const breadth = model.breadth[f] ?? 0.5;
  const rising = Math.round(breadth * valid);
  const back24 = useMemo(() => frameBefore(model, f, 24), [model, f]);
  const sectors = useMemo(() => model.sectors.map((sector) => {
    let n = 0;
    let score = 0;
    let change = 0;
    let before = 0;
    let beforeN = 0;
    for (let index = 0; index < model.count; index += 1) {
      if (model.categories[index] !== sector) continue;
      const key = f * model.count + index;
      if (!model.valid[key]) continue;
      n += 1;
      score += model.factors.composite[key]!;
      change += model.change[key]!;
      if (back24 !== null && model.valid[back24 * model.count + index]) {
        before += model.factors.composite[back24 * model.count + index]!;
        beforeN += 1;
      }
    }
    return { sector, n, avg: n ? score / n : 0, change: n ? change / n : 0, delta: beforeN ? score / n - before / beforeN : null };
  }).filter((item) => item.n > 0).sort((left, right) => right.avg - left.avg), [back24, f, model]);
  const movers = useMemo(() => {
    const out: Array<[number, number]> = [];
    for (let index = 0; index < model.count; index += 1) {
      const key = f * model.count + index;
      if (!model.valid[key] || model.rank[key]! > 150) continue;
      const delta = rankChangeOver(model, index, f, 6);
      if (delta) out.push([index, delta]);
    }
    return out.sort((left, right) => Math.abs(right[1]) - Math.abs(left[1])).slice(0, 7);
  }, [f, model]);

  return <>
    <section className="rc-sec">
      <div className="rc-sec-h"><span className="rc-micro">{text("市场宽度", "Market breadth")}</span><span className="rc-micro is-plain">{formatFrameTime(model.frameTimes[f])}</span></div>
      <div className="rc-breadth"><span className={clsx("rc-display", breadth >= 0.5 ? "is-rise" : "is-fall")}>{(breadth * 100).toFixed(0)}%</span><span>{text("24h 上涨合约占比", "of markets up over 24h")}</span></div>
      <div className="rc-bbar"><i style={{ width: `${(breadth * 100).toFixed(1)}%` }} className="is-rise" /><i className="is-fall" /></div>
      <div className="rc-bbar-l"><span>{text(`上涨 ${rising}`, `Up ${rising}`)}</span><span>{text(`下跌 ${valid - rising}`, `Down ${valid - rising}`)}</span></div>
    </section>
    <section className="rc-sec">
      <div className="rc-sec-h"><span className="rc-micro">{text("板块强弱 · 平均综合位置", "Sectors · mean composite")}</span><span className="rc-micro is-plain">24h Δ</span></div>
      <div className="rc-rows">
        {sectors.map((item) => <button type="button" key={item.sector} className={clsx("rc-row", categoryFocus === item.sector && "is-focus")} onClick={() => onCategoryFocus(categoryFocus === item.sector ? null : item.sector)}>
          <span className="rc-n">{radarSectorName(item.sector, chinese)} <small>{item.n}</small></span>
          <span className="rc-mini"><i style={{ width: `${item.avg.toFixed(0)}%` }} /></span>
          <span className={clsx("rc-r", pctClass(item.change))}>{signedPct(item.change)}</span>
          <span className="rc-r is-muted">{item.delta === null ? "--" : `${item.delta >= 0 ? "+" : ""}${item.delta.toFixed(1)}`}</span>
        </button>)}
      </div>
    </section>
    <section className="rc-sec">
      <div className="rc-sec-h"><span className="rc-micro">{text("排名异动 · 6 小时", "Rank moves · 6h")}</span><span className="rc-micro is-plain">{text("前 150", "Top 150")}</span></div>
      <div className="rc-rows">
        {movers.length === 0 ? <p className="rc-foot">{text("该时刻缺少 6 小时前的快照，或前 150 名没有排名变化。", "No 6h-earlier snapshot at this moment, or no rank changes in the top 150.")}</p> : movers.map(([index, delta]) => <button type="button" key={index} className="rc-row is-mv" onClick={() => onSelect(index)}>
          <span className="rc-n">{model.labels[index]} <small>{radarSectorName(model.categories[index]!, chinese)}</small></span>
          <span className="rc-r is-muted">#{model.rank[f * model.count + index]}</span>
          <span className="rc-r">{delta > 0 ? "▲" : "▼"} {Math.abs(delta)}</span>
        </button>)}
      </div>
    </section>
    <section className="rc-sec">
      <div className="rc-hint">{text("点击星点查看证据", "Click a star for evidence")} · <kbd>⇧</kbd> {text("拖拽圈选 2–4 个比较", "drag to lasso 2–4")} · <kbd>⌘</kbd> {text("点击加入比较", "click to compare")}</div>
    </section>
  </>;
}

function frameBefore(model: ConstellationModel, frame: number, hours: number) {
  const time = model.frameTimes[frame];
  if (time === undefined) return null;
  const target = time - hours * 3_600_000;
  let cursor = frame;
  while (cursor > 0 && model.frameTimes[cursor]! > target + 30 * 60_000) cursor -= 1;
  return cursor !== frame && Math.abs(model.frameTimes[cursor]! - target) <= Math.max(90 * 60_000, hours * 3_600_000 * 0.25) ? cursor : null;
}

const FACTOR_ROWS: ConstellationFactor[] = ["strength", "lowVolatility", "activity", "trendQuality"];

function DetailPanel({ model, frame, rows, chinese, text, selected, factorName, onAddCompare, onOpenSymbol }: Props) {
  const f = Math.max(0, Math.min(model.frames - 1, Math.round(frame)));
  const key = f * model.count + selected;
  const instId = model.instIds[selected]!;
  const row = rows.find((item) => item.instrument.instId === instId);
  const sparkRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = sparkRef.current;
    if (!canvas) return;
    const { context, w, h } = fitCanvas(canvas);
    if (!context) return;
    const points: Array<[number, number]> = [];
    let min = Infinity;
    let max = 0;
    // 12 个样本的滑动均值：读趋势而不是读噪声。
    for (let cursor = 0; cursor < model.frames; cursor += 1) {
      let sum = 0;
      let n = 0;
      for (let q = 0; q < 12 && cursor - q >= 0; q += 1) {
        const back = (cursor - q) * model.count + selected;
        if (!model.valid[back]) break;
        sum += model.rank[back]!;
        n += 1;
      }
      if (!n) continue;
      const value = sum / n;
      points.push([cursor, value]);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    if (points.length < 2) {
      context.fillStyle = INK.ink4;
      context.font = `11px ${UI_FONT}`;
      context.fillText(text("回放区间内没有足够的快照", "Not enough snapshots in range"), 4, h / 2);
      return;
    }
    min = Math.max(1, Math.round(min) - 3);
    max = Math.round(max) + 3;
    const start = model.frameTimes[0]!;
    const span = Math.max(1, model.frameTimes.at(-1)! - start);
    const px = (cursor: number) => 30 + ((model.frameTimes[cursor]! - start) / span) * (w - 34);
    const py = (rank: number) => 6 + ((Math.log(rank) - Math.log(min)) / (Math.log(max) - Math.log(min) || 1)) * (h - 20);
    context.font = `9.5px ${NUM_FONT}`;
    context.fillStyle = INK.ink4;
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillText(`#${min}`, 26, py(min));
    context.fillText(`#${max}`, 26, py(max));
    context.strokeStyle = INK.hair;
    context.beginPath();
    context.moveTo(30, py(min) + 0.5);
    context.lineTo(w, py(min) + 0.5);
    context.moveTo(30, py(max) + 0.5);
    context.lineTo(w, py(max) + 0.5);
    context.stroke();
    for (const event of model.events) {
      context.fillStyle = INK.hair;
      context.fillRect(px(event.frame), 4, 1, h - 16);
    }
    const trace = () => {
      context.beginPath();
      points.forEach(([cursor, rank], index) => (index ? context.lineTo(px(cursor), py(rank)) : context.moveTo(px(cursor), py(rank))));
    };
    context.lineWidth = 1.2;
    trace();
    context.strokeStyle = INK.ink3;
    context.stroke();
    context.save();
    context.beginPath();
    context.rect(0, 0, px(f), h);
    context.clip();
    trace();
    context.strokeStyle = INK.ink;
    context.stroke();
    context.restore();
    if (model.valid[key]) {
      context.fillStyle = INK.ink;
      context.beginPath();
      context.arc(px(f), py(model.rank[key]!), 2.6, 0, Math.PI * 2);
      context.fill();
    }
    context.textBaseline = "bottom";
    context.fillStyle = INK.ink4;
    context.textAlign = "left";
    context.fillText(formatFrameTime(model.frameTimes[0]).slice(0, 5), 30, h);
    context.textAlign = "right";
    context.fillText(formatFrameTime(model.frameTimes.at(-1)).slice(0, 5), w, h);
  }, [f, key, model, selected, text]);

  if (!model.valid[key]) {
    return <section className="rc-sec"><div className="rc-pd-sym">{model.labels[selected]}</div><p className="rc-foot">{text("该时刻没有这个合约的快照。", "No snapshot for this market at this moment.")}</p></section>;
  }
  const deltaText = (value: number | null) => (value === null ? "--" : value === 0 ? text("持平", "Flat") : `${value > 0 ? "▲" : "▼"} ${Math.abs(value)}`);
  const atLive = model.liveIndex === f;
  return <>
    <section className="rc-sec">
      <div className="rc-pd-head">
        <div>
          <div className="rc-pd-sym">{row?.instrument.baseCcy ?? model.labels[selected]}</div>
          <div className="rc-pd-inst">{instId} · {radarSectorName(model.categories[selected]!, chinese)}</div>
        </div>
        <div className="rc-pd-actions">
          <button type="button" className="rc-btn" onClick={() => onAddCompare(selected)}><GitCompareArrows size={12} />{text("比较", "Compare")}</button>
          <button type="button" className="rc-btn" onClick={() => onOpenSymbol(instId)}><ArrowUpRight size={12} />{text("图表", "Chart")}</button>
        </div>
      </div>
      <div className="rc-pd-big">
        <span className="rc-display">{Math.round(model.compositeRaw[key]!)}</span>
        <span className="rc-unit">{text("综合评分", "Composite")}</span>
        <span className={clsx("rc-chg", pctClass(model.change[key]!))}>{signedPct(model.change[key]!)}</span>
        <span className="rc-rk">#{model.rank[key]} / {model.validCount[f]}</span>
      </div>
    </section>
    <section className="rc-sec">
      {FACTOR_ROWS.map((factor) => {
        const value = model.factors[factor][key]!;
        return <div className="rc-fac" key={factor}>
          <div className="rc-l"><b>{factorName(factor)}</b><span>{value.toFixed(0)}</span></div>
          <div className="rc-bar"><i style={{ width: `${value.toFixed(1)}%` }} /><em /></div>
          <div className="rc-d">{factorFact(factor, atLive ? row : undefined, text)}</div>
        </div>;
      })}
    </section>
    <section className="rc-sec">
      <div className="rc-sec-h"><span className="rc-micro">{text("排名历史 · 回放区间", "Rank history · range")}</span><span className="rc-micro is-plain">{text("越高越靠前", "Higher is better")}</span></div>
      <canvas className="rc-spark" ref={sparkRef} />
    </section>
    <section className="rc-sec">
      <dl className="rc-kv">
        <dt>{text("1 小时排名变化", "1h rank change")}</dt><dd>{deltaText(rankChangeOver(model, selected, f, 1))}</dd>
        <dt>{text("1 日排名变化", "1d rank change")}</dt><dd>{deltaText(rankChangeOver(model, selected, f, 24))}</dd>
        <dt>{text("7 日排名变化", "7d rank change")}</dt><dd>{deltaText(rankChangeOver(model, selected, f, 168))}</dd>
        <dt>{text("24h 成交额", "24h turnover")}</dt><dd>{compactUsd(model.turnover[key]!)}</dd>
        {atLive && row ? <><dt>{text("点差", "Spread")}</dt><dd>{row.spreadBps == null ? "--" : `${row.spreadBps.toFixed(1)} bp`}</dd></> : null}
        {atLive && row ? <><dt>{text("最新价", "Last")}</dt><dd>{row.last.toLocaleString("en-US", { maximumSignificantDigits: 8 })}</dd></> : null}
        <dt>{text("快照时间", "Snapshot")}</dt><dd>{formatFrameTime(model.frameTimes[f], true)}{atLive ? text(" · 实时", " · live") : ""}</dd>
      </dl>
    </section>
    <section className="rc-sec"><p className="rc-foot">{text("坐标为当帧横截面位置（50 = 全市场均值）。评分只用于市场研究优先级，不是交易建议或自动交易命令。", "Coordinates are cross-sectional positions in this frame (50 = market mean). Scores rank research priority; they are not trade advice or automated orders.")}</p></section>
  </>;
}

function factorFact(factor: ConstellationFactor, row: MarketRadarRow | undefined, text: Text) {
  const research = row?.research;
  if (factor === "strength") return research ? text(`30 天相对全市场 ${signedPct(research.relativeStrength30dPct)}`, `30d vs market ${signedPct(research.relativeStrength30dPct)}`) : text("相对强度在全市场中的位置", "Relative strength vs the market");
  if (factor === "lowVolatility") return research ? text(`20 天日收益波动率 ${research.volatility20dPct.toFixed(2)}%`, `20d daily volatility ${research.volatility20dPct.toFixed(2)}%`) : text("波动越低越靠右", "Lower volatility scores higher");
  if (factor === "activity") return research?.volumeRatio20d != null ? text(`最近成交额为 20 日均值的 ${research.volumeRatio20d.toFixed(2)} 倍`, `Turnover ${research.volumeRatio20d.toFixed(2)}× its 20d mean`) : text("成交活跃度在全市场中的位置", "Trading activity vs the market");
  return research ? text(`30 天趋势拟合度 ${(research.trendQuality30d * 100).toFixed(0)}%`, `30d trend fit ${(research.trendQuality30d * 100).toFixed(0)}%`) : text("趋势稳定性在全市场中的位置", "Trend stability vs the market");
}

const PARALLEL_AXES: Array<[ConstellationFactor, string, string]> = [
  ["strength", "相对强度", "Strength"],
  ["lowVolatility", "低波动", "Calm"],
  ["activity", "活跃", "Activity"],
  ["trendQuality", "趋势", "Trend"],
  ["composite", "综合", "Composite"]
];

function ComparePanel({ model, frame, chinese, text, compare, onRemoveCompare, onClearCompare }: Props) {
  const f = Math.max(0, Math.min(model.frames - 1, Math.round(frame)));
  const parallelRef = useRef<HTMLCanvasElement | null>(null);
  const ranksRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = parallelRef.current;
    if (!canvas) return;
    const { context, w, h } = fitCanvas(canvas);
    if (!context) return;
    const x0 = 14;
    const x1 = w - 14;
    const top = 8;
    const bottom = h - 22;
    const ax = (position: number) => x0 + (position / (PARALLEL_AXES.length - 1)) * (x1 - x0);
    const ay = (value: number) => bottom - (value / 100) * (bottom - top);
    context.font = `10px ${UI_FONT}`;
    PARALLEL_AXES.forEach(([, zh, en], position) => {
      context.fillStyle = INK.hair2;
      context.fillRect(Math.round(ax(position)), top, 1, bottom - top);
      context.fillStyle = INK.ink3;
      context.textAlign = position === 0 ? "left" : position === PARALLEL_AXES.length - 1 ? "right" : "center";
      context.textBaseline = "top";
      context.fillText(chinese ? zh : en, ax(position) + (position === 0 ? -6 : position === PARALLEL_AXES.length - 1 ? 6 : 0), bottom + 7);
    });
    context.fillStyle = INK.hair;
    context.fillRect(x0, Math.round(ay(50)), x1 - x0, 1);
    compare.forEach((index, series) => {
      const key = f * model.count + index;
      if (!model.valid[key]) return;
      const color = COMPARE_SERIES[series % COMPARE_SERIES.length]!;
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 1.4;
      context.beginPath();
      PARALLEL_AXES.forEach(([factor], position) => (position ? context.lineTo(ax(position), ay(model.factors[factor][key]!)) : context.moveTo(ax(position), ay(model.factors[factor][key]!))));
      context.stroke();
      PARALLEL_AXES.forEach(([factor], position) => {
        context.beginPath();
        context.arc(ax(position), ay(model.factors[factor][key]!), 2.2, 0, Math.PI * 2);
        context.fill();
      });
    });
  }, [chinese, compare, f, model]);

  // 名次走势：回放区间内每个比较对象的综合名次（价格序列不在快照里，这里只画真实存在的名次）。
  useEffect(() => {
    const canvas = ranksRef.current;
    if (!canvas) return;
    const { context, w, h } = fitCanvas(canvas);
    if (!context) return;
    const start = model.frameTimes[0] ?? 0;
    const end = model.frameTimes[f] ?? start;
    const span = Math.max(1, end - start);
    let worst = 1;
    for (const index of compare) for (let cursor = 0; cursor <= f; cursor += 1) {
      const key = cursor * model.count + index;
      if (model.valid[key]) worst = Math.max(worst, model.rank[key]!);
    }
    const x0 = 4;
    const x1 = w - 52;
    const px = (cursor: number) => x0 + ((model.frameTimes[cursor]! - start) / span) * (x1 - x0);
    const py = (rank: number) => 6 + ((Math.log(rank)) / (Math.log(worst + 1) || 1)) * (h - 12);
    context.font = `10px ${NUM_FONT}`;
    context.textBaseline = "middle";
    context.textAlign = "left";
    const labels: Array<{ y: number; rank: number; series: number }> = [];
    compare.forEach((index, series) => {
      const color = COMPARE_SERIES[series % COMPARE_SERIES.length]!;
      context.strokeStyle = color;
      context.lineWidth = 1.3;
      context.beginPath();
      let started = false;
      let last: number | null = null;
      for (let cursor = 0; cursor <= f; cursor += 1) {
        const key = cursor * model.count + index;
        if (!model.valid[key] || (cursor > 0 && model.gapAfter[cursor - 1])) {
          started = false;
          if (!model.valid[key]) continue;
        }
        if (started) context.lineTo(px(cursor), py(model.rank[key]!));
        else context.moveTo(px(cursor), py(model.rank[key]!));
        started = true;
        last = model.rank[key]!;
      }
      context.stroke();
      if (last !== null) labels.push({ y: py(last), rank: last, series });
    });
    labels.sort((left, right) => left.y - right.y);
    for (let position = 1; position < labels.length; position += 1) if (labels[position]!.y - labels[position - 1]!.y < 12) labels[position]!.y = labels[position - 1]!.y + 12;
    for (const label of labels) {
      context.fillStyle = COMPARE_SERIES[label.series % COMPARE_SERIES.length]!;
      context.fillText(`#${label.rank}`, x1 + 6, label.y);
    }
  }, [compare, f, model]);

  return <>
    <section className="rc-sec">
      <div className="rc-sec-h"><span className="rc-micro">{text(`比较 · ${compare.length} 个合约`, `Compare · ${compare.length}`)}</span><button type="button" className="rc-btn is-ghost" onClick={onClearCompare}>{text("清除", "Clear")} <kbd>Esc</kbd></button></div>
      <div className="rc-cmp-leg">
        {compare.map((index, series) => {
          const key = f * model.count + index;
          const valid = model.valid[key];
          return <div className="rc-it" key={index}>
            <span className="rc-sw" style={{ background: COMPARE_SERIES[series % COMPARE_SERIES.length] }} />
            <span><b>{model.labels[index]}</b> <small>{radarSectorName(model.categories[index]!, chinese)}</small></span>
            <span className="rc-num">{valid ? Math.round(model.compositeRaw[key]!) : "—"}</span>
            <span className={clsx("rc-num", valid && pctClass(model.change[key]!))}>{valid ? signedPct(model.change[key]!) : "—"}</span>
            <button type="button" onClick={() => onRemoveCompare(index)} title={text("移除", "Remove")} aria-label={text("移除", "Remove")}><X size={12} /></button>
          </div>;
        })}
      </div>
      {compare.length < 2 ? <p className="rc-foot">{text(`⌘ 点击星点或 ⇧ 拖拽圈选，再加入 ${2 - compare.length} 个以上。`, `⌘-click or ⇧-lasso to add ${2 - compare.length} more.`)}</p> : null}
    </section>
    <section className="rc-sec"><div className="rc-sec-h"><span className="rc-micro">{text("因子叠加 · 0–100", "Factor overlay · 0–100")}</span></div><canvas className="rc-pc" ref={parallelRef} /></section>
    <section className="rc-sec"><div className="rc-sec-h"><span className="rc-micro">{text("综合名次 · 回放区间", "Composite rank · range")}</span></div><canvas className="rc-pl" ref={ranksRef} /></section>
    <section className="rc-sec"><p className="rc-foot">{text("比较只陈列同一快照时刻的事实与评分，不构成方向判断。", "Comparison shows facts and scores at the same snapshot; it is not a directional call.")}</p></section>
  </>;
}

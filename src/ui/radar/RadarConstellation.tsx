import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowLeftRight, Pause, Play, Radar as RadarIcon } from "lucide-react";
import type { MarketRadarResearchScore, MarketRadarSnapshotFrames } from "../../types";
import type { MarketRadarRow } from "../../lib/marketRadar";
import { loadMarketRadarSnapshotFrames } from "../../lib/okx";
import { buildConstellationModel, CONSTELLATION_FACTORS, rankChangeOver, type ConstellationFactor, type ConstellationModel } from "./constellationModel";
import { RadarConstellationEngine } from "./radarConstellationEngine";
import { buildPreviewSnapshotFrames } from "./radarPreviewFrames";
import { buildRadarSnapshotInput } from "../../lib/marketRadarSnapshot";
import { TerminalSelect } from "../TerminalSelect";
import "./radarConstellation.css";

type Text = (zh: string, en: string) => string;

type Props = {
  rows: MarketRadarRow[];
  researchScores: MarketRadarResearchScore[];
  fetchedAt: number | null;
  focusIds: Set<string> | null;
  selectedId: string | null;
  compareIds: string[];
  desktop: boolean;
  text: Text;
  categoryName: (category: string) => string;
  onSelect: (instId: string) => void;
  onCompare: (instIds: string[]) => void;
};

const RANGES = [
  { id: "7d", days: 7, stepHours: 1 },
  { id: "30d", days: 30, stepHours: 4 },
  { id: "90d", days: 90, stepHours: 12 }
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const SPEEDS = [2, 6, 18] as const;
const AXIS_STORAGE = "desic.radar.constellation-axes.v1";
const syntheticFrames = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("radarFrames") === "synthetic";

function readAxes(): [ConstellationFactor, ConstellationFactor] {
  try {
    const [x, y] = JSON.parse(window.localStorage.getItem(AXIS_STORAGE) ?? "[]") as string[];
    const valid = (value: unknown): value is ConstellationFactor => CONSTELLATION_FACTORS.includes(value as ConstellationFactor);
    if (valid(x) && valid(y) && x !== y) return [x, y];
  } catch {
    // 读不到就用默认坐标轴。
  }
  return ["strength", "activity"];
}

export function RadarConstellation({ rows, researchScores, fetchedAt, focusIds, selectedId, compareIds, desktop, text, categoryName, onSelect, onCompare }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<RadarConstellationEngine | null>(null);
  const [range, setRange] = useState<RangeId>("7d");
  const [frames, setFrames] = useState<MarketRadarSnapshotFrames | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const [axes, setAxes] = useState(readAxes);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(6);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(() => new Set());
  const [webgl, setWebgl] = useState(true);
  const previousRanksRef = useRef<Map<string, number>>(new Map());

  const factorMeta = useMemo<Record<ConstellationFactor, { name: string; low: string; high: string }>>(() => ({
    composite: { name: text("综合评分", "Composite score"), low: text("低分", "Low"), high: text("高分", "High") },
    strength: { name: text("相对强度", "Relative strength"), low: text("弱", "Weak"), high: text("强", "Strong") },
    lowVolatility: { name: text("低波动", "Low volatility"), low: text("高波动", "Volatile"), high: text("平稳", "Calm") },
    activity: { name: text("成交活跃", "Activity"), low: text("冷清", "Quiet"), high: text("活跃", "Active") },
    trendQuality: { name: text("趋势稳定", "Trend stability"), low: text("杂乱", "Choppy"), high: text("稳定", "Stable") }
  }), [text]);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onCompareRef = useRef(onCompare);
  onCompareRef.current = onCompare;
  const frameRef = useRef(0);
  const engineModelRef = useRef<ConstellationModel | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = new RadarConstellationEngine(host, {
      onHover: (index, x, y) => setHover(index === null ? null : { index, x, y }),
      onSelect: (index) => {
        const instId = engineModelRef.current?.instIds[index];
        if (instId) onSelectRef.current(instId);
      },
      onLasso: (indices) => {
        const model = engineModelRef.current;
        if (!model || indices.length === 0) return;
        const current = Math.round(frameRef.current);
        const ranked = indices
          .map((index) => ({ index, rank: model.rank[current * model.count + index] ?? Infinity }))
          .sort((left, right) => left.rank - right.rank)
          .slice(0, 4)
          .map((entry) => model.instIds[entry.index]!);
        onCompareRef.current(ranked);
      },
      onTime: (next, isPlaying) => {
        frameRef.current = next;
        setFrame(next);
        setPlaying(isPlaying);
      }
    });
    engineRef.current = engine;
    setWebgl(engine.webglAvailable);
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  const rangeConfig = RANGES.find((item) => item.id === range)!;
  useEffect(() => {
    let active = true;
    setFramesLoading(true);
    const now = Date.now();
    const load = syntheticFrames
      ? Promise.resolve(buildPreviewSnapshotFrames(
        rows.map((row) => row.instrument.instId),
        rows.map((row) => row.instrument.instCategory ?? null),
        rangeConfig.days,
        rangeConfig.stepHours,
        now,
        buildRadarSnapshotInput(rows, researchScores, now).rows.map((row) => ({
          composite: row.compositeScore,
          strength: row.strengthScore,
          lowVolatility: row.lowVolatilityScore,
          activity: row.rawActivityScore,
          trendQuality: row.rawTrendQualityScore ?? row.trendQualityScore,
          change: row.change24hPct,
          turnover: row.turnover24h
        }))
      ))
      : loadMarketRadarSnapshotFrames({ fromMs: now - rangeConfig.days * 86_400_000, toMs: now, stepHours: rangeConfig.stepHours, maxFrames: 400 });
    void load.then((result) => {
      if (active) setFrames(result);
    }).finally(() => {
      if (active) setFramesLoading(false);
    });
    return () => {
      active = false;
    };
    // 行情刷新不重新读取历史帧；范围切换或首次有行情时读取。
  }, [range, rows.length > 0]);

  const model = useMemo(() => buildConstellationModel(frames, rows, researchScores, fetchedAt), [fetchedAt, frames, researchScores, rows]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engineModelRef.current = model;
    engine.setModel(model);
  }, [model]);

  useEffect(() => {
    const [x, y] = axes;
    window.localStorage.setItem(AXIS_STORAGE, JSON.stringify(axes));
    engineRef.current?.setAxes(x, y, {
      x: factorMeta[x].name,
      y: factorMeta[y].name,
      xLow: factorMeta[x].low,
      xHigh: factorMeta[x].high,
      yLow: factorMeta[y].low,
      yHigh: factorMeta[y].high
    });
  }, [axes, factorMeta]);

  const axisOptions = useMemo(() => CONSTELLATION_FACTORS.map((factor) => ({ value: factor, label: factorMeta[factor].name })), [factorMeta]);
  const categories = useMemo(() => [...new Set(model.categories)], [model.categories]);
  useEffect(() => {
    engineRef.current?.setCategoryNames(Object.fromEntries(categories.map((category) => [category, categoryName(category)])));
  }, [categories, categoryName]);

  useEffect(() => {
    engineRef.current?.setHiddenCategories(hiddenCategories);
  }, [hiddenCategories]);

  useEffect(() => {
    if (!focusIds) {
      engineRef.current?.setFocus(null);
      return;
    }
    const mask = new Uint8Array(model.count);
    model.instIds.forEach((instId, index) => {
      if (focusIds.has(instId)) mask[index] = 1;
    });
    engineRef.current?.setFocus(mask);
  }, [focusIds, model]);

  useEffect(() => {
    const index = selectedId ? model.instIds.indexOf(selectedId) : -1;
    engineRef.current?.setSelection(index, compareIds.map((instId) => model.instIds.indexOf(instId)).filter((value) => value >= 0));
  }, [compareIds, model, selectedId]);

  // 实时端每次刷新：名次变化的点在雷达扫描扫过时点亮（只在停留于实时端时播放）。
  useEffect(() => {
    const previous = previousRanksRef.current;
    const next = new Map(rows.map((row) => [row.instrument.instId, row.rank]));
    previousRanksRef.current = next;
    if (previous.size === 0 || model.liveIndex === null || Math.round(frameRef.current) !== model.liveIndex) return;
    const changed = new Map<number, number>();
    for (const [instId, rank] of next) {
      const before = previous.get(instId);
      const index = model.instIds.indexOf(instId);
      if (before !== undefined && before !== rank && index >= 0) changed.set(index, before - rank);
    }
    engineRef.current?.sweep(changed);
    // 只跟随行情刷新时间。
  }, [fetchedAt]);

  const frameTime = model.frameTimes[Math.round(frame)] ?? null;
  const atLive = model.liveIndex !== null && Math.round(frame) === model.liveIndex;
  const snapshotCount = frames?.snapshotsInRange ?? 0;

  // —— 时间轴：宽度曲线（上涨占比）、快照空洞斜线、播放头；按真实时间布局，空洞如实占位 ——
  const drawTimeline = useCallback(() => {
    const canvas = timelineRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const times = model.frameTimes;
    if (times.length === 0) return;
    const start = times[0]!;
    const end = Math.max(times.at(-1)!, start + 1);
    const xOf = (time: number) => ((time - start) / (end - start)) * rect.width;
    const mid = rect.height / 2;
    const styles = getComputedStyle(canvas);
    const up = styles.getPropertyValue("--up").trim() || "#f6465d";
    const down = styles.getPropertyValue("--down").trim() || "#0ecb81";
    times.forEach((time, index) => {
      const next = times[index + 1] ?? time + 3_600_000;
      const width = Math.max(1, xOf(next) - xOf(time) - 0.5);
      if (model.gapAfter[index]) return;
      const value = model.breadth[index]! - 0.5;
      context.fillStyle = value >= 0 ? up : down;
      context.globalAlpha = 0.55;
      const height = Math.abs(value) * (rect.height - 6);
      context.fillRect(xOf(time), value >= 0 ? mid - height : mid, width, height);
    });
    context.globalAlpha = 1;
    // 快照空洞：斜线填充，表示应用未运行、没有快照，不补造数据。
    context.strokeStyle = "rgba(200, 200, 230, 0.18)";
    context.lineWidth = 1;
    times.forEach((time, index) => {
      if (!model.gapAfter[index]) return;
      const left = xOf(time) + 1;
      const right = xOf(times[index + 1]!) - 1;
      context.save();
      context.beginPath();
      context.rect(left, 2, Math.max(0, right - left), rect.height - 4);
      context.clip();
      for (let x = left - rect.height; x < right; x += 5) {
        context.beginPath();
        context.moveTo(x, rect.height);
        context.lineTo(x + rect.height, 0);
        context.stroke();
      }
      context.restore();
    });
    context.strokeStyle = "rgba(200, 200, 230, 0.16)";
    context.beginPath();
    context.moveTo(0, mid + 0.5);
    context.lineTo(rect.width, mid + 0.5);
    context.stroke();
    const current = frameRef.current;
    const f0 = Math.floor(current);
    const t0 = times[f0] ?? start;
    const t1 = times[Math.min(times.length - 1, f0 + 1)] ?? t0;
    const playhead = xOf(t0 + (t1 - t0) * (current - f0));
    context.strokeStyle = styles.getPropertyValue("--text").trim() || "#f4f4fa";
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(playhead, 0);
    context.lineTo(playhead, rect.height);
    context.stroke();
  }, [model]);

  useEffect(() => {
    drawTimeline();
  }, [drawTimeline, frame]);

  useEffect(() => {
    const canvas = timelineRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(drawTimeline);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawTimeline]);

  const frameAtClientX = (clientX: number) => {
    const canvas = timelineRef.current;
    const times = model.frameTimes;
    if (!canvas || times.length < 2) return times.length - 1;
    const rect = canvas.getBoundingClientRect();
    const time = times[0]! + ((clientX - rect.left) / rect.width) * (times.at(-1)! - times[0]!);
    let index = 0;
    while (index < times.length - 2 && times[index + 1]! <= time) index += 1;
    const span = times[index + 1]! - times[index]!;
    return Math.max(0, Math.min(times.length - 1, index + (span > 0 ? (time - times[index]!) / span : 0)));
  };

  const hovered = hover ? model.instIds[hover.index] : null;
  const hoverFrame = Math.round(frame);
  const hoverKey = hover ? hoverFrame * model.count + hover.index : -1;
  const formatDelta = (value: number | null) => (value === null ? "--" : value === 0 ? "0" : `${value > 0 ? "↑" : "↓"}${Math.abs(value)}`);

  return (
    <section className="radar-constellation" aria-label={text("市场星图", "Market constellation")}>
      <header className="radar-constellation__toolbar">
        <label>
          <span>X</span>
          <TerminalSelect
            value={axes[0]}
            options={axisOptions}
            ariaLabel={text("横轴因子", "X-axis factor")}
            className="radar-constellation__axis"
            onChange={(value) => setAxes(([x, y]) => [value as ConstellationFactor, y === value ? x : y])}
          />
        </label>
        <button type="button" className="radar-constellation__swap" onClick={() => setAxes(([x, y]) => [y, x])} title={text("交换坐标轴", "Swap axes")} aria-label={text("交换坐标轴", "Swap axes")}><ArrowLeftRight size={13} /></button>
        <label>
          <span>Y</span>
          <TerminalSelect
            value={axes[1]}
            options={axisOptions}
            ariaLabel={text("纵轴因子", "Y-axis factor")}
            className="radar-constellation__axis"
            onChange={(value) => setAxes(([x, y]) => [x === value ? y : x, value as ConstellationFactor])}
          />
        </label>
        <div className="radar-constellation__seg" role="radiogroup" aria-label={text("回放范围", "Replay range")}>
          {RANGES.map((item) => (
            <button key={item.id} type="button" aria-pressed={range === item.id} onClick={() => setRange(item.id)}>
              {item.id === "7d" ? text("7 天 · 1h", "7d · 1h") : item.id === "30d" ? text("30 天 · 4h", "30d · 4h") : text("90 天 · 12h", "90d · 12h")}
            </button>
          ))}
        </div>
        <div className="radar-constellation__legend">
          {categories.map((category) => (
            <button key={category} type="button" aria-pressed={!hiddenCategories.has(category)} onClick={() => setHiddenCategories((current) => {
              const next = new Set(current);
              if (next.has(category)) next.delete(category);
              else next.add(category);
              return next;
            })}>{categoryName(category)}</button>
          ))}
          <span className="radar-constellation__ramp" title={text("颜色 = 24h 涨跌（红涨绿跌）", "Color = 24h change (red up, green down)")}><em>-10%</em><i /><em>+10%</em></span>
          <span className="radar-constellation__note">{text("大小 = 成交额 · 光晕 = 6h 名次显著变化 · Shift 拖拽比较", "Size = turnover · Glow = 6h rank move · Shift-drag to compare")}</span>
        </div>
      </header>
      <div className="radar-constellation__plot" ref={hostRef}>
        {hover && hovered && hoverKey >= 0 ? (
          <div className="radar-constellation__tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
            <strong>{model.labels[hover.index]}</strong>
            <small>{categoryName(model.categories[hover.index]!)}</small>
            <span><em>{text("综合名次", "Rank")}</em><b>#{model.rank[hoverKey]}</b></span>
            <span><em>{text("24h 涨跌", "24h")}</em><b className={model.change[hoverKey]! >= 0 ? "up" : "down"}>{model.change[hoverKey]! >= 0 ? "+" : ""}{model.change[hoverKey]!.toFixed(2)}%</b></span>
            <span><em>1h / 1d / 7d</em><b>{formatDelta(rankChangeOver(model, hover.index, hoverFrame, 1))} · {formatDelta(rankChangeOver(model, hover.index, hoverFrame, 24))} · {formatDelta(rankChangeOver(model, hover.index, hoverFrame, 168))}</b></span>
          </div>
        ) : null}
        {!webgl ? <p className="radar-constellation__notice">{text("当前设备不支持 WebGL2，已退化为平面绘制。", "WebGL2 unavailable: drawing in 2D.")}</p> : null}
      </div>
      <footer className="radar-constellation__timeline">
        <button type="button" className="radar-constellation__play" disabled={model.frames < 2} onClick={() => {
          const engine = engineRef.current;
          if (!engine) return;
          if (playing) engine.pause();
          else engine.play(speed);
        }} aria-label={playing ? text("暂停", "Pause") : text("播放", "Play")}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
        <div className="radar-constellation__seg" role="radiogroup" aria-label={text("播放速度", "Playback speed")}>
          {SPEEDS.map((value) => <button key={value} type="button" aria-pressed={speed === value} onClick={() => {
            setSpeed(value);
            engineRef.current?.setSpeed(value);
          }}>{value}×</button>)}
        </div>
        <div className="radar-constellation__time">
          <strong>{frameTime ? new Date(frameTime).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "--"}</strong>
          <small>
            {atLive ? text("实时", "Live") : text("回放", "Replay")}
            {" · "}
            {!desktop && !syntheticFrames
              ? text("回放需要桌面端本地快照", "Replay needs desktop snapshots")
              : framesLoading ? text("读取快照…", "Loading snapshots…") : text(`范围内 ${snapshotCount} 份小时快照`, `${snapshotCount} hourly snapshots in range`)}
          </small>
        </div>
        <canvas
          ref={timelineRef}
          className="radar-constellation__track"
          aria-label={text("回放时间轴：市场宽度与快照空洞", "Replay timeline: market breadth and snapshot gaps")}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            engineRef.current?.pause();
            engineRef.current?.setFrame(frameAtClientX(event.clientX), true);
          }}
          onPointerMove={(event) => {
            if (event.buttons !== 1) return;
            engineRef.current?.setFrame(frameAtClientX(event.clientX), true);
          }}
          onPointerUp={() => engineRef.current?.setFrame(frameRef.current, false)}
        />
        <button type="button" className="radar-constellation__live" disabled={atLive || model.liveIndex === null} onClick={() => {
          engineRef.current?.pause();
          if (model.liveIndex !== null) engineRef.current?.setFrame(model.liveIndex);
        }}><RadarIcon size={13} />{text("回到实时", "Live")}</button>
      </footer>
    </section>
  );
}

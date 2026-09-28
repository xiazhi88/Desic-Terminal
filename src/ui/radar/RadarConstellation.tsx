import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowLeftRight, Pause, Play } from "lucide-react";
import type { MarketRadarResearchScore, MarketRadarSnapshotFrames } from "../../types";
import type { MarketRadarRow } from "../../lib/marketRadar";
import { loadMarketRadarSnapshotFrames } from "../../lib/okx";
import { radarSectorName } from "../../lib/radarSectors";
import { buildConstellationModel, CONSTELLATION_FACTORS, rankChangeOver, type ConstellationEvent, type ConstellationFactor, type ConstellationModel } from "./constellationModel";
import { RadarConstellationEngine } from "./radarConstellationEngine";
import { buildPreviewSnapshotFrames } from "./radarPreviewFrames";
import { buildRadarSnapshotInput } from "../../lib/marketRadarSnapshot";
import { TerminalSelect } from "../TerminalSelect";
import { ConstellationSidePanel, formatFrameTime } from "./ConstellationSidePanel";
import "./radarConstellation.css";

// 市场星图（移植自 viz/prototypes/market-constellation.html）：星点 = 合约，坐标 = 两个因子在当帧的横截面位置，
// 颜色 = 24h 涨跌（红涨绿跌），大小 = 成交额，光晕 = 6 小时综合位置显著变化。
// 时间轴回放的是桌面端逐小时写入的真实快照；应用未运行的时段如实留空，不补造数据。

type Text = (zh: string, en: string) => string;

export type ConstellationAxes = [ConstellationFactor, ConstellationFactor];

type Props = {
  rows: MarketRadarRow[];
  researchScores: MarketRadarResearchScore[];
  fetchedAt: number | null;
  focusIds: Set<string> | null;
  compareIds: string[];
  axes: ConstellationAxes;
  desktop: boolean;
  chinese: boolean;
  text: Text;
  onSelect: (instId: string) => void;
  onCompareChange: (instIds: string[]) => void;
  onOpenSymbol: (instId: string) => void;
};

const RANGES = [
  { id: "7d", days: 7, stepHours: 1 },
  { id: "30d", days: 30, stepHours: 4 },
  { id: "90d", days: 90, stepHours: 12 }
] as const;
type RangeId = (typeof RANGES)[number]["id"];

/** 播放速度：每秒推进的小时数（与原型相同的 1h/s · 6h/s · 1d/s）。 */
const SPEEDS = [1, 6, 24] as const;
const AXIS_STORAGE = "desic.radar.constellation-axes.v1";
const TL = { top: 26, mid: 45, bot: 60 };
const INK = { ink: "#f4f4fa", ink2: "#b9bacb", ink3: "#7e8096", ink4: "#53556a", s1: "#0a0b12", s3: "#171824", bg: "#05060b", hair2: "rgba(200, 200, 230, 0.13)", hair3: "rgba(200, 200, 230, 0.22)", rise: "#ff4d6a", fall: "#19d99a" };
const NUM_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";
const UI_FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const syntheticFrames = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("radarFrames") === "synthetic";

export function readConstellationAxes(): ConstellationAxes {
  try {
    const [x, y] = JSON.parse(window.localStorage.getItem(AXIS_STORAGE) ?? "[]") as string[];
    const valid = (value: unknown): value is ConstellationFactor => CONSTELLATION_FACTORS.includes(value as ConstellationFactor);
    if (valid(x) && valid(y) && x !== y) return [x, y];
  } catch {
    // 读不到就用默认坐标轴。
  }
  return ["strength", "activity"];
}

export function useConstellationFactorMeta(text: Text) {
  return useMemo<Record<ConstellationFactor, { name: string; low: string; high: string }>>(() => ({
    composite: { name: text("综合评分", "Composite score"), low: text("低分", "Low"), high: text("高分", "High") },
    strength: { name: text("30 天相对强度", "30d relative strength"), low: text("弱", "Weak"), high: text("强", "Strong") },
    lowVolatility: { name: text("低波动", "Low volatility"), low: text("高波动", "Volatile"), high: text("平稳", "Calm") },
    activity: { name: text("成交活跃", "Activity"), low: text("缩量", "Quiet"), high: text("放量", "Active") },
    trendQuality: { name: text("趋势稳定性", "Trend stability"), low: text("杂乱", "Choppy"), high: text("稳定", "Stable") }
  }), [text]);
}

/** 放在雷达页工具栏里的坐标轴选择（与原型一致：X / ⇄ / Y 紧挨着「星图 / 表格」切换）。 */
export function ConstellationAxisControls({ axes, text, onChange }: { axes: ConstellationAxes; text: Text; onChange: (axes: ConstellationAxes) => void }) {
  const meta = useConstellationFactorMeta(text);
  const options = useMemo(() => CONSTELLATION_FACTORS.map((factor) => ({ value: factor, label: meta[factor].name })), [meta]);
  const update = (next: ConstellationAxes) => {
    window.localStorage.setItem(AXIS_STORAGE, JSON.stringify(next));
    onChange(next);
  };
  return <div className="rc-axes">
    <label><span>X</span><TerminalSelect value={axes[0]} options={options} ariaLabel={text("横轴因子", "X-axis factor")} className="rc-axis" onChange={(value) => update([value as ConstellationFactor, axes[1] === value ? axes[0] : axes[1]])} /></label>
    <button type="button" className="rc-swap" onClick={() => update([axes[1], axes[0]])} title={text("交换坐标轴", "Swap axes")} aria-label={text("交换坐标轴", "Swap axes")}><ArrowLeftRight size={13} /></button>
    <label><span>Y</span><TerminalSelect value={axes[1]} options={options} ariaLabel={text("纵轴因子", "Y-axis factor")} className="rc-axis" onChange={(value) => update([axes[0] === value ? axes[1] : axes[0], value as ConstellationFactor])} /></label>
  </div>;
}

function eventLabel(event: ConstellationEvent, chinese: boolean, text: Text) {
  if (event.kind === "breadth-up") return text(`普涨 ${Math.round(event.value * 100)}%`, `Broad rally ${Math.round(event.value * 100)}%`);
  if (event.kind === "breadth-down") return text(`普跌 ${Math.round((1 - event.value) * 100)}%`, `Broad selloff ${Math.round((1 - event.value) * 100)}%`);
  const name = radarSectorName(event.sector ?? "other", chinese);
  return event.kind === "sector-up" ? text(`${name} 走强`, `${name} rising`) : text(`${name} 回落`, `${name} fading`);
}

function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.closest("[role='listbox'], [role='dialog']")));
}

export function RadarConstellation({ rows, researchScores, fetchedAt, focusIds, compareIds, axes, desktop, chinese, text, onSelect, onCompareChange, onOpenSymbol }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<RadarConstellationEngine | null>(null);
  const [range, setRange] = useState<RangeId>("7d");
  const [frames, setFrames] = useState<MarketRadarSnapshotFrames | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(6);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [timelineHover, setTimelineHover] = useState<number | null>(null);
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(() => new Set());
  const [categoryFocus, setCategoryFocus] = useState<string | null>(null);
  const [showTrails, setShowTrails] = useState(true);
  const [showCentroids, setShowCentroids] = useState(true);
  const [selectedInst, setSelectedInst] = useState<string | null>(null);
  const [webgl, setWebgl] = useState(true);
  const previousRanksRef = useRef<Map<string, number>>(new Map());
  const factorMeta = useConstellationFactorMeta(text);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const compareRef = useRef({ ids: compareIds, change: onCompareChange });
  compareRef.current = { ids: compareIds, change: onCompareChange };
  const frameRef = useRef(0);
  const engineModelRef = useRef<ConstellationModel | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const engine = new RadarConstellationEngine(host, {
      onHover: (index, x, y) => setHover(index === null ? null : { index, x, y }),
      onSelect: (index) => {
        const instId = index >= 0 ? engineModelRef.current?.instIds[index] ?? null : null;
        setSelectedInst(instId);
        if (instId) onSelectRef.current(instId);
      },
      onToggleCompare: (index) => {
        const instId = engineModelRef.current?.instIds[index];
        if (!instId) return;
        const { ids, change } = compareRef.current;
        change(ids.includes(instId) ? ids.filter((id) => id !== instId) : [...ids, instId].slice(-4));
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
        compareRef.current.change(ranked);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, rows.length > 0]);

  const model = useMemo(() => buildConstellationModel(frames, rows, researchScores, fetchedAt), [fetchedAt, frames, researchScores, rows]);
  const selected = selectedInst ? model.instIds.indexOf(selectedInst) : -1;
  const compare = useMemo(() => compareIds.map((instId) => model.instIds.indexOf(instId)).filter((index) => index >= 0), [compareIds, model]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engineModelRef.current = model;
    engine.setModel(model);
  }, [model]);

  useEffect(() => {
    const [x, y] = axes;
    engineRef.current?.setAxes(x, y, {
      x: factorMeta[x].name,
      y: factorMeta[y].name,
      xLow: factorMeta[x].low,
      xHigh: factorMeta[x].high,
      yLow: factorMeta[y].low,
      yHigh: factorMeta[y].high
    });
  }, [axes, factorMeta]);

  // 坐标轴按回放区间内所有帧的 1%–99% 分位收紧（含 6% 余量，跨度至少 30），回放过程中视野不跳动。
  const domain = useMemo(() => {
    const fit = (factor: ConstellationFactor): [number, number] => {
      const values: number[] = [];
      const source = model.factors[factor];
      for (let key = 0; key < model.valid.length; key += 1) if (model.valid[key]) values.push(source[key]!);
      if (values.length < 10) return [0, 100];
      values.sort((left, right) => left - right);
      let low = values[Math.floor(values.length * 0.01)]!;
      let high = values[Math.ceil(values.length * 0.99) - 1]!;
      const pad = Math.max(3, (high - low) * 0.06);
      low -= pad;
      high += pad;
      if (high - low < 30) {
        const middle = (high + low) / 2;
        low = middle - 15;
        high = middle + 15;
      }
      return [Math.max(0, Math.floor(low)), Math.min(100, Math.ceil(high))];
    };
    return { x: fit(axes[0]), y: fit(axes[1]) };
  }, [axes, model]);

  useEffect(() => {
    engineRef.current?.setDomain(domain.x, domain.y);
  }, [domain]);

  const sectorCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const f = Math.max(0, model.frames - 1);
    for (let index = 0; index < model.count; index += 1) {
      if (!model.valid[f * model.count + index]) continue;
      counts.set(model.categories[index]!, (counts.get(model.categories[index]!) ?? 0) + 1);
    }
    return model.sectors.filter((sector) => counts.has(sector)).map((sector) => [sector, counts.get(sector)!] as const);
  }, [model]);

  useEffect(() => {
    engineRef.current?.setCategoryNames(Object.fromEntries(model.sectors.map((sector) => [sector, radarSectorName(sector, chinese)])));
  }, [chinese, model.sectors]);
  useEffect(() => engineRef.current?.setHiddenCategories(hiddenCategories), [hiddenCategories]);
  useEffect(() => engineRef.current?.setCategoryFocus(categoryFocus), [categoryFocus]);
  useEffect(() => engineRef.current?.setLayers(showTrails, showCentroids), [showCentroids, showTrails]);
  useEffect(() => engineRef.current?.setSpeed(speed / (frames?.stepHours ?? rangeConfig.stepHours)), [frames?.stepHours, rangeConfig.stepHours, speed]);

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
    engineRef.current?.setSelection(selected, compare);
  }, [compare, selected]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedAt]);

  const togglePlay = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (playing) engine.pause();
    else engine.play(speed / (frames?.stepHours ?? rangeConfig.stepHours));
  }, [frames?.stepHours, playing, rangeConfig.stepHours, speed]);
  const goLive = useCallback(() => {
    engineRef.current?.pause();
    if (model.liveIndex !== null) engineRef.current?.setFrame(model.liveIndex);
    else if (model.frames > 0) engineRef.current?.setFrame(model.frames - 1);
  }, [model.frames, model.liveIndex]);

  // 键盘：空格 播放 / 暂停，End 回到实时，Esc 依次清除比较、选中、板块聚焦。
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!hostRef.current?.isConnected || hostRef.current.getBoundingClientRect().width === 0) return;
      if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "End") {
        event.preventDefault();
        goLive();
      } else if (event.key === "Escape") {
        if (compareRef.current.ids.length > 0) compareRef.current.change([]);
        else if (selectedInst) setSelectedInst(null);
        else if (categoryFocus) setCategoryFocus(null);
        else return;
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [categoryFocus, goLive, selectedInst, togglePlay]);

  const frameIndex = Math.max(0, Math.min(model.frames - 1, Math.round(frame)));
  const frameTime = model.frameTimes[frameIndex];
  const atLive = model.liveIndex !== null && frameIndex === model.liveIndex;
  const snapshotCount = frames?.snapshotsInRange ?? 0;
  const replayStatus = !desktop && !syntheticFrames
    ? text("回放需要桌面端本地快照", "Replay needs desktop snapshots")
    : framesLoading ? text("读取快照…", "Loading snapshots…") : text(`范围内 ${snapshotCount} 份快照`, `${snapshotCount} snapshots in range`);

  // —— 时间轴：宽度面积（>50% 红 / <50% 绿）、日期刻度、事件、快照空洞斜线、未播放区遮罩、播放头 ——
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
    const width = rect.width;
    const xOf = (time: number) => ((time - start) / (end - start)) * width;
    let cursor = 0;
    for (let x = 0; x < Math.floor(width); x += 1) {
      const time = start + ((x + 0.5) / width) * (end - start);
      while (cursor < times.length - 1 && times[cursor + 1]! <= time) cursor += 1;
      // 空洞内不画宽度（由下面的斜线占位）。
      if (model.gapAfter[cursor] && time > times[cursor]!) continue;
      const value = model.breadth[cursor]! - 0.5;
      const y = TL.mid - value * 44;
      context.fillStyle = value >= 0 ? INK.rise : INK.fall;
      context.globalAlpha = 0.42;
      context.fillRect(x, Math.min(y, TL.mid), 1, Math.max(0.6, Math.abs(y - TL.mid)));
    }
    context.globalAlpha = 1;
    // 快照空洞：斜线填充，表示应用未运行、没有快照。
    context.strokeStyle = "rgba(200, 200, 230, 0.2)";
    context.lineWidth = 1;
    times.forEach((time, index) => {
      if (!model.gapAfter[index]) return;
      const left = xOf(time) + 1;
      const right = xOf(times[index + 1]!) - 1;
      if (right - left < 2) return;
      context.save();
      context.beginPath();
      context.rect(left, TL.top, right - left, TL.bot - TL.top);
      context.clip();
      for (let x = left - 40; x < right; x += 5) {
        context.beginPath();
        context.moveTo(x, TL.bot);
        context.lineTo(x + (TL.bot - TL.top), TL.top);
        context.stroke();
      }
      context.restore();
    });
    context.fillStyle = INK.hair3;
    context.fillRect(0, TL.mid, width, 1);
    // 日期刻度：每天一个短刻度，按范围每 1 / 7 / 14 天标注日期。
    const days = (end - start) / 86_400_000;
    const labelEvery = days <= 8 ? 1 : days <= 31 ? 7 : 14;
    const firstDay = new Date(start);
    firstDay.setHours(0, 0, 0, 0);
    context.font = `10px ${NUM_FONT}`;
    context.textBaseline = "top";
    for (let day = 0; firstDay.getTime() + day * 86_400_000 <= end; day += 1) {
      const time = firstDay.getTime() + day * 86_400_000;
      if (time < start) continue;
      const x = Math.round(xOf(time)) + 0.5;
      const major = day % labelEvery === 0;
      context.fillStyle = INK.hair2;
      context.fillRect(x, TL.bot, 1, major ? 5 : 2);
      if (major && x < width - 34) {
        const date = new Date(time);
        context.fillStyle = INK.ink4;
        context.textAlign = x < 20 ? "left" : "center";
        context.fillText(`${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`, x, TL.bot + 2);
      }
    }
    // 事件：从数据检测到的板块轮动 / 宽度极值，两行避让。
    context.font = `10.5px ${UI_FONT}`;
    const lanes: Array<Array<[number, number]>> = [[], []];
    for (const event of model.events) {
      const x = xOf(event.time);
      const label = eventLabel(event, chinese, text);
      const labelWidth = context.measureText(label).width;
      // 靠近右端的事件把标签放到标记左侧，避免被裁掉。
      const flip = x + 6 + labelWidth > width - 4;
      const bx = flip ? x - labelWidth - 9 : x - 3;
      const lane = lanes.findIndex((occupied) => !occupied.some(([a, b]) => bx < b + 8 && bx + labelWidth + 10 > a));
      if (lane >= 0) lanes[lane]!.push([bx, bx + labelWidth + 10]);
      const y = lane === 1 ? 12 : 1;
      context.fillStyle = INK.ink4;
      context.fillRect(Math.round(x), y + 10, 1, TL.mid - y - 10);
      context.fillStyle = INK.ink2;
      context.beginPath();
      context.moveTo(x, y + 2);
      context.lineTo(x + 3, y + 5);
      context.lineTo(x, y + 8);
      context.lineTo(x - 3, y + 5);
      context.closePath();
      context.fill();
      if (lane < 0) continue;
      context.fillStyle = INK.ink3;
      context.textAlign = flip ? "right" : "left";
      context.textBaseline = "top";
      context.fillText(label, flip ? x - 6 : x + 6, y);
    }
    const current = frameRef.current;
    const f0 = Math.floor(current);
    const t0 = times[f0] ?? start;
    const t1 = times[Math.min(times.length - 1, f0 + 1)] ?? t0;
    const playhead = xOf(t0 + (t1 - t0) * (current - f0));
    if (playhead < width - 1) {
      context.fillStyle = INK.s1;
      context.globalAlpha = 0.6;
      context.fillRect(playhead, TL.top, width - playhead, TL.bot - TL.top);
      context.globalAlpha = 1;
    }
    if (timelineHover !== null && times[timelineHover] !== undefined) {
      const hx = Math.round(xOf(times[timelineHover]!)) + 0.5;
      context.fillStyle = INK.ink4;
      context.fillRect(hx, TL.top, 1, TL.bot - TL.top);
      const label = `${formatFrameTime(times[timelineHover])}  ${text("宽度", "Breadth")} ${(model.breadth[timelineHover]! * 100).toFixed(0)}%`;
      context.font = `10px ${NUM_FONT}`;
      const labelWidth = context.measureText(label).width + 10;
      const bx = Math.min(Math.max(0, hx - labelWidth / 2), width - labelWidth);
      context.fillStyle = INK.s3;
      context.fillRect(bx, TL.bot - 1, labelWidth, 12);
      context.fillStyle = INK.ink2;
      context.textAlign = "left";
      context.textBaseline = "top";
      context.fillText(label, bx + 5, TL.bot);
    }
    const x = Math.round(playhead) + 0.5;
    context.fillStyle = INK.ink;
    context.fillRect(x - 0.5, TL.top - 2, 1.5, TL.bot - TL.top + 4);
    context.beginPath();
    context.arc(x, TL.mid, 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = INK.bg;
    context.beginPath();
    context.arc(x, TL.mid, 1.6, 0, Math.PI * 2);
    context.fill();
  }, [chinese, model, text, timelineHover]);

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
    if (!canvas || times.length < 2) return Math.max(0, times.length - 1);
    const rect = canvas.getBoundingClientRect();
    const time = times[0]! + ((clientX - rect.left) / rect.width) * (times.at(-1)! - times[0]!);
    let index = 0;
    while (index < times.length - 2 && times[index + 1]! <= time) index += 1;
    const span = times[index + 1]! - times[index]!;
    return Math.max(0, Math.min(times.length - 1, index + (span > 0 ? (time - times[index]!) / span : 0)));
  };

  const hoverKey = hover ? frameIndex * model.count + hover.index : -1;
  const hoverValid = hover !== null && hoverKey >= 0 && model.valid[hoverKey] === 1;
  const hoverDelta = hover && hoverValid ? rankChangeOver(model, hover.index, frameIndex, 6) : null;
  const focusCount = useMemo(() => {
    if (!focusIds) return null;
    let count = 0;
    model.instIds.forEach((instId, index) => {
      if (focusIds.has(instId) && model.valid[frameIndex * model.count + index]) count += 1;
    });
    return count;
  }, [focusIds, frameIndex, model]);

  return (
    <section className="radar-constellation rc" aria-label={text("市场星图", "Market constellation")}>
      <div className="rc-map">
        <div className="rc-plot radar-constellation__plot">
          <div className="rc-layers" ref={hostRef} />
          <div className={clsx("rc-hud", !atLive && "is-replay")}>
            <div className="rc-tc">{formatFrameTime(frameTime)}</div>
            <div className="rc-st">
              {atLive
                ? <><span className="rc-live" />{text("实时 · 每小时快照 + 实时行情", "Live · hourly snapshots + live quotes")}</>
                : <>{text("回放", "Replay")} · {formatFrameTime(frameTime, true)}</>}
            </div>
          </div>
          {hover && hoverValid ? (
            <div className="rc-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
              <div className="rc-t1"><b>{model.labels[hover.index]}</b><span>{radarSectorName(model.categories[hover.index]!, chinese)}</span></div>
              <dl>
                <dt>{text("综合", "Composite")}</dt><dd>#{model.rank[hoverKey]} · {Math.round(model.compositeRaw[hoverKey]!)}</dd>
                <dt>{text("24h 涨跌", "24h")}</dt><dd className={model.change[hoverKey]! >= 0 ? "is-rise" : "is-fall"}>{model.change[hoverKey]! >= 0 ? "+" : ""}{model.change[hoverKey]!.toFixed(2)}%</dd>
                <dt>{factorMeta[axes[0]].name}</dt><dd>{model.factors[axes[0]][hoverKey]!.toFixed(0)}</dd>
                <dt>{factorMeta[axes[1]].name}</dt><dd>{model.factors[axes[1]][hoverKey]!.toFixed(0)}</dd>
                <dt>{text("6h 名次", "6h rank")}</dt><dd>{hoverDelta === null ? "--" : hoverDelta === 0 ? text("持平", "Flat") : `${hoverDelta > 0 ? "▲" : "▼"} ${Math.abs(hoverDelta)}`}</dd>
              </dl>
            </div>
          ) : null}
          {focusCount === 0 ? <div className="rc-empty">{text("该时刻没有符合当前标签 / 搜索 / 筛选的合约", "No markets match the current view at this moment")}</div> : null}
          {!webgl ? <p className="rc-notice">{text("当前设备不支持 WebGL2，已退化为平面绘制。", "WebGL2 unavailable: drawing in 2D.")}</p> : null}
        </div>
        <div className="rc-legend">
          {sectorCounts.map(([sector, count]) => (
            <button key={sector} type="button" className="rc-cat" aria-pressed={!hiddenCategories.has(sector)} onClick={() => setHiddenCategories((current) => {
              const next = new Set(current);
              if (next.has(sector)) next.delete(sector);
              else next.add(sector);
              return next;
            })}>{radarSectorName(sector, chinese)}<i>{count}</i></button>
          ))}
          <span className="rc-spacer" />
          <span className="rc-scale" title={text("颜色 = 24h 涨跌（红涨绿跌）", "Color = 24h change (red up, green down)")}><em>-10%</em><i className="rc-ramp" /><em>+10%</em><span>{text("24h 涨跌", "24h change")}</span></span>
          <span className="rc-scale rc-sizekey"><span>{text("成交额", "Turnover")}</span><b style={{ width: 3, height: 3 }} /><b style={{ width: 6, height: 6 }} /><b style={{ width: 10, height: 10 }} /></span>
          <span className="rc-scale rc-glowkey-wrap"><i className="rc-glowkey" /><span>{text("光晕 = 6h 显著变化", "Glow = 6h shift")}</span></span>
          <button type="button" className="rc-btn rc-tg" aria-pressed={showTrails} onClick={() => setShowTrails((value) => !value)}>{text("彗尾", "Trails")}</button>
          <button type="button" className="rc-btn rc-tg" aria-pressed={showCentroids} onClick={() => setShowCentroids((value) => !value)}>{text("板块质心", "Centroids")}</button>
        </div>
      </div>
      <aside className="rc-side" aria-live="polite">
        {model.frames > 0 ? <ConstellationSidePanel
          model={model}
          frame={frameIndex}
          rows={rows}
          chinese={chinese}
          text={text}
          selected={selected}
          compare={compare}
          categoryFocus={categoryFocus}
          factorName={(factor) => factorMeta[factor].name}
          onSelect={(index) => {
            const instId = model.instIds[index];
            if (!instId) return;
            setSelectedInst(instId);
            onSelect(instId);
          }}
          onCategoryFocus={setCategoryFocus}
          onAddCompare={(index) => {
            const instId = model.instIds[index];
            if (instId && !compareIds.includes(instId)) onCompareChange([...compareIds, instId].slice(-4));
          }}
          onRemoveCompare={(index) => onCompareChange(compareIds.filter((instId) => instId !== model.instIds[index]))}
          onClearCompare={() => onCompareChange([])}
          onOpenSymbol={onOpenSymbol}
        /> : <p className="rc-foot rc-sec">{text("等待全市场快照…", "Waiting for the market snapshot…")}</p>}
      </aside>
      <footer className="rc-tl">
        <div className="rc-tl-ctrl">
          <button type="button" className="rc-play" disabled={model.frames < 2} onClick={togglePlay} aria-label={playing ? text("暂停", "Pause") : text("播放", "Play")} title={text("播放 / 暂停（空格）", "Play / pause (Space)")}>{playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}</button>
          <div className="rc-tl-time radar-constellation__time">
            <strong>{formatFrameTime(frameTime, true)}</strong>
            <small>{atLive ? text("实时", "Live") : text("回放", "Replay")} · {replayStatus}</small>
          </div>
          <div className="rc-seg" role="group" aria-label={text("播放速度", "Playback speed")}>
            {SPEEDS.map((value) => <button key={value} type="button" aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value === 24 ? "1d/s" : `${value}h/s`}</button>)}
          </div>
        </div>
        <div className="rc-tl-track">
          <canvas
            ref={timelineRef}
            aria-label={text("回放时间轴：市场宽度、事件与快照空洞", "Replay timeline: breadth, events and snapshot gaps")}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              engineRef.current?.pause();
              engineRef.current?.setFrame(frameAtClientX(event.clientX), true);
            }}
            onPointerMove={(event) => {
              if (event.buttons === 1) engineRef.current?.setFrame(frameAtClientX(event.clientX), true);
              else setTimelineHover(Math.round(frameAtClientX(event.clientX)));
            }}
            onPointerLeave={() => setTimelineHover(null)}
            onPointerUp={() => engineRef.current?.setFrame(frameRef.current, false)}
          />
        </div>
        <div className="rc-tl-right">
          <button type="button" className="rc-btn" disabled={atLive || model.frames === 0} onClick={goLive}>{text("回到实时", "Back to live")} <kbd>End</kbd></button>
          <div className="rc-seg is-small" role="group" aria-label={text("回放范围", "Replay range")}>
            {RANGES.map((item) => <button key={item.id} type="button" aria-pressed={range === item.id} onClick={() => setRange(item.id)}>{item.id === "7d" ? text("7 天", "7d") : item.id === "30d" ? text("30 天", "30d") : text("90 天", "90d")}</button>)}
          </div>
        </div>
      </footer>
    </section>
  );
}

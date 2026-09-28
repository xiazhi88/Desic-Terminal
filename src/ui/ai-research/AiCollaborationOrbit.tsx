import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Activity, Brain, Newspaper, Scale, ShieldCheck, Swords, Users } from "lucide-react";
import { agentUsageTokens, deriveOrbitExperts, type OrbitExpert } from "../../lib/aiEvidenceLedger";
import { prefersReducedMotion } from "../../lib/springMotion";
import type { AiUiMessage } from "../AiMessageProcess";
import { alpha, EVB_COLORS } from "./evidenceViz";
import { useNowInterval } from "./useNowInterval";

type UiText = (zh: string, en: string) => string;

// 协作轨道：结构与动效复刻证据天平原型的轨道视图。主 Agent 居中（唯一决策者），被咨询的专家落在
// 椭圆轨道上；连线、请求粒子、结论回传与执行时间线全部由 agentStart / agentDone 与
// consult_experts 结果里的 mode 驱动，不补造任何状态或 Token。

const ANGLES = [222, 318, 138, 42, 270, 90, 180, 0];
const GANTT_HEIGHT = 150;
const REQUEST_MS = 900;
const RETURN_MS = 1000;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const UI_FONT = "ui-sans-serif, system-ui, -apple-system, sans-serif";

type Layout = { w: number; h: number; cx: number; cy: number; rx: number; ry: number };
type Point = [number, number];

function bez(p0: Point, p1: Point, p2: Point, s: number): Point {
  const u = 1 - s;
  return [u * u * p0[0] + 2 * u * s * p1[0] + s * s * p2[0], u * u * p0[1] + 2 * u * s * p1[1] + s * s * p2[1]];
}

function ctrl(a: Point, b: Point): Point {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  return [mx - (b[1] - a[1]) * 0.1, my + (b[0] - a[0]) * 0.1];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function expertIcon(expert: OrbitExpert) {
  const key = `${expert.role ?? ""} ${expert.title}`.toLowerCase();
  if (/risk|风险|账户|account/.test(key)) return <ShieldCheck size={20} strokeWidth={1.6} />;
  if (/red|反方|审查|devil|critic|review/.test(key)) return <Swords size={20} strokeWidth={1.6} />;
  if (/intel|情报|资金|news|flow|smart/.test(key)) return <Newspaper size={20} strokeWidth={1.6} />;
  if (/market|市场|结构|technical|技术/.test(key)) return <Activity size={20} strokeWidth={1.6} />;
  if (/judge|裁决|decision/.test(key)) return <Scale size={20} strokeWidth={1.6} />;
  return <Users size={20} strokeWidth={1.6} />;
}

function formatTokens(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(Math.round(value));
}

type Transition = { requestAt: number | null; returnAt: number | null; lastStatus: string };

export function AiCollaborationOrbit({ message, running, uiText }: { message: AiUiMessage; running: boolean; uiText: UiText }) {
  // 专家列表只随 agent 状态变化；流式正文不改变它，避免轨道画布逐 token 重画。
  const expertSignature = (message.agents ?? []).map((agent) => `${agent.id}:${agent.status}:${agent.endedAt ?? ""}:${agent.tools?.length ?? 0}`).join("|")
    + `|${message.tools.filter((tool) => tool.name === "consult_experts" || tool.name === "follow_up").map((tool) => `${tool.id}:${tool.status}`).join(",")}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const experts = useMemo(() => deriveOrbitExperts(message), [expertSignature]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const transitions = useRef(new Map<string, Transition>());
  const active = experts.filter((expert) => expert.status === "running" || expert.status === "queued");
  const now = useNowInterval(running || active.length > 0);

  // 记录每位专家的状态切换时刻：刚开始运行 → 请求粒子；刚返回 → 结论包沿连线回传。
  const mountedAt = useRef(performance.now());
  for (const expert of experts) {
    const entry = transitions.current.get(expert.id);
    if (!entry) {
      // 首次看到时已完成 / 已运行的专家不回放动画，只呈现当前状态。
      transitions.current.set(expert.id, { requestAt: null, returnAt: null, lastStatus: expert.status });
      continue;
    }
    if (entry.lastStatus === expert.status) continue;
    const at = performance.now();
    if (expert.status === "running" && at - mountedAt.current > 200) entry.requestAt = at;
    if ((expert.status === "done" || expert.status === "failed") && at - mountedAt.current > 200) entry.returnAt = at;
    entry.lastStatus = expert.status;
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const top = 44;
      const usable = Math.max(120, rect.height - GANTT_HEIGHT - top);
      setLayout({ w: rect.width, h: rect.height, cx: rect.width / 2, cy: top + usable / 2, rx: Math.min(rect.width * 0.33, 215), ry: Math.min(usable * 0.4, 168) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const position = (index: number): Point => {
    if (!layout) return [0, 0];
    const angle = (ANGLES[index % ANGLES.length]! * Math.PI) / 180;
    return [layout.cx + layout.rx * Math.cos(angle), layout.cy + layout.ry * Math.sin(angle)];
  };

  const origin = message.startedAt ?? message.createdAt ?? Math.min(...experts.map((expert) => expert.startedAt ?? Infinity));
  const finishedAt = message.completedAt ?? (running ? null : Math.max(...experts.map((expert) => expert.endedAt ?? 0), origin));
  const mainTokens = message.usageIsSessionCumulative ? null : agentUsageTokens({ usage: message.usage });
  const expertTokens = experts.reduce<number | null>((sum, expert) => (expert.tokens === null ? sum : (sum ?? 0) + expert.tokens), null);
  const totalTokens = mainTokens === null && expertTokens === null ? null : (mainTokens ?? 0) + (expertTokens ?? 0);

  const currentTool = (expert: OrbitExpert) => {
    const agent = message.agents?.find((item) => item.id === expert.id);
    const tool = agent?.tools?.slice().reverse().find((item) => item.status === "running" || item.status === "pending");
    return tool?.name ?? null;
  };

  const phase = (() => {
    const runningExperts = experts.filter((expert) => expert.status === "running");
    if (runningExperts.length > 1) return { label: uiText(`并行 ×${runningExperts.length} · ${runningExperts.map((expert) => expert.title).join(" / ")}`, `Parallel ×${runningExperts.length} · ${runningExperts.map((expert) => expert.title).join(" / ")}`), live: true };
    if (runningExperts.length === 1) return { label: uiText(`${runningExperts[0]!.mode === "parallel" ? "并行" : "串行"} · ${runningExperts[0]!.title}`, `${runningExperts[0]!.mode} · ${runningExperts[0]!.title}`), live: true };
    if (running) return { label: experts.length > 0 ? uiText("主 Agent 汇总", "Main Agent synthesizing") : uiText("主 Agent 直接读取", "Main Agent reading directly"), live: true };
    if (experts.length === 0) return { label: uiText("本回合未咨询专家", "No experts consulted this turn"), live: false };
    return { label: uiText(`完成 · 1 决策者 · ${experts.length} 专家`, `Done · 1 decider · ${experts.length} experts`), live: false };
  })();

  // 画布：轨道、连线、方式标签、请求粒子、回传结论包与执行时间线。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(layout.w * dpr);
    canvas.height = Math.round(layout.h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = prefersReducedMotion();
    let frame = 0;
    const draw = () => {
      const t = performance.now();
      const wall = Date.now();
      let animating = false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, layout.w, layout.h);
      ctx.setLineDash([2, 5]);
      ctx.strokeStyle = alpha(EVB_COLORS.ink, 0.1);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(layout.cx, layout.cy, layout.rx, layout.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const main: Point = [layout.cx, layout.cy];
      experts.forEach((expert, index) => {
        const end = position(index);
        const control = ctrl(main, end);
        const isActive = expert.status === "running" || expert.status === "queued";
        const done = expert.status === "done";
        ctx.strokeStyle = isActive ? alpha(EVB_COLORS.ai, 0.5) : done ? alpha(EVB_COLORS.ink, 0.16) : expert.status === "failed" ? alpha(EVB_COLORS.rise, 0.3) : alpha(EVB_COLORS.ink, 0.07);
        ctx.lineWidth = isActive ? 1.2 : 1;
        if (expert.status === "running") {
          ctx.setLineDash([3, 5]);
          ctx.lineDashOffset = reduced ? 0 : -(t / 1000) * 14;
          if (!reduced) animating = true;
        }
        ctx.beginPath();
        ctx.moveTo(main[0], main[1]);
        ctx.quadraticCurveTo(control[0], control[1], end[0], end[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        const labelPoint = bez(main, control, end, 0.46);
        const mode = expert.mode === "parallel" ? uiText("并行", "parallel") : uiText("串行", "serial");
        ctx.font = `10.5px ${MONO}`;
        ctx.textAlign = "center";
        const labelWidth = ctx.measureText(mode).width + 10;
        ctx.fillStyle = EVB_COLORS.s1;
        ctx.fillRect(labelPoint[0] - labelWidth / 2, labelPoint[1] - 8, labelWidth, 16);
        ctx.fillStyle = isActive ? EVB_COLORS.aiHi : done ? EVB_COLORS.ink3 : EVB_COLORS.ink4;
        ctx.fillText(mode, labelPoint[0], labelPoint[1] + 3.5);

        const transition = transitions.current.get(expert.id);
        if (!reduced && transition?.requestAt) {
          const p = (t - transition.requestAt) / REQUEST_MS;
          if (p < 1) {
            animating = true;
            for (let i = 0; i < 7; i += 1) {
              const s = Math.max(0, Math.min(1, p * 1.5 - i * 0.07));
              if (s <= 0 || s >= 1) continue;
              const q = bez(main, control, end, s);
              ctx.fillStyle = alpha(EVB_COLORS.aiHi, 0.9 - i * 0.1);
              ctx.beginPath();
              ctx.arc(q[0], q[1], 2.2 - i * 0.18, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        if (!reduced && transition?.returnAt) {
          const p = (t - transition.returnAt) / RETURN_MS;
          if (p < 1) {
            animating = true;
            const eased = 1 - Math.pow(1 - p, 3);
            const q = bez(end, control, main, eased * 0.8);
            const label = expert.status === "failed" ? uiText("失败", "Failed") : uiText("结论", "Findings");
            ctx.font = `10.5px ${UI_FONT}`;
            const width = ctx.measureText(label).width + 16;
            ctx.fillStyle = EVB_COLORS.s2;
            ctx.strokeStyle = alpha(EVB_COLORS.ai, 0.8);
            ctx.lineWidth = 1;
            roundRect(ctx, q[0] - width / 2, q[1] - 10, width, 20, 4);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = EVB_COLORS.ink;
            ctx.textAlign = "center";
            ctx.fillText(label, q[0], q[1] + 3.5);
          } else if (p < 1.1 && mainRef.current && !mainRef.current.classList.contains("is-receiving")) {
            const node = mainRef.current;
            node.classList.add("is-receiving");
            window.setTimeout(() => node.classList.remove("is-receiving"), 820);
          }
        }
      });
      drawGantt(ctx, wall);
      if (animating) frame = requestAnimationFrame(draw);
    };

    const drawGantt = (context: CanvasRenderingContext2D, wall: number) => {
      if (!Number.isFinite(origin)) return;
      const rowH = 19;
      const rows: Array<{ name: string; intervals: Array<[number, number | null]>; main?: boolean }> = [
        { name: uiText("主 Agent", "Main Agent"), intervals: [[origin, finishedAt]], main: true },
        ...experts.map((expert) => ({
          name: expert.title,
          intervals: expert.startedAt ? [[expert.startedAt, expert.endedAt ?? (expert.status === "running" || expert.status === "queued" ? null : expert.startedAt)] as [number, number | null]] : []
        }))
      ];
      const visible = rows.slice(0, Math.max(1, Math.floor((GANTT_HEIGHT - 34) / rowH)));
      const top = layout.h - GANTT_HEIGHT + 12;
      const x0 = 92;
      const x1 = layout.w - 18;
      const end = Math.max(finishedAt ?? wall, origin + 1000);
      const span = end - origin;
      const X = (value: number) => x0 + ((value - origin) / span) * (x1 - x0);
      context.fillStyle = alpha(EVB_COLORS.ink, 0.06);
      context.fillRect(16, top - 12, layout.w - 32, 1);
      context.font = `10px ${MONO}`;
      context.textAlign = "left";
      context.fillStyle = EVB_COLORS.ink4;
      context.fillText(uiText("执行时间线", "Execution timeline"), 16, top + 4);
      context.font = `11px ${UI_FONT}`;
      visible.forEach((row, index) => {
        const y = top + 16 + index * rowH;
        context.fillStyle = EVB_COLORS.ink3;
        context.textAlign = "left";
        const name = row.name.length > 7 ? `${row.name.slice(0, 7)}…` : row.name;
        context.fillText(name, 16, y + 9);
        context.fillStyle = alpha(EVB_COLORS.ink, 0.05);
        context.fillRect(x0, y + 5, x1 - x0, 1);
        for (const [start, stop] of row.intervals) {
          const live = stop === null;
          const e = stop ?? wall;
          context.fillStyle = row.main ? alpha(EVB_COLORS.ai, 0.28) : live ? alpha(EVB_COLORS.ai, 0.75) : alpha(EVB_COLORS.ink2, 0.35);
          roundRect(context, X(start), y + 1, Math.max(2, X(Math.min(e, end)) - X(start)), 9, 2);
          context.fill();
        }
      });
      // 并行括注：同一批并行启动的专家用一道方括号括起来。
      const parallelRows = experts.map((expert, index) => ({ expert, index })).filter(({ expert, index }) => expert.mode === "parallel" && expert.startedAt && index + 1 < visible.length);
      if (parallelRows.length >= 2) {
        const first = parallelRows[0]!;
        const last = parallelRows.at(-1)!;
        const bx = X(Math.min(...parallelRows.map(({ expert }) => expert.startedAt!))) - 5;
        const y0 = top + 16 + (first.index + 1) * rowH + 2;
        const y1 = top + 16 + (last.index + 1) * rowH + rowH - 6;
        context.strokeStyle = alpha(EVB_COLORS.ink, 0.25);
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(bx, y0);
        context.lineTo(bx - 3, y0);
        context.lineTo(bx - 3, y1);
        context.lineTo(bx, y1);
        context.stroke();
      }
      const seconds = span / 1000;
      const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((candidate) => seconds / candidate <= 6) ?? 1200;
      context.fillStyle = EVB_COLORS.ink4;
      context.font = `10px ${MONO}`;
      context.textAlign = "center";
      for (let s = 0; s <= seconds + 0.001; s += step) {
        context.fillText(s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}` : `${s}s`, X(origin + s * 1000), top + 16 + visible.length * rowH + 12);
      }
      if (finishedAt === null) {
        const cursor = X(Math.min(wall, end));
        context.fillStyle = alpha(EVB_COLORS.ai, 0.9);
        context.fillRect(cursor - 0.5, top + 10, 1, visible.length * rowH + 6);
      }
    };

    draw();
    return () => cancelAnimationFrame(frame);
    // now 每秒推进一次，让运行中的时间线与虚线流动持续刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, experts, now, running, finishedAt, origin, uiText]);

  return <div className="evb-orbit" ref={hostRef}>
    <canvas ref={canvasRef} />
    <div className="evb-orbit-hud">
      <span className={clsx("evb-phase", phase.live && "is-live")}>{phase.live ? <span className="evb-live is-ai" /> : null}{phase.label}</span>
      <span className="evb-orbit-tot">{uiText("总 Token", "Total tokens")} <b>{totalTokens === null ? "--" : formatTokens(totalTokens)}</b></span>
    </div>
    {layout ? <>
      <div className="evb-onode is-main" ref={mainRef} style={{ left: layout.cx, top: layout.cy }}>
        <div className="evb-onode-disc"><Brain size={28} strokeWidth={1.5} /></div>
        <b>{uiText("主 Agent", "Main Agent")}</b>
        <span className="evb-micro">{uiText("唯一决策者", "Sole decider")}</span>
        <span className="evb-onode-tok">{mainTokens === null ? "" : `${formatTokens(mainTokens)} tok`}</span>
      </div>
      {experts.map((expert, index) => {
        const [x, y] = position(index);
        const top = Math.sin((ANGLES[index % ANGLES.length]! * Math.PI) / 180) < 0;
        const isActive = expert.status === "running" || expert.status === "queued";
        const tool = expert.status === "running" ? currentTool(expert) : null;
        const status = expert.status === "queued" ? uiText("接收任务…", "Receiving task…")
          : expert.status === "running" ? `${uiText("思考中", "Thinking")} · ${tool ?? uiText("整理结论", "drafting")}`
            : expert.status === "done" ? `${uiText("已返回", "Returned")}${expert.followUps > 0 ? uiText(` · 追问 ${expert.followUps}`, ` · ${expert.followUps} follow-up`) : ""}`
              : expert.status === "failed" ? uiText("失败", "Failed") : uiText("已取消", "Cancelled");
        return <div
          key={expert.id}
          className={clsx("evb-onode", top && "is-top", isActive && "is-active", expert.status === "running" && "is-thinking", expert.status === "done" && "is-done", expert.status === "failed" && "is-failed")}
          style={{ left: x, top: y }}
        >
          <div className="evb-onode-disc">{expertIcon(expert)}</div>
          <b>{expert.title}</b>
          <span className="evb-onode-status" title={status}>{status}</span>
          <span className="evb-onode-tok">{expert.tokens === null ? uiText("Token 未上报", "tokens n/a") : `${formatTokens(expert.tokens)} tok`}</span>
        </div>;
      })}
    </> : null}
  </div>;
}

import { useMemo } from "react";
import clsx from "clsx";
import { deriveOrbitExperts, type OrbitExpert } from "../../lib/aiEvidenceLedger";
import { prefersReducedMotion } from "../../lib/springMotion";
import type { AiUiMessage } from "../AiMessageProcess";
import { useNowInterval } from "./useNowInterval";

type UiText = (zh: string, en: string) => string;

const CENTER = { x: 180, y: 128 };
const ORBIT = { rx: 132, ry: 82 };

// 协作轨道：主 Agent 居中（唯一决策者），被咨询的专家落在轨道上。
// 数据只来自 agentStart / agentDone 与 consult_experts 结果里的 mode，不补造任何状态。
export function AiCollaborationOrbit({ message, uiText }: { message: AiUiMessage; uiText: UiText }) {
  const experts = useMemo(() => deriveOrbitExperts(message), [message]);
  const running = experts.some((expert) => expert.status === "running" || expert.status === "queued");
  const now = useNowInterval(running);
  const animate = !prefersReducedMotion();
  const nodes = experts.map((expert, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(experts.length, 1)) * Math.PI * 2 + (experts.length === 2 ? Math.PI / 2 : 0);
    const x = CENTER.x + ORBIT.rx * Math.cos(angle);
    const y = CENTER.y + ORBIT.ry * Math.sin(angle);
    const bend = 18 * (index % 2 === 0 ? 1 : -1);
    const midX = (CENTER.x + x) / 2 - (y - CENTER.y) * (bend / 100);
    const midY = (CENTER.y + y) / 2 + (x - CENTER.x) * (bend / 100);
    return { expert, x, y, path: `M ${CENTER.x} ${CENTER.y} Q ${midX} ${midY} ${x} ${y}` };
  });
  const parallel = experts.filter((expert) => expert.mode === "parallel").length;
  const totalTokens = experts.reduce<number | null>((sum, expert) => (expert.tokens === null ? sum : (sum ?? 0) + expert.tokens), null);

  return <div className="ai-orbit">
    <p className="ai-orbit-summary">
      <span>{uiText(`${experts.length} 位专家`, `${experts.length} experts`)}{parallel > 0 ? uiText(` · 并行 ${parallel}`, ` · ${parallel} parallel`) : ""}{experts.length - parallel > 0 ? uiText(` · 串行 ${experts.length - parallel}`, ` · ${experts.length - parallel} serial`) : ""}</span>
      <small>{totalTokens === null ? uiText("专家 Token 未上报", "Expert tokens not reported") : uiText(`专家 Token ${formatTokens(totalTokens)}`, `Expert tokens ${formatTokens(totalTokens)}`)}</small>
    </p>
    <svg className="ai-orbit-map" viewBox="0 0 360 246" role="img" aria-label={uiText("主 Agent 与专家协作轨道", "Main Agent and expert collaboration orbit")}>
      <ellipse className="ai-orbit-ring" cx={CENTER.x} cy={CENTER.y} rx={ORBIT.rx} ry={ORBIT.ry} />
      {nodes.map(({ expert, path }) => <g key={`edge:${expert.id}`} className={clsx("ai-orbit-edge", `is-${expert.status}`)}>
        <path id={edgeId(message.id, expert.id)} d={path} />
        {animate && (expert.status === "running" || expert.status === "queued")
          ? [0, 0.55, 1.1].map((delay) => <circle key={delay} className="ai-orbit-packet" r={2.2}>
            <animateMotion dur="1.6s" begin={`${delay}s`} repeatCount="indefinite"><mpath href={`#${edgeId(message.id, expert.id)}`} /></animateMotion>
          </circle>)
          : null}
        {animate && expert.status === "done"
          ? <circle className="ai-orbit-return" r={3}>
            <animateMotion dur="0.9s" fill="freeze" keyPoints="1;0" keyTimes="0;1" calcMode="linear"><mpath href={`#${edgeId(message.id, expert.id)}`} /></animateMotion>
          </circle>
          : null}
      </g>)}
      <g className="ai-orbit-main">
        <circle cx={CENTER.x} cy={CENTER.y} r={29} />
        <text x={CENTER.x} y={CENTER.y - 2} textAnchor="middle">{uiText("主 Agent", "Main")}</text>
        <text className="ai-orbit-sub" x={CENTER.x} y={CENTER.y + 11} textAnchor="middle">{uiText("唯一决策者", "Sole decider")}</text>
      </g>
      {nodes.map(({ expert, x, y }) => <g key={`node:${expert.id}`} className={clsx("ai-orbit-node", `is-${expert.status}`)} transform={`translate(${x} ${y})`}>
        <circle r={15} />
        {expert.status === "running" ? <circle className="ai-orbit-breath" r={15} /> : null}
        <text y={4} textAnchor="middle">{expert.title.slice(0, 2)}</text>
        <text className="ai-orbit-label" y={y > CENTER.y ? 30 : -33} textAnchor="middle">{expert.title}</text>
        <text className="ai-orbit-sub" y={y > CENTER.y ? 42 : -21} textAnchor="middle">
          {statusLabel(expert, uiText)} · {expert.mode === "parallel" ? uiText("并行", "parallel") : uiText("串行", "serial")}{expert.followUps > 0 ? uiText(` · 追问 ${expert.followUps}`, ` · ${expert.followUps} follow-up`) : ""}
        </text>
      </g>)}
    </svg>
    <OrbitTimeline experts={experts} now={now} running={running} uiText={uiText} />
  </div>;
}

function OrbitTimeline({ experts, now, running, uiText }: { experts: OrbitExpert[]; now: number; running: boolean; uiText: UiText }) {
  const starts = experts.map((expert) => expert.startedAt).filter((value): value is number => value !== null);
  if (starts.length === 0) return null;
  const origin = Math.min(...starts);
  // 仍有专家在跑时时间轴延伸到“现在”；全部结束后以最后一位返回为终点。
  const ends = experts.map((expert) => expert.endedAt ?? (running ? now : expert.startedAt ?? origin));
  const end = Math.max(...ends, running ? now : origin);
  const span = Math.max(end - origin, 1000);
  return <div className="ai-orbit-timeline" aria-label={uiText("执行时间线", "Execution timeline")}>
    {experts.map((expert) => {
      const start = expert.startedAt ?? origin;
      const stop = expert.endedAt ?? now;
      return <div key={expert.id} className={clsx("ai-orbit-lane", `is-${expert.status}`)}>
        <span>{expert.title}</span>
        <i><b style={{ left: `${((start - origin) / span) * 100}%`, width: `${Math.max(((stop - start) / span) * 100, 1.5)}%` }} /></i>
        <small>{expert.tokens === null ? "--" : formatTokens(expert.tokens)}</small>
      </div>;
    })}
    <p>{uiText(`总时长 ${formatSeconds(span)}`, `Span ${formatSeconds(span)}`)}</p>
  </div>;
}

function statusLabel(expert: OrbitExpert, uiText: UiText) {
  switch (expert.status) {
    case "running": return uiText("分析中", "working");
    case "queued": return uiText("排队", "queued");
    case "done": return uiText("已返回", "returned");
    case "failed": return uiText("失败", "failed");
    default: return uiText("已取消", "cancelled");
  }
}

function edgeId(messageId: string, expertId: string) {
  return `ai-orbit-${messageId}-${expertId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function formatTokens(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(Math.round(value));
}

function formatSeconds(ms: number) {
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

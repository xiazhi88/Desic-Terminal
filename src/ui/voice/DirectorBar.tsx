import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import type { DirectorAction } from "../../lib/voice/directorCommands";
import type { DirectorStepStatus } from "../../lib/voice/directorExecutor";
import { plainSpeech, splitLead, toolLabel, type VoiceAgentTool } from "../../lib/voice/voiceAgentModel";
import { EvidenceStage } from "./EvidenceStage";
import type { VoiceHoldKey, VoicePaletteName } from "../../lib/voice/voicePreference";
import { PixelBuddy, type BuddyPhase } from "./pixelBuddy";
import type { DirectorView } from "./directorView";

export type { DirectorNotice, DirectorPhase, DirectorView } from "./directorView";

type LevelStore = { get: () => number; subscribe: (listener: () => void) => () => void };
type UiText = (chinese: string, english: string) => string;

type Props = {
  view: DirectorView;
  levelStore: LevelStore;
  uiText: UiText;
  holdKey: VoiceHoldKey;
  enabled: boolean;
  palette: VoicePaletteName;
  side: "left" | "right";
  /** 是否允许偶尔探出头来。 */
  peek: boolean;
  /** 命令面板、引导等占用界面时不冒头。 */
  paused: boolean;
  onUndo: () => void;
  onStop: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  /** 在伙伴本体上按下 / 松开（点按 = 开始，再点 = 发送）。 */
  /** 停顿期里进入改字。 */
  onEdit: () => void;
  /** 提交改后的文字；传 null 表示取消。 */
  onSubmitEdit: (value: string | null) => void;
  onPointerStart: () => void;
  onPointerEnd: () => void;
};

const SECTION_LABELS: Record<string, [string, string]> = {
  ai: ["AI 研究", "AI Research"],
  terminal: ["交易终端", "Terminal"],
  radar: ["市场雷达", "Market Radar"],
  opportunities: ["交易机会", "Opportunities"],
  automation: ["AI 自动化", "AI Automation"],
  intelligence: ["市场情报", "Intelligence"],
  systematic: ["策略研究", "Strategy Research"],
  data: ["数据", "Data"],
  config: ["设置", "Settings"],
};

export function holdKeyLabel(key: VoiceHoldKey, uiText: UiText) {
  if (key === "Backquote") return "`";
  if (key === "AltRight") return uiText("右 Option / Alt", "Right Option / Alt");
  return key;
}

export function describeDirectorAction(action: DirectorAction, uiText: UiText): string {
  switch (action.type) {
    case "workspace": {
      const [zh, en] = SECTION_LABELS[action.section] ?? [action.section, action.section];
      return uiText(`打开 ${zh}`, `Open ${en}`);
    }
    case "instrument":
      return uiText(`切换到 ${action.instId.replace(/-USDT-SWAP$/, "")}`, `Switch to ${action.instId.replace(/-USDT-SWAP$/, "")}`);
    case "timeframe":
      return uiText(`周期 ${action.bar}`, `Timeframe ${action.bar}`);
    case "orderFlow":
      return action.enabled ? uiText("开启订单流", "Turn on order flow") : uiText("关闭订单流", "Turn off order flow");
    case "indicator":
      return action.op === "add" ? uiText(`添加 ${action.id.toUpperCase()}`, `Add ${action.id.toUpperCase()}`) : uiText(`去掉 ${action.id.toUpperCase()}`, `Remove ${action.id.toUpperCase()}`);
    case "clearIndicators":
      return uiText("清空指标", "Clear indicators");
  }
}

function describeTool(tool: VoiceAgentTool, uiText: UiText): string {
  const [zh, en] = toolLabel(tool.name);
  return `${uiText(zh, en)}${tool.target ? ` · ${tool.target}` : ""}`;
}

/** 回答文字：先说结论（开头一两句），其余折叠；去掉 Markdown 标记，避免满屏星号和长段落。 */
function AnswerText({ text, streaming, uiText }: { text: string; streaming?: boolean; uiText: UiText }) {
  const [expanded, setExpanded] = useState(false);
  const { lead, rest } = splitLead(plainSpeech(text));
  return (
    <span className="director-answer">
      {lead}
      {rest && (expanded || streaming ? <span className="director-answer-rest"> {rest}</span> : null)}
      {streaming && <span className="director-caret" />}
      {rest && !streaming && (
        <button type="button" className="director-more" onClick={() => setExpanded((value) => !value)}>
          {expanded ? uiText("收起", "Less") : uiText("展开全文", "More")}
        </button>
      )}
    </span>
  );
}

/** 对应角色的动作阶段。 */
function buddyPhaseFor(view: DirectorView): BuddyPhase {
  switch (view.phase) {
    case "arming":
    case "listening":
      return "listening";
    case "transcribing":
      return "thinking";
    case "confirming":
    case "editing":
      return "confirming";
    case "executing":
      return "working";
    case "answering":
      return view.agent && view.agent.text ? "talking" : "thinking";
    case "notice":
      if (view.notice?.tone === "ok") return "happy";
      if (view.notice?.tone === "warn" || view.notice?.tone === "error") return "refuse";
      return "nod";
    default:
      return "sleeping";
  }
}

function LevelBridge({ levelStore, onLevel }: { levelStore: LevelStore; onLevel: (value: number) => void }) {
  const level = useSyncExternalStore(levelStore.subscribe, levelStore.get, () => 0);
  useEffect(() => onLevel(level), [level, onLevel]);
  return null;
}

/** 目标元素高亮一下，让用户一眼看到「它改了哪里」。 */
function pulse(element: Element | null) {
  if (!element) return;
  element.classList.remove("voice-spotlight");
  void (element as HTMLElement).offsetWidth;
  element.classList.add("voice-spotlight");
  window.setTimeout(() => element.classList.remove("voice-spotlight"), 900);
}

export function DirectorBar({ view, levelStore, uiText, holdKey, enabled, palette, side, peek, paused, onUndo, onStop, onCancel, onDismiss, onEdit, onSubmitEdit, onPointerStart, onPointerEnd }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<PixelBuddy | null>(null);
  const awake = view.phase !== "idle";
  const viewIdleRef = useRef(true);
  viewIdleRef.current = view.phase === "idle";

  // 引擎生命周期：随语音开关创建 / 销毁
  useEffect(() => {
    if (!enabled || !canvasRef.current || !trailRef.current || !rootRef.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const engine = new PixelBuddy({ canvas: canvasRef.current, trail: trailRef.current, root: rootRef.current, reducedMotion: reduced });
    engineRef.current = engine;
    const handleResize = () => engine.resize();
    const handlePointer = (event: PointerEvent) => engine.lookAt(event.clientX, event.clientY);
    window.addEventListener("resize", handleResize);
    window.addEventListener("pointermove", handlePointer);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("pointermove", handlePointer);
      engine.destroy();
      engineRef.current = null;
    };
  }, [enabled]);

  useEffect(() => engineRef.current?.setPalette(palette), [palette, enabled]);
  useEffect(() => engineRef.current?.setSide(side), [side, enabled]);
  useEffect(() => {
    engineRef.current?.setPhase(buddyPhaseFor(view));
  }, [view.phase, view.notice?.tone, view.agent?.text ? 1 : 0, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void engineRef.current?.setAwake(awake);
  }, [awake, enabled]);

  // 执行进度
  useEffect(() => {
    if (view.phase !== "executing") return;
    const total = view.steps.length || 1;
    const done = view.steps.filter((step) => step.status === "done" || step.status === "skipped").length;
    engineRef.current?.setProgress(done / total);
  }, [view.phase, view.steps]);

  // 停顿倒计时：角色脚下的像素条从满到空
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || view.phase !== "confirming" || !view.countdown) {
      engineRef.current?.setCountdown(null);
      return;
    }
    const { startedAt, durationMs } = view.countdown;
    const timer = window.setInterval(() => engine.setCountdown(Math.max(0, 1 - (performance.now() - startedAt) / durationMs)), 80);
    engine.setCountdown(1);
    return () => {
      window.clearInterval(timer);
      engine.setCountdown(null);
    };
  }, [view.phase, view.countdown]);

  // 指挥：射出像素飞向被改动的位置
  const lastSpotlight = useRef(0);
  useEffect(() => {
    const spotlight = view.spotlight;
    if (!spotlight || spotlight.id === lastSpotlight.current) return;
    lastSpotlight.current = spotlight.id;
    const target = document.querySelector(spotlight.selector);
    engineRef.current?.beam(target, () => pulse(target));
  }, [view.spotlight]);

  // 偶尔冒头：30–90 秒随机，只在空闲、可见、没有其它界面占用时发生
  useEffect(() => {
    if (!enabled || !peek || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    const schedule = (first: boolean) => {
      const delay = first ? 6_000 : 30_000 + Math.random() * 60_000;
      timer = window.setTimeout(() => {
        const engine = engineRef.current;
        if (engine && engine.isDockedIdle && document.visibilityState === "visible" && !paused && viewIdleRef.current) void engine.peek();
        schedule(false);
      }, delay);
    };
    schedule(true);
    return () => window.clearTimeout(timer);
  }, [enabled, peek, paused]);
  if (!enabled) return null;

  const { phase, notice, steps, agent } = view;
  const quote = view.transcript ?? notice?.transcript ?? null;
  const keyLabel = holdKeyLabel(holdKey, uiText);
  const showSteps = steps.length > 0 && (phase === "executing" || (phase === "notice" && notice?.tone !== "error"));
  const hints = [uiText("切到 ETH 四小时", "ETH 4 hours"), uiText("加 RSI", "Add RSI"), uiText("打开订单流", "Order flow on"), uiText("今天市场怎么样", "How is the market today")];

  return (
    <>
      <LevelBridge levelStore={levelStore} onLevel={(value) => engineRef.current?.setLevel(value)} />
      <canvas ref={trailRef} className="director-trail" aria-hidden="true" />
      <div ref={rootRef} className={clsx("director-buddy", awake && "is-awake")}>
        <canvas ref={canvasRef} className="director-sprite" aria-hidden="true" />
        <div
          className="director-hit"
          onPointerDown={(event) => {
            event.preventDefault();
            onPointerStart();
          }}
          onPointerUp={onPointerEnd}
          title={uiText(`按住 ${keyLabel} 说话`, `Hold ${keyLabel} to talk`)}
        />
        <div className={clsx("director-stack", awake && "show")}>
        {agent && (phase === "answering" || (phase === "notice" && notice?.tone === "ok")) && (
          <EvidenceStage evidence={agent.evidence} decision={agent.decision} sources={agent.sources} uiText={uiText} />
        )}
        <div className={clsx("director-bubble", awake && "show", notice && `tone-${notice.tone}`, `is-${phase}`)} role="status" aria-live="polite">
          <div className="director-body">
            {(phase === "arming" || phase === "listening") && (
              <>
                <div className="director-line">
                  <span className="director-text">
                    {view.partial ? <span className="director-partial">{view.partial}</span> : phase === "arming" ? uiText("正在打开麦克风…", "Opening microphone…") : uiText("正在听…", "Listening…")}
                    <span className="director-sub">{uiText(`松开 ${keyLabel} 发送 · Esc 取消`, `Release ${keyLabel} to send · Esc to cancel`)}</span>
                  </span>
                </div>
                {!view.partial && phase === "listening" && (
                  <div className="director-hints">
                    {hints.map((hint) => (
                      <span key={hint}>{hint}</span>
                    ))}
                  </div>
                )}
              </>
            )}
  
            {phase === "transcribing" && (
              <div className="director-line">
                <span className="director-text">
                  {view.partial ? <span className="director-partial">{view.partial}</span> : null}
                  <span className="director-sub">{uiText("识别中", "Transcribing")}<span className="director-dots" /></span>
                </span>
              </div>
            )}
  
            {phase === "confirming" && (
              <>
                <div className="director-line">
                  <span className="director-text">
                    <span className="director-quote">“{quote}”</span>
                    {view.heard && <span className="director-heard">{uiText("听到：", "Heard: ")}{view.heard}{uiText("（已按词表纠正）", " (corrected by your word list)")}</span>}
                    {view.pending === "ask-ai" ? (
                      <span className="director-plan">{uiText("→ 交给语音指挥回答", "→ Ask the voice assistant")}</span>
                    ) : (
                      <span className="director-plan">→ {view.pending?.map((action) => describeDirectorAction(action, uiText)).join(" · ")}</span>
                    )}
                  </span>
                  <button type="button" className="director-link" onClick={onEdit}>{uiText("改 Tab", "Edit Tab")}</button>
                  <button type="button" className="director-link" onClick={onCancel}>{uiText("取消 Esc", "Cancel Esc")}</button>
                </div>
                <div className="director-sub director-confirm-hint">{uiText("识别不对？Tab 改字 · Esc 取消 · Enter 立即执行", "Wrong? Tab to edit · Esc to cancel · Enter to run now")}</div>
                {view.countdown && <div key={view.countdown.startedAt} className="director-countdown" style={{ animationDuration: `${view.countdown.durationMs}ms` }} />}
              </>
            )}
  
            {phase === "editing" && (
              <form
                className="director-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = (new FormData(event.currentTarget).get("draft") as string | null) ?? "";
                  onSubmitEdit(value);
                }}
              >
                <span className="director-sub">{uiText("改成你想说的，系统会记住这次的纠正", "Fix what you meant. The app will remember the correction")}</span>
                <input name="draft" className="director-input" defaultValue={view.draft ?? ""} autoFocus autoComplete="off" spellCheck={false} />
                <span className="director-sub">{uiText("Enter 确认并执行 · Esc 取消", "Enter to confirm and run · Esc to cancel")}</span>
              </form>
            )}

            {phase === "executing" && (
              <div className="director-line">
                <span className="director-text director-quote">{view.source === "ai" ? uiText("AI 正在操作界面", "AI is adjusting the view") : quote ? `“${quote}”` : ""}</span>
                <button type="button" className="director-link" onClick={onStop}>{uiText("停止 Esc", "Stop Esc")}</button>
              </div>
            )}
  
            {phase === "answering" && (
              <>
                <div className="director-line">
                  <span className="director-text">
                    {quote && <span className="director-quote">“{quote}”</span>}
                    {agent?.text ? <AnswerText text={agent.text} streaming uiText={uiText} /> : <span className="director-sub">{uiText("思考中", "Thinking")}<span className="director-dots" /></span>}
                  </span>
                  <button type="button" className="director-link" onClick={onCancel}>{uiText("停止 Esc", "Stop Esc")}</button>
                </div>
                {agent && agent.tools.length > 0 && (
                  <ol className="director-trail-list">
                    {agent.tools.slice(-6).map((tool) => (
                      <li key={tool.id} className={`is-${tool.status}`}>
                        <b aria-hidden="true">{tool.status === "done" ? "✓" : tool.status === "failed" ? "×" : ">"}</b>
                        <span>{describeTool(tool, uiText)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
  
            {phase === "notice" && notice && (
              <>
                <div className={clsx("director-line", agent && "is-answer")}>
                  <span className="director-text">
                    {quote && <span className="director-quote">“{quote}”</span>}
                    {agent ? <AnswerText text={notice.text} uiText={uiText} /> : <span>{notice.text}</span>}
                  </span>
                  {!agent && notice.action && (
                    <button type="button" className="director-link is-strong" onClick={notice.action.run}>{notice.action.label}</button>
                  )}
                  {notice.undoable && view.canUndo && (
                    <button type="button" className="director-link is-strong" onClick={onUndo}>{uiText("撤销", "Undo")}</button>
                  )}
                  <button type="button" className="director-close" onClick={onDismiss} aria-label={uiText("关闭提示", "Dismiss")}>×</button>
                </div>
                {agent && notice.action && (
                  <div className="director-actions">
                    <button type="button" className="director-link is-strong" onClick={notice.action.run}>{notice.action.label}</button>
                  </div>
                )}
              </>
            )}
  
            {view.learned && (phase === "executing" || phase === "answering" || phase === "notice") && (
              <div className="director-sub director-learned">{uiText(`已记住：${view.learned}`, `Remembered: ${view.learned}`)}</div>
            )}

            {showSteps && (
              <ol className="director-steps">
                {steps.map((step, index) => (
                  <li key={index} className={clsx(`is-${step.status}`)}>
                    <b aria-hidden="true">{stepGlyph(step.status)}</b>
                    <span>{describeDirectorAction(step.action, uiText)}</span>
                    {step.status === "skipped" && <small>{uiText("已是这样", "already")}</small>}
                  </li>
                ))}
              </ol>
            )}
  
          </div>
        </div>
        </div>
      </div>
    </>
  );
}

function stepGlyph(status: DirectorStepStatus) {
  if (status === "done") return "✓";
  if (status === "running") return ">";
  if (status === "skipped") return "–";
  if (status === "cancelled") return "×";
  return "·";
}

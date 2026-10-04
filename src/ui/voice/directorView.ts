import type { DirectorAction } from "../../lib/voice/directorCommands";
import type { DirectorStepStatus } from "../../lib/voice/directorExecutor";
import type { VoiceAgentState } from "../../lib/voice/voiceAgentModel";

export type DirectorPhase = "idle" | "arming" | "listening" | "transcribing" | "confirming" | "editing" | "executing" | "answering" | "notice";

export type DirectorNotice = {
  tone: "info" | "ok" | "warn" | "error";
  text: string;
  transcript?: string;
  action?: { label: string; run: () => void };
  /** 仅「刚执行完并改动了界面」的提示才给撤销入口；拒绝、已撤销、回答都不能显示，否则会误撤销上一次无关操作。 */
  undoable?: boolean;
};

export type DirectorView = {
  phase: DirectorPhase;
  /** 最终识别文字（识别完成后）。 */
  transcript: string | null;
  /** 流式识别的实时文字（说话过程中）。 */
  partial: string | null;
  /** 纠错词表改动了识别结果时，这里是引擎原本听到的文字。 */
  heard: string | null;
  /** 停顿期里用户正在改的文字（editing 阶段）。 */
  draft: string | null;
  /** 刚从用户的改动里学到的一条纠错，例如「座椅 → 以太」。 */
  learned: string | null;
  source: "voice" | "ai" | null;
  steps: { action: DirectorAction; status: DirectorStepStatus }[];
  /** 停顿确认期：将要做的事；`ask-ai` 表示交给语音指挥回答。 */
  pending: DirectorAction[] | "ask-ai" | null;
  countdown: { startedAt: number; durationMs: number } | null;
  /** 语音指挥正在或刚刚给出的回答。 */
  agent: Pick<VoiceAgentState, "text" | "tools" | "evidence" | "decision" | "sources" | "status"> | null;
  notice: DirectorNotice | null;
  canUndo: boolean;
  /** 让伙伴射出像素飞向某个界面元素（`id` 递增触发，同一目标连续触发也会重放）。 */
  spotlight: { id: number; selector: string } | null;
};

export const IDLE_VIEW: DirectorView = {
  phase: "idle",
  transcript: null,
  partial: null,
  heard: null,
  draft: null,
  learned: null,
  source: null,
  steps: [],
  pending: null,
  countdown: null,
  agent: null,
  notice: null,
  canUndo: false,
  spotlight: null,
};

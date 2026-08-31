import { AiProcessTimeline, aiReportedOutputTokens, type AiResearchArtifact, type AiUiMessage } from "../AiMessageProcess";
import { formatDuration } from "../App";
import { formatLocalizedNumber } from "../../i18n/runtime";
import { useNowInterval } from "./useNowInterval";

// Leaf components that display relative time / elapsed duration. Each of them
// subscribes to the shared one-second clock (useNowInterval) so ticking no
// longer re-renders the whole AiResearchWorkspace. Rendered markup and values
// are unchanged.

export function AiResearchMessageTimeline({ message, streaming, onApprove, onOpenStrategy, onOpenArtifact }: { message: AiUiMessage; streaming: boolean; onApprove: (approvalId: string, approved: boolean, reason: string) => void; onOpenStrategy?: (strategyId: string, runId?: string, optimizationId?: string) => void; onOpenArtifact?: (artifact: AiResearchArtifact) => void }) {
  const now = useNowInterval(streaming);
  return (
    <AiProcessTimeline
      message={message}
      now={now}
      onApprove={onApprove}
      onOpenStrategy={onOpenStrategy}
      onOpenArtifact={onOpenArtifact}
    />
  );
}

export function AiResearchMessageDuration({ startedAt, completedAt, completed, streaming }: { startedAt?: number; completedAt?: number; completed?: boolean; streaming: boolean }) {
  const now = useNowInterval(streaming);
  return <span>{formatDuration(startedAt, completedAt ?? (completed ? undefined : now))}</span>;
}

function AiThroughputMetric({ message }: { message: AiUiMessage }) {
  if (message.usageIsSessionCumulative || message.tools.length > 0 || (message.agents?.length ?? 0) > 0
    || !message.firstTokenAt || !message.completedAt) return null;
  const outputTokens = aiReportedOutputTokens(message.usage);
  const generationSeconds = (message.completedAt - message.firstTokenAt) / 1000;
  if (!outputTokens || !Number.isFinite(generationSeconds) || generationSeconds <= 0) return null;
  const tokensPerSecond = outputTokens / generationSeconds;
  return <span>{formatLocalizedNumber(tokensPerSecond, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} tok/s</span>;
}

export { AiThroughputMetric };

import { QUICK_PROMPTS } from "./ai-research/welcome-prompts";

// 简约版任务甲板：一句标题 + 快捷建议（点击由工作区直接 submit 发送）。
// 最近会话/Skill/研究起点已移除——会话列表在左侧栏，Skill 走 composer 的斜杠菜单。
export function AiResearchWelcome({
  uiText,
  onSend
}: {
  uiText: (zh: string, en: string) => string;
  onSend?: (prompt: string) => void;
}) {
  return (
    <section className="ai-research-welcome" aria-labelledby="ai-research-welcome-title">
      <h1 id="ai-research-welcome-title">{uiText("从一个市场问题开始。", "Start with a market question.")}</h1>
      <div className="ai-research-welcome-quick">
        {QUICK_PROMPTS.map((item) => (
          <button
            type="button"
            key={item.id}
            disabled={!onSend}
            title={uiText(item.zh, item.en)}
            onClick={() => onSend?.(uiText(item.zh, item.en))}
          >
            {uiText(item.zh, item.en)}
          </button>
        ))}
      </div>
    </section>
  );
}

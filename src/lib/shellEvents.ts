// 外壳级跨组件事件：命令面板等全局入口把请求交给对应工作区处理，不直接耦合其内部状态。

/** detail 为要填入 AI 研究输入框的问题文本（只填入，不自动发送）。 */
export const AI_RESEARCH_PROMPT_EVENT = "desic:ai-research-prompt";

export function requestAiResearchPrompt(prompt: string) {
  window.dispatchEvent(new CustomEvent<string>(AI_RESEARCH_PROMPT_EVENT, { detail: prompt }));
}

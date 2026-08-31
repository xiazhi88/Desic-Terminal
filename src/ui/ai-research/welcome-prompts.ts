/*
 * 快捷建议文案：任务甲板直发 prompts（zh/en 双语，uiText 内联消费）。
 * 独立模块便于后续增删句子而不触碰组件。
 */
export const QUICK_PROMPTS: ReadonlyArray<{ id: string; zh: string; en: string }> = [
  { id: "market-overview", zh: "分析下目前的市场情况。", en: "Analyze the current market situation." },
  { id: "radar-scan", zh: "扫描雷达排名，找出当前值得关注的品种。", en: "Scan the radar ranking for instruments worth watching." },
  { id: "account-review", zh: "解读我当前的账户持仓与风险。", en: "Review my current positions and account risk." },
  { id: "intel-digest", zh: "总结最近的市场情报与重要异动。", en: "Summarize the latest market intelligence and anomalies." }
];

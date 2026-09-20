import type { ReactNode } from "react";

/**
 * 行徽标"优先级 + 限量"策略（视觉规格 P0-2）：每行最多渲染 max 枚语义徽章，
 * 其余折叠为一枚 `+n` 计数徽标，全文由 title 承载。列表行与 Profile 勾选器共用。
 */
export type AgentRowChip = {
  key: string;
  /** 越小越优先（风险/警告类应排前）。 */
  priority: number;
  node: ReactNode;
  /** 折叠时写入 +n title 的全文摘要。 */
  summary: string;
};

export function limitRowChips(chips: AgentRowChip[], max = 2): ReactNode[] {
  const sorted = [...chips].sort((left, right) => left.priority - right.priority);
  const visible = sorted.slice(0, max);
  const overflow = sorted.slice(max);
  const nodes = visible.map((chip) => chip.node);
  if (overflow.length > 0) {
    nodes.push(
      <em
        key="__chip-overflow"
        className="agent-chip is-quiet"
        title={overflow.map((chip) => chip.summary).join(" · ")}
      >
        +{overflow.length}
      </em>
    );
  }
  return nodes;
}

/**
 * 图表指标的外部指令（导演模式 / AI 界面工具）。
 *
 * 语义刻意做成「可逆、不丢参数」：
 * - add：优先把已有但被隐藏的同类指标重新显示（保留用户调过的参数）；没有才新建一个默认参数的实例。
 * - remove：只隐藏该类指标的所有实例，不删除，因此撤销就是再 add。
 *
 * 不依赖 React 或图表库，实例的创建通过参数注入，便于直接用 node 测试。
 */

export type IndicatorCommand = { token: number; op: "add" | "remove"; id: string };

type InstanceLike = { id: string; definitionId: string; visible: boolean };

export function applyIndicatorCommands<T extends InstanceLike>(
  items: readonly T[],
  commands: readonly IndicatorCommand[],
  createInstance: (definitionId: string, token: number) => T | null,
): T[] {
  let next = [...items];
  for (const command of commands) {
    const same = next.filter((item) => item.definitionId === command.id);
    if (command.op === "remove") {
      next = next.map((item) => (item.definitionId === command.id && item.visible ? { ...item, visible: false } : item));
      continue;
    }
    if (same.some((item) => item.visible)) continue;
    const hidden = same[0];
    if (hidden) {
      next = next.map((item) => (item.id === hidden.id ? { ...item, visible: true } : item));
      continue;
    }
    const created = createInstance(command.id, command.token);
    if (created) next.push(created);
  }
  return next;
}

/** 当前可见的指标种类（去重、保持出现顺序）。 */
export function visibleIndicatorIds(items: readonly InstanceLike[]): string[] {
  const seen = new Set<string>();
  for (const item of items) if (item.visible) seen.add(item.definitionId);
  return [...seen];
}

/** 一批指令里最大的 token，用来通知调用方「已处理到哪里」。 */
export function maxCommandToken(commands: readonly IndicatorCommand[]): number {
  return commands.reduce((max, command) => Math.max(max, command.token), 0);
}

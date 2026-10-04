/**
 * 导演模式的动作执行器。
 *
 * 只通过 DirectorController 触达界面：全部是可逆的界面操作，不接触订单、账户或 Profile。
 * 每次执行都会返回一个撤销函数，按相反顺序把界面还原到执行前。
 */
import type { DirectorAction, DirectorSection, DirectorTimeframe } from "./directorCommands";

export type DirectorSnapshot = {
  section: DirectorSection;
  symbol: string;
  bar: string;
  orderFlow: boolean;
  indicatorIds: readonly string[];
};

export interface DirectorController {
  snapshot(): DirectorSnapshot;
  setSection(section: DirectorSection): void;
  setInstrument(instId: string): void;
  setTimeframe(bar: DirectorTimeframe): void;
  setOrderFlow(enabled: boolean): void;
  addIndicator(id: string): void;
  removeIndicator(id: string): void;
}

export type DirectorStepStatus = "pending" | "running" | "done" | "skipped" | "cancelled";

export type DirectorRunOptions = {
  signal?: AbortSignal;
  /** 步骤之间的停顿，让用户看清每一步；测试里传 0。 */
  stepDelayMs?: number;
  onStep?: (index: number, status: DirectorStepStatus) => void;
  wait?: (ms: number) => Promise<void>;
};

export type DirectorRunResult = {
  statuses: DirectorStepStatus[];
  /** 本次是否改变过界面；全部被跳过时为 false。 */
  changed: boolean;
  undo: () => void;
};

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runDirectorActions(
  actions: readonly DirectorAction[],
  controller: DirectorController,
  options: DirectorRunOptions = {},
): Promise<DirectorRunResult> {
  const { signal, stepDelayMs = 320, onStep, wait = defaultWait } = options;
  // React 状态是异步生效的，所以在本地维护一份推演状态，避免同一句话里的前后步骤互相看不见。
  const state: { section: DirectorSection; symbol: string; bar: string; orderFlow: boolean; indicatorIds: string[] } = (() => {
    const snapshot = controller.snapshot();
    return { ...snapshot, indicatorIds: [...snapshot.indicatorIds] };
  })();
  const statuses: DirectorStepStatus[] = actions.map(() => "pending");
  const inverses: Array<() => void> = [];
  let changed = false;

  const ensureTerminal = () => {
    if (state.section === "terminal") return;
    const previous = state.section;
    controller.setSection("terminal");
    state.section = "terminal";
    inverses.push(() => controller.setSection(previous));
    changed = true;
  };

  for (let index = 0; index < actions.length; index += 1) {
    if (signal?.aborted) {
      for (let rest = index; rest < actions.length; rest += 1) {
        statuses[rest] = "cancelled";
        onStep?.(rest, "cancelled");
      }
      break;
    }
    const action = actions[index];
    statuses[index] = "running";
    onStep?.(index, "running");
    let applied = false;

    switch (action.type) {
      case "workspace": {
        if (state.section !== action.section) {
          const previous = state.section;
          controller.setSection(action.section);
          state.section = action.section;
          inverses.push(() => controller.setSection(previous));
          applied = true;
        }
        break;
      }
      case "instrument": {
        if (state.symbol !== action.instId || state.section !== "terminal") {
          const previousSymbol = state.symbol;
          const previousSection = state.section;
          controller.setInstrument(action.instId);
          state.symbol = action.instId;
          state.section = "terminal";
          inverses.push(() => {
            controller.setInstrument(previousSymbol);
            if (previousSection !== "terminal") controller.setSection(previousSection);
          });
          applied = state.symbol !== previousSymbol || previousSection !== "terminal";
        }
        break;
      }
      case "timeframe": {
        if (state.bar !== action.bar) {
          ensureTerminal();
          const previous = state.bar;
          controller.setTimeframe(action.bar);
          state.bar = action.bar;
          inverses.push(() => controller.setTimeframe(previous as DirectorTimeframe));
          applied = true;
        }
        break;
      }
      case "orderFlow": {
        if (state.orderFlow !== action.enabled) {
          ensureTerminal();
          const previous = state.orderFlow;
          controller.setOrderFlow(action.enabled);
          state.orderFlow = action.enabled;
          inverses.push(() => controller.setOrderFlow(previous));
          applied = true;
        }
        break;
      }
      case "indicator": {
        const present = state.indicatorIds.includes(action.id);
        if (action.op === "add" && !present) {
          ensureTerminal();
          controller.addIndicator(action.id);
          state.indicatorIds.push(action.id);
          inverses.push(() => controller.removeIndicator(action.id));
          applied = true;
        } else if (action.op === "remove" && present) {
          ensureTerminal();
          controller.removeIndicator(action.id);
          state.indicatorIds = state.indicatorIds.filter((id) => id !== action.id);
          inverses.push(() => controller.addIndicator(action.id));
          applied = true;
        }
        break;
      }
      case "clearIndicators": {
        if (state.indicatorIds.length > 0) {
          ensureTerminal();
          const previous = [...state.indicatorIds];
          for (const id of previous) controller.removeIndicator(id);
          state.indicatorIds = [];
          inverses.push(() => previous.forEach((id) => controller.addIndicator(id)));
          applied = true;
        }
        break;
      }
    }

    changed = changed || applied;
    statuses[index] = applied ? "done" : "skipped";
    onStep?.(index, statuses[index]);
    if (applied && index < actions.length - 1 && stepDelayMs > 0) await wait(stepDelayMs);
  }

  return {
    statuses,
    changed,
    undo: () => {
      for (const inverse of [...inverses].reverse()) inverse();
    },
  };
}

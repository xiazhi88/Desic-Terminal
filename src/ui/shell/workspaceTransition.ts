import { prefersReducedMotion } from "../../lib/springMotion";
import { isPhosphorVisual } from "../../lib/visualPreference";

const ENTER_MS = 320;
let enterTimer: number | null = null;

// 工作区切换：顶栏与导航栏不动，只有新的内容区淡入上移一次。
// 不使用 View Transitions API：它在过渡期间把命中测试整体指向根元素，
// 切换后立即点击新页面控件会被吞掉；这里只是 CSS 进入动画，交互不受影响。
export function runWorkspaceTransition(update: () => void) {
  update();
  if (document.hidden || prefersReducedMotion() || !isPhosphorVisual()) return;
  const workspace = document.querySelector<HTMLElement>(".terminal .workspace");
  if (!workspace) return;
  workspace.removeAttribute("data-entering");
  void workspace.offsetWidth;
  workspace.setAttribute("data-entering", "");
  if (enterTimer !== null) window.clearTimeout(enterTimer);
  enterTimer = window.setTimeout(() => {
    workspace.removeAttribute("data-entering");
    enterTimer = null;
  }, ENTER_MS);
}

import { useEffect, useRef, useState } from "react";

export type BumpDirection = "up" | "down" | null;

/**
 * useBump —— 行情数字跳动接线 hook（配合 src/theme/data-voice.css 的 .bump utility）。
 *
 * 用法：
 *   const bump = useBump(value);
 *   <span className={`原类名 ${bump.className}`.trim()} onAnimationEnd={bump.onAnimationEnd}>{value}</span>
 *
 * 已知取舍（按任务约定，不做重触发队列）：
 * - 动画运行中（numBump 约 450ms）value 再次变化不会重触发：bump class 未先移除，
 *   浏览器不会重启同名动画；高频行情下 450ms 内最多丢几次 tick 的跳动反馈，这是接受的取舍。
 * - onAnimationEnd 会在该元素上"任何" animation 结束时触发（animationend 会从后代冒泡上来）：
 *   若目标元素同时挂有其他 CSS 动画（如呼吸点），bump class 可能被提前/延后清除。
 *   本轮接线的站点均无共存动画；后续新站点如遇共存动画，应把 bump 挪到无共存动画的
 *   包裹元素上（本 hook 函数原型保持不变）。
 * - value 传 number 时按数值比较得出 bump-up / bump-down 方向；传 string 时变化即闪、方向为 null。
 * - prefers-reduced-motion 下 CSS 已关闭全部动画（animationend 不会触发），active 会停留 true，
 *   仅表现为 bump class 常驻、无任何动画视觉；TSX 侧无需媒体查询处理。
 */
export function useBump(value: number | string): { className: string; onAnimationEnd: () => void } {
  const prevRef = useRef(value);
  const [state, setState] = useState<{ active: boolean; dir: BumpDirection }>({ active: false, dir: null });
  useEffect(() => {
    const prev = prevRef.current;
    if (prev === value) return;
    prevRef.current = value;
    const dir: BumpDirection =
      typeof value === "number" && typeof prev === "number"
        ? value > prev ? "up" : value < prev ? "down" : null
        : null;
    setState({ active: true, dir });
  }, [value]);
  const className = state.active ? `bump${state.dir ? ` bump-${state.dir}` : ""}` : "";
  const onAnimationEnd = () => setState((s) => ({ ...s, active: false }));
  return { className, onAnimationEnd };
}

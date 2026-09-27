import { useEffect, useRef, useState } from "react";

// 阻尼弹簧：半隐式欧拉积分，单步上限 1/30s，切后台回来不会“弹飞”。
export type SpringOptions = { stiffness?: number; damping?: number; mass?: number };

export function stepSpring(
  state: { value: number; velocity: number },
  target: number,
  dt: number,
  { stiffness = 170, damping = 20, mass = 1 }: SpringOptions = {}
) {
  const h = Math.min(dt, 1 / 30);
  const force = -stiffness * (state.value - target) - damping * state.velocity;
  const velocity = state.velocity + (force / mass) * h;
  return { value: state.value + velocity * h, velocity };
}

export function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 返回逐帧逼近 target 的弹簧值；减弱动效时直接跳到目标值。 */
export function useSpringValue(target: number, options: SpringOptions = {}) {
  const [value, setValue] = useState(target);
  const stateRef = useRef({ value: target, velocity: 0 });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (prefersReducedMotion()) {
      stateRef.current = { value: target, velocity: 0 };
      setValue(target);
      return;
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = stepSpring(stateRef.current, target, (now - last) / 1000, optionsRef.current);
      last = now;
      stateRef.current = next;
      const settled = Math.abs(next.value - target) < 1e-3 && Math.abs(next.velocity) < 1e-3;
      if (settled) {
        stateRef.current = { value: target, velocity: 0 };
        setValue(target);
        return;
      }
      setValue(next.value);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return value;
}

import { useEffect, useRef } from "react";
import { hasVisibleTradeHotkeyBlocker, isEditableKeyboardTarget } from "../trade-ticket/model";

type Options = {
  /** KeyboardEvent.code，与键盘布局和输入法无关。 */
  code: string;
  enabled: boolean;
  /** 命令面板、引导等占用键盘的界面打开时暂停。 */
  paused: boolean;
  onStart: () => void;
  onEnd: () => void;
  /** 窗口失焦等异常中断：丢弃而不是发送。 */
  onCancel: () => void;
};

/** 需要持续按住这么久才算「开始说话」，避免误碰键位就弹出麦克风权限。 */
const HOLD_DELAY_MS = 160;

export function useHoldToTalk({ code, enabled, paused, onStart, onEnd, onCancel }: Options) {
  const handlers = useRef({ onStart, onEnd, onCancel });
  handlers.current = { onStart, onEnd, onCancel };

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    let pressed = false;
    let started = false;

    const reset = () => {
      window.clearTimeout(timer);
      pressed = false;
      started = false;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code !== code) return;
      if (event.repeat) {
        // 按住期间的重复事件要吞掉，否则会在页面里反复输入该字符。
        if (pressed) event.preventDefault();
        return;
      }
      if (paused || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.altKey && code !== "AltRight") return;
      if (isEditableKeyboardTarget(event.target) || hasVisibleTradeHotkeyBlocker()) return;
      pressed = true;
      event.preventDefault();
      timer = window.setTimeout(() => {
        started = true;
        handlers.current.onStart();
      }, HOLD_DELAY_MS);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== code || !pressed) return;
      event.preventDefault();
      const wasStarted = started;
      reset();
      if (wasStarted) handlers.current.onEnd();
    };

    const handleInterrupt = () => {
      if (!pressed) return;
      const wasStarted = started;
      reset();
      if (wasStarted) handlers.current.onCancel();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") handleInterrupt();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleInterrupt);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleInterrupt);
      document.removeEventListener("visibilitychange", handleVisibility);
      const wasStarted = started;
      reset();
      if (wasStarted) handlers.current.onCancel();
    };
  }, [code, enabled, paused]);
}

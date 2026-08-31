import { useEffect, useState } from "react";

// Shared one-second clock for AI research time leaves. Only components that
// actually render a relative time / elapsed duration subscribe, so the whole
// workspace no longer re-renders every second while the clock keeps ticking.
const CLOCK_INTERVAL_MS = 1000;

type ClockListener = (now: number) => void;

type ClockState = {
  now: number;
  timer: number | null;
  activeCount: number;
  listeners: Set<ClockListener>;
};

const clock: ClockState = {
  now: Date.now(),
  timer: null,
  activeCount: 0,
  listeners: new Set()
};

function emitClockTick() {
  clock.now = Date.now();
  for (const listener of Array.from(clock.listeners)) listener(clock.now);
}

function subscribeClock(listener: ClockListener) {
  clock.listeners.add(listener);
  clock.activeCount += 1;
  if (clock.activeCount === 1) {
    clock.now = Date.now();
    clock.timer = window.setInterval(emitClockTick, CLOCK_INTERVAL_MS);
  }
  listener(clock.now);
  return () => {
    clock.listeners.delete(listener);
    clock.activeCount -= 1;
    if (clock.activeCount === 0 && clock.timer !== null) {
      window.clearInterval(clock.timer);
      clock.timer = null;
      clock.now = Date.now();
    }
  };
}

export function useNowInterval(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setNow(Date.now());
      return;
    }
    return subscribeClock(setNow);
  }, [active]);
  return now;
}

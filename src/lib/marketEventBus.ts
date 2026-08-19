import { logger } from "./logger";
import { listenOptional } from "./tauri";
import type { MarketEvent } from "./marketEvents";

export type MarketEventHandler = (event: MarketEvent) => void;

const handlers = new Set<MarketEventHandler>();
let attachPromise: Promise<void> | null = null;
let detach: (() => void) | null = null;

function dispatch(event: MarketEvent) {
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch (error) {
      logger.error("market event subscriber failed", error, { eventType: event.type });
    }
  }
}

async function ensureAttached() {
  if (detach || attachPromise) return;
  attachPromise = listenOptional<MarketEvent>("market:event", dispatch)
    .then((cleanup) => {
      if (handlers.size === 0) {
        cleanup?.();
        return;
      }
      detach = cleanup;
    })
    .catch((error) => {
      logger.error("failed to attach shared market event listener", error);
    })
    .finally(() => {
      attachPromise = null;
    });
  await attachPromise;
}

export function subscribeMarketEvents(handler: MarketEventHandler) {
  handlers.add(handler);
  void ensureAttached();

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    handlers.delete(handler);
    if (handlers.size === 0 && detach) {
      detach();
      detach = null;
    }
  };
}

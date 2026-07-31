export type Cleanup = () => void;

export function createDeferredCleanupSlot() {
  let disposed = false;
  let cleanup: Cleanup | null = null;

  return {
    settle(next: Cleanup | null | undefined) {
      if (!next) return;
      if (disposed) {
        next();
        return;
      }
      cleanup = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = cleanup;
      cleanup = null;
      current?.();
    },
    get disposed() {
      return disposed;
    }
  };
}

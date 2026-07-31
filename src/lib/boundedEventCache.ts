type CacheEntry = { signature: string; seenAt: number };

export class BoundedEventCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries = 1_000, private readonly maxAgeMs = 24 * 60 * 60 * 1_000) {}

  isDuplicate(key: string, signature: string, now = Date.now()) {
    const previous = this.entries.get(key);
    if (previous?.signature === signature && now - previous.seenAt <= this.maxAgeMs) return true;
    this.entries.delete(key);
    this.entries.set(key, { signature, seenAt: now });
    this.prune(now);
    return false;
  }

  get size() {
    return this.entries.size;
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) {
      if (now - entry.seenAt > this.maxAgeMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

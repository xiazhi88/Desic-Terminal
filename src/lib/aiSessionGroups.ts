/** AI 研究会话列表的分组：置顶 / 今天 / 昨天 / 更早 / 语音指挥。纯函数，可直接用 node 测试。 */
export const VOICE_GROUP_TITLE = "语音指挥";

export type GroupableSession = { id: string; title: string; updatedAt: number };
export type SessionGroupKey = "pinned" | "today" | "yesterday" | "earlier" | "voice";
export type SessionGroup<T extends GroupableSession> = { key: SessionGroupKey; items: T[] };

const dayStart = (time: number) => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export function groupSessions<T extends GroupableSession>(sessions: readonly T[], pinned: ReadonlySet<string>, now: number, query = ""): SessionGroup<T>[] {
  const needle = query.trim().toLowerCase();
  const today = dayStart(now);
  const yesterday = today - 86_400_000;
  const buckets: Record<SessionGroupKey, T[]> = { pinned: [], today: [], yesterday: [], earlier: [], voice: [] };
  const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const session of ordered) {
    if (needle && !session.title.toLowerCase().includes(needle)) continue;
    if (session.title === VOICE_GROUP_TITLE) buckets.voice.push(session);
    else if (pinned.has(session.id)) buckets.pinned.push(session);
    else if (session.updatedAt >= today) buckets.today.push(session);
    else if (session.updatedAt >= yesterday) buckets.yesterday.push(session);
    else buckets.earlier.push(session);
  }
  return (["pinned", "today", "yesterday", "earlier", "voice"] as const).filter((key) => buckets[key].length > 0).map((key) => ({ key, items: buckets[key] }));
}

/**
 * Conversation history as plain data. Pure functions only; loaded on its
 * own by scripts/check-logic.mjs, so imports must be `import type`.
 */
import type { ChatMessage } from "./protocol";

export type Turn = {
  role: "user" | "assistant";
  /**
   * What the model gets on later turns. For user turns this is the compact
   * prompt: retrieved excerpts and full text are only sent on the turn they
   * were fetched for.
   */
  content: string;
  /** What the transcript shows, if different from `content`. */
  display?: string;
  /** Reasoning shown under an answer; kept in memory, never saved or resent. */
  reasoning?: string;
  /** Local record of the user message sent with this turn, capped in size. */
  source?: { text: string; truncated: boolean };
};

export const HISTORY_VERSION = 1;

/**
 * Messages for one request: the stored turns plus the full prompt of the
 * new question, cut to the last `limit` messages (null = no limit).
 */
export function buildHistory(
  turns: Turn[],
  prompt: string,
  limit: number | null,
): ChatMessage[] {
  const all: ChatMessage[] = [
    ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: prompt },
  ];
  const recent = limit === null ? all : all.slice(-Math.max(1, limit));
  // Some hosts (and Anthropic) reject a history that opens with a reply.
  while (recent.length > 1 && recent[0].role === "assistant") recent.shift();
  return recent;
}

/**
 * File name for an item's conversation. Library IDs are local to one
 * installation and change when a group is re-added, so name files by
 * library type and group ID instead.
 */
export function conversationFileName(
  library: { type: "user" } | { type: "group"; groupID: number },
  itemKey: string,
) {
  const safeKey = itemKey.replace(/[^A-Za-z0-9]/g, "");
  if (!safeKey) return undefined;
  return library.type === "user"
    ? `u_${safeKey}.json`
    : `g${library.groupID}_${safeKey}.json`;
}

export function serializeConversation(label: string, turns: Turn[]) {
  return JSON.stringify(
    {
      version: HISTORY_VERSION,
      label,
      updatedAt: new Date().toISOString(),
      turns: turns.map(({ role, content, display, source }) => ({
        role,
        content,
        ...(display === undefined ? {} : { display }),
        ...(source === undefined ? {} : { source }),
      })),
    },
    null,
    1,
  );
}

/** Stored turns, or undefined if the file is not a conversation. */
export function parseConversation(raw: string): Turn[] | undefined {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.turns)) {
    return undefined;
  }
  return data.turns.flatMap((turn: any): Turn[] => {
    if (turn?.role !== "user" && turn?.role !== "assistant") return [];
    if (typeof turn.content !== "string") return [];
    const source =
      turn.source &&
      typeof turn.source.text === "string" &&
      typeof turn.source.truncated === "boolean"
        ? { text: turn.source.text, truncated: turn.source.truncated }
        : undefined;
    return [
      {
        role: turn.role,
        content: turn.content,
        ...(typeof turn.display === "string" ? { display: turn.display } : {}),
        ...(source ? { source } : {}),
      },
    ];
  });
}

/** Version 2 keeps multiple named sessions in the item's existing JSON file. */
export type SessionRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
};
export type SessionFile = {
  activeId: string;
  sessions: SessionRecord[];
  migrated?: boolean;
};

export function sessionTitle(turns: Turn[]) {
  const first = turns.find((turn) => turn.role === "user");
  return (first?.display ?? first?.content ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

export function parseSessionFile(raw: string): SessionFile | undefined {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const date = (value: unknown) =>
    typeof value === "string" && Number.isFinite(Date.parse(value))
      ? new Date(value).toISOString()
      : new Date(0).toISOString();
  if (
    data.version === 1 ||
    (data.version === undefined && Array.isArray(data.turns))
  ) {
    const turns = parseConversation(raw);
    if (!turns || turns.length !== data.turns.length) return undefined;
    return {
      activeId: "legacy",
      sessions: [
        {
          id: "legacy",
          title: sessionTitle(turns),
          createdAt: date(data.updatedAt),
          updatedAt: date(data.updatedAt),
          turns,
        },
      ],
      migrated: true,
    };
  }
  if (
    data.version !== 2 ||
    !Array.isArray(data.sessions) ||
    !data.sessions.length
  )
    return undefined;
  const ids = new Set<string>();
  const sessions: SessionRecord[] = [];
  for (const entry of data.sessions) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.title !== "string" ||
      !Array.isArray(entry.turns)
    )
      return undefined;
    const turns = parseConversation(JSON.stringify({ turns: entry.turns }));
    if (!turns || turns.length !== entry.turns.length) return undefined;
    ids.add(entry.id);
    sessions.push({
      id: entry.id,
      title: entry.title.slice(0, 120),
      createdAt: date(entry.createdAt),
      updatedAt: date(entry.updatedAt),
      turns,
    });
  }
  return {
    activeId: ids.has(data.activeId) ? data.activeId : sessions[0].id,
    sessions,
  };
}

export function serializeSessionFile(label: string, data: SessionFile) {
  return JSON.stringify(
    {
      version: 2,
      label,
      activeId: data.activeId,
      sessions: data.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        // Share the existing rule: reasoning and runtime state never reach disk.
        turns: JSON.parse(serializeConversation(label, session.turns)).turns,
      })),
    },
    null,
    1,
  );
}

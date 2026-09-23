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
      turns: turns.map(({ role, content, display }) =>
        display === undefined ? { role, content } : { role, content, display },
      ),
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
    return [
      typeof turn.display === "string"
        ? { role: turn.role, content: turn.content, display: turn.display }
        : { role: turn.role, content: turn.content },
    ];
  });
}

/**
 * Pure board data: entries, validation, truncation, serialization and dedupe
 * keys. No Zotero or locale runtime imports; the module store owns the file.
 */

export const BOARD_LIMIT = 50;
export const BOARD_TRANSLATION_LIMIT = 20000;
export const BOARD_SOURCE_LIMIT = 10000;

export type BoardMode = "quick" | "collaborative" | "review";
export type BoardStatus =
  "draft" | "reviewed" | "review-failed" | "stopped" | "incomplete";

export type BoardEntry = {
  /** Random id, 8 characters in practice. */
  id: string;
  /** ISO timestamp of the moment the entry was added. */
  addedAt: string;
  /** `${libraryID}/${item.key}`, the same value as Target.key. */
  itemKey: string;
  /** Display title snapshot from the moment the entry was added. */
  itemTitle: string;
  mode: BoardMode;
  status: BoardStatus;
  /** Original text, already clipped to BOARD_SOURCE_LIMIT. */
  source: string;
  sourceTruncated?: boolean;
  /** Final translation (turn.content), clipped to BOARD_TRANSLATION_LIMIT. */
  translation: string;
  translationTruncated?: boolean;
  /** Model ids for display only; keys and request URLs are never stored. */
  translator?: string;
  reviewer?: string;
};

/** Everything needed to build one entry; the store supplies id and addedAt. */
export type BoardEntryInput = {
  id: string;
  addedAt: string;
  itemKey: string;
  itemTitle: string;
  mode: BoardMode;
  status: BoardStatus;
  source: string;
  sourceTruncated?: boolean;
  translation: string;
  translationTruncated?: boolean;
  translator?: string;
  reviewer?: string;
};

export type BoardDedupeInput = {
  itemKey: string;
  mode: BoardMode;
  translation: string;
};

const BOARD_VERSION = 1;
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOARD_ITEM_KEY = /^-?\d+\/[^\s/]{1,64}$/;
/** Display-only snapshot cap; longer titles are clipped, not rejected. */
const BOARD_TITLE_LIMIT = 500;
/** Model ids are short; the cap keeps a hostile value from bloating a file. */
const BOARD_MODEL_LIMIT = 200;

const MODES = new Set<BoardMode>(["quick", "collaborative", "review"]);
const STATUSES = new Set<BoardStatus>([
  "draft",
  "reviewed",
  "review-failed",
  "stopped",
  "incomplete",
]);

/**
 * Stable identity of a board entry. The translation is clipped to the same
 * limit used by the store, so an answer keeps one key before and after
 * truncation and the duplicate check still matches after a restart.
 */
export function boardDedupeKey(input: BoardDedupeInput): string {
  return [
    input.itemKey,
    input.mode,
    clip(input.translation, BOARD_TRANSLATION_LIMIT),
  ].join("\u0000");
}

/** Dedupe key of a stored entry; the same value the app uses for its button. */
export function boardEntryKey(
  entry: Pick<BoardEntry, "itemKey" | "mode" | "translation">,
): string {
  return boardDedupeKey(entry);
}

/**
 * Build a valid, normalized entry, or undefined when a field is unusable.
 * Text over the limits is clipped and flagged instead of rejected.
 */
export function makeBoardEntry(input: BoardEntryInput): BoardEntry | undefined {
  if (!input || typeof input !== "object") return undefined;
  const id = requiredText(input.id);
  if (!id || !BOARD_ID.test(id)) return undefined;
  const addedAt = isoDate(input.addedAt);
  if (!addedAt) return undefined;
  const itemKey = requiredText(input.itemKey);
  if (!itemKey || !BOARD_ITEM_KEY.test(itemKey)) return undefined;
  if (!MODES.has(input.mode)) return undefined;
  if (!STATUSES.has(input.status)) return undefined;
  if (typeof input.itemTitle !== "string") return undefined;
  if (typeof input.source !== "string") return undefined;
  if (typeof input.translation !== "string" || !input.translation.trim()) {
    return undefined;
  }
  const sourceFlag = optionalBoolean(input.sourceTruncated);
  const translationFlag = optionalBoolean(input.translationTruncated);
  const translator = optionalText(input.translator, BOARD_MODEL_LIMIT);
  const reviewer = optionalText(input.reviewer, BOARD_MODEL_LIMIT);
  if (
    sourceFlag === null ||
    translationFlag === null ||
    translator === null ||
    reviewer === null
  ) {
    return undefined;
  }
  const sourceTruncated =
    sourceFlag === true || input.source.length > BOARD_SOURCE_LIMIT;
  const translationTruncated =
    translationFlag === true ||
    input.translation.length > BOARD_TRANSLATION_LIMIT;
  return {
    id,
    addedAt,
    itemKey,
    itemTitle: clip(
      input.itemTitle.replace(/\s+/g, " ").trim(),
      BOARD_TITLE_LIMIT,
    ),
    mode: input.mode,
    status: input.status,
    source: clip(input.source, BOARD_SOURCE_LIMIT),
    ...(sourceTruncated ? { sourceTruncated: true } : {}),
    translation: clip(input.translation, BOARD_TRANSLATION_LIMIT),
    ...(translationTruncated ? { translationTruncated: true } : {}),
    ...(translator ? { translator } : {}),
    ...(reviewer ? { reviewer } : {}),
  };
}

/** Stored entries, or undefined when the file is not a valid board. */
export function parseBoard(raw: string): BoardEntry[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const record = data as { version?: unknown; entries?: unknown };
  if (record.version !== BOARD_VERSION || !Array.isArray(record.entries)) {
    return undefined;
  }
  const entries: BoardEntry[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const value of record.entries) {
    const entry = readEntry(value);
    // A repeated id means the file cannot be trusted as a whole. A repeated
    // answer key is only obsolete data: the first copy wins.
    if (!entry || ids.has(entry.id)) return undefined;
    ids.add(entry.id);
    const key = boardEntryKey(entry);
    if (keys.has(key)) continue;
    keys.add(key);
    entries.push(entry);
  }
  // The file is newest first, so the first BOARD_LIMIT entries are kept.
  return entries.slice(0, BOARD_LIMIT);
}

/** Board file text. Throws instead of writing an invalid entry. */
export function serializeBoard(entries: BoardEntry[]): string {
  if (entries.length > BOARD_LIMIT) throw new Error("invalid board size");
  const stored = entries.map((entry) => {
    const normalized = makeBoardEntry(entry);
    if (!normalized) throw new Error("invalid board entry");
    return normalized;
  });
  return JSON.stringify({ version: BOARD_VERSION, entries: stored }, null, 1);
}

export function isBoardFull(entries: readonly BoardEntry[]): boolean {
  return entries.length >= BOARD_LIMIT;
}

function readEntry(value: unknown): BoardEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return makeBoardEntry(value as unknown as BoardEntryInput);
}

function requiredText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** undefined = absent, null = present but not a boolean. */
function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

/** undefined = absent or blank, null = present but not a string. */
function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, max);
  return text || undefined;
}

function clip(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

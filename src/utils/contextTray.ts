import type { PromptImage } from "./protocol";

export type ContextItemKind = "text" | "figure" | "table" | "equation";

export type ContextItem = {
  id: string;
  kind: ContextItemKind;
  /** Clean text, LaTeX formula, Markdown table, or excerpt. */
  text: string;
  /** Optional caption for figures or tables. */
  caption?: string;
  /** Optional reader comment (e.g. from a Zotero annotation). */
  comment?: string;
  /** 1-based page number when known. */
  page?: number;
  /** Optional multimodal image payload attached for vision models. */
  image?: PromptImage;
  /** Optional short scope tag such as "整段". */
  label?: string;
};

export type ContextItemInput = Omit<ContextItem, "id">;

export const MAX_CONTEXT_ITEMS = 12;

let nextId = 1;

function normalizeKeyText(value: string | undefined): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** Deterministic deduplication key so repeated clicks never stack duplicates. */
export function contextItemKey(item: ContextItemInput): string {
  const imgSig = item.image
    ? `${item.image.mimeType}:${item.image.data.length}:${item.image.data.slice(0, 48)}:${item.image.data.slice(-24)}`
    : "";
  return [
    item.kind,
    item.page ?? "",
    normalizeKeyText(item.text),
    normalizeKeyText(item.caption),
    normalizeKeyText(item.comment),
    imgSig,
  ].join("|");
}

/**
 * Append a new context item to the tray unless an identical item is already
 * present. Enforces `MAX_CONTEXT_ITEMS` by keeping the newest items.
 */
export function addContextItem(
  list: readonly ContextItem[],
  incoming: ContextItemInput,
): { items: ContextItem[]; added: boolean; duplicate: boolean } {
  const cleaned: ContextItemInput = {
    kind: incoming.kind,
    text: String(incoming.text || "").trim(),
    ...(incoming.caption?.trim() ? { caption: incoming.caption.trim() } : {}),
    ...(incoming.comment?.trim() ? { comment: incoming.comment.trim() } : {}),
    ...(incoming.page && incoming.page > 0 ? { page: incoming.page } : {}),
    ...(incoming.image?.data ? { image: incoming.image } : {}),
    ...(incoming.label?.trim() ? { label: incoming.label.trim() } : {}),
  };
  if (!cleaned.text && !cleaned.caption && !cleaned.comment && !cleaned.image) {
    return { items: [...list], added: false, duplicate: false };
  }
  const key = contextItemKey(cleaned);
  if (list.some((existing) => contextItemKey(existing) === key)) {
    return { items: [...list], added: false, duplicate: true };
  }
  const created: ContextItem = {
    id: `ctx_${nextId++}`,
    ...cleaned,
  };
  const next = [...list, created];
  if (next.length > MAX_CONTEXT_ITEMS) {
    next.splice(0, next.length - MAX_CONTEXT_ITEMS);
  }
  return { items: next, added: true, duplicate: false };
}

export function removeContextItem(
  list: readonly ContextItem[],
  id: string,
): ContextItem[] {
  return list.filter((item) => item.id !== id);
}

export function extractContextImages(
  items: readonly ContextItem[],
): PromptImage[] {
  const images: PromptImage[] = [];
  for (const item of items) {
    if (item.image?.data) images.push(item.image);
  }
  return images;
}

function kindHeading(kind: ContextItemKind): string {
  if (kind === "figure") return "Figure";
  if (kind === "table") return "Table";
  if (kind === "equation") return "Equation";
  return "Text";
}

/**
 * Format all staged context items into a clean, clearly labeled block for the
 * model. Single plain-text items stay concise; multi-item or multimodal trays
 * get numbered headers with page numbers, captions, and visual image hints.
 */
export function formatContextItemsForPrompt(
  items: readonly ContextItem[],
  includeImageHint: boolean,
): string {
  if (!items.length) return "";
  if (
    items.length === 1 &&
    items[0].kind === "text" &&
    !items[0].image &&
    !items[0].comment &&
    !items[0].caption
  ) {
    return items[0].text;
  }
  const blocks: string[] = [];
  let imageIndex = 0;
  items.forEach((item, idx) => {
    const num = idx + 1;
    const headParts = [`[${num}] ${kindHeading(item.kind)}`];
    if (item.label) headParts.push(item.label);
    if (item.page) headParts.push(`p. ${item.page}`);
    if (item.image) {
      imageIndex += 1;
      headParts.push(
        includeImageHint
          ? `attached image #${imageIndex}`
          : "image omitted in text-only fallback",
      );
    }
    const lines = [headParts.join(" · ")];
    if (item.caption) lines.push(`Caption: ${item.caption}`);
    if (item.text) lines.push(item.text);
    if (item.comment) lines.push(`Reader note: ${item.comment}`);
    blocks.push(lines.join("\n"));
  });
  return blocks.join("\n\n");
}

/** Compact one-line summary of attached context items for the chat transcript. */
export function summarizeContextItems(
  items: readonly ContextItem[],
  kindLabels: Record<ContextItemKind, string>,
): string {
  if (!items.length) return "";
  if (items.length === 1 && items[0].kind === "text" && items[0].text) {
    const flat = items[0].text.replace(/\s+/g, " ").trim();
    const short = flat.length > 48 ? flat.slice(0, 48).trimEnd() + "…" : flat;
    return `“${short}”`;
  }
  const labels = items.slice(0, 3).map((item) => {
    const k = kindLabels[item.kind] || item.kind;
    return item.page ? `${k}(p.${item.page})` : k;
  });
  const suffix = items.length > 3 ? ` +${items.length - 3}` : "";
  return `[${labels.join(" + ")}${suffix}]`;
}

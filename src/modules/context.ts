import type { ResolvedConfig } from "../utils/config";
import { asItem, getActiveReader } from "../utils/reader";
import {
  cosine,
  interpolate,
  splitText,
  templateKeys,
  type ContextPack,
} from "../utils/text";
import { canEmbed, embedTexts, embeddingIdentity } from "./llm";
import { getPDFPlainText, getPDFSelection } from "./pdf";

/** What the user is looking at: metadata item plus the PDF to read from. */
export type Target = {
  /** Conversation key; one conversation per regular item. */
  key: string;
  label: string;
  item?: Zotero.Item;
  attachment?: Zotero.Item;
};

export type RenderedPrompt = {
  /** Sent on the turn it was made for. */
  prompt: string;
  /** Resent on later turns, with retrieved excerpts left out. */
  compact: string;
  /** Long source translation, streamed in verified pieces. */
  translation?: {
    source: string;
    promptFor: (piece: string) => Promise<string>;
  };
  /**
   * Local metadata for a real translation. Quick keeps the existing single
   * request; collaborative is the only mode that adds a review pass.
   * `source` is the text itself, never the rendered prompt.
   */
  translationRequest?: { mode: "quick" | "collaborative"; source: string };
};

/**
 * The reader tab wins over the library selection: while a PDF is open the
 * items list keeps whatever was selected before, which is often a
 * different paper.
 */
export function getActiveTarget(): Target {
  const reader = getActiveReader();
  if (reader?.itemID) {
    const attachment = asItem(Zotero.Items.get(reader.itemID));
    if (attachment)
      return targetFor(attachment.parentItem || attachment, attachment);
  }
  let selected: Zotero.Item[] = [];
  try {
    selected = Zotero.getActiveZoteroPane()?.getSelectedItems?.() || [];
  } catch {
    // pane may be unavailable
  }
  const first = selected[0];
  if (first?.isAttachment()) return targetFor(first.parentItem || first, first);
  if (first) return targetFor(first);
  return { key: "none", label: "" };
}

export function targetFor(item: Zotero.Item, attachment?: Zotero.Item): Target {
  return {
    key: `${item.libraryID}/${item.key}`,
    label: item.getDisplayTitle(),
    item,
    attachment,
  };
}

export async function renderTemplate(
  template: string,
  input: string,
  target: Target,
  config: ResolvedConfig,
  /** The selection as captured by the caller (the reader's popup). */
  selection?: string,
): Promise<RenderedPrompt> {
  const pack = await collectContext(
    template,
    input,
    target,
    config,
    true,
    selection,
  );
  return {
    prompt: interpolate(template, pack).trim(),
    compact: interpolate(template, compactPack(pack)).trim(),
  };
}

/** Later turns resend the question without the bulky document text. */
function compactPack(pack: ContextPack): ContextPack {
  return {
    ...pack,
    related: pack.related ? "(excerpts omitted)" : "",
    fulltext: pack.fulltext ? "(full text omitted)" : "",
  };
}

export const CONTEXT_MODES = [
  "chat",
  "related",
  "fulltext",
  "abstract",
] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

const QUESTION_CONTEXT: Record<
  Exclude<ContextMode, "chat">,
  { key: "related" | "fulltext" | "abstract"; heading: string }
> = {
  related: {
    key: "related",
    heading: "Relevant excerpts (cite them as [n] when you use them):",
  },
  fulltext: { key: "fulltext", heading: "Full text:" },
  abstract: { key: "abstract", heading: "Abstract:" },
};

/**
 * A typed question in the given context mode. Sections that come out empty
 * are left out; without an item every mode is plain chat.
 */
export async function renderQuestion(
  input: string,
  target: Target,
  mode: ContextMode,
  config: ResolvedConfig,
  selection?: string,
): Promise<RenderedPrompt> {
  if (mode === "chat" || !target.item) {
    const quoted = selection?.trim();
    if (!quoted) return { prompt: input, compact: input };
    const body = `Selected text:\n${quoted}\n\nQuestion:\n${input}`;
    return { prompt: body, compact: body };
  }
  const { key, heading } = QUESTION_CONTEXT[mode];
  // The question is about the document, so rank the document's passages
  // even when some text is selected; the selection is quoted separately.
  const pack = await collectContext(
    `{{${key}}}`,
    input,
    target,
    config,
    false,
    selection,
  );
  const compose = (source: ContextPack) => {
    const year = source.year ? ` (${source.year})` : "";
    return [
      `Item: ${source.title}${year}`,
      source[key] && `${heading}\n${source[key]}`,
      source.selection && `Selected text:\n${source.selection}`,
      `Question:\n${source.input}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  };
  return { prompt: compose(pack), compact: compose(compactPack(pack)) };
}

async function collectContext(
  template: string,
  input: string,
  target: Target,
  config: ResolvedConfig,
  selectionAsCorpus: boolean,
  selectionOverride?: string,
): Promise<ContextPack> {
  const { item } = target;
  const selection = selectionOverride?.trim() || getPDFSelection();
  const pack: ContextPack = {
    input,
    selection,
    abstract: String(item?.getField("abstractNote") || ""),
    title: String(item?.getDisplayTitle() || ""),
    authors: (item?.getCreators() || [])
      .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
      .filter(Boolean)
      .join(", "),
    year: getYear(item),
    related: "",
    fulltext: "",
  };

  // Retrieval extracts the PDF and calls the embeddings API; only pay for
  // it when the template will show the result.
  const keys = templateKeys(template);
  if (keys.has("related")) {
    try {
      pack.related = await getRelatedText(
        target,
        input || selection || pack.title,
        selectionAsCorpus ? selection : "",
        config,
      );
    } catch (error) {
      ztoolkit.log("[Glossa] related text failed", error);
    }
  }
  if (keys.has("fulltext")) {
    try {
      pack.fulltext = (await getDocIndex(target))?.text || "";
    } catch (error) {
      ztoolkit.log("[Glossa] full text failed", error);
    }
  }
  return pack;
}

/** "year" is not an item field; it is the first part of the parsed date. */
function getYear(item?: Zotero.Item) {
  const year = String(item?.getField("date", true, true) || "").slice(0, 4);
  return /^\d{4}$/.test(year) && year !== "0000" ? year : "";
}

type DocIndex = {
  chunks: string[];
  /** The start of the document for {{fulltext}}, already truncated. */
  text?: string;
  vectors?: Float32Array[];
  vectorKey?: string;
};

/** Enough for a book-length PDF; beyond this the tail is not indexed. */
const MAX_CHUNKS = 400;
/** Roughly 25k tokens; longer documents are cut, with a note. */
const FULLTEXT_LIMIT = 100_000;
const MAX_CACHED_DOCS = 12;
const indexCache = new Map<string, DocIndex>();

async function getRelatedText(
  target: Target,
  query: string,
  selection: string,
  config: ResolvedConfig,
): Promise<string> {
  const index =
    selection.length > 40
      ? { chunks: splitText(selection) }
      : await getDocIndex(target);
  if (!index?.chunks.length) return "";
  const { chunks } = index;
  const k = Math.max(1, config.relatedNumber);
  if (chunks.length <= k || !query.trim()) {
    return formatChunks(chunks.slice(0, k));
  }

  if (canEmbed(config)) {
    try {
      const vectors = await ensureVectors(index, config);
      const [qVec] = await embedTexts(config, [query]);
      const ranked = chunks
        .map((text, i) => ({ text, score: cosine(qVec, vectors[i] || []) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
      return formatChunks(ranked.map((row) => row.text));
    } catch (error) {
      ztoolkit.log("[Glossa] embedding ranking failed, using keywords", error);
    }
  }
  return formatChunks(rankByKeywords(chunks, query, k));
}

function rankByKeywords(chunks: string[], query: string, k: number) {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 3);
  return chunks
    .map((text) => ({
      text,
      score: words.filter((word) => text.toLowerCase().includes(word)).length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((row) => row.text);
}

/** Chunks of the target's PDF, extracted once per file version. */
async function getDocIndex(target: Target): Promise<DocIndex | undefined> {
  const attachment = target.attachment || findPDFAttachment(target.item);
  if (attachment?.isPDFAttachment()) {
    const mtime = await attachment.attachmentModificationTime;
    const cacheKey = `${attachment.libraryID}/${attachment.key}@${mtime ?? 0}`;
    const hit = indexCache.get(cacheKey);
    if (hit) {
      // refresh LRU position
      indexCache.delete(cacheKey);
      indexCache.set(cacheKey, hit);
      return hit;
    }
    const text = await getPDFPlainText(attachment);
    if (text.trim()) {
      const all = splitText(text);
      if (all.length > MAX_CHUNKS) {
        ztoolkit.log(
          `[Glossa] indexing first ${MAX_CHUNKS} of ${all.length} chunks`,
        );
      }
      const flat = text.replace(/[ \t]+/g, " ").trim();
      const index: DocIndex = {
        chunks: all.slice(0, MAX_CHUNKS),
        text:
          flat.length > FULLTEXT_LIMIT
            ? `${flat.slice(0, FULLTEXT_LIMIT)}\n[… truncated: first ${FULLTEXT_LIMIT} of ${flat.length} characters]`
            : flat,
      };
      indexCache.set(cacheKey, index);
      if (indexCache.size > MAX_CACHED_DOCS) {
        indexCache.delete(indexCache.keys().next().value!);
      }
      return index;
    }
  }
  const abstract = String(target.item?.getField("abstractNote") || "");
  return abstract ? { chunks: splitText(abstract) } : undefined;
}

function findPDFAttachment(item?: Zotero.Item) {
  if (!item || item.isAttachment()) return undefined;
  return item
    .getAttachments()
    .map((id) => asItem(Zotero.Items.get(id)))
    .find((att) => att?.isPDFAttachment());
}

/** Chunk vectors are computed once per document and embedding model. */
async function ensureVectors(index: DocIndex, config: ResolvedConfig) {
  const vectorKey = embeddingIdentity(config);
  if (index.vectors && index.vectorKey === vectorKey) return index.vectors;
  const raw = await embedTexts(config, index.chunks);
  index.vectors = raw.map((vector) => Float32Array.from(vector));
  index.vectorKey = vectorKey;
  return index.vectors;
}

function formatChunks(chunks: string[]) {
  return chunks.map((chunk, index) => `[${index + 1}] ${chunk}`).join("\n\n");
}

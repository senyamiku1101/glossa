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
): Promise<RenderedPrompt> {
  const pack = await collectContext(template, input, target, config);
  return {
    prompt: interpolate(template, pack).trim(),
    compact: interpolate(template, {
      ...pack,
      related: pack.related ? "(excerpts omitted)" : "",
    }).trim(),
  };
}

async function collectContext(
  template: string,
  input: string,
  target: Target,
  config: ResolvedConfig,
): Promise<ContextPack> {
  const { item } = target;
  const selection = getPDFSelection();
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
  };

  // Retrieval extracts the PDF and calls the embeddings API; only pay for
  // it when the template will show the result.
  if (templateKeys(template).has("related")) {
    try {
      pack.related = await getRelatedText(
        target,
        input || selection || pack.title,
        selection,
        config,
      );
    } catch (error) {
      ztoolkit.log("[Glossa] related text failed", error);
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
  vectors?: Float32Array[];
  vectorKey?: string;
};

/** Enough for a book-length PDF; beyond this the tail is not indexed. */
const MAX_CHUNKS = 400;
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
      const index: DocIndex = { chunks: all.slice(0, MAX_CHUNKS) };
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

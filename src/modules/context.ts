import type { ResolvedConfig } from "../utils/config";
import {
  extractContextImages,
  formatContextItemsForPrompt,
  type ContextItem,
} from "../utils/contextTray";
import type { PromptImage } from "../utils/protocol";
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
import { readSettings } from "./markdownPrep/settings";
import {
  getBodyCacheTag,
  readBodyForContext,
  type ContextBody,
} from "./markdownPrep/store";
import { getStateForPDF } from "./markdownPrep/queue";

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
  /** Transient multimodal images attached to this turn's user prompt only. */
  images?: PromptImage[];
  /** Optional text-only fallback prompt if a text-only model rejects image payloads. */
  imageFallbackPrompt?: string;
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
  /** Optional multi-item context staged in the composer tray (text + images). */
  attachments?: readonly ContextItem[],
): Promise<RenderedPrompt> {
  const images = attachments?.length ? extractContextImages(attachments) : [];
  const effectiveSelection = attachments?.length
    ? formatContextItemsForPrompt(attachments, images.length > 0)
    : selection;
  const pack = await collectContext(
    template,
    input,
    target,
    config,
    true,
    effectiveSelection,
  );
  const prompt = interpolate(template, pack).trim();
  const compact = interpolate(template, compactPack(pack)).trim();
  if (!images.length) return { prompt, compact };
  const fallbackSelection = formatContextItemsForPrompt(attachments!, false);
  const fallbackPack: ContextPack = { ...pack, selection: fallbackSelection };
  const imageFallbackPrompt = interpolate(template, fallbackPack).trim();
  return {
    prompt,
    compact,
    images,
    ...(imageFallbackPrompt ? { imageFallbackPrompt } : {}),
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
  attachments?: readonly ContextItem[],
): Promise<RenderedPrompt> {
  const images = attachments?.length ? extractContextImages(attachments) : [];
  const formattedWithImages = attachments?.length
    ? formatContextItemsForPrompt(attachments, images.length > 0)
    : selection?.trim() || "";
  const formattedFallback = attachments?.length
    ? formatContextItemsForPrompt(attachments, false)
    : formattedWithImages;
  const contextLabel =
    attachments && (attachments.length > 1 || attachments[0]?.kind !== "text")
      ? "Selected context:"
      : "Selected text:";

  if (mode === "chat" || !target.item) {
    if (!formattedWithImages && !images.length) {
      return { prompt: input, compact: input };
    }
    const title = String(target.item?.getDisplayTitle() || "").trim();
    const year = getYear(target.item);
    const header = title ? `Item: ${title}${year ? ` (${year})` : ""}` : "";
    const buildBody = (ctx: string) =>
      [header, ctx && `${contextLabel}\n${ctx}`, `Question:\n${input}`]
        .filter(Boolean)
        .join("\n\n");
    const body = buildBody(formattedWithImages);
    const fallbackBody = buildBody(formattedFallback);
    return {
      prompt: body,
      compact: fallbackBody,
      ...(images.length ? { images, imageFallbackPrompt: fallbackBody } : {}),
    };
  }
  const { key, heading } = QUESTION_CONTEXT[mode];
  // The question explicitly requested document-wide context (either no staged
  // items with "Use current paper" ON, or staged items with "+ Search full paper" ON).
  const pack = await collectContext(
    `{{${key}}}`,
    input,
    target,
    config,
    false,
    formattedWithImages,
  );
  const compose = (source: ContextPack, ctxText: string) => {
    const year = source.year ? ` (${source.year})` : "";
    return [
      `Item: ${source.title}${year}`,
      source[key] && `${heading}\n${source[key]}`,
      ctxText && `${contextLabel}\n${ctxText}`,
      `Question:\n${source.input}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  };
  const prompt = compose(pack, pack.selection);
  const compact = compose(
    compactPack(pack),
    formattedFallback || pack.selection,
  );
  const fallbackPrompt = compose(pack, formattedFallback || pack.selection);
  return {
    prompt,
    compact,
    ...(images.length ? { images, imageFallbackPrompt: fallbackPrompt } : {}),
  };
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
  const selection =
    selectionOverride !== undefined
      ? selectionOverride.trim()
      : getPDFSelection();
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

type KeywordToken = { token: string; bounded: boolean };

function extractKeywords(query: string): KeywordToken[] {
  const seen = new Set<string>();
  const out: KeywordToken[] = [];
  const add = (token: string, bounded: boolean) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    out.push({ token, bounded });
  };
  for (const match of query.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]*/g)) {
    const raw = match[0];
    const lower = raw.toLowerCase();
    if (lower.length > 3) {
      add(lower, false);
    } else if (raw.length >= 2 && (/[A-Z]/.test(raw) || /\d/.test(raw))) {
      // Preserve short technical acronyms/codes such as PDF, CFD, LLM, 3D, v2.
      add(lower, true);
    }
  }
  const cjkStop = new Set([
    "的",
    "了",
    "是",
    "在",
    "和",
    "与",
    "及",
    "或",
    "把",
    "被",
    "对",
    "中",
    "有",
    "这",
    "那",
    "个",
    "吗",
    "呢",
    "吧",
  ]);
  for (const match of query.matchAll(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
  )) {
    const run = [...match[0]].filter((ch) => !cjkStop.has(ch)).join("");
    if (run.length === 1) {
      add(run, false);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        add(run.slice(i, i + 2), false);
      }
    }
  }
  return out;
}

export function rankByKeywords(chunks: string[], query: string, k: number) {
  const keywords = extractKeywords(query);
  if (!keywords.length) return chunks.slice(0, k);
  const patterns = keywords.map(({ token, bounded }) =>
    bounded
      ? new RegExp(
          `(?<![a-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_])`,
          "i",
        )
      : token,
  );
  return chunks
    .map((text) => {
      const lower = text.toLowerCase();
      let score = 0;
      for (const pattern of patterns) {
        if (
          typeof pattern === "string"
            ? lower.includes(pattern)
            : pattern.test(text)
        ) {
          score += 1;
        }
      }
      return { text, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((row) => row.text);
}

/** Chunks of the target's PDF, extracted once per file version. */
async function getDocIndex(target: Target): Promise<DocIndex | undefined> {
  const attachment = target.attachment || findPDFAttachment(target.item);
  if (attachment?.isPDFAttachment()) {
    const state = getStateForPDF(attachment);
    const mtime = await attachment.attachmentModificationTime;
    // The generated body changes independently of the PDF file, so its
    // identity participates in the index cache key: a re-converted (or
    // synced/edited/migrated) body must re-index. The bundle body file's own
    // size/mtime is included so even a journal-less WebDAV download re-indexes.
    const hostedTag = await getBodyCacheTag(attachment, state);
    const cacheKey = `${attachment.libraryID}/${attachment.key}@${mtime ?? 0}${hostedTag}`;
    const hit = indexCache.get(cacheKey);
    if (hit) {
      // refresh LRU position
      indexCache.delete(cacheKey);
      indexCache.set(cacheKey, hit);
      return hit;
    }
    // Prepared Markdown wins over re-extracting the PDF, but only when it still
    // matches the current source file. A stale/missing/invalid bundle falls back
    // to a legacy body, then to the existing extractor below; this read path
    // never uploads anything and never writes.
    const settings = readSettings();
    if (settings.readContext) {
      const hosted = await readBodyForContext(attachment, {
        legacyAttachmentKey: state?.hostedAttachmentKey,
        fingerprint: state?.source,
        // The working cache is a fallback only for a read-only library, where a
        // bundle cannot be written. A missing product in a writable library
        // falls back to the normal PDF text path instead.
        allowCache: state?.status === "read-only",
      });
      if (hosted?.fresh) {
        const index = hostedDocIndex(hosted);
        rememberIndex(cacheKey, index);
        return index;
      }
      if (hosted && !hosted.fresh) {
        ztoolkit.log(
          "[Glossa] prepared Markdown is stale; falling back to PDF text",
        );
      }
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
      rememberIndex(cacheKey, index);
      return index;
    }
  }
  const abstract = String(target.item?.getField("abstractNote") || "");
  return abstract ? { chunks: splitText(abstract) } : undefined;
}

function rememberIndex(cacheKey: string, index: DocIndex) {
  indexCache.set(cacheKey, index);
  if (indexCache.size > MAX_CACHED_DOCS) {
    indexCache.delete(indexCache.keys().next().value!);
  }
}

/** Human/trace-visible provenance line for a prepared Markdown body. */
function hostedSourceLabel(hosted: ContextBody): string {
  const parts = [
    "Glossa Markdown",
    hosted.meta.quality,
    `${hosted.meta.pageCount || "?"} pages`,
  ];
  if (hosted.origin === "cache") parts.push("cached");
  else if (hosted.origin === "hosted-md") parts.push("Markdown attachment");
  if (hosted.userModified) parts.push("user-edited");
  return `[Source: ${parts.join(" · ")}]`;
}

/**
 * Turn the prepared Markdown into the same chunk/text structure the extractor
 * path produces. Page comments become `(p.N)` chunk prefixes; HTML comments
 * are stripped from the text sent to the model.
 */
function hostedDocIndex(hosted: ContextBody): DocIndex {
  const { body, sections } = splitPreparedMarkdown(hosted.markdown);
  const chunks: string[] = [];
  if (sections.length) {
    for (const section of sections) {
      for (const chunk of splitText(section.text)) {
        chunks.push(section.label ? `(p.${section.label}) ${chunk}` : chunk);
        if (chunks.length >= MAX_CHUNKS) break;
      }
      if (chunks.length >= MAX_CHUNKS) break;
    }
  } else {
    chunks.push(...splitText(body).slice(0, MAX_CHUNKS));
  }
  const flat = body.replace(/[ \t]+/g, " ").trim();
  const truncated = flat.length > FULLTEXT_LIMIT;
  const text = [
    hostedSourceLabel(hosted),
    truncated
      ? `${flat.slice(0, FULLTEXT_LIMIT)}\n[… truncated: first ${FULLTEXT_LIMIT} of ${flat.length} characters]`
      : flat,
  ].join("\n");
  return { chunks, text };
}

type PreparedSection = { label: string; text: string };

/**
 * Strip our metadata/page comments and group the body by page, so excerpt
 * chunks can carry the page they came from. A body without page markers is
 * returned as one unlabelled section.
 */
export function splitPreparedMarkdown(markdown: string): {
  body: string;
  sections: PreparedSection[];
} {
  const pageRe = /^<!--\s*page\s+(\d+)(?:\s*\(printed\s+(.+?)\))?\s*-->$/i;
  const sections: PreparedSection[] = [];
  const bodyLines: string[] = [];
  let current: { label: string; lines: string[] } | undefined;
  // Remove multi-line comments as well, preserving only page delimiters.
  const visible = markdown.replace(/<!--[\s\S]*?-->/g, (comment) =>
    pageRe.test(comment.trim()) ? comment : "",
  );
  for (const rawLine of visible.split(/\r?\n/)) {
    const line = rawLine.trim();
    const page = pageRe.exec(line);
    if (page) {
      if (current) {
        sections.push({
          label: current.label,
          text: current.lines.join("\n").trim(),
        });
      }
      const printed = page[2]?.trim();
      current = { label: printed || page[1], lines: [] };
      continue;
    }
    // Drop every remaining HTML comment (metadata/caveat notes).
    const cleaned = rawLine.replace(/<!--[\s\S]*?-->/g, "");
    if (!cleaned.trim()) continue;
    bodyLines.push(cleaned);
    if (current) current.lines.push(cleaned);
  }
  if (current) {
    sections.push({
      label: current.label,
      text: current.lines.join("\n").trim(),
    });
  }
  return { body: bodyLines.join("\n"), sections };
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

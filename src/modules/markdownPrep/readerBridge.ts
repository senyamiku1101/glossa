/**
 * Runtime glue connecting Zotero's PDF reader selections and annotations to
 * the paper's prepared Markdown + unified position map (`blocks.json`).
 */
import type { PromptImage } from "../../utils/protocol";
import type { Target } from "../context";
import { getPdfPageViewBox } from "../pdfLayout";
import { readBytes } from "./journal";
import { sniffImageMime } from "./paddleAssets";
import { getStateForPDF } from "./queue";
import {
  alignRegionToVisual,
  alignSelectionToMarkdown,
  fractionRectToPdfRect,
  listPageVisualTargets,
  type AlignedSelection,
  type AlignedVisualRegion,
  type PageVisualTarget,
} from "./readerAlign";
import { readSettings } from "./settings";
import {
  isLibraryWritable,
  readPreparedAsset,
  readPreparedLayout,
  type PreparedLayout,
} from "./store";

const MAX_VISION_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_LAYOUTS = 4;

type LayoutCacheEntry = {
  key: string;
  layout: PreparedLayout;
  visualByPage: Map<number, PageVisualTarget[]>;
};

const layoutCache = new Map<string, LayoutCacheEntry>();

export function invalidateReaderLayoutCache(cacheId?: string): void {
  if (cacheId) layoutCache.delete(cacheId);
  else layoutCache.clear();
}

/**
 * Synchronous version token for an attachment's prepared layout state so
 * lightweight UI caches (like the hover overlay) refresh as soon as Markdown
 * conversion finishes or is cleared without reopening the PDF tab.
 */
export function getReaderLayoutVersion(target: Target): string {
  const attachment = target.attachment;
  if (!attachment?.isPDFAttachment()) return "";
  const state = getStateForPDF(attachment);
  return `${attachment.libraryID}/${attachment.key}|${state?.updatedAt ?? 0}|${state?.status ?? ""}|${state?.hostedAttachmentKey ?? ""}`;
}

function copyRects(raw?: readonly number[][]): number[][] | undefined {
  if (!raw) return undefined;
  const len = raw.length;
  if (!Number.isSafeInteger(len) || len <= 0 || len > 5000) return undefined;
  const out: number[][] = [];
  for (let i = 0; i < len; i++) {
    const r = raw[i];
    if (!r || r.length !== 4) continue;
    const a = r[0];
    const b = r[1];
    const c = r[2];
    const d = r[3];
    if (
      typeof a === "number" &&
      typeof b === "number" &&
      typeof c === "number" &&
      typeof d === "number" &&
      Number.isFinite(a) &&
      Number.isFinite(b) &&
      Number.isFinite(c) &&
      Number.isFinite(d)
    ) {
      out.push([a, b, c, d]);
    }
  }
  return out.length ? out : undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      alphabet[(n >>> 18) & 63] +
      alphabet[(n >>> 12) & 63] +
      alphabet[(n >>> 6) & 63] +
      alphabet[n & 63];
  }
  if (i < bytes.length) {
    const remaining = bytes.length - i;
    const n = (bytes[i] << 16) | (remaining === 2 ? bytes[i + 1] << 8 : 0);
    out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63];
    out += remaining === 2 ? alphabet[(n >>> 6) & 63] + "=" : "==";
  }
  return out;
}

async function loadPreparedEntry(
  attachment: Zotero.Item | undefined,
): Promise<LayoutCacheEntry | undefined> {
  if (!attachment?.isPDFAttachment()) return undefined;
  const settings = readSettings();
  if (!settings.readContext) return undefined;
  const state = getStateForPDF(attachment);
  const mtime = (await attachment.attachmentModificationTime) ?? 0;
  const cacheId = `${attachment.libraryID}/${attachment.key}`;
  const versionKey = `${mtime}|${state?.updatedAt ?? 0}|${state?.hostedAttachmentKey ?? ""}`;
  const hit = layoutCache.get(cacheId);
  if (hit && hit.key === versionKey) {
    layoutCache.delete(cacheId);
    layoutCache.set(cacheId, hit);
    return hit;
  }
  const layout = await readPreparedLayout(attachment, {
    legacyAttachmentKey: state?.hostedAttachmentKey,
    fingerprint: state?.source,
    allowCache: state?.status === "read-only",
  });
  if (!layout) {
    layoutCache.delete(cacheId);
    return undefined;
  }
  const entry: LayoutCacheEntry = {
    key: versionKey,
    layout,
    visualByPage: new Map(),
  };
  layoutCache.set(cacheId, entry);
  if (layoutCache.size > MAX_CACHED_LAYOUTS) {
    const oldest = layoutCache.keys().next().value;
    if (oldest !== undefined) layoutCache.delete(oldest);
  }
  return entry;
}

async function loadPreparedLayout(
  attachment: Zotero.Item | undefined,
): Promise<PreparedLayout | undefined> {
  return (await loadPreparedEntry(attachment))?.layout;
}

/**
 * Try aligning a Zotero PDF text selection to the paper's prepared Markdown
 * position map. Returns `undefined` when no fresh Markdown exists or the match
 * is not confirmed, letting callers fall back to native PDF text cleanly.
 */
export async function resolveSelectionMarkdown(
  reader: _ZoteroTypes.ReaderInstance,
  target: Target,
  selection: string,
  pageIndex: number | undefined,
  rects?: readonly number[][],
  nextPageRects?: readonly number[][],
): Promise<AlignedSelection | undefined> {
  if (pageIndex === undefined || pageIndex < 0 || !Number.isInteger(pageIndex))
    return undefined;
  try {
    const layout = await loadPreparedLayout(target.attachment);
    if (!layout) return undefined;
    const safeRects = copyRects(rects);
    const safeNextRects = copyRects(nextPageRects);
    const viewBox = safeRects
      ? await getPdfPageViewBox(reader, pageIndex)
      : undefined;
    const nextViewBox = safeNextRects
      ? await getPdfPageViewBox(reader, pageIndex + 1)
      : undefined;
    const aligned = alignSelectionToMarkdown({
      markdown: layout.markdown,
      blocks: layout.blocks,
      pageIndex,
      selection,
      rects: safeRects,
      nextPageRects: safeNextRects,
      viewBox,
      nextViewBox,
    });
    return aligned.kind === "matched" ? aligned : undefined;
  } catch (error) {
    ztoolkit.log("[Glossa] Markdown selection alignment failed", error);
    return undefined;
  }
}

export type ResolvedAnnotationContext =
  | {
      kind: "visual";
      visualKind: AlignedVisualRegion["kind"];
      page?: number;
      image?: PromptImage;
      caption?: string;
      markdownText?: string;
      comment?: string;
    }
  | {
      kind: "text";
      page?: number;
      text: string;
      paragraphText?: string;
      fromMarkdown: boolean;
      comment?: string;
    };

async function readZoteroAnnotationImage(
  annotationItem: Zotero.Item,
): Promise<PromptImage | undefined> {
  try {
    const path = Zotero.Annotations.getCacheImagePath({
      libraryID: annotationItem.libraryID,
      key: annotationItem.key,
    });
    if (!path) return undefined;
    const bytes = await readBytes(path);
    if (!bytes || !bytes.byteLength || bytes.byteLength > MAX_VISION_BYTES)
      return undefined;
    const mime = sniffImageMime(bytes) || "image/png";
    return { mimeType: mime, data: bytesToBase64(bytes) };
  } catch {
    return undefined;
  }
}

function parseAnnotationPosition(raw: string | undefined): {
  pageIndex?: number;
  rects?: number[][];
  nextPageRects?: number[][];
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      pageIndex?: unknown;
      rects?: unknown;
      nextPageRects?: unknown;
    };
    const pageIndex =
      typeof parsed.pageIndex === "number" &&
      Number.isInteger(parsed.pageIndex) &&
      parsed.pageIndex >= 0
        ? parsed.pageIndex
        : undefined;
    const rects = Array.isArray(parsed.rects)
      ? copyRects(parsed.rects as number[][])
      : undefined;
    const nextPageRects = Array.isArray(parsed.nextPageRects)
      ? copyRects(parsed.nextPageRects as number[][])
      : undefined;
    return { pageIndex, rects, nextPageRects };
  } catch {
    return {};
  }
}

/**
 * Resolve rich context for a Zotero PDF annotation (area/image or text
 * highlight), combining the prepared position map's crisp figure/caption/LaTeX
 * with Zotero's own cropped annotation cache image when needed.
 */
export async function resolveAnnotationContext(
  reader: _ZoteroTypes.ReaderInstance,
  target: Target,
  annotationItem: Zotero.Item,
): Promise<ResolvedAnnotationContext | undefined> {
  const type = annotationItem.annotationType;
  const comment =
    String(annotationItem.annotationComment || "").trim() || undefined;
  const text = String(annotationItem.annotationText || "").trim();
  const { pageIndex, rects, nextPageRects } = parseAnnotationPosition(
    annotationItem.annotationPosition,
  );
  const labelPage = Number(annotationItem.annotationPageLabel);
  const page =
    labelPage > 0
      ? labelPage
      : pageIndex !== undefined
        ? pageIndex + 1
        : undefined;

  const layout = await loadPreparedLayout(target.attachment);
  const viewBox =
    pageIndex !== undefined && rects?.length
      ? await getPdfPageViewBox(reader, pageIndex)
      : undefined;

  if (type === "image") {
    const visual =
      layout && pageIndex !== undefined && rects?.length
        ? alignRegionToVisual({
            markdown: layout.markdown,
            blocks: layout.blocks,
            pageIndex,
            rects,
            viewBox,
          })
        : undefined;
    let image: PromptImage | undefined;
    if (layout && visual?.assetPath) {
      const asset = await readPreparedAsset(layout, visual.assetPath);
      if (asset && asset.bytes.byteLength <= MAX_VISION_BYTES) {
        const mime = sniffImageMime(asset.bytes) || asset.mime || "image/png";
        image = { mimeType: mime, data: bytesToBase64(asset.bytes) };
      }
    }
    if (!image) {
      image = await readZoteroAnnotationImage(annotationItem);
    }
    if (!image && !visual?.markdownText && !visual?.caption && !comment) {
      return undefined;
    }
    return {
      kind: "visual",
      visualKind: visual?.kind ?? "figure",
      page,
      ...(image ? { image } : {}),
      ...(visual?.caption ? { caption: visual.caption } : {}),
      ...(visual?.markdownText ? { markdownText: visual.markdownText } : {}),
      ...(comment ? { comment } : {}),
    };
  }

  if (!text && !comment) return undefined;
  const nextViewBox =
    pageIndex !== undefined && nextPageRects?.length
      ? await getPdfPageViewBox(reader, pageIndex + 1)
      : undefined;
  const aligned =
    layout && text && pageIndex !== undefined
      ? alignSelectionToMarkdown({
          markdown: layout.markdown,
          blocks: layout.blocks,
          pageIndex,
          selection: text,
          rects,
          nextPageRects,
          viewBox,
          nextViewBox,
        })
      : undefined;
  const resolvedText =
    aligned?.kind === "matched" && aligned.selectionEnhanced
      ? aligned.selectionText
      : text || comment || "";
  return {
    kind: "text",
    page,
    text: resolvedText,
    ...(aligned?.kind === "matched"
      ? { paragraphText: aligned.paragraphText }
      : {}),
    fromMarkdown: aligned?.kind === "matched",
    ...(comment ? { comment } : {}),
  };
}

/**
 * List cached hoverable figure, table and display-equation regions on one page
 * of the active PDF. Returns an empty array when the paper has no position map.
 */
export async function loadPageVisualTargets(
  reader: _ZoteroTypes.ReaderInstance,
  target: Target,
  pageIndex: number,
): Promise<PageVisualTarget[]> {
  if (pageIndex < 0 || !Number.isInteger(pageIndex)) return [];
  try {
    const entry = await loadPreparedEntry(target.attachment);
    if (!entry || !entry.layout.blocks.length) return [];
    const cached = entry.visualByPage.get(pageIndex);
    if (cached) return cached;
    const viewBox = await getPdfPageViewBox(reader, pageIndex);
    const targets = listPageVisualTargets({
      markdown: entry.layout.markdown,
      blocks: entry.layout.blocks,
      pageIndex,
      viewBox,
    });
    entry.visualByPage.set(pageIndex, targets);
    return targets;
  } catch (error) {
    ztoolkit.log("[Glossa] loading visual targets failed", error);
    return [];
  }
}

/**
 * Prepare a hover-selected figure/table/equation for AI explanation, preferring
 * the parsed HD asset and falling back to a live canvas crop of the PDF page.
 */
export async function resolveVisualTargetForAI(
  target: Target,
  visual: PageVisualTarget,
  fallbackCrop?: { bytes: Uint8Array; mime: string },
): Promise<Extract<ResolvedAnnotationContext, { kind: "visual" }> | undefined> {
  const layout = await loadPreparedLayout(target.attachment);
  let image: PromptImage | undefined;
  if (layout && visual.assetPath) {
    const asset = await readPreparedAsset(layout, visual.assetPath);
    if (asset && asset.bytes.byteLength <= MAX_VISION_BYTES) {
      const mime = sniffImageMime(asset.bytes) || asset.mime || "image/png";
      image = { mimeType: mime, data: bytesToBase64(asset.bytes) };
    }
  }
  if (
    !image &&
    fallbackCrop &&
    fallbackCrop.bytes.byteLength <= MAX_VISION_BYTES
  ) {
    const mime =
      sniffImageMime(fallbackCrop.bytes) || fallbackCrop.mime || "image/png";
    image = { mimeType: mime, data: bytesToBase64(fallbackCrop.bytes) };
  }
  if (!image && !visual.markdownText && !visual.caption) return undefined;
  const page =
    Number(visual.block.pageLabel) > 0
      ? Number(visual.block.pageLabel)
      : visual.pageIndex + 1;
  return {
    kind: "visual",
    visualKind: visual.kind,
    page,
    ...(image ? { image } : {}),
    ...(visual.caption ? { caption: visual.caption } : {}),
    ...(visual.markdownText ? { markdownText: visual.markdownText } : {}),
  };
}

function formatAnnotationSortIndex(
  pageIndex: number,
  topFraction: number,
): string {
  const page = String(Math.max(0, Math.floor(pageIndex))).padStart(5, "0");
  const vertical = String(
    Math.max(0, Math.min(99999, Math.round(topFraction * 10000))),
  ).padStart(5, "0");
  return `${page}|000000|${vertical}`;
}

export type CreateAnnotationOutcome =
  | { ok: true; key: string }
  | { ok: false; reason: "read-only" | "no-geometry" | "failed" };

/**
 * Create a native Zotero area (`image`) annotation covering `visual.bbox`,
 * attach a crisp cache thumbnail, and focus it in the reader so the user can
 * immediately add comments or tags inside Zotero's native annotation workflow.
 */
export async function createNativeVisualAnnotation(
  reader: _ZoteroTypes.ReaderInstance,
  target: Target,
  visual: PageVisualTarget,
  fallbackCrop?: { bytes: Uint8Array; mime: string },
): Promise<CreateAnnotationOutcome> {
  const attachment = target.attachment;
  if (!attachment?.isPDFAttachment()) {
    return { ok: false, reason: "failed" };
  }
  if (!isLibraryWritable(attachment.libraryID)) {
    return { ok: false, reason: "read-only" };
  }
  try {
    const viewBox = await getPdfPageViewBox(reader, visual.pageIndex);
    const pdfRect = fractionRectToPdfRect(visual.bbox, viewBox);
    if (!pdfRect) return { ok: false, reason: "no-geometry" };
    const toolColor = (() => {
      try {
        const internal = reader._internalReader;
        return (
          internal?._tools?.image?.color ||
          internal?._tools?.highlight?.color ||
          "#ffd400"
        );
      } catch {
        return "#ffd400";
      }
    })();
    const ann = new Zotero.Item("annotation");
    ann.libraryID = attachment.libraryID;
    ann.parentID = attachment.id;
    ann.annotationType = "image";
    ann.annotationColor = toolColor;
    ann.annotationPageLabel =
      visual.block.pageLabel || String(visual.pageIndex + 1);
    ann.annotationPosition = JSON.stringify({
      pageIndex: visual.pageIndex,
      rects: [pdfRect],
    });
    ann.annotationSortIndex = formatAnnotationSortIndex(
      visual.pageIndex,
      visual.bbox[1],
    );
    await ann.saveTx();

    // Save thumbnail image so Zotero's sidebar & notes render the crop immediately.
    let imgBytes = fallbackCrop?.bytes;
    let imgMime = fallbackCrop?.mime || "image/png";
    if (!imgBytes && visual.assetPath) {
      const layout = await loadPreparedLayout(attachment);
      if (layout) {
        const asset = await readPreparedAsset(layout, visual.assetPath);
        if (asset) {
          imgBytes = asset.bytes;
          imgMime = asset.mime || "image/png";
        }
      }
    }
    if (imgBytes && imgBytes.byteLength) {
      try {
        const BlobCtor = ztoolkit.getGlobal("Blob");
        const copy = new Uint8Array(imgBytes.byteLength);
        copy.set(imgBytes);
        const blob = new BlobCtor([copy], { type: imgMime });
        await Zotero.Annotations.saveCacheImage(ann, blob);
      } catch (error) {
        ztoolkit.log("[Glossa] annotation thumbnail save skipped", error);
      }
    }
    try {
      reader.setAnnotations?.([ann]);
      await reader.navigate?.({ annotationKey: ann.key });
    } catch {
      // Navigation is best-effort; the saved annotation is already persisted.
    }
    return { ok: true, key: ann.key };
  } catch (error) {
    ztoolkit.log("[Glossa] creating native visual annotation failed", error);
    return { ok: false, reason: "failed" };
  }
}

export type SaveHighlightOutcome =
  | { ok: true; key: string; updated: boolean }
  | { ok: false; reason: "read-only" | "no-geometry" | "failed" };

/**
 * Save a popup translation as a native Zotero `highlight` annotation whose
 * comment stores the Chinese translation. When `existingKey` is supplied (e.g.
 * after reviewing a previously saved translation), updates the existing
 * annotation's comment in place instead of creating a duplicate highlight.
 */
export async function saveHighlightTranslationAnnotation(options: {
  reader: _ZoteroTypes.ReaderInstance;
  target: Target;
  rawText: string;
  translation: string;
  pageIndex?: number;
  pageLabel?: string;
  rects?: readonly number[][];
  sortIndex?: string;
  existingKey?: string;
}): Promise<SaveHighlightOutcome> {
  const {
    reader,
    target,
    rawText,
    translation,
    pageIndex,
    pageLabel,
    rects,
    sortIndex,
    existingKey,
  } = options;
  const attachment = target.attachment;
  if (!attachment?.isPDFAttachment()) {
    return { ok: false, reason: "failed" };
  }
  if (!isLibraryWritable(attachment.libraryID)) {
    return { ok: false, reason: "read-only" };
  }
  const comment = translation.trim();
  if (!comment) return { ok: false, reason: "failed" };

  try {
    if (existingKey) {
      const existing = Zotero.Items.getByLibraryAndKey?.(
        attachment.libraryID,
        existingKey,
      ) as Zotero.Item | undefined;
      if (existing && existing.isAnnotation?.()) {
        existing.annotationComment = comment;
        await existing.saveTx();
        try {
          reader.setAnnotations?.([existing]);
        } catch {
          // Best-effort live refresh.
        }
        return { ok: true, key: existing.key, updated: true };
      }
    }

    const safeRects = copyRects(rects);
    if (
      pageIndex === undefined ||
      !Number.isInteger(pageIndex) ||
      pageIndex < 0 ||
      !safeRects?.length
    ) {
      return { ok: false, reason: "no-geometry" };
    }

    const toolColor = (() => {
      try {
        return reader._internalReader?._tools?.highlight?.color || "#ffd400";
      } catch {
        return "#ffd400";
      }
    })();

    const ann = new Zotero.Item("annotation");
    ann.libraryID = attachment.libraryID;
    ann.parentID = attachment.id;
    ann.annotationType = "highlight";
    ann.annotationColor = toolColor;
    ann.annotationText = rawText.trim();
    ann.annotationComment = comment;
    ann.annotationPageLabel = pageLabel || String(pageIndex + 1);
    ann.annotationPosition = JSON.stringify({
      pageIndex,
      rects: safeRects,
    });
    ann.annotationSortIndex =
      sortIndex && String(sortIndex).trim()
        ? String(sortIndex).trim()
        : formatAnnotationSortIndex(pageIndex, 0);
    await ann.saveTx();
    try {
      reader.setAnnotations?.([ann]);
    } catch {
      // Saved annotation is already persisted even if live paint skips.
    }
    return { ok: true, key: ann.key, updated: false };
  } catch (error) {
    ztoolkit.log("[Glossa] saving highlight translation failed", error);
    return { ok: false, reason: "failed" };
  }
}

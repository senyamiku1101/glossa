/**
 * PaddleOCR cloud result -> unified ParsedBody.
 *
 * `normalizePaddleJsonl()` is the only place that knows the provider's JSONL
 * shape. The adapter (task D) can use it directly, and the converter builds
 * the same ParsedBody every storage/queue/UI consumer expects.
 *
 * The service is parsed defensively: real responses vary by model/version and
 * the converter must degrade to a placeholder, never invent LaTeX, table cells
 * or image bytes.
 */
import {
  CONVERTER_VERSION,
  type BlockLoc,
  type BlockType,
  type BodyAsset,
  type CaveatCode,
  type ParsedBody,
  type RemoteInfo,
  type SourceFingerprint,
} from "./types";
import { judgeQuality, type QualityJudgement } from "./quality";
import { mimeFromFilename, safeRelativePath } from "./assets";

export type PaddleBlock = {
  kind: BlockType;
  label: string;
  text: string;
  pageIndex: number;
  bbox?: number[];
};

export type PaddlePage = {
  pageIndex: number;
  markdown: string;
  blocks: PaddleBlock[];
  assets: BodyAsset[];
  /** Printed page label when the service provides one. */
  pageLabel?: string;
  /** Rendered page pixel size `[widthPx, heightPx]` when reported. */
  pageSize?: [number, number];
};

export type NormalizePaddleOptions = {
  /** Page rasters are large; only include them when explicitly requested. */
  includePageImages?: boolean;
};

export type ConvertPaddleInput = {
  jsonl: string;
  source: SourceFingerprint;
  /** Paddle model name, stored as modelVersion. */
  model: string;
  remote?: RemoteInfo;
  includePageImages?: boolean;
  /**
   * Assets downloaded by the adapter (image URLs are presigned and must be
   * fetched by D). Filenames must be unique per page, e.g.
   * `images/p003-figure-1.jpg`; the converter rewrites `imgs/...` references
   * in the Markdown to the matching page asset.
   */
  assets?: BodyAsset[];
  /** Per-page rendered pixel sizes `[widthPx, heightPx]` from poll `dataInfo`. */
  pageSizes?: Array<[number, number] | undefined>;
  /** Real PDF page count; needed to detect missing/truncated service pages. */
  expectedPages?: number;
  /** The adapter applied pageRanges/limits; never report done silently. */
  truncated?: boolean;
};

export type PaddleConversion = {
  body: ParsedBody;
  judgement: QualityJudgement;
};

const AUXILIARY_LABELS = new Set([
  "header",
  "page_header",
  "footer",
  "page_footer",
  "page_number",
  "number",
  "seal",
  "aside_text",
]);

const LABEL_KIND: Record<string, BlockType> = {
  title: "heading",
  doc_title: "heading",
  paragraph_title: "heading",
  heading: "heading",
  subtitle: "heading",
  text: "paragraph",
  paragraph: "paragraph",
  abstract: "paragraph",
  caption: "caption",
  figure_title: "caption",
  table_title: "caption",
  figure_caption: "caption",
  image_caption: "caption",
  table_caption: "caption",
  chart_caption: "caption",
  table: "table",
  equation: "equation",
  formula: "equation",
  display_formula: "equation",
  inline_formula: "equation",
  interline_equation: "equation",
  image: "image",
  figure: "image",
  chart: "image",
  list: "list",
  blockquote: "blockquote",
  code: "preformatted",
  algorithm: "preformatted",
  note: "note",
  footnote: "note",
};

/**
 * Parse the JSONL downloaded from PaddleOCR into provider-neutral pages.
 * Tolerates both `markdown.text`, plain `markdown` strings and
 * `prunedResult.parsing_res_list[].block_content`.
 */
export function normalizePaddleJsonl(
  jsonl: string,
  options: NormalizePaddleOptions = {},
): PaddlePage[] {
  const pages: PaddlePage[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const value = asRecord(parsed);
    if (!value) continue;
    const result = asRecord(value.result) || value;
    const list =
      asArray(result.layoutParsingResults) ||
      asArray(result.layout_parsing_results) ||
      asArray(result.pages) ||
      asArray(value.layoutParsingResults);
    const pageValues = list || (isPageLike(value) ? [value] : []);
    const lineDataInfo = asRecord(result.dataInfo) || asRecord(value.dataInfo);
    const infoPages = asArray(lineDataInfo?.pages);
    for (let localIndex = 0; localIndex < pageValues.length; localIndex++) {
      const page = asRecord(pageValues[localIndex]);
      if (!page) continue;
      const pageIndex = pages.length;
      const blocks = normalizeBlocks(page, pageIndex);
      const markdown =
        pageMarkdown(page) ||
        blocks
          .map((block) => block.text)
          .filter(Boolean)
          .join("\n\n");
      const pageSize = detectPageSize(
        page,
        lineDataInfo,
        infoPages,
        pageIndex,
        localIndex,
      );
      pages.push({
        pageIndex,
        markdown,
        blocks,
        assets: normalizeAssets(page, pageIndex, options, blocks),
        pageLabel: pageLabel(page),
        ...(pageSize ? { pageSize } : {}),
      });
    }
  }
  return pages;
}

export function convertPaddleJsonl(
  input: ConvertPaddleInput,
): PaddleConversion {
  const pages = normalizePaddleJsonl(input.jsonl, {
    includePageImages: input.includePageImages,
  });

  let markdown = "";
  const blocks: BlockLoc[] = [];
  let unverifiedBlockPages = 0;
  let emptyPages = 0;
  let parsedPages = 0;
  const structuralPages = new Set<number>();
  let hasTableBlocks = false;
  let hasEquationBlocks = false;
  let hasImages = false;

  // D downloads image URLs; inline base64 (rare) is handled above. Rewrite
  // every provider image reference to the hosted `images/<basename>` name
  // before offsets are computed, so the hosted Markdown never points at a
  // presigned URL that expires.
  const merged = mergeAssets(
    pages.flatMap((page) => page.assets),
    input.assets ?? [],
  );
  const allAssets = merged.assets;
  const resolvedAliases = imageAliases(pages, allAssets);
  const emptyAliases = new Map<string, string>();

  for (const page of pages) {
    const pageHeading = `<!-- page ${page.pageIndex + 1}${
      page.pageLabel ? ` (printed ${page.pageLabel})` : ""
    } -->`;
    markdown += `${pageHeading}\n\n`;
    const pageBody = sanitizeProviderMarkdown(
      rewriteImageRefs(
        page.markdown.trim(),
        resolvedAliases.byPage.get(page.pageIndex) || emptyAliases,
      ),
    );
    if (pageBody) parsedPages += 1;
    else emptyPages += 1;
    const pageStart = markdown.length;
    markdown += `${pageBody}\n\n`;

    const usable = page.blocks.filter(
      (block) => block.text.trim() || block.bbox,
    );
    if (!usable.some((block) => block.bbox)) unverifiedBlockPages += 1;

    let cursor = 0;
    const pageAliases =
      resolvedAliases.byPage.get(page.pageIndex) || emptyAliases;
    const pageSize = input.pageSizes?.[page.pageIndex] ?? page.pageSize;
    const pageFigureAssets = allAssets
      .filter(
        (asset) =>
          asset.pageIndex === page.pageIndex && asset.kind === "figure",
      )
      .map((asset) => asset.filename);
    const usedFigureAssets = new Set<string>();
    const imageBlockCount = usable.filter((b) => b.kind === "image").length;
    for (const block of usable) {
      if (block.kind === "table") {
        structuralPages.add(page.pageIndex);
        hasTableBlocks = true;
      } else if (block.kind === "equation") {
        structuralPages.add(page.pageIndex);
        hasEquationBlocks = true;
      } else if (block.kind === "image") {
        hasImages = true;
      }
      const rawText = block.text.trim();
      const rewrittenText = rawText
        ? sanitizeProviderMarkdown(rewriteImageRefs(rawText, pageAliases))
        : "";
      let start = pageStart + cursor;
      let end = start;
      for (const candidate of [rewrittenText, rawText]) {
        if (!candidate) continue;
        const found = pageBody.indexOf(candidate, Math.max(0, cursor));
        if (found >= 0) {
          start = pageStart + found;
          end = start + candidate.length;
          cursor = found + candidate.length;
          break;
        }
      }
      let assetPath: string | undefined;
      if (block.kind === "image" || block.kind === "table") {
        for (const ref of collectImageRefs(rewrittenText)) {
          const safe = safeRelativePath(ref);
          if (safe && allAssets.some((a) => a.filename === safe)) {
            assetPath = safe;
            usedFigureAssets.add(safe);
            break;
          }
        }
        if (
          !assetPath &&
          block.kind === "image" &&
          imageBlockCount === 1 &&
          pageFigureAssets.length === 1 &&
          !usedFigureAssets.has(pageFigureAssets[0])
        ) {
          assetPath = pageFigureAssets[0];
          usedFigureAssets.add(assetPath);
        }
      }
      const rectInfo = buildPaddleBlockRect(
        page.pageIndex,
        block.bbox,
        pageSize,
      );
      blocks.push({
        type: block.kind,
        pageIndex: page.pageIndex,
        ...(page.pageLabel ? { pageLabel: page.pageLabel } : {}),
        ...rectInfo,
        ...(rewrittenText ? { text: rewrittenText } : {}),
        ...(assetPath ? { assetPath } : {}),
        mdStart: start,
        mdEnd: Math.max(start, end),
      });
    }
    if (!usable.length && pageBody.trim()) {
      blocks.push({
        type: "paragraph",
        pageIndex: page.pageIndex,
        ...(page.pageLabel ? { pageLabel: page.pageLabel } : {}),
        mdStart: pageStart,
        mdEnd: pageStart + pageBody.length,
      });
    }
  }

  const assets = allAssets;
  const imageStats = countImageReferences(markdown, assets);
  const totalPages = Math.max(
    input.expectedPages || 0,
    input.source.pageCount,
    pages.length,
  );
  const textChars = pages.reduce(
    (sum, page) => sum + effectiveChars(page.markdown),
    0,
  );
  // PaddleOCR-VL emits HTML tables; PP-StructureV3 usually emits pipe tables.
  // Both preserve the table, but only a Markdown table is universally
  // renderable, so mark the rest as text with an explicit caveat.
  const tablesPreserved =
    /\|\s*:?-{3,}/.test(markdown) || /<table[\s>]/i.test(markdown);
  // Money such as "$5 and $10" is not a formula; require a LaTeX-ish char.
  const equationsLatex =
    /\$\$[\s\S]+?\$\$/.test(markdown) ||
    /\$(?![\d\s])[^$\n]*[\p{L}\\^_{}=][^$\n]*\$/u.test(markdown);
  const pageLabelsProvided = pages.some((page) => Boolean(page.pageLabel));
  const pageCountKnown = Boolean(input.expectedPages || input.source.pageCount);
  const warnings = new Set<CaveatCode>([
    ...imageStats.warnings,
    ...merged.warnings,
    ...resolvedAliases.warnings,
  ]);
  if (!pageLabelsProvided && pages.length) {
    warnings.add("page-label-from-index");
  }
  if (!pageCountKnown) {
    warnings.add("page-order-unverified");
  }

  const judgement = judgeQuality({
    parserId: "paddleocr-cloud",
    textChars,
    totalPages,
    parsedPages,
    emptyPages,
    unverifiedBlockPages,
    structuralPages: structuralPages.size,
    hasTableBlocks,
    hasEquationBlocks,
    tablesPreserved,
    equationsLatex,
    hasImages: hasImages || assets.length > 0 || imageStats.declared > 0,
    assetsDeclared: imageStats.declared,
    assetsResolved: imageStats.resolved,
    truncated: Boolean(input.truncated),
    warnings: [...warnings],
  });

  const source: SourceFingerprint = {
    ...input.source,
    pageCount: totalPages,
  };
  const body: ParsedBody = {
    markdown,
    assets,
    blocks,
    source,
    parserId: "paddleocr-cloud",
    processorVersion: input.model,
    converterVersion: CONVERTER_VERSION,
    quality: judgement.quality,
    warnings: judgement.quality.caveats,
    generatedAt: new Date().toISOString(),
    ...(input.remote ? { remote: input.remote } : {}),
  };
  return { body, judgement };
}

// ---- provider JSONL helpers (kept here so D does not duplicate shapes) ----

function pageMarkdown(page: Record<string, unknown>): string {
  const markdown = asRecord(page.markdown);
  if (markdown) {
    const text = asString(markdown.text);
    if (text) return text;
  }
  const plain = asString(page.markdown);
  if (plain) return plain;
  const pruned = asRecord(page.prunedResult);
  const list = asArray(pruned?.parsing_res_list);
  if (list) {
    return list
      .map((item) => asString(asRecord(item)?.block_content) || "")
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function normalizeBlocks(
  page: Record<string, unknown>,
  pageIndex: number,
): PaddleBlock[] {
  const pruned = asRecord(page.prunedResult);
  const list = asArray(pruned?.parsing_res_list);
  const blocks: PaddleBlock[] = [];
  if (list) {
    for (const item of list) {
      const block = asRecord(item);
      if (!block) continue;
      const label = (
        asString(block.block_label) ||
        asString(block.label) ||
        "text"
      ).toLowerCase();
      if (AUXILIARY_LABELS.has(label)) continue;
      const kind = LABEL_KIND[label] || "paragraph";
      const text = asString(block.block_content) || asString(block.text) || "";
      const bbox = normalizeBBox(block.block_bbox || block.bbox);
      if (!text.trim() && !bbox) continue;
      blocks.push({ kind, label, text, pageIndex, ...(bbox ? { bbox } : {}) });
    }
  }
  if (blocks.length) return blocks;
  const boxes = asArray(asRecord(pruned?.layout_det_res)?.boxes);
  if (boxes) {
    for (const item of boxes) {
      const box = asRecord(item);
      if (!box) continue;
      const label = (asString(box.label) || "text").toLowerCase();
      if (AUXILIARY_LABELS.has(label)) continue;
      const bbox = normalizeBBox(box.coordinate || box.bbox || box.box);
      if (!bbox) continue;
      blocks.push({
        kind: LABEL_KIND[label] || "paragraph",
        label,
        text: "",
        pageIndex,
        bbox,
      });
    }
  }
  return blocks;
}

function normalizeAssets(
  page: Record<string, unknown>,
  pageIndex: number,
  options: NormalizePaddleOptions,
  blocks: PaddleBlock[],
): BodyAsset[] {
  const assets: BodyAsset[] = [];
  const seen = new Set<string>();
  const push = (name: string, payload: unknown, kind: BodyAsset["kind"]) => {
    const decoded = decodeImagePayload(payload);
    if (!decoded) return;
    // Keep the page in the file name: two pages may both call their figure
    // `fig1.jpg`, and the hosted attachment must never overwrite one with the
    // other.
    const safe = safeRelativePath(name);
    const basename = safe?.split("/").pop();
    const filename = basename
      ? `images/p${String(pageIndex + 1).padStart(3, "0")}-${basename}`
      : `images/page-${String(pageIndex + 1).padStart(4, "0")}.${extensionFor(decoded.mime)}`;
    if (seen.has(filename)) return;
    seen.add(filename);
    assets.push({
      kind,
      pageIndex,
      filename,
      mime: decoded.mime,
      bytes: decoded.bytes,
    });
  };

  const markdown = asRecord(page.markdown);
  for (const [name, payload] of imageEntries(markdown?.images ?? page.images)) {
    push(name, payload, "figure");
  }
  if (options.includePageImages) {
    const inputImage = asString(page.inputImage);
    if (inputImage) {
      push(
        `pages/page-${String(pageIndex + 1).padStart(4, "0")}.jpg`,
        inputImage,
        "page",
      );
    }
  }
  for (const [index, block] of blocks.entries()) {
    if (block.kind !== "image") continue;
    const record =
      asRecord(
        asArray(asRecord(page.prunedResult)?.parsing_res_list)?.[index],
      ) || {};
    const payload =
      record.block_image ??
      record.image_base64 ??
      record.image_data ??
      record.image;
    if (typeof payload === "string") {
      push(
        `images/figure-${pageIndex + 1}-${index + 1}.jpg`,
        payload,
        "figure",
      );
    }
  }
  return assets;
}

function imageEntries(value: unknown): Array<[string, unknown]> {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const record = asRecord(item);
      const name =
        asString(record?.name) ||
        asString(record?.filename) ||
        `images/image-${index + 1}.jpg`;
      return [name, item] as [string, unknown];
    });
  }
  const record = asRecord(value);
  return record ? Object.entries(record) : [];
}

function decodeImagePayload(
  payload: unknown,
): { mime: string; bytes: Uint8Array } | undefined {
  const text =
    typeof payload === "string"
      ? payload
      : asString(asRecord(payload)?.base64) ||
        asString(asRecord(payload)?.data) ||
        asString(asRecord(payload)?.image);
  if (!text) return undefined;
  const trimmed = text.trim();
  // D downloads Markdown image URLs without a token; the converter must never
  // interpret a URL as base64 (that produced garbage assets).
  if (
    /^(?:https?:)?\/\//i.test(trimmed) ||
    /^(?:imgs|images)\//i.test(trimmed)
  ) {
    return undefined;
  }
  const dataUri = /^data:([^;]+);base64,(.*)$/s.exec(trimmed);
  if (dataUri) {
    const bytes = decodeBase64(dataUri[2]);
    return bytes.length ? { mime: dataUri[1], bytes } : undefined;
  }
  // Only decode payloads that actually look like base64, and ignore obvious
  // relative paths / sentences.
  if (!/^[A-Za-z0-9+/=\s]{16,}$/.test(trimmed) || / /.test(trimmed.trim())) {
    return undefined;
  }
  const bytes = decodeBase64(trimmed);
  return bytes.length ? { mime: "image/jpeg", bytes } : undefined;
}

/**
 * Merge adapter-downloaded assets with inline base64 assets. Duplicate
 * filenames with different bytes are renamed (page prefix) so one page can
 * never overwrite another; ambiguous references are warned about later.
 */
function mergeAssets(
  inline: BodyAsset[],
  downloaded: BodyAsset[],
): { assets: BodyAsset[]; warnings: Set<CaveatCode> } {
  const result: BodyAsset[] = [];
  const used = new Map<string, BodyAsset>();
  const warnings = new Set<CaveatCode>();
  for (const asset of [...inline, ...downloaded]) {
    const filename = safeRelativePath(asset.filename);
    if (!filename) continue;
    let finalName = filename;
    const existing = used.get(finalName);
    if (existing) {
      if (sameBytes(existing.bytes, asset.bytes)) continue;
      finalName = pagePrefixedName(
        filename,
        asset.pageIndex ?? result.length,
        used,
      );
      // The renamed asset is still embedded; this is an ambiguity we resolved,
      // not a missing image. A genuinely unresolved reference is warned below.
    }
    const merged: BodyAsset = {
      ...asset,
      filename: finalName,
      mime: asset.mime || mimeFromFilename(finalName),
    };
    used.set(finalName, merged);
    result.push(merged);
  }
  return { assets: result, warnings };
}

function pagePrefixedName(
  filename: string,
  pageIndex: number,
  used: Map<string, BodyAsset>,
): string {
  const dir = filename.includes("/")
    ? filename.slice(0, filename.lastIndexOf("/") + 1)
    : "";
  const base = filename.slice(dir.length);
  const dot = base.lastIndexOf(".");
  const rawStem = dot > 0 ? base.slice(0, dot) : base;
  const stem = rawStem.replace(/^p\d+-/, "");
  const ext = dot > 0 ? base.slice(dot) : "";
  let suffix = 1;
  let candidate = `${dir}p${pageIndex + 1}-${stem}${ext}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${dir}p${pageIndex + 1}-${stem}-${suffix}${ext}`;
  }
  return candidate;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Map each page's provider image references to the asset downloaded for that
 * page. Cross-page references with the same basename are never resolved to
 * another page's asset.
 */
function imageAliases(
  pages: PaddlePage[],
  assets: BodyAsset[],
): { byPage: Map<number, Map<string, string>>; warnings: Set<CaveatCode> } {
  const byPage = new Map<number, Map<string, string>>();
  const warnings = new Set<CaveatCode>();
  const global = assets.filter((asset) => asset.pageIndex === undefined);
  for (const page of pages) {
    const aliases = new Map<string, string>();
    const pageAssets = assets.filter(
      (asset) => asset.pageIndex === page.pageIndex,
    );
    for (const reference of collectImageRefs(page.markdown)) {
      const base = referenceBasename(reference);
      if (!base) continue;
      const candidates = pageAssets.filter((asset) =>
        assetMatchesBase(asset, base),
      );
      const globalCandidates = global.filter((asset) =>
        assetMatchesBase(asset, base),
      );
      const pool = candidates.length ? candidates : globalCandidates;
      if (pool.length === 1) aliases.set(reference.trim(), pool[0].filename);
      else if (pool.length > 1) warnings.add("asset-missing");
      else if (isProviderRelativeRef(reference)) {
        // No asset for this page: rewriteImageRefs will emit a placeholder.
        warnings.add("asset-missing");
      }
    }
    if (aliases.size) byPage.set(page.pageIndex, aliases);
  }
  return { byPage, warnings };
}

function assetMatchesBase(asset: BodyAsset, base: string): boolean {
  const filename = asset.filename.split("/").pop() || asset.filename;
  if (filename === base) return true;
  // Inline base64 assets are page-prefixed; D's downloaded assets usually
  // keep the provider basename. Accept both without losing the page link.
  return filename.replace(/^p\d+-/, "") === base;
}

function referenceBasename(reference: string): string | undefined {
  const raw = reference.trim();
  if (!raw || /^(?:data:|javascript:|vbscript:|file:|#|zotero:)/i.test(raw)) {
    return undefined;
  }
  let candidate = raw;
  try {
    candidate = decodeURI(candidate);
  } catch {
    // Keep the raw value.
  }
  const safe = safeRelativePath(candidate);
  const base = (safe || candidate).split(/[\\/]/).pop() || "";
  // Keep readable service filenames, including spaces, plus signs and parentheses.
  // eslint-disable-next-line no-control-regex
  return base && !base.includes("..") && !/[\x00-\x1f\x7f/\\]/.test(base)
    ? base
    : undefined;
}

function collectImageRefs(markdown: string): string[] {
  const refs: string[] = [];
  const markdownLink = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))/g;
  for (const match of markdown.matchAll(markdownLink)) {
    refs.push((match[1] || match[2] || "").trim());
  }
  const htmlImage =
    /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of markdown.matchAll(htmlImage))
    refs.push((match[1] || match[2] || match[3] || "").trim());
  return refs.filter(Boolean);
}

function rewriteImageRefs(
  markdown: string,
  aliases: Map<string, string>,
): string {
  let result = markdown;
  // Existing Markdown image links first.
  result = result.replace(
    /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(\s+["'][^"']*["'])?\s*\)/g,
    (match, alt: string, angle?: string, plain?: string, title?: string) => {
      const reference = (angle || plain || "").trim();
      const replacement = aliases.get(reference);
      if (replacement)
        return `![${alt}](${/[\s()]/.test(replacement) ? `<${replacement}>` : replacement}${title || ""})`;
      // A provider-relative image without a downloaded asset for this page
      // must become an explicit placeholder: leaving it for the hosting layer
      // could bind it to another page's same-named asset.
      return isProviderRelativeRef(reference)
        ? `[Image: ${alt || "image"}]`
        : match;
    },
  );
  // Paddle Markdown uses HTML `<img>`; convert it afterwards so the Markdown
  // emitted here is not reprocessed by the placeholder pass above.
  result = result.replace(/<img\b([^>]*)>/gi, (match, attributes: string) => {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
      attributes,
    );
    if (!src) return match;
    const reference = (src[1] || src[2] || src[3] || "").trim();
    const replacement = aliases.get(reference);
    const alt = /\balt\s*=\s*(["'])(.*?)\1/i.exec(attributes);
    if (replacement) {
      return `![${alt ? alt[2] : "image"}](${/[\s()]/.test(replacement) ? `<${replacement}>` : replacement})`;
    }
    return isProviderRelativeRef(reference)
      ? `[Image: ${alt ? alt[2] : "image"}]`
      : match;
  });
  return result;
}

function isProviderRelativeRef(reference: string): boolean {
  const value = reference.trim();
  if (!value) return false;
  return !/^(?:https?:|data:|zotero:|mailto:|file:|javascript:|vbscript:|#|\/\/)/i.test(
    value,
  );
}

/**
 * Conservative active-content stripping for untrusted provider Markdown.
 * Rendering-side escaping/sanitization is still required; this only removes
 * obviously executable tags/attributes and unsafe URL schemes.
 */
function sanitizeProviderMarkdown(markdown: string): string {
  let result = markdown;
  result = result.replace(
    /<(script|style|iframe|object|embed|applet)\b[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  result = result.replace(
    /<(script|style|iframe|object|embed|applet|link|meta)\b[^>]*\/?>/gi,
    "",
  );
  result = result.replace(
    /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    "",
  );
  result = result.replace(
    /\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (
      match,
      attribute: string,
      double?: string,
      single?: string,
      raw?: string,
    ) => {
      const value = double ?? single ?? raw ?? "";
      if (/^(?:javascript|vbscript):/i.test(value)) return `${attribute}="#"`;
      if (/^data:text\/html/i.test(value)) return `${attribute}="#"`;
      return match;
    },
  );
  return result;
}

function countImageReferences(markdown: string, assets: BodyAsset[]) {
  const known = new Set(
    assets
      .map((asset) => safeRelativePath(asset.filename))
      .filter((value): value is string => Boolean(value)),
  );
  const warnings = new Set<ParsedBody["warnings"][number]>();
  let declared = 0;
  let resolved = 0;
  for (const ref of collectImageRefs(markdown)) {
    if (!ref || /^(?:https?:|data:|zotero:|file:)/i.test(ref)) continue;
    declared += 1;
    // Exact relative path only: cross-page basename matching would count a
    // different page's image as this page's asset.
    const safe = safeRelativePath(ref);
    if (safe && known.has(safe)) resolved += 1;
    else warnings.add("asset-missing");
  }
  return { declared, resolved, warnings };
}

function effectiveChars(value: string): number {
  return (value.match(/[\p{L}\p{N}]/gu) || []).length;
}

function isPageLike(value: Record<string, unknown>): boolean {
  return Boolean(value.markdown || value.prunedResult || value.inputImage);
}

function normalizeBBox(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const result: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return undefined;
    result.push(item);
  }
  return result;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positiveSize(
  width: unknown,
  height: unknown,
): [number, number] | undefined {
  const w = typeof width === "number" ? width : Number(width);
  const h = typeof height === "number" ? height : Number(height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return [w, h];
  }
  return undefined;
}

function sizeFromRecord(
  record: Record<string, unknown> | undefined,
): [number, number] | undefined {
  if (!record) return undefined;
  return positiveSize(
    record.width ?? record.pageWidth ?? record.imageWidth,
    record.height ?? record.pageHeight ?? record.imageHeight,
  );
}

/** Read JPEG SOF0-SOF15 or PNG IHDR pixel dimensions from decoded image bytes. */
function imageDimensionsFromBytes(
  bytes: Uint8Array,
): [number, number] | undefined {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const w =
      ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>>
      0;
    const h =
      ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>>
      0;
    return positiveSize(w, h);
  }
  if (bytes.length >= 11 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 4 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined;
      const marker = bytes[i + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (i + 8 < bytes.length) {
          const h = (bytes[i + 5] << 8) | bytes[i + 6];
          const w = (bytes[i + 7] << 8) | bytes[i + 8];
          return positiveSize(w, h);
        }
        return undefined;
      }
      if (marker === 0xd9) return undefined;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (len < 2) return undefined;
      i += 2 + len;
    }
  }
  return undefined;
}

function detectPageSize(
  page: Record<string, unknown>,
  lineDataInfo: Record<string, unknown> | undefined,
  infoPages: unknown[] | undefined,
  pageIndex: number,
  localIndex: number,
): [number, number] | undefined {
  const fromInfoPages =
    sizeFromRecord(asRecord(infoPages?.[pageIndex])) ||
    sizeFromRecord(asRecord(infoPages?.[localIndex]));
  if (fromInfoPages) return fromInfoPages;
  const fromDirect =
    sizeFromRecord(asRecord(page.prunedResult)) ||
    sizeFromRecord(page) ||
    sizeFromRecord(lineDataInfo);
  if (fromDirect) return fromDirect;
  const decoded = decodeImagePayload(page.inputImage);
  if (decoded) return imageDimensionsFromBytes(decoded.bytes);
  return undefined;
}

function buildPaddleBlockRect(
  pageIndex: number,
  bbox: number[] | undefined,
  pageSize: [number, number] | undefined,
): Pick<BlockLoc, "pageRects" | "pageRectsSpace" | "pageSize"> {
  if (!bbox || bbox.length !== 4) return {};
  if (pageSize && pageSize[0] > 0 && pageSize[1] > 0) {
    const nx1 = clamp01(Math.min(bbox[0], bbox[2]) / pageSize[0]);
    const ny1 = clamp01(Math.min(bbox[1], bbox[3]) / pageSize[1]);
    const nx2 = clamp01(Math.max(bbox[0], bbox[2]) / pageSize[0]);
    const ny2 = clamp01(Math.max(bbox[1], bbox[3]) / pageSize[1]);
    if (nx2 > nx1 && ny2 > ny1) {
      return {
        pageRects: [[pageIndex, nx1, ny1, nx2, ny2]],
        pageRectsSpace: "page-fraction",
        pageSize,
      };
    }
  }
  return {
    pageRects: [[pageIndex, ...bbox]],
    pageRectsSpace: "service-pixels",
    ...(pageSize ? { pageSize } : {}),
  };
}

function pageLabel(page: Record<string, unknown>): string | undefined {
  for (const key of ["page_label", "pageLabel", "page_number", "pageNumber"]) {
    const value = page[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function extensionFor(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  if (lower.includes("svg")) return "svg";
  if (lower.includes("tiff")) return "tiff";
  return "jpg";
}

function decodeBase64(value: string): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    if (char === "=") break;
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

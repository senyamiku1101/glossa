/**
 * Align Zotero PDF reader selections and area annotations to the unified
 * position map (`BlockLoc[]`) and clean Markdown produced by PaddleOCR / MinerU.
 *
 * Pure module: no Zotero runtime globals so `scripts/check-reader-align.mjs`
 * can verify geometry, math-tolerant matching and sub-span slicing directly.
 */
import type { BlockLoc, BlockType } from "./types";

/** Normalized `[x1, y1, x2, y2]` rectangle in `[0..1]` top-left page space. */
export type NormRect = [number, number, number, number];

export type SelectionAlignInput = {
  markdown: string;
  blocks: readonly BlockLoc[];
  pageIndex: number;
  selection: string;
  rects?: readonly number[][];
  nextPageRects?: readonly number[][];
  viewBox?: readonly number[];
  nextViewBox?: readonly number[];
};

export type AlignedSelection =
  | {
      kind: "matched";
      /** Clean Markdown for the user's selected span, or raw selection if sub-span is ambiguous. */
      selectionText: string;
      /** True when `selectionText` was upgraded from clean Markdown. */
      selectionEnhanced: boolean;
      /** Clean Markdown of the complete block(s) touched by the selection. */
      paragraphText: string;
      /** Number of logical blocks joined into `paragraphText`. */
      paragraphCount: number;
      via: "geometry" | "text";
      blocks: BlockLoc[];
      visualBlocks: BlockLoc[];
    }
  | { kind: "none" };

export type VisualRegionAlignInput = {
  markdown: string;
  blocks: readonly BlockLoc[];
  pageIndex: number;
  rects?: readonly number[][];
  viewBox?: readonly number[];
};

export type AlignedVisualRegion = {
  kind: "figure" | "table" | "equation" | "text";
  pageIndex: number;
  block: BlockLoc;
  assetPath?: string;
  caption?: string;
  markdownText?: string;
};

/** Hoverable figure / table / display-equation target on one PDF page. */
export type PageVisualTarget = {
  id: string;
  kind: "figure" | "table" | "equation";
  pageIndex: number;
  /** Normalized `[x1, y1, x2, y2]` top-left `[0..1]` box (includes merged caption). */
  bbox: NormRect;
  block: BlockLoc;
  assetPath?: string;
  caption?: string;
  markdownText?: string;
};

const MAX_ALIGNED_CHARS = 12_000;
const PADDLE_RENDER_SCALES = [2, 150 / 72, 200 / 72, 300 / 72, 1];
const PAGE_COMMENT_RE =
  /<!--\s*page\s+(\d+)(?:\s*\(printed\s+([^)]+)\))?\s*-->/gi;
const IMAGE_LINK_RE =
  /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function validViewBox(
  viewBox?: readonly number[],
): [number, number, number, number] | undefined {
  if (!viewBox || viewBox.length !== 4) return undefined;
  const [x0, y0, x1, y1] = viewBox;
  if (
    !Number.isFinite(x0) ||
    !Number.isFinite(y0) ||
    !Number.isFinite(x1) ||
    !Number.isFinite(y1)
  ) {
    return undefined;
  }
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : undefined;
}

/**
 * Convert Zotero PDF.js bottom-left point rects `[x1, y1, x2, y2]` into
 * normalized `[0..1]` top-left page fractions.
 */
export function pdfRectsToFractions(
  rects: readonly number[][] | undefined,
  viewBox: readonly number[] | undefined,
): NormRect[] {
  const vb = validViewBox(viewBox);
  if (!rects?.length || !vb) return [];
  const [vx0, vy0, vx1, vy1] = vb;
  const width = vx1 - vx0;
  const height = vy1 - vy0;
  const out: NormRect[] = [];
  for (const rect of rects) {
    if (!Array.isArray(rect) || rect.length !== 4) continue;
    const [a, b, c, d] = rect;
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      !Number.isFinite(c) ||
      !Number.isFinite(d)
    ) {
      continue;
    }
    const nx1 = clamp01((Math.min(a, c) - vx0) / width);
    const nx2 = clamp01((Math.max(a, c) - vx0) / width);
    const ny1 = clamp01((vy1 - Math.max(b, d)) / height);
    const ny2 = clamp01((vy1 - Math.min(b, d)) / height);
    if (nx2 > nx1 && ny2 > ny1) out.push([nx1, ny1, nx2, ny2]);
  }
  return out;
}

/**
 * Convert a normalized `[x1, y1, x2, y2]` top-left `[0..1]` rectangle back
 * into Zotero PDF bottom-left user-space points `[x1, y1, x2, y2]`.
 */
export function fractionRectToPdfRect(
  rect: NormRect,
  viewBox: readonly number[] | undefined,
): [number, number, number, number] | undefined {
  const vb = validViewBox(viewBox);
  if (!vb) return undefined;
  const [vx0, vy0, vx1, vy1] = vb;
  const width = vx1 - vx0;
  const height = vy1 - vy0;
  const x1 = vx0 + clamp01(Math.min(rect[0], rect[2])) * width;
  const x2 = vx0 + clamp01(Math.max(rect[0], rect[2])) * width;
  const y1 = vy1 - clamp01(Math.max(rect[1], rect[3])) * height;
  const y2 = vy1 - clamp01(Math.min(rect[1], rect[3])) * height;
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : undefined;
}

function inferServicePixelSize(
  block: BlockLoc,
  pageBlocks: readonly BlockLoc[],
  viewBox: readonly number[] | undefined,
): [number, number] | undefined {
  if (block.pageSize && block.pageSize[0] > 0 && block.pageSize[1] > 0) {
    return block.pageSize;
  }
  for (const candidate of pageBlocks) {
    if (
      candidate.pageIndex === block.pageIndex &&
      candidate.pageSize &&
      candidate.pageSize[0] > 0 &&
      candidate.pageSize[1] > 0
    ) {
      return candidate.pageSize;
    }
  }
  const vb = validViewBox(viewBox);
  if (!vb) return undefined;
  const widthPt = vb[2] - vb[0];
  const heightPt = vb[3] - vb[1];
  let maxX = 0;
  let maxY = 0;
  for (const candidate of pageBlocks) {
    if (
      candidate.pageIndex !== block.pageIndex ||
      candidate.pageRectsSpace !== "service-pixels"
    ) {
      continue;
    }
    for (const r of candidate.pageRects ?? []) {
      if (r.length !== 5 || r[0] !== block.pageIndex) continue;
      maxX = Math.max(maxX, r[1], r[3]);
      maxY = Math.max(maxY, r[2], r[4]);
    }
  }
  if (maxX <= 0 || maxY <= 0) return [widthPt * 2, heightPt * 2];
  for (const scale of PADDLE_RENDER_SCALES) {
    const w = widthPt * scale;
    const h = heightPt * scale;
    if (maxX <= w * 1.04 && maxY <= h * 1.04) return [w, h];
  }
  return [Math.max(maxX, widthPt * 2), Math.max(maxY, heightPt * 2)];
}

/** Convert a `BlockLoc`'s rectangles on its page into normalized top-left `[0..1]` fractions. */
export function blockRectsToFractions(
  block: BlockLoc,
  pageBlocks: readonly BlockLoc[],
  viewBox?: readonly number[],
): NormRect[] {
  const raw = (block.pageRects ?? []).filter(
    (r) =>
      Array.isArray(r) &&
      r.length === 5 &&
      r[0] === block.pageIndex &&
      r.slice(1).every((n) => typeof n === "number" && Number.isFinite(n)),
  );
  if (!raw.length) return [];
  const space = block.pageRectsSpace ?? "service-pixels";
  if (space === "page-fraction") {
    const out: NormRect[] = [];
    for (const r of raw) {
      const x1 = clamp01(Math.min(r[1], r[3]));
      const y1 = clamp01(Math.min(r[2], r[4]));
      const x2 = clamp01(Math.max(r[1], r[3]));
      const y2 = clamp01(Math.max(r[2], r[4]));
      if (x2 > x1 && y2 > y1) out.push([x1, y1, x2, y2]);
    }
    return out;
  }
  if (space === "pdf-points") {
    return pdfRectsToFractions(
      raw.map((r) => [r[1], r[2], r[3], r[4]]),
      viewBox,
    );
  }
  const size = inferServicePixelSize(block, pageBlocks, viewBox);
  if (!size || size[0] <= 0 || size[1] <= 0) return [];
  const [pw, ph] = size;
  const out: NormRect[] = [];
  for (const r of raw) {
    const x1 = clamp01(Math.min(r[1], r[3]) / pw);
    const y1 = clamp01(Math.min(r[2], r[4]) / ph);
    const x2 = clamp01(Math.max(r[1], r[3]) / pw);
    const y2 = clamp01(Math.max(r[2], r[4]) / ph);
    if (x2 > x1 && y2 > y1) out.push([x1, y1, x2, y2]);
  }
  return out;
}

/**
 * Tighten OCR-style spaced inline math (`$ \epsilon $` -> `$\epsilon$`) so
 * both Markdown renderers and LLMs see clean standard inline LaTeX. Leaves
 * display `$$...$$` and currency like `$5 and $10` untouched.
 */
export function normalizeInlineMathSpacing(text: string): string {
  return text.replace(
    /(?<!\$)\$(?!\$)([ \t]+)([^$\n]+?)([ \t]+)\$(?!\$)/g,
    (match, _leftSpace: string, body: string) => {
      const trimmed = body.trim();
      if (!trimmed) return match;
      if (/^\d+(?:[.,]\d+)?\s+[A-Za-z]{2,}\b/.test(trimmed)) return match;
      const isMath =
        /\\[A-Za-z]+/.test(trimmed) ||
        /[_^=<>±×÷∑∫∂∇≈≠≤≥∞α-ωΑ-Ω]/.test(trimmed) ||
        (trimmed.length <= 24 &&
          /^[A-Za-z0-9()[\]{}+\-*/.,=<>|^_'\s]+$/.test(trimmed) &&
          /[A-Za-z]/.test(trimmed) &&
          !/\b[A-Za-z]{4,}\b/.test(trimmed));
      return isMath ? `$${trimmed}$` : match;
    },
  );
}

/** Extract clean Markdown text for a block from `block.text` or its offsets in `markdown`. */
export function blockMarkdownText(block: BlockLoc, markdown: string): string {
  const direct = block.text?.trim();
  if (direct) return normalizeInlineMathSpacing(stripPageComments(direct));
  if (
    Number.isInteger(block.mdStart) &&
    Number.isInteger(block.mdEnd) &&
    block.mdStart >= 0 &&
    block.mdEnd > block.mdStart &&
    block.mdEnd <= markdown.length
  ) {
    return normalizeInlineMathSpacing(
      stripPageComments(markdown.slice(block.mdStart, block.mdEnd)),
    );
  }
  return "";
}

function stripPageComments(text: string): string {
  return text.replace(PAGE_COMMENT_RE, "").trim();
}

function classifyChunk(chunk: string): { type: BlockType; assetPath?: string } {
  const trimmed = chunk.trim();
  if (/^#{1,6}\s+/.test(trimmed)) return { type: "heading" };
  if (/^\$\$[\s\S]+\$\$$/.test(trimmed)) return { type: "equation" };
  if (
    /^\|.+\|\s*\n\|[\s:|-]+\|/m.test(trimmed) ||
    /^<table[\s>]/i.test(trimmed)
  ) {
    return { type: "table" };
  }
  const img = IMAGE_LINK_RE.exec(trimmed);
  if (img && trimmed.replace(IMAGE_LINK_RE, "").trim().length < 24) {
    return { type: "image", assetPath: (img[2] || img[3] || "").trim() };
  }
  if (/^(?:Fig\.?|Figure|Table|Tab\.?|图|表)\s*\d+/i.test(trimmed)) {
    return { type: "caption" };
  }
  if (/^>\s+/.test(trimmed)) return { type: "blockquote" };
  if (/^(?:```|~~~)/.test(trimmed)) return { type: "preformatted" };
  return { type: "paragraph" };
}

/**
 * Fallback virtual blocks built directly from hosted Markdown when `blocks.json`
 * is missing or empty (e.g., synced Markdown or pre-map conversions).
 */
export function fallbackBlocksFromMarkdown(markdown: string): BlockLoc[] {
  if (!markdown.trim()) return [];
  const markers: Array<{
    pageIndex: number;
    pageLabel?: string;
    start: number;
    end: number;
  }> = [];
  for (const match of markdown.matchAll(PAGE_COMMENT_RE)) {
    const pageNum = Number(match[1]);
    if (!Number.isInteger(pageNum) || pageNum < 1) continue;
    markers.push({
      pageIndex: pageNum - 1,
      pageLabel: match[2]?.trim() || undefined,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  const sections: Array<{
    pageIndex: number;
    pageLabel?: string;
    start: number;
    end: number;
  }> = [];
  if (markers.length) {
    for (let i = 0; i < markers.length; i++) {
      sections.push({
        pageIndex: markers[i].pageIndex,
        pageLabel: markers[i].pageLabel,
        start: markers[i].end,
        end: i + 1 < markers.length ? markers[i + 1].start : markdown.length,
      });
    }
  } else {
    sections.push({ pageIndex: -1, start: 0, end: markdown.length });
  }
  const blocks: BlockLoc[] = [];
  for (const section of sections) {
    const slice = markdown.slice(section.start, section.end);
    const re = /\S[\s\S]*?(?=\r?\n\s*\r?\n|$)/g;
    for (const match of slice.matchAll(re)) {
      const text = match[0].trim();
      if (!text) continue;
      const offset = section.start + (match.index ?? 0);
      const info = classifyChunk(text);
      blocks.push({
        type: info.type,
        pageIndex: section.pageIndex,
        ...(section.pageLabel ? { pageLabel: section.pageLabel } : {}),
        text,
        ...(info.assetPath ? { assetPath: info.assetPath } : {}),
        mdStart: offset,
        mdEnd: offset + match[0].length,
      });
    }
  }
  return blocks;
}

// ---- Math-tolerant normalization & token matching ----

function replaceLigatures(text: string): string {
  return text
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-");
}

/** Normalize prose/Markdown/PDF text so equations, ligatures and hyphenation do not break matching. */
export function normalizeComparable(text: string): string {
  return replaceLigatures(stripPageComments(text))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, " $1 ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, " $1 ")
    .replace(/<[^>]+>/g, " ")
    .replace(/([A-Za-z])-\s*\r?\n\s*([A-Za-z])/g, "$1$2")
    .replace(/([A-Za-z])-\s+([a-z])/g, "$1$2")
    .replace(/\\[A-Za-z]+/g, " ")
    .replace(/[$\\{}^_*`~#>|]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeComparable(text: string): string[] {
  const norm = normalizeComparable(text);
  if (!norm) return [];
  const tokens: string[] = [];
  for (const match of norm.matchAll(
    /[a-z0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu,
  )) {
    const raw = match[0];
    if (/^[a-z0-9]+$/.test(raw)) {
      if (raw.length >= 2 || /^\d$/.test(raw)) tokens.push(raw);
    } else if (raw.length === 1) {
      tokens.push(raw);
    } else {
      for (let i = 0; i < raw.length - 1; i++) {
        tokens.push(raw.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

function tokenCoverage(
  selectionTokens: readonly string[],
  candidateTokens: readonly string[],
): { selectionCoverage: number; candidateCoverage: number } {
  if (!selectionTokens.length || !candidateTokens.length) {
    return { selectionCoverage: 0, candidateCoverage: 0 };
  }
  const bag = new Map<string, number>();
  for (const tok of candidateTokens) {
    bag.set(tok, (bag.get(tok) || 0) + 1);
  }
  let hits = 0;
  for (const tok of selectionTokens) {
    const count = bag.get(tok) || 0;
    if (count > 0) {
      hits += 1;
      bag.set(tok, count - 1);
    }
  }
  return {
    selectionCoverage: hits / selectionTokens.length,
    candidateCoverage: hits / candidateTokens.length,
  };
}

// ---- Geometry helpers ----

function rectArea(r: NormRect): number {
  return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
}

function intersectionArea(
  a: NormRect,
  b: NormRect,
  padX = 0,
  padY = padX,
): number {
  const x1 = Math.max(a[0], b[0] - padX);
  const y1 = Math.max(a[1], b[1] - padY);
  const x2 = Math.min(a[2], b[2] + padX);
  const y2 = Math.min(a[3], b[3] + padY);
  return x2 > x1 && y2 > y1 ? (x2 - x1) * (y2 - y1) : 0;
}

function unionRect(rects: readonly NormRect[]): NormRect | undefined {
  if (!rects.length) return undefined;
  let x1 = 1;
  let y1 = 1;
  let x2 = 0;
  let y2 = 0;
  for (const r of rects) {
    x1 = Math.min(x1, r[0]);
    y1 = Math.min(y1, r[1]);
    x2 = Math.max(x2, r[2]);
    y2 = Math.max(y2, r[3]);
  }
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : undefined;
}

function selectionOverlapStats(
  selRects: readonly NormRect[],
  blockRects: readonly NormRect[],
  padX = 0.005,
  padY = 0.0015,
): { selFraction: number; maxRectFraction: number; blockFraction: number } {
  if (!selRects.length || !blockRects.length) {
    return { selFraction: 0, maxRectFraction: 0, blockFraction: 0 };
  }
  let totalSelArea = 0;
  let coveredSelArea = 0;
  let maxRectFraction = 0;
  for (const s of selRects) {
    const area = rectArea(s);
    if (area <= 0) continue;
    totalSelArea += area;
    let best = 0;
    for (const b of blockRects) {
      best = Math.max(best, intersectionArea(s, b, padX, padY));
    }
    coveredSelArea += Math.min(area, best);
    maxRectFraction = Math.max(maxRectFraction, Math.min(1, best / area));
  }
  let totalBlockArea = 0;
  let coveredBlockArea = 0;
  for (const b of blockRects) {
    const area = rectArea(b);
    if (area <= 0) continue;
    totalBlockArea += area;
    let covered = 0;
    for (const s of selRects) {
      covered += intersectionArea(s, b, padX, padY);
    }
    coveredBlockArea += Math.min(area, covered);
  }
  return {
    selFraction: totalSelArea > 0 ? coveredSelArea / totalSelArea : 0,
    maxRectFraction,
    blockFraction: totalBlockArea > 0 ? coveredBlockArea / totalBlockArea : 0,
  };
}

// ---- Sub-span extraction inside clean Markdown without slicing LaTeX ----

type MathRange = { start: number; end: number };

function findMathRanges(md: string): MathRange[] {
  const ranges: MathRange[] = [];
  const re =
    /\$\$[\s\S]+?\$\$|\$(?!\s)(?:\\.|[^$\\\n])+(?<!\s)\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/g;
  for (const m of md.matchAll(re)) {
    const start = m.index ?? 0;
    ranges.push({ start, end: start + m[0].length });
  }
  return ranges;
}

type IndexedToken = { token: string; start: number; end: number };

function indexMarkdownTokens(md: string): IndexedToken[] {
  const mathRanges = findMathRanges(md);
  const inMath = (pos: number) =>
    mathRanges.some((r) => pos >= r.start && pos < r.end);
  const out: IndexedToken[] = [];
  const wordRe =
    /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
  for (const m of md.matchAll(wordRe)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (inMath(start)) continue;
    const raw = replaceLigatures(m[0]).toLowerCase();
    if (/^[a-z0-9'’-]+$/.test(raw)) {
      const cleaned = raw.replace(/['’-]/g, "");
      if (cleaned.length >= 2 || /^\d$/.test(cleaned)) {
        out.push({ token: cleaned, start, end });
      }
    } else if (raw.length === 1) {
      out.push({ token: raw, start, end });
    } else {
      for (let i = 0; i < raw.length - 1; i++) {
        out.push({
          token: raw.slice(i, i + 2),
          start: start + i,
          end: start + i + 2,
        });
      }
    }
  }
  return out;
}

function expandAcrossMath(
  md: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s = start;
  let e = end;
  for (const r of findMathRanges(md)) {
    if (r.start < s && r.end > s) s = r.start;
    if (r.start < e && r.end > e) e = r.end;
  }
  // Include trailing sentence punctuation or closing bracket directly attached.
  while (e < md.length && /[.,;:!?。，；：！？)\]”’"']/.test(md[e])) {
    e += 1;
  }
  return { start: s, end: e };
}

/**
 * Extract the clean Markdown sub-span corresponding to `selection` inside
 * `paragraphMd`, preserving inline LaTeX formulas intact. Returns `undefined`
 * when alignment is not sharp enough (caller then keeps raw selection safely).
 */
export function extractCleanSubSpan(
  paragraphMd: string,
  selection: string,
): string | undefined {
  const selTokens = tokenizeComparable(selection);
  if (selTokens.length < 3) return undefined;
  const indexed = indexMarkdownTokens(paragraphMd);
  if (indexed.length < selTokens.length * 0.5) return undefined;

  const anchorLen = Math.min(3, Math.max(2, Math.floor(selTokens.length / 3)));
  const startAnchors = selTokens.slice(0, anchorLen);
  const endAnchors = selTokens.slice(-anchorLen);

  const startCandidates: number[] = [];
  for (let i = 0; i < indexed.length; i++) {
    if (indexed[i].token === startAnchors[0]) {
      startCandidates.push(i);
    } else if (
      startAnchors.length > 1 &&
      indexed[i].token === startAnchors[1] &&
      i > 0
    ) {
      startCandidates.push(i - 1);
    }
  }
  const endCandidates: number[] = [];
  const lastAnchor = endAnchors[endAnchors.length - 1];
  const prevAnchor =
    endAnchors.length > 1 ? endAnchors[endAnchors.length - 2] : undefined;
  for (let i = 0; i < indexed.length; i++) {
    if (indexed[i].token === lastAnchor) {
      endCandidates.push(i);
    } else if (prevAnchor && indexed[i].token === prevAnchor) {
      endCandidates.push(Math.min(indexed.length - 1, i + 1));
    }
  }
  if (!startCandidates.length || !endCandidates.length) return undefined;

  let best:
    { score: number; start: number; end: number; cov: number } | undefined;
  for (const si of startCandidates) {
    for (const ei of endCandidates) {
      if (ei < si) continue;
      const spanLen = ei - si + 1;
      if (
        spanLen < selTokens.length * 0.45 ||
        spanLen > selTokens.length * 1.9 + 6
      ) {
        continue;
      }
      const sliceTokens = indexed.slice(si, ei + 1).map((t) => t.token);
      const { selectionCoverage, candidateCoverage } = tokenCoverage(
        selTokens,
        sliceTokens,
      );
      if (selectionCoverage < 0.65 || candidateCoverage < 0.55) continue;
      const edgeBonus =
        (indexed[si].token === startAnchors[0] ? 0.1 : 0) +
        (indexed[ei].token === lastAnchor ? 0.1 : 0);
      const score =
        selectionCoverage * 0.6 + candidateCoverage * 0.4 + edgeBonus;
      if (!best || score > best.score) {
        best = {
          score,
          start: indexed[si].start,
          end: indexed[ei].end,
          cov: selectionCoverage,
        };
      }
    }
  }
  if (!best) return undefined;
  const expanded = expandAcrossMath(paragraphMd, best.start, best.end);
  const extracted = paragraphMd.slice(expanded.start, expanded.end).trim();
  if (!extracted || extracted.length > MAX_ALIGNED_CHARS) return undefined;
  return extracted;
}

// ---- Main selection alignment ----

function sortReadingOrder(
  entries: Array<{
    block: BlockLoc;
    rects: NormRect[];
    text: string;
  }>,
) {
  return [...entries].sort((a, b) => {
    if (a.block.pageIndex !== b.block.pageIndex) {
      return a.block.pageIndex - b.block.pageIndex;
    }
    if (a.block.mdStart !== b.block.mdStart) {
      return a.block.mdStart - b.block.mdStart;
    }
    const ay = a.rects[0]?.[1] ?? 0;
    const by = b.rects[0]?.[1] ?? 0;
    if (Math.abs(ay - by) > 0.01) return ay - by;
    return (a.rects[0]?.[0] ?? 0) - (b.rects[0]?.[0] ?? 0);
  });
}

/**
 * If a strictly smaller contiguous sub-slice of `ordered` already explains >= 90%
 * of the selection tokens covered by the whole list, drop the redundant outer
 * neighboring paragraphs (e.g. grazed by slightly loose OCR boxes or DPI drift).
 */
function pruneToMinimalCover<T extends { block: BlockLoc; text: string }>(
  ordered: readonly T[],
  selTokens: readonly string[],
): T[] {
  if (ordered.length <= 1 || selTokens.length < 3) return [...ordered];
  const tokenLists = ordered.map((entry) => tokenizeComparable(entry.text));
  const fullCov = tokenCoverage(selTokens, tokenLists.flat()).selectionCoverage;
  if (fullCov <= 0) return [...ordered];
  for (let len = 1; len < ordered.length; len++) {
    let bestSlice:
      { start: number; cov: number; tightness: number } | undefined;
    for (let start = 0; start + len <= ordered.length; start++) {
      const subTokens = tokenLists.slice(start, start + len).flat();
      const { selectionCoverage, candidateCoverage } = tokenCoverage(
        selTokens,
        subTokens,
      );
      if (selectionCoverage < fullCov * 0.9 || selectionCoverage < 0.7) {
        continue;
      }
      if (
        !bestSlice ||
        selectionCoverage > bestSlice.cov + 0.02 ||
        (Math.abs(selectionCoverage - bestSlice.cov) <= 0.02 &&
          candidateCoverage > bestSlice.tightness)
      ) {
        bestSlice = {
          start,
          cov: selectionCoverage,
          tightness: candidateCoverage,
        };
      }
    }
    if (bestSlice) {
      return ordered.slice(bestSlice.start, bestSlice.start + len);
    }
  }
  return [...ordered];
}

function finalizeMatch(
  matched: BlockLoc[],
  markdown: string,
  selection: string,
  via: "geometry" | "text",
): AlignedSelection {
  const texts = matched
    .map((block) => blockMarkdownText(block, markdown))
    .filter(Boolean);
  if (!texts.length) return { kind: "none" };
  const paragraphText = texts.join("\n\n").trim();
  if (!paragraphText || paragraphText.length > MAX_ALIGNED_CHARS) {
    return { kind: "none" };
  }
  const selTokens = tokenizeComparable(selection);
  const paraTokens = tokenizeComparable(paragraphText);
  const { candidateCoverage } = tokenCoverage(selTokens, paraTokens);
  const allStructured = matched.every(
    (b) =>
      b.type === "equation" ||
      b.type === "table" ||
      b.type === "caption" ||
      b.type === "heading",
  );
  let selectionText = selection;
  let selectionEnhanced = false;
  if (allStructured || candidateCoverage >= 0.72) {
    selectionText = paragraphText;
    selectionEnhanced = true;
  } else {
    const sub = extractCleanSubSpan(paragraphText, selection);
    if (sub) {
      selectionText = sub;
      selectionEnhanced = true;
    }
  }
  const visualBlocks = matched.filter(
    (b) => b.type === "image" || b.type === "table" || b.type === "equation",
  );
  return {
    kind: "matched",
    selectionText,
    selectionEnhanced,
    paragraphText,
    paragraphCount: texts.length,
    via,
    blocks: matched,
    visualBlocks,
  };
}

/**
 * Align a PDF text selection to its corresponding clean Markdown block(s),
 * preferring position-map geometry (verified by math-tolerant text overlap)
 * and falling back to page-scoped text alignment when geometry is unavailable.
 */
export function alignSelectionToMarkdown(
  input: SelectionAlignInput,
): AlignedSelection {
  const selection = input.selection.trim();
  if (!selection || !input.markdown.trim()) return { kind: "none" };
  // Guard against legacy cached `blocks.json` where failed offset matches fell
  // back to the entire page slice (multiple blocks sharing identical offsets).
  const hasDegeneratePageSlice = (pageIdx: number): boolean => {
    const onPage = input.blocks.filter(
      (b) => b.pageIndex === pageIdx && !b.text?.trim() && b.mdEnd > b.mdStart,
    );
    if (onPage.length < 2) return false;
    const spanCounts = new Map<string, number>();
    for (const b of onPage) {
      const key = `${b.mdStart}:${b.mdEnd}`;
      const next = (spanCounts.get(key) || 0) + 1;
      if (next >= 2) return true;
      spanCounts.set(key, next);
    }
    return false;
  };
  const fallbackBlocks =
    !input.blocks.length || hasDegeneratePageSlice(input.pageIndex)
      ? fallbackBlocksFromMarkdown(input.markdown)
      : [];
  const pageFallbacks = fallbackBlocks.filter(
    (b) => b.pageIndex === input.pageIndex,
  );
  const replacementFallbacks = pageFallbacks.length
    ? pageFallbacks
    : fallbackBlocks.filter((b) => b.pageIndex < 0);
  const sourceBlocks = input.blocks.length
    ? hasDegeneratePageSlice(input.pageIndex)
      ? [
          ...input.blocks.filter((b) => b.pageIndex !== input.pageIndex),
          ...replacementFallbacks,
        ]
      : [...input.blocks]
    : fallbackBlocks;
  if (!sourceBlocks.length) return { kind: "none" };

  const selTokens = tokenizeComparable(selection);
  const selNorm = normalizeComparable(selection);

  // 1. Geometry-first alignment on touched page(s)
  const pageSelection = new Map<
    number,
    { rects: NormRect[]; viewBox?: readonly number[] }
  >();
  const primaryRects = pdfRectsToFractions(input.rects, input.viewBox);
  if (primaryRects.length) {
    pageSelection.set(input.pageIndex, {
      rects: primaryRects,
      viewBox: input.viewBox,
    });
  }
  const nextRects = pdfRectsToFractions(
    input.nextPageRects,
    input.nextViewBox ?? input.viewBox,
  );
  if (nextRects.length) {
    pageSelection.set(input.pageIndex + 1, {
      rects: nextRects,
      viewBox: input.nextViewBox ?? input.viewBox,
    });
  }

  if (pageSelection.size) {
    const geomHits: Array<{
      block: BlockLoc;
      rects: NormRect[];
      text: string;
      selFraction: number;
      maxRectFraction: number;
      cov: number;
    }> = [];
    for (const [pageIdx, selInfo] of pageSelection) {
      const pageBlocks = sourceBlocks.filter((b) => b.pageIndex === pageIdx);
      for (const block of pageBlocks) {
        if (block.type === "image") continue;
        const bRects = blockRectsToFractions(
          block,
          pageBlocks,
          selInfo.viewBox,
        );
        if (!bRects.length) continue;
        const stats = selectionOverlapStats(selInfo.rects, bRects);
        if (stats.maxRectFraction < 0.25 && stats.selFraction < 0.12) continue;
        const text = blockMarkdownText(block, input.markdown);
        if (!text) continue;
        const { selectionCoverage } = tokenCoverage(
          selTokens,
          tokenizeComparable(text),
        );
        if (stats.selFraction >= 0.15 || stats.maxRectFraction >= 0.55) {
          geomHits.push({
            block,
            rects: bRects,
            text,
            selFraction: stats.selFraction,
            maxRectFraction: stats.maxRectFraction,
            cov: selectionCoverage,
          });
        }
      }
      // Include display equations bracketed vertically by the selection box on this page.
      const selUnion = unionRect(selInfo.rects);
      if (selUnion) {
        for (const block of pageBlocks) {
          if (block.type !== "equation") continue;
          if (geomHits.some((h) => h.block === block)) continue;
          const bRects = blockRectsToFractions(
            block,
            pageBlocks,
            selInfo.viewBox,
          );
          const bUnion = unionRect(bRects);
          if (!bUnion) continue;
          const horizOverlap =
            Math.min(selUnion[2], bUnion[2]) - Math.max(selUnion[0], bUnion[0]);
          const withinY =
            bUnion[1] >= selUnion[1] - 0.01 && bUnion[3] <= selUnion[3] + 0.01;
          if (horizOverlap > 0.05 && withinY) {
            const text = blockMarkdownText(block, input.markdown);
            if (text) {
              geomHits.push({
                block,
                rects: bRects,
                text,
                selFraction: 0.25,
                maxRectFraction: 0.5,
                cov: 0,
              });
            }
          }
        }
      }
    }

    if (geomHits.length) {
      const ordered = pruneToMinimalCover(
        sortReadingOrder(geomHits),
        selTokens,
      );
      const combinedText = ordered.map((e) => e.text).join("\n\n");
      const { selectionCoverage } = tokenCoverage(
        selTokens,
        tokenizeComparable(combinedText),
      );
      const totalSelFraction = geomHits.reduce(
        (sum, h) => sum + h.selFraction,
        0,
      );
      const hasFormulaOrTable = ordered.some(
        (h) => h.block.type === "equation" || h.block.type === "table",
      );
      const shortExact =
        selNorm.length >= 3 &&
        normalizeComparable(combinedText).includes(selNorm);
      const accepted =
        shortExact ||
        selectionCoverage >= 0.45 ||
        (hasFormulaOrTable &&
          totalSelFraction >= 0.4 &&
          (selectionCoverage >= 0.2 || selTokens.length < 4));
      if (accepted) {
        return finalizeMatch(
          ordered.map((e) => e.block),
          input.markdown,
          selection,
          "geometry",
        );
      }
    }
  }

  // 2. Page-scoped text fallback (works even for synced/legacy Markdown without geometry)
  const pageSpecific = sourceBlocks.filter(
    (b) =>
      b.type !== "image" &&
      (b.pageIndex === input.pageIndex ||
        (input.nextPageRects?.length && b.pageIndex === input.pageIndex + 1)),
  );
  const pageLess = !pageSpecific.length
    ? sourceBlocks.filter((b) => b.type !== "image" && b.pageIndex < 0)
    : [];
  const pool = pageSpecific.length ? pageSpecific : pageLess;
  if (!pool.length) return { kind: "none" };
  const strictDocWide = pageSpecific.length === 0;
  const minCoverage = strictDocWide ? 0.8 : 0.65;
  if (selTokens.length < 2 && selNorm.length < 6) return { kind: "none" };

  const entries = pool
    .map((block) => {
      const text = blockMarkdownText(block, input.markdown);
      return { block, text, tokens: tokenizeComparable(text) };
    })
    .filter((entry) => entry.text && entry.tokens.length);

  type WindowCandidate = {
    blocks: BlockLoc[];
    coverage: number;
    tightness: number;
    score: number;
    startIdx: number;
    endIdx: number;
  };
  const candidates: WindowCandidate[] = [];
  for (let i = 0; i < entries.length; i++) {
    let combinedTokens: string[] = [];
    for (let span = 1; span <= 3 && i + span <= entries.length; span++) {
      const current = entries[i + span - 1];
      combinedTokens = combinedTokens.concat(current.tokens);
      const { selectionCoverage, candidateCoverage } = tokenCoverage(
        selTokens,
        combinedTokens,
      );
      if (selectionCoverage < minCoverage) continue;
      // Avoid attaching extra unrelated blocks just to gain negligible coverage.
      if (span > 1) {
        const prev = candidates.find(
          (c) => c.startIdx === i && c.endIdx === i + span - 2,
        );
        if (prev && selectionCoverage - prev.coverage < 0.12) continue;
      }
      const score = selectionCoverage * 0.78 + candidateCoverage * 0.22;
      candidates.push({
        blocks: entries.slice(i, i + span).map((e) => e.block),
        coverage: selectionCoverage,
        tightness: candidateCoverage,
        score,
        startIdx: i,
        endIdx: i + span - 1,
      });
    }
  }
  if (!candidates.length) return { kind: "none" };
  candidates.sort((a, b) => b.score - a.score || b.tightness - a.tightness);
  const best = candidates[0];
  if (strictDocWide) {
    const disjointSecond = candidates.find(
      (c) => c.endIdx < best.startIdx || c.startIdx > best.endIdx,
    );
    if (disjointSecond && best.score - disjointSecond.score < 0.08) {
      return { kind: "none" };
    }
  }
  const pruned = pruneToMinimalCover(
    best.blocks.map((block) => ({
      block,
      text: blockMarkdownText(block, input.markdown),
    })),
    selTokens,
  );
  return finalizeMatch(
    pruned.map((e) => e.block),
    input.markdown,
    selection,
    "text",
  );
}

// ---- Visual / Area region alignment (figures, tables, equations) ----

function visualKindOf(type: BlockType): AlignedVisualRegion["kind"] {
  if (type === "image") return "figure";
  if (type === "table") return "table";
  if (type === "equation") return "equation";
  return "text";
}

function findAdjacentCaption(
  targetRect: NormRect,
  pageBlocks: readonly BlockLoc[],
  markdown: string,
  viewBox?: readonly number[],
): string | undefined {
  let best: { dist: number; text: string } | undefined;
  for (const block of pageBlocks) {
    if (block.type !== "caption") continue;
    const text = blockMarkdownText(block, markdown);
    if (!text) continue;
    const rects = blockRectsToFractions(block, pageBlocks, viewBox);
    const box = unionRect(rects);
    if (!box) continue;
    const horizOverlap =
      Math.min(targetRect[2], box[2]) - Math.max(targetRect[0], box[0]);
    if (horizOverlap <= 0) continue;
    const dist =
      box[1] >= targetRect[3]
        ? box[1] - targetRect[3]
        : targetRect[1] >= box[3]
          ? targetRect[1] - box[3]
          : 0;
    if (dist > 0.12) continue;
    if (!best || dist < best.dist) best = { dist, text };
  }
  return best?.text;
}

/**
 * Align a PDF area / image annotation rectangle to the matching figure, table,
 * equation, or text block on the position map (including adjacent captions).
 */
export function alignRegionToVisual(
  input: VisualRegionAlignInput,
): AlignedVisualRegion | undefined {
  const selRects = pdfRectsToFractions(input.rects, input.viewBox);
  if (!selRects.length || !input.blocks.length) return undefined;
  const pageBlocks = input.blocks.filter(
    (b) => b.pageIndex === input.pageIndex,
  );
  if (!pageBlocks.length) return undefined;

  type Hit = {
    block: BlockLoc;
    box: NormRect;
    priority: number;
    overlap: number;
  };
  const hits: Hit[] = [];
  for (const block of pageBlocks) {
    const bRects = blockRectsToFractions(block, pageBlocks, input.viewBox);
    const box = unionRect(bRects);
    if (!box) continue;
    const stats = selectionOverlapStats(selRects, bRects, 0.012);
    const overlap = Math.max(stats.selFraction, stats.blockFraction);
    if (overlap < 0.15) continue;
    const priority =
      block.type === "image" ||
      block.type === "table" ||
      block.type === "equation"
        ? 3
        : block.type === "caption"
          ? 2
          : 1;
    hits.push({ block, box, priority, overlap });
  }
  if (!hits.length) return undefined;
  hits.sort((a, b) => b.priority - a.priority || b.overlap - a.overlap);
  const chosen = hits[0];
  let assetPath = chosen.block.assetPath;
  let caption =
    chosen.block.caption ||
    (chosen.block.type === "caption"
      ? blockMarkdownText(chosen.block, input.markdown)
      : undefined);
  let kind = visualKindOf(chosen.block.type);

  // If the user boxed the caption, link the adjacent figure/table asset.
  if (chosen.block.type === "caption" && !assetPath) {
    const nearbyVisual = hits.find(
      (h) => h.block.type === "image" || h.block.type === "table",
    );
    if (nearbyVisual) {
      assetPath = nearbyVisual.block.assetPath;
      kind = visualKindOf(nearbyVisual.block.type);
    }
  }
  if ((kind === "figure" || kind === "table") && !caption) {
    caption = findAdjacentCaption(
      chosen.box,
      pageBlocks,
      input.markdown,
      input.viewBox,
    );
  }
  const markdownText = blockMarkdownText(chosen.block, input.markdown);
  return {
    kind,
    pageIndex: input.pageIndex,
    block: chosen.block,
    ...(assetPath ? { assetPath } : {}),
    ...(caption ? { caption } : {}),
    ...(markdownText ? { markdownText } : {}),
  };
}

/**
 * List hoverable figure, table and display-equation regions on one PDF page.
 * Merges each figure/table with its nearest adjacent caption so the hover
 * outline wraps both the graphic and its title cleanly.
 */
export function listPageVisualTargets(input: {
  markdown: string;
  blocks: readonly BlockLoc[];
  pageIndex: number;
  viewBox?: readonly number[];
}): PageVisualTarget[] {
  const pageBlocks = input.blocks.filter(
    (b) => b.pageIndex === input.pageIndex,
  );
  if (!pageBlocks.length) return [];

  const captions: Array<{ block: BlockLoc; box: NormRect; text: string }> = [];
  for (const block of pageBlocks) {
    if (block.type !== "caption") continue;
    const text = blockMarkdownText(block, input.markdown);
    if (!text) continue;
    const box = unionRect(
      blockRectsToFractions(block, pageBlocks, input.viewBox),
    );
    if (box) captions.push({ block, box, text });
  }

  const rawTargets: Array<{
    kind: PageVisualTarget["kind"];
    block: BlockLoc;
    box: NormRect;
    assetPath?: string;
    caption?: string;
    markdownText?: string;
  }> = [];

  for (const block of pageBlocks) {
    if (
      block.type !== "image" &&
      block.type !== "table" &&
      block.type !== "equation"
    ) {
      continue;
    }
    const box = unionRect(
      blockRectsToFractions(block, pageBlocks, input.viewBox),
    );
    if (!box) continue;
    const w = box[2] - box[0];
    const h = box[3] - box[1];
    // Drop stray tiny boxes (e.g. equation numbers or micro artifacts).
    if (w < 0.03 || h < 0.018) continue;
    const kind =
      block.type === "image"
        ? "figure"
        : block.type === "table"
          ? "table"
          : "equation";
    const markdownText = blockMarkdownText(block, input.markdown);
    rawTargets.push({
      kind,
      block,
      box,
      ...(block.assetPath ? { assetPath: block.assetPath } : {}),
      ...(block.caption ? { caption: block.caption } : {}),
      ...(markdownText ? { markdownText } : {}),
    });
  }

  // Merge each unclaimed caption into its closest figure/table host.
  const claimedCaptions = new Set<number>();
  for (const target of rawTargets) {
    if (target.kind !== "figure" && target.kind !== "table") continue;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < captions.length; i++) {
      if (claimedCaptions.has(i)) continue;
      const cap = captions[i];
      const horizOverlap =
        Math.min(target.box[2], cap.box[2]) -
        Math.max(target.box[0], cap.box[0]);
      const minW = Math.min(
        target.box[2] - target.box[0],
        cap.box[2] - cap.box[0],
      );
      if (minW <= 0 || horizOverlap / minW < 0.25) continue;
      const dist =
        cap.box[1] >= target.box[3]
          ? cap.box[1] - target.box[3]
          : target.box[1] >= cap.box[3]
            ? target.box[1] - cap.box[3]
            : 0;
      if (dist > 0.065) continue;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      claimedCaptions.add(bestIdx);
      const cap = captions[bestIdx];
      target.box = unionRect([target.box, cap.box]) ?? target.box;
      if (!target.caption) target.caption = cap.text;
    }
  }

  // Deduplicate heavily overlapping regions of the same kind (keep larger/richer).
  const deduped: typeof rawTargets = [];
  for (const candidate of rawTargets) {
    const dup = deduped.find((existing) => {
      if (existing.kind !== candidate.kind) return false;
      const inter = intersectionArea(existing.box, candidate.box);
      const minArea = Math.min(rectArea(existing.box), rectArea(candidate.box));
      return minArea > 0 && inter / minArea >= 0.8;
    });
    if (!dup) deduped.push(candidate);
  }

  return deduped.map((item, index) => ({
    id: `v-${input.pageIndex}-${index}`,
    kind: item.kind,
    pageIndex: input.pageIndex,
    bbox: item.box,
    block: item.block,
    ...(item.assetPath ? { assetPath: item.assetPath } : {}),
    ...(item.caption ? { caption: item.caption } : {}),
    ...(item.markdownText ? { markdownText: item.markdownText } : {}),
  }));
}

/** Pick the most specific (smallest-area) visual target containing normalized point `(nx, ny)`. */
export function pickVisualTargetAtPoint(
  targets: readonly PageVisualTarget[],
  nx: number,
  ny: number,
): PageVisualTarget | undefined {
  let best: { target: PageVisualTarget; area: number } | undefined;
  for (const target of targets) {
    const [x1, y1, x2, y2] = target.bbox;
    if (nx < x1 || nx > x2 || ny < y1 || ny > y2) continue;
    const area = rectArea(target.bbox);
    if (!best || area < best.area) best = { target, area };
  }
  return best?.target;
}

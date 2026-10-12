import type { PdfParagraphResult } from "./pdfParagraph";

type TextItem = {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
  bold?: boolean;
  /** Indices of the page's raw characters (Zotero selection order). */
  chars?: number[];
};

type Span = {
  x: number;
  y: number;
  end: number;
  size: number;
  text: string;
  hasEOL?: boolean;
  bold?: boolean;
  chars?: number[];
};
type Line = {
  x: number;
  y: number;
  end: number;
  size: number;
  text: string;
  column: number;
  heading?: boolean;
  caption?: boolean;
  breakBefore?: boolean;
  chars?: number[];
  page?: number;
};
/** A paragraph's visual lines, or why its boundaries are not confirmed. */
type Located =
  | { kind: "lines"; lines: Line[]; context: Line[] }
  | { kind: "unmatched"; detail?: string; partial?: Line[] }
  | { kind: "unavailable" };

type PageChar = {
  c: string;
  rect: number[];
  inlineRect?: number[];
  rotation?: number;
  ignorable?: boolean;
  isolated?: boolean;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  fontSize?: number;
  baseline?: number;
  fontName?: string;
};
type PageData = { chars?: PageChar[]; viewBox?: number[] };
type RuntimePDFWindow = {
  wrappedJSObject?: RuntimePDFWindow;
  Object?: new () => { pageIndex?: number };
  PDFViewerApplication?: {
    pdfDocument?: {
      numPages: number;
      getPageData?: (params: { pageIndex?: number }) => Promise<PageData>;
      getPage: (number: number) => Promise<{
        view: number[];
        getTextContent: () => Promise<{ items: TextItem[] }>;
      }>;
    };
  };
};
type RuntimePDFView = {
  _pdfPages?: Record<number, PageData>;
  _iframeWindow?: RuntimePDFWindow;
  _iframe?: { contentWindow?: RuntimePDFWindow };
  /** Zotero's own loader: runs inside the reader iframe, so it can call
   * pdfDocument.getPageData without crossing the plugin/content privilege
   * boundary (passing an object to the privileged call is denied there). */
  _ensureBasicPageData?: (pageIndex: number) => Promise<void>;
};

/** Convert Zotero's structured character rectangles into visual lines. */
export function paragraphFromPageData(
  data: PageData,
  selection: string,
  rects?: number[][],
): PdfParagraphResult {
  return publicResult(
    analyzePageSet(new Map([[0, data]]), new Set([-1, 1]), 0, selection, rects),
  );
}

/** The original single-paragraph analysis of one page. */
function singleFromPageData(
  data: PageData,
  selection: string,
  rects?: number[][],
): PdfParagraphResult {
  const geometry = pageGeometry(data, rects);
  return singleFromLayout(
    geometry.items,
    selection,
    geometry.width,
    geometry.rects,
  );
}

function shiftedGeometry(
  items: TextItem[],
  viewBox?: number[],
  rects?: number[][],
) {
  const x = viewBox?.[0] || 0;
  const y = viewBox?.[1] || 0;
  return {
    width: viewBox ? viewBox[2] - viewBox[0] : NaN,
    items: items.map((item) => {
      // PDF.js can interleave marked-content records without text geometry.
      if (!item.transform || item.transform.length < 6) return item;
      return {
        ...item,
        transform: [
          ...item.transform.slice(0, 4),
          item.transform[4] - x,
          item.transform[5] - y,
        ],
      };
    }),
    rects: rects?.map((rect) =>
      rect.length === 4
        ? [rect[0] - x, rect[1] - y, rect[2] - x, rect[3] - y]
        : rect,
    ),
  };
}

function pageGeometry(data: PageData, rects?: number[][]) {
  return shiftedGeometry(itemsFromPageData(data), data.viewBox, rects);
}

function itemsFromPageData(data: PageData): TextItem[] {
  const items: TextItem[] = [];
  let text = "";
  let box: number[] | undefined;
  let fontSizes: number[] = [];
  let baselines: number[] = [];
  let boldCount = 0;
  let charCount = 0;
  let indices: number[] = [];
  const flush = (hasEOL = false) => {
    if (box && text.trim()) {
      // Equations and superscripts enlarge glyph rectangles, not the body font.
      const size = frequentValue(fontSizes) ?? box[3] - box[1];
      const baseline = frequentValue(baselines) ?? box[1];
      items.push({
        str: text,
        transform: [size, 0, 0, size, box[0], baseline],
        width: box[2] - box[0],
        hasEOL,
        bold: boldCount > charCount * 0.7,
        chars: indices,
      });
    }
    box = undefined;
    text = "";
    fontSizes = [];
    baselines = [];
    boldCount = 0;
    charCount = 0;
    indices = [];
  };
  const chars = data.chars || [];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    const r = char.inlineRect || char.rect;
    if (!r || r.length !== 4 || !r.every(Number.isFinite)) continue;
    if (char.isolated || (char.rotation && char.rotation % 180 !== 0)) {
      flush();
      continue;
    }
    if (!char.ignorable) {
      // Some Zotero versions omit lineBreakAfter; also respect rectangle rows.
      const baseline = char.baseline ?? r[1];
      const size = char.fontSize ?? r[3] - r[1];
      if (
        box &&
        Math.abs(baseline - (baselines[0] ?? box[1])) > Math.max(4, size * 0.7)
      )
        flush(true);
      text += char.c;
      indices.push(index);
      if (char.spaceAfter) text += " ";
      if (Number.isFinite(char.fontSize)) fontSizes.push(char.fontSize!);
      if (Number.isFinite(char.baseline)) baselines.push(char.baseline!);
      charCount++;
      if (/bold|black|heavy/i.test(char.fontName || "")) boldCount++;
      box = box
        ? [
            Math.min(box[0], r[0]),
            Math.min(box[1], r[1]),
            Math.max(box[2], r[2]),
            Math.max(box[3], r[3]),
          ]
        : [...r];
    }
    if (char.lineBreakAfter) {
      // Keep a line-end soft hyphen until the line joiner removes it, so
      // "in-" + "dicate" becomes "indicate", never "in dicate".
      if (char.ignorable && char.c === "-") text = text.trimEnd() + "-";
      flush(true);
    }
  }
  flush(true);
  return items;
}

function frequentValue(values: number[]) {
  const counts = new Map<number, { count: number; value: number }>();
  for (const value of values) {
    const key = Math.round(value * 5);
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { count: 1, value });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.value;
}

/** Copy only numbers, by index. Calling a reader-owned Array's .map/.every
 * passes our privileged callback to the content compartment and Gecko denies
 * it. No reader method, iterator, JSON hook, or object is passed back here. */
function localNumbers(raw?: number[], length?: number): number[] | undefined {
  if (!raw) return undefined;
  const count = raw.length;
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > 10000 ||
    (length !== undefined && count !== length)
  )
    return undefined;
  const result: number[] = [];
  for (let index = 0; index < count; index++) {
    const value = raw[index];
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    result.push(value);
  }
  return result;
}

function localRects(raw?: number[][]): number[][] | undefined {
  if (!raw) return undefined;
  if (!Number.isSafeInteger(raw.length) || raw.length > 10000)
    throw new Error("selection-rectangles-invalid");
  const result: number[][] = [];
  for (let index = 0; index < raw.length; index++) {
    const rect = localNumbers(raw[index], 4);
    if (rect) result.push(rect);
  }
  return result;
}

/** Keep all paragraph analysis in the plugin's own compartment. Cached data
 * and getPageData results are both reader-owned, including their nested rects. */
function localPageData(raw?: PageData): PageData | undefined {
  if (!raw) return undefined;
  const chars = raw.chars;
  if (!chars?.length) return undefined;
  if (!Number.isSafeInteger(chars.length) || chars.length > 250000)
    throw new Error("page-character-count-invalid");
  const result: PageChar[] = [];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (!char) throw new Error("page-character-missing");
    const c = char.c;
    if (typeof c !== "string") throw new Error("page-character-text-invalid");
    const size = char.fontSize;
    const baseline = char.baseline;
    const font = char.fontName;
    const rotation = char.rotation;
    result.push({
      c,
      rect: localNumbers(char.rect, 4) || [],
      inlineRect: localNumbers(char.inlineRect, 4),
      fontSize:
        typeof size === "number" && Number.isFinite(size) ? size : undefined,
      baseline:
        typeof baseline === "number" && Number.isFinite(baseline)
          ? baseline
          : undefined,
      fontName: typeof font === "string" ? font : undefined,
      rotation:
        typeof rotation === "number" && Number.isFinite(rotation)
          ? rotation
          : undefined,
      ignorable: char.ignorable === true,
      isolated: char.isolated === true,
      spaceAfter: char.spaceAfter === true,
      lineBreakAfter: char.lineBreakAfter === true,
    });
  }
  return { chars: result, viewBox: localNumbers(raw.viewBox, 4) };
}

function localTextItems(raw: TextItem[]): TextItem[] {
  if (!Number.isSafeInteger(raw.length) || raw.length > 250000)
    throw new Error("text-item-count-invalid");
  const result: TextItem[] = [];
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    // PDF.js interleaves marked-content metadata with its text items.
    if (!item || typeof item.str !== "string") continue;
    const transform = localNumbers(item.transform, 6);
    if (!transform) continue;
    const width = item.width;
    const height = item.height;
    result.push({
      str: item.str,
      transform,
      width: typeof width === "number" ? width : undefined,
      height: typeof height === "number" ? height : undefined,
      bold: item.bold === true,
      hasEOL: item.hasEOL === true,
    });
  }
  return result;
}

/** Run a cross-boundary property read without letting a permission error kill
 * the whole view. Returns undefined on any throw. */
function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Resolve the PDF window for a view, probing each cross-boundary property so a
 * single denied read produces a precise diagnostic instead of aborting the
 * view. */
function probeWindow(
  view: RuntimePDFView,
  label: string,
  failures: string[],
):
  | {
      win: RuntimePDFWindow;
      doc?: NonNullable<
        NonNullable<RuntimePDFWindow["PDFViewerApplication"]>["pdfDocument"]
      >;
    }
  | undefined {
  const read = <T>(stage: string, get: () => T): T | undefined => {
    try {
      return get();
    } catch (error) {
      failures.push(`${label}-${stage}: ${String(error)}`);
      return undefined;
    }
  };
  const rawWindow = read(
    "window",
    () => view._iframeWindow || view._iframe?.contentWindow,
  );
  if (!rawWindow) {
    failures.push(`${label}:no-window`);
    return undefined;
  }
  const win =
    read("window-wrapper", () => rawWindow.wrappedJSObject) || rawWindow;
  const app = read("viewer-app", () => win.PDFViewerApplication);
  const doc = read("viewer-document", () => app?.pdfDocument);
  if (!doc) failures.push(`${label}:no-document`);
  return { win, doc };
}

/** Read page geometry from Zotero's own PDF.js viewer, not its flattened full-text cache. */
export async function getPdfLayoutParagraph(
  reader: _ZoteroTypes.ReaderInstance,
  selection: string,
  pageIndex: number | undefined,
  rects?: number[][],
  nextPageRects?: number[][],
): Promise<PdfParagraphResult | undefined> {
  if (pageIndex === undefined || pageIndex < 0 || !Number.isInteger(pageIndex))
    return undefined;
  try {
    rects = localRects(rects);
    nextPageRects = localRects(nextPageRects);
  } catch (error) {
    return {
      kind: "unavailable",
      detail: `selection-snapshot: ${String(error)}`,
    };
  }
  const failures: string[] = [];
  let lastResult: PdfParagraphResult | undefined;
  const internal = safe(() => reader._internalReader) || reader;
  const views = [
    { label: "last", rawView: safe(() => internal._lastView) },
    { label: "primary", rawView: safe(() => internal._primaryView) },
    { label: "secondary", rawView: safe(() => internal._secondaryView) },
  ];
  const visited = new Set<RuntimePDFView>();
  for (const { rawView, label } of views) {
    if (!rawView) continue;
    const view = rawView as unknown as RuntimePDFView;
    if (visited.has(view)) continue;
    visited.add(view);
    let stage = "page-load";
    try {
      // Probe each cross-boundary property individually: under Xray, even
      // reading _iframeWindow/PDFViewerApplication can throw, and the thrown
      // "Permission denied to pass object to privileged code" was previously
      // indistinguishable from a getPageData failure.
      // A selected page is normally cached already. Do not touch window or
      // document getters at all until uncached data or a text fallback is needed.
      let probed: ReturnType<typeof probeWindow>;
      let didProbe = false;
      const pdfWindow = () => {
        if (!didProbe) {
          didProbe = true;
          probed = probeWindow(view, label, failures);
        }
        return probed;
      };
      const readCache = (index: number) => {
        try {
          return localPageData(view._pdfPages?.[index]);
        } catch (error) {
          failures.push(`${label}-cache-snapshot-${index}: ${String(error)}`);
          return undefined;
        }
      };
      const loadPage = async (index: number) => {
        if (index < 0) return undefined;
        const cached = readCache(index);
        if (cached) return cached;
        const { win, doc } = pdfWindow() || {};
        const numPages = safe(() => doc?.numPages);
        if (numPages !== undefined && index >= numPages) return undefined;
        // Prefer Zotero's own loader: _ensureBasicPageData executes inside the
        // reader iframe, so its getPageData call never passes an object across
        // the plugin→content privilege boundary.
        // Method-call syntax binds `this` inside the Xray boundary; calling the
        // function via .call(view, ...) instead *passes* the view object to
        // privileged code and is itself denied.
        if (typeof safe(() => view._ensureBasicPageData) === "function") {
          try {
            // Fire the content-side loader but do NOT await its Promise: the
            // returned promise is itself a cross-boundary object that can be
            // denied. Poll _pdfPages instead — it fills in after the await
            // inside _ensureBasicPageData resolves.
            // Do not access .then/.catch on the reader-owned Promise either:
            // those also receive privileged callbacks. Only its cache matters.
            void view._ensureBasicPageData!(index);
            for (let attempt = 0; attempt < 40; attempt++) {
              const loaded = readCache(index);
              if (loaded) return loaded;
              const timer = ztoolkit.getGlobal("setTimeout");
              await new Promise<void>((resolve) => timer(resolve, 25));
            }
            failures.push(`${label}-ensure-page-data-${index}: cache-timeout`);
          } catch (error) {
            failures.push(
              (index === pageIndex
                ? "ensure-page-data: "
                : `ensure-page-data-${index}: `) + String(error),
            );
          }
        }
        if (typeof safe(() => doc?.getPageData) !== "function") {
          if (typeof safe(() => view._ensureBasicPageData) !== "function")
            failures.push(`${label}:no-loader`);
          return undefined;
        }
        try {
          // Invoke with an object created in the PDF window's compartment.
          // Structured-clone/sendWithPromise cannot always consume an object
          // from a privileged plugin sandbox directly.
          const params = win?.Object ? new win.Object() : {};
          params.pageIndex = index;
          const data = await doc!.getPageData!(params);
          return localPageData(data);
        } catch (error) {
          failures.push(
            (index === pageIndex ? "page-data: " : `page-data-${index}: `) +
              String(error),
          );
          return undefined;
        }
      };
      const current = await loadPage(pageIndex);
      if (current) {
        stage = "native-analysis";
        const pages = new Map([[pageIndex, current]]);
        const missing = new Set<number>();
        let analysis = analyzePageSet(
          pages,
          missing,
          pageIndex,
          selection,
          rects,
          nextPageRects,
        );
        // A selection or paragraph may continue on a neighbouring page;
        // annotations cover at most two pages, paragraphs one more.
        for (
          let round = 0;
          analysis.needPage !== undefined && round < 6;
          round++
        ) {
          const needed = analysis.needPage;
          const data =
            Math.abs(needed - pageIndex) <= 2
              ? await loadPage(needed)
              : undefined;
          if (data) pages.set(needed, data);
          else missing.add(needed);
          analysis = analyzePageSet(
            pages,
            missing,
            pageIndex,
            selection,
            rects,
            nextPageRects,
          );
        }
        // Confirmed multi-paragraph decisions come from the same native
        // characters; a text-stream fallback must not override them.
        if (analysis.kind === "ready" || analysis.multiParagraph)
          return publicResult(analysis);
        lastResult = publicResult(analysis);
      }
      const doc = pdfWindow()?.doc;
      const numPages = safe(() => doc?.numPages);
      if (!doc) {
        failures.push(label + "-document-missing");
        continue;
      }
      if (numPages !== undefined && pageIndex >= numPages) {
        failures.push("page-out-of-range");
        continue;
      }
      try {
        const page = await doc.getPage(pageIndex + 1);
        const content = await page.getTextContent();
        const geometry = shiftedGeometry(
          localTextItems(content.items),
          localNumbers(page.view, 4),
          rects,
        );
        const result = paragraphFromLayout(
          geometry.items,
          selection,
          geometry.width,
          geometry.rects,
        );
        if (result.kind === "ready" || result.multiParagraph) return result;
        lastResult = result;
        failures.push("text-content-no-usable-geometry");
      } catch (error) {
        failures.push("text-content: " + String(error));
      }
    } catch (error) {
      failures.push(`${label}-${stage}: ${String(error)}`);
    }
  }
  if (lastResult?.kind === "unmatched" || lastResult?.kind === "too-long")
    return lastResult;
  return {
    kind: "unavailable",
    detail: (failures.join("; ") || "reader-view-missing").slice(0, 360),
  };
}

type Analysis = PdfParagraphResult & { needPage?: number };

function publicResult(analysis: Analysis): PdfParagraphResult {
  const { needPage: _needPage, ...result } = analysis;
  return result;
}

/** Single-paragraph analysis first (unchanged), then neighbouring-page
 * continuations, then the multi-paragraph extension. `needPage` asks the
 * caller to load another page and analyse again. */
function analyzePageSet(
  pages: Map<number, PageData>,
  missing: Set<number>,
  pageIndex: number,
  selection: string,
  rects?: number[][],
  nextPageRects?: number[][],
): Analysis {
  const current = pages.get(pageIndex)!;
  const single = singleFromPageData(current, selection, rects);
  if (single.kind === "ready") return single;
  if (single.kind === "unmatched") {
    const previous = pages.get(pageIndex - 1);
    if (single.detail === "start-outside-visible-column") {
      if (previous) {
        const joined = paragraphAcrossPreviousPage(
          previous,
          current,
          selection,
          rects,
        );
        if (joined.kind === "ready") return joined;
      } else if (pageIndex > 0 && !missing.has(pageIndex - 1))
        return { ...single, needPage: pageIndex - 1 };
    }
    const next = pages.get(pageIndex + 1);
    if (single.detail === "end-outside-visible-column") {
      if (next) {
        const joined = paragraphAcrossNextPage(current, next, selection, rects);
        if (joined.kind === "ready") return joined;
      } else if (!missing.has(pageIndex + 1))
        return { ...single, needPage: pageIndex + 1 };
    }
  }
  const layouts = new Map<number, PageLayout>();
  for (const [index, data] of pages) {
    const layout = pageLayoutFromData(data, index);
    if (layout) layouts.set(index, layout);
  }
  if (!layouts.has(pageIndex)) return single;
  const multi = multiParagraph({
    pages: layouts,
    missing,
    start: pageIndex,
    selection,
    rects,
    nextPageRects,
  });
  if (multi.kind === "need") return { ...single, needPage: multi.page };
  return mergedResult(single, multi);
}

function mergedResult(
  single: PdfParagraphResult,
  multi: Exclude<MultiOutcome, { kind: "need" }>,
): PdfParagraphResult {
  if (multi.kind === "ready")
    return multi.paragraphs > 1
      ? { kind: "ready", text: multi.text, paragraphs: multi.paragraphs }
      : { kind: "ready", text: multi.text };
  if (multi.detail === "too-long")
    return {
      kind: "too-long",
      detail: "multi-paragraph",
      multiParagraph: true,
    };
  // When the selection could not be placed, or its first paragraph is not
  // confirmed, the original single-paragraph diagnosis is the precise one.
  if (
    (multi.stage === "locate" || multi.stage === "start") &&
    !(single.kind === "unmatched" && single.detail === CROSSING)
  )
    return single;
  return { kind: "unmatched", detail: multi.detail, multiParagraph: true };
}

/** Pure helper: geometrically separate columns, lines, and indented paragraphs. */
export function paragraphFromLayout(
  items: TextItem[],
  selection: string,
  pageWidth: number,
  rects?: number[][],
): PdfParagraphResult {
  const single = singleFromLayout(items, selection, pageWidth, rects);
  if (single.kind === "ready" || single.kind === "unavailable") return single;
  const layout = pageLayoutFromItems(items, pageWidth, 0);
  if (!layout) return single;
  const multi = multiParagraph({
    pages: new Map([[0, layout]]),
    missing: new Set([-1, 1]),
    start: 0,
    selection,
    rects,
  });
  return multi.kind === "need" ? single : mergedResult(single, multi);
}

function singleFromLayout(
  items: TextItem[],
  selection: string,
  pageWidth: number,
  rects?: number[][],
): PdfParagraphResult {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0)
    return { kind: "unavailable" };
  const lines = layoutLines(items, pageWidth);
  if (!lines.length) return { kind: "unavailable" };
  const wanted = normalized(selection);
  const prefix = wanted.slice(0, Math.min(24, wanted.length));
  if (!canAnchor(prefix, rects))
    return {
      kind: "unmatched",
      detail: "selection-too-short-without-position",
    };
  const matches = positionedMatches(lines, prefix, rects);
  if (matches.length !== 1) {
    // A figure or table caption is its own bounded unit. Return that caption
    // alone; never attach the body paragraph above or below it.
    if (!matches.length) {
      const caption = captionSelection(lines, prefix, wanted, rects);
      if (caption?.kind === "ready") return caption;
    }
    return {
      kind: "unmatched",
      detail: matches.length ? "anchor-ambiguous" : "anchor-not-found",
    };
  }
  const located = paragraphLinesAt(lines, matches[0]);
  if (located.kind === "unavailable") return located;
  if (located.kind === "unmatched")
    return { kind: "unmatched", detail: located.detail };
  return checkedParagraph(located.lines, prefix, wanted, located.context);
}

/** The paragraph around one visual line: list item, body paragraph, or a
 * paragraph continued in the next column. Never guesses a missing boundary. */
function paragraphLinesAt(
  lines: Line[],
  anchor: Line,
  startProof = false,
): Located {
  const list = paragraphFromList(lines, anchor);
  if (list) return list;
  const nearby = lines
    .filter(
      (line) =>
        !line.heading &&
        !line.caption &&
        line.column === anchor.column &&
        Math.abs(line.x - anchor.x) < 23 &&
        Math.abs(line.size - anchor.size) < anchor.size * 0.25 &&
        line.text.length > 25,
    )
    .sort((a, b) => b.y - a.y);
  if (nearby.length < 3)
    return { kind: "unmatched", detail: "insufficient-body-lines" };
  const left = bodyMargin(nearby);
  const body = lines
    .filter(
      (line) =>
        !line.heading &&
        !line.caption &&
        line.column === anchor.column &&
        line.x >= left - 5 &&
        line.x <= left + 22 &&
        Math.abs(line.size - anchor.size) < anchor.size * 0.25 &&
        line.text.length > 3,
    )
    .sort((a, b) => b.y - a.y);
  markBodyBoundaries(body, lines);
  const anchorAt = body.indexOf(anchor);
  if (anchorAt < 0)
    return { kind: "unmatched", detail: "anchor-outside-body-column" };
  const gaps = body
    .slice(1)
    .map((line, i) => body[i].y - line.y)
    .filter((gap) => gap > anchor.size * 0.75 && gap < anchor.size * 1.7)
    .sort((a, b) => a - b);
  const spacing = gaps[Math.floor(gaps.length / 2)] || anchor.size * 1.1;
  const startsAt = (index: number) =>
    startsParagraphAt(body, index, left, spacing, anchor.size);
  let first = anchorAt;
  while (first > 0 && !startsAt(first)) first--;
  let last = anchorAt + 1;
  while (last < body.length && !startsAt(last)) last++;
  const hasStart =
    first > 0 ||
    startsParagraphAt(body, first, left, spacing, anchor.size) ||
    (first === 0 && startProof);
  if (anchor.column === 0 && hasStart && last === body.length) {
    const right = adjacentBody(lines, anchor, 1);
    const run = right && firstProseRun(right, anchor);
    if (run && canContinue(body.at(-1)!, run[0]))
      return {
        kind: "lines",
        lines: [...body.slice(first), ...run],
        context: [...body, ...right!.body],
      };
  }
  if (anchor.column === 1 && first === 0) {
    const right = adjacentBody(lines, anchor, 1);
    const run = right && firstProseRun(right, anchor);
    const leftColumn = adjacentBody(lines, anchor, 0);
    if (run?.includes(anchor) && leftColumn) {
      const leftBody = leftColumn.body;
      let leftFirst = leftBody.length - 1;
      while (
        leftFirst > 0 &&
        !startsParagraphAt(
          leftBody,
          leftFirst,
          leftColumn.left,
          leftColumn.spacing,
          anchor.size,
        )
      )
        leftFirst--;
      if (
        (leftFirst > 0 ||
          startsParagraphAt(
            leftBody,
            leftFirst,
            leftColumn.left,
            leftColumn.spacing,
            anchor.size,
          )) &&
        canContinue(leftBody.at(-1)!, run[0])
      )
        return {
          kind: "lines",
          lines: [...leftBody.slice(leftFirst), ...run],
          context: [...leftBody, ...right!.body],
        };
    }
  }
  // Without both boundaries a page fragment is not a complete paragraph.
  if (
    !hasStart ||
    (last === body.length &&
      !confirmedFinalLine(
        body.slice(first),
        body,
        anchor.size,
        lines.every((line) => line.column === 0),
      ))
  )
    return {
      kind: "unmatched",
      detail: !hasStart
        ? "start-outside-visible-column"
        : "end-outside-visible-column",
      // The confirmed start of a paragraph reaching the column bottom.
      ...(hasStart ? { partial: body.slice(first) } : {}),
    };
  return { kind: "lines", lines: body.slice(first, last), context: body };
}

/** An independently complete last paragraph closes the previous page's lane,
 * so the next page's first flush prose paragraph can have a confirmed start.
 * A sentence-ending period without that local end proof is not sufficient. */
function previousEndConfirmsStart(
  previousLines: Line[],
  lines: Line[],
  anchor: Line,
) {
  if (anchor.column !== 0) return false;
  // Boundary marking belongs to paragraph analysis. Work on local copies so
  // verifying the proof does not alter either page's existing line markers.
  const current = lines.map((line) => ({ ...line }));
  const currentColumn = adjacentBody(current, anchor, 0);
  const first = currentColumn?.body[0];
  if (
    !currentColumn ||
    !first ||
    !proseLike(first.text) ||
    first.x < currentColumn.left - 5 ||
    first.x > currentColumn.left + 4
  )
    return false;
  const previous = previousLines.map((line) => ({ ...line }));
  const lastColumn = previous.some(
    (line) =>
      !line.heading &&
      !line.caption &&
      line.column === 1 &&
      line.text.length > 25,
  )
    ? 1
    : 0;
  const previousColumn = adjacentBody(previous, anchor, lastColumn);
  const last = previousColumn?.body.at(-1);
  if (!previousColumn || !last || !TERMINAL.test(last.text)) return false;
  // Never borrow another page's start proof recursively: the prior paragraph
  // must establish its own start and end through the existing local rules.
  const located = paragraphLinesAt(previous, last);
  if (located.kind !== "lines" || located.lines.at(-1) !== last) return false;
  const from = previousColumn.body.findIndex((line) =>
    located.lines.includes(line),
  );
  return (
    from >= 0 &&
    previousColumn.body
      .slice(from)
      .every((line) => located.lines.includes(line))
  );
}

/** Only a repeated independent body lane is column evidence. Font chunks
 * that abut the previous chunk on the same baseline are one visual row.
 * Full-width abstracts cannot outvote a genuine gutter below them. */
function continuesSpan(left: Span, right: Span) {
  const gap = right.x - left.end;
  return (
    left.hasEOL !== true &&
    gap >= -1 &&
    gap <= Math.max(3, Math.min(left.size, right.size) * 0.7)
  );
}

function bodyColumnBoundary(spans: Span[], pageWidth: number) {
  const halfway = pageWidth / 2;
  const prose = spans.filter(
    (span) =>
      !span.bold &&
      normalized(span.text).length > 25 &&
      span.end - span.x > pageWidth * 0.15 &&
      !isPageFurniture(span.text) &&
      !isCaptionLabel(span.text),
  );
  const right = prose.filter(
    (span) => span.x >= halfway && span.x < pageWidth * 0.75,
  );
  for (const start of right) {
    const rows: number[] = [];
    for (const span of right) {
      if (
        span.x < start.x - 4 ||
        span.x > start.x + Math.max(22, start.size * 2) ||
        Math.abs(span.size - start.size) >= start.size * 0.2
      )
        continue;
      const left = spans
        .filter(
          (other) =>
            other.text.trim().length > 0 &&
            other.x < halfway &&
            other.x < span.x &&
            Math.abs(other.y - span.y) <= Math.min(4.5, span.size * 0.55),
        )
        .sort((a, b) => b.end - a.end)[0];
      if (left && continuesSpan(left, span)) continue;
      if (!rows.some((y) => Math.abs(y - span.y) <= start.size * 0.55))
        rows.push(span.y);
    }
    if (
      rows.length >= 3 &&
      Math.max(...rows) - Math.min(...rows) >= start.size * 2
    )
      return halfway;
  }
  return undefined;
}

function spanSize(spans: Span[]) {
  const counts = new Map<number, { weight: number; size: number }>();
  for (const span of spans) {
    const key = Math.round(span.size * 5);
    const weight = normalized(span.text).length || 1;
    const entry = counts.get(key);
    if (entry) entry.weight += weight;
    else counts.set(key, { weight, size: span.size });
  }
  return [...counts.values()].sort((a, b) => b.weight - a.weight)[0].size;
}

function bodyMargin(lines: Line[]) {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.x / 2) * 2;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const commonEnd = frequentValue(lines.map((line) => line.end))!;
  const biggest = Math.max(...counts.values());
  const credible = lines.filter(
    (line) =>
      counts.get(Math.round(line.x / 2) * 2)! >= Math.max(2, biggest * 0.4) ||
      Math.abs(line.end - commonEnd) < line.size,
  );
  return Math.min(
    ...(credible.length ? credible : lines).map(
      (line) => Math.round(line.x / 2) * 2,
    ),
  );
}

/** A caption label, not a sentence that merely names a figure.
 * "Figure 15:" and "Fig. 14" are labels; "Figure 15 illustrates" is prose. */
function isCaptionLabel(text: string) {
  return /^(?:Fig\.?\s*\d+|Figure\s+\d+\s*[:.]|Table\s+\d+)/i.test(text);
}

function markCaptions(lines: Line[]) {
  for (const label of lines) {
    if (!isCaptionLabel(label.text)) continue;
    for (const line of captionBlock(lines, label)) line.caption = true;
  }
}

/** A caption label line and the lines that continue its text below it. */
function captionBlock(lines: Line[], label: Line): Line[] {
  const block = [label];
  let previous = label;
  const following = lines
    .filter(
      (line) =>
        line.column === label.column &&
        line.y < label.y &&
        Math.abs(line.x - label.x) <= 24,
    )
    .sort((a, b) => b.y - a.y);
  for (const line of following) {
    if (
      (line.heading &&
        (line.size > label.size * 1.12 ||
          /^\d+(?:\.\d+)*\.?\s+\p{Lu}/u.test(line.text))) ||
      /^(?:[A-Z]|\d+(?:\.\d+)*)\.\s+\p{Lu}/u.test(line.text) ||
      previous.y - line.y > label.size * 1.9 ||
      Math.abs(line.x - label.x) > 24 ||
      Math.abs(line.size - label.size) > label.size * 0.18 ||
      (line.x >= label.x + Math.max(6, label.size * 0.75) &&
        /^[\p{Lu}]/u.test(line.text) &&
        /[.!?。！？]["'”’）)\]]*$/.test(previous.text))
    )
      break;
    block.push(line);
    previous = line;
  }
  return block;
}

function markBodyBoundaries(body: Line[], lines: Line[]) {
  body.forEach((line, index) => {
    const previous = body[index - 1];
    line.breakBefore = lines.some(
      (other) =>
        other.heading &&
        !other.caption &&
        other.size >= line.size * 0.95 &&
        normalized(other.text).length >= 4 &&
        other.column === line.column &&
        other.x < Math.max(...body.map((row) => row.end)) &&
        other.end > Math.min(...body.map((row) => row.x)) &&
        other.y > line.y &&
        other.y < (previous?.y ?? line.y + line.size * 6),
    );
  });
}

/** A short terminal line is evidence only in a visibly justified body. The
 * legacy large shortfall applies in every lane; a modest shortfall needs much
 * stronger measured justification, explicitly enabled for single-column prose. */
function confirmedFinalLine(
  selected: Line[],
  body: Line[],
  size: number,
  allowTightTail = false,
) {
  const last = selected.at(-1)!;
  if (selected.length < 2 || !/[.!?。！？]["'”’）)\]]*$/.test(last.text))
    return false;
  const modalEnd = frequentValue(body.map((line) => line.end))!;
  const aligned = body.filter(
    (line) => Math.abs(line.end - modalEnd) < size * 0.7,
  ).length;
  if (
    aligned >= 2 &&
    aligned >= body.length * 0.5 &&
    last.end < modalEnd - size * 4
  )
    return true;
  if (
    !allowTightTail ||
    selected.length < 4 ||
    selected.some((line) => !proseLike(line.text))
  )
    return false;
  // A bucket mode can be a repeated short paragraph ending rather than the
  // body edge. Find the densest tight cluster of actual end coordinates.
  const ends = body.map((line) => line.end).sort((a, b) => a - b);
  let from = 0;
  let bestFrom = 0;
  let bestTo = 0;
  for (let to = 0; to < ends.length; to++) {
    while (ends[to] - ends[from] > size * 0.25) from++;
    if (to - from + 1 > bestTo - bestFrom) {
      bestFrom = from;
      bestTo = to + 1;
    }
  }
  const cluster = ends.slice(bestFrom, bestTo);
  if (cluster.length < body.length * 0.75) return false;
  const preceding = selected.slice(0, -1);
  const precedingAligned = preceding.filter(
    (line) => line.end >= cluster[0] && line.end <= cluster.at(-1)!,
  ).length;
  if (precedingAligned < 3 || precedingAligned < preceding.length * 0.8)
    return false;
  const middle = Math.floor(cluster.length / 2);
  const end =
    cluster.length % 2
      ? cluster[middle]
      : (cluster[middle - 1] + cluster[middle]) / 2;
  const spread = cluster.at(-1)! - cluster[0];
  // Subtract before comparing: an exact one-em end must not pass due to
  // cancellation noise in (end - last.end). Sentence punctuation alone is not
  // a page boundary, and the ordinary aligned-edge jitter is not a short tail.
  return last.end < end - Math.max(size, spread * 2 + size * 0.2);
}

function layoutLines(items: TextItem[], pageWidth: number): Line[] {
  const spans: Span[] = items.flatMap((item) => {
    const [a, b, , , x, y] = item.transform || [];
    const size = Math.hypot(a, b);
    if (
      !item.str?.length ||
      ![x, y, size].every(Number.isFinite) ||
      size < 4 ||
      size > 30 ||
      Math.abs(b) > Math.abs(a) * 0.4
    )
      return [];
    return [
      {
        x,
        y,
        end: x + (item.width || item.str.length * size * 0.45),
        size,
        text: item.str,
        hasEOL: item.hasEOL,
        bold: item.bold,
        chars: item.chars,
      },
    ];
  });
  if (!spans.length) return [];
  // Separate columns only when the page supplies column evidence. A single
  // column can cross the page centre in several PDF.js font/style spans.
  const boundary = bodyColumnBoundary(spans, pageWidth);
  const grouped: Array<{ y: number; column: number; spans: Span[] }> = [];
  const columns = new Map<Span, number>();
  for (const span of spans.sort((a, b) => b.y - a.y || a.x - b.x)) {
    let column = boundary === undefined || span.x < boundary ? 0 : 1;
    if (column === 1) {
      const continuation = spans
        .filter(
          (other) =>
            columns.has(other) &&
            other.text.trim().length > 0 &&
            other.x < span.x &&
            Math.abs(other.y - span.y) <= Math.min(4.5, span.size * 0.55) &&
            continuesSpan(other, span),
        )
        .sort((a, b) => b.end - a.end)[0];
      if (continuation) column = columns.get(continuation)!;
    }
    columns.set(span, column);
    const last = grouped.find(
      (entry) =>
        entry.column === column &&
        Math.abs(entry.y - span.y) <= Math.min(4.5, span.size * 0.55) &&
        entry.spans.some((part) =>
          part.x <= span.x
            ? continuesSpan(part, span)
            : continuesSpan(span, part),
        ),
    );
    if (last) {
      last.spans.push(span);
    } else {
      grouped.push({ y: span.y, column, spans: [span] });
    }
  }
  const lines: Line[] = grouped
    .map(({ y, column, spans: row }) => {
      row.sort((a, b) => a.x - b.x);
      let text = "";
      let end = row[0].x;
      for (const part of row) {
        if (text && part.x - end > part.size * 0.22 && !/\s$/.test(text))
          text += " ";
        text += part.text;
        end = Math.max(end, part.end);
      }
      return {
        x: row[0].x,
        y,
        end,
        size: spanSize(row),
        column,
        heading:
          row
            .filter((part) => part.bold)
            .reduce((n, part) => n + part.text.length, 0) >
          text.length * 0.7,
        text: text.replace(/\s+/g, " ").trim(),
        chars: row.flatMap((part) => part.chars || []),
      };
    })
    .filter((line) => !isPageFurniture(line.text));
  const joined = joinDetachedListMarkers(lines);
  markCaptions(joined);
  const font = frequentValue(
    joined
      .filter((line) => !line.heading && !line.caption && line.text.length > 25)
      .map((line) => line.size),
  );
  for (const line of joined) {
    if (
      font &&
      !line.caption &&
      line.size > font * 1.12 &&
      line.text.length < 100 &&
      !listMarker(line.text)
    )
      line.heading = true;
  }
  return joined;
}

/** Only accept a page continuation when both the prior indent and the next
 * page's following indent bound the paragraph. Never send an open fragment. */
export function paragraphAcrossNextPage(
  current: PageData,
  following: PageData,
  selection: string,
  rects?: number[][],
): PdfParagraphResult {
  const geometry = pageGeometry(current, rects);
  const nextGeometry = pageGeometry(following);
  if (!Number.isFinite(geometry.width) || !Number.isFinite(nextGeometry.width))
    return { kind: "unmatched" };
  const lines = layoutLines(geometry.items, geometry.width);
  const nextLines = layoutLines(nextGeometry.items, nextGeometry.width);
  const wanted = normalized(selection);
  const prefix = wanted.slice(0, Math.min(24, wanted.length));
  if (!canAnchor(prefix, geometry.rects)) return { kind: "unmatched" };
  const matches = positionedMatches(lines, prefix, geometry.rects);
  if (matches.length !== 1) return { kind: "unmatched" };
  const located = acrossNextPageAt(lines, nextLines, matches[0]);
  if (located.kind !== "lines") return { kind: "unmatched" };
  return checkedParagraph(located.lines, prefix, wanted, located.context);
}

function acrossNextPageAt(
  lines: Line[],
  nextLines: Line[],
  anchor: Line,
): Located {
  const lastColumn = lines.some(
    (line) =>
      !line.heading &&
      !line.caption &&
      line.column === 1 &&
      line.text.length > 25,
  )
    ? 1
    : 0;
  if (anchor.column !== lastColumn) return { kind: "unmatched" };
  const currentColumn = adjacentBody(lines, anchor, anchor.column);
  const nextColumn = adjacentBody(nextLines, anchor, 0);
  if (!currentColumn || !nextColumn) return { kind: "unmatched" };
  const { body, left, spacing } = currentColumn;
  const index = body.indexOf(anchor);
  if (index < 0) return { kind: "unmatched" };
  let first = index;
  while (
    first > 0 &&
    !startsParagraphAt(body, first, left, spacing, anchor.size)
  )
    first--;
  if (
    first === 0 &&
    !startsParagraphAt(body, first, left, spacing, anchor.size)
  )
    return { kind: "unmatched" };
  if (
    body
      .slice(index + 1)
      .some((_, offset) =>
        startsParagraphAt(body, index + offset + 1, left, spacing, anchor.size),
      )
  )
    return { kind: "unmatched" };
  const run = firstProseRun(nextColumn, anchor);
  if (
    !run ||
    !canContinue(body.at(-1)!, run[0]) ||
    !/[.!?。！？]["'”’）)\]]*$/.test(run.at(-1)!.text)
  )
    return { kind: "unmatched" };
  return {
    kind: "lines",
    lines: [...body.slice(first), ...run],
    context: [...body, ...nextColumn.body],
  };
}

/** Continue a paragraph that starts in the preceding page's last column. */
export function paragraphAcrossPreviousPage(
  previous: PageData,
  current: PageData,
  selection: string,
  rects?: number[][],
): PdfParagraphResult {
  const geometry = pageGeometry(current, rects);
  const previousGeometry = pageGeometry(previous);
  if (
    !Number.isFinite(geometry.width) ||
    !Number.isFinite(previousGeometry.width)
  )
    return { kind: "unmatched" };
  const previousLines = layoutLines(
    previousGeometry.items,
    previousGeometry.width,
  );
  const lines = layoutLines(geometry.items, geometry.width);
  const wanted = normalized(selection);
  const prefix = wanted.slice(0, Math.min(24, wanted.length));
  if (!canAnchor(prefix, geometry.rects)) return { kind: "unmatched" };
  const matches = positionedMatches(lines, prefix, geometry.rects);
  if (matches.length !== 1) return { kind: "unmatched" };
  const located = acrossPreviousPageAt(previousLines, lines, matches[0]);
  if (located.kind !== "lines") return { kind: "unmatched" };
  return checkedParagraph(located.lines, prefix, wanted, located.context);
}

function acrossPreviousPageAt(
  previousLines: Line[],
  lines: Line[],
  anchor: Line,
): Located {
  if (anchor.column !== 0) return { kind: "unmatched" };
  const lastColumn = previousLines.some(
    (line) =>
      !line.heading &&
      !line.caption &&
      line.column === 1 &&
      line.text.length > 25,
  )
    ? 1
    : 0;
  const previousColumn = adjacentBody(previousLines, anchor, lastColumn);
  const currentColumn = adjacentBody(lines, anchor, 0);
  if (!previousColumn || !currentColumn) return { kind: "unmatched" };
  const run = firstProseRun(currentColumn, anchor);
  if (!run?.includes(anchor)) return { kind: "unmatched" };
  const previousBody = previousColumn.body;
  let first = previousBody.length - 1;
  while (
    first > 0 &&
    !startsParagraphAt(
      previousBody,
      first,
      previousColumn.left,
      previousColumn.spacing,
      anchor.size,
    )
  )
    first--;
  // Only send text when the beginning and the end are both confirmed.
  if (
    (first === 0 &&
      !startsParagraphAt(
        previousBody,
        first,
        previousColumn.left,
        previousColumn.spacing,
        anchor.size,
      )) ||
    !canContinue(previousBody.at(-1)!, run[0]) ||
    !/[.!?。！？]["'”’）)\]]*$/.test(run.at(-1)!.text)
  )
    return { kind: "unmatched" };
  return {
    kind: "lines",
    lines: [...previousBody.slice(first), ...run],
    context: [...previousBody, ...currentColumn.body],
  };
}

type ListMarker = { style: string; label: string; content: string };

function listMarker(text: string): ListMarker | undefined {
  const match = text
    .normalize("NFKC")
    .match(
      /^(?:\((\d{1,3}|[a-z]|[ivxlcdm]{2,6})\)|(\d{1,3}|[a-z]|[ivxlcdm]{2,6})([.)])|([•●◦▪▫‣⁃*–—-]))(?:\s+|(?=\p{L})|$)(.*)$/iu,
    );
  if (!match) return undefined;
  return {
    style: match[4]
      ? "bullet:" + match[4]
      : match[1]
        ? "parenthesized"
        : match[3],
    label: (match[1] || match[2] || match[4]).toLowerCase(),
    content: match[5],
  };
}

function joinDetachedListMarkers(lines: Line[]): Line[] {
  const consumed = new Set<Line>();
  const joined: Line[] = [];
  for (const line of lines) {
    const marker = listMarker(line.text);
    if (!marker || marker.content) continue;
    const next = lines
      .filter(
        (other) =>
          other !== line &&
          !consumed.has(other) &&
          other.column === line.column &&
          !listMarker(other.text) &&
          Math.abs(other.y - line.y) <= line.size * 0.4 &&
          Math.abs(other.size - line.size) <= line.size * 0.3 &&
          other.x >= line.end - 1 &&
          other.x - line.end <= line.size * 10,
      )
      .sort((a, b) => a.x - b.x)[0];
    if (!next) continue;
    joined.push({
      ...next,
      x: line.x,
      text: line.text + " " + next.text,
      chars: [...(line.chars || []), ...(next.chars || [])],
    });
    consumed.add(line);
    consumed.add(next);
  }
  return [...lines.filter((line) => !consumed.has(line)), ...joined];
}

function consecutiveMarkers(previous: ListMarker, next: ListMarker) {
  if (previous.style !== next.style) return false;
  if (previous.style.startsWith("bullet:")) return true;
  if (/^\d+$/.test(previous.label) && /^\d+$/.test(next.label))
    return Number(next.label) === Number(previous.label) + 1;
  if (
    previous.label.length === 1 &&
    next.label.length === 1 &&
    next.label.charCodeAt(0) === previous.label.charCodeAt(0) + 1
  )
    return true;
  const roman = (label: string) => {
    if (!/^[ivxlcdm]+$/.test(label)) return NaN;
    const values: Record<string, number> = {
      i: 1,
      v: 5,
      x: 10,
      l: 50,
      c: 100,
      d: 500,
      m: 1000,
    };
    return [...label].reduce(
      (total, letter, index) =>
        total +
        (values[letter] < (values[label[index + 1]] || 0)
          ? -values[letter]
          : values[letter]),
      0,
    );
  };
  return roman(next.label) === roman(previous.label) + 1;
}

/** Use local marker and hanging-indent geometry, not the column's modal margin.
 * Returning unmatched for a confirmed list prevents falling back to a block
 * containing several list items. A marker alone is not evidence of a list. */
function paragraphFromList(lines: Line[], anchor: Line): Located | undefined {
  const tolerance = Math.max(2, anchor.size * 0.45);
  const starts = lines
    .filter(
      (line) =>
        !line.heading &&
        !line.caption &&
        line.column === anchor.column &&
        line.y >= anchor.y - tolerance &&
        line.x <= anchor.x + tolerance &&
        anchor.x - line.x <= anchor.size * 12 &&
        Math.abs(line.size - anchor.size) < anchor.size * 0.3 &&
        listMarker(line.text),
    )
    .sort((a, b) => a.y - b.y || b.x - a.x);
  for (const start of starts) {
    const marker = listMarker(start.text)!;
    // Formula labels and reference numbers are not prose list items.
    if (!/\p{L}{3}/u.test(marker.content)) continue;
    if (
      /[=<>≤≥]/u.test(marker.content) &&
      (marker.content.match(/\p{L}{2,}/gu)?.length || 0) < 4
    )
      continue;
    const peers = lines
      .filter(
        (line) =>
          !line.heading &&
          !line.caption &&
          line.column === start.column &&
          Math.abs(line.x - start.x) <= tolerance &&
          Math.abs(line.size - start.size) < start.size * 0.3 &&
          listMarker(line.text)?.style === marker.style,
      )
      .sort((a, b) => b.y - a.y);
    const at = peers.indexOf(start);
    const before = peers[at - 1] && listMarker(peers[at - 1].text);
    const after = peers[at + 1] && listMarker(peers[at + 1].text);
    if (
      !(before && consecutiveMarkers(before, marker)) &&
      !(after && consecutiveMarkers(marker, after))
    )
      continue;
    const local = lines
      .filter(
        (line) =>
          line.column === start.column &&
          line.y <= start.y + tolerance &&
          line.end > start.x &&
          line.x <= start.x + start.size * 12,
      )
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const from = local.indexOf(start);
    const selected: Line[] = [start];
    let markerBoundary = false;
    let blockBoundary = false;
    for (const line of local.slice(from + 1)) {
      const previous = selected.at(-1)!;
      if (listMarker(line.text) && line.x <= start.x + tolerance) {
        markerBoundary = true;
        break;
      }
      if (
        line.heading ||
        line.x < start.x - tolerance ||
        Math.abs(line.size - start.size) > start.size * 0.4 ||
        previous.y - line.y > start.size * 2.2
      ) {
        blockBoundary = true;
        break;
      }
      selected.push(line);
    }
    if (!selected.includes(anchor)) continue;
    const last = selected.at(-1)!;
    const terminal = /[.!?。！？]["'”’）)\]]*$/.test(last.text);
    const shortLastLine =
      last.end <
      Math.max(
        ...selected.map((line) => line.end),
        ...peers.map((line) => line.end),
      ) -
        start.size;
    if (!markerBoundary && !(terminal && (blockBoundary || shortLastLine)))
      return { kind: "unmatched", detail: "list-end-unconfirmed" };
    return { kind: "lines", lines: selected, context: local };
  }
  return undefined;
}

function usableRects(rects?: number[][]) {
  return (rects || []).filter(
    (rect) =>
      rect.length === 4 &&
      rect.every(Number.isFinite) &&
      rect[2] > rect[0] &&
      rect[3] > rect[1],
  );
}

function canAnchor(prefix: string, rects?: number[][]) {
  return (
    prefix.length >= 8 || (prefix.length >= 2 && usableRects(rects).length > 0)
  );
}

/** The one caption block that fully contains this selection, if any. */
function captionSelection(
  lines: Line[],
  prefix: string,
  wanted: string,
  rects?: number[][],
): PdfParagraphResult | undefined {
  const blocks: Line[][] = [];
  const seen = new Set<Line>();
  for (const label of lines) {
    if (!isCaptionLabel(label.text) || seen.has(label)) continue;
    const block = captionBlock(lines, label);
    for (const line of block) seen.add(line);
    blocks.push(block);
  }
  const first = usableRects(rects)[0];
  const hits = blocks.filter((block) => {
    if (!normalized(joinedLines(block)).includes(prefix)) return false;
    if (!first) return true;
    const x = (first[0] + first[2]) / 2;
    const y = (first[1] + first[3]) / 2;
    return block.some(
      (line) =>
        x >= line.x - 3 &&
        x <= line.end + 3 &&
        y >= line.y - line.size * 0.3 &&
        y <= line.y + line.size * 1.05,
    );
  });
  if (hits.length !== 1) return undefined;
  return checkedParagraph(hits[0], prefix, wanted);
}

function positionedMatches(lines: Line[], prefix: string, rects?: number[][]) {
  const matches = matchingLines(
    lines.filter((line) => !line.heading && !line.caption),
    prefix,
  );
  const first = usableRects(rects)[0];
  if (!first) return matches;
  const x = (first[0] + first[2]) / 2;
  const y = (first[1] + first[3]) / 2;
  return matches.filter(
    (line) =>
      x >= line.x - 3 &&
      x <= line.end + 3 &&
      y >= line.y - line.size * 0.3 &&
      y <= line.y + line.size * 1.05,
  );
}

function matchingLines(lines: Line[], prefix: string): Line[] {
  const direct = lines.filter((line) => normalized(line.text).includes(prefix));
  if (direct.length) return direct;
  return lines.filter((line) => {
    const next = lines
      .filter(
        (other) =>
          other.column === line.column &&
          other.y < line.y &&
          line.y - other.y > line.size * 0.75 &&
          line.y - other.y < line.size * 1.8 &&
          Math.abs(other.x - line.x) < 25,
      )
      .sort((a, b) => b.y - a.y)[0];
    if (!next) return false;
    const combined = line.text.endsWith("-")
      ? line.text.slice(0, -1) + next.text
      : line.text + " " + next.text;
    return normalized(combined).includes(prefix);
  });
}

function startsParagraphAt(
  body: Line[],
  index: number,
  left: number,
  spacing: number,
  size: number,
) {
  const line = body[index];
  const prev = body[index - 1];
  if (line.breakBefore) return true;
  if (!prev) return line.x >= left + Math.max(6, size * 0.75);
  const gap = prev.y - line.y;
  return (
    (gap > spacing * 1.65 && /[.!?。！？]["'”’）)\]]*$/.test(prev.text)) ||
    (line.x >= left + Math.max(6, size * 0.75) &&
      (gap > spacing * 1.07 || /[.!?。！？]["'”’）)\]]*$/.test(prev.text)))
  );
}

function adjacentBody(lines: Line[], anchor: Line, column: number) {
  const candidates = lines.filter(
    (line) =>
      !line.heading &&
      !line.caption &&
      line.column === column &&
      Math.abs(line.size - anchor.size) < anchor.size * 0.4 &&
      line.text.length > 25 &&
      !isCaptionLabel(line.text),
  );
  if (candidates.length < 3) return undefined;
  const left = bodyMargin(candidates);
  const body = lines
    .filter(
      (line) =>
        !line.heading &&
        !line.caption &&
        line.column === column &&
        Math.abs(line.size - anchor.size) < anchor.size * 0.4 &&
        line.x >= left - 5 &&
        line.x <= left + 22 &&
        line.text.length > 3 &&
        !isCaptionLabel(line.text),
    )
    .sort((a, b) => b.y - a.y);
  markBodyBoundaries(body, lines);
  const gaps = body
    .slice(1)
    .map((line, i) => body[i].y - line.y)
    .filter((gap) => gap > anchor.size * 0.75 && gap < anchor.size * 1.7)
    .sort((a, b) => a - b);
  const spacing = gaps[Math.floor(gaps.length / 2)] || anchor.size * 1.1;
  return { body, left, spacing };
}

function firstProseRun(
  context: NonNullable<ReturnType<typeof adjacentBody>>,
  anchor: Line,
): Line[] | undefined {
  const { body, left, spacing } = context;
  for (let from = 0; from < body.length;) {
    let to = from + 1;
    while (to < body.length && body[to - 1].y - body[to].y <= spacing * 1.8)
      to++;
    // Discard plot labels and two-line figure captions, but retain prose
    // below figures even when it is far from the previous column's text.
    if (
      to - from >= 3 &&
      body[from].x <= left + 4 &&
      !startsParagraphAt(body, from, left, spacing, anchor.size) &&
      /^[a-z]/.test(body[from].text)
    ) {
      let end = from + 1;
      while (
        end < to &&
        !startsParagraphAt(body, end, left, spacing, anchor.size)
      )
        end++;
      const run = body.slice(from, end);
      if (
        (end < body.length &&
          startsParagraphAt(body, end, left, spacing, anchor.size)) ||
        confirmedFinalLine(run, body, anchor.size)
      )
        return run;
    }
    from = to;
  }
  return undefined;
}

function canContinue(previous: Line, next: Line) {
  return (
    previous.text.length > 20 &&
    next.text.length > 20 &&
    !/[.!?。！？]["'”’）)\]]*$/.test(previous.text) &&
    /^[a-z]/.test(next.text)
  );
}

function joinedLines(lines: Line[]): string {
  return lines
    .map((line) => line.text)
    .reduce(
      (joined, part) =>
        joined.endsWith("-")
          ? joined.slice(0, -1) + part
          : joined + (joined ? " " : "") + part,
      "",
    );
}

function checkedParagraph(
  lines: Line[],
  prefix: string,
  wanted: string,
  context?: Line[],
): PdfParagraphResult {
  const text = joinedLines(lines);
  const cleaned = normalized(text);
  if (!cleaned.includes(prefix) || !cleaned.includes(wanted))
    return {
      kind: "unmatched",
      detail:
        context && normalized(joinedLines(context)).includes(wanted)
          ? CROSSING
          : "selection-text-mismatch",
    };
  if (text.length > 16000) return { kind: "too-long" };
  return { kind: "ready", text };
}

function isPageFurniture(text: string) {
  return /^(?:downloaded from\b|accepted\s*manuscript\b|journal of\b|\d+\s*\/\s*preprint\b|copyright\b|doi:)/i.test(
    text,
  );
}

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// ---------------------------------------------------------------------------
// Multi-paragraph selections
//
// Zotero builds the selected text from a contiguous range of each page's
// native characters. Locating that range exactly tells which visual lines the
// selection touches. The selection is then expanded from the start of the
// paragraph containing its first body line to the end of the paragraph
// containing its last body line, walking the paragraphs between them with the
// same single-paragraph boundary rules. Any unconfirmed boundary, unexplained
// selected text, or disagreement with Zotero's character order fails with a
// diagnostic instead of guessing.
// ---------------------------------------------------------------------------

const CROSSING = "selection-crosses-paragraph-boundary";
const TERMINAL = /[.!?。！？]["'”’）)\]]*$/;
const MAX_PARAGRAPHS = 40;
const MAX_TEXT = 16000;
const EQUATION_TAIL = /\s*\(eq(?:uation)?s?\.?\s*\d+[a-z]?\)\s*$/i;
const EQUATION_LABEL = /^\((?:eq(?:uation)?\.?\s*)?\d+[a-z]?\)$/i;

type PageLayout = {
  page: number;
  lines: Line[];
  /** Normalized text of every raw character, in Zotero selection order. */
  stream: string[];
  /** Character rectangles in layout coordinates, when known. */
  boxes: Array<number[] | undefined>;
  owner: Map<number, Line>;
  shift: [number, number];
};

type MultiInput = {
  pages: Map<number, PageLayout>;
  /** Pages known to be unavailable (outside the document or unreadable). */
  missing: Set<number>;
  start: number;
  selection: string;
  /** Rectangles of the selection on the start page (page coordinates). */
  rects?: number[][];
  /** Rectangles of the selection on the following page, if it continues. */
  nextPageRects?: number[][];
};

type MultiOutcome =
  | { kind: "ready"; text: string; paragraphs: number }
  | { kind: "need"; page: number }
  | { kind: "failed"; stage: "locate" | "start" | "later"; detail: string };

type AtResult =
  | { kind: "lines"; lines: Line[] }
  | { kind: "need"; page: number }
  | { kind: "unmatched"; detail: string };

function normalizedChars(value: string) {
  return Array.from(value, (char) => normalized(char)).join("");
}

function pageLayoutFromData(
  data: PageData,
  page: number,
): PageLayout | undefined {
  const geometry = pageGeometry(data);
  if (!Number.isFinite(geometry.width) || geometry.width <= 0) return undefined;
  const x = data.viewBox?.[0] || 0;
  const y = data.viewBox?.[1] || 0;
  const chars = data.chars || [];
  return finishLayout(
    geometry.items,
    geometry.width,
    page,
    chars.map((char) => (char.ignorable ? "" : normalizedChars(char.c || ""))),
    chars.map((char) => {
      const r = char.rect || char.inlineRect;
      return r?.length === 4 && r.every(Number.isFinite)
        ? [r[0] - x, r[1] - y, r[2] - x, r[3] - y]
        : undefined;
    }),
    [x, y],
  );
}

/** Text API items carry no native characters; their strings, in content
 * order, stand in for the character stream. */
function pageLayoutFromItems(
  items: TextItem[],
  width: number,
  page: number,
): PageLayout | undefined {
  if (!Number.isFinite(width) || width <= 0) return undefined;
  const stream: string[] = [];
  const indexed = items.map((item) => {
    if (typeof item.str !== "string") return item;
    const chars: number[] = [];
    for (const char of Array.from(item.str)) {
      chars.push(stream.length);
      stream.push(normalizedChars(char));
    }
    return { ...item, chars };
  });
  return finishLayout(indexed, width, page, stream, [], [0, 0]);
}

function finishLayout(
  items: TextItem[],
  width: number,
  page: number,
  stream: string[],
  boxes: Array<number[] | undefined>,
  shift: [number, number],
): PageLayout | undefined {
  const lines = layoutLines(items, width);
  if (!lines.length) return undefined;
  const owner = new Map<number, Line>();
  for (const line of lines) {
    line.page = page;
    for (const index of line.chars || []) owner.set(index, line);
  }
  return { page, lines, stream, boxes, owner, shift };
}

function shiftRects(rects: number[][] | undefined, shift: [number, number]) {
  return usableRects(rects).map((rect) => [
    rect[0] - shift[0],
    rect[1] - shift[1],
    rect[2] - shift[0],
    rect[3] - shift[1],
  ]);
}

/** Prose has words; equations, table cells, axis labels and page numbers
 * mostly do not. A display equation can contain words but carries a label. */
function proseLike(text: string) {
  if (/\(eq(?:uation)?s?\.?\s*\d+[a-z]?\)$/i.test(text.trim())) return false;
  return (
    (text.match(/\p{L}{3,}/gu)?.length || 0) >= 3 ||
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{4}/u.test(
      text,
    )
  );
}

type PageInfo = {
  size: number;
  lefts: Map<number, number>;
  rights: Map<number, number>;
  /** Caption lines confirmed by a bold or smaller label, or by a
   * punctuated label standing apart from the text above it. */
  captions: Set<Line>;
};

function pageInfo(layout: PageLayout): PageInfo {
  const prose = layout.lines.filter(
    (line) => !line.heading && !line.caption && line.text.length > 25,
  );
  const size =
    frequentValue(prose.map((line) => line.size)) ||
    frequentValue(layout.lines.map((line) => line.size)) ||
    10;
  const lefts = new Map<number, number>();
  const rights = new Map<number, number>();
  for (const column of new Set(layout.lines.map((line) => line.column))) {
    const body = prose.filter(
      (line) =>
        line.column === column && Math.abs(line.size - size) < size * 0.25,
    );
    if (!body.length) continue;
    lefts.set(column, bodyMargin(body));
    rights.set(column, frequentValue(body.map((line) => line.end))!);
  }
  const captions = new Set<Line>();
  for (const label of layout.lines) {
    if (!/^(?:fig(?:ure)?\.?\s*\d+|table\s*\d+)/i.test(label.text)) continue;
    const punctuated =
      /^(?:fig(?:ure)?\.?|table)\s*\d+[a-z]?\s*[.:](?:\s|$)/i.test(label.text);
    const standsApart = !layout.lines.some(
      (other) =>
        other !== label &&
        other.column === label.column &&
        proseLike(other.text) &&
        Math.abs(other.size - label.size) < label.size * 0.2 &&
        other.y > label.y + label.size * 0.3 &&
        other.y - label.y < label.size * 1.9 &&
        other.x < label.end &&
        other.end > label.x,
    );
    if (
      label.heading ||
      label.size < size * 0.92 ||
      (punctuated && standsApart)
    )
      for (const line of captionBlock(layout.lines, label)) captions.add(line);
  }
  return { size, lefts, rights, captions };
}

function multiParagraph(input: MultiInput): MultiOutcome {
  const { pages, missing, start } = input;
  const fail = (
    stage: "locate" | "start" | "later",
    detail: string,
  ): MultiOutcome => ({ kind: "failed", stage, detail });
  const need = (page: number): MultiOutcome => ({ kind: "need", page });
  const canLoad = (page: number) =>
    page >= 0 && !pages.has(page) && !missing.has(page);
  const wanted = normalizedChars(input.selection);
  const startLayout = pages.get(start);
  // As for single paragraphs, a short selection needs its position.
  if (!startLayout || !canAnchor(wanted, input.rects))
    return fail("locate", "selection-not-located");
  const nextRects = usableRects(input.nextPageRects);
  if (nextRects.length && canLoad(start + 1)) return need(start + 1);

  // 1. Place the selection in the start (and following) page's characters.
  const order = [start, ...(pages.has(start + 1) ? [start + 1] : [])];
  let joined = "";
  const positions: Array<{ page: number; index: number }> = [];
  for (const page of order) {
    pages.get(page)!.stream.forEach((text, index) => {
      for (const char of text) {
        joined += char;
        positions.push({ page, index });
      }
    });
  }
  const occurrences: number[] = [];
  for (
    let at = joined.indexOf(wanted);
    at >= 0 && occurrences.length < 64;
    at = joined.indexOf(wanted, at + 1)
  )
    if (positions[at].page === start) occurrences.push(at);
  if (!occurrences.length)
    return canLoad(start + 1)
      ? need(start + 1)
      : fail("locate", "selection-not-located");
  const startRect = shiftRects(input.rects, startLayout.shift)[0];
  const endPage = nextRects.length ? start + 1 : start;
  const endLayout = pages.get(endPage);
  const endRect = endLayout
    ? shiftRects(
        nextRects.length ? nextRects : input.rects,
        endLayout.shift,
      ).at(-1)
    : undefined;
  let candidates = occurrences.filter(
    (at) =>
      !startRect ||
      charAtRect(startLayout, positions[at].index, startRect) !== false,
  );
  if (nextRects.length)
    candidates = candidates.filter(
      (at) => positions[at + wanted.length - 1].page === start + 1,
    );
  if (candidates.length > 1 && endRect && endLayout)
    candidates = candidates.filter((at) => {
      const end = positions[at + wanted.length - 1];
      return (
        end.page === endPage &&
        charAtRect(endLayout, end.index, endRect) !== false
      );
    });
  if (candidates.length !== 1)
    return fail(
      "locate",
      candidates.length
        ? "selection-position-ambiguous"
        : "selection-not-located",
    );

  // 2. The visual lines the selected characters belong to, in Zotero order.
  const touched: Line[] = [];
  const touchCount = new Map<Line, number>();
  const seen = new Set<string>();
  for (let k = candidates[0]; k < candidates[0] + wanted.length; k++) {
    const { page, index } = positions[k];
    const key = page + ":" + index;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = pages.get(page)!.owner.get(index);
    if (!line) continue; // page furniture, rotated or tiny glyphs
    if (!touchCount.has(line)) touched.push(line);
    touchCount.set(line, (touchCount.get(line) || 0) + 1);
  }

  const infos = new Map<number, PageInfo>();
  const info = (line: Line) => {
    const page = line.page!;
    let value = infos.get(page);
    if (!value) infos.set(page, (value = pageInfo(pages.get(page)!)));
    return value;
  };
  const isCaption = (line: Line) => info(line).captions.has(line);
  // Outside the column's text block: other font sizes, margins, centred
  // headings and display material.
  const outlier = (line: Line) => {
    const { size, lefts, rights } = info(line);
    const left = lefts.get(line.column);
    const right = rights.get(line.column);
    if (
      Math.abs(line.size - size) > size * 0.12 ||
      left === undefined ||
      right === undefined ||
      line.x < left - 5 ||
      line.x > left + 50
    )
      return true;
    const indent = line.x - left;
    const rest = right - line.end;
    return (
      indent > size * 2 &&
      rest > size * 2 &&
      Math.abs(indent - rest) < (right - left) * 0.25
    );
  };
  // Lines that never start a body paragraph of their own.
  const skippable = (line: Line) =>
    line.heading || isCaption(line) || !proseLike(line.text) || outlier(line);
  const sequence = [...pages.keys()]
    .sort((a, b) => a - b)
    .flatMap((page) =>
      [...pages.get(page)!.lines].sort(
        (a, b) => a.column - b.column || b.y - a.y || a.x - b.x,
      ),
    );
  const rank = new Map(sequence.map((line, index) => [line, index]));
  const memo = new Map<Line, AtResult>();
  const paragraphAt = (line: Line): AtResult => {
    const cached = memo.get(line);
    if (cached) return cached;
    const result = locateAt(line);
    if (result.kind !== "need") memo.set(line, result);
    return result;
  };
  const locateAt = (line: Line): AtResult => {
    const page = line.page!;
    const layout = pages.get(page)!;
    const located = paragraphLinesAt(layout.lines, line);
    if (located.kind === "lines") return located;
    const detail =
      located.kind === "unmatched"
        ? located.detail || "unmatched"
        : "unavailable";
    if (detail === "start-outside-visible-column" && line.column === 0) {
      const previous = pages.get(page - 1);
      if (previous) {
        const joinedAt = acrossPreviousPageAt(
          previous.lines,
          layout.lines,
          line,
        );
        if (joinedAt.kind === "lines") return joinedAt;
        if (previousEndConfirmsStart(previous.lines, layout.lines, line)) {
          const bounded = paragraphLinesAt(layout.lines, line, true);
          if (bounded.kind === "lines") return bounded;
        }
      } else if (canLoad(page - 1)) return { kind: "need", page: page - 1 };
    }
    if (
      detail === "end-outside-visible-column" &&
      located.kind === "unmatched"
    ) {
      const partial = located.partial;
      const lastColumn = layout.lines.some(
        (other) =>
          !other.heading &&
          !other.caption &&
          other.column === 1 &&
          other.text.length > 25,
      )
        ? 1
        : 0;
      if (line.column < lastColumn) {
        // A finished sentence at the column foot followed by an indented
        // paragraph start at the top of the next column.
        if (
          partial &&
          freshStartFollows(partial, adjacentBody(layout.lines, line, 1), info)
        )
          return { kind: "lines", lines: partial };
      } else {
        const next = pages.get(page + 1);
        if (next) {
          const joinedAt = acrossNextPageAt(layout.lines, next.lines, line);
          if (joinedAt.kind === "lines") return joinedAt;
          if (
            partial &&
            freshStartFollows(partial, adjacentBody(next.lines, line, 0), info)
          )
            return { kind: "lines", lines: partial };
        } else if (canLoad(page + 1)) return { kind: "need", page: page + 1 };
      }
    }
    return { kind: "unmatched", detail };
  };
  // Plot labels around a caption ("a) b)") belong to the figure, too.
  const prose = (lines: Line[]) =>
    proseLike(joinedLines(lines.filter((line) => !isCaption(line))));

  // 3. The first and last selected lines that belong to body paragraphs.
  const choices = touched.filter(
    (line) => !line.heading && !line.caption && !isCaption(line),
  );
  const boundary = (
    lines: Line[],
    label: "start" | "end",
  ): { line: Line; lines: Line[] } | MultiOutcome | undefined => {
    for (const line of lines) {
      const at = paragraphAt(line);
      if (at.kind === "need") return need(at.page);
      if (at.kind === "lines") {
        if (!prose(at.lines)) continue;
        if (at.lines.some(isCaption))
          return fail(
            label === "start" ? "start" : "later",
            "caption-inside-paragraph",
          );
        return { line, lines: at.lines };
      }
      if (skippable(line)) continue;
      return fail(
        label === "start" ? "start" : "later",
        `${label}-paragraph-unconfirmed:${at.detail}`,
      );
    }
    return undefined;
  };
  const first = boundary(choices, "start");
  if (!first) return fail("start", "selection-without-body-text");
  if ("kind" in first) return first;
  const last = boundary([...choices].reverse(), "end");
  if (!last) return fail("later", "selection-without-body-text");
  if ("kind" in last) return last;

  // 4. Walk the paragraphs between them in reading order.
  const paragraphs = [first.lines];
  const claimed = new Set(first.lines);
  const passed = new Set<Line>();
  const endRank = rank.get(last.line)!;
  while (!paragraphs.at(-1)!.includes(last.line)) {
    if (paragraphs.length >= MAX_PARAGRAPHS)
      return fail("later", "too-many-paragraphs");
    const previous = paragraphs.at(-1)!;
    const after = Math.max(...previous.map((line) => rank.get(line) ?? -1));
    let next: Line[] | undefined;
    for (let index = after + 1; index < sequence.length && !next; index++) {
      const candidate = sequence[index];
      if (
        claimed.has(candidate) ||
        passed.has(candidate) ||
        candidate.heading ||
        candidate.caption ||
        isCaption(candidate)
      )
        continue;
      const at = paragraphAt(candidate);
      if (at.kind === "need") return need(at.page);
      if (at.kind === "unmatched") {
        if (skippable(candidate)) continue;
        return fail("later", "middle-paragraph-unconfirmed:" + at.detail);
      }
      if (
        at.lines.some((line) => claimed.has(line)) ||
        Math.min(...at.lines.map((line) => rank.get(line) ?? -1)) <= after
      )
        return fail("later", "paragraph-sequence-inconsistent");
      if (!prose(at.lines)) {
        for (const line of at.lines) passed.add(line);
        continue;
      }
      if (at.lines.some(isCaption))
        return fail("later", "caption-inside-paragraph");
      next = at.lines;
    }
    if (!next) {
      const lastPage = Math.max(...pages.keys());
      return canLoad(lastPage + 1)
        ? need(lastPage + 1)
        : fail("later", "paragraph-sequence-inconsistent");
    }
    if (Math.min(...next.map((line) => rank.get(line) ?? -1)) > endRank)
      return fail("later", "paragraph-sequence-inconsistent");
    paragraphs.push(next);
    for (const line of next) claimed.add(line);
  }
  const closing = paragraphs.at(-1)!;
  if (
    closing.length !== last.lines.length ||
    closing.some((line, index) => line !== last.lines[index])
  )
    return fail("later", "paragraph-sequence-inconsistent");

  // 5. Everything selected must be explained, and everything between the
  // selection ends must have been selected (same order as Zotero's).
  if (paragraphs.some((lines) => lines.some(isCaption)))
    return fail("later", "caption-inside-paragraph");
  const result = paragraphs.flat();
  const included = new Set(result);
  // An inline formula can split a visual row into several pieces; words to
  // its right still belong to the body line. Equation labels do not.
  const pieces = new Map<Line, Line[]>();
  const attached = new Set<Line>();
  for (const line of result) {
    const { size, rights } = info(line);
    const right = rights.get(line.column) ?? Infinity;
    const row = pages
      .get(line.page!)!
      .lines.filter(
        (other) =>
          !included.has(other) &&
          !attached.has(other) &&
          !other.heading &&
          !other.caption &&
          !isCaption(other) &&
          other.column === line.column &&
          other.x >= line.end - 1 &&
          other.x < right + size &&
          Math.abs(other.y - line.y) < line.size * 0.35 &&
          !EQUATION_LABEL.test(other.text),
      );
    if (!row.length) continue;
    for (const other of row) attached.add(other);
    pieces.set(line, row);
  }
  for (const line of touched) {
    if (
      included.has(line) ||
      attached.has(line) ||
      line.heading ||
      isCaption(line)
    )
      continue;
    if (line.caption) {
      if (proseLike(line.text))
        return fail("later", "caption-boundary-uncertain");
      continue;
    }
    // Body words beside a formula on a result line are part of that line.
    if (
      proseLike(line.text) &&
      result.some(
        (other) =>
          other.page === line.page &&
          other.column === line.column &&
          Math.abs(other.y - line.y) < other.size * 0.5,
      )
    )
      return fail("later", "inline-text-outside-paragraph");
    // Display equations and font/indent outliers can carry meaningful selected
    // content. Do not silently discard them just because they do not look like
    // ordinary prose; only the explicit heading/caption exclusions above are
    // safe to skip.
    return fail("later", "selection-includes-unrecognized-text");
  }
  const from = result.indexOf(first.line);
  const to = result.indexOf(last.line);
  if (from < 0 || to < from) return fail("later", "paragraph-order-mismatch");
  for (const line of result.slice(from + 1, to)) {
    const layout = pages.get(line.page!)!;
    const total = new Set(
      (line.chars || []).filter((index) => layout.stream[index]),
    ).size;
    if (total && (touchCount.get(line) || 0) < total * 0.6)
      return fail("later", "paragraph-order-mismatch");
  }
  // A layout break before an equation is not the end of a natural paragraph.
  // Refuse the range rather than sending prose fragments such as "because"
  // while omitting the formula or body text that completes the sentence.
  if (
    paragraphs.some(
      (lines) => !/[.!?。！？:：;；]["'”’）)\]]*$/.test(lines.at(-1)!.text),
    )
  )
    return fail("later", "paragraph-ending-unconfirmed");
  const text = paragraphs
    .map((lines) =>
      joinedLines(
        lines
          .map((line) => {
            // Equation labels such as "(Eq. 12)" are not running text.
            const text = [line, ...(pieces.get(line) || [])]
              .sort((a, b) => a.x - b.x)
              .map((part) => part.text.replace(EQUATION_TAIL, ""))
              .filter(Boolean)
              .join(" ");
            return { ...line, text };
          })
          .filter((line) => line.text),
      ),
    )
    .join("\n\n");
  if (text.length > MAX_TEXT) return fail("later", "too-long");
  return { kind: "ready", text, paragraphs: paragraphs.length };
}

/** Whether a native character (or, for text items, its line) lies under a
 * selection rectangle. Undefined when the position is unknown. */
function charAtRect(layout: PageLayout, index: number, rect: number[]) {
  const box = layout.boxes[index];
  if (box) {
    const x = (box[0] + box[2]) / 2;
    const y = (box[1] + box[3]) / 2;
    const pad = Math.max(1, (rect[3] - rect[1]) * 0.25);
    return (
      x >= rect[0] - pad &&
      x <= rect[2] + pad &&
      y >= rect[1] - pad &&
      y <= rect[3] + pad
    );
  }
  const line = layout.owner.get(index);
  if (!line) return undefined;
  const x = (rect[0] + rect[2]) / 2;
  const y = (rect[1] + rect[3]) / 2;
  return (
    x >= line.x - 3 &&
    x <= line.end + 3 &&
    y >= line.y - line.size * 0.3 &&
    y <= line.y + line.size * 1.05
  );
}

/** A paragraph that reaches the foot of its column is complete only when it
 * ends a sentence and the next column or page opens with an indented prose
 * line (captions above it are ignored). */
function freshStartFollows(
  partial: Line[],
  following: ReturnType<typeof adjacentBody>,
  info: (line: Line) => PageInfo,
) {
  if (!following || !TERMINAL.test(partial.at(-1)!.text)) return false;
  const first = following.body.find((line) => !info(line).captions.has(line));
  return Boolean(
    first &&
    proseLike(first.text) &&
    first.x >= following.left + Math.max(6, partial.at(-1)!.size * 0.75),
  );
}

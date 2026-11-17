/**
 * Quality gate for the unified PaddleOCR body. Pure: no Zotero globals.
 *
 * The cloud service returns OCR Markdown; it is never "native text layer" in
 * the sense a PDF extractor can prove, so textLayer is always "ocr" here.
 * `high` is reserved for a complete document whose tables/formulas/images are
 * actually preserved; any placeholder or missing page downgrades the grade.
 */
import {
  STRUCTURAL_LOSS_PARTIAL_RATIO,
  TEXT_MIN_CHARS,
  UNVERIFIED_BLOCK_RATIO,
  type CaveatCode,
  type ParseFailureReason,
  type ParserId,
  type Quality,
} from "./types";

export type QualityInput = {
  parserId: ParserId;
  /** Effective (Unicode letter/digit) characters in the produced Markdown. */
  textChars: number;
  /** Source PDF page count; 0 when unknown. */
  totalPages: number;
  /** Pages that produced a usable page Markdown. */
  parsedPages: number;
  /** Pages whose page Markdown was empty. */
  emptyPages: number;
  /** Pages whose blocks came without usable page rectangles. */
  unverifiedBlockPages: number;
  /** Pages containing table/equation/image blocks. */
  structuralPages: number;
  /** Markdown carries a GFM pipe table. */
  tablesPreserved: boolean;
  /** Markdown carries `$...$` / `$$...$$` formulas. */
  equationsLatex: boolean;
  /** The service returned at least one image/table/figure payload/reference. */
  hasImages: boolean;
  /** Asset references in the Markdown that the service named. */
  assetsDeclared: number;
  /** Asset references that resolved to actual bytes. */
  assetsResolved: number;
  /** Output was cut by a page cap. */
  truncated: boolean;
  /** Extra caveats from the adapter (must be in the closed code set). */
  warnings?: CaveatCode[];
};

export type QualityJudgement = {
  quality: Quality;
  status: "done" | "partial" | "needs-parser" | "failed";
  reason?: ParseFailureReason;
  detail?: string;
};

export function judgeQuality(input: QualityInput): QualityJudgement {
  const totalPages = Math.max(0, Math.round(input.totalPages));
  const parsedPages = Math.max(0, Math.round(input.parsedPages));
  const emptyPages = Math.max(0, Math.round(input.emptyPages));
  const caveats = new Set<CaveatCode>(input.warnings ?? []);

  // A usable response succeeds; structural caveats remain informational.
  if (input.textChars <= 0) {
    return {
      quality: {
        level: "low",
        textLayer: "none",
        structure: "none",
        tables: "none",
        equations: "none",
        images: "none",
        caveats: [
          "partial-pages",
          ...(input.truncated ? (["truncated-pages"] as CaveatCode[]) : []),
        ],
      },
      status: "needs-parser",
      reason: "paddle-no-output",
      detail: `textChars=${input.textChars} pages=${parsedPages}/${totalPages} empty=${emptyPages}`,
    };
  }

  let status: "done" | "partial" = "done";

  // Trust explicit adapter caveats: impossible/ambiguous assets, unknown page
  // order, explicit truncation and missing pages are never a clean `done`.
  const partialWarnings: CaveatCode[] = [
    "partial-pages",
    "truncated-pages",
    "asset-missing",
    "asset-not-embedded",
    "page-order-unverified",
    "page-blocks-unverified",
  ];
  if (input.warnings?.some((code) => partialWarnings.includes(code))) {
    status = "partial";
    for (const code of input.warnings) caveats.add(code);
  }

  // Missing pages are the strongest reason to stay partial.
  if (parsedPages < totalPages) {
    status = "partial";
    caveats.add("partial-pages");
  }
  if (input.truncated) {
    status = "partial";
    caveats.add("truncated-pages");
  }
  if (
    input.unverifiedBlockPages > 0 &&
    input.unverifiedBlockPages / Math.max(1, parsedPages) >=
      UNVERIFIED_BLOCK_RATIO
  ) {
    status = "partial";
    caveats.add("page-blocks-unverified");
  }
  if (
    input.structuralPages > 0 &&
    input.structuralPages / Math.max(1, parsedPages) >
      STRUCTURAL_LOSS_PARTIAL_RATIO
  ) {
    status = "partial";
  }

  // Tables/equations/images must not be claimed when the Markdown lacks them.
  const tables = input.tablesPreserved
    ? "preserved"
    : input.structuralPages > 0
      ? "text"
      : "none";
  if (tables === "text") caveats.add("table-cells-unverified");

  const equations = input.equationsLatex
    ? "latex"
    : input.structuralPages > 0
      ? "text"
      : "none";
  if (equations === "text") caveats.add("equation-not-latex");

  let images: Quality["images"] = "none";
  if (input.assetsDeclared > 0 || input.hasImages) {
    if (
      input.assetsResolved >= input.assetsDeclared &&
      input.assetsResolved > 0
    ) {
      images = "embedded";
    } else if (input.assetsResolved > 0) {
      images = "embedded";
      status = "partial";
      caveats.add("asset-missing");
    } else {
      images = "placeholder";
      status = "partial";
      caveats.add("image-placeholder");
    }
  }

  const structure: Quality["structure"] =
    input.unverifiedBlockPages === 0 && parsedPages === totalPages
      ? "full"
      : parsedPages > 0
        ? "partial"
        : "none";

  // `high` requires the whole document and no fake/placeholder structure.
  let level: Quality["level"] = "medium";
  if (
    status === "done" &&
    structure === "full" &&
    tables !== "text" &&
    equations !== "text" &&
    images !== "placeholder"
  ) {
    level = "high";
  }
  if (status !== "done") level = "medium";
  if (parsedPages / Math.max(1, totalPages) < 0.5) level = "low";
  // A complete but very short document is usable, just low-text: do not
  // promote it to high/medium and do not reject it either.
  if (input.textChars < TEXT_MIN_CHARS) level = "low";

  return {
    quality: {
      level,
      textLayer: "ocr",
      structure,
      tables,
      equations,
      images,
      caveats: [...caveats],
    },
    status: "done",
  };
}

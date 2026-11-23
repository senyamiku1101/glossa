/** Shared contracts for cloud parsing and native Markdown attachments. */

/** Format of the produced Markdown and of the hosted-body comment line. */
export const BODY_SCHEMA_VERSION = 1;
/** Bump when body/warning layout or materialization changes. */
export const CONVERTER_VERSION = "2";

/** Supported cloud parser engines. */
export const PARSER_IDS = ["paddleocr-cloud", "mineru-cloud"] as const;
export type ParserId = (typeof PARSER_IDS)[number];

/** User-visible lifecycle of one source PDF. */
export const PREP_STATUSES = [
  "queued",
  "waiting-file",
  "waiting-config",
  "running",
  "done",
  "partial",
  "needs-parser",
  "failed",
  "cancelled",
  "stale",
  "no-pdf",
  "read-only",
  "unsupported",
] as const;
export type PrepStatus = (typeof PREP_STATUSES)[number];

export const QUALITY_LEVELS = ["high", "medium", "low"] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

/** Stable caveat codes; unknown codes must not be emitted. */
export const CAVEAT_CODES = [
  "ocr",
  "partial-pages",
  "asset-missing",
  "asset-not-embedded",
  "image-placeholder",
  "table-cells-unverified",
  "equation-not-latex",
  "truncated-pages",
  "page-label-from-index",
  "page-blocks-unverified",
  "page-order-unverified",
  "user-modified-body",
] as const;
export type CaveatCode = (typeof CAVEAT_CODES)[number];

/** What the body actually preserves. */
export type Quality = {
  level: QualityLevel;
  textLayer: "native" | "ocr" | "none";
  structure: "full" | "partial" | "none";
  tables: "preserved" | "text" | "none";
  equations: "latex" | "text" | "none";
  images: "embedded" | "placeholder" | "none";
  caveats: CaveatCode[];
};

/**
 * Fingerprint of the source PDF. `md5` is Zotero's attachment hash; size and
 * mtime are the cheap change detector before re-hashing the file.
 */
export type SourceFingerprint = {
  attachmentKey: string;
  /** Undefined for a standalone PDF attachment without a regular parent. */
  parentKey?: string;
  libraryID: number;
  filename: string;
  md5: string;
  size: number;
  mtime: number;
  pageCount: number;
};

export type BlockType =
  | "heading"
  | "paragraph"
  | "list"
  | "listitem"
  | "caption"
  | "table"
  | "equation"
  | "image"
  | "preformatted"
  | "blockquote"
  | "note";

/** Location of one converted block, for reader alignment and citation work. */
export type BlockLoc = {
  type: BlockType;
  /** 0-based page index. */
  pageIndex: number;
  /** Printed page label when the service provides one. */
  pageLabel?: string;
  /**
   * `[pageIndex, x1, y1, x2, y2]` when the service provides boxes.
   * - `"page-fraction"`: normalized `[0..1]` coordinates, top-left origin.
   * - `"service-pixels"`: provider rendered-image pixels, top-left origin.
   * - `"pdf-points"`: PDF user-space points, bottom-left origin.
   */
  pageRects?: number[][];
  pageRectsSpace?: "page-fraction" | "service-pixels" | "pdf-points";
  /** Rendered page pixel dimensions `[widthPx, heightPx]` when reported. */
  pageSize?: [number, number];
  /** Clean Markdown text for this block (formulas/tables intact). */
  text?: string;
  /** Relative asset path (e.g. `images/p001-fig.jpg`) for figure/table blocks. */
  assetPath?: string;
  /** Attached figure/table caption text when provided by the parser. */
  caption?: string;
  /** UTF-16 offsets into the hosted Markdown file. */
  mdStart: number;
  mdEnd: number;
};

export type BodyAsset = {
  kind: "figure" | "table" | "page";
  pageIndex?: number;
  pageLabel?: string;
  /** Relative path as referenced by the engine, e.g. `images/figure-1.jpg`. */
  filename: string;
  mime: string;
  bytes: Uint8Array;
};

/** One asset that must be written beside the hosted body.md. */
export type HostedResource = {
  /** Slash-separated path below the attachment storage dir. */
  relativePath: string;
  mime: string;
  bytes: Uint8Array;
};

/** Result of turning a ParsedBody into the hosted body.md + resources. */
export type HostedBodyPlan = {
  markdown: string;
  resources: HostedResource[];
  /** Number of asset links resolved to an existing resource. */
  resolved: number;
  /** Number of asset links replaced with a placeholder. */
  placeholders: number;
  warnings: CaveatCode[];
};

export type HostedBodyOptions = {
  /** Per-asset and total caps for assets kept beside body.md. */
  maxAssetBytes?: number;
  maxTotalAssetBytes?: number;
};

export type RemoteInfo = {
  provider: "paddleocr" | "mineru";
  /** API host used for submission and polling (not a presigned URL host). */
  host: string;
  uploadedAt: number;
  jobId?: string;
  modelVersion?: string;
};

/** First-line JSON comment of a hosted body.md; no YAML parser needed. */
export type HostedBodyMeta = {
  v: number;
  sourceKey: string;
  parentKey?: string;
  md5: string;
  size: number;
  mtime: number;
  pageCount: number;
  parser: ParserId;
  /** Provider model name or version, e.g. "PP-StructureV3" / "vlm". */
  modelVersion?: string;
  schemaVersion?: string;
  converterVersion: string;
  configVersion: string;
  status: PrepStatus;
  quality: QualityLevel;
  generatedAt: string;
  assetMode: "placeholder" | "relative";
  remote?: RemoteInfo;
  /** SHA-1 (hex) of the body text written, for user-edit detection. */
  bodySha1: string;
};

/** Output of a parser adapter. Storage/queue/UI treat it uniformly. */
export type ParsedBody = {
  /** Intermediate Markdown; asset links are resolved by materialization. */
  markdown: string;
  assets: BodyAsset[];
  blocks: BlockLoc[];
  source: SourceFingerprint;
  parserId: ParserId;
  processorVersion?: string;
  schemaVersion?: string;
  converterVersion: string;
  quality: Quality;
  warnings: CaveatCode[];
  generatedAt: string;
  remote?: RemoteInfo;
};

export type ParseFailureStatus =
  | "needs-parser"
  | "failed"
  | "waiting-file"
  | "waiting-config"
  | "read-only"
  | "no-pdf"
  | "unsupported";

export type ParseFailureReason =
  | "mineru-not-configured"
  | "mineru-api"
  | "mineru-network"
  | "mineru-invalid-output"
  | "mineru-too-large"
  | "mineru-timeout"
  | "mineru-bad-token"
  | "mineru-no-output"
  | "no-pdf-attachment"
  | "file-not-downloaded"
  | "paddle-not-configured"
  | "paddle-bad-token"
  | "paddle-quota"
  | "paddle-too-large"
  | "paddle-unsupported-pdf"
  | "paddle-password-required"
  | "paddle-network"
  | "paddle-timeout"
  | "paddle-api"
  | "paddle-no-output"
  | "paddle-invalid-output"
  | "cancelled"
  | "user-modified-body"
  | "internal-error";

export type ParseOutcome =
  | {
      ok: true;
      body: ParsedBody;
      /**
       * Final quality-gate status. The adapter runs `judgeQuality()` once and
       * returns it here; the queue trusts this value directly.
       */
      status: "done" | "partial";
    }
  | {
      ok: false;
      status: ParseFailureStatus;
      reason: ParseFailureReason;
      detail?: string;
    };

export type ProgressStage =
  "uploading" | "polling" | "downloading" | "converting";

export type ProgressEvent = {
  stage: ProgressStage;
  page?: number;
  pages?: number;
  percent?: number;
};

/**
 * Per-run options. `apiKey` is resolved from Zotero's login manager by the
 * caller and is never written to metadata, logs or the hosted Markdown.
 */
export type ParseOptions = {
  onProgress?: (event: ProgressEvent) => void;
  isCancelled?: () => boolean;
  cancelSignal?: AbortSignal;
  /** Provider API token. Not persisted by Glossa. */
  apiKey?: string;
  /**
   * User-selected Paddle `pageRanges` (e.g. "1-100"). Only set after an
   * explicit user choice; never a default. The adapter sends it and marks
   * the result truncated/partial.
   */
  pageRanges?: string;
  /**
   * Called by the adapter immediately after submit succeeds and before
   * polling starts, so the queue can persist the job id for later resume.
   */
  onSubmitted?: (remote: RemoteInfo) => void;
  /** Resume an already-submitted job by polling/downloading only. */
  resumeJobId?: string;
};

export type CloudConfig = { endpoint: string; model: string };
export type MineruConfig = {
  endpoint: string;
  modelVersion: "vlm" | "pipeline";
  language: string;
  isOcr: boolean;
  selfHosted: boolean;
};

export type BodySourceInput = {
  attachment: Zotero.Item;
  pdfPath: string;
  fingerprint: SourceFingerprint;
};

export interface BodySource {
  id: ParserId;
  label: string;
  isRemote(): boolean;
  available(): Promise<boolean>;
  parse(input: BodySourceInput, options: ParseOptions): Promise<ParseOutcome>;
}

/** Persisted queue/state row exposed to the UI. */
export type PrepState = {
  key: string;
  attachmentKey: string;
  parentKey?: string;
  libraryID: number;
  /** Display title resolved by the queue; optional for older journal rows. */
  title?: string;
  status: PrepStatus;
  quality?: Quality;
  parserId?: ParserId;
  source?: SourceFingerprint;
  hostedAttachmentKey?: string;
  pageCount?: number;
  updatedAt?: number;
  attempts: number;
  reason?: ParseFailureReason;
  detail?: string;
  progress?: ProgressEvent;
  lastAttemptError?: string;
  remote?: RemoteInfo;
};

export type BatchSummary = {
  total: number;
  queued: number;
  skipped: number;
  waitingFile: number;
  waitingConfig: number;
  failed: number;
  noPdf: number;
};

/** FNV-1a hash for small config fingerprints; stable across runs. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ---- quality gate thresholds (quality.ts owns the judgement) ----

/** Documents below this effective character count are graded `low` quality. */
export const TEXT_MIN_CHARS = 200;
/** Too many unverified page blocks downgrade `done` to `partial`. */
export const UNVERIFIED_BLOCK_RATIO = 0.5;

export const DEFAULT_PARSER: ParserId = "paddleocr-cloud";

/** Official AI Studio PaddleOCR OCR jobs endpoint (fixed by the provider). */
export const DEFAULT_PADDLE_ENDPOINT =
  "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
/** Default layout + Markdown model for PP-StructureV3 output. */
export const DEFAULT_PADDLE_MODEL = "PP-StructureV3";

/** True when a status means the user already has a readable body. */
export function hasBody(status: PrepStatus): boolean {
  return status === "done" || status === "partial" || status === "stale";
}

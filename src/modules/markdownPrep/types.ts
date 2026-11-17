/** Shared contracts for cloud parsing and native Markdown attachments. */

/** Format of the produced Markdown and of the hosted-body comment line. */
export const BODY_SCHEMA_VERSION = 1;
/** Bump when body/warning layout or materialization changes. */
export const CONVERTER_VERSION = "2";
/** Bump when thresholds in quality.ts change. */
export const QUALITY_POLICY_VERSION = "2";

/** The only body source in the current product direction. */
export const PARSER_IDS = ["paddleocr-cloud", "mineru-cloud"] as const;
export type ParserId = (typeof PARSER_IDS)[number];

/**
 * User-visible lifecycle of one source PDF.
 *
 * `waiting-consent` is deliberate: before the user explicitly enables
 * cloud auto-submission, a new PDF is queued but never uploaded. `waiting-config`
 * means endpoint/token is missing, and is also not an upload.
 */
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
  /**
   * The attachment cannot carry a bundle even though nothing is wrong with the
   * cloud: a linked file (the PDF is not in a Zotero storage directory) or a
   * non-imported storage mode. Explicit, never silently treated as synced.
   */
  "unsupported",
] as const;
export type PrepStatus = (typeof PREP_STATUSES)[number];

export const QUALITY_LEVELS = ["high", "medium", "low"] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

/**
 * Stable caveat codes; user-facing labels live in the FTL files. This is a
 * closed set for the Paddle-only path. Unknown codes must not be emitted.
 */
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

/**
 * What the body actually preserves. `level` is the overall grade and is never
 * enough on its own: the UI must show the individual fields and caveats.
 */
export type Quality = {
  level: QualityLevel;
  /** PaddleOCR cloud always reads rendered pages, so this is normally "ocr". */
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

/** Location of one converted block, for later citation/evidence work. */
export type BlockLoc = {
  type: BlockType;
  /** 0-based page index. */
  pageIndex: number;
  /** Printed page label when the service provides one. */
  pageLabel?: string;
  /**
   * `[pageIndex, x1, y1, x2, y2]` when the service provides boxes. Paddle's
   * boxes are rendered-pixel coordinates, not PDF points; the coordinate space
   * is explicit so nobody pretends they can be used as PDF geometry.
   */
  pageRects?: number[][];
  pageRectsSpace?: "service-pixels" | "pdf-points";
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
  /** When the user granted upload consent. */
  uploadedAt: number;
  jobId?: string;
  modelVersion?: string;
};

/**
 * Storage layout of the generated body. The product layout is a "bundle": the
 * generated Markdown, metadata and assets live directly inside the PDF's own
 * Zotero storage directory (`storage/<PDF_KEY>/glossa-body.md`, ...), beside
 * the untouched PDF file, so Zotero's own attachment sync (WebDAV for the first
 * user) uploads one package. A nested subdirectory is deliberately NOT used:
 * Zotero's attachment ZIP download does not create parent directories and
 * flattens Windows backslash entries, so only files at the storage root can be
 * restored on a new machine. No separate Markdown attachment item is created.
 */
export const BUNDLE_LAYOUT = "bundle-flat-v1" as const;
export type BundleLayout = typeof BUNDLE_LAYOUT;
/** Bundle-only part of the metadata; absent on legacy hosted `.md` bodies. */
export type BundleMetaInfo = {
  layout: BundleLayout;
  /** Monotonic per-PDF commit counter, bumped on every successful write. */
  generation: number;
  /** Content token shared by the flat `glossa-asset-<token>-<i>.<ext>` files. */
  assetToken?: string;
  /** Exact flat asset filenames written for this generation (existence check). */
  assetFiles?: string[];
  assetCount: number;
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
  /** Paddle model name, e.g. "PP-StructureV3" / "PaddleOCR-VL-1.6". */
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
  /** Present only for the in-storage bundle layout (not legacy `.md` items). */
  assetFiles?: string[];
  bundle?: BundleMetaInfo;
};

/** Output of the PaddleOCR adapter. Storage/queue/UI treat it uniformly. */
export type ParsedBody = {
  /** Intermediate Markdown; asset links are resolved by materialization. */
  markdown: string;
  assets: BodyAsset[];
  blocks: BlockLoc[];
  source: SourceFingerprint;
  parserId: ParserId;
  /** Paddle model name. */
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
  | "paddle-not-authorized"
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
  | "internal-error"
  /** The PDF is a linked file, so it has no Zotero storage directory to extend. */
  | "linked-file"
  /** Imported snapshot/embedded mode; not a regular imported PDF file. */
  | "non-imported-storage";

export type ParseOutcome =
  | {
      ok: true;
      body: ParsedBody;
      /**
       * Final quality-gate status. The adapter (D) runs
       * `judgeQuality()`/`convertPaddleJsonl()` once and returns it here; the
       * queue must trust this value instead of re-deriving done/partial.
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
 * Upload consent is a precondition of the PaddleOCR source.
 * `auto` is the first-time "allow new PDFs to be submitted" grant; `batch` is
 * one manual batch whose range was just shown to the user. Both carry the API
 * host they were granted for. The queue never uploads without one of these.
 */

/**
 * Per-run options. `apiKey` is resolved from Zotero's login manager by the
 * caller and is never written to metadata, logs or the hosted Markdown.
 */
export type ParseOptions = {
  onProgress?: (event: ProgressEvent) => void;
  isCancelled?: () => boolean;
  /** AbortSignal is available in the Zotero privileged window. */
  cancelSignal?: AbortSignal;
  /** Required for the remote source; the adapter must refuse without it. */
  /** PaddleOCR API token. Not persisted by Glossa. */
  apiKey?: string;
  /**
   * DEPRECATED in the first phase and ignored by the adapter. Complete bodies
   * always request all pages (no implicit first-N cap, no internal page
   * limit). Keep the field only for source compatibility until B/C remove the
   * old setting; new code must use `pageRanges` and only after an explicit
   * user choice.
   */
  maxPages?: number;
  /**
   * User-selected Paddle `pageRanges` (e.g. "1-100"). Only set after an
   * explicit user choice; never a default. The adapter must send it and mark
   * the result truncated/partial.
   */
  pageRanges?: string;
  /**
   * Called by the adapter immediately after submit succeeds and before
   * polling starts, so the queue can persist the job id for later resume.
   * The implementation must wrap the callback in try/catch and never let a
   * listener error abort the parse.
   */
  onSubmitted?: (remote: RemoteInfo) => void;
  /**
   * Resume an already-submitted job by polling/downloading only. The adapter
   * must never upload again, and must still validate endpoint/consent/token
   * before making any request.
   */
  resumeJobId?: string;
};

/**
 * Cloud endpoint/model options; the token is never part of this type.
 * Token secret name: `markdown.cloud.token` (Zotero login manager, never prefs).
 */
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
  /** Always true for the PaddleOCR cloud source. */
  isRemote(): boolean;
  /**
   * Adapter code is usable. This is NOT "configured" and NOT "consented":
   * the queue owns those checks and maps them to waiting-config /
   * waiting-consent.
   */
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
  /** Hosted product location; read-only libraries have no hosted product. */
  hosted?: {
    attachmentKey?: string;
    mode: "child" | "standalone-related";
    status: "hosted" | "skipped-read-only" | "failed";
    assetCount: number;
  };
  pageCount?: number;
  updatedAt?: number;
  attempts: number;
  reason?: ParseFailureReason;
  detail?: string;
  progress?: ProgressEvent;
  lastAttemptError?: string;
  remote?: RemoteInfo;
  /**
   * Generated body inside the source PDF's own storage directory. Absent on a
   * legacy row whose product is still a standalone `.md` attachment (the old
   * item is kept for explicit migration; new conversions never create one).
   */
  bundle?: {
    /** `ready` = readable body, `stale` = readable but source PDF changed. */
    storageState: "ready" | "stale";
    bodyPath?: string;
    generation?: number;
    assetCount: number;
    /**
     * True when the latest official sync marking (bundleSync) did not succeed;
     * the body is local and usable but must not be reported as synced.
     */
    syncPending?: boolean;
    /** Concrete reason when sync could not be requested. */
    syncReason?: string;
  };
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

// ---- public bundle (in-PDF-storage) contract shared by UI and sync ----

/** Lifecycle of the generated body for one PDF attachment. */
export const BUNDLE_STORAGE_STATES = [
  "ready",
  "stale",
  "invalid",
  "legacy-only",
  "none",
  "unavailable",
] as const;
export type BundleStorageState = (typeof BUNDLE_STORAGE_STATES)[number];

/** Why this PDF never got a bundle (storage-level, not a cloud/queue failure). */
export type BundleUnavailableReason =
  | "not-pdf"
  | "linked-file"
  | "non-imported-storage"
  | "no-local-file"
  | "read-only"
  | "no-storage";

/** Why existing bundle files cannot be used as a readable body. */
export type BundleInvalidReason =
  "body-missing" | "body-corrupt" | "source-mismatch" | "assets-missing";

/**
 * One PDF's storage-level body view. Never claims anything about sync: the UI
 * combines it with `bundleSync.getBundleSyncCapability(pdf)` for that.
 */
export type BundleInfo = {
  pdfKey: string;
  libraryID: number;
  parentKey?: string;
  storageState: BundleStorageState;
  reason?: BundleUnavailableReason | BundleInvalidReason;
  /** Native absolute paths below the PDF storage dir (`glossa/...`). */
  bodyPath?: string;
  metaPath?: string;
  assetsDir?: string;
  meta?: HostedBodyMeta;
  quality?: QualityLevel;
  pageCount?: number;
  generation?: number;
  updatedAt?: number;
  /** Body text differs from the SHA-1 recorded in its metadata. */
  userModified?: boolean;
  /** Body still belongs to the current PDF file (size+mtime+md5). */
  fresh: boolean;
  /** The PDF file itself is not downloaded / missing locally. */
  sourceFileMissing: boolean;
  canWriteBundle: boolean;
  canMigrateLegacy: boolean;
  /** Concrete storage reason when writes are blocked but the body is readable. */
  writeBlockedReason?: BundleUnavailableReason;
  /** Old standalone `.md` attachment key, when one still exists. */
  legacyAttachmentKey?: string;
};

/** Cheap write/read eligibility check for a migration button or menu item. */
export type BundlePolicy = {
  canRead: boolean;
  canWrite: boolean;
  canMigrate: boolean;
  reason?: BundleUnavailableReason;
};

export type BundleMigrationStatus = "migrated" | "skipped" | "failed";
export type BundleMigrationReason =
  | "no-legacy"
  | "already-bundle"
  | "read-only"
  | "linked-file"
  | "no-local-file"
  | "unsupported-library"
  | "assets-incomplete"
  | "body-corrupt"
  | "user-modified"
  | "user-modified-bundle"
  | "stale-source"
  | "occupied-by-foreign-file"
  | "internal-error";

/** Result of copy-migrating one legacy hosted `.md` into its PDF bundle. */
export type BundleMigrationResult = {
  pdfKey: string;
  status: BundleMigrationStatus;
  reason?: BundleMigrationReason;
  detail?: string;
  /** Migration never deletes the legacy item; always true by construction. */
  oldAttachmentKept: boolean;
  bundle?: BundleInfo;
  /** Official-sync marking outcome; absent when no sync module is registered. */
  sync?: { ok: boolean; reason?: string };
};

export type BundleChangeType = "written" | "migrated" | "removed";
/** UI refresh signal emitted after a successful bundle/migration commit. */
export type BundleChangeEvent = {
  libraryID: number;
  pdfKey: string;
  type: BundleChangeType;
};

export type CacheKeyInput = {
  md5: string;
  parserId: ParserId;
  processorVersion?: string;
  schemaVersion?: string;
  converterVersion: string;
  /** Hash of parser options; different configs must never share a body. */
  configVersion: string;
};

/**
 * Content-addressed working-cache key. Same source with a different
 * model/converter/config version must never reuse a cached body.
 */
export function cacheKey(input: CacheKeyInput): string {
  return [
    input.md5.toLowerCase(),
    input.parserId,
    input.processorVersion ?? "-",
    input.schemaVersion ?? "-",
    input.converterVersion,
    input.configVersion,
  ].join("|");
}

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

/** A document with fewer effective characters is not a usable body. */
export const TEXT_MIN_CHARS = 200;
/**
 * Genuinely short documents (one-page notes, graphical abstracts,
 * corrigenda) must not be rejected just for being under TEXT_MIN_CHARS. For
 * at most this many pages the gate only requires *some* text and complete
 * coverage; the quality level still reports the short/low-text reality.
 */
export const SHORT_DOC_MAX_PAGES = 10;
export const SHORT_DOC_MIN_CHARS = 10;
/** A page with fewer effective characters counts as an empty/OCR-failed page. */
export const PAGE_TEXT_MIN = 30;
/** More than this share of empty pages means the service output is unusable. */
export const EMPTY_PAGE_RATIO = 0.5;
/** Missing/failed pages above this share force `partial` instead of `done`. */
export const PARTIAL_PAGE_RATIO = 0;
/** Too many unverified page blocks downgrade `done` to `partial`. */
export const UNVERIFIED_BLOCK_RATIO = 0.5;
/** Pages carrying table/math/image blocks above this share => `partial`. */
export const STRUCTURAL_LOSS_PARTIAL_RATIO = 0.3;

export const DEFAULT_PARSER: ParserId = "paddleocr-cloud";

/** Official AI Studio PaddleOCR OCR jobs endpoint (fixed by the provider). */
export const DEFAULT_PADDLE_ENDPOINT =
  "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
/** Layout + Markdown model used by Agentero for PP-StructureV3 output. */
export const DEFAULT_PADDLE_MODEL = "PP-StructureV3";

export function isParserId(value: unknown): value is ParserId {
  return (
    typeof value === "string" &&
    (PARSER_IDS as readonly string[]).includes(value)
  );
}

/** True when a status means the user already has a readable body. */
export function hasBody(status: PrepStatus): boolean {
  return status === "done" || status === "partial" || status === "stale";
}

/** True when an attempt is over and a retry action makes sense. */
export function isTerminal(status: PrepStatus): boolean {
  return (
    status === "done" ||
    status === "partial" ||
    status === "needs-parser" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "read-only" ||
    status === "unsupported" ||
    status === "no-pdf"
  );
}

/** True when the status is waiting on the user, not on Glossa or the network. */
export function awaitsUser(status: PrepStatus): boolean {
  return status === "waiting-config" || status === "waiting-file";
}

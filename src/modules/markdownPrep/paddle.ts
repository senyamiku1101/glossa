/**
 * PaddleOCR official cloud body source (task D, the only parser provider).
 *
 * Flow (verified against the official Python SDK under
 * `paddleocr/_api_client/` on 2026-11-16):
 *   POST {endpoint} multipart file+model+optionalPayload -> data.jobId
 *   GET  {endpoint}/{jobId} -> state pending|running|done|failed
 *   GET  resultUrl.jsonUrl (presigned, no auth) -> JSONL pages
 *   GET  each markdown.images URL (presigned, no auth) -> image bytes
 * The token is only ever sent to the configured API host. Result and resource
 * URLs are untrusted third-party origins, so they are fetched without auth
 * after https/private-host checks and with size limits.
 *
 * There is no cancel API: cancelling stops local polling/downloading, while an
 * already submitted job may keep running on the service (UI must say so).
 */
import {
  DEFAULT_PADDLE_MODEL,
  type BodyAsset,
  type BodySource,
  type BodySourceInput,
  type CaveatCode,
  type CloudConfig,
  type ParseOptions,
  type ParseOutcome,
  type ParseFailureReason,
  type ParseFailureStatus,
  type ProgressEvent,
  type RemoteInfo,
} from "./types";
import { registerBodySource } from "./sources";
import { convertPaddleJsonl } from "./paddleConvert";
import { readPaddleToken, readSettings } from "./settings";
import {
  MAX_ASSET_BYTES,
  MAX_JSONL_BYTES,
  MAX_TOTAL_ASSET_BYTES,
  type ImageResource,
  PaddlePayloadError,
  assertUploadablePdf,
  buildMultipartBody,
  isSafeHttpsUrl,
  planImageResources,
  sniffImageMime,
  toBodyAsset,
} from "./paddleAssets";
import { io } from "../../utils/paths";

const SUBMIT_TIMEOUT_MS = 180_000;
const POLL_REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const ASSET_TIMEOUT_MS = 60_000;
const POLL_INITIAL_MS = 3_000;
const POLL_MAX_MS = 15_000;
/** Whole-job wait. The official SDK defaults to 600s; papers can be slower. */
const POLL_TOTAL_MS = 15 * 60_000;
const POLL_TRANSIENT_RETRIES = 5;
const ASSET_CONCURRENCY = 3;

export type PaddleRequest = {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  responseType: "text" | "arraybuffer";
  timeoutMs: number;
  /**
   * API requests set false so a redirect can never carry the bearer token to
   * another host; result/resource downloads keep the default redirects because
   * they never carry the token.
   */
  followRedirects?: boolean;
};

export type PaddleResponse = {
  status: number;
  body: string | ArrayBuffer;
  /** Final URL after redirects, when the transport exposes it. */
  finalUrl?: string;
};

export type PaddleCancelState = {
  isCancelled(): boolean;
  signal?: AbortSignal;
};

export type PaddleTransport = {
  request(
    request: PaddleRequest,
    cancel: PaddleCancelState,
  ): Promise<PaddleResponse>;
};

export type PaddleDeps = {
  transport?: PaddleTransport;
  readPdf?: (path: string) => Promise<Uint8Array>;
  /** Real PDF page count; falls back to Zotero's cached page count. */
  pageCount?: (attachment: Zotero.Item) => Promise<number>;
  config?: CloudConfig;
  token?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type PaddleTestResult = {
  ok: boolean;
  detail:
    | "ok"
    | "no-token"
    | "disabled"
    | "network"
    | "bad-endpoint"
    | "bad-token"
    | "rate-limited"
    | "api-error"
    | "unsupported";
};

class PaddleJobError extends Error {
  constructor(readonly outcome: Extract<ParseOutcome, { ok: false }>) {
    super(outcome.detail || outcome.reason);
    this.name = "PaddleJobError";
  }
}

function fail(
  status: ParseFailureStatus,
  reason: ParseFailureReason,
  detail?: string,
): Extract<ParseOutcome, { ok: false }> {
  return { ok: false, status, reason, ...(detail ? { detail } : {}) };
}

function errorOutcome(error: unknown): ParseOutcome {
  if (error instanceof PaddleJobError) return error.outcome;
  if (error instanceof PaddlePayloadError) {
    return fail("failed", error.reason, error.message);
  }
  return fail(
    "failed",
    "internal-error",
    error instanceof Error ? error.message : String(error),
  );
}

// ---- cancellation ----

function makeCancel(options: ParseOptions): PaddleCancelState {
  return {
    isCancelled() {
      return (
        Boolean(options.isCancelled?.()) ||
        Boolean(options.cancelSignal?.aborted)
      );
    },
    ...(options.cancelSignal ? { signal: options.cancelSignal } : {}),
  };
}

function checkCancelled(cancel: PaddleCancelState) {
  if (cancel.isCancelled()) {
    throw new PaddleJobError(fail("failed", "cancelled", "cancelled"));
  }
}

// ---- default Zotero transport ----

const zoteroTransport: PaddleTransport = {
  async request(request, cancel) {
    let cancelRequest: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const abort = () => {
      if (cancelRequest) cancelRequest();
    };
    if (typeof setInterval === "function") {
      timer = setInterval(() => {
        if (cancel.isCancelled()) abort();
      }, 250);
    }
    cancel.signal?.addEventListener("abort", abort, { once: true });
    try {
      const xhr = await Zotero.HTTP.request(request.method, request.url, {
        headers: request.headers,
        body: request.body,
        responseType: request.responseType,
        ...(request.followRedirects === false
          ? { followRedirects: false }
          : {}),
        // Handle non-2xx ourselves; the default retry policy is not wanted.
        successCodes: false,
        errorDelayMax: 0,
        timeout: request.timeoutMs,
        cancellerReceiver: (fn: () => void) => {
          cancelRequest = fn;
          if (cancel.isCancelled()) fn();
        },
      });
      const body =
        request.responseType === "arraybuffer"
          ? (xhr.response as ArrayBuffer)
          : String(xhr.responseText ?? xhr.response ?? "");
      return {
        status: xhr.status,
        body,
        ...(xhr.responseURL ? { finalUrl: String(xhr.responseURL) } : {}),
      };
    } finally {
      if (timer !== undefined) clearInterval(timer);
      cancel.signal?.removeEventListener("abort", abort);
    }
  },
};

// ---- HTTP helpers ----

function apiHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function mediaHeaders(): Record<string, string> {
  return { Accept: "*/*" };
}

function isTextResponse(response: PaddleResponse): string {
  if (typeof response.body === "string") return response.body;
  return "";
}

function isArrayResponse(response: PaddleResponse): ArrayBuffer {
  const body: unknown = response.body;
  // `instanceof` is unsafe when the transport and this module live in
  // different JS compartments (tests, some Zotero sandboxes).
  if (Object.prototype.toString.call(body) === "[object ArrayBuffer]") {
    return body as ArrayBuffer;
  }
  if (body && ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer;
  }
  return new ArrayBuffer(0);
}

function assertFinalHttps(response: PaddleResponse, what: string) {
  if (response.finalUrl && !response.finalUrl.startsWith("https://")) {
    throw new PaddleJobError(
      fail("failed", "paddle-network", `${what}: non-https redirect`),
    );
  }
}

/**
 * A bearer request must never follow a redirect to another host: some stacks
 * resend Authorization on cross-origin redirects before the caller can check.
 */
function assertAuthRedirectSameHost(
  request: PaddleRequest,
  response: PaddleResponse,
) {
  if (!request.headers?.Authorization || !response.finalUrl) return;
  try {
    const before = new URL(request.url);
    const after = new URL(response.finalUrl);
    if (before.host.toLowerCase() !== after.host.toLowerCase()) {
      throw new PaddleJobError(
        fail(
          "failed",
          "paddle-network",
          "paddle-refused-token-redirect: request host changed",
        ),
      );
    }
    if (after.protocol !== "https:") {
      throw new PaddleJobError(
        fail("failed", "paddle-network", "paddle-refused-token-redirect"),
      );
    }
  } catch (error) {
    if (error instanceof PaddleJobError) throw error;
    throw new PaddleJobError(
      fail("failed", "paddle-network", "paddle-refused-token-redirect"),
    );
  }
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new PaddleJobError(
      fail("failed", "paddle-invalid-output", `${what}: response is not JSON`),
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function apiMessage(value: Record<string, unknown>): string {
  for (const key of ["msg", "errorMsg", "message"]) {
    const message = asString(value[key]);
    if (message) return message;
  }
  const data = asRecord(value.data);
  return data ? asString(data.errorMsg) : "";
}

function businessCodeOk(value: Record<string, unknown>): boolean {
  const code = value.code ?? value.msgCode;
  return code === undefined || code === 0 || code === "0";
}

function classifyMessage(detail: string): {
  reason: ParseFailureReason;
  status: ParseFailureStatus;
} {
  const lower = detail.toLowerCase();
  if (/(invalid|expired|token|unauthori[sz]ed|auth)/.test(lower)) {
    return { status: "failed", reason: "paddle-bad-token" };
  }
  if (/(quota|rate|limit exceeded|too many)/.test(lower)) {
    return { status: "failed", reason: "paddle-quota" };
  }
  if (/(size|too large|exceed|page.*(limit|count)|100 pages)/.test(lower)) {
    return { status: "failed", reason: "paddle-too-large" };
  }
  if (/(encrypt|password)/.test(lower)) {
    return { status: "failed", reason: "paddle-password-required" };
  }
  if (/(format|unsupported|not a pdf|invalid file)/.test(lower)) {
    return { status: "failed", reason: "paddle-unsupported-pdf" };
  }
  return { status: "failed", reason: "paddle-api" };
}

function classifyHttp(
  stage: string,
  status: number,
  bodyText: string,
): Extract<ParseOutcome, { ok: false }> {
  let message: string;
  try {
    message = apiMessage(JSON.parse(bodyText) as Record<string, unknown>);
  } catch {
    message = bodyText.slice(0, 300);
  }
  const detail = `paddle-${stage}-http-${status}${
    message ? `: ${message}` : ""
  }`;
  if (status === 401 || status === 403) {
    return fail("failed", "paddle-bad-token", detail);
  }
  if (status === 429) {
    return fail("failed", "paddle-quota", detail);
  }
  if (status === 400 || status === 413 || status === 422) {
    const classified = classifyMessage(message || bodyText);
    return fail(classified.status, classified.reason, detail);
  }
  return fail("failed", "paddle-api", detail);
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return /timeout/i.test(name) || /timed out|timeout/i.test(message);
}

function isCancelledError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return /cancel/i.test(name);
}

async function send(
  transport: PaddleTransport,
  request: PaddleRequest,
  cancel: PaddleCancelState,
): Promise<PaddleResponse> {
  checkCancelled(cancel);
  try {
    const response = await transport.request(request, cancel);
    if (
      request.followRedirects === false &&
      response.status >= 300 &&
      response.status < 400
    ) {
      throw new PaddleJobError(
        fail(
          "failed",
          "paddle-api",
          "paddle-refused-redirect (check the configured endpoint)",
        ),
      );
    }
    assertFinalHttps(response, request.url);
    assertAuthRedirectSameHost(request, response);
    return response;
  } catch (error) {
    if (cancel.isCancelled() || isCancelledError(error)) {
      throw new PaddleJobError(fail("failed", "cancelled", "cancelled"));
    }
    if (isTimeoutError(error)) {
      throw new PaddleJobError(
        fail("failed", "paddle-timeout", `${request.method} ${request.url}`),
      );
    }
    throw new PaddleJobError(
      fail(
        "failed",
        "paddle-network",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

// ---- job steps ----

function optionalPayload(model: string): Record<string, unknown> {
  // Field names follow the official SDK `paddleocr/_api_client/models.py`
  // option classes (`return_markdown_images`/`use_chart_recognition` are
  // defined there for both PP-StructureV3 and PaddleOCR-VL); the public docs
  // table is not exhaustive. Whether this deployment accepts every field is
  // NOT live-verified yet, so submitJob retries once without optionalPayload
  // when a 4xx explicitly rejects it.
  if (/structure/i.test(model)) {
    return {
      useTableRecognition: true,
      useFormulaRecognition: true,
      useChartRecognition: false,
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      prettifyMarkdown: true,
      returnMarkdownImages: true,
    };
  }
  if (/vl/i.test(model)) {
    return {
      useLayoutDetection: true,
      useChartRecognition: false,
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      prettifyMarkdown: true,
      returnMarkdownImages: true,
    };
  }
  return { returnMarkdownImages: true };
}

function pdfFileName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || "document.pdf";
  const safe = base.replace(/[^\w.-]/g, "_").slice(0, 120);
  return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
}

function isOptionalPayloadRejection(message: string): boolean {
  return /optional\s*payload|optionalpayload|unknown (field|option)|unrecognized (field|option)|invalid (field|option)/i.test(
    message,
  );
}

async function submitJob(args: {
  transport: PaddleTransport;
  cancel: PaddleCancelState;
  endpoint: string;
  token: string;
  model: string;
  filename: string;
  bytes: Uint8Array;
  /** User-explicit Paddle pageRanges; "" means the whole PDF. */
  pageRange: string;
  /** False only for the one-shot retry after an optionalPayload rejection. */
  includeOptionalPayload?: boolean;
}): Promise<string> {
  const fields = [{ name: "model", value: args.model }];
  if (args.includeOptionalPayload !== false) {
    fields.push({
      name: "optionalPayload",
      value: JSON.stringify(optionalPayload(args.model)),
    });
  }
  // Official submit_file accepts an optional pageRanges string. It is sent
  // only for an explicit user choice; "" means the complete document.
  if (args.pageRange) {
    fields.push({ name: "pageRanges", value: args.pageRange });
  }
  const multipart = buildMultipartBody(fields, {
    filename: pdfFileName(args.filename),
    mime: "application/pdf",
    bytes: args.bytes,
  });
  const response = await send(
    args.transport,
    {
      method: "POST",
      url: args.endpoint,
      headers: {
        ...apiHeaders(args.token),
        "Content-Type": multipart.contentType,
      },
      body: multipart.body,
      responseType: "text",
      timeoutMs: SUBMIT_TIMEOUT_MS,
      followRedirects: false,
    },
    args.cancel,
  );
  const text = isTextResponse(response);
  if (response.status < 200 || response.status >= 300) {
    // Some deployments may validate optionalPayload strictly. Retry exactly
    // once without it; a 400 means no job was created, so this is not a
    // duplicate submission.
    if (
      args.includeOptionalPayload !== false &&
      response.status === 400 &&
      isOptionalPayloadRejection(text)
    ) {
      return submitJob({ ...args, includeOptionalPayload: false });
    }
    throw new PaddleJobError(classifyHttp("submit", response.status, text));
  }
  const value = parseJsonObject(text, "submit");
  if (!businessCodeOk(value)) {
    const message = apiMessage(value);
    if (
      args.includeOptionalPayload !== false &&
      isOptionalPayloadRejection(message)
    ) {
      return submitJob({ ...args, includeOptionalPayload: false });
    }
    const classified = classifyMessage(message);
    throw new PaddleJobError(
      fail(
        classified.status,
        classified.reason,
        `paddle-submit-code-${String(value.code ?? value.msgCode)}${
          message ? `: ${message}` : ""
        }`,
      ),
    );
  }
  const data = asRecord(value.data);
  const jobId = asString(data?.jobId);
  if (!jobId) {
    throw new PaddleJobError(
      fail("failed", "paddle-invalid-output", "submit response has no jobId"),
    );
  }
  return jobId;
}

type PollOutcome =
  | { state: "waiting" }
  | {
      state: "done";
      jsonUrl: string;
      totalPages: number;
      pageSizes?: Array<[number, number] | undefined>;
    };

function extractDataInfoPageSizes(
  dataInfo: Record<string, unknown> | undefined,
): Array<[number, number] | undefined> | undefined {
  if (!dataInfo) return undefined;
  const pages = Array.isArray(dataInfo.pages) ? dataInfo.pages : undefined;
  if (pages && pages.length) {
    const sizes = pages.map((entry): [number, number] | undefined => {
      const rec = asRecord(entry);
      const w = asNumber(rec?.width ?? rec?.pageWidth ?? rec?.imageWidth);
      const h = asNumber(rec?.height ?? rec?.pageHeight ?? rec?.imageHeight);
      return w && h && w > 0 && h > 0 ? [w, h] : undefined;
    });
    if (sizes.some(Boolean)) return sizes;
  }
  const w = asNumber(
    dataInfo.width ?? dataInfo.pageWidth ?? dataInfo.imageWidth,
  );
  const h = asNumber(
    dataInfo.height ?? dataInfo.pageHeight ?? dataInfo.imageHeight,
  );
  if (w && h && w > 0 && h > 0) return [[w, h]];
  return undefined;
}

async function pollJob(args: {
  transport: PaddleTransport;
  cancel: PaddleCancelState;
  endpoint: string;
  token: string;
  jobId: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onProgress?: (event: ProgressEvent) => void;
}): Promise<PollOutcome> {
  const started = args.now();
  let interval = POLL_INITIAL_MS;
  let transientFailures = 0;
  while (true) {
    checkCancelled(args.cancel);
    if (args.now() - started > POLL_TOTAL_MS) {
      throw new PaddleJobError(
        fail(
          "failed",
          "paddle-timeout",
          `job ${args.jobId} exceeded ${POLL_TOTAL_MS}ms`,
        ),
      );
    }
    const response = await send(
      args.transport,
      {
        method: "GET",
        url: `${args.endpoint}/${encodeURIComponent(args.jobId)}`,
        headers: apiHeaders(args.token),
        responseType: "text",
        timeoutMs: POLL_REQUEST_TIMEOUT_MS,
        followRedirects: false,
      },
      args.cancel,
    );
    const text = isTextResponse(response);
    if (response.status < 200 || response.status >= 300) {
      if (
        isTransientStatus(response.status) &&
        transientFailures < POLL_TRANSIENT_RETRIES
      ) {
        transientFailures += 1;
        await args.sleep(Math.min(interval * 2, POLL_MAX_MS));
        continue;
      }
      throw new PaddleJobError(classifyHttp("poll", response.status, text));
    }
    transientFailures = 0;
    const value = parseJsonObject(text, "poll");
    if (!businessCodeOk(value)) {
      const message = apiMessage(value);
      const classified = classifyMessage(message);
      throw new PaddleJobError(
        fail(
          classified.status,
          classified.reason,
          `paddle-poll-code-${String(value.code ?? value.msgCode)}${
            message ? `: ${message}` : ""
          }`,
        ),
      );
    }
    const data = asRecord(value.data);
    const state = asString(data?.state).toLowerCase();
    const progressRecord = asRecord(data?.extractProgress);
    const extracted = asNumber(progressRecord?.extractedPages);
    const total = asNumber(progressRecord?.totalPages);
    if (state === "done") {
      const resultUrl = asRecord(data?.resultUrl);
      const jsonUrl = asString(resultUrl?.jsonUrl);
      if (!jsonUrl) {
        throw new PaddleJobError(
          fail(
            "failed",
            "paddle-invalid-output",
            "done job has no resultUrl.jsonUrl",
          ),
        );
      }
      const pageSizes = extractDataInfoPageSizes(asRecord(data?.dataInfo));
      args.onProgress?.({ stage: "polling", page: extracted, pages: total });
      return {
        state: "done",
        jsonUrl,
        totalPages: total ?? 0,
        ...(pageSizes ? { pageSizes } : {}),
      };
    }
    if (state === "failed") {
      const message = asString(data?.errorMsg) || "Paddle job failed";
      const classified = classifyMessage(message);
      throw new PaddleJobError(
        fail(
          classified.status,
          classified.reason,
          `paddle-job-failed: ${message}`,
        ),
      );
    }
    if (state !== "pending" && state !== "running") {
      throw new PaddleJobError(
        fail("failed", "paddle-invalid-output", `unknown job state: ${state}`),
      );
    }
    args.onProgress?.({ stage: "polling", page: extracted, pages: total });
    await args.sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), POLL_MAX_MS);
  }
}

async function downloadJsonl(args: {
  transport: PaddleTransport;
  cancel: PaddleCancelState;
  jsonUrl: string;
}): Promise<string> {
  if (!isSafeHttpsUrl(args.jsonUrl)) {
    throw new PaddleJobError(
      fail("failed", "paddle-invalid-output", "unsafe result URL"),
    );
  }
  // Presigned result URLs never receive the API token.
  const response = await send(
    args.transport,
    {
      method: "GET",
      url: args.jsonUrl,
      headers: mediaHeaders(),
      responseType: "text",
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    },
    args.cancel,
  );
  const text = isTextResponse(response);
  if (response.status < 200 || response.status >= 300) {
    throw new PaddleJobError(
      fail(
        "failed",
        "paddle-network",
        `result download HTTP ${response.status}`,
      ),
    );
  }
  if (new TextEncoder().encode(text).byteLength > MAX_JSONL_BYTES) {
    throw new PaddleJobError(
      fail("failed", "paddle-too-large", "result JSONL exceeds Glossa's cap"),
    );
  }
  if (!text.trim()) {
    throw new PaddleJobError(
      fail("failed", "paddle-no-output", "result JSONL is empty"),
    );
  }
  return text;
}

async function downloadImages(args: {
  transport: PaddleTransport;
  cancel: PaddleCancelState;
  resources: ImageResource[];
  onProgress?: (event: ProgressEvent) => void;
}): Promise<{ assets: BodyAsset[]; warnings: CaveatCode[] }> {
  const assets: BodyAsset[] = [];
  const warnings = new Set<CaveatCode>();
  let total = 0;
  let next = 0;
  const worker = async () => {
    while (true) {
      checkCancelled(args.cancel);
      const index = next++;
      const resource = args.resources[index];
      if (!resource) return;
      let response: PaddleResponse;
      try {
        response = await send(
          args.transport,
          {
            method: "GET",
            url: resource.url,
            headers: mediaHeaders(),
            responseType: "arraybuffer",
            timeoutMs: ASSET_TIMEOUT_MS,
          },
          args.cancel,
        );
      } catch (error) {
        if (error instanceof PaddleJobError) {
          if (error.outcome.reason === "cancelled") throw error;
          ztoolkit.log("[Glossa] image unavailable", resource.filename, 0);
          warnings.add("asset-missing");
          continue;
        }
        ztoolkit.log("[Glossa] image unavailable", resource.filename, 0);
        warnings.add("asset-missing");
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        ztoolkit.log(
          "[Glossa] image unavailable",
          resource.filename,
          response.status,
        );
        warnings.add("asset-missing");
        continue;
      }
      const bytes = new Uint8Array(isArrayResponse(response));
      if (!bytes.byteLength) {
        ztoolkit.log("[Glossa] image unavailable", resource.filename, 0);
        warnings.add("asset-missing");
        continue;
      }
      // A presigned URL can answer 200 with an HTML error page. Only real
      // image bytes may be counted as a resolved figure.
      const mime = sniffImageMime(bytes);
      if (!mime) {
        ztoolkit.log(
          "[Glossa] image unavailable",
          resource.filename,
          response.status,
        );
        warnings.add("asset-missing");
        continue;
      }
      if (
        bytes.byteLength > MAX_ASSET_BYTES ||
        total + bytes.byteLength > MAX_TOTAL_ASSET_BYTES
      ) {
        warnings.add("asset-not-embedded");
        continue;
      }
      total += bytes.byteLength;
      assets.push(toBodyAsset(resource, bytes, mime));
      args.onProgress?.({
        stage: "downloading",
        page: assets.length,
        pages: args.resources.length,
      });
    }
  };
  const workers = Math.min(ASSET_CONCURRENCY, args.resources.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { assets, warnings: [...warnings] };
}

function mergeAssetWarnings(warnings: CaveatCode[]): CaveatCode[] {
  return [...new Set(warnings)];
}

async function runPaddle(
  input: BodySourceInput,
  options: ParseOptions,
  deps: PaddleDeps = {},
): Promise<ParseOutcome> {
  const config = deps.config ?? readSettings().cloud;
  const endpoint = normalizeCloudEndpoint(config.endpoint);
  const token = (options.apiKey ?? deps.token ?? readPaddleToken()).trim();
  const model = config.model || DEFAULT_PADDLE_MODEL;
  const cancel = makeCancel(options);

  // Missing configuration must never touch the network.
  if (!token) {
    return fail("waiting-config", "paddle-not-configured", "no-token");
  }
  if (!endpoint || !config.model.trim()) {
    return fail("waiting-config", "paddle-not-configured", "bad-endpoint");
  }
  const readPdf = deps.readPdf ?? readPdfFile;
  const transport = deps.transport ?? zoteroTransport;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Page range is ONLY a user-explicit choice (`pageRanges`). `maxPages` is
  // intentionally ignored: the first release has no page-range requirement and
  // must never silently convert "first N pages". The local safety limit is the
  // whole-file size guard above; oversized files fail explicitly.
  const pageRange = options.pageRanges?.trim() || "";

  try {
    let jobId = options.resumeJobId?.trim() || "";
    let uploadedAt = 0;
    if (jobId) {
      // Resume path: never submit/upload again. The queue keeps the original
      // remote/upload time in its journal.
      options.onProgress?.({ stage: "polling" });
    } else {
      options.onProgress?.({ stage: "uploading" });
      const bytes = await readPdf(input.pdfPath);
      assertUploadablePdf(bytes);
      jobId = await submitJob({
        transport,
        cancel,
        endpoint,
        token,
        model,
        filename: input.fingerprint.filename,
        bytes,
        pageRange,
      });
      uploadedAt = now();
    }
    const remote: RemoteInfo = {
      provider: "paddleocr",
      host: cloudEndpointHost(endpoint),
      uploadedAt,
      jobId,
      modelVersion: model,
    };
    if (!options.resumeJobId) {
      try {
        // Persist the job id before the first poll so a restart can resume.
        options.onSubmitted?.(remote);
      } catch {
        // Persisting is best-effort; a failure must not abort the conversion.
      }
    }

    const poll = await pollJob({
      transport,
      cancel,
      endpoint,
      token,
      jobId,
      now,
      sleep,
      onProgress: options.onProgress,
    });
    if (poll.state !== "done") {
      return fail("failed", "paddle-api", "paddle job did not finish");
    }
    const servicePages = poll.totalPages;
    let pdfPages = input.fingerprint.pageCount;
    if (!pdfPages) {
      try {
        pdfPages = await (deps.pageCount ?? cachedPageCount)(input.attachment);
      } catch {
        pdfPages = 0;
      }
    }
    // With pageRanges the service reports only the selected pages, so use the
    // real PDF page count for the missing-page judgement.
    const expectedPages = pageRange
      ? pdfPages || servicePages
      : servicePages || pdfPages;
    const truncated = Boolean(pageRange);

    options.onProgress?.({ stage: "downloading" });
    const jsonl = await downloadJsonl({
      transport,
      cancel,
      jsonUrl: poll.jsonUrl,
    });
    const plan = planImageResources(jsonl);
    const downloaded = await downloadImages({
      transport,
      cancel,
      resources: plan.resources,
      onProgress: options.onProgress,
    });
    checkCancelled(cancel);
    options.onProgress?.({ stage: "converting" });

    const conversion = convertPaddleJsonl({
      jsonl,
      source: input.fingerprint,
      model,
      remote,
      assets: downloaded.assets,
      ...(poll.pageSizes ? { pageSizes: poll.pageSizes } : {}),
      expectedPages: expectedPages || undefined,
      truncated,
    });
    const warnings = [
      ...new Set([
        ...conversion.body.quality.caveats,
        ...plan.warnings,
        ...mergeAssetWarnings(downloaded.warnings),
      ]),
    ];
    conversion.body.quality.caveats = warnings;
    conversion.body.warnings = warnings;

    if (conversion.judgement.status === "done") {
      return { ok: true, body: conversion.body, status: "done" };
    }
    if (conversion.judgement.status === "partial") {
      return { ok: true, body: conversion.body, status: "partial" };
    }
    if (conversion.judgement.status === "needs-parser") {
      return fail(
        "needs-parser",
        conversion.judgement.reason ?? "paddle-no-output",
        conversion.judgement.detail,
      );
    }
    return fail(
      "failed",
      conversion.judgement.reason ?? "paddle-invalid-output",
      conversion.judgement.detail,
    );
  } catch (error) {
    return errorOutcome(error);
  }
}

async function readPdfFile(path: string): Promise<Uint8Array> {
  const bytes = await io().read(path);
  return new Uint8Array(bytes);
}

/**
 * Zotero's cached page count for an attachment. Used when the queue's source
 * fingerprint has no page count yet, so hosted metadata and missing-page
 * judgement still use the real PDF page count.
 */
async function cachedPageCount(attachment: Zotero.Item): Promise<number> {
  try {
    const pages = await Zotero.FullText.getPages(attachment.id);
    if (pages && typeof pages === "object" && typeof pages.total === "number") {
      return Math.max(0, Math.round(pages.total));
    }
  } catch {
    // Page count is optional; /api/v2 results still carry totalPages.
  }
  return 0;
}

const paddleSource: BodySource = {
  id: "paddleocr-cloud",
  label: "PaddleOCR cloud",
  isRemote() {
    return true;
  },
  async available() {
    return true;
  },
  parse(input, options) {
    return runPaddle(input, options);
  },
};

let initialized = false;

/** Register the PaddleOCR body source. Idempotent; never throws. */
export async function initPaddleCloud(): Promise<void> {
  if (initialized) return;
  try {
    registerBodySource(paddleSource);
    initialized = true;
  } catch (error) {
    ztoolkit.log("[Glossa] cannot register PaddleOCR source", error);
  }
}

/**
 * Zero-upload connectivity check: a random job status GET distinguishes an
 * invalid token (401/403) from a reachable, authenticated endpoint without
 * creating a job or sending any PDF. The service has no auth-only endpoint.
 */
export async function testPaddleConnection(
  deps: PaddleDeps = {},
): Promise<PaddleTestResult> {
  const config = deps.config ?? readSettings().cloud;
  const token = (deps.token ?? readPaddleToken()).trim();
  if (!token) return { ok: false, detail: "no-token" };
  const endpoint = normalizeCloudEndpoint(config.endpoint);
  if (!endpoint) return { ok: false, detail: "bad-endpoint" };
  const transport = deps.transport ?? zoteroTransport;
  const cancel: PaddleCancelState = { isCancelled: () => false };
  try {
    const request: PaddleRequest = {
      method: "GET",
      url: `${endpoint}/${randomUuid()}`,
      headers: apiHeaders(token),
      responseType: "text",
      timeoutMs: 20_000,
      followRedirects: false,
    };
    const response = await transport.request(request, cancel);
    assertFinalHttps(response, request.url);
    assertAuthRedirectSameHost(request, response);
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: "bad-token" };
    }
    if (response.status === 429) {
      return { ok: false, detail: "rate-limited" };
    }
    if (response.status >= 500) {
      return { ok: false, detail: "api-error" };
    }
    if (response.status >= 200 && response.status < 300) {
      // A 200 is only "authenticated" if it is the API's JSON envelope, not a
      // login/proxy HTML page.
      try {
        const value: unknown = JSON.parse(isTextResponse(response));
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return { ok: true, detail: "ok" };
        }
      } catch {
        // Non-JSON 200 falls through to bad-endpoint.
      }
      return { ok: false, detail: "bad-endpoint" };
    }
    // A reachable endpoint that rejects the unknown job id (400/404/422)
    // still proves token + host are usable.
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 422
    ) {
      return { ok: true, detail: "ok" };
    }
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, detail: "bad-endpoint" };
    }
    return { ok: false, detail: "api-error" };
  } catch {
    return { ok: false, detail: "network" };
  }
}

function randomUuid(): string {
  const crypto =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: Crypto }).crypto
      : undefined;
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const hex = Array.from(bytes).map((byte) =>
    byte.toString(16).padStart(2, "0"),
  );
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/** Test/maintenance hooks: run a full mock job against an injected transport. */
export { paddleSource, runPaddle as runPaddleBodyForTests };

/**
 * Resume an already submitted job without uploading again. `onSubmitted` is
 * called right after submit so the queue can persist `jobId`; this entry point
 * consumes that id after a restart and never re-reads or re-uploads the PDF.
 */
export function resumePaddleBody(
  input: BodySourceInput,
  options: ParseOptions,
  jobId: string,
  deps: PaddleDeps = {},
): Promise<ParseOutcome> {
  const resumed = { ...options, resumeJobId: jobId } as ParseOptions;
  return runPaddle(input, resumed, deps);
}
/** API endpoints require HTTPS; credentials and fragments are not accepted. */
export function normalizeCloudEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint.trim());
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      return undefined;
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}
export function cloudEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "";
  }
}

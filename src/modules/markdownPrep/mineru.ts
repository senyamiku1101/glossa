/** MinerU v4 cloud adapter. No Node dependencies and no credentials on presigned URLs. */
import {
  CONVERTER_VERSION,
  type BlockLoc,
  type BlockType,
  type BodyAsset,
  type BodySource,
  type BodySourceInput,
  type MineruConfig,
  type ParseOptions,
  type ParseOutcome,
  type RemoteInfo,
} from "./types";
import { readMineruToken, readSettings } from "./settings";
import { registerBodySource } from "./sources";
import { judgeQuality } from "./quality";
import {
  assertUploadablePdf,
  isSafeHttpsUrl,
  hostedImageFilename,
  sniffImageMime,
} from "./paddleAssets";
import { io } from "../../utils/paths";

export const MAX_MINERU_ZIP_BYTES = 256 * 1024 * 1024;
export const MAX_MINERU_ENTRIES = 4096;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_POLL_MS = 30 * 60_000;
export type MineruRequest = {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  responseType: "text" | "arraybuffer";
  timeoutMs: number;
  maxBytes: number;
};
export type MineruResponse = {
  status: number;
  body: string | ArrayBuffer | Uint8Array;
  finalUrl?: string;
};
export type MineruCancelState = {
  isCancelled: () => boolean;
  signal?: AbortSignal;
};
export type MineruTransport = {
  request(
    request: MineruRequest,
    cancel: MineruCancelState,
  ): Promise<MineruResponse>;
};
export type ZipEntry = { name: string; bytes: Uint8Array };
export type MineruDeps = {
  transport?: MineruTransport;
  config?: MineruConfig;
  token?: string;
  readPdf?: (path: string) => Promise<Uint8Array>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  unzip?: (bytes: Uint8Array) => Promise<ZipEntry[]>;
};
export type MineruTestResult = {
  ok: boolean;
  detail:
    | "ok"
    | "no-token"
    | "bad-endpoint"
    | "bad-token"
    | "network"
    | "rate-limited"
    | "api-error";
};

class MineruError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "mineru-api"
      | "mineru-network"
      | "mineru-invalid-output"
      | "mineru-too-large"
      | "mineru-timeout"
      | "mineru-bad-token"
      | "cancelled" = "mineru-api",
  ) {
    super(message);
    this.name = "MineruError";
  }
}
function checkCancelled(cancel: MineruCancelState): void {
  if (cancel.isCancelled()) throw new MineruError("cancelled", "cancelled");
}
export function normalizeMineruEndpoint(
  endpoint: string,
  selfHosted = false,
): string | undefined {
  try {
    const url = new URL(endpoint.trim());
    if (
      (url.protocol !== "https:" &&
        !(selfHosted && url.protocol === "http:")) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}
function safeResourceUrl(
  raw: string,
  base: string,
  selfHosted: boolean,
): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) throw new Error();
    if (
      isSafeHttpsUrl(url.href) ||
      (selfHosted &&
        url.origin === new URL(base).origin &&
        ["https:", "http:"].includes(url.protocol))
    )
      return url.href;
  } catch {
    /* Invalid or unsafe resource URL. */
  }
  throw new MineruError("Unsafe MinerU resource URL", "mineru-invalid-output");
}
function asBytes(value: MineruResponse["body"]): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}
/** Raw binary PUT: Zotero.HTTP would inject a form Content-Type and break OSS signatures. */
export function requestMineruPut(
  request: MineruRequest,
  cancel: MineruCancelState,
): Promise<MineruResponse> {
  return new Promise((resolve, reject) => {
    const XHR = ztoolkit.getGlobal("XMLHttpRequest");
    const xhr = new XHR();
    xhr.mozBackgroundRequest = true;
    let failure: Error | undefined;
    const abort = () => xhr.abort();
    const timer = setInterval(() => {
      if (cancel.isCancelled()) abort();
    }, 200);
    const finish = () => {
      clearInterval(timer);
      cancel.signal?.removeEventListener("abort", abort);
    };
    xhr.onload = () => {
      finish();
      try {
        checkCancelled(cancel);
        const body =
          request.responseType === "arraybuffer"
            ? (xhr.response as ArrayBuffer)
            : String(xhr.responseText ?? "");
        if (asBytes(body).byteLength > request.maxBytes)
          throw new MineruError(
            "MinerU response exceeds size limit",
            "mineru-too-large",
          );
        resolve({
          status: xhr.status,
          body,
          finalUrl: xhr.responseURL || request.url,
        });
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => {
      finish();
      reject(
        new MineruError("MinerU upload network failure", "mineru-network"),
      );
    };
    xhr.ontimeout = () => {
      finish();
      reject(new MineruError("MinerU upload timeout", "mineru-timeout"));
    };
    xhr.onabort = () => {
      finish();
      reject(
        failure ||
          new MineruError(
            "MinerU upload cancelled",
            cancel.isCancelled() ? "cancelled" : "mineru-network",
          ),
      );
    };
    xhr.onprogress = (event) => {
      const p = event as ProgressEvent;
      if (
        p.loaded > request.maxBytes ||
        (p.lengthComputable && p.total > request.maxBytes)
      ) {
        failure = new MineruError(
          "MinerU response exceeds size limit",
          "mineru-too-large",
        );
        abort();
      }
    };
    try {
      xhr.open("PUT", request.url, true);
      // Gecko's channel redirect limit is the raw-XHR equivalent of followRedirects:false.
      const channel = xhr.channel?.QueryInterface?.(Ci.nsIHttpChannel);
      if (channel) channel.redirectionLimit = 0;
      xhr.timeout = request.timeoutMs;
      xhr.responseType = request.responseType;
      for (const [name, value] of Object.entries(request.headers || {}))
        if (name.toLowerCase() !== "content-type")
          xhr.setRequestHeader(name, value);
      cancel.signal?.addEventListener("abort", abort, { once: true });
      checkCancelled(cancel);
      xhr.send(request.body);
    } catch (error) {
      finish();
      reject(error);
    }
  });
}
const defaultTransport: MineruTransport = {
  async request(request, cancel) {
    checkCancelled(cancel);
    if (request.method === "PUT") return requestMineruPut(request, cancel);
    let abortRequest: (() => void) | undefined;
    const abort = () => abortRequest?.();
    const timer = setInterval(() => {
      if (cancel.isCancelled()) abort();
    }, 200);
    cancel.signal?.addEventListener("abort", abort, { once: true });
    try {
      const xhr = await Zotero.HTTP.request(request.method, request.url, {
        headers: request.headers,
        body: request.body,
        responseType: request.responseType,
        // API credentials never follow redirects; unsigned CDN downloads may redirect safely.
        followRedirects: !Object.keys(request.headers || {}).some(
          (name) => name.toLowerCase() === "authorization",
        ),
        successCodes: false,
        errorDelayMax: 0,
        timeout: request.timeoutMs,
        cancellerReceiver: (fn: () => void) => {
          abortRequest = fn;
          if (cancel.isCancelled()) fn();
        },
        requestObserver: (xhr: XMLHttpRequest) => {
          xhr.addEventListener("progress", (event) => {
            const progress = event as ProgressEvent;
            if (
              progress.loaded > request.maxBytes ||
              (progress.lengthComputable && progress.total > request.maxBytes)
            )
              xhr.abort();
          });
        },
      });
      checkCancelled(cancel);
      const body =
        request.responseType === "arraybuffer"
          ? (xhr.response as ArrayBuffer)
          : String(xhr.responseText ?? "");
      if (asBytes(body).byteLength > request.maxBytes)
        throw new MineruError(
          "MinerU response exceeds size limit",
          "mineru-too-large",
        );
      return {
        status: xhr.status,
        body,
        finalUrl: xhr.responseURL || request.url,
      };
    } finally {
      clearInterval(timer);
      cancel.signal?.removeEventListener("abort", abort);
    }
  },
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function businessResponse(response: MineruResponse): Record<string, unknown> {
  if (response.status === 401 || response.status === 403)
    throw new MineruError("MinerU rejected the API key", "mineru-bad-token");
  if (response.status < 200 || response.status >= 300)
    throw new MineruError("MinerU HTTP " + response.status);
  let envelope: Record<string, unknown>;
  try {
    envelope = record(
      JSON.parse(
        typeof response.body === "string"
          ? response.body
          : new TextDecoder().decode(asBytes(response.body)),
      ),
    );
  } catch {
    throw new MineruError(
      "MinerU returned invalid JSON",
      "mineru-invalid-output",
    );
  }
  if (String(envelope.code) !== "0")
    throw new MineruError(
      String(envelope.msg ?? envelope.message ?? "MinerU API error").slice(
        0,
        300,
      ),
    );
  return record(envelope.data);
}
async function requestChecked(
  transport: MineruTransport,
  request: MineruRequest,
  cancel: MineruCancelState,
): Promise<MineruResponse> {
  checkCancelled(cancel);
  const response = await transport.request(request, cancel);
  checkCancelled(cancel);
  if (
    response.finalUrl &&
    Object.keys(request.headers || {}).some(
      (name) => name.toLowerCase() === "authorization",
    ) &&
    new URL(response.finalUrl).href !== new URL(request.url).href
  )
    throw new MineruError("MinerU redirect refused", "mineru-network");
  if (
    response.finalUrl &&
    !Object.keys(request.headers || {}).some(
      (name) => name.toLowerCase() === "authorization",
    )
  )
    safeResourceUrl(
      response.finalUrl,
      request.url,
      new URL(request.url).protocol === "http:",
    );
  if (response.status >= 300 && response.status < 400)
    throw new MineruError("MinerU redirect refused", "mineru-network");
  if (asBytes(response.body).byteLength > request.maxBytes)
    throw new MineruError(
      "MinerU response exceeds size limit",
      "mineru-too-large",
    );
  return response;
}
function progress(
  options: ParseOptions,
  event: Parameters<NonNullable<ParseOptions["onProgress"]>>[0],
): void {
  try {
    options.onProgress?.(event);
  } catch {
    /* UI listeners cannot stop parsing. */
  }
}

/** Bounded raw-deflate stream, shared by browser/Gecko/Node tests. */
async function inflateRaw(
  bytes: Uint8Array,
  expected: number,
): Promise<Uint8Array> {
  type StreamConstructor = new (format: string) => {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  const scope = globalThis as unknown as {
    DecompressionStream?: StreamConstructor;
  };
  const ctor =
    scope.DecompressionStream ??
    (typeof ztoolkit !== "undefined"
      ? (ztoolkit.getGlobal(
          "DecompressionStream" as never,
        ) as unknown as StreamConstructor)
      : undefined);
  if (!ctor)
    throw new MineruError(
      "Raw deflate is not available in this Zotero version",
      "mineru-invalid-output",
    );
  const stream = new ctor("deflate-raw");
  const writer = stream.writable.getWriter();
  const writing = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();
  // Observe write rejection even when reading fails first.
  void writing.catch(() => {});
  // Gecko declarations also expose the BYOB overload; this is the default reader.
  const reader =
    stream.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > expected || length > MAX_ENTRY_BYTES)
        throw new MineruError(
          "ZIP expansion exceeds limit",
          "mineru-too-large",
        );
      chunks.push(next.value);
    }
    await writing;
  } catch (error) {
    await reader.cancel(undefined).catch(() => {});
    await writer.abort().catch(() => {});
    throw error;
  }
  if (length !== expected)
    throw new MineruError(
      "ZIP uncompressed size mismatch",
      "mineru-invalid-output",
    );
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export function zipPathIsSafe(name: string): boolean {
  return (
    Boolean(name) &&
    !name.includes("\\") &&
    !Array.from(name).some((char) => char.charCodeAt(0) < 32) &&
    !name.startsWith("/") &&
    !/^[a-z]:/i.test(name) &&
    !name
      .split("/")
      .some((part) => part === ".." || part === "." || part.includes(":"))
  );
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Parse the ZIP central directory, reject ZIP64/encryption/symlinks and bound all expansion. */
export async function readMineruZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (bytes.byteLength > MAX_MINERU_ZIP_BYTES || bytes.byteLength < 22)
    throw new MineruError("Invalid ZIP size", "mineru-invalid-output");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new MineruError("Invalid or multi-disk ZIP", "mineru-invalid-output");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (
    count > MAX_MINERU_ENTRIES ||
    count === 65535 ||
    count !== view.getUint16(end + 8, true) ||
    offset + directorySize !== end
  )
    throw new MineruError("ZIP directory exceeds limits", "mineru-too-large");
  const directoryStart = offset;
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      throw new MineruError("Malformed ZIP directory", "mineru-invalid-output");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const disk = view.getUint16(offset + 34, true);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    const local = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      disk ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      size === 0xffffffff ||
      compressed === 0xffffffff ||
      (mode & 0xf000) === 0xa000
    )
      throw new MineruError("Unsupported ZIP entry", "mineru-invalid-output");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (!zipPathIsSafe(name) || names.has(name.toLowerCase()))
      throw new MineruError(
        "Unsafe or duplicate ZIP path",
        "mineru-invalid-output",
      );
    names.add(name.toLowerCase());
    total += size;
    if (size > MAX_ENTRY_BYTES || total > MAX_MINERU_ZIP_BYTES)
      throw new MineruError("ZIP expansion exceeds limit", "mineru-too-large");
    if (
      local + 30 > directoryStart ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint16(local + 6, true) !== flags
    )
      throw new MineruError(
        "Malformed local ZIP entry",
        "mineru-invalid-output",
      );
    const localNameLength = view.getUint16(local + 26, true);
    const dataOffset =
      local + 30 + localNameLength + view.getUint16(local + 28, true);
    if (
      dataOffset + compressed > directoryStart ||
      new TextDecoder().decode(
        bytes.subarray(local + 30, local + 30 + localNameLength),
      ) !== name
    )
      throw new MineruError(
        "ZIP local entry mismatch",
        "mineru-invalid-output",
      );
    // Validate every name/size, but only expand Markdown, images and layout JSON.
    if (
      !name.endsWith("/") &&
      (/\.md$/i.test(name) ||
        /^images\//i.test(name) ||
        /(?:^|\/)(?:[^/]*content_list|middle_json|[^/]*middle|layout)\.json$/i.test(
          name,
        ))
    ) {
      const data = bytes.subarray(dataOffset, dataOffset + compressed);
      const content =
        method === 0 ? data.slice() : await inflateRaw(data, size);
      if (content.length !== size || crc32(content) !== checksum)
        throw new MineruError("ZIP checksum mismatch", "mineru-invalid-output");
      entries.push({ name, bytes: content });
    }
    offset = next;
  }
  if (offset !== end)
    throw new MineruError(
      "ZIP directory length mismatch",
      "mineru-invalid-output",
    );
  return entries;
}
export function mineruZipBody(entries: ZipEntry[]): {
  markdown: string;
  assets: BodyAsset[];
  blocks: BlockLoc[];
} {
  if (entries.length > MAX_MINERU_ENTRIES)
    throw new MineruError("Too many ZIP files", "mineru-too-large");
  let total = 0;
  for (const entry of entries) {
    if (!zipPathIsSafe(entry.name))
      throw new MineruError("Unsafe ZIP path", "mineru-invalid-output");
    total += entry.bytes.length;
    if (entry.bytes.length > MAX_ENTRY_BYTES || total > MAX_MINERU_ZIP_BYTES)
      throw new MineruError("ZIP expansion exceeds limit", "mineru-too-large");
  }
  const main =
    entries.find((entry) => entry.name.toLowerCase() === "full.md") ??
    entries.find(
      (entry) => !entry.name.includes("/") && /\.md$/i.test(entry.name),
    );
  if (!main)
    throw new MineruError(
      "MinerU ZIP has no root Markdown file",
      "mineru-invalid-output",
    );
  let markdown = new TextDecoder("utf-8", { fatal: true })
    .decode(main.bytes)
    .replace(/^\uFEFF/, "");
  const assets: BodyAsset[] = [];
  const used = new Set<string>();
  const assetBySource = new Map<string, string>();
  for (const entry of entries) {
    if (!/^images\//i.test(entry.name)) continue;
    let target = hostedImageFilename(entry.name);
    if (!target || entry.bytes.length > MAX_IMAGE_BYTES) continue;
    if (used.has(target.toLowerCase())) {
      const split = target.lastIndexOf(".");
      target =
        target.slice(0, split) + "-" + assets.length + target.slice(split);
    }
    used.add(target.toLowerCase());
    const mime = sniffImageMime(entry.bytes);
    if (!mime) continue;
    assets.push({ kind: "figure", filename: target, mime, bytes: entry.bytes });
    const encoded = entry.name
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    for (const from of new Set([
      entry.name,
      "./" + entry.name,
      encoded,
      "./" + encoded,
    ])) {
      assetBySource.set(from, target);
      markdown = markdown
        .split("](" + from + ")")
        .join("](" + target + ")")
        .split("](<" + from + ">)")
        .join("](<" + target + ">)");
      markdown = markdown
        .split('src="' + from + '"')
        .join('src="' + target + '"')
        .split("src='" + from + "'")
        .join("src='" + target + "'");
    }
  }
  const blocks = parseMineruBlocks(entries, markdown, assetBySource);
  return { markdown, assets, blocks };
}

const MINERU_SKIP_TYPES = new Set([
  "discarded",
  "header",
  "page_header",
  "footer",
  "page_footer",
  "page_number",
  "page_footnote",
]);

function mapMineruBlockType(
  rawType: string,
  textLevel?: number,
): BlockType | undefined {
  const lower = rawType.trim().toLowerCase();
  if (!lower || MINERU_SKIP_TYPES.has(lower)) return undefined;
  if (lower === "title" || lower === "heading") return "heading";
  if (lower === "text" || lower === "paragraph") {
    return typeof textLevel === "number" && textLevel > 0
      ? "heading"
      : "paragraph";
  }
  if (
    lower === "equation" ||
    lower === "interline_equation" ||
    lower === "formula"
  ) {
    return "equation";
  }
  if (lower === "image" || lower === "figure" || lower === "chart") {
    return "image";
  }
  if (lower === "table") return "table";
  if (
    lower === "image_caption" ||
    lower === "table_caption" ||
    lower === "chart_caption" ||
    lower === "caption"
  ) {
    return "caption";
  }
  if (lower === "list") return "list";
  if (lower === "code" || lower === "algorithm") return "preformatted";
  if (lower === "blockquote") return "blockquote";
  if (lower === "footnote" || lower === "note") return "note";
  return "paragraph";
}

function mineruText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => mineruText(part))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if ("content" in rec) return mineruText(rec.content);
    if ("text" in rec) return mineruText(rec.text);
  }
  return "";
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeMineruBox(
  bbox: unknown,
  scale: 1000 | 1,
): [number, number, number, number] | undefined {
  if (!Array.isArray(bbox) || bbox.length !== 4) return undefined;
  const nums = bbox.map((v) => (typeof v === "number" ? v : Number(v)));
  if (!nums.every((n) => Number.isFinite(n))) return undefined;
  const divisor = scale === 1000 && nums.some((n) => n > 1.001) ? 1000 : 1;
  const x1 = clampUnit(Math.min(nums[0], nums[2]) / divisor);
  const y1 = clampUnit(Math.min(nums[1], nums[3]) / divisor);
  const x2 = clampUnit(Math.max(nums[0], nums[2]) / divisor);
  const y2 = clampUnit(Math.max(nums[1], nums[3]) / divisor);
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : undefined;
}

function resolveMineruAsset(
  imgPath: unknown,
  assetBySource: Map<string, string>,
): string | undefined {
  if (typeof imgPath !== "string" || !imgPath.trim()) return undefined;
  const raw = imgPath.trim().replace(/\\/g, "/");
  const stripped = raw.replace(/^\.\//, "");
  return (
    assetBySource.get(raw) ??
    assetBySource.get(stripped) ??
    assetBySource.get("./" + stripped)
  );
}

function parseJsonEntry(entry: ZipEntry | undefined): unknown {
  if (!entry) return undefined;
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true })
        .decode(entry.bytes)
        .replace(/^\uFEFF/, ""),
    );
  } catch {
    return undefined;
  }
}

function locateBlockOffsets(
  markdown: string,
  candidates: string[],
  cursor: number,
): { start: number; end: number; nextCursor: number } {
  for (const raw of candidates) {
    const needle = raw.trim();
    if (!needle) continue;
    const found = markdown.indexOf(needle, Math.max(0, cursor));
    if (found >= 0) {
      return {
        start: found,
        end: found + needle.length,
        nextCursor: found + needle.length,
      };
    }
    const earlier = markdown.indexOf(needle);
    if (earlier >= 0) {
      return {
        start: earlier,
        end: earlier + needle.length,
        nextCursor: Math.max(cursor, earlier + needle.length),
      };
    }
  }
  return { start: cursor, end: cursor, nextCursor: cursor };
}

function parseMineruBlocks(
  entries: ZipEntry[],
  markdown: string,
  assetBySource: Map<string, string>,
): BlockLoc[] {
  const contentListEntry =
    entries.find((e) => /(?:^|\/)[^/]*content_list\.json$/i.test(e.name)) ??
    entries.find((e) => /(?:^|\/)content_list\.json$/i.test(e.name));
  const contentList = parseJsonEntry(contentListEntry);
  if (Array.isArray(contentList) && contentList.length) {
    return parseMineruContentList(contentList, markdown, assetBySource);
  }
  const middleEntry = entries.find((e) =>
    /(?:^|\/)middle_json\.json$/i.test(e.name),
  );
  const middle = parseJsonEntry(middleEntry);
  if (middle && typeof middle === "object" && !Array.isArray(middle)) {
    return parseMineruDocvortex(
      middle as Record<string, unknown>,
      markdown,
      assetBySource,
    );
  }
  return [];
}

function parseMineruContentList(
  items: unknown[],
  markdown: string,
  assetBySource: Map<string, string>,
): BlockLoc[] {
  const blocks: BlockLoc[] = [];
  let cursor = 0;
  for (const raw of items) {
    const item = record(raw);
    const rawType = typeof item.type === "string" ? item.type : "";
    const textLevel =
      typeof item.text_level === "number" ? item.text_level : undefined;
    const type = mapMineruBlockType(rawType, textLevel);
    if (!type) continue;
    const pageIndex = Number(item.page_idx);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) continue;
    const box = normalizeMineruBox(item.bbox, 1000);
    const assetPath = resolveMineruAsset(item.img_path, assetBySource);
    const caption =
      mineruText(item.image_caption) ||
      mineruText(item.table_caption) ||
      mineruText(item.chart_caption);
    let text =
      mineruText(item.text) ||
      mineruText(item.content) ||
      mineruText(item.table_body);
    if (type === "equation" && text && !text.includes("$")) {
      text = `$$\n${text}\n$$`;
    }
    if (!text && !box && !assetPath && !caption) continue;
    const searchCandidates: string[] = [];
    if (text) {
      searchCandidates.push(text);
      if (type === "equation") {
        searchCandidates.push(text.replace(/^\$\$|\$\$$/g, "").trim());
      }
    }
    if (assetPath) searchCandidates.push(assetPath);
    if (caption) searchCandidates.push(caption);
    const { start, end, nextCursor } = locateBlockOffsets(
      markdown,
      searchCandidates,
      cursor,
    );
    cursor = nextCursor;
    blocks.push({
      type,
      pageIndex,
      ...(box
        ? {
            pageRects: [[pageIndex, ...box]],
            pageRectsSpace: "page-fraction" as const,
          }
        : {}),
      ...(text ? { text } : {}),
      ...(assetPath ? { assetPath } : {}),
      ...(caption ? { caption } : {}),
      mdStart: start,
      mdEnd: Math.max(start, end),
    });
  }
  return blocks;
}

function parseMineruDocvortex(
  middle: Record<string, unknown>,
  markdown: string,
  assetBySource: Map<string, string>,
): BlockLoc[] {
  const pages = Array.isArray(middle.pages) ? middle.pages : [];
  const blocks: BlockLoc[] = [];
  let cursor = 0;
  for (const rawPage of pages) {
    const page = record(rawPage);
    const pageIndex = Number(page.page_idx);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) continue;
    const rawBlocks = Array.isArray(page.blocks) ? page.blocks : [];
    for (const rawBlock of rawBlocks) {
      const block = record(rawBlock);
      const rawType = typeof block.type === "string" ? block.type : "";
      const level = typeof block.level === "number" ? block.level : undefined;
      const type = mapMineruBlockType(rawType, level);
      if (!type) continue;
      const box = normalizeMineruBox(block.bbox, 1);
      const text = mineruText(block.content);
      const assetPath = resolveMineruAsset(
        block.img_path ?? block.image_path,
        assetBySource,
      );
      if (!text && !box && !assetPath) continue;
      const { start, end, nextCursor } = locateBlockOffsets(
        markdown,
        [text, assetPath || ""].filter(Boolean),
        cursor,
      );
      cursor = nextCursor;
      blocks.push({
        type,
        pageIndex,
        ...(box
          ? {
              pageRects: [[pageIndex, ...box]],
              pageRectsSpace: "page-fraction" as const,
            }
          : {}),
        ...(text ? { text } : {}),
        ...(assetPath ? { assetPath } : {}),
        mdStart: start,
        mdEnd: Math.max(start, end),
      });
    }
  }
  return blocks;
}

export async function runMineruBodyForTests(
  input: BodySourceInput,
  options: ParseOptions,
  deps: MineruDeps = {},
): Promise<ParseOutcome> {
  const config = deps.config ?? readSettings().mineru;
  const endpoint = normalizeMineruEndpoint(config.endpoint, config.selfHosted);
  const token = (options.apiKey ?? deps.token ?? readMineruToken()).trim();
  if (!endpoint || (!config.selfHosted && !token))
    return {
      ok: false,
      status: "waiting-config",
      reason: "mineru-not-configured",
      detail: "Configure MinerU endpoint and API key.",
    };
  const transport = deps.transport ?? defaultTransport;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cancel: MineruCancelState = {
    isCancelled: () =>
      Boolean(options.isCancelled?.() || options.cancelSignal?.aborted),
    signal: options.cancelSignal,
  };
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(token ? { Authorization: "Bearer " + token } : {}),
  };
  const api = async (method: "GET" | "POST", path: string, body?: string) =>
    businessResponse(
      await requestChecked(
        transport,
        {
          method,
          url: endpoint + path,
          headers: {
            ...headers,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body,
          responseType: "text",
          timeoutMs: 60_000,
          maxBytes: 4 * 1024 * 1024,
        },
        cancel,
      ),
    );
  try {
    checkCancelled(cancel);
    let jobId = options.resumeJobId?.trim() || "";
    let uploadedAt = 0;
    if (!jobId) {
      progress(options, { stage: "uploading" });
      const bytes = await (deps.readPdf ?? ((path) => io().read(path)))(
        input.pdfPath,
      );
      assertUploadablePdf(bytes);
      const data = await api(
        "POST",
        "/api/v4/file-urls/batch",
        JSON.stringify({
          files: [
            {
              name: input.fingerprint.filename,
              is_ocr: config.isOcr,
              data_id: input.fingerprint.attachmentKey,
            },
          ],
          model_version: config.modelVersion,
          language: config.language,
          enable_formula: true,
          enable_table: true,
        }),
      );
      jobId = typeof data.batch_id === "string" ? data.batch_id : "";
      const uploadUrl =
        Array.isArray(data.file_urls) && typeof data.file_urls[0] === "string"
          ? data.file_urls[0]
          : "";
      if (!jobId || !uploadUrl)
        throw new MineruError(
          "MinerU returned no batch id/upload URL",
          "mineru-invalid-output",
        );
      const upload = await requestChecked(
        transport,
        {
          method: "PUT",
          url: safeResourceUrl(uploadUrl, endpoint, config.selfHosted),
          body: bytes,
          responseType: "text",
          timeoutMs: 180_000,
          maxBytes: 1024 * 1024,
        },
        cancel,
      );
      if (upload.status < 200 || upload.status >= 300)
        throw new MineruError(
          "MinerU upload HTTP " + upload.status,
          "mineru-network",
        );
      uploadedAt = now();
    }
    const remote: RemoteInfo = {
      provider: "mineru",
      host: new URL(endpoint).host,
      uploadedAt,
      jobId,
      modelVersion: config.modelVersion,
    };
    if (!options.resumeJobId) {
      try {
        options.onSubmitted?.(remote);
      } catch {
        /* Listener errors do not discard the accepted job. */
      }
    }
    let fullZipUrl = "";
    let pages = input.fingerprint.pageCount;
    let extractedPages = 0;
    const started = now();
    for (
      let attempts = 0;
      attempts < 600 && now() - started <= MAX_POLL_MS;
      attempts++
    ) {
      checkCancelled(cancel);
      const data = await api(
        "GET",
        "/api/v4/extract-results/batch/" + encodeURIComponent(jobId),
      );
      const result = record(
        Array.isArray(data.extract_result) ? data.extract_result[0] : undefined,
      );
      const p = record(result.extract_progress);
      const total = Number(p.total_pages);
      const done = Number(p.extracted_pages);
      if (Number.isFinite(total) && total > 0) pages = Math.max(pages, total);
      if (Number.isFinite(done) && done >= 0) extractedPages = done;
      progress(options, {
        stage: "polling",
        ...(pages > 0
          ? {
              page: extractedPages,
              pages,
              percent: Math.min(100, (100 * extractedPages) / pages),
            }
          : {}),
      });
      const state = String(result.state ?? "").toLowerCase();
      if (state === "failed")
        throw new MineruError(
          String(result.err_msg ?? "MinerU extraction failed").slice(0, 300),
        );
      if (state === "done" || state === "completed") {
        fullZipUrl = String(result.full_zip_url ?? "");
        if (!fullZipUrl)
          throw new MineruError(
            "MinerU returned no result ZIP",
            "mineru-invalid-output",
          );
        break;
      }
      if (
        state &&
        ![
          "pending",
          "running",
          "waiting-file",
          "converting",
          "waiting",
          "queued",
        ].includes(state)
      )
        throw new MineruError(
          "Unknown MinerU task state: " + state,
          "mineru-invalid-output",
        );
      await sleep(3000);
    }
    if (!fullZipUrl)
      throw new MineruError("MinerU task timed out", "mineru-timeout");
    progress(options, { stage: "downloading" });
    const response = await requestChecked(
      transport,
      {
        method: "GET",
        url: safeResourceUrl(fullZipUrl, endpoint, config.selfHosted),
        responseType: "arraybuffer",
        timeoutMs: 180_000,
        maxBytes: MAX_MINERU_ZIP_BYTES,
      },
      cancel,
    );
    if (response.status < 200 || response.status >= 300)
      throw new MineruError(
        "MinerU ZIP download HTTP " + response.status,
        "mineru-network",
      );
    progress(options, { stage: "converting" });
    const converted = mineruZipBody(
      await (deps.unzip ?? readMineruZip)(asBytes(response.body)),
    );
    checkCancelled(cancel);
    const count = Math.max(1, pages);
    const parsedPages =
      extractedPages > 0 ? Math.min(count, extractedPages) : count;
    const textChars = converted.markdown.replace(/\s/g, "").length;
    const judgement = judgeQuality({
      parserId: "mineru-cloud",
      textChars,
      totalPages: count,
      parsedPages,
      emptyPages: 0,
      unverifiedBlockPages: 0,
      structuralPages: 0,
      tablesPreserved: /\|.*\|/.test(converted.markdown),
      equationsLatex: converted.markdown.includes("$"),
      hasImages: converted.assets.length > 0,
      assetsDeclared: converted.assets.length,
      assetsResolved: converted.assets.length,
      truncated: false,
    });
    if (
      !converted.markdown.trim() ||
      judgement.status === "failed" ||
      judgement.status === "needs-parser"
    )
      return {
        ok: false,
        status: "needs-parser",
        reason: "mineru-no-output",
        detail: "MinerU returned empty Markdown",
      };
    return {
      ok: true,
      status: judgement.status,
      body: {
        markdown: converted.markdown,
        assets: converted.assets,
        blocks: converted.blocks,
        source: { ...input.fingerprint, pageCount: pages },
        parserId: "mineru-cloud",
        processorVersion: config.modelVersion,
        converterVersion: CONVERTER_VERSION,
        quality: judgement.quality,
        warnings: judgement.quality.caveats,
        generatedAt: new Date(now()).toISOString(),
        remote,
      },
    };
  } catch (error) {
    if (cancel.isCancelled())
      return {
        ok: false,
        status: "failed",
        reason: "cancelled",
        detail: "cancelled",
      };
    // Network libraries may include presigned URLs and headers in exceptions. Do not persist them.
    return {
      ok: false,
      status: "failed",
      reason: error instanceof MineruError ? error.reason : "mineru-network",
      detail:
        error instanceof MineruError
          ? error.message
          : "MinerU request or ZIP decoding failed",
    };
  }
}
export const mineruSource: BodySource = {
  id: "mineru-cloud",
  label: "MinerU",
  isRemote: () => true,
  available: async () => true,
  parse: (input, options) => runMineruBodyForTests(input, options),
};
export async function initMineruCloud(): Promise<void> {
  registerBodySource(mineruSource);
}
/** Unknown-batch status probe: no PDF upload or extraction job creation. */
export async function testMineruConnection(
  deps: MineruDeps = {},
): Promise<MineruTestResult> {
  const config = deps.config ?? readSettings().mineru;
  const endpoint = normalizeMineruEndpoint(config.endpoint, config.selfHosted);
  const token = (deps.token ?? readMineruToken()).trim();
  if (!endpoint) return { ok: false, detail: "bad-endpoint" };
  if (!token && !config.selfHosted) return { ok: false, detail: "no-token" };
  try {
    const response = await requestChecked(
      deps.transport ?? defaultTransport,
      {
        method: "GET",
        url:
          endpoint +
          "/api/v4/extract-results/batch/00000000-0000-4000-8000-000000000000",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        responseType: "text",
        timeoutMs: 20_000,
        maxBytes: 1024 * 1024,
      },
      { isCancelled: () => false },
    );
    if ([401, 403].includes(response.status))
      return { ok: false, detail: "bad-token" };
    if (response.status === 429) return { ok: false, detail: "rate-limited" };
    if (response.status >= 500) return { ok: false, detail: "api-error" };
    if (response.status >= 200 && response.status < 300) {
      const body = record(
        JSON.parse(
          typeof response.body === "string"
            ? response.body
            : new TextDecoder().decode(asBytes(response.body)),
        ),
      );
      const message = String(body.msg ?? body.message ?? "");
      if (/token|unauthori[sz]ed|auth.*fail|令牌|鉴权/i.test(message))
        return { ok: false, detail: "bad-token" };
      if (
        "code" in body &&
        (String(body.code) === "0" || /batch|not.?found|不存在/i.test(message))
      )
        return { ok: true, detail: "ok" };
    }
    return { ok: false, detail: "bad-endpoint" };
  } catch {
    return { ok: false, detail: "network" };
  }
}

/**
 * PaddleOCR cloud transport helpers that must not touch Zotero globals:
 * multipart body building, result URL safety, asset planning and limits.
 *
 * The provider returns Markdown plus per-image download URLs (presigned object
 * storage). The JSONL and image requests are deliberately built without an
 * Authorization header; only the API host may ever see the token. Everything
 * that leaves the API origin is treated as untrusted input.
 */
import type { BodyAsset, CaveatCode } from "./types";

/** Glossa's local upload guard, NOT an official PaddleOCR service limit. */
export const LOCAL_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** A Paddle JSONL result larger than this is not a usable document body. */
export const MAX_JSONL_BYTES = 64 * 1024 * 1024;
/** Matches the hosted-body defaults in assets.ts. */
export const MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_ASSET_COUNT = 500;

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
]);

export type PaddlePayloadReason =
  | "paddle-no-output"
  | "paddle-invalid-output"
  | "paddle-too-large"
  | "paddle-unsupported-pdf";

/** A response/document shape Glossa refuses to turn into a body. */
export class PaddlePayloadError extends Error {
  constructor(
    readonly reason: PaddlePayloadReason,
    message: string,
  ) {
    super(message);
    this.name = "PaddlePayloadError";
  }
}

export type ImageResource = {
  /** Provider key, e.g. `imgs/img_in_image_box_1_2_3_4.jpg`. */
  key: string;
  /** Presigned download URL. Never sent the API token. */
  url: string;
  /** Hosted relative filename, e.g. `images/img_in_image_box_1_2_3_4.jpg`. */
  filename: string;
  mime: string;
  pageIndex: number;
};

export type ImageResourcePlan = {
  resources: ImageResource[];
  /** Every image key the Markdown declared (including skipped ones). */
  declared: number;
  warnings: CaveatCode[];
};

export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

export function assertUploadablePdf(bytes: Uint8Array) {
  if (bytes.byteLength > LOCAL_MAX_UPLOAD_BYTES) {
    throw new PaddlePayloadError(
      "paddle-too-large",
      `PDF is ${bytes.byteLength} bytes; Glossa refuses files over ${LOCAL_MAX_UPLOAD_BYTES} bytes`,
    );
  }
  if (!looksLikePdf(bytes)) {
    throw new PaddlePayloadError(
      "paddle-unsupported-pdf",
      "Attachment is not a PDF file",
    );
  }
}

/** Reject paths/URLs that could read local files or hit internal hosts. */
export function isSafeHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!url.hostname || url.username || url.password) return false;
  if (isLocalOrPrivateHost(url.hostname)) return false;
  return true;
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(":")) {
    // IPv6: loopback, unspecified, unique-local (fc00::/7), link-local.
    const prefix = host.slice(0, 2);
    if (host === "::1" || host === "::") return true;
    if (prefix === "fc" || prefix === "fd" || prefix === "fe") return true;
  }
  return false;
}

/**
 * Hosted asset name for one provider image key. The converter rewrites
 * Markdown references by basename to the same `images/<basename>` path, so the
 * basename must be preserved (only unsafe characters are replaced).
 */
export function hostedImageFilename(key: string): string | undefined {
  const raw = key.trim();
  if (!raw || /^(?:data:|blob:|javascript:)/i.test(raw)) return undefined;
  let candidate = raw;
  try {
    if (/^https?:/i.test(raw)) {
      candidate = new URL(raw).pathname;
    } else {
      candidate = decodeURIComponent(raw);
    }
  } catch {
    // Keep the raw key when it is not valid percent-encoding.
  }
  const basename = candidate
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .pop();
  if (!basename) return undefined;
  const dot = basename.lastIndexOf(".");
  const extension = dot >= 0 ? basename.slice(dot).toLowerCase() : "";
  if (!IMAGE_EXTENSIONS.has(extension)) return undefined;
  const stem = basename.slice(0, dot).replace(/[^\w.-]/g, "_");
  if (!stem) return undefined;
  return `images/${stem.slice(0, 120)}${extension}`;
}

export function mimeFromImageFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

/**
 * Find the image resources declared by every page of the JSONL. The official
 * provider shape is `result.layoutParsingResults[].markdown.images` mapping a
 * relative key to a downloadable URL; malformed lines are ignored so one bad
 * page cannot hide the rest.
 */
export function planImageResources(
  jsonl: string,
  limits: { maxCount?: number } = {},
): ImageResourcePlan {
  if (new TextEncoder().encode(jsonl).byteLength > MAX_JSONL_BYTES) {
    throw new PaddlePayloadError(
      "paddle-too-large",
      "Paddle JSONL exceeds Glossa's parsing cap",
    );
  }
  const maxCount = limits.maxCount ?? MAX_ASSET_COUNT;
  const resources: ImageResource[] = [];
  const warnings = new Set<CaveatCode>();
  // Page-local names: two pages may both call a figure `fig1.jpg`. The second
  // page gets a `p<page>-` prefix so the converter can match assets by page
  // without overwriting one image with another.
  const used = new Map<string, number>();
  let declared = 0;
  let pageIndex = 0;

  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const result = asRecord(asRecord(parsed)?.result) || asRecord(parsed);
    const pages = asArray(result?.layoutParsingResults);
    if (!pages) continue;
    for (const pageValue of pages) {
      const page = asRecord(pageValue);
      const markdown = asRecord(page?.markdown);
      const images = markdown?.images;
      for (const [key, payload] of imageEntries(images)) {
        declared += 1;
        if (typeof payload !== "string") {
          warnings.add("asset-not-embedded");
          continue;
        }
        if (/^(?:data:|blob:)/i.test(payload.trim())) {
          // Inline base64 is decoded by the converter, not downloaded here.
          continue;
        }
        if (!isSafeHttpsUrl(payload)) {
          warnings.add("asset-missing");
          continue;
        }
        const basename = hostedImageFilename(key);
        if (!basename) {
          warnings.add("asset-missing");
          continue;
        }
        let filename = basename;
        const owner = used.get(filename);
        if (owner !== undefined && owner !== pageIndex) {
          const name = basename.slice("images/".length);
          filename = `images/p${String(pageIndex + 1).padStart(3, "0")}-${name}`;
        }
        if (used.has(filename)) continue;
        if (resources.length >= maxCount) {
          warnings.add("asset-not-embedded");
          continue;
        }
        used.set(filename, pageIndex);
        resources.push({
          key,
          url: payload.trim(),
          filename,
          mime: mimeFromImageFilename(filename),
          pageIndex,
        });
      }
      pageIndex += 1;
    }
  }

  return { resources, declared, warnings: [...warnings] };
}

function imageEntries(value: unknown): Array<[string, unknown]> {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const record = asRecord(item);
      const key =
        asString(record?.name) ||
        asString(record?.filename) ||
        `images/image-${index + 1}.jpg`;
      const url = asString(record?.url) || asString(record?.image) || item;
      return [[key, url] as [string, unknown]];
    });
  }
  const record = asRecord(value);
  return record ? Object.entries(record) : [];
}

export type MultipartPart = {
  name: string;
  value: string;
};

/**
 * Build a multipart/form-data body without DOM APIs (plugin sandboxes do not
 * always expose FormData/Blob). The returned body is sent as a Uint8Array so
 * the PDF bytes are never turned into a string.
 */
export function buildMultipartBody(
  fields: MultipartPart[],
  file: { filename: string; mime: string; bytes: Uint8Array },
  boundary = `----GlossaPaddle${randomHex(16)}`,
): { body: Uint8Array; contentType: string } {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const line = (text: string) => chunks.push(encoder.encode(`${text}\r\n`));
  for (const field of fields) {
    line(`--${boundary}`);
    line(`Content-Disposition: form-data; name="${headerSafe(field.name)}"`);
    line("");
    line(field.value);
  }
  line(`--${boundary}`);
  line(
    `Content-Disposition: form-data; name="file"; filename="${headerSafe(
      file.filename,
    )}"`,
  );
  line(`Content-Type: ${file.mime}`);
  line("");
  chunks.push(file.bytes);
  line("");
  line(`--${boundary}--`);
  return {
    body: concatBytes(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function headerSafe(value: string): string {
  return value.replace(/[\r\n"]/g, "_").slice(0, 200) || "file";
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  const crypto =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: Crypto }).crypto
      : undefined;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.random() * 256;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Convert a downloaded resource into a BodyAsset with a size guard. */
export function toBodyAsset(
  resource: ImageResource,
  bytes: Uint8Array,
  mime?: string,
): BodyAsset {
  return {
    kind: "figure",
    pageIndex: resource.pageIndex,
    filename: resource.filename,
    mime: mime || resource.mime,
    bytes,
  };
}

/**
 * Sniff the image magic bytes. A presigned URL can return an HTML error page
 * with HTTP 200; saving that as a figure would make the quality grade lie.
 */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  const start = new TextDecoder().decode(bytes.slice(0, 6));
  if (start.startsWith("GIF8")) return "image/gif";
  if (
    start.startsWith("RIFF") &&
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return undefined;
}

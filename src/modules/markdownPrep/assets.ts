/**
 * Materialize a ParsedBody into a hosted body.md plus the relative resources
 * that must be written beside it in the Zotero attachment storage directory.
 *
 * Rules:
 * - Only relative links are rewritten/validated; http(s)/data:/zotero: links
 *   are left untouched.
 * - Every resolved asset becomes a HostedResource at the same relative path.
 * - Missing/oversized assets are replaced with explicit placeholders and a
 *   caveat; a dangling relative image link is never emitted.
 */
import {
  type BodyAsset,
  type CaveatCode,
  type HostedBodyOptions,
  type HostedBodyPlan,
  type HostedResource,
  type ParsedBody,
} from "./types";

const DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const IMAGE_LINK =
  /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/g;

export function planHostedBody(
  body: ParsedBody,
  options: HostedBodyOptions = {},
): HostedBodyPlan {
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  const maxTotalBytes = options.maxTotalAssetBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const available = new Map<string, { asset: BodyAsset; relative: string }>();
  for (const asset of body.assets) {
    const relative = safeRelativePath(asset.filename);
    if (!relative || available.has(relative)) continue;
    available.set(relative, { asset, relative });
  }
  const resources: HostedResource[] = [];
  const written = new Set<string>();
  const warnings = new Set<CaveatCode>();
  let resolved = 0;
  let placeholders = 0;
  let totalBytes = 0;

  type Resolution =
    | { kind: "external" }
    | { kind: "resolved"; relative: string }
    | { kind: "placeholder"; reference: string };

  const resolve = (href: string): Resolution => {
    if (!href) return { kind: "external" };
    if (/^data:image\//i.test(href)) return { kind: "external" };
    if (
      /^(?:https?:|zotero:|mailto:|\/\/)/i.test(href) ||
      href.startsWith("#")
    ) {
      return { kind: "external" };
    }
    if (/^(?:javascript|vbscript|file|data):/i.test(href)) {
      return { kind: "placeholder", reference: href };
    }
    const normalized = safeRelativePath(href);
    if (!normalized) return { kind: "placeholder", reference: href };
    // Exact path only. A basename match could belong to another page's figure
    // and must never be substituted here.
    const entry = available.get(normalized);
    if (entry && written.has(entry.relative))
      return { kind: "resolved", relative: entry.relative };
    if (!entry) {
      return { kind: "placeholder", reference: normalized };
    }
    const size = entry.asset.bytes.byteLength;
    if (size > maxAssetBytes || totalBytes + size > maxTotalBytes) {
      warnings.add("asset-not-embedded");
      return { kind: "placeholder", reference: entry.relative };
    }
    written.add(entry.relative);
    totalBytes += size;
    resources.push({
      relativePath: entry.relative,
      mime: entry.asset.mime || mimeFromFilename(entry.relative),
      bytes: entry.asset.bytes,
    });
    resolved += 1;
    return { kind: "resolved", relative: entry.relative };
  };

  let markdown = body.markdown.replace(
    IMAGE_LINK,
    (match, alt: string, angleHref?: string, plainHref?: string) => {
      const href = (angleHref || plainHref || "").trim();
      const outcome = resolve(href);
      if (outcome.kind === "external") return match;
      if (outcome.kind === "placeholder") {
        placeholders += 1;
        warnings.add("asset-missing");
        return placeholder(alt, outcome.reference);
      }
      return `![${alt}](${/[\s()]/.test(outcome.relative) ? `<${outcome.relative}>` : outcome.relative})`;
    },
  );

  // PaddleOCR-VL emits `<img src="imgs/...">`, and some adapters may keep the
  // HTML form. Convert resolved image tags to Markdown so the resource is
  // materialized; unresolved/unsafe tags become explicit placeholders.
  markdown = markdown.replace(
    /<img\b([^>]*)>/gi,
    (match, attributes: string) => {
      const src = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(attributes);
      if (!src) return match;
      const altMatch = /\balt\s*=\s*(["'])(.*?)\1/i.exec(attributes);
      const outcome = resolve(src[2].trim());
      if (outcome.kind === "external") return match;
      if (outcome.kind === "placeholder") {
        placeholders += 1;
        warnings.add("asset-missing");
        return placeholder(altMatch ? altMatch[2] : "image", outcome.reference);
      }
      return `![${altMatch ? altMatch[2] : "image"}](${outcome.relative})`;
    },
  );

  return {
    markdown,
    resources,
    resolved,
    placeholders,
    warnings: [...warnings],
  };
}

function placeholder(alt: string, reference: string): string {
  const label = (alt || "image").trim() || "image";
  const safeRef = reference.replace(/[[\]]/g, "").slice(0, 160);
  return `[Image: ${label} (${safeRef})]`;
}

/** Slash-separated path with no empty, "." or ".." segments. */
export function safeRelativePath(value: string): string | undefined {
  let decoded = value.trim();
  try {
    decoded = decodeURI(decoded);
  } catch {
    // Keep the raw value when it is not valid percent-encoding.
  }
  const normalized = decoded.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    return undefined;
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return undefined;
  }
  return parts.join("/");
}

export function mimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

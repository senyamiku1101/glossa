/**
 * Hosted body metadata + source fingerprint helpers. Pure except
 * `sourceFingerprintFromItem`, which is called from the queue and therefore
 * reads Zotero globals only at call time.
 */
import {
  BODY_SCHEMA_VERSION,
  type HostedBodyMeta,
  type SourceFingerprint,
} from "./types";

const META_PREFIX = "<!-- glossa-body ";
const META_SUFFIX = " -->";

/** Whole-file source hash used inside the metadata comment. */
export function bodySha1(value: string): string {
  return sha1Hex(utf8Bytes(value));
}

export function serializeBodyMeta(meta: HostedBodyMeta): string {
  const payload = {
    v: meta.v,
    sourceKey: meta.sourceKey,
    ...(meta.parentKey ? { parentKey: meta.parentKey } : {}),
    md5: meta.md5,
    size: meta.size,
    mtime: meta.mtime,
    pageCount: meta.pageCount,
    parser: meta.parser,
    ...(meta.modelVersion ? { modelVersion: meta.modelVersion } : {}),
    ...(meta.schemaVersion ? { schemaVersion: meta.schemaVersion } : {}),
    converterVersion: meta.converterVersion,
    configVersion: meta.configVersion,
    status: meta.status,
    quality: meta.quality,
    generatedAt: meta.generatedAt,
    assetMode: meta.assetMode,
    ...(meta.remote ? { remote: meta.remote } : {}),
    bodySha1: meta.bodySha1,
  };
  return `${META_PREFIX}${JSON.stringify(payload)}${META_SUFFIX}\n`;
}

/** Returns undefined when the first line is not a Glossa body comment. */
export function parseBodyMeta(markdown: string): HostedBodyMeta | undefined {
  const line = markdown.split(/\r?\n/, 1)[0] ?? "";
  const match = /^<!-- glossa-body (\{.*\}) -->$/.exec(line.trim());
  if (!match) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Partial<HostedBodyMeta>;
  if (
    value.v !== BODY_SCHEMA_VERSION ||
    typeof value.sourceKey !== "string" ||
    typeof value.md5 !== "string" ||
    typeof value.bodySha1 !== "string" ||
    !["paddleocr-cloud", "mineru-cloud"].includes(value.parser ?? "")
  ) {
    return undefined;
  }
  return value as HostedBodyMeta;
}

/** True when the stored body still belongs to this source file. */
export function fingerprintMatches(
  source: SourceFingerprint,
  actual: { md5: string; size: number; mtime: number },
): boolean {
  return (
    source.md5 === actual.md5 &&
    source.size === actual.size &&
    source.mtime === actual.mtime
  );
}

/**
 * Resolve the current PDF fingerprint. Returns undefined when the attachment
 * has no readable local file (linked-file missing, sync placeholder, deleted
 * file); the queue maps that to `waiting-file`. Other failures throw.
 */
export async function sourceFingerprintFromItem(
  attachment: Zotero.Item,
): Promise<SourceFingerprint | undefined> {
  const path = await attachment.getFilePathAsync();
  if (!path) return undefined;
  const ioUtils = ztoolkit.getGlobal("IOUtils") as typeof IOUtils;
  let stat: { size?: number; lastModified?: number };
  try {
    stat = await ioUtils.stat(path);
  } catch {
    return undefined;
  }
  let md5: string;
  try {
    md5 = String((await attachment.attachmentHash) || "");
  } catch {
    md5 = "";
  }
  if (!md5) {
    try {
      md5 = await Zotero.Utilities.Internal.md5Async(path);
    } catch (error) {
      throw new Error(`source hash unavailable: ${String(error)}`, {
        cause: error,
      });
    }
  }
  if (!md5) throw new Error("source hash unavailable");
  const parts = path.replace(/\\/g, "/").split("/");
  return {
    attachmentKey: attachment.key,
    parentKey: attachment.parentItemKey || undefined,
    libraryID: attachment.libraryID,
    filename: parts[parts.length - 1] || "paper.pdf",
    md5,
    size: stat.size || 0,
    mtime: stat.lastModified || 0,
    pageCount: 0,
  };
}

// ---- tiny SHA-1 (pure, no crypto.subtle/Node dependency) ----

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index++;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function sha1Hex(bytes: Uint8Array): string {
  const length = bytes.length;
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[length] = 0x80;
  const bitLength = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 80; index++) {
      const value =
        words[index - 3] ^
        words[index - 8] ^
        words[index - 14] ^
        words[index - 16];
      words[index] = (value << 1) | (value >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let index = 0; index < 80; index++) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

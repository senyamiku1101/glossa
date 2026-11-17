/** Native Zotero Markdown attachments; resources are flat for native ZIP sync. */
import { config } from "../../../package.json";
import { planHostedBody } from "./assets";
import {
  cacheEntryDirName,
  ensureDirectory,
  findAnyCacheEntry,
  isSafeRelativePath,
  loadCacheEntry,
  loadCacheIndex,
  pathExists,
  readText,
  saveCacheIndex,
  upsertCacheIndex,
  writeBytesAtomic,
  writeCacheEntry,
  writeTextAtomic,
  type CacheEntryMeta,
} from "./journal";
import { bodySha1, parseBodyMeta, serializeBodyMeta } from "./meta";
import { bodyStagingDir, paths } from "../../utils/paths";
import {
  BODY_SCHEMA_VERSION,
  CONVERTER_VERSION,
  type HostedBodyMeta,
  type HostedBodyPlan,
  type HostedResource,
  type ParsedBody,
  type PrepState,
  type SourceFingerprint,
} from "./types";
export const HOSTED_TITLE_PREFIX = "[Glossa] Body · ";
export const HOSTED_CONTENT_TYPE = "text/markdown";
const MAX_BODY_BYTES = 64 * 1024 * 1024,
  META_SCAN_BYTES = 64 * 1024,
  ASSET_VERSION_LENGTH = 16;
const BUNDLE_ASSET_PREFIX = "glossa-asset-";
const ASSET_RE = /^glossa-asset-[0-9a-f]{16}-\d{1,4}\.[a-z0-9]{1,8}$/;
export type HostedAttachmentRead = {
  attachment: Zotero.Item;
  meta: HostedBodyMeta;
  /** Body text without the first-line metadata comment. */
  markdown: string;
  userModified: boolean;
};

export type BundleWriteOptions = {
  status: "done" | "partial";
  configVersion: string;
  /** Explicit user choice: replace a body edited outside Glossa. */
  force?: boolean;
};
export function hostedTitleFor(pdfFilename: string): string {
  const name = String(pdfFilename || "paper.pdf").trim() || "paper.pdf";
  return `${HOSTED_TITLE_PREFIX}${name}`;
}

export function isHostedTitle(title: string | undefined): boolean {
  return Boolean(title && title.startsWith(HOSTED_TITLE_PREFIX));
}

/** Body after the first-line metadata comment. */
export function stripBodyMeta(text: string): string {
  const newline = text.indexOf("\n");
  return newline >= 0 ? text.slice(newline + 1) : "";
}

/** `relative` keeps real links; `placeholder` marks a body with no resources. */
export function hostedAssetMode(
  plan: HostedBodyPlan,
): "relative" | "placeholder" {
  return plan.resources.length > 0 || plan.placeholders === 0
    ? "relative"
    : "placeholder";
}

export type BuildHostedMetaInput = {
  source: SourceFingerprint;
  parser: HostedBodyMeta["parser"];
  processorVersion?: string;
  schemaVersion?: string;
  converterVersion?: string;
  configVersion: string;
  status: "done" | "partial";
  quality: HostedBodyMeta["quality"];
  pageCount: number;
  generatedAt: string;
  assetMode: "relative" | "placeholder";
  remote?: HostedBodyMeta["remote"];
  bodyMarkdown: string;
};

export function buildHostedMeta(input: BuildHostedMetaInput): HostedBodyMeta {
  return {
    v: BODY_SCHEMA_VERSION,
    sourceKey: input.source.attachmentKey,
    ...(input.source.parentKey ? { parentKey: input.source.parentKey } : {}),
    md5: input.source.md5,
    size: input.source.size,
    mtime: input.source.mtime,
    pageCount: Math.max(
      0,
      Math.round(input.pageCount || input.source.pageCount || 0),
    ),
    parser: input.parser,
    ...(input.processorVersion ? { modelVersion: input.processorVersion } : {}),
    ...(input.schemaVersion ? { schemaVersion: input.schemaVersion } : {}),
    converterVersion: input.converterVersion || CONVERTER_VERSION,
    configVersion: input.configVersion,
    status: input.status,
    quality: input.quality,
    generatedAt: input.generatedAt,
    assetMode: input.assetMode,
    ...(input.remote ? { remote: input.remote } : {}),
    bodySha1: bodySha1(input.bodyMarkdown),
  };
}

/** Cheap freshness check against the metadata written with the body. */
export function metaMatchesSource(
  meta: HostedBodyMeta,
  current: { size: number; mtime: number } | undefined,
): boolean {
  if (!current) return false;
  return meta.size === current.size && meta.mtime === current.mtime;
}
export function hostedAssetToken(
  meta: HostedBodyMeta,
  resources: { relativePath: string; bytes: Uint8Array }[],
): string {
  const parts = resources
    .filter((resource) => isSafeRelativePath(resource.relativePath))
    .map(
      (resource) => `${resource.relativePath}#${bytesHashHex(resource.bytes)}`,
    )
    .sort();
  return bodySha1(`${meta.bodySha1}|${parts.join("|")}`).slice(
    0,
    ASSET_VERSION_LENGTH,
  );
}

/** Safe lowercase extension for a flat asset filename; `bin` when unknown. */
export function bundleAssetExtension(relativePath: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(relativePath || ""));
  if (!match) return "bin";
  const lower = match[1].toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(lower) ? lower : "bin";
}

/**
 * Flat asset filename inside the PDF storage directory. No subdirectory is
 * used because Zotero's attachment ZIP download cannot create one. The name is
 * ASCII-safe (`glossa-asset-<token>-<index>.<ext>`), so a Windows download never
 * applies getValidFileName mangling.
 */
export function bundleAssetFileName(
  token: string,
  index: number,
  relativePath: string,
): string {
  return `${BUNDLE_ASSET_PREFIX}${token}-${Math.max(0, Math.floor(index))}.${bundleAssetExtension(relativePath)}`;
}

/**
 * Map the plan's resources (sorted by relative path for determinism) to their
 * flat filenames. Pure: the same body/resources always produce the same names.
 */
export function planBundleAssetFiles(
  token: string,
  resources: { relativePath: string }[],
): Map<string, string> {
  const files = new Map<string, string>();
  const sorted = resources
    .filter((resource) => isSafeRelativePath(resource.relativePath))
    .map((resource) => resource.relativePath)
    .sort();
  sorted.forEach((relative, index) => {
    files.set(relative, bundleAssetFileName(token, index, relative));
  });
  return files;
}

/** Rewrite relative image links to the flat filenames used beside body.md. */
export function applyBundleAssetLinks(
  markdown: string,
  files: Map<string, string>,
): string {
  let result = markdown;
  for (const [relative, fileName] of files) {
    result = result.split(`](${relative})`).join(`](${fileName})`);
    result = result.split(`](<${relative}>)`).join(`](<${fileName}>)`);
    for (const quote of ['"', "'"]) {
      result = result
        .split(`](${relative} ${quote}`)
        .join(`](${fileName} ${quote}`);
      result = result
        .split(`](<${relative}> ${quote}`)
        .join(`](<${fileName}> ${quote}`);
    }
  }
  return result;
}
function ioUtils(): typeof IOUtils {
  return ztoolkit.getGlobal("IOUtils") as typeof IOUtils;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  if (error && typeof error === "object") {
    const record = error as { message?: unknown };
    if (typeof record.message === "string") return record.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function fileStat(
  path: string,
): Promise<{ size: number; mtime: number } | undefined> {
  try {
    const stat = await ioUtils().stat(path);
    return { size: stat.size || 0, mtime: stat.lastModified || 0 };
  } catch {
    return undefined;
  }
}

async function currentStat(
  pdf: Zotero.Item,
): Promise<{ size: number; mtime: number } | undefined> {
  try {
    const path = await pdf.getFilePathAsync();
    return path ? await fileStat(path) : undefined;
  } catch {
    return undefined;
  }
}

/** Read at most the metadata line of a candidate legacy hosted attachment. */
async function readMetaHead(
  attachment: Zotero.Item,
): Promise<HostedBodyMeta | undefined> {
  let path: string | false;
  try {
    path = await attachment.getFilePathAsync();
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  try {
    const bytes = await ioUtils().read(path, { maxBytes: META_SCAN_BYTES });
    const head = new TextDecoder("utf-8").decode(bytes);
    return parseBodyMeta(head);
  } catch {
    return undefined;
  }
}

/** True when items and files can be created in this library. */
export function isLibraryWritable(libraryID: number): boolean {
  try {
    const library = Zotero.Libraries.get(libraryID);
    if (!library) return false;
    return Boolean(library.editable) && library.filesEditable !== false;
  } catch {
    return false;
  }
}
async function bodyStillMatches(
  pdf: Zotero.Item,
  meta: HostedBodyMeta,
  current: { size: number; mtime: number } | undefined,
): Promise<boolean> {
  if (!metaMatchesSource(meta, current)) return false;
  try {
    const hash = String((await pdf.attachmentHash) || "")
      .toLowerCase()
      .trim();
    if (!hash) return true;
    return hash === String(meta.md5 || "").toLowerCase();
  } catch {
    return true;
  }
}
function itemFromRelated(
  pdf: Zotero.Item,
  key: string,
): Zotero.Item | undefined {
  try {
    return Zotero.Items.getByLibraryAndKey(pdf.libraryID, key) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the legacy hosted attachment that belongs to exactly this source PDF.
 * The candidate's own first-line metadata (sourceKey) decides, so a parent with
 * several PDFs never mixes bodies.
 */
export async function findHostedAttachment(
  pdf: Zotero.Item,
  knownAttachmentKey?: string,
): Promise<Zotero.Item | undefined> {
  if (!pdf?.isPDFAttachment()) return undefined;
  const seen = new Set<string>();
  const candidates: Zotero.Item[] = [];
  const push = (item: Zotero.Item | undefined) => {
    if (!item || seen.has(item.key)) return;
    if (!isHostedTitle(item.getField("title") as string)) return;
    if (item.attachmentContentType !== HOSTED_CONTENT_TYPE) return;
    seen.add(item.key);
    candidates.push(item);
  };
  if (knownAttachmentKey) {
    try {
      const known = Zotero.Items.getByLibraryAndKey(
        pdf.libraryID,
        knownAttachmentKey,
      );
      if (known) push(known);
    } catch {
      // A stale journal key is ignored; discovery below still runs.
    }
  }
  const parent = pdf.parentItem;
  if (parent) {
    for (const id of parent.getAttachments()) {
      try {
        push(Zotero.Items.get(id) || undefined);
      } catch {
        // Skip an unreadable child.
      }
    }
  } else {
    // A file attachment cannot have children; the hosted body is related in
    // the same library instead.
    for (const key of pdf.relatedItems || []) {
      push(itemFromRelated(pdf, key));
    }
  }
  for (const candidate of candidates) {
    const meta = await readMetaHead(candidate);
    if (meta && meta.sourceKey === pdf.key) return candidate;
  }
  return undefined;
}

/** True when the file exists and is our legacy hosted body for this source. */
export async function readHostedAttachment(
  attachment: Zotero.Item,
): Promise<HostedAttachmentRead | undefined> {
  let path: string | false;
  try {
    path = await attachment.getFilePathAsync();
  } catch {
    return undefined;
  }
  if (!path || !(await pathExists(path))) return undefined;
  const stat = await fileStat(path);
  if (!stat || stat.size > MAX_BODY_BYTES) return undefined;
  const text = await readText(path);
  if (text === undefined) return undefined;
  const meta = parseBodyMeta(text);
  if (!meta) return undefined;
  const body = stripBodyMeta(text);
  if (!body.trim()) return undefined;
  return {
    attachment,
    meta,
    markdown: body,
    userModified: bodySha1(body) !== meta.bodySha1,
  };
}

/** Deprecated alias kept for callers that only need the legacy item. */
export async function getHostedAttachment(
  pdf: Zotero.Item,
  knownAttachmentKey?: string,
): Promise<Zotero.Item | undefined> {
  return findHostedAttachment(pdf, knownAttachmentKey);
}
export type PreparedHostedBody = {
  plan: HostedBodyPlan;
  meta: HostedBodyMeta;
  /** Cache directory name derived from hash + parser/converter/config versions. */
  dirName: string;
};

/**
 * Deterministically turn a parsed body into the hosted Markdown + metadata.
 * Used both for the working cache and for the bundle, so the two can never
 * disagree about the body text.
 */
export function prepareHostedBody(
  body: ParsedBody,
  options: { status: "done" | "partial"; configVersion: string },
): PreparedHostedBody {
  const plan = planHostedBody(body);
  const meta = buildHostedMeta({
    source: body.source,
    parser: body.parserId,
    processorVersion: body.processorVersion,
    schemaVersion: body.schemaVersion,
    converterVersion: body.converterVersion,
    configVersion: options.configVersion,
    status: options.status,
    quality: body.quality.level,
    pageCount: body.source.pageCount,
    generatedAt: body.generatedAt,
    assetMode: hostedAssetMode(plan),
    remote: body.remote,
    bodyMarkdown: plan.markdown,
  });
  const dirName = cacheEntryDirName({
    md5: body.source.md5,
    parserId: body.parserId,
    converterVersion: body.converterVersion,
    configVersion: options.configVersion,
    processorVersion: body.processorVersion,
    schemaVersion: body.schemaVersion,
  });
  return { plan, meta, dirName };
}

/**
 * Write the parsed body into the content-addressed working cache. This happens
 * before the bundle so a cancelled/failed bundle write still leaves a
 * reconstructible result, and a repeat conversion never re-uploads.
 */
export async function cacheParsedBody(
  body: ParsedBody,
  options: { status: "done" | "partial"; configVersion: string },
): Promise<{ entry: CacheEntryMeta; prepared: PreparedHostedBody }> {
  const prepared = prepareHostedBody(body, options);
  const entry = await writeCacheEntry(
    {
      meta: prepared.meta,
      markdown: prepared.plan.markdown,
      blocks: body.blocks,
      resources: prepared.plan.resources,
    },
    prepared.dirName,
  );
  try {
    const index = upsertCacheIndex(await loadCacheIndex(), entry);
    await saveCacheIndex(index);
  } catch (error) {
    // The entry exists on disk even if the index update failed; the queue can
    // still reuse it next time via cache lookup fallbacks.
    ztoolkit.log("[Glossa] cache index update failed", error);
  }
  return { entry, prepared };
}
function bytesHashHex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index++) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return (
    bytes.length.toString(16) + ":" + (hash >>> 0).toString(16).padStart(8, "0")
  );
}

/** Content-addressed token of the resource bytes kept for one body. */
export function tokenForResources(
  meta: HostedBodyMeta,
  resources: { relativePath: string; bytes: Uint8Array }[],
): string | undefined {
  const safe = resources.filter((resource) =>
    isSafeRelativePath(resource.relativePath),
  );
  if (!safe.length) return undefined;
  return hostedAssetToken(meta, safe);
}
async function readCachedBody(
  pdf: Zotero.Item,
  fingerprint: SourceFingerprint,
): Promise<{ markdown: string; meta: HostedBodyMeta } | undefined> {
  try {
    const index = await loadCacheIndex();
    const entry = findAnyCacheEntry(index, {
      md5: fingerprint.md5,
      size: fingerprint.size,
      mtime: fingerprint.mtime,
    });
    if (!entry) return undefined;
    const cached = await loadCacheEntry(entry.dir);
    if (!cached || cached.meta.sourceKey !== pdf.key) return undefined;
    if (bodySha1(cached.markdown) !== cached.meta.bodySha1) return undefined;
    return { markdown: cached.markdown, meta: cached.meta };
  } catch {
    return undefined;
  }
}

export async function deleteBodyForPDF(
  pdf: Zotero.Item,
  key?: string,
): Promise<boolean> {
  const attachment = await findHostedAttachment(pdf, key);
  if (!attachment || !isLibraryWritable(pdf.libraryID)) return false;
  const meta = await readMetaHead(attachment);
  if (!meta || meta.sourceKey !== pdf.key) return false;
  await attachment.eraseTx();
  return true;
}
export const removeHostedBody = deleteBodyForPDF;
export type HostedWriteResult =
  | {
      ok: true;
      attachment: Zotero.Item;
      hostedAttachmentKey: string;
      bodyPath: string;
      assetCount: number;
      bodySha1: string;
    }
  | {
      ok: false;
      reason: "read-only" | "user-modified-body" | "internal-error";
      detail?: string;
      existing?: { valid: boolean };
    };
export type ContextBody = {
  markdown: string;
  meta: HostedBodyMeta;
  origin: "hosted-md" | "cache";
  bodyPath?: string;
  attachment?: Zotero.Item;
  fresh: boolean;
  userModified: boolean;
  sourceFileMissing?: boolean;
};
export type PreparedBodyRef = {
  origin: "hosted-md";
  fresh: boolean;
  meta: HostedBodyMeta;
  attachment: Zotero.Item;
  info: { bodyPath?: string; legacyAttachmentKey: string };
};
export async function findPreparedBody(
  pdf: Zotero.Item,
  key?: string,
): Promise<PreparedBodyRef | undefined> {
  const attachment = await findHostedAttachment(pdf, key);
  const read = attachment && (await readHostedAttachment(attachment));
  if (!read || read.meta.sourceKey !== pdf.key) return undefined;
  return {
    origin: "hosted-md",
    fresh: await bodyStillMatches(pdf, read.meta, await currentStat(pdf)),
    meta: read.meta,
    attachment: read.attachment,
    info: {
      bodyPath: (await read.attachment.getFilePathAsync()) || undefined,
      legacyAttachmentKey: read.attachment.key,
    },
  };
}
export async function readBodyForContext(
  pdf: Zotero.Item,
  options: {
    legacyAttachmentKey?: string;
    fingerprint?: SourceFingerprint;
    allowCache?: boolean;
  } = {},
): Promise<ContextBody | undefined> {
  const p = await findPreparedBody(pdf, options.legacyAttachmentKey);
  const current = await currentStat(pdf);
  if (p) {
    const read = await readHostedAttachment(p.attachment);
    if (read && read.meta.sourceKey === pdf.key)
      return {
        ...read,
        origin: "hosted-md",
        bodyPath: p.info.bodyPath,
        fresh: p.fresh,
        sourceFileMissing: !current,
      };
  }
  if (options.allowCache && options.fingerprint) {
    const cached = await readCachedBody(pdf, options.fingerprint);
    if (cached)
      return {
        ...cached,
        origin: "cache",
        fresh: await bodyStillMatches(pdf, cached.meta, current),
        userModified: false,
        sourceFileMissing: !current,
      };
  }
  return undefined;
}
export async function getBodyCacheTag(
  pdf: Zotero.Item,
  state?: Pick<PrepState, "updatedAt" | "hostedAttachmentKey">,
): Promise<string> {
  const read = await readBodyForContext(pdf, {
    legacyAttachmentKey: state?.hostedAttachmentKey,
  });
  const stat = read?.bodyPath && (await fileStat(read.bodyPath));
  return [
    state?.updatedAt || 0,
    read?.attachment?.key || "",
    read?.meta.bodySha1 || "",
    stat ? stat.size + ":" + stat.mtime : "",
    read ? bodySha1(read.markdown) : "",
  ].join("|");
}
export function safeMarkdownFilename(filename: string): string {
  let stem = String(filename || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.pdf$/i, "")
    // Windows filenames cannot contain ASCII control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 61)
    .replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem))
    stem = "_" + stem.slice(0, 60);
  return stem ? stem + ".md" : "glossa-body.md";
}
const writes = new Map<string, Promise<unknown>>();
function serializeWrite(
  pdf: Zotero.Item,
  fn: () => Promise<HostedWriteResult>,
): Promise<HostedWriteResult> {
  const key = pdf.libraryID + ":" + pdf.key;
  const next = (writes.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  writes.set(key, next);
  void next.finally(() => {
    if (writes.get(key) === next) writes.delete(key);
  });
  return next;
}
export function writeHostedBody(
  pdf: Zotero.Item,
  body: ParsedBody,
  options: BundleWriteOptions,
): Promise<HostedWriteResult> {
  return serializeWrite(pdf, () => {
    const p = prepareHostedBody(body, options);
    return commitHosted(pdf, p.meta, p.plan, options.force);
  });
}
export function writeHostedFromCache(
  pdf: Zotero.Item,
  cached: {
    meta: HostedBodyMeta;
    markdown: string;
    resources: HostedResource[];
  },
  options: { force?: boolean } = {},
): Promise<HostedWriteResult> {
  return serializeWrite(pdf, async () => {
    if (bodySha1(cached.markdown) !== cached.meta.bodySha1)
      return {
        ok: false,
        reason: "internal-error",
        detail: "cache-body-corrupt",
      };
    return commitHosted(
      pdf,
      cached.meta,
      {
        markdown: cached.markdown,
        resources: cached.resources,
        resolved: cached.resources.length,
        placeholders: 0,
        warnings: [],
      },
      options.force,
    );
  });
}
async function commitHosted(
  pdf: Zotero.Item,
  meta: HostedBodyMeta,
  plan: HostedBodyPlan,
  force = false,
): Promise<HostedWriteResult> {
  if (!isLibraryWritable(pdf.libraryID))
    return { ok: false, reason: "read-only" };
  if (meta.sourceKey !== pdf.key || !pdf.isPDFAttachment())
    return { ok: false, reason: "internal-error", detail: "source-mismatch" };
  let attachment = await findHostedAttachment(pdf);
  const old = attachment && (await readHostedAttachment(attachment));
  if (old?.userModified && !force)
    return {
      ok: false,
      reason: "user-modified-body",
      existing: { valid: true },
    };
  let staging: string | undefined;
  try {
    const resources = plan.resources.filter((r) =>
      isSafeRelativePath(r.relativePath),
    );
    if (resources.length > 10000) throw new Error("Too many assets");
    const files = planBundleAssetFiles(
      hostedAssetToken(meta, resources),
      resources,
    );
    const markdown = applyBundleAssetLinks(plan.markdown, files);
    meta = { ...meta, bundle: undefined, bodySha1: bodySha1(markdown) };
    staging = paths().join(
      bodyStagingDir(),
      pdf.key + "-" + Date.now() + "-" + Math.random().toString(16).slice(2),
    );
    await ensureDirectory(staging);
    const stagedBody = paths().join(
      staging,
      safeMarkdownFilename(pdf.attachmentFilename || ""),
    );
    await writeTextAtomic(stagedBody, serializeBodyMeta(meta) + markdown);
    for (const r of resources)
      await writeBytesAtomic(
        paths().join(staging, files.get(r.relativePath)!),
        r.bytes,
      );
    if (!attachment)
      attachment = await Zotero.Attachments.importFromFile({
        file: stagedBody,
        libraryID: pdf.libraryID,
        parentItemID: pdf.parentItemID || undefined,
        collections: pdf.parentItemID ? undefined : pdf.getCollections(),
        title: hostedTitleFor(pdf.attachmentFilename || "paper.pdf"),
        contentType: HOSTED_CONTENT_TYPE,
      });
    const wantedName = safeMarkdownFilename(pdf.attachmentFilename || "");
    if (attachment.attachmentFilename !== wantedName) {
      const renamed = await attachment.renameAttachmentFile(
        wantedName,
        false,
        false,
      );
      if (renamed !== true)
        throw new Error("Cannot safely rename Markdown attachment");
    }
    const bodyPath = await attachment.getFilePathAsync();
    if (!bodyPath) throw new Error("No local Markdown path");
    const root = paths().parent(bodyPath);
    if (!root) throw new Error("No Markdown storage directory");
    // Generation-addressed assets first; the atomic Markdown replacement commits the new generation.
    for (const r of resources)
      await writeBytesAtomic(
        paths().join(root, files.get(r.relativePath)!),
        r.bytes,
      );
    await writeTextAtomic(bodyPath, serializeBodyMeta(meta) + markdown);
    attachment.setField(
      "title",
      hostedTitleFor(pdf.attachmentFilename || "paper.pdf"),
    );
    attachment.attachmentContentType = HOSTED_CONTENT_TYPE;
    if (!pdf.parentItemID) {
      attachment.addRelatedItem(pdf);
      pdf.addRelatedItem(attachment);
      await pdf.saveTx();
    }
    attachment.attachmentSyncState = "to_upload";
    await attachment.saveTx();
    const keep = new Set(files.values());
    for (const path of await ioUtils().getChildren(root)) {
      const name = paths().filename(path);
      if (
        ASSET_RE.test(name || "") &&
        !keep.has(name || "") &&
        (await ioUtils().stat(path)).type === "regular"
      )
        await ioUtils().remove(path);
    }
    return {
      ok: true,
      attachment,
      hostedAttachmentKey: attachment.key,
      bodyPath,
      assetCount: files.size,
      bodySha1: meta.bodySha1,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "internal-error",
      detail: describeError(error),
      existing: { valid: !!old },
    };
  } finally {
    if (staging)
      await ioUtils().remove(staging, { recursive: true, ignoreAbsent: true });
  }
}
let cleanupPromise: Promise<void> | undefined;
export function cleanupLegacyPdfBundlesOnce(): Promise<void> {
  return (cleanupPromise ||= (async () => {
    const pref = config.prefsPrefix + ".markdown.bundleCleanupDone";
    if (Zotero.Prefs.get(pref, true)) return;
    await ioUtils().remove(
      paths().join(Zotero.DataDirectory.dir, "glossa", "bundle-sync"),
      { recursive: true, ignoreAbsent: true },
    );
    const search = new Zotero.Search();
    search.addCondition("itemType", "is", "attachment");
    for (const id of await search.search()) {
      const item = Zotero.Items.get(id);
      if (!item || !item.isPDFAttachment() || !item.isStoredFileAttachment())
        continue;
      const pdfPath = await item.getFilePathAsync();
      if (!pdfPath || !(await pathExists(pdfPath))) continue;
      const root = paths().parent(pdfPath);
      if (!root) continue;
      for (const path of await ioUtils().getChildren(root)) {
        const name = paths().filename(path);
        if (
          (name === "glossa-body.md" ||
            name === "glossa-meta.json" ||
            ASSET_RE.test(name || "")) &&
          path !== pdfPath &&
          (await ioUtils().stat(path)).type === "regular"
        )
          await ioUtils().remove(path);
      }
    }
    Zotero.Prefs.set(pref, true, true);
  })().catch((error) => {
    cleanupPromise = undefined;
    throw error;
  }));
}

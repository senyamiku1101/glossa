/**
 * Durable state for the unified Markdown body pipeline.
 *
 * Two independent things live under `<data dir>/glossa/body/`:
 *  - `queue.json`: the durable queue journal. It stores only Glossa's own state
 *    rows (the same shape the UI shows), so a restart never leaves a row stuck
 *    in `running`.
 *  - `cache/<dir>/`: the content-addressed working cache. An entry is keyed by
 *    source hash + parser/model/converter/config versions, so the same PDF with
 *    a different model or endpoint never reuses another body. The cache is an
 *    internal optimisation; the deliverable is the hosted Zotero attachment.
 *
 * Runtime-free helpers (keys, recovery, staleness, index upserts) are pure and
 * are covered by `scripts/check-markdown-pipeline.mjs`. The IO functions are
 * thin wrappers around Gecko's IOUtils and never touch Zotero's database.
 */
import { bodyCacheDir, bodyQueueFile, io, paths } from "../../utils/paths";
import {
  hasBody,
  stableHash,
  type BlockLoc,
  type HostedBodyMeta,
  type HostedResource,
  type PrepState,
  type PrepStatus,
  type QualityLevel,
  type SourceFingerprint,
} from "./types";

export const JOURNAL_VERSION = 1;
export const CACHE_INDEX_VERSION = 1;

export type JournalFile = {
  version: number;
  savedAt: number;
  states: PrepState[];
};

/** One cached parse result, addressed by md5 + parser + versions. */
export type CacheEntryMeta = {
  dir: string;
  md5: string;
  size: number;
  mtime: number;
  parserId: string;
  configVersion: string;
  converterVersion: string;
  processorVersion?: string;
  schemaVersion?: string;
  status: "done" | "partial";
  quality: QualityLevel;
  pageCount: number;
  updatedAt: number;
};

export type CacheEntryData = {
  meta: HostedBodyMeta;
  markdown: string;
  blocks: BlockLoc[];
  resources: HostedResource[];
};

export type CacheIndexFile = {
  version: number;
  entries: Record<string, CacheEntryMeta[]>;
};

// ---- pure keys and state helpers ----

/** Stable state row key; the attachment key is unique inside one library. */
export function stateKey(libraryID: number, attachmentKey: string): string {
  return `${libraryID}/${attachmentKey}`;
}

export function emptyJournal(): JournalFile {
  return { version: JOURNAL_VERSION, savedAt: 0, states: [] };
}

/**
 * Rebuild the in-memory queue after a restart.
 *
 * A `running` row that already recorded a cloud job id (written as soon as the
 * service accepted the PDF) is resumable: it becomes `queued` and the queue
 * polls the existing job instead of uploading again. A `running` row without a
 * job id is **not** resubmitted, because the accepted request may have been
 * charged already: it is cancelled with an explicit reason so the user can
 * decide. Rows waiting only for a local file are rechecked once. Rows that wait
 * for the user (config/consent) are deliberately not resumed.
 */
export function recoverStates(states: PrepState[]): {
  states: PrepState[];
  resume: PrepState[];
} {
  const byKey = new Map<string, PrepState>();
  for (const row of states) {
    if (!row || typeof row.key !== "string") continue;
    byKey.set(row.key, row);
  }
  const next: PrepState[] = [];
  const resume: PrepState[] = [];
  for (const row of byKey.values()) {
    if (row.status === "running") {
      if (row.remote?.jobId) {
        const revived: PrepState = {
          ...row,
          status: "queued",
          progress: undefined,
          detail: "resume-restart",
        };
        next.push(revived);
        resume.push(revived);
      } else {
        // No remote job id was persisted, so a restart must not silently
        // submit the same PDF again.
        next.push({
          ...row,
          status: "cancelled",
          reason: "cancelled",
          progress: undefined,
          detail: "restart-during-run",
          lastAttemptError: "interrupted-by-restart; retry manually",
        });
      }
      continue;
    }
    if (row.status === "queued" || row.status === "waiting-file") {
      next.push(row);
      resume.push(row);
      continue;
    }
    next.push(row);
  }
  return { states: next, resume };
}

/** True when the file behind a body changed since it was produced. */
export function fingerprintDiffers(
  stored: SourceFingerprint | undefined,
  current: SourceFingerprint | undefined,
): boolean {
  if (!stored || !current) return true;
  return (
    stored.md5 !== current.md5 ||
    stored.size !== current.size ||
    stored.mtime !== current.mtime
  );
}

/**
 * A finished body becomes `stale` once the current PDF no longer matches the
 * fingerprint it was produced from. The old body is kept and remains readable
 * until a new one is written.
 */
export function staleStatusFor(
  row: PrepState,
  current: SourceFingerprint | undefined,
): PrepStatus {
  if (!hasBody(row.status)) return row.status;
  if (row.status === "stale") return "stale";
  if (!current || !row.source) return row.status;
  return fingerprintDiffers(row.source, current) ? "stale" : row.status;
}

/** Key shared by all cache entries of one source + parser + config + converter. */
export function cacheIndexKey(input: {
  md5: string;
  parserId: string;
  configVersion: string;
  converterVersion: string;
}): string {
  return [
    input.md5.toLowerCase(),
    input.parserId,
    input.converterVersion,
    input.configVersion,
  ].join("|");
}

function safeName(value: string): string {
  return String(value || "-").replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Self-describing cache directory: source hash, parser, converter and config
 * versions are visible on disk, plus a short hash of the engine's own
 * processor/schema version (known only after a parse).
 */
export function cacheEntryDirName(input: {
  md5: string;
  parserId: string;
  converterVersion: string;
  configVersion: string;
  processorVersion?: string;
  schemaVersion?: string;
}): string {
  const engine = stableHash(
    `${input.processorVersion ?? "-"}|${input.schemaVersion ?? "-"}`,
  );
  return [
    safeName(input.md5.toLowerCase()),
    safeName(input.parserId),
    safeName(input.converterVersion),
    safeName(input.configVersion),
    engine,
  ].join("-");
}

export function emptyCacheIndex(): CacheIndexFile {
  return { version: CACHE_INDEX_VERSION, entries: {} };
}

/** Whether a cached entry can be reused for the current source at all. */
export function sameSource(
  entry: Pick<CacheEntryMeta, "md5" | "size" | "mtime">,
  input: Pick<SourceFingerprint, "md5" | "size" | "mtime">,
): boolean {
  return (
    entry.md5.toLowerCase() === input.md5.toLowerCase() &&
    entry.size === input.size &&
    entry.mtime === input.mtime
  );
}

/**
 * The newest cached result for this source, parser, converter and config.
 * Processor/schema versions live in the entry, so a later engine version can
 * coexist instead of overwriting the older mirror.
 */
export function findCacheEntry(
  index: CacheIndexFile | undefined,
  input: {
    md5: string;
    size: number;
    mtime: number;
    parserId: string;
    converterVersion: string;
    configVersion: string;
  },
): CacheEntryMeta | undefined {
  if (!index || !index.entries) return undefined;
  const key = cacheIndexKey(input);
  const rows = index.entries[key] ?? [];
  let best: CacheEntryMeta | undefined;
  for (const row of rows) {
    if (!sameSource(row, input)) continue;
    if (!best || row.updatedAt > best.updatedAt) best = row;
  }
  return best;
}

/** Insert/replace one entry and keep at most `maxPerKey` per source/config. */
export function upsertCacheIndex(
  index: CacheIndexFile | undefined,
  entry: CacheEntryMeta,
  maxPerKey = 3,
): CacheIndexFile {
  const base = index ?? emptyCacheIndex();
  const key = cacheIndexKey(entry);
  const rows = (base.entries[key] ?? []).filter((row) => row.dir !== entry.dir);
  rows.push(entry);
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    version: CACHE_INDEX_VERSION,
    entries: { ...base.entries, [key]: rows.slice(0, maxPerKey) },
  };
}

/** Number of cached bodies this source/parser/config currently keeps. */
export function cacheEntryCount(
  index: CacheIndexFile | undefined,
  input: {
    md5: string;
    parserId: string;
    converterVersion: string;
    configVersion: string;
  },
): number {
  if (!index?.entries) return 0;
  return (index.entries[cacheIndexKey(input)] ?? []).length;
}

/**
 * Newest cached body for this exact file across all parser/config versions.
 * Used by the read-only/context fallback, where the caller does not know which
 * config produced the existing cache entry.
 */
export function findAnyCacheEntry(
  index: CacheIndexFile | undefined,
  input: Pick<SourceFingerprint, "md5" | "size" | "mtime">,
): CacheEntryMeta | undefined {
  if (!index?.entries) return undefined;
  let best: CacheEntryMeta | undefined;
  for (const rows of Object.values(index.entries)) {
    for (const row of rows ?? []) {
      if (!sameSource(row, input)) continue;
      if (!best || row.updatedAt > best.updatedAt) best = row;
    }
  }
  return best;
}

/** Reject absolute paths, `..` segments and backslash escapes from services. */
export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  return normalized
    .split("/")
    .every((segment) => segment && segment !== "." && segment !== "..");
}

// ---- IO: queue journal ----

export async function loadJournal(): Promise<JournalFile> {
  const raw = await readJson<Partial<JournalFile>>(bodyQueueFile());
  if (!raw || !Array.isArray(raw.states)) return emptyJournal();
  return {
    version: typeof raw.version === "number" ? raw.version : JOURNAL_VERSION,
    savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
    states: raw.states.filter(
      (row): row is PrepState =>
        Boolean(row) && typeof (row as PrepState).key === "string",
    ),
  };
}

export async function saveJournal(states: PrepState[]): Promise<void> {
  const file = bodyQueueFile();
  const parent = paths().parent(file);
  if (parent) await ensureDirectory(parent);
  const payload: JournalFile = {
    version: JOURNAL_VERSION,
    savedAt: Date.now(),
    states,
  };
  await writeTextAtomic(file, JSON.stringify(payload));
}

// ---- IO: content-addressed cache ----

export function cacheRoot(): string {
  return bodyCacheDir();
}

export function cacheEntryPath(dir: string): string {
  return paths().join(cacheRoot(), dir);
}

export async function loadCacheIndex(): Promise<CacheIndexFile> {
  const raw = await readJson<Partial<CacheIndexFile>>(
    paths().join(cacheRoot(), "index.json"),
  );
  if (!raw || typeof raw !== "object" || !raw.entries) {
    return emptyCacheIndex();
  }
  return {
    version:
      typeof raw.version === "number" ? raw.version : CACHE_INDEX_VERSION,
    entries: raw.entries as Record<string, CacheEntryMeta[]>,
  };
}

export async function saveCacheIndex(index: CacheIndexFile): Promise<void> {
  await ensureDirectory(cacheRoot());
  await writeTextAtomic(
    paths().join(cacheRoot(), "index.json"),
    JSON.stringify(index),
  );
}

export async function writeCacheEntry(
  data: CacheEntryData,
  dirName: string,
): Promise<CacheEntryMeta> {
  const dir = cacheEntryPath(dirName);
  const resourcesDir = paths().join(dir, "resources");
  // Clear resources from any previous write in the same directory so a rebuilt
  // body never retains stale nested images.
  try {
    await io().remove(resourcesDir, { ignoreAbsent: true, recursive: true });
  } catch {
    // A missing resource directory is fine.
  }
  await ensureDirectory(resourcesDir);
  const kept: { relativePath: string; mime: string }[] = [];
  for (const resource of data.resources) {
    if (!isSafeRelativePath(resource.relativePath)) continue;
    const segments = resource.relativePath
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    if (!segments.length) continue;
    const target = paths().join(resourcesDir, ...segments);
    const parent = paths().parent(target);
    if (parent) await ensureDirectory(parent);
    await writeBytesAtomic(target, resource.bytes);
    kept.push({ relativePath: resource.relativePath, mime: resource.mime });
  }
  await writeTextAtomic(
    paths().join(dir, "resources.json"),
    JSON.stringify(kept),
  );
  await writeTextAtomic(paths().join(dir, "body.md"), data.markdown);
  await writeTextAtomic(
    paths().join(dir, "meta.json"),
    JSON.stringify(data.meta),
  );
  await writeTextAtomic(
    paths().join(dir, "blocks.json"),
    JSON.stringify(data.blocks),
  );
  return {
    dir: dirName,
    md5: data.meta.md5,
    size: data.meta.size,
    mtime: data.meta.mtime,
    parserId: data.meta.parser,
    configVersion: data.meta.configVersion,
    converterVersion: data.meta.converterVersion,
    processorVersion: data.meta.modelVersion,
    schemaVersion: data.meta.schemaVersion,
    status: data.meta.status === "partial" ? "partial" : "done",
    quality: data.meta.quality,
    pageCount: data.meta.pageCount,
    updatedAt: Date.now(),
  };
}

export async function loadCacheEntry(
  dirName: string,
): Promise<CacheEntryData | undefined> {
  const dir = cacheEntryPath(dirName);
  const meta = await readJson<HostedBodyMeta>(paths().join(dir, "meta.json"));
  if (
    !meta ||
    typeof meta.md5 !== "string" ||
    typeof meta.bodySha1 !== "string"
  )
    return undefined;
  const markdown = await readText(paths().join(dir, "body.md"));
  if (markdown === undefined) return undefined;
  const blocks =
    (await readJson<BlockLoc[]>(paths().join(dir, "blocks.json"))) ?? [];
  const manifest =
    (await readJson<{ relativePath: string; mime: string }[]>(
      paths().join(dir, "resources.json"),
    )) ?? [];
  const resources: HostedResource[] = [];
  for (const row of manifest) {
    if (!isSafeRelativePath(row.relativePath)) continue;
    const segments = row.relativePath
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    if (!segments.length) continue;
    const bytes = await readBytes(paths().join(dir, "resources", ...segments));
    if (!bytes) continue;
    resources.push({ relativePath: row.relativePath, mime: row.mime, bytes });
  }
  return { meta, markdown, blocks, resources };
}

export async function dropCacheEntry(dirName: string): Promise<void> {
  try {
    await io().remove(cacheEntryPath(dirName), {
      ignoreAbsent: true,
      recursive: true,
    });
  } catch {
    // A cache entry we cannot delete must never break the pipeline.
  }
}

// ---- small IO helpers (also used by store.ts) ----

export async function ensureDirectory(dir: string): Promise<void> {
  await io().makeDirectory(dir, {
    ignoreExisting: true,
    createAncestors: true,
  });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    return await io().exists(path);
  } catch {
    return false;
  }
}

export async function readText(path: string): Promise<string | undefined> {
  try {
    return await io().readUTF8(path);
  } catch {
    return undefined;
  }
}

export async function readBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return await io().read(path);
  } catch {
    return undefined;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Atomic replace: IOUtils writes to `tmpPath` and renames, so a crash never
 * leaves a truncated body/queue file behind.
 */
export async function writeTextAtomic(
  path: string,
  text: string,
): Promise<void> {
  await io().writeUTF8(path, text, { tmpPath: `${path}.tmp` });
}

export async function writeBytesAtomic(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await io().write(path, bytes, { tmpPath: `${path}.tmp` });
}

import { config } from "../../../package.json";
import { bodySha1, sourceFingerprintFromItem } from "./meta";

import {
  cacheParsedBody,
  writeHostedBody,
  writeHostedFromCache,
  deleteBodyForPDF as deleteStoredBody,
  findPreparedBody,
  isLibraryWritable,
  readHostedAttachment,
  type PreparedBodyRef,
} from "./store";
import { resolveCloudGate } from "./engines";
import {
  configVersion as readParserConfigVersion,
  endpointHost,
  readSettings,
  type MarkdownSettings,
} from "./settings";
import {
  dropCacheEntry,
  findCacheEntry,
  loadCacheEntry,
  loadCacheIndex,
  loadJournal,
  recoverStates,
  saveJournal,
  staleStatusFor,
  stateKey,
} from "./journal";
import {
  CONVERTER_VERSION,
  hasBody,
  type BatchSummary,
  type HostedBodyMeta,
  type ParseOptions,
  type ParseOutcome,
  type PrepState,
  type PrepStatus,
  type ProgressEvent,
  type RemoteInfo,
  type SourceFingerprint,
} from "./types";

export type EnqueueOptions = {
  /** Explicitly replace a body the user edited (hosted user-modified guard). */
  force?: boolean;
};

type JobOptions = {
  automatic: boolean;

  force: boolean;
  /** Status of an existing usable body before this attempt (failure keeps it). */
  previousStatus?: PrepStatus;
  /** Existing cloud job id: poll it instead of uploading the PDF again. */
  resumeJobId?: string;
};

export function resumeJobFor(
  row: Pick<PrepState, "remote" | "detail" | "status">,
  settings: MarkdownSettings,
): string | undefined {
  const jobId = row.remote?.jobId;
  if (!jobId) return undefined;
  if (
    row.status === "done" ||
    row.status === "partial" ||
    row.status === "stale"
  )
    return undefined;
  if (!row.detail?.startsWith("resume-")) return undefined;
  if (
    row.remote?.provider !==
    (settings.provider === "mineru-cloud" ? "mineru" : "paddleocr")
  )
    return undefined;
  const endpoint =
    settings.provider === "mineru-cloud"
      ? settings.mineru.endpoint
      : settings.cloud.endpoint;
  const model =
    settings.provider === "mineru-cloud"
      ? settings.mineru.modelVersion
      : settings.cloud.model;
  const host = endpointHost(
    endpoint,
    settings.provider === "mineru-cloud" && settings.mineru.selfHosted,
  );
  if (!host || row.remote?.host !== host) return undefined;
  if (row.remote.modelVersion !== model) return undefined;
  return jobId;
}

function mergeRemote(
  prior: RemoteInfo | undefined,
  next: RemoteInfo | undefined,
): RemoteInfo | undefined {
  if (!next) return prior;
  if (!prior) return next;
  return {
    ...next,
    host: next.host || prior.host,
    uploadedAt: next.uploadedAt || prior.uploadedAt || 0,

    jobId: next.jobId || prior.jobId,
    ...((next.modelVersion ?? prior.modelVersion)
      ? { modelVersion: next.modelVersion ?? prior.modelVersion }
      : {}),
  };
}

const states = new Map<string, PrepState>();
/** Pending attachment state keys, FIFO. */
const jobs: string[] = [];
const jobOptions = new Map<string, JobOptions>();
let running:
  { key: string; controller?: AbortController; cancelled: boolean } | undefined;
let initialized = false;
let disposed = false;
let pumping = false;
let kickTimer: number | undefined;
let notifierID: string | undefined;
let saveTimer: number | undefined;
let publishTimer: number | undefined;
const listeners = new Set<(rows: PrepState[]) => void>();
let idleWaiters: (() => void)[] = [];
const waitingTimers = new Map<string, number>();
const waitingAttempts = new Map<string, number>();
/** itemID -> state key for live source PDFs, for delete notifications. */
const itemIDToStateKey = new Map<number, string>();
/** hosted attachment itemID -> source PDF key. */
const hostedItemIDToSource = new Map<number, string>();

type Timer = (handler: () => void, timeout?: number) => number;

function getSetTimeout(): Timer | undefined {
  try {
    const globalSetTimeout = ztoolkit.getGlobal("setTimeout") as unknown as
      Timer | undefined;
    if (globalSetTimeout) return globalSetTimeout;
  } catch {
    /* Ignore an unavailable optional host API. */
  }
  const win = Zotero.getMainWindow();
  if (!win) return undefined;
  return (handler: () => void, timeout?: number) =>
    win.setTimeout(handler, timeout);
}

function schedule(handler: () => void, timeout: number): number | undefined {
  const set = getSetTimeout();
  if (!set) return undefined;
  return set(handler, timeout);
}

function log(message: string, error?: unknown) {
  try {
    ztoolkit.log(`[Glossa] ${message}`, error);
  } catch {
    /* Ignore an unavailable optional host API. */
  }
}

/** Readable error text with stack; never includes PDF content or secrets. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack || "";
    return stack ? `${error.message} | ${stack}` : error.message;
  }
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; stack?: unknown };
    if (typeof record.message === "string") {
      const stack = typeof record.stack === "string" ? record.stack : "";
      return stack ? `${record.message} | ${stack}` : record.message;
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function createAbortController(): AbortController | undefined {
  try {
    const ctor = (
      globalThis as unknown as {
        AbortController?: new () => AbortController;
      }
    ).AbortController;
    return typeof ctor === "function" ? new ctor() : undefined;
  } catch {
    return undefined;
  }
}

function snapshot(): PrepState[] {
  return [...states.values()]
    .map((row) => ({ ...row }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function publishSoon() {
  if (publishTimer !== undefined) return;
  const fire = () => {
    publishTimer = undefined;
    const rows = snapshot();
    for (const listener of listeners) {
      try {
        listener(rows);
      } catch (error) {
        log("queue listener failed", error);
      }
    }
    if (!isBusy()) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
  const timer = getSetTimeout();
  if (!timer) {
    fire();
    return;
  }
  publishTimer = timer(fire, 0);
}

function scheduleSave() {
  if (saveTimer !== undefined) return;
  const fire = () => {
    saveTimer = undefined;
    void flushJournal();
  };
  const timer = getSetTimeout();
  if (!timer) {
    void flushJournal();
    return;
  }
  saveTimer = timer(fire, 400);
}

async function flushJournal() {
  try {
    await saveJournal(snapshot());
  } catch (error) {
    log("queue journal write failed", error);
  }
}

function patchState(
  key: string,
  patch: Partial<PrepState>,
): PrepState | undefined {
  const current = states.get(key);
  if (!current) return undefined;
  const next: PrepState = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  states.set(key, next);
  publishSoon();
  scheduleSave();
  return next;
}

function resolvePDF(
  libraryID: number,
  attachmentKey: string,
): Zotero.Item | undefined {
  try {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, attachmentKey);
    return item && item.isPDFAttachment() ? item : undefined;
  } catch {
    return undefined;
  }
}

async function resolvePDFAsync(
  libraryID: number,
  attachmentKey: string,
): Promise<Zotero.Item | undefined> {
  const cached = resolvePDF(libraryID, attachmentKey);
  if (cached) return cached;
  try {
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      libraryID,
      attachmentKey,
    );
    return item && item.isPDFAttachment() ? item : undefined;
  } catch {
    return undefined;
  }
}

function rememberItem(item: Zotero.Item, key: string) {
  if (item?.id) itemIDToStateKey.set(item.id, key);
}

function rememberHosted(
  attachment: Zotero.Item | undefined,
  sourceKey: string,
) {
  if (attachment?.id) hostedItemIDToSource.set(attachment.id, sourceKey);
}

function displayTitle(item: Zotero.Item): string {
  try {
    const attachmentTitle = String(item.getField("title") || "").trim();
    const parent = item.parentItem;
    if (parent && attachmentTitle) {
      return `${parent.getDisplayTitle()} — ${attachmentTitle}`;
    }
    if (parent) return parent.getDisplayTitle();
    return attachmentTitle || item.getDisplayTitle();
  } catch {
    return "";
  }
}

function collectPDFs(items: Zotero.Item[]): {
  pdfs: Zotero.Item[];
  noPdf: Zotero.Item[];
} {
  const pdfs = new Map<string, Zotero.Item>();
  const noPdf: Zotero.Item[] = [];
  for (const item of items) {
    if (!item) continue;
    if (item.isPDFAttachment()) {
      pdfs.set(`${item.libraryID}/${item.key}`, item);
      continue;
    }
    if (!item.isRegularItem()) continue;
    const children: Zotero.Item[] = [];
    try {
      for (const id of item.getAttachments()) {
        const child = Zotero.Items.get(id);
        if (child && child.isPDFAttachment() && child.isFileAttachment()) {
          children.push(child);
        }
      }
    } catch {
      /* Ignore an unavailable optional host API. */
    }
    if (!children.length) {
      noPdf.push(item);
      continue;
    }
    for (const child of children) {
      pdfs.set(`${child.libraryID}/${child.key}`, child);
    }
  }
  return { pdfs: [...pdfs.values()], noPdf };
}

export async function initMarkdownQueue(): Promise<void> {
  if (initialized) return;
  initialized = true;
  disposed = false;

  try {
    const journal = await loadJournal();
    const recovered = recoverStates(journal.states);
    for (const row of recovered.states) states.set(row.key, row);
    for (const row of recovered.states) {
      const pdf = await resolvePDFAsync(row.libraryID, row.attachmentKey);
      if (pdf) rememberItem(pdf, row.key);
      if (row.hostedAttachmentKey) {
        try {
          const hosted =
            Zotero.Items.getByLibraryAndKey(
              row.libraryID,
              row.hostedAttachmentKey,
            ) ||
            (await Zotero.Items.getByLibraryAndKeyAsync(
              row.libraryID,
              row.hostedAttachmentKey,
            ));
          if (hosted) rememberHosted(hosted, row.attachmentKey);
        } catch {
          /* Ignore an unreadable attachment during recovery. */
        }
      }
    }
    for (const row of recovered.resume) {
      if (!states.has(row.key)) continue;
      const resumeJobId = resumeJobFor(row, readSettings());
      jobOptions.set(row.key, {
        automatic: true,
        force: false,
        resumeJobId,
      });
      pushJob(row.key);
    }
    registerNotifier();
    publishSoon();
    scheduleSave();
    void pump();
    scheduleKick();
  } catch (error) {
    log("queue init failed", error);
  }
}

export function disposeMarkdownQueue(): void {
  initialized = false;
  disposed = true;
  try {
    if (notifierID) Zotero.Notifier.unregisterObserver(notifierID);
  } catch (error) {
    log("notifier cleanup failed", error);
  }
  notifierID = undefined;
  jobs.length = 0;
  jobOptions.clear();
  if (kickTimer !== undefined) {
    clearTimer(kickTimer);
    kickTimer = undefined;
  }
  if (publishTimer !== undefined) {
    clearTimer(publishTimer);
    publishTimer = undefined;
  }
  if (saveTimer !== undefined) {
    clearTimer(saveTimer);
    saveTimer = undefined;
  }
  for (const timer of waitingTimers.values()) clearTimer(timer);
  waitingTimers.clear();
  waitingAttempts.clear();
  itemIDToStateKey.clear();
  hostedItemIDToSource.clear();
  if (running) {
    try {
      running.controller?.abort();
    } catch {
      /* Ignore an unavailable optional host API. */
    }
    running.cancelled = true;
  }
  void flushJournal();
  for (const resolve of idleWaiters) resolve();
  idleWaiters = [];
}

function clearTimer(timer: number) {
  try {
    const clear = ztoolkit.getGlobal("clearTimeout") as (id: number) => void;
    clear(timer);
  } catch {
    const win = Zotero.getMainWindow();
    if (win) win.clearTimeout(timer);
  }
}

export function getStates(): PrepState[] {
  return snapshot();
}

export function subscribe(listener: (rows: PrepState[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getStateForPDF(attachment: Zotero.Item): PrepState | undefined {
  if (!attachment) return undefined;
  return states.get(stateKey(attachment.libraryID, attachment.key));
}

export function isBusy(): boolean {
  return pumping || Boolean(running) || jobs.length > 0;
}

/** Resolves as soon as no job is queued or running. */
export function queueIdle(): Promise<void> {
  if (!isBusy()) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function pushJob(key: string) {
  if (!jobs.includes(key)) jobs.push(key);
}

function ensureRow(pdf: Zotero.Item, patch: Partial<PrepState>): PrepState {
  const key = stateKey(pdf.libraryID, pdf.key);
  const existing = states.get(key);
  const row: PrepState = {
    key,
    attachmentKey: pdf.key,
    parentKey: pdf.parentItemKey || undefined,
    libraryID: pdf.libraryID,
    title: displayTitle(pdf),
    status: "queued",
    attempts: 0,
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  };
  states.set(key, row);
  rememberItem(pdf, key);
  return row;
}

export async function enqueueItems(
  items: Zotero.Item[],
  options: EnqueueOptions = {},
): Promise<BatchSummary> {
  if (!initialized) await initMarkdownQueue();
  const settings = readSettings();
  const { pdfs, noPdf } = collectPDFs([...(items || [])]);
  const summary: BatchSummary = {
    total: pdfs.length + noPdf.length,
    queued: 0,
    skipped: 0,

    waitingFile: 0,
    waitingConfig: 0,
    failed: 0,
    noPdf: 0,
  };

  for (const item of noPdf) {
    const key = stateKey(item.libraryID, item.key);
    states.set(key, {
      key,
      attachmentKey: item.key,
      parentKey: item.parentItemKey || undefined,
      libraryID: item.libraryID,
      title: displayTitle(item),
      status: "no-pdf",
      attempts: 0,
      reason: "no-pdf-attachment",
      updatedAt: Date.now(),
    });
    summary.noPdf += 1;
  }

  for (const pdf of pdfs) {
    const key = stateKey(pdf.libraryID, pdf.key);
    const existing = states.get(key);
    if (existing && isRowActive(existing.status)) {
      const strandedQueued =
        existing.status === "queued" &&
        running?.key !== key &&
        !jobs.includes(key);
      const promotable =
        strandedQueued ||
        existing.status === "waiting-config" ||
        existing.status === "waiting-file";
      if (!promotable) {
        if (existing.status === "waiting-file") summary.waitingFile += 1;
        else if (existing.status === "waiting-config")
          summary.waitingConfig += 1;
        summary.skipped += 1;
        continue;
      }
      removeFromJobs(key);
      clearWaitingTimer(key);
    }
    if (existing && hasBody(existing.status) && !options.force) {
      const prepared = await findPreparedBody(
        pdf,
        existing.hostedAttachmentKey,
      );
      if (prepared) {
        await restoreRowFromPrepared(pdf, prepared, existing);
        summary.skipped += 1;
        continue;
      }
    }
    if (existing?.status === "read-only" && !options.force) {
      summary.skipped += 1;
      continue;
    }
    if (existing?.status === "unsupported" && !options.force) {
      summary.skipped += 1;
      continue;
    }
    if (!existing && !options.force) {
      const prepared = await findPreparedBody(pdf);
      if (prepared) {
        await restoreRowFromPrepared(pdf, prepared);
        summary.skipped += 1;
        continue;
      }
    }
    if (pdf.parentItemKey) {
      const itemKey = stateKey(pdf.libraryID, pdf.parentItemKey);
      if (states.get(itemKey)?.status === "no-pdf") {
        states.delete(itemKey);
      }
    }
    ensureRow(pdf, {
      status: "queued",
      reason: undefined,
      detail: undefined,
      lastAttemptError: undefined,
      progress: undefined,
      title: displayTitle(pdf),
    });
    jobOptions.set(key, {
      automatic: false,

      force: options.force === true,
      previousStatus:
        existing && hasBody(existing.status) ? existing.status : undefined,
      resumeJobId: existing ? resumeJobFor(existing, settings) : undefined,
    });
    pushJob(key);
    summary.queued += 1;
  }
  publishSoon();
  scheduleSave();
  void pump();
  scheduleKick();
  return summary;
}

async function restoreRowFromPrepared(
  pdf: Zotero.Item,
  prepared: PreparedBodyRef,
  existing?: PrepState,
): Promise<PrepState> {
  const key = stateKey(pdf.libraryID, pdf.key);
  const meta = prepared.meta;
  const status: PrepStatus = prepared.fresh
    ? meta.status === "partial"
      ? "partial"
      : "done"
    : "stale";
  let source: SourceFingerprint;
  try {
    source =
      (await sourceFingerprintFromItem(pdf)) ?? fingerprintFromMeta(pdf, meta);
  } catch {
    source = fingerprintFromMeta(pdf, meta);
  }
  const row: PrepState = {
    ...(existing ?? { attempts: 0 }),
    key,
    attachmentKey: pdf.key,
    parentKey: pdf.parentItemKey || undefined,
    libraryID: pdf.libraryID,
    title: displayTitle(pdf),
    status,
    attempts: existing?.attempts ?? 0,
    quality: existing?.quality ?? qualityFromLevel(meta.quality),
    parserId: meta.parser,
    pageCount: meta.pageCount || source.pageCount,
    source,
    remote: meta.remote,
    reason: undefined,
    detail: undefined,
    progress: undefined,
    updatedAt: Date.now(),
    hostedAttachmentKey: prepared.attachment.key,
  };
  states.set(key, row);
  rememberItem(pdf, key);
  rememberHosted(prepared.attachment, pdf.key);
  scheduleSave();
  return row;
}

/** Fingerprint reconstructed from stored metadata when the file is missing. */
function fingerprintFromMeta(
  pdf: Zotero.Item,
  meta: import("./types").HostedBodyMeta,
): SourceFingerprint {
  return {
    attachmentKey: pdf.key,
    parentKey: pdf.parentItemKey || undefined,
    libraryID: pdf.libraryID,
    filename: "",
    md5: meta.md5,
    size: meta.size,
    mtime: meta.mtime,
    pageCount: meta.pageCount,
  };
}

function isRowActive(status: PrepStatus): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting-file" ||
    status === "waiting-config"
  );
}

function findRowFor(itemOrKey: Zotero.Item | string): PrepState | undefined {
  if (typeof itemOrKey === "string") {
    return (
      states.get(itemOrKey) ||
      [...states.values()].find(
        (row) => row.attachmentKey === itemOrKey || row.key === itemOrKey,
      )
    );
  }
  if (!itemOrKey) return undefined;
  if (itemOrKey.isPDFAttachment()) {
    return getStateForPDF(itemOrKey);
  }
  if (!itemOrKey.isRegularItem()) return undefined;
  return [...states.values()].find(
    (row) =>
      row.libraryID === itemOrKey.libraryID &&
      row.attachmentKey &&
      itemOrKey.getAttachments().some((id: number) => {
        const child = Zotero.Items.get(id);
        return Boolean(child && child.key === row.attachmentKey);
      }),
  );
}

export async function retryItem(
  itemOrKey: Zotero.Item | string,
  options: EnqueueOptions = {},
): Promise<boolean> {
  const row = findRowFor(itemOrKey);
  if (!row) return false;
  const pdf = await resolvePDFAsync(row.libraryID, row.attachmentKey);
  if (!pdf) {
    patchState(row.key, {
      status: "failed",
      reason: "no-pdf-attachment",
      detail: "source-pdf-missing",
    });
    return false;
  }
  const summary = await enqueueItems([pdf], {
    force: options.force,
  });
  return summary.queued > 0;
}

export function cancel(key: string): boolean {
  const row = states.get(key);
  if (!row) return false;
  if (running?.key === key) {
    running.cancelled = true;
    try {
      running.controller?.abort();
    } catch {
      /* Ignore an unavailable optional host API. */
    }
  }
  removeFromJobs(key);
  clearWaitingTimer(key);
  patchState(key, {
    status: "cancelled",
    reason: "cancelled",
    progress: undefined,
    detail: "cancelled-remote-may-continue",
    remote: undefined,
  });
  return true;
}

function removeFromJobs(key: string) {
  let index = jobs.indexOf(key);
  while (index >= 0) {
    jobs.splice(index, 1);
    index = jobs.indexOf(key);
  }
}

export function resumePending(): void {
  if (!initialized) return;
  const settings = readSettings();
  for (const row of [...states.values()]) {
    if (
      row.status === "waiting-config" ||
      row.status === "queued" ||
      row.status === "waiting-file"
    ) {
      const resumeJobId = resumeJobFor(row, settings);
      jobOptions.set(row.key, {
        automatic: true,
        force: false,
        resumeJobId,
      });
      if (row.status !== "queued" || resumeJobId) {
        patchState(row.key, {
          status: "queued",
          reason: undefined,
          detail: resumeJobId ? "resume-restart" : undefined,
          progress: undefined,
        });
      }
      pushJob(row.key);
    }
  }
  publishSoon();
  scheduleSave();
  void pump();
  scheduleKick();
}

async function recoverQueuedRows(): Promise<void> {
  if (!initialized || disposed) return;
  let recovered = 0;
  for (const row of [...states.values()]) {
    if (row.status !== "queued") continue;
    if (running?.key === row.key || jobs.includes(row.key)) continue;
    const pdf = await resolvePDFAsync(row.libraryID, row.attachmentKey);
    if (!initialized || disposed) return;
    if (states.get(row.key)?.status !== "queued") continue;
    if (running?.key === row.key || jobs.includes(row.key)) continue;
    if (!pdf) {
      patchState(row.key, {
        status: "failed",
        reason: "internal-error",
        detail: "source-pdf-missing",
        progress: undefined,
      });
      continue;
    }
    if (!jobOptions.has(row.key)) {
      const settings = readSettings();
      jobOptions.set(row.key, {
        automatic: true,
        force: false,
        resumeJobId: resumeJobFor(row, settings),
      });
    }
    pushJob(row.key);
    recovered += 1;
  }
  if (recovered > 0) {
    log(`queue recovered ${recovered} stranded queued row(s)`);
    scheduleSave();
  }
  void pump();
}

function scheduleKick(delay = 600): void {
  if (kickTimer !== undefined || !initialized || disposed) return;
  const timer = schedule(() => {
    kickTimer = undefined;
    void recoverQueuedRows();
  }, delay);
  if (timer !== undefined) kickTimer = timer;
}

async function pump(): Promise<void> {
  if (pumping || !initialized || disposed) return;
  pumping = true;
  try {
    while (!disposed) {
      const key = jobs.shift();
      if (!key) break;
      const options = jobOptions.get(key) ?? { automatic: true, force: false };
      if (!states.has(key)) {
        jobOptions.delete(key);
        continue;
      }
      try {
        await runJob(key, options);
      } catch (error) {
        const message = describeError(error);
        log(`queue job failed: ${message}`);
        if (running?.key === key) running = undefined;
        const row = states.get(key);
        if (row) {
          const keptStatus = hasBody(options.previousStatus ?? "queued")
            ? options.previousStatus
            : undefined;
          const statusPatch: Partial<PrepState> = keptStatus
            ? { status: keptStatus }
            : { status: "failed", reason: "internal-error" };
          patchState(key, {
            ...statusPatch,
            detail: message,
            progress: undefined,
            lastAttemptError: message,
          });
          void flushJournal();
        }
      }
      jobOptions.delete(key);
    }
  } finally {
    pumping = false;
    publishSoon();
    if (!disposed) {
      if (jobs.length > 0) {
        void pump();
      } else {
        scheduleKick();
      }
    }
  }
}

async function runJobAttempt(key: string, options: JobOptions): Promise<void> {
  const row = states.get(key);
  if (!row) return;
  if (!isRowActive(row.status)) return;
  const previousStatus = row.status;
  const pdf = await resolvePDFAsync(row.libraryID, row.attachmentKey);
  if (!pdf) {
    patchState(key, {
      status: "failed",
      reason: "internal-error",
      detail: "source-pdf-missing",
      progress: undefined,
    });
    return;
  }
  rememberItem(pdf, key);
  const settings = readSettings();
  const previousRemote = row.remote;
  const previousHostedKey = row.hostedAttachmentKey;
  running = { key, controller: undefined, cancelled: false };
  patchState(key, {
    status: "running",
    attempts: (row.attempts ?? 0) + 1,
    progress: { stage: "converting" },
    reason: undefined,
    detail: undefined,
  });
  if (!settings.enabled) {
    patchState(key, {
      status: "waiting-config",
      reason: "paddle-not-configured",
      detail: "markdown-disabled",
      progress: undefined,
    });
    return;
  }
  if (!isLibraryWritable(pdf.libraryID)) {
    patchState(key, {
      status: "read-only",
      detail: "library-read-only",
      progress: undefined,
      reason: undefined,
    });
    return;
  }

  let pdfPath: string | false = false;
  try {
    pdfPath = await pdf.getFilePathAsync();
  } catch {
    /* Ignore an unavailable optional host API. */
  }
  if (!pdfPath) {
    await markWaitingFile(key, options);
    return;
  }
  let fingerprint: SourceFingerprint | undefined;
  try {
    fingerprint = await sourceFingerprintFromItem(pdf);
  } catch (error) {
    patchState(key, {
      status: "failed",
      reason: "paddle-invalid-output",
      detail: `fingerprint-failed: ${String(error)}`,
      progress: undefined,
    });
    return;
  }
  if (!fingerprint) {
    await markWaitingFile(key, options);
    return;
  }

  const configVersion = readParserConfigVersion(settings);
  const cacheInput = {
    md5: fingerprint.md5,
    size: fingerprint.size,
    mtime: fingerprint.mtime,
    parserId: settings.provider,
    converterVersion: CONVERTER_VERSION,
    configVersion,
  };
  if (!options.force) {
    const cached = await findCacheEntry(await loadCacheIndex(), cacheInput);
    if (cached) {
      const entry = await loadCacheEntry(cached.dir);
      if (
        entry &&
        entry.meta.sourceKey === pdf.key &&
        bodySha1(entry.markdown) === entry.meta.bodySha1
      ) {
        await promoteCachedBody(
          key,
          pdf,
          fingerprint,
          entry,
          options.previousStatus,
          previousHostedKey,
        );
        return;
      }
      await dropCacheEntry(cached.dir);
    }
  }

  const gate = await resolveCloudGate({
    settings,

    automatic: options.automatic,
  });
  if (!gate.ok) {
    patchState(key, {
      status: gate.status as PrepStatus,
      reason: gate.reason,
      detail: options.resumeJobId
        ? `resume-blocked:${gate.detail ?? "waiting"}`
        : gate.detail,
      progress: undefined,
    });
    return;
  }

  const controller = createAbortController();
  if (running?.key === key) running.controller = controller;
  patchState(key, { progress: { stage: "uploading" } });

  let outcome: ParseOutcome;
  try {
    const parseOptions: ParseOptions = {
      apiKey: gate.apiKey,

      isCancelled: () => Boolean(running?.cancelled),
      ...(controller ? { cancelSignal: controller.signal } : {}),
      onProgress: (event: ProgressEvent) => {
        if (states.get(key)?.status === "running") {
          patchState(key, { progress: event });
        }
      },
      onSubmitted: (remote: RemoteInfo) => {
        const prior = states.get(key)?.remote ?? previousRemote;
        patchState(key, {
          remote: mergeRemote(prior, remote),
          detail: "resume-polling",
        });
        void flushJournal();
      },
      ...(options.resumeJobId ? { resumeJobId: options.resumeJobId } : {}),
    };
    outcome = await gate.source.parse(
      { attachment: pdf, pdfPath, fingerprint },
      parseOptions,
    );
  } catch (error) {
    outcome = {
      ok: false,
      status: "failed",
      reason: "internal-error",
      detail: String(error),
    };
  }
  const cancelledDuringRun = Boolean(running?.cancelled);
  running = undefined;

  if (cancelledDuringRun || states.get(key)?.status === "cancelled") {
    patchState(key, {
      status: "cancelled",
      reason: "cancelled",
      progress: undefined,
    });
    return;
  }
  if (!outcome.ok) {
    await applyParseFailure(
      key,
      outcome,
      fingerprint,
      options.previousStatus ?? previousStatus,
      previousRemote,
    );
    return;
  }

  const body = outcome.body;
  const status = outcome.status;
  let cachedOk = false;
  try {
    await cacheParsedBody(body, { status, configVersion });
    cachedOk = true;
  } catch (error) {
    log("cache write failed", error);
  }

  const result = await writeHostedBody(pdf, body, {
    status,
    configVersion,
    force: options.force,
  });

  if (!result.ok) {
    if (result.reason === "user-modified-body") {
      patchState(key, {
        status: previousStatus,
        progress: undefined,
        lastAttemptError: "user-modified-body",
        remote: previousRemote,
      });
      return;
    }
    if (result.reason === "read-only") {
      patchState(key, {
        status: "read-only",
        progress: undefined,
        quality: body.quality,
        source: fingerprint,
      });
      return;
    }

    if (result.existing?.valid) {
      const keptStatus = hasBody(options.previousStatus ?? previousStatus)
        ? (options.previousStatus ?? previousStatus)
        : "stale";
      patchState(key, {
        status: keptStatus,
        progress: undefined,
        lastAttemptError: `hosted-write-failed: ${result.detail ?? result.reason}`,
        remote: previousRemote,
      });
      return;
    }
    patchState(key, {
      status: "failed",
      reason: "internal-error",
      detail: result.detail,
      progress: undefined,
      lastAttemptError: result.detail,
    });
    return;
  }
  rememberHosted(result.attachment, pdf.key);
  patchState(key, {
    status,
    quality: body.quality,
    source: fingerprint,
    parserId: body.parserId,
    pageCount: body.source.pageCount,
    hostedAttachmentKey: result.hostedAttachmentKey,
    remote: mergeRemote(previousRemote, body.remote),
    reason: undefined,
    detail: undefined,
    progress: undefined,
    lastAttemptError: undefined,
  });
  if (!cachedOk) {
    log("prepared body exists but its cache entry is missing", key);
  }
}

async function runJob(key: string, options: JobOptions): Promise<void> {
  try {
    await runJobAttempt(key, options);
  } finally {
    if (running?.key === key) running = undefined;
  }
}

async function promoteCachedBody(
  key: string,
  pdf: Zotero.Item,
  fingerprint: SourceFingerprint,
  entry: {
    meta: HostedBodyMeta;
    markdown: string;
    resources: import("./types").HostedResource[];
  },
  previousStatus?: PrepStatus,
  _previousHostedKey?: string,
): Promise<void> {
  try {
    const result = await writeHostedFromCache(pdf, entry, { force: false });

    if (!result.ok) {
      if (
        result.reason === "user-modified-body" ||
        result.reason === "read-only" ||
        result.existing?.valid
      ) {
        const keptStatus: PrepStatus =
          result.reason === "read-only"
            ? "read-only"
            : previousStatus && hasBody(previousStatus)
              ? previousStatus
              : result.existing?.valid
                ? "stale"
                : states.get(key)?.status === "queued"
                  ? "failed"
                  : (states.get(key)?.status ?? "failed");
        patchState(key, {
          status: keptStatus,
          progress: undefined,
          detail: result.reason,
          lastAttemptError: result.detail ?? result.reason,
        });
        return;
      }
      patchState(key, {
        status: "failed",
        reason: "internal-error",
        detail: result.detail,
        progress: undefined,
        lastAttemptError: result.detail,
      });
      return;
    }
    rememberHosted(result.attachment, pdf.key);
    patchState(key, {
      status: entry.meta.status === "partial" ? "partial" : "done",
      quality: qualityFromLevel(entry.meta.quality),
      source: fingerprint,
      parserId: entry.meta.parser,
      pageCount: entry.meta.pageCount,
      hostedAttachmentKey: result.hostedAttachmentKey,
      remote: entry.meta.remote,
      reason: undefined,
      detail: undefined,
      progress: undefined,
      lastAttemptError: undefined,
    });
  } catch (error) {
    patchState(key, {
      status: "failed",
      reason: "internal-error",
      detail: `cache-promote-failed: ${String(error)}`,
      progress: undefined,
    });
  }
}

/** Minimal Quality reconstruction for a body restored from the cache. */
function qualityFromLevel(
  level: import("./types").QualityLevel,
): import("./types").Quality {
  return {
    level,
    textLayer: "ocr",
    structure: level === "high" ? "full" : "partial",
    tables: level === "high" ? "preserved" : "text",
    equations: level === "high" ? "latex" : "text",
    images: level === "high" ? "embedded" : "placeholder",
    caveats: [],
  };
}
async function markWaitingFile(key: string, options: JobOptions) {
  patchState(key, {
    status: "waiting-file",
    reason: "file-not-downloaded",
    detail: "pdf-file-not-available",
    progress: undefined,
  });
  const previous = waitingAttempts.get(key) ?? 0;
  if (previous >= 5) return;
  waitingAttempts.set(key, previous + 1);
  const delay = Math.min(120_000, 15_000 * 2 ** previous);
  const timer = schedule(() => {
    waitingTimers.delete(key);
    if (!initialized || disposed) return;
    if (states.get(key)?.status !== "waiting-file") return;
    jobOptions.set(key, options);
    pushJob(key);
    void pump();
  }, delay);
  if (timer === undefined) return;
  clearWaitingTimer(key);
  waitingTimers.set(key, timer);
}

function clearWaitingTimer(key: string) {
  const timer = waitingTimers.get(key);
  if (timer === undefined) return;
  clearTimer(timer);
  waitingTimers.delete(key);
}

async function applyParseFailure(
  key: string,
  outcome: Extract<ParseOutcome, { ok: false }>,
  fingerprint: SourceFingerprint,
  previousStatus: PrepStatus,
  previousRemote: RemoteInfo | undefined,
) {
  const previous = states.get(key);
  const pdf = previous
    ? await resolvePDFAsync(previous.libraryID, previous.attachmentKey)
    : undefined;
  let keepOld = false;
  if (previous && hasBody(previousStatus) && pdf) {
    try {
      keepOld = Boolean(
        await findPreparedBody(pdf, previous.hostedAttachmentKey),
      );
    } catch {
      keepOld = false;
    }
  }
  if (keepOld && previous) {
    patchState(key, {
      status: staleStatusFor(
        { ...previous, status: previousStatus },
        fingerprint,
      ),
      progress: undefined,
      lastAttemptError: `${outcome.reason}: ${outcome.detail ?? ""}`.trim(),
      source: fingerprint,
      remote: previousRemote,
    });
    return;
  }
  patchState(key, {
    status: outcome.status,
    reason: outcome.reason,
    detail: outcome.detail,
    progress: undefined,
    lastAttemptError: `${outcome.reason}: ${outcome.detail ?? ""}`.trim(),
    remote: undefined,
  });
}

function registerNotifier() {
  try {
    notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (
          event: string,
          type: string,
          ids: (number | string)[] | number | string,
          extraData?: Record<string, any>,
        ) => {
          if (type !== "item") return;
          const items = Array.isArray(ids) ? ids : [ids];
          void handleItemNotification(event, items.map(Number), extraData);
        },
      },
      ["item"],
      config.addonRef,
    );
  } catch (error) {
    log("notifier registration failed", error);
  }
}

async function handleItemNotification(
  event: string,
  ids: number[],
  extraData?: Record<string, any>,
) {
  if (!initialized || disposed) return;
  try {
    if (event === "delete") {
      await handleDeleted(ids, extraData);
      return;
    }
    if (event !== "add" && event !== "modify") return;
    const items = await Zotero.Items.getAsync(ids);
    for (const item of items) {
      if (!item.isPDFAttachment()) continue;
      if (event === "add") await observeNewPDF(item);
      else await observeModifiedPDF(item);
    }
  } catch (error) {
    log("notifier handling failed", error);
  }
}

export async function observeNewPDF(pdf: Zotero.Item) {
  const settings = readSettings();
  if (!settings.enabled || !settings.autoOnImport) return;
  const key = stateKey(pdf.libraryID, pdf.key);
  const existing = states.get(key);
  if (
    existing &&
    existing.status !== "cancelled" &&
    existing.status !== "failed" &&
    existing.status !== "no-pdf"
  ) {
    return;
  }
  ensureRow(pdf, { status: "queued", title: displayTitle(pdf) });
  jobOptions.set(key, { automatic: true, force: false });
  pushJob(key);
  publishSoon();
  scheduleSave();
  void pump();
}

async function observeModifiedPDF(pdf: Zotero.Item) {
  const key = stateKey(pdf.libraryID, pdf.key);
  const row = states.get(key);
  if (!row) return;
  if (row.status === "waiting-file") {
    jobOptions.set(key, { automatic: true, force: false });
    pushJob(key);
    void pump();
    return;
  }
  if (!row.source || !hasBody(row.status)) return;
  let current: SourceFingerprint | undefined;
  try {
    current = await sourceFingerprintFromItem(pdf);
  } catch {
    return;
  }
  if (!current) return;
  if (
    current.md5 === row.source.md5 &&
    current.size === row.source.size &&
    current.mtime === row.source.mtime
  ) {
    return;
  }
  patchState(key, {
    status: "stale",
    detail: "source-pdf-changed",
    progress: undefined,
  });
}

async function handleDeleted(ids: number[], extraData?: Record<string, any>) {
  for (const id of ids) {
    const extra = extraData?.[id] ?? extraData?.[String(id)];
    const extraKey =
      typeof extra?.key === "string"
        ? extra.key
        : typeof extra?.old?.key === "string"
          ? extra.old.key
          : undefined;
    const extraLibraryID =
      typeof extra?.libraryID === "number"
        ? extra.libraryID
        : typeof extra?.old?.libraryID === "number"
          ? extra.old.libraryID
          : undefined;
    const stateKeyForItem =
      itemIDToStateKey.get(id) ??
      (extraKey && extraLibraryID !== undefined
        ? states.get(stateKey(extraLibraryID, extraKey))?.key
        : undefined);
    if (stateKeyForItem) {
      await cleanupDeletedSource(stateKeyForItem);
      continue;
    }
    const sourceKey = hostedItemIDToSource.get(id);
    hostedItemIDToSource.delete(id);
    if (sourceKey || extraKey) {
      for (const row of states.values()) {
        const matchesSource = sourceKey && row.attachmentKey === sourceKey;
        const matchesHosted =
          extraKey &&
          row.hostedAttachmentKey === extraKey &&
          (extraLibraryID === undefined || row.libraryID === extraLibraryID);
        if (!matchesSource && !matchesHosted) continue;
        if (row.hostedAttachmentKey) {
          patchState(row.key, {
            hostedAttachmentKey: undefined,
            detail: "hosted-body-deleted",
          });
        }
      }
    }
  }
}

async function cleanupDeletedSource(key: string) {
  const row = states.get(key);
  if (!row) return;
  states.delete(key);
  itemIDToStateKey.delete(stateKeyToItemID(key));
  for (const [itemID, mapped] of itemIDToStateKey) {
    if (mapped === key) itemIDToStateKey.delete(itemID);
  }
  for (const [hostedID, sourceKey] of hostedItemIDToSource) {
    if (sourceKey === row.attachmentKey) hostedItemIDToSource.delete(hostedID);
  }
  if (row.hostedAttachmentKey) {
    try {
      const hosted =
        Zotero.Items.getByLibraryAndKey(
          row.libraryID,
          row.hostedAttachmentKey,
        ) ||
        (await Zotero.Items.getByLibraryAndKeyAsync(
          row.libraryID,
          row.hostedAttachmentKey,
        ));
      if (hosted) {
        const read = await readHostedAttachment(hosted);
        if (read && read.meta.sourceKey === row.attachmentKey) {
          await hosted.eraseTx();
        }
      }
    } catch (error) {
      log("could not remove hosted body of deleted PDF", error);
    }
  }
  publishSoon();
  scheduleSave();
}

function stateKeyToItemID(key: string): number {
  for (const [itemID, mapped] of itemIDToStateKey) {
    if (mapped === key) return itemID;
  }
  return -1;
}
/** Remove terminal rows only; generated attachments remain available for discovery. */
export function clearFinishedStates(): number {
  let count = 0;
  for (const [key, row] of states) {
    if (isRowActive(row.status) || running?.key === key || jobs.includes(key))
      continue;
    states.delete(key);
    jobOptions.delete(key);
    clearWaitingTimer(key);
    count++;
  }
  if (count) {
    publishSoon();
    scheduleSave();
  }
  return count;
}
/** Wait for a cancelled writer before deleting its managed attachment. */
export async function deleteBodyForPDF(pdf: Zotero.Item): Promise<boolean> {
  const key = stateKey(pdf.libraryID, pdf.key);
  cancel(key);
  if (running?.key === key) await queueIdle();
  const deleted = await deleteStoredBody(
    pdf,
    states.get(key)?.hostedAttachmentKey,
  );
  if (deleted) {
    states.delete(key);
    jobOptions.delete(key);
    clearWaitingTimer(key);
    publishSoon();
    scheduleSave();
  }
  return deleted;
}
export const collectTargets = collectPDFs;

/**
 * Non-blocking PDF reader hover overlay for recognized figures, tables and
 * display equations (Option A): hovering reveals a click-through outline and a
 * compact top-right corner bar with 1-click "AI Explain" and "Annotate".
 *
 * Also adds a reader toolbar toggle button (`reader.visualOverlay`) so the
 * user can turn hover frames on/off at any time.
 */
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { asItem } from "../utils/reader";
import { targetFor, type Target } from "./context";
import {
  pickVisualTargetAtPoint,
  type NormRect,
  type PageVisualTarget,
} from "./markdownPrep/readerAlign";
import {
  createNativeVisualAnnotation,
  getReaderLayoutVersion,
  loadPageVisualTargets,
  resolveVisualTargetForAI,
} from "./markdownPrep/readerBridge";
import { addVisualTargetToChat } from "./selectionPopup";

type ToolbarEvent = _ZoteroTypes.Reader.EventParams<"renderToolbar">;

type TimerFn = (handler: () => void, ms?: number) => number;
type ClearTimerFn = (id: number) => void;

type ViewBinding = {
  doc: Document;
  dispose: () => void;
  hide: () => void;
};

type ReaderController = {
  reader: _ZoteroTypes.ReaderInstance;
  bindings: Map<object, ViewBinding>;
  retryTimer?: number;
  disposed: boolean;
};

const controllers = new Map<string, ReaderController>();
const toggleButtons = new Set<HTMLButtonElement>();
let registered = false;

function schedule(fn: () => void, ms: number): number | undefined {
  try {
    const set = ztoolkit.getGlobal("setTimeout") as unknown as
      TimerFn | undefined;
    return set ? set(fn, ms) : undefined;
  } catch {
    return undefined;
  }
}

function unschedule(id: number | undefined): void {
  if (id === undefined) return;
  try {
    const clear = ztoolkit.getGlobal("clearTimeout") as unknown as
      ClearTimerFn | undefined;
    clear?.(id);
  } catch {
    // Ignore shutdown races.
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function isOverlayEnabled(): boolean {
  return getPref("reader.visualOverlay") !== false;
}

function applyToolbarButtonState(
  button: HTMLButtonElement,
  enabled: boolean,
): void {
  const label = getString(
    enabled ? "visual-overlay-toggle-on" : "visual-overlay-toggle-off",
  );
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(enabled));
  button.classList.toggle("glossa-active", enabled);
  button.classList.toggle("glossa-off", !enabled);
  button.innerHTML = enabled ? FRAME_ICON_ON_SVG : FRAME_ICON_OFF_SVG;
}

function syncToolbarButtons(): void {
  const enabled = isOverlayEnabled();
  for (const button of [...toggleButtons]) {
    if (!button.isConnected) {
      toggleButtons.delete(button);
      continue;
    }
    applyToolbarButtonState(button, enabled);
  }
  if (!enabled) {
    for (const ctrl of controllers.values()) {
      for (const binding of ctrl.bindings.values()) binding.hide();
    }
  }
}

function readerTarget(reader: _ZoteroTypes.ReaderInstance): Target | undefined {
  const attachment = reader.itemID
    ? asItem(Zotero.Items.get(reader.itemID))
    : undefined;
  if (!attachment || !attachment.isPDFAttachment()) return undefined;
  return targetFor(attachment.parentItem || attachment, attachment);
}

function decodeBase64(value: string): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = value.replace(/\s+/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === "=") break;
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Crop `bbox` from PDF.js's rendered page `<canvas>` using `toDataURL` (plain
 * string across Gecko's Xray boundary — avoids cross-compartment callbacks).
 */
function cropPageCanvas(
  pdfDoc: Document,
  pageEl: HTMLElement,
  bbox: NormRect,
): { bytes: Uint8Array; mime: string } | undefined {
  try {
    const src = pageEl.querySelector("canvas") as HTMLCanvasElement | null;
    if (!src || !src.width || !src.height) return undefined;
    const sx = Math.max(0, Math.floor(bbox[0] * src.width));
    const sy = Math.max(0, Math.floor(bbox[1] * src.height));
    const sw = Math.min(
      src.width - sx,
      Math.max(1, Math.ceil((bbox[2] - bbox[0]) * src.width)),
    );
    const sh = Math.min(
      src.height - sy,
      Math.max(1, Math.ceil((bbox[3] - bbox[1]) * src.height)),
    );
    if (sw < 2 || sh < 2) return undefined;
    const maxEdge = 1600;
    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const out = pdfDoc.createElement("canvas") as HTMLCanvasElement;
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    const ctx = out.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return undefined;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const dataUrl = out.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return undefined;
    const bytes = decodeBase64(dataUrl.slice(comma + 1));
    return bytes.byteLength ? { bytes, mime: "image/png" } : undefined;
  } catch (error) {
    ztoolkit.log("[Glossa] page canvas crop failed", error);
    return undefined;
  }
}

function shouldSuppressForTool(reader: _ZoteroTypes.ReaderInstance): boolean {
  const tool = safe(() => reader._internalReader?.toolType);
  return tool === "hand" || tool === "ink" || tool === "eraser";
}

function kindLabel(kind: PageVisualTarget["kind"]): string {
  if (kind === "table") return getString("visual-kind-table");
  if (kind === "equation") return getString("visual-kind-equation");
  return getString("visual-kind-figure");
}

function bindPdfView(
  reader: _ZoteroTypes.ReaderInstance,
  pdfWin: Window,
  pdfDoc: Document,
): ViewBinding | undefined {
  const viewer =
    pdfDoc.getElementById("viewer") ||
    (pdfDoc.querySelector(".pdfViewer") as HTMLElement | null);
  if (!viewer) return undefined;

  let styleEl = pdfDoc.getElementById(
    "glossa-visual-overlay-style",
  ) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = pdfDoc.createElement("style");
    styleEl.id = "glossa-visual-overlay-style";
    styleEl.textContent = OVERLAY_STYLE;
    (pdfDoc.head || pdfDoc.documentElement)?.appendChild(styleEl);
  }

  const frame = pdfDoc.createElement("div");
  frame.className = "glossa-visual-frame";
  frame.hidden = true;

  const bar = pdfDoc.createElement("div");
  bar.className = "glossa-visual-bar";
  bar.hidden = true;

  const badge = pdfDoc.createElement("span");
  badge.className = "glossa-visual-badge";

  const addChatBtn = pdfDoc.createElement("button");
  addChatBtn.type = "button";
  addChatBtn.className = "glossa-visual-btn glossa-visual-btn-primary";
  addChatBtn.textContent = getString("visual-action-chat");

  const annotateBtn = pdfDoc.createElement("button");
  annotateBtn.type = "button";
  annotateBtn.className = "glossa-visual-btn glossa-visual-btn-secondary";
  annotateBtn.textContent = getString("visual-action-annotate");

  bar.append(badge, addChatBtn, annotateBtn);

  let activeTarget: PageVisualTarget | undefined;
  let activePageEl: HTMLElement | undefined;
  let pointerInBar = false;
  let disposed = false;
  let moveSeq = 0;
  let hideTimer: number | undefined;
  let throttleTimer: number | undefined;
  let feedbackTimer: number | undefined;
  let chatFeedbackTimer: number | undefined;
  let pendingMove:
    { target: EventTarget | null; x: number; y: number } | undefined;
  const inFlightPages = new Set<number>();
  const resolvedPages = new Map<
    number,
    { version: string; list: PageVisualTarget[] }
  >();

  const hide = () => {
    moveSeq++;
    unschedule(hideTimer);
    hideTimer = undefined;
    activeTarget = undefined;
    activePageEl = undefined;
    frame.hidden = true;
    bar.hidden = true;
    if (frame.parentNode) frame.parentNode.removeChild(frame);
    if (bar.parentNode) bar.parentNode.removeChild(bar);
  };

  const scheduleHide = () => {
    unschedule(hideTimer);
    hideTimer = schedule(() => {
      if (!pointerInBar) hide();
    }, 180);
  };

  const showTarget = (pageEl: HTMLElement, hit: PageVisualTarget) => {
    unschedule(hideTimer);
    hideTimer = undefined;
    if (
      activeTarget &&
      activeTarget.id === hit.id &&
      activePageEl === pageEl &&
      !frame.hidden
    ) {
      return;
    }
    activeTarget = hit;
    activePageEl = pageEl;
    const [x1, y1, x2, y2] = hit.bbox;
    frame.style.left = `${x1 * 100}%`;
    frame.style.top = `${y1 * 100}%`;
    frame.style.width = `${(x2 - x1) * 100}%`;
    frame.style.height = `${(y2 - y1) * 100}%`;
    frame.hidden = false;

    badge.textContent = kindLabel(hit.kind);
    unschedule(feedbackTimer);
    unschedule(chatFeedbackTimer);
    annotateBtn.textContent = getString("visual-action-annotate");
    annotateBtn.disabled = false;
    addChatBtn.textContent = getString("visual-action-chat");
    addChatBtn.disabled = false;

    // Place the compact action pill at the top-right of the frame; for short
    // boxes (like display equations) float just above the top border so the
    // equation itself stays uncovered, and clamp horizontally inside the page.
    const pageW = pageEl.clientWidth || 1;
    const pageH = pageEl.clientHeight || 1;
    const boxH = (y2 - y1) * pageH;
    const rawRight = Math.max(4, Math.round((1 - x2) * pageW) + 6);
    const maxRight = Math.max(4, pageW - 220);
    const rightOffset = Math.min(rawRight, maxRight);
    const topPx =
      boxH < 72 && y1 * pageH >= 34
        ? Math.round(y1 * pageH) - 30
        : Math.max(4, Math.min(pageH - 36, Math.round(y1 * pageH) + 6));
    bar.style.right = `${rightOffset}px`;
    bar.style.top = `${topPx}px`;
    bar.style.left = "auto";
    bar.hidden = false;

    if (frame.parentNode !== pageEl) pageEl.appendChild(frame);
    if (bar.parentNode !== pageEl) pageEl.appendChild(bar);
  };

  const evaluatePointer = (
    eventTarget: EventTarget | null,
    clientX: number,
    clientY: number,
  ) => {
    const seq = ++moveSeq;
    if (disposed || !isOverlayEnabled() || shouldSuppressForTool(reader)) {
      hide();
      return;
    }
    const sel = safe(() => pdfWin.getSelection()?.toString());
    if (sel && sel.trim()) {
      hide();
      return;
    }
    const node = eventTarget as HTMLElement | null;
    if (node && (node === bar || bar.contains(node))) {
      unschedule(hideTimer);
      return;
    }
    const pageEl = safe(
      () => node?.closest?.(".page[data-page-number]") as HTMLElement | null,
    );
    if (!pageEl) {
      scheduleHide();
      return;
    }
    const pageNumber = Number(pageEl.getAttribute("data-page-number"));
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      scheduleHide();
      return;
    }
    const pageIndex = pageNumber - 1;
    const rect = pageEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      scheduleHide();
      return;
    }
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    const target = readerTarget(reader);
    if (!target) {
      hide();
      return;
    }
    const version = getReaderLayoutVersion(target);
    const cached = resolvedPages.get(pageIndex);
    if (cached && cached.version === version) {
      const hit = pickVisualTargetAtPoint(cached.list, nx, ny);
      if (hit) showTarget(pageEl, hit);
      else scheduleHide();
      return;
    }
    if (inFlightPages.has(pageIndex)) return;
    inFlightPages.add(pageIndex);
    void loadPageVisualTargets(reader, target, pageIndex)
      .then((list) => {
        resolvedPages.set(pageIndex, { version, list });
        if (disposed || seq !== moveSeq || !isOverlayEnabled()) return;
        const hit = pickVisualTargetAtPoint(list, nx, ny);
        if (hit) showTarget(pageEl, hit);
      })
      .finally(() => {
        inFlightPages.delete(pageIndex);
      });
  };

  const onMouseMove = (event: MouseEvent) => {
    if (event.buttons !== 0) {
      hide();
      return;
    }
    pendingMove = {
      target: event.target,
      x: event.clientX,
      y: event.clientY,
    };
    if (throttleTimer !== undefined) return;
    throttleTimer = schedule(() => {
      throttleTimer = undefined;
      const move = pendingMove;
      pendingMove = undefined;
      if (move) evaluatePointer(move.target, move.x, move.y);
    }, 32);
  };

  const onMouseDown = (event: MouseEvent) => {
    const node = event.target as HTMLElement | null;
    if (node && (node === bar || bar.contains(node))) return;
    hide();
  };

  const onMouseLeave = () => {
    scheduleHide();
  };

  const onBarEnter = () => {
    pointerInBar = true;
    unschedule(hideTimer);
  };

  const onBarLeave = () => {
    pointerInBar = false;
    scheduleHide();
  };

  const onBarMouseDown = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const onAddChatClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const hit = activeTarget;
    const pageEl = activePageEl;
    const target = readerTarget(reader);
    if (!hit || !pageEl || !target) return;
    addChatBtn.disabled = true;
    const crop = cropPageCanvas(pdfDoc, pageEl, hit.bbox);
    void resolveVisualTargetForAI(target, hit, crop)
      .then((resolved) => {
        if (resolved && addVisualTargetToChat(target, resolved, reader)) {
          addChatBtn.textContent = getString("visual-added-to-chat");
          unschedule(chatFeedbackTimer);
          chatFeedbackTimer = schedule(() => {
            addChatBtn.textContent = getString("visual-action-chat");
            addChatBtn.disabled = false;
          }, 1200);
          return;
        }
        addChatBtn.disabled = false;
      })
      .catch((error) => {
        ztoolkit.log("[Glossa] hover add to chat failed", error);
        addChatBtn.disabled = false;
      });
  };

  const onAnnotateClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const hit = activeTarget;
    const pageEl = activePageEl;
    const target = readerTarget(reader);
    if (!hit || !pageEl || !target) return;
    annotateBtn.disabled = true;
    const crop = cropPageCanvas(pdfDoc, pageEl, hit.bbox);
    void createNativeVisualAnnotation(reader, target, hit, crop)
      .then((outcome) => {
        annotateBtn.textContent = outcome.ok
          ? getString("visual-annotated")
          : getString(
              outcome.reason === "read-only"
                ? "visual-annotate-readonly"
                : "visual-annotate-failed",
            );
        unschedule(feedbackTimer);
        feedbackTimer = schedule(() => {
          annotateBtn.textContent = getString("visual-action-annotate");
          annotateBtn.disabled = false;
        }, 1500);
      })
      .catch((error) => {
        ztoolkit.log("[Glossa] hover annotate failed", error);
        annotateBtn.textContent = getString("visual-annotate-failed");
        annotateBtn.disabled = false;
      });
  };

  viewer.addEventListener("mousemove", onMouseMove, { passive: true });
  viewer.addEventListener("mousedown", onMouseDown, true);
  viewer.addEventListener("mouseleave", onMouseLeave);
  bar.addEventListener("mouseenter", onBarEnter);
  bar.addEventListener("mouseleave", onBarLeave);
  bar.addEventListener("mousedown", onBarMouseDown);
  addChatBtn.addEventListener("click", onAddChatClick);
  annotateBtn.addEventListener("click", onAnnotateClick);

  return {
    doc: pdfDoc,
    hide,
    dispose: () => {
      disposed = true;
      unschedule(hideTimer);
      unschedule(throttleTimer);
      unschedule(feedbackTimer);
      unschedule(chatFeedbackTimer);
      hide();
      safe(() => viewer.removeEventListener("mousemove", onMouseMove));
      safe(() => viewer.removeEventListener("mousedown", onMouseDown, true));
      safe(() => viewer.removeEventListener("mouseleave", onMouseLeave));
      safe(() => bar.removeEventListener("mouseenter", onBarEnter));
      safe(() => bar.removeEventListener("mouseleave", onBarLeave));
      safe(() => bar.removeEventListener("mousedown", onBarMouseDown));
      safe(() => addChatBtn.removeEventListener("click", onAddChatClick));
      safe(() => annotateBtn.removeEventListener("click", onAnnotateClick));
      safe(() => styleEl?.parentNode?.removeChild(styleEl));
    },
  };
}

function attachToReader(reader: _ZoteroTypes.ReaderInstance): void {
  if (safe(() => reader.type) !== "pdf") return;
  const id =
    safe(() => reader._instanceID) ||
    safe(() => reader.tabID) ||
    String(reader.itemID || "");
  if (!id) return;
  let ctrl = controllers.get(id);
  if (!ctrl) {
    ctrl = { reader, bindings: new Map(), disposed: false };
    controllers.set(id, ctrl);
  }
  const tryBind = (attempt: number) => {
    if (!ctrl || ctrl.disposed) return;
    const internal = safe(() => reader._internalReader);
    const views = [
      safe(() => internal?._primaryView),
      safe(() => internal?._secondaryView),
    ].filter(Boolean) as Array<_ZoteroTypes.Reader.PDFView>;
    let boundAny = false;
    for (const view of views) {
      if (ctrl.bindings.has(view)) {
        boundAny = true;
        continue;
      }
      const pdfWin = safe(() => view._iframeWindow);
      const pdfDoc = safe(() => pdfWin?.document);
      if (pdfWin && pdfDoc) {
        const binding = bindPdfView(reader, pdfWin, pdfDoc);
        if (binding) {
          ctrl.bindings.set(view, binding);
          boundAny = true;
        }
      }
    }
    if (!boundAny && attempt < 24) {
      ctrl.retryTimer = schedule(() => tryBind(attempt + 1), 250);
    }
  };
  tryBind(0);
}

function onRenderToolbar(event: ToolbarEvent): void {
  if (safe(() => event.reader.type) !== "pdf") return;
  const doc = event.doc;
  if (!doc.getElementById("glossa-toolbar-style")) {
    const style = doc.createElement("style");
    style.id = "glossa-toolbar-style";
    style.textContent = TOOLBAR_BTN_STYLE;
    (doc.head || doc.documentElement)?.appendChild(style);
  }
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "toolbar-button glossa-visual-toggle";
  applyToolbarButtonState(button, isOverlayEnabled());
  button.addEventListener("click", () => {
    setPref("reader.visualOverlay", !isOverlayEnabled());
    syncToolbarButtons();
  });
  toggleButtons.add(button);
  event.append(button);
  attachToReader(event.reader);
}

export function registerReaderOverlay(): void {
  if (registered) return;
  registered = true;
  Zotero.Reader.registerEventListener(
    "renderToolbar",
    onRenderToolbar,
    config.addonID,
  );
  const openReaders = safe(() => Zotero.Reader._readers) || [];
  for (const reader of openReaders) {
    attachToReader(reader);
  }
}

export function unregisterReaderOverlay(): void {
  if (!registered) return;
  registered = false;
  Zotero.Reader.unregisterEventListener("renderToolbar", onRenderToolbar);
  for (const ctrl of controllers.values()) {
    ctrl.disposed = true;
    unschedule(ctrl.retryTimer);
    for (const binding of ctrl.bindings.values()) binding.dispose();
    ctrl.bindings.clear();
  }
  controllers.clear();
  for (const button of toggleButtons) {
    safe(() => button.parentNode?.removeChild(button));
  }
  toggleButtons.clear();
}

const FRAME_ICON_ON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M12 2.5h2.5a1 1 0 0 1 1 1V6M15.5 12v2.5a1 1 0 0 1-1 1H12M6 15.5H3.5a1 1 0 0 1-1-1V12"/><rect x="5.5" y="5.5" width="7" height="7" rx="1.2" fill="currentColor" fill-opacity="0.24"/><circle cx="14.2" cy="3.8" r="1.9" fill="#1f9d74" stroke="none"/></svg>';

const FRAME_ICON_OFF_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M12 2.5h2.5a1 1 0 0 1 1 1V6M15.5 12v2.5a1 1 0 0 1-1 1H12M6 15.5H3.5a1 1 0 0 1-1-1V12" opacity="0.65"/><rect x="5.5" y="5.5" width="7" height="7" rx="1.2" opacity="0.55"/><line x1="2.5" y1="15.5" x2="15.5" y2="2.5" stroke-width="1.8"/></svg>';

const TOOLBAR_BTN_STYLE = `
.glossa-visual-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
}
.glossa-visual-toggle.glossa-active {
  opacity: 1 !important;
  color: #1c6b58 !important;
  background: rgba(39, 107, 90, 0.16) !important;
  box-shadow: inset 0 0 0 1px rgba(39, 107, 90, 0.42) !important;
}
.glossa-visual-toggle.glossa-off {
  opacity: 0.7 !important;
  color: #88928d !important;
  background: transparent !important;
  box-shadow: none !important;
}
.glossa-visual-toggle.glossa-off:hover {
  opacity: 0.95 !important;
}
@media (prefers-color-scheme: dark) {
  .glossa-visual-toggle.glossa-active {
    color: #9bd3b6 !important;
    background: rgba(155, 211, 182, 0.22) !important;
    box-shadow: inset 0 0 0 1px rgba(155, 211, 182, 0.48) !important;
  }
  .glossa-visual-toggle.glossa-off {
    color: #8b9891 !important;
  }
}
`;

const OVERLAY_STYLE = `
.glossa-visual-frame {
  position: absolute;
  pointer-events: none;
  z-index: 6;
  box-sizing: border-box;
  border: 2px solid #276b5a;
  border-radius: 4px;
  background: rgba(39, 107, 90, 0.05);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.65);
}
.glossa-visual-frame[hidden],
.glossa-visual-bar[hidden] {
  display: none !important;
}
.glossa-visual-bar {
  position: absolute;
  pointer-events: auto;
  z-index: 7;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 5px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid rgba(39, 107, 90, 0.28);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.16);
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 12px;
  line-height: 1.2;
  user-select: none;
}
.glossa-visual-badge {
  padding: 2px 5px;
  border-radius: 4px;
  background: rgba(39, 107, 90, 0.12);
  color: #276b5a;
  font-size: 11px;
  font-weight: 600;
}
.glossa-visual-btn {
  appearance: none;
  margin: 0;
  padding: 4px 8px;
  border-radius: 5px;
  font: 500 12px/1.2 system-ui, -apple-system, sans-serif;
  cursor: pointer;
  white-space: nowrap;
  transition: filter 0.12s ease, background 0.12s ease;
}
.glossa-visual-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.glossa-visual-btn-primary {
  border: 0;
  background: #276b5a;
  color: #ffffff;
}
.glossa-visual-btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}
.glossa-visual-btn-secondary {
  border: 1px solid #cbd5d0;
  background: #ffffff;
  color: #24332d;
}
.glossa-visual-btn-secondary:hover:not(:disabled) {
  border-color: #276b5a;
  color: #276b5a;
}
@media (prefers-color-scheme: dark) {
  .glossa-visual-frame {
    border-color: #9bd3b6;
    background: rgba(155, 211, 182, 0.08);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
  }
  .glossa-visual-bar {
    background: rgba(33, 42, 38, 0.96);
    border-color: rgba(155, 211, 182, 0.32);
  }
  .glossa-visual-badge {
    background: rgba(155, 211, 182, 0.16);
    color: #9bd3b6;
  }
  .glossa-visual-btn-primary {
    background: #9bd3b6;
    color: #153126;
  }
  .glossa-visual-btn-secondary {
    border-color: #4a5e54;
    background: #27322c;
    color: #e7eee9;
  }
}
`;

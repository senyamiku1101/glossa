import { config } from "../../package.json";
import type { ContextItemInput } from "../utils/contextTray";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { asItem } from "../utils/reader";
import { renderTemplate, targetFor, type Target } from "./context";
import { openGlossaryEditor } from "./glossaryUI";
import { renderMarkdown } from "./markdown";
import type { AlignedSelection } from "./markdownPrep/readerAlign";
import {
  resolveAnnotationContext,
  resolveSelectionMarkdown,
  saveHighlightTranslationAnnotation,
  type ResolvedAnnotationContext,
} from "./markdownPrep/readerBridge";
import { getPdfLayoutParagraph } from "./pdfLayout";
import {
  paragraphFailureStatus,
  type PdfParagraphResult,
} from "./pdfParagraph";
import {
  streamPopupReview,
  streamPopupTranslation,
  type PopupTranslationPiece,
} from "./runner";
import { addContextToChat } from "./sidebar";
import { TRANSLATE_TEMPLATE } from "./tags";

type PopupEvent = _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">;
type AnnotationMenuEvent =
  _ZoteroTypes.Reader.EventParams<"createAnnotationContextMenu">;
type SidebarAnnotationEvent =
  _ZoteroTypes.Reader.EventParams<"renderSidebarAnnotationHeader">;
type TranslationScope = "selection" | "paragraph";

type TimerFn = (handler: () => void, ms?: number) => number;
type ClearTimerFn = (id: number) => void;

const activeInlineCancels = new Set<() => void>();
const activePopupCleanups = new Set<() => void>();

function cancelActiveInlineTranslations(): void {
  for (const cancel of [...activeInlineCancels]) {
    try {
      cancel();
    } catch {
      // Ignore cleanup errors.
    }
  }
  activeInlineCancels.clear();
}

function cleanupActivePopups(): void {
  for (const cleanup of [...activePopupCleanups]) {
    try {
      cleanup();
    } catch {
      // Ignore cleanup errors.
    }
  }
  activePopupCleanups.clear();
}

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

export function registerSelectionPopup() {
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    onPopup,
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "createAnnotationContextMenu",
    onAnnotationMenu,
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "renderSidebarAnnotationHeader",
    onSidebarAnnotationHeader,
    config.addonID,
  );
}

export function unregisterSelectionPopup() {
  cancelActiveInlineTranslations();
  cleanupActivePopups();
  Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", onPopup);
  Zotero.Reader.unregisterEventListener(
    "createAnnotationContextMenu",
    onAnnotationMenu,
  );
  Zotero.Reader.unregisterEventListener(
    "renderSidebarAnnotationHeader",
    onSidebarAnnotationHeader,
  );
}

function resetExpandedPopups(doc: Document): void {
  try {
    const docked = doc.querySelectorAll?.(".glossa-top-actions-docked");
    if (docked) {
      for (let i = 0; i < docked.length; i++) {
        const el = docked[i];
        el?.parentNode?.removeChild(el);
      }
    }
    const list = doc.querySelectorAll?.(
      ".glossa-popup-expanded, .glossa-popup-host, .glossa-color-row-merged",
    );
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      list[i]?.classList?.remove("glossa-popup-expanded");
      list[i]?.classList?.remove("glossa-popup-host");
      list[i]?.classList?.remove("glossa-color-row-merged");
    }
  } catch {
    // Ignore mock documents without querySelectorAll.
  }
}

function findSelectionPopup(holder: HTMLElement): HTMLElement | null {
  try {
    const direct = holder.closest?.(".selection-popup") as HTMLElement | null;
    if (direct) return direct;
    let cur = holder.parentElement;
    const doc = holder.ownerDocument;
    while (cur && cur !== doc?.body && cur !== doc?.documentElement) {
      if (/\bpopup\b/i.test(String(cur.className || ""))) {
        return cur as HTMLElement;
      }
      cur = cur.parentElement;
    }
  } catch {
    // Ignore mock DOMs without closest/parentElement.
  }
  return null;
}

function isInsideGlossa(el: HTMLElement): boolean {
  try {
    if (el.closest?.(".glossa-selection-panel, .glossa-selection-actions")) {
      return true;
    }
  } catch {
    // Fall through to className check for minimal mock DOMs.
  }
  const cls = String(el.className || "");
  return (
    cls.includes("glossa-selection-panel") ||
    cls.includes("glossa-selection-actions")
  );
}

function countDirectColorSwatches(container: HTMLElement): number {
  const kids = container.children;
  if (!kids || kids.length < 5) return 0;
  let count = 0;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i] as (HTMLElement & { tag?: string }) | undefined;
    if (!child) continue;
    const cls = String(child.className || "");
    if (cls.includes("glossa-")) continue;
    const tag = String(child.tagName || child.tag || "").toLowerCase();
    const role = child.getAttribute?.("role") || "";
    if (tag === "button" || role === "button" || /\bcolor\b/i.test(cls)) {
      count++;
    }
  }
  return count;
}

function findColorRow(popup: HTMLElement): HTMLElement | null {
  try {
    const bySelector = popup.querySelector?.(
      ".colors, .color-picker",
    ) as HTMLElement | null;
    if (
      bySelector &&
      !isInsideGlossa(bySelector) &&
      countDirectColorSwatches(bySelector) >= 5
    ) {
      return bySelector;
    }
    // Breadth-first scan up to 2 levels deep inside `.selection-popup` for
    // Zotero's highlight color bar (typically 8 color swatches).
    const queue: HTMLElement[] = [];
    const top = popup.children;
    if (top) {
      for (let i = 0; i < top.length; i++) {
        const child = top[i] as HTMLElement | undefined;
        if (child && !isInsideGlossa(child)) queue.push(child);
      }
    }
    const level1Len = queue.length;
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      if (countDirectColorSwatches(node) >= 5) return node;
      if (i < level1Len && node.children) {
        for (let j = 0; j < node.children.length; j++) {
          const sub = node.children[j] as HTMLElement | undefined;
          if (sub && !isInsideGlossa(sub)) queue.push(sub);
        }
      }
    }
  } catch {
    // Graceful fallback when mock DOMs omit querySelector/children.
  }
  return null;
}

function clampPopupToViewport(popup: HTMLElement, doc: Document): void {
  try {
    const win = doc.defaultView;
    const rect = popup.getBoundingClientRect?.();
    if (win?.innerWidth && rect && rect.right > win.innerWidth - 12) {
      const nextLeft = Math.max(12, win.innerWidth - rect.width - 12);
      if (popup.style) popup.style.left = `${Math.round(nextLeft)}px`;
    }
  } catch {
    // Best-effort viewport clamping.
  }
}

function onPopup(event: PopupEvent) {
  cancelActiveInlineTranslations();
  resetExpandedPopups(event.doc);
  if (getPref("reader.popup") === false) return;
  const selection = String(event.params.annotation?.text || "").trim();
  if (!selection) return;
  const target = readerTarget(event.reader);
  if (!target) return;

  // Use the reader's native text-selection popup directly (docking our action
  // buttons beside Zotero's highlight color squares) and keep the right-hand
  // Glossa sidebar context workbench untouched until explicitly added.
  const built = actionRow(
    event.doc,
    event.reader,
    event.params.annotation,
    target,
    selection,
  );
  event.append(built.holder);
  built.dock();
}

function pageOf(annotation: _ZoteroTypes.Annotations.AnnotationJson) {
  const label = Number(annotation?.pageLabel);
  if (label > 0) return label;
  const index = annotation?.position?.pageIndex;
  return typeof index === "number" ? index + 1 : undefined;
}

function readerTarget(reader: _ZoteroTypes.ReaderInstance): Target | undefined {
  const attachment = reader.itemID
    ? asItem(Zotero.Items.get(reader.itemID))
    : undefined;
  if (!attachment) return undefined;
  return targetFor(attachment.parentItem || attachment, attachment);
}

function actionRow(
  doc: Document,
  reader: _ZoteroTypes.ReaderInstance,
  annotation: _ZoteroTypes.Annotations.AnnotationJson,
  target: Target,
  selection: string,
): { holder: HTMLDivElement; dock: () => void } {
  const holder = doc.createElement("div");
  holder.className = "glossa-selection-panel";
  const style = doc.createElement("style");
  style.textContent = TOOLBAR_STYLE;
  const row = doc.createElement("div");
  row.className = "glossa-selection-actions";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Glossa");

  const translateBtn = doc.createElement("button");
  translateBtn.type = "button";
  translateBtn.className = "glossa-selection-send glossa-selection-translate";
  translateBtn.textContent = getString("selection-translate");
  const translateTip = getString("selection-translate-tip");
  translateBtn.title = translateTip;
  translateBtn.setAttribute("aria-label", translateTip);

  const paragraphBtn = doc.createElement("button");
  paragraphBtn.type = "button";
  paragraphBtn.className = "glossa-selection-send glossa-selection-paragraph";
  paragraphBtn.textContent = getString("selection-paragraph-button");
  const paragraphTip = getString("selection-translate-paragraph-tip");
  paragraphBtn.title = paragraphTip;
  paragraphBtn.setAttribute("aria-label", paragraphTip);

  const addToChatBtn = doc.createElement("button");
  addToChatBtn.type = "button";
  addToChatBtn.className = "glossa-selection-secondary glossa-selection-chat";
  addToChatBtn.textContent = getString("selection-add-to-chat");
  const chatTip = getString("selection-add-to-chat-tip");
  addToChatBtn.title = chatTip;
  addToChatBtn.setAttribute("aria-label", chatTip);

  const glossaryAdd = doc.createElement("button");
  glossaryAdd.type = "button";
  glossaryAdd.className = "glossa-selection-glossary";
  glossaryAdd.innerHTML = GLOSSARY_SVG;
  glossaryAdd.title = getString("glossary-add");
  glossaryAdd.setAttribute("aria-label", getString("glossary-add"));

  const status = doc.createElement("div");
  status.className = "glossa-selection-status";
  status.hidden = true;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  // ---- Inline translation drawer (stays hidden until Translate/Full click) ----
  const drawer = doc.createElement("div");
  drawer.className = "glossa-inline-translation";
  drawer.hidden = true;

  const drawerHeader = doc.createElement("div");
  drawerHeader.className = "glossa-inline-header";

  const drawerMeta = doc.createElement("div");
  drawerMeta.className = "glossa-inline-meta";
  const drawerTitle = doc.createElement("span");
  drawerTitle.className = "glossa-inline-title";
  drawerTitle.textContent = getString("translate-popup-title");
  const drawerBadge = doc.createElement("span");
  drawerBadge.className = "glossa-inline-badge";
  drawerBadge.hidden = true;
  drawerMeta.append(drawerTitle, drawerBadge);

  const drawerActions = doc.createElement("div");
  drawerActions.className = "glossa-inline-actions";

  const saveAnnBtn = doc.createElement("button");
  saveAnnBtn.type = "button";
  saveAnnBtn.className = "glossa-inline-save-btn";
  saveAnnBtn.textContent = getString("translate-popup-save-annotation");
  const saveAnnTip = getString("translate-popup-save-annotation-tip");
  saveAnnBtn.title = saveAnnTip;
  saveAnnBtn.setAttribute("aria-label", saveAnnTip);
  saveAnnBtn.disabled = true;

  const makeIconBtn = (cls: string, svg: string, label: string) => {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = `glossa-inline-icon-btn ${cls}`;
    btn.innerHTML = svg;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    return btn;
  };

  const stopBtn = makeIconBtn(
    "glossa-inline-stop",
    STOP_SVG,
    getString("stop"),
  );
  stopBtn.hidden = true;
  const reviewBtn = makeIconBtn(
    "glossa-inline-review",
    REVIEW_SVG,
    getString("translate-popup-review"),
  );
  reviewBtn.disabled = true;
  const drawerChatBtn = makeIconBtn(
    "glossa-inline-chat",
    CHAT_SVG,
    getString("translate-popup-chat"),
  );
  const copyBtn = makeIconBtn(
    "glossa-inline-copy",
    COPY_SVG,
    getString("copy"),
  );
  copyBtn.disabled = true;
  drawerActions.append(saveAnnBtn, stopBtn, reviewBtn, drawerChatBtn, copyBtn);
  drawerHeader.append(drawerMeta, drawerActions);

  const drawerBody = doc.createElement("div");
  drawerBody.className = "glossa-inline-body";

  const drawerError = doc.createElement("div");
  drawerError.className = "glossa-inline-error";
  drawerError.hidden = true;
  const drawerErrorText = doc.createElement("span");
  drawerErrorText.className = "glossa-inline-error-text";
  const retryBtn = doc.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "glossa-inline-retry";
  retryBtn.textContent = getString("translate-popup-retry");
  drawerError.append(drawerErrorText, retryBtn);

  drawer.append(drawerHeader, drawerBody, drawerError);

  let paragraphRequest: Promise<PdfParagraphResult> | undefined;
  let markdownRequest: Promise<AlignedSelection | undefined> | undefined;
  let paragraphReady = false;
  let sending = false;
  let recognizeRevision = 0;

  // Inline translation state
  let inlineRunId = 0;
  let inlineStreaming = false;
  let inlineCancel: (() => void) | undefined;
  let inlineRenderTimer: number | undefined;
  let inlineCopyTimer: number | undefined;
  let inlineSaveTimer: number | undefined;
  let inlineText = "";
  let inlineSource = selection;
  let inlineScope: TranslationScope = "selection";
  let inlinePieces: PopupTranslationPiece[] = [];
  let savedAnnotationKey: string | undefined;
  let savingAnnotation = false;

  const cleanupPopup = () => {
    resetExpandedPopups(doc);
    activePopupCleanups.delete(cleanupPopup);
  };
  activePopupCleanups.add(cleanupPopup);

  const updateSendState = () => {
    translateBtn.disabled = sending;
    paragraphBtn.disabled = sending || !paragraphReady;
    addToChatBtn.disabled = sending;
    translateBtn.setAttribute("aria-disabled", String(translateBtn.disabled));
    paragraphBtn.setAttribute("aria-disabled", String(paragraphBtn.disabled));
    addToChatBtn.setAttribute("aria-disabled", String(addToChatBtn.disabled));
  };

  const syncInlineControls = () => {
    const hasText = Boolean(inlineText.trim());
    stopBtn.hidden = !inlineStreaming;
    reviewBtn.hidden = inlineStreaming;
    reviewBtn.disabled = inlineStreaming || !inlinePieces.length;
    copyBtn.disabled = !hasText;
    saveAnnBtn.disabled = inlineStreaming || savingAnnotation || !hasText;
  };

  const setDrawerBadge = (text: string) => {
    drawerBadge.textContent = text;
    drawerBadge.hidden = !text;
  };

  const setDrawerError = (message: string) => {
    drawerErrorText.textContent = message;
    drawerError.hidden = !message;
  };

  const renderDrawerBodyNow = () => {
    unschedule(inlineRenderTimer);
    inlineRenderTimer = undefined;
    if (!inlineText.trim()) {
      if (inlineStreaming) {
        drawerBody.textContent = getString("translate-popup-loading");
        drawerBody.classList?.add("glossa-inline-loading");
      } else {
        drawerBody.textContent = "";
        drawerBody.classList?.remove("glossa-inline-loading");
      }
      return;
    }
    drawerBody.classList?.remove("glossa-inline-loading");
    renderMarkdown(drawerBody, inlineText);
  };

  const scheduleDrawerRender = () => {
    if (inlineRenderTimer !== undefined) return;
    inlineRenderTimer = schedule(() => {
      inlineRenderTimer = undefined;
      if (holder.isConnected) renderDrawerBodyNow();
    }, 45);
  };

  const cancelInlineStream = () => {
    inlineRunId++;
    inlineStreaming = false;
    const cancel = inlineCancel;
    inlineCancel = undefined;
    unschedule(inlineRenderTimer);
    inlineRenderTimer = undefined;
    try {
      cancel?.();
    } catch {
      // Ignore abort races.
    }
    activeInlineCancels.delete(cancelInlineStream);
  };

  const attachPopupHost = (): HTMLElement | null => {
    const popup = findSelectionPopup(holder);
    if (popup) popup.classList?.add("glossa-popup-host");
    return popup;
  };

  const dockToolbarIntoColorRow = () => {
    if (!holder.isConnected) return;
    const popup = attachPopupHost();
    if (!popup) return;
    const colorRow = findColorRow(popup);
    if (colorRow && row.parentElement !== colorRow) {
      try {
        const stale = colorRow.querySelectorAll?.(".glossa-top-actions-docked");
        if (stale) {
          for (let i = 0; i < stale.length; i++) {
            const el = stale[i];
            if (el && el !== row) el.parentNode?.removeChild(el);
          }
        }
      } catch {
        // Ignore mock DOMs without querySelectorAll.
      }
      colorRow.classList?.add("glossa-color-row-merged");
      row.classList?.add("glossa-top-actions-docked");
      holder.classList?.add("glossa-docked");
      colorRow.append(row);
    }
    clampPopupToViewport(popup, doc);
  };

  const expandDrawerForReading = () => {
    dockToolbarIntoColorRow();
    drawer.hidden = false;
    holder.classList?.add("glossa-selection-expanded");
    // Widen Zotero's outer `.selection-popup` card itself so our translation
    // drawer stays cleanly contained inside the native card border.
    const popup = attachPopupHost();
    if (popup) {
      popup.classList?.add("glossa-popup-expanded");
      clampPopupToViewport(popup, doc);
    }
  };

  const position = annotation.position as
    | (_ZoteroTypes.Annotations.AnnotationJson["position"] & {
        nextPageRects?: number[][];
      })
    | undefined;
  const markdownAligned = async (): Promise<AlignedSelection | undefined> => {
    return await (markdownRequest ??= resolveSelectionMarkdown(
      reader,
      target,
      selection,
      position?.pageIndex,
      position?.rects,
      position?.nextPageRects,
    ).catch((error) => {
      ztoolkit.log("[Glossa] Markdown selection alignment failed", error);
      return undefined;
    }));
  };
  const paragraph = async (): Promise<PdfParagraphResult> => {
    const request = (paragraphRequest ??=
      (async (): Promise<PdfParagraphResult> => {
        // Start both lookups together: unconverted PDFs pay zero latency, while
        // a confirmed Markdown match resolves immediately even if PDF.js fails on
        // equations or multi-column boundaries.
        const mdPromise = markdownAligned();
        const layoutPromise = getPdfLayoutParagraph(
          reader,
          selection,
          position?.pageIndex,
          position?.rects,
          position?.nextPageRects,
        )
          .then((result): PdfParagraphResult => {
            if (result?.kind === "ready" && !result.text.trim())
              return { kind: "unmatched", detail: "paragraph-text-empty" };
            return result ?? { kind: "unavailable" };
          })
          .catch((error) => {
            ztoolkit.log("[Glossa] PDF paragraph extraction failed", error);
            return { kind: "unavailable" } as const;
          });
        const aligned = await mdPromise;
        if (aligned?.kind === "matched" && aligned.paragraphText.trim()) {
          return {
            kind: "ready",
            text: aligned.paragraphText,
            fromMarkdown: true,
            ...(aligned.paragraphCount > 1
              ? { paragraphs: aligned.paragraphCount }
              : {}),
          };
        }
        return await layoutPromise;
      })());
    const result = await request;
    if (result.kind !== "ready" && paragraphRequest === request) {
      paragraphRequest = undefined;
    }
    return result;
  };
  const showStatus = (message: string) => {
    status.textContent = message;
    status.hidden = false;
  };
  const showParagraphFailure = (
    result: Exclude<PdfParagraphResult, { kind: "ready" }>,
  ) => {
    const failure = paragraphFailureStatus(result);
    showStatus(
      getString(failure.messageId) +
        (failure.detail
          ? `\n[${getString("selection-layout-diagnostic")}] ${failure.detail}`
          : ""),
    );
  };
  const showParagraphResult = (result: PdfParagraphResult) => {
    if (result.kind === "ready") {
      paragraphReady = true;
      updateSendState();
      const messageId = result.fromSelection
        ? "selection-paragraph-from-selection"
        : result.fromMarkdown
          ? (result.paragraphs || 1) > 1
            ? "selection-paragraph-md-multi-ready"
            : "selection-paragraph-md-ready"
          : (result.paragraphs || 1) > 1
            ? "selection-paragraph-multi-ready"
            : "selection-paragraph-ready";
      showStatus(
        getString(messageId, {
          args: {
            count: result.text.length,
            paragraphs: result.paragraphs || 1,
          },
        }),
      );
      return;
    }
    // The selection translate button stays usable. The paragraph button stays
    // disabled until a new selection confirms a complete paragraph.
    paragraphReady = false;
    updateSendState();
    showParagraphFailure(result);
  };
  const recognize = async () => {
    const revision = ++recognizeRevision;
    paragraphReady = false;
    updateSendState();
    showStatus(getString("selection-paragraph-loading"));
    const result = await paragraph();
    if (revision !== recognizeRevision) return;
    paragraphReady = result.kind === "ready";
    updateSendState();
    if (sending) return;
    showParagraphResult(result);
  };

  const runInlineTranslation = async (
    sourceText: string,
    requestedScope: TranslationScope,
  ) => {
    cancelInlineStream();
    const runId = inlineRunId;
    activeInlineCancels.add(cancelInlineStream);
    inlineStreaming = true;
    inlineText = "";
    inlineSource = sourceText;
    inlineScope = requestedScope;
    inlinePieces = [];
    setDrawerError("");
    setDrawerBadge(
      requestedScope === "paragraph"
        ? getString("translate-popup-paragraph")
        : "",
    );
    expandDrawerForReading();
    renderDrawerBodyNow();
    syncInlineControls();

    const outcome = await streamPopupTranslation({
      source: sourceText,
      verifyComplete: requestedScope === "paragraph",
      promptFor: async (piece, cfg) =>
        (await renderTemplate(TRANSLATE_TEMPLATE, "", target, cfg, piece))
          .prompt,
      onDelta: (text) => {
        if (inlineRunId !== runId) return;
        if (!holder.isConnected) {
          cancelInlineStream();
          return;
        }
        inlineText = text;
        scheduleDrawerRender();
        syncInlineControls();
      },
      onCancelReady: (cancel) => {
        if (inlineRunId === runId && holder.isConnected) {
          inlineCancel = cancel;
        } else {
          try {
            cancel();
          } catch {
            // Ignore late cancel.
          }
        }
      },
      stopped: () => inlineRunId !== runId || !holder.isConnected,
    });

    if (inlineRunId !== runId) return;
    inlineStreaming = false;
    inlineCancel = undefined;
    activeInlineCancels.delete(cancelInlineStream);
    if (!holder.isConnected) return;

    if (outcome.ok) {
      inlineText = outcome.text;
      inlinePieces = outcome.pieces;
      setDrawerBadge(
        requestedScope === "paragraph"
          ? getString("translate-popup-paragraph")
          : "",
      );
      setDrawerError("");
      renderDrawerBodyNow();
    } else if (!outcome.aborted) {
      setDrawerBadge("");
      if (!inlineText.trim()) drawerBody.textContent = "";
      drawerBody.classList?.remove("glossa-inline-loading");
      setDrawerError(outcome.error || getString("translate-popup-empty"));
    }
    syncInlineControls();
  };

  const runInlineReview = async () => {
    if (!holder.isConnected || inlineStreaming || !inlinePieces.length) return;
    const draftText = inlineText;
    const pieces = inlinePieces;
    cancelInlineStream();
    const runId = inlineRunId;
    activeInlineCancels.add(cancelInlineStream);
    inlineStreaming = true;
    setDrawerError("");
    setDrawerBadge(getString("translate-popup-reviewing"));
    syncInlineControls();

    const outcome = await streamPopupReview({
      pieces,
      onDelta: (text) => {
        if (inlineRunId !== runId || !text) return;
        if (!holder.isConnected) {
          cancelInlineStream();
          return;
        }
        inlineText = text;
        scheduleDrawerRender();
      },
      onCancelReady: (cancel) => {
        if (inlineRunId === runId && holder.isConnected) {
          inlineCancel = cancel;
        } else {
          try {
            cancel();
          } catch {
            // Ignore late cancel.
          }
        }
      },
      stopped: () => inlineRunId !== runId || !holder.isConnected,
    });

    if (inlineRunId !== runId) return;
    inlineStreaming = false;
    inlineCancel = undefined;
    activeInlineCancels.delete(cancelInlineStream);
    if (!holder.isConnected) return;

    if (outcome.ok) {
      inlineText = outcome.text;
      setDrawerBadge(getString("translate-popup-reviewed"));
      setDrawerError("");
      renderDrawerBodyNow();
    } else {
      inlineText = draftText;
      setDrawerBadge(
        inlineScope === "paragraph"
          ? getString("translate-popup-paragraph")
          : "",
      );
      renderDrawerBodyNow();
      if (!outcome.aborted) {
        setDrawerError(outcome.error || getString("translation-review-failed"));
      }
    }
    syncInlineControls();
  };

  // Preserve the PDF selection when pressing action buttons, while allowing
  // normal mouse selection inside the translated body text.
  for (const button of [
    translateBtn,
    paragraphBtn,
    addToChatBtn,
    glossaryAdd,
    saveAnnBtn,
    stopBtn,
    reviewBtn,
    drawerChatBtn,
    copyBtn,
    retryBtn,
  ]) {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  drawerBody.addEventListener("mousedown", (event) => event.stopPropagation());
  drawerBody.addEventListener("click", (event) => event.stopPropagation());

  // The editor is a real dialog window: it stays up when this popup closes.
  glossaryAdd.addEventListener("click", () => {
    if (!holder.isConnected) return;
    void openGlossaryEditor({ source: selection });
  });

  // 1. Inline translation directly inside Zotero's selection popup.
  const translateInline = async (requestedScope: TranslationScope) => {
    if (!holder.isConnected) return;
    if (sending || (requestedScope === "paragraph" && !paragraphReady)) {
      updateSendState();
      return;
    }
    sending = true;
    updateSendState();
    translateBtn.setAttribute("aria-busy", "true");
    paragraphBtn.setAttribute("aria-busy", "true");
    try {
      let input = selection;
      if (requestedScope === "selection") {
        const aligned = await markdownAligned();
        if (!holder.isConnected) return;
        if (aligned?.kind === "matched" && aligned.selectionEnhanced) {
          input = aligned.selectionText;
        }
      } else {
        const result = await paragraph();
        if (!holder.isConnected) return;
        if (result.kind !== "ready") {
          showParagraphResult(result);
          return;
        }
        input = result.text;
      }
      status.hidden = true;
      await runInlineTranslation(input, requestedScope);
    } catch (error) {
      ztoolkit.log("[Glossa] inline translation failed", error);
      if (holder.isConnected) {
        expandDrawerForReading();
        setDrawerError(getString("translate-popup-empty"));
      }
    } finally {
      sending = false;
      updateSendState();
      translateBtn.removeAttribute("aria-busy");
      paragraphBtn.removeAttribute("aria-busy");
    }
  };

  // 2. Add clean selection to Glossa's multi-context workbench & focus pane.
  const addSelectionToChat = async () => {
    if (!holder.isConnected || sending) return;
    sending = true;
    updateSendState();
    try {
      let input = selection;
      const aligned = await markdownAligned();
      if (!holder.isConnected) return;
      if (aligned?.kind === "matched" && aligned.selectionEnhanced) {
        input = aligned.selectionText;
      }
      addContextToChat(
        target,
        {
          kind: "text",
          text: input,
          page: pageOf(annotation),
        },
        reader,
      );
    } finally {
      sending = false;
      updateSendState();
    }
  };

  saveAnnBtn.addEventListener("click", async () => {
    if (!holder.isConnected || inlineStreaming || savingAnnotation) return;
    const text = inlineText.trim();
    if (!text) return;
    savingAnnotation = true;
    syncInlineControls();
    try {
      const outcome = await saveHighlightTranslationAnnotation({
        reader,
        target,
        rawText: selection,
        translation: text,
        pageIndex: position?.pageIndex,
        pageLabel: annotation.pageLabel,
        rects: position?.rects,
        sortIndex: annotation.sortIndex,
        existingKey: savedAnnotationKey,
      });
      if (!holder.isConnected) return;
      if (outcome.ok) {
        savedAnnotationKey = outcome.key;
        saveAnnBtn.textContent = getString(
          outcome.updated
            ? "translate-popup-updated-annotation"
            : "translate-popup-saved-annotation",
        );
        saveAnnBtn.classList?.add("glossa-saved");
        unschedule(inlineSaveTimer);
        inlineSaveTimer = schedule(() => {
          if (!holder.isConnected) return;
          saveAnnBtn.textContent = getString("translate-popup-save-annotation");
          saveAnnBtn.classList?.remove("glossa-saved");
        }, 1800);
      } else {
        setDrawerError(
          getString(
            outcome.reason === "read-only"
              ? "visual-annotate-readonly"
              : "visual-annotate-failed",
          ),
        );
      }
    } finally {
      savingAnnotation = false;
      if (holder.isConnected) syncInlineControls();
    }
  });

  stopBtn.addEventListener("click", () => {
    cancelInlineStream();
    setDrawerBadge("");
    if (!inlineText.trim()) {
      drawerBody.textContent = getString("stopped");
      drawerBody.classList?.remove("glossa-inline-loading");
    }
    syncInlineControls();
  });

  reviewBtn.addEventListener("click", () => {
    void runInlineReview();
  });

  drawerChatBtn.addEventListener("click", () => {
    if (!holder.isConnected) return;
    addContextToChat(
      target,
      {
        kind: "text",
        text: inlineSource,
        page: pageOf(annotation),
        ...(inlineScope === "paragraph"
          ? { label: getString("translate-popup-paragraph") }
          : {}),
      },
      reader,
    );
  });

  copyBtn.addEventListener("click", () => {
    const text = inlineText.trim();
    if (!text) return;
    try {
      Zotero.Utilities.Internal.copyTextToClipboard(text);
    } catch {
      // Ignore clipboard unavailability in headless tests.
    }
    copyBtn.innerHTML = CHECK_SVG;
    copyBtn.title = getString("copied");
    copyBtn.classList?.add("glossa-copied");
    unschedule(inlineCopyTimer);
    inlineCopyTimer = schedule(() => {
      if (!holder.isConnected) return;
      copyBtn.innerHTML = COPY_SVG;
      copyBtn.title = getString("copy");
      copyBtn.classList?.remove("glossa-copied");
    }, 1200);
  });

  retryBtn.addEventListener("click", () => {
    if (!holder.isConnected || inlineStreaming) return;
    void runInlineTranslation(inlineSource, inlineScope);
  });

  translateBtn.addEventListener("click", () => translateInline("selection"));
  paragraphBtn.addEventListener("click", () => translateInline("paragraph"));
  addToChatBtn.addEventListener("click", () => addSelectionToChat());
  updateSendState();
  row.append(translateBtn, paragraphBtn, addToChatBtn, glossaryAdd);
  holder.append(style, row, status, drawer);

  // Try docking right after mount, on next microtask, and on next macrotask so
  // both synchronous and React-batched Zotero mounts place our controls next to
  // the 8 highlight color squares without a flash.
  const dock = () => {
    dockToolbarIntoColorRow();
    void Promise.resolve().then(dockToolbarIntoColorRow);
    schedule(dockToolbarIntoColorRow, 0);
  };

  // Reader append() may mount asynchronously. Recognition may fill this
  // detached DOM, but must not send or change sidebar state while detached.
  // Explicit action clicks still require a connected popup.
  void recognize();
  return { holder, dock };
}

function onAnnotationMenu(event: AnnotationMenuEvent) {
  if (getPref("reader.popup") === false) return;
  const target = readerTarget(event.reader);
  if (!target?.attachment) return;
  const key = event.params.currentID || event.params.ids?.[0];
  if (!key) return;
  const annotationItem = asItem(
    Zotero.Items.getByLibraryAndKey?.(target.attachment.libraryID, key),
  );
  if (!annotationItem || !annotationItem.isAnnotation?.()) return;
  const isVisual = annotationItem.annotationType === "image";
  if (
    !isVisual &&
    !annotationItem.annotationText?.trim() &&
    !annotationItem.annotationComment?.trim()
  ) {
    return;
  }
  event.append({
    label: getString("annotation-add-to-chat"),
    onCommand: () => {
      void addAnnotationToChat(event.reader, target, annotationItem);
    },
  });
}

function onSidebarAnnotationHeader(event: SidebarAnnotationEvent) {
  if (getPref("reader.popup") === false) return;
  const target = readerTarget(event.reader);
  if (!target?.attachment) return;
  const ann = event.params.annotation;
  if (!ann) return;
  const isVisual = ann.type === "image";
  if (
    !isVisual &&
    !String(ann.text || "").trim() &&
    !String(ann.comment || "").trim()
  ) {
    return;
  }
  const key = ann.key || ann.id;
  if (!key) return;
  const host = event.doc.head || event.doc.documentElement;
  if (host && !event.doc.getElementById?.("glossa-sidebar-ann-style")) {
    const style = event.doc.createElement("style");
    style.id = "glossa-sidebar-ann-style";
    style.textContent = SIDEBAR_ANN_STYLE;
    host.appendChild(style);
  }
  const btn = event.doc.createElement("button");
  btn.type = "button";
  btn.className = "glossa-sidebar-ann-chat";
  btn.textContent = getString("sidebar-annotation-add-chat");
  btn.title = getString("annotation-add-to-chat");
  btn.addEventListener("click", (clickEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    const item = asItem(
      Zotero.Items.getByLibraryAndKey?.(target.attachment!.libraryID, key),
    );
    if (item && item.isAnnotation?.()) {
      void addAnnotationToChat(event.reader, target, item);
    }
  });
  event.append(btn);
}

/**
 * Append a recognized figure, table, or display equation into Glossa's
 * right-hand multi-context chat workbench.
 */
export function addVisualTargetToChat(
  target: Target,
  resolved: Extract<ResolvedAnnotationContext, { kind: "visual" }>,
  reader?: _ZoteroTypes.ReaderInstance,
): boolean {
  const item: ContextItemInput = {
    kind: resolved.visualKind,
    text: resolved.markdownText || "",
    ...(resolved.caption ? { caption: resolved.caption } : {}),
    ...(resolved.comment ? { comment: resolved.comment } : {}),
    ...(resolved.page ? { page: resolved.page } : {}),
    ...(resolved.image ? { image: resolved.image } : {}),
  };
  return addContextToChat(target, item, reader);
}

async function addAnnotationToChat(
  reader: _ZoteroTypes.ReaderInstance,
  target: Target,
  annotationItem: Zotero.Item,
): Promise<boolean> {
  try {
    const resolved = await resolveAnnotationContext(
      reader,
      target,
      annotationItem,
    );
    if (!resolved) return false;
    if (resolved.kind === "visual") {
      return addVisualTargetToChat(target, resolved, reader);
    }
    return addContextToChat(
      target,
      {
        kind: "text",
        text: resolved.text,
        ...(resolved.comment ? { comment: resolved.comment } : {}),
        ...(resolved.page ? { page: resolved.page } : {}),
      },
      reader,
    );
  } catch (error) {
    ztoolkit.log("[Glossa] add annotation to chat failed", error);
    return false;
  }
}

const GLOSSARY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14.5A1.5 1.5 0 0 1 2.5 13V3a1.5 1.5 0 0 1 1.5-1.5H13.5v11H4.5A1.5 1.5 0 0 0 3 14z"/><path d="M4 12.5h9.5"/><path d="M7 5.5h3M8.5 4v3"/></svg>';

const STOP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.8"/></svg>';

const REVIEW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l1.2 3.1 3.1 1.2-3.1 1.2L8 10.4 6.8 7.3 3.7 6.1l3.1-1.2L8 1.8z"/><path d="M12.5 10.5l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5z"/></svg>';

const CHAT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H6.2L3.2 13.5V11H4a1.5 1.5 0 0 1-1.5-1.5v-6z"/><path d="M8 4.8v3.4M6.3 6.5h3.4"/></svg>';

const COPY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.4"/><path d="M3.8 10.5H3.5A1.5 1.5 0 0 1 2 9V3.5A1.5 1.5 0 0 1 3.5 2H9a1.5 1.5 0 0 1 1.5 1.5v.3"/></svg>';

const CHECK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';

const TOOLBAR_STYLE = `
.selection-popup:has(.glossa-selection-panel),
.glossa-popup-host {
  width: auto !important;
  max-width: min(480px, calc(100vw - 28px)) !important;
}
.selection-popup:has(.glossa-selection-expanded),
.glossa-popup-expanded {
  width: min(430px, calc(100vw - 28px)) !important;
  max-width: min(480px, calc(100vw - 28px)) !important;
}
.glossa-selection-panel,
.glossa-top-actions-docked {
  --glossa-selection-accent: #276b5a;
  --glossa-selection-accent-soft: rgba(39, 107, 90, 0.12);
  --glossa-selection-border: #dbe1d9;
  --glossa-selection-paper: #fff;
  --glossa-selection-surface: #f8faf8;
  --glossa-selection-text: #26332e;
  --glossa-selection-muted: #65756d;
  --glossa-selection-disabled: #d9dedb;
  --glossa-selection-disabled-text: #6d7772;
  --glossa-selection-error: #b9382c;
  font-family: system-ui, -apple-system, sans-serif;
}
.glossa-selection-panel {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  padding: 6px 0 2px;
}
.glossa-selection-panel.glossa-docked {
  padding: 0;
}
.glossa-selection-panel [hidden] {
  display: none !important;
}
.glossa-color-row-merged {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  justify-content: flex-start !important;
  flex-wrap: wrap !important;
  gap: 4px !important;
  width: 100% !important;
  max-width: none !important;
  box-sizing: border-box !important;
}
.glossa-color-row-merged > :not(.glossa-top-actions-docked) {
  flex: 0 0 auto !important;
}
.glossa-selection-actions {
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.glossa-top-actions-docked {
  display: inline-flex !important;
  flex-wrap: nowrap !important;
  align-items: center !important;
  gap: 4px !important;
  width: auto !important;
  max-width: none !important;
  flex: 0 0 auto !important;
  margin-left: 2px !important;
  padding-left: 7px !important;
  position: relative;
}
.glossa-top-actions-docked::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 1px;
  height: 16px;
  background: var(--glossa-selection-border);
}
.glossa-selection-send {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 7px;
  border: 0;
  border-radius: 6px;
  color: #fff;
  background: var(--glossa-selection-accent);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
}
.glossa-selection-send:hover:not(:disabled) { filter: brightness(1.1); }
.glossa-selection-send:disabled {
  background: var(--glossa-selection-disabled);
  color: var(--glossa-selection-disabled-text);
  opacity: 1;
  cursor: default;
}
.glossa-selection-secondary {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--glossa-selection-border);
  border-radius: 6px;
  color: var(--glossa-selection-text);
  background: var(--glossa-selection-paper);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
}
.glossa-selection-secondary:hover:not(:disabled) {
  border-color: var(--glossa-selection-accent);
  color: var(--glossa-selection-accent);
}
.glossa-selection-secondary:disabled {
  opacity: 0.5;
  cursor: default;
}
.glossa-selection-glossary {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  margin-left: auto;
  border: 1px solid var(--glossa-selection-border);
  border-radius: 6px;
  color: var(--glossa-selection-text);
  background: transparent;
  flex-shrink: 0;
  cursor: pointer;
}
.glossa-selection-glossary svg { display: block; }
.glossa-selection-glossary:hover:not(:disabled) {
  border-color: var(--glossa-selection-accent);
  color: var(--glossa-selection-accent);
}
/* Protect docked buttons from Zotero's .colors button swatch rules. */
.glossa-top-actions-docked button {
  margin: 0 !important;
  min-width: 0 !important;
  box-shadow: none !important;
  transform: none !important;
  line-height: 1 !important;
}
.glossa-top-actions-docked .glossa-selection-send,
.glossa-top-actions-docked .glossa-selection-secondary {
  width: auto !important;
  height: 24px !important;
  padding: 0 7px !important;
  border-radius: 5px !important;
  font-size: 12px !important;
}
.glossa-top-actions-docked .glossa-selection-send {
  border: 0 !important;
  background: var(--glossa-selection-accent) !important;
  color: #fff !important;
}
.glossa-top-actions-docked .glossa-selection-send:disabled {
  background: var(--glossa-selection-disabled) !important;
  color: var(--glossa-selection-disabled-text) !important;
  opacity: 1 !important;
}
.glossa-top-actions-docked .glossa-selection-secondary {
  border: 1px solid var(--glossa-selection-border) !important;
  background: var(--glossa-selection-paper) !important;
  color: var(--glossa-selection-text) !important;
}
.glossa-top-actions-docked .glossa-selection-secondary:hover:not(:disabled) {
  border-color: var(--glossa-selection-accent) !important;
  color: var(--glossa-selection-accent) !important;
}
.glossa-top-actions-docked .glossa-selection-glossary {
  width: 24px !important;
  height: 24px !important;
  padding: 0 !important;
  border: 1px solid var(--glossa-selection-border) !important;
  border-radius: 5px !important;
  background: var(--glossa-selection-paper) !important;
  color: var(--glossa-selection-text) !important;
}
.glossa-top-actions-docked .glossa-selection-glossary:hover:not(:disabled) {
  border-color: var(--glossa-selection-accent) !important;
  color: var(--glossa-selection-accent) !important;
}
.glossa-selection-glossary:focus-visible,
.glossa-selection-send:focus-visible,
.glossa-selection-secondary:focus-visible {
  outline: 2px solid var(--glossa-selection-accent);
  outline-offset: 2px;
}
.glossa-selection-status {
  padding-top: 4px;
  color: var(--glossa-selection-muted);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.glossa-selection-status[hidden] { display: none; }

/* ---- Inline translation drawer cleanly contained inside expanded popup ---- */
.glossa-inline-translation {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin-top: 6px;
  border: 1px solid var(--glossa-selection-border);
  border-radius: 8px;
  background: var(--glossa-selection-surface);
  overflow: hidden;
}
.glossa-inline-header {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--glossa-selection-border);
  background: var(--glossa-selection-paper);
  min-width: 0;
}
.glossa-inline-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
}
.glossa-inline-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--glossa-selection-text);
  white-space: nowrap;
}
.glossa-inline-badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--glossa-selection-accent-soft);
  color: var(--glossa-selection-accent);
  font-size: 10.5px;
  line-height: 1.45;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.glossa-inline-actions {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}
.glossa-inline-save-btn {
  appearance: none;
  margin: 0;
  padding: 2px 7px;
  border: 1px solid var(--glossa-selection-border);
  border-radius: 5px;
  background: var(--glossa-selection-paper);
  color: var(--glossa-selection-text);
  font: 500 11px/1.45 system-ui, sans-serif;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
}
.glossa-inline-save-btn:hover:not(:disabled) {
  border-color: var(--glossa-selection-accent);
  color: var(--glossa-selection-accent);
}
.glossa-inline-save-btn.glossa-saved {
  border-color: var(--glossa-selection-accent);
  background: var(--glossa-selection-accent-soft);
  color: var(--glossa-selection-accent);
}
.glossa-inline-save-btn:disabled {
  opacity: 0.42;
  cursor: default;
}
.glossa-inline-icon-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--glossa-selection-muted);
  cursor: pointer;
}
.glossa-inline-icon-btn:hover:not(:disabled) {
  background: var(--glossa-selection-accent-soft);
  color: var(--glossa-selection-text);
}
.glossa-inline-icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.glossa-inline-icon-btn.glossa-copied {
  color: var(--glossa-selection-accent);
  background: var(--glossa-selection-accent-soft);
}
.glossa-inline-icon-btn.glossa-inline-stop {
  color: var(--glossa-selection-error);
}
.glossa-inline-body {
  box-sizing: border-box;
  width: 100%;
  max-height: min(270px, 38vh);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 9px 11px 10px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--glossa-selection-text);
  user-select: text;
  overflow-wrap: anywhere;
  text-align: left;
}
.glossa-inline-body.glossa-inline-loading {
  color: var(--glossa-selection-muted);
  font-size: 12.5px;
}
.glossa-inline-body p {
  margin: 0 0 0.55em;
}
.glossa-inline-body p:last-child {
  margin-bottom: 0;
}
.glossa-inline-body ul,
.glossa-inline-body ol {
  margin: 0 0 0.55em;
  padding-left: 1.3em;
}
.glossa-inline-body code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--glossa-selection-accent-soft);
  font-size: 0.9em;
}
.glossa-inline-body .glossa-math {
  font-family: "Cambria Math", "STIX Two Math", "Times New Roman", serif;
}
.glossa-inline-body .glossa-math-block {
  margin: 0.4em 0;
  overflow-x: auto;
  text-align: center;
}
.glossa-inline-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--glossa-selection-border);
  background: rgba(185, 56, 44, 0.06);
  color: var(--glossa-selection-error);
  font-size: 11.5px;
}
.glossa-inline-retry {
  appearance: none;
  margin: 0;
  padding: 2px 8px;
  border: 1px solid var(--glossa-selection-border);
  border-radius: 5px;
  background: var(--glossa-selection-paper);
  color: var(--glossa-selection-text);
  font: 500 11px/1.4 system-ui, sans-serif;
  cursor: pointer;
  flex-shrink: 0;
}
.glossa-inline-retry:hover {
  border-color: var(--glossa-selection-accent);
  color: var(--glossa-selection-accent);
}
@media (prefers-color-scheme: dark) {
  .glossa-selection-panel,
  .glossa-top-actions-docked {
    --glossa-selection-accent: #9bd3b6;
    --glossa-selection-accent-soft: rgba(155, 211, 182, 0.16);
    --glossa-selection-border: #45584e;
    --glossa-selection-paper: #27322c;
    --glossa-selection-surface: #202824;
    --glossa-selection-text: #e7eee9;
    --glossa-selection-muted: #9eb0a5;
    --glossa-selection-disabled: #46514b;
    --glossa-selection-disabled-text: #abb5af;
    --glossa-selection-error: #ff8a80;
  }
  .glossa-selection-send,
  .glossa-top-actions-docked .glossa-selection-send {
    color: #153126 !important;
  }
}
`;

const SIDEBAR_ANN_STYLE = `
.glossa-sidebar-ann-chat {
  margin-left: auto;
  padding: 1px 7px;
  border: 1px solid rgba(39, 107, 90, 0.38);
  border-radius: 5px;
  background: rgba(39, 107, 90, 0.08);
  color: #276b5a;
  font: 500 11px/1.5 system-ui, -apple-system, sans-serif;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.glossa-sidebar-ann-chat:hover {
  background: rgba(39, 107, 90, 0.16);
  border-color: #276b5a;
}
@media (prefers-color-scheme: dark) {
  .glossa-sidebar-ann-chat {
    border-color: rgba(155, 211, 182, 0.4);
    background: rgba(155, 211, 182, 0.12);
    color: #9bd3b6;
  }
  .glossa-sidebar-ann-chat:hover {
    background: rgba(155, 211, 182, 0.22);
    border-color: #9bd3b6;
  }
}
`;

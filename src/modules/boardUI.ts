import { getString } from "../utils/locale";
import { BOARD_SOURCE_LIMIT, type BoardEntry } from "../utils/board";
import { board } from "./board";
import { renderMarkdown } from "./markdown";

export type BoardPanel = {
  root: HTMLElement;
  dispose(): void;
};

export type BoardPanelOptions = {
  /** Called when the entry's source paper title is clicked. */
  onJump(itemKey: string): void;
  /** Optional callback to add a pinned board entry back to the composer tray. */
  onAddToChat?(entry: BoardEntry): void;
};

const HTML_NS = "http://www.w3.org/1999/xhtml";
const COPIED_MS = 1200;
const REMOVE_PREVIEW = 60;
/** Long entries are folded with a show-more button. */
const LONG_TEXT_LINES = 10;
const LONG_TEXT_CHARS = 600;

let panelCount = 0;

/**
 * Sticky-note style global board pinned to the top edge of the chat workspace.
 * Collapsed: a compact warm Post-it tab pinned to the top-right edge (0px
 * layout height stolen from the header or conversation).
 * Expanded: a floating sticky-note sheet overlaid over the top of the chat.
 */
export function createBoardPanel(
  win: Window,
  options: BoardPanelOptions,
): BoardPanel {
  const doc = win.document;
  const listId = `glossa-board-list-${++panelCount}`;
  const timers = new Set<number>();
  let expanded = false;
  let loaded = false;
  let loadFailed = "";
  let clearing = false;
  let operationError = "";
  let disposed = false;

  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElementNS(
      HTML_NS,
      tag,
    ) as unknown as HTMLElementTagNameMap[K];
    if (className) node.className = className;
    return node;
  }

  // ---- structure

  const root = element("div", "glossa-board glossa-sticky-board");

  const toggle = element("button", "glossa-board-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-controls", listId);
  const pinIcon = element("span", "glossa-board-pin");
  pinIcon.setAttribute("aria-hidden", "true");
  pinIcon.innerHTML = PIN_ICON;
  const title = element("span", "glossa-board-title");
  title.textContent = getString("board-title");
  const count = element("span", "glossa-board-count");
  toggle.append(pinIcon, title, count);

  const clearButton = element("button", "glossa-board-clear");
  clearButton.type = "button";
  clearButton.textContent = getString("board-clear");

  const closeButton = element("button", "glossa-board-close");
  closeButton.type = "button";
  closeButton.innerHTML = CLOSE_ICON;
  closeButton.title = getString("board-collapse");
  closeButton.setAttribute("aria-label", getString("board-collapse"));

  const head = element("div", "glossa-board-head");
  head.append(toggle, clearButton, closeButton);

  const list = element("div", "glossa-board-list");
  list.id = listId;
  list.setAttribute("role", "list");
  list.setAttribute("aria-live", "polite");

  const status = element("div", "glossa-board-status");
  status.setAttribute("role", "status");

  root.append(head, list, status);
  list.hidden = true;

  // ---- state

  function setExpanded(next: boolean) {
    expanded = next;
    root.classList.toggle("glossa-board-open", next);
    toggle.setAttribute("aria-expanded", String(next));
    toggle.title = getString(next ? "board-collapse" : "board-expand");
    list.hidden = !next;
    clearButton.hidden = !next;
    closeButton.hidden = !next;
    syncStatus();
  }

  function updateCount(total: number) {
    root.classList.toggle("glossa-board-is-empty", total === 0);
    count.textContent = String(total);
    toggle.setAttribute(
      "aria-label",
      `${getString("board-title")} · ${getString("board-count", { args: { count: total } })}`,
    );
  }

  function setOperationError(message: string) {
    operationError = message;
    syncStatus();
  }

  function syncStatus() {
    let text = "";
    const empty =
      loaded && !loadFailed && !operationError && !board.list().length;
    if (loadFailed) text = loadFailed;
    else if (!loaded) text = getString("board-loading");
    else if (operationError) text = operationError;
    else if (empty) text = getString("board-empty");
    status.textContent = text;
    status.classList.toggle("glossa-board-empty", empty);
    status.hidden = !text || !expanded;
  }

  function updateClear(total: number) {
    clearButton.disabled =
      clearing || !loaded || Boolean(loadFailed) || total === 0;
  }

  function render() {
    if (disposed) return;
    operationError = "";
    const entries = loadFailed ? [] : board.list();
    updateCount(entries.length);
    updateClear(entries.length);
    list.replaceChildren();
    for (const entry of entries) list.append(renderEntry(entry));
    syncStatus();
  }

  // ---- entries

  function renderEntry(entry: BoardEntry): HTMLElement {
    const item = element("div", "glossa-board-entry");
    item.setAttribute("role", "listitem");
    item.dataset.entryId = entry.id;

    item.append(renderBody(entry));
    item.append(renderMeta(entry));
    if (entry.source.trim()) item.append(renderSource(entry));
    return item;
  }

  function renderBody(entry: BoardEntry): HTMLElement {
    const host = element("div", "glossa-board-text-wrap");
    const text = element("div", "glossa-board-text glossa-msg");
    renderMarkdown(text, entry.translation);
    host.append(text);
    if (!isLongText(entry.translation)) return host;
    text.classList.add("glossa-board-text-clamped");
    const more = element("button", "glossa-board-text-toggle");
    more.type = "button";
    more.setAttribute("aria-expanded", "false");
    more.textContent = getString("board-expand-text");
    more.addEventListener("click", () => {
      const open = more.getAttribute("aria-expanded") !== "true";
      more.setAttribute("aria-expanded", String(open));
      text.classList.toggle("glossa-board-text-clamped", !open);
      more.textContent = getString(
        open ? "board-collapse-text" : "board-expand-text",
      );
    });
    host.append(more);
    return host;
  }

  function renderSource(entry: BoardEntry): HTMLElement {
    const details = element("details", "glossa-board-source");
    const summary = element("summary", "glossa-board-source-summary");
    summary.textContent = getString(
      entry.mode === "note" ? "board-question" : "board-source",
    );
    const body = element("div", "glossa-board-source-body");
    body.textContent = entry.source;
    details.append(summary, body);
    if (entry.sourceTruncated) {
      const note = element("div", "glossa-board-source-note");
      note.textContent = getString("board-source-truncated", {
        args: { count: BOARD_SOURCE_LIMIT },
      });
      details.append(note);
    }
    return details;
  }

  function renderMeta(entry: BoardEntry): HTMLElement {
    const meta = element("div", "glossa-board-meta");

    const paper = renderPaper(entry);

    const mode = element(
      "span",
      `glossa-board-mode glossa-board-tl-${entry.mode === "note" ? "note" : entry.status}`,
    );
    mode.textContent = statusText(entry);

    const date = element("span", "glossa-board-date");
    date.textContent = formatDate(entry.addedAt);

    const actions = element("span", "glossa-board-actions");
    if (options.onAddToChat) {
      const toChat = element("button", "glossa-board-to-chat");
      toChat.type = "button";
      toChat.textContent = getString("board-add-chat");
      toChat.title = getString("board-add-chat");
      toChat.addEventListener("click", () => {
        options.onAddToChat?.(entry);
        setExpanded(false);
      });
      actions.append(toChat);
    }
    const copy = element("button", "glossa-board-copy");
    copy.type = "button";
    copy.textContent = getString("board-copy");
    copy.title = getString("board-copy");
    copy.addEventListener("click", () => copyEntry(entry, copy));
    const remove = element("button", "glossa-board-remove");
    remove.type = "button";
    remove.textContent = getString("board-remove");
    const removeLabel = getString("board-remove-label", {
      args: { text: previewText(entry.translation) },
    });
    remove.setAttribute("aria-label", removeLabel);
    remove.title = removeLabel;
    remove.addEventListener("click", () => void removeEntry(entry, remove));
    actions.append(copy, remove);

    meta.append(mode, paper, date, actions);
    return meta;
  }

  function renderPaper(entry: BoardEntry): HTMLButtonElement {
    const paper = element("button", "glossa-board-paper");
    paper.type = "button";
    paper.textContent = entry.itemTitle || getString("no-context");
    const enable = () => {
      paper.disabled = false;
      paper.title = entry.itemTitle;
      paper.setAttribute("aria-label", entry.itemTitle);
      paper.addEventListener("click", () => {
        setExpanded(false);
        options.onJump(entry.itemKey);
      });
    };
    const disable = () => {
      paper.disabled = true;
      paper.title = getString("board-paper-missing");
      paper.setAttribute("aria-label", getString("board-paper-missing"));
    };
    const parsed = parseBoardItemKey(entry.itemKey);
    let cached = false;
    if (parsed) {
      try {
        cached = Boolean(
          Zotero.Items.getByLibraryAndKey(parsed.libraryID, parsed.key),
        );
      } catch (error) {
        ztoolkit.log("[Glossa] board source lookup failed", error);
      }
    }
    if (cached) {
      enable();
      return paper;
    }
    disable();
    if (parsed) {
      void Zotero.Items.getByLibraryAndKeyAsync(parsed.libraryID, parsed.key)
        .then((item) => {
          if (item && paper.isConnected) enable();
        })
        .catch((error: unknown) => {
          ztoolkit.log("[Glossa] board source lookup failed", error);
        });
    }
    return paper;
  }

  // ---- actions

  function copyEntry(entry: BoardEntry, button: HTMLButtonElement) {
    try {
      Zotero.Utilities.Internal.copyTextToClipboard(entry.translation);
    } catch (error) {
      ztoolkit.log("[Glossa] board copy failed", error);
      return;
    }
    const original = button.textContent;
    button.textContent = getString("board-copied");
    button.classList.add("glossa-board-copied");
    const timer = win.setTimeout(() => {
      timers.delete(timer);
      if (!doc.contains(button)) return;
      button.textContent = original;
      button.classList.remove("glossa-board-copied");
    }, COPIED_MS);
    timers.add(timer);
  }

  async function removeEntry(entry: BoardEntry, button: HTMLButtonElement) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      await board.remove(entry.id);
    } catch (error) {
      ztoolkit.log("[Glossa] board remove failed", error);
      if (doc.contains(button)) button.disabled = false;
      setOperationError(messageOf(error, "board-remove-error"));
    }
  }

  async function clearBoard() {
    if (clearing || clearButton.disabled) return;
    const confirmed = Services.prompt.confirm(
      win as any,
      "Glossa",
      getString("board-clear-confirm"),
    );
    if (!confirmed) return;
    clearing = true;
    updateClear(board.list().length);
    try {
      await board.clear();
    } catch (error) {
      ztoolkit.log("[Glossa] board clear failed", error);
      setOperationError(messageOf(error, "board-clear-error"));
    } finally {
      clearing = false;
      if (!disposed) updateClear(board.list().length);
    }
  }

  // ---- wiring

  toggle.addEventListener("click", () => setExpanded(!expanded));
  closeButton.addEventListener("click", () => setExpanded(false));
  clearButton.addEventListener("click", () => void clearBoard());

  const onOutsidePointer = (ev: Event) => {
    if (!expanded) return;
    const node = ev.target as Node | null;
    if (node && !root.contains(node)) setExpanded(false);
  };
  const onKeyDown = (ev: Event) => {
    if (expanded && (ev as KeyboardEvent).key === "Escape") {
      ev.stopPropagation();
      setExpanded(false);
    }
  };
  doc.addEventListener("pointerdown", onOutsidePointer);
  doc.addEventListener("keydown", onKeyDown);

  const unsubscribe = board.subscribe(() => render());

  setExpanded(false);
  render();
  void board.ensureLoaded().then(
    () => {
      loaded = true;
      loadFailed = "";
      render();
    },
    (error) => {
      loadFailed = messageOf(error, "board-load-error");
      ztoolkit.log("[Glossa] board load failed", error);
      render();
    },
  );

  return {
    root,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      doc.removeEventListener("pointerdown", onOutsidePointer);
      doc.removeEventListener("keydown", onKeyDown);
      for (const timer of timers) win.clearTimeout(timer);
      timers.clear();
      root.remove();
    },
  };
}

/** Split `${libraryID}/${key}` as stored in `BoardEntry.itemKey`. */
export function parseBoardItemKey(value: string) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  const libraryID = Number(value.slice(0, slash));
  if (!Number.isInteger(libraryID) || libraryID <= 0) return undefined;
  return { libraryID, key: value.slice(slash + 1) };
}

function statusText(entry: BoardEntry) {
  if (entry.mode === "note") return getString("board-note-badge");
  switch (entry.status) {
    case "reviewed":
      return getString("translation-status-reviewed");
    case "review-failed":
      return getString("translation-status-review-failed");
    case "stopped":
      return getString("translation-status-stopped");
    case "incomplete":
      return getString("translation-status-incomplete");
    default:
      return entry.mode === "quick"
        ? getString("translation-status-quick")
        : entry.mode === "review"
          ? getString("translation-review-title")
          : getString("selection-collaborative");
  }
}

function formatDate(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleDateString();
}

function isLongText(text: string) {
  return (
    text.length > LONG_TEXT_CHARS || text.split("\n").length > LONG_TEXT_LINES
  );
}

function previewText(text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > REMOVE_PREVIEW
    ? `${flat.slice(0, REMOVE_PREVIEW)}…`
    : flat;
}

function messageOf(error: unknown, fallbackKey: string) {
  const text = String((error as Error)?.message || error || "");
  return text && text.length < 300 && !text.includes("\n")
    ? text
    : getString(fallbackKey);
}

const PIN_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2.5h5l-.6 3.8 1.9 1.9v1.3H4.2V8.2l1.9-1.9-.6-3.8z"/><path d="M8 9.5V14"/></svg>';

const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

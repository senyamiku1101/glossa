import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { BOARD_SOURCE_LIMIT, type BoardEntry } from "../utils/board";
import { board } from "./board";

export type BoardPanel = {
  root: HTMLElement;
  dispose(): void;
};

export type BoardPanelOptions = {
  /** Called when the entry's source paper title is clicked. */
  onJump(itemKey: string): void;
};

const HTML_NS = "http://www.w3.org/1999/xhtml";
const EXPANDED_PREF = "board.expanded";
const COPIED_MS = 1200;
const REMOVE_PREVIEW = 60;
/** Translations longer than this are folded with a show-more button. */
const LONG_TEXT_LINES = 12;
const LONG_TEXT_CHARS = 800;

let panelCount = 0;

/**
 * The global translation board at the top of the chat pane: a collapsible
 * strip with one card per saved translation. The board store owns the data
 * and notifies subscribers; this module is pure DOM and re-reads the store
 * on every change. All user text is set with `textContent`, never HTML.
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

  const root = element("div", "glossa-board");

  const toggle = element("button", "glossa-board-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-controls", listId);
  const chevron = element("span", "glossa-board-chevron");
  chevron.setAttribute("aria-hidden", "true");
  const title = element("span", "glossa-board-title");
  title.textContent = getString("board-title");
  const count = element("span", "glossa-board-count");
  toggle.append(chevron, title, count);

  const clearButton = element("button", "glossa-board-clear");
  clearButton.type = "button";
  clearButton.textContent = getString("board-clear");

  const head = element("div", "glossa-board-head");
  head.append(toggle, clearButton);

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
    toggle.setAttribute("aria-expanded", String(next));
    toggle.title = getString(next ? "board-collapse" : "board-expand");
    chevron.textContent = next ? "▾" : "▸";
    list.hidden = !next;
    clearButton.hidden = !next;
    syncStatus();
  }

  function updateCount(total: number) {
    count.textContent = getString("board-count", { args: { count: total } });
    toggle.setAttribute(
      "aria-label",
      `${getString("board-title")} · ${count.textContent}`,
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
    // The collapsed strip is a single row; status is only useful when open.
    status.hidden = !text || !expanded;
  }

  function updateClear(total: number) {
    clearButton.disabled =
      clearing || !loaded || Boolean(loadFailed) || total === 0;
  }

  function render() {
    if (disposed) return;
    // A fresh render reflects a new snapshot, so an old failure no longer
    // describes the displayed state.
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

    // Same rhythm as an answer card: body, footer meta, then folded source.
    item.append(renderTranslation(entry));
    item.append(renderMeta(entry));
    item.append(renderSource(entry));
    return item;
  }

  function renderTranslation(entry: BoardEntry): HTMLElement {
    const host = element("div", "glossa-board-text-wrap");
    const text = element("div", "glossa-board-text");
    text.textContent = entry.translation;
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
    summary.textContent = getString("board-source");
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
      `glossa-board-mode glossa-board-tl-${entry.status}`,
    );
    mode.textContent = statusText(entry);

    const date = element("span", "glossa-board-date");
    date.textContent = formatDate(entry.addedAt);

    const actions = element("span", "glossa-board-actions");
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

    // Chip first, like the translation footer; the paper title then reads as
    // the provenance link rather than the leading label.
    meta.append(mode, paper, date, actions);
    return meta;
  }

  /**
   * Source title; clicking jumps back to the item. A deleted item is disabled.
   * After a restart the item is not in memory yet, so a cache miss is checked
   * against the database instead of leaving valid entries disabled.
   */
  function renderPaper(entry: BoardEntry): HTMLButtonElement {
    const paper = element("button", "glossa-board-paper");
    paper.type = "button";
    paper.textContent = entry.itemTitle || getString("no-context");
    const enable = () => {
      paper.disabled = false;
      paper.title = entry.itemTitle;
      paper.setAttribute("aria-label", entry.itemTitle);
      paper.addEventListener("click", () => options.onJump(entry.itemKey));
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
      // Success notifies subscribers; the list re-renders without this card.
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
      // The store may have notified before this frame; restore the button.
      if (!disposed) updateClear(board.list().length);
    }
  }

  // ---- wiring

  toggle.addEventListener("click", () => {
    const next = !expanded;
    setExpanded(next);
    try {
      setPref(EXPANDED_PREF, next);
    } catch (error) {
      ztoolkit.log("[Glossa] board expansion pref failed", error);
    }
  });
  clearButton.addEventListener("click", () => void clearBoard());

  const unsubscribe = board.subscribe(() => render());
  // Every item-pane workspace (library, each reader tab) shares one expansion
  // value; the pref observer keeps them in sync without focus.
  const prefObserver = Zotero.Prefs.registerObserver(
    `${config.prefsPrefix}.${EXPANDED_PREF}`,
    () => setExpanded(Boolean(getPref(EXPANDED_PREF))),
    true,
  );

  setExpanded(Boolean(getPref(EXPANDED_PREF)));
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
      Zotero.Prefs.unregisterObserver(prefObserver);
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

/** Reuse the existing translation labels; no board-specific mode keys. */
function statusText(entry: BoardEntry) {
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

/** Store errors already carry a localized message; keep odd ones generic. */
function messageOf(error: unknown, fallbackKey: string) {
  const text = String((error as Error)?.message || error || "");
  return text && text.length < 300 && !text.includes("\n")
    ? text
    : getString(fallbackKey);
}

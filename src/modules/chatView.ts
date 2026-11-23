import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { boardDedupeKey, type BoardMode } from "../utils/board";
import {
  addContextItem,
  removeContextItem,
  summarizeContextItems,
  type ContextItem,
  type ContextItemInput,
  type ContextItemKind,
} from "../utils/contextTray";
import { renderQuestion, type ContextMode, type Target } from "./context";
import { conversations, type StoreEvent } from "./conversations";
import type { Turn } from "../utils/history";
import { board, type BoardAddInput } from "./board";
import {
  createBoardPanel,
  parseBoardItemKey,
  type BoardPanel,
} from "./boardUI";
import { openGlossaryManager } from "./glossaryUI";
import { renderMarkdown } from "./markdown";
import { runner } from "./runner";
import { saveSessionNote } from "./notes";
import { applyProfile, getProfiles, matchingProfileId } from "./settings";

export type ChatViewOptions = {
  /** Show "Glossa" in the header; the item pane section has its own. */
  title?: boolean;
  /** Mount the shared board strip above the header (item-pane sidebar only). */
  board?: boolean;
  onEscape?: () => void;
  /** Re-resolve the target before sending (the floating panel follows tabs). */
  resolveTarget?: () => Target;
};

const views = new Set<ChatView>();
let prefObservers: symbol[] = [];

/** Pref observers shared by all views, registered once. */
export function initChatViews() {
  const watch = (key: string, fn: (view: ChatView) => void) => {
    prefObservers.push(
      Zotero.Prefs.registerObserver(
        `${config.prefsPrefix}.${key}`,
        () => views.forEach(fn),
        true,
      ),
    );
  };
  watch("chat.contextMode", (view) => view.renderMode());
  for (const key of ["profiles", "profiles.active", "api.model", "api.url"]) {
    watch(key, (view) => view.renderProfiles());
  }
}

export function disposeChatViews() {
  for (const symbol of prefObservers) Zotero.Prefs.unregisterObserver(symbol);
  prefObservers = [];
  for (const view of [...views]) view.dispose();
}

type PendingElements = {
  reasoningBtn: HTMLButtonElement;
  reasoningPane: HTMLDivElement;
  reasoningBody: HTMLElement;
  answer: HTMLElement;
};

/**
 * The chat UI for one conversation: header, transcript + sticky board, composer.
 * It keeps no conversation state of its own; every render reads the store,
 * so a view created mid-answer catches up on its first render.
 */
export class ChatView {
  readonly root: HTMLDivElement;
  private target?: Target;
  private unsubscribe: () => void;
  private readonly boardPanel?: BoardPanel;
  private unsubscribeBoard: () => void;
  private boardButtonKeys = new WeakMap<HTMLButtonElement, string>();
  private boardErrorTimers = new WeakMap<HTMLElement, number>();
  private frame = 0;
  private fullRenderQueued = false;
  private pendingEls?: PendingElements;
  private contextItems: ContextItem[] = [];
  private expandedContextId?: string;
  private attachPaperWithContext = false;
  private shownSession = "";
  private drafts = new Map<string, { text: string; items: ContextItem[] }>();
  private savingNote = false;
  private editingSessionId?: string;

  constructor(
    private readonly win: Window,
    container: Element,
    private readonly options: ChatViewOptions = {},
  ) {
    this.root = this.build(container);
    // Sticky-note board floats pinned at the top edge of the conversation stage.
    if (this.options.board) {
      this.boardPanel = createBoardPanel(this.win, {
        onJump: (itemKey) => void this.jumpToItem(itemKey),
        onAddToChat: (entry) => {
          this.addContext(
            {
              kind: "text",
              text: entry.translation,
              label: getString("board-note-badge"),
            },
            true,
          );
        },
      });
      this.root.querySelector(".glossa-stage")?.prepend(this.boardPanel.root);
    }
    this.unsubscribe = conversations.subscribe((event) =>
      this.onStoreEvent(event),
    );
    // Only button labels change on board events; the transcript is untouched.
    this.unsubscribeBoard = board.subscribe(() => this.refreshBoardButtons());
    views.add(this);
    this.renderProfiles();
    this.renderMode();
    this.renderAll(true);
    // The board may finish loading after the first cards were rendered.
    void board.ensureLoaded().then(
      () => this.refreshBoardButtons(),
      () => this.refreshBoardButtons(),
    );
  }

  dispose() {
    this.dismissCopyMenu();
    this.unsubscribe();
    this.unsubscribeBoard();
    this.boardPanel?.dispose();
    views.delete(this);
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.root.remove();
  }

  get key() {
    return this.target?.key;
  }

  setTarget(target: Target) {
    const changed = this.target?.key !== target.key;
    this.target = target;
    this.renderLabel();
    if (!changed) return;
    const convo = conversations.get(target.key, target.label);
    this.renderAll(true);
    if (!convo.loaded)
      void conversations.ensureLoaded(target.key, target.label);
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  /**
   * Append a text, figure, table or equation context item to the composer's
   * multi-context workbench (deduplicated) and optionally focus the input.
   */
  addContext(item: ContextItemInput, focus = true): boolean {
    const res = addContextItem(this.contextItems, item);
    if (res.added) {
      this.contextItems = res.items;
      this.syncContextTray();
    }
    if (focus) this.input.focus({ preventScroll: true });
    return res.added || res.duplicate;
  }

  /** Legacy helper: add a plain text selection to the context workbench. */
  prefillSelection(text: string, page?: number, focus = true) {
    const quoted = text.replace(/\s+/g, " ").trim();
    if (!quoted) return;
    this.addContext({ kind: "text", text: quoted, page }, focus);
  }

  // ---- DOM

  private get input() {
    return this.root.querySelector("textarea") as HTMLTextAreaElement;
  }

  private get contextTray() {
    return this.root.querySelector(".glossa-context-tray") as HTMLElement;
  }

  private contextKindLabels(): Record<ContextItemKind, string> {
    return {
      text: getString("context-kind-text"),
      figure: getString("context-kind-figure"),
      table: getString("context-kind-table"),
      equation: getString("context-kind-equation"),
    };
  }

  private syncContextToggle() {
    const toggle = this.root.querySelector<HTMLButtonElement>(
      ".glossa-paper-toggle",
    );
    const hasItems = this.contextItems.length > 0;
    if (hasItems) {
      this.input.placeholder = getString("context-placeholder");
      if (toggle) {
        toggle.textContent = getString("context-attach-paper");
        toggle.title = getString("context-attach-paper-tip");
        toggle.setAttribute(
          "aria-pressed",
          String(this.attachPaperWithContext),
        );
        toggle.classList.toggle(
          "glossa-toggle-active",
          this.attachPaperWithContext,
        );
      }
      return;
    }
    const usePaper = usePaperContext();
    this.input.placeholder = getString(
      usePaper ? "composer-placeholder-paper" : "composer-placeholder-chat",
    );
    if (toggle) {
      toggle.textContent = getString("context-use-paper");
      toggle.title = getString("context-use-paper-tip");
      toggle.setAttribute("aria-pressed", String(usePaper));
      toggle.classList.toggle("glossa-toggle-active", usePaper);
    }
  }

  private togglePaperContext() {
    if (this.contextItems.length > 0) {
      this.attachPaperWithContext = !this.attachPaperWithContext;
      this.syncContextToggle();
      return;
    }
    setPref("chat.contextMode", usePaperContext() ? "chat" : "related");
    this.syncContextToggle();
  }

  private syncContextTray() {
    const tray = this.contextTray;
    if (!tray) return;
    const count = this.contextItems.length;
    tray.hidden = count === 0;
    this.input.classList.remove("glossa-needs-input");
    if (!count) {
      this.expandedContextId = undefined;
      this.attachPaperWithContext = false;
      this.syncContextToggle();
      return;
    }
    this.syncContextToggle();
    const titleEl = tray.querySelector(".glossa-ctx-title") as HTMLElement;
    const clearBtn = tray.querySelector(
      ".glossa-ctx-clear",
    ) as HTMLButtonElement;
    const listEl = tray.querySelector(".glossa-ctx-list") as HTMLElement;
    titleEl.textContent = getString("context-tray-title", { args: { count } });
    clearBtn.hidden = count < 2;

    const doc = this.win.document;
    const kindLabels = this.contextKindLabels();
    const frag = doc.createDocumentFragment();
    for (const item of this.contextItems) {
      const expanded = this.expandedContextId === item.id;
      const card = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLDivElement;
      card.className = expanded
        ? "glossa-ctx-item glossa-ctx-expanded"
        : "glossa-ctx-item";

      const row = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLDivElement;
      row.className = "glossa-ctx-row";

      if (item.image) {
        const img = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "img",
        ) as HTMLImageElement;
        img.className = "glossa-ctx-thumb";
        img.src = `data:${item.image.mimeType};base64,${item.image.data}`;
        img.alt = item.caption || kindLabels[item.kind];
        row.append(img);
      } else {
        const icon = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "span",
        ) as HTMLSpanElement;
        icon.className = `glossa-ctx-icon glossa-ctx-icon-${item.kind}`;
        icon.textContent =
          item.kind === "equation"
            ? "∑"
            : item.kind === "table"
              ? "⊞"
              : item.kind === "figure"
                ? "◫"
                : "¶";
        row.append(icon);
      }

      const main = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLDivElement;
      main.className = "glossa-ctx-main";

      const meta = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLDivElement;
      meta.className = "glossa-ctx-meta";
      const metaParts = [item.label || kindLabels[item.kind]];
      if (item.page) {
        metaParts.push(
          getString("context-page-label", { args: { page: item.page } }),
        );
      }
      if (item.kind === "text" && item.text) {
        metaParts.push(
          getString("context-words", { args: { words: wordCount(item.text) } }),
        );
      }
      meta.textContent = metaParts.join(" · ");

      const preview = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLDivElement;
      preview.className = "glossa-ctx-preview";
      const snippet = (
        item.caption ||
        item.text ||
        item.comment ||
        getString("context-preview-empty")
      )
        .replace(/\s+/g, " ")
        .trim();
      preview.textContent = snippet;
      preview.title = snippet;
      main.append(meta, preview);

      const removeBtn = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      ) as HTMLButtonElement;
      removeBtn.type = "button";
      removeBtn.className = "glossa-ctx-remove";
      removeBtn.textContent = "×";
      removeBtn.title = getString("context-item-remove");
      removeBtn.setAttribute("aria-label", getString("context-item-remove"));
      removeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.contextItems = removeContextItem(this.contextItems, item.id);
        if (this.expandedContextId === item.id) {
          this.expandedContextId = undefined;
        }
        this.syncContextTray();
        this.input.focus({ preventScroll: true });
      });

      row.addEventListener("click", () => {
        this.expandedContextId = expanded ? undefined : item.id;
        this.syncContextTray();
      });
      row.append(main, removeBtn);
      card.append(row);

      if (expanded) {
        const detail = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "div",
        ) as HTMLDivElement;
        detail.className = "glossa-ctx-detail";
        if (item.image) {
          const big = doc.createElementNS(
            "http://www.w3.org/1999/xhtml",
            "img",
          ) as HTMLImageElement;
          big.className = "glossa-ctx-detail-img";
          big.src = `data:${item.image.mimeType};base64,${item.image.data}`;
          big.alt = item.caption || kindLabels[item.kind];
          detail.append(big);
        }
        const detailText = [item.caption, item.text, item.comment]
          .filter(Boolean)
          .join("\n\n");
        if (detailText) {
          const body = doc.createElementNS(
            "http://www.w3.org/1999/xhtml",
            "div",
          ) as HTMLDivElement;
          body.className = "glossa-ctx-detail-text";
          renderMarkdown(body, detailText);
          detail.append(body);
        }
        card.append(detail);
      }

      frag.append(card);
    }
    listEl.replaceChildren(frag);
  }

  private get transcript() {
    return this.root.querySelector(".glossa-transcript") as HTMLDivElement;
  }

  private part<T extends HTMLElement>(selector: string) {
    return this.root.querySelector(selector) as T;
  }

  private build(container: Element) {
    const html = "html" as const;
    return ztoolkit.UI.appendElement(
      {
        tag: "div",
        namespace: html,
        classList: ["glossa-chat"],
        listeners: [
          {
            type: "keydown",
            listener: (ev: Event) => {
              const key = ev as KeyboardEvent;
              // Zotero's chrome document has no native copy command for plain
              // text: copy the current selection ourselves on Ctrl+C.
              if (
                (key.ctrlKey || key.metaKey) &&
                !key.shiftKey &&
                !key.altKey &&
                (key.key === "c" || key.key === "C")
              ) {
                if (this.copySelection()) {
                  key.preventDefault();
                  key.stopPropagation();
                }
                return;
              }
              if (key.key !== "Escape") return;
              if (!this.part(".glossa-session-panel").hidden) {
                key.preventDefault();
                key.stopPropagation();
                this.toggleSessions(false);
                this.part(".glossa-session-toggle").focus({
                  preventScroll: true,
                });
                return;
              }
              if (!this.options.onEscape) return;
              key.preventDefault();
              this.options.onEscape();
            },
          },
          {
            type: "contextmenu",
            listener: (ev: Event) => this.onContextMenu(ev as MouseEvent),
          },
        ],
        children: [
          {
            tag: "div",
            namespace: html,
            classList: ["glossa-header"],
            children: [
              ...(this.options.title
                ? [
                    {
                      tag: "span",
                      namespace: html,
                      classList: ["glossa-title"],
                      properties: {
                        textContent: "Glossa",
                        title: getString("shortcut-hint"),
                      },
                    },
                  ]
                : []),
              {
                tag: "span",
                namespace: html,
                classList: ["glossa-session-current"],
              },
              {
                tag: "select",
                namespace: html,
                classList: ["glossa-profile-select"],
                listeners: [
                  {
                    type: "change",
                    listener: (ev: Event) =>
                      void this.switchProfile(
                        (ev.target as HTMLSelectElement).value,
                      ),
                  },
                ],
              },
              {
                tag: "button",
                namespace: html,
                classList: ["glossa-session-toggle", "glossa-icon-button"],
                attributes: {
                  type: "button",
                  "aria-expanded": "false",
                  "aria-label": getString("session-manage"),
                  title: getString("session-manage"),
                },
                properties: { innerHTML: HISTORY_ICON },
                listeners: [
                  { type: "click", listener: () => this.toggleSessions() },
                ],
              },
              {
                tag: "button",
                namespace: html,
                classList: ["glossa-glossary", "glossa-icon-button"],
                attributes: {
                  type: "button",
                  "aria-label": getString("glossary-title"),
                  title: getString("glossary-title"),
                },
                properties: { innerHTML: GLOSSARY_ICON },
                listeners: [
                  {
                    type: "click",
                    listener: () => void openGlossaryManager(),
                  },
                ],
              },
              {
                tag: "button",
                namespace: html,
                classList: ["glossa-new", "glossa-icon-button"],
                attributes: {
                  type: "button",
                  "aria-label": getString("new-chat"),
                  title: getString("new-chat"),
                },
                properties: { innerHTML: COMPOSE_ICON },
                listeners: [
                  { type: "click", listener: () => this.newConversation() },
                ],
              },
            ],
          },
          {
            tag: "div",
            namespace: html,
            classList: ["glossa-session-panel"],
            attributes: {
              hidden: "true",
              role: "region",
              "aria-label": getString("session-manage"),
            },
            children: [
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-history-head"],
                children: [
                  {
                    tag: "strong",
                    namespace: html,
                    classList: ["glossa-history-title"],
                    properties: { textContent: getString("history-title") },
                  },
                  {
                    tag: "button",
                    namespace: html,
                    classList: ["glossa-history-new", "glossa-icon-button"],
                    attributes: {
                      type: "button",
                      "aria-label": getString("new-chat"),
                      title: getString("new-chat"),
                    },
                    properties: { innerHTML: COMPOSE_ICON },
                    listeners: [
                      { type: "click", listener: () => this.newConversation() },
                    ],
                  },
                  {
                    tag: "button",
                    namespace: html,
                    classList: ["glossa-history-back", "glossa-icon-button"],
                    attributes: {
                      type: "button",
                      "aria-label": getString("history-back"),
                      title: getString("history-back"),
                    },
                    properties: { innerHTML: CLOSE_ICON },
                    listeners: [
                      {
                        type: "click",
                        listener: () => this.toggleSessions(false),
                      },
                    ],
                  },
                ],
              },
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-history-search"],
                children: [
                  {
                    tag: "span",
                    namespace: html,
                    classList: ["glossa-history-search-icon"],
                    properties: { innerHTML: SEARCH_ICON },
                  },
                  {
                    tag: "input",
                    namespace: html,
                    classList: ["glossa-session-search"],
                    attributes: {
                      type: "search",
                      placeholder: getString("session-search"),
                      "aria-label": getString("session-search"),
                    },
                    listeners: [
                      { type: "input", listener: () => this.renderSessions() },
                    ],
                  },
                ],
              },
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-history-scope"],
                children: [
                  {
                    tag: "span",
                    namespace: html,
                    classList: ["glossa-history-scope-label"],
                    properties: { textContent: getString("history-scope") },
                  },
                  {
                    tag: "span",
                    namespace: html,
                    classList: ["glossa-history-count"],
                  },
                  {
                    tag: "div",
                    namespace: html,
                    classList: ["glossa-history-paper"],
                  },
                ],
              },
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-session-list"],
              },
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-session-rename-form"],
                attributes: { hidden: "true" },
                children: [
                  {
                    tag: "input",
                    namespace: html,
                    classList: ["glossa-session-name"],
                    attributes: {
                      type: "text",
                      maxlength: "120",
                      "aria-label": getString("session-rename"),
                    },
                    listeners: [
                      {
                        type: "keydown",
                        listener: (ev: Event) => {
                          const key = ev as KeyboardEvent;
                          if (key.isComposing) return;
                          if (key.key === "Enter") {
                            key.preventDefault();
                            this.saveSessionName();
                          }
                        },
                      },
                    ],
                  },
                  {
                    tag: "button",
                    namespace: html,
                    properties: { textContent: getString("session-save-name") },
                    listeners: [
                      { type: "click", listener: () => this.saveSessionName() },
                    ],
                  },
                ],
              },
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-session-status"],
                attributes: { role: "status", "aria-live": "polite" },
              },
            ],
          },
          {
            tag: "div",
            namespace: html,
            classList: ["glossa-stage"],
            children: [
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-transcript"],
              },
            ],
          },
          {
            tag: "div",
            namespace: html,
            classList: ["glossa-composer"],
            children: [
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-context-tray"],
                attributes: { hidden: "true" },
                children: [
                  {
                    tag: "div",
                    namespace: html,
                    classList: ["glossa-ctx-header"],
                    children: [
                      {
                        tag: "span",
                        namespace: html,
                        classList: ["glossa-ctx-title"],
                      },
                      {
                        tag: "button",
                        namespace: html,
                        classList: ["glossa-ctx-clear"],
                        attributes: { type: "button", hidden: "true" },
                        properties: {
                          textContent: getString("context-tray-clear"),
                        },
                        listeners: [
                          {
                            type: "click",
                            listener: () => {
                              this.contextItems = [];
                              this.expandedContextId = undefined;
                              this.attachPaperWithContext = false;
                              this.syncContextTray();
                              this.input.focus({ preventScroll: true });
                            },
                          },
                        ],
                      },
                    ],
                  },
                  {
                    tag: "div",
                    namespace: html,
                    classList: ["glossa-ctx-list"],
                  },
                ],
              },
              {
                tag: "textarea",
                namespace: html,
                attributes: {
                  rows: "2",
                  placeholder: getString("composer-placeholder-paper"),
                },
                listeners: [
                  {
                    type: "keydown",
                    listener: (ev: Event) => {
                      const event = ev as KeyboardEvent;
                      // Enter also confirms an IME candidate; let it.
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.isComposing
                      ) {
                        event.preventDefault();
                        void this.send();
                      }
                    },
                  },
                  { type: "focus", listener: () => this.refreshTarget() },
                  {
                    type: "input",
                    listener: () => {
                      if (this.input.classList.contains("glossa-needs-input")) {
                        this.syncContextTray();
                      }
                    },
                  },
                ],
              },
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-composer-bar"],
                children: [
                  {
                    tag: "button",
                    namespace: html,
                    classList: ["glossa-paper-toggle"],
                    attributes: {
                      type: "button",
                      "aria-pressed": "false",
                    },
                    listeners: [
                      {
                        type: "click",
                        listener: () => this.togglePaperContext(),
                      },
                    ],
                  },
                  {
                    tag: "button",
                    namespace: html,
                    classList: ["glossa-stop"],
                    properties: {
                      textContent: getString("stop"),
                      hidden: true,
                    },
                    listeners: [
                      { type: "click", listener: () => runner.stop() },
                    ],
                  },
                  {
                    tag: "button",
                    namespace: html,
                    classList: ["glossa-send"],
                    attributes: {
                      type: "button",
                      title: getString("send"),
                    },
                    properties: { innerHTML: SEND_ICON },
                    listeners: [
                      { type: "click", listener: () => void this.send() },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      container,
    ) as HTMLDivElement;
  }

  // ---- rendering

  private onStoreEvent(event: StoreEvent) {
    if (event.kind === "busy") this.renderBusy();
    if (event.key !== this.key) return;
    if (event.kind === "session") {
      this.renderAll(true);
      return;
    }
    if (
      event.kind === "busy" &&
      conversations.busyKey === this.key &&
      conversations.busySessionId === conversations.active(this.key!).id
    ) {
      this.contextItems = [];
      this.expandedContextId = undefined;
      this.attachPaperWithContext = false;
      this.syncContextTray();
    }
    if (event.kind !== "busy") this.schedule(event.kind !== "delta");
  }

  /** Coalesce store events into one paint per frame. */
  private schedule(full: boolean) {
    this.fullRenderQueued ||= full;
    if (this.frame) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      const full = this.fullRenderQueued || !this.pendingEls;
      this.fullRenderQueued = false;
      try {
        if (full) this.renderAll(false);
        else this.renderPending();
      } catch (error) {
        ztoolkit.log("[Glossa] render failed", error);
      }
    });
  }

  private renderLabel() {
    const title = this.root.querySelector<HTMLElement>(".glossa-title");
    if (title) {
      title.title = [
        this.target?.label || getString("no-context"),
        getString("shortcut-hint"),
      ].join("\n");
    }
  }

  private renderAll(forceScroll: boolean) {
    const out = this.transcript;
    const follow = forceScroll || isNearEnd(out);
    out.replaceChildren();
    this.pendingEls = undefined;
    this.syncSession();
    this.renderSessions();
    this.renderBusy();
    if (!this.target) return;
    const bucket = conversations.get(this.target.key);
    const convo = conversations.active(this.target.key);
    if (bucket.storageError) {
      appendBubble(out, "error", getString("session-storage-error"));
    }
    if (!bucket.loaded) {
      appendBubble(out, "hint", getString("loading"));
      return;
    }
    if (!convo.turns.length && !convo.pending && !convo.failed) {
      appendBubble(out, "hint", getString("empty-hint"));
    }
    convo.turns.forEach((turn, turnIndex) => {
      const text = turn.display ?? turn.content;
      if (turn.role === "user") {
        appendBubble(out, "user", text);
        return;
      }
      const prevUser =
        turnIndex > 0 && convo.turns[turnIndex - 1]?.role === "user"
          ? convo.turns[turnIndex - 1]
          : undefined;
      const { card, body } = this.answerBlock(out, {
        reasoning: turn.reasoning,
        source: prevUser?.source,
      });
      renderMarkdown(body, text);
      this.cardFooter(card, turn, prevUser, convo.id, turnIndex);
    });
    if (convo.failed) {
      // Not in the history: shown struck through, with the reason.
      appendBubble(out, "user", convo.failed.display).classList.add(
        "glossa-dropped",
      );
      appendBubble(out, "error", convo.failed.error);
    }
    if (convo.pending) {
      appendBubble(out, "user", convo.pending.display);
      const pendingCard = this.answerBlock(out, { livePending: true });
      this.pendingEls = {
        reasoningBtn: pendingCard.liveReasoningBtn!,
        reasoningPane: pendingCard.liveReasoningPane!,
        reasoningBody: pendingCard.liveReasoningBody!,
        answer: pendingCard.body,
      };
      this.renderPending();
    }
    // Cards were rebuilt from the store; re-apply current board membership.
    this.refreshBoardButtons();
    if (follow) out.scrollTop = out.scrollHeight;
  }

  private renderPending() {
    const pending =
      this.target && conversations.active(this.target.key).pending;
    const els = this.pendingEls;
    if (!pending || !els) return;
    const out = this.transcript;
    const follow = isNearEnd(out);
    const stage = pending.stage;
    const hasReasoning = Boolean(pending.reasoning);
    els.reasoningBtn.hidden = !hasReasoning && !stage;
    els.reasoningBtn.textContent =
      stage === "reviewing"
        ? getString("translation-phase-review")
        : stage === "translating"
          ? getString("translation-phase-draft")
          : getString(
              pending.text ? "card-toggle-reasoning" : "reasoning-live",
            );
    els.reasoningBtn.disabled = !hasReasoning;
    els.reasoningBody.textContent = pending.reasoning;
    if (!hasReasoning) els.reasoningPane.hidden = true;
    renderMarkdown(els.answer, pending.text || getString("thinking"));
    if (follow) out.scrollTop = out.scrollHeight;
  }

  private answerBlock(
    host: Element,
    inspector: {
      reasoning?: string;
      source?: { text: string; truncated: boolean };
      livePending?: boolean;
    } = {},
  ) {
    const doc = this.win.document;
    const card = ztoolkit.UI.appendElement(
      {
        tag: "div",
        namespace: "html",
        classList: ["glossa-answer-card"],
        children: [
          {
            tag: "div",
            namespace: "html",
            classList: ["glossa-answer-top"],
            children: [
              {
                tag: "div",
                namespace: "html",
                classList: ["glossa-answer-label"],
                properties: { textContent: getString("note-label") },
              },
              {
                tag: "div",
                namespace: "html",
                classList: ["glossa-answer-tools"],
                children: [
                  {
                    tag: "button",
                    namespace: "html",
                    classList: ["glossa-icon-button", "glossa-copy-answer"],
                    attributes: {
                      type: "button",
                      title: getString("copy"),
                      "aria-label": getString("copy"),
                    },
                    properties: { innerHTML: COPY_ICON },
                    listeners: [
                      {
                        type: "click",
                        listener: (ev: Event) => {
                          const btn = ev.currentTarget as HTMLElement;
                          const body = btn
                            .closest(".glossa-answer-card")
                            ?.querySelector(
                              ".glossa-assistant",
                            ) as HTMLElement | null;
                          this.copyText(body ? extractText(body) : "");
                          this.flashCopied(btn);
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            tag: "div",
            namespace: "html",
            classList: ["glossa-msg", "glossa-assistant"],
          },
        ],
      },
      host,
    ) as HTMLElement;

    const tools = card.querySelector(".glossa-answer-tools") as HTMLElement;
    const copyBtn = tools.querySelector(".glossa-copy-answer") as HTMLElement;
    const body = card.querySelector(".glossa-assistant") as HTMLElement;

    const makeToggle = (label: string, title: string) => {
      const btn = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      ) as HTMLButtonElement;
      btn.type = "button";
      btn.className = "glossa-meta-toggle";
      btn.textContent = label;
      btn.title = title;
      btn.setAttribute("aria-expanded", "false");
      return btn;
    };

    const makePane = (cls: string) => {
      const pane = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLDivElement;
      pane.className = `glossa-inline-inspector ${cls}`;
      pane.hidden = true;
      return pane;
    };

    const panes: Array<{ btn: HTMLButtonElement; pane: HTMLDivElement }> = [];
    const wireToggle = (btn: HTMLButtonElement, pane: HTMLDivElement) => {
      const entry = { btn, pane };
      panes.push(entry);
      btn.addEventListener("click", () => {
        const opening = pane.hidden;
        for (const other of panes) {
          other.pane.hidden = true;
          other.btn.setAttribute("aria-expanded", "false");
          other.btn.classList.remove("glossa-meta-active");
        }
        if (opening) {
          pane.hidden = false;
          btn.setAttribute("aria-expanded", "true");
          btn.classList.add("glossa-meta-active");
        }
      });
    };

    let liveReasoningBtn: HTMLButtonElement | undefined;
    let liveReasoningPane: HTMLDivElement | undefined;
    let liveReasoningBody: HTMLElement | undefined;

    if (inspector.livePending) {
      liveReasoningBtn = makeToggle(
        getString("reasoning-live"),
        getString("reasoning"),
      );
      liveReasoningBtn.hidden = true;
      liveReasoningPane = makePane("glossa-inspector-reasoning");
      liveReasoningBody = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLDivElement;
      liveReasoningBody.className = "glossa-reasoning-body";
      liveReasoningPane.append(liveReasoningBody);
      tools.insertBefore(liveReasoningBtn, copyBtn);
      card.insertBefore(liveReasoningPane, body);
      wireToggle(liveReasoningBtn, liveReasoningPane);
    } else {
      if (inspector.reasoning) {
        const btn = makeToggle(
          getString("card-toggle-reasoning"),
          getString("reasoning"),
        );
        const pane = makePane("glossa-inspector-reasoning");
        const content = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "div",
        ) as HTMLDivElement;
        content.className = "glossa-reasoning-body";
        content.textContent = inspector.reasoning;
        pane.append(content);
        tools.insertBefore(btn, copyBtn);
        card.insertBefore(pane, body);
        wireToggle(btn, pane);
      }
      if (inspector.source) {
        const btn = makeToggle(
          getString("card-toggle-context"),
          getString("source-trace"),
        );
        const pane = makePane("glossa-inspector-source");
        const help = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "p",
        ) as HTMLParagraphElement;
        help.className = "glossa-source-help";
        help.textContent = getString(
          inspector.source.truncated
            ? "source-truncated"
            : "source-description",
        );
        const pre = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "pre",
        ) as HTMLPreElement;
        pre.textContent = inspector.source.text;
        pane.append(help, pre);
        tools.insertBefore(btn, copyBtn);
        card.insertBefore(pane, body);
        wireToggle(btn, pane);
      }
    }

    return {
      card,
      body,
      liveReasoningBtn,
      liveReasoningPane,
      liveReasoningBody,
    };
  }

  /**
   * Unified action bar under every committed answer card: supports Pin to Board
   * and Delete for all Q&A notes as well as legacy translation metadata/review.
   */
  private cardFooter(
    card: Element,
    turn: Turn,
    prevUser: Turn | undefined,
    sessionId: string,
    turnIndex: number,
  ) {
    const info = turn.translation;
    const statusKey = info
      ? info.status === "reviewed"
        ? "translation-status-reviewed"
        : info.status === "review-failed"
          ? "translation-status-review-failed"
          : info.status === "stopped"
            ? "translation-status-stopped"
            : info.status === "incomplete"
              ? "translation-status-incomplete"
              : info.mode === "quick"
                ? "translation-status-quick"
                : info.mode === "review"
                  ? "translation-review-title"
                  : "selection-collaborative"
      : undefined;
    const reviewable = Boolean(
      info &&
      info.source &&
      !info.sourceTruncated &&
      info.status !== "incomplete" &&
      turn.content.trim(),
    );
    const key = this.key;
    const bucket = key ? conversations.get(key) : undefined;
    const actionDisabled =
      runner.busy || !bucket || !bucket.loaded || !!bucket.storageError;
    const itemKey = this.key;
    const boardMode: BoardMode = info ? info.mode : "note";
    const canBoard = Boolean(
      itemKey && turn.content.trim() && info?.status !== "incomplete",
    );
    const boardKey = canBoard
      ? boardDedupeKey({
          itemKey: itemKey!,
          mode: boardMode,
          translation: turn.content,
        })
      : "";
    const boardAdded = boardKey ? board.has(boardKey) : false;
    const noteSource =
      info?.source ?? (prevUser?.display || prevUser?.content || "");
    const host = ztoolkit.UI.appendElement(
      {
        tag: "div",
        namespace: "html",
        classList: ["glossa-translation-meta", "glossa-card-footer"],
        children: [
          ...(info && statusKey
            ? [
                {
                  tag: "span",
                  namespace: "html" as const,
                  classList: [
                    "glossa-translation-chip",
                    `glossa-tl-${info.status}`,
                  ],
                  properties: { textContent: getString(statusKey) },
                },
              ]
            : []),
          ...(info?.translator
            ? [
                {
                  tag: "span",
                  namespace: "html" as const,
                  classList: ["glossa-translation-model"],
                  properties: {
                    textContent: getString("translation-translator", {
                      args: { model: info.translator },
                    }),
                    title: info.translator,
                  },
                },
              ]
            : []),
          ...(info?.reviewer
            ? [
                {
                  tag: "span",
                  namespace: "html" as const,
                  classList: ["glossa-translation-model"],
                  properties: {
                    textContent: getString("translation-reviewer", {
                      args: { model: info.reviewer },
                    }),
                    title: info.reviewer,
                  },
                },
              ]
            : []),
          ...(boardKey
            ? [
                {
                  tag: "button",
                  namespace: "html" as const,
                  classList: ["glossa-board-add"],
                  attributes: {
                    type: "button",
                  },
                  properties: {
                    textContent: getString(
                      boardAdded ? "board-added" : "board-add",
                    ),
                    disabled: boardAdded,
                  },
                  listeners: [
                    {
                      type: "click",
                      listener: (ev: Event) =>
                        void this.addToBoard(
                          ev.currentTarget as HTMLButtonElement,
                          {
                            itemKey: itemKey!,
                            itemTitle: this.target?.label || "",
                            translation: info
                              ? {
                                  mode: info.mode,
                                  status: info.status,
                                  source: info.source,
                                  ...(info.sourceTruncated
                                    ? { sourceTruncated: true }
                                    : {}),
                                  ...(info.translator
                                    ? { translator: info.translator }
                                    : {}),
                                  ...(info.reviewer
                                    ? { reviewer: info.reviewer }
                                    : {}),
                                }
                              : {
                                  mode: "note",
                                  status: "draft",
                                  source: noteSource,
                                },
                            text: turn.content,
                          },
                        ),
                    },
                  ],
                },
              ]
            : []),
          {
            tag: "button",
            namespace: "html" as const,
            classList: ["glossa-translation-delete", "glossa-card-delete"],
            attributes: {
              type: "button",
              title: getString("card-delete"),
            },
            properties: {
              textContent: getString("card-delete"),
              disabled: actionDisabled,
            },
            listeners: [
              {
                type: "click",
                listener: () => this.deleteExchange(sessionId, turnIndex),
              },
            ],
          },
          ...(reviewable
            ? [
                {
                  tag: "button",
                  namespace: "html" as const,
                  classList: ["glossa-translation-review"],
                  attributes: { type: "button" },
                  properties: {
                    textContent: getString("translation-review-action"),
                    title: getString("translation-review-action"),
                    disabled: actionDisabled,
                  },
                  listeners: [
                    {
                      type: "click",
                      listener: (ev: Event) => {
                        const button = ev.currentTarget as HTMLButtonElement;
                        button.disabled = true;
                        void this.reviewTranslation(
                          sessionId,
                          turnIndex,
                        ).finally(() => this.renderBusy());
                      },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      card,
    ) as HTMLElement;
    const boardButton =
      host.querySelector<HTMLButtonElement>(".glossa-board-add");
    if (boardButton && boardKey)
      this.boardButtonKeys.set(boardButton, boardKey);
    if (info?.warning) {
      ztoolkit.UI.appendElement(
        {
          tag: "div",
          namespace: "html",
          classList: ["glossa-translation-warning"],
          properties: { textContent: info.warning },
        },
        host,
      );
    }
    if (info?.draft && info.draft !== turn.content) {
      const details = ztoolkit.UI.appendElement(
        {
          tag: "details",
          namespace: "html",
          classList: ["glossa-translation-draft"],
          children: [
            {
              tag: "summary",
              namespace: "html",
              properties: { textContent: getString("translation-draft-label") },
            },
            {
              tag: "div",
              namespace: "html",
              classList: ["glossa-translation-draft-body"],
            },
          ],
        },
        host,
      ) as HTMLDetailsElement;
      const body = details.querySelector(
        ".glossa-translation-draft-body",
      ) as HTMLElement;
      body.textContent = info.draft;
    }
  }

  /**
   * Ask the store to review one committed translation turn in place. The
   * runner reports configuration problems or a busy pipeline as a failed
   * pending turn itself; false only means nothing ran.
   */
  private async reviewTranslation(sessionId: string, turnIndex: number) {
    this.refreshTarget();
    if (!this.target) return;
    try {
      await runner.reviewTranslation({
        target: this.target,
        sessionId,
        turnIndex,
      });
    } catch (error) {
      ztoolkit.log("[Glossa] review translation failed", error);
    }
  }

  /**
   * Delete one committed Q&A exchange (answer and its user question). The
   * board keeps its own copy; this only edits the transcript.
   */
  private deleteExchange(sessionId: string, turnIndex: number) {
    const key = this.key;
    if (!key) return;
    const bucket = conversations.get(key);
    if (!bucket.loaded || bucket.storageError || runner.busy) return;
    if (
      !Services.prompt.confirm(
        this.win as any,
        "Glossa",
        getString("card-delete-confirm"),
      )
    )
      return;
    if (!conversations.deleteExchange(key, sessionId, turnIndex)) {
      Services.prompt.alert(
        this.win as any,
        "Glossa",
        getString("card-delete-failed"),
      );
    }
  }

  /** Add one committed translation card to the shared board. */
  private async addToBoard(button: HTMLButtonElement, input: BoardAddInput) {
    if (button.disabled) return;
    button.dataset.busy = "1";
    button.disabled = true;
    const card = button.closest(".glossa-answer-card");
    try {
      // A duplicate is a success too: the same text is already on the board.
      await board.add(input);
      button.textContent = getString("board-added");
      this.clearBoardError(card);
    } catch (error) {
      ztoolkit.log("[Glossa] board add failed", error);
      if (this.root.contains(button)) {
        button.disabled = false;
        button.textContent = getString("board-add");
      }
      this.showBoardError(card, messageOf(error, "board-save-error"));
    } finally {
      delete button.dataset.busy;
    }
  }

  /** Board membership changed elsewhere; only the meta rows need updating. */
  private refreshBoardButtons() {
    this.root
      .querySelectorAll<HTMLButtonElement>(".glossa-board-add")
      .forEach((button: HTMLButtonElement) => {
        const key = this.boardButtonKeys.get(button);
        if (!key) return;
        const added = board.has(key);
        button.textContent = getString(added ? "board-added" : "board-add");
        if (added) button.disabled = true;
        else if (button.dataset.busy !== "1") button.disabled = false;
      });
  }

  /** A failed add must stay visible on the card it belongs to. */
  private showBoardError(card: Element | null, message: string) {
    if (!card) return;
    let error = card.querySelector<HTMLElement>(".glossa-board-error");
    if (!error) {
      error = this.win.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "span",
      ) as HTMLSpanElement;
      error.className = "glossa-board-error";
      error.setAttribute("role", "status");
      const meta = card.querySelector(".glossa-translation-meta");
      (meta || card).append(error);
    }
    error.textContent = message;
    const node = error;
    const previous = this.boardErrorTimers.get(node);
    if (previous) this.win.clearTimeout(previous);
    const timer = this.win.setTimeout(() => {
      this.boardErrorTimers.delete(node);
      if (node.isConnected) node.remove();
    }, 6000);
    this.boardErrorTimers.set(node, timer);
  }

  private clearBoardError(card: Element | null) {
    const error = card?.querySelector<HTMLElement>(".glossa-board-error");
    if (!error) return;
    const timer = this.boardErrorTimers.get(error);
    if (timer) this.win.clearTimeout(timer);
    this.boardErrorTimers.delete(error);
    error.remove();
  }

  /** Open a board entry's PDF, or select its item when it has no attachment. */
  private async jumpToItem(itemKey: string) {
    const parsed = parseBoardItemKey(itemKey);
    if (!parsed) return;
    let item = Zotero.Items.getByLibraryAndKey(parsed.libraryID, parsed.key);
    if (!item) {
      // After a restart the source item is not in memory yet.
      try {
        item = await Zotero.Items.getByLibraryAndKeyAsync(
          parsed.libraryID,
          parsed.key,
        );
      } catch (error) {
        ztoolkit.log("[Glossa] board item lookup failed", error);
        return;
      }
    }
    // A deleted item leaves nothing to jump to; the title is already disabled.
    if (!item) return;
    try {
      const attachment = await item.getBestAttachment();
      if (attachment) {
        await Zotero.Reader.open(attachment.id);
        return;
      }
    } catch (error) {
      ztoolkit.log("[Glossa] board item open failed", error);
    }
    try {
      Zotero.getActiveZoteroPane()?.selectItem(item.id);
    } catch (error) {
      ztoolkit.log("[Glossa] board item select failed", error);
    }
  }

  private renderBusy() {
    const busy = runner.busy;
    const bucket = this.key ? conversations.get(this.key) : undefined;
    const current = this.key ? conversations.active(this.key) : undefined;
    const mine =
      busy &&
      conversations.busyKey === this.key &&
      (!conversations.busySessionId ||
        conversations.busySessionId === (current && current.id));
    this.part(".glossa-stop").hidden = !mine;
    this.part<HTMLButtonElement>(".glossa-send").hidden = mine;
    this.part<HTMLButtonElement>(".glossa-send").disabled =
      busy || !bucket || !bucket.loaded || !!bucket.storageError;
    this.root
      .querySelectorAll<HTMLButtonElement>(".glossa-new, .glossa-history-new")
      .forEach((button: HTMLButtonElement) => {
        button.disabled = !bucket || !bucket.loaded || !!bucket.storageError;
      });
    this.part<HTMLButtonElement>(".glossa-session-toggle").disabled =
      !bucket || !bucket.loaded;
    this.root
      .querySelectorAll<HTMLButtonElement>(".glossa-session-delete")
      .forEach((button: HTMLButtonElement) => {
        button.disabled =
          !bucket ||
          !bucket.loaded ||
          !!bucket.storageError ||
          (conversations.busyKey === this.key &&
            conversations.busySessionId === button.dataset.sessionId);
      });
    this.root
      .querySelectorAll<HTMLButtonElement>(".glossa-session-note")
      .forEach((button: HTMLButtonElement) => {
        const session = bucket?.sessions.find(
          (entry) => entry.id === button.dataset.sessionId,
        );
        button.disabled =
          this.savingNote ||
          !bucket?.loaded ||
          !!bucket.storageError ||
          !session?.turns.length ||
          !this.target?.item ||
          (conversations.busyKey === this.key &&
            conversations.busySessionId === session.id);
      });
    this.root
      .querySelectorAll<HTMLButtonElement>(
        ".glossa-session-rename, .glossa-session-more",
      )
      .forEach((button: HTMLButtonElement) => {
        button.disabled = !bucket || !bucket.loaded || !!bucket.storageError;
      });
    this.root
      .querySelectorAll<HTMLButtonElement>(
        ".glossa-translation-review, .glossa-card-delete",
      )
      .forEach((button: HTMLButtonElement) => {
        button.disabled =
          busy || !bucket || !bucket.loaded || !!bucket.storageError;
      });
    this.input.disabled = !bucket || !bucket.loaded || !!bucket.storageError;
    this.root.classList.toggle("glossa-busy", busy);
  }

  renderMode() {
    this.syncContextToggle();
  }

  /** Profile switcher; hidden until the user saves a profile. */
  renderProfiles() {
    const select = this.part<HTMLSelectElement>(".glossa-profile-select");
    const profiles = getProfiles();
    select.hidden = !profiles.length;
    select.replaceChildren();
    if (!profiles.length) return;
    const active = matchingProfileId();
    const options = [
      ...(active ? [] : [{ id: "", name: getString("profile-custom") }]),
      ...profiles,
    ];
    for (const { id, name } of options) {
      ztoolkit.UI.appendElement(
        {
          tag: "option",
          namespace: "html",
          properties: { value: id, textContent: name },
        },
        select,
      );
    }
    select.value = active || "";
    select.title = String(getPref("api.model") || "");
  }

  // ---- actions

  private refreshTarget() {
    if (this.options.resolveTarget) {
      this.setTarget(this.options.resolveTarget());
    }
  }

  private async send() {
    this.refreshTarget();
    const box = this.input;
    const input = box.value.trim();
    if (!input || runner.busy || !this.target) return;
    const bucket = conversations.get(this.target.key);
    if (!bucket.loaded || bucket.storageError) return;
    const sentItems = [...this.contextItems];
    const sentAttachPaper = this.attachPaperWithContext;
    box.value = "";
    // WYSIWYG context rule:
    // - When the user staged context items, send ONLY those items by default
    //   unless they explicitly turned on "+ Search full paper".
    // - When no items are staged, follow the "Use current paper" toggle.
    const mode: ContextMode = sentItems.length
      ? sentAttachPaper
        ? "related"
        : "chat"
      : usePaperContext()
        ? "related"
        : "chat";
    const sentKey = this.target.key;
    const sentSession = conversations.active(sentKey).id;
    const summary = summarizeContextItems(sentItems, this.contextKindLabels());
    const answered = await runner.ask({
      target: this.target,
      sessionId: sentSession,
      display: summary ? `${summary} · ${input}` : input,
      build: (target, snapshot) =>
        renderQuestion(input, target, mode, snapshot, undefined, sentItems),
    });
    // A failed question restores both the typed text and the staged context.
    if (!answered) {
      if (
        this.key === sentKey &&
        conversations.active(sentKey).id === sentSession
      ) {
        if (!box.value) box.value = input;
        if (!this.contextItems.length && sentItems.length) {
          this.contextItems = sentItems;
          this.attachPaperWithContext = sentAttachPaper;
          this.syncContextTray();
        }
      } else {
        const draftKey = sentKey + "#" + sentSession;
        const draft = this.drafts.get(draftKey);
        if (!draft?.text) {
          this.drafts.set(draftKey, {
            text: input,
            items: draft?.items?.length ? draft.items : sentItems,
          });
        }
      }
    }
  }

  private syncSession() {
    const next = this.key
      ? this.key + "#" + conversations.get(this.key).activeId
      : "";
    if (next === this.shownSession) return;
    if (this.shownSession) {
      this.drafts.set(this.shownSession, {
        text: this.input.value,
        items: [...this.contextItems],
      });
    }
    this.shownSession = next;
    this.part<HTMLInputElement>(".glossa-session-search").value = "";
    const draft = this.drafts.get(next);
    this.input.value = draft?.text || "";
    this.contextItems = draft?.items ? [...draft.items] : [];
    this.expandedContextId = undefined;
    this.syncContextTray();
    this.part(".glossa-session-status").textContent = "";
    this.part(".glossa-session-rename-form").hidden = true;
  }

  private toggleSessions(
    open: boolean = Boolean(this.part(".glossa-session-panel").hidden),
  ) {
    this.part(".glossa-session-panel").hidden = !open;
    this.part(".glossa-session-toggle").setAttribute(
      "aria-expanded",
      String(open),
    );
    this.root.classList.toggle("glossa-history-open", open);
    if (open) {
      this.renderSessions();
      this.part<HTMLInputElement>(".glossa-session-search").focus({
        preventScroll: true,
      });
    } else {
      this.editingSessionId = undefined;
      this.part(".glossa-session-rename-form").hidden = true;
    }
  }

  private renderSessions() {
    const list = this.part(".glossa-session-list");
    list.replaceChildren();
    const paper = this.part(".glossa-history-paper");
    paper.textContent = this.target?.label || getString("no-context");
    paper.title = this.target?.label || "";
    const currentLabel = this.part(".glossa-session-current");
    if (!this.key) {
      currentLabel.textContent = getString("session-untitled");
      this.part(".glossa-history-count").textContent = "";
      return;
    }
    const bucket = conversations.get(this.key);
    const current = conversations.active(this.key);
    currentLabel.textContent = current.title || getString("session-untitled");
    currentLabel.title = currentLabel.textContent;
    this.part(".glossa-history-count").textContent = getString(
      "history-count",
      { args: { count: bucket.sessions.length } },
    );
    const query = this.part<HTMLInputElement>(".glossa-session-search")
      .value.trim()
      .toLocaleLowerCase();
    for (const session of [...bucket.sessions].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )) {
      const title = session.title || getString("session-untitled");
      const searchable =
        title +
        " " +
        session.turns.map((turn) => turn.display ?? turn.content).join(" ");
      if (query && !searchable.toLocaleLowerCase().includes(query)) continue;
      const when = session.pending
        ? getString("thinking")
        : formatSessionTime(session.updatedAt);
      const item = ztoolkit.UI.appendElement(
        {
          tag: "div",
          namespace: "html",
          classList: ["glossa-history-item"],
          children: [
            {
              tag: "div",
              namespace: "html",
              classList: ["glossa-history-line"],
              children: [
                {
                  tag: "button",
                  namespace: "html",
                  classList: ["glossa-session-row"],
                  attributes: {
                    type: "button",
                    "aria-current":
                      session.id === current.id ? "true" : "false",
                    title: getString("session-meta", {
                      args: {
                        count: Math.ceil(session.turns.length / 2),
                        date: new Date(session.updatedAt).toLocaleDateString(),
                      },
                    }),
                  },
                  children: [
                    {
                      tag: "span",
                      namespace: "html",
                      classList: ["glossa-session-row-title"],
                      properties: { textContent: title },
                    },
                    {
                      tag: "span",
                      namespace: "html",
                      classList: ["glossa-session-row-meta"],
                      properties: { textContent: when },
                    },
                  ],
                  listeners: [
                    {
                      type: "click",
                      listener: () => {
                        if (!this.key) return;
                        conversations.selectSession(this.key, session.id);
                        this.toggleSessions(false);
                        this.focus();
                      },
                    },
                  ],
                },
                {
                  tag: "button",
                  namespace: "html",
                  classList: ["glossa-session-more", "glossa-icon-button"],
                  attributes: {
                    type: "button",
                    "aria-label": getString("history-actions"),
                    "aria-expanded": "false",
                    title: getString("history-actions"),
                  },
                  properties: { textContent: "···" },
                },
              ],
            },
            {
              tag: "div",
              namespace: "html",
              classList: ["glossa-session-actions"],
              attributes: { hidden: "true" },
              children: [
                {
                  tag: "button",
                  namespace: "html",
                  classList: ["glossa-session-rename"],
                  attributes: {
                    type: "button",
                    "data-session-id": session.id,
                  },
                  properties: { textContent: getString("session-rename") },
                  listeners: [
                    {
                      type: "click",
                      listener: () => this.renameSession(session.id),
                    },
                  ],
                },
                {
                  tag: "button",
                  namespace: "html",
                  classList: ["glossa-session-note"],
                  attributes: {
                    type: "button",
                    "data-session-id": session.id,
                  },
                  properties: { textContent: getString("session-save-note") },
                  listeners: [
                    {
                      type: "click",
                      listener: () => void this.saveNote(session.id),
                    },
                  ],
                },
                {
                  tag: "button",
                  namespace: "html",
                  classList: ["glossa-session-delete"],
                  attributes: {
                    type: "button",
                    "data-session-id": session.id,
                  },
                  properties: { textContent: getString("session-delete") },
                  listeners: [
                    {
                      type: "click",
                      listener: () => this.deleteSession(session.id),
                    },
                  ],
                },
              ],
            },
          ],
        },
        list,
      ) as HTMLElement;
      const more = item.querySelector(
        ".glossa-session-more",
      ) as HTMLButtonElement;
      const actions = item.querySelector(
        ".glossa-session-actions",
      ) as HTMLElement;
      more.addEventListener("click", () => {
        const open = actions.hidden;
        list
          .querySelectorAll<HTMLElement>(".glossa-session-actions")
          .forEach((panel: HTMLElement) => {
            panel.hidden = true;
          });
        list
          .querySelectorAll<HTMLButtonElement>(".glossa-session-more")
          .forEach((button: HTMLButtonElement) =>
            button.setAttribute("aria-expanded", "false"),
          );
        actions.hidden = !open;
        more.setAttribute("aria-expanded", String(open));
      });
    }
    if (!list.childElementCount)
      list.textContent = getString("session-no-results");
    this.renderBusy();
  }

  private newConversation() {
    if (!this.key || !conversations.createSession(this.key)) return;
    this.renderAll(true);
    this.toggleSessions(false);
    this.focus();
  }

  private renameSession(id: string) {
    if (!this.key) return;
    const session = conversations
      .get(this.key)
      .sessions.find((entry) => entry.id === id);
    if (!session) return;
    this.editingSessionId = id;
    const input = this.part<HTMLInputElement>(".glossa-session-name");
    this.part(".glossa-session-rename-form").hidden = false;
    input.value = session.title;
    input.focus({ preventScroll: true });
    input.select();
  }

  private saveSessionName() {
    if (!this.key || !this.editingSessionId) return;
    const name = this.part<HTMLInputElement>(
      ".glossa-session-name",
    ).value.trim();
    if (!name) return;
    conversations.renameSession(this.key, this.editingSessionId, name);
    this.editingSessionId = undefined;
    this.part(".glossa-session-rename-form").hidden = true;
    this.renderSessions();
  }

  private deleteSession(id: string) {
    if (!this.key) return;
    const session = conversations
      .get(this.key)
      .sessions.find((entry) => entry.id === id);
    if (!session) return;
    if (
      !Services.prompt.confirm(
        this.win as any,
        "Glossa",
        getString("session-delete-confirm", {
          args: { name: session.title || getString("session-untitled") },
        }),
      )
    )
      return;
    if (conversations.deleteSession(this.key, session.id)) {
      this.drafts.delete(this.key + "#" + id);
      this.renderAll(true);
    }
  }

  private async saveNote(id: string) {
    if (!this.target || !this.key || this.savingNote) return;
    const target = this.target;
    const session = conversations
      .get(this.key)
      .sessions.find((entry) => entry.id === id);
    if (!session) return;
    this.savingNote = true;
    this.renderBusy();
    try {
      await saveSessionNote(this.win.document, target, session);
      if (this.key === target.key)
        this.part(".glossa-session-status").textContent =
          getString("session-note-saved");
    } catch (error) {
      if (this.key === target.key)
        this.part(".glossa-session-status").textContent = String(error);
    } finally {
      this.savingNote = false;
      this.renderBusy();
    }
  }

  private async switchProfile(id: string) {
    if (!id) return;
    if (
      !matchingProfileId() &&
      !Services.prompt.confirm(
        this.win as any,
        "Glossa",
        getString("profile-switch-unsaved"),
      )
    ) {
      this.renderProfiles();
      return;
    }
    await applyProfile(id);
  }

  // ---- copy support
  //
  // Zotero's chrome document does not route Ctrl+C or a context-menu Copy to
  // plain text nodes: only inputs/textareas copy natively. We copy the window
  // selection ourselves, and offer a small right-click Copy menu so selected
  // answer text can be copied without a keyboard.

  /** Copy the window's current selection. Returns false when nothing is selected. */
  private copySelection() {
    const selection = this.win.getSelection();
    const text = selection ? selection.toString() : "";
    if (!text) return false;
    this.copyText(text);
    return true;
  }

  private copyText(text: string) {
    if (!text) return;
    Zotero.Utilities.Internal.copyTextToClipboard(text);
  }

  /** Briefly switch a copy button to a check mark as feedback. */
  private flashCopied(button: HTMLElement) {
    const doc = this.win.document;
    const original = button.innerHTML;
    button.classList.add("glossa-copied");
    button.innerHTML = CHECK_ICON;
    this.win.setTimeout(() => {
      if (!doc.contains(button)) return;
      button.innerHTML = original;
      button.classList.remove("glossa-copied");
    }, 1200);
  }

  private onContextMenu(event: MouseEvent) {
    // Only take over when there is selectable, selected text inside the chat.
    const selection = this.win.getSelection();
    const selected = selection ? selection.toString() : "";
    if (!selected) return;
    const target = event.target as Node | null;
    if (target && !this.root.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    this.showCopyMenu(event, selected);
  }

  private showCopyMenu(event: MouseEvent, text: string) {
    const doc = this.win.document;
    this.dismissCopyMenu();
    const menu = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    menu.className = "glossa-context-menu";
    const item = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    item.className = "glossa-context-item";
    item.type = "button";
    item.textContent = getString("copy");
    item.addEventListener("click", () => {
      this.copyText(text);
      this.dismissCopyMenu();
    });
    menu.append(item);
    (doc.body || doc.documentElement || this.root).append(menu);
    // Keep the menu inside the window near the cursor.
    const rect = menu.getBoundingClientRect();
    const x = Math.min(event.clientX, this.win.innerWidth - rect.width - 8);
    const y = Math.min(event.clientY, this.win.innerHeight - rect.height - 8);
    menu.style.left = Math.max(4, x) + "px";
    menu.style.top = Math.max(4, y) + "px";
    this.copyMenu = menu;
    const dismiss = (ev: Event) => {
      if (!menu.contains(ev.target as Node)) this.dismissCopyMenu();
    };
    const onBlur = () => this.dismissCopyMenu();
    const onKeyDown = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape") this.dismissCopyMenu();
    };
    // Defer so the opening contextmenu/mousedown does not close it instantly.
    this.copyMenuTimer = this.win.setTimeout(() => {
      this.copyMenuTimer = undefined;
      // The menu may have been dismissed while this timer was pending.
      if (this.copyMenu !== menu) return;
      doc.addEventListener("mousedown", dismiss, true);
      doc.addEventListener("blur", onBlur, true);
      doc.addEventListener("keydown", onKeyDown);
      menu.dataset.dismiss = "1";
      this.copyMenuDismiss = () => {
        doc.removeEventListener("mousedown", dismiss, true);
        doc.removeEventListener("blur", onBlur, true);
        doc.removeEventListener("keydown", onKeyDown);
      };
    });
  }

  private copyMenu?: HTMLDivElement;
  private copyMenuDismiss?: () => void;
  private copyMenuTimer?: number;

  private dismissCopyMenu() {
    if (this.copyMenuTimer !== undefined) {
      this.win.clearTimeout(this.copyMenuTimer);
      this.copyMenuTimer = undefined;
    }
    this.copyMenuDismiss?.();
    this.copyMenuDismiss = undefined;
    this.copyMenu?.remove();
    this.copyMenu = undefined;
  }
}

/**
 * Extract readable text from a rendered answer, preserving the line breaks
 * that textContent would drop between paragraphs, list items, code and rows.
 */
function extractText(root: HTMLElement): string {
  const BLOCK = new Set([
    "p",
    "div",
    "section",
    "article",
    "header",
    "footer",
    "li",
    "tr",
    "pre",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "table",
    "hr",
    "details",
    "summary",
  ]);
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      parts.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.localName;
    if (tag === "br") {
      parts.push("\n");
      return;
    }
    const isBlock = BLOCK.has(tag);
    if (isBlock) parts.push("\n");
    if (tag === "li") parts.push("• ");
    if (tag === "td" || tag === "th") parts.push("\t");
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes.item(i);
      if (child) walk(child);
    }
    if (isBlock) parts.push("\n");
  };
  walk(root);
  return parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Store errors already carry a localized message; keep odd ones generic. */
function messageOf(error: unknown, fallbackKey: string) {
  const text = String((error as Error)?.message || error || "");
  return text && text.length < 300 && !text.includes("\n")
    ? text
    : getString(fallbackKey);
}

function wordCount(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

const HISTORY_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9a6.5 6.5 0 1 1 1.9 4.6"/><path d="M3.5 4.5V9H8"/><path d="M10 6.5V10l2.5 1.5"/></svg>';
const COMPOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 9v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h6"/><path d="m10 10 6-6 2 2-6 6-3 1z"/></svg>';
const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" aria-hidden="true"><path d="M4 4l12 12M16 4 4 16"/></svg>';
const SEARCH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" aria-hidden="true"><circle cx="8.6" cy="8.6" r="5.6"/><path d="m13 13 4.2 4.2"/></svg>';

function formatSessionTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return getString("history-just-now");
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 60) return relative.format(-minutes, "minute");
  if (minutes < 24 * 60)
    return relative.format(-Math.floor(minutes / 60), "hour");
  if (minutes < 7 * 24 * 60)
    return relative.format(-Math.floor(minutes / (24 * 60)), "day");
  return new Date(time).toLocaleDateString();
}

const SEND_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.5V3.5"/><path d="M4.5 7 8 3.5 11.5 7"/></svg>`;

const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="9" rx="1.6"/><path d="M10.5 5.5v-2A1.6 1.6 0 0 0 8.9 1.9H3.6A1.6 1.6 0 0 0 2 3.5v5.3a1.6 1.6 0 0 0 1.6 1.6h2"/></svg>`;

const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>`;

const GLOSSARY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14.5A1.5 1.5 0 0 1 2.5 13V3a1.5 1.5 0 0 1 1.5-1.5H13.5v11H4.5A1.5 1.5 0 0 0 3 14z"/><path d="M4 12.5h9.5"/><path d="M6.5 5h3M6.5 7.5h5"/></svg>`;

/** Whether direct questions without staged context should query the current paper. */
function usePaperContext(): boolean {
  return String(getPref("chat.contextMode") || "") !== "chat";
}

function appendBubble(
  host: Element,
  kind: "user" | "assistant" | "hint" | "error",
  text?: string,
) {
  return ztoolkit.UI.appendElement(
    {
      tag: "div",
      namespace: "html",
      classList: ["glossa-msg", `glossa-${kind}`],
      properties: text === undefined ? {} : { textContent: text },
    },
    host,
  ) as HTMLDivElement;
}

/** Keep up with streamed text unless the user scrolled up to read. */
function isNearEnd(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

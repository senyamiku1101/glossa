import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { templateKeys } from "../utils/text";
import {
  CONTEXT_MODES,
  renderQuestion,
  renderTemplate,
  type ContextMode,
  type Target,
} from "./context";
import { conversations, type StoreEvent } from "./conversations";
import type { Turn } from "../utils/history";
import { openGlossaryManager } from "./glossaryUI";
import { renderMarkdown } from "./markdown";
import { getPDFSelection } from "./pdf";
import { runner } from "./runner";
import { saveSessionNote } from "./notes";
import { applyProfile, getProfiles, matchingProfileId } from "./settings";
import { getTags, TRANSLATE_TEMPLATE, type CommandTag } from "./tags";

export type ChatViewOptions = {
  /** Show "Glossa" in the header; the item pane section has its own. */
  title?: boolean;
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
  watch("tags", (view) => view.renderTags());
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
  reasoning: HTMLDetailsElement;
  summary: HTMLElement;
  reasoningBody: HTMLElement;
  answer: HTMLElement;
};

/**
 * The chat UI for one conversation: header, transcript, tags, composer.
 * It keeps no conversation state of its own; every render reads the store,
 * so a view created mid-answer catches up on its first render.
 */
export class ChatView {
  readonly root: HTMLDivElement;
  private target?: Target;
  private unsubscribe: () => void;
  private frame = 0;
  private fullRenderQueued = false;
  private pendingEls?: PendingElements;
  private quoted = "";
  private quotedPage?: number;
  private shownSession = "";
  private drafts = new Map<
    string,
    { text: string; quote: string; page?: number }
  >();
  private savingNote = false;
  private editingSessionId?: string;

  constructor(
    private readonly win: Window,
    container: Element,
    private readonly options: ChatViewOptions = {},
  ) {
    this.root = this.build(container);
    this.unsubscribe = conversations.subscribe((event) =>
      this.onStoreEvent(event),
    );
    views.add(this);
    this.renderTags();
    this.renderProfiles();
    this.renderMode();
    this.renderAll(true);
  }

  dispose() {
    this.dismissCopyMenu();
    this.unsubscribe();
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

  /** Keep the PDF selection after the popup closes and show it as a quote. */
  prefillSelection(text: string, page?: number, focus = true) {
    const quoted = text.replace(/\s+/g, " ").trim();
    if (!quoted) return;
    this.quoted = quoted;
    this.quotedPage = page && page > 0 ? page : undefined;
    this.syncQuote();
    if (focus) this.input.focus({ preventScroll: true });
  }

  // ---- DOM

  private get input() {
    return this.root.querySelector("textarea") as HTMLTextAreaElement;
  }

  private get quote() {
    return this.root.querySelector(".glossa-quote") as HTMLElement;
  }

  private get quoteMeta() {
    return this.root.querySelector(".glossa-quote-meta") as HTMLElement;
  }

  private get quotePreview() {
    return this.root.querySelector(".glossa-quote-preview") as HTMLElement;
  }

  private syncQuote() {
    const quote = this.quote;
    if (!quote) return;
    const has = Boolean(this.quoted);
    quote.hidden = !has;
    const words = wordCount(this.quoted);
    this.quoteMeta.textContent = this.quotedPage
      ? getString("quote-meta", {
          args: { page: this.quotedPage, words },
        })
      : getString("quote-meta-nopage", { args: { words } });
    this.quotePreview.textContent = this.quoted;
    this.quotePreview.title = this.quoted;
    this.input.placeholder = getString("ask-placeholder", {
      args: { mode: getString(`mode-${contextMode()}`) },
    });
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
          { tag: "div", namespace: html, classList: ["glossa-transcript"] },
          { tag: "div", namespace: html, classList: ["glossa-tags"] },
          {
            tag: "div",
            namespace: html,
            classList: ["glossa-composer"],
            children: [
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-quote"],
                attributes: { hidden: "true" },
                children: [
                  {
                    tag: "div",
                    namespace: html,
                    classList: ["glossa-quote-icon"],
                    properties: { innerHTML: QUOTE_ICON },
                  },
                  {
                    tag: "div",
                    namespace: html,
                    classList: ["glossa-quote-main"],
                    children: [
                      {
                        tag: "div",
                        namespace: html,
                        classList: ["glossa-quote-meta"],
                      },
                      {
                        tag: "div",
                        namespace: html,
                        classList: ["glossa-quote-preview"],
                      },
                    ],
                  },
                  {
                    tag: "button",
                    namespace: html,
                    classList: ["glossa-quote-clear"],
                    attributes: {
                      type: "button",
                      title: getString("quote-clear"),
                    },
                    properties: { textContent: "×" },
                    listeners: [
                      {
                        type: "click",
                        listener: () => {
                          this.quoted = "";
                          this.quotedPage = undefined;
                          this.syncQuote();
                          this.input.focus({ preventScroll: true });
                        },
                      },
                    ],
                  },
                ],
              },
              {
                tag: "textarea",
                namespace: html,
                attributes: {
                  rows: "2",
                  placeholder: getString("ask-placeholder", {
                    args: { mode: getString("mode-related") },
                  }),
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
                ],
              },
              {
                tag: "div",
                namespace: html,
                classList: ["glossa-composer-bar"],
                children: [
                  {
                    tag: "select",
                    namespace: html,
                    classList: ["glossa-mode-select"],
                    attributes: { title: getString("mode-title") },
                    children: CONTEXT_MODES.map((mode) => ({
                      tag: "option",
                      namespace: html,
                      properties: {
                        value: mode,
                        textContent: getString(`mode-${mode}`),
                      },
                    })),
                    listeners: [
                      {
                        type: "change",
                        listener: (ev: Event) => {
                          setPref(
                            "chat.contextMode",
                            (ev.target as HTMLSelectElement).value,
                          );
                          this.syncQuote();
                        },
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
      this.quoted = "";
      this.quotedPage = undefined;
      this.syncQuote();
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
        if (turn.source) this.sourceBlock(out, turn.source);
        return;
      }
      if (turn.reasoning) {
        this.reasoningBlock(out, getString("reasoning")).body.textContent =
          turn.reasoning;
      }
      const assistant = this.answerBlock(out);
      renderMarkdown(assistant, text);
      if (turn.translation && assistant.parentElement) {
        this.translationMeta(
          assistant.parentElement,
          turn,
          convo.id,
          turnIndex,
        );
      }
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
      const block = this.reasoningBlock(out, getString("reasoning-live"));
      this.pendingEls = {
        reasoning: block.details,
        summary: block.summary,
        reasoningBody: block.body,
        answer: this.answerBlock(out),
      };
      this.renderPending();
    }
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
    // The stage label lives in the summary, so keep the row visible for a
    // stage even when the model produces no reasoning of its own.
    els.reasoning.hidden = !pending.reasoning && !stage;
    els.summary.textContent =
      stage === "reviewing"
        ? getString("translation-phase-review")
        : stage === "translating"
          ? getString("translation-phase-draft")
          : getString(pending.text ? "reasoning" : "reasoning-live");
    els.reasoningBody.textContent = pending.reasoning;
    renderMarkdown(els.answer, pending.text || getString("thinking"));
    if (follow) out.scrollTop = out.scrollHeight;
  }

  private answerBlock(host: Element) {
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
          {
            tag: "div",
            namespace: "html",
            classList: ["glossa-msg", "glossa-assistant"],
          },
        ],
      },
      host,
    ) as HTMLElement;
    return card.querySelector(".glossa-assistant") as HTMLElement;
  }

  private sourceBlock(
    host: Element,
    source: { text: string; truncated: boolean },
  ) {
    ztoolkit.UI.appendElement(
      {
        tag: "details",
        namespace: "html",
        classList: ["glossa-source-block"],
        children: [
          {
            tag: "summary",
            namespace: "html",
            properties: { textContent: getString("source-trace") },
          },
          {
            tag: "p",
            namespace: "html",
            classList: ["glossa-source-help"],
            properties: {
              textContent: getString(
                source.truncated ? "source-truncated" : "source-description",
              ),
            },
          },
          {
            tag: "pre",
            namespace: "html",
            properties: { textContent: source.text },
          },
        ],
      },
      host,
    );
  }

  private reasoningBlock(host: Element, summary: string) {
    const details = ztoolkit.UI.appendElement(
      {
        tag: "details",
        namespace: "html",
        classList: ["glossa-reasoning"],
        children: [
          {
            tag: "summary",
            namespace: "html",
            properties: { textContent: summary },
          },
          {
            tag: "div",
            namespace: "html",
            classList: ["glossa-reasoning-body"],
          },
        ],
      },
      host,
    ) as HTMLDetailsElement;
    return {
      details,
      summary: details.querySelector("summary") as HTMLElement,
      body: details.querySelector(".glossa-reasoning-body") as HTMLElement,
    };
  }

  /**
   * Status, models, draft and the review action under a translation answer.
   * `info` is the local translation metadata; the rendered body above it is
   * the latest result (the reviewed text when one exists).
   */
  private translationMeta(
    card: Element,
    turn: Turn,
    sessionId: string,
    turnIndex: number,
  ) {
    const info = turn.translation;
    if (!info) return;
    const statusKey =
      info.status === "reviewed"
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
                  : "selection-collaborative";
    // Core reviews any turn that still has its complete source; an
    // incomplete one is the only committed status that cannot be reviewed.
    const reviewable = Boolean(
      info.source &&
      !info.sourceTruncated &&
      info.status !== "incomplete" &&
      turn.content.trim(),
    );
    // New buttons are created after renderBusy ran for this pass, so the
    // busy/storage gates must be applied here too, not only in renderBusy.
    const key = this.key;
    const bucket = key ? conversations.get(key) : undefined;
    const reviewDisabled =
      runner.busy || !bucket || !bucket.loaded || !!bucket.storageError;
    const host = ztoolkit.UI.appendElement(
      {
        tag: "div",
        namespace: "html",
        classList: ["glossa-translation-meta"],
        children: [
          {
            tag: "span",
            namespace: "html",
            classList: ["glossa-translation-chip", `glossa-tl-${info.status}`],
            properties: { textContent: getString(statusKey) },
          },
          ...(info.translator
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
          ...(info.reviewer
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
                    disabled: reviewDisabled,
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
    if (info.warning) {
      // `warning` arrives already localized from the store; show it as is.
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
    // The folded draft is only worth showing when it differs from the final
    // body; a kept draft after a failed or stopped review is the body itself.
    if (info.draft && info.draft !== turn.content) {
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
      .querySelectorAll<HTMLButtonElement>(".glossa-tag")
      .forEach((button: HTMLButtonElement) => {
        button.disabled =
          busy || !bucket || !bucket.loaded || !!bucket.storageError;
      });
    this.root
      .querySelectorAll<HTMLButtonElement>(".glossa-translation-review")
      .forEach((button: HTMLButtonElement) => {
        button.disabled =
          busy || !bucket || !bucket.loaded || !!bucket.storageError;
      });
    this.input.disabled = !bucket || !bucket.loaded || !!bucket.storageError;
    this.root.classList.toggle("glossa-busy", busy);
  }

  renderTags() {
    const host = this.part(".glossa-tags");
    host.replaceChildren();
    for (const tag of getTags()) {
      ztoolkit.UI.appendElement(
        {
          tag: "button",
          namespace: "html",
          classList: ["glossa-tag"],
          properties: { textContent: tag.name },
          styles: { background: `${tag.color}22`, color: tag.color },
          listeners: [{ type: "click", listener: () => void this.runTag(tag) }],
        },
        host,
      );
    }
  }

  renderMode() {
    this.part<HTMLSelectElement>(".glossa-mode-select").value = contextMode();
    this.syncQuote();
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
    const selection = this.quoted;
    box.value = "";
    const mode = contextMode();
    const sentKey = this.target.key;
    const sentSession = conversations.active(sentKey).id;
    const answered = await runner.ask({
      target: this.target,
      sessionId: sentSession,
      display: selection ? `${previewQuote(selection)} · ${input}` : input,
      build: (target, snapshot) =>
        renderQuestion(input, target, mode, snapshot, selection),
    });
    // A failed question does not have to be retyped.
    if (!answered) {
      if (
        this.key === sentKey &&
        conversations.active(sentKey).id === sentSession
      ) {
        if (!box.value) box.value = input;
      } else {
        const draftKey = sentKey + "#" + sentSession;
        const draft = this.drafts.get(draftKey);
        if (!draft?.text)
          this.drafts.set(draftKey, { text: input, quote: selection });
      }
    }
  }

  private async runTag(tag: CommandTag) {
    this.refreshTarget();
    if (runner.busy || !this.target) return;
    const bucket = conversations.get(this.target.key);
    if (!bucket.loaded || bucket.storageError) return;
    const input = this.input.value.trim();
    const selection = this.quoted;
    if (!input && needsQuestion(tag.template, selection)) {
      this.askForInput(tag.name);
      return;
    }
    // Only the standard translation template gets translation metadata; a
    // user-edited prompt is never assumed to produce a reviewable translation.
    const standardTranslate = tag.template.trim() === TRANSLATE_TEMPLATE.trim();
    // Same rule collectContext applies: an explicit quote wins, otherwise the
    // live PDF selection. Snapshot it now so the rendered prompt and the
    // recorded source describe the same text.
    const effectiveSelection = (selection || getPDFSelection() || "").trim();
    // TRANSLATE_TEMPLATE renders {{selection}} and {{input}} together, so the
    // review source must contain both parts the model actually translates.
    const source = [effectiveSelection, input]
      .filter(Boolean)
      .join("\n")
      .trim();
    await runner.ask({
      target: this.target,
      sessionId: conversations.active(this.target.key).id,
      display: input ? `${tag.name} · ${input}` : tag.name,
      build: async (target, snapshot) => {
        const rendered = await renderTemplate(
          tag.template,
          input,
          target,
          snapshot,
          effectiveSelection,
        );
        if (standardTranslate && source) {
          rendered.translationRequest = { mode: "quick", source };
        }
        return rendered;
      },
    });
  }

  /** Point at the empty input box until the user types. */
  private askForInput(tagName: string) {
    const box = this.input;
    const original = getString("input-placeholder");
    box.placeholder = getString("tag-needs-input", { args: { name: tagName } });
    box.classList.add("glossa-needs-input");
    box.addEventListener(
      "input",
      () => {
        box.placeholder = original;
        box.classList.remove("glossa-needs-input");
      },
      { once: true },
    );
    box.focus({ preventScroll: true });
  }

  private syncSession() {
    const next = this.key
      ? this.key + "#" + conversations.get(this.key).activeId
      : "";
    if (next === this.shownSession) return;
    if (this.shownSession) {
      this.drafts.set(this.shownSession, {
        text: this.input.value,
        quote: this.quoted,
        page: this.quotedPage,
      });
    }
    this.shownSession = next;
    this.part<HTMLInputElement>(".glossa-session-search").value = "";
    const draft = this.drafts.get(next);
    this.input.value = draft?.text || "";
    this.quoted = draft?.quote || "";
    this.quotedPage = draft?.page;
    this.syncQuote();
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
 * A template built around a typed question ({{input}}) has nothing to ask
 * without one, unless it can use the PDF selection instead.
 */
function needsQuestion(template: string, quoted?: string) {
  const keys = templateKeys(template);
  if (!keys.has("input")) return false;
  return !(keys.has("selection") && (quoted || getPDFSelection()));
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

function previewQuote(text: string) {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
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

const QUOTE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6"/></svg>`;

const SEND_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.5V3.5"/><path d="M4.5 7 8 3.5 11.5 7"/></svg>`;

const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="9" rx="1.6"/><path d="M10.5 5.5v-2A1.6 1.6 0 0 0 8.9 1.9H3.6A1.6 1.6 0 0 0 2 3.5v5.3a1.6 1.6 0 0 0 1.6 1.6h2"/></svg>`;

const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5"/></svg>`;

const GLOSSARY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14.5A1.5 1.5 0 0 1 2.5 13V3a1.5 1.5 0 0 1 1.5-1.5H13.5v11H4.5A1.5 1.5 0 0 0 3 14z"/><path d="M4 12.5h9.5"/><path d="M6.5 5h3M6.5 7.5h5"/></svg>`;

function contextMode(): ContextMode {
  const mode = String(getPref("chat.contextMode") || "");
  return (CONTEXT_MODES as readonly string[]).includes(mode)
    ? (mode as ContextMode)
    : "related";
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

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
import { renderMarkdown } from "./markdown";
import { getPDFSelection } from "./pdf";
import { runner } from "./runner";
import { saveSessionNote } from "./notes";
import { applyProfile, getProfiles, matchingProfileId } from "./settings";
import { getTags, type CommandTag } from "./tags";

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
              if ((ev as KeyboardEvent).key !== "Escape") return;
              if (!this.part(".glossa-session-panel").hidden) {
                ev.preventDefault();
                ev.stopPropagation();
                this.toggleSessions(false);
                this.part(".glossa-session-toggle").focus({
                  preventScroll: true,
                });
                return;
              }
              if (!this.options.onEscape) return;
              ev.preventDefault();
              this.options.onEscape();
            },
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
    for (const turn of convo.turns) {
      const text = turn.display ?? turn.content;
      if (turn.role === "user") {
        appendBubble(out, "user", text);
        if (turn.source) this.sourceBlock(out, turn.source);
        continue;
      }
      if (turn.reasoning) {
        this.reasoningBlock(out, getString("reasoning")).body.textContent =
          turn.reasoning;
      }
      renderMarkdown(this.answerBlock(out), text);
    }
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
    els.reasoning.hidden = !pending.reasoning;
    els.summary.textContent = getString(
      pending.text ? "reasoning" : "reasoning-live",
    );
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
            classList: ["glossa-answer-label"],
            properties: { textContent: getString("note-label") },
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
    await runner.ask({
      target: this.target,
      sessionId: conversations.active(this.target.key).id,
      display: input ? `${tag.name} · ${input}` : tag.name,
      build: (target, snapshot) =>
        renderTemplate(tag.template, input, target, snapshot, selection),
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

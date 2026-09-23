import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  CONTEXT_MODES,
  renderQuestion,
  renderTemplate,
  type ContextMode,
  type Target,
} from "./context";
import { conversations, type StoreEvent } from "./conversations";
import { renderMarkdown } from "./markdown";
import { runner } from "./runner";
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
    this.input.focus();
  }

  // ---- DOM

  private get input() {
    return this.root.querySelector("textarea") as HTMLTextAreaElement;
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
                classList: ["glossa-context"],
              },
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
                    listener: (ev: Event) =>
                      setPref(
                        "chat.contextMode",
                        (ev.target as HTMLSelectElement).value,
                      ),
                  },
                ],
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
                classList: ["glossa-new"],
                properties: { textContent: getString("new-chat") },
                listeners: [
                  { type: "click", listener: () => this.newConversation() },
                ],
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
                tag: "textarea",
                namespace: html,
                attributes: {
                  rows: "3",
                  placeholder: getString("input-placeholder"),
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
                tag: "button",
                namespace: html,
                classList: ["glossa-stop"],
                properties: { textContent: getString("stop"), hidden: true },
                listeners: [{ type: "click", listener: () => runner.stop() }],
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
      if (full) this.renderAll(false);
      else this.renderPending();
    });
  }

  private renderLabel() {
    const label = this.part(".glossa-context");
    label.textContent = this.target?.label || getString("no-context");
    label.title = this.target?.label || "";
  }

  private renderAll(forceScroll: boolean) {
    const out = this.transcript;
    const follow = forceScroll || isNearEnd(out);
    out.replaceChildren();
    this.pendingEls = undefined;
    this.renderBusy();
    if (!this.target) return;
    const convo = conversations.get(this.target.key);
    if (!convo.loaded) {
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
        continue;
      }
      if (turn.reasoning) {
        this.reasoningBlock(out, getString("reasoning")).body.textContent =
          turn.reasoning;
      }
      appendBubble(out, "assistant").innerHTML = renderMarkdown(text);
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
        answer: appendBubble(out, "assistant"),
      };
      this.renderPending();
    }
    if (follow) out.scrollTop = out.scrollHeight;
  }

  private renderPending() {
    const pending = this.target && conversations.get(this.target.key).pending;
    const els = this.pendingEls;
    if (!pending || !els) return;
    const out = this.transcript;
    const follow = isNearEnd(out);
    els.reasoning.hidden = !pending.reasoning;
    els.summary.textContent = getString(
      pending.text ? "reasoning" : "reasoning-live",
    );
    els.reasoningBody.textContent = pending.reasoning;
    els.answer.innerHTML = renderMarkdown(
      pending.text || getString("thinking"),
    );
    if (follow) out.scrollTop = out.scrollHeight;
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
    const mine = busy && conversations.busyKey === this.key;
    this.part(".glossa-stop").hidden = !mine;
    this.part<HTMLButtonElement>(".glossa-new").disabled = mine;
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
    box.value = "";
    const mode = contextMode();
    const answered = await runner.ask({
      target: this.target,
      display: input,
      build: (target, snapshot) =>
        renderQuestion(input, target, mode, snapshot),
    });
    // A failed question does not have to be retyped.
    if (!answered && !box.value) box.value = input;
  }

  private async runTag(tag: CommandTag) {
    this.refreshTarget();
    if (runner.busy || !this.target) return;
    const input = this.input.value.trim();
    await runner.ask({
      target: this.target,
      display: input ? `${tag.name} · ${input}` : tag.name,
      build: (target, snapshot) =>
        renderTemplate(tag.template, input, target, snapshot),
    });
  }

  private newConversation() {
    if (!this.target) return;
    const key = this.target.key;
    if (runner.busy && conversations.busyKey === key) return;
    const convo = conversations.get(key);
    if (
      convo.turns.length &&
      !Services.prompt.confirm(
        this.win as any,
        "Glossa",
        getString("new-chat-confirm"),
      )
    ) {
      return;
    }
    conversations.clear(key);
    this.focus();
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

import { config } from "../../package.json";
import { DEFAULT_SYSTEM_PROMPT, type ResolvedConfig } from "../utils/config";
import { getString } from "../utils/locale";
import { ChatMessage, streamChat } from "./llm";
import { getTags, type CommandTag } from "./tags";
import {
  getActiveTarget,
  renderTemplate,
  type RenderedPrompt,
  type Target,
} from "./context";
import { renderMarkdown } from "./markdown";
import { readActiveConfig } from "./settings";

const PANEL_ID = `${config.addonRef}-panel`;
const STYLESHEET_ID = `${config.addonRef}-stylesheet`;
const MENU_ID = `${config.addonRef}-tools-menu`;
const MAX_CONVERSATIONS = 50;

type Turn = {
  role: "user" | "assistant";
  /** What the model received on this turn. */
  content: string;
  /** Lighter text resent on later turns, if different from `content`. */
  history?: string;
  /** What the transcript shows, if different from `content`. */
  display?: string;
};

type Conversation = { key: string; label: string; turns: Turn[] };

type Run = { stopped: boolean; cancel?: () => void };

export class ChatController {
  /** One conversation per item, least recently used first. */
  private conversations = new Map<string, Conversation>();
  /** Conversation currently rendered in each window's panel. */
  private shown = new WeakMap<Window, Conversation>();
  private run?: Run;
  private keyboardOwner?: ZToolkit;
  private handledKeys = new WeakSet<Event>();
  private notifierID?: string;
  private tagsObserver?: symbol;

  init() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string) => {
          if (type === "tab" && event === "select") this.refreshOpenPanels();
        },
      },
      ["tab"],
      config.addonRef,
    );
    this.tagsObserver = Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.tags`,
      () => this.forEachPanel((panel, win) => this.renderTags(panel, win)),
      true,
    );
  }

  dispose() {
    if (this.notifierID) Zotero.Notifier.unregisterObserver(this.notifierID);
    if (this.tagsObserver) Zotero.Prefs.unregisterObserver(this.tagsObserver);
    this.keyboardOwner?.Keyboard.unregister(this.onKeyboard);
    this.keyboardOwner = undefined;
    this.stop();
    for (const win of Zotero.getMainWindows()) this.unregister(win);
  }

  register(win: _ZoteroTypes.MainWindow) {
    this.bindKeyboard();
    this.ensureStylesheet(win);
    this.ensureToolsMenu(win);
  }

  unregister(win: Window) {
    for (const id of [PANEL_ID, STYLESHEET_ID, MENU_ID]) {
      win.document.getElementById(id)?.remove();
    }
    this.shown.delete(win);
  }

  toggle(win: Window | undefined = Zotero.getMainWindow()) {
    if (!win) return;
    if (this.isOpen(win)) this.hide(win);
    else this.show(win);
  }

  private get busy() {
    return Boolean(this.run);
  }

  /**
   * ztoolkit's keyboard manager also listens inside reader iframes, which a
   * listener on the main window does not reliably see. The toolkit instance
   * is recreated per main window, so follow it to the newest one.
   */
  private bindKeyboard() {
    if (this.keyboardOwner === ztoolkit) return;
    this.keyboardOwner?.Keyboard.unregister(this.onKeyboard);
    ztoolkit.Keyboard.register(this.onKeyboard);
    this.keyboardOwner = ztoolkit;
  }

  private onKeyboard = (event: KeyboardEvent, options: { type: string }) => {
    if (options.type !== "keydown" || this.handledKeys.has(event)) return;
    const accel = event.ctrlKey || event.metaKey;
    if (!accel || event.altKey || event.key !== "/") return;
    // One key press can reach both a reader iframe and the main window.
    this.handledKeys.add(event);
    event.preventDefault();
    event.stopPropagation();
    this.toggle(mainWindowFor(event));
  };

  private ensureStylesheet(win: Window) {
    const doc = win.document;
    if (doc.getElementById(STYLESHEET_ID)) return;
    ztoolkit.UI.appendElement(
      {
        tag: "link",
        namespace: "html",
        id: STYLESHEET_ID,
        attributes: {
          rel: "stylesheet",
          type: "text/css",
          href: `chrome://${config.addonRef}/content/zoteroPane.css`,
        },
      },
      doc.documentElement as Element,
    );
  }

  private ensureToolsMenu(win: _ZoteroTypes.MainWindow) {
    const doc = win.document;
    if (doc.getElementById(MENU_ID)) return;
    const popup = doc.getElementById("menu_ToolsPopup");
    if (!popup) return;
    ztoolkit.UI.appendElement(
      {
        tag: "menuitem",
        id: MENU_ID,
        attributes: { label: "Glossa" },
        listeners: [{ type: "command", listener: () => this.toggle(win) }],
      },
      popup as HTMLElement,
    );
  }

  private isOpen(win: Window) {
    const panel = getPanel(win);
    return Boolean(panel && !panel.hidden);
  }

  private hide(win: Window) {
    const panel = getPanel(win);
    if (panel) panel.hidden = true;
  }

  private show(win: Window) {
    const panel = this.ensurePanel(win);
    panel.hidden = false;
    this.syncConversation(win);
    panel.querySelector("textarea")?.focus();
  }

  private ensurePanel(win: Window) {
    const existing = getPanel(win);
    if (existing) return existing;

    const panel = ztoolkit.UI.appendElement(
      {
        tag: "div",
        namespace: "html",
        id: PANEL_ID,
        classList: ["glossa-panel"],
        listeners: [
          {
            type: "keydown",
            listener: (ev: Event) => {
              if ((ev as KeyboardEvent).key !== "Escape") return;
              ev.preventDefault();
              this.hide(win);
            },
          },
        ],
        children: [
          {
            tag: "div",
            namespace: "html",
            classList: ["glossa-header"],
            children: [
              {
                tag: "span",
                namespace: "html",
                classList: ["glossa-title"],
                properties: {
                  textContent: "Glossa",
                  title: getString("shortcut-hint"),
                },
              },
              {
                tag: "span",
                namespace: "html",
                classList: ["glossa-context"],
              },
              {
                tag: "button",
                namespace: "html",
                classList: ["glossa-new"],
                properties: { textContent: getString("new-chat") },
                listeners: [
                  {
                    type: "click",
                    listener: () => this.newConversation(win),
                  },
                ],
              },
            ],
          },
          {
            tag: "div",
            namespace: "html",
            classList: ["glossa-transcript"],
          },
          {
            tag: "div",
            namespace: "html",
            classList: ["glossa-tags"],
          },
          {
            tag: "div",
            namespace: "html",
            classList: ["glossa-composer"],
            children: [
              {
                tag: "textarea",
                namespace: "html",
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
                        void this.send(win);
                      }
                    },
                  },
                  {
                    type: "focus",
                    listener: () => this.syncConversation(win),
                  },
                ],
              },
              {
                tag: "button",
                namespace: "html",
                classList: ["glossa-stop"],
                properties: { textContent: getString("stop"), hidden: true },
                listeners: [{ type: "click", listener: () => this.stop() }],
              },
            ],
          },
        ],
      },
      win.document.documentElement as Element,
    ) as HTMLDivElement;

    this.renderTags(panel, win);
    return panel;
  }

  private renderTags(panel: Element, win: Window) {
    const host = panel.querySelector(".glossa-tags");
    if (!host) return;
    host.replaceChildren();
    for (const tag of getTags()) {
      ztoolkit.UI.appendElement(
        {
          tag: "button",
          namespace: "html",
          classList: ["glossa-tag"],
          properties: { textContent: tag.name },
          styles: { background: `${tag.color}22`, color: tag.color },
          listeners: [
            { type: "click", listener: () => void this.runTag(win, tag) },
          ],
        },
        host,
      );
    }
  }

  private forEachPanel(fn: (panel: HTMLDivElement, win: Window) => void) {
    for (const win of Zotero.getMainWindows()) {
      const panel = getPanel(win);
      if (panel) fn(panel, win);
    }
  }

  private refreshOpenPanels() {
    this.forEachPanel((panel, win) => {
      if (!panel.hidden) this.syncConversation(win);
    });
  }

  /**
   * Point the panel at the conversation for whatever is active now. While
   * an answer streams, the panel stays on the conversation it belongs to.
   */
  private syncConversation(win: Window, target = getActiveTarget()) {
    const shown = this.shown.get(win);
    if (this.busy && shown) return shown;

    const convo = this.conversationFor(target);
    const panel = getPanel(win);
    if (panel) {
      const label = panel.querySelector(".glossa-context") as HTMLElement;
      label.textContent = convo.label || getString("no-context");
      label.title = convo.label;
      if (shown !== convo) {
        this.shown.set(win, convo);
        this.renderTranscript(panel, convo);
      }
    }
    return convo;
  }

  private conversationFor(target: Target) {
    let convo = this.conversations.get(target.key);
    if (convo) {
      this.conversations.delete(target.key);
      convo.label = target.label;
    } else {
      convo = { key: target.key, label: target.label, turns: [] };
    }
    this.conversations.set(target.key, convo);
    if (this.conversations.size > MAX_CONVERSATIONS) {
      const oldest = this.conversations.keys().next().value;
      if (oldest !== undefined) this.conversations.delete(oldest);
    }
    return convo;
  }

  private renderTranscript(panel: Element, convo: Conversation) {
    const out = transcriptOf(panel);
    out.replaceChildren();
    if (!convo.turns.length) appendBubble(out, "hint", getString("empty-hint"));
    for (const turn of convo.turns) {
      const text = turn.display ?? turn.content;
      if (turn.role === "user") appendBubble(out, "user", text);
      else appendBubble(out, "assistant").innerHTML = renderMarkdown(text);
    }
    out.scrollTop = out.scrollHeight;
  }

  private newConversation(win: Window) {
    if (this.busy) return;
    const convo = this.syncConversation(win);
    convo.turns = [];
    const panel = getPanel(win);
    if (panel) {
      this.renderTranscript(panel, convo);
      panel.querySelector("textarea")?.focus();
    }
  }

  private stop() {
    if (!this.run) return;
    this.run.stopped = true;
    this.run.cancel?.();
  }

  private async runTag(win: Window, tag: CommandTag) {
    const input = inputOf(win)?.value.trim() || "";
    const display = input ? `${tag.name} · ${input}` : tag.name;
    await this.ask(win, display, (target, snapshot) =>
      renderTemplate(tag.template, input, target, snapshot),
    );
  }

  private async send(win: Window) {
    const box = inputOf(win);
    const input = box?.value.trim() || "";
    if (!box || !input || this.busy) return;
    box.value = "";
    await this.ask(
      win,
      input,
      async () => ({ prompt: input, compact: input }),
      input,
    );
  }

  /**
   * @param retryInput put back into the input box if nothing was answered,
   *   so a failed question does not have to be retyped
   */
  private async ask(
    win: Window,
    display: string,
    build: (
      target: Target,
      snapshot: ResolvedConfig,
    ) => Promise<RenderedPrompt>,
    retryInput = "",
  ) {
    if (this.busy) return;
    const panel = this.ensurePanel(win);
    const target = getActiveTarget();
    const convo = this.syncConversation(win, target);
    const snapshot = readActiveConfig();
    const run: Run = { stopped: false };
    this.run = run;
    this.setBusy(panel, true);

    const out = transcriptOf(panel);
    out.querySelector(".glossa-hint")?.remove();
    const question = appendBubble(out, "user", display);
    const reply = appendBubble(out, "assistant", getString("thinking"));
    out.scrollTop = out.scrollHeight;

    let turn: Turn | undefined;
    let answered = false;
    try {
      const rendered = await build(target, snapshot);
      if (run.stopped) {
        reply.textContent = getString("stopped");
        return;
      }
      turn = {
        role: "user",
        content: rendered.prompt,
        history:
          rendered.compact === rendered.prompt ? undefined : rendered.compact,
        display: display === rendered.prompt ? undefined : display,
      };
      convo.turns.push(turn);
      const messages: ChatMessage[] = [
        {
          role: "system",
          content: snapshot.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
        },
        ...windowed(
          convo.turns,
          snapshot.chatNumber.enabled ? snapshot.chatNumber.value : null,
        ),
      ];
      const { text, aborted } = await streamChat(
        snapshot,
        messages,
        (partial) => {
          const follow = isNearEnd(out);
          reply.innerHTML = renderMarkdown(
            partial.text || getString("thinking"),
          );
          if (follow) out.scrollTop = out.scrollHeight;
        },
        (cancel) => (run.cancel = cancel),
      );
      if (!text) {
        reply.textContent = getString(aborted ? "stopped" : "empty-reply");
        return;
      }
      const shown = aborted ? `${text}\n\n*${getString("stopped")}*` : text;
      convo.turns.push({
        role: "assistant",
        content: text,
        display: aborted ? shown : undefined,
      });
      answered = true;
      reply.innerHTML = renderMarkdown(shown);
    } catch (error: any) {
      reply.classList.add("glossa-error");
      reply.textContent = error?.message || String(error);
    } finally {
      if (!answered) {
        // A question without an answer would leave the history unpaired;
        // drop it and show that it is not part of the conversation.
        if (turn && convo.turns.at(-1) === turn) convo.turns.pop();
        question.classList.add("glossa-dropped");
        const box = inputOf(win);
        if (box && retryInput && !box.value) box.value = retryInput;
      }
      this.run = undefined;
      this.setBusy(panel, false);
    }
  }

  private setBusy(panel: Element, busy: boolean) {
    const stop = panel.querySelector(".glossa-stop") as HTMLButtonElement;
    const fresh = panel.querySelector(".glossa-new") as HTMLButtonElement;
    stop.hidden = !busy;
    fresh.disabled = busy;
    panel.classList.toggle("glossa-busy", busy);
  }
}

/**
 * The last `chatNumber` turns. Earlier user turns are resent in their
 * compact form: retrieved excerpts are only sent on the turn they were
 * fetched for.
 */
function windowed(turns: Turn[], limit: number | null): ChatMessage[] {
  const recent = limit === null ? [...turns] : turns.slice(-Math.max(1, limit));
  // Some OpenAI-compatible hosts reject a history that opens with a reply.
  while (recent.length > 1 && recent[0].role === "assistant") recent.shift();
  return recent.map((turn, i) => ({
    role: turn.role,
    content:
      i === recent.length - 1 ? turn.content : (turn.history ?? turn.content),
  }));
}

function getPanel(win: Window) {
  return win.document.getElementById(PANEL_ID) as HTMLDivElement | null;
}

function transcriptOf(panel: Element) {
  return panel.querySelector(".glossa-transcript") as HTMLDivElement;
}

function inputOf(win: Window) {
  return getPanel(win)?.querySelector("textarea") ?? undefined;
}

function appendBubble(
  host: Element,
  kind: "user" | "assistant" | "hint",
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

function mainWindowFor(event: Event) {
  const view = (event as KeyboardEvent).view;
  return (
    Zotero.getMainWindows().find((win) => win === view) ||
    Zotero.getMainWindow()
  );
}

export const chat = new ChatController();

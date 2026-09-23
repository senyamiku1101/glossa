import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { asItem } from "../utils/reader";
import { templateKeys } from "../utils/text";
import { renderTemplate, targetFor, type Target } from "./context";
import { conversations } from "./conversations";
import { renderMarkdown } from "./markdown";
import { runner } from "./runner";
import { getTags, type CommandTag } from "./tags";

type PopupEvent = _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">;

/**
 * Command tags in the reader's text selection popup. The answer streams
 * into the popup and is also kept in the item's conversation, so the
 * sidebar shows it too.
 */
export function registerSelectionPopup() {
  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    onPopup,
    config.addonID,
  );
}

export function unregisterSelectionPopup() {
  Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", onPopup);
}

/** Tags that work on a selection: their template uses {{selection}}. */
function popupTags() {
  return getTags().filter((tag) => templateKeys(tag.template).has("selection"));
}

function onPopup(event: PopupEvent) {
  if (getPref("reader.popup") === false) return;
  const selection = String(event.params.annotation?.text || "").trim();
  const tags = popupTags();
  if (!selection || !tags.length) return;
  const target = readerTarget(event.reader);
  if (!target) return;
  event.append(new SelectionPanel(event.doc, target, selection, tags).root);
}

function readerTarget(reader: _ZoteroTypes.ReaderInstance): Target | undefined {
  const attachment = reader.itemID
    ? asItem(Zotero.Items.get(reader.itemID))
    : undefined;
  if (!attachment) return undefined;
  return targetFor(attachment.parentItem || attachment, attachment);
}

const STYLE = `
.glossa-sel [hidden] { display: none !important; }
.glossa-sel { display: flex; flex-direction: column; gap: 6px; padding: 6px 4px 2px;
  border-top: 1px solid rgba(128,128,128,.25); font: 12px/1.5 system-ui, sans-serif; color: inherit; }
.glossa-sel-buttons { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.glossa-sel-mark { font-weight: 600; opacity: .6; margin-right: 2px; }
.glossa-sel button { font: inherit; cursor: pointer; border-radius: 999px; padding: 2px 10px; border: none; }
.glossa-sel button:disabled { opacity: .5; cursor: default; }
.glossa-sel-result { width: min(420px, 70vw); }
.glossa-sel-answer { max-height: 260px; overflow: auto; overflow-wrap: anywhere; padding: 6px 8px;
  border-radius: 6px; background: rgba(128,128,128,.1); user-select: text; }
.glossa-sel-answer p { margin: 0 0 .5em; } .glossa-sel-answer p:last-child { margin-bottom: 0; }
.glossa-sel-answer ul, .glossa-sel-answer ol { margin: .2em 0 .5em; padding-left: 1.4em; }
.glossa-sel-answer h1, .glossa-sel-answer h2, .glossa-sel-answer h3, .glossa-sel-answer h4 { font-size: 1.05em; margin: .5em 0 .3em; }
.glossa-sel-answer pre { overflow: auto; padding: 6px; background: rgba(128,128,128,.12); border-radius: 4px; }
.glossa-sel-answer hr { border: none; border-top: 1px solid rgba(128,128,128,.3); }
.glossa-sel-error { color: #d0453a; }
.glossa-sel-actions { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
.glossa-sel-actions button { background: rgba(128,128,128,.15); color: inherit; }
.glossa-sel-status { opacity: .65; flex: 1; }
`;

class SelectionPanel {
  readonly root: HTMLElement;
  private answer!: HTMLElement;
  private result!: HTMLElement;
  private status!: HTMLElement;
  private stopButton!: HTMLButtonElement;
  private copyButton!: HTMLButtonElement;
  private buttons: HTMLButtonElement[] = [];
  private text = "";
  private frame = 0;

  constructor(
    private readonly doc: Document,
    private readonly target: Target,
    private readonly selection: string,
    tags: CommandTag[],
  ) {
    this.root = this.build(tags);
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ) {
    const node = this.doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  private build(tags: CommandTag[]) {
    const root = this.el("div", "glossa-sel");
    root.append(this.el("style", undefined, STYLE));

    const row = this.el("div", "glossa-sel-buttons");
    row.append(this.el("span", "glossa-sel-mark", "Glossa"));
    for (const tag of tags) {
      const button = this.el("button", undefined, tag.name);
      button.style.background = `${tag.color}22`;
      button.style.color = tag.color;
      // Keep the text selection: a focus change would collapse it.
      button.addEventListener("mousedown", (e) => e.preventDefault());
      button.addEventListener("click", () => void this.run(tag));
      this.buttons.push(button);
      row.append(button);
    }
    root.append(row);

    this.result = this.el("div", "glossa-sel-result");
    this.result.hidden = true;
    this.answer = this.el("div", "glossa-sel-answer");
    this.status = this.el("span", "glossa-sel-status");
    this.stopButton = this.el("button", undefined, getString("stop"));
    this.stopButton.addEventListener("click", () => runner.stop());
    this.copyButton = this.el("button", undefined, getString("copy"));
    this.copyButton.addEventListener("click", () => {
      Zotero.Utilities.Internal.copyTextToClipboard(this.text);
      this.status.textContent = getString("copied");
    });
    const actions = this.el("div", "glossa-sel-actions");
    this.stopButton.hidden = true;
    this.copyButton.hidden = true;
    actions.append(this.status, this.stopButton, this.copyButton);
    this.result.append(this.answer, actions);
    root.append(this.result);
    return root;
  }

  private async run(tag: CommandTag) {
    this.result.hidden = false;
    if (runner.busy) {
      this.showError(getString("popup-busy"));
      return;
    }
    const key = this.target.key;
    this.setRunning(true);
    this.text = "";
    this.draw(getString("thinking"));
    this.status.textContent = "";

    // Follow the answer through the store, like the chat views do.
    const unsubscribe = conversations.subscribe((event) => {
      if (event.key !== key || !this.root.isConnected) return;
      const pending = conversations.get(key).pending;
      if (pending?.text) this.schedule(pending.text);
    });
    try {
      const answered = await runner.ask({
        target: this.target,
        display: `${tag.name} · ${preview(this.selection)}`,
        build: (target, snapshot) =>
          renderTemplate(tag.template, "", target, snapshot, this.selection),
      });
      const convo = conversations.get(key);
      if (answered) {
        const last = convo.turns[convo.turns.length - 1];
        this.text = last?.content || "";
        this.draw(last?.display ?? this.text);
        this.status.textContent = getString("popup-saved");
      } else {
        this.showError(convo.failed?.error || getString("empty-reply"));
      }
    } finally {
      unsubscribe();
      this.setRunning(false);
    }
  }

  private setRunning(running: boolean) {
    for (const button of this.buttons) button.disabled = running;
    this.stopButton.hidden = !running;
    this.copyButton.hidden = running || !this.text;
  }

  private schedule(text: string) {
    this.text = text;
    const win = this.doc.defaultView;
    if (!win || this.frame) return;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw(this.text);
    });
  }

  private draw(markdown: string) {
    const follow =
      this.answer.scrollHeight -
        this.answer.scrollTop -
        this.answer.clientHeight <
      40;
    this.answer.classList.remove("glossa-sel-error");
    renderMarkdown(this.answer, markdown);
    if (follow) this.answer.scrollTop = this.answer.scrollHeight;
  }

  private showError(message: string) {
    this.answer.classList.add("glossa-sel-error");
    this.answer.textContent = message;
  }
}

function preview(text: string) {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

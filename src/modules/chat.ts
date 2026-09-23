import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { ChatMessage, streamChat } from "./llm";
import { getTags, renderTag, type CommandTag } from "./tags";
import { renderMarkdown } from "./markdown";

const PANEL_ID = `${config.addonRef}-panel`;

export class ChatController {
  private messages: ChatMessage[] = [];
  private panels = new WeakMap<Window, HTMLDivElement>();
  private busy = false;

  register(win: _ZoteroTypes.MainWindow) {
    win.addEventListener("keydown", this.onKey, true);
    this.ensureToolsMenu(win);
  }

  unregister(win: Window) {
    win.removeEventListener("keydown", this.onKey, true);
    win.document.getElementById(PANEL_ID)?.remove();
    win.document.getElementById(`${config.addonRef}-tools-menu`)?.remove();
    this.panels.delete(win);
  }

  private ensureToolsMenu(win: _ZoteroTypes.MainWindow) {
    const doc = win.document;
    const id = `${config.addonRef}-tools-menu`;
    if (doc.getElementById(id)) return;
    const popup =
      doc.getElementById("menu_ToolsPopup") ||
      doc.querySelector("#menu_ToolsPopup");
    if (!popup) return;
    ztoolkit.UI.appendElement(
      {
        tag: "menuitem",
        id,
        attributes: { label: "Glossa" },
        listeners: [
          {
            type: "command",
            listener: () => this.toggle(win),
          },
        ],
      },
      popup as HTMLElement,
    );
  }

  private onKey = (event: KeyboardEvent) => {
    const win = event.view || (event.target as Node | null)?.ownerDocument?.defaultView;
    if (!win) return;
    const accel = event.ctrlKey || event.metaKey;
    if (accel && event.key === "/") {
      event.preventDefault();
      event.stopPropagation();
      this.toggle(win);
      return;
    }
    if (event.key === "Escape" && this.isOpen(win)) {
      event.preventDefault();
      this.hide(win);
    }
  };

  toggle(win?: Window) {
    const target = win || Zotero.getMainWindow();
    if (!target) return;
    if (this.isOpen(target)) this.hide(target);
    else this.show(target);
  }

  isOpen(win: Window) {
    const panel = this.panels.get(win) || (win.document.getElementById(PANEL_ID) as HTMLDivElement | null);
    return Boolean(panel && panel.style.display !== "none");
  }

  hide(win?: Window) {
    const target = win || Zotero.getMainWindow();
    if (!target) return;
    const panel = this.panels.get(target) || (target.document.getElementById(PANEL_ID) as HTMLDivElement | null);
    if (panel) panel.style.display = "none";
  }

  show(win?: Window) {
    const target = (win || Zotero.getMainWindow()) as _ZoteroTypes.MainWindow | undefined;
    if (!target) return;
    const panel = this.ensurePanel(target);
    panel.style.display = "flex";
    panel.querySelector("textarea")?.focus();
  }

  private ensurePanel(win: _ZoteroTypes.MainWindow) {
    const existing =
      this.panels.get(win) ||
      (win.document.getElementById(PANEL_ID) as HTMLDivElement | null);
    if (existing) {
      this.panels.set(win, existing);
      return existing;
    }

    const panel = ztoolkit.UI.appendElement(
      {
        tag: "div",
        id: PANEL_ID,
        namespace: "html",
        styles: {
          position: "fixed",
          right: "24px",
          bottom: "24px",
          width: "420px",
          maxHeight: "70vh",
          display: "none",
          flexDirection: "column",
          background: "#fff",
          color: "#111",
          borderRadius: "12px",
          boxShadow: "0 12px 40px rgba(0,0,0,.18)",
          zIndex: "9999",
          overflow: "hidden",
          fontFamily: "system-ui, sans-serif",
        },
        children: [
          {
            tag: "div",
            namespace: "html",
            styles: {
              padding: "10px 14px",
              fontWeight: "600",
              borderBottom: "1px solid #eee",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            },
            children: [
              {
                tag: "span",
                namespace: "html",
                properties: { innerText: "Glossa" },
              },
              {
                tag: "span",
                namespace: "html",
                styles: { fontWeight: "400", opacity: "0.6", fontSize: "12px" },
                properties: { innerText: getString("shortcut-hint") },
              },
            ],
          },
          {
            tag: "div",
            namespace: "html",
            id: `${PANEL_ID}-out`,
            styles: {
              flex: "1",
              overflow: "auto",
              padding: "12px 14px",
              fontSize: "13px",
              lineHeight: "1.55",
              minHeight: "160px",
            },
          },
          {
            tag: "div",
            namespace: "html",
            id: `${PANEL_ID}-tags`,
            styles: {
              display: "flex",
              flexWrap: "wrap",
              gap: "6px",
              padding: "0 12px 8px",
            },
          },
          {
            tag: "textarea",
            namespace: "html",
            styles: {
              width: "100%",
              minHeight: "64px",
              border: "none",
              borderTop: "1px solid #eee",
              padding: "10px 12px",
              resize: "vertical",
              fontFamily: "inherit",
              fontSize: "13px",
              outline: "none",
              boxSizing: "border-box",
            },
            attributes: {
              placeholder: getString("input-placeholder"),
            },
            listeners: [
              {
                type: "keydown",
                listener: (ev: Event) => {
                  const event = ev as KeyboardEvent;
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void this.send(win);
                  }
                },
              },
            ],
          },
        ],
      },
      win.document.documentElement as Element,
    ) as HTMLDivElement;

    this.panels.set(win, panel);
    this.renderTags(win, panel);
    return panel;
  }

  private renderTags(win: Window, panel: HTMLDivElement) {
    const host = panel.querySelector(`#${PANEL_ID}-tags`);
    if (!host) return;
    host.innerHTML = "";
    for (const tag of getTags()) {
      ztoolkit.UI.appendElement(
        {
          tag: "button",
          namespace: "html",
          properties: { innerText: tag.name },
          styles: {
            border: "none",
            borderRadius: "999px",
            padding: "4px 10px",
            cursor: "pointer",
            background: `${tag.color}22`,
            color: tag.color,
            fontSize: "12px",
          },
          listeners: [
            {
              type: "click",
              listener: () => {
                void this.runTag(win, tag);
              },
            },
          ],
        },
        host as HTMLElement,
      );
    }
  }

  private inputEl(win: Window) {
    return this.ensureExisting(win)?.querySelector("textarea") as
      | HTMLTextAreaElement
      | undefined;
  }

  private outputEl(win: Window) {
    return this.ensureExisting(win)?.querySelector(`#${PANEL_ID}-out`) as
      | HTMLDivElement
      | undefined;
  }

  private ensureExisting(win: Window) {
    return (
      this.panels.get(win) ||
      (win.document.getElementById(PANEL_ID) as HTMLDivElement | null)
    );
  }

  private async runTag(win: Window, tag: CommandTag) {
    const input = this.inputEl(win)?.value || "";
    const prompt = await renderTag(tag, input);
    await this.ask(win, prompt);
  }

  private async send(win: Window) {
    const input = this.inputEl(win)?.value.trim() || "";
    if (!input) return;
    const box = this.inputEl(win);
    if (box) box.value = "";
    await this.ask(win, input);
  }

  private async ask(win: Window, prompt: string) {
    if (this.busy) return;
    this.busy = true;
    const out = this.outputEl(win);
    if (out) out.innerHTML = `<p>${getString("thinking")}</p>`;
    const historyLimit = Math.max(1, Number(getPref("chatNumber") || 6));
    this.messages.push({ role: "user", content: prompt });
    const windowed: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are Glossa, an open-source research assistant inside Zotero. Prefer evidence from the provided context. Cite numbered snippets with [n] when they are present.",
      },
      ...this.messages.slice(-historyLimit),
    ];
    try {
      const reply = await streamChat(windowed, (text) => {
        if (out) out.innerHTML = renderMarkdown(text || getString("thinking"));
      });
      this.messages.push({ role: "assistant", content: reply });
      if (out) out.innerHTML = renderMarkdown(reply || getString("empty-reply"));
    } catch (error: any) {
      if (out) {
        out.innerHTML = `<p>${escapeText(error?.message || String(error))}</p>`;
      }
    } finally {
      this.busy = false;
    }
  }
}

function escapeText(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const chat = new ChatController();

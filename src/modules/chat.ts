import { config } from "../../package.json";
import {
  ensureStylesheet as ensureGlossaStylesheet,
  STYLESHEET_ID,
} from "../utils/stylesheet";
import { ChatView } from "./chatView";
import { getActiveTarget } from "./context";

const PANEL_ID = `${config.addonRef}-panel`;
const LEGACY_MENU_ID = `${config.addonRef}-tools-menu`;

/**
 * The floating chat panel (Ctrl+/). It follows whatever the user is looking
 * at: the PDF in the selected reader tab, or the selected library item.
 */
export class ChatController {
  private views = new Map<Window, ChatView>();
  private keyboardOwner?: ZToolkit;
  private handledKeys = new WeakSet<Event>();
  private notifierID?: string;

  init() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string) => {
          if (type === "tab" && event === "select") this.followActiveTarget();
        },
      },
      ["tab"],
      config.addonRef,
    );
  }

  dispose() {
    if (this.notifierID) Zotero.Notifier.unregisterObserver(this.notifierID);
    this.keyboardOwner?.Keyboard.unregister(this.onKeyboard);
    this.keyboardOwner = undefined;
    for (const win of Zotero.getMainWindows()) this.unregister(win);
  }

  register(win: _ZoteroTypes.MainWindow) {
    this.bindKeyboard();
    this.ensureStylesheet(win);
    win.document.getElementById(LEGACY_MENU_ID)?.remove();
  }

  unregister(win: Window) {
    this.views.get(win)?.dispose();
    this.views.delete(win);
    for (const id of [PANEL_ID, STYLESHEET_ID, LEGACY_MENU_ID]) {
      win.document.getElementById(id)?.remove();
    }
  }

  toggle(win: Window | undefined = Zotero.getMainWindow()) {
    if (!win) return;
    const panel = getPanel(win);
    if (panel && !panel.hidden) panel.hidden = true;
    else this.show(win);
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

  /** Shared by the floating panel and the item pane section. */
  private ensureStylesheet(win: Window) {
    ensureGlossaStylesheet(win);
  }

  private show(win: Window) {
    let panel = getPanel(win);
    if (!panel) {
      const created = ztoolkit.UI.appendElement(
        {
          tag: "div",
          namespace: "html",
          id: PANEL_ID,
          classList: ["glossa-panel"],
        },
        win.document.documentElement as Element,
      ) as HTMLDivElement;
      this.views.set(
        win,
        new ChatView(win, created, {
          title: true,
          onEscape: () => (created.hidden = true),
          resolveTarget: getActiveTarget,
        }),
      );
      panel = created;
    }
    panel.hidden = false;
    const view = this.views.get(win);
    view?.setTarget(getActiveTarget());
    view?.focus();
  }

  private followActiveTarget() {
    for (const [win, view] of this.views) {
      const panel = getPanel(win);
      if (panel && !panel.hidden) view.setTarget(getActiveTarget());
    }
  }
}

function getPanel(win: Window) {
  return win.document.getElementById(PANEL_ID) as HTMLDivElement | null;
}

function mainWindowFor(event: Event) {
  const view = (event as KeyboardEvent).view;
  return (
    Zotero.getMainWindows().find((win) => win === view) ||
    Zotero.getMainWindow()
  );
}

export const chat = new ChatController();

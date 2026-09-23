import { config } from "../../package.json";
import { asItem } from "../utils/reader";
import { ChatView } from "./chatView";
import { targetFor, type Target } from "./context";
import { conversations } from "./conversations";

const ICON = `chrome://${config.addonRef}/content/icons/favicon.svg`;
const MIN_HEIGHT = 320;

type Section = { win: Window; view: ChatView; resize?: ResizeObserver };

/**
 * One section body per item pane: the library pane has one, and every
 * reader tab's context pane has its own.
 */
const sections = new WeakMap<HTMLDivElement, Section>();
let sectionKey: string | false = false;

/** The chat as a section of Zotero's item pane (library and reader). */
export function registerSidebar() {
  sectionKey = Zotero.ItemPaneManager.registerSection({
    paneID: `${config.addonRef}-chat`,
    pluginID: config.addonID,
    header: { l10nID: `${config.addonRef}-section-head`, icon: ICON },
    sidenav: { l10nID: `${config.addonRef}-section-sidenav`, icon: ICON },
    onInit: ({ body, doc }) => {
      const win = doc.defaultView;
      if (!win) return;
      const view = new ChatView(win, body);
      view.root.classList.add("glossa-in-pane");
      sections.set(body, {
        win,
        view,
        resize: fitHeight(win, body, view.root),
      });
    },
    // Runs on every item change, even while collapsed: keep it cheap.
    onItemChange: ({ item, setEnabled }) => {
      setEnabled(Boolean(item) && !item.isNote() && !item.isAnnotation());
    },
    // Called again for the same item after edits; setTarget ignores that.
    onRender: ({ body, item, tabType }) => {
      const section = sections.get(body);
      if (!item || !section) return;
      // The body may not have been in the scrolling pane yet at init.
      section.resize ??= fitHeight(section.win, body, section.view.root);
      section.view.setTarget(sectionTarget(body, item, tabType));
    },
    onAsyncRender: async ({ body, item, tabType }) => {
      if (!item) return;
      const target = sectionTarget(body, item, tabType);
      await conversations.ensureLoaded(target.key, target.label);
    },
    // Never stop a running answer here: it belongs to the store, not the pane.
    onDestroy: ({ body }) => {
      const section = sections.get(body);
      section?.resize?.disconnect();
      section?.view.dispose();
      sections.delete(body);
    },
  });
  if (!sectionKey) ztoolkit.log("[Glossa] item pane section not registered");
}

export function unregisterSidebar() {
  if (sectionKey) Zotero.ItemPaneManager.unregisterSection(sectionKey);
  sectionKey = false;
}

/**
 * In a reader tab `item` is the parent item, so find the PDF through the
 * reader that owns this body, not through the selected tab: panes of
 * background tabs can re-render too.
 */
function sectionTarget(
  body: HTMLElement,
  item: Zotero.Item,
  tabType: string,
): Target {
  if (item.isAttachment()) return targetFor(item.parentItem || item, item);
  if (tabType === "reader") {
    const attachment = readerAttachment(body, item);
    if (attachment) return targetFor(item, attachment);
  }
  return targetFor(item);
}

function readerAttachment(body: HTMLElement, parent: Zotero.Item) {
  const readers = (Zotero.Reader as any)._readers as
    _ZoteroTypes.ReaderInstance[] | undefined;
  // The context pane names its item details `<tabID>-context`.
  const detailsID = body.closest("item-details")?.id || "";
  const tabID = detailsID.replace(/-context$/, "");
  const owner = tabID ? Zotero.Reader.getByTabID(tabID) : undefined;
  const candidates = owner ? [owner] : readers || [];
  for (const reader of candidates) {
    const attachment = reader.itemID
      ? asItem(Zotero.Items.get(reader.itemID))
      : undefined;
    if (attachment?.parentItemID === parent.id) return attachment;
  }
  return undefined;
}

/**
 * The item pane scrolls as a whole, so give the chat a fixed height that
 * matches the visible pane; its transcript then scrolls on its own.
 */
function fitHeight(win: Window, body: HTMLElement, root: HTMLElement) {
  const scroller = scrollParent(win, body);
  if (!scroller) return undefined;
  const apply = () => {
    const height = Math.max(MIN_HEIGHT, scroller.clientHeight - 48);
    root.style.height = `${height}px`;
  };
  apply();
  const observer = new win.ResizeObserver(apply);
  observer.observe(scroller);
  return observer;
}

function scrollParent(win: Window, el: HTMLElement) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = win.getComputedStyle(node)?.overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return undefined;
}

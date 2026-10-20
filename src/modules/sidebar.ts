import { config } from "../../package.json";
import { asItem } from "../utils/reader";
import { ensureStylesheet } from "../utils/stylesheet";
import { ChatView } from "./chatView";
import { targetFor, type Target } from "./context";
import { conversations } from "./conversations";
import { attachSidebarViewport } from "./sidebarViewport";

const ICON = `chrome://${config.addonRef}/content/icons/favicon.svg`;

type Section = {
  win: Window;
  view: ChatView;
  viewport?: ReturnType<typeof attachSidebarViewport>;
};

/**
 * One section body per item pane: the library pane has one, and every
 * reader tab's context pane has its own.
 */
const sections = new WeakMap<HTMLDivElement, Section>();
const live = new Set<Section>();
let sectionKey: string | false = false;

/** The chat as a section of Zotero's item pane (library and reader). */
export function registerSidebar() {
  // Zotero places non-orderable custom sections after reorderable sections.
  // Keep Glossa at the end without changing the user's sidenav preference.
  const sidenav = {
    l10nID: `${config.addonRef}-section-sidenav`,
    icon: ICON,
    orderable: false,
  };
  sectionKey = Zotero.ItemPaneManager.registerSection({
    paneID: `${config.addonRef}-chat`,
    pluginID: config.addonID,
    header: { l10nID: `${config.addonRef}-section-head`, icon: ICON },
    sidenav,
    onInit: ({ body, doc }) => {
      const win = doc.defaultView;
      if (!win) return;
      // Every window that mounts a pane needs the stylesheet; the floating
      // chat also injects it, but a pane can exist before that ever runs.
      ensureStylesheet(win);
      const view = new ChatView(win, body, { title: true, board: true });
      view.root.classList.add("glossa-in-pane");
      const section = {
        win,
        view,
        viewport: attachSidebarViewport(win, body, view.root),
      };
      sections.set(body, section);
      live.add(section);
    },
    // Runs on every item change, even while collapsed: keep it cheap.
    onItemChange: ({ body, item, setEnabled }) => {
      const enabled = Boolean(item) && !item.isNote() && !item.isAnnotation();
      setEnabled(enabled);
      if (!enabled) sections.get(body)?.viewport?.deactivate();
    },
    // Called again for the same item after edits; setTarget ignores that.
    onRender: ({ body, item, tabType }) => {
      const section = sections.get(body);
      if (!item || !section) return;
      // The body may not have been in the scrolling pane yet at init.
      section.viewport ??= attachSidebarViewport(
        section.win,
        body,
        section.view.root,
      );
      section.viewport?.fit();
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
      if (section) {
        section.viewport?.dispose();
        section.view.dispose();
        live.delete(section);
      }
      sections.delete(body);
    },
  });
  if (!sectionKey) {
    ztoolkit.log("[Glossa] item pane section not registered");
    return;
  }
  // Earlier versions could be stored in Zotero's reorderable list. Remove
  // only our old entry so Zotero keeps the other sections in their chosen order.
  const storedOrder = Zotero.Prefs.get("sidenav.order");
  if (typeof storedOrder === "string") {
    const paneIDs = storedOrder.split(",");
    if (paneIDs.includes(sectionKey)) {
      Zotero.Prefs.set(
        "sidenav.order",
        paneIDs.filter((id) => id !== sectionKey).join(","),
      );
    }
  }
}

export function unregisterSidebar() {
  for (const section of live) section.viewport?.dispose();
  if (sectionKey) Zotero.ItemPaneManager.unregisterSection(sectionKey);
  sectionKey = false;
  live.clear();
}

/** Put the selected PDF text into the matching reader sidebar composer. */
export function offerSelection(
  target: Target,
  selection: string,
  page?: number,
) {
  for (const section of live) {
    if (section.view.key !== target.key) continue;
    // Selecting PDF text updates the quote without moving focus or scrolling.
    section.view.prefillSelection(selection, page, false);
  }
}

/** An explicit Glossa command opens the matching, visible reader workspace. */
export function revealSidebar(target: Target) {
  const candidates = [...live].filter(
    (section) => section.view.key === target.key,
  );
  const section =
    candidates.find(
      (entry) => entry.view.root.getBoundingClientRect().width > 0,
    ) || candidates.at(-1);
  if (!section) return;
  const pane = section.view.root.closest("context-pane, item-pane") as
    (HTMLElement & { collapsed?: boolean }) | null;
  if (pane) pane.collapsed = false;
  const contextPane = (section.win as any).ZoteroContextPane;
  if (contextPane) contextPane.collapsed = false;
  section.viewport?.activate();
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

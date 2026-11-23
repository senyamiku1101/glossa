import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { ensureStylesheet } from "../utils/stylesheet";
import * as queue from "./markdownPrep/queue";
import { findHostedAttachment } from "./markdownPrep/store";
import { readSettings } from "./markdownPrep/settings";
import { testPaddleConnection } from "./markdownPrep/paddle";
import { testMineruConnection } from "./markdownPrep/mineru";
import type { PrepState } from "./markdownPrep/types";
const HTML = "http://www.w3.org/1999/xhtml",
  SVG = "http://www.w3.org/2000/svg";
function text(key: string, fallback: string) {
  try {
    const value = getString(key as Parameters<typeof getString>[0]);
    return value && !value.includes(key) ? value : fallback;
  } catch {
    return fallback;
  }
}
function report(error: unknown) {
  ztoolkit.log("[Glossa] Markdown action failed", error);
}
function alertText(message: string) {
  Zotero.alert(Zotero.getMainWindow(), "Glossa", message);
}
function settings() {
  Zotero.Utilities.Internal.openPreferences(config.addonID);
}
function currentReaderPdf(): Zotero.Item | undefined {
  try {
    const win = Zotero.getMainWindow() as unknown as {
      Zotero_Tabs?: { selectedID: string; selectedType: string };
    };
    const tabs = win?.Zotero_Tabs;
    if (!tabs || tabs.selectedType !== "reader") return undefined;
    const readerApi = (
      Zotero as unknown as {
        Reader?: { getByTabID(id: string): { itemID?: number } | undefined };
      }
    ).Reader;
    const itemID = readerApi?.getByTabID(tabs.selectedID)?.itemID;
    if (!itemID) return undefined;
    const item = Zotero.Items.get(itemID);
    if (item && item.isPDFAttachment()) return item;
  } catch (error) {
    ztoolkit.log("[Glossa] markdown current-reader lookup failed", error);
  }
  return undefined;
}

function selectedLibraryItems(): Zotero.Item[] {
  try {
    return Zotero.getActiveZoteroPane()?.getSelectedItems() || [];
  } catch (error) {
    ztoolkit.log("[Glossa] markdown selection lookup failed", error);
    return [];
  }
}

/** Library selection first, then the PDF open in the reader. */
function selectionOrCurrentPdf(): Zotero.Item[] {
  const selected = selectedLibraryItems();
  if (selected.length) return selected;
  const readerPdf = currentReaderPdf();
  return readerPdf ? [readerPdf] : [];
}
export async function convertItemsInteractive(items: Zotero.Item[]) {
  try {
    if (!queue.collectTargets(items).pdfs.length) {
      alertText(
        text("markdown-no-current-pdf", "请选择 PDF 或包含 PDF 的条目"),
      );
      return;
    }
    await queue.enqueueItems(items, { force: true });
  } catch (error) {
    report(error);
  }
}
export function convertCurrentPdfInteractive() {
  const pdf = currentReaderPdf();
  return convertItemsInteractive(pdf ? [pdf] : []);
}
export const resumeQueue = queue.resumePending;
export function testCurrentProviderConnection() {
  return readSettings().provider === "mineru-cloud"
    ? testMineruConnection()
    : testPaddleConnection();
}
export async function deleteSelectionInteractive(
  items = selectionOrCurrentPdf(),
) {
  let removed = 0;
  for (const pdf of queue.collectTargets(items).pdfs)
    if (await queue.deleteBodyForPDF(pdf)) removed++;
  if (!removed)
    alertText(text("markdown-body-none", "所选条目没有托管的 Markdown 正文"));
}
const windows = new Map<Window, () => void>();
const menuIDs: string[] = [];
const TOOLBAR_WIDGET_ID = `${config.addonRef}-bgtasks-toolbar`;
let menusRegistered = false;
export function registerMarkdownUI(win: _ZoteroTypes.MainWindow) {
  if (windows.has(win)) return;
  const cleanups: (() => void)[] = [];
  try {
    ensureStylesheet?.(win);
  } catch (error) {
    report(error);
  }
  const toolbar = win.document.getElementById("zotero-items-toolbar");
  if (toolbar) {
    win.document.getElementById(TOOLBAR_WIDGET_ID)?.remove();
    const widget = createBackgroundTasksWidget(win, { mode: "toolbar" });
    widget.root.id = TOOLBAR_WIDGET_ID;
    const found =
      toolbar.querySelector("#zotero-tb-search") ||
      toolbar.querySelector("#zotero-tb-search-textbox") ||
      toolbar.querySelector("search-textbox") ||
      toolbar.querySelector("#zotero-tb-sync");
    let anchor: Element | null = found;
    while (anchor?.parentElement && anchor.parentElement !== toolbar) {
      anchor = anchor.parentElement;
    }
    if (anchor && anchor.parentNode === toolbar) {
      toolbar.insertBefore(widget.root, anchor);
    } else {
      toolbar.append(widget.root);
    }
    cleanups.push(() => widget.dispose());
  }
  if (!menusRegistered && Zotero.MenuManager) {
    for (const target of ["item", "collection"] as const) {
      const id = config.addonRef + "-markdown-" + target;
      if (menuIDs.includes(id)) continue;
      try {
        Zotero.MenuManager.registerMenu({
          menuID: id,
          pluginID: config.addonID,
          target:
            target === "item" ? "main/library/item" : "main/library/collection",
          menus: [false, true].map((deleting) => ({
            menuType: "menuitem" as const,
            onShowing: (
              _event: Event,
              context: _ZoteroTypes.MenuManager.LibraryMenuContext,
            ) => {
              context.menuElem.setAttribute(
                "label",
                deleting
                  ? text("markdown-menu-delete", "删除正文 Markdown")
                  : text("markdown-menu-convert", "转换正文 Markdown"),
              );
              context.setEnabled(
                !!(context.items?.length || context.collectionTreeRow),
              );
            },
            onCommand: (
              _event: Event,
              context: _ZoteroTypes.MenuManager.LibraryMenuContext,
            ) => {
              const items = context.items?.length
                ? context.items
                : (
                    context.collectionTreeRow?.ref as
                      Zotero.Collection | undefined
                  )?.getChildItems?.() || selectionOrCurrentPdf();
              void (
                deleting
                  ? deleteSelectionInteractive(items)
                  : convertItemsInteractive(items)
              ).catch(report);
            },
          })),
        });
        menuIDs.push(id);
      } catch (error) {
        report(error);
      }
    }
    menusRegistered = menuIDs.length === 2;
  }
  // Older Zotero versions expose XUL context menus instead of MenuManager.
  if (!menusRegistered) {
    for (const id of ["zotero-itemmenu", "zotero-collectionmenu"]) {
      const popup = win.document.getElementById(id);
      if (!popup) continue;
      const nodes: Element[] = [];
      for (const deleting of [false, true]) {
        const node = win.document.createXULElement("menuitem");
        node.setAttribute(
          "label",
          deleting
            ? text("markdown-menu-delete", "删除正文 Markdown")
            : text("markdown-menu-convert", "转换正文 Markdown"),
        );
        const command = () => {
          const collection =
            id === "zotero-collectionmenu"
              ? win.ZoteroPane.getSelectedCollection()
              : undefined;
          const items = collection
            ? collection.getChildItems()
            : selectionOrCurrentPdf();
          void (
            deleting
              ? deleteSelectionInteractive(items)
              : convertItemsInteractive(items)
          ).catch(report);
        };
        node.addEventListener("command", command);
        popup.append(node);
        nodes.push(node);
      }
      cleanups.push(() => nodes.forEach((n) => n.remove()));
    }
  }
  windows.set(win, () => cleanups.forEach((fn) => fn()));
}
export function unregisterMarkdownUI(win: Window) {
  windows.get(win)?.();
  windows.delete(win);
}
export function disposeMarkdownUI() {
  for (const win of windows.keys()) unregisterMarkdownUI(win);
  for (const id of menuIDs.splice(0)) Zotero.MenuManager?.unregisterMenu(id);
  menusRegistered = false;
  for (const dispose of [...widgets]) dispose();
}
const widgets = new Set<() => void>();
type Icon =
  | "tasks"
  | "spin"
  | "done"
  | "failed"
  | "queued"
  | "cancelled"
  | "retry"
  | "settings"
  | "close";
const iconPaths: Record<Icon, string> = {
  tasks: "M4 5h16M4 12h16M4 19h16",
  spin: "M20 12a8 8 0 1 1-8-8",
  done: "m5 12 4 4L19 6",
  failed: "m6 6 12 12M18 6 6 18",
  queued: "M12 4v8l5 3M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  cancelled: "m6 6 12 12M18 6 6 18",
  retry: "M4 10a8 8 0 1 1 1 8M4 4v6h6",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
  close: "m6 6 12 12M18 6 6 18",
};
function icon(doc: Document, kind: Icon) {
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("glossa-bgtasks-icon");
  if (kind === "spin") svg.classList.add("glossa-bgtasks-spin");
  const path = doc.createElementNS(SVG, "path");
  path.setAttribute("d", iconPaths[kind]);
  svg.append(path);
  return svg;
}
function active(row: PrepState) {
  return ["queued", "running", "waiting-file"].includes(row.status);
}
function stageLabel(row: PrepState) {
  if (row.status === "running") {
    const p = row.progress;
    if (p?.page && p.pages) {
      const fallback = "解析 " + p.page + "/" + p.pages + " 页";
      try {
        const value = getString("background-tasks-pages", {
          args: { page: p.page, pages: p.pages },
        });
        return value.includes("background-tasks-pages") ? fallback : value;
      } catch {
        return fallback;
      }
    }
    return p?.stage
      ? text("background-tasks-stage-" + p.stage, p.stage)
      : text("background-tasks-running", "解析中");
  }
  return text("background-tasks-status-" + row.status, row.status);
}
export function createBackgroundTasksWidget(
  win: Window,
  options: { mode?: "inline" | "toolbar" } = {},
) {
  const doc = win.document;
  const toolbarMode = options.mode === "toolbar";
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) => {
    const node = doc.createElementNS(HTML, tag) as HTMLElementTagNameMap[K];
    node.className = cls;
    return node;
  };
  const root = el(
    "div",
    toolbarMode
      ? "glossa-bgtasks-root glossa-bgtasks-toolbar"
      : "glossa-bgtasks-root",
  );
  const trigger = el("button", "glossa-bgtasks-trigger");
  trigger.type = "button";
  trigger.title = text("background-tasks-title", "后台任务");
  trigger.setAttribute("aria-label", trigger.title);
  trigger.setAttribute("aria-expanded", "false");
  const panel = el(
    "div",
    toolbarMode
      ? "glossa-bgtasks-panel glossa-bgtasks-popover"
      : "glossa-bgtasks-panel",
  );
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", trigger.title);
  const header = el("div", "glossa-bgtasks-header");
  const title = el("strong", "");
  title.textContent = trigger.title;
  const clear = el("button", "glossa-bgtasks-clear");
  clear.type = "button";
  clear.textContent = text("background-tasks-clear", "清除已完成");
  clear.onclick = () => queue.clearFinishedStates();
  const close = el("button", "glossa-bgtasks-action");
  close.type = "button";
  close.title = text("background-tasks-close", "关闭");
  close.setAttribute("aria-label", close.title);
  close.append(icon(doc, "close"));
  close.onclick = () => setOpen(false);
  header.append(title, clear, close);
  const list = el("div", "glossa-bgtasks-list");
  panel.append(header, list);
  const portalHost = toolbarMode ? doc.documentElement || doc.body : undefined;
  if (portalHost) {
    root.append(trigger);
    portalHost.append(panel);
  } else {
    root.append(trigger, panel);
  }
  let showTimer: number | undefined,
    hideTimer: number | undefined,
    disposed = false;
  const stopTimers = () => {
    win.clearTimeout(showTimer);
    win.clearTimeout(hideTimer);
  };
  const containsNode = (node: Node | null) =>
    Boolean(node && (root.contains(node) || panel.contains(node)));
  const positionPopover = () => {
    if (!toolbarMode || panel.hidden) return;
    try {
      const rect = trigger.getBoundingClientRect();
      const viewW = win.innerWidth || 1000;
      const width = Math.min(320, Math.max(220, viewW - 24));
      const left = Math.max(
        12,
        Math.min(rect.right - width, viewW - width - 12),
      );
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(rect.bottom + 6)}px`;
      panel.style.right = "auto";
    } catch {
      // Ignore mock environments without getBoundingClientRect.
    }
  };
  const setOpen = (open: boolean) => {
    stopTimers();
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) positionPopover();
  };
  trigger.onclick = () => setOpen(Boolean(panel.hidden));
  const scheduleOpen = () => {
    stopTimers();
    showTimer = win.setTimeout(() => setOpen(true), 350);
  };
  const scheduleClose = () => {
    stopTimers();
    hideTimer = win.setTimeout(() => {
      if (!containsNode(doc.activeElement)) setOpen(false);
    }, 220);
  };
  root.onmouseenter = scheduleOpen;
  root.onmouseleave = scheduleClose;
  if (portalHost) {
    panel.onmouseenter = stopTimers;
    panel.onmouseleave = scheduleClose;
    panel.addEventListener("focusin", stopTimers);
    panel.addEventListener("focusout", scheduleClose);
  }
  root.addEventListener("focusin", stopTimers);
  root.addEventListener("focusout", scheduleClose);
  const onKeyDown = (e: Event) => {
    if ((e as KeyboardEvent).key === "Escape" && !panel.hidden) {
      e.stopPropagation();
      setOpen(false);
      trigger.focus();
    }
  };
  root.onkeydown = onKeyDown;
  if (portalHost) panel.onkeydown = onKeyDown;
  const outside = (e: Event) => {
    if (!containsNode(e.target as Node | null)) setOpen(false);
  };
  doc.addEventListener("pointerdown", outside);
  const onResize = () => positionPopover();
  if (toolbarMode) win.addEventListener?.("resize", onResize);
  const render = (rows: PrepState[]) => {
    if (disposed) return;
    const busy = rows.some(active);
    const failed = rows.some((r) => r.status === "failed");
    const done = rows.some(
      (r) => r.status === "done" || r.status === "partial",
    );
    root.dataset.state = busy
      ? "running"
      : failed
        ? "failed"
        : done
          ? "done"
          : "idle";
    trigger.replaceChildren(icon(doc, busy ? "spin" : "tasks"));
    list.replaceChildren();
    clear.disabled = !rows.some(
      (r) => !active(r) && r.status !== "waiting-config",
    );
    if (!rows.length) {
      const empty = el("div", "glossa-bgtasks-empty");
      empty.textContent = text("background-tasks-empty", "暂无后台任务");
      list.append(empty);
      return;
    }
    for (const row of [...rows].sort(
      (a, b) =>
        Number(active(b)) - Number(active(a)) ||
        (b.updatedAt || 0) - (a.updatedAt || 0),
    )) {
      const item = el("div", "glossa-bgtasks-row");
      item.dataset.status = row.status;
      const kind: Icon =
        row.status === "running"
          ? "spin"
          : row.status === "done" || row.status === "partial"
            ? "done"
            : row.status === "failed"
              ? "failed"
              : row.status === "cancelled"
                ? "cancelled"
                : "queued";
      item.append(icon(doc, kind));
      const content = el("div", "glossa-bgtasks-content");
      const status = el("span", "glossa-bgtasks-status");
      const error =
        row.status === "failed"
          ? row.detail || row.lastAttemptError
          : undefined;
      status.textContent = error
        ? `${stageLabel(row)} · ${error.slice(0, 60)}`
        : stageLabel(row);
      status.title = row.detail || row.lastAttemptError || status.textContent;
      const label = el("span", "glossa-bgtasks-title");
      label.textContent = row.title || row.attachmentKey;
      label.title = label.textContent;
      content.append(status, label);
      item.append(content);
      const action = (kind: Icon, label: string, fn: () => unknown) => {
        const b = el("button", "glossa-bgtasks-action");
        b.type = "button";
        b.title = label;
        b.setAttribute("aria-label", label);
        b.append(icon(doc, kind));
        b.onclick = () => {
          Promise.resolve().then(fn).catch(report);
        };
        item.append(b);
      };
      const pdf = async () =>
        Zotero.Items.getByLibraryAndKey(row.libraryID, row.attachmentKey) ||
        (await Zotero.Items.getByLibraryAndKeyAsync(
          row.libraryID,
          row.attachmentKey,
        ));
      if (active(row))
        action("close", text("background-tasks-cancel", "取消"), () =>
          queue.cancel(row.key),
        );
      else if (row.status === "failed" || row.status === "cancelled")
        action("retry", text("background-tasks-retry", "重试"), () =>
          queue.retryItem(row.key),
        );
      else if (row.status === "waiting-config")
        action(
          "settings",
          text("background-tasks-settings", "打开设置"),
          settings,
        );
      else if (row.hostedAttachmentKey)
        action(
          "done",
          text("background-tasks-open", "打开 Markdown"),
          async () => {
            const source = await pdf();
            const attachment =
              source &&
              (await findHostedAttachment(source, row.hostedAttachmentKey));
            if (attachment)
              await Zotero.getActiveZoteroPane()?.viewAttachment(attachment.id);
          },
        );
      list.append(item);
    }
  };
  const unsubscribe = queue.subscribe(render);
  render(queue.getStates());
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopTimers();
    unsubscribe();
    doc.removeEventListener("pointerdown", outside);
    if (toolbarMode) win.removeEventListener?.("resize", onResize);
    panel.remove();
    root.remove();
    widgets.delete(dispose);
  };
  widgets.add(dispose);
  return { root, dispose };
}

/**
 * A focused workspace inside Zotero's registered section. Only this item's
 * container is scoped; native pane visibility and pin preferences stay intact.
 */
export function attachSidebarViewport(
  win: Window,
  body: HTMLElement,
  root: HTMLElement,
) {
  const host = body.closest("item-pane-custom-section") as HTMLElement | null;
  const details = body.closest("item-details") as
    | (HTMLElement & {
        sidenav?: HTMLElement & { container?: Element };
        pinnedPane?: string;
      })
    | null;
  const scroller = host?.parentElement;
  if (!host || !details || !scroller) return;
  const paneID = host.dataset.pane;
  let active = false;
  let disposed = false;
  host.classList.add("glossa-pane-host");
  body.classList.add("glossa-pane-body");

  const fit = () => {
    if (disposed || !scroller.clientHeight) return;
    root.style.height =
      Math.max(active ? 160 : 240, scroller.clientHeight - (active ? 0 : 48)) +
      "px";
  };
  const deactivate = () => {
    active = false;
    details.classList.remove("glossa-workspace-active");
    scroller.classList.remove("glossa-pane-viewport");
    fit();
  };
  const activate = () => {
    if (disposed || host.hidden) return;
    active = true;
    const section = host.querySelector("collapsible-section") as
      (HTMLElement & { open?: boolean }) | null;
    if (section) section.open = true;
    details.classList.add("glossa-workspace-active");
    scroller.classList.add("glossa-pane-viewport");
    scroller.scrollTop = 0;
    fit();
  };
  const navigate = (event: Event) => {
    const target = event.target as Element | null;
    const button = target?.closest?.("[data-pane]");
    const nav = button?.closest("item-pane-sidenav") as
      (HTMLElement & { container?: Element }) | null;
    if (!nav || nav.container !== details) return;
    if (event.type === "click" && (event as MouseEvent).button !== 0) return;
    if (
      event.type === "keydown" &&
      !["Enter", " "].includes((event as KeyboardEvent).key)
    )
      return;
    if (
      button?.getAttribute("disabled") === "true" ||
      (button as HTMLButtonElement).disabled
    )
      return;
    if (button?.getAttribute("data-pane") === paneID) activate();
    else deactivate();
  };
  // Capture runs before Zotero computes the requested pane's scroll position.
  win.document.addEventListener("click", navigate, true);
  win.document.addEventListener("keydown", navigate, true);
  root.addEventListener("focusin", activate);
  const observer = new win.ResizeObserver(fit);
  observer.observe(scroller);
  fit();
  if (details.pinnedPane === paneID) activate();

  return {
    activate,
    deactivate,
    fit,
    dispose() {
      if (disposed) return;
      deactivate();
      disposed = true;
      observer.disconnect();
      win.document.removeEventListener("click", navigate, true);
      win.document.removeEventListener("keydown", navigate, true);
      root.removeEventListener("focusin", activate);
      host.classList.remove("glossa-pane-host");
      body.classList.remove("glossa-pane-body");
      root.style.removeProperty("height");
    },
  };
}

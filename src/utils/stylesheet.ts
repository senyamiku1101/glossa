import { config, version } from "../../package.json";

export const STYLESHEET_ID = `${config.addonRef}-stylesheet`;

/**
 * The plugin stylesheet for chrome documents (main windows, reader windows,
 * item pane sections, the floating panel). The URL carries the addon version
 * so a plugin update never keeps serving the previous release's CSS from the
 * style cache. If a chrome document rejects the query string the link falls
 * back to the plain URL.
 */
export function ensureStylesheet(win: Window) {
  const doc = win.document;
  const base = `chrome://${config.addonRef}/content/zoteroPane.css`;
  const href = `${base}?v=${encodeURIComponent(version)}`;
  const existing = doc.getElementById(STYLESHEET_ID) as HTMLLinkElement | null;
  if (existing?.getAttribute("href") === href) return;
  existing?.remove();
  const link = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link",
  ) as HTMLLinkElement;
  link.id = STYLESHEET_ID;
  link.rel = "stylesheet";
  link.type = "text/css";
  try {
    link.setAttribute("href", href);
  } catch {
    link.setAttribute("href", base);
  }
  link.addEventListener(
    "error",
    () => {
      if (link.getAttribute("href") === href) link.setAttribute("href", base);
    },
    { once: true },
  );
  (doc.head || doc.documentElement)?.appendChild(link);
}

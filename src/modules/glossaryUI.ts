import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { glossary, type GlossaryTerm } from "./glossary";

const MAX_SOURCE = 200;
const MAX_TARGET = 500;
const LIST_LIMIT = 100;
const STYLESHEET = `chrome://${config.addonRef}/content/zoteroPane.css`;

/** Dialog windows still open, so addon shutdown can close them. */
const openWindows = new Set<Window>();

/** Close glossary dialogs that survived into addon shutdown/update. */
export function disposeGlossaryWindows() {
  for (const win of [...openWindows]) {
    try {
      win.close();
    } catch {
      // The window may already be gone.
    }
  }
  openWindows.clear();
}

function trackDialog(dialog: { window: Window }) {
  const win = dialog.window;
  if (!win) return;
  openWindows.add(win);
  win.addEventListener("unload", () => openWindows.delete(win), {
    once: true,
  });
}

/** A dialog that cannot open must say so; a silent click looks broken. */
function reportOpenFailure() {
  try {
    Services.prompt.alert(
      Zotero.getMainWindow() as any,
      "Glossa",
      getString("glossary-open-error"),
    );
  } catch (error) {
    ztoolkit.log("[Glossa] glossary error alert failed", error);
  }
}

/**
 * Personal glossary UI. Two surfaces share one editor: the reader popup's
 * "add term" button and the chat header's manage button. Both open real
 * chrome dialogs so the form outlives a closing selection popup.
 *
 * The toolkit dialog builds its DOM after `open()` resolves the load lock,
 * so every element lookup and listener lives in `loadCallback`. The dialog
 * window only gets the stock chrome stylesheets, so ours is linked in too.
 */

export type GlossaryEditorOptions = {
  /** Prefilled source (from a text selection). */
  source?: string;
  /** Edit this existing term; renaming passes its original source back. */
  existing?: GlossaryTerm;
  /** Runs after a successful save so the caller can refresh its list. */
  onSaved?: () => void;
};

/**
 * Two-field editor dialog for one term. Stays open on error so nothing the
 * user typed is lost; closes only after a save that the store accepted.
 * Opening failures are reported instead of disappearing silently.
 */
export async function openGlossaryEditor(options: GlossaryEditorOptions = {}) {
  try {
    await openEditorDialog(options);
  } catch (error) {
    ztoolkit.log("[Glossa] glossary editor failed", error);
    reportOpenFailure();
  }
}

async function openEditorDialog(options: GlossaryEditorOptions = {}) {
  const existing = options.existing;
  let loadError = false;
  try {
    await glossary.ensureLoaded();
  } catch (error) {
    loadError = true;
    ztoolkit.log("[Glossa] glossary load failed", error);
  }
  // A known term is edited in place: the saved translation prefills and the
  // same key saves as an update, not a conflict.
  const known =
    existing || (options.source ? glossary.find(options.source) : undefined);
  // A PDF selection may contain line breaks that a single-line input drops.
  // Normalize like the store does, then keep the value inside the limit.
  const normalized = (known?.source || options.source || "")
    .replace(/\s+/g, " ")
    .trim();
  const prefillTooLong = normalized.length > MAX_SOURCE;
  const prefill = prefillTooLong ? normalized.slice(0, MAX_SOURCE) : normalized;
  let saving = false;
  const dialog = new ztoolkit.Dialog(3, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      classList: ["glossa-glossary-field"],
      children: [
        {
          tag: "label",
          namespace: "html",
          attributes: { for: "glossa-glossary-source" },
          properties: { textContent: getString("glossary-source") },
        },
        {
          tag: "input",
          namespace: "html",
          id: "glossa-glossary-source",
          attributes: {
            type: "text",
            maxlength: String(MAX_SOURCE),
            value: prefill,
          },
        },
      ],
    })
    .addCell(1, 0, {
      tag: "div",
      namespace: "html",
      classList: ["glossa-glossary-field"],
      children: [
        {
          tag: "label",
          namespace: "html",
          attributes: { for: "glossa-glossary-target" },
          properties: { textContent: getString("glossary-target") },
        },
        {
          tag: "input",
          namespace: "html",
          id: "glossa-glossary-target",
          attributes: {
            type: "text",
            maxlength: String(MAX_TARGET),
            value: known?.target || "",
          },
        },
      ],
    })
    .addCell(2, 0, {
      tag: "div",
      namespace: "html",
      id: "glossa-glossary-status",
      classList: ["glossa-glossary-status"],
      attributes: { role: "alert" },
      properties: {
        textContent: loadError
          ? getString("glossary-load-error")
          : prefillTooLong
            ? getString("glossary-source-too-long")
            : "",
      },
    })
    .addButton(getString("glossary-save"), "save", {
      noClose: true,
      callback: () => void save(),
    })
    .addButton(getString("glossary-cancel"), "cancel")
    .setDialogData({
      loadCallback: () => {
        const doc = dialog.window.document;
        ensureStylesheet(doc);
        doc.addEventListener("keydown", (event) => {
          const key = event as KeyboardEvent;
          // Leave an IME candidate window and an in-flight save alone.
          if (key.key === "Escape" && !key.isComposing && !saving) {
            key.preventDefault();
            dialog.window.close();
            return;
          }
          // An IME-candidate Enter must not submit the form.
          if (key.key !== "Enter" || key.isComposing) return;
          if ((key.target as HTMLElement | null)?.tagName !== "INPUT") return;
          key.preventDefault();
          void save();
        });
        (
          doc.getElementById("glossa-glossary-source") as HTMLElement | null
        )?.focus();
      },
    })
    .open(getString("glossary-title"), {
      centerscreen: true,
      resizable: false,
      fitContent: true,
      alwaysRaised: true,
    });
  trackDialog(dialog);

  async function save() {
    if (saving) return;
    const doc = dialog.window.document;
    const sourceInput = doc.getElementById(
      "glossa-glossary-source",
    ) as HTMLInputElement;
    const targetInput = doc.getElementById(
      "glossa-glossary-target",
    ) as HTMLInputElement;
    const status = doc.getElementById("glossa-glossary-status") as HTMLElement;
    const source = sourceInput.value.trim();
    const target = targetInput.value.trim();
    if (
      !source ||
      !target ||
      source.length > MAX_SOURCE ||
      target.length > MAX_TARGET
    ) {
      status.textContent = getString("glossary-invalid");
      return;
    }
    const buttons = [...doc.querySelectorAll<HTMLButtonElement>("button")];
    try {
      // Renaming onto another existing key would silently overwrite it.
      const clash = glossary.find(source);
      if (clash && (!known || clash.source !== known.source)) {
        status.textContent = getString("glossary-conflict");
        return;
      }
      saving = true;
      for (const button of buttons) button.disabled = true;
      await glossary.save({ source, target }, known?.source);
      options.onSaved?.();
      dialog.window.close();
    } catch (error) {
      ztoolkit.log("[Glossa] glossary save failed", error);
      status.textContent = messageOf(error, "glossary-save-error");
      for (const button of buttons) button.disabled = false;
    } finally {
      saving = false;
    }
  }
}

/** Searchable manage dialog: list, edit and delete saved terms. */
export function openGlossaryManager() {
  try {
    openManagerDialog();
  } catch (error) {
    ztoolkit.log("[Glossa] glossary manager failed", error);
    reportOpenFailure();
  }
}

function openManagerDialog() {
  let loaded = false;
  let loadFailed = false;
  const dialog = new ztoolkit.Dialog(3, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      classList: ["glossa-glossary-search"],
      children: [
        {
          tag: "input",
          namespace: "html",
          id: "glossa-glossary-query",
          attributes: {
            type: "search",
            placeholder: getString("glossary-search"),
            "aria-label": getString("glossary-search"),
          },
        },
      ],
    })
    .addCell(1, 0, {
      tag: "div",
      namespace: "html",
      id: "glossa-glossary-list",
      classList: ["glossa-glossary-list"],
    })
    .addCell(2, 0, {
      tag: "div",
      namespace: "html",
      id: "glossa-glossary-status",
      classList: ["glossa-glossary-status"],
      attributes: { role: "status" },
      properties: { textContent: getString("glossary-loading") },
    })
    .addButton(getString("glossary-new"), "new", {
      noClose: true,
      callback: () => void openGlossaryEditor({ onSaved: renderList }),
    })
    .addButton(getString("glossary-close"), "close")
    .setDialogData({
      loadCallback: () => {
        const doc = dialog.window.document;
        ensureStylesheet(doc);
        doc.addEventListener("keydown", (event) => {
          if ((event as KeyboardEvent).key !== "Escape") return;
          event.preventDefault();
          dialog.window.close();
        });
        const queryEl = doc.getElementById(
          "glossa-glossary-query",
        ) as HTMLInputElement;
        queryEl.addEventListener("input", renderList);
        queryEl.focus();
        // Live updates while the dialog is open; released on unload.
        const unsubscribe = glossary.subscribe(renderList);
        dialog.window.addEventListener("unload", unsubscribe, { once: true });
        renderList();
      },
    })
    .open(getString("glossary-title"), {
      centerscreen: true,
      resizable: true,
      fitContent: true,
      alwaysRaised: true,
    });
  trackDialog(dialog);

  // Load runs in parallel with the window opening; the first renderList call
  // after loadCallback may see an unfinished load and shows "loading" until
  // this resolves and re-renders.
  void (async () => {
    try {
      await glossary.ensureLoaded();
      loaded = true;
    } catch (error) {
      loadFailed = true;
      ztoolkit.log("[Glossa] glossary load failed", error);
    }
    renderList();
  })();

  function renderList() {
    const doc = dialog.window?.document;
    const listEl = doc?.getElementById(
      "glossa-glossary-list",
    ) as HTMLElement | null;
    const statusEl = doc?.getElementById(
      "glossa-glossary-status",
    ) as HTMLElement | null;
    const queryEl = doc?.getElementById(
      "glossa-glossary-query",
    ) as HTMLInputElement | null;
    // The dialog DOM may not exist yet; the load callback renders again.
    if (!listEl || !statusEl || !queryEl) return;
    listEl.replaceChildren();
    if (!loaded) {
      statusEl.textContent = getString(
        loadFailed ? "glossary-load-error" : "glossary-loading",
      );
      return;
    }
    const query = queryEl.value.trim();
    const all = glossary.list(query);
    if (!all.length) {
      statusEl.textContent = getString(
        query ? "glossary-no-results" : "glossary-empty",
      );
      return;
    }
    const shown = all.slice(0, LIST_LIMIT);
    statusEl.textContent =
      all.length > LIST_LIMIT ? getString("glossary-list-limit") : "";
    for (const term of shown) {
      ztoolkit.UI.appendElement(
        {
          tag: "div",
          namespace: "html",
          classList: ["glossa-glossary-row"],
          children: [
            {
              tag: "span",
              namespace: "html",
              classList: ["glossa-glossary-source"],
              properties: { textContent: term.source, title: term.source },
            },
            {
              tag: "span",
              namespace: "html",
              classList: ["glossa-glossary-target"],
              properties: { textContent: term.target, title: term.target },
            },
            {
              tag: "button",
              namespace: "html",
              classList: ["glossa-glossary-edit"],
              attributes: {
                type: "button",
                "aria-label": `${getString("glossary-edit")} — ${term.source}`,
                title: `${getString("glossary-edit")} — ${term.source}`,
              },
              properties: { textContent: getString("glossary-edit") },
              listeners: [
                {
                  type: "click",
                  listener: () =>
                    void openGlossaryEditor({
                      existing: term,
                      onSaved: renderList,
                    }),
                },
              ],
            },
            {
              tag: "button",
              namespace: "html",
              classList: ["glossa-glossary-delete"],
              attributes: {
                type: "button",
                "aria-label": `${getString("glossary-delete")} — ${term.source}`,
                title: `${getString("glossary-delete")} — ${term.source}`,
              },
              properties: { textContent: getString("glossary-delete") },
              listeners: [
                {
                  type: "click",
                  listener: (event: Event) => void removeTerm(term, event),
                },
              ],
            },
          ],
        },
        listEl,
      );
    }
  }

  async function removeTerm(term: GlossaryTerm, event: Event) {
    const button = event.target as HTMLButtonElement;
    const confirmed = Services.prompt.confirm(
      dialog.window as any,
      "Glossa",
      getString("glossary-delete-confirm", { args: { term: term.source } }),
    );
    if (!confirmed) return;
    button.disabled = true;
    try {
      await glossary.remove(term.source);
    } catch (error) {
      ztoolkit.log("[Glossa] glossary delete failed", error);
      const doc = dialog.window?.document;
      const statusEl = doc?.getElementById(
        "glossa-glossary-status",
      ) as HTMLElement | null;
      if (statusEl) {
        statusEl.textContent = messageOf(error, "glossary-delete-error");
      }
      button.disabled = false;
    }
    // A successful remove notifies subscribers, which re-renders the list.
  }
}

/** The dialog window ships without the addon stylesheet; link ours in. */
function ensureStylesheet(doc: Document) {
  if (doc.getElementById("glossa-glossary-stylesheet")) return;
  const link = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link",
  ) as HTMLLinkElement;
  link.id = "glossa-glossary-stylesheet";
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = STYLESHEET;
  (doc.head || doc.documentElement)?.appendChild(link);
}

/** Core errors already carry a localized message; keep unknown ones generic. */
function messageOf(error: unknown, fallbackKey: string) {
  const text = String((error as Error)?.message || error || "");
  return text && text.length < 300 && !text.includes("\n")
    ? text
    : getString(fallbackKey);
}

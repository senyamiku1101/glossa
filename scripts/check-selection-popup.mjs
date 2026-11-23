/* global URL, console */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
async function compiled(name, suffix = "") {
  return ts.transpileModule((await read(name)) + suffix, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}
const popup = await compiled("../src/modules/selectionPopup.ts");
const paragraphModule = { exports: {} };
runInNewContext(await compiled("../src/modules/pdfParagraph.ts"), {
  module: paragraphModule,
  exports: paragraphModule.exports,
});
const defaultPrefs = {};
runInNewContext(await read("../addon/prefs.js"), {
  pref: (name, value) => {
    defaultPrefs[name] = value;
  },
});
assert.equal(defaultPrefs["reader.popup"], true);
assert.equal(defaultPrefs["reader.visualOverlay"], true);
assert.equal(defaultPrefs["reader.popupScope"], undefined);

class Element {
  constructor(tag) {
    this.tag = tag;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.events = new Map();
    this.isConnected = true;
    this.value = "";
    this.disabled = false;
    this.textContent = "";
    this.hidden = false;
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.classSet = new Set();
    this.classList = {
      add: (n) => this.classSet.add(n),
      remove: (n) => this.classSet.delete(n),
      toggle: (n, force) => {
        const next = force === undefined ? !this.classSet.has(n) : force;
        if (next) this.classSet.add(n);
        else this.classSet.delete(n);
      },
      contains: (n) => this.classSet.has(n),
    };
  }
  append(...children) {
    for (const child of children) {
      if (child?.parentElement) {
        child.parentElement.removeChild(child);
      }
      if (child && typeof child === "object") {
        child.parentElement = this;
        child.parentNode = this;
      }
      this.children.push(child);
    }
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    if (child && typeof child === "object") {
      child.parentElement = null;
      child.parentNode = null;
    }
    return child;
  }
  setAttribute(name, value) {
    this[name] = String(value);
  }
  getAttribute(name) {
    return name in this ? this[name] : null;
  }
  removeAttribute(name) {
    delete this[name];
  }
  addEventListener(name, callback) {
    this.events.set(name, callback);
  }
  async fire(name) {
    await this.events.get(name)?.({
      preventDefault() {},
      stopPropagation() {},
    });
  }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
// Automatic detection is intentionally fire-and-forget; drain its finite
// promise chain instead of introducing timers or invoking Send in the test.
async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
const popupHarnesses = [];
function harness(extract, options = {}) {
  const elements = [],
    addedContexts = [],
    rendered = [],
    calls = [],
    popupTranslations = [],
    savedHighlights = [],
    copiedTexts = [],
    renderedMarkdowns = [],
    glossaryOpens = [],
    preferenceWrites = [];
  const preferences = { ...defaultPrefs, ...options.preferences };
  const setPreference = (key, value) => {
    preferenceWrites.push([key, value]);
    preferences[key] = value;
  };
  const callbacks = {};
  const target = {
    item: { id: 1, getDisplayTitle: () => "Test Paper" },
    attachment: { id: 2, libraryID: 1 },
    pdf: { id: 2 },
  };
  const attachment = { id: 2, libraryID: 1, parentItem: target.item };
  const doc = {
    createElement: (tag) => {
      const el = new Element(tag);
      elements.push(el);
      return el;
    },
  };
  const reader = { itemID: 2, _iframeWindow: { document: doc } };
  const rects = [[10, 10, 40, 20]];
  const nextPageRects = options.nextPageRects;
  const dependencies = {
    "../../package.json": { config: { addonID: "glossa-test" } },
    "../utils/locale": {
      getString: (key, params) =>
        key + (params?.args ? ":" + JSON.stringify(params.args) : ""),
    },
    "../utils/prefs": {
      getPref: (key) => preferences[key],
      setPref: setPreference,
      clearPref: (key) => setPreference(key, undefined),
    },
    "../utils/reader": { asItem: (item) => item },
    "./context": {
      targetFor: () => target,
      renderTemplate: async (...args) => {
        rendered.push(args.at(-1));
        return { prompt: args.at(-1) };
      },
    },
    "./markdown": {
      renderMarkdown: (el, src) => {
        el.textContent = src;
        renderedMarkdowns.push(src);
      },
    },
    "./markdownPrep/readerBridge": {
      resolveSelectionMarkdown: async (...args) =>
        options.markdownAligned
          ? await options.markdownAligned(...args)
          : undefined,
      resolveAnnotationContext: async (...args) =>
        options.annotationContext
          ? await options.annotationContext(...args)
          : undefined,
      saveHighlightTranslationAnnotation: async (req) => {
        savedHighlights.push(req);
        if (options.saveHighlight) return await options.saveHighlight(req);
        return {
          ok: true,
          key: req.existingKey || "HLNEW01",
          updated: Boolean(req.existingKey),
        };
      },
    },
    "./pdfParagraph": paragraphModule.exports,
    "./pdfLayout": {
      getPdfLayoutParagraph: async (...args) => {
        calls.push(args);
        return await extract();
      },
    },
    "./runner": {
      streamPopupTranslation: async (req) => {
        popupTranslations.push({
          source: req.source,
          scope: req.verifyComplete ? "paragraph" : "selection",
        });
        if (options.streamPopupTranslation) {
          return await options.streamPopupTranslation(req);
        }
        const out = `译文:${req.source}`;
        req.onDelta(out);
        return {
          ok: true,
          text: out,
          pieces: [{ source: req.source, text: out }],
        };
      },
      streamPopupReview: async (req) => {
        if (options.streamPopupReview) {
          return await options.streamPopupReview(req);
        }
        const out = `审校:${req.pieces[0]?.text || ""}`;
        req.onDelta(out);
        return { ok: true, text: out };
      },
    },
    "./sidebar": {
      addContextToChat: (tgt, item, rdr) => {
        addedContexts.push({ target: tgt, item, reader: rdr });
        return true;
      },
    },
    "./tags": { TRANSLATE_TEMPLATE: "test translation" },
    "./glossaryUI": {
      openGlossaryEditor: (request) => glossaryOpens.push(request),
    },
  };
  const module = { exports: {} };
  runInNewContext(popup, {
    module,
    exports: module.exports,
    require: (name) => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
    Zotero: {
      Prefs: {
        set: setPreference,
        clear: (key) => setPreference(key, undefined),
      },
      Items: {
        get: () => attachment,
        getByLibraryAndKey: (libraryID, key) =>
          options.annotationsByKey?.[`${libraryID}:${key}`],
      },
      Reader: {
        registerEventListener: (name, handler) => {
          callbacks[name] = handler;
        },
        unregisterEventListener: (name) => {
          delete callbacks[name];
        },
      },
      Utilities: {
        Internal: {
          copyTextToClipboard: (text) => copiedTexts.push(text),
        },
      },
    },
    ztoolkit: { log: () => {}, getGlobal: () => undefined },
  });
  module.exports.registerSelectionPopup();
  let holder;
  let outerPopup;
  let colorRow;
  if (options.withNativePopup) {
    outerPopup = new Element("div");
    outerPopup.className = "selection-popup";
    colorRow = new Element("div");
    colorRow.className = "colors";
    for (let i = 0; i < 8; i++) {
      const swatch = new Element("button");
      swatch.className = "color";
      colorRow.append(swatch);
    }
    const typesRow = new Element("div");
    typesRow.className = "types";
    typesRow.append(new Element("button"), new Element("button"));
    outerPopup.append(colorRow, typesRow);
    outerPopup.querySelector = (sel) =>
      sel.includes(".colors") ? colorRow : null;
  }
  callbacks.renderTextSelectionPopup({
    doc,
    reader,
    params: {
      annotation: {
        text: "text" in options ? options.text : "selected few words",
        pageLabel: "38",
        sortIndex: "00037|000100|00200",
        position: { pageIndex: 37, rects, nextPageRects },
      },
    },
    append: (el) => {
      holder = el;
      holder.isConnected = options.initiallyConnected !== false;
      if (outerPopup) {
        outerPopup.append(holder);
        holder.closest = (sel) =>
          sel === ".selection-popup" ? outerPopup : null;
      }
    },
  });
  const state = {
    holder,
    outerPopup,
    colorRow,
    elements,
    addedContexts,
    rendered,
    calls,
    popupTranslations,
    savedHighlights,
    copiedTexts,
    renderedMarkdowns,
    glossaryOpens,
    preferences,
    preferenceWrites,
    rects,
    nextPageRects,
    callbacks,
    reader,
    exports: module.exports,
    row: elements.find((el) => el.className === "glossa-selection-actions"),
    send: elements.find((el) =>
      el.className?.includes("glossa-selection-translate"),
    ),
    paragraphSend: elements.find((el) =>
      el.className?.includes("glossa-selection-paragraph"),
    ),
    addToChat: elements.find((el) =>
      el.className?.includes("glossa-selection-chat"),
    ),
    glossary: elements.find(
      (el) => el.className === "glossa-selection-glossary",
    ),
    status: elements.find((el) => el.className === "glossa-selection-status"),
    drawer: elements.find((el) => el.className === "glossa-inline-translation"),
    drawerBody: elements.find((el) => el.className === "glossa-inline-body"),
    drawerBadge: elements.find((el) => el.className === "glossa-inline-badge"),
    drawerError: elements.find((el) => el.className === "glossa-inline-error"),
    saveAnnBtn: elements.find(
      (el) => el.className === "glossa-inline-save-btn",
    ),
    reviewBtn: elements.find((el) =>
      el.className?.includes("glossa-inline-review"),
    ),
    drawerChatBtn: elements.find((el) =>
      el.className?.includes("glossa-inline-chat"),
    ),
    copyBtn: elements.find((el) =>
      el.className?.includes("glossa-inline-copy"),
    ),
  };
  popupHarnesses.push(state);
  return state;
}
function assertSendReady(popup, ready, message = "Send readiness") {
  assert.equal(popup.send.disabled, !ready, message);
  assert.equal(
    popup.send["aria-disabled"],
    String(!ready),
    message + " (ARIA)",
  );
}
function assertParagraphReady(popup, ready, message = "Paragraph readiness") {
  assert.equal(popup.paragraphSend.disabled, !ready, message);
  assert.equal(
    popup.paragraphSend["aria-disabled"],
    String(!ready),
    message + " (ARIA)",
  );
}
const whole =
  "The complete natural paragraph begins before the selected few words and ends after them without a neighbouring paragraph.";
const selectionDefault = harness(() => ({ kind: "ready", text: whole }));
assert.equal(
  selectionDefault.elements.some((el) =>
    el.className?.includes("glossa-selection-scope"),
  ),
  false,
);
assert.equal(
  selectionDefault.elements.some((el) =>
    el.className?.includes("glossa-selection-explain"),
  ),
  false,
  "redundant Explain button must be removed",
);
assertSendReady(
  selectionDefault,
  true,
  "a nonempty selection is immediately ready",
);
assertParagraphReady(selectionDefault, false);
assert.equal(selectionDefault.calls.length, 1);
assert.equal(
  selectionDefault.addedContexts.length,
  0,
  "passive text selection must never pollute the multi-context workbench",
);
assert.deepEqual(selectionDefault.row.children, [
  selectionDefault.send,
  selectionDefault.paragraphSend,
  selectionDefault.addToChat,
  selectionDefault.glossary,
]);
assert.ok(
  !selectionDefault.elements.some(
    (el) =>
      el.className === "glossa-selection-label" ||
      el.className === "glossa-selection-heading",
  ),
);
assert.ok(!selectionDefault.elements.some((el) => el.textContent === "Glossa"));

// Docking into Zotero's highlight color row places `[翻译] [整段] [加入会话] [📖]`
// directly to the right of the 8 color squares.
const docked = harness(() => ({ kind: "ready", text: whole }), {
  withNativePopup: true,
});
assert.equal(docked.colorRow.children.length, 9);
assert.equal(docked.colorRow.children.at(-1), docked.row);
assert.equal(
  docked.colorRow.classList.contains("glossa-color-row-merged"),
  true,
);
assert.equal(docked.row.classList.contains("glossa-top-actions-docked"), true);
assert.equal(docked.holder.classList.contains("glossa-docked"), true);
assert.equal(docked.outerPopup.classList.contains("glossa-popup-host"), true);
assert.equal(
  docked.holder.children.includes(docked.row),
  false,
  "docked row moves out of holder into the color row",
);

const css = selectionDefault.elements.find(
  (el) => el.tag === "style",
).textContent;
assert.match(css, /\.glossa-selection-actions\s*\{[^}]*display:\s*flex/);
assert.ok(!css.includes("grid-column: 1 / -1"));
assert.match(
  css,
  /\.glossa-selection-panel,\s*\.glossa-top-actions-docked\s*\{/,
  "docked top actions must inherit Glossa CSS variables",
);
assert.match(
  css,
  /\.glossa-top-actions-docked\s+\.glossa-selection-send\s*\{/,
  "docked buttons must override Zotero .colors button swatch sizing",
);
const disabledRule = css.match(
  /\.glossa-selection-send:disabled\s*\{([^}]+)\}/,
)?.[1];
assert.ok(disabledRule, "the disabled arrow needs its own CSS rule");
assert.match(
  disabledRule,
  /background(?:-color)?:\s*var\(--glossa-selection-disabled\)/,
);
assert.match(disabledRule, /color:\s*var\(--glossa-selection-disabled-text\)/);
assert.match(
  disabledRule,
  /opacity:\s*1\s*;/,
  "gray must not be a translucent green accent",
);
assert.match(
  css,
  /\.glossa-selection-send\s*\{[^}]*background:\s*var\(--glossa-selection-accent\)/,
);
assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
const darkAt = css.search(/@media\s*\(prefers-color-scheme:\s*dark\)/);
for (const themedCss of [css.slice(0, darkAt), css.slice(darkAt)]) {
  assert.match(themedCss, /--glossa-selection-disabled:\s*#[\da-f]{6}\s*;/i);
  assert.match(
    themedCss,
    /--glossa-selection-disabled-text:\s*#[\da-f]{6}\s*;/i,
  );
}
for (const match of css.matchAll(
  /--glossa-selection-disabled:\s*(#[\da-f]{6})\s*;/gi,
)) {
  const rgb = [1, 3, 5].map((offset) =>
    Number.parseInt(match[1].slice(offset, offset + 2), 16),
  );
  assert.ok(
    Math.max(...rgb) - Math.min(...rgb) <= 32,
    "disabled background must be neutral gray in both themes",
  );
}

assert.equal(
  harness(() => undefined, { preferences: { "reader.popup": false } }).holder,
  undefined,
);
for (const text of ["", " \t\n", null, undefined]) {
  const empty = harness(
    () => {
      throw new Error("must not read without a selection");
    },
    { text },
  );
  assert.equal(empty.holder, undefined);
  assert.equal(empty.addedContexts.length, 0);
  assert.equal(empty.calls.length, 0);
}
await settle();
assert.match(
  selectionDefault.status.textContent,
  /^selection-paragraph-ready:/,
);
assertParagraphReady(selectionDefault, true);
assert.equal(
  selectionDefault.addedContexts.length,
  0,
  "recognition must never add to context workbench by itself",
);
// Clicking Translate opens the inline translation drawer without touching
// the Glossa sidebar context workbench.
await selectionDefault.send.fire("click");
assert.equal(selectionDefault.calls.length, 1);
assert.equal(selectionDefault.popupTranslations.length, 1);
assert.equal(
  selectionDefault.popupTranslations[0].source,
  "selected few words",
);
assert.equal(selectionDefault.popupTranslations[0].scope, "selection");
assert.equal(selectionDefault.addedContexts.length, 0);
assertSendReady(selectionDefault, true);
assertParagraphReady(selectionDefault, true);

// Clicking Add to Chat explicitly appends the selection to the workbench.
await selectionDefault.addToChat.fire("click");
assert.equal(selectionDefault.addedContexts.length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(selectionDefault.addedContexts[0].item)),
  { kind: "text", text: "selected few words", page: 38 },
);

assert.equal(selectionDefault.glossary["aria-label"], "glossary-add");
await selectionDefault.glossary.fire("click");
assert.equal(
  selectionDefault.glossaryOpens.length,
  1,
  "the glossary button opens the local editor",
);
assert.equal(
  selectionDefault.glossaryOpens[0].source,
  "selected few words",
  "the editor starts from the current selection",
);
assert.equal(
  selectionDefault.calls.length,
  1,
  "opening the glossary must not rescan",
);
assert.equal(selectionDefault.send.title, "selection-translate-tip");
assert.equal(
  selectionDefault.paragraphSend.title,
  "selection-translate-paragraph-tip",
);

const crossing = {
  kind: "unmatched",
  detail: "selection-crosses-paragraph-boundary",
};
const changed = harness(() => crossing);
assertSendReady(changed, true);
assertParagraphReady(changed, false);
await settle();
assert.equal(
  changed.status.textContent,
  "selection-paragraph-crosses-boundary",
);
assertParagraphReady(changed, false, "failed paragraph stays gray");
assertSendReady(
  changed,
  true,
  "selection translate stays available after paragraph failure",
);
assert.equal(changed.popupTranslations.length, 0);
await changed.paragraphSend.fire("click");
assert.equal(
  changed.calls.length,
  1,
  "a disabled paragraph click must not retry",
);
assert.equal(changed.popupTranslations.length, 0);
changed.paragraphSend.disabled = false;
await changed.paragraphSend.fire("click");
assert.equal(changed.calls.length, 1);
assert.equal(changed.popupTranslations.length, 0);
assertParagraphReady(changed, false);
await changed.send.fire("click");
assert.equal(changed.popupTranslations.length, 1);
assert.equal(changed.popupTranslations[0].source, "selected few words");

for (const failure of [
  undefined,
  { kind: "unavailable" },
  { kind: "unmatched", multiParagraph: true, detail: "missing-page-end" },
  { kind: "too-long", multiParagraph: true },
  { kind: "ready", text: "" },
  { kind: "ready", text: " \n\t " },
]) {
  const failed = harness(() => failure);
  assertSendReady(failed, true);
  assertParagraphReady(failed, false);
  await settle();
  assert.equal(failed.status.hidden, false);
  assert.equal(failed.popupTranslations.length, 0);
  assertParagraphReady(failed, false);
  assert.equal(failed.addedContexts.length, 0);
  const diagnosis = failed.status.textContent;
  await failed.paragraphSend.fire("click");
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.popupTranslations.length, 0);
  assert.equal(failed.status.textContent, diagnosis);
  assertParagraphReady(failed, false);
  assert.equal(failed.addToChat.disabled, false);
  if (failure?.kind === "ready")
    assert.match(diagnosis, /paragraph-text-empty/);
  if (failure?.multiParagraph && failure.kind === "unmatched")
    assert.match(diagnosis, /^selection-paragraph-multi-unmatched/);
}
const rejected = harness(() => {
  throw new Error("page unavailable");
});
await settle();
assert.equal(rejected.status.textContent, "selection-paragraph-unavailable");
assertParagraphReady(rejected, false);
assertSendReady(rejected, true);
await rejected.paragraphSend.fire("click");
assert.equal(rejected.calls.length, 1);
assert.equal(rejected.popupTranslations.length, 0);

const newlySelected = harness(() => ({ kind: "ready", text: whole }));
assertParagraphReady(newlySelected, false);
await settle();
assertParagraphReady(
  newlySelected,
  true,
  "a fresh popup reads the paragraph again",
);
assert.equal(newlySelected.popupTranslations.length, 0);

const twoParagraphs =
  whole + "\n\nA second complete paragraph must retain its own line break.";
const nextPageRects = [[20, 700, 300, 710]];
const ready = harness(
  () => ({ kind: "ready", text: twoParagraphs, paragraphs: 2 }),
  { nextPageRects },
);
assertParagraphReady(ready, false);
await settle();
assertParagraphReady(ready, true);
assert.match(ready.status.textContent, /^selection-paragraph-multi-ready:/);
assert.match(ready.status.textContent, /"paragraphs":2/);
assert.equal(ready.popupTranslations.length, 0);
await ready.paragraphSend.fire("click");
assert.equal(ready.calls.length, 1);
assert.equal(ready.calls[0][1], "selected few words");
assert.equal(ready.calls[0][2], 37);
assert.equal(ready.calls[0][3], ready.rects);
assert.equal(ready.calls[0][4], nextPageRects);
assert.equal(ready.popupTranslations.length, 1);
assert.equal(ready.popupTranslations[0].source, twoParagraphs);
assert.equal(ready.popupTranslations[0].scope, "paragraph");
assertParagraphReady(ready, true);
await ready.paragraphSend.fire("click");
assert.equal(
  ready.calls.length,
  1,
  "a confirmed paragraph is not extracted again",
);
assert.equal(ready.popupTranslations.length, 2);

const sendPending = deferred();
const eager = harness(() => sendPending.promise);
assertParagraphReady(eager, false);
assertSendReady(eager, true);
await eager.paragraphSend.fire("click");
sendPending.resolve({ kind: "ready", text: twoParagraphs, paragraphs: 2 });
await settle();
assertParagraphReady(eager, true);
assert.equal(
  eager.popupTranslations.length,
  0,
  "a paragraph click while detecting must not queue a send",
);
await eager.paragraphSend.fire("click");
assert.equal(
  eager.popupTranslations.length,
  1,
  "only a click after confirmation may open the paragraph translation",
);

for (const clickParagraph of [false, true]) {
  const pending = deferred();
  const closed = harness(() => pending.promise);
  if (clickParagraph) await closed.paragraphSend.fire("click");
  closed.holder.isConnected = false;
  pending.resolve({ kind: "ready", text: whole });
  await settle();
  await closed.paragraphSend.fire("click");
  await closed.send.fire("click");
  await closed.addToChat.fire("click");
  assert.equal(
    closed.popupTranslations.length,
    0,
    "a closed popup must not translate",
  );
  assert.equal(
    closed.addedContexts.length,
    0,
    "a closed popup must not add to context workbench",
  );
}
for (const result of [
  { kind: "ready", text: twoParagraphs, paragraphs: 2 },
  { kind: "unavailable" },
  { kind: "unmatched", multiParagraph: true },
]) {
  const pending = deferred();
  const delayedMount = harness(() => pending.promise, {
    initiallyConnected: false,
  });
  assertSendReady(delayedMount, true);
  assertParagraphReady(delayedMount, false);
  pending.resolve(result);
  await settle();
  assert.equal(delayedMount.popupTranslations.length, 0);
  assert.equal(delayedMount.addedContexts.length, 0);
  assert.notEqual(
    delayedMount.status.textContent,
    "selection-paragraph-loading",
  );
  assert.equal(delayedMount.status.hidden, false);
  assertParagraphReady(delayedMount, result.kind === "ready");
  await delayedMount.paragraphSend.fire("click");
  assert.equal(
    delayedMount.popupTranslations.length,
    0,
    "detached paragraph click has no external effect",
  );
  delayedMount.holder.isConnected = true;
  await delayedMount.paragraphSend.fire("click");
  assert.equal(delayedMount.calls.length, 1);
  if (result.kind === "ready") {
    assert.equal(delayedMount.popupTranslations.length, 1);
    assert.equal(delayedMount.popupTranslations[0].source, twoParagraphs);
  } else {
    assert.equal(delayedMount.popupTranslations.length, 0);
    assertParagraphReady(delayedMount, false);
  }
}

// Re-entrancy gate: while an inline translation awaits, extra clicks are ignored
// and buttons re-enable in finally.
{
  const pendingTrans = deferred();
  const gated = harness(() => ({ kind: "ready", text: whole }), {
    streamPopupTranslation: () => pendingTrans.promise,
  });
  await settle();
  const op = gated.send.fire("click");
  assertSendReady(gated, false);
  assertParagraphReady(gated, false);
  assert.equal(gated.addToChat.disabled, true);
  assert.equal(gated.send["aria-busy"], "true");
  await gated.send.fire("click");
  await gated.addToChat.fire("click");
  assert.equal(gated.popupTranslations.length, 1);
  assert.equal(gated.addedContexts.length, 0);
  pendingTrans.resolve({
    ok: true,
    text: "ok",
    pieces: [{ source: "selected few words", text: "ok" }],
  });
  await op;
  assertSendReady(gated, true);
  assertParagraphReady(gated, true);
  assert.equal(gated.addToChat.disabled, false);
  assert.equal(gated.send["aria-busy"], undefined);
}

// Markdown alignment upgrades selection translate, paragraph translate, and
// Add to Chat, succeeding even when native PDF.js layout fails on math.
const mdParagraph =
  "For an arbitrary quantity $\\Phi$ inside a stator, Eq. (30) holds.";
const mdSelection = "an arbitrary quantity $\\Phi$ inside a stator";
const mdHarness = harness(
  () => ({
    kind: "unmatched",
    detail: "selection-includes-unrecognized-text",
  }),
  {
    text: "an arbitrary quantity  inside a stator",
    markdownAligned: async () => ({
      kind: "matched",
      selectionText: mdSelection,
      selectionEnhanced: true,
      paragraphText: mdParagraph,
      paragraphCount: 1,
      via: "geometry",
      blocks: [],
      visualBlocks: [],
    }),
  },
);
await settle();
assertParagraphReady(mdHarness, true);
assert.match(mdHarness.status.textContent, /^selection-paragraph-md-ready:/);
assert.equal(
  mdHarness.addedContexts.length,
  0,
  "Markdown alignment never passively overwrites context tray",
);
await mdHarness.send.fire("click");
assert.equal(mdHarness.popupTranslations[0].source, mdSelection);
assert.equal(mdHarness.popupTranslations[0].scope, "selection");
await mdHarness.paragraphSend.fire("click");
assert.equal(mdHarness.popupTranslations[1].source, mdParagraph);
assert.equal(mdHarness.popupTranslations[1].scope, "paragraph");
await mdHarness.addToChat.fire("click");
assert.equal(mdHarness.addedContexts.length, 1);
assert.equal(mdHarness.addedContexts[0].item.text, mdSelection);

// Inline translation drawer inside Zotero's selection popup:
// translates in place without a second window, supports copy, review (with
// draft retention on error), saving as a native Zotero highlight annotation,
// updating that same annotation in place after review, and adding the full
// translated paragraph to the multi-context workbench.
{
  let reviewShouldFail = false;
  const inline = harness(() => ({ kind: "ready", text: whole }), {
    withNativePopup: true,
    streamPopupReview: async ({ onDelta }) => {
      if (reviewShouldFail) {
        return { ok: false, text: "", error: "translation-config-missing" };
      }
      onDelta("审校后译文");
      return { ok: true, text: "审校后译文" };
    },
  });
  await settle();
  assert.equal(inline.drawer.hidden, true);
  assert.equal(
    inline.holder.classList.contains("glossa-selection-expanded"),
    false,
  );

  await inline.paragraphSend.fire("click");
  assert.equal(inline.drawer.hidden, false);
  assert.equal(
    inline.holder.classList.contains("glossa-selection-expanded"),
    true,
  );
  // Widens Zotero's outer `.selection-popup` container itself (never forcing an
  // overflowing child pixel width on `holder`).
  assert.equal(inline.holder.style.width, undefined);
  assert.equal(inline.outerPopup.classList.contains("glossa-popup-host"), true);
  assert.equal(
    inline.outerPopup.classList.contains("glossa-popup-expanded"),
    true,
  );
  const inlineStyle = inline.elements.find(
    (el) => el.tag === "style",
  ).textContent;
  assert.match(inlineStyle, /\.glossa-popup-expanded\s*\{[^}]*width:/);
  assert.equal(inline.drawerBody.textContent, `译文:${whole}`);
  assert.equal(inline.drawerBadge.textContent, "translate-popup-paragraph");
  assert.equal(inline.addedContexts.length, 0);

  // Copy copies translated text cleanly.
  await inline.copyBtn.fire("click");
  assert.equal(inline.copiedTexts.at(-1), `译文:${whole}`);

  // Save as native Zotero highlight annotation (translation stored in comment).
  await inline.saveAnnBtn.fire("click");
  assert.equal(inline.savedHighlights.length, 1);
  assert.equal(inline.savedHighlights[0].rawText, "selected few words");
  assert.equal(inline.savedHighlights[0].translation, `译文:${whole}`);
  assert.equal(inline.savedHighlights[0].existingKey, undefined);
  assert.equal(
    inline.saveAnnBtn.textContent,
    "translate-popup-saved-annotation",
  );

  // Failed review retains the draft and shows inline error.
  reviewShouldFail = true;
  await inline.reviewBtn.fire("click");
  await settle();
  assert.equal(inline.drawerBody.textContent, `译文:${whole}`);
  assert.equal(inline.drawerError.hidden, false);

  // Successful review updates translation; clicking Save again updates the SAME
  // annotation instead of creating a duplicate highlight!
  reviewShouldFail = false;
  await inline.reviewBtn.fire("click");
  await settle();
  assert.equal(inline.drawerBody.textContent, "审校后译文");
  assert.equal(inline.drawerBadge.textContent, "translate-popup-reviewed");
  assert.equal(inline.drawerError.hidden, true);

  await inline.saveAnnBtn.fire("click");
  assert.equal(inline.savedHighlights.length, 2);
  assert.equal(inline.savedHighlights[1].existingKey, "HLNEW01");
  assert.equal(inline.savedHighlights[1].translation, "审校后译文");
  assert.equal(
    inline.saveAnnBtn.textContent,
    "translate-popup-updated-annotation",
  );

  // Add to chat from paragraph drawer stages the full paragraph with scope tag.
  await inline.drawerChatBtn.fire("click");
  assert.equal(inline.addedContexts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(inline.addedContexts[0].item)), {
    kind: "text",
    text: whole,
    page: 38,
    label: "translate-popup-paragraph",
  });
}

// Read-only library shows a friendly error when clicking Save as highlight.
{
  const ro = harness(() => ({ kind: "ready", text: whole }), {
    saveHighlight: async () => ({ ok: false, reason: "read-only" }),
  });
  await settle();
  await ro.send.fire("click");
  await ro.saveAnnBtn.fire("click");
  assert.equal(ro.drawerError.hidden, false);
}

// Unified annotation context menu & left sidebar annotation header:
// BOTH image/area annotations and text highlights expose a single clean
// "Add to chat" action that stages multimodal/aligned context into Glossa.
const imageAnnotation = {
  libraryID: 1,
  key: "IMGANN01",
  isAnnotation: () => true,
  annotationType: "image",
  annotationComment: "Check Fig. 31 peaks",
};
const highlightAnnotation = {
  libraryID: 1,
  key: "HLANN01",
  isAnnotation: () => true,
  annotationType: "highlight",
  annotationText: "raw highlight",
  annotationComment: "Key assumption",
};
const menuHarness = harness(() => ({ kind: "unavailable" }), {
  annotationsByKey: {
    "1:IMGANN01": imageAnnotation,
    "1:HLANN01": highlightAnnotation,
  },
  annotationContext: async (_reader, _target, item) =>
    item.key === "IMGANN01"
      ? {
          kind: "visual",
          visualKind: "figure",
          page: 17,
          image: { mimeType: "image/png", data: "iVBORw0KGgo=" },
          caption: "Fig. 31. Total pressure ratio at fan face.",
          markdownText: "![Fig 31](images/fig31.png)",
          comment: "Check Fig. 31 peaks",
        }
      : {
          kind: "text",
          page: 17,
          text: "Clean $\\Phi$ highlight text.",
          comment: "Key assumption",
          fromMarkdown: true,
        },
});
await settle();
const imageMenuItems = [];
menuHarness.callbacks.createAnnotationContextMenu({
  reader: menuHarness.reader,
  params: { currentID: "IMGANN01", ids: ["IMGANN01"], x: 0, y: 0 },
  append: (item) => imageMenuItems.push(item),
});
assert.equal(imageMenuItems.length, 1);
assert.equal(imageMenuItems[0].label, "annotation-add-to-chat");
imageMenuItems[0].onCommand();
await settle();
assert.equal(menuHarness.addedContexts.length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(menuHarness.addedContexts[0].item)),
  {
    kind: "figure",
    text: "![Fig 31](images/fig31.png)",
    caption: "Fig. 31. Total pressure ratio at fan face.",
    comment: "Check Fig. 31 peaks",
    page: 17,
    image: { mimeType: "image/png", data: "iVBORw0KGgo=" },
  },
);

const hlMenuItems = [];
menuHarness.callbacks.createAnnotationContextMenu({
  reader: menuHarness.reader,
  params: { currentID: "HLANN01", ids: ["HLANN01"], x: 0, y: 0 },
  append: (item) => hlMenuItems.push(item),
});
assert.equal(
  hlMenuItems.length,
  1,
  "annotation menu is streamlined to one unified Add to Chat item",
);
assert.equal(hlMenuItems[0].label, "annotation-add-to-chat");
hlMenuItems[0].onCommand();
await settle();
assert.equal(menuHarness.addedContexts.length, 2);
assert.deepEqual(
  JSON.parse(JSON.stringify(menuHarness.addedContexts[1].item)),
  {
    kind: "text",
    text: "Clean $\\Phi$ highlight text.",
    comment: "Key assumption",
    page: 17,
  },
);

// Sidebar annotation header shortcut: appends 1-click "Add to chat" button on
// image and highlight cards without opening the `...` context menu.
const sidebarHeaderEls = [];
menuHarness.callbacks.renderSidebarAnnotationHeader({
  doc: {
    createElement: (tag) => new Element(tag),
  },
  reader: menuHarness.reader,
  params: {
    annotation: { type: "image", key: "IMGANN01" },
  },
  append: (el) => sidebarHeaderEls.push(el),
});
assert.equal(sidebarHeaderEls.length, 1);
assert.equal(sidebarHeaderEls[0].className, "glossa-sidebar-ann-chat");
assert.equal(sidebarHeaderEls[0].textContent, "sidebar-annotation-add-chat");
await sidebarHeaderEls[0].fire("click");
await settle();
assert.equal(menuHarness.addedContexts.length, 3);
assert.equal(menuHarness.addedContexts[2].item.kind, "figure");
assert.equal(menuHarness.addedContexts[2].item.image.mimeType, "image/png");

// Empty note annotation card gets no button.
const emptyHeaderEls = [];
menuHarness.callbacks.renderSidebarAnnotationHeader({
  doc: {
    createElement: (tag) => new Element(tag),
  },
  reader: menuHarness.reader,
  params: {
    annotation: { type: "note", key: "NOTE01", text: "", comment: "" },
  },
  append: (el) => emptyHeaderEls.push(el),
});
assert.equal(emptyHeaderEls.length, 0);

// Reader visual overlay toolbar toggle: renders toggle button, flips pref
// `reader.visualOverlay` on click, uses addVisualTargetToChat, and unregisters cleanly.
{
  const overlayCode = await compiled("../src/modules/readerOverlay.ts");
  let overlayEnabled = true;
  const overlayListeners = {};
  const toolbarButtons = [];
  const headChildren = [];
  class OverlayEl extends Element {
    constructor(tag) {
      super(tag);
      this.classSet = new Set();
      this.classList = {
        toggle: (name, force) => {
          if (force) this.classSet.add(name);
          else this.classSet.delete(name);
        },
        contains: (name) => this.classSet.has(name),
      };
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
  }
  const overlayMod = { exports: {} };
  runInNewContext(overlayCode, {
    module: overlayMod,
    exports: overlayMod.exports,
    require: (name) => {
      const map = {
        "../../package.json": { config: { addonID: "glossa-test" } },
        "../utils/locale": { getString: (k) => k },
        "../utils/prefs": {
          getPref: (k) =>
            k === "reader.visualOverlay" ? overlayEnabled : undefined,
          setPref: (k, v) => {
            if (k === "reader.visualOverlay") overlayEnabled = v;
          },
        },
        "../utils/reader": { asItem: (i) => i },
        "./context": { targetFor: () => undefined },
        "./markdownPrep/readerAlign": {
          pickVisualTargetAtPoint: () => undefined,
        },
        "./markdownPrep/readerBridge": {
          createNativeVisualAnnotation: async () => ({ ok: true, key: "A" }),
          getReaderLayoutVersion: () => "1",
          loadPageVisualTargets: async () => [],
          resolveVisualTargetForAI: async () => undefined,
        },
        "./selectionPopup": { addVisualTargetToChat: () => true },
      };
      assert.ok(name in map, `Unexpected overlay dep: ${name}`);
      return map[name];
    },
    Zotero: {
      Items: { get: () => undefined },
      Reader: {
        _readers: [],
        registerEventListener: (name, fn) => {
          overlayListeners[name] = fn;
        },
        unregisterEventListener: (name) => {
          delete overlayListeners[name];
        },
      },
    },
    ztoolkit: {
      log: () => {},
      getGlobal: () => undefined,
    },
  });
  overlayMod.exports.registerReaderOverlay();
  assert.ok(overlayListeners.renderToolbar);
  overlayListeners.renderToolbar({
    reader: { type: "pdf", _instanceID: "r1", itemID: 2 },
    doc: {
      head: { appendChild: (el) => headChildren.push(el) },
      getElementById: () => null,
      createElement: (tag) => new OverlayEl(tag),
    },
    append: (el) => toolbarButtons.push(el),
  });
  assert.equal(toolbarButtons.length, 1);
  assert.equal(toolbarButtons[0]["aria-pressed"], "true");
  assert.equal(toolbarButtons[0].classList.contains("glossa-active"), true);
  assert.equal(toolbarButtons[0].classList.contains("glossa-off"), false);
  assert.equal(toolbarButtons[0].title, "visual-overlay-toggle-on");
  const onSvg = toolbarButtons[0].innerHTML;
  assert.ok(onSvg.includes("<circle"), "ON icon shows active status indicator");
  await toolbarButtons[0].fire("click");
  assert.equal(overlayEnabled, false);
  assert.equal(toolbarButtons[0]["aria-pressed"], "false");
  assert.equal(toolbarButtons[0].classList.contains("glossa-active"), false);
  assert.equal(toolbarButtons[0].classList.contains("glossa-off"), true);
  assert.equal(toolbarButtons[0].title, "visual-overlay-toggle-off");
  const offSvg = toolbarButtons[0].innerHTML;
  assert.notEqual(offSvg, onSvg, "ON and OFF toolbar icons must be distinct");
  assert.ok(offSvg.includes("<line"), "OFF icon shows a clear diagonal slash");
  overlayMod.exports.unregisterReaderOverlay();
  assert.equal(overlayListeners.renderToolbar, undefined);
}

// Direct check of saveHighlightTranslationAnnotation in readerBridge.ts:
// respects read-only library, creates a native Zotero `highlight` annotation
// with translation stored in `annotationComment`, and updates in place when
// `existingKey` is provided.
{
  const bridgeCode = await compiled(
    "../src/modules/markdownPrep/readerBridge.ts",
  );
  let writable = true;
  const savedItems = [];
  const painted = [];
  const itemsByKey = new Map();
  let nextKey = 1;
  class MockZoteroItem {
    constructor(type) {
      this.itemType = type;
      this.key = `HLKEY0${nextKey++}`;
    }
    isAnnotation() {
      return this.itemType === "annotation";
    }
    async saveTx() {
      savedItems.push({ ...this });
      itemsByKey.set(`${this.libraryID}:${this.key}`, this);
    }
  }
  const bridgeMod = { exports: {} };
  runInNewContext(bridgeCode, {
    module: bridgeMod,
    exports: bridgeMod.exports,
    require: (name) => {
      const map = {
        "../pdfLayout": { getPdfPageViewBox: async () => [0, 0, 600, 800] },
        "./journal": { readBytes: async () => undefined },
        "./paddleAssets": { sniffImageMime: () => "image/png" },
        "./queue": { getStateForPDF: () => undefined },
        "./readerAlign": {},
        "./settings": { readSettings: () => ({ readContext: true }) },
        "./store": {
          isLibraryWritable: () => writable,
          readPreparedAsset: async () => undefined,
          readPreparedLayout: async () => undefined,
        },
      };
      assert.ok(name in map, `Unexpected bridge dep: ${name}`);
      return map[name];
    },
    Zotero: {
      Item: MockZoteroItem,
      Items: {
        getByLibraryAndKey: (lib, key) => itemsByKey.get(`${lib}:${key}`),
      },
      Annotations: {},
    },
    ztoolkit: { log: () => {}, getGlobal: () => undefined },
  });

  const mockReader = {
    _internalReader: { _tools: { highlight: { color: "#2ea8e5" } } },
    setAnnotations: (list) => painted.push(...list),
  };
  const mockTarget = {
    attachment: { id: 99, libraryID: 1, isPDFAttachment: () => true },
  };

  // Read-only library refuses cleanly.
  writable = false;
  const roRes = await bridgeMod.exports.saveHighlightTranslationAnnotation({
    reader: mockReader,
    target: mockTarget,
    rawText: "Boundary layer",
    translation: "边界层",
    pageIndex: 4,
    rects: [[10, 20, 100, 35]],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(roRes)), {
    ok: false,
    reason: "read-only",
  });

  // Writable library creates native highlight annotation with translation comment.
  writable = true;
  const createdRes = await bridgeMod.exports.saveHighlightTranslationAnnotation(
    {
      reader: mockReader,
      target: mockTarget,
      rawText: "Boundary layer",
      translation: "边界层",
      pageIndex: 4,
      pageLabel: "5",
      rects: [[10, 20, 100, 35]],
      sortIndex: "00004|000010|00020",
    },
  );
  assert.equal(createdRes.ok, true);
  assert.equal(createdRes.updated, false);
  assert.equal(savedItems.length, 1);
  assert.equal(savedItems[0].annotationType, "highlight");
  assert.equal(savedItems[0].annotationColor, "#2ea8e5");
  assert.equal(savedItems[0].annotationText, "Boundary layer");
  assert.equal(savedItems[0].annotationComment, "边界层");
  assert.equal(painted.length, 1);

  // Updating the same annotation after review edits comment in place.
  const updatedRes = await bridgeMod.exports.saveHighlightTranslationAnnotation(
    {
      reader: mockReader,
      target: mockTarget,
      rawText: "Boundary layer",
      translation: "边界层（审校定稿）",
      pageIndex: 4,
      rects: [[10, 20, 100, 35]],
      existingKey: createdRes.key,
    },
  );
  assert.equal(updatedRes.ok, true);
  assert.equal(updatedRes.updated, true);
  assert.equal(updatedRes.key, createdRes.key);
  assert.equal(
    itemsByKey.get(`1:${createdRes.key}`).annotationComment,
    "边界层（审校定稿）",
  );
}

for (const state of popupHarnesses)
  assert.deepEqual(
    state.preferenceWrites,
    [],
    "popup actions must never write preferences",
  );

// Exercise the real generic preferences binding, with the unrelated preference
// pane initialization stubbed out.
const prefSource = await compiled(
  "../src/modules/preferences.ts",
  "\nexport { PreferencesPane as TestPreferencesPane };\n",
);
const prefControl = new Element("input");
prefControl.dataset.pref = "chatNumber";
prefControl.dataset.type = "int";
prefControl.min = "1";
const prefRoot = {
  querySelectorAll: (selector) =>
    selector === "[data-pref]" || selector === '[data-pref="chatNumber"]'
      ? [prefControl]
      : [],
};
let stored = 6;
const writes = [];
let observer;
const prefModule = { exports: {} };
runInNewContext(prefSource, {
  module: prefModule,
  exports: prefModule.exports,
  require: (name) =>
    name === "../../package.json"
      ? {
          config: {
            addonRef: "glossa",
            prefsPrefix: "extensions.zotero.glossa",
          },
        }
      : {},
  Zotero: {
    Prefs: {
      get: () => stored,
      set: (key, value) => {
        writes.push([key, value]);
        stored = value;
        observer();
      },
      registerObserver: (key, handler) => {
        observer = handler;
        return 1;
      },
      unregisterObserver: () => {},
    },
  },
});
const pane = new prefModule.exports.TestPreferencesPane({
  document: { getElementById: () => prefRoot },
});
pane.refreshDerived = () => {};
pane.bindPrefs();
assert.equal(prefControl.value, "6");
prefControl.value = "10";
await prefControl.fire("change");
assert.deepEqual(writes.at(-1), ["extensions.zotero.glossa.chatNumber", 10]);
assert.equal(prefControl.value, "10");
prefControl.value = "0";
await prefControl.fire("change");
assert.equal(writes.length, 1);
assert.equal(prefControl.value, "10");
stored = undefined;
observer();
assert.equal(prefControl.value, "");
const prefMarkup = await read("../addon/content/preferences.xhtml");
assert.doesNotMatch(prefMarkup, /reader\.popupScope/);
assert.doesNotMatch(prefMarkup, /pref-reader-popup-scope/);
for (const lang of ["zh-CN", "en-US"]) {
  const settingsLocale = await read(`../addon/locale/${lang}/preferences.ftl`);
  const popupLocale = await read(`../addon/locale/${lang}/addon.ftl`);
  assert.doesNotMatch(settingsLocale, /^pref-reader-popup-scope/m);
  for (const key of [
    "selection-paragraph-button",
    "selection-paragraph-multi-ready",
    "selection-paragraph-multi-unmatched",
    "selection-layout-diagnostic",
    "annotation-add-to-chat",
    "sidebar-annotation-add-chat",
    "visual-action-chat",
    "context-tray-title",
    "context-tray-clear",
  ])
    assert.match(popupLocale, new RegExp(`^${key} = .+`, "m"));
  for (const key of [
    "selection-paragraph-unavailable",
    "selection-paragraph-unmatched",
    "selection-paragraph-multi-unmatched",
    "selection-paragraph-crosses-boundary",
  ]) {
    const message = popupLocale.match(new RegExp(`^${key} = (.+)$`, "m"))?.[1];
    assert.ok(message);
    assert.match(
      message,
      lang === "zh-CN"
        ? /重新划选文字后再次识别/
        : /Select the text again to retry recognition/,
    );
    assert.match(
      message,
      lang === "zh-CN" ? /选区发送/ : /send the highlighted selection/,
    );
    assert.doesNotMatch(message, /再次点击发送重试|Click Send again to retry/);
  }
  if (lang === "zh-CN") {
    assert.match(popupLocale, /^selection-paragraph-button = 整段$/m);
    assert.match(popupLocale, /^selection-scope-paragraph = 选段$/m);
    assert.ok(!popupLocale.includes("本段"));
  }
}
console.log(
  "Selection popup: top-row color-bar docking, zero passive pollution, unified Add to Chat across popup/drawer/annotations/overlay, inline translation + highlight save, readiness gate, and theme CSS passed (mock DOM, not live Zotero)",
);

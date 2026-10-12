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
assert.equal(defaultPrefs["reader.popupScope"], "selection");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.events = new Map();
    this.isConnected = true;
    this.value = "";
    this.disabled = false;
    this.textContent = "";
    this.hidden = false;
    this.dataset = {};
  }
  append(...children) {
    this.children.push(...children);
  }
  setAttribute(name, value) {
    this[name] = String(value);
  }
  removeAttribute(name) {
    delete this[name];
  }
  addEventListener(name, callback) {
    this.events.set(name, callback);
  }
  async fire(name) {
    await this.events.get(name)?.({ preventDefault() {} });
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
    offers = [],
    asks = [],
    rendered = [],
    calls = [],
    preferenceWrites = [];
  const preferences = { ...defaultPrefs, ...options.preferences };
  const setPreference = (key, value) => {
    preferenceWrites.push([key, value]);
    preferences[key] = value;
  };
  let callback;
  const target = { item: { id: 1 }, pdf: { id: 2 } };
  const attachment = { id: 2, parentItem: { id: 1 } };
  const reader = { itemID: 2 };
  const rects = [[10, 10, 40, 20]];
  const nextPageRects = options.nextPageRects;
  const doc = {
    createElement: (tag) => {
      const el = new Element(tag);
      elements.push(el);
      return el;
    },
  };
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
    "./pdfParagraph": paragraphModule.exports,
    "./pdfLayout": {
      getPdfLayoutParagraph: async (...args) => {
        calls.push(args);
        return await extract();
      },
    },
    "./runner": {
      runner: {
        busy: options.busy === true,
        ask: async (config) => {
          const built = await config.build(target, {});
          asks.push({ ...config, built });
          return options.ask ? await options.ask(config) : true;
        },
      },
    },
    "./sidebar": {
      offerSelection: (...args) => offers.push(args),
      revealSidebar: () => {},
    },
    "./tags": { TRANSLATE_TEMPLATE: "test translation" },
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
      Items: { get: () => attachment },
      Reader: {
        registerEventListener: (name, handler) => {
          callback = handler;
        },
      },
    },
    ztoolkit: { log: () => {} },
  });
  module.exports.registerSelectionPopup();
  let holder;
  callback({
    doc,
    reader,
    params: {
      annotation: {
        text: "text" in options ? options.text : "selected few words",
        pageLabel: "38",
        position: { pageIndex: 37, rects, nextPageRects },
      },
    },
    append: (el) => {
      holder = el;
      holder.isConnected = options.initiallyConnected !== false;
    },
  });
  const state = {
    holder,
    elements,
    offers,
    asks,
    rendered,
    calls,
    preferences,
    preferenceWrites,
    rects,
    nextPageRects,
    action: elements.find((el) => el.className === "glossa-selection-action"),
    row: elements.find((el) => el.className === "glossa-selection-actions"),
    send: elements.find((el) => el.className === "glossa-selection-send"),
    paragraphSend: elements.find((el) =>
      el.className?.includes("glossa-selection-paragraph"),
    ),
    status: elements.find((el) => el.className === "glossa-selection-status"),
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
assertSendReady(
  selectionDefault,
  true,
  "a nonempty selection is immediately ready",
);
assertParagraphReady(selectionDefault, false);
assert.equal(selectionDefault.calls.length, 1);
assert.equal(selectionDefault.asks.length, 0);
assert.deepEqual(selectionDefault.row.children, [
  selectionDefault.action,
  selectionDefault.send,
  selectionDefault.paragraphSend,
]);
assert.ok(
  !selectionDefault.elements.some(
    (el) =>
      el.className === "glossa-selection-label" ||
      el.className === "glossa-selection-heading",
  ),
);
assert.ok(!selectionDefault.elements.some((el) => el.textContent === "Glossa"));
const css = selectionDefault.elements.find(
  (el) => el.tag === "style",
).textContent;
assert.match(
  css,
  /grid-template-columns:\s*minmax\(0, 1fr\) 32px auto/,
);
assert.ok(!css.includes("grid-column: 1 / -1"));
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
  assert.equal(empty.asks.length, 0);
  assert.equal(empty.calls.length, 0);
}
await settle();
assert.match(selectionDefault.status.textContent, /^selection-paragraph-ready:/);
assertParagraphReady(selectionDefault, true);
assert.equal(selectionDefault.asks.length, 0, "recognition must never send by itself");
await selectionDefault.send.fire("click");
assert.equal(selectionDefault.calls.length, 1);
assert.equal(selectionDefault.asks[0].built.prompt, "selected few words");
assert.equal(selectionDefault.asks[0].built.translation, undefined);
assert.equal(
  selectionDefault.asks[0].display.includes("selection-scope-paragraph"),
  false,
);
assert.equal(selectionDefault.status.textContent, "popup-saved");
assertSendReady(selectionDefault, true);
assertParagraphReady(selectionDefault, true);
await selectionDefault.action.fire("change");
assert.equal(selectionDefault.asks.length, 1, "changing the action must not send");
assert.match(selectionDefault.send.title, /^selection-send:/);
assert.match(selectionDefault.paragraphSend.title, /^selection-send-paragraph:/);

const crossing = {
  kind: "unmatched",
  detail: "selection-crosses-paragraph-boundary",
};
const changed = harness(() => crossing);
assertSendReady(changed, true);
assertParagraphReady(changed, false);
await settle();
assert.equal(changed.status.textContent, "selection-paragraph-crosses-boundary");
assertParagraphReady(changed, false, "failed paragraph stays gray");
assertSendReady(changed, true, "selection send stays available after paragraph failure");
assert.equal(changed.asks.length, 0);
assert.match(changed.paragraphSend.title, /^selection-send-paragraph:/);
await changed.paragraphSend.fire("click");
assert.equal(changed.calls.length, 1, "a disabled paragraph click must not retry");
assert.equal(changed.asks.length, 0);
changed.paragraphSend.disabled = false;
await changed.paragraphSend.fire("click");
assert.equal(changed.calls.length, 1);
assert.equal(changed.asks.length, 0);
assertParagraphReady(changed, false);
await changed.send.fire("click");
assert.equal(changed.asks.length, 1);
assert.equal(changed.asks[0].built.prompt, "selected few words");

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
  assert.equal(failed.asks.length, 0);
  assertParagraphReady(failed, false);
  assert.equal(failed.offers.length, 1);
  assert.equal(failed.offers.at(-1)[1], "selected few words");
  const diagnosis = failed.status.textContent;
  await failed.paragraphSend.fire("click");
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.asks.length, 0);
  assert.equal(failed.status.textContent, diagnosis);
  assertParagraphReady(failed, false);
  assert.equal(failed.action.disabled, false);
  if (failure?.kind === "ready") assert.match(diagnosis, /paragraph-text-empty/);
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
assert.equal(rejected.asks.length, 0);

const newlySelected = harness(() => ({ kind: "ready", text: whole }));
assertParagraphReady(newlySelected, false);
await settle();
assertParagraphReady(newlySelected, true, "a fresh popup reads the paragraph again");
assert.equal(newlySelected.asks.length, 0);

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
assert.equal(ready.asks.length, 0);
await ready.paragraphSend.fire("click");
assert.equal(ready.calls.length, 1);
assert.equal(ready.calls[0][1], "selected few words");
assert.equal(ready.calls[0][2], 37);
assert.equal(ready.calls[0][3], ready.rects);
assert.equal(ready.calls[0][4], nextPageRects);
assert.equal(ready.asks[0].built.translation.source, twoParagraphs);
assert.equal(ready.asks[0].built.prompt, twoParagraphs);
assert.equal(ready.offers.at(-1)[1], twoParagraphs);
assert.ok(ready.asks[0].display.includes("selection-scope-paragraph"));
assertParagraphReady(ready, true);
await ready.paragraphSend.fire("click");
assert.equal(ready.calls.length, 1, "a confirmed paragraph is not extracted again");
assert.equal(ready.asks.length, 2);

const sendPending = deferred();
const eager = harness(() => sendPending.promise);
assertParagraphReady(eager, false);
assertSendReady(eager, true);
await eager.paragraphSend.fire("click");
sendPending.resolve({ kind: "ready", text: twoParagraphs, paragraphs: 2 });
await settle();
assertParagraphReady(eager, true);
assert.equal(eager.asks.length, 0, "a paragraph click while detecting must not queue a send");
await eager.paragraphSend.fire("click");
assert.equal(eager.asks.length, 1, "only a click after confirmation may submit the paragraph");

for (const clickParagraph of [false, true]) {
  const pending = deferred();
  const closed = harness(() => pending.promise);
  if (clickParagraph) await closed.paragraphSend.fire("click");
  const offersBefore = closed.offers.length;
  closed.holder.isConnected = false;
  pending.resolve({ kind: "ready", text: whole });
  await settle();
  await closed.paragraphSend.fire("click");
  await closed.send.fire("click");
  assert.equal(closed.asks.length, 0, "a closed popup must not send");
  assert.equal(closed.offers.length, offersBefore);
}
for (const result of [
  { kind: "ready", text: twoParagraphs, paragraphs: 2 },
  { kind: "unavailable" },
  { kind: "unmatched", multiParagraph: true },
]) {
  const pending = deferred();
  const delayedMount = harness(() => pending.promise, { initiallyConnected: false });
  assertSendReady(delayedMount, true);
  assertParagraphReady(delayedMount, false);
  const offersBefore = delayedMount.offers.length;
  pending.resolve(result);
  await settle();
  assert.equal(delayedMount.asks.length, 0);
  assert.equal(delayedMount.offers.length, offersBefore);
  assert.notEqual(delayedMount.status.textContent, "selection-paragraph-loading");
  assert.equal(delayedMount.status.hidden, false);
  assertParagraphReady(delayedMount, result.kind === "ready");
  await delayedMount.paragraphSend.fire("click");
  assert.equal(delayedMount.asks.length, 0, "detached paragraph send has no external effect");
  delayedMount.holder.isConnected = true;
  await delayedMount.paragraphSend.fire("click");
  assert.equal(delayedMount.calls.length, 1);
  if (result.kind === "ready") {
    assert.equal(delayedMount.asks.length, 1);
    assert.equal(delayedMount.asks[0].built.prompt, twoParagraphs);
  } else {
    assert.equal(delayedMount.asks.length, 0);
    assertParagraphReady(delayedMount, false);
  }
}

const model = deferred();
const sending = harness(() => ({ kind: "ready", text: whole }), {
  ask: () => model.promise,
});
await settle();
assertSendReady(sending, true);
assertParagraphReady(sending, true);
const operation = sending.send.fire("click");
assertSendReady(sending, false);
assertParagraphReady(sending, false);
assert.equal(sending.send["aria-busy"], "true");
await settle();
assert.equal(sending.asks.length, 1);
await sending.send.fire("click");
await sending.paragraphSend.fire("click");
sending.send.disabled = false;
await sending.send.fire("click");
assert.equal(sending.asks.length, 1, "synthetic clicks must not submit twice");
model.resolve(true);
await operation;
assertSendReady(sending, true);
assertParagraphReady(sending, true);
assert.equal(sending.send["aria-busy"], undefined);
assert.equal(sending.action.disabled, false);

const failedModel = harness(() => ({ kind: "ready", text: whole }), {
  ask: () => {
    throw new Error("model unavailable");
  },
});
await settle();
await failedModel.send.fire("click");
assertSendReady(failedModel, true);
assertParagraphReady(failedModel, true);
assert.equal(failedModel.status.textContent, "selection-incomplete");

const modelBeforeClose = deferred();
const closedDuringModel = harness(() => ({ kind: "ready", text: whole }), {
  ask: () => modelBeforeClose.promise,
});
const closingOperation = closedDuringModel.send.fire("click");
await settle();
closedDuringModel.holder.isConnected = false;
modelBeforeClose.resolve(true);
await closingOperation;
await closedDuringModel.send.fire("click");
assert.equal(closedDuringModel.asks.length, 1);
assert.equal(closedDuringModel.status.hidden, true);

for (const state of popupHarnesses)
  assert.deepEqual(
    state.preferenceWrites,
    [],
    "popup actions must never write preferences",
  );


// Exercise the real generic preferences binding, with the unrelated preference
// pane initialization stubbed out. Only the popup-scope control is installed.
const prefSource = await compiled(
  "../src/modules/preferences.ts",
  "\nexport { PreferencesPane as TestPreferencesPane };\n",
);
const prefControl = new Element("select");
prefControl.dataset.pref = "reader.popupScope";
const prefRoot = {
  querySelectorAll: (selector) =>
    selector === "[data-pref]" || selector === '[data-pref="reader.popupScope"]'
      ? [prefControl]
      : [],
};
let stored = "selection";
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
assert.equal(prefControl.value, "selection");
prefControl.value = "paragraph";
await prefControl.fire("change");
assert.deepEqual(writes.at(-1), [
  "extensions.zotero.glossa.reader.popupScope",
  "paragraph",
]);
assert.equal(prefControl.value, "paragraph");
prefControl.value = "invalid";
await prefControl.fire("change");
assert.equal(writes.length, 1);
assert.equal(prefControl.value, "paragraph");
prefControl.value = "selection";
await prefControl.fire("change");
assert.deepEqual(writes.at(-1), [
  "extensions.zotero.glossa.reader.popupScope",
  "selection",
]);
assert.equal(writes.length, 2);
stored = undefined;
observer();
assert.equal(prefControl.value, "selection");
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
  "Selection popup: gray/green readiness gate, ARIA/theme CSS, no disabled-click sends, scope retry/cache/stale/close safety, send finally, no preference writes, single row and multi-paragraph text passed (mock DOM, not live Zotero)",
);

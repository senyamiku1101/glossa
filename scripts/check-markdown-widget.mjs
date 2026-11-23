/* global URL, console */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.classList = { add: () => {} };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  removeEventListener(k) {
    delete this.listeners[k];
  }
  contains(n) {
    return n === this || this.children.some((c) => c.contains(n));
  }
  remove() {
    this.removed = true;
  }
  focus() {}
}
const doc = new Element("document");
doc.createElementNS = (_, tag) => new Element(tag);
doc.activeElement = null;
let listener,
  unsubscribed = false,
  rows = [],
  cancelled,
  cleared = false,
  retried;
const queue = {
  getStates: () => rows,
  subscribe: (fn) => {
    listener = fn;
    return () => (unsubscribed = true);
  },
  cancel: (key) => (cancelled = key),
  clearFinishedStates: () => (cleared = true),
  retryItem: (key) => (retried = key),
};
const { outputText } = ts.transpileModule(
  await readFile(
    new URL("../src/modules/markdownUI.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
);
const module = { exports: {} };
runInNewContext(outputText, {
  module,
  exports: module.exports,
  require: (n) =>
    n === "./markdownPrep/queue"
      ? queue
      : n === "../utils/locale"
        ? { getString: (k) => k }
        : n === "../../package.json"
          ? { config: {} }
          : {},
  console,
});
const timers = new Map();
let timer = 0;
const win = {
  document: doc,
  setTimeout: (fn, delay) => {
    timers.set(++timer, { fn, delay });
    return timer;
  },
  clearTimeout: (id) => timers.delete(id),
};
const widget = module.exports.createBackgroundTasksWidget(win);
const [trigger, panel] = widget.root.children;
const [header, list] = panel.children;
assert(panel.hidden);
let stoppedWhenHidden = false;
widget.root.onkeydown({
  key: "Escape",
  stopPropagation: () => (stoppedWhenHidden = true),
});
assert(!stoppedWhenHidden);
assert.equal(list.children[0].textContent, "暂无后台任务");
trigger.onclick();
assert(!panel.hidden);
let stoppedWhenOpen = false;
widget.root.onkeydown({
  key: "Escape",
  stopPropagation: () => (stoppedWhenOpen = true),
});
assert(stoppedWhenOpen);
assert(panel.hidden);
trigger.onclick();
assert(!panel.hidden);
assert.equal(trigger.attrs["aria-expanded"], "true");
widget.root.onmouseenter();
assert([...timers.values()].some((t) => t.delay === 350));
rows = [
  {
    key: "running",
    status: "running",
    title: "Paper",
    progress: { page: 3, pages: 10, stage: "polling" },
    updatedAt: 1,
  },
];
listener(rows);
assert.equal(widget.root.dataset.state, "running");
assert.equal(
  list.children[0].children[1].children[0].textContent,
  "解析 3/10 页",
);
list.children[0].children.at(-1).onclick();
await Promise.resolve();
await Promise.resolve();
assert.equal(cancelled, "running");
listener([{ key: "fail", status: "failed", title: "Failure", updatedAt: 2 }]);
assert.equal(widget.root.dataset.state, "failed");
list.children[0].children.at(-1).onclick();
await Promise.resolve();
await Promise.resolve();
assert.equal(retried, "fail");
header.children[1].onclick();
assert(cleared);
listener([{ status: "done", title: "Done" }]);
assert.equal(widget.root.dataset.state, "done");
widget.dispose();
widget.dispose();
assert(unsubscribed);
assert(widget.root.removed);
assert.equal(timers.size, 0);
assert(!doc.listeners.pointerdown);

// Toolbar mode: mounts trigger inside `#zotero-items-toolbar` right before the
// Quick Search box and portals the popover panel to `documentElement`.
const rootEl = new Element("window");
const searchBox = new Element("search-textbox");
searchBox.id = "zotero-tb-search";
const itemsToolbar = new Element("hbox");
itemsToolbar.id = "zotero-items-toolbar";
itemsToolbar.append(searchBox);
itemsToolbar.insertBefore = (node, ref) => {
  const idx = itemsToolbar.children.indexOf(ref);
  if (idx >= 0) itemsToolbar.children.splice(idx, 0, node);
  else itemsToolbar.children.push(node);
  node.parent = itemsToolbar;
  node.parentNode = itemsToolbar;
};
itemsToolbar.querySelector = (sel) =>
  sel === "#zotero-tb-search" ? searchBox : null;
searchBox.parentNode = itemsToolbar;

const tbDoc = new Element("document");
tbDoc.documentElement = rootEl;
tbDoc.createElementNS = (_, tag) => {
  const el = new Element(tag);
  el.style = {};
  el.getBoundingClientRect = () => ({ right: 500, bottom: 40 });
  return el;
};
tbDoc.getElementById = (id) =>
  id === "zotero-items-toolbar" ? itemsToolbar : null;
tbDoc.activeElement = null;
const tbWin = {
  document: tbDoc,
  innerWidth: 1200,
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn, delay) => {
    timers.set(++timer, { fn, delay });
    return timer;
  },
  clearTimeout: (id) => timers.delete(id),
};
const tbWidget = module.exports.createBackgroundTasksWidget(tbWin, {
  mode: "toolbar",
});
assert.equal(
  tbWidget.root.className,
  "glossa-bgtasks-root glossa-bgtasks-toolbar",
);
assert.equal(tbWidget.root.children.length, 1);
assert.equal(rootEl.children.length, 1);
const [tbTrigger] = tbWidget.root.children;
const [tbPanel] = rootEl.children;
assert.equal(tbPanel.hidden, true);
tbTrigger.onclick();
assert.equal(tbPanel.hidden, false);
assert.equal(tbPanel.style.top, "46px");
tbWidget.dispose();
assert(tbWidget.root.removed);
assert(tbPanel.removed);

console.log(
  "Widget checks passed: empty, toggle, hover debounce, progress, cancel, retry, clear, status indicators, toolbar popover mode, idempotent disposal.",
);

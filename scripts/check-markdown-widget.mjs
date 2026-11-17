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
assert.equal(list.children[0].textContent, "暂无后台任务");
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
console.log(
  "Widget checks passed: empty, toggle, hover debounce, progress, cancel, retry, clear, status indicators, idempotent disposal.",
);

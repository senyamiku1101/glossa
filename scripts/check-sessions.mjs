/* global console, URL */
// Run the shipped store and runner with in-memory Zotero services.
// No user profile, files, or API requests are touched.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function load(path, imports = {}, globals = {}) {
  const source = await readFile(new URL("../" + path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    require(name) {
      assert.ok(name in imports, "Unexpected dependency: " + name);
      return imports[name];
    },
    ...globals,
  });
  return module.exports;
}
const history = await load("src/utils/history.ts");
const { splitTranslationSource } = await load("src/utils/translation.ts");
const disk = new Map();
let serial = 0;
let deleteObserver;
let failWrites = false;
const io = {
  exists: async (path) => disk.has(path),
  readUTF8: async (path) => disk.get(path),
  writeUTF8: async (path, text) => {
    if (failWrites) throw new Error("disk full");
    disk.set(path, text);
  },
  makeDirectory: async () => {},
  remove: async (path) => disk.delete(path),
};
const globals = {
  Zotero: {
    Utilities: { randomString: () => "session" + ++serial },
    Libraries: { get: () => ({ libraryType: "user", editable: true }) },
    Notifier: {
      registerObserver: (observer) => {
        deleteObserver = observer;
        return "observer";
      },
      unregisterObserver() {},
    },
  },
  ztoolkit: { log() {} },
};
const { ConversationStore } = await load(
  "src/modules/conversations.ts",
  {
    "../../package.json": { config: { addonRef: "glossa" } },
    "../utils/paths": {
      io: () => io,
      conversationsDir: () => "/sessions",
      paths: () => ({ join: (...parts) => parts.join("/") }),
    },
    "../utils/history": history,
  },
  globals,
);
const flush = async (store) => {
  // Wait for the real serialized write queue, including its cleanup handlers.
  while (store.writes.size) await Promise.all([...store.writes.values()]);
};
const pair = [
  {
    role: "user",
    content: "First\n  question",
    source: { text: "source passage", truncated: false },
  },
  { role: "assistant", content: "Answer", reasoning: "private reasoning" },
];
const oldRaw = history.serializeConversation("Paper", pair);
disk.set("/sessions/u_PAPER.json", oldRaw);
const store = new ConversationStore();
store.init();
const convo = await store.ensureLoaded("1/PAPER", "Paper");
assert.equal(convo.sessions.length, 1);
assert.equal(store.active("1/PAPER").title, "First question");
assert.equal(store.active("1/PAPER").turns[0].source.text, "source passage");
assert.equal(disk.get("/sessions/u_PAPER.json.v1.bak"), oldRaw);
assert.equal(
  disk.get("/sessions/u_PAPER.json"),
  oldRaw,
  "read should not overwrite v1",
);

const legacyId = convo.activeId;
const second = store.createSession("1/PAPER");
assert.equal(convo.sessions.length, 2, "new keeps previous history");
assert.equal(convo.sessions[0].turns.length, 2);
assert.equal(store.createSession("1/PAPER").id, second.id, "reuse empty draft");
store.renameSession("1/PAPER", second.id, "  Methods\n  & limits  ");
assert.equal(second.title, "Methods & limits");
store.startPending("1/PAPER", second.id, "Second question");
store.setBusy("1/PAPER", second.id);
store.selectSession("1/PAPER", legacyId);
store.updatePending("1/PAPER", second.id, "streamed", "reasoning");
assert.equal(store.active("1/PAPER").pending, undefined);
assert.equal(second.pending.text, "streamed");
assert.equal(
  store.deleteSession("1/PAPER", second.id),
  false,
  "running session cannot be deleted",
);
store.commitPending("1/PAPER", second.id, pair[0], pair[1]);
store.setBusy(undefined);
await flush(store);
const persisted = JSON.parse(disk.get("/sessions/u_PAPER.json"));
assert.equal(persisted.version, 2);
assert.equal(persisted.activeId, legacyId);
assert.equal(persisted.sessions[1].turns.length, 2);
assert.equal(persisted.sessions[1].title, "Methods & limits");
assert.ok(!disk.get("/sessions/u_PAPER.json").includes("private reasoning"));
assert.equal(disk.get("/sessions/u_PAPER.json.v1.bak"), oldRaw);

const restored = new ConversationStore();
await restored.ensureLoaded("1/PAPER");
assert.equal(restored.get("1/PAPER").sessions.length, 2);
assert.equal(restored.active("1/PAPER").id, legacyId);
restored.deleteSession("1/PAPER", legacyId);
assert.equal(restored.active("1/PAPER").id, second.id);
restored.deleteSession("1/PAPER", second.id);
assert.equal(restored.get("1/PAPER").sessions.length, 1);
assert.equal(restored.active("1/PAPER").turns.length, 0);
await flush(restored);

// Malformed or future-format files must not be overwritten with an empty chat.
for (const raw of [
  '{"version":99}',
  '{"version":2,"sessions":[]}',
  "{broken",
]) {
  disk.set("/sessions/u_BAD.json", raw);
  const damaged = new ConversationStore();
  const bad = await damaged.ensureLoaded("1/BAD");
  assert.equal(bad.storageError, true);
  assert.equal(damaged.createSession("1/BAD"), undefined);
  damaged.renameSession("1/BAD", bad.activeId, "test");
  await flush(damaged);
  assert.equal(disk.get("/sessions/u_BAD.json"), raw);
}
assert.equal(
  history.parseSessionFile(
    JSON.stringify({
      version: 2,
      sessions: [persisted.sessions[0], persisted.sessions[0]],
    }),
  ),
  undefined,
);
assert.equal(
  history.parseSessionFile(
    JSON.stringify({
      ...persisted,
      activeId: "missing",
    }),
  ).activeId,
  legacyId,
);

// A write failure must retain in-memory history and block destructive actions.
const failing = new ConversationStore();
await failing.ensureLoaded("1/FAIL");
const failedId = failing.active("1/FAIL").id;
failWrites = true;
failing.commitPending("1/FAIL", failedId, pair[0], pair[1]);
await flush(failing);
assert.equal(failing.get("1/FAIL").storageError, true);
assert.equal(failing.active("1/FAIL").turns.length, 2);
assert.equal(failing.deleteSession("1/FAIL", failedId), false);
failWrites = false;

// Exercise the real async runner: switching sessions during context building
// must neither mix the request history nor send the reply into the new session.
const runStore = new ConversationStore();
await runStore.ensureLoaded("1/RUN");
const runId = runStore.active("1/RUN").id;
runStore.commitPending("1/RUN", runId, ...pair);
let built;
const buildGate = new Promise((resolve) => {
  built = resolve;
});
let receivedMessages;
const { runner } = await load("src/modules/runner.ts", {
  "../utils/locale": { getString: (key) => key },
  "../utils/config": { DEFAULT_SYSTEM_PROMPT: "System" },
  "../utils/history": history,
  "../utils/translation": { splitTranslationSource },
  "./conversations": { conversations: runStore },
  "./settings": {
    readActiveConfig: () => ({
      chatNumber: { enabled: false },
      systemPrompt: "",
    }),
  },
  "./llm": {
    streamChat: async (_config, messages, delta) => {
      receivedMessages = messages;
      delta({ text: "Reply in original session", reasoning: "" });
      return { text: "Reply in original session" };
    },
  },
});
const answer = runner.ask({
  target: { key: "1/RUN", label: "Run paper" },
  sessionId: runId,
  display: "Follow-up",
  build: async () => {
    await buildGate;
    return { prompt: "New context with follow-up", compact: "Follow-up" };
  },
});
await Promise.resolve();
await Promise.resolve();
const other = runStore.createSession("1/RUN");
assert.notEqual(other.id, runId);
built();
assert.equal(await answer, true);
assert.equal(other.turns.length, 0);
assert.equal(runStore.active("1/RUN").id, other.id);
assert.equal(runStore.get("1/RUN").sessions[0].turns.length, 4);
assert.equal(receivedMessages[1].content, pair[0].content);
assert.equal(receivedMessages.at(-1).content, "New context with follow-up");
await flush(runStore);

// A long paragraph is translated in verified pieces. An unmarked response is
// retried at a smaller size instead of being saved as a complete translation.
const longSource = Array.from(
  { length: 32 },
  (_, index) =>
    `Sentence ${index} explains a different part of the experiment.`,
).join(" ");
const initialPieces = splitTranslationSource(longSource);
assert.ok(initialPieces.length > 1);
assert.equal(initialPieces.join(" "), longSource);
assert.ok(initialPieces.every((piece) => piece.length <= 1000));
const translationStore = new ConversationStore();
await translationStore.ensureLoaded("1/TRANSLATION");
const successfulSources = [];
let attempts = 0;
const { runner: translationRunner } = await load("src/modules/runner.ts", {
  "../utils/locale": { getString: (key) => key },
  "../utils/config": { DEFAULT_SYSTEM_PROMPT: "System" },
  "../utils/history": history,
  "../utils/translation": { splitTranslationSource },
  "./conversations": { conversations: translationStore },
  "./settings": {
    readActiveConfig: () => ({
      chatNumber: { enabled: false },
      systemPrompt: "",
    }),
  },
  "./llm": {
    streamChat: async (_config, messages, delta) => {
      attempts++;
      const source = messages
        .at(-1)
        .content.split("SOURCE:")[1]
        .split("\n\n请在译文")[0];
      if (source.length > 700) {
        delta({ text: "Unfinished", reasoning: "" });
        return {
          text: "Unfinished",
          reasoning: "",
          incomplete: "",
          aborted: false,
        };
      }
      successfulSources.push(source);
      const text = `Translated ${source.length} [[GLOSSA_TRANSLATION_END]]`;
      delta({ text, reasoning: "" });
      return { text, reasoning: "", incomplete: "", aborted: false };
    },
  },
});
assert.equal(
  await translationRunner.ask({
    target: { key: "1/TRANSLATION", label: "Paper" },
    display: "Translate paragraph",
    build: async () => ({
      prompt: `FULL:${longSource}`,
      compact: `FULL:${longSource}`,
      translation: {
        source: longSource,
        promptFor: async (piece) => `SOURCE:${piece}`,
      },
    }),
  }),
  true,
);
const translatedTurns = translationStore.active("1/TRANSLATION").turns;
assert.equal(translatedTurns[0].content, `FULL:${longSource}`);
assert.equal(successfulSources.join(" "), longSource);
assert.ok(attempts > initialPieces.length);
assert.ok(!translatedTurns[1].content.includes("Unfinished"));
assert.ok(!translatedTurns[1].content.includes("GLOSSA_TRANSLATION_END"));
await flush(translationStore);

const failureStore = new ConversationStore();
await failureStore.ensureLoaded("1/NO_MARKER");
const { runner: failureRunner } = await load("src/modules/runner.ts", {
  "../utils/locale": { getString: (key) => key },
  "../utils/config": { DEFAULT_SYSTEM_PROMPT: "System" },
  "../utils/history": history,
  "../utils/translation": { splitTranslationSource },
  "./conversations": { conversations: failureStore },
  "./settings": {
    readActiveConfig: () => ({
      chatNumber: { enabled: false },
      systemPrompt: "",
    }),
  },
  "./llm": {
    streamChat: async () => ({
      text: "Partial answer",
      reasoning: "",
      incomplete: "",
      aborted: false,
    }),
  },
});
assert.equal(
  await failureRunner.ask({
    target: { key: "1/NO_MARKER", label: "Paper" },
    display: "Translate paragraph",
    build: async () => ({
      prompt: "Full source",
      compact: "Full source",
      translation: {
        source: "A paragraph with enough words to translate completely.",
        promptFor: async (piece) => piece,
      },
    }),
  }),
  false,
);
assert.equal(failureStore.active("1/NO_MARKER").turns.length, 0);
assert.equal(
  failureStore.active("1/NO_MARKER").failed.error,
  "translation-incomplete",
);
// Item deletion must remove sessions and their legacy backup.
await flush(store);
deleteObserver.notify("delete", "item", [42], {
  42: { libraryID: 1, key: "PAPER" },
});
await flush(store);
assert.equal(disk.has("/sessions/u_PAPER.json"), false);
assert.equal(disk.has("/sessions/u_PAPER.json.v1.bak"), false);

// Deleting an item during v1 migration must not leave a resurrected backup.
disk.set("/sessions/u_RACE.json", oldRaw);
const racing = new ConversationStore();
racing.init();
const originalRead = io.readUTF8;
let releaseRead;
let readStarted;
const started = new Promise((resolve) => {
  readStarted = resolve;
});
const gate = new Promise((resolve) => {
  releaseRead = resolve;
});
io.readUTF8 = async (path) => {
  const raw = await originalRead(path);
  readStarted();
  await gate;
  return raw;
};
const loading = racing.ensureLoaded("1/RACE");
await started;
deleteObserver.notify("delete", "item", [43], {
  43: { libraryID: 1, key: "RACE" },
});
releaseRead();
await loading;
await flush(racing);
io.readUTF8 = originalRead;
assert.equal(disk.has("/sessions/u_RACE.json"), false);
assert.equal(disk.has("/sessions/u_RACE.json.v1.bak"), false);
assert.equal(racing.convos.has("1/RACE"), false);
console.log(
  "Session persistence, migration, failure protection, and async routing passed",
);

// Minimal DOM surface for the actual viewport controller. Check native navigation
// is restored, unrelated reader tabs are untouched, and event listeners clean up.
class Node {
  classList = {
    values: new Set(),
    add: (value) => this.classList.values.add(value),
    remove: (value) => this.classList.values.delete(value),
    contains: (value) => this.classList.values.has(value),
  };
  listeners = new Map();
  style = { removeProperty: (key) => delete this.style[key] };
  hidden = false;
  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }
  removeEventListener(name, fn) {
    if (this.listeners.get(name) === fn) this.listeners.delete(name);
  }
}
const doc = new Node();
const details = new Node();
const scroller = new Node();
scroller.clientHeight = 700;
scroller.scrollTop = 280;
const section = new Node();
const host = new Node();
host.parentElement = scroller;
host.dataset = { pane: "glossa-chat" };
host.querySelector = () => section;
const body = new Node();
body.closest = (tag) => (tag === "item-details" ? details : host);
const root = new Node();
let resize;
let disconnected = false;
const win = {
  document: doc,
  ResizeObserver: class {
    constructor(callback) {
      resize = callback;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  },
};
const { attachSidebarViewport } = await load("src/modules/sidebarViewport.ts");
const viewport = attachSidebarViewport(win, body, root);
assert.equal(scroller.classList.contains("glossa-pane-viewport"), false);
function nav(pane, container = details, type = "click", key) {
  const button = {
    closest: () => ({ container }),
    getAttribute: (name) => (name === "data-pane" ? pane : null),
  };
  doc.listeners.get(type)({
    type,
    key,
    button: 0,
    target: { closest: () => button },
  });
}
nav("glossa-chat");
assert.equal(details.classList.contains("glossa-workspace-active"), true);
assert.equal(scroller.scrollTop, 0);
assert.equal(root.style.height, "700px");
assert.equal(section.open, true);
nav("info", {});
assert.equal(details.classList.contains("glossa-workspace-active"), true);
nav("info");
assert.equal(details.classList.contains("glossa-workspace-active"), false);
assert.equal(scroller.classList.contains("glossa-pane-viewport"), false);
nav("glossa-chat", details, "keydown", "Enter");
assert.equal(details.classList.contains("glossa-workspace-active"), true);
scroller.clientHeight = 510;
resize();
assert.equal(root.style.height, "510px");
viewport.dispose();
assert.equal(details.classList.contains("glossa-workspace-active"), false);
assert.equal(doc.listeners.size, 0);
assert.equal(root.listeners.size, 0);
assert.equal(root.style.height, undefined);
assert.equal(disconnected, true);
viewport.activate();
assert.equal(details.classList.contains("glossa-workspace-active"), false);
console.log(
  "Sidebar activation, keyboard navigation, resize, and cleanup passed",
);

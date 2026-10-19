/* global console, URL */
// Targeted checks for the local glossary and the two-model translation flow.
// The shipped modules run against in-memory paths and a mock stream: no user
// profile, no files outside memory, no API requests.
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

// Objects that cross a vm context boundary carry a different prototype, so
// compare their plain JSON form instead.
const plain = (value) => JSON.parse(JSON.stringify(value));
const same = (actual, expected, message) =>
  assert.deepEqual(plain(actual), expected, message);

const glossaryUtils = await load("src/utils/glossary.ts");
const {
  GLOSSARY_SOURCE_LIMIT,
  GLOSSARY_TARGET_LIMIT,
  buildGlossaryIndex,
  glossaryKey,
  parseGlossary,
  prepareTerm,
  serializeGlossary,
} = glossaryUtils;

// ---- pure glossary data and matching

assert.equal(glossaryKey("  Deep   Learning "), "deep learning");
assert.equal(glossaryKey("   "), undefined);
assert.equal(
  glossaryKey("x".repeat(GLOSSARY_SOURCE_LIMIT)),
  "x".repeat(GLOSSARY_SOURCE_LIMIT),
);
assert.equal(glossaryKey("x".repeat(GLOSSARY_SOURCE_LIMIT + 1)), undefined);
assert.equal(
  prepareTerm({ source: " DNA ", target: " 脱氧核糖核酸 " }).ok,
  true,
);
same(prepareTerm({ source: " DNA ", target: " 脱氧核糖核酸 " }).term, {
  source: "DNA",
  target: "脱氧核糖核酸",
});
assert.equal(prepareTerm({ source: "  ", target: "x" }).ok, false);
assert.equal(prepareTerm({ source: "x", target: "  " }).ok, false);
assert.equal(
  prepareTerm({
    source: "x".repeat(GLOSSARY_SOURCE_LIMIT + 1),
    target: "x",
  }).ok,
  false,
);
assert.equal(
  prepareTerm({
    source: "x",
    target: "x".repeat(GLOSSARY_TARGET_LIMIT + 1),
  }).ok,
  false,
);

same(parseGlossary('{"version":1,"terms":[]}'), []);
assert.equal(parseGlossary("not json"), undefined);
assert.equal(parseGlossary('{"version":2,"terms":[]}'), undefined);
assert.equal(parseGlossary('{"version":1,"terms":{}}'), undefined);
assert.equal(
  parseGlossary('{"version":1,"terms":[{"source":"A"}]}'),
  undefined,
);
assert.equal(
  parseGlossary(
    '{"version":1,"terms":[{"source":"A","target":"a"},{"source":"a","target":"b"}]}',
  ),
  undefined,
  "duplicate keys are rejected instead of silently collapsing",
);
const parsed = parseGlossary(
  '{"version":1,"terms":[{"source":" Deep  Learning ","target":"深度学习"}]}',
);
same(parsed, [{ source: "Deep Learning", target: "深度学习" }]);
const serialized = serializeGlossary([
  { source: "RNA", target: "核糖核酸" },
  { source: "DNA", target: "脱氧核糖核酸" },
]);
assert.equal(JSON.parse(serialized).version, 1);
same(JSON.parse(serialized).terms, [
  { source: "DNA", target: "脱氧核糖核酸" },
  { source: "RNA", target: "核糖核酸" },
]);
same(parseGlossary(serialized), JSON.parse(serialized).terms);
assert.throws(() => serializeGlossary([{ source: "", target: "x" }]));

const index = buildGlossaryIndex([
  { source: "DNA", target: "脱氧核糖核酸" },
  { source: "RNA", target: "核糖核酸" },
  { source: "SPL", target: "声压级" },
  { source: "gene", target: "基因" },
  { source: "deep learning", target: "深度学习" },
  { source: "deep learning model", target: "深度学习模型" },
  { source: "注意力机制", target: "attention mechanism" },
]);
same(
  index.match("The display shows DNA and RNA, not SPL.").map((t) => t.target),
  ["脱氧核糖核酸", "核糖核酸", "声压级"],
  "word boundaries keep SPL out of display",
);
same(index.match("display spline"), [], "substrings never match");
same(
  index.match("genetic code").map((t) => t.target),
  [],
  "gene must not match inside genetic",
);
same(
  index.match("dna").map((t) => t.target),
  ["脱氧核糖核酸"],
  "matching is case insensitive",
);
same(
  index.match("A deep learning model.").map((t) => t.target),
  ["深度学习模型"],
  "the longest phrase wins over its prefix",
);
same(
  index.match("Deep   Learning is useful.").map((t) => t.target),
  ["深度学习"],
  "runs of whitespace still match a phrase",
);
same(
  index.match("DNA and DNA again").map((t) => t.target),
  ["脱氧核糖核酸"],
  "repeated hits are deduplicated",
);
same(
  index.match("这里使用注意力机制处理。").map((t) => t.target),
  ["attention mechanism"],
  "CJK terms match without word boundaries",
);
same(
  index.match("DNA").map((t) => ({ ...t })),
  [{ source: "DNA", target: "脱氧核糖核酸" }],
);
const copy = index.match("DNA")[0];
copy.target = "mutated";
same(index.match("DNA")[0].target, "脱氧核糖核酸");
same(index.find("dna"), { source: "DNA", target: "脱氧核糖核酸" });
assert.equal(index.find("missing"), undefined);
same(
  index.list("dna").map((t) => t.source),
  ["DNA"],
  "list searches the source term",
);
same(
  index.list("声压").map((t) => t.source),
  ["SPL"],
  "list also searches the translation",
);
same(
  index.list().map((t) => t.source),
  [
    "SPL",
    "DNA",
    "RNA",
    "deep learning",
    "deep learning model",
    "gene",
    "注意力机制",
  ].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)),
);
same(buildGlossaryIndex([]).match("anything"), []);

// ---- glossary store: persistence, failures, snapshot, subscription

async function loadStore(store) {
  const io = {
    exists: async (path) => store.files.has(path),
    readUTF8: async (path) => store.files.get(path),
    writeUTF8: async (path, text, options) => {
      if (store.failWrites) throw new Error("disk full");
      store.writes.push({ path, text, options });
      store.files.set(path, text);
    },
    makeDirectory: async () => {},
  };
  const module = await load(
    "src/modules/glossary.ts",
    {
      "../utils/locale": { getString: (key) => key },
      "../utils/paths": {
        dataDir: () => "/data/glossa",
        io: () => io,
        paths: () => ({ join: (...parts) => parts.join("/") }),
      },
      "../utils/glossary": glossaryUtils,
    },
    { ztoolkit: { log() {} } },
  );
  return module.glossary;
}

function memoryStore() {
  return { files: new Map(), writes: [], failWrites: false };
}

async function rejectsKey(promise, key, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, key, message);
    return true;
  });
}

{
  const disk = memoryStore();
  const store = await loadStore(disk);
  same(store.list(), []);
  let notices = 0;
  const unsubscribe = store.subscribe(() => notices++);
  await store.save({ source: "  Deep   Learning ", target: " 深度学习 " });
  assert.equal(notices, 1, "a successful write notifies subscribers");
  assert.equal(disk.writes.length, 1);
  assert.equal(disk.writes[0].path, "/data/glossa/glossary.json");
  assert.equal(
    disk.writes[0].options.tmpPath,
    "/data/glossa/glossary.json.tmp",
    "the write is atomic",
  );
  same(store.list(), [{ source: "Deep Learning", target: "深度学习" }]);
  same(parseGlossary(disk.writes[0].text), [
    { source: "Deep Learning", target: "深度学习" },
  ]);

  // A fresh store loads the same file.
  const reloaded = await loadStore(disk);
  await reloaded.ensureLoaded();
  same(reloaded.list(), [{ source: "Deep Learning", target: "深度学习" }]);

  // Same key is an update, not a duplicate.
  await store.save({ source: "deep learning", target: "深度學習" });
  assert.equal(store.list().length, 1);
  same(store.find("Deep Learning"), {
    source: "deep learning",
    target: "深度學習",
  });

  // Rename keeps one entry; a rename onto another existing key is refused.
  await store.save({ source: "RNA", target: "核糖核酸" }, "Deep Learning");
  same(
    store.list().map((t) => t.source),
    ["RNA"],
  );
  await store.save({ source: "DNA", target: "脱氧核糖核酸" });
  await rejectsKey(
    store.save({ source: "DNA", target: "x" }, "RNA"),
    "glossary-conflict",
  );
  same(
    store.list().map((t) => t.source),
    ["DNA", "RNA"],
    "a refused rename leaves memory unchanged",
  );
  same(
    parseGlossary(disk.files.get("/data/glossa/glossary.json")).map(
      (t) => t.source,
    ),
    ["DNA", "RNA"],
    "a refused rename leaves the file unchanged",
  );

  // Invalid input never reaches the file.
  const writesBefore = disk.writes.length;
  await rejectsKey(
    store.save({ source: "ok", target: " " }),
    "glossary-invalid",
  );
  assert.equal(disk.writes.length, writesBefore);

  // Snapshot is the index at creation time.
  const snapshot = await store.snapshot();
  await store.save({ source: "new term", target: "新词" });
  same(snapshot.match("new term"), [], "a snapshot does not see later writes");
  const later = await store.snapshot();
  assert.equal(later.match("new term").length, 1);

  // Concurrent saves are serialized without losing an entry.
  await Promise.all([
    store.save({ source: "alpha", target: "阿尔法" }),
    store.save({ source: "beta", target: "贝塔" }),
  ]);
  assert.ok(store.find("alpha"));
  assert.ok(store.find("beta"));

  // Removing an entry and removing a missing key.
  await store.remove("alpha");
  assert.equal(store.find("alpha"), undefined);
  await store.remove("never there");

  unsubscribe();
  notices = 0;
  await store.save({ source: "gamma", target: "伽马" });
  assert.equal(notices, 0, "unsubscribed listeners are not called again");
}

{
  // A write failure keeps both memory and the previous file.
  const disk = memoryStore();
  const store = await loadStore(disk);
  await store.save({ source: "DNA", target: "脱氧核糖核酸" });
  const before = disk.files.get("/data/glossa/glossary.json");
  disk.failWrites = true;
  await rejectsKey(
    store.save({ source: "RNA", target: "核糖核酸" }),
    "glossary-save-error",
  );
  assert.equal(store.find("RNA"), undefined);
  assert.equal(disk.files.get("/data/glossa/glossary.json"), before);

  // A damaged file is reported and never overwritten.
  const damaged = memoryStore();
  damaged.files.set("/data/glossa/glossary.json", "{broken");
  const brokenStore = await loadStore(damaged);
  await rejectsKey(brokenStore.ensureLoaded(), "glossary-load-error");
  await rejectsKey(
    brokenStore.save({ source: "DNA", target: "x" }),
    "glossary-load-error",
  );
  assert.equal(damaged.files.get("/data/glossa/glossary.json"), "{broken");
  assert.equal(damaged.writes.length, 0);
}

// ---- translation prompts and profile resolution

const translationPrefs = {};
const translationProfilesList = [
  { id: "p1", resolved: { model: "draft-m", systemPrompt: "draft system" } },
  { id: "p2", resolved: { model: "review-m", systemPrompt: "review system" } },
];
const translationModule = await load("src/modules/translation.ts", {
  "../utils/locale": { getString: (key) => key },
  "../utils/prefs": { getPref: (key) => translationPrefs[key] },
  "./settings": {
    getProfiles: () => translationProfilesList,
    resolveProfile: (profile) => profile.resolved,
  },
});
const { reviewBlock, reviewPrompt, translationProfiles, withGlossary } =
  translationModule;

assert.equal(withGlossary("prompt", []), "prompt", "no hits keeps the prompt");
const injected = withGlossary("prompt", [
  { source: "DNA", target: "脱氧核糖核酸" },
]);
assert.ok(injected.startsWith("prompt\n\n"));
assert.ok(injected.includes("术语表"));
const block = injected.split("\n").find((line) => line.startsWith("["));
same(JSON.parse(block), [{ source: "DNA", target: "脱氧核糖核酸" }]);
assert.throws(
  () =>
    withGlossary(
      "prompt",
      Array.from({ length: 40 }, (_, i) => ({
        source: "term" + i,
        target: "译".repeat(500),
      })),
    ),
  (error) => error.message === "glossary-match-limit",
  "an oversized glossary block fails instead of dropping terms",
);

const assistant = (extra) => ({
  role: "assistant",
  content: "译文",
  translation: { mode: "quick", source: "原文", status: "draft" },
  ...extra,
});
assert.equal(reviewBlock(assistant()), undefined);
assert.equal(reviewBlock(undefined), "translation-source-unavailable");
assert.equal(
  reviewBlock({ role: "user", content: "问题" }),
  "translation-source-unavailable",
);
assert.equal(
  reviewBlock(assistant({ translation: undefined })),
  "translation-source-unavailable",
);
assert.equal(
  reviewBlock(
    assistant({
      translation: {
        mode: "quick",
        source: "原文",
        status: "draft",
        sourceTruncated: true,
      },
    }),
  ),
  "translation-source-unavailable",
);
assert.equal(
  reviewBlock(
    assistant({
      translation: { mode: "quick", source: "原文", status: "incomplete" },
    }),
  ),
  "translation-source-unavailable",
);
assert.equal(
  reviewBlock(assistant({ content: " " })),
  "translation-source-unavailable",
);

const plainReview = reviewPrompt("Source text.", "Draft text.");
assert.ok(plainReview.includes("Source text."));
assert.ok(plainReview.includes("Draft text."));
assert.ok(!plainReview.includes("前一片段参考"));
const withPrevious = reviewPrompt("Current source.", "Current draft.", {
  source: "Previous source.",
  translation: "Previous translation.",
});
assert.ok(withPrevious.includes("前一片段参考"));
assert.ok(withPrevious.includes("Previous source."));
assert.ok(withPrevious.includes("Previous translation."));
const bounded = reviewPrompt("S".repeat(10), "D".repeat(10), {
  source: "A".repeat(5000),
  translation: "B".repeat(5000),
});
assert.ok(bounded.includes("节选"), "oversized previous fragments are marked");
const boundedLength =
  bounded.match(/前一片段原文：\n([\s\S]*?)\n前一片段定稿：/)[1].length +
  bounded.match(/前一片段定稿：\n([\s\S]*?)\n\n当前待审片段/)[1].length;
assert.ok(boundedLength <= 2000, "previous fragments share a 2000 char budget");

translationPrefs["translation.draftProfile"] = "";
translationPrefs["translation.reviewProfile"] = "";
assert.throws(
  () => translationProfiles("review"),
  (error) => error.message === "translation-config-missing",
);
translationPrefs["translation.draftProfile"] = "p1";
translationPrefs["translation.reviewProfile"] = "gone";
assert.throws(
  () => translationProfiles("collaborative"),
  (error) => error.message === "translation-profile-missing",
);
translationPrefs["translation.draftProfile"] = "p1";
translationPrefs["translation.reviewProfile"] = "p2";
same(translationProfiles("review"), {
  review: translationProfilesList[1].resolved,
});
translationPrefs["translation.draftProfile"] = "p1";
translationPrefs["translation.reviewProfile"] = "p2";
same(translationProfiles("collaborative"), {
  draft: translationProfilesList[0].resolved,
  review: translationProfilesList[1].resolved,
});

// ---- runner flows: request counts, glossary injection, status transitions

const historyModule = await load("src/utils/history.ts");
const translationUtils = await load("src/utils/translation.ts");
const END = "[[GLOSSA_TRANSLATION_END]]";

function makeLlm() {
  const calls = [];
  const queue = [];
  const streamChat = async (config, messages, onDelta, onCancelReady) => {
    calls.push({ config, messages });
    onCancelReady?.(() => {});
    const next = queue.shift();
    assert.ok(next, "unexpected request " + calls.length);
    const result = typeof next === "function" ? next() : next;
    onDelta?.({ text: result.text || "", reasoning: result.reasoning || "" });
    return {
      text: result.text || "",
      reasoning: result.reasoning || "",
      aborted: Boolean(result.aborted),
      incomplete: result.incomplete || "",
    };
  };
  return { streamChat, calls, queue };
}

function makeStore(turns = []) {
  const session = { id: "s1", turns: [...turns] };
  const commits = [];
  const failures = [];
  const stages = [];
  return {
    session,
    commits,
    failures,
    stages,
    setBusy() {},
    ensureLoaded: async () => ({ sessions: [session] }),
    active: () => session,
    startPending() {},
    updatePending() {},
    setPendingStage(key, id, stage) {
      stages.push(stage);
    },
    commitPending(key, id, user, answer) {
      commits.push({ user, answer });
      session.turns.push(user, answer);
    },
    failPending(key, id, error) {
      failures.push(error);
    },
  };
}

function makeGlossary(terms, fails = false) {
  const matched = [];
  let snapshots = 0;
  return {
    glossary: {
      snapshot: async () => {
        snapshots++;
        if (fails) throw new Error("glossary.json is unreadable");
        return {
          match(source) {
            const hits = terms.filter((term) => source.includes(term.source));
            matched.push({ source, hits: hits.map((term) => term.source) });
            return hits;
          },
        };
      },
    },
    stats: () => ({ snapshots, matched }),
  };
}

const target = { key: "item:1", label: "Paper" };
const chatConfig = {
  model: "chat-m",
  systemPrompt: "chat system",
  chatNumber: { enabled: false, value: 0 },
};

async function loadRunner({
  terms = [],
  turns = [],
  prefs,
  glossaryFails = false,
} = {}) {
  const llm = makeLlm();
  const store = makeStore(turns);
  const glossaryMock = makeGlossary(terms, glossaryFails);
  const logs = [];
  const profiles = translationProfilesList;
  const prefsState = {
    "translation.draftProfile": "p1",
    "translation.reviewProfile": "p2",
    ...prefs,
  };
  const translation = await load("src/modules/translation.ts", {
    "../utils/locale": { getString: (key) => key },
    "../utils/prefs": { getPref: (key) => prefsState[key] },
    "./settings": {
      getProfiles: () => profiles,
      resolveProfile: (profile) => profile.resolved,
    },
  });
  const runnerModule = await load(
    "src/modules/runner.ts",
    {
      "../utils/locale": { getString: (key) => key },
      "../utils/config": { DEFAULT_SYSTEM_PROMPT: "System" },
      "../utils/history": historyModule,
      "../utils/translation": translationUtils,
      "./conversations": { conversations: store },
      "./glossary": glossaryMock,
      "./llm": { streamChat: llm.streamChat },
      "./settings": { readActiveConfig: () => chatConfig },
      "./translation": translation,
    },
    { ztoolkit: { log: (...args) => logs.push(args) } },
  );
  return { runner: runnerModule.runner, llm, store, glossaryMock, logs };
}

const p1 = "甲".repeat(600) + "。";
const p2 = "乙".repeat(600) + "。";
const longSource = p1 + " " + p2;
const paragraphRendered = {
  prompt: "long translation prompt",
  compact: "long translation prompt",
  translation: {
    source: longSource,
    promptFor: async (piece) => "translate:" + piece,
  },
  translationRequest: { mode: "collaborative", source: longSource },
};

{
  // Draft and review both run, chunk by chunk, with a prompt built per piece.
  const flow = await loadRunner({
    terms: [
      { source: "甲", target: "甲译" },
      { source: "乙", target: "乙译" },
    ],
  });
  flow.llm.queue.push(
    { text: "D1 " + END },
    { text: "D2 " + END },
    { text: "R1 " + END },
    { text: "R2 " + END },
  );
  const kept = await flow.runner.ask({
    target,
    display: "display",
    build: async () => paragraphRendered,
  });
  assert.equal(kept, true);
  assert.equal(flow.llm.calls.length, 4, "two pieces, two models, four calls");
  assert.equal(flow.glossaryMock.stats().snapshots, 1, "one snapshot per task");
  same(flow.store.stages, ["translating", "reviewing"]);
  const draftOne = flow.llm.calls[0].messages.at(-1).content;
  const draftTwo = flow.llm.calls[1].messages.at(-1).content;
  assert.ok(draftOne.includes("translate:" + p1));
  assert.ok(draftOne.includes("甲译"));
  assert.ok(!draftOne.includes("乙译"), "only this piece's hits are sent");
  assert.ok(draftTwo.includes("translate:" + p2));
  assert.ok(draftTwo.includes("乙译"));
  assert.ok(!draftTwo.includes("甲译"));
  const reviewOne = flow.llm.calls[2].messages.at(-1).content;
  assert.ok(reviewOne.includes("原文"));
  assert.ok(reviewOne.includes(p1));
  assert.ok(reviewOne.includes("D1"));
  assert.ok(reviewOne.includes("甲译"));
  assert.ok(!reviewOne.includes("乙译"));
  assert.equal(flow.llm.calls[2].config.model, "review-m");
  assert.equal(flow.store.commits.length, 1);
  const answer = flow.store.commits[0].answer;
  assert.equal(answer.content, "R1\n\nR2");
  same(
    {
      mode: answer.translation.mode,
      status: answer.translation.status,
      translator: answer.translation.translator,
      reviewer: answer.translation.reviewer,
      draft: answer.translation.draft,
      source: answer.translation.source,
    },
    {
      mode: "collaborative",
      status: "reviewed",
      translator: "draft-m",
      reviewer: "review-m",
      draft: "D1\n\nD2",
      source: longSource,
    },
  );
  const trace = flow.store.commits[0].user.source.text;
  assert.ok(
    trace.includes("术语表"),
    "the saved trace keeps the glossary that was actually sent",
  );
  assert.ok(
    trace.includes("translate:" + p1),
    "the saved trace keeps the per-piece prompts that were actually sent",
  );
  assert.ok(trace.includes("结束标记"));
}

{
  // The chat-command path: one draft call, one review call, no extra requests.
  const flow = await loadRunner({
    terms: [{ source: "甲", target: "甲译" }],
  });
  flow.llm.queue.push({ text: "DRAFT" }, { text: "FINAL " + END });
  const kept = await flow.runner.ask({
    target,
    display: "display",
    build: async () => ({
      prompt: "PROMPT",
      compact: "COMPACT",
      translationRequest: { mode: "collaborative", source: "甲乙" },
    }),
  });
  assert.equal(kept, true);
  assert.equal(flow.llm.calls.length, 2);
  assert.equal(flow.llm.calls[0].config.model, "draft-m");
  assert.equal(flow.llm.calls[1].config.model, "review-m");
  assert.ok(flow.llm.calls[0].messages.at(-1).content.includes("甲译"));
  assert.ok(flow.llm.calls[1].messages.at(-1).content.includes("甲乙"));
  assert.ok(flow.llm.calls[1].messages.at(-1).content.includes("DRAFT"));
  const answer = flow.store.commits[0].answer;
  assert.equal(answer.content, "FINAL");
  same(answer.translation, {
    mode: "collaborative",
    source: "甲乙",
    status: "reviewed",
    draft: "DRAFT",
    translator: "draft-m",
    reviewer: "review-m",
  });
}

{
  // An incomplete draft is kept as incomplete and never reviewed.
  const flow = await loadRunner();
  flow.llm.queue.push({ text: "DRAFT", incomplete: "max tokens" });
  const kept = await flow.runner.ask({
    target,
    display: "display",
    build: async () => ({
      prompt: "PROMPT",
      compact: "COMPACT",
      translationRequest: { mode: "collaborative", source: "甲乙" },
    }),
  });
  assert.equal(kept, true);
  assert.equal(flow.llm.calls.length, 1, "no review after an incomplete draft");
  const answer = flow.store.commits[0].answer;
  assert.equal(answer.translation.status, "incomplete");
  assert.equal(answer.translation.reviewer, undefined);
  assert.equal(answer.translation.draft, undefined);
}

{
  // A stopped review keeps the complete draft and never claims a review.
  const flow = await loadRunner();
  flow.llm.queue.push({ text: "DRAFT" }, { text: "", aborted: true });
  const kept = await flow.runner.ask({
    target,
    display: "display",
    build: async () => ({
      prompt: "PROMPT",
      compact: "COMPACT",
      translationRequest: { mode: "collaborative", source: "甲乙" },
    }),
  });
  assert.equal(kept, true);
  assert.equal(flow.llm.calls.length, 2);
  const answer = flow.store.commits[0].answer;
  assert.equal(answer.content, "DRAFT");
  assert.equal(answer.translation.status, "stopped");
  assert.equal(answer.translation.warning, "translation-review-stopped");
  assert.equal(answer.translation.reviewer, "review-m");
}

{
  // A review that never passes the completeness marker keeps the draft.
  const flow = await loadRunner();
  flow.llm.queue.push(
    { text: "DRAFT" },
    { text: "partial" },
    { text: "partial again" },
  );
  const kept = await flow.runner.ask({
    target,
    display: "display",
    build: async () => ({
      prompt: "PROMPT",
      compact: "COMPACT",
      translationRequest: { mode: "collaborative", source: "甲" },
    }),
  });
  assert.equal(kept, true);
  assert.equal(flow.llm.calls.length, 3, "the failed review is retried once");
  const answer = flow.store.commits[0].answer;
  assert.equal(answer.content, "DRAFT");
  assert.equal(answer.translation.status, "review-failed");
  assert.equal(answer.translation.warning, "translation-review-failed");
}

{
  // Quick paragraph translation keeps the old single-model path: one request
  // per verified piece and no review call.
  const flow = await loadRunner({
    terms: [{ source: "甲", target: "甲译" }],
  });
  flow.llm.queue.push({ text: "T1 " + END }, { text: "T2 " + END });
  const kept = await flow.runner.ask({
    target,
    display: "display",
    build: async () => ({
      prompt: "quick prompt",
      compact: "quick prompt",
      translation: {
        source: longSource,
        promptFor: async (piece) => "translate:" + piece,
      },
      translationRequest: { mode: "quick", source: longSource },
    }),
  });
  assert.equal(kept, true);
  assert.equal(flow.llm.calls.length, 2, "one request per piece, no review");
  assert.equal(flow.glossaryMock.stats().snapshots, 1);
  const answer = flow.store.commits[0].answer;
  assert.equal(answer.content, "T1\n\nT2");
  assert.equal(answer.translation.mode, "quick");
  assert.equal(answer.translation.status, "draft");
  assert.equal(answer.translation.translator, "chat-m");
  same(flow.store.stages, []);
}

{
  // Ordinary chat is untouched: no glossary snapshot, no translation metadata.
  const flow = await loadRunner({ terms: [{ source: "甲", target: "甲译" }] });
  flow.llm.queue.push({ text: "ANSWER" });
  const kept = await flow.runner.ask({
    target,
    display: "question",
    build: async () => ({ prompt: "question", compact: "question" }),
  });
  assert.equal(kept, true);
  assert.equal(flow.llm.calls.length, 1);
  assert.equal(flow.glossaryMock.stats().snapshots, 0);
  assert.equal(flow.llm.calls[0].messages.at(-1).content, "question");
  const answer = flow.store.commits[0].answer;
  assert.equal(answer.content, "ANSWER");
  assert.equal(answer.translation, undefined);
}

{
  // Reviewing a committed translation appends a new answer.
  const flow = await loadRunner({
    terms: [{ source: "原", target: "原译" }],
    turns: [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: "旧译文",
        translation: {
          mode: "quick",
          source: "原文内容",
          status: "draft",
          translator: "chat-m",
        },
      },
    ],
  });
  flow.llm.queue.push({ text: "新译文 " + END });
  const kept = await flow.runner.reviewTranslation({
    target,
    sessionId: "s1",
    turnIndex: 1,
  });
  assert.equal(kept, true);
  assert.equal(flow.llm.calls.length, 1, "review is a single request");
  assert.equal(flow.llm.calls[0].config.model, "review-m");
  const prompt = flow.llm.calls[0].messages.at(-1).content;
  assert.ok(prompt.includes("原文内容"));
  assert.ok(prompt.includes("旧译文"));
  assert.ok(prompt.includes("原译"));
  same(flow.store.stages, ["reviewing"]);
  assert.equal(flow.store.commits.length, 1);
  const { user, answer } = flow.store.commits[0];
  assert.equal(user.content, "translation-review-title");
  assert.equal(answer.content, "新译文");
  same(answer.translation, {
    mode: "review",
    source: "原文内容",
    status: "reviewed",
    draft: "旧译文",
    translator: "chat-m",
    reviewer: "review-m",
  });
  assert.equal(flow.store.session.turns[1].content, "旧译文");
}

for (const turns of [
  [
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: "旧译文",
      translation: {
        mode: "quick",
        source: "原文",
        status: "draft",
        sourceTruncated: true,
      },
    },
  ],
  [
    { role: "user", content: "question" },
    { role: "assistant", content: "旧译文" },
  ],
]) {
  // Truncated or missing metadata is refused without calling any model.
  const flow = await loadRunner({ turns });
  const kept = await flow.runner.reviewTranslation({
    target,
    sessionId: "s1",
    turnIndex: 1,
  });
  assert.equal(kept, false);
  assert.equal(flow.llm.calls.length, 0);
  same(flow.store.failures, ["translation-source-unavailable"]);
  assert.equal(flow.store.commits.length, 0);
}

{
  // A failed review request is logged and never loses the draft.
  const flow = await loadRunner();
  flow.llm.queue.push({ text: "DRAFT" }, () => {
    throw new Error("HTTP 500");
  });
  const kept = await flow.runner.ask({
    target,
    display: "display",
    build: async () => ({
      prompt: "PROMPT",
      compact: "COMPACT",
      translationRequest: { mode: "collaborative", source: "甲" },
    }),
  });
  assert.equal(kept, true);
  assert.equal(
    flow.store.commits[0].answer.translation.status,
    "review-failed",
  );
  assert.ok(
    flow.logs.some((args) => String(args[0]).includes("review request failed")),
    "a review request error must reach the log",
  );
}

{
  // A damaged glossary is optional context: translations still run without it.
  const flow = await loadRunner({ glossaryFails: true });
  flow.llm.queue.push({ text: "T1 " + END }, { text: "T2 " + END });
  const kept = await flow.runner.ask({
    target,
    display: "display",
    build: async () => ({
      prompt: "quick prompt",
      compact: "quick prompt",
      translation: {
        source: longSource,
        promptFor: async (piece) => "translate:" + piece,
      },
      translationRequest: { mode: "quick", source: longSource },
    }),
  });
  assert.equal(kept, true, "a broken glossary must not fail the translation");
  assert.equal(flow.llm.calls.length, 2);
  assert.ok(!flow.llm.calls[0].messages.at(-1).content.includes("术语表"));
  assert.ok(
    flow.logs.some((args) => String(args[0]).includes("glossary unavailable")),
  );
  assert.equal(flow.store.failures.length, 0);
}

{
  // The same is true for on-demand review.
  const flow = await loadRunner({
    glossaryFails: true,
    turns: [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: "旧译文",
        translation: { mode: "quick", source: "原文内容", status: "draft" },
      },
    ],
  });
  flow.llm.queue.push({ text: "新译文 " + END });
  const kept = await flow.runner.reviewTranslation({
    target,
    sessionId: "s1",
    turnIndex: 1,
  });
  assert.equal(kept, true, "a broken glossary must not block a review");
  assert.equal(flow.llm.calls.length, 1);
  assert.ok(
    flow.logs.some((args) => String(args[0]).includes("glossary unavailable")),
  );
}

console.log(
  "Glossary and translation: matching, persistence/failure retention, snapshots, profile resolution, prompt injection, request counts, draft/review transitions and refusal paths passed (in-memory mocks, no live Zotero or API)",
);

/* global console, setTimeout, URL */
// Targeted checks for the board data layer and its store. The shipped
// modules run under in-memory paths and a mock stream: no user profile,
// no files outside memory, no network and no live Zotero.
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

const boardUtils = await load("src/utils/board.ts");
const {
  BOARD_LIMIT,
  BOARD_SOURCE_LIMIT,
  BOARD_TRANSLATION_LIMIT,
  boardDedupeKey,
  boardEntryKey,
  isBoardFull,
  makeBoardEntry,
  parseBoard,
  serializeBoard,
} = boardUtils;

const ITEM = "1/ITEM0001";

function boardInput(overrides = {}) {
  return {
    id: "id000001",
    addedAt: "2026-10-19T08:12:00.000Z",
    itemKey: ITEM,
    itemTitle: "Paper One",
    mode: "quick",
    status: "draft",
    source: "source text",
    translation: "译文",
    ...overrides,
  };
}

function dedupeInput(overrides = {}) {
  return { itemKey: ITEM, mode: "quick", translation: "译文", ...overrides };
}

// ---- pure board data: limits, dedupe key, entry validation, truncation

assert.equal(BOARD_LIMIT, 50);
assert.equal(BOARD_SOURCE_LIMIT, 10000);
assert.equal(BOARD_TRANSLATION_LIMIT, 20000);

const key = boardDedupeKey(dedupeInput());
assert.equal(key, boardDedupeKey(dedupeInput()), "keys are stable");
assert.equal(key.split("\u0000").length, 3, "the fields are separated");
assert.ok(key.includes(ITEM));
assert.notEqual(key, boardDedupeKey(dedupeInput({ itemKey: "1/ITEM0002" })));
assert.notEqual(key, boardDedupeKey(dedupeInput({ mode: "review" })));
assert.notEqual(
  key,
  boardDedupeKey(dedupeInput({ translation: "另一个译文" })),
);
assert.equal(
  boardDedupeKey(
    dedupeInput({ translation: "x".repeat(BOARD_TRANSLATION_LIMIT) }),
  ),
  boardDedupeKey(
    dedupeInput({ translation: "x".repeat(BOARD_TRANSLATION_LIMIT + 100) }),
  ),
  "the stored and the original long translation share one key",
);
same(
  boardEntryKey({
    itemKey: ITEM,
    mode: "quick",
    translation: "译文",
  }),
  key,
);

const entry = makeBoardEntry(boardInput());
assert.ok(entry, "a complete input builds an entry");
assert.equal(entry.id, "id000001");
assert.equal(entry.addedAt, "2026-10-19T08:12:00.000Z");
assert.equal(entry.itemKey, ITEM);
assert.equal(entry.itemTitle, "Paper One");
assert.equal(entry.mode, "quick");
assert.equal(entry.status, "draft");
assert.equal(entry.source, "source text");
assert.equal(entry.translation, "译文");
assert.equal(entry.sourceTruncated, undefined);
assert.equal(entry.translationTruncated, undefined);
assert.equal(
  makeBoardEntry(boardInput({ addedAt: "2026-10-19T16:12:00+08:00" })).addedAt,
  "2026-10-19T08:12:00.000Z",
  "timestamps are normalized to ISO",
);
assert.equal(
  makeBoardEntry(boardInput({ itemTitle: "  A\n B\t C  " })).itemTitle,
  "A B C",
  "the title snapshot has its whitespace collapsed",
);
assert.equal(
  makeBoardEntry(
    boardInput({ translator: "  model-a ", reviewer: " model-b " }),
  ).translator,
  "model-a",
);
assert.equal(
  "translator" in makeBoardEntry(boardInput({ translator: "  " })),
  false,
);
assert.equal("reviewer" in makeBoardEntry(boardInput({ reviewer: "" })), false);
assert.equal(
  makeBoardEntry(boardInput({ itemTitle: "T".repeat(2000) })).itemTitle.length,
  500,
  "an oversized title is clipped, not rejected",
);

for (const patch of [
  { id: "" },
  { id: "has space" },
  { id: 7 },
  { addedAt: "not a date" },
  { addedAt: "" },
  { addedAt: 7 },
  { itemKey: "no-slash" },
  { itemKey: "1/" },
  { itemKey: "x/ITEM0001" },
  { itemTitle: 7 },
  { mode: "bogus" },
  { status: "done" },
  { source: 7 },
  { translation: "   " },
  { translation: 7 },
  { sourceTruncated: "yes" },
  { translationTruncated: "yes" },
  { translator: 7 },
  { reviewer: 7 },
]) {
  assert.equal(
    makeBoardEntry(boardInput(patch)),
    undefined,
    "invalid field is rejected: " + JSON.stringify(patch),
  );
}

const longSource = "s".repeat(BOARD_SOURCE_LIMIT + 1);
const longTranslation = "t".repeat(BOARD_TRANSLATION_LIMIT + 1);
const clipped = makeBoardEntry(
  boardInput({ source: longSource, translation: longTranslation }),
);
assert.equal(clipped.source.length, BOARD_SOURCE_LIMIT);
assert.equal(clipped.sourceTruncated, true);
assert.equal(clipped.translation.length, BOARD_TRANSLATION_LIMIT);
assert.equal(clipped.translationTruncated, true);
const exact = makeBoardEntry(
  boardInput({
    source: "s".repeat(BOARD_SOURCE_LIMIT),
    translation: "t".repeat(BOARD_TRANSLATION_LIMIT),
  }),
);
assert.equal(
  exact.sourceTruncated,
  undefined,
  "the limit itself is not clipped",
);
assert.equal(exact.translationTruncated, undefined);
const flagged = makeBoardEntry(
  boardInput({ sourceTruncated: true, translationTruncated: true }),
);
assert.equal(
  flagged.sourceTruncated,
  true,
  "an explicit truncation flag is kept",
);
assert.equal(flagged.translationTruncated, true);

// ---- pure board data: serialization, parsing, damaged data, limits

const second = makeBoardEntry(
  boardInput({ id: "id000002", translation: "第二段", mode: "review" }),
);
const text = serializeBoard([entry, second]);
const file = JSON.parse(text);
assert.equal(file.version, 1);
assert.equal(file.entries.length, 2);
same(
  parseBoard(text),
  [plain(entry), plain(second)],
  "a round trip keeps order",
);
same(parseBoard('{"version":1,"entries":[]}'), []);
assert.equal(parseBoard("not json"), undefined);
assert.equal(parseBoard(""), undefined);
assert.equal(parseBoard("null"), undefined);
assert.equal(parseBoard("[]"), undefined);
assert.equal(parseBoard('{"version":2,"entries":[]}'), undefined);
assert.equal(parseBoard('{"version":1}'), undefined);
assert.equal(parseBoard('{"version":1,"entries":{}}'), undefined);
assert.equal(
  parseBoard('{"version":1,"entries":[{"id":"only-an-id"}]}'),
  undefined,
  "a partial entry is damaged",
);

const normalizedAt = parseBoard(
  JSON.stringify({
    version: 1,
    entries: [{ ...plain(entry), addedAt: "2026-10-19T16:12:00+08:00" }],
  }),
);
assert.equal(normalizedAt[0].addedAt, "2026-10-19T08:12:00.000Z");

const firstId = makeBoardEntry(boardInput({ id: "id000001" }));
const repeatedId = makeBoardEntry(
  boardInput({ id: "id000001", translation: "不同译文" }),
);
assert.equal(
  parseBoard(JSON.stringify({ version: 1, entries: [firstId, repeatedId] })),
  undefined,
  "a repeated id means the file cannot be trusted",
);

const sameAnswer = makeBoardEntry(
  boardInput({ id: "id000002", translation: "同一译文" }),
);
const sameAnswerAgain = makeBoardEntry(
  boardInput({ id: "id000003", translation: "同一译文" }),
);
const deduped = parseBoard(
  JSON.stringify({ version: 1, entries: [sameAnswer, sameAnswerAgain] }),
);
assert.equal(deduped.length, 1, "repeated answers are collapsed while reading");
assert.equal(deduped[0].id, "id000002", "the first copy in the file wins");

const overLimit = Array.from({ length: BOARD_LIMIT + 3 }, (_, index) =>
  makeBoardEntry(
    boardInput({
      id: "seed" + String(index).padStart(4, "0"),
      translation: "译文" + index,
    }),
  ),
);
const trimmed = parseBoard(JSON.stringify({ version: 1, entries: overLimit }));
assert.equal(
  trimmed.length,
  BOARD_LIMIT,
  "reads keep at most BOARD_LIMIT items",
);
assert.equal(trimmed[0].id, "seed0000");

const longStored = plain(entry);
longStored.source = "y".repeat(BOARD_SOURCE_LIMIT + 5);
longStored.translation = "z".repeat(BOARD_TRANSLATION_LIMIT + 5);
const longParsed = parseBoard(
  JSON.stringify({ version: 1, entries: [longStored] }),
);
assert.equal(longParsed[0].source.length, BOARD_SOURCE_LIMIT);
assert.equal(longParsed[0].sourceTruncated, true);
assert.equal(longParsed[0].translation.length, BOARD_TRANSLATION_LIMIT);
assert.equal(longParsed[0].translationTruncated, true);

assert.throws(() => serializeBoard([{ ...plain(entry), mode: "bogus" }]));
assert.throws(() =>
  serializeBoard(Array.from({ length: BOARD_LIMIT + 1 }, () => entry)),
);
assert.equal(isBoardFull([]), false);
assert.equal(
  isBoardFull(Array.from({ length: BOARD_LIMIT - 1 }, () => entry)),
  false,
);
assert.equal(
  isBoardFull(Array.from({ length: BOARD_LIMIT }, () => entry)),
  true,
);

// ---- store: in-memory io mock, one module instance per "app start"

function memoryStore() {
  return {
    files: new Map(),
    writes: [],
    dirs: [],
    reads: 0,
    inflight: 0,
    maxInflight: 0,
    failWrites: false,
    serial: 0,
    idLengths: [],
  };
}

async function loadStore(store) {
  const io = {
    exists: async (path) => store.files.has(path),
    readUTF8: async (path) => {
      store.reads++;
      return store.files.get(path);
    },
    writeUTF8: async (path, text, options) => {
      if (store.failWrites) throw new Error("disk full");
      store.inflight++;
      store.maxInflight = Math.max(store.maxInflight, store.inflight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        store.writes.push({ path, text, options });
        store.files.set(path, text);
      } finally {
        store.inflight--;
      }
    },
    makeDirectory: async (path) => {
      store.dirs.push(path);
    },
  };
  const module = await load(
    "src/modules/board.ts",
    {
      "../utils/locale": {
        getString: (key, options) =>
          options?.args ? key + ":" + String(options.args.count) : key,
      },
      "../utils/paths": {
        dataDir: () => "/data/glossa",
        io: () => io,
        paths: () => ({ join: (...parts) => parts.join("/") }),
      },
      "../utils/board": boardUtils,
    },
    {
      Zotero: {
        Utilities: {
          randomString: (length) => {
            store.idLengths.push(length);
            store.serial++;
            return "id" + String(store.serial).padStart(6, "0");
          },
        },
      },
      ztoolkit: { log() {} },
    },
  );
  return module.board;
}

function addInput(overrides = {}) {
  return {
    itemKey: ITEM,
    itemTitle: "Paper One",
    translation: { mode: "quick", status: "draft", source: "原文" },
    text: "译文",
    ...overrides,
  };
}

async function rejectsKey(promise, expected, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, expected, message);
    assert.equal(error.name, "BoardError", message);
    return true;
  });
}

const BOARD_PATH = "/data/glossa/board.json";

// ---- store: first load, add, duplicate, ordering, copies, remove, clear

{
  const disk = memoryStore();
  const store = await loadStore(disk);
  assert.equal(store.has(key), false, "has() is false before loading");
  same(store.list(), []);
  let notices = 0;
  const unsubscribe = store.subscribe(() => notices++);

  await store.ensureLoaded();
  same(store.list(), []);
  assert.equal(disk.reads, 0, "a missing file is not read");
  assert.equal(disk.writes.length, 0, "loading never writes");

  assert.equal(
    await store.add(
      addInput({
        translation: {
          mode: "quick",
          status: "draft",
          source: "原文一",
          translator: "model-a",
        },
        text: "译文一",
      }),
    ),
    "added",
  );
  assert.equal(notices, 1, "a successful add notifies subscribers");
  assert.equal(disk.writes.length, 1);
  assert.equal(disk.writes[0].path, BOARD_PATH);
  assert.equal(
    disk.writes[0].options.tmpPath,
    BOARD_PATH + ".tmp",
    "the write is atomic",
  );
  assert.equal(disk.dirs[0], "/data/glossa");
  assert.equal(disk.idLengths[0], 8, "ids use randomString(8)");
  const saved = JSON.parse(disk.files.get(BOARD_PATH));
  assert.equal(saved.version, 1);
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].translation, "译文一");
  assert.equal(saved.entries[0].itemTitle, "Paper One");
  assert.equal(saved.entries[0].mode, "quick");
  assert.equal(saved.entries[0].status, "draft");
  assert.equal(saved.entries[0].translator, "model-a");
  assert.equal(
    saved.entries[0].addedAt,
    new Date(saved.entries[0].addedAt).toISOString(),
    "addedAt is ISO",
  );
  assert.equal(saved.entries[0].id, store.list()[0].id);

  assert.equal(await store.add(addInput({ text: "译文二" })), "added");
  same(
    store.list().map((item) => item.translation),
    ["译文二", "译文一"],
    "newest entry comes first",
  );
  assert.equal(
    store.has(
      boardDedupeKey({ itemKey: ITEM, mode: "quick", translation: "译文一" }),
    ),
    true,
  );

  const copies = store.list();
  copies[0].translation = "mutated";
  copies.pop();
  same(
    store.list().map((item) => item.translation),
    ["译文二", "译文一"],
    "list() returns copies",
  );

  const writesBeforeDuplicate = disk.writes.length;
  assert.equal(
    await store.add(addInput({ text: "译文一", itemTitle: "另一个标题" })),
    "duplicate",
    "the same answer is refused without an error",
  );
  assert.equal(
    disk.writes.length,
    writesBeforeDuplicate,
    "a duplicate is never written",
  );
  assert.equal(notices, 2);

  const firstId = store.list()[1].id;
  await store.remove(firstId);
  same(
    store.list().map((item) => item.translation),
    ["译文二"],
  );
  same(
    JSON.parse(disk.files.get(BOARD_PATH)).entries.map(
      (item) => item.translation,
    ),
    ["译文二"],
    "remove persists the new list",
  );
  assert.equal(notices, 3);

  const writesBeforeMissing = disk.writes.length;
  await store.remove("never-there");
  assert.equal(
    disk.writes.length,
    writesBeforeMissing,
    "a missing id is a no-op",
  );
  assert.equal(notices, 3);

  await store.clear();
  same(store.list(), []);
  same(JSON.parse(disk.files.get(BOARD_PATH)).entries, []);
  assert.equal(notices, 4);
  const writesBeforeEmptyClear = disk.writes.length;
  await store.clear();
  assert.equal(disk.writes.length, writesBeforeEmptyClear);
  assert.equal(notices, 4, "clearing an empty board does nothing");

  unsubscribe();
  await store.add(addInput({ text: "悄悄加入" }));
  assert.equal(notices, 4, "unsubscribed listeners are not called again");

  // A fresh store reads the same file.
  const reloaded = await loadStore(disk);
  await reloaded.ensureLoaded();
  same(
    reloaded.list().map((item) => item.translation),
    ["悄悄加入"],
  );
}

// ---- store: add loads the file first and concurrent writes stay serialized

{
  const disk = memoryStore();
  disk.files.set(
    BOARD_PATH,
    serializeBoard([
      makeBoardEntry(boardInput({ id: "seed0000", translation: "旧译文" })),
    ]),
  );
  const store = await loadStore(disk);
  assert.equal(await store.add(addInput({ text: "新译文" })), "added");
  same(
    store.list().map((item) => item.translation),
    ["新译文", "旧译文"],
    "add loads an existing file before it changes anything",
  );
  assert.equal(JSON.parse(disk.files.get(BOARD_PATH)).entries.length, 2);
}
{
  const disk = memoryStore();
  const store = await loadStore(disk);
  const input = addInput({ text: "并发译文" });
  const results = await Promise.all([store.add(input), store.add(input)]);
  assert.deepEqual(results.sort(), ["added", "duplicate"]);
  assert.equal(store.list().length, 1, "concurrent duplicates add one entry");
  assert.equal(disk.writes.length, 1);

  await Promise.all([
    store.add(addInput({ text: "并发一" })),
    store.add(addInput({ text: "并发二" })),
    store.add(addInput({ text: "并发三" })),
  ]);
  assert.equal(store.list().length, 4);
  assert.equal(disk.maxInflight, 1, "writes are serialized through one queue");
  assert.equal(JSON.parse(disk.files.get(BOARD_PATH)).entries.length, 4);
}
{
  // A long translation and its stored prefix are the same answer.
  const disk = memoryStore();
  const store = await loadStore(disk);
  await store.add(addInput({ text: "x".repeat(BOARD_TRANSLATION_LIMIT + 10) }));
  assert.equal(
    await store.add(addInput({ text: "x".repeat(BOARD_TRANSLATION_LIMIT) })),
    "duplicate",
  );
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].translation.length, BOARD_TRANSLATION_LIMIT);
  assert.equal(store.list()[0].translationTruncated, true);
}

// ---- store: the 50 entry limit

{
  const disk = memoryStore();
  const seed = Array.from({ length: BOARD_LIMIT }, (_, index) =>
    makeBoardEntry(
      boardInput({
        id: "seed" + String(index).padStart(4, "0"),
        itemKey: "1/ITEM" + String(index).padStart(4, "0"),
        translation: "译文" + index,
      }),
    ),
  );
  disk.files.set(
    BOARD_PATH,
    JSON.stringify({ version: 1, entries: seed.map(plain) }),
  );
  const store = await loadStore(disk);
  await store.ensureLoaded();
  assert.equal(store.list().length, BOARD_LIMIT);

  const writesBeforeFull = disk.writes.length;
  await rejectsKey(
    store.add(addInput({ text: "第 51 条" })),
    "board-full:50",
    "the limit rejects an extra entry with the localized count",
  );
  assert.equal(
    disk.writes.length,
    writesBeforeFull,
    "a full board is not written",
  );
  assert.equal(store.list().length, BOARD_LIMIT);

  // A duplicate is still reported as a duplicate when the board is full.
  const existing = store.list()[0];
  assert.equal(
    await store.add({
      itemKey: existing.itemKey,
      itemTitle: existing.itemTitle,
      translation: {
        mode: existing.mode,
        status: existing.status,
        source: existing.source,
      },
      text: existing.translation,
    }),
    "duplicate",
  );

  await store.remove(existing.id);
  assert.equal(await store.add(addInput({ text: "补位" })), "added");
  assert.equal(store.list().length, BOARD_LIMIT);
  assert.equal(
    JSON.parse(disk.files.get(BOARD_PATH)).entries.length,
    BOARD_LIMIT,
  );
}

// ---- store: write and clear failures keep memory and the old file

{
  const disk = memoryStore();
  const store = await loadStore(disk);
  await store.add(addInput({ text: "保留" }));
  const fileBefore = disk.files.get(BOARD_PATH);
  const listBefore = plain(store.list());
  let notices = 0;
  store.subscribe(() => notices++);
  const writesBefore = disk.writes.length;

  disk.failWrites = true;
  await rejectsKey(store.add(addInput({ text: "新内容" })), "board-save-error");
  same(store.list(), listBefore, "a failed add leaves memory unchanged");
  assert.equal(
    disk.files.get(BOARD_PATH),
    fileBefore,
    "a failed add leaves the file unchanged",
  );

  await rejectsKey(store.remove(store.list()[0].id), "board-save-error");
  same(store.list(), listBefore, "a failed remove leaves memory unchanged");
  assert.equal(disk.files.get(BOARD_PATH), fileBefore);

  await rejectsKey(store.clear(), "board-clear-error");
  same(store.list(), listBefore, "a failed clear leaves memory unchanged");
  assert.equal(disk.files.get(BOARD_PATH), fileBefore);
  assert.equal(notices, 0, "failed writes never notify subscribers");
  assert.equal(disk.writes.length, writesBefore);

  disk.failWrites = false;
  assert.equal(await store.add(addInput({ text: "重试成功" })), "added");
  assert.equal(store.list().length, 2);
  assert.equal(notices, 1);
  assert.equal(JSON.parse(disk.files.get(BOARD_PATH)).entries.length, 2);
}

// ---- store: unusable input is refused before any write

{
  const disk = memoryStore();
  const store = await loadStore(disk);
  await store.ensureLoaded();
  const writesBefore = disk.writes.length;
  for (const input of [
    addInput({ text: "" }),
    addInput({ text: "   " }),
    addInput({ itemKey: "no-slash" }),
    addInput({ itemTitle: undefined }),
    addInput({
      translation: {
        mode: "bogus",
        status: "draft",
        source: "原文",
      },
    }),
    addInput({
      translation: {
        mode: "quick",
        status: "bogus",
        source: "原文",
      },
    }),
  ]) {
    await rejectsKey(store.add(input), "board-invalid");
  }
  assert.equal(
    disk.writes.length,
    writesBefore,
    "nothing invalid reaches the file",
  );
  same(store.list(), []);
}

// ---- store: a damaged file is reported and never overwritten

{
  const disk = memoryStore();
  disk.files.set(BOARD_PATH, "{broken");
  const store = await loadStore(disk);
  let notices = 0;
  store.subscribe(() => notices++);
  await rejectsKey(store.ensureLoaded(), "board-load-error");
  await rejectsKey(
    store.ensureLoaded(),
    "board-load-error",
    "a broken board stays rejected after the first attempt",
  );
  await rejectsKey(store.add(addInput()), "board-load-error");
  await rejectsKey(store.remove("whatever"), "board-load-error");
  await rejectsKey(store.clear(), "board-load-error");
  assert.equal(disk.files.get(BOARD_PATH), "{broken");
  assert.equal(disk.writes.length, 0, "a damaged file is never overwritten");
  assert.equal(notices, 0);
  assert.equal(store.has(key), false);
}

{
  const damaged = [
    JSON.stringify({
      version: 1,
      entries: [plain(entry), plain(entry)],
    }),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: "id000001",
          addedAt: "2026-10-19T08:12:00.000Z",
          itemKey: ITEM,
          itemTitle: "",
          mode: "quick",
          status: "draft",
          source: "",
          translation: "   ",
        },
      ],
    }),
    JSON.stringify({
      version: 1,
      entries: [{ ...plain(entry), mode: "bogus" }],
    }),
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: {} }),
    JSON.stringify({ version: 1, entries: [null] }),
    JSON.stringify({ version: 1, entries: [[]] }),
  ];
  for (const raw of damaged) {
    const disk = memoryStore();
    disk.files.set(BOARD_PATH, raw);
    const store = await loadStore(disk);
    await rejectsKey(
      store.ensureLoaded(),
      "board-load-error",
      "damaged content is refused: " + raw.slice(0, 40),
    );
    assert.equal(disk.files.get(BOARD_PATH), raw);
    assert.equal(disk.writes.length, 0);
  }
}

// ---- store: dedupe while reading, listener isolation, one read per load

{
  const first = makeBoardEntry(
    boardInput({ id: "id000001", translation: "同一译文" }),
  );
  const second = makeBoardEntry(
    boardInput({ id: "id000002", translation: "同一译文" }),
  );
  const disk = memoryStore();
  disk.files.set(
    BOARD_PATH,
    JSON.stringify({ version: 1, entries: [plain(first), plain(second)] }),
  );
  const store = await loadStore(disk);
  await store.ensureLoaded();
  assert.equal(store.list().length, 1, "dedupe also happens on load");
  assert.equal(store.list()[0].id, "id000001");
}
{
  const disk = memoryStore();
  const store = await loadStore(disk);
  let notices = 0;
  store.subscribe(() => {
    throw new Error("listener boom");
  });
  store.subscribe(() => notices++);
  assert.equal(await store.add(addInput()), "added");
  assert.equal(notices, 1, "a broken listener does not stop the others");
}
{
  const disk = memoryStore();
  disk.files.set(BOARD_PATH, JSON.stringify({ version: 1, entries: [] }));
  const store = await loadStore(disk);
  await Promise.all([store.ensureLoaded(), store.ensureLoaded()]);
  assert.equal(disk.reads, 1, "concurrent loads share one read");
  await store.ensureLoaded();
  assert.equal(disk.reads, 1, "a loaded store is not read again");
}

console.log(
  "Board: dedupe keys, entry validation/truncation, parse/serialize, hard limits, first load, add/duplicate/remove/clear, copies and ordering, serialized concurrent writes, write-failure retention, damaged-file protection and subscriptions passed (in-memory mocks, no live Zotero or API)",
);

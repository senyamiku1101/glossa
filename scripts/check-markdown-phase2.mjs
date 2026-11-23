/* global URL, setTimeout, clearTimeout, TextDecoder, console */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
async function load(path, imports = {}) {
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
    require: (n) => imports[n] || {},
    setTimeout,
    clearTimeout,
    URL,
    TextDecoder,
    console,
  });
  return module.exports;
}
const types = await load("src/modules/markdownPrep/types.ts");
const meta = await load("src/modules/markdownPrep/meta.ts", {
  "./types": types,
});
const store = await load("src/modules/markdownPrep/store.ts", {
  "./types": types,
  "./meta": meta,
  "./journal": { isSafeRelativePath: (p) => !p.includes("..") },
});
for (const name of [
  "paper.pdf",
  "CON.pdf",
  'a<>:"|?*.pdf',
  "x".repeat(100) + ".pdf",
  "...pdf",
  "",
  "中 文.pdf",
]) {
  const safe = store.safeMarkdownFilename(name);
  assert(safe.length <= 64);
  assert(safe.endsWith(".md"));
  assert(!/[<>:"/\\|?*]/.test(safe));
  assert(!/^(con|prn|aux|nul)\./i.test(safe));
}
assert.equal(store.safeMarkdownFilename(""), "glossa-body.md");
const resources = [
  { relativePath: "images/foo.PNG", bytes: new Uint8Array([1, 2, 3]) },
];
const token = store.hostedAssetToken({ bodySha1: "test" }, resources);
assert.match(token, /^[0-9a-f]{16}$/);
const files = store.planBundleAssetFiles(token, resources);
const filename = files.get("images/foo.PNG");
assert.match(filename, /^glossa-asset-[0-9a-f]{16}-0\.png$/);
assert.equal(
  store.applyBundleAssetLinks("![](images/foo.PNG)", files),
  "![](" + filename + ")",
);
const queue = await load("src/modules/markdownPrep/queue.ts", {
  "./settings": { endpointHost: (v) => new URL(v).host },
});
for (const provider of ["paddleocr-cloud", "mineru-cloud"]) {
  const settings = {
    provider,
    cloud: { endpoint: "https://paddle.test/api", model: "paddle-model" },
    mineru: {
      endpoint: "https://mineru.test",
      modelVersion: "vlm",
      selfHosted: false,
    },
  };
  const remote = {
    provider: provider === "mineru-cloud" ? "mineru" : "paddleocr",
    host: provider === "mineru-cloud" ? "mineru.test" : "paddle.test",
    modelVersion: provider === "mineru-cloud" ? "vlm" : "paddle-model",
    jobId: "job-123",
  };
  const row = { status: "queued", detail: "resume-polling", remote };
  assert.equal(queue.resumeJobFor(row, settings), "job-123");
  for (const changed of [
    { provider: "other" },
    { host: "other.test" },
    { modelVersion: "other" },
    { modelVersion: undefined },
  ])
    assert.equal(
      queue.resumeJobFor(
        { ...row, remote: { ...remote, ...changed } },
        settings,
      ),
      undefined,
    );
  assert.equal(
    queue.resumeJobFor({ ...row, status: "done" }, settings),
    undefined,
  );
  assert.equal(
    queue.resumeJobFor({ ...row, detail: undefined }, settings),
    undefined,
  );
}
const context = await load("src/modules/context.ts");
const split = context.splitPreparedMarkdown(
  "<!-- glossa-body {} -->\n<!-- hidden\nsecret -->\n<!-- page 1 -->\nHello\n<!-- page 2 (printed iv) -->\nWorld",
);
assert(!split.body.includes("secret"));
assert(!split.body.includes("<!--"));
assert.equal(split.sections[0].label, "1");
assert.equal(split.sections[1].label, "iv");
assert.equal(
  context.rankByKeywords(
    ["引言与背景介绍", "本文提出一种边界层分离控制方法", "结论与展望"],
    "边界层分离是怎么控制的？",
    1,
  )[0],
  "本文提出一种边界层分离控制方法",
);
assert.equal(
  context.rankByKeywords(
    [
      "The main experiment uses wind tunnels.",
      "Unsteady CFD simulations resolve the tip vortex.",
    ],
    "CFD simulation",
    1,
  )[0],
  "Unsteady CFD simulations resolve the tip vortex.",
);
assert.equal(
  context.rankByKeywords(
    ["The main domain is large.", "An AI model predicts stall."],
    "AI",
    1,
  )[0],
  "An AI model predicts stall.",
);
console.log(
  "Phase 2 pure checks passed: safe filenames, flat asset links, both provider resumptions, clean page-labelled AI text.",
);
assert.equal(
  store.applyBundleAssetLinks('![](images/foo.PNG "caption")', files),
  "![](" + filename + ' "caption")',
);
{
  const memText = new Map();
  const memBytes = new Map();
  const journal = await load("src/modules/markdownPrep/journal.ts", {
    "./types": types,
    "../../utils/paths": {
      bodyCacheDir: () => "D:\\Zotero\\glossa\\body\\cache",
      bodyQueueFile: () => "D:\\Zotero\\glossa\\body\\queue.json",
      paths: () => ({
        join: (base, ...parts) => {
          for (const part of parts) {
            if (/[\\/]/.test(part) || part === "..") {
              throw new Error(`Invalid PathUtils.join segment: ${part}`);
            }
          }
          return [base, ...parts].join("\\");
        },
        parent: (p) => {
          const idx = p.lastIndexOf("\\");
          return idx > 0 ? p.slice(0, idx) : undefined;
        },
      }),
      io: () => ({
        remove: async () => {},
        makeDirectory: async () => {},
        writeUTF8: async (p, v) => {
          memText.set(p, v);
        },
        write: async (p, v) => {
          memBytes.set(p, v);
        },
        readUTF8: async (p) => {
          if (!memText.has(p)) throw new Error("ENOENT");
          return memText.get(p);
        },
        read: async (p) => {
          if (!memBytes.has(p)) throw new Error("ENOENT");
          return memBytes.get(p);
        },
      }),
    },
  });
  await journal.writeCacheEntry(
    {
      meta: {
        v: 1,
        sourceKey: "K",
        md5: "abc",
        size: 10,
        mtime: 1,
        pageCount: 1,
        parser: "paddleocr-cloud",
        converterVersion: "2",
        configVersion: "cfg",
        status: "done",
        quality: "high",
        generatedAt: "2026-11-18T00:00:00Z",
        assetMode: "relative",
        bodySha1: "sha",
      },
      markdown: "# Title\n\n![](images/foo.png)",
      blocks: [],
      resources: [
        {
          relativePath: "images/foo.png",
          mime: "image/png",
          bytes: new Uint8Array([7, 8, 9]),
        },
      ],
    },
    "entry-1",
  );
  const loaded = await journal.loadCacheEntry("entry-1");
  assert(loaded);
  assert.equal(loaded.resources.length, 1);
  assert.equal(loaded.resources[0].relativePath, "images/foo.png");
}

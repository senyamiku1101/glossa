/**
 * Runtime-free checks for the Paddle-only body contract.
 *
 * Loads the real TypeScript sources (transpiled to CommonJS) so the checks
 * cannot drift from shipped code. No Zotero globals are touched: only
 * types/sources/quality/meta/assets/paddleConvert are imported.
 */
/* global console, process, URL */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const cache = new Map();
const root = new URL("../", import.meta.url);

function load(path) {
  const key = normalize(path);
  if (cache.has(key)) return cache.get(key).exports;
  const source = readFileSync(new URL(key, root), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  cache.set(key, module);
  const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : ".";
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    console,
    Date,
    require: (id) => {
      if (!id.startsWith(".")) throw new Error(`unsupported import ${id}`);
      return load(join(dir, id));
    },
  });
  return module.exports;
}

function join(dir, id) {
  const parts = `${dir}/${id}`.split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/") + ".ts";
}

function normalize(path) {
  return path.replace(/^\.\//, "");
}

const asserts = [];
function assert(name, condition) {
  asserts.push({ name, ok: Boolean(condition) });
  if (!condition) console.error("FAIL", name);
}
function equal(name, actual, expected) {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error("  actual:", JSON.stringify(actual));
    console.error("  expected:", JSON.stringify(expected));
  }
}

const types = load("src/modules/markdownPrep/types.ts");
const sources = load("src/modules/markdownPrep/sources.ts");
const quality = load("src/modules/markdownPrep/quality.ts");
const meta = load("src/modules/markdownPrep/meta.ts");
const assets = load("src/modules/markdownPrep/assets.ts");
const paddle = load("src/modules/markdownPrep/paddleConvert.ts");

// ---- types / cache key ----
assert("single parser id", types.PARSER_IDS.length === 2);
assert("parser id value", types.PARSER_IDS[0] === "paddleocr-cloud");
assert(
  "no obsolete authorization state",
  !types.PREP_STATUSES.includes("waiting-consent"),
);
assert(
  "statuses include waiting-config",
  types.PREP_STATUSES.includes("waiting-config"),
);
assert(
  "stableHash changes with config",
  types.stableHash("paddleocr-cloud|PP-StructureV3|a") !==
    types.stableHash("paddleocr-cloud|PP-StructureV3|b"),
);

// ---- source registry ----
const source = {
  id: "paddleocr-cloud",
  label: "PaddleOCR cloud",
  isRemote: () => true,
  available: async () => true,
  parse: async () => ({
    ok: false,
    status: "failed",
    reason: "internal-error",
  }),
};
sources.registerBodySource(source);
assert(
  "registry registers",
  sources.getBodySource("paddleocr-cloud") === source,
);
assert("registry lists", sources.listBodySources().length === 1);
sources.resetBodySources();
assert("registry resets", sources.listBodySources().length === 0);

// ---- meta ----
equal(
  "sha1 known vector",
  meta.bodySha1("abc"),
  "a9993e364706816aba3e25717850c26c9cd0d89d",
);
const hostedMeta = {
  v: 1,
  sourceKey: "PDFKEY01",
  parentKey: "ITEMKEY1",
  md5: "md5hex",
  size: 42,
  mtime: 1700000000000,
  pageCount: 3,
  parser: "paddleocr-cloud",
  modelVersion: "PP-StructureV3",
  converterVersion: "1",
  configVersion: "cfg",
  status: "done",
  quality: "high",
  generatedAt: "2026-11-16T00:00:00.000Z",
  assetMode: "relative",
  bodySha1: "abc",
};
const serialized = meta.serializeBodyMeta(hostedMeta);
assert("meta prefix", serialized.startsWith("<!-- glossa-body {"));
assert("meta first line only", serialized.split("\n").length === 2);
equal("meta roundtrip", meta.parseBodyMeta(serialized + "# Body"), hostedMeta);
assert(
  "bad meta is tolerated",
  meta.parseBodyMeta("no meta here") === undefined,
);
assert(
  "malformed meta is tolerated",
  meta.parseBodyMeta("<!-- glossa-body {oops} -->") === undefined,
);
assert(
  "fingerprint matches",
  meta.fingerprintMatches(
    { md5: "a", size: 1, mtime: 2 },
    { md5: "a", size: 1, mtime: 2 },
  ),
);
assert(
  "fingerprint change detected",
  !meta.fingerprintMatches(
    { md5: "a", size: 1, mtime: 2 },
    { md5: "b", size: 1, mtime: 2 },
  ),
);

// ---- assets ----
const jpeg = Uint8Array.from([1, 2, 3, 4]);
const assetBody = (markdown, assetsList) => ({
  markdown,
  assets: assetsList,
  blocks: [],
  source: {
    attachmentKey: "K",
    libraryID: 1,
    filename: "x.pdf",
    md5: "m",
    size: 1,
    mtime: 1,
    pageCount: 1,
  },
  parserId: "paddleocr-cloud",
  converterVersion: "1",
  quality: {
    level: "medium",
    textLayer: "ocr",
    structure: "full",
    tables: "none",
    equations: "none",
    images: "embedded",
    caveats: [],
  },
  warnings: [],
  generatedAt: "2026-11-16T00:00:00.000Z",
});
const plan = assets.planHostedBody(
  assetBody("![Fig](images/a.jpg)", [
    {
      kind: "figure",
      filename: "images/a.jpg",
      mime: "image/jpeg",
      bytes: jpeg,
    },
  ]),
);
equal("asset resolved", plan.resolved, 1);
equal("asset resource path", plan.resources[0].relativePath, "images/a.jpg");
equal("asset link kept", plan.markdown.includes("![Fig](images/a.jpg)"), true);
const missing = assets.planHostedBody(
  assetBody("![Fig](images/missing.jpg)", []),
);
equal("missing asset placeholder", missing.placeholders, 1);
assert("missing asset caveat", missing.warnings.includes("asset-missing"));
assert("no dangling link", !missing.markdown.includes("](images/missing.jpg)"));
const traversal = assets.planHostedBody(assetBody("![x](../secret.png)", []));
assert("path traversal placeholder", traversal.placeholders === 1);
assert(
  "safe path rejects dotdot",
  assets.safeRelativePath("../a.png") === undefined,
);

// ---- Paddle JSONL conversion ----
const fixture = readFileSync(
  new URL("test/fixtures/markdown-prep/paddle-basic.jsonl", root),
  "utf8",
);
const sourceFingerprint = {
  attachmentKey: "PDFKEY01",
  parentKey: "ITEMKEY1",
  libraryID: 1,
  filename: "paper.pdf",
  md5: "0123456789abcdef0123456789abcdef",
  size: 1234,
  mtime: 1700000000000,
  pageCount: 2,
};
const downloaded = [
  {
    kind: "figure",
    pageIndex: 0,
    filename: "images/a.jpg",
    mime: "image/jpeg",
    bytes: jpeg,
  },
  {
    kind: "figure",
    pageIndex: 1,
    filename: "images/b.jpg",
    mime: "image/jpeg",
    bytes: Uint8Array.from([5, 6, 7]),
  },
];
const converted = paddle.convertPaddleJsonl({
  jsonl: fixture,
  source: sourceFingerprint,
  model: "PP-StructureV3",
  assets: downloaded,
});
assert("parser id", converted.body.parserId === "paddleocr-cloud");
assert("model version", converted.body.processorVersion === "PP-StructureV3");
assert("page count", converted.body.source.pageCount === 2);
assert("page comments", converted.body.markdown.includes("<!-- page 1"));
assert(
  "body keeps references-like text",
  converted.body.markdown.includes("Results"),
);
assert(
  "blocks have pages",
  converted.body.blocks.every((block) => block.pageIndex >= 0),
);
assert(
  "blocks keep bbox when available",
  converted.body.blocks.some((block) => Array.isArray(block.pageRects)),
);
equal("downloaded assets kept", converted.body.assets.length, 2);
assert(
  "URL payload not decoded as base64",
  !converted.body.assets.some((asset) => asset.filename.includes("p001-")),
);
assert(
  "downloaded filenames kept",
  converted.body.assets.some((asset) => asset.filename === "images/b.jpg"),
);
assert(
  "HTML img converted to Markdown",
  converted.body.markdown.includes("![fig b](images/b.jpg)"),
);
equal("table preserved flag", converted.body.quality.tables, "preserved");
equal("equation latex flag", converted.body.quality.equations, "latex");
equal("preserved structure is done", converted.judgement.status, "done");
equal("preserved structure level high", converted.body.quality.level, "high");
assert("ocr text layer", converted.body.quality.textLayer === "ocr");

const lostTable = quality.judgeQuality({
  parserId: "paddleocr-cloud",
  textChars: 1200,
  totalPages: 2,
  parsedPages: 2,
  emptyPages: 0,
  unverifiedBlockPages: 0,
  structuralPages: 1,
  hasTableBlocks: true,
  hasEquationBlocks: false,
  tablesPreserved: false,
  equationsLatex: false,
  hasImages: false,
  assetsDeclared: 0,
  assetsResolved: 0,
  truncated: false,
});
equal("flattened table stays done", lostTable.status, "done");
equal("flattened table level medium", lostTable.quality.level, "medium");
assert(
  "flattened table caveat",
  lostTable.quality.caveats.includes("table-cells-unverified"),
);

const hosted = assets.planHostedBody(converted.body);
assert("converted asset embedded", hosted.resolved >= 1);
assert(
  "converted asset resource exists",
  hosted.resources.some((resource) => resource.relativePath === "images/b.jpg"),
);

// Same basename on two pages must not overwrite each other.
const collision = paddle.convertPaddleJsonl({
  jsonl:
    '{"result":{"layoutParsingResults":[{"markdown":{"text":"Page one short body."}},{"markdown":{"text":"Page two short body."}}]}}',
  source: { ...sourceFingerprint, pageCount: 2 },
  model: "PP-StructureV3",
  assets: [
    {
      kind: "figure",
      pageIndex: 0,
      filename: "images/fig.jpg",
      mime: "image/jpeg",
      bytes: jpeg,
    },
    {
      kind: "figure",
      pageIndex: 1,
      filename: "images/fig.jpg",
      mime: "image/jpeg",
      bytes: Uint8Array.from([9, 9]),
    },
  ],
});
const collisionNames = collision.body.assets.map((asset) => asset.filename);
equal("collision assets kept unique", new Set(collisionNames).size, 2);
assert(
  "collision does not claim missing",
  !collision.body.warnings.includes("asset-missing"),
);

// HTML img in planHostedBody is materialized even if converter did not rewrite it.
const htmlPlan = assets.planHostedBody(
  assetBody('<div><img src="images/c.jpg" alt="c"></div>', [
    {
      kind: "figure",
      filename: "images/c.jpg",
      mime: "image/jpeg",
      bytes: jpeg,
    },
  ]),
);
equal("HTML img resource", htmlPlan.resources.length, 1);
assert(
  "HTML img becomes Markdown",
  htmlPlan.markdown.includes("![c](images/c.jpg)"),
);

// Active HTML must not reach the hosted body.
const unsafe = paddle.convertPaddleJsonl({
  jsonl: JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text: '<script>alert(1)</script><img src="javascript:alert(2)" onerror="x()">Body text that is long enough to be a legal short note.',
          },
        },
      ],
    },
  }),
  source: { ...sourceFingerprint, pageCount: 1 },
  model: "PP-StructureV3",
});
assert("script stripped", !/script/i.test(unsafe.body.markdown));
assert("event handler stripped", !/onerror/i.test(unsafe.body.markdown));
assert("javascript URL stripped", !/javascript:/i.test(unsafe.body.markdown));

// A missing per-page image must become a placeholder, not another page's image.
const unresolved = paddle.convertPaddleJsonl({
  jsonl: JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text:
              "Body text with a missing figure. " +
              "Enough prose for the short document gate. ".repeat(6) +
              '<div><img src="imgs/missing.jpg" alt="missing"></div>',
          },
        },
      ],
    },
  }),
  source: { ...sourceFingerprint, pageCount: 1 },
  model: "PP-StructureV3",
});
assert(
  "missing ref placeholder",
  unresolved.body.markdown.includes("[Image: missing]"),
);
assert(
  "missing ref not left dangling",
  !unresolved.body.markdown.includes("imgs/missing.jpg"),
);
assert(
  "missing ref caveat",
  unresolved.body.warnings.includes("asset-missing"),
);
assert("missing ref partial", unresolved.judgement.status === "partial");

// More active HTML hardening: unquoted JS URLs, meta/link tags, data:text/html.
const hardened = paddle.convertPaddleJsonl({
  jsonl: JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text:
              '<meta http-equiv="refresh" content="0;url=javascript:alert(1)"><link rel="x" href="javascript:alert(2)">' +
              '<a href=javascript:alert(3)>x</a><img src="data:text/html;base64,PHNjcmlwdD4=">' +
              "Body text long enough to satisfy the legal short document gate.",
          },
        },
      ],
    },
  }),
  source: { ...sourceFingerprint, pageCount: 1 },
  model: "PP-StructureV3",
});
assert("meta/link stripped", !/<(?:meta|link)\b/i.test(hardened.body.markdown));
assert(
  "unquoted javascript stripped",
  !/javascript:/i.test(hardened.body.markdown),
);
assert(
  "data text/html stripped",
  !/data:text\/html/i.test(hardened.body.markdown),
);

// Four-page corrigendum/short abstract: 150 chars is legal, done + low.
const shortFour = quality.judgeQuality({
  parserId: "paddleocr-cloud",
  textChars: 150,
  totalPages: 4,
  parsedPages: 4,
  emptyPages: 0,
  unverifiedBlockPages: 0,
  structuralPages: 0,
  tablesPreserved: false,
  equationsLatex: false,
  hasImages: false,
  assetsDeclared: 0,
  assetsResolved: 0,
  truncated: false,
});
equal("four-page short doc is done", shortFour.status, "done");
equal("four-page short doc is low", shortFour.quality.level, "low");

// Unknown PDF page count is honestly partial, not done with unverified order.
const unknownOrder = paddle.convertPaddleJsonl({
  jsonl: JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text:
              "# Page\n\n" + "Prose for page order verification. ".repeat(6),
          },
        },
      ],
    },
  }),
  source: { ...sourceFingerprint, pageCount: 0 },
  model: "PP-StructureV3",
});
assert(
  "unknown page count caveat",
  unknownOrder.body.warnings.includes("page-order-unverified"),
);
assert(
  "unknown page count partial",
  unknownOrder.judgement.status === "partial",
);

// Short legal document: non-empty one-pager must not be rejected by length.
const shortDoc = quality.judgeQuality({
  parserId: "paddleocr-cloud",
  textChars: 40,
  totalPages: 1,
  parsedPages: 1,
  emptyPages: 0,
  unverifiedBlockPages: 0,
  structuralPages: 0,
  tablesPreserved: false,
  equationsLatex: false,
  hasImages: false,
  assetsDeclared: 0,
  assetsResolved: 0,
  truncated: false,
});
equal("short doc is done", shortDoc.status, "done");
equal("short doc is low", shortDoc.quality.level, "low");
const emptyShort = quality.judgeQuality({
  parserId: "paddleocr-cloud",
  textChars: 0,
  totalPages: 1,
  parsedPages: 1,
  emptyPages: 1,
  unverifiedBlockPages: 0,
  structuralPages: 0,
  tablesPreserved: false,
  equationsLatex: false,
  hasImages: false,
  assetsDeclared: 0,
  assetsResolved: 0,
  truncated: false,
});
equal("empty short doc needs parser", emptyShort.status, "needs-parser");

// Provider returning fewer pages than the PDF is partial, never done.
const truncated = paddle.convertPaddleJsonl({
  jsonl: JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text:
              "# Only page\n\n" +
              "Enough prose for the short document gate. ".repeat(12),
          },
        },
      ],
    },
  }),
  source: { ...sourceFingerprint, pageCount: 0 },
  model: "PP-StructureV3",
  expectedPages: 4,
});
assert(
  "fewer pages than PDF is partial",
  truncated.judgement.status === "partial",
);
assert("truncated caveat", truncated.body.warnings.includes("partial-pages"));

const empty = paddle.convertPaddleJsonl({
  jsonl: '{"result":{"layoutParsingResults":[{"markdown":{"text":""}}]}}',
  source: { ...sourceFingerprint, pageCount: 1 },
  model: "PP-StructureV3",
});
equal("empty output needs parser", empty.judgement.status, "needs-parser");
equal("empty output reason", empty.judgement.reason, "paddle-no-output");

const missingPage = paddle.convertPaddleJsonl({
  jsonl: JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text: "# Page one\n\nThis page contains enough prose for the quality gate and for retrieval. This page contains enough prose for the quality gate and for retrieval. This page contains enough prose for the quality gate and for retrieval. This page contains enough prose for the quality gate and for retrieval. This page contains enough prose for the quality gate and for retrieval. ",
          },
        },
        {
          markdown: {
            text: "# Page two\n\nThis page contains enough prose for the quality gate and for retrieval. This page contains enough prose for the quality gate and for retrieval. This page contains enough prose for the quality gate and for retrieval. This page contains enough prose for the quality gate and for retrieval. This page contains enough prose for the quality gate and for retrieval. ",
          },
        },
      ],
    },
  }),
  source: { ...sourceFingerprint, pageCount: 4 },
  model: "PP-StructureV3",
});
assert("missing pages are partial", missingPage.judgement.status === "partial");
assert(
  "missing pages caveat",
  missingPage.body.quality.caveats.includes("partial-pages"),
);

// ---- quality gate ----
const high = quality.judgeQuality({
  parserId: "paddleocr-cloud",
  textChars: 5000,
  totalPages: 10,
  parsedPages: 10,
  emptyPages: 0,
  unverifiedBlockPages: 0,
  structuralPages: 0,
  tablesPreserved: false,
  equationsLatex: false,
  hasImages: false,
  assetsDeclared: 0,
  assetsResolved: 0,
  truncated: false,
});
equal("clean output done", high.status, "done");
equal("clean output high", high.quality.level, "high");
const noText = quality.judgeQuality({
  parserId: "paddleocr-cloud",
  textChars: 10,
  totalPages: 10,
  parsedPages: 10,
  emptyPages: 10,
  unverifiedBlockPages: 0,
  structuralPages: 0,
  tablesPreserved: false,
  equationsLatex: false,
  hasImages: false,
  assetsDeclared: 0,
  assetsResolved: 0,
  truncated: false,
});
equal("short text is usable", noText.status, "done");

const repeated = assets.planHostedBody({
  ...converted.body,
  markdown: "![](images/repeated.png) ![](images/repeated.png)",
  assets: [
    {
      filename: "images/repeated.png",
      mime: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      kind: "figure",
    },
  ],
});
assert(
  "duplicate image resources are reused",
  repeated.resources.length === 1 &&
    repeated.placeholders === 0 &&
    repeated.markdown.split("](images/repeated.png)").length === 3,
);
const htmlNames = paddle.convertPaddleJsonl({
  jsonl: JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text: 'A paragraph <img src="figure + (1).png"> <img src=plain+1.png>',
          },
        },
      ],
    },
  }),
  source: { ...sourceFingerprint, pageCount: 1 },
  model: "PP-StructureV3",
  assets: [
    {
      filename: "images/figure + (1).png",
      mime: "image/png",
      bytes: new Uint8Array([1]),
      kind: "figure",
    },
    {
      filename: "images/plain+1.png",
      mime: "image/png",
      bytes: new Uint8Array([1]),
      kind: "figure",
    },
  ],
});
assert(
  "quoted and unquoted img references preserve readable filenames",
  htmlNames.body.markdown.includes("images/figure + (1).png") &&
    htmlNames.body.markdown.includes("images/plain+1.png") &&
    !htmlNames.body.markdown.includes("[Image:"),
);
const htmlHosted = assets.planHostedBody(htmlNames.body);
assert(
  "readable filenames survive hosted planning",
  htmlHosted.resources.length === 2 && htmlHosted.placeholders === 0,
);
const failures = asserts.filter((item) => !item.ok);
console.log(
  `${asserts.length - failures.length}/${asserts.length} checks passed`,
);
if (failures.length) process.exitCode = 1;

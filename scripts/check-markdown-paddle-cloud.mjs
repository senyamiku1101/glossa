/* global console, URL, TextEncoder, TextDecoder, setInterval, clearInterval, setTimeout, clearTimeout */
/**
 * Contract checks for the PaddleOCR cloud source (task D).
 *
 * All network traffic is a local in-memory mock transport: no real request, no
 * token, no PDF upload, no user profile. The shipped TypeScript modules are
 * transpiled and loaded exactly like the other `scripts/check-*.mjs` suites.
 */
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
    URL,
    TextEncoder,
    TextDecoder,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto,
    Zotero: {},
    ztoolkit: { log() {} },
    ...globals,
  });
  return module.exports;
}

const types = await load("src/modules/markdownPrep/types.ts");
const quality = await load("src/modules/markdownPrep/quality.ts", {
  "./types": types,
});
const assetsModule = await load("src/modules/markdownPrep/assets.ts", {
  "./types": types,
});
const convert = await load("src/modules/markdownPrep/paddleConvert.ts", {
  "./types": types,
  "./quality": quality,
  "./assets": assetsModule,
});
const paddleAssets = await load("src/modules/markdownPrep/paddleAssets.ts", {
  "./types": types,
});

const ENDPOINT = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const HOST = "paddleocr.aistudio-app.com";
const PDF = new TextEncoder().encode("%PDF-1.7\nmock pdf bytes\n");

const config = {
  endpoint: ENDPOINT,
  model: "PP-StructureV3",
};

let registered = 0;
const paddle = await load("src/modules/markdownPrep/paddle.ts", {
  "./types": types,
  "./sources": {
    registerBodySource() {
      registered += 1;
    },
  },
  "./paddleConvert": convert,
  "./settings": {
    readSettings: () => ({ cloud: config }),
    readPaddleToken: () => "test-token",
  },
  "./paddleAssets": paddleAssets,
  "../../utils/paths": { io: () => ({ read: async () => PDF }) },
});

const {
  buildMultipartBody,
  hostedImageFilename,
  isSafeHttpsUrl,
  planImageResources,
  assertUploadablePdf,
  PaddlePayloadError,
  LOCAL_MAX_UPLOAD_BYTES,
} = paddleAssets;
const {
  initPaddleCloud,
  testPaddleConnection,
  runPaddleBodyForTests,
  resumePaddleBody,
} = paddle;

const plain = (value) => JSON.parse(JSON.stringify(value));
const source = {
  attachmentKey: "ATTACH01",
  parentKey: "ITEM01",
  libraryID: 1,
  filename: "paper.pdf",
  md5: "0123456789abcdef0123456789abcdef",
  size: PDF.byteLength,
  mtime: 1700000000000,
  pageCount: 2,
};
const input = {
  attachment: { id: 1 },
  pdfPath: "/tmp/paper.pdf",
  fingerprint: source,
};
const options = (overrides = {}) => ({
  apiKey: "test-token",
  isCancelled: () => false,
  ...overrides,
});

const LONG =
  "The boundary layer ingesting ducted fan was measured in a wind tunnel and " +
  "the aeroacoustic response was analysed across several thrust regimes. ";
const pageMarkdown = (heading, anchor) =>
  `# ${heading}\n\n${LONG}${LONG}\n\n` +
  `<div style="text-align: center;"><img src="imgs/${anchor}.jpg" /></div>` +
  `\n\nSee $x^2$ for the model.\n`;
const page = (heading, anchor) => ({
  markdown: {
    text: pageMarkdown(heading, anchor),
    images: { [`imgs/${anchor}.jpg`]: `https://cdn.example/${anchor}.jpg` },
  },
  prunedResult: {
    parsing_res_list: [
      {
        block_label: "title",
        block_content: heading,
        block_bbox: [10, 10, 300, 40],
      },
      {
        block_label: "text",
        block_content: LONG,
        block_bbox: [10, 60, 900, 200],
      },
    ],
  },
});
const jsonl = `${JSON.stringify({
  result: {
    dataInfo: {
      pages: [
        { width: 1000, height: 1400 },
        { width: 1000, height: 1400 },
      ],
    },
    layoutParsingResults: [page("Title", "img_1"), page("Section", "img_2")],
  },
})}\n`;

const ENVELOPE = (jobId) =>
  JSON.stringify({ code: 0, msg: "ok", data: { jobId } });
const statusBody = (data) => JSON.stringify({ code: 0, msg: "ok", data });
const doneBody = (jsonUrl) =>
  statusBody({ state: "done", resultUrl: { jsonUrl } });
const pendingBody = (pages = 2) =>
  statusBody({
    state: "running",
    extractProgress: { extractedPages: 1, totalPages: pages },
  });
const pngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const arrayBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

function mockTransport(steps) {
  const calls = [];
  const queue = [...steps];
  return {
    calls,
    async request(request) {
      calls.push({
        method: request.method,
        url: request.url,
        headers: request.headers || {},
        body: request.body,
        responseType: request.responseType,
      });
      const step = queue.shift();
      assert.ok(
        step,
        "unexpected request " + request.method + " " + request.url,
      );
      return step(request, calls);
    },
  };
}

function failAfter(transport, index) {
  return transport.calls[index] || { headers: {}, method: "?", url: "?" };
}

// ---- 1. multipart body: fields, filename, boundary, no token ---------------

const multipart = buildMultipartBody(
  [
    { name: "model", value: "PP-StructureV3" },
    { name: "optionalPayload", value: '{"returnMarkdownImages":true}' },
  ],
  { filename: "paper.pdf", mime: "application/pdf", bytes: PDF },
);
const boundary = multipart.contentType.split("boundary=")[1];
assert.ok(boundary.length > 8);
const multipartText = new TextDecoder().decode(multipart.body);
assert.match(multipartText, /Content-Disposition: form-data; name="model"/);
assert.match(multipartText, /name="file"; filename="paper\.pdf"/);
assert.match(multipartText, /Content-Type: application\/pdf/);
assert.ok(multipartText.includes('{"returnMarkdownImages":true}'));
assert.ok(multipartText.endsWith(`--${boundary}--\r\n`));
assert.ok(!multipartText.includes("Bearer"));
assert.ok(!multipartText.includes("test-token"));
// PDF bytes survive byte-for-byte.
const pdfOffset = multipart.body.indexOf(PDF[0]);
assert.ok(pdfOffset > 0);
assert.deepEqual(
  Array.from(multipart.body.slice(pdfOffset, pdfOffset + PDF.byteLength)),
  Array.from(PDF),
);

// ---- 2. path/URL safety ---------------------------------------------------

assert.equal(hostedImageFilename("imgs/img_x.jpg"), "images/img_x.jpg");
assert.equal(hostedImageFilename("../../etc/passwd.jpg"), "images/passwd.jpg");
assert.equal(hostedImageFilename("imgs/a.svg"), undefined);
assert.equal(hostedImageFilename("javascript:alert(1)"), undefined);
assert.equal(isSafeHttpsUrl("https://cdn.example/img.jpg"), true);
assert.equal(isSafeHttpsUrl("http://cdn.example/img.jpg"), false);
assert.equal(isSafeHttpsUrl("https://localhost/img.jpg"), false);
assert.equal(isSafeHttpsUrl("https://127.0.0.1/img.jpg"), false);
assert.equal(isSafeHttpsUrl("https://user:pass@cdn.example/img.jpg"), false);
assert.equal(isSafeHttpsUrl("file:///etc/passwd"), false);

// ---- 3. image resource plan ----------------------------------------------

const plan = planImageResources(jsonl);
assert.equal(plan.declared, 2);
assert.deepEqual(
  plain([...plan.resources.map((resource) => resource.filename)].sort()),
  ["images/img_1.jpg", "images/img_2.jpg"],
);
assert.deepEqual(
  plain([...plan.resources.map((resource) => resource.pageIndex)]),
  [0, 1],
);
assert.equal(plan.warnings.length, 0);
const unsafePlan = planImageResources(
  JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text: "x",
            images: {
              "imgs/a.jpg": "https://127.0.0.1/a.jpg",
              "imgs/b.svg": "https://cdn.example/b.svg",
            },
          },
        },
      ],
    },
  }),
);
assert.equal(unsafePlan.resources.length, 0);
assert.ok(unsafePlan.warnings.includes("asset-missing"));

// Cross-page same basename: second page gets a page prefix and keeps pageIndex.
const collisionPlan = planImageResources(
  JSON.stringify({
    result: {
      layoutParsingResults: [
        {
          markdown: {
            text: "first",
            images: { "imgs/fig.jpg": "https://cdn.example/a.jpg" },
          },
        },
        {
          markdown: {
            text: "second",
            images: { "imgs/fig.jpg": "https://cdn.example/b.jpg" },
          },
        },
      ],
    },
  }),
);
assert.deepEqual(
  plain(collisionPlan.resources.map((r) => [r.filename, r.pageIndex])),
  [
    ["images/fig.jpg", 0],
    ["images/p002-fig.jpg", 1],
  ],
);

// Local size guard is a Glossa cap and names itself as such.
assert.throws(
  () => assertUploadablePdf({ byteLength: LOCAL_MAX_UPLOAD_BYTES + 1 }),
  (error) =>
    error instanceof PaddlePayloadError && error.reason === "paddle-too-large",
);
assert.throws(
  () => assertUploadablePdf(new TextEncoder().encode("not a pdf")),
  (error) =>
    error instanceof PaddlePayloadError &&
    error.reason === "paddle-unsupported-pdf",
);
assert.doesNotThrow(() => assertUploadablePdf(PDF));

// ---- 4. init is idempotent and registration is the only side effect -------

await initPaddleCloud();
await initPaddleCloud();
assert.equal(registered, 1);
assert.equal(paddle.paddleSource.id, "paddleocr-cloud");
assert.equal(paddle.paddleSource.isRemote(), true);

// ---- 5. authorization guards must not touch the network -------------------

const zero = mockTransport([]);
let outcome = await runPaddleBodyForTests(input, options({ apiKey: "" }), {
  transport: zero,
  config,
  readPdf: async () => PDF,
});
assert.deepEqual(plain(outcome), {
  ok: false,
  status: "waiting-config",
  reason: "paddle-not-configured",
  detail: "no-token",
});
assert.equal(zero.calls.length, 0);

outcome = await runPaddleBodyForTests(input, options(), {
  transport: zero,
  config: {
    ...config,
    endpoint: "http://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
  },
  readPdf: async () => PDF,
});
assert.equal(outcome.status, "waiting-config");
assert.equal(zero.calls.length, 0);

// ---- 6. full mock job: submit -> poll -> JSONL -> images ------------------

{
  const transport = mockTransport([
    () => ({ status: 200, body: ENVELOPE("job-1") }),
    () => ({ status: 200, body: pendingBody() }),
    () => ({ status: 200, body: doneBody("https://cdn.example/result.jsonl") }),
    () => ({ status: 200, body: jsonl }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
  ]);
  const progress = [];
  const submitted = [];
  const result = await runPaddleBodyForTests(
    input,
    options({
      onProgress: (event) => progress.push(event.stage),
      onSubmitted: (remote) => submitted.push(remote),
    }),
    {
      transport,
      config,
      readPdf: async () => PDF,
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "done");
  assert.equal(result.body.remote.provider, "paddleocr");
  assert.equal(result.body.remote.host, HOST);
  assert.equal(result.body.remote.jobId, "job-1");
  assert.equal(result.body.remote.modelVersion, "PP-StructureV3");
  assert.ok(result.body.remote.uploadedAt > 0);
  assert.match(result.body.markdown, /<!-- page 1/);
  assert.match(result.body.markdown, /<!-- page 2/);
  assert.match(result.body.markdown, /images\/img_1\.jpg/);
  assert.deepEqual(
    plain(
      [...result.body.assets.map((asset) => asset.filename)]
        .filter((name) => name.startsWith("images/"))
        .sort(),
    ),
    ["images/img_1.jpg", "images/img_2.jpg"],
  );
  assert.ok(result.body.blocks.length > 0);
  // The hosted layer must be able to materialize every image: the converter
  // turns provider HTML <img> into Markdown and points at the downloaded asset.
  const hosted = assetsModule.planHostedBody(result.body);
  assert.equal(hosted.resources.length, 2);
  assert.ok(!/<img\b/i.test(hosted.markdown));
  assert.match(hosted.markdown, /!\[[^\]]*\]\(images\/img_1\.jpg\)/);
  assert.ok(progress.includes("uploading"));
  assert.ok(progress.includes("polling"));
  assert.ok(progress.includes("downloading"));
  assert.ok(progress.includes("converting"));

  // Token only reaches the API host. Result/image downloads are unauthenticated.
  const submit = failAfter(transport, 0);
  const poll = failAfter(transport, 1);
  assert.equal(submit.headers.Authorization, "Bearer test-token");
  assert.equal(poll.headers.Authorization, "Bearer test-token");
  for (const call of transport.calls.slice(3)) {
    assert.equal(call.headers.Authorization, undefined, call.url);
  }
  assert.ok(!transport.calls[3].url.includes("test-token"));
  assert.ok(
    transport.calls
      .slice(3)
      .every((call) => call.url.startsWith("https://cdn.example/")),
  );
  // The submit body is multipart and never contains the token.
  const submitBody = new TextDecoder().decode(submit.body);
  assert.ok(submitBody.includes('name="file"'));
  assert.ok(!submitBody.includes("test-token"));
  // No page cap by default: the whole PDF is submitted, never first-N pages.
  assert.ok(!submitBody.includes('name="pageRanges"'));
  // The queue must learn the job id before polling so a restart can resume.
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].jobId, "job-1");
  assert.equal(submitted[0].provider, "paddleocr");
}

// ---- 6b. page cap, missing pages, image magic, resume --------------------

// Explicit user pageRanges becomes a partial result (never a silent default).
{
  const transport = mockTransport([
    () => ({ status: 200, body: ENVELOPE("job-cap") }),
    () => ({ status: 200, body: doneBody("https://cdn.example/result.jsonl") }),
    () => ({ status: 200, body: jsonl }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
  ]);
  const result = await runPaddleBodyForTests(
    input,
    options({ pageRanges: "1-1" }),
    {
      transport,
      config,
      readPdf: async () => PDF,
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "partial");
  assert.ok(result.body.quality.caveats.includes("truncated-pages"));
  const body = new TextDecoder().decode(failAfter(transport, 0).body);
  assert.match(body, /name="pageRanges"[\s\S]*1-1/);
}

// The real PDF has 3 pages but the service returned 2: partial, not done.
{
  const transport = mockTransport([
    () => ({ status: 200, body: ENVELOPE("job-short") }),
    () => ({ status: 200, body: doneBody("https://cdn.example/result.jsonl") }),
    () => ({ status: 200, body: jsonl }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
  ]);
  const result = await runPaddleBodyForTests(
    { ...input, fingerprint: { ...source, pageCount: 3 } },
    options(),
    {
      transport,
      config,
      readPdf: async () => PDF,
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "partial");
  assert.ok(result.body.quality.caveats.includes("partial-pages"));
}

// Page count missing from the queue fingerprint: use Zotero's cached count,
// then write it into body.source.pageCount for the hosted metadata.
{
  const transport = mockTransport([
    () => ({ status: 200, body: ENVELOPE("job-count") }),
    () => ({ status: 200, body: doneBody("https://cdn.example/result.jsonl") }),
    () => ({ status: 200, body: jsonl }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
  ]);
  const result = await runPaddleBodyForTests(
    { ...input, fingerprint: { ...source, pageCount: 0 } },
    options(),
    {
      transport,
      config,
      readPdf: async () => PDF,
      pageCount: async () => 5,
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "partial");
  assert.equal(result.body.source.pageCount, 5);
  assert.ok(result.body.quality.caveats.includes("partial-pages"));
}

// A 200 HTML error page must never count as an image.
{
  const html = new TextEncoder().encode("<html>expired token</html>");
  const transport = mockTransport([
    () => ({ status: 200, body: ENVELOPE("job-html") }),
    () => ({ status: 200, body: doneBody("https://cdn.example/result.jsonl") }),
    () => ({ status: 200, body: jsonl }),
    () => ({ status: 200, body: arrayBuffer(html) }),
    () => ({ status: 200, body: arrayBuffer(html) }),
  ]);
  const result = await runPaddleBodyForTests(input, options(), {
    transport,
    config,
    readPdf: async () => PDF,
    sleep: async () => {},
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "partial");
  assert.equal(
    result.body.assets.filter((asset) => asset.filename.startsWith("images/"))
      .length,
    0,
  );
  assert.ok(
    result.body.quality.caveats.includes("asset-missing") ||
      result.body.quality.caveats.includes("image-placeholder"),
  );
}

// A bearer request must not follow a redirect to another host.
{
  const transport = mockTransport([
    () => ({
      status: 200,
      body: ENVELOPE("job-redirect"),
      finalUrl: "https://evil.example/jobs",
    }),
  ]);
  const result = await runPaddleBodyForTests(input, options(), {
    transport,
    config,
    readPdf: async () => PDF,
    sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "paddle-network");
  assert.equal(transport.calls.length, 1);
}

// Resume an existing job: no second submit/upload; queue may keep old remote.
{
  const transport = mockTransport([
    () => ({ status: 200, body: pendingBody() }),
    () => ({ status: 200, body: doneBody("https://cdn.example/result.jsonl") }),
    () => ({ status: 200, body: jsonl }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
  ]);
  let submitted = 0;
  const result = await resumePaddleBody(
    input,
    options({
      onSubmitted: () => {
        submitted += 1;
      },
    }),
    "job-resume",
    {
      transport,
      config,
      readPdf: async () => {
        throw new Error("resume must not read/upload the PDF");
      },
      sleep: async () => {},
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.body.remote.jobId, "job-resume");
  // Resume does not know the original upload time; the queue keeps it.
  assert.equal(result.body.remote.uploadedAt, 0);
  assert.equal(submitted, 0, "resume must not re-register a submit");
  assert.equal(transport.calls[0].method, "GET");
  assert.match(transport.calls[0].url, /\/job-resume$/);
  assert.equal(transport.calls.length, 5);
}

// A deployment that rejects optionalPayload gets exactly one retry without it.
{
  const transport = mockTransport([
    () => ({
      status: 400,
      body: JSON.stringify({ msg: "unknown field optionalPayload" }),
    }),
    () => ({ status: 200, body: ENVELOPE("job-retry") }),
    () => statusBody({ state: "failed", errorMsg: "stop after retry check" }),
  ]);
  const result = await runPaddleBodyForTests(input, options(), {
    transport,
    config,
    readPdf: async () => PDF,
    sleep: async () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(transport.calls.length, 3);
  const first = new TextDecoder().decode(transport.calls[0].body);
  const second = new TextDecoder().decode(transport.calls[1].body);
  assert.ok(first.includes('name="optionalPayload"'));
  assert.ok(!second.includes('name="optionalPayload"'));
  assert.ok(second.includes('name="model"'));
}

// ---- 7. errors map to the closed reason set ------------------------------

async function runWith(steps, overrides = {}, configOverride = config) {
  const transport = mockTransport(steps);
  const result = await runPaddleBodyForTests(input, options(overrides), {
    transport,
    config: configOverride,
    readPdf: async () => PDF,
    sleep: async () => {},
  });
  return { result, transport };
}

{
  const { result, transport } = await runWith([
    () => ({
      status: 401,
      body: JSON.stringify({ code: "A0202", msg: "bad token" }),
    }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "paddle-bad-token");
  assert.equal(transport.calls.length, 1);
}

{
  const { result } = await runWith([
    () => ({ status: 200, body: ENVELOPE("job-2") }),
    () => ({
      status: 200,
      body: statusBody({
        state: "failed",
        errorMsg: "file page count exceeds limit",
      }),
    }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    "paddle-too-large",
    JSON.stringify(plain(result)),
  );
}

{
  const { result } = await runWith([
    () => ({ status: 200, body: ENVELOPE("job-3") }),
    () => ({ status: 200, body: doneBody("https://cdn.example/empty.jsonl") }),
    () => ({ status: 200, body: "" }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "paddle-no-output");
}

{
  const { result } = await runWith([
    () => ({ status: 200, body: ENVELOPE("job-4") }),
    () => ({ status: 200, body: statusBody({ state: "teleporting" }) }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "paddle-invalid-output");
}

{
  const { result } = await runWith([
    () => ({ status: 200, body: ENVELOPE("job-5") }),
    () => ({
      status: 429,
      body: JSON.stringify({ code: "rate", msg: "too many" }),
    }),
    () => ({ status: 200, body: pendingBody() }),
    () => ({ status: 200, body: doneBody("https://cdn.example/result.jsonl") }),
    () => ({ status: 200, body: jsonl }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
    () => ({ status: 200, body: arrayBuffer(pngBytes) }),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "done");
}

// Missing images: the body is still produced but explicitly partial.
{
  const { result } = await runWith([
    () => ({ status: 200, body: ENVELOPE("job-6") }),
    () => ({ status: 200, body: doneBody("https://cdn.example/result.jsonl") }),
    () => ({ status: 200, body: jsonl }),
    () => ({ status: 404, body: "" }),
    () => ({ status: 404, body: "" }),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "partial");
  assert.equal(
    result.body.assets.filter((a) => a.filename.startsWith("images/")).length,
    0,
  );
  assert.ok(
    result.body.quality.caveats.includes("asset-missing") ||
      result.body.quality.caveats.includes("image-placeholder"),
  );
}

// ---- 8. cancellation stops before new requests ----------------------------

{
  const transport = mockTransport([]);
  const result = await runPaddleBodyForTests(
    input,
    options({ isCancelled: () => true }),
    { transport, config, readPdf: async () => PDF },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(transport.calls.length, 0);
}

{
  const transport = mockTransport([
    () => ({ status: 200, body: ENVELOPE("job-7") }),
    () => ({ status: 200, body: pendingBody() }),
  ]);
  let submitted = 0;
  const result = await runPaddleBodyForTests(
    input,
    options({ isCancelled: () => submitted >= 2 }),
    {
      transport,
      config,
      readPdf: async () => PDF,
      sleep: async () => {
        submitted = transport.calls.length;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.equal(transport.calls.length, 2);
}

// ---- 9. connectivity probe: zero upload, closed detail set ---------------

async function probe(step, token = "test-token") {
  const transport = mockTransport([step]);
  const result = await testPaddleConnection({
    transport,
    config,
    token,
  });
  return { result, transport };
}
assert.deepEqual(
  plain((await probe(() => ({ status: 404, body: "{}" }))).result),
  {
    ok: true,
    detail: "ok",
  },
);
assert.deepEqual(
  plain((await probe(() => ({ status: 400, body: "{}" }))).result),
  { ok: true, detail: "ok" },
);
assert.deepEqual(
  plain((await probe(() => ({ status: 401, body: "{}" }))).result),
  { ok: false, detail: "bad-token" },
);
assert.deepEqual(
  plain((await probe(() => ({ status: 429, body: "{}" }))).result),
  { ok: false, detail: "rate-limited" },
);
assert.deepEqual(
  plain((await probe(() => ({ status: 503, body: "{}" }))).result),
  { ok: false, detail: "api-error" },
);
// A 200 must be the API JSON envelope, not a proxy/login HTML page.
assert.deepEqual(
  plain(
    (
      await probe(() => ({
        status: 200,
        body: JSON.stringify({ code: 0, msg: "ok", data: {} }),
      }))
    ).result,
  ),
  { ok: true, detail: "ok" },
);
assert.deepEqual(
  plain(
    (await probe(() => ({ status: 200, body: "<html>login</html>" }))).result,
  ),
  { ok: false, detail: "bad-endpoint" },
);
assert.deepEqual(
  plain((await probe(() => ({ status: 302, body: "" }))).result),
  { ok: false, detail: "bad-endpoint" },
);
{
  const transport = mockTransport([
    () => {
      throw new Error("connection refused");
    },
  ]);
  assert.deepEqual(
    plain(await testPaddleConnection({ transport, config, token: "x" })),
    { ok: false, detail: "network" },
  );
}
assert.deepEqual(
  plain(
    await testPaddleConnection({
      transport: mockTransport([]),
      config,
      token: "",
    }),
  ),
  { ok: false, detail: "no-token" },
);
assert.deepEqual(
  plain(
    await testPaddleConnection({
      transport: mockTransport([]),
      config: { ...config, endpoint: "http://bad" },
      token: "x",
    }),
  ),
  { ok: false, detail: "bad-endpoint" },
);
{
  const { transport } = await probe(() => ({ status: 404, body: "{}" }));
  const call = failAfter(transport, 0);
  assert.equal(call.headers.Authorization, "Bearer test-token");
  assert.ok(call.url.includes("/api/v2/ocr/jobs/"));
  assert.ok(!call.url.includes("test-token"));
}

// ---- 10. request body: model + optionalPayload are camelCase -------------

{
  const transport = mockTransport([
    () => ({ status: 200, body: ENVELOPE("job-8") }),
    () => ({
      status: 200,
      body: statusBody({ state: "failed", errorMsg: "stop" }),
    }),
  ]);
  await runPaddleBodyForTests(input, options(), {
    transport,
    config,
    readPdf: async () => PDF,
    sleep: async () => {},
  });
  const body = new TextDecoder().decode(failAfter(transport, 0).body);
  assert.match(body, /name="model"[\s\S]*PP-StructureV3/);
  assert.match(body, /name="optionalPayload"/);
  assert.match(
    body,
    /useTableRecognition|useFormulaRecognition|returnMarkdownImages/,
  );
  assert.match(body, /name="file"; filename="paper\.pdf"/);
}

console.log("Paddle cloud protocol checks passed");
for (const model of ["PP-StructureV3", "PaddleOCR-VL-1.6"]) {
  const transport = mockTransport([
    () => ({ status: 200, body: ENVELOPE("flags") }),
    () => ({
      status: 200,
      body: statusBody({ state: "failed", errorMsg: "stop" }),
    }),
  ]);
  await runPaddleBodyForTests(input, options(), {
    transport,
    config: { ...config, model },
    readPdf: async () => PDF,
    sleep: async () => {},
  });
  const body = new TextDecoder().decode(transport.calls[0].body);
  for (const key of [
    "useChartRecognition",
    "useDocOrientationClassify",
    "useDocUnwarping",
  ])
    assert.match(body, new RegExp('"' + key + '":false'));
  assert.match(body, /"returnMarkdownImages":true/);
}

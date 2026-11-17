import { Buffer } from "node:buffer";
/* global URL, TextEncoder, TextDecoder, DecompressionStream, console, setTimeout */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { deflateRawSync } from "node:zlib";
import ts from "typescript";
async function load(path, imports = {}, globals = {}) {
  const { outputText } = ts.transpileModule(
    await readFile(new URL("../" + path, import.meta.url), "utf8"),
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
    require: (n) => {
      assert(n in imports, n);
      return imports[n];
    },
    URL,
    TextEncoder,
    TextDecoder,
    DecompressionStream,
    Uint8Array,
    ArrayBuffer,
    DataView,
    setTimeout,
    ...globals,
  });
  return module.exports;
}
const types = await load("src/modules/markdownPrep/types.ts");
const quality = await load("src/modules/markdownPrep/quality.ts", {
  "./types": types,
});
const assets = await load("src/modules/markdownPrep/paddleAssets.ts", {
  "./types": types,
});
const mineru = await load("src/modules/markdownPrep/mineru.ts", {
  "./types": types,
  "./quality": quality,
  "./settings": {},
  "./sources": {},
  "./paddleAssets": assets,
  "../../utils/paths": {},
});
function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function zip(name, body, method = 0, size = body.length) {
  const n = Buffer.from(name),
    data = method === 8 ? deflateRawSync(body) : body;
  const local = Buffer.alloc(30 + n.length + data.length);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc(body), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(n.length, 26);
  n.copy(local, 30);
  data.copy(local, 30 + n.length);
  const central = Buffer.alloc(46 + n.length);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc(body), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(n.length, 28);
  n.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return new Uint8Array(Buffer.concat([local, central, end]));
}
const body = Buffer.from("# Result\nA useful parsed paper body.");
for (const method of [0, 8]) {
  const entries = await mineru.readMineruZip(zip("full.md", body, method));
  assert.equal(new TextDecoder().decode(entries[0].bytes), body.toString());
}
for (const name of [
  "../full.md",
  "images/../../escape.png",
  "/absolute.md",
  "C:/evil.md",
  "images/..\\evil.png",
]) {
  assert(!mineru.zipPathIsSafe(name), name);
  await assert.rejects(() => mineru.readMineruZip(zip(name, body)));
}
await assert.rejects(
  () => mineru.readMineruZip(zip("full.md", body, 0, 65 * 1024 * 1024)),
  /limit/,
);
await assert.rejects(() => mineru.readMineruZip(new Uint8Array(10)), /size/);
await assert.rejects(
  () => mineru.readMineruZip({ byteLength: mineru.MAX_MINERU_ZIP_BYTES + 1 }),
  /size/,
);
const corrupt = zip("full.md", body);
corrupt[30 + "full.md".length] ^= 1;
await assert.rejects(() => mineru.readMineruZip(corrupt), /CRC|checksum/i);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const entries = [
  {
    name: "full.md",
    bytes: new TextEncoder().encode(
      "# Paper\nUseful content ![](./images/a.png)",
    ),
  },
  { name: "images/a.png", bytes: png },
];
const planned = mineru.mineruZipBody(entries);
assert.equal(planned.assets.length, 1);
assert(!planned.assets[0].filename.includes(".."));
assert(!planned.markdown.includes("](./images/"));
assert(planned.markdown.includes("](" + planned.assets[0].filename + ")"));
assert.throws(
  () => mineru.mineruZipBody([{ name: "../x", bytes: png }]),
  /Unsafe/,
);
const config = {
  endpoint: "https://mineru.net",
  modelVersion: "vlm",
  language: "en",
  isOcr: false,
  selfHosted: false,
};
const input = {
  pdfPath: "/mock.pdf",
  fingerprint: {
    attachmentKey: "PDFKEY01",
    filename: "paper.pdf",
    pageCount: 1,
    md5: "hash",
    size: 10,
    mtime: 1,
    libraryID: 1,
  },
};
const calls = [];
let submitted;
const responses = [
  {
    code: 0,
    data: { batch_id: "batch-1", file_urls: ["https://upload.example/file"] },
  },
  "",
  {
    code: 0,
    data: {
      extract_result: [
        {
          state: "done",
          full_zip_url: "https://result.example/body.zip",
          extract_progress: { total_pages: 1, extracted_pages: 1 },
        },
      ],
    },
  },
  new Uint8Array([1]),
];
const transport = {
  request: async (request) => {
    calls.push(request);
    const value = responses.shift();
    assert.notEqual(value, undefined);
    return {
      status: 200,
      body:
        typeof value === "object" && !(value instanceof Uint8Array)
          ? JSON.stringify(value)
          : value,
    };
  },
};
const result = await mineru.runMineruBodyForTests(
  input,
  { apiKey: "test-key", onSubmitted: (r) => (submitted = r) },
  {
    config,
    transport,
    readPdf: async () => new TextEncoder().encode("%PDF-1.7 mock"),
    sleep: async () => {},
    unzip: async () => entries,
  },
);
assert(result.ok, JSON.stringify(result));
assert.equal(result.body.parserId, "mineru-cloud");
assert.equal(submitted.jobId, "batch-1");
assert.equal(calls[0].method, "POST");
assert.equal(JSON.parse(calls[0].body).language, "en");
assert.equal(calls[1].method, "PUT");
assert(!calls[1].headers?.Authorization);
assert(
  !Object.keys(calls[1].headers || {}).some(
    (k) => k.toLowerCase() === "content-type",
  ),
);
assert(!calls[3].headers?.Authorization);
const resumed = [];
const resumedResult = await mineru.runMineruBodyForTests(
  input,
  { apiKey: "test-key", resumeJobId: "batch-1" },
  {
    config,
    transport: {
      request: async (r) => {
        resumed.push(r);
        return {
          status: 200,
          body: r.url.includes("extract-results")
            ? JSON.stringify({
                code: 0,
                data: {
                  extract_result: [
                    {
                      state: "done",
                      full_zip_url: "https://result.example/body.zip",
                    },
                  ],
                },
              })
            : new Uint8Array([1]),
        };
      },
    },
    readPdf: async () => {
      throw Error("must not upload");
    },
    unzip: async () => entries,
  },
);
assert(resumedResult.ok, JSON.stringify(resumedResult));
assert.equal(resumed.length, 2);
assert(resumed.every((r) => r.method === "GET"));
console.log(
  "MinerU checks passed: v4 submit/PUT/poll/download, resume without upload, credential isolation, stored/deflate ZIP, traversal, CRC, size limits, relative image rewriting.",
);
const mismatched = mineru.mineruZipBody([
  { name: "full.md", bytes: new TextEncoder().encode("![](images/a.jpg)") },
  { name: "images/a.jpg", bytes: png },
]);
assert.equal(mismatched.assets.length, 1);
assert.equal(mismatched.assets[0].mime, "image/png");
let raw;
class RawXHR {
  constructor() {
    raw = this;
    this.headers = {};
    this.channel = { QueryInterface: () => this.channel };
    this.status = 200;
    this.responseText = "";
  }
  open(method, url) {
    this.method = method;
    this.responseURL = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  send(body) {
    this.body = body;
    this.onload();
  }
  abort() {
    this.onabort();
  }
}
const rawModule = await load(
  "src/modules/markdownPrep/mineru.ts",
  {
    "./types": types,
    "./quality": quality,
    "./settings": {},
    "./sources": {},
    "./paddleAssets": assets,
    "../../utils/paths": {},
  },
  {
    ztoolkit: { getGlobal: () => RawXHR },
    Ci: { nsIHttpChannel: {} },
    setInterval: () => 1,
    clearInterval: () => {},
  },
);
await rawModule.requestMineruPut(
  {
    method: "PUT",
    url: "https://upload.example/presigned",
    body: png,
    headers: { "Content-Type": "should-not-be-forwarded" },
    responseType: "text",
    timeoutMs: 100,
    maxBytes: 100,
  },
  { isCancelled: () => false },
);
assert.equal(raw.method, "PUT");
assert.equal(raw.mozBackgroundRequest, true);
assert.equal(raw.channel.redirectionLimit, 0);
assert.equal(raw.body, png);
assert.equal(Object.keys(raw.headers).length, 0);
for (const finalUrl of [
  "https://cdn.example/final.zip",
  "http://unsafe.example/body.zip",
]) {
  const result = await mineru.runMineruBodyForTests(
    input,
    { apiKey: "test", resumeJobId: "batch-1" },
    {
      config,
      transport: {
        request: async (r) =>
          r.url.includes("extract-results")
            ? {
                status: 200,
                body: JSON.stringify({
                  code: 0,
                  data: {
                    extract_result: [
                      {
                        state: "done",
                        full_zip_url: "https://result.example/start.zip",
                      },
                    ],
                  },
                }),
              }
            : { status: 200, body: new Uint8Array([1]), finalUrl },
      },
      unzip: async () => entries,
    },
  );
  assert.equal(
    result.ok,
    finalUrl.startsWith("https:"),
    JSON.stringify(result),
  );
}
const redirectedApi = await mineru.runMineruBodyForTests(
  input,
  { apiKey: "test", resumeJobId: "batch-1" },
  {
    config,
    transport: {
      request: async (r) => ({
        status: 200,
        body: "{}",
        finalUrl: r.url + "/redirect",
      }),
    },
  },
);
assert.equal(redirectedApi.ok, false);

/**
 * Runtime-free checks for the pure helpers under src/utils. Each file is
 * transpiled and imported on its own, so these tests cannot drift from the
 * code that ships. Pure modules may only use `import type` between them.
 */
/* global Buffer, URL, console, process */
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function load(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

const { cosine, interpolate, sanitizeColor, splitText, templateKeys } =
  await load("src/utils/text.ts");
const {
  buildChatRequest,
  buildEmbeddingRequest,
  chatUrl,
  createStreamParser,
  detectProtocol,
  embeddingsUrl,
  looksLikeFullUrl,
  mergeParams,
  modelsUrl,
  parseEmbeddings,
  parseFinalBody,
  parseModelList,
} = await load("src/utils/protocol.ts");
const { DEFAULT_CONFIG, configEquals, normalizeConfig, parseProfiles } =
  await load("src/utils/config.ts");
const {
  buildHistory,
  conversationFileName,
  parseConversation,
  serializeConversation,
} = await load("src/utils/history.ts");
const { parseInline, parseMarkdown, texToParts } = await load(
  "src/utils/markdown.ts",
);

const asserts = [];
function assert(name, cond) {
  asserts.push({ name, ok: Boolean(cond) });
  if (!cond) console.error("FAIL", name);
}
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ---- text.ts

assert("cosine identical", Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
assert("cosine orthogonal", Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
assert(
  "cosine typed array",
  Math.abs(cosine(Float32Array.from([3, 4]), [3, 4]) - 1) < 1e-6,
);
assert("cosine zero vector", cosine([0, 0], [1, 1]) === 0);

const packed = interpolate("Q: {{input}}\n{{ related }}\n{{unknown}}", {
  input: "What is DNS?",
  related: "[1] Domain Name System",
});
assert(
  "interpolate known keys, keeps unknown",
  packed === "Q: What is DNS?\n[1] Domain Name System\n{{unknown}}",
);
assert("interpolate missing key is empty", interpolate("{{title}}", {}) === "");

const keys = templateKeys("{{input}} {{ related }} {{input}}");
assert(
  "templateKeys",
  keys.size === 2 && keys.has("input") && keys.has("related"),
);
assert(
  "templateKeys without related",
  !templateKeys("Translate:\n{{selection}}").has("related"),
);

assert("splitText empty", splitText(" \n\n ").length === 0);
const merged = splitText(
  "First paragraph that is long enough.\n\nSecond one.\n\nThird paragraph here.",
);
assert(
  "splitText ignores paragraph breaks",
  merged.length === 1 && !merged[0].includes("\n"),
);
// 50 characters plus a separating space: 19 sentences fit in 1000.
const sentence = "This sentence is exactly fifty characters long ok. ";
const long = splitText(sentence.repeat(100), 1000);
assert(
  "splitText packs to size",
  long.length === 6 && long.every((chunk) => chunk.length <= 1000),
);
assert(
  "splitText breaks at sentence ends",
  long.every((chunk) => chunk.endsWith(".")),
);
const hard = splitText("x".repeat(2500), 1000);
assert(
  "splitText hard-wraps run-on text",
  hard.length === 3 && hard[0].length === 1000,
);
const cjk = splitText("这是第一句话。".repeat(200), 100);
assert(
  "splitText splits CJK sentences",
  cjk.length > 1 &&
    cjk.slice(0, -1).every((chunk) => chunk.length <= 100) &&
    cjk.join("").replace(/ /g, "") === "这是第一句话。".repeat(200),
);
// 32 sentences fill the first chunk; the 33rd plus "p. 3" is a short tail.
const tail = splitText(
  `${"Long sentence number one here. ".repeat(33)}p. 3`,
  1000,
);
assert(
  "splitText folds a short tail into the previous chunk",
  tail.length === 1 && tail[0].endsWith("p. 3"),
);

assert("sanitizeColor valid", sanitizeColor("#0EA293") === "#0EA293");
assert(
  "sanitizeColor rejects css injection",
  sanitizeColor("red;background:url(x)") === "#6b7280",
);
assert("sanitizeColor non-string", sanitizeColor(undefined) === "#6b7280");

// ---- protocol.ts: URLs

const cfg = (patch = {}) => ({
  ...normalizeConfig({ ...DEFAULT_CONFIG, ...patch }),
  keys: { api: "sk-test", embed: "" },
});
const url = (u, urlMode, protocol) => chatUrl({ url: u, urlMode, protocol });

assert(
  "base url, chat",
  url("https://api.openai.com", "base", "openai-chat") ===
    "https://api.openai.com/v1/chat/completions",
);
assert(
  "base url, responses",
  url("https://api.veraashel.cn/", "base", "openai-responses") ===
    "https://api.veraashel.cn/v1/responses",
);
assert(
  "base url, anthropic",
  url("https://api.anthropic.com", "base", "anthropic-messages") ===
    "https://api.anthropic.com/v1/messages",
);
assert(
  "base url ending in /v1 is not doubled",
  url("https://api.deepseek.com/v1", "base", "openai-chat") ===
    "https://api.deepseek.com/v1/chat/completions",
);
assert(
  "base url keeps other versions (GLM v4)",
  url("https://open.bigmodel.cn/api/paas/v4", "base", "openai-chat") ===
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
);
assert(
  "v0.1 full endpoint in base mode still works",
  url("https://api.openai.com/v1/chat/completions", "base", "openai-chat") ===
    "https://api.openai.com/v1/chat/completions",
);
assert(
  "base mode swaps a typed endpoint for the protocol's",
  url("https://x.test/v1/chat/completions", "base", "openai-responses") ===
    "https://x.test/v1/responses",
);
assert(
  "base url keeps query",
  url("https://x.test/openai?api-version=1", "base", "openai-chat") ===
    "https://x.test/openai/v1/chat/completions?api-version=1",
);
assert(
  "full url is used as typed",
  url("https://api.deepseek.com/chat/completions", "full", "openai-chat") ===
    "https://api.deepseek.com/chat/completions",
);
assert(
  "detectProtocol",
  detectProtocol("https://a/v1/responses") === "openai-responses" &&
    detectProtocol("https://a/v1/messages/") === "anthropic-messages" &&
    detectProtocol("https://a/chat/completions?x=1") === "openai-chat" &&
    detectProtocol("https://a") === undefined,
);
assert(
  "looksLikeFullUrl",
  looksLikeFullUrl("https://a/v1/chat/completions") &&
    !looksLikeFullUrl("https://a/v1"),
);
assert(
  "models url, base",
  modelsUrl({
    url: "https://api.siliconflow.cn",
    urlMode: "base",
    protocol: "openai-chat",
  }) === "https://api.siliconflow.cn/v1/models",
);
assert(
  "models url, full (Gemini) does not add /v1",
  modelsUrl({
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    urlMode: "full",
    protocol: "openai-chat",
  }) === "https://generativelanguage.googleapis.com/v1beta/openai/models",
);
assert(
  "models url, anthropic asks for the full list",
  modelsUrl({
    url: "https://api.anthropic.com",
    urlMode: "base",
    protocol: "anthropic-messages",
  }) === "https://api.anthropic.com/v1/models?limit=1000",
);
assert(
  "embeddings url derived from base chat url",
  embeddingsUrl(cfg({ url: "https://api.siliconflow.cn" })) ===
    "https://api.siliconflow.cn/v1/embeddings",
);
assert(
  "embeddings url derived from full chat url",
  embeddingsUrl(
    cfg({
      url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      urlMode: "full",
    }),
  ) === "https://open.bigmodel.cn/api/paas/v4/embeddings",
);
assert(
  "embeddings url: explicit endpoint kept, base completed",
  embeddingsUrl(
    cfg({
      embed: { ...DEFAULT_CONFIG.embed, url: "https://e.test/v1/embeddings" },
    }),
  ) === "https://e.test/v1/embeddings" &&
    embeddingsUrl(
      cfg({ embed: { ...DEFAULT_CONFIG.embed, url: "https://e.test" } }),
    ) === "https://e.test/v1/embeddings",
);
assert(
  "no derived embeddings for anthropic",
  embeddingsUrl(
    cfg({ protocol: "anthropic-messages", url: "https://api.anthropic.com" }),
  ) === "",
);

// ---- protocol.ts: request bodies

const msgs = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hi" },
];
const body = (patch) => JSON.parse(buildChatRequest(cfg(patch), msgs).body);

const chatBody = body({});
assert(
  "chat body: messages keep system, temperature on, no max tokens",
  chatBody.messages.length === 2 &&
    chatBody.temperature === 0.7 &&
    !("max_tokens" in chatBody) &&
    !("max_completion_tokens" in chatBody) &&
    chatBody.stream === true,
);
assert(
  "chat body: OpenAI host uses max_completion_tokens",
  body({ maxTokens: { enabled: true, value: 2048 } }).max_completion_tokens ===
    2048,
);
assert(
  "chat body: other hosts use max_tokens and reasoning_effort",
  (() => {
    const b = body({
      url: "https://api.deepseek.com",
      maxTokens: { enabled: true, value: 2048 },
      reasoningEffort: { enabled: true, value: "high" },
      temperature: { enabled: false, value: 1 },
    });
    return (
      b.max_tokens === 2048 &&
      b.reasoning_effort === "high" &&
      !("temperature" in b)
    );
  })(),
);
const resBody = body({
  protocol: "openai-responses",
  reasoningEffort: { enabled: true, value: "low" },
  maxTokens: { enabled: true, value: 1000 },
});
assert(
  "responses body",
  resBody.instructions === "SYS" &&
    resBody.input.length === 1 &&
    resBody.input[0].role === "user" &&
    resBody.max_output_tokens === 1000 &&
    resBody.reasoning.effort === "low" &&
    resBody.reasoning.summary === "auto" &&
    resBody.store === false,
);
const antReq = buildChatRequest(
  cfg({
    protocol: "anthropic-messages",
    url: "https://api.anthropic.com",
    temperature: { enabled: false, value: 1 },
    reasoningEffort: { enabled: true, value: "high" },
  }),
  msgs,
);
const antBody = JSON.parse(antReq.body);
assert(
  "anthropic request",
  antReq.headers["x-api-key"] === "sk-test" &&
    antReq.headers["anthropic-version"] === "2023-06-01" &&
    !antReq.headers.Authorization &&
    antBody.system === "SYS" &&
    antBody.messages.length === 1 &&
    antBody.max_tokens === 8192 &&
    antBody.thinking.type === "adaptive" &&
    antBody.output_config.effort === "high" &&
    !("temperature" in antBody),
);
assert(
  "anthropic effort none sends no thinking",
  !(
    "thinking" in
    body({
      protocol: "anthropic-messages",
      reasoningEffort: { enabled: true, value: "none" },
    })
  ),
);
const extra = body({
  protocol: "anthropic-messages",
  reasoningEffort: { enabled: true, value: "high" },
  extraParams:
    '{"thinking": {"type": "enabled", "budget_tokens": 4000}, "output_config": null, "top_k": 5}',
});
assert(
  "extra params merge deep and null deletes",
  extra.thinking.type === "enabled" &&
    extra.thinking.budget_tokens === 4000 &&
    extra.thinking.display === "summarized" &&
    !("output_config" in extra) &&
    extra.top_k === 5,
);
assert(
  "invalid extra params throw",
  throws(() => buildChatRequest(cfg({ extraParams: "{oops" }), msgs)) &&
    throws(() => buildChatRequest(cfg({ extraParams: "[1]" }), msgs)),
);
assert(
  "empty extra params are fine",
  !throws(() => buildChatRequest(cfg({ extraParams: "  " }), msgs)),
);
assert(
  "stream false via extra params is reported",
  buildChatRequest(cfg({ extraParams: '{"stream": false}' }), msgs).stream ===
    false,
);
assert(
  "mergeParams replaces arrays",
  mergeParams({ a: [1, 2] }, { a: [3] }).a.length === 1,
);

// ---- protocol.ts: streams

function feedAll(protocol, raw, pieces = 3) {
  const parser = createStreamParser(protocol);
  const step = Math.ceil(raw.length / pieces);
  for (let i = step; i < raw.length; i += step) parser.feed(raw.slice(0, i));
  return parser.finish(raw);
}

const chatSse = [
  'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
  'data: {"choices":[{"delta":{"content":"Hel"}}]}',
  "",
  'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"length"}]}',
  'data: {"choices":[],"usage":{"total_tokens":3}}',
  "data: [DONE]",
].join("\n");
const chatState = feedAll("openai-chat", chatSse);
assert(
  "chat stream: text, reasoning, usage chunk, done",
  chatState.text === "Hello" &&
    chatState.reasoning === "think " &&
    chatState.incomplete === "length" &&
    chatState.done,
);
const partial = createStreamParser("openai-chat");
partial.feed('data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"choi');
assert("chat stream ignores a partial line", partial.state.text === "A");
partial.feed(
  'data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"choices":[{"delta":{"content":"B"}}]}\n',
);
assert("chat stream resumes at the saved offset", partial.state.text === "AB");
assert(
  "chat stream: mid-stream error",
  feedAll(
    "openai-chat",
    'data: {"choices":[{"delta":{"content":"x"}}]}\ndata: {"error":{"message":"quota"}}\n',
  ).error === "quota",
);

const resSse = [
  "event: response.created",
  'data: {"type":"response.created","response":{}}',
  "",
  'data: {"type":"response.reasoning_summary_text.delta","delta":"Plan"}',
  'data: {"type":"response.reasoning_summary_part.added"}',
  'data: {"type":"response.reasoning_summary_text.delta","delta":"More"}',
  'data: {"type":"response.output_text.delta","delta":"O"}',
  'data: {"type":"response.output_text.delta","delta":"K"}',
  'data: {"type":"response.completed","response":{}}',
].join("\n");
const resState = feedAll("openai-responses", resSse, 5);
assert(
  "responses stream",
  resState.text === "OK" &&
    resState.reasoning === "Plan\n\nMore" &&
    resState.done &&
    !resState.error,
);
assert(
  "responses stream: failed and incomplete",
  feedAll(
    "openai-responses",
    'data: {"type":"response.failed","response":{"error":{"message":"bad model"}}}\n',
  ).error === "bad model" &&
    feedAll(
      "openai-responses",
      'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n',
    ).incomplete === "max_output_tokens",
);

const antSse = [
  "event: message_start",
  'data: {"type":"message_start","message":{}}',
  "",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}',
  'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
  'data: {"type":"message_stop"}',
].join("\n");
const antState = feedAll("anthropic-messages", antSse);
assert(
  "anthropic stream",
  antState.text === "Hi" &&
    antState.reasoning === "hmm" &&
    antState.incomplete === "max_tokens" &&
    antState.done,
);
assert(
  "anthropic stream: error event",
  feedAll(
    "anthropic-messages",
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n',
  ).error === "Overloaded",
);

// ---- protocol.ts: non-streaming bodies, model lists, embeddings

assert(
  "final body: chat",
  parseFinalBody(
    "openai-chat",
    '{"choices":[{"message":{"content":"yo","reasoning_content":"r"}}]}',
  ).text === "yo",
);
const resFinal = parseFinalBody(
  "openai-responses",
  JSON.stringify({
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "S" }] },
      { type: "message", content: [{ type: "output_text", text: "T" }] },
    ],
  }),
);
assert(
  "final body: responses",
  resFinal.text === "T" && resFinal.reasoning === "S",
);
assert(
  "final body: anthropic",
  parseFinalBody(
    "anthropic-messages",
    '{"content":[{"type":"thinking","thinking":"a"},{"type":"text","text":"b"}]}',
  ).text === "b",
);
assert(
  "final body: error",
  parseFinalBody("openai-chat", '{"error":{"message":"nope"}}').error ===
    "nope",
);

assert(
  "parseModelList: openai, sorted and unique",
  parseModelList({ data: [{ id: "b" }, { id: "a" }, { id: "b" }] }).join() ===
    "a,b",
);
assert(
  "parseModelList: gemini names",
  parseModelList({ models: [{ name: "models/gemini-2.5-flash" }] })[0] ===
    "gemini-2.5-flash",
);
assert(
  "parseModelList: bare array and junk",
  parseModelList(["x", null, { slug: "y" }]).join() === "x,y" &&
    parseModelList({}).length === 0,
);

const embReq = buildEmbeddingRequest(
  {
    ...cfg({ url: "https://api.siliconflow.cn" }),
    keys: { api: "A", embed: "" },
  },
  ["t"],
);
assert(
  "embedding request falls back to the chat key",
  embReq.headers.Authorization === "Bearer A" &&
    embReq.url === "https://api.siliconflow.cn/v1/embeddings",
);
assert(
  "parseEmbeddings orders by index",
  parseEmbeddings(
    {
      data: [
        { index: 1, embedding: [2] },
        { index: 0, embedding: [1] },
      ],
    },
    2,
  )
    .map((v) => v[0])
    .join() === "1,2",
);
assert(
  "parseEmbeddings rejects a short list",
  throws(() => parseEmbeddings({ data: [] }, 1)),
);

// ---- config.ts

const normalized = normalizeConfig({
  protocol: "nope",
  temperature: { enabled: true, value: "9" },
  maxTokens: { value: -5 },
});
assert(
  "normalizeConfig fills and clamps",
  normalized.protocol === "openai-chat" &&
    normalized.temperature.value === 2 &&
    normalized.maxTokens.value === 1 &&
    normalized.embed.batchSize === 16,
);
assert(
  "configEquals ignores key order",
  configEquals(DEFAULT_CONFIG, JSON.parse(JSON.stringify(DEFAULT_CONFIG))) &&
    !configEquals(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, model: "other" }),
);
const profiles = parseProfiles(
  JSON.stringify([
    { id: "a", name: " ds ", config: { model: "deepseek-chat" } },
    { id: "", name: "no id" },
    { id: "b", name: "" },
  ]),
);
assert(
  "parseProfiles keeps valid entries",
  profiles.length === 1 &&
    profiles[0].name === "ds" &&
    profiles[0].config.model === "deepseek-chat",
);
assert("parseProfiles tolerates junk", parseProfiles("{").length === 0);

// ---- history.ts

const history = [
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "q2" },
  { role: "assistant", content: "a2" },
];
const sent = buildHistory(history, "FULL q3", null);
assert(
  "buildHistory appends the full prompt",
  sent.length === 5 && sent[4].content === "FULL q3" && sent[4].role === "user",
);
const cut = buildHistory(history, "q3", 2);
assert(
  "buildHistory drops a leading reply after the cut",
  cut.length === 1 && cut[0].content === "q3",
);
assert(
  "buildHistory limit 3 keeps user-first",
  buildHistory(history, "q3", 3)[0].content === "q2",
);
assert(
  "conversationFileName",
  conversationFileName({ type: "user" }, "ABCD1234") === "u_ABCD1234.json" &&
    conversationFileName({ type: "group", groupID: 42 }, "AB/CD") ===
      "g42_ABCD.json" &&
    conversationFileName({ type: "user" }, "../") === undefined,
);
const stored = serializeConversation("Title", [
  {
    role: "user",
    content: "compact",
    display: "AskPDF · q",
    source: { text: "PDF excerpt [1]", truncated: false },
  },
  { role: "assistant", content: "answer", reasoning: "secret thoughts" },
]);
const restored = parseConversation(stored);
assert(
  "conversation round trip keeps display, drops reasoning",
  restored.length === 2 &&
    restored[0].display === "AskPDF · q" &&
    restored[0].source.text === "PDF excerpt [1]" &&
    restored[0].source.truncated === false &&
    restored[1].content === "answer" &&
    !("reasoning" in restored[1]) &&
    !stored.includes("secret thoughts"),
);
assert(
  "parseConversation rejects junk and bad turns",
  parseConversation("nope") === undefined &&
    parseConversation("{}") === undefined &&
    parseConversation(
      '{"turns":[{"role":"system","content":"x"},{"role":"user"}]}',
    ).length === 0,
);

// ---- markdown.ts

const types = (blocks) => blocks.map((b) => b.type).join(",");
const plain = (nodes) =>
  nodes
    .map((n) =>
      n.type === "text" || n.type === "code" || n.type === "math"
        ? n.text
        : n.type === "br"
          ? "\n"
          : plain(n.children),
    )
    .join("");
const inlineTypes = (nodes) => nodes.map((n) => n.type).join(",");

// The shape of the answer that broke the sidebar: bullets written with "*",
// bold labels, rules, headings and a nested list under an ordered item.
const answer = parseMarkdown(
  [
    "这篇论文围绕 **TA36 单级低速轴流压气机**展开 [1, 5]。核心内容：",
    "",
    "---",
    "",
    "### 1. 研究背景",
    "* **实验平台**：动叶数 20 [5]。",
    "* **数据处理**：分辨 $m = -9 \\sim 10$ 阶模态 [4, 8]。",
    "",
    "---",
    "",
    "3. **地面进气畸变**：",
    "   * 湍流气团被**轴向拉长**[12]。",
    "   * 转子切割湍流 [13]。",
    "* **补充实验验证**：3BPF 截止。",
  ].join("\n"),
);
assert(
  "real answer: block structure",
  types(answer) === "paragraph,hr,heading,list,hr,list,list",
);
assert(
  "real answer: bullets are list items, not emphasis",
  answer[3].items.length === 2 &&
    inlineTypes(answer[3].items[0][0].inline) === "strong,text" &&
    !JSON.stringify(answer).includes('"em"'),
);
assert(
  "real answer: nested list under an ordered item",
  answer[5].ordered &&
    answer[5].start === 3 &&
    types(answer[5].items[0]) === "paragraph,list" &&
    answer[5].items[0][1].items.length === 2,
);
assert(
  "real answer: CJK bold without spaces, inline math",
  inlineTypes(answer[0].inline) === "text,strong,text" &&
    answer[3].items[1][0].inline.some(
      (n) => n.type === "math" && n.text === "m = -9 \\sim 10",
    ),
);

assert(
  "emphasis never crosses paragraphs",
  types(parseMarkdown("a *b\n\nc* d")) === "paragraph,paragraph" &&
    !JSON.stringify(parseMarkdown("a *b\n\nc* d")).includes('"em"'),
);
assert(
  "unclosed markers stay text",
  plain(parseInline("**bold and *it")) === "**bold and *it",
);
assert(
  "nested emphasis",
  JSON.stringify(parseInline("*a **b** c*")) ===
    JSON.stringify([
      {
        type: "em",
        children: [
          { type: "text", text: "a " },
          { type: "strong", children: [{ type: "text", text: "b" }] },
          { type: "text", text: " c" },
        ],
      },
    ]),
);
assert(
  "snake_case is not emphasis, 2 * 3 is not either",
  inlineTypes(parseInline("use snake_case_name here")) === "text" &&
    inlineTypes(parseInline("2 * 3 * 4")) === "text",
);
assert(
  "code span protects markers",
  JSON.stringify(parseInline("`a*b*c` and ~~gone~~")) ===
    JSON.stringify([
      { type: "code", text: "a*b*c" },
      { type: "text", text: " and " },
      { type: "del", children: [{ type: "text", text: "gone" }] },
    ]),
);
assert(
  "links and escapes",
  (() => {
    const nodes = parseInline("see [docs](https://x.test/a) \\*not em\\*");
    return (
      nodes[1].type === "link" &&
      nodes[1].href === "https://x.test/a" &&
      plain(nodes) === "see docs *not em*"
    );
  })(),
);
assert(
  "dollar amounts are not math",
  inlineTypes(parseInline("costs $5 and $10 today")) === "text",
);
assert(
  "LaTeX delimiters",
  inlineTypes(parseInline("\\(x^2\\) and $$y$$")) === "math,text,math",
);
const fenced = parseMarkdown("```python\nx = 1\n\ny = 2\n```\nafter");
assert(
  "fenced code keeps blank lines and language",
  fenced[0].type === "code" &&
    fenced[0].lang === "python" &&
    fenced[0].text === "x = 1\n\ny = 2" &&
    fenced[1].type === "paragraph",
);
assert(
  "unclosed fence mid-stream runs to the end",
  types(parseMarkdown("text\n```js\nlet a")) === "paragraph,code",
);
const table = parseMarkdown(
  "| 转速 | 模态 |\n|:---|---:|\n| 2100 | $m=-2$ |\n| 2700 | a \\| b |",
);
assert(
  "table with alignment and escaped pipe",
  table[0].type === "table" &&
    table[0].align.join() === "left,right" &&
    table[0].rows.length === 2 &&
    plain(table[0].rows[1][1]) === "a | b",
);
assert(
  "math block and quote",
  types(parseMarkdown("$$\nE = mc^2\n$$\n\n> quoted\n> more")) === "math,quote",
);
assert(
  "a paragraph starting with $$ does not swallow the rest",
  types(parseMarkdown("$$x$$ is small\n\n# Next")) === "paragraph,heading",
);
assert(
  "list interrupts a paragraph; soft breaks become br",
  types(parseMarkdown("以下几点：\n- a\n- b")) === "paragraph,list" &&
    inlineTypes(parseMarkdown("line one\nline two")[0].inline) ===
      "text,br,text",
);
assert(
  "loose list stays one list",
  (() => {
    const list = parseMarkdown("1. a\n\n2. b\n\n3. c")[0];
    return list.type === "list" && list.items.length === 3;
  })(),
);
assert(
  "texToParts symbols and scripts",
  JSON.stringify(texToParts("m = -9 \\sim 10, x^{2} + y_i")) ===
    JSON.stringify([
      { text: "m = -9 ∼ 10, x" },
      { text: "2", script: "sup" },
      { text: " + y" },
      { text: "i", script: "sub" },
    ]),
);

const failed = asserts.filter((row) => !row.ok);
console.log(
  `${asserts.length - failed.length}/${asserts.length} checks passed`,
);
if (failed.length) process.exit(1);

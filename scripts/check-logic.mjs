/**
 * Runtime-free checks for MVP string/math helpers.
 * Mirrors src/modules/llm.ts joinUrl/cosine and context interpolate/splitText.
 */
function joinUrl(base, path) {
  const trimmed = base.replace(/\/+$/, "");
  if (/\/v1\/(chat\/completions|responses|embeddings)$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) return `${trimmed}${path.replace(/^\/v1/, "")}`;
  return `${trimmed}${path}`;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function interpolate(template, pack) {
  return template.replace(
    /\{\{\s*(input|selection|abstract|title|authors|year|related)\s*\}\}/g,
    (_match, key) => pack[key] || "",
  );
}

function splitText(text) {
  return text
    .replace(/\r/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 40)
    .slice(0, 80);
}

const asserts = [];
function assert(name, cond) {
  asserts.push({ name, ok: Boolean(cond) });
  if (!cond) console.error("FAIL", name);
}

assert(
  "joinUrl base host",
  joinUrl("https://api.openai.com", "/v1/chat/completions") ===
    "https://api.openai.com/v1/chat/completions",
);
assert(
  "joinUrl v1 suffix",
  joinUrl("https://api.deepseek.com/v1", "/v1/chat/completions") ===
    "https://api.deepseek.com/v1/chat/completions",
);
assert(
  "joinUrl full chat url",
  joinUrl("https://api.openai.com/v1/chat/completions", "/v1/chat/completions") ===
    "https://api.openai.com/v1/chat/completions",
);
assert(
  "joinUrl full embeddings url",
  joinUrl("https://api.siliconflow.cn/v1/embeddings", "/v1/embeddings") ===
    "https://api.siliconflow.cn/v1/embeddings",
);
assert("cosine identical", Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
assert("cosine orthogonal", Math.abs(cosine([1, 0], [0, 1])) < 1e-9);

const packed = interpolate("Q: {{input}}\n{{related}}", {
  input: "What is DNS?",
  selection: "",
  abstract: "",
  title: "",
  authors: "",
  year: "",
  related: "[1] Domain Name System",
});
assert("interpolate", packed.includes("What is DNS?") && packed.includes("[1]"));

const chunks = splitText(
  "This paragraph is definitely longer than forty characters in total.\n\nshort\n\nAnother paragraph that is also long enough to survive the filter used here.",
);
assert("splitText keeps long", chunks.length === 2);

const failed = asserts.filter((row) => !row.ok);
console.log(`${asserts.length - failed.length}/${asserts.length} checks passed`);
if (failed.length) process.exit(1);

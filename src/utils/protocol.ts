/**
 * Wire formats of the three supported chat protocols. Pure functions only;
 * scripts/check-logic.mjs loads this file on its own, so imports from other
 * modules must be `import type`.
 */
import type { Protocol, ResolvedConfig, UrlMode } from "./config";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type HttpRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
  stream: boolean;
};

const CHAT_PATHS: Record<Protocol, string> = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
};

const ENDPOINT_SUFFIX =
  /\/(chat\/completions|responses|messages|embeddings|models)$/;

function splitQuery(url: string): [string, string] {
  const trimmed = url.trim();
  const i = trimmed.indexOf("?");
  return i < 0 ? [trimmed, ""] : [trimmed.slice(0, i), trimmed.slice(i)];
}

function stripEndpoint(path: string) {
  return path.replace(/\/+$/, "").replace(ENDPOINT_SUFFIX, "");
}

/** "https://host" → "https://host/v1"; ".../v4" and ".../v1" stay. */
function withVersion(path: string) {
  return /\/v\d+$/i.test(path) ? path : `${path}/v1`;
}

/**
 * Final request URL. In base mode any endpoint suffix the user typed is
 * dropped first, so a full URL left over from v0.1 still works.
 */
export function resolveUrl(url: string, urlMode: UrlMode, endpoint: string) {
  const [path, query] = splitQuery(url);
  if (urlMode === "full") return `${path}${query}`;
  return `${withVersion(stripEndpoint(path))}${endpoint}${query}`;
}

export function chatUrl(
  config: Pick<ResolvedConfig, "url" | "urlMode" | "protocol">,
) {
  return resolveUrl(config.url, config.urlMode, CHAT_PATHS[config.protocol]);
}

/** The URL without its endpoint path, for switching from full to base mode. */
export function stripEndpointUrl(url: string) {
  const [path, query] = splitQuery(url);
  return `${stripEndpoint(path)}${query}`;
}

/** Protocol implied by a typed full endpoint, if any. */
export function detectProtocol(url: string): Protocol | undefined {
  const [path] = splitQuery(url);
  const clean = path.replace(/\/+$/, "");
  if (clean.endsWith("/responses")) return "openai-responses";
  if (clean.endsWith("/messages")) return "anthropic-messages";
  if (clean.endsWith("/chat/completions")) return "openai-chat";
  return undefined;
}

/** Whether the URL already names an endpoint (a hint for the Full URL toggle). */
export function looksLikeFullUrl(url: string) {
  return ENDPOINT_SUFFIX.test(splitQuery(url)[0].replace(/\/+$/, ""));
}

export function modelsUrl(
  config: Pick<ResolvedConfig, "url" | "urlMode" | "protocol">,
) {
  const [path, query] = splitQuery(config.url);
  const stripped = stripEndpoint(path);
  const base = config.urlMode === "full" ? stripped : withVersion(stripped);
  const limit = config.protocol === "anthropic-messages" ? "?limit=1000" : "";
  return `${base}/models${limit || query}`;
}

/**
 * Embeddings endpoint: the explicit URL if set, otherwise derived from the
 * chat URL. Anthropic has no embeddings API, so that yields "".
 */
export function embeddingsUrl(config: ResolvedConfig) {
  const explicit = config.embed.url.trim();
  if (explicit) {
    const [path, query] = splitQuery(explicit);
    if (path.replace(/\/+$/, "").endsWith("/embeddings")) return explicit;
    return `${withVersion(stripEndpoint(path))}/embeddings${query}`;
  }
  if (config.protocol === "anthropic-messages") return "";
  const [path, query] = splitQuery(config.url);
  const stripped = stripEndpoint(path);
  const base = config.urlMode === "full" ? stripped : withVersion(stripped);
  return `${base}/embeddings${query}`;
}

export function parseExtraParams(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Extra params: invalid JSON (${(error as Error).message})`,
      {
        cause: error,
      },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra params must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Deep merge; a `null` in `extra` deletes the key, arrays are replaced. */
export function mergeParams(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
) {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = mergeParams(current, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildChatRequest(
  config: ResolvedConfig,
  messages: ChatMessage[],
): HttpRequest {
  const url = chatUrl(config);
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  const { temperature, maxTokens, reasoningEffort } = config;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  let body: Record<string, unknown>;

  switch (config.protocol) {
    case "openai-responses":
      headers.Authorization = `Bearer ${config.keys.api}`;
      body = { model: config.model, input: turns, stream: true, store: false };
      if (system) body.instructions = system;
      if (temperature.enabled) body.temperature = temperature.value;
      if (maxTokens.enabled) body.max_output_tokens = maxTokens.value;
      if (reasoningEffort.enabled) {
        // Without `summary`, reasoning models stream nothing to show.
        body.reasoning = { effort: reasoningEffort.value, summary: "auto" };
      }
      break;
    case "anthropic-messages":
      headers["x-api-key"] = config.keys.api;
      headers["anthropic-version"] = "2023-06-01";
      // max_tokens is required by this API, so the toggle only gates the others.
      body = {
        model: config.model,
        messages: turns,
        max_tokens: maxTokens.value,
        stream: true,
      };
      if (system) body.system = system;
      if (temperature.enabled) body.temperature = temperature.value;
      if (reasoningEffort.enabled && reasoningEffort.value !== "none") {
        body.thinking = { type: "adaptive", display: "summarized" };
        body.output_config = { effort: reasoningEffort.value };
      }
      break;
    default:
      headers.Authorization = `Bearer ${config.keys.api}`;
      body = { model: config.model, messages, stream: true };
      if (temperature.enabled) body.temperature = temperature.value;
      if (maxTokens.enabled) {
        // OpenAI's reasoning models reject max_tokens; most other hosts
        // only know max_tokens.
        const field = /^https:\/\/api\.openai\.com\//.test(url)
          ? "max_completion_tokens"
          : "max_tokens";
        body[field] = maxTokens.value;
      }
      if (reasoningEffort.enabled) {
        body.reasoning_effort = reasoningEffort.value;
      }
  }

  body = mergeParams(body, parseExtraParams(config.extraParams));
  return {
    url,
    headers,
    body: JSON.stringify(body),
    stream: body.stream !== false,
  };
}

export type StreamState = {
  text: string;
  reasoning: string;
  /** Provider error reported inside a 200 response. */
  error: string;
  /** Why generation stopped early (e.g. max tokens), if it did. */
  incomplete: string;
  done: boolean;
};

/**
 * Incremental SSE parser: `feed` takes the whole response text received so
 * far and only parses the complete lines it has not seen.
 */
export function createStreamParser(protocol: Protocol) {
  let offset = 0;
  const state: StreamState = {
    text: "",
    reasoning: "",
    error: "",
    incomplete: "",
    done: false,
  };
  const feed = (raw: string) => {
    const end = raw.lastIndexOf("\n");
    if (end < offset) return state;
    for (const line of raw.slice(offset, end).split("\n")) {
      handleLine(protocol, line, state);
    }
    offset = end + 1;
    return state;
  };
  return {
    state,
    feed,
    /** Parse a final line that arrived without a trailing newline. */
    finish: (raw: string) => feed(raw.endsWith("\n") ? raw : `${raw}\n`),
  };
}

function handleLine(protocol: Protocol, line: string, state: StreamState) {
  const trimmed = line.trim();
  let payload: string;
  if (trimmed.startsWith("data:")) payload = trimmed.slice(5).trim();
  else if (trimmed.startsWith("{")) payload = trimmed;
  else return; // event:, id:, comments, blank lines
  if (!payload) return;
  if (payload === "[DONE]") {
    state.done = true;
    return;
  }
  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    return;
  }
  // Relays sometimes drop `event:` lines, so dispatch on the payload.
  if (json?.error && json?.type !== "response.failed") {
    state.error = errorText(json.error);
    return;
  }
  if (protocol === "openai-responses") handleResponsesEvent(json, state);
  else if (protocol === "anthropic-messages") handleAnthropicEvent(json, state);
  else handleChatChunk(json, state);
}

function handleChatChunk(json: any, state: StreamState) {
  const choice = json?.choices?.[0];
  if (!choice) return; // e.g. the trailing usage chunk
  const delta = choice.delta;
  if (delta) {
    if (typeof delta.content === "string") state.text += delta.content;
    const thought = delta.reasoning_content ?? delta.reasoning;
    if (typeof thought === "string") state.reasoning += thought;
  } else if (typeof choice.message?.content === "string") {
    state.text += choice.message.content;
  }
  if (choice.finish_reason === "length") state.incomplete = "length";
}

function handleResponsesEvent(json: any, state: StreamState) {
  switch (json?.type) {
    case "response.output_text.delta":
      state.text += json.delta ?? "";
      break;
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta":
      state.reasoning += json.delta ?? "";
      break;
    case "response.reasoning_summary_part.added":
      if (state.reasoning) state.reasoning += "\n\n";
      break;
    case "response.completed":
      state.done = true;
      break;
    case "response.incomplete":
      state.incomplete =
        json.response?.incomplete_details?.reason || "incomplete";
      state.done = true;
      break;
    case "response.failed":
      state.error = errorText(json.response?.error) || "Response failed.";
      state.done = true;
      break;
    case "error":
      state.error = errorText(json) || "Stream error.";
      break;
  }
}

function handleAnthropicEvent(json: any, state: StreamState) {
  switch (json?.type) {
    case "content_block_delta":
      if (json.delta?.type === "text_delta")
        state.text += json.delta.text ?? "";
      else if (json.delta?.type === "thinking_delta") {
        state.reasoning += json.delta.thinking ?? "";
      }
      break;
    case "message_delta":
      if (json.delta?.stop_reason === "max_tokens") {
        state.incomplete = "max_tokens";
      }
      break;
    case "message_stop":
      state.done = true;
      break;
  }
}

function errorText(error: any): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(error.message || error.error?.message || error.type || "");
}

/** Non-streaming bodies, for hosts that ignore `stream` or `stream: false`. */
export function parseFinalBody(protocol: Protocol, raw: string) {
  const result = { text: "", reasoning: "", error: "" };
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    return result;
  }
  if (json?.error) {
    result.error = errorText(json.error);
    return result;
  }
  if (protocol === "openai-responses") {
    for (const item of json?.output || []) {
      if (item?.type === "message") {
        for (const part of item.content || []) {
          if (part?.type === "output_text") result.text += part.text ?? "";
        }
      } else if (item?.type === "reasoning") {
        for (const part of item.summary || []) {
          result.reasoning += part?.text ?? "";
        }
      }
    }
  } else if (protocol === "anthropic-messages") {
    for (const block of json?.content || []) {
      if (block?.type === "text") result.text += block.text ?? "";
      else if (block?.type === "thinking")
        result.reasoning += block.thinking ?? "";
    }
  } else {
    const message = json?.choices?.[0]?.message;
    result.text = String(message?.content ?? "");
    result.reasoning = String(message?.reasoning_content ?? "");
  }
  return result;
}

/** Model ids from OpenAI, Anthropic, Gemini or bare-array list responses. */
export function parseModelList(json: unknown): string[] {
  const src = json as any;
  const list: unknown[] = Array.isArray(src)
    ? src
    : Array.isArray(src?.data)
      ? src.data
      : Array.isArray(src?.models)
        ? src.models
        : [];
  const ids = list
    .map((entry: any) =>
      typeof entry === "string"
        ? entry
        : (entry?.id ?? entry?.slug ?? entry?.name),
    )
    .filter((id): id is string => typeof id === "string" && Boolean(id))
    .map((id) => id.replace(/^models\//, ""));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export function buildEmbeddingRequest(
  config: ResolvedConfig,
  input: string[],
): HttpRequest {
  return {
    url: embeddingsUrl(config),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.keys.embed || config.keys.api}`,
    },
    body: JSON.stringify({ model: config.embed.model, input }),
    stream: false,
  };
}

/** Vectors in input order; providers may return `data` out of order. */
export function parseEmbeddings(json: unknown, expected: number): number[][] {
  const data = (json as any)?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error("Embedding API returned no vectors.");
  }
  return [...data]
    .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
    .map((row) => {
      if (!Array.isArray(row?.embedding)) {
        throw new Error("Embedding API returned no vectors.");
      }
      return row.embedding as number[];
    });
}

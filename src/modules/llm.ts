import { getString } from "../utils/locale";
import type { ResolvedConfig } from "../utils/config";
import {
  buildChatRequest,
  buildEmbeddingRequest,
  chatUrl,
  createStreamParser,
  embeddingsUrl,
  modelsUrl,
  parseEmbeddings,
  parseFinalBody,
  parseModelList,
  type ChatMessage,
  type StreamState,
} from "../utils/protocol";

export type { ChatMessage };

export type Delta = { text: string; reasoning: string };
export type StreamResult = Delta & {
  aborted: boolean;
  /** Why the answer is cut short (max tokens, provider error), if it is. */
  incomplete: string;
};

/** Identifies the vector space; cached vectors are only valid within one. */
export function embeddingIdentity(config: ResolvedConfig) {
  return `${embeddingsUrl(config)}|${config.embed.model}`;
}

export function canEmbed(config: ResolvedConfig) {
  return config.embed.enabled && Boolean(embeddingsUrl(config));
}

/**
 * Stream a chat completion. `onCancelReady` receives a function that aborts
 * the request; an aborted stream resolves with the text received so far.
 */
export async function streamChat(
  config: ResolvedConfig,
  messages: ChatMessage[],
  onDelta: (delta: Delta) => void,
  onCancelReady?: (cancel: () => void) => void,
): Promise<StreamResult> {
  if (!config.keys.api) throw new Error(getString("error-no-key"));
  const request = buildChatRequest(config, messages);
  const parser = createStreamParser(config.protocol);

  let aborted = false;
  // Zotero's canceller also settles the promise; a raw abort() is the
  // fallback if it is never handed over.
  let cancelRequest: (() => void) | undefined;
  onCancelReady?.(() => {
    aborted = true;
    cancelRequest?.();
  });
  let xhr: XMLHttpRequest;
  try {
    xhr = await Zotero.HTTP.request("POST", request.url, {
      headers: request.headers,
      body: request.body,
      responseType: "text",
      // Zotero's defaults are a 30 s cap on the whole request and up to an
      // hour of silent 5xx retries; neither fits a streamed answer.
      timeout: 0,
      errorDelayMax: 0,
      requestObserver: (req: XMLHttpRequest) => {
        cancelRequest ??= () => req.abort();
        req.onprogress = () => {
          const state = parser.feed(req.responseText || "");
          onDelta({ text: state.text, reasoning: state.reasoning });
        };
      },
      cancellerReceiver: (cancel: () => void) => {
        cancelRequest = cancel;
      },
    });
  } catch (error) {
    if (aborted) return { ...partial(parser.state), aborted: true };
    throw new Error(describeHttpError(error), { cause: error });
  }

  const raw = xhr.responseText || "";
  const state = parser.finish(raw);
  let { text, reasoning } = state;
  let error = state.error;
  if (!text && !error) {
    // Hosts that ignore `stream`, or `stream: false` set in extra params.
    const final = parseFinalBody(config.protocol, raw);
    text = final.text;
    reasoning ||= final.reasoning;
    error = final.error;
  }
  if (error && !text) throw new Error(error);
  return {
    text,
    reasoning,
    aborted: false,
    incomplete: error || state.incomplete,
  };
}

function partial(state: StreamState) {
  return { text: state.text, reasoning: state.reasoning, incomplete: "" };
}

export async function embedTexts(
  config: ResolvedConfig,
  texts: string[],
): Promise<number[][]> {
  if (!config.embed.enabled) throw new Error(getString("test-embed-off"));
  if (!embeddingsUrl(config)) throw new Error(getString("test-embed-none"));
  if (!config.keys.embed && !config.keys.api) {
    throw new Error(getString("error-no-embed-key"));
  }
  const batchSize = Math.max(1, config.embed.batchSize);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const request = buildEmbeddingRequest(config, batch);
    let res: XMLHttpRequest;
    try {
      res = await Zotero.HTTP.request("POST", request.url, {
        headers: request.headers,
        body: request.body,
        responseType: "json",
        timeout: 60000,
        errorDelayMax: 0,
      });
    } catch (error) {
      throw new Error(describeHttpError(error), { cause: error });
    }
    vectors.push(...parseEmbeddings(res.response, batch.length));
  }
  return vectors;
}

export async function listModels(config: ResolvedConfig): Promise<string[]> {
  const headers: Record<string, string> =
    config.protocol === "anthropic-messages"
      ? { "x-api-key": config.keys.api, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${config.keys.api}` };
  try {
    const res = await Zotero.HTTP.request("GET", modelsUrl(config), {
      headers,
      responseType: "json",
      timeout: 20000,
      errorDelayMax: 0,
    });
    return parseModelList(res.response);
  } catch (error) {
    throw new Error(describeHttpError(error), { cause: error });
  }
}

export type TestKind = "request" | "ok" | "warn" | "error" | "info";
export type TestOutcome = {
  chat: "ok" | "warn" | "error" | "cancelled";
  embed: "ok" | "error" | "skipped";
  chatDetail: string;
  embedDetail: string;
  ms: number;
};

const TEST_TIMEOUT_MS = 30000;

/** Send `Just reply "OK"`, then embed one short text, logging each step. */
export async function testConnection(
  config: ResolvedConfig,
  log: (kind: TestKind, text: string) => void,
  onCancelReady?: (cancel: () => void) => void,
): Promise<TestOutcome> {
  const started = Date.now();
  const outcome: TestOutcome = {
    chat: "ok",
    embed: "skipped",
    chatDetail: "",
    embedDetail: "",
    ms: 0,
  };
  let cancelled = false;
  let timedOut = false;
  let cancelChat: (() => void) | undefined;
  onCancelReady?.(() => {
    cancelled = true;
    cancelChat?.();
  });

  log("request", `POST ${chatUrl(config)}`);
  const setTimeout = ztoolkit.getGlobal("setTimeout");
  const clearTimeout = ztoolkit.getGlobal("clearTimeout");
  const timer = setTimeout(() => {
    timedOut = true;
    cancelChat?.();
  }, TEST_TIMEOUT_MS);
  try {
    const result = await streamChat(
      config,
      [{ role: "user", content: 'Just reply "OK"' }],
      () => {},
      (cancel) => (cancelChat = cancel),
    );
    if (result.aborted) {
      throw new Error(getString(timedOut ? "test-timeout" : "test-cancelled"));
    }
    const reply = result.text.trim();
    outcome.chatDetail = seconds(started);
    if (/\bok\b/i.test(reply)) {
      log(
        "ok",
        getString("test-chat-ok", {
          args: { seconds: outcome.chatDetail, model: config.model },
        }),
      );
    } else {
      outcome.chat = "warn";
      log(
        "warn",
        getString("test-chat-unexpected", {
          args: { reply: reply.slice(0, 120) || "∅" },
        }),
      );
    }
  } catch (error: any) {
    outcome.chat = cancelled ? "cancelled" : "error";
    outcome.chatDetail = error?.message || String(error);
    log(
      "error",
      getString("test-chat-error", { args: { message: outcome.chatDetail } }),
    );
  } finally {
    clearTimeout(timer);
  }
  if (cancelled) {
    outcome.ms = Date.now() - started;
    return outcome;
  }

  if (!config.embed.enabled) {
    log("info", getString("test-embed-off"));
  } else if (!embeddingsUrl(config)) {
    log("info", getString("test-embed-none"));
  } else {
    const embedStart = Date.now();
    log("request", `POST ${embeddingsUrl(config)}`);
    try {
      const [vector] = await embedTexts(config, ["测试文本"]);
      outcome.embed = "ok";
      outcome.embedDetail = seconds(embedStart);
      log(
        "ok",
        getString("test-embed-ok", {
          args: { dims: vector.length, seconds: outcome.embedDetail },
        }),
      );
    } catch (error: any) {
      outcome.embed = "error";
      outcome.embedDetail = error?.message || String(error);
      log(
        "error",
        getString("test-embed-error", {
          args: { message: outcome.embedDetail },
        }),
      );
    }
  }
  outcome.ms = Date.now() - started;
  return outcome;
}

function seconds(since: number) {
  return ((Date.now() - since) / 1000).toFixed(1);
}

/** Prefer the provider's own message ("invalid api key") over a bare status. */
function describeHttpError(error: any): string {
  const xhr = error?.xmlhttp as XMLHttpRequest | undefined;
  if (!xhr?.status) return error?.message || String(error);
  const detail = String(responseMessage(xhr)).trim().slice(0, 300);
  return `HTTP ${xhr.status}${detail ? `: ${detail}` : ""}`;
}

function responseMessage(xhr: XMLHttpRequest) {
  if (xhr.responseType === "json") {
    return xhr.response?.error?.message || xhr.response?.message || "";
  }
  const raw = xhr.responseText || "";
  try {
    const body = JSON.parse(raw);
    return body?.error?.message || body?.message || "";
  } catch {
    return raw;
  }
}

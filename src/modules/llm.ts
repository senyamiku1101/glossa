import { getPref } from "../utils/prefs";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function joinUrl(base: string, path: string) {
  const trimmed = base.replace(/\/+$/, "");
  if (/\/v1\/(chat\/completions|responses|embeddings)$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) return `${trimmed}${path.replace(/^\/v1/, "")}`;
  return `${trimmed}${path}`;
}

export function getChatUrl() {
  return joinUrl(String(getPref("api.url") || "https://api.openai.com"), "/v1/chat/completions");
}

export function getEmbedUrl() {
  const custom = String(getPref("embed.url") || "").trim();
  if (custom) return joinUrl(custom, "/v1/embeddings");
  return joinUrl(String(getPref("api.url") || "https://api.openai.com"), "/v1/embeddings");
}

export async function streamChat(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
): Promise<string> {
  const url = getChatUrl();
  const key = String(getPref("api.key") || "");
  const model = String(getPref("api.model") || "gpt-4o-mini");
  const temperature = Number(getPref("api.temperature") || "0.7");
  if (!key) throw new Error("Set an API key in Glossa preferences.");

  let assembled = "";
  await Zotero.HTTP.request("POST", url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      stream: true,
    }),
    responseType: "text",
    requestObserver: (xhr: XMLHttpRequest) => {
      xhr.onprogress = () => {
        assembled = parseSseContent(xhr.responseText || "");
        onDelta(assembled);
      };
    },
  });
  return assembled;
}

function parseSseContent(raw: string) {
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    const payload = line.replace(/^data:\s*/, "").trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      const piece =
        json.choices?.[0]?.delta?.content ||
        json.choices?.[0]?.message?.content ||
        "";
      if (piece) parts.push(piece);
    } catch {
      // ignore incomplete SSE chunks
    }
  }
  return parts.join("");
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const url = getEmbedUrl();
  const key = String(getPref("embed.key") || getPref("api.key") || "");
  const model = String(getPref("embed.model") || "text-embedding-3-small");
  if (!key) throw new Error("Set an embedding API key in Glossa preferences.");

  const batchSize = 16;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await Zotero.HTTP.request("POST", url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, input: batch }),
      responseType: "json",
    });
    const data = res.response?.data;
    if (!Array.isArray(data)) {
      throw new Error("Embedding API returned no vectors.");
    }
    vectors.push(
      ...data.map((row: { embedding: number[] }) => row.embedding),
    );
  }
  return vectors;
}

export function cosine(a: number[], b: number[]) {
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

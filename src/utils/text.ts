/**
 * Pure string/number helpers. Nothing here may touch Zotero globals or
 * import other modules: scripts/check-logic.mjs loads this file on its own
 * under plain Node to test the real code.
 */

export const TEMPLATE_KEYS = [
  "input",
  "selection",
  "abstract",
  "title",
  "authors",
  "year",
  "related",
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export type ContextPack = Record<TemplateKey, string>;

const PLACEHOLDER = new RegExp(
  `\\{\\{\\s*(${TEMPLATE_KEYS.join("|")})\\s*\\}\\}`,
  "g",
);

export function interpolate(template: string, pack: Partial<ContextPack>) {
  return template.replace(
    PLACEHOLDER,
    (_match, key: TemplateKey) => pack[key] || "",
  );
}

/** Placeholders a template actually uses, so costly ones can be skipped. */
export function templateKeys(template: string) {
  const keys = new Set<TemplateKey>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    keys.add(match[1] as TemplateKey);
  }
  return keys;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
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

export const CHUNK_SIZE = 1000;

/**
 * Split text into chunks of at most `size` characters, breaking at sentence
 * ends where possible. Line breaks are ignored on purpose: PDF extractors
 * disagree on where they put them, and chunk sizes should not depend on that.
 */
export function splitText(text: string, size = CHUNK_SIZE) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const sentences = flat.split(/(?<=[.!?;。！？；])\s+|(?<=[。！？；])/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    for (let i = 0; i < sentence.length; i += size) {
      const piece = sentence.slice(i, i + size);
      if (current && current.length + 1 + piece.length > size) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current} ${piece}` : piece;
    }
  }
  // A short tail is usually a page footer or reference stub; keep it with
  // the chunk before it instead of letting it rank on its own.
  if (current.length < 80 && chunks.length) {
    chunks[chunks.length - 1] += ` ${current}`;
  } else if (current) {
    chunks.push(current);
  }
  return chunks;
}

const FALLBACK_COLOR = "#6b7280";

/** Tag colours come from user prefs and end up in inline styles. */
export function sanitizeColor(color: unknown) {
  return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)
    ? color
    : FALLBACK_COLOR;
}

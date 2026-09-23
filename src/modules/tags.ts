import { clearPref, getPref, setPref } from "../utils/prefs";
import { sanitizeColor } from "../utils/text";

export type CommandTag = {
  name: string;
  color: string;
  template: string;
};

const DEFAULT_TAGS: CommandTag[] = [
  {
    name: "AskPDF",
    color: "#0EA293",
    template: `You are a research assistant. Use only the context below. Cite snippets with [n].

Context:
{{related}}

Selection:
{{selection}}

Question:
{{input}}

Answer in the user's language.`,
  },
  {
    name: "Translate",
    color: "#D14D72",
    template: `Translate into Simplified Chinese. Keep technical terms.

{{selection}}
{{input}}`,
  },
  {
    name: "Summarize",
    color: "#8e44ad",
    template: `Summarize this paper for a researcher in 8 bullets, then list 3 follow-up questions.

Title: {{title}}
Authors: {{authors}} ({{year}})
Abstract: {{abstract}}
Related excerpts:
{{related}}`,
  },
  {
    name: "AskAbstract",
    color: "#159895",
    template: `Based on this abstract, answer the question. If the abstract is insufficient, say so.

Title: {{title}}
Abstract:
{{abstract}}

Question:
{{input}}`,
  },
];

/**
 * An unset pref means "use the defaults"; "[]" means the user removed every
 * tag and is respected.
 */
export function getTags(): CommandTag[] {
  const raw = String(getPref("tags") || "").trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.flatMap((value) => {
          const tag = normalizeTag(value);
          return tag ? [tag] : [];
        });
      }
    } catch {
      ztoolkit.log("[Glossa] tags pref is not valid JSON; using defaults");
    }
  }
  return DEFAULT_TAGS.map((tag) => ({ ...tag }));
}

export function saveTags(tags: CommandTag[]) {
  setPref("tags", JSON.stringify(tags));
}

export function resetTags() {
  clearPref("tags");
}

function normalizeTag(value: unknown): CommandTag | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { name, color, template } = value as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim()) return undefined;
  if (typeof template !== "string") return undefined;
  return { name: name.trim(), color: sanitizeColor(color), template };
}

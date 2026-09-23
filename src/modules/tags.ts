import { getPref, setPref } from "../utils/prefs";
import { collectContext, interpolate } from "./context";

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

export function getTags(): CommandTag[] {
  try {
    const raw = String(getPref("tags") || "[]");
    const parsed = JSON.parse(raw) as CommandTag[];
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // fall through
  }
  saveTags(DEFAULT_TAGS);
  return DEFAULT_TAGS;
}

export function saveTags(tags: CommandTag[]) {
  setPref("tags", JSON.stringify(tags));
}

export async function renderTag(tag: CommandTag, input: string) {
  const pack = await collectContext(input);
  return interpolate(tag.template, pack).trim();
}

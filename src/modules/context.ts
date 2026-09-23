import { getPref } from "../utils/prefs";
import { asItem, selectedTabID } from "../utils/reader";
import { cosine, embedTexts } from "./llm";
import { getPDFPlainText, getPDFSelection } from "./pdf";

export type ContextPack = {
  input: string;
  selection: string;
  abstract: string;
  title: string;
  authors: string;
  year: string;
  related: string;
};

export { getPDFSelection };

export async function collectContext(input: string): Promise<ContextPack> {
  const item = getPrimaryItem();
  const selection = getPDFSelection();
  const abstract = String(item?.getField("abstractNote") || "");
  const title = String(item?.getDisplayTitle() || "");
  const year = String(item?.getField("year") || "");
  const authors = (item?.getCreators() || [])
    .map((c) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
    .filter(Boolean)
    .join(", ");

  let related = "";
  try {
    related = await getRelatedText(input || selection || title);
  } catch (error) {
    ztoolkit.log("[Glossa] related text failed", error);
  }

  return {
    input,
    selection,
    abstract,
    title,
    authors,
    year,
    related,
  };
}

export function interpolate(template: string, pack: ContextPack) {
  return template.replace(
    /\{\{\s*(input|selection|abstract|title|authors|year|related)\s*\}\}/g,
    (_match, key: keyof ContextPack) => pack[key] || "",
  );
}

function getPrimaryItem(): Zotero.Item | undefined {
  try {
    const selected = Zotero.getActiveZoteroPane()?.getSelectedItems?.() || [];
    if (selected[0]) {
      return selected[0].isAttachment()
        ? selected[0].parentItem || selected[0]
        : selected[0];
    }
  } catch {
    // pane may be unavailable
  }
  try {
    const reader = Zotero.Reader.getByTabID(selectedTabID());
    if (reader?.itemID) {
      const attachment = asItem(Zotero.Items.get(reader.itemID));
      return attachment?.parentItem || attachment;
    }
  } catch {
    // not in reader
  }
  return undefined;
}

async function getRelatedText(query: string): Promise<string> {
  const chunks = await collectChunks();
  if (!chunks.length) return "";
  const k = Math.max(1, Number(getPref("relatedNumber") || 5));
  if (chunks.length <= k || !query.trim()) {
    return formatChunks(chunks.slice(0, k));
  }

  try {
    const vectors = await embedTexts([query, ...chunks]);
    const qVec = vectors[0];
    const ranked = chunks
      .map((text, i) => ({ text, score: cosine(qVec, vectors[i + 1] || []) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return formatChunks(ranked.map((row) => row.text));
  } catch (error) {
    ztoolkit.log("[Glossa] embedding ranking failed, using keywords", error);
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3);
    const ranked = chunks
      .map((text) => ({
        text,
        score: words.filter((word) => text.toLowerCase().includes(word)).length,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return formatChunks(ranked.map((row) => row.text));
  }
}

async function collectChunks(): Promise<string[]> {
  const selection = getPDFSelection();
  if (selection.length > 40) return splitText(selection);

  const item = getPrimaryItem();
  if (!item) return [];

  const abstract = String(item.getField("abstractNote") || "");
  const attachment = item.isPDFAttachment()
    ? item
    : item
        .getAttachments()
        .map((id) => asItem(Zotero.Items.get(id)))
        .find((att) => att?.isPDFAttachment());

  if (attachment) {
    const pdfText = await getPDFPlainText(attachment);
    if (pdfText.trim()) return splitText(pdfText);
  }
  if (abstract) return splitText(abstract);
  return [];
}

export function splitText(text: string) {
  return text
    .replace(/\r/g, "\n")
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 40)
    .slice(0, 80);
}

function formatChunks(chunks: string[]) {
  return chunks.map((chunk, index) => `[${index + 1}] ${chunk}`).join("\n\n");
}

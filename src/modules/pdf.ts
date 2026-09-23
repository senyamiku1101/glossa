import { getActiveReader } from "../utils/reader";

export function getPDFSelection(): string {
  try {
    const reader = getActiveReader();
    if (!reader) return "";
    return String(ztoolkit.Reader.getSelectedText(reader) || "").trim();
  } catch {
    return "";
  }
}

/**
 * Full text via Zotero's PDF worker, the same path the fulltext indexer
 * uses. It reads the file from disk, so it works whether or not the PDF is
 * open, and needs no access to reader internals that change between
 * Zotero versions. Callers cache the result.
 */
export async function getPDFPlainText(
  attachment: Zotero.Item,
): Promise<string> {
  try {
    const full = await Zotero.PDFWorker.getFullText(attachment.id);
    return String(full?.text ?? full ?? "");
  } catch (error) {
    ztoolkit.log("[Glossa] PDFWorker.getFullText failed", error);
    return "";
  }
}

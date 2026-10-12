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

/**
 * Prefer Zotero's already indexed UTF-8 text for paragraph boundaries. Its
 * paragraph breaks are stable for the current attachment; re-extract only
 * when an index cache is unavailable.
 */
export async function getPDFParagraphSourceText(
  attachment: Zotero.Item,
): Promise<string> {
  try {
    const cacheFile = Zotero.FullText.getItemCacheFile(attachment);
    if (cacheFile.exists()) {
      const cached = await Zotero.File.getContentsAsync(cacheFile, "utf-8");
      if (typeof cached === "string" && cached.trim()) return cached;
    }
  } catch (error) {
    ztoolkit.log("[Glossa] PDF full-text cache unavailable", error);
  }
  return getPDFPlainText(attachment);
}

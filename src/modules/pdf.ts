import { selectedTabID } from "../utils/reader";

export function getPDFSelection(): string {
  try {
    const reader = Zotero.Reader.getByTabID(selectedTabID());
    if (!reader) return "";
    return String(ztoolkit.Reader.getSelectedText(reader) || "").trim();
  } catch {
    return "";
  }
}

export async function getPDFPlainText(attachment: Zotero.Item): Promise<string> {
  const fromReader = await readOpenReaderText(attachment.id);
  if (fromReader.trim()) return fromReader;

  try {
    const worker = (Zotero as any).PDFWorker;
    if (worker?.getFullText) {
      const full = await worker.getFullText(attachment.id);
      const text = String(full?.text || full || "");
      if (text.trim()) return text;
    }
  } catch (error) {
    ztoolkit.log("[Glossa] PDFWorker.getFullText failed", error);
  }

  return "";
}

async function readOpenReaderText(itemID: number): Promise<string> {
  try {
    const reader = Zotero.Reader.getByTabID(selectedTabID());
    if (!reader || reader.itemID !== itemID) return "";
    const win = reader._iframeWindow as any;
    const app =
      win?.wrappedJSObject?.PDFViewerApplication || win?.PDFViewerApplication;
    if (!app) return "";
    await app.pdfLoadingTask.promise;
    await app.pdfViewer.pagesPromise;
    const pages = app.pdfViewer._pages || [];
    const parts: string[] = [];
    for (const pageView of pages) {
      const pdfPage = pageView?.pdfPage;
      if (!pdfPage) continue;
      const content = await pdfPage.getTextContent();
      const line = (content.items || [])
        .map((item: { str?: string }) => item.str || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (line) parts.push(line);
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

export type PdfParagraphResult =
  | {
      kind: "ready";
      text: string;
      fromSelection?: true;
      /** True when the paragraph came from the paper's prepared Markdown map. */
      fromMarkdown?: true;
      /** Number of natural paragraphs, present only when more than one;
       * they are separated by blank lines in `text`. */
      paragraphs?: number;
    }
  | {
      kind: "unavailable" | "unmatched" | "too-long";
      detail?: string;
      /** The selection spans paragraphs and one of their boundaries (or the
       * selected text between them) could not be confirmed. */
      multiParagraph?: true;
    };

export function paragraphFailureStatus(
  result: Exclude<PdfParagraphResult, { kind: "ready" }>,
) {
  if (result.multiParagraph)
    return {
      messageId:
        result.kind === "too-long"
          ? "selection-paragraph-too-long"
          : "selection-paragraph-multi-unmatched",
      detail: result.detail,
    };
  if (
    result.kind === "unmatched" &&
    result.detail === "selection-crosses-paragraph-boundary"
  )
    return { messageId: "selection-paragraph-crosses-boundary" };
  return {
    messageId: "selection-paragraph-" + result.kind,
    detail: result.detail,
  };
}

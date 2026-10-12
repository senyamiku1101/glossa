export type PdfParagraphResult =
  | {
      kind: "ready";
      text: string;
      fromSelection?: true;
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

const MAX_PARAGRAPH_CHARS = 16000;
// PDF text caches sometimes flatten an entire section into one line. In that
// case a short selection must not cause thousands of unrelated characters to
// be sent as "this paragraph".
const MAX_UNCONFIRMED_CHARS = 2000;
const MAX_UNCONFIRMED_GROWTH = 2.5;
const MAX_INTERRUPTION_LINES = 24;

type PdfLine = { text: string; page: number };

/**
 * Zotero's indexed PDF text usually keeps a paragraph on one line. Columns,
 * figures and page furniture can interrupt it, so join only fragments with a
 * clear continuation across those boundaries.
 */
export async function getPdfParagraph(
  selection: string,
  pageIndex: number | undefined,
  readFullText: () => Promise<string>,
): Promise<PdfParagraphResult> {
  const text = await readFullText();
  return getPdfParagraphFromText(text, selection, pageIndex);
}

export function getPdfParagraphFromText(
  fullText: string,
  selection: string,
  pageIndex?: number,
): PdfParagraphResult {
  if (!fullText.trim()) return { kind: "unavailable" };
  const wanted = normalized(selection);
  if (!wanted) return { kind: "unmatched" };

  const pages = fullText.split("\f");
  const lines: PdfLine[] = pages.flatMap((page, pageNumber) => {
    const rows = page.split(/\r?\n/).map((text) => text.trim());
    // Empty rows inside a page separate paragraphs; only trim page-edge
    // empties so a paragraph can still continue across a page break.
    while (rows[0] === "") rows.shift();
    while (rows.at(-1) === "") rows.pop();
    return rows.map((text) => ({ text, page: pageNumber }));
  });
  const pageAvailable =
    pages.length > 1 &&
    pageIndex !== undefined &&
    pageIndex >= 0 &&
    pageIndex < pages.length;
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        (!pageAvailable || line.page === pageIndex) &&
        !isInterruption(line.text) &&
        normalized(line.text).includes(wanted),
    );
  if (matches.length !== 1) return { kind: "unmatched" };

  const fragments = [matches[0].line.text];
  let first = matches[0].index;
  let last = first;
  while (true) {
    const before = adjacentContent(lines, first, -1);
    if (before === undefined || !continues(lines[before], lines[first])) break;
    fragments.unshift(lines[before].text);
    first = before;
  }
  while (true) {
    const after = adjacentContent(lines, last, 1);
    if (after === undefined || !continues(lines[last], lines[after])) break;
    fragments.push(lines[after].text);
    last = after;
  }
  const paragraph = fragments.reduce((joined, fragment) =>
    joined.endsWith("-")
      ? joined.slice(0, -1) + fragment
      : joined + " " + fragment,
  );
  // Even a candidate under 2,000 characters can contain adjacent paragraphs:
  // Zotero's cache joins them into one line in the reported PDF. If the user
  // already selected a sentence-complete block, do not expand it to that line.
  const completeSelection = selectedParagraph(selection);
  if (
    completeSelection &&
    normalized(paragraph).length >
      wanted.length + Math.max(80, wanted.length * 0.12)
  ) {
    return { kind: "ready", text: completeSelection, fromSelection: true };
  }
  if (paragraph.length > MAX_PARAGRAPH_CHARS) return { kind: "too-long" };
  if (
    paragraph.length > MAX_UNCONFIRMED_CHARS &&
    normalized(paragraph).length > wanted.length * MAX_UNCONFIRMED_GROWTH
  ) {
    return { kind: "too-long" };
  }
  return { kind: "ready", text: paragraph };
}

function selectedParagraph(selection: string) {
  if (/\n\s*\n/.test(selection)) return undefined;
  const text = selection
    .replace(/(\p{L})-\s*\r?\n\s*(\p{Ll})/gu, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (
    text.length < 250 ||
    !/^[\p{Lu}\p{Lo}“"‘'（(]/u.test(text) ||
    !/[.!?。！？]["'”’）)\]]*$/.test(text) ||
    (text.match(/[.!?。！？](?=\s|$)/g) || []).length < 2
  ) {
    return undefined;
  }
  return text;
}

function adjacentContent(lines: PdfLine[], index: number, step: -1 | 1) {
  let skipped = 0;
  for (
    let next = index + step;
    next >= 0 && next < lines.length;
    next += step
  ) {
    if (Math.abs(lines[next].page - lines[index].page) > 1) break;
    if (!lines[next].text) break; // An internal blank line is a hard boundary.
    if (
      !isInterruption(lines[next].text) &&
      !(skipped > 0 && isFigureMaterial(lines[next].text))
    )
      return next;
    if (++skipped > MAX_INTERRUPTION_LINES) break;
  }
  return undefined;
}

function continues(before: PdfLine, after: PdfLine) {
  return (
    after.page - before.page <= 1 &&
    before.text.length >= 15 &&
    !/[.!?:。！？：]["'”’）)\]]*$/.test(before.text) &&
    (/^\p{Ll}/u.test(after.text) ||
      (/\b(?:and|or|at|of|to|from|between)\s*$/i.test(before.text) &&
        /^[\p{L}\p{N}]/u.test(after.text)))
  );
}

function isInterruption(text: string) {
  return /^(?:fig\.\s*\d|table\s*\d|\d+\s*\/\s*preprint\b|journal of\b|accepted\s*manuscript|copyright\b|downloaded from\b|doi:)/i.test(
    text,
  );
}

function isFigureMaterial(text: string) {
  return (
    text.length < 180 &&
    !(/[.!?]\s+\p{Lu}/u.test(text) && text.length > 40) &&
    ((text.length < 15 && !/\s/.test(text)) ||
      /^[\p{S}\p{N}(]/u.test(text) ||
      (/=/.test(text) && !/[.!?]\s/.test(text)) ||
      /^[A-Z\s]+$/.test(text))
  );
}
function normalized(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

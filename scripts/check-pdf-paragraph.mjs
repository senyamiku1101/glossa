/* global console, URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function load(path, globals = {}) {
  const source = await readFile(new URL("../" + path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: () => ({ getActiveReader: () => undefined }),
    ...globals,
  });
  return module.exports;
}

const { getPdfParagraph, getPdfParagraphFromText, paragraphFailureStatus } =
  await load("src/modules/pdfParagraph.ts");
const crossingStatus = paragraphFailureStatus({
  kind: "unmatched",
  detail: "selection-crosses-paragraph-boundary",
});
assert.equal(crossingStatus.messageId, "selection-paragraph-crosses-boundary");
assert.equal(crossingStatus.detail, undefined);
const mismatchStatus = paragraphFailureStatus({
  kind: "unmatched",
  detail: "selection-text-mismatch",
});
assert.equal(mismatchStatus.messageId, "selection-paragraph-unmatched");
assert.equal(mismatchStatus.detail, "selection-text-mismatch");
assert.equal(
  paragraphFailureStatus({ kind: "unavailable" }).messageId,
  "selection-paragraph-unavailable",
);
for (const locale of ["zh-CN", "en-US"]) {
  const messages = await readFile(
    new URL(`../addon/locale/${locale}/addon.ftl`, import.meta.url),
    "utf8",
  );
  assert.match(messages, /^selection-paragraph-crosses-boundary = /m);
}

const paragraph =
  "For several years, reducing the length of engine inlets has been recognized " +
  "as an optimization strategy. Shorter inlets improve fuel efficiency.";
const source = [
  "Abstract",
  "A repeated phrase belongs to the abstract.",
  "\f",
  "1 Introduction",
  paragraph,
  "A second paragraph about fan stability.",
  "\f",
  "2 Method",
  "A repeated phrase belongs to the method.",
].join("\n");

const found = getPdfParagraphFromText(
  source,
  "reducing the length of engine inlets",
  1,
);
assert.equal(found.kind, "ready");
assert.equal(found.text, paragraph);
assert.doesNotMatch(found.text, /Introduction|fan stability/);
assert.equal(
  (
    await getPdfParagraph(
      "Shorter inlets improve fuel efficiency.",
      1,
      async () => source,
    )
  ).text,
  paragraph,
);
assert.equal(
  getPdfParagraphFromText(source, "A repeated phrase", 2).text,
  "A repeated phrase belongs to the method.",
);
assert.equal(
  getPdfParagraphFromText(source, "A repeated phrase").kind,
  "unmatched",
);
assert.equal(
  getPdfParagraphFromText(source, "length of engine inlets", 2).kind,
  "unmatched",
);
assert.equal(
  getPdfParagraphFromText(
    source,
    "Shorter inlets improve fuel efficiency. A second paragraph",
    1,
  ).kind,
  "unmatched",
);
assert.equal(getPdfParagraphFromText("", "engine inlets").kind, "unavailable");
assert.equal(
  getPdfParagraphFromText("A" + "x".repeat(16000) + " sample.", "sample.").kind,
  "too-long",
);
// Internal blank lines are paragraph breaks even when the preceding line
// lacks a period (common in imperfect PDF text extraction).
const blankSeparated =
  "The pressure plateau extends downstream\n\n" +
  "another paragraph begins with a lowercase word.";
assert.equal(
  getPdfParagraphFromText(blankSeparated, "pressure plateau").text,
  "The pressure plateau extends downstream",
);
// Some cache files flatten an entire section into a single very long line.
// A highlighted paragraph within it must not claim the whole section.
const selectedParagraph =
  "In the downstream region, the flow undergoes a significant deceleration " +
  "before forming a pressure plateau. This is evident in both configurations.";
const flattenedSection =
  selectedParagraph + " Further discussion of the experiments.".repeat(160);
assert.equal(
  getPdfParagraphFromText(flattenedSection, selectedParagraph).kind,
  "too-long",
);
// The reported INFRa PDF has this shape: the previous paragraph ends, the
// highlighted paragraph starts and ends, then the next one starts, all on the
// same cache line. Neither punctuation nor line breaks delimit that paragraph.
const flattenedNeighbors =
  "The earlier discussion ends with a result. " +
  selectedParagraph +
  " Experimental observations begin a different paragraph.".repeat(110);
assert.equal(
  getPdfParagraphFromText(flattenedNeighbors, selectedParagraph).kind,
  "too-long",
);
// In the reported screenshot the user had already highlighted all sentences
// of the visual paragraph. Use those exact words, not the glued cache line.
const wholeSelection =
  selectedParagraph +
  " The initial results support this conclusion.".repeat(10);
const gluedPage =
  "The earlier discussion ends with a result. " +
  wholeSelection +
  " Experimental observations begin another paragraph.".repeat(90);
const selectedResult = getPdfParagraphFromText(gluedPage, wholeSelection);
assert.equal(selectedResult.kind, "ready");
assert.equal(selectedResult.fromSelection, true);
assert.equal(selectedResult.text, wholeSelection);
// The second reported PDF page has a shorter, ~1,664-character cache line:
// the previous paragraph, the selected one and the next all share one line.
const middleSelection =
  "However, the two measurements differ under crosswind conditions. " +
  "The measured response shows a change in the downstream flow. ".repeat(9) +
  "The response remains transient upstream of the rotor.";
const gluedShortLine =
  "Earlier, the numerical results aligned under clean inflow. ".repeat(5) +
  middleSelection +
  " Subsequent measurements provide additional evidence.".repeat(6);
assert.ok(gluedShortLine.length < 2000);
const middleResult = getPdfParagraphFromText(gluedShortLine, middleSelection);
assert.equal(middleResult.kind, "ready");
assert.equal(middleResult.fromSelection, true);
assert.equal(middleResult.text, middleSelection);
assert.equal(
  getPdfParagraphFromText(gluedPage, wholeSelection.slice(0, -10)).kind,
  "too-long",
  "an incomplete selection must not be presented as a complete paragraph",
);
// A genuinely long selection still matches itself instead of being rejected
// merely because the paragraph exceeds the conservative threshold.
const longSelection =
  "A detailed result " + "remains consistent ".repeat(130) + "at the exit.";
assert.equal(
  getPdfParagraphFromText(longSelection, longSelection).text,
  longSelection,
);

const interrupted = [
  "3 Numerical Setup",
  "In addition to the experimental investigation, the outer geometry is assumed to remain",
  "Fig. 9 Numerical setup",
  "constant. Internally, the structure is omitted and the result has a temporal",
  "Journal of Turbomachinery PREPRINT FOR REVIEW / 5",
  "AcceptedManuscriptNotCopyedited",
  "Downloaded from the publisher by a university user",
  "\fresolution that was verified with experiments. This closes the paragraph.",
  "A new paragraph begins here.",
].join("\n");
const wholeParagraph =
  "In addition to the experimental investigation, the outer geometry is assumed to remain " +
  "constant. Internally, the structure is omitted and the result has a temporal " +
  "resolution that was verified with experiments. This closes the paragraph.";
assert.equal(
  getPdfParagraphFromText(interrupted, "outer geometry is assumed", 0).text,
  wholeParagraph,
);
assert.equal(
  getPdfParagraphFromText(interrupted, "the structure is omitted", 0).text,
  wholeParagraph,
);
assert.equal(
  getPdfParagraphFromText(interrupted, "verified with experiments", 1).text,
  wholeParagraph,
);
assert.doesNotMatch(wholeParagraph, /Fig\. 9|Journal of|new paragraph/);
const numericalContinuation = [
  "Initially, the intake response was measured at each test condition",
  "along the circumference. The greater wall distance at θ = 45° and",
  "135° does not change the Mach number. In the aspirated",
  "6 / PREPRINT FOR REVIEW Transactions of the ASME",
  "AcceptedManuscriptNotCopyedited",
  "Downloaded from the publisher by a university user",
  "\fπ",
  "RANS, vcw = 0kts EXP, vcw = 10kts",
  "(a) Overview of the operational area.",
  "Fig. 10 Fan map and crosswind response.",
  "AIP",
  "vcw=38 kts",
  "Fig. 11 Flow measurements across the intake.",
  "configuration, the flow returns to a plateau and increases to",
  "DC60,max = 0.481.",
  "A separate paragraph begins here.",
].join("\n");
const completeNumericalParagraph =
  "Initially, the intake response was measured at each test condition " +
  "along the circumference. The greater wall distance at θ = 45° and " +
  "135° does not change the Mach number. In the aspirated " +
  "configuration, the flow returns to a plateau and increases to " +
  "DC60,max = 0.481.";
for (const [selected, page] of [
  ["The greater wall distance", 0],
  ["135° does not change", 0],
  ["the flow returns to a plateau", 1],
]) {
  assert.equal(
    getPdfParagraphFromText(numericalContinuation, selected, page).text,
    completeNumericalParagraph,
  );
}
let workerCalls = 0;
const cacheZotero = {
  FullText: { getItemCacheFile: () => ({ exists: () => true }) },
  File: { getContentsAsync: async () => source },
  PDFWorker: {
    getFullText: async () => {
      workerCalls++;
      return { text: "Different extraction." };
    },
  },
};
const { getPDFParagraphSourceText } = await load("src/modules/pdf.ts", {
  Zotero: cacheZotero,
  ztoolkit: { log: () => {} },
});
assert.equal(await getPDFParagraphSourceText({ id: 1 }), source);
assert.equal(workerCalls, 0);
console.log(
  "PDF paragraph boundaries, page matching, and cache preference passed",
);

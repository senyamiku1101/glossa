/* global URL, console */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const { outputText } = ts.transpileModule(
  await readFile(
    new URL("../src/modules/pdfLayout.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
);
const module = { exports: {} };
runInNewContext(outputText, { module, exports: module.exports });
const { paragraphFromPageData, paragraphFromLayout, getPdfLayoutParagraph } =
  module.exports;
const row = (str, x, y, width = 475, extra = {}) => ({
  str,
  transform: [11, 0, 0, 11, x, y],
  width,
  ...extra,
});
const paragraphs = [
  [
    "The first paragraph introduces the acoustic wave propagation problem.",
    "Its evidence validates the propagation model and numerical assumptions.",
    "These independent observations conclude the first physical argument.",
  ],
  [
    "The second paragraph explains a different choice of coordinate system.",
    "This separate investigation discusses the eigenvector solution method.",
    "The second argument ends with a distinct and complete conclusion.",
  ],
  [
    "The third paragraph considers reflected waves and boundary conditions.",
    "Its evidence concerns the interaction between downstream acoustic waves.",
    "These final observations complete the third independent argument.",
  ],
];
const items = paragraphs.flatMap((lines, p) =>
  lines.map((text, n) =>
    row(
      text,
      n ? 55 : 67,
      750 - p * 60 - n * 18,
      n === 2 ? 390 : n ? 475 : 463,
    ),
  ),
);
const pageFromItems = (rows, shift = [0, 0]) => ({
  viewBox: [shift[0], shift[1], 595 + shift[0], 842 + shift[1]],
  chars: rows.flatMap((item) =>
    Array.from(item.str, (c, index) => ({
      c,
      fontSize: 11,
      baseline: item.transform[5] + shift[1],
      fontName: item.bold ? "Synthetic-Bold" : "Synthetic-Regular",
      rect: [
        item.transform[4] + (index * item.width) / item.str.length + shift[0],
        item.transform[5] + shift[1],
        item.transform[4] +
          ((index + 1) * item.width) / item.str.length +
          shift[0],
        item.transform[5] + 11 + shift[1],
      ],
      lineBreakAfter: index === item.str.length - 1,
    })),
  ),
});
const full = (first, last) =>
  paragraphs
    .slice(first, last)
    .map((lines) => lines.join(" "))
    .join("\n\n");
const selection =
  paragraphs[0][2].slice(20) + " " + paragraphs[1][0].slice(0, 42);
for (const read of [
  (text) => paragraphFromLayout(items, text, 595),
  (text) => paragraphFromPageData(pageFromItems(items), text),
  (text) => paragraphFromPageData(pageFromItems(items, [200, 30]), text),
]) {
  const two = read(selection);
  assert.equal(two.kind, "ready");
  assert.equal(two.paragraphs, 2);
  assert.equal(two.text, full(0, 2));
  const three = read(
    paragraphs[0][2] + " " + paragraphs[1].join(" ") + " " + paragraphs[2][0],
  );
  assert.equal(three.kind, "ready");
  assert.equal(three.paragraphs, 3);
  assert.equal(three.text, full(0, 3));
  const exactEnd = read(
    paragraphs[0].join(" ") + " " + paragraphs[1].join(" "),
  );
  assert.equal(exactEnd.text, full(0, 2));
  assert.notEqual(
    read(paragraphs[0][2] + " fabricated intervening text " + paragraphs[1][0])
      .kind,
    "ready",
  );
  assert.notEqual(
    read(paragraphs[0][2] + " " + paragraphs[2][0]).kind,
    "ready",
    "never silently skip a middle paragraph",
  );
}
// A native selection containing repeated words is resolved by its PDF position.
const repeatedItems = [
  ...items,
  ...items.map((item) => ({
    ...item,
    transform: [...item.transform.slice(0, 5), item.transform[5] - 230],
  })),
];
const repeated = pageFromItems(repeatedItems);
assert.notEqual(paragraphFromPageData(repeated, selection).kind, "ready");
const repeatedResult = paragraphFromPageData(repeated, selection, [
  [55, 714, 530, 725],
  [67, 690, 530, 701],
]);
assert.equal(repeatedResult.text, full(0, 2));
// Cross-page selection: include every selected raw character, even a caption
// between the last paragraph of one page and the first body line of the next.
const firstPageRows = paragraphs[0].map((text, n) =>
  row(text, n ? 55 : 67, 750 - n * 18, n === 2 ? 390 : 463),
);
const secondPageRows = [
  row("Figure 9. Independent diagram caption.", 55, 790, 360, { bold: true }),
  ...paragraphs
    .slice(1)
    .flatMap((lines, p) =>
      lines.map((text, n) =>
        row(text, n ? 55 : 67, 750 - p * 60 - n * 18, n === 2 ? 390 : 463),
      ),
    ),
];
const p0 = pageFromItems(firstPageRows),
  p1 = pageFromItems(secondPageRows);
const crossSelection =
  paragraphs[0][2].slice(20) +
  " Figure 9. Independent diagram caption. " +
  paragraphs[1][0].slice(0, 42);
const firstRects = [[55, 714, 445, 725]],
  nextRects = [
    [55, 790, 415, 801],
    [67, 750, 530, 761],
  ];
for (const cached of [true, false]) {
  const calls = [];
  const reader = {
    _internalReader: {
      _primaryView: {
        _pdfPages: cached ? { 0: p0, 1: p1 } : { 0: p0 },
        _iframeWindow: {
          PDFViewerApplication: {
            pdfDocument: {
              numPages: 2,
              getPageData: async ({ pageIndex }) => {
                calls.push(pageIndex);
                assert.equal(pageIndex, 1);
                return p1;
              },
              getPage: async () => {
                throw new Error(
                  "confirmed native range must not use text fallback",
                );
              },
            },
          },
        },
      },
    },
  };
  const result = await getPdfLayoutParagraph(
    reader,
    crossSelection,
    0,
    firstRects,
    nextRects,
  );
  assert.equal(result.kind, "ready");
  assert.equal(result.paragraphs, 2);
  assert.equal(result.text, full(0, 2));
  assert.deepEqual(calls, cached ? [] : [1]);
}
// A locally confirmed previous paragraph supplies the missing start of a
// flush first paragraph on the next page. It does not merge the two paragraphs
// and does not waive native selection coverage, display, or ending checks.
const flushItems = paragraphs[1].map((text, index) =>
  row(text, 55, 750 - index * 18, index === 2 ? 390 : 475),
);
const flushPage = pageFromItems(flushItems);
const provedPriorItems = paragraphs[0].map((text, index) =>
  row(
    text,
    index ? 55 : 67,
    750 - index * 18,
    index === 2 ? 390 : index ? 475 : 463,
  ),
);
const provedPriorPage = pageFromItems(provedPriorItems);
const flushCrossSelection =
  paragraphs[0][2].slice(20) + " " + paragraphs[1][0].slice(0, 42);
const flushRects = [[55, 750, 530, 761]];
for (const cached of [true, false]) {
  const calls = [];
  const result = await getPdfLayoutParagraph(
    {
      _internalReader: {
        _primaryView: {
          _pdfPages: cached ? { 0: provedPriorPage, 1: flushPage } : {},
          _iframeWindow: {
            PDFViewerApplication: {
              pdfDocument: {
                numPages: 2,
                getPageData: async ({ pageIndex }) => {
                  calls.push(pageIndex);
                  return pageIndex === 0 ? provedPriorPage : flushPage;
                },
                getPage: async () => {
                  throw new Error(
                    "proved native paragraphs must not fall back to text",
                  );
                },
              },
            },
          },
        },
      },
    },
    flushCrossSelection,
    0,
    firstRects,
    flushRects,
  );
  assert.equal(result.kind, "ready", JSON.stringify(result));
  assert.equal(result.paragraphs, 2);
  assert.equal(result.text, full(0, 2));
  assert.deepEqual(calls, cached ? [] : [0, 1]);
}
for (const [name, lastWidth] of [
  ["full-width period", 475],
  ["near-aligned period", 468.4],
]) {
  const priorRows = provedPriorItems.map((item) => ({ ...item }));
  priorRows.at(-1).width = lastWidth;
  const result = await getPdfLayoutParagraph(
    {
      _internalReader: {
        _primaryView: {
          _pdfPages: { 0: pageFromItems(priorRows), 1: flushPage },
        },
      },
    },
    flushCrossSelection,
    0,
    firstRects,
    flushRects,
  );
  assert.notEqual(
    result.kind,
    "ready",
    `${name} does not establish a prior paragraph boundary`,
  );
}
const omittedCurrent = await getPdfLayoutParagraph(
  {
    _internalReader: {
      _primaryView: { _pdfPages: { 0: provedPriorPage, 1: flushPage } },
    },
  },
  paragraphs[0][2].slice(20) + " " + paragraphs[1][1],
  0,
  firstRects,
  [[55, 732, 530, 743]],
);
assert.notEqual(
  omittedCurrent.kind,
  "ready",
  "a start proof cannot hide omitted intervening selected text",
);
const flushDisplayItems = [
  flushItems[0],
  row("alpha + beta = gamma", 160, 740, 200),
  ...flushItems.slice(1),
];
const flushDisplaySelection =
  paragraphs[0][2].slice(20) +
  " " +
  flushDisplayItems
    .slice(0, 3)
    .map((item) => item.str)
    .join(" ");
const flushDisplayResult = await getPdfLayoutParagraph(
  {
    _internalReader: {
      _primaryView: {
        _pdfPages: { 0: provedPriorPage, 1: pageFromItems(flushDisplayItems) },
      },
    },
  },
  flushDisplaySelection,
  0,
  firstRects,
  [
    [55, 750, 530, 761],
    [160, 740, 360, 751],
    [55, 732, 530, 743],
  ],
);
assert.notEqual(
  flushDisplayResult.kind,
  "ready",
  "a contextual start proof cannot waive selected display material",
);
// A confirmed first paragraph is not enough to send an unbounded later fragment.
const incompleteItems = [
  ...items.slice(0, 3),
  row(paragraphs[1][0], 67, 690, 463),
  row(
    "The next page is needed to confirm this unfinished second argument",
    55,
    672,
    475,
  ),
];
const incomplete = paragraphFromPageData(
  pageFromItems(incompleteItems),
  paragraphs[0][2] + " " + paragraphs[1][0],
);
assert.equal(incomplete.kind, "unmatched");
assert.equal(incomplete.multiParagraph, true);
assert.ok(incomplete.detail);
// An output limit applies to the full expanded range, not each paragraph only.
const longRows = [0, 1, 2].flatMap((p) =>
  [0, 1, 2].map((n) =>
    row(
      `Paragraph ${p} line ${n} provides unique analytic evidence ` +
        "acoustic observations ".repeat(130) +
        ".",
      n ? 55 : 67,
      750 - p * 60 - n * 18,
      n === 2 ? 390 : 463,
    ),
  ),
);
const tooLong = paragraphFromLayout(
  [
    ...longRows,
    row(
      "A subsequent paragraph begins outside the expanded long range.",
      67,
      566,
      460,
    ),
  ],
  longRows.map((r) => r.str).join(" "),
  595,
);
assert.equal(tooLong.kind, "too-long", JSON.stringify(tooLong));
assert.equal(tooLong.multiParagraph, true);
const withDisplay = [
  ...items.slice(0, 3),
  row(paragraphs[1][0], 67, 690, 463),
  row(
    "The numerical relation for the independent wave amplitudes is",
    55,
    672,
    470,
  ),
  row("alpha + beta = gamma", 160, 650, 200),
  row("(Eq. 12)", 480, 650, 50),
  ...items.slice(6).map((item) => ({
    ...item,
    transform: [...item.transform.slice(0, 5), item.transform[5] - 15],
  })),
];
const displaySelection = withDisplay
  .slice(2, 7)
  .map((item) => item.str)
  .join(" ");
assert.notEqual(
  paragraphFromLayout(withDisplay, displaySelection, 595).kind,
  "ready",
  "do not silently omit selected display equations and send incomplete sentences",
);
console.log(
  "PDF multi-paragraph: partial endpoints, lists, text/native data, crop, positions, cross-page fetch, incomplete/oversize/display rejection passed",
);

/* global URL, console */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(
  new URL("../src/modules/pdfLayout.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
runInNewContext(outputText, { module, exports: module.exports });
const {
  paragraphFromLayout,
  paragraphAcrossNextPage,
  paragraphAcrossPreviousPage,
  paragraphFromPageData,
  getPdfLayoutParagraph,
} = module.exports;

const items = [];
function line(x, y, str) {
  items.push({
    str,
    transform: [9, 0, 0, 9, x, y],
    width: str.length * 4,
  });
}
// Two columns at the same baselines must never be joined. The right column's
// full-text cache flattens the three visual paragraphs into a single line.
for (let i = 0; i < 18; i++)
  line(59.8, 710 - i * 10, `Left column sample body text ${i}`);
line(
  69.7,
  527,
  "Figure 15 illustrates the capability of steady state simulations",
);
line(312.4, 770, "Fig. 14 Plot caption from another text block");
line(312.4, 760, "comparison of numerical and experimental values");
line(
  312.4,
  710,
  "and transient simulations in predicting the aerodynamic behavior.",
);
line(312.4, 700, "The numerical results were compared against measurements.");
line(312.4, 690, "For clean inflow, they aligned with the observations.");
line(312.4, 680, "The isentropic Mach number differed near the intake.");
line(312.4, 670, "between the inlet and the rotor.");
line(
  322.3,
  657,
  "However, as crosswind conditions increase, the simulations do",
);
line(
  312.4,
  647,
  "not fully capture the complex intake aerodynamics, although they",
);
line(
  312.4,
  637,
  "reproduce the general trends. The suction peak is overpredicted.",
);
line(
  312.4,
  627,
  "Further downstream the numerical results indicate a plateau,",
);
line(
  312.4,
  617,
  "while experimental data reveals a continuously decelerating flow.",
);
line(312.4, 607, "Steady state simulations show convergence problems.");
line(587.6, 609, "Downloaded from publisher on this date");
line(
  312.4,
  597,
  "Time-resolved measurements show transient behavior upstream of",
);
line(312.4, 587, "the rotor, cf. Fig. 16.");
line(322.3, 574, "The noise component in the Kulite signal is significant.");
line(312.4, 564, "A separate paragraph continues below.");
const expectedStart = "However, as crosswind conditions increase";
for (const fragment of [
  expectedStart,
  "experimental data reveals",
  "plateau while experimental",
  "convergence problems",
]) {
  const result = paragraphFromLayout(items, fragment, 612);
  assert.equal(result.kind, "ready", fragment);
  assert.ok(result.text.startsWith(expectedStart), fragment);
  assert.ok(result.text.endsWith("the rotor, cf. Fig. 16."), fragment);
  assert.ok(!result.text.includes("and transient simulations"), fragment);
  assert.ok(!result.text.includes("Kulite"), fragment);
  assert.ok(!result.text.includes("Downloaded from"), fragment);
}
for (const fragment of [
  "Figure 15 illustrates the capability",
  "and transient simulations",
]) {
  const result = paragraphFromLayout(items, fragment, 612);
  assert.equal(result.kind, "ready", fragment);
  assert.ok(result.text.startsWith("Figure 15 illustrates"), fragment);
  assert.ok(result.text.endsWith("between the inlet and the rotor."), fragment);
  assert.ok(!result.text.includes("Plot caption"), fragment);
  assert.ok(!result.text.includes("However,"), fragment);
}
assert.equal(
  paragraphFromLayout(items, "not a unique selection", 612).kind,
  "unmatched",
);
const reader = {
  _internalReader: {
    _primaryView: {
      _iframeWindow: {
        PDFViewerApplication: {
          pdfDocument: {
            numPages: 8,
            getPage: async (pageNumber) => {
              assert.equal(pageNumber, 8);
              return {
                view: [0, 0, 612, 810],
                getTextContent: async () => ({ items }),
              };
            },
          },
        },
      },
    },
  },
};
const fromReader = await getPdfLayoutParagraph(
  reader,
  "experimental data reveals",
  7,
);
assert.equal(fromReader.kind, "ready");
assert.ok(fromReader.text.startsWith(expectedStart));
// Runtime-shaped structured chars (the current Zotero _pdfPages cache).
const chars = items.flatMap((item) =>
  [...item.str].map((c, index) => ({
    c,
    rect: [
      item.transform[4] + index * 4,
      item.transform[5],
      item.transform[4] + (index + 1) * 4,
      item.transform[5] + 9,
    ],
    lineBreakAfter: index === item.str.length - 1,
  })),
);
const pageData = { chars, viewBox: [0, 0, 612, 810] };
const cachedReader = {
  _internalReader: { _primaryView: { _pdfPages: { 7: pageData } } },
};
const cachedResult = await getPdfLayoutParagraph(
  cachedReader,
  "experimental data reveals",
  7,
);
assert.equal(cachedResult.kind, "ready");
assert.ok(cachedResult.text.startsWith(expectedStart));
// A window Xray may hide PDFViewerApplication; use wrappedJSObject.
let nativeCalls = 0;
const wrappedReader = {
  _internalReader: {
    _primaryView: {
      _iframeWindow: {
        wrappedJSObject: {
          Object,
          PDFViewerApplication: {
            pdfDocument: {
              numPages: 8,
              getPageData: async ({ pageIndex }) => {
                nativeCalls++;
                assert.equal(pageIndex, 7);
                return pageData;
              },
              getPage: async () => {
                throw new Error("getTextContent unavailable");
              },
            },
          },
        },
      },
    },
  },
};
const wrappedResult = await getPdfLayoutParagraph(
  wrappedReader,
  "experimental data reveals",
  7,
);
assert.equal(wrappedResult.kind, "ready");
assert.equal(nativeCalls, 1);
// Real Zotero: pdfDocument.getPageData is a privileged API that rejects an
// object passed from the plugin compartment ("Permission denied to pass
// object to privileged code"). Zotero's own _ensureBasicPageData runs inside
// the reader iframe and does not cross that boundary — prefer it.
{
  const pdfPages = {};
  const privilegedReader = {
    _internalReader: {
      _primaryView: {
        _pdfPages: pdfPages,
        _ensureBasicPageData: async (index) => {
          pdfPages[index] = pageData;
        },
        _iframeWindow: {
          wrappedJSObject: {
            Object,
            PDFViewerApplication: {
              pdfDocument: {
                numPages: 8,
                getPageData: async () => {
                  throw new Error(
                    "Permission denied to pass object to privileged code",
                  );
                },
                getPage: async () => {
                  throw new Error("getTextContent unavailable");
                },
              },
            },
          },
        },
      },
    },
  };
  const result = await getPdfLayoutParagraph(
    privilegedReader,
    "experimental data reveals",
    7,
  );
  assert.equal(result.kind, "ready", JSON.stringify(result));
  assert.ok(result.text.startsWith(expectedStart));
}
// The permission error previously fired even earlier: reading
// _iframeWindow/PDFViewerApplication threw, aborting the view before
// _ensureBasicPageData could run. Cross-boundary reads must be isolated so the
// iframe-side loader still works.
{
  const pdfPages = {};
  const hostileWindow = {
    get wrappedJSObject() {
      throw new Error("Permission denied to pass object to privileged code");
    },
    get PDFViewerApplication() {
      throw new Error("Permission denied to pass object to privileged code");
    },
  };
  const hostileReader = {
    _internalReader: {
      _primaryView: {
        _pdfPages: pdfPages,
        _ensureBasicPageData: async (index) => {
          pdfPages[index] = pageData;
        },
        _iframeWindow: hostileWindow,
      },
    },
  };
  const result = await getPdfLayoutParagraph(
    hostileReader,
    "experimental data reveals",
    7,
  );
  assert.equal(result.kind, "ready", JSON.stringify(result));
  assert.ok(result.text.startsWith(expectedStart));
}
const missing = await getPdfLayoutParagraph(
  { _internalReader: {} },
  "experimental data reveals",
  7,
);
assert.equal(missing.kind, "unavailable");
assert.equal(missing.detail, "reader-view-missing");
const pageWith = (rows) => ({
  viewBox: [0, 0, 612, 810],
  chars: rows.flatMap(([x, y, text]) =>
    [...text].map((c, index) => ({
      c,
      rect: [x + index * 4, y, x + (index + 1) * 4, y + 8],
      lineBreakAfter: index === text.length - 1,
    })),
  ),
});
const precedingPage = pageWith([
  [312, 460, "An earlier paragraph ends on the right side of this page."],
  [322, 447, "The noise component in the pressure signal is significant,"],
  [312, 437, "and is confirmed by subsequent numer-"],
]);
const followingPage = pageWith([
  [59, 700, "Fig. 16 Caption above the continued paragraph"],
  [59, 690, "isolated plot legend on this page"],
  [59, 650, "ical studies conducted on a different experimental sample,"],
  [59, 640, "which provide a reliable comparison of the flow features"],
  [59, 630, "and reproduce the expected behavior of the intake."],
  [69, 617, "The next indented paragraph starts separately here."],
  [59, 607, "Further independent discussion continues below."],
]);
const crossPage = paragraphAcrossNextPage(
  precedingPage,
  followingPage,
  "The noise component in the pressure signal",
);
assert.equal(crossPage.kind, "ready");
assert.ok(crossPage.text.startsWith("The noise component"));
assert.ok(crossPage.text.endsWith("behavior of the intake."));
assert.ok(!crossPage.text.includes("Fig. 16"));
assert.ok(!crossPage.text.includes("The next indented"));
assert.equal(
  paragraphAcrossNextPage(
    precedingPage,
    followingPage,
    "An earlier paragraph ends",
  ).kind,
  "unmatched",
);
const joinedCachedReader = {
  _internalReader: {
    _primaryView: { _pdfPages: { 7: precedingPage, 8: followingPage } },
  },
};
assert.equal(
  (
    await getPdfLayoutParagraph(
      joinedCachedReader,
      "The noise component in the pressure signal",
      7,
    )
  ).kind,
  "ready",
);
let nextPageCalls = 0;
const joinedFetchedReader = {
  _internalReader: {
    _primaryView: {
      _pdfPages: { 7: precedingPage },
      _iframeWindow: {
        PDFViewerApplication: {
          pdfDocument: {
            numPages: 9,
            getPageData: async ({ pageIndex }) => {
              if (pageIndex === 8) {
                nextPageCalls++;
                return followingPage;
              }
              return precedingPage;
            },
            getPage: async () => {
              throw new Error("unneeded text API");
            },
          },
        },
      },
    },
  },
};
assert.equal(
  (
    await getPdfLayoutParagraph(
      joinedFetchedReader,
      "The noise component in the pressure signal",
      7,
    )
  ).kind,
  "ready",
);
assert.equal(nextPageCalls, 1);
const previousPageResult = paragraphAcrossPreviousPage(
  precedingPage,
  followingPage,
  "which provide a reliable comparison",
);
assert.equal(previousPageResult.kind, "ready");
assert.equal(previousPageResult.text, crossPage.text);
const previousCachedReader = {
  _internalReader: {
    _primaryView: { _pdfPages: { 7: precedingPage, 8: followingPage } },
  },
};
assert.equal(
  (
    await getPdfLayoutParagraph(
      previousCachedReader,
      "which provide a reliable comparison",
      8,
    )
  ).text,
  crossPage.text,
);
let previousPageCalls = 0;
const previousFetchedReader = {
  _internalReader: {
    _primaryView: {
      _pdfPages: { 8: followingPage },
      _iframeWindow: {
        PDFViewerApplication: {
          pdfDocument: {
            numPages: 9,
            getPageData: async ({ pageIndex }) => {
              if (pageIndex === 7) {
                previousPageCalls++;
                return precedingPage;
              }
              return followingPage;
            },
            getPage: async () => {
              throw new Error("unneeded text API");
            },
          },
        },
      },
    },
  },
};
assert.equal(
  (
    await getPdfLayoutParagraph(
      previousFetchedReader,
      "which provide a reliable comparison",
      8,
    )
  ).text,
  crossPage.text,
);
assert.equal(previousPageCalls, 1);

// A single natural paragraph can occupy more than 48 lines across columns.
// Native font sizes and baselines must survive tall mathematical glyphs, while
// bold headings, figure captions and the next paragraph stay outside the input.
const longLeft = Array.from(
  { length: 32 },
  (_, index) =>
    `Measurement ${index} keeps the profile under changing flow conditions`,
);
longLeft[0] = "A natural paragraph starts below the section heading";
longLeft[10] = "The flow remains largely unaffected. At the θ = 180° location";
longLeft[31] = "and continues into the next column without stopping";
const longRight = Array.from(
  { length: 20 },
  (_, index) =>
    `the body discussion ${index} retains the continued physical detail`,
);
longRight[19] = "and the paragraph ends with its final numerical conclusion.";
const nativePage = {
  viewBox: [0, 0, 612, 810],
  chars: [
    [59, 760, "6 A bold heading above the first natural paragraph", true],
    ...longLeft.map((text, index) => [
      index === 0 ? 69 : 59,
      735 - index * 10 - (index >= 23 ? 70 : 0),
      text,
      false,
    ]),
    [100, 470, "Fig. 19 A caption between the body text blocks", false, 6],
    ...longRight.map((text, index) => [312, 735 - index * 10, text, false]),
    [322, 532, "A separate indented paragraph begins below the conclusion."],
    [312, 522, "Its remaining lines must never enter the previous input."],
    [312, 512, "The independent discussion continues on this page."],
  ].flatMap(([x, y, text, bold = false, fontSize = 8]) =>
    [...text].map((c, index) => ({
      c,
      fontSize,
      baseline: y,
      fontName: bold ? "Synthetic-Bold" : "Synthetic-Regular",
      rect: [
        x + index * 4,
        y - (c === "θ" ? 2 : 0),
        x + (index + 1) * 4,
        y + (c === "θ" ? 12 : fontSize),
      ],
      lineBreakAfter: index === text.length - 1,
    })),
  ),
};
const completeLongParagraph = [...longLeft, ...longRight].join(" ");
for (const selection of [
  longLeft[0],
  longLeft[10],
  longLeft.slice(2, 12).join(" "),
  longRight[0],
  longRight[12],
]) {
  const result = paragraphFromPageData(nativePage, selection);
  assert.equal(result.kind, "ready", selection);
  assert.equal(result.text, completeLongParagraph, selection);
}
// Hanging-indent lists have two margins: marker starts and continuation starts.
// Exercise both columns, multiple marker formats, wide indents and PDF items
// where the marker is stored separately from its first line of content.
const listTexts = [
  [
    "The first item studies unsteady inflow near the interface",
    "to be assessed experimentally for accurate validation",
    "These details stay in the first item.",
  ],
  [
    "The second item discusses measurement section coverage",
    "to collect additional observations in different directions",
    "These details stay in the second item.",
  ],
  [
    "The third item discusses further operating conditions",
    "with additional measurements at a range of power settings",
    "The final item ends here.",
  ],
];
const markerFormats = [
  ["(1)", "(2)", "(3)"],
  ["1.", "2.", "3."],
  ["a)", "b)", "c)"],
  ["(i)", "(ii)", "(iii)"],
  ["•", "•", "•"],
  ["–", "–", "–"],
];
const makeLine = (x, y, str, width = Math.min(240, str.length * 3.5)) => ({
  str,
  width,
  transform: [9, 0, 0, 9, x, y],
});
for (const markerX of [64, 320]) {
  for (const indent of [15, 50]) {
    for (const markers of markerFormats) {
      const listItems = [];
      for (let item = 0; item < 3; item++) {
        const y = 640 - item * 30;
        if (indent === 50) {
          listItems.push(makeLine(markerX, y, markers[item], 10));
          listItems.push(makeLine(markerX + indent, y, listTexts[item][0]));
        } else {
          listItems.push(
            makeLine(markerX, y, markers[item] + " " + listTexts[item][0]),
          );
        }
        listItems.push(makeLine(markerX + indent, y - 10, listTexts[item][1]));
        listItems.push(makeLine(markerX + indent, y - 20, listTexts[item][2]));
      }
      for (let item = 0; item < 3; item++) {
        const expected = markers[item] + " " + listTexts[item].join(" ");
        for (const fragment of listTexts[item]) {
          const result = paragraphFromLayout(listItems, fragment, 612);
          assert.equal(
            result.kind,
            "ready",
            `${markerX}/${indent}/${markers[item]}: ${fragment}`,
          );
          assert.equal(result.text, expected);
        }
      }
      const mixed = paragraphFromLayout(
        listItems,
        listTexts[0][2] + " " + markers[1] + " " + listTexts[1][0],
        612,
      );
      assert.equal(
        mixed.kind,
        "ready",
        "expand a selection covering two list items",
      );
      assert.equal(mixed.paragraphs, 2);
      assert.equal(
        mixed.text,
        [0, 1]
          .map((index) => markers[index] + " " + listTexts[index].join(" "))
          .join("\n\n"),
        "both complete items must be present, without the third item",
      );
    }
  }
}
const nested = [
  makeLine(64, 600, "(1) The parent item introduces these measurement tasks"),
  makeLine(80, 590, "and explains why the following details are necessary."),
  makeLine(95, 580, "(a) The first nested item requires independent data"),
  makeLine(110, 570, "with its own closing statement."),
  makeLine(95, 560, "(b) The second nested item requires another method"),
  makeLine(110, 550, "with an independent closing statement."),
  makeLine(80, 540, "The parent item resumes after the nested list."),
  makeLine(64, 530, "(2) Another parent item starts below this complete block"),
  makeLine(80, 520, "and finishes with its own observations."),
];
assert.equal(
  paragraphFromLayout(nested, "first nested item requires", 612).text,
  "(a) The first nested item requires independent data with its own closing statement.",
);
assert.equal(
  paragraphFromLayout(nested, "second nested item requires", 612).text,
  "(b) The second nested item requires another method with an independent closing statement.",
);
const parentListResult = paragraphFromLayout(
  nested,
  "parent item introduces",
  612,
);
assert.equal(parentListResult.kind, "ready");
assert.ok(
  parentListResult.text.endsWith(
    "The parent item resumes after the nested list.",
  ),
);
assert.ok(!parentListResult.text.includes("(2)"));
const unfinishedList = [
  makeLine(64, 600, "(1) The first item has a complete first-line statement."),
  makeLine(
    64,
    580,
    "(2) Another item begins with a discussion of several observations",
  ),
  makeLine(
    80,
    570,
    "and its text continues elsewhere without a confirmed ending",
  ),
];
assert.equal(
  paragraphFromLayout(unfinishedList, "text continues elsewhere", 612).kind,
  "unmatched",
);
assert.notEqual(
  paragraphFromLayout(
    [
      makeLine(64, 600, "(1) alpha + beta = gamma"),
      makeLine(64, 580, "(2) beta + gamma = delta"),
      makeLine(64, 560, "(3) gamma + delta = theta"),
    ],
    "alpha + beta = gamma",
    612,
  ).kind,
  "ready",
);
const singleLineList = [
  makeLine(64, 600, "1. The first item is a longer standalone instruction."),
  makeLine(64, 580, "2. The second item is another complete instruction."),
  makeLine(64, 560, "3. A shorter last item."),
];
assert.equal(
  paragraphFromLayout(singleLineList, "shorter last item", 612).text,
  "3. A shorter last item.",
);
const compactList = [
  makeLine(64, 600, "(1)The first compact item concerns the incoming flow"),
  makeLine(80, 590, "and includes a closing observation."),
  makeLine(64, 580, "(2)The second compact item concerns the outgoing flow"),
  makeLine(80, 570, "and ends with a short conclusion."),
];
assert.ok(
  paragraphFromLayout(
    compactList,
    "first compact item concerns",
    612,
  ).text.startsWith("(1)The first"),
);
const duplicateColumns = [
  makeLine(64, 600, "(1) The same item wording occurs in both columns"),
  makeLine(80, 590, "The left column has its own closing observation."),
  makeLine(64, 580, "(2) The next left item is outside the selected item"),
  makeLine(80, 570, "This is a separate list item."),
  makeLine(320, 600, "(1) The same item wording occurs in both columns"),
  makeLine(335, 590, "The right column has its own closing observation."),
  makeLine(320, 580, "(2) The next right item is outside the selected item"),
  makeLine(335, 570, "This is a different list item."),
];
assert.equal(
  paragraphFromLayout(duplicateColumns, "same item wording occurs", 612).kind,
  "unmatched",
);
assert.equal(
  paragraphFromLayout(duplicateColumns, "same item wording occurs", 612, [
    [370, 600, 400, 609],
  ]).text,
  "(1) The same item wording occurs in both columns The right column has its own closing observation.",
);
const nativeListPage = pageWith([
  [320, 600, "(1) The unsteady inflow to the fan stage needs assessment"],
  [335, 590, "to improve the understanding of the flow coupling."],
  [320, 580, "(2) The next measurement task starts outside this item"],
  [335, 570, "and must not be included in the first item."],
]);
const nativeListReader = {
  _internalReader: { _primaryView: { _pdfPages: { 10: nativeListPage } } },
};
assert.equal(
  (await getPdfLayoutParagraph(nativeListReader, "inflow to the fan stage", 10))
    .text,
  "(1) The unsteady inflow to the fan stage needs assessment to improve the understanding of the flow coupling.",
);
// Single-column scientific manuscripts can have 18pt line spacing, 11pt
// body fonts, first-line indents, and centred subsection headings. Selecting
// across an actual indented paragraph start is not a layout detection failure.
const manuscriptLine = (x, y, str, width = 480) => ({
  str,
  width,
  transform: [11, 0, 0, 11, x, y],
});
const manuscriptParagraphs = [
  [
    "The validation results establish the accuracy of the acoustic method",
    "for propagation through a range of non-uniform duct geometries.",
    "The results reach the expected accuracy of the reference solutions.",
  ],
  [
    "Both sweep directions produce accurate estimates of the acoustic field",
    "with the axial integration method applied at successive analysis planes.",
    "Small reflected waves do not substantially alter the upstream field",
    "while the full sweep also includes the effect of stronger reflections.",
    "This extends the analysis to a wider range of operating conditions.",
    "Reflected waves can be significant.",
  ],
  [
    "The third paragraph discusses the influence of spatial discretisation",
    "and compares calculations at several different analysis positions.",
    "The coordinate system explains the observed result.",
  ],
];
const manuscript = [
  manuscriptLine(
    55,
    748,
    "The preceding section finishes with an independent conclusion.",
  ),
  { ...manuscriptLine(55, 710, "7. Discussion", 85), bold: true },
  manuscriptLine(270, 677, "7.1. Accuracy", 75),
];
let manuscriptY = 640;
for (const rows of manuscriptParagraphs) {
  rows.forEach((text, index) => {
    if (rows === manuscriptParagraphs[1] && index === 0) {
      const split = text.indexOf("of the acoustic field");
      manuscript.push(
        manuscriptLine(65, manuscriptY, text.slice(0, split), 275),
        manuscriptLine(342, manuscriptY, text.slice(split), 203),
      );
    } else {
      manuscript.push(
        manuscriptLine(
          index === 0 ? 65 : 55,
          manuscriptY,
          text,
          index === rows.length - 1 ? 370 : 480,
        ),
      );
    }
    manuscriptY -= 18;
  });
}
manuscript.push(
  manuscriptLine(240, manuscriptY - 15, "7.2. Computational Expense", 150),
  manuscriptLine(
    65,
    manuscriptY - 45,
    "The next section starts with a separate discussion of computational expense.",
  ),
  manuscriptLine(
    55,
    manuscriptY - 63,
    "This independent discussion is not part of the preceding paragraph.",
  ),
);
for (const rows of manuscriptParagraphs) {
  for (const selection of rows) {
    const result = paragraphFromLayout(manuscript, selection, 595);
    assert.equal(result.kind, "ready", selection);
    assert.equal(result.text, rows.join(" "));
  }
}
assert.equal(
  paragraphFromLayout(manuscript, "acoustic field", 595).text,
  manuscriptParagraphs[1].join(" "),
  "a single-column font fragment right of page centre must not become a separate column",
);
const twoParagraphSelection =
  manuscriptParagraphs[0][2] + " " + manuscriptParagraphs[1][0];
const manuscriptCrossing = paragraphFromLayout(
  manuscript,
  twoParagraphSelection,
  595,
);
assert.equal(manuscriptCrossing.kind, "ready");
assert.equal(manuscriptCrossing.paragraphs, 2);
assert.equal(
  manuscriptCrossing.text,
  manuscriptParagraphs
    .slice(0, 2)
    .map((rows) => rows.join(" "))
    .join("\n\n"),
);
const manuscriptMismatch = paragraphFromLayout(
  manuscript,
  manuscriptParagraphs[0][1] + " A made-up phrase missing from the PDF.",
  595,
);
assert.equal(manuscriptMismatch.kind, "unmatched");
assert.equal(manuscriptMismatch.detail, "selection-text-mismatch");
let unnecessaryViewerCalls = 0;
const authoritativeCrossingReader = {
  _internalReader: {
    _primaryView: {
      _pdfPages: { 10: nativeListPage },
      _iframeWindow: {
        PDFViewerApplication: {
          pdfDocument: {
            numPages: 11,
            getPageData: async () => {
              unnecessaryViewerCalls++;
              throw new Error(
                "authoritative native crossing must not be retried",
              );
            },
            getPage: async () => {
              unnecessaryViewerCalls++;
              throw new Error(
                "text fallback must not override native boundaries",
              );
            },
          },
        },
      },
    },
  },
};
const readerCrossing = await getPdfLayoutParagraph(
  authoritativeCrossingReader,
  "to improve the understanding of the flow coupling. (2) The next measurement task starts outside this item",
  10,
);
assert.equal(readerCrossing.kind, "ready");
assert.equal(readerCrossing.paragraphs, 2);
assert.equal(
  readerCrossing.text,
  "(1) The unsteady inflow to the fan stage needs assessment to improve the understanding of the flow coupling.\n\n(2) The next measurement task starts outside this item and must not be included in the first item.",
);
assert.equal(unnecessaryViewerCalls, 0);
const captionItems = [
  {
    str: "Figure 15: Front fan case circumferential variation",
    transform: [10, 0, 0, 10, 72, 760],
    width: 420,
    bold: true,
  },
  {
    str: "at two engine orders for the drooped intake.",
    transform: [10, 0, 0, 10, 72, 747],
    width: 340,
    bold: true,
  },
  {
    str: "C. Inlet axial array noise results",
    transform: [12, 0, 0, 12, 72, 720],
    width: 280,
    bold: true,
  },
  ...[
    [
      82,
      450,
      "The wall pressure was predicted across the fan face and highlight plane.",
    ],
    [72, 450, "Further observations stay inside this same acoustic paragraph."],
    [72, 450, "Another full line keeps the justified edge of this body."],
    [72, 280, "The paragraph ends with this shorter conclusion."],
  ].map(([x, width, str], index) => ({
    str,
    transform: [10, 0, 0, 10, x, 690 - index * 13],
    width,
  })),
];
const captionText =
  "Figure 15: Front fan case circumferential variation at two engine orders for the drooped intake.";
const captionResult = paragraphFromLayout(
  captionItems,
  "circumferential variation",
  595,
);
assert.equal(captionResult.kind, "ready");
assert.equal(captionResult.text, captionText);
const wrappedCaption = paragraphFromLayout(
  captionItems,
  "two engine orders",
  595,
);
assert.equal(wrappedCaption.text, captionText);
const bodyBesideCaption = paragraphFromLayout(
  captionItems,
  "wall pressure was predicted",
  595,
);
assert.equal(bodyBesideCaption.kind, "ready");
assert.ok(bodyBesideCaption.text.startsWith("The wall pressure"));
assert.ok(!bodyBesideCaption.text.includes("Figure 15"));
assert.notEqual(
  paragraphFromLayout(
    captionItems,
    "circumferential variation C. Inlet axial",
    595,
  ).kind,
  "ready",
);
console.log(
  "PDF layout: single-column paragraph crossings, lists, nested items, native metrics, column/page continuations and reader access passed",
);

/* global URL, console, setTimeout */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(
  new URL("../src/modules/pdfLayout.ts", import.meta.url),
  "utf8",
);
const module = { exports: {} };
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
runInNewContext(outputText, {
  module,
  exports: module.exports,
  ztoolkit: {
    getGlobal: (name) => {
      assert.equal(name, "setTimeout");
      return setTimeout;
    },
  },
});
const { paragraphFromPageData, getPdfLayoutParagraph } = module.exports;
const denied = "Permission denied to pass object to privileged code";
const methods = new Set([
  "map",
  "every",
  "filter",
  "forEach",
  "slice",
  "sort",
  "at",
  "toJSON",
  Symbol.iterator,
]);
let deniedCalls = 0;
function foreign(value) {
  if (!value || typeof value !== "object") return value;
  const copy = Array.isArray(value)
    ? value.map(foreign)
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, foreign(item)]),
      );
  return new Proxy(copy, {
    get(target, key) {
      if (methods.has(key) || key === "then") {
        deniedCalls++;
        throw new Error(denied);
      }
      return Reflect.get(target, key);
    },
    set() {
      throw new Error("reader-owned data must not be mutated");
    },
  });
}
const paragraphs = [
  [
    "The first paragraph validates the acoustic propagation model.",
    "Further measurements reinforce its numerical interpretation.",
    "These observations complete the first independent argument.",
  ],
  [
    "The second paragraph introduces a separate numerical method.",
    "Its additional measurements concern reflected acoustic waves.",
    "The second independent discussion finishes with this conclusion.",
  ],
  [
    "A third paragraph starts beyond the selected range.",
    "These further details must not enter the requested paragraph.",
  ],
];
const rows = paragraphs.flatMap((parts, p) =>
  parts.map((str, line) => ({
    str,
    width: line === 2 ? 370 : 470,
    transform: [11, 0, 0, 11, line ? 55 : 67, 750 - p * 60 - line * 18],
  })),
);
const page = {
  viewBox: [0, 0, 595, 842],
  chars: rows.flatMap(({ str, transform, width }) =>
    Array.from(str, (c, index) => ({
      c,
      rect: [
        transform[4] + (index * width) / str.length,
        transform[5],
        transform[4] + ((index + 1) * width) / str.length,
        transform[5] + 11,
      ],
      inlineRect: [
        transform[4] + (index * width) / str.length,
        transform[5],
        transform[4] + ((index + 1) * width) / str.length,
        transform[5] + 11,
      ],
      fontSize: 11,
      baseline: transform[5],
      fontName: "Synthetic-Regular",
      lineBreakAfter: index === str.length - 1,
    })),
  ),
};
const expectedFirst = paragraphs[0].join(" ");
const expectedBoth = paragraphs
  .slice(0, 2)
  .map((parts) => parts.join(" "))
  .join("\n\n");
const selected =
  paragraphs[0][2].slice(20) + " " + paragraphs[1][0].slice(0, 40);
const readerPage = foreign(page);
assert.throws(
  () => paragraphFromPageData(readerPage, "acoustic propagation model"),
  new RegExp(denied),
);
assert.ok(
  deniedCalls > 0,
  "the old raw-data analysis must reproduce the user's permission error",
);
deniedCalls = 0;
let windowReads = 0;
const cachedView = {
  _pdfPages: { 37: readerPage },
  get _iframeWindow() {
    windowReads++;
    throw new Error(denied);
  },
};
const cached = {
  _internalReader: { _lastView: cachedView, _primaryView: cachedView },
};
const first = await getPdfLayoutParagraph(
  cached,
  "acoustic propagation model",
  37,
  foreign([[100, 750, 160, 761]]),
);
assert.equal(first.kind, "ready", JSON.stringify(first));
assert.equal(first.text, expectedFirst);
const both = await getPdfLayoutParagraph(
  cached,
  selected,
  37,
  foreign([
    [55, 714, 425, 725],
    [67, 690, 537, 701],
  ]),
);
assert.equal(both.kind, "ready", JSON.stringify(both));
assert.equal(both.paragraphs, 2);
assert.equal(both.text, expectedBoth);
assert.equal(
  windowReads,
  0,
  "complete cached data must not probe window privileges",
);
assert.equal(
  deniedCalls,
  0,
  "new analysis must never call a foreign Array method or thenable",
);

// Both selected pages and nextPageRects must stay local, even with denied
// viewer getters and foreign arrays on the neighbouring page.
const firstCharCount = paragraphs[0].reduce(
  (count, text) => count + text.length,
  0,
);
const nextPage = {
  viewBox: page.viewBox,
  chars: page.chars.slice(firstCharCount).map((char) => ({
    ...char,
    baseline: char.baseline + 60,
    rect: [char.rect[0], char.rect[1] + 60, char.rect[2], char.rect[3] + 60],
    inlineRect: [
      char.inlineRect[0],
      char.inlineRect[1] + 60,
      char.inlineRect[2],
      char.inlineRect[3] + 60,
    ],
  })),
};
const pagedView = {
  _pdfPages: {
    0: foreign({
      viewBox: page.viewBox,
      chars: page.chars.slice(0, firstCharCount),
    }),
    1: foreign(nextPage),
  },
  get _iframeWindow() {
    throw new Error("cached cross-page range must not touch the viewer");
  },
};
const crossPage = await getPdfLayoutParagraph(
  { _internalReader: { _primaryView: pagedView } },
  selected,
  0,
  foreign([[55, 714, 425, 725]]),
  foreign([[67, 750, 537, 761]]),
);
assert.equal(crossPage.kind, "ready", JSON.stringify(crossPage));
assert.equal(crossPage.text, expectedBoth);
assert.equal(crossPage.paragraphs, 2);
assert.equal(deniedCalls, 0);

// Getter denial must not abort the view before the reader's primitive-only loader.
let receiverCalls = 0,
  promiseCallbacks = 0;
const loadedView = {
  _pdfPages: {},
  _ensureBasicPageData(index) {
    assert.equal(this, loadedView);
    assert.equal(index, 37);
    receiverCalls++;
    setTimeout(() => {
      loadedView._pdfPages[index] = readerPage;
    }, 1);
    return new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "then" || key === "catch") {
            promiseCallbacks++;
            throw new Error(denied);
          }
          return undefined;
        },
      },
    );
  },
  _iframeWindow: {
    PDFViewerApplication: {
      get pdfDocument() {
        throw new Error(denied);
      },
    },
  },
};
const loaded = await getPdfLayoutParagraph(
  { _internalReader: { _primaryView: loadedView } },
  selected,
  37,
);
assert.equal(loaded.kind, "ready", JSON.stringify(loaded));
assert.equal(loaded.text, expectedBoth);
assert.equal(receiverCalls, 1);
assert.equal(
  promiseCallbacks,
  0,
  "never attach local callbacks to a reader-owned Promise",
);
assert.equal(deniedCalls, 0);

// A rejected last-view getter must not prevent using the real primary PDF view.
const alternate = await getPdfLayoutParagraph(
  {
    _internalReader: {
      get _lastView() {
        throw new Error(denied);
      },
      _primaryView: cachedView,
    },
  },
  "acoustic propagation model",
  37,
);
assert.equal(alternate.text, expectedFirst);

// The direct getPageData fallback also yields foreign nested arrays.
const direct = await getPdfLayoutParagraph(
  {
    _internalReader: {
      _primaryView: {
        _iframeWindow: {
          PDFViewerApplication: {
            pdfDocument: {
              numPages: 38,
              getPageData: async () => ({
                chars: readerPage.chars,
                viewBox: readerPage.viewBox,
              }),
            },
          },
        },
      },
    },
  },
  selected,
  37,
);
assert.equal(direct.text, expectedBoth);
assert.equal(deniedCalls, 0);

// Text API items, matrices, and cropped page viewBox need the same treatment.
const textFallback = await getPdfLayoutParagraph(
  {
    _internalReader: {
      _primaryView: {
        _iframeWindow: {
          PDFViewerApplication: {
            pdfDocument: {
              numPages: 38,
              getPage: async (number) => {
                assert.equal(number, 38);
                return {
                  view: foreign([200, 30, 795, 872]),
                  getTextContent: async () => ({
                    items: foreign([
                      { type: "beginMarkedContent" },
                      ...rows.map((item) => ({
                        ...item,
                        transform: [
                          ...item.transform.slice(0, 4),
                          item.transform[4] + 200,
                          item.transform[5] + 30,
                        ],
                      })),
                    ]),
                  }),
                };
              },
            },
          },
        },
      },
    },
  },
  selected,
  37,
  foreign([
    [255, 744, 625, 755],
    [267, 720, 737, 731],
  ]),
);
assert.equal(textFallback.kind, "ready", JSON.stringify(textFallback));
assert.equal(textFallback.text, expectedBoth);
assert.equal(deniedCalls, 0);

// Failed snapshots must report their source; never analyse the partial copy.
const inaccessible = {
  viewBox: page.viewBox,
  get chars() {
    throw new Error(denied);
  },
};
const failed = await getPdfLayoutParagraph(
  { _internalReader: { _lastView: { _pdfPages: { 37: inaccessible } } } },
  selected,
  37,
);
assert.equal(failed.kind, "unavailable");
assert.match(failed.detail, /last-cache-snapshot-37/);
assert.match(failed.detail, new RegExp(denied));
const invalidRects = await getPdfLayoutParagraph(
  cached,
  selected,
  37,
  new Proxy([], {
    get() {
      throw new Error(denied);
    },
  }),
);
assert.equal(invalidRects.kind, "unavailable");
assert.match(invalidRects.detail, /selection-snapshot/);
console.log(
  "PDF reader access: permission error reproduced; local snapshots, cached-first access, loader receiver/promise isolation, native/text arrays and selection rectangles passed (mock compartments)",
);

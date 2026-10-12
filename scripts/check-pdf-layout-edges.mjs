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
const {
  paragraphFromLayout,
  paragraphFromPageData,
  paragraphAcrossNextPage,
  paragraphAcrossPreviousPage,
  getPdfLayoutParagraph,
} = module.exports;
const failures = [];
let probes = 0;
async function check(name, action) {
  probes++;
  try {
    await action();
  } catch (error) {
    failures.push(name + ": " + error.message);
  }
}
const item = (x, y, str, width = 480, size = 11, extra = {}) => ({
  str,
  width,
  transform: [size, 0, 0, size, x, y],
  ...extra,
});
const first = [
  "The first paragraph validates acoustic propagation with several careful comparisons.",
  "Related measurements reinforce the interpretation and remain within this paragraph.",
  "This particular conclusion completes the discussion without introducing the next item.",
];
const second = [
  "The second paragraph introduces an independent investigation of the numerical method.",
  "Its observations must not be included in the previous naturally bounded discussion.",
  "The separate investigation finishes with its own carefully stated conclusion.",
];
const split = [];
let y = 680;
for (const rows of [first, second]) {
  rows.forEach((text, index) => {
    const cut = text.indexOf(" ", 33) + 1;
    const x = index === 0 ? 65 : 55;
    split.push(
      item(x, y, text.slice(0, cut), 300 - x),
      item(302, y, text.slice(cut), 230),
    );
    y -= 18;
  });
}
await check("every single-column row split at centre", () => {
  const result = paragraphFromLayout(
    split,
    "acoustic propagation with several careful comparisons",
    595,
  );
  assert.equal(result.kind, "ready");
  assert.equal(result.text, first.join(" "));
});
await check("selection spanning split font pieces", () => {
  assert.equal(paragraphFromLayout(split, first[0], 595).text, first.join(" "));
});
const mixed = [];
for (let i = 0; i < 12; i++)
  mixed.push(
    item(
      i ? 55 : 65,
      790 - i * 18,
      `Full width abstract statement ${i} explains a separate introductory background.`,
      i ? 480 : 470,
    ),
  );
mixed.push(item(55, 550, "1. Results", 100, 13, { bold: true }));
const left = [
  "The left body paragraph contains its own acoustic discussion",
  "with independent measurements of the upstream velocity",
  "and completes the left-side argument with this result.",
];
const right = [
  "The right body paragraph analyses a different physical mechanism",
  "and keeps its conclusions separate from those in the left column",
  "before completing the right-side argument with these observations.",
];
for (let i = 0; i < 3; i++) {
  mixed.push(item(i ? 55 : 65, 520 - i * 18, left[i], i ? 240 : 230));
  mixed.push(item(i ? 315 : 325, 520 - i * 18, right[i], i ? 230 : 220));
}
mixed.push(
  item(65, 456, "A separate later paragraph starts on the left side.", 230),
);
mixed.push(
  item(325, 456, "A separate later paragraph starts on the right side.", 220),
);
await check("page-wide abstract must not erase real body gutter", () => {
  assert.equal(
    paragraphFromLayout(mixed, "right body paragraph analyses", 595).text,
    right.join(" "),
  );
  assert.equal(
    paragraphFromLayout(mixed, "left body paragraph contains", 595).text,
    left.join(" "),
  );
});
const repeated = [
  item(
    65,
    622,
    "The initial discussion starts with an independent observation.",
    220,
    9,
  ),
  item(
    55,
    610,
    "Earlier physical evidence remains in the initial discussion.",
    230,
    9,
  ),
  item(55, 600, "Repeated phrase belongs to the first paragraph.", 180, 9),
  item(65, 590, "Repeated phrase belongs to the second paragraph.", 220, 9),
  item(
    55,
    580,
    "The second discussion remains independent of the first result.",
    200,
    9,
  ),
  item(
    65,
    567,
    "A third discussion starts separately from both previous paragraphs.",
    220,
    9,
  ),
];
await check("adjacent repeated anchors resolved by glyph-row position", () => {
  assert.equal(
    paragraphFromLayout(repeated, "Repeated phrase", 595, [[90, 590, 160, 598]])
      .text,
    repeated
      .slice(3, 5)
      .map((row) => row.str)
      .join(" "),
  );
});
await check("unpositioned repeated anchor stays ambiguous", () =>
  assert.equal(
    paragraphFromLayout(repeated, "Repeated phrase", 595).kind,
    "unmatched",
  ),
);
await check("unique textual anchor does not override incompatible rects", () =>
  assert.equal(
    paragraphFromLayout(repeated, "The initial discussion", 595, [
      [90, 580, 160, 588],
    ]).kind,
    "unmatched",
  ),
);
const short = [
  item(
    65,
    620,
    "The flow passage is part of the first physical discussion.",
    470,
  ),
  item(
    55,
    602,
    "The flow remains consistent with the first set of measurements.",
    480,
  ),
  item(55, 584, "These observations explain why the flow stabilises.", 250),
  item(
    65,
    566,
    "A second flow argument begins independently of the first paragraph.",
    470,
  ),
  item(
    55,
    548,
    "The later argument discusses another set of physical effects.",
    480,
  ),
];
await check("short word with reliable position expands full paragraph", () =>
  assert.equal(
    paragraphFromLayout(short, "flow", 595, [[77, 601, 100, 611]]).text,
    short
      .slice(0, 3)
      .map((row) => row.str)
      .join(" "),
  ),
);
await check("short word without position is not guessed", () =>
  assert.equal(paragraphFromLayout(short, "flow", 595).kind, "unmatched"),
);
const afterHeading = [
  item(55, 705, "2. Discussion", 120, 13, { bold: true }),
  item(
    55,
    680,
    "The unindented first paragraph starts immediately after a heading.",
    480,
  ),
  item(
    55,
    662,
    "Its remaining observations belong to the same discussion.",
    480,
  ),
  item(55, 644, "A bounded conclusion finishes this paragraph.", 250),
  item(65, 626, "The next independent paragraph starts with an indent.", 470),
];
await check("heading confirms unindented first paragraph start", () =>
  assert.equal(
    paragraphFromLayout(afterHeading, "remaining observations", 595).text,
    afterHeading
      .slice(1, 4)
      .map((row) => row.str)
      .join(" "),
  ),
);
const blank = [
  item(
    65,
    680,
    "The earlier paragraph starts with another unrelated observation.",
    470,
  ),
  item(
    55,
    662,
    "The earlier discussion reaches its own separate conclusion.",
    250,
  ),
  item(
    55,
    628,
    "This unindented paragraph follows an explicit blank separation.",
    480,
  ),
  item(
    55,
    610,
    "Its observations must remain separate from the preceding discussion.",
    250,
  ),
  item(65, 592, "The next naturally independent paragraph starts here.", 470),
];
await check("blank separation bounds unindented paragraph", () =>
  assert.equal(
    paragraphFromLayout(blank, "explicit blank separation", 595).text,
    blank
      .slice(2, 4)
      .map((row) => row.str)
      .join(" "),
  ),
);
const headingEnd = [
  item(
    65,
    680,
    "The paragraph before the heading begins with a complete argument.",
    470,
  ),
  item(
    55,
    662,
    "It adds further observations within the same natural discussion.",
    480,
  ),
  item(55, 644, "The earlier discussion ends with this result.", 250),
  item(55, 620, "3. Later Discussion", 130, 13, { bold: true }),
  item(
    55,
    598,
    "The next unindented discussion is under a different heading.",
    480,
  ),
  item(55, 580, "It ends with its own separate result.", 250),
  item(
    65,
    562,
    "A further paragraph starts with its own independent argument.",
    470,
  ),
];
await check(
  "intervening heading prevents merging neighbouring paragraphs",
  () =>
    assert.equal(
      paragraphFromLayout(headingEnd, "adds further observations", 595).text,
      headingEnd
        .slice(0, 3)
        .map((row) => row.str)
        .join(" "),
    ),
);
const final = headingEnd.slice(0, 3);
await check(
  "short terminal line in justified body confirms final paragraph",
  () =>
    assert.equal(
      paragraphFromLayout(final, "adds further observations", 595).text,
      final.map((row) => row.str).join(" "),
    ),
);
const open = final.map((row) => ({ ...row }));
open[2] = item(
  55,
  644,
  "The discussion continues with further evidence not present here",
  480,
);
await check("unfinished final paragraph is still rejected", () =>
  assert.equal(
    paragraphFromLayout(open, "adds further observations", 595).kind,
    "unmatched",
  ),
);
// Anonymous typesetting fixtures: the full rows have a tight measured right
// edge, but a genuinely final, almost full-width row can be only one em short.
// No private paper text or native cache is embedded in this published check.
const terminalTexts = Array.from({ length: 11 }, (_, index) =>
  index === 10
    ? "These independent observations complete the original bounded comparison."
    : `Measured statement ${index} develops the same numerical interpretation and provides further evidence`,
);
const terminalRows = (ends, size = 9.96) =>
  ends.map((end, index) => {
    const x = index ? 72 : 82;
    return item(
      x,
      680 - index * 13.2,
      terminalTexts[index] ||
        `Additional observation ${index} extends the numerical interpretation`,
      end - x,
      size,
    );
  });
const measuredTail = terminalRows([
  523.12, 523.24, 523.19, 523.26, 523.08, 523.22, 523.15, 523.18, 523.11,
  523.21, 512.14,
]);
await check(
  "eleven-point terminal shortfall in a justified body is complete",
  () => {
    const result = paragraphFromLayout(
      measuredTail,
      measuredTail
        .slice(4, 7)
        .map((row) => row.str)
        .join(" "),
      612,
    );
    assert.equal(result.kind, "ready");
    assert.equal(result.text, measuredTail.map((row) => row.str).join(" "));
  },
);
const nativeTerminalPage = (rows) => ({
  viewBox: [0, 0, 612, 800],
  chars: rows.flatMap((row) => {
    const [, , , , x, y] = row.transform;
    const chars = Array.from(row.str);
    return chars.map((c, index) => ({
      c,
      rect: [
        x + (index * row.width) / chars.length,
        y,
        x + ((index + 1) * row.width) / chars.length,
        y + row.transform[0],
      ],
      fontSize: row.transform[0],
      baseline: y,
      fontName: "Synthetic-Regular",
      lineBreakAfter: index === chars.length - 1,
    }));
  }),
});
const newFlushParagraph = [
  item(
    72,
    760,
    "A new unindented paragraph opens with an independent subject",
    451,
    9.96,
  ),
  item(
    72,
    746.8,
    "Further independent measurements belong to this later discussion",
    451,
    9.96,
  ),
  item(
    72,
    733.6,
    "The later discussion ends with its own separate conclusion.",
    320,
    9.96,
  ),
];
await check(
  "native cached long tail stops before an unindented next-page paragraph",
  async () => {
    const result = await getPdfLayoutParagraph(
      {
        _internalReader: {
          _primaryView: {
            _pdfPages: {
              0: nativeTerminalPage(measuredTail),
              1: nativeTerminalPage(newFlushParagraph),
            },
          },
        },
      },
      measuredTail
        .slice(4, 7)
        .map((row) => row.str)
        .join(" "),
      0,
    );
    assert.equal(result.kind, "ready");
    assert.equal(result.text, measuredTail.map((row) => row.str).join(" "));
    assert.ok(!result.text.includes(newFlushParagraph[0].str));
  },
);
for (const [label, shortfall] of [
  ["exactly one font size", 10],
  ["less than seven-tenths of a font size", 6],
  ["full-width sentence", 0],
]) {
  const rows = terminalRows([...Array(10).fill(520), 520 - shortfall], 10);
  await check(`${label} is not a confirmed final line`, () =>
    assert.equal(paragraphFromLayout(rows, rows[5].str, 612).kind, "unmatched"),
  );
}
const looseEdge = terminalRows([520, 520, 514, 526, 520, 508.9], 10);
looseEdge.at(-1).str = terminalTexts.at(-1);
await check(
  "loose aligned edge needs more than an eleven-point terminal gap",
  () =>
    assert.equal(
      paragraphFromLayout(looseEdge, looseEdge[2].str, 612).kind,
      "unmatched",
    ),
);
const raggedTail = terminalRows([
  410, 460, 430, 510, 470, 455, 490, 415, 500, 450, 412,
]);
await check(
  "ragged-right terminal text supplies no justified edge evidence",
  () =>
    assert.equal(
      paragraphFromLayout(raggedTail, raggedTail[5].str, 612).kind,
      "unmatched",
    ),
);
const openMeasuredTail = measuredTail.map((row) => ({ ...row }));
openMeasuredTail.at(-1).str =
  "These observations continue into evidence not yet present";
await check("measured edge shortfall cannot close a nonterminal fragment", () =>
  assert.equal(
    paragraphFromLayout(openMeasuredTail, openMeasuredTail[5].str, 612).kind,
    "unmatched",
  ),
);
const singleTerminal = terminalRows([520, 520, 508.9], 10);
singleTerminal[1].str =
  "The earlier paragraph ends with an independent conclusion.";
singleTerminal[2] = item(82, 653.6, terminalTexts.at(-1), 426.9, 10);
await check(
  "one terminal row remains insufficient even with aligned context",
  () =>
    assert.equal(
      paragraphFromLayout(singleTerminal, singleTerminal[2].str, 612).kind,
      "unmatched",
    ),
);
const fullWidthSentence = terminalRows(Array(11).fill(523.2));
const continuingSentences = [
  item(
    72,
    760,
    "The next sentence continues the same argument beyond the page boundary",
    451.2,
    9.96,
  ),
  item(
    72,
    746.8,
    "Its additional observations must not be discarded from the original paragraph",
    451.2,
    9.96,
  ),
  item(
    72,
    733.6,
    "The original argument finally reaches its own bounded conclusion.",
    340,
    9.96,
  ),
  item(
    82,
    720.4,
    "Another independent paragraph starts outside the continued argument",
    441.2,
    9.96,
  ),
];
await check(
  "page-foot period before an uppercase continuation is not a paragraph end",
  async () => {
    const result = await getPdfLayoutParagraph(
      {
        _internalReader: {
          _primaryView: {
            _pdfPages: {
              0: nativeTerminalPage(fullWidthSentence),
              1: nativeTerminalPage(continuingSentences),
            },
          },
        },
      },
      fullWidthSentence[5].str,
      0,
    );
    assert.equal(result.kind, "unmatched");
    assert.ok(
      !result.text,
      "do not return only the first page of a continued paragraph",
    );
  },
);
const threeRowTail = terminalRows([520, 520, 508.9], 10);
threeRowTail.at(-1).str = terminalTexts.at(-1);
await check(
  "three modestly shortened rows lack the stronger terminal evidence",
  () =>
    assert.equal(
      paragraphFromLayout(threeRowTail, threeRowTail[1].str, 612).kind,
      "unmatched",
    ),
);
const repeatedShortEnds = Array.from({ length: 3 }, (_, paragraph) =>
  Array.from({ length: 3 }, (_, line) => {
    const x = line ? 72 : 82;
    const end =
      line === 2
        ? 410
        : [520.3, 520.8, 521.3, 521.8, 522.2, 522.4][paragraph * 2 + line];
    return item(
      x,
      790 - (paragraph * 3 + line) * 13.2,
      line === 2
        ? `The prior discussion ${paragraph} closes at this separate result.`
        : `Prior paragraph ${paragraph} observation ${line} develops its independent numerical interpretation`,
      end - x,
      10,
    );
  }),
).flat();
const noisyModalTail = terminalRows(
  [...Array.from({ length: 10 }, (_, index) => 520.1 + index * 0.21), 510],
  10,
).map((row) => ({
  ...row,
  transform: [...row.transform.slice(0, 5), row.transform[5] - 24],
}));
await check(
  "repeated short endings cannot outvote the dense actual body edge",
  () => {
    const result = paragraphFromLayout(
      [...repeatedShortEnds, ...noisyModalTail],
      noisyModalTail[5].str,
      612,
    );
    assert.equal(result.kind, "ready");
    assert.equal(result.text, noisyModalTail.map((row) => row.str).join(" "));
  },
);
const leftModestTail = terminalRows([280, 280, 280, 268.9], 10);
leftModestTail.at(-1).str = terminalTexts.at(-1);
const rightOpenRows = Array.from({ length: 4 }, (_, index) =>
  item(
    320,
    680 - index * 13.2,
    `Independent right-column statement ${index} continues an unrelated unbounded argument`,
    220,
    10,
  ),
);
await check(
  "another body column does not enable the modest terminal branch",
  () =>
    assert.equal(
      paragraphFromLayout(
        [...leftModestTail, ...rightOpenRows],
        leftModestTail[1].str,
        612,
      ).kind,
      "unmatched",
    ),
);
const previousOpenRows = terminalRows([523.2, 523.2, 523.2, 523.2]);
const nextModestRun = measuredTail.map((row) => ({ ...row }));
nextModestRun[0] = item(
  72,
  760,
  "and continues the same numerical interpretation across the page",
  451.12,
  9.96,
);
for (let index = 1; index < nextModestRun.length; index++)
  nextModestRun[index].transform = [9.96, 0, 0, 9.96, 72, 760 - index * 13.2];
await check(
  "cross-page prose-run helper retains the legacy terminal requirement",
  () =>
    assert.equal(
      paragraphAcrossNextPage(
        nativeTerminalPage(previousOpenRows),
        nativeTerminalPage(nextModestRun),
        previousOpenRows[1].str,
      ).kind,
      "unmatched",
    ),
);
const contextReader = (previous, current = newFlushParagraph) => ({
  _internalReader: {
    _primaryView: {
      _pdfPages: {
        0: nativeTerminalPage(previous),
        1: nativeTerminalPage(current),
      },
    },
  },
});
await check("a flush first paragraph cannot invent its own start proof", () => {
  assert.equal(
    paragraphFromLayout(newFlushParagraph, newFlushParagraph[1].str, 612).kind,
    "unmatched",
  );
  assert.equal(
    paragraphFromPageData(
      nativeTerminalPage(newFlushParagraph),
      newFlushParagraph[1].str,
    ).kind,
    "unmatched",
  );
});
await check(
  "a locally complete previous tail confirms a flush paragraph start",
  async () => {
    const result = await getPdfLayoutParagraph(
      contextReader(measuredTail),
      newFlushParagraph[1].str,
      1,
    );
    assert.equal(result.kind, "ready");
    assert.equal(
      result.text,
      newFlushParagraph.map((row) => row.str).join(" "),
    );
    assert.ok(!result.text.includes(measuredTail[0].str));
  },
);
for (const [name, previous] of [
  ["full-width terminal sentence", fullWidthSentence],
  [
    "near-aligned terminal jitter",
    terminalRows([...Array(10).fill(520), 514], 10),
  ],
]) {
  previous.at(-1).str = terminalTexts.at(-1);
  await check(
    `${name} on the prior page is not a flush-start proof`,
    async () => {
      const result = await getPdfLayoutParagraph(
        contextReader(previous),
        newFlushParagraph[1].str,
        1,
      );
      assert.equal(result.kind, "unmatched");
    },
  );
}
const unboundedFlush = newFlushParagraph.map((row) => ({ ...row }));
unboundedFlush.at(-1).str =
  "The later discussion continues with additional evidence not yet available";
await check(
  "a proved flush start cannot bypass the current paragraph's end",
  async () => {
    const result = await getPdfLayoutParagraph(
      contextReader(measuredTail, unboundedFlush),
      unboundedFlush[1].str,
      1,
    );
    assert.equal(result.kind, "unmatched");
  },
);
const priorOpenSuffix = [
  ...measuredTail,
  item(
    82,
    520,
    "A later unbounded paragraph starts below the earlier complete argument",
    441.2,
    9.96,
  ),
  item(
    72,
    506.8,
    "Further observations stay in this still unfinished later paragraph",
    451.2,
    9.96,
  ),
  item(
    72,
    493.6,
    "The later argument remains incomplete across the page boundary",
    451.2,
    9.96,
  ),
];
await check(
  "an earlier complete paragraph cannot prove an uncovered prior suffix",
  async () => {
    const result = await getPdfLayoutParagraph(
      contextReader(priorOpenSuffix),
      newFlushParagraph[1].str,
      1,
    );
    assert.equal(result.kind, "unmatched");
  },
);
const styled = [
  item(65, 680, "ζ ", 12, 18),
  item(
    80,
    680,
    "explains the complete acoustic argument in this paragraph",
    455,
  ),
  item(
    55,
    662,
    "Additional observations reinforce the naturally bounded discussion.",
    480,
  ),
  item(
    55,
    644,
    "These measurements complete the original acoustic argument.",
    250,
  ),
  item(
    65,
    626,
    "The next independent paragraph introduces another argument.",
    470,
  ),
];
await check(
  "first mathematical glyph does not replace dominant body font",
  () =>
    assert.equal(
      paragraphFromLayout(styled, "complete acoustic argument", 595).text,
      "ζ explains the complete acoustic argument in this paragraph Additional observations reinforce the naturally bounded discussion. These measurements complete the original acoustic argument.",
    ),
);
const pageWith = (rows) => ({
  viewBox: [0, 0, 612, 800],
  chars: rows.flatMap(([x, y, text]) =>
    Array.from(text, (c, i) => ({
      c,
      rect: [x + i * 3, y, x + (i + 1) * 3, y + 8],
      fontSize: 9,
      baseline: y,
      lineBreakAfter: i === text.length - 1,
    })),
  ),
});
const previousRows = [
  [312, 460, "An earlier paragraph ends on this side of the page."],
  [322, 447, "The pending paragraph describes numerical propagation,"],
  [312, 437, "and continues through a sequence of experiments"],
];
const followingRows = [
  [59, 710, "Fig. 9 Caption above the continued numerical discussion"],
  [59, 700, "lowercase description of independent quantities in the figure"],
  [59, 690, "another caption sentence describes an unrelated comparison"],
  [59, 680, "further caption observations finish with their own conclusion."],
  [59, 640, "and returns to the same numerical interpretation,"],
  [59, 630, "with all further measurements matching the model"],
  [59, 620, "before the original discussion finally concludes."],
  [69, 607, "The next separate paragraph starts with an independent question."],
  [59, 597, "Additional unrelated material continues under that question."],
];
const previous = pageWith(previousRows),
  following = pageWith(followingRows);
const continuation = [...previousRows.slice(1), ...followingRows.slice(4, 7)]
  .map((row) => row[2])
  .join(" ");
await check(
  "long figure caption must not become a cross-page continuation",
  () =>
    assert.equal(
      paragraphAcrossNextPage(
        previous,
        following,
        "pending paragraph describes",
      ).text,
      continuation,
    ),
);
await check("backward continuation must skip entire caption block", () =>
  assert.equal(
    paragraphAcrossPreviousPage(
      previous,
      following,
      "further measurements matching",
    ).text,
    continuation,
  ),
);
const crop = (data) => ({
  viewBox: [200, 30, 812, 830],
  chars: data.chars.map((c) => ({
    ...c,
    baseline: c.baseline + 30,
    rect: c.rect.map((v, i) => v + (i % 2 ? 30 : 200)),
  })),
});
await check("nonzero viewBox origin preserves cross-page column order", () =>
  assert.equal(
    paragraphAcrossNextPage(
      crop(previous),
      crop(following),
      "pending paragraph describes",
    ).text,
    continuation,
  ),
);
await check(
  "short positioned word can anchor backward cached-page continuation",
  async () => {
    const source = followingRows[5];
    const offset = source[2].indexOf("model");
    const result = await getPdfLayoutParagraph(
      {
        _internalReader: {
          _primaryView: { _pdfPages: { 7: previous, 8: following } },
        },
      },
      "model",
      8,
      [
        [
          source[0] + offset * 3,
          source[1],
          source[0] + (offset + 5) * 3,
          source[1] + 8,
        ],
      ],
    );
    assert.equal(result.text, continuation);
  },
);
const fontHeavy = [];
for (let i = 0; i < 20; i++)
  fontHeavy.push(
    item(
      55,
      790 - i * 8,
      i
        ? `additional small-caption observation ${i} explains an unrelated graphical quantity`
        : "Fig. 2 Small-caption observations occupy the upper portion of the page",
      220,
      7,
    ),
  );
fontHeavy.push(
  ...afterHeading.map((row) => ({
    ...row,
    transform: [
      ...row.transform.slice(0, 4),
      row.transform[4],
      row.transform[5] - 100,
    ],
  })),
);
await check(
  "caption-heavy page cannot redefine the main prose as headings",
  () =>
    assert.equal(
      paragraphFromLayout(fontHeavy, "remaining observations", 595).text,
      afterHeading
        .slice(1, 4)
        .map((row) => row.str)
        .join(" "),
    ),
);
const boldCaption = {
  ...following,
  chars: following.chars.map((char) =>
    char.baseline >= 680 ? { ...char, fontName: "Caption-Bold" } : char,
  ),
};
await check("all lines of a bold caption are excluded from continuation", () =>
  assert.equal(
    paragraphAcrossNextPage(
      previous,
      boldCaption,
      "pending paragraph describes",
    ).text,
    continuation,
  ),
);
const legend = pageWith([
  [59, 650, "Mean acoustic quantities in the measured plot"],
]);
legend.chars.forEach((char) => {
  char.fontSize = 7;
  char.fontName = "Plot-Bold";
  char.rect[3] = char.rect[1] + 7;
});
const withLegend = {
  ...following,
  chars: [...following.chars, ...legend.chars],
};
await check("small bold plot legend is not a section boundary", () =>
  assert.equal(
    paragraphAcrossNextPage(previous, withLegend, "pending paragraph describes")
      .text,
    continuation,
  ),
);
const tight = mixed.slice(13).map((row) => ({
  ...row,
  hasEOL: true,
  transform: [
    ...row.transform.slice(0, 4),
    row.transform[4] >= 315 ? row.transform[4] - 16 : row.transform[4],
    row.transform[5],
  ],
}));
await check(
  "explicit row ends protect independent columns with a narrow gutter",
  () =>
    assert.equal(
      paragraphFromLayout(tight, "right body paragraph analyses", 595).text,
      right.join(" "),
    ),
);
const mixedSplit = mixed.flatMap((row, index) =>
  index >= 12
    ? [row]
    : [
        item(
          row.transform[4],
          row.transform[5],
          row.str.slice(0, 35),
          300 - row.transform[4],
          11,
          { hasEOL: false },
        ),
        item(302, row.transform[5], row.str.slice(35), 233, 11, {
          hasEOL: true,
        }),
      ],
);
await check(
  "split full-width abstract coexists with genuine two-column body",
  () => {
    assert.equal(
      paragraphFromLayout(mixedSplit, "right body paragraph analyses", 595)
        .text,
      right.join(" "),
    );
    assert.equal(
      paragraphFromLayout(mixedSplit, "Full width abstract statement 0", 595, [
        [100, 790, 130, 800],
      ]).text,
      mixed
        .slice(0, 12)
        .map((row) => row.str)
        .join(" "),
    );
  },
);
await check(
  "terminal sentence without following boundary is not an open-page completion",
  () =>
    assert.equal(
      paragraphAcrossNextPage(
        previous,
        pageWith(followingRows.slice(4, 7)),
        "pending paragraph describes",
      ).kind,
      "unmatched",
    ),
);
await check(
  "a cross-page range omitting intervening native text is not guessed",
  async () => {
    let calls = 0;
    const result = await getPdfLayoutParagraph(
      {
        _internalReader: {
          _primaryView: {
            _pdfPages: { 7: previous, 8: following },
            _iframeWindow: {
              PDFViewerApplication: {
                pdfDocument: {
                  numPages: 9,
                  getPageData: async () => {
                    calls++;
                    throw Error("must not retry");
                  },
                  getPage: async () => {
                    calls++;
                    throw Error("must not retry");
                  },
                },
              },
            },
          },
        },
      },
      continuation + " The next separate paragraph",
      7,
    );
    assert.equal(result.kind, "unmatched");
    assert.equal(result.detail, "end-outside-visible-column");
    assert.equal(
      calls,
      1,
      "one text fallback is allowed for an unlocatable native selection",
    );
  },
);
const formulas = [
  item(55, 680, "(1) pressure = density * speed", 230),
  item(55, 662, "(2) momentum = mass * velocity", 230),
  item(55, 644, "(3) energy = mass * acceleration", 230),
];
await check(
  "numbered equations are not silently interpreted as prose lists",
  () =>
    assert.equal(
      paragraphFromLayout(formulas, "density", 595, [[110, 680, 140, 690]])
        .kind,
      "unmatched",
    ),
);
const literalSpace = [
  item(65, 680, "A measured analytic", 235),
  item(300, 680, "\u2009", 1),
  item(301, 680, "response explains the naturally bounded paragraph", 234),
  item(
    55,
    662,
    "Further observations remain in the original physical discussion.",
    480,
  ),
  item(55, 644, "These observations complete the original argument.", 230),
  item(65, 626, "A separate following paragraph starts here.", 470),
];
await check("explicit whitespace item survives font-fragment assembly", () =>
  assert.equal(
    paragraphFromLayout(literalSpace, "measured analytic", 595).text,
    "A measured analytic response explains the naturally bounded paragraph Further observations remain in the original physical discussion. These observations complete the original argument.",
  ),
);
await check(
  "text API crop normalization ignores marked-content metadata",
  async () => {
    const moved = afterHeading.map((row) => ({
      ...row,
      transform: [
        ...row.transform.slice(0, 4),
        row.transform[4] + 200,
        row.transform[5] + 30,
      ],
    }));
    const result = await getPdfLayoutParagraph(
      {
        _internalReader: {
          _primaryView: {
            _iframeWindow: {
              PDFViewerApplication: {
                pdfDocument: {
                  numPages: 1,
                  getPage: async () => ({
                    view: [200, 30, 795, 872],
                    getTextContent: async () => ({
                      items: [{ type: "beginMarkedContent" }, ...moved],
                    }),
                  }),
                },
              },
            },
          },
        },
      },
      "remaining observations",
      0,
    );
    assert.equal(
      result.text,
      afterHeading
        .slice(1, 4)
        .map((row) => row.str)
        .join(" "),
    );
  },
);
const alignedCaptionRows = [
  ...followingRows
    .slice(4, 7)
    .map(([x, y, text]) => [x, y, text, 300 - x, false]),
  [69, 607, followingRows[7][2], 230, false],
  [59, 597, followingRows[8][2], 240, false],
  [
    312,
    640,
    "Fig. 9 Independent caption beside the continued prose",
    240,
    true,
  ],
  [
    312,
    630,
    "another caption observation about a different plotted result",
    240,
    true,
  ],
  [
    312,
    620,
    "the caption finishes with a separate unrelated conclusion.",
    200,
    true,
  ],
];
const alignedPage = {
  viewBox: [0, 0, 612, 800],
  chars: alignedCaptionRows.flatMap(([x, y, text, width, bold]) =>
    Array.from(text, (c, i) => ({
      c,
      rect: [
        x + (i * width) / text.length,
        y,
        x + ((i + 1) * width) / text.length,
        y + 8,
      ],
      fontSize: 9,
      baseline: y,
      fontName: bold ? "Caption-Bold" : "Body-Regular",
      lineBreakAfter: i === text.length - 1,
    })),
  ),
};
await check(
  "parallel same-baseline bold caption never merges into native prose",
  () =>
    assert.equal(
      paragraphAcrossNextPage(
        previous,
        alignedPage,
        "pending paragraph describes",
      ).text,
      continuation,
    ),
);
const alignedItems = alignedCaptionRows.map(([x, y, text, width, bold]) =>
  item(x, y, text, width, 9, { bold }),
);
await check(
  "parallel caption without EOL metadata does not merge into text prose",
  () => {
    const result = paragraphFromLayout(
      [
        ...alignedItems,
        item(
          69,
          668,
          "The bounded paragraph starts above the parallel figure caption.",
          230,
          9,
        ),
        item(
          59,
          658,
          "Its continuing measurements remain within the same discussion",
          240,
          9,
        ),
      ],
      "continuing measurements",
      612,
    );
    assert.equal(
      result.text,
      [
        "The bounded paragraph starts above the parallel figure caption.",
        "Its continuing measurements remain within the same discussion",
        ...followingRows.slice(4, 7).map((row) => row[2]),
      ].join(" "),
    );
  },
);
if (failures.length)
  throw new Error(
    `${failures.length}/${probes} edge cases failed:\n` + failures.join("\n"),
  );
console.log(
  `PDF layout edges: ${probes} full-content, position, boundary and continuation regressions passed`,
);

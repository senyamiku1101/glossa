/**
 * Runtime-free checks for unified layout coordinate calibration (Paddle + MinerU)
 * and PDF-reader alignment (`readerAlign.ts`).
 */
/* global Buffer, URL, TextEncoder, TextDecoder, DecompressionStream, console */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function load(path, imports = {}, globals = {}) {
  const { outputText } = ts.transpileModule(
    await readFile(new URL("../" + path, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  );
  const module = { exports: {} };
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (name) => {
      assert.ok(name in imports, `Unexpected dependency ${name} in ${path}`);
      return imports[name];
    },
    URL,
    TextEncoder,
    TextDecoder,
    DecompressionStream,
    Uint8Array,
    ArrayBuffer,
    DataView,
    console,
    ...globals,
  });
  return module.exports;
}

const types = await load("src/modules/markdownPrep/types.ts");
const quality = await load("src/modules/markdownPrep/quality.ts", {
  "./types": types,
});
const assets = await load("src/modules/markdownPrep/assets.ts", {
  "./types": types,
});
const paddleAssets = await load("src/modules/markdownPrep/paddleAssets.ts", {
  "./types": types,
});
const paddleConvert = await load("src/modules/markdownPrep/paddleConvert.ts", {
  "./types": types,
  "./quality": quality,
  "./assets": assets,
});
const mineru = await load("src/modules/markdownPrep/mineru.ts", {
  "./types": types,
  "./quality": quality,
  "./settings": {},
  "./sources": {},
  "./paddleAssets": paddleAssets,
  "../../utils/paths": {},
});
const align = await load("src/modules/markdownPrep/readerAlign.ts", {
  "./types": types,
});

const sourceFingerprint = {
  attachmentKey: "PDF00001",
  libraryID: 1,
  filename: "aero.pdf",
  md5: "0123456789abcdef0123456789abcdef",
  size: 2048,
  mtime: 1700000000000,
  pageCount: 2,
};

// Minimal valid PNG with 1200x1600 dimensions in IHDR.
const png1200x1600 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x04, 0xb0, 0x00, 0x00, 0x06, 0x40,
]);

// 1. Paddle coordinate normalization via dataInfo.pages + inputImage PNG header
const paddleJsonl = JSON.stringify({
  result: {
    dataInfo: {
      pages: [{ width: 1000, height: 2000 }],
    },
    layoutParsingResults: [
      {
        markdown: {
          text:
            "For an arbitrary quantity $\\Phi$ inside a stator, it can be decomposed as equation (30).\n\n" +
            "$$\n\\widehat{\\Phi'''} = 0\n$$\n\n" +
            "![Fig 31](imgs/fig31.png)\n\n" +
            "Fig. 31. Total pressure ratio at fan face.",
        },
        prunedResult: {
          parsing_res_list: [
            {
              block_label: "text",
              block_content:
                "For an arbitrary quantity $\\Phi$ inside a stator, it can be decomposed as equation (30).",
              block_bbox: [100, 200, 500, 400],
            },
            {
              block_label: "display_formula",
              block_content: "$$\n\\widehat{\\Phi'''} = 0\n$$",
              block_bbox: [100, 420, 500, 500],
            },
            {
              block_label: "image",
              block_content: "![Fig 31](imgs/fig31.png)",
              block_bbox: [100, 600, 500, 1400],
            },
            {
              block_label: "figure_title",
              block_content: "Fig. 31. Total pressure ratio at fan face.",
              block_bbox: [100, 1420, 500, 1500],
            },
          ],
        },
      },
      {
        inputImage: Buffer.from(png1200x1600).toString("base64"),
        markdown: { text: "Second page conclusion paragraph." },
        prunedResult: {
          parsing_res_list: [
            {
              block_label: "text",
              block_content: "Second page conclusion paragraph.",
              block_bbox: [120, 160, 1080, 320],
            },
          ],
        },
      },
    ],
  },
});

const paddleRes = paddleConvert.convertPaddleJsonl({
  jsonl: paddleJsonl,
  source: sourceFingerprint,
  model: "PP-StructureV3",
  assets: [
    {
      kind: "figure",
      pageIndex: 0,
      filename: "images/fig31.png",
      mime: "image/png",
      bytes: png1200x1600,
    },
  ],
});

const plain = (v) => JSON.parse(JSON.stringify(v));

assert.equal(paddleRes.body.blocks.length, 5);
assert.equal(paddleRes.body.blocks[0].pageRectsSpace, "page-fraction");
assert.deepEqual(
  plain(paddleRes.body.blocks[0].pageRects[0]),
  [0, 0.1, 0.1, 0.5, 0.2],
);
assert.equal(paddleRes.body.blocks[1].type, "equation");
assert.equal(paddleRes.body.blocks[2].type, "image");
assert.equal(paddleRes.body.blocks[2].assetPath, "images/fig31.png");
assert.equal(paddleRes.body.blocks[3].type, "caption");
// Page 2 inferred 1200x1600 from inline PNG header
assert.equal(paddleRes.body.blocks[4].pageRectsSpace, "page-fraction");
assert.deepEqual(
  plain(paddleRes.body.blocks[4].pageRects[0]),
  [1, 0.1, 0.1, 0.9, 0.2],
);

// 2. MinerU content_list.json (0..1000) & middle_json.json (0..1) -> page-fraction blocks
const mineruMd =
  "# Appendix A\n\n" +
  "The moving average process is derived thoroughly.\n\n" +
  "$$\n\\frac{\\partial \\Phi}{\\partial r} = 0\n$$\n\n" +
  "![](images/fig31.png)\n\n" +
  "Fig. 31. Fan face pressure ratio.";
const mineruContentList = [
  {
    type: "text",
    text_level: 1,
    text: "Appendix A",
    page_idx: 0,
    bbox: [80, 50, 480, 90],
  },
  {
    type: "text",
    text: "The moving average process is derived thoroughly.",
    page_idx: 0,
    bbox: [80, 110, 480, 210],
  },
  {
    type: "equation",
    text: "\\frac{\\partial \\Phi}{\\partial r} = 0",
    page_idx: 0,
    bbox: [80, 230, 480, 310],
  },
  {
    type: "image",
    img_path: "images/fig31.png",
    image_caption: ["Fig. 31. Fan face pressure ratio."],
    page_idx: 0,
    bbox: [520, 100, 920, 700],
  },
  {
    type: "discarded",
    text: "Page 17",
    page_idx: 0,
    bbox: [900, 10, 950, 40],
  },
];
const mineruRes = mineru.mineruZipBody([
  { name: "full.md", bytes: new TextEncoder().encode(mineruMd) },
  {
    name: "task_content_list.json",
    bytes: new TextEncoder().encode(JSON.stringify(mineruContentList)),
  },
  { name: "images/fig31.png", bytes: png1200x1600 },
]);
assert.equal(mineruRes.blocks.length, 4);
assert.equal(mineruRes.blocks[0].type, "heading");
assert.equal(mineruRes.blocks[0].pageRectsSpace, "page-fraction");
assert.deepEqual(
  plain(mineruRes.blocks[0].pageRects[0]),
  [0, 0.08, 0.05, 0.48, 0.09],
);
assert.equal(mineruRes.blocks[2].type, "equation");
assert.ok(mineruRes.blocks[2].text.includes("$$"));
assert.equal(mineruRes.blocks[3].type, "image");
assert.equal(mineruRes.blocks[3].assetPath, mineruRes.assets[0].filename);
assert.equal(mineruRes.blocks[3].caption, "Fig. 31. Fan face pressure ratio.");

// MinerU 4.0 docvortex middle_json.json (0..1 boxes)
const docvortexRes = mineru.mineruZipBody([
  { name: "full.md", bytes: new TextEncoder().encode("Steady flow field.") },
  {
    name: "middle_json.json",
    bytes: new TextEncoder().encode(
      JSON.stringify({
        pages: [
          {
            page_idx: 0,
            blocks: [
              {
                type: "paragraph",
                bbox: [0.1, 0.2, 0.5, 0.3],
                content: [{ content: "Steady flow field." }],
              },
            ],
          },
        ],
      }),
    ),
  },
]);
assert.equal(docvortexRes.blocks.length, 1);
assert.deepEqual(
  plain(docvortexRes.blocks[0].pageRects[0]),
  [0, 0.1, 0.2, 0.5, 0.3],
);

// 3. Coordinate conversion: Zotero PDF bottom-left viewBox -> top-left [0..1]
// viewBox [0, 0, 600, 800], rect y=640..720 is top 10%..20% of the page.
const fracs = align.pdfRectsToFractions(
  [[60, 640, 300, 720]],
  [0, 0, 600, 800],
);
assert.equal(fracs.length, 1);
assert.ok(Math.abs(fracs[0][0] - 0.1) < 1e-6);
assert.ok(Math.abs(fracs[0][1] - 0.1) < 1e-6);
assert.ok(Math.abs(fracs[0][2] - 0.5) < 1e-6);
assert.ok(Math.abs(fracs[0][3] - 0.2) < 1e-6);

// 4. Geometry-first alignment restores garbled math symbols & keeps inline LaTeX intact
const alignedFull = align.alignSelectionToMarkdown({
  markdown: paddleRes.body.markdown,
  blocks: paddleRes.body.blocks,
  pageIndex: 0,
  // Simulated PDF.js selection where Φ dropped out and hyphenation broke a word
  selection:
    "For an arbitrary quan- tity  inside a stator, it can be decomposed as equation (30).",
  rects: [[60, 640, 300, 720]],
  viewBox: [0, 0, 600, 800],
});
assert.equal(alignedFull.kind, "matched");
assert.equal(alignedFull.via, "geometry");
assert.equal(alignedFull.selectionEnhanced, true);
assert.ok(alignedFull.selectionText.includes("$\\Phi$"));
assert.ok(alignedFull.paragraphText.includes("$\\Phi$"));

// 5. Sub-span extraction inside a longer paragraph never slices inline `$...$` LaTeX
const longPara =
  "The moving average process is derived thoroughly. " +
  "For an arbitrary quantity $\\Phi(x, r, \\theta)$ inside a stator, it can be decomposed as equation (30). " +
  "Subsequent boundary conditions are applied downstream.";
const subBlocks = [
  {
    type: "paragraph",
    pageIndex: 0,
    pageRects: [[0, 0.1, 0.1, 0.5, 0.3]],
    pageRectsSpace: "page-fraction",
    text: longPara,
    mdStart: 0,
    mdEnd: longPara.length,
  },
];
const alignedSub = align.alignSelectionToMarkdown({
  markdown: longPara,
  blocks: subBlocks,
  pageIndex: 0,
  selection:
    "For an arbitrary quantity (x, r, ) inside a stator, it can be decomposed",
  rects: [[60, 620, 300, 680]],
  viewBox: [0, 0, 600, 800],
});
assert.equal(alignedSub.kind, "matched");
assert.equal(alignedSub.selectionEnhanced, true);
assert.ok(alignedSub.selectionText.includes("$\\Phi(x, r, \\theta)$"));
assert.ok(!alignedSub.selectionText.includes("Subsequent boundary"));
assert.equal(alignedSub.paragraphText, longPara);

// 6. Short ambiguous word keeps raw selection safely while still providing paragraphText
const alignedShort = align.alignSelectionToMarkdown({
  markdown: longPara,
  blocks: subBlocks,
  pageIndex: 0,
  selection: "stator",
  rects: [[120, 640, 160, 660]],
  viewBox: [0, 0, 600, 800],
});
assert.equal(alignedShort.kind, "matched");
assert.equal(alignedShort.selectionEnhanced, false);
assert.equal(alignedShort.selectionText, "stator");
assert.equal(alignedShort.paragraphText, longPara);

// 7. Legacy service-pixels blocks (without pageSize) infer Paddle 144 DPI from viewBox
const legacyBlocks = [
  {
    type: "paragraph",
    pageIndex: 0,
    // 600x800 pt at 144 DPI = 1200x1600 px -> [120, 160, 600, 320] = [0.1, 0.1, 0.5, 0.2]
    pageRects: [[0, 120, 160, 600, 320]],
    pageRectsSpace: "service-pixels",
    text: "Legacy cached paragraph with $\\alpha + \\beta$.",
    mdStart: 0,
    mdEnd: 45,
  },
];
const alignedLegacy = align.alignSelectionToMarkdown({
  markdown: "Legacy cached paragraph with $\\alpha + \\beta$.",
  blocks: legacyBlocks,
  pageIndex: 0,
  selection: "Legacy cached paragraph with  + .",
  rects: [[60, 640, 300, 720]],
  viewBox: [0, 0, 600, 800],
});
assert.equal(alignedLegacy.kind, "matched");
assert.equal(alignedLegacy.via, "geometry");
assert.ok(alignedLegacy.selectionText.includes("$\\alpha + \\beta$"));

// 8. Fallback without blocks.json uses <!-- page N --> comments cleanly
const pageMd =
  "<!-- page 1 -->\n\nFirst page introduction with $\\gamma$.\n\n<!-- page 2 -->\n\nSecond page discussion of turbulent boundary layers.";
const alignedTextFallback = align.alignSelectionToMarkdown({
  markdown: pageMd,
  blocks: [],
  pageIndex: 1,
  selection: "discussion of turbulent boundary layers",
});
assert.equal(alignedTextFallback.kind, "matched");
assert.equal(alignedTextFallback.via, "text");
assert.ok(
  alignedTextFallback.paragraphText.includes("turbulent boundary layers"),
);

// 9. Visual region alignment links figure box + adjacent caption, and equation box -> LaTeX
// Paddle page 0: image is y=[0.3..0.7], caption is y=[0.71..0.75].
// In 600x800 PDF points (bottom-left): y=[0.3..0.7] top-down -> [240..560] bottom-up.
const visualFig = align.alignRegionToVisual({
  markdown: paddleRes.body.markdown,
  blocks: paddleRes.body.blocks,
  pageIndex: 0,
  rects: [[60, 240, 300, 560]],
  viewBox: [0, 0, 600, 800],
});
assert.ok(visualFig);
assert.equal(visualFig.kind, "figure");
assert.equal(visualFig.assetPath, "images/fig31.png");
assert.equal(visualFig.caption, "Fig. 31. Total pressure ratio at fan face.");

// Equation box is y=[0.21..0.25] top-down -> [600..632] bottom-up.
const visualEq = align.alignRegionToVisual({
  markdown: paddleRes.body.markdown,
  blocks: paddleRes.body.blocks,
  pageIndex: 0,
  rects: [[60, 600, 300, 632]],
  viewBox: [0, 0, 600, 800],
});
assert.ok(visualEq);
assert.equal(visualEq.kind, "equation");
assert.ok(visualEq.markdownText.includes("\\widehat{\\Phi'''}"));

// 10. Safety guard: unrelated text on same box must not falsely match
const mismatch = align.alignSelectionToMarkdown({
  markdown: paddleRes.body.markdown,
  blocks: paddleRes.body.blocks,
  pageIndex: 0,
  selection: "completely unrelated economics paper sentence about inflation",
  rects: [[60, 640, 300, 720]],
  viewBox: [0, 0, 600, 800],
});
assert.equal(mismatch.kind, "none");

// 11. Bug 1 regression: selecting ONLY the middle paragraph must not pull in
// adjacent paragraphs even when boxes slightly graze or vocabulary overlaps,
// nor when legacy blocks share a degenerate page-wide slice.
const para1 =
  "In this paper a procedure is described to determine the acoustic modes propagating in a lined annular duct with azimuthally varying subsonic mean flow. This model represents steady flow distortion on fan tones in a turbofan intake duct.";
const para2 =
  "The aerolines of a turbofan nacelle are designed so that the flow onto the fan in flight is as uniform as possible. The nacelle itself is often scarfed or drooped to accommodate a non-zero angle of incidence in flight. This leads to a region of non-axisymmetric mean flow upstream of the fan between the highlight and the fan face.";
const para3 =
  "A typical fan rig geometry used for noise and performance testing is shown in figure 1(a). Computed mean flow Mach contours for the intake closely resemble those in a flight intake. The proportional variation is given by $ \\epsilon $ as the ratio of $ \\Delta M $ to $ \\bar{M} $.";
const threeParaMd = `${para1}\n\n${para2}\n\n${para3}`;
const threeParaBlocks = [
  {
    type: "paragraph",
    pageIndex: 0,
    pageRects: [[0, 0.1, 0.1, 0.9, 0.25]],
    pageRectsSpace: "page-fraction",
    text: para1,
    mdStart: 0,
    mdEnd: para1.length,
  },
  {
    type: "paragraph",
    pageIndex: 0,
    pageRects: [[0, 0.1, 0.252, 0.9, 0.42]],
    pageRectsSpace: "page-fraction",
    text: para2,
    mdStart: para1.length + 2,
    mdEnd: para1.length + 2 + para2.length,
  },
  {
    type: "paragraph",
    pageIndex: 0,
    pageRects: [[0, 0.1, 0.422, 0.9, 0.62]],
    pageRectsSpace: "page-fraction",
    text: para3,
    mdStart: para1.length + 2 + para2.length + 2,
    mdEnd: threeParaMd.length,
  },
];
// Selection covers para2 (y=0.25..0.422 top-down -> [462..600] bottom-up on 600x800)
// slightly grazing both para1 and para3 borders.
const middleOnlyGeom = align.alignSelectionToMarkdown({
  markdown: threeParaMd,
  blocks: threeParaBlocks,
  pageIndex: 0,
  selection: para2,
  rects: [
    [60, 580, 540, 600],
    [60, 462, 540, 580],
  ],
  viewBox: [0, 0, 600, 800],
});
assert.equal(middleOnlyGeom.kind, "matched");
assert.equal(middleOnlyGeom.paragraphCount, 1);
assert.equal(middleOnlyGeom.paragraphText, para2);

// Text fallback path also prunes to ONLY the middle paragraph.
const middleOnlyText = align.alignSelectionToMarkdown({
  markdown: threeParaMd,
  blocks: [],
  pageIndex: 0,
  selection: para2,
});
assert.equal(middleOnlyText.kind, "matched");
assert.equal(middleOnlyText.paragraphCount, 1);
assert.equal(middleOnlyText.paragraphText, para2);

// Degenerate legacy blocks missing `text` and sharing full-page `mdStart:mdEnd`
// fall back to clean single-paragraph matching instead of returning all 3 paragraphs.
const degenerateBlocks = threeParaBlocks.map((b) => ({
  type: b.type,
  pageIndex: 0,
  pageRects: b.pageRects,
  pageRectsSpace: "page-fraction",
  mdStart: 0,
  mdEnd: threeParaMd.length,
}));
const middleDegenerate = align.alignSelectionToMarkdown({
  markdown: threeParaMd,
  blocks: degenerateBlocks,
  pageIndex: 0,
  selection: para2,
  rects: [[60, 470, 540, 595]],
  viewBox: [0, 0, 600, 800],
});
assert.equal(middleDegenerate.kind, "matched");
assert.equal(middleDegenerate.paragraphCount, 1);
assert.equal(middleDegenerate.paragraphText, para2);

// Spaced inline math from OCR (`$ \epsilon $`) is normalized cleanly in aligned Markdown
// while currency amounts remain untouched.
assert.equal(
  align.normalizeInlineMathSpacing(
    "ratio $ \\epsilon $ of $ \\Delta M $ to $ \\bar{M} $, costs $5 and $10",
  ),
  "ratio $\\epsilon$ of $\\Delta M$ to $\\bar{M}$, costs $5 and $10",
);
const para3Aligned = align.alignSelectionToMarkdown({
  markdown: threeParaMd,
  blocks: threeParaBlocks,
  pageIndex: 0,
  selection: "The proportional variation is given by e as the ratio of M to M.",
  rects: [[60, 310, 540, 450]],
  viewBox: [0, 0, 600, 800],
});
assert.equal(para3Aligned.kind, "matched");
assert.ok(para3Aligned.paragraphText.includes("$\\epsilon$"));
assert.ok(para3Aligned.paragraphText.includes("$\\Delta M$"));
assert.ok(para3Aligned.paragraphText.includes("$\\bar{M}$"));

// 12. Step 2 pure helpers: fractionRectToPdfRect round-trip, listPageVisualTargets
// (figures + tables + display equations only, figure+caption merged, noise dropped,
// duplicates pruned), and pickVisualTargetAtPoint (smallest-area hit).
const pdfRoundTrip = align.fractionRectToPdfRect(
  [0.1, 0.1, 0.5, 0.2],
  [0, 0, 600, 800],
);
assert.deepEqual(plain(pdfRoundTrip), [60, 640, 300, 720]);
const backToFrac = align.pdfRectsToFractions([pdfRoundTrip], [0, 0, 600, 800]);
assert.ok(Math.abs(backToFrac[0][0] - 0.1) < 1e-6);
assert.ok(Math.abs(backToFrac[0][1] - 0.1) < 1e-6);
assert.ok(Math.abs(backToFrac[0][2] - 0.5) < 1e-6);
assert.ok(Math.abs(backToFrac[0][3] - 0.2) < 1e-6);

const visualTargets = align.listPageVisualTargets({
  markdown: paddleRes.body.markdown,
  blocks: [
    ...paddleRes.body.blocks,
    // Tiny noise image box (< 0.03 width) must be dropped.
    {
      type: "image",
      pageIndex: 0,
      pageRects: [[0, 0.95, 0.02, 0.97, 0.04]],
      pageRectsSpace: "page-fraction",
      mdStart: 0,
      mdEnd: 0,
    },
    // Table block on page 0.
    {
      type: "table",
      pageIndex: 0,
      pageRects: [[0, 0.55, 0.4, 0.92, 0.65]],
      pageRectsSpace: "page-fraction",
      text: "| col |\n|---|\n| 1 |",
      mdStart: 0,
      mdEnd: 0,
    },
    // Nearly identical duplicate table box must be deduplicated.
    {
      type: "table",
      pageIndex: 0,
      pageRects: [[0, 0.552, 0.402, 0.918, 0.648]],
      pageRectsSpace: "page-fraction",
      text: "| col |\n|---|\n| 1 |",
      mdStart: 0,
      mdEnd: 0,
    },
  ],
  pageIndex: 0,
  viewBox: [0, 0, 600, 800],
});
// Only 3 targets on page 0: 1 equation + 1 figure (merged with its caption!) + 1 table.
assert.equal(visualTargets.length, 3);
assert.deepEqual(plain(visualTargets.map((t) => t.kind).sort()), [
  "equation",
  "figure",
  "table",
]);
const figTarget = visualTargets.find((t) => t.kind === "figure");
assert.equal(figTarget.caption, "Fig. 31. Total pressure ratio at fan face.");
// Merged bbox includes the caption bottom (1500 / 2000 = 0.75).
assert.ok(Math.abs(figTarget.bbox[1] - 0.3) < 1e-6);
assert.ok(Math.abs(figTarget.bbox[3] - 0.75) < 1e-6);

// Hit-testing picks the target containing (nx, ny) and returns undefined outside.
assert.equal(
  align.pickVisualTargetAtPoint(visualTargets, 0.3, 0.5)?.kind,
  "figure",
);
assert.equal(
  align.pickVisualTargetAtPoint(visualTargets, 0.3, 0.73)?.kind,
  "figure",
);
assert.equal(
  align.pickVisualTargetAtPoint(visualTargets, 0.3, 0.23)?.kind,
  "equation",
);
assert.equal(
  align.pickVisualTargetAtPoint(visualTargets, 0.7, 0.5)?.kind,
  "table",
);
assert.equal(
  align.pickVisualTargetAtPoint(visualTargets, 0.3, 0.15),
  undefined,
);

console.log(
  "Reader align checks passed: Paddle/MinerU normalized position map, PDF<->fraction transforms, single-paragraph pruning, spaced inline math normalization, visual hover targets, and hit-testing.",
);

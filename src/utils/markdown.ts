/**
 * Markdown → syntax tree, for rendering model answers. Pure functions only;
 * scripts/check-logic.mjs loads this file on its own.
 *
 * The tree is turned into DOM nodes one by one (src/modules/markdown.ts),
 * never into an HTML string: Zotero's windows are XHTML, where innerHTML
 * throws on any tag the regexes of a string renderer fail to balance.
 * Covers what chat models write: headings, lists (nested), code, quotes,
 * tables, rules, emphasis, links and TeX math.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "math"; text: string }
  | { type: "br" }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Align = "" | "left" | "center" | "right";

export type Block =
  | { type: "paragraph"; inline: Inline[] }
  | { type: "heading"; level: number; inline: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "math"; text: string }
  | { type: "quote"; blocks: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/;
const TABLE_DELIM =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines);
}

function indentOf(line: string) {
  return line.length - line.trimStart().length;
}

function isBlank(line: string | undefined) {
  return !line || !line.trim();
}

function isTableStart(line: string, next: string | undefined) {
  return (
    line.includes("|") &&
    next !== undefined &&
    next.includes("|") &&
    TABLE_DELIM.test(next)
  );
}

/** `$$` / `\[` alone on a line, or a whole display formula on one line. */
function isMathOpen(line: string) {
  const t = line.trim();
  return (
    t === "$$" ||
    t === "\\[" ||
    (t.length > 4 && t.startsWith("$$") && t.endsWith("$$")) ||
    (t.length > 4 && t.startsWith("\\[") && t.endsWith("\\]"))
  );
}

/** Whether `line` begins a block that ends the paragraph before it. */
function startsBlock(line: string, next: string | undefined) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    isMathOpen(line) ||
    isTableStart(line, next)
  );
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const indent = indentOf(line);
      const closing = new RegExp(
        `^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`,
      );
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end: that is a code block mid-stream.
      while (i < lines.length && !closing.test(lines[i])) {
        body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
        i++;
      }
      i++;
      blocks.push({
        type: "code",
        lang: fence[2] || "",
        text: body.join("\n"),
      });
      continue;
    }

    if (isMathOpen(line)) {
      const t = line.trim();
      const close = t.startsWith("$$") ? "$$" : "\\]";
      const open = t.startsWith("$$") ? "$$" : "\\[";
      if (t.length > open.length + close.length - 1 && t.endsWith(close)) {
        blocks.push({
          type: "math",
          text: t.slice(open.length, -close.length).trim(),
        });
        i++;
        continue;
      }
      const body = [t.slice(open.length)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith(close)) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) body.push(lines[i].trim().slice(0, -close.length));
      i++;
      blocks.push({ type: "math", text: body.join("\n").trim() });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inline: parseInline(heading[2] || ""),
      });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    if (ITEM.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        rows.push(header.map((_, c) => parseInline(cells[c] || "")));
        i++;
      }
      blocks.push({
        type: "table",
        align: header.map((_, c) => align[c] || ""),
        header: header.map((cell) => parseInline(cell)),
        rows,
      });
      continue;
    }

    const para = [line.trim()];
    i++;
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !startsBlock(lines[i], lines[i + 1])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", inline: parseInline(para.join("\n")) });
  }
  return blocks;
}

function parseList(lines: string[], start: number) {
  const first = ITEM.exec(lines[start])!;
  const ordered = /\d/.test(first[2]);
  const baseIndent = first[1].length;
  const isSibling = (line: string | undefined) => {
    const m = line === undefined ? null : ITEM.exec(line);
    return (
      !!m &&
      !HR.test(line!) &&
      /\d/.test(m[2]) === ordered &&
      m[1].length >= baseIndent &&
      m[1].length <= baseIndent + 3
    );
  };
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length && isSibling(lines[i])) {
    const m = ITEM.exec(lines[i])!;
    const markerIndent = m[1].length;
    const spaces = m[3] ? m[3].length : 1;
    const contentIndent =
      markerIndent + m[2].length + (spaces > 4 ? 1 : spaces);
    // Nested lists are often indented less than the content column.
    const belongs = (line: string) =>
      indentOf(line) >= contentIndent ||
      (ITEM.test(line) && indentOf(line) >= markerIndent + 2);
    const itemLines = [m[4] ?? ""];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && belongs(lines[j])) {
          for (; i < j; i++) itemLines.push("");
          continue;
        }
        break;
      }
      if (belongs(line)) {
        itemLines.push(line.slice(Math.min(indentOf(line), contentIndent)));
        i++;
        continue;
      }
      if (startsBlock(line, lines[i + 1])) break;
      // Lazy continuation of the item's last paragraph.
      if (isBlank(itemLines[itemLines.length - 1])) break;
      itemLines.push(line.trim());
      i++;
    }
    items.push(parseBlocks(itemLines));
    let j = i;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (!isSibling(lines[j])) break;
    i = j;
  }
  return {
    block: {
      type: "list" as const,
      ordered,
      start: ordered ? parseInt(first[2], 10) : 1,
      items,
    },
    next: i,
  };
}

function splitRow(line: string) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "\\" && s[k + 1] === "|") {
      cell += "|";
      k++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

// ---- inline

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const LINK = /^\[([^\]\n]*)\]\(\s*<?([^()\s<>]+)>?(?:\s+"[^"\n]*")?\s*\)/;

function runLength(src: string, i: number) {
  let n = 0;
  while (src[i + n] === src[i]) n++;
  return n;
}

/** End of the code span opening at `i`, or -1. */
function codeSpanEnd(src: string, i: number) {
  const len = runLength(src, i);
  let j = src.indexOf("`", i + len);
  while (j >= 0) {
    const run = runLength(src, j);
    if (run === len) return j + len;
    j = src.indexOf("`", j + run);
  }
  return -1;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === "\\") {
      const next = src[i + 1];
      if (next === "(" || next === "[") {
        const close = src.indexOf(next === "(" ? "\\)" : "\\]", i + 2);
        if (close > i + 2) {
          flush();
          out.push({ type: "math", text: src.slice(i + 2, close).trim() });
          i = close + 2;
          continue;
        }
      }
      if (next === "\n") {
        flush();
        out.push({ type: "br" });
        i += 2;
        continue;
      }
      if (next && PUNCTUATION.test(next)) {
        text += next;
        i += 2;
        continue;
      }
      text += c;
      i++;
      continue;
    }

    if (c === "\n") {
      flush();
      out.push({ type: "br" });
      i++;
      continue;
    }

    if (c === "`") {
      const len = runLength(src, i);
      const end = codeSpanEnd(src, i);
      if (end < 0) {
        text += src.slice(i, i + len);
        i += len;
        continue;
      }
      let code = src.slice(i + len, end - len).replace(/\n/g, " ");
      if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
      flush();
      out.push({ type: "code", text: code });
      i = end;
      continue;
    }

    if (c === "$") {
      const delim = src[i + 1] === "$" ? "$$" : "$";
      const from = i + delim.length;
      const close = src.indexOf(delim, from);
      const inner = close > from ? src.slice(from, close) : "";
      const ok =
        inner &&
        (delim === "$$" ||
          (!/^\s|\s$/.test(inner) &&
            !inner.includes("\n") &&
            !/\d/.test(src[close + 1] ?? "")));
      if (ok) {
        flush();
        out.push({ type: "math", text: inner.trim() });
        i = close + delim.length;
        continue;
      }
      text += c;
      i++;
      continue;
    }

    if (c === "[") {
      const link = LINK.exec(src.slice(i));
      if (link) {
        flush();
        out.push({
          type: "link",
          href: link[2],
          children: parseInline(link[1]),
        });
        i += link[0].length;
        continue;
      }
    }

    if (c === "*" || c === "_" || c === "~") {
      const found = parseDelimited(src, i);
      if (found) {
        flush();
        out.push(found.node);
        i = found.end;
        continue;
      }
      const len = runLength(src, i);
      text += src.slice(i, i + len);
      i += len;
      continue;
    }

    text += c;
    i++;
  }
  flush();
  return out;
}

/**
 * Emphasis opening at `i`, closed within the same paragraph. Looser than
 * CommonMark on purpose: `**粗体**：` must work without spaces around it.
 */
function parseDelimited(
  src: string,
  i: number,
): { node: Inline; end: number } | undefined {
  const c = src[i];
  const run = runLength(src, i);
  if (c === "~" && run !== 2) return undefined;
  const len = c === "~" ? 2 : Math.min(run, 3);
  const after = src[i + len];
  if (!after || /\s/.test(after)) return undefined;
  if (c === "_" && WORD.test(src[i - 1] ?? "")) return undefined;

  let j = i + len;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "`") {
      const end = codeSpanEnd(src, j);
      j = end < 0 ? j + 1 : end;
      continue;
    }
    if (ch !== c) {
      j++;
      continue;
    }
    const here = runLength(src, j);
    const closes =
      here >= len &&
      j > i + len &&
      !/\s/.test(src[j - 1]) &&
      !(c === "_" && WORD.test(src[j + len] ?? ""));
    if (closes) {
      const inner = parseInline(src.slice(i + len, j));
      const node: Inline =
        c === "~"
          ? { type: "del", children: inner }
          : len === 1
            ? { type: "em", children: inner }
            : len === 2
              ? { type: "strong", children: inner }
              : {
                  type: "strong",
                  children: [{ type: "em", children: inner }],
                };
      return { node, end: j + len };
    }
    if (here > len) {
      // A longer run opens nested emphasis (`*a **b** c*`); skip over it.
      const nested = parseDelimited(src, j);
      j = nested ? nested.end : j + here;
      continue;
    }
    j += here;
  }
  return undefined;
}

// ---- TeX

export type MathPart = { text: string; script?: "sup" | "sub" };

// prettier-ignore
const TEX_SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ",
  omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ",
  Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  sim: "∼", approx: "≈", simeq: "≃", equiv: "≡", neq: "≠", ne: "≠",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ll: "≪", gg: "≫", pm: "±", mp: "∓",
  times: "×", cdot: "·", div: "÷", ast: "∗", circ: "∘", infty: "∞",
  partial: "∂", nabla: "∇", sum: "∑", prod: "∏", int: "∫", oint: "∮",
  sqrt: "√", propto: "∝", to: "→", rightarrow: "→", leftarrow: "←",
  Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔", iff: "⇔",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩",
  forall: "∀", exists: "∃", degree: "°", circledast: "⊛", ldots: "…",
  cdots: "⋯", dots: "…", prime: "′", perp: "⊥", parallel: "∥", angle: "∠",
  quad: "  ", qquad: "    ",
};

/**
 * TeX as readable text: common symbols become Unicode, ^ and _ become
 * super/subscripts. Not a typesetter; it keeps unknown commands as typed.
 */
export function texToParts(tex: string): MathPart[] {
  let s = tex
    .replace(/\\(?:left|right|big|Big|bigg|Bigg|displaystyle)\b\s*/g, "")
    .replace(
      /\\(?:text|mathrm|mathbf|mathit|operatorname|boldsymbol|mathcal)\s*\{([^{}]*)\}/g,
      "$1",
    )
    .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)")
    .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
    .replace(/\\[,;: !]/g, " ")
    .replace(/\\\\/g, " ")
    .replace(/\\([A-Za-z]+)/g, (m, name: string) => TEX_SYMBOLS[name] ?? m);
  s = s.replace(/\(([A-Za-z0-9α-ωΑ-Ω])\)\/\(([A-Za-z0-9α-ωΑ-Ω])\)/g, "$1/$2");

  const parts: MathPart[] = [];
  let text = "";
  let k = 0;
  while (k < s.length) {
    const ch = s[k];
    if ((ch === "^" || ch === "_") && k + 1 < s.length) {
      let arg: string;
      if (s[k + 1] === "{") {
        const close = s.indexOf("}", k + 2);
        arg = close < 0 ? s.slice(k + 2) : s.slice(k + 2, close);
        k = close < 0 ? s.length : close + 1;
      } else {
        arg = s[k + 1];
        k += 2;
      }
      if (text) parts.push({ text });
      text = "";
      parts.push({
        text: arg.replace(/[{}]/g, ""),
        script: ch === "^" ? "sup" : "sub",
      });
      continue;
    }
    if (ch !== "{" && ch !== "}") text += ch;
    k++;
  }
  if (text) parts.push({ text });
  return parts;
}

import {
  parseMarkdown,
  texToParts,
  type Block,
  type Inline,
} from "../utils/markdown";

const NS = "http://www.w3.org/1999/xhtml";

/**
 * Render Markdown into `target` by building elements one by one. No HTML
 * strings: Zotero's windows are XHTML, where innerHTML throws on markup
 * that is not well-formed and model output is never guaranteed to be.
 */
export function renderMarkdown(target: HTMLElement, src: string) {
  const doc = target.ownerDocument as Document;
  try {
    const frag = doc.createDocumentFragment();
    for (const block of parseMarkdown(src))
      frag.append(renderBlock(doc, block));
    target.replaceChildren(frag);
  } catch (error) {
    // Showing the raw text beats showing nothing.
    ztoolkit.log("[Glossa] markdown rendering failed", error);
    target.textContent = src;
  }
}

function el(doc: Document, tag: string, className?: string) {
  const node = doc.createElementNS(NS, tag) as HTMLElement;
  if (className) node.className = className;
  return node;
}

function renderBlock(doc: Document, block: Block): Node {
  switch (block.type) {
    case "paragraph":
      return withInline(el(doc, "p"), block.inline);
    case "heading":
      return withInline(el(doc, `h${block.level}`), block.inline);
    case "hr":
      return el(doc, "hr");
    case "code": {
      const pre = el(doc, "pre");
      const code = el(doc, "code");
      code.textContent = block.text;
      if (block.lang) code.dataset.lang = block.lang;
      pre.append(code);
      return pre;
    }
    case "math":
      return renderMath(
        el(doc, "div", "glossa-math glossa-math-block"),
        block.text,
      );
    case "quote": {
      const quote = el(doc, "blockquote");
      for (const child of block.blocks) quote.append(renderBlock(doc, child));
      return quote;
    }
    case "list": {
      const list = el(doc, block.ordered ? "ol" : "ul");
      if (block.ordered && block.start !== 1) {
        list.setAttribute("start", String(block.start));
      }
      for (const item of block.items) {
        const li = el(doc, "li");
        item.forEach((child, index) => {
          // Keep tight items compact: no <p> margin around the first line.
          if (index === 0 && child.type === "paragraph") {
            withInline(li, child.inline);
          } else {
            li.append(renderBlock(doc, child));
          }
        });
        list.append(li);
      }
      return list;
    }
    case "table": {
      const wrap = el(doc, "div", "glossa-table");
      const table = el(doc, "table");
      const head = el(doc, "thead");
      const headRow = el(doc, "tr");
      block.header.forEach((cell, c) =>
        headRow.append(cellElement(doc, "th", cell, block.align[c])),
      );
      head.append(headRow);
      const body = el(doc, "tbody");
      for (const row of block.rows) {
        const tr = el(doc, "tr");
        row.forEach((cell, c) =>
          tr.append(cellElement(doc, "td", cell, block.align[c])),
        );
        body.append(tr);
      }
      table.append(head, body);
      wrap.append(table);
      return wrap;
    }
  }
}

function cellElement(
  doc: Document,
  tag: "th" | "td",
  inline: Inline[],
  align: string | undefined,
) {
  const cell = withInline(el(doc, tag), inline);
  if (align) cell.style.textAlign = align;
  return cell;
}

function withInline(parent: HTMLElement, nodes: Inline[]) {
  const doc = parent.ownerDocument as Document;
  for (const node of nodes) parent.append(renderInline(doc, node));
  return parent;
}

function renderInline(doc: Document, node: Inline): Node {
  switch (node.type) {
    case "text":
      return doc.createTextNode(node.text);
    case "br":
      return el(doc, "br");
    case "code": {
      const code = el(doc, "code");
      code.textContent = node.text;
      return code;
    }
    case "math":
      return renderMath(el(doc, "span", "glossa-math"), node.text);
    case "strong":
    case "em":
    case "del":
      return withInline(el(doc, node.type), node.children);
    case "link": {
      // Only web links open, and in the system browser: a plain href would
      // navigate the Zotero window itself.
      if (!/^https?:\/\//i.test(node.href)) {
        return withInline(el(doc, "span"), node.children);
      }
      const link = el(doc, "a");
      link.setAttribute("href", node.href);
      link.title = node.href;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        Zotero.launchURL(node.href);
      });
      return withInline(link, node.children);
    }
  }
}

function renderMath(host: HTMLElement, tex: string) {
  const doc = host.ownerDocument as Document;
  host.title = tex;
  for (const part of texToParts(tex)) {
    if (part.script) {
      const script = el(doc, part.script);
      script.textContent = part.text;
      host.append(script);
    } else {
      host.append(doc.createTextNode(part.text));
    }
  }
  return host;
}

/**
 * Pure glossary data and matching. No Zotero or locale imports: the module
 * store is the only place that reads or writes the file.
 */

export type GlossaryTerm = { source: string; target: string };
export type GlossarySnapshot = { match(source: string): GlossaryTerm[] };

export const GLOSSARY_SOURCE_LIMIT = 200;
export const GLOSSARY_TARGET_LIMIT = 500;

type StoredTerm = GlossaryTerm & { key: string };
type Hit = { start: number; end: number; term: StoredTerm };
type LatinEntry = { term: StoredTerm; words: string[] };
type TrieNode = { kids: Map<string, TrieNode>; term?: StoredTerm };

const LATIN_WORD = /[a-z0-9]+(?:['’-][a-z0-9]+)*/g;

export function glossaryKey(source: string): string | undefined {
  const display = source.replace(/\s+/g, " ").trim();
  if (!display || display.length > GLOSSARY_SOURCE_LIMIT) return undefined;
  return display.toLowerCase();
}

export function prepareTerm(
  input: GlossaryTerm,
): { ok: true; term: GlossaryTerm; key: string } | { ok: false } {
  const source = input.source.replace(/\s+/g, " ").trim();
  const target = input.target.trim();
  const key = source.toLowerCase();
  if (
    !source ||
    !target ||
    source.length > GLOSSARY_SOURCE_LIMIT ||
    target.length > GLOSSARY_TARGET_LIMIT
  ) {
    return { ok: false };
  }
  return { ok: true, term: { source, target }, key };
}

export function parseGlossary(raw: string): GlossaryTerm[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return undefined;
  const record = data as { version?: unknown; terms?: unknown };
  if (record.version !== 1 || !Array.isArray(record.terms)) return undefined;
  const terms: GlossaryTerm[] = [];
  const seen = new Set<string>();
  for (const entry of record.terms) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    const source = (entry as { source?: unknown }).source;
    const target = (entry as { target?: unknown }).target;
    if (typeof source !== "string" || typeof target !== "string")
      return undefined;
    const prepared = prepareTerm({ source, target });
    if (!prepared.ok || seen.has(prepared.key)) return undefined;
    seen.add(prepared.key);
    terms.push(prepared.term);
  }
  return terms;
}

export function serializeGlossary(terms: GlossaryTerm[]) {
  const prepared = terms.map((term) => {
    const item = prepareTerm(term);
    if (!item.ok) throw new Error("invalid glossary term");
    return item;
  });
  prepared.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return JSON.stringify(
    { version: 1, terms: prepared.map((item) => item.term) },
    null,
    1,
  );
}

export type GlossaryIndex = GlossarySnapshot & {
  find(source: string): GlossaryTerm | undefined;
  list(query?: string): GlossaryTerm[];
};

export function buildGlossaryIndex(terms: GlossaryTerm[]): GlossaryIndex {
  const byKey = new Map<string, StoredTerm>();
  const latin = new Map<string, LatinEntry[]>();
  const root: TrieNode = { kids: new Map() };
  for (const term of terms) {
    const prepared = prepareTerm(term);
    if (!prepared.ok || byKey.has(prepared.key)) continue;
    const stored: StoredTerm = { ...prepared.term, key: prepared.key };
    byKey.set(stored.key, stored);
    const words = latinWords(stored.key);
    if (words && words.join(" ") === stored.key) {
      const bucket = latin.get(words[0]) || [];
      bucket.push({ term: stored, words });
      latin.set(words[0], bucket);
    } else {
      insertTrie(root, stored);
    }
  }
  for (const bucket of latin.values()) {
    bucket.sort(
      (a, b) =>
        b.words.length - a.words.length ||
        b.term.key.length - a.term.key.length,
    );
  }

  return {
    match(source: string) {
      if (!source) return [];
      const folded = source.toLowerCase();
      const hits: Hit[] = [];
      collectLatin(folded, latin, hits);
      collectTrie(folded, root, hits);
      return chooseHits(hits).map(copyTerm);
    },
    find(source: string) {
      const key = glossaryKey(source);
      const found = key ? byKey.get(key) : undefined;
      return found ? copyTerm(found) : undefined;
    },
    list(query?: string) {
      const needle = query
        ? query.replace(/\s+/g, " ").trim().toLowerCase()
        : "";
      const rows = [...byKey.values()].filter(
        (term) =>
          !needle ||
          term.key.includes(needle) ||
          term.target.toLowerCase().includes(needle),
      );
      rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return rows.map(copyTerm);
    },
  };
}

function copyTerm(term: GlossaryTerm): GlossaryTerm {
  return { source: term.source, target: term.target };
}

function latinWords(key: string) {
  return key.match(LATIN_WORD);
}

function insertTrie(root: TrieNode, term: StoredTerm) {
  let node = root;
  for (const ch of term.key) {
    let next = node.kids.get(ch);
    if (!next) {
      next = { kids: new Map() };
      node.kids.set(ch, next);
    }
    node = next;
  }
  node.term = term;
}

function collectLatin(
  folded: string,
  latin: Map<string, LatinEntry[]>,
  hits: Hit[],
) {
  const words: { start: number; end: number; word: string }[] = [];
  for (const found of folded.matchAll(LATIN_WORD)) {
    const word = found[0];
    words.push({
      start: found.index,
      end: found.index + word.length,
      word,
    });
  }
  for (let i = 0; i < words.length; i++) {
    const candidates = latin.get(words[i].word);
    if (!candidates) continue;
    for (const candidate of candidates) {
      const count = candidate.words.length;
      if (i + count > words.length) continue;
      let same = true;
      for (let k = 0; k < count; k++) {
        if (words[i + k].word !== candidate.words[k]) {
          same = false;
          break;
        }
      }
      if (!same) continue;
      let tight = true;
      for (let k = 0; k < count - 1; k++) {
        const gap = folded.slice(words[i + k].end, words[i + k + 1].start);
        if (!/^\s+$/.test(gap)) {
          tight = false;
          break;
        }
      }
      if (!tight) continue;
      const start = words[i].start;
      const end = words[i + count - 1].end;
      if (!latinEdge(folded, start, end)) continue;
      hits.push({ start, end, term: candidate.term });
    }
  }
}

function collectTrie(folded: string, root: TrieNode, hits: Hit[]) {
  for (let start = 0; start < folded.length; start++) {
    let node = root;
    let i = start;
    while (i <= folded.length) {
      if (node.term && bounded(folded, start, i, node.term.key)) {
        hits.push({ start, end: i, term: node.term });
      }
      if (i === folded.length) break;
      const space = node.kids.get(" ");
      if (space && /\s/.test(folded[i])) {
        node = space;
        while (i < folded.length && /\s/.test(folded[i])) i++;
        continue;
      }
      const next = node.kids.get(folded[i]);
      if (!next) break;
      node = next;
      i++;
    }
  }
}

function bounded(text: string, start: number, end: number, key: string) {
  return !/[a-z0-9]/i.test(key) || latinEdge(text, start, end);
}

function latinEdge(text: string, start: number, end: number) {
  const word = /[a-z0-9_]/i;
  const before = start === 0 || !word.test(text[start - 1] || "");
  const after = end >= text.length || !word.test(text[end] || "");
  return before && after;
}

function chooseHits(hits: Hit[]) {
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const placed: Hit[] = [];
  for (const hit of hits) {
    const overlaps = placed.some(
      (prev) => hit.start < prev.end && prev.start < hit.end,
    );
    if (!overlaps) placed.push(hit);
  }
  const seen = new Set<string>();
  const unique: Hit[] = [];
  for (const hit of placed) {
    if (seen.has(hit.term.key)) continue;
    seen.add(hit.term.key);
    unique.push(hit);
  }
  unique.sort((a, b) => a.start - b.start);
  return unique.map((hit) => hit.term);
}

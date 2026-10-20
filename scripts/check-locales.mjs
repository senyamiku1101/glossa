/* global console, URL */
// Fluent and settings-markup consistency for the shipped addon files.
// No network, no Zotero: plain files compared against each other.
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/**
 * Minimal Fluent reader: message ids, their text and `{ $arg }` placeables.
 * Glossa messages are single-line or use indented continuation lines, so this
 * stays deliberately small instead of pulling in a parser dependency.
 */
function parseFtl(path) {
  const messages = new Map();
  let current;
  for (const line of read(path).split(/\r?\n/)) {
    const head = /^([A-Za-z][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (head) {
      assert(
        !messages.has(head[1]),
        `${path}: duplicate message id ${head[1]}`,
      );
      current = { id: head[1], text: head[2] };
      messages.set(current.id, current);
      continue;
    }
    if (!current) continue;
    if (/^\s+\./.test(line) || /^\s+\S/.test(line)) {
      // An attribute or a continuation line belongs to the current message.
      current.text += ` ${line.trim()}`;
      continue;
    }
    current = undefined;
  }
  return messages;
}

function placeables(message) {
  return [...new Set(message.text.match(/\$[A-Za-z]+/g) || [])].sort();
}

function compareLocales(label, en, zh) {
  const missing = [...en.keys()].filter((key) => !zh.has(key));
  const extra = [...zh.keys()].filter((key) => !en.has(key));
  assert(!missing.length, `${label}: missing in zh-CN: ${missing.join(", ")}`);
  assert(!extra.length, `${label}: extra in zh-CN: ${extra.join(", ")}`);
  for (const [id, message] of en) {
    assert(
      placeables(message).join(",") === placeables(zh.get(id)).join(","),
      `${label}: placeholder mismatch for ${id}`,
    );
  }
  return en.size;
}

const addonEn = parseFtl("addon/locale/en-US/addon.ftl");
const addonZh = parseFtl("addon/locale/zh-CN/addon.ftl");
const prefsEn = parseFtl("addon/locale/en-US/preferences.ftl");
const prefsZh = parseFtl("addon/locale/zh-CN/preferences.ftl");
assert(compareLocales("addon.ftl", addonEn, addonZh) > 0, "addon.ftl is empty");
assert(
  compareLocales("preferences.ftl", prefsEn, prefsZh) > 0,
  "preferences.ftl is empty",
);

// Every data-l10n-id in the settings markup has a message.
const xhtml = read("addon/content/preferences.xhtml");
const markupIds = [
  ...new Set(
    [...xhtml.matchAll(/data-l10n-id="([^"]+)"/g)].map((match) => match[1]),
  ),
];
const markupMissing = markupIds.filter((id) => !prefsEn.has(id));
assert(
  !markupMissing.length,
  `preferences.xhtml: ids without messages: ${markupMissing.join(", ")}`,
);

// At runtime getString("k") reads the id `glossa-k` from addon.ftl; the build
// only prefixes FTL ids that do not already start with `glossa`.
const effectiveAddon = new Set(
  [...addonEn.keys()].map((id) =>
    id.startsWith("glossa") ? id : `glossa-${id}`,
  ),
);
function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(new URL(dir, root), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) files.push(...sourceFiles(dir + entry.name + "/"));
    else if (entry.name.endsWith(".ts")) files.push(dir + entry.name);
  }
  return files;
}
const keys = new Set();
for (const file of sourceFiles("src/")) {
  for (const match of read(file).matchAll(/getString\("([a-z0-9-]+)"/g)) {
    keys.add(match[1]);
  }
}
const keysMissing = [...keys].filter(
  (key) => !key.endsWith("-") && !effectiveAddon.has(`glossa-${key}`),
);
assert(
  !keysMissing.length,
  `getString keys without addon.ftl messages: ${keysMissing.join(", ")}`,
);

console.log(
  `Locales: ${addonEn.size} addon + ${prefsEn.size} preferences messages, en/zh keys and placeholders match, ${markupIds.length} markup ids defined, ${keys.size} runtime keys resolved`,
);

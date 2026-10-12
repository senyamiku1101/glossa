import { getString } from "../utils/locale";
import type { SessionRecord } from "../utils/history";
import type { Target } from "./context";
import { renderMarkdown } from "./markdown";

/** Build from text/Markdown DOM nodes so model output cannot inject note HTML. */
export async function saveSessionNote(
  doc: Document,
  target: Target,
  session: SessionRecord,
) {
  const item = target.item;
  if (!item || !session.turns.length)
    throw new Error(getString("session-note-empty"));
  const library = Zotero.Libraries.get(item.libraryID);
  if (!library || !library.editable) {
    throw new Error(getString("session-note-readonly"));
  }
  const ns = "http://www.w3.org/1999/xhtml";
  const root = doc.createElementNS(ns, "div") as HTMLElement;
  const add = (tag: string, text: string) => {
    const el = doc.createElementNS(ns, tag);
    el.textContent = text;
    root.append(el);
    return el;
  };
  add("h1", session.title || getString("session-untitled"));
  add("p", "Glossa · " + target.label);
  for (const turn of session.turns) {
    add(
      "h2",
      getString(turn.role === "user" ? "session-question" : "note-label"),
    );
    const body = doc.createElementNS(ns, "div") as HTMLElement;
    if (turn.role === "assistant")
      renderMarkdown(body, turn.display ?? turn.content);
    else {
      const p = doc.createElementNS(ns, "p");
      p.textContent = turn.display ?? turn.content;
      body.append(p);
    }
    root.append(body);
  }
  const note = new Zotero.Item("note");
  note.libraryID = item.libraryID;
  const parent = item.isRegularItem() ? item : item.parentItem;
  if (parent) note.parentKey = parent.key;
  note.setNote(String(root.innerHTML));
  await note.saveTx();
  return note;
}

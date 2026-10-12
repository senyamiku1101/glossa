import { config } from "../../package.json";
import { conversationsDir, io, paths } from "../utils/paths";
import {
  conversationFileName,
  parseSessionFile,
  serializeSessionFile,
  sessionTitle,
  type SessionRecord,
  type SessionFile,
  type Turn,
} from "../utils/history";

export type Pending = { display: string; text: string; reasoning: string };
export type Session = SessionRecord & {
  pending?: Pending;
  failed?: { display: string; error: string };
};
export type Conversation = {
  key: string;
  label: string;
  sessions: Session[];
  activeId: string;
  loaded: boolean;
  storageError?: boolean;
};
export type StoreEvent = {
  key: string;
  kind: "loaded" | "changed" | "delta" | "busy" | "session";
};

function blankSession(): Session {
  const now = new Date().toISOString();
  return {
    id: Zotero.Utilities.randomString(16),
    title: "",
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
}

/** One file per item; stream destinations are session IDs, never the current tab. */
export class ConversationStore {
  private convos = new Map<string, Conversation>();
  private loads = new Map<string, Promise<Conversation>>();
  private writes = new Map<string, Promise<void>>();
  private listeners = new Set<(event: StoreEvent) => void>();
  private notifierID?: string;
  busyKey?: string;
  busySessionId?: string;

  init() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: unknown, extra: any) => {
          if (type !== "item" || event !== "delete") return;
          for (const id of ids as number[]) {
            const data = extra?.[id];
            if (data?.libraryID && data?.key)
              this.forget(data.libraryID + "/" + data.key);
          }
        },
      },
      ["item"],
      config.addonRef + "-conversations",
    );
  }

  dispose() {
    if (this.notifierID) Zotero.Notifier.unregisterObserver(this.notifierID);
    this.listeners.clear();
  }

  subscribe(listener: (event: StoreEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(key: string, kind: StoreEvent["kind"]) {
    for (const listener of this.listeners) {
      try {
        listener({ key, kind });
      } catch (error) {
        ztoolkit.log("[Glossa] conversation listener failed", error);
      }
    }
  }

  get(key: string, label = ""): Conversation {
    let convo = this.convos.get(key);
    if (!convo) {
      const first = blankSession();
      convo = {
        key,
        label,
        sessions: [first],
        activeId: first.id,
        loaded: key === "none",
      };
      this.convos.set(key, convo);
      this.evict();
    } else if (label) convo.label = label;
    return convo;
  }

  active(key: string): Session {
    const convo = this.get(key);
    return convo.sessions.find((session) => session.id === convo.activeId)!;
  }

  private session(key: string, id: string) {
    return this.convos.get(key)?.sessions.find((session) => session.id === id);
  }

  private evict() {
    if (this.convos.size <= 100) return;
    for (const [key, convo] of this.convos) {
      if (this.convos.size <= 100) break;
      if (
        key !== this.busyKey &&
        key !== "none" &&
        convo.loaded &&
        !convo.storageError &&
        !this.writes.has(key) &&
        !convo.sessions.some((session) => session.pending)
      )
        this.convos.delete(key);
    }
  }

  ensureLoaded(key: string, label = ""): Promise<Conversation> {
    const convo = this.get(key, label);
    if (convo.loaded) return Promise.resolve(convo);
    let loading = this.loads.get(key);
    if (!loading) {
      const queued = this.writes.get(key) || Promise.resolve();
      loading = queued
        .then(() => this.read(key))
        .then((data) => {
          // An item can be deleted while its file is being read.
          if (this.convos.get(key) !== convo) return convo;
          if (data) {
            convo.sessions = data.sessions;
            convo.activeId = data.activeId;
          }
          convo.loaded = true;
          return convo;
        })
        .catch((error) => {
          // Keep the original file intact, and block writes until a restart/retry.
          convo.loaded = true;
          convo.storageError = true;
          ztoolkit.log("[Glossa] cannot load sessions", key, error);
          return convo;
        })
        .finally(() => {
          if (this.loads.get(key) === loading) this.loads.delete(key);
          if (this.convos.get(key) === convo) this.emit(key, "loaded");
        });
      this.loads.set(key, loading);
    }
    return loading;
  }

  createSession(key: string) {
    const convo = this.get(key);
    if (!convo.loaded || convo.storageError) return;
    const current = this.active(key);
    if (!current.turns.length && !current.pending && !current.failed)
      return current;
    const session = blankSession();
    convo.sessions.push(session);
    convo.activeId = session.id;
    this.save(convo);
    this.emit(key, "session");
    return session;
  }

  selectSession(key: string, id: string) {
    const convo = this.get(key);
    if (!convo.loaded || !this.session(key, id) || convo.activeId === id)
      return;
    convo.activeId = id;
    this.save(convo);
    this.emit(key, "session");
  }

  renameSession(key: string, id: string, title: string) {
    const session = this.session(key, id);
    const name = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!session || !name || this.get(key).storageError) return;
    session.title = name;
    this.save(this.get(key));
    this.emit(key, "changed");
  }

  deleteSession(key: string, id: string) {
    const convo = this.get(key);
    if (
      !convo.loaded ||
      convo.storageError ||
      (this.busyKey === key && this.busySessionId === id)
    )
      return false;
    if (!this.session(key, id)) return false;
    convo.sessions = convo.sessions.filter((session) => session.id !== id);
    if (!convo.sessions.length) convo.sessions.push(blankSession());
    if (convo.activeId === id) {
      convo.activeId = [...convo.sessions].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      )[0].id;
    }
    this.save(convo);
    this.emit(key, "session");
    return true;
  }

  setBusy(key: string | undefined, sessionId?: string) {
    const previous = this.busyKey;
    this.busyKey = key;
    this.busySessionId = sessionId;
    this.emit(key || previous || "none", "busy");
  }

  startPending(key: string, id: string, display: string) {
    const session = this.session(key, id);
    if (!session) return;
    session.failed = undefined;
    session.pending = { display, text: "", reasoning: "" };
    this.emit(key, "changed");
  }

  updatePending(key: string, id: string, text: string, reasoning: string) {
    const pending = this.session(key, id)?.pending;
    if (!pending) return;
    pending.text = text;
    pending.reasoning = reasoning;
    this.emit(key, "delta");
  }

  commitPending(key: string, id: string, question: Turn, answer: Turn) {
    const session = this.session(key, id);
    if (!session) return;
    session.pending = undefined;
    session.turns.push(question, answer);
    if (!session.title) session.title = sessionTitle(session.turns);
    session.updatedAt = new Date().toISOString();
    this.save(this.get(key));
    this.emit(key, "changed");
  }

  failPending(key: string, id: string | undefined, error: string) {
    const session = id && this.session(key, id);
    if (!session) return;
    if (session.pending)
      session.failed = { display: session.pending.display, error };
    session.pending = undefined;
    this.emit(key, "changed");
  }

  private forget(key: string) {
    const path = this.filePath(key);
    const loading = this.loads.get(key);
    this.convos.delete(key);
    this.loads.delete(key);
    if (path)
      this.enqueue(key, async () => {
        // A v1 read may still be writing its backup. Remove it only afterward.
        await loading;
        await io().remove(path, { ignoreAbsent: true });
        await io().remove(path + ".v1.bak", { ignoreAbsent: true });
      });
  }

  private filePath(key: string) {
    const [libraryIDText, itemKey] = key.split("/");
    const libraryID = Number(libraryIDText);
    if (!itemKey || !Number.isInteger(libraryID)) return;
    const library = Zotero.Libraries.get(libraryID);
    if (!library) return;
    let name: string | undefined;
    if (library.libraryType === "user")
      name = conversationFileName({ type: "user" }, itemKey);
    else if (library.libraryType === "group") {
      name = conversationFileName(
        {
          type: "group",
          groupID: Zotero.Groups.getGroupIDFromLibraryID(libraryID),
        },
        itemKey,
      );
    }
    return name ? paths().join(conversationsDir(), name) : undefined;
  }

  private async read(key: string): Promise<SessionFile | undefined> {
    const path = this.filePath(key);
    if (!path || !(await io().exists(path))) return;
    const raw = await io().readUTF8(path);
    const data = parseSessionFile(raw);
    if (!data) throw new Error("Unsupported or damaged session file");
    // Retain an untouched backup before the first write in the new format.
    if (data.migrated && !(await io().exists(path + ".v1.bak"))) {
      await io().writeUTF8(path + ".v1.bak", raw);
    }
    return data;
  }

  private save(convo: Conversation) {
    if (convo.storageError) return;
    const path = this.filePath(convo.key);
    if (!path) return;
    const data = serializeSessionFile(convo.label, convo);
    this.enqueue(convo.key, async () => {
      await io().makeDirectory(conversationsDir(), {
        createAncestors: true,
        ignoreExisting: true,
      });
      await io().writeUTF8(path, data, { tmpPath: path + ".tmp" });
    });
  }

  private enqueue(key: string, task: () => Promise<unknown>) {
    const previous = this.writes.get(key) || Promise.resolve();
    const next = previous
      .then(task)
      .then(() => undefined)
      .catch((error) => {
        const convo = this.convos.get(key);
        if (convo) convo.storageError = true;
        ztoolkit.log("[Glossa] session storage failed", error);
        this.emit(key, "changed");
      });
    this.writes.set(key, next);
    void next.finally(() => {
      if (this.writes.get(key) === next) this.writes.delete(key);
    });
  }
}

export const conversations = new ConversationStore();

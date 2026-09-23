import { config } from "../../package.json";
import { conversationsDir, io, paths } from "../utils/paths";
import {
  conversationFileName,
  parseConversation,
  serializeConversation,
  type Turn,
} from "../utils/history";

/** A question being answered; lives in memory only. */
export type Pending = { display: string; text: string; reasoning: string };

export type Conversation = {
  /** `${libraryID}/${itemKey}`, or "none" when no item is selected. */
  key: string;
  label: string;
  turns: Turn[];
  loaded: boolean;
  pending?: Pending;
  /** The last question that got no answer, shown until the next one. */
  failed?: { display: string; error: string };
};

export type StoreEvent = {
  key: string;
  /**
   * loaded/changed: redraw everything; delta: only the pending answer grew;
   * busy: a run started or ended somewhere (key is that run's key).
   */
  kind: "loaded" | "changed" | "delta" | "busy";
};

const MAX_IN_MEMORY = 100;

/**
 * Conversations per item, persisted as one JSON file each under the Zotero
 * data directory. Views never hold on to a Conversation; they look it up by
 * key on every event, so eviction and reloads are invisible to them.
 */
class ConversationStore {
  private convos = new Map<string, Conversation>();
  private loads = new Map<string, Promise<Conversation>>();
  /** Writes and deletes per key run in order on one chain. */
  private writes = new Map<string, Promise<void>>();
  /** Bumped by clear(), so a load that finishes afterwards is discarded. */
  private generations = new Map<string, number>();
  private listeners = new Set<(event: StoreEvent) => void>();
  private notifierID?: string;
  private warned = false;
  busyKey?: string;

  init() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: unknown, extra: any) => {
          if (type !== "item" || event !== "delete") return;
          for (const id of ids as number[]) {
            const data = extra?.[id];
            if (data?.libraryID && data?.key) {
              this.forget(`${data.libraryID}/${data.key}`);
            }
          }
        },
      },
      ["item"],
      `${config.addonRef}-conversations`,
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

  /** The conversation for `key`, possibly not loaded yet. */
  get(key: string, label = ""): Conversation {
    let convo = this.convos.get(key);
    if (!convo) {
      convo = { key, label, turns: [], loaded: key === "none" };
      this.convos.set(key, convo);
      this.evict();
    } else if (label) {
      convo.label = label;
    }
    return convo;
  }

  private evict() {
    if (this.convos.size <= MAX_IN_MEMORY) return;
    for (const [key, convo] of this.convos) {
      if (this.convos.size <= MAX_IN_MEMORY) break;
      const idle = !convo.pending && convo.loaded && !this.writes.has(key);
      if (key !== this.busyKey && idle) {
        this.convos.delete(key);
      }
    }
  }

  /**
   * Load from disk once. Nothing may be appended before this resolves,
   * or the first save would overwrite the stored history.
   */
  ensureLoaded(key: string, label = ""): Promise<Conversation> {
    const convo = this.get(key, label);
    if (convo.loaded) return Promise.resolve(convo);
    let loading = this.loads.get(key);
    if (!loading) {
      const generation = this.generations.get(key) || 0;
      // Read after any queued write for this key has landed.
      const queued = this.writes.get(key) || Promise.resolve();
      loading = queued
        .then(() => this.read(key))
        .then((turns) => {
          const current = this.get(key);
          if ((this.generations.get(key) || 0) === generation && turns) {
            current.turns = turns;
          }
          current.loaded = true;
          return current;
        })
        .catch((error) => {
          ztoolkit.log("[Glossa] cannot load conversation", key, error);
          const current = this.get(key);
          current.loaded = true;
          return current;
        })
        .finally(() => {
          this.loads.delete(key);
          this.emit(key, "loaded");
        });
      this.loads.set(key, loading);
    }
    return loading;
  }

  setBusy(key: string | undefined) {
    const previous = this.busyKey;
    this.busyKey = key;
    this.emit(key || previous || "none", "busy");
  }

  startPending(key: string, display: string) {
    const convo = this.get(key);
    convo.failed = undefined;
    convo.pending = { display, text: "", reasoning: "" };
    this.emit(key, "changed");
  }

  updatePending(key: string, text: string, reasoning: string) {
    const pending = this.convos.get(key)?.pending;
    if (!pending) return;
    pending.text = text;
    pending.reasoning = reasoning;
    this.emit(key, "delta");
  }

  /** Keep the question and its answer, and save. */
  commitPending(key: string, question: Turn, answer: Turn) {
    const convo = this.get(key);
    convo.pending = undefined;
    convo.turns.push(question, answer);
    this.emit(key, "changed");
    this.save(convo);
  }

  /** Drop the question; the history stays paired. */
  failPending(key: string, error: string) {
    const convo = this.get(key);
    if (convo.pending) {
      convo.failed = { display: convo.pending.display, error };
    }
    convo.pending = undefined;
    this.emit(key, "changed");
  }

  /** "New chat": forget the turns and delete the file. */
  clear(key: string) {
    const convo = this.get(key);
    this.generations.set(key, (this.generations.get(key) || 0) + 1);
    convo.turns = [];
    convo.failed = undefined;
    convo.loaded = true;
    this.emit(key, "changed");
    this.remove(key);
  }

  /** The item was deleted. */
  private forget(key: string) {
    this.generations.set(key, (this.generations.get(key) || 0) + 1);
    this.convos.delete(key);
    this.remove(key);
  }

  // ---- disk

  private filePath(key: string) {
    const [libraryIDText, itemKey] = key.split("/");
    const libraryID = Number(libraryIDText);
    if (!itemKey || !Number.isInteger(libraryID)) return undefined;
    const library = Zotero.Libraries.get(libraryID);
    if (!library) return undefined;
    let name: string | undefined;
    if (library.libraryType === "user") {
      name = conversationFileName({ type: "user" }, itemKey);
    } else if (library.libraryType === "group") {
      const groupID = Zotero.Groups.getGroupIDFromLibraryID(libraryID);
      name = conversationFileName({ type: "group", groupID }, itemKey);
    }
    // Feeds and unknown libraries stay in memory.
    return name ? paths().join(conversationsDir(), name) : undefined;
  }

  private async read(key: string): Promise<Turn[] | undefined> {
    const path = this.filePath(key);
    if (!path || !(await io().exists(path))) return undefined;
    const raw = await io().readUTF8(path);
    const turns = parseConversation(raw);
    if (!turns) {
      // Keep the unreadable file for inspection instead of overwriting it.
      await io().move(path, `${path}.corrupt`);
      ztoolkit.log("[Glossa] moved unreadable conversation aside", path);
    }
    return turns;
  }

  private save(convo: Conversation) {
    const path = this.filePath(convo.key);
    if (!path) return;
    const data = serializeConversation(convo.label, convo.turns);
    this.enqueue(convo.key, async () => {
      await io().makeDirectory(conversationsDir(), {
        createAncestors: true,
        ignoreExisting: true,
      });
      await io().writeUTF8(path, data, { tmpPath: `${path}.tmp` });
    });
  }

  private remove(key: string) {
    const path = this.filePath(key);
    if (!path) return;
    this.enqueue(key, () => io().remove(path, { ignoreAbsent: true }));
  }

  private enqueue(key: string, task: () => Promise<unknown>) {
    const previous = this.writes.get(key) || Promise.resolve();
    const next = previous
      .then(task)
      .then(() => undefined)
      .catch((error) => {
        // Disk trouble must not break chatting; keep going in memory.
        if (!this.warned) {
          this.warned = true;
          ztoolkit.log("[Glossa] conversation storage failed", error);
        }
      });
    this.writes.set(key, next);
    void next.finally(() => {
      if (this.writes.get(key) === next) this.writes.delete(key);
    });
  }
}

export const conversations = new ConversationStore();

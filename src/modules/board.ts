import { getString } from "../utils/locale";
import { dataDir, io, paths } from "../utils/paths";
import {
  BOARD_LIMIT,
  boardEntryKey,
  isBoardFull,
  makeBoardEntry,
  parseBoard,
  serializeBoard,
  type BoardEntry,
  type BoardMode,
  type BoardStatus,
} from "../utils/board";

export type { BoardEntry, BoardMode, BoardStatus } from "../utils/board";

export type BoardAddInput = {
  itemKey: string;
  itemTitle: string;
  translation: {
    mode: BoardMode;
    status: BoardStatus;
    source: string;
    sourceTruncated?: boolean;
    translator?: string;
    reviewer?: string;
  };
  /** Final translation text (turn.content). */
  text: string;
};

class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardError";
  }
}

/**
 * One global board shared by every panel. Reads stay in memory after the
 * first successful load. A damaged file is reported and never overwritten.
 * Memory changes only after an atomic write succeeds.
 */
class BoardStore {
  private entries: BoardEntry[] = [];
  private keys = new Set<string>();
  private loaded = false;
  private broken = false;
  private loading?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return this.broken
        ? Promise.reject(new BoardError(getString("board-load-error")))
        : Promise.resolve();
    }
    if (!this.loading) {
      this.loading = this.read()
        .then((entries) => {
          this.replace(entries);
          this.loaded = true;
        })
        .catch((error) => {
          this.loaded = true;
          this.broken = true;
          ztoolkit.log("[Glossa] board load failed", error);
          throw new BoardError(getString("board-load-error"));
        });
    }
    return this.loading;
  }

  /** Copies, newest first. */
  list(): BoardEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Whether the same dedupe key already exists; false before loading. */
  has(key: string): boolean {
    return this.loaded && !this.broken && this.keys.has(key);
  }

  /** "added", or "duplicate" when the same answer is already on the board. */
  add(input: BoardAddInput): Promise<"added" | "duplicate"> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const translation = input?.translation;
      if (!translation) throw new BoardError(getString("board-invalid"));
      const entry = makeBoardEntry({
        id: Zotero.Utilities.randomString(8),
        addedAt: new Date().toISOString(),
        itemKey: input.itemKey,
        itemTitle: input.itemTitle,
        mode: translation.mode,
        status: translation.status,
        source: translation.source,
        sourceTruncated: translation.sourceTruncated,
        translation: input.text,
        translator: translation.translator,
        reviewer: translation.reviewer,
      });
      if (!entry) throw new BoardError(getString("board-invalid"));
      const key = boardEntryKey(entry);
      if (this.keys.has(key)) return "duplicate";
      if (isBoardFull(this.entries)) {
        throw new BoardError(
          getString("board-full", { args: { count: BOARD_LIMIT } }),
        );
      }
      const next = [entry, ...this.entries];
      await this.persist(next);
      this.replace(next);
      this.emit();
      return "added";
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const next = this.entries.filter((entry) => entry.id !== id);
      if (next.length === this.entries.length) return;
      await this.persist(next);
      this.replace(next);
      this.emit();
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.entries.length) return;
      await this.persist([]);
      this.replace([]);
      this.emit();
    }, "board-clear-error");
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private async read(): Promise<BoardEntry[]> {
    const path = this.file();
    if (!(await io().exists(path))) return [];
    const entries = parseBoard(await io().readUTF8(path));
    if (!entries) throw new Error("damaged board");
    return entries;
  }

  private async persist(entries: BoardEntry[]) {
    const dir = dataDir();
    await io().makeDirectory(dir, { ignoreExisting: true });
    const path = this.file();
    await io().writeUTF8(path, serializeBoard(entries), {
      tmpPath: path + ".tmp",
    });
  }

  private file() {
    return paths().join(dataDir(), "board.json");
  }

  private replace(entries: BoardEntry[]) {
    this.entries = entries;
    this.keys = new Set(entries.map((entry) => boardEntryKey(entry)));
  }

  private enqueue<T>(
    task: () => Promise<T>,
    errorKey = "board-save-error",
  ): Promise<T> {
    const result = this.writes.then(task);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result.catch((error: unknown) => {
      if (error instanceof BoardError) throw error;
      ztoolkit.log("[Glossa] board write failed", error);
      throw new BoardError(getString(errorKey));
    });
  }

  private emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (error) {
        ztoolkit.log("[Glossa] board listener failed", error);
      }
    }
  }
}

export type BoardApi = {
  ensureLoaded(): Promise<void>;
  /** Copies, newest first. */
  list(): BoardEntry[];
  /** Whether the same dedupe key already exists; false before loading. */
  has(key: string): boolean;
  /** "added", or "duplicate" when the same answer is already on the board. */
  add(input: BoardAddInput): Promise<"added" | "duplicate">;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  subscribe(fn: () => void): () => void;
};

export const board: BoardApi = new BoardStore();

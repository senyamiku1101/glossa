import { getString } from "../utils/locale";
import { dataDir, io, paths } from "../utils/paths";
import {
  buildGlossaryIndex,
  glossaryKey,
  parseGlossary,
  prepareTerm,
  serializeGlossary,
  type GlossaryIndex,
  type GlossarySnapshot,
  type GlossaryTerm,
} from "../utils/glossary";

export type { GlossarySnapshot, GlossaryTerm };

class GlossaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlossaryError";
  }
}

/**
 * One local glossary. Reads stay in memory after the first successful load.
 * A damaged file is reported and never overwritten. Memory changes only
 * after an atomic write succeeds.
 */
class GlossaryStore {
  private index: GlossaryIndex = buildGlossaryIndex([]);
  private loaded = false;
  private broken = false;
  private loading?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return this.broken
        ? Promise.reject(new GlossaryError(getString("glossary-load-error")))
        : Promise.resolve();
    }
    if (!this.loading) {
      this.loading = this.read()
        .then((terms) => {
          this.index = buildGlossaryIndex(terms);
          this.loaded = true;
        })
        .catch((error) => {
          this.loaded = true;
          this.broken = true;
          ztoolkit.log("[Glossa] glossary load failed", error);
          throw new GlossaryError(getString("glossary-load-error"));
        });
    }
    return this.loading;
  }

  list(query?: string) {
    return this.index.list(query);
  }

  find(source: string) {
    return this.index.find(source);
  }

  save(term: GlossaryTerm, previousSource?: string): Promise<void> {
    const prepared = prepareTerm(term);
    if (!prepared.ok) {
      return Promise.reject(new GlossaryError(getString("glossary-invalid")));
    }
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const next = this.nextTerms(prepared.term, prepared.key, previousSource);
      await this.persist(next);
      this.index = buildGlossaryIndex(next);
      this.emit();
    });
  }

  remove(source: string): Promise<void> {
    const key = glossaryKey(source);
    if (!key) {
      return Promise.reject(new GlossaryError(getString("glossary-invalid")));
    }
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.index.find(source)) return;
      const next = this.index
        .list()
        .filter((term) => glossaryKey(term.source) !== key);
      await this.persist(next);
      this.index = buildGlossaryIndex(next);
      this.emit();
    });
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async snapshot(): Promise<GlossarySnapshot> {
    await this.ensureLoaded();
    const index = this.index;
    return { match: (source: string) => index.match(source) };
  }

  private async read(): Promise<GlossaryTerm[]> {
    const path = this.file();
    if (!(await io().exists(path))) return [];
    const terms = parseGlossary(await io().readUTF8(path));
    if (!terms) throw new Error("damaged glossary");
    return terms;
  }

  private nextTerms(term: GlossaryTerm, key: string, previous?: string) {
    const current = this.index.list();
    const previousKey =
      previous === undefined ? undefined : glossaryKey(previous);
    if (previous !== undefined && !previousKey) {
      throw new GlossaryError(getString("glossary-invalid"));
    }
    const keys = new Set(
      current.map((item) => glossaryKey(item.source)).filter(Boolean),
    );
    if (previousKey && previousKey !== key) {
      if (keys.has(key)) {
        throw new GlossaryError(getString("glossary-conflict"));
      }
      if (!keys.has(previousKey)) return [...current, term];
      return current
        .filter((item) => glossaryKey(item.source) !== previousKey)
        .concat(term);
    }
    return current
      .filter((item) => glossaryKey(item.source) !== key)
      .concat(term);
  }

  private async persist(terms: GlossaryTerm[]) {
    const dir = dataDir();
    await io().makeDirectory(dir, { ignoreExisting: true });
    const path = this.file();
    await io().writeUTF8(path, serializeGlossary(terms), {
      tmpPath: path + ".tmp",
    });
  }

  private file() {
    return paths().join(dataDir(), "glossary.json");
  }

  private enqueue(task: () => Promise<void>) {
    const result = this.writes.then(task);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result.catch((error: unknown) => {
      if (error instanceof GlossaryError) throw error;
      ztoolkit.log("[Glossa] glossary write failed", error);
      throw new GlossaryError(getString("glossary-save-error"));
    });
  }

  private emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (error) {
        ztoolkit.log("[Glossa] glossary listener failed", error);
      }
    }
  }
}

export const glossary = new GlossaryStore();

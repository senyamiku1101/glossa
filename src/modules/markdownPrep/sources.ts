/** Registry for body sources. Task A owns this; B/D only import. */
import type { BodySource } from "./types";

const registry = new Map<string, BodySource>();

/** Register or replace one source. Called once per source at startup. */
export function registerBodySource(source: BodySource): void {
  registry.set(source.id, source);
}

export function getBodySource(id: string): BodySource | undefined {
  return registry.get(id);
}

export function listBodySources(): BodySource[] {
  return [...registry.values()];
}

/** Used by tests/tools; not called by production code. */
export function resetBodySources(): void {
  registry.clear();
}

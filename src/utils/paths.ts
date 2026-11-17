/**
 * IOUtils/PathUtils are window globals in Gecko; the plugin sandbox may not
 * have them, so fetch them through ztoolkit (which falls back to the main
 * window).
 */
export function io(): typeof IOUtils {
  return ztoolkit.getGlobal("IOUtils");
}

export function paths(): typeof PathUtils {
  return ztoolkit.getGlobal("PathUtils");
}

/** Glossa's folder in the Zotero data directory. */
export function dataDir() {
  return paths().join(Zotero.DataDirectory.dir, "glossa");
}

export function conversationsDir() {
  return paths().join(dataDir(), "conversations");
}

/**
 * Glossa's private working directory for prepared Markdown bodies. It holds the
 * durable queue journal and the content-addressed parse cache; the user-visible
 * deliverable is always a hosted attachment inside the Zotero library, never a
 * file here.
 */
export function bodyDir() {
  return paths().join(dataDir(), "body");
}

export function bodyCacheDir() {
  return paths().join(bodyDir(), "cache");
}

export function bodyQueueFile() {
  return paths().join(bodyDir(), "queue.json");
}

/**
 * Same-volume staging directory for atomic bundle writes. It lives in the
 * Zotero data directory (never inside `storage/<key>/glossa/`), so a partially
 * written bundle can never leak `.tmp`/incomplete files into the attachment ZIP
 * that Zotero uploads. A finished bundle is published by moving/renaming its
 * files into the PDF storage directory.
 */
export function bodyStagingDir() {
  return paths().join(bodyDir(), "staging");
}

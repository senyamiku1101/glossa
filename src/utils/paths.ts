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

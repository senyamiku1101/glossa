export function selectedTabID(): string {
  const tabs = ztoolkit.getGlobal("Zotero_Tabs") as { selectedID: string };
  return tabs.selectedID;
}

/** The reader in the selected tab, or undefined on the library tab. */
export function getActiveReader() {
  try {
    return Zotero.Reader.getByTabID(selectedTabID());
  } catch {
    return undefined;
  }
}

export function asItem(value: Zotero.Item | false | undefined | null) {
  return value && typeof value === "object" ? value : undefined;
}

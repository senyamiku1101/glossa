export function selectedTabID(): string {
  const tabs = ztoolkit.getGlobal("Zotero_Tabs") as { selectedID: string };
  return tabs.selectedID;
}

export function asItem(value: Zotero.Item | false | undefined | null) {
  return value && typeof value === "object" ? value : undefined;
}

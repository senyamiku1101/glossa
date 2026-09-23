import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { chat } from "./modules/chat";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerPrefs();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow) {
  addon.data.ztoolkit = createZToolkit();
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`);
  chat.register(win);
}

async function onMainWindowUnload(win: Window) {
  chat.unregister(win);
  ztoolkit.unregisterAll();
}

function onShutdown() {
  for (const win of Zotero.getMainWindows()) {
    chat.unregister(win);
  }
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error runtime instance
  delete Zotero[addon.data.config.addonInstance];
}

function registerPrefs() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.svg`,
  });
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};

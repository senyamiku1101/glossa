import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { migrateLegacySecrets } from "./utils/secrets";
import { createZToolkit } from "./utils/ztoolkit";
import { chat } from "./modules/chat";
import { disposeChatViews, initChatViews } from "./modules/chatView";
import { conversations } from "./modules/conversations";
import { disposeGlossaryWindows } from "./modules/glossaryUI";
import { runner } from "./modules/runner";
import { initPreferencesPane } from "./modules/preferences";
import {
  registerSelectionPopup,
  unregisterSelectionPopup,
} from "./modules/selectionPopup";
import { registerSidebar, unregisterSidebar } from "./modules/sidebar";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerPrefs();
  try {
    await migrateLegacySecrets();
  } catch (error) {
    ztoolkit.log("[Glossa] secret migration failed", error);
  }
  conversations.init();
  initChatViews();
  chat.init();
  registerSidebar();
  registerSelectionPopup();

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
  runner.stop();
  chat.dispose();
  unregisterSidebar();
  unregisterSelectionPopup();
  disposeChatViews();
  disposeGlossaryWindows();
  conversations.dispose();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error runtime instance
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(type: "load", data: { window: Window }) {
  if (type === "load") initPreferencesPane(data.window);
}

function registerPrefs() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.svg`,
    stylesheets: [`chrome://${config.addonRef}/content/preferences.css`],
  });
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};

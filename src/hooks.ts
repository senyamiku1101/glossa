import { config } from "../package.json";
import { getString, initLocale } from "./utils/locale";
import { migrateLegacySecrets } from "./utils/secrets";
import { createZToolkit } from "./utils/ztoolkit";
import { chat } from "./modules/chat";
import { disposeChatViews, initChatViews } from "./modules/chatView";
import { conversations } from "./modules/conversations";
import { disposeGlossaryWindows } from "./modules/glossaryUI";
import { initPaddleCloud } from "./modules/markdownPrep/paddle";
import { initMineruCloud } from "./modules/markdownPrep/mineru";
import { cleanupLegacyPdfBundlesOnce } from "./modules/markdownPrep/store";
import {
  disposeMarkdownQueue,
  initMarkdownQueue,
} from "./modules/markdownPrep/queue";
import {
  disposeMarkdownUI,
  registerMarkdownUI,
  unregisterMarkdownUI,
} from "./modules/markdownUI";
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

  // Cloud source first, then the queue that reads it. Both are defensive: a
  // failure here must not stop the rest of the plugin from starting.
  try {
    await initPaddleCloud();
  } catch (error) {
    ztoolkit.log("[Glossa] PaddleOCR cloud init failed", error);
  }
  try {
    await initMineruCloud();
  } catch (error) {
    ztoolkit.log("[Glossa] MinerU cloud init failed", error);
  }
  try {
    await initMarkdownQueue();
  } catch (error) {
    ztoolkit.log("[Glossa] markdown queue init failed", error);
  }
  void cleanupLegacyPdfBundlesOnce().catch((error) =>
    ztoolkit.log("[Glossa] legacy Markdown cleanup failed", error),
  );

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow) {
  addon.data.ztoolkit = createZToolkit();
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`);
  chat.register(win);
  try {
    registerMarkdownUI(win);
  } catch (error) {
    ztoolkit.log("[Glossa] markdown UI registration failed", error);
  }
}

async function onMainWindowUnload(win: Window) {
  try {
    unregisterMarkdownUI(win);
  } catch (error) {
    ztoolkit.log("[Glossa] markdown UI unregister failed", error);
  }
  chat.unregister(win);
  ztoolkit.unregisterAll();
}

function onShutdown() {
  runner.stop();
  chat.dispose();
  try {
    disposeMarkdownUI();
  } catch (error) {
    ztoolkit.log("[Glossa] markdown UI dispose failed", error);
  }
  try {
    disposeMarkdownQueue();
  } catch (error) {
    ztoolkit.log("[Glossa] markdown queue dispose failed", error);
  }
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

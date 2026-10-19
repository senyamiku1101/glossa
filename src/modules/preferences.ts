import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { conversationsDir, io } from "../utils/paths";
import { getSecret, setSecret, type SecretName } from "../utils/secrets";
import {
  CHAT_PRESETS,
  DEFAULT_SYSTEM_PROMPT,
  EMBED_MODEL_PRESETS,
  EMBED_PRESETS,
  MODEL_PRESETS,
  type ChatPreset,
  type Profile,
} from "../utils/config";
import {
  chatUrl,
  detectProtocol,
  embeddingsUrl,
  looksLikeFullUrl,
  modelsUrl,
  parseExtraParams,
  stripEndpointUrl,
} from "../utils/protocol";
import { listModels, testConnection, type TestKind } from "./llm";
import {
  applyProfile,
  deleteProfile,
  getProfiles,
  matchingProfileId,
  overwriteProfile,
  readActiveConfig,
  readConfig,
  renameProfile,
  resolveProfile,
  saveCurrentAs,
} from "./settings";
import { initTagEditor } from "./tagEditor";

const ref = config.addonRef;
const PREFIX = config.prefsPrefix;

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type MenuItem =
  "separator" | { label: string; disabled?: boolean; onCommand?: () => void };

/** Called from the pane's onload; runs each time the pane is opened. */
export function initPreferencesPane(win: Window) {
  new PreferencesPane(win).init();
}

class PreferencesPane {
  private readonly doc: Document;
  private readonly root: Element;
  private cleanup: (() => void)[] = [];
  private cancels = new Set<() => void>();
  private stopQueue = false;
  private modelCache = new Map<string, string[]>();
  private profilesTimer?: number;

  constructor(private readonly win: Window) {
    this.doc = win.document;
    this.root = this.doc.getElementById(`${ref}-preferences`)!;
  }

  init() {
    this.initTabs();
    this.bindPrefs();
    this.bindSecret("api-key", "api.key");
    this.bindSecret("embed-key", "embed.key");
    this.initKeyToggles();
    this.initUrlControls();
    this.initMenus();
    this.initProfiles();
    this.initTranslationProfiles();
    this.initTest();
    this.initStorage();
    initTagEditor(this.doc);
    this.refreshDerived();
    this.win.addEventListener("unload", () => this.dispose(), { once: true });
  }

  /** One settings panel visible at a time; the tabs switch between them. */
  private initTabs() {
    const tabs = [...this.root.querySelectorAll<HTMLElement>(".glossa-tab")];
    const panels = [
      ...this.root.querySelectorAll<HTMLElement>(".glossa-tabpanel"),
    ];
    const show = (name: string) => {
      for (const tab of tabs) {
        const active = tab.dataset.tab === name;
        tab.setAttribute("aria-selected", String(active));
        // Roving tabindex: Tab reaches the active tab, arrows move inside.
        tab.tabIndex = active ? 0 : -1;
      }
      for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    };
    const activate = (tab: HTMLElement) => {
      show(tab.dataset.tab || "chat");
      tab.focus();
    };
    tabs.forEach((tab, index) => {
      const name = tab.dataset.tab || "chat";
      tab.id = `${ref}-tab-${name}`;
      tab.setAttribute("aria-controls", `${ref}-panel-${name}`);
      tab.addEventListener("click", () => show(name));
      tab.addEventListener("keydown", (event: Event) => {
        const key = event as KeyboardEvent;
        let next = -1;
        if (key.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (key.key === "ArrowLeft")
          next = (index - 1 + tabs.length) % tabs.length;
        else if (key.key === "Home") next = 0;
        else if (key.key === "End") next = tabs.length - 1;
        if (next < 0) return;
        key.preventDefault();
        activate(tabs[next]);
      });
    });
    for (const panel of panels) {
      const name = panel.dataset.panel || "chat";
      panel.id = `${ref}-panel-${name}`;
      panel.setAttribute("aria-labelledby", `${ref}-tab-${name}`);
    }
    show("chat");
  }

  private dispose() {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.stopTests();
  }

  private el<T extends HTMLElement = HTMLElement>(id: string) {
    return this.doc.getElementById(`${ref}-${id}`) as T;
  }

  // ---- pref binding

  private controls(key?: string) {
    const selector = key ? `[data-pref="${key}"]` : "[data-pref]";
    return [...this.root.querySelectorAll<Control>(selector)];
  }

  /**
   * Controls with data-pref read and write their pref; an observer per pref
   * keeps them current when something else (a profile switch, the sidebar)
   * changes it.
   */
  private bindPrefs() {
    const keys = new Set<string>();
    for (const control of this.controls()) {
      keys.add(control.dataset.pref!);
      const live = isInput(control) && control.type === "range";
      control.addEventListener(live ? "input" : "change", () =>
        this.write(control),
      );
    }
    for (const key of keys) {
      const symbol = Zotero.Prefs.registerObserver(
        `${PREFIX}.${key}`,
        () => this.sync(key),
        true,
      );
      this.cleanup.push(() => Zotero.Prefs.unregisterObserver(symbol));
      this.sync(key);
    }
  }

  private write(control: Control) {
    const key = control.dataset.pref!;
    let value: string | number | boolean = control.value;
    if (isCheckbox(control)) {
      value = control.checked;
    } else if (control.dataset.type === "int") {
      const n = Math.round(Number(control.value));
      const min = isInput(control) && control.min ? Number(control.min) : 1;
      if (!Number.isFinite(n) || n < min) {
        this.sync(key);
        return;
      }
      value = n;
    }
    if (
      key === "reader.popupScope" &&
      value !== "selection" &&
      value !== "paragraph"
    ) {
      this.sync(key);
      return;
    }
    if (control.dataset.validate === "json") {
      const error = this.el("api-extra-error");
      try {
        parseExtraParams(String(value));
        error.textContent = "";
      } catch (e: any) {
        error.textContent = e?.message || String(e);
        return;
      }
    }
    Zotero.Prefs.set(`${PREFIX}.${key}`, value, true);
    // Changing the limit means the user wants it included in requests.
    if (key === "api.maxTokens")
      Zotero.Prefs.set(`${PREFIX}.api.maxTokens.enabled`, true, true);
  }

  private sync(key: string) {
    const value = Zotero.Prefs.get(`${PREFIX}.${key}`, true);
    const text =
      key === "reader.popupScope"
        ? value === "paragraph"
          ? "paragraph"
          : "selection"
        : value === undefined
          ? ""
          : String(value);
    for (const control of this.controls(key)) {
      if (isCheckbox(control)) control.checked = Boolean(value);
      else if (control.value !== text) control.value = text;
    }
    for (const out of this.root.querySelectorAll(`[data-show="${key}"]`)) {
      out.textContent = text;
    }
    this.refreshDerived();
  }

  /** Labels, previews and hints that depend on several prefs. */
  private refreshDerived() {
    const cfg = { ...readConfig(), keys: { api: "", embed: "" } };
    const full = cfg.urlMode === "full";
    this.el("api-url-label").textContent = getString(
      full ? "url-full-label" : "url-base-label",
    );
    this.el<HTMLInputElement>("api-url-full").checked = full;
    this.el("api-final-row").hidden = full;
    this.el("api-final-url").textContent = chatUrl(cfg);
    this.el("api-hint").textContent =
      cfg.protocol === "anthropic-messages" ? getString("hint-anthropic") : "";

    const derived = embeddingsUrl({ ...cfg, embed: { ...cfg.embed, url: "" } });
    this.el<HTMLInputElement>("embed-url").placeholder = derived;
    this.el("embed-hint").textContent = cfg.embed.url.trim()
      ? ""
      : derived
        ? getString("embed-hint-derived", { args: { url: derived } })
        : getString("embed-hint-anthropic");
    this.el<HTMLTextAreaElement>("api-system").placeholder =
      DEFAULT_SYSTEM_PROMPT;
    this.scheduleProfiles();
  }

  // ---- keys

  /** Key fields are not bound to prefs; they read and write the login store. */
  private bindSecret(id: string, name: SecretName) {
    const input = this.el<HTMLInputElement>(id);
    input.value = getSecret(name);
    input.addEventListener("change", () => {
      setSecret(name, input.value.trim())
        .then(() => this.scheduleProfiles())
        .catch((error) => ztoolkit.log(`[Glossa] cannot save ${name}`, error));
    });
  }

  private refreshSecrets() {
    this.el<HTMLInputElement>("api-key").value = getSecret("api.key");
    this.el<HTMLInputElement>("embed-key").value = getSecret("embed.key");
  }

  private initKeyToggles() {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      ".glossa-key-toggle",
    )) {
      const input = this.doc.getElementById(
        button.dataset.for!,
      ) as HTMLInputElement;
      const render = () => {
        button.textContent = getString(
          input.type === "password" ? "key-show" : "key-hide",
        );
      };
      button.addEventListener("click", () => {
        input.type = input.type === "password" ? "text" : "password";
        render();
      });
      render();
    }
  }

  // ---- URL and model

  private initUrlControls() {
    const url = this.el<HTMLInputElement>("api-url");
    url.addEventListener("input", () => {
      this.el("api-final-url").textContent = chatUrl({
        ...readConfig(),
        url: url.value,
      });
    });
    // A typed endpoint names its protocol; follow it.
    url.addEventListener("change", () => {
      const detected = detectProtocol(url.value);
      if (detected) setPref("api.protocol", detected);
    });
    const toggle = this.el<HTMLInputElement>("api-url-full");
    toggle.addEventListener("change", () => {
      const cfg = readConfig();
      if (toggle.checked) {
        setPref("api.url", chatUrl(cfg));
        setPref("api.urlMode", "full");
      } else {
        setPref("api.url", stripEndpointUrl(cfg.url));
        setPref("api.urlMode", "base");
      }
    });
  }

  private initMenus() {
    const presets = this.el("api-url-presets");
    presets.addEventListener("click", () =>
      this.openMenu(
        presets,
        CHAT_PRESETS.map((preset) => ({
          label: `${preset.name}  ·  ${preset.url}`,
          onCommand: () => applyChatPreset(preset),
        })),
      ),
    );
    const embedUrl = this.el("embed-url-presets");
    embedUrl.addEventListener("click", () =>
      this.openMenu(
        embedUrl,
        EMBED_PRESETS.map((preset) => ({
          label: `${preset.name}  ·  ${preset.url}`,
          onCommand: () => setPref("embed.url", preset.url),
        })),
      ),
    );
    const embedModel = this.el("embed-model-presets");
    embedModel.addEventListener("click", () =>
      this.openMenu(
        embedModel,
        EMBED_MODEL_PRESETS.map((model) => ({
          label: model,
          onCommand: () => setPref("embed.model", model),
        })),
      ),
    );
    const models = this.el<HTMLButtonElement>("api-model-list");
    models.addEventListener("click", () => void this.openModelMenu(models));
  }

  private async openModelMenu(anchor: HTMLButtonElement) {
    const cfg = readActiveConfig();
    const cacheKey = `${modelsUrl(cfg)}|${cfg.keys.api}`;
    const items: MenuItem[] = [];
    let fetched = this.modelCache.get(cacheKey);
    if (!fetched) {
      anchor.disabled = true;
      try {
        fetched = await listModels(cfg);
        this.modelCache.set(cacheKey, fetched);
      } catch (error) {
        ztoolkit.log("[Glossa] model list failed", error);
        items.push({ label: getString("models-failed"), disabled: true });
      } finally {
        anchor.disabled = false;
      }
    }
    const pick = (model: string) => () => setPref("api.model", model);
    for (const model of fetched || []) {
      items.push({ label: model, onCommand: pick(model) });
    }
    items.push("separator");
    for (const model of MODEL_PRESETS) {
      items.push({ label: model, onCommand: pick(model) });
    }
    this.openMenu(anchor, items);
  }

  private openMenu(anchor: Element, items: MenuItem[]) {
    const popup = this.doc.createXULElement("menupopup") as XULPopupElement;
    for (const item of items) {
      if (item === "separator") {
        popup.append(this.doc.createXULElement("menuseparator"));
        continue;
      }
      const entry = this.doc.createXULElement("menuitem");
      entry.setAttribute("label", item.label);
      if (item.disabled) entry.setAttribute("disabled", "true");
      if (item.onCommand) entry.addEventListener("command", item.onCommand);
      popup.append(entry);
    }
    popup.addEventListener("popuphidden", (event: Event) => {
      if (event.target === popup) popup.remove();
    });
    this.root.append(popup);
    popup.openPopup(anchor, "after_end");
  }

  // ---- profiles

  private initProfiles() {
    this.el("profile-save").addEventListener(
      "click",
      () => void this.saveProfile(),
    );
    this.el("profile-test-all").addEventListener(
      "click",
      () => void this.testAll(),
    );
    for (const key of ["profiles", "profiles.active"]) {
      const symbol = Zotero.Prefs.registerObserver(
        `${PREFIX}.${key}`,
        () => this.scheduleProfiles(),
        true,
      );
      this.cleanup.push(() => Zotero.Prefs.unregisterObserver(symbol));
    }
    this.renderProfiles();
  }

  /** Coalesce: a range drag fires many pref changes. */
  private scheduleProfiles() {
    if (this.profilesTimer !== undefined) return;
    this.profilesTimer = this.win.setTimeout(() => {
      this.profilesTimer = undefined;
      this.renderProfiles();
    }, 150);
  }

  private renderProfiles() {
    const list = this.el("profile-list");
    list.replaceChildren();
    const profiles = getProfiles();
    const active = matchingProfileId();
    this.el<HTMLButtonElement>("profile-test-all").disabled = !profiles.length;
    if (!profiles.length) {
      ztoolkit.UI.appendElement(
        {
          tag: "div",
          namespace: "html",
          classList: ["glossa-empty"],
          properties: { textContent: getString("profile-empty") },
        },
        list,
      );
      return;
    }
    for (const profile of profiles) {
      const isActive = profile.id === active;
      ztoolkit.UI.appendElement(
        {
          tag: "div",
          namespace: "html",
          classList: isActive
            ? ["glossa-profile", "glossa-active"]
            : ["glossa-profile"],
          children: [
            {
              tag: "button",
              namespace: "html",
              classList: ["glossa-profile-name"],
              properties: {
                textContent: `${isActive ? "✓ " : ""}${profile.name}`,
                title: getString("profile-use", {
                  args: { name: profile.name },
                }),
              },
              listeners: [
                {
                  type: "click",
                  listener: () => void this.switchProfile(profile),
                },
              ],
            },
            {
              tag: "button",
              namespace: "html",
              classList: ["glossa-profile-more"],
              properties: { textContent: "⋯" },
              listeners: [
                {
                  type: "click",
                  listener: (ev: Event) =>
                    this.openProfileMenu(ev.target as Element, profile),
                },
              ],
            },
          ],
        },
        list,
      );
    }
  }

  private openProfileMenu(anchor: Element, profile: Profile) {
    this.openMenu(anchor, [
      {
        label: getString("profile-rename"),
        onCommand: () => {
          const name = this.prompt(
            getString("profile-name-prompt"),
            profile.name,
          );
          if (!name || name === profile.name) return;
          if (getProfiles().some((p) => p.name === name)) {
            this.alert(getString("profile-name-exists", { args: { name } }));
            return;
          }
          renameProfile(profile.id, name);
        },
      },
      {
        label: getString("profile-save-here"),
        onCommand: () => void overwriteProfile(profile.id),
      },
      {
        label: getString("profile-delete"),
        onCommand: () => {
          const text = getString("profile-delete-confirm", {
            args: { name: profile.name },
          });
          if (this.confirm(text)) void deleteProfile(profile.id);
        },
      },
    ]);
  }

  private async saveProfile() {
    const profiles = getProfiles();
    const activeId = matchingProfileId() || String(getPref("profiles.active"));
    const current = profiles.find((p) => p.id === activeId);
    const name = this.prompt(
      getString("profile-name-prompt"),
      current?.name ||
        getString("profile-default-name", {
          args: { n: profiles.length + 1 },
        }),
    );
    if (!name) return;
    const exists = profiles.some((p) => p.name === name);
    if (
      exists &&
      !this.confirm(getString("profile-overwrite-confirm", { args: { name } }))
    ) {
      return;
    }
    await saveCurrentAs(name);
    this.renderProfiles();
  }

  private async switchProfile(profile: Profile) {
    const matching = matchingProfileId();
    if (matching === profile.id) return;
    if (!matching && !this.confirm(getString("profile-switch-unsaved"))) {
      return;
    }
    await applyProfile(profile.id);
    // Prefs update through their observers; keys have none.
    this.refreshSecrets();
    this.renderProfiles();
  }

  private prompt(text: string, value = "") {
    const box = { value };
    const ok = Services.prompt.prompt(
      this.win as any,
      "Glossa",
      text,
      box,
      null as unknown as string,
      { value: false },
    );
    return ok ? box.value.trim() : undefined;
  }

  private confirm(text: string) {
    return Services.prompt.confirm(this.win as any, "Glossa", text);
  }

  private alert(text: string) {
    Services.prompt.alert(this.win as any, "Glossa", text);
  }

  // ---- collaborative translation profiles

  /**
   * Two saved profiles used for draft → review translation. They are global
   * (not part of a chat profile) and only resolved when the user asks for a
   * collaborative or on-demand review, so picking them never changes the
   * current chat settings.
   */
  private initTranslationProfiles() {
    const draft = this.el<HTMLSelectElement>("translation-draft-profile");
    const review = this.el<HTMLSelectElement>("translation-review-profile");
    draft.addEventListener("change", () => {
      setPref("translation.draftProfile", draft.value);
      this.renderTranslationProfiles();
    });
    review.addEventListener("change", () => {
      setPref("translation.reviewProfile", review.value);
      this.renderTranslationProfiles();
    });
    // Profiles can be renamed, added or deleted elsewhere; the saved picks
    // themselves can also change from another open pane.
    for (const key of [
      "profiles",
      "profiles.active",
      "translation.draftProfile",
      "translation.reviewProfile",
    ]) {
      const symbol = Zotero.Prefs.registerObserver(
        `${PREFIX}.${key}`,
        () => this.renderTranslationProfiles(),
        true,
      );
      this.cleanup.push(() => Zotero.Prefs.unregisterObserver(symbol));
    }
    this.renderTranslationProfiles();
  }

  private renderTranslationProfiles() {
    const profiles = getProfiles();
    const hint = this.el("translation-hint");
    const fill = (
      select: HTMLSelectElement,
      prefKey: "translation.draftProfile" | "translation.reviewProfile",
    ) => {
      const stored = String(getPref(prefKey) || "");
      const exists = Boolean(stored) && profiles.some((p) => p.id === stored);
      // Keep the localized placeholder option; rebuild only the profile list.
      while (select.options.length > 1) select.remove(1);
      for (const profile of profiles) {
        ztoolkit.UI.appendElement(
          {
            tag: "option",
            namespace: "html",
            properties: { value: profile.id, textContent: profile.name },
          },
          select,
        );
      }
      // Restore the stored choice; if it was deleted show the placeholder and
      // flag it rather than silently dropping to the first profile.
      select.value = exists ? stored : "";
      return Boolean(stored) && !exists;
    };
    const draftMissing = fill(
      this.el<HTMLSelectElement>("translation-draft-profile"),
      "translation.draftProfile",
    );
    const reviewMissing = fill(
      this.el<HTMLSelectElement>("translation-review-profile"),
      "translation.reviewProfile",
    );
    const draftPick = String(getPref("translation.draftProfile") || "");
    const reviewPick = String(getPref("translation.reviewProfile") || "");
    const sameProfile =
      Boolean(draftPick) &&
      draftPick === reviewPick &&
      profiles.some((profile) => profile.id === draftPick);
    hint.textContent =
      draftMissing || reviewMissing
        ? getString("translation-profile-missing")
        : sameProfile
          ? getString("pref-translation-same-profile")
          : "";
  }

  // ---- connectivity test

  private initTest() {
    this.el("test-run").addEventListener("click", () => void this.runTest());
    this.el("test-cancel").addEventListener("click", () => this.stopTests());
    this.el("test-copy").addEventListener("click", () => this.copyOutput());
    this.el("test-help").addEventListener("click", () => {
      for (const id of [
        "test-help-chat",
        "test-help-embed",
        "test-help-network",
      ]) {
        this.line("info", getString(id));
      }
    });
    this.line("info", getString("test-idle"));
  }

  private output() {
    return this.el("test-output");
  }

  private line(kind: TestKind, text: string) {
    const out = this.output();
    ztoolkit.UI.appendElement(
      {
        tag: "div",
        namespace: "html",
        classList: ["glossa-line", `glossa-line-${kind}`],
        properties: { textContent: text },
      },
      out,
    );
    out.scrollTop = out.scrollHeight;
  }

  private setTesting(on: boolean) {
    this.el<HTMLButtonElement>("test-run").disabled = on;
    this.el<HTMLButtonElement>("profile-test-all").disabled =
      on || !getProfiles().length;
    this.el("test-cancel").hidden = !on;
    if (on) this.el("test-copy").hidden = true;
  }

  private stopTests() {
    this.stopQueue = true;
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
  }

  private async runTest() {
    let cfg = readActiveConfig();
    if (cfg.urlMode === "full" && !looksLikeFullUrl(cfg.url)) {
      if (this.confirm(getString("test-url-mismatch"))) {
        setPref("api.urlMode", "base");
        cfg = readActiveConfig();
      }
    }
    this.output().replaceChildren();
    this.stopQueue = false;
    this.setTesting(true);
    try {
      const outcome = await testConnection(
        cfg,
        (kind, text) => this.line(kind, text),
        (cancel) => this.cancels.add(cancel),
      );
      this.line(
        "info",
        getString("test-done", {
          args: { seconds: (outcome.ms / 1000).toFixed(1) },
        }),
      );
      this.el("test-copy").hidden =
        outcome.chat === "ok" && outcome.embed !== "error";
    } finally {
      this.cancels.clear();
      this.setTesting(false);
    }
  }

  /** Test every saved profile, three at a time, without switching to it. */
  private async testAll() {
    const profiles = getProfiles();
    if (!profiles.length) return;
    const out = this.output();
    out.replaceChildren();
    const table = ztoolkit.UI.appendElement(
      {
        tag: "table",
        namespace: "html",
        classList: ["glossa-results"],
        children: [
          {
            tag: "tr",
            namespace: "html",
            children: [
              "test-all-profile",
              "test-all-chat",
              "test-all-embed",
              "test-all-time",
              "",
            ].map((id) => ({
              tag: "th",
              namespace: "html",
              properties: { textContent: id ? getString(id) : "" },
            })),
          },
        ],
      },
      out,
    ) as HTMLTableElement;

    const rows = new Map<string, HTMLTableCellElement[]>();
    for (const profile of profiles) {
      const row = ztoolkit.UI.appendElement(
        {
          tag: "tr",
          namespace: "html",
          children: [
            {
              tag: "td",
              namespace: "html",
              properties: { textContent: profile.name },
            },
            { tag: "td", namespace: "html", properties: { textContent: "…" } },
            { tag: "td", namespace: "html", properties: { textContent: "…" } },
            { tag: "td", namespace: "html" },
            {
              tag: "td",
              namespace: "html",
              children: [
                {
                  tag: "button",
                  namespace: "html",
                  properties: { textContent: getString("test-all-use") },
                  listeners: [
                    {
                      type: "click",
                      listener: () => void this.switchProfile(profile),
                    },
                  ],
                },
              ],
            },
          ],
        },
        table,
      ) as HTMLElement;
      rows.set(profile.id, [
        ...row.querySelectorAll("td"),
      ] as HTMLTableCellElement[]);
    }

    const started = Date.now();
    const queue = [...profiles];
    let passed = 0;
    this.stopQueue = false;
    this.setTesting(true);
    const worker = async () => {
      while (queue.length && !this.stopQueue) {
        const profile = queue.shift()!;
        const [, chat, embed, time] = rows.get(profile.id)!;
        const outcome = await testConnection(
          resolveProfile(profile),
          () => {},
          (cancel) => this.cancels.add(cancel),
        );
        mark(
          chat,
          outcome.chat === "ok"
            ? "ok"
            : outcome.chat === "warn"
              ? "warn"
              : "error",
          outcome.chatDetail,
        );
        mark(
          embed,
          outcome.embed === "ok"
            ? "ok"
            : outcome.embed === "error"
              ? "error"
              : "info",
          outcome.embedDetail,
        );
        time.textContent = `${(outcome.ms / 1000).toFixed(1)} s`;
        if (outcome.chat === "ok" && outcome.embed !== "error") passed++;
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
    } finally {
      this.cancels.clear();
      this.setTesting(false);
    }
    this.line(
      "info",
      getString("test-all-summary", {
        args: {
          passed,
          total: profiles.length,
          seconds: ((Date.now() - started) / 1000).toFixed(1),
        },
      }),
    );
  }

  private copyOutput() {
    const text = [...this.output().querySelectorAll(".glossa-line, tr")]
      .map((node) =>
        node.localName === "tr"
          ? [...node.children].map((cell) => cell.textContent).join("\t")
          : node.textContent,
      )
      .join("\n");
    Zotero.Utilities.Internal.copyTextToClipboard(text);
    this.line("info", getString("test-copied"));
  }

  // ---- storage

  private initStorage() {
    const dir = conversationsDir();
    this.el("storage-path").textContent = dir;
    this.el("storage-open").addEventListener("click", async () => {
      try {
        await io().makeDirectory(dir, {
          createAncestors: true,
          ignoreExisting: true,
        });
        await Zotero.File.reveal(dir);
      } catch (error) {
        ztoolkit.log("[Glossa] cannot open storage folder", error);
      }
    });
  }
}

function applyChatPreset(preset: ChatPreset) {
  setPref("api.url", preset.url);
  setPref("api.urlMode", preset.urlMode);
  setPref("api.protocol", preset.protocol);
  // Current Claude models reject temperature.
  if (preset.protocol === "anthropic-messages") {
    setPref("api.temperature.enabled", false);
  }
}

function mark(cell: HTMLElement, kind: TestKind, detail: string) {
  cell.textContent = { ok: "✓", warn: "⚠", error: "✗", info: "–", request: "" }[
    kind
  ];
  cell.title = detail;
  cell.className = `glossa-line-${kind}`;
}

function isInput(control: Control): control is HTMLInputElement {
  return control.localName === "input";
}

function isCheckbox(control: Control): control is HTMLInputElement {
  return isInput(control) && control.type === "checkbox";
}

import { getPref, setPref } from "../utils/prefs";
import { getSecret, setSecret } from "../utils/secrets";
import {
  configEquals,
  normalizeConfig,
  parseProfiles,
  type ChatConfig,
  type Keys,
  type Profile,
  type ResolvedConfig,
} from "../utils/config";

/** The settings currently in effect, read from prefs. */
export function readConfig(): ChatConfig {
  return normalizeConfig({
    protocol: getPref("api.protocol"),
    url: getPref("api.url"),
    urlMode: getPref("api.urlMode"),
    model: getPref("api.model"),
    temperature: {
      enabled: getPref("api.temperature.enabled"),
      value: getPref("api.temperature"),
    },
    maxTokens: {
      enabled: getPref("api.maxTokens.enabled"),
      value: getPref("api.maxTokens"),
    },
    reasoningEffort: {
      enabled: getPref("api.reasoningEffort.enabled"),
      value: getPref("api.reasoningEffort"),
    },
    extraParams: getPref("api.extraParams"),
    systemPrompt: getPref("api.systemPrompt"),
    embed: {
      enabled: getPref("embed.enabled"),
      url: getPref("embed.url"),
      model: getPref("embed.model"),
      batchSize: getPref("embed.batchSize"),
    },
    relatedNumber: getPref("relatedNumber"),
    chatNumber: {
      enabled: getPref("chatNumber.enabled"),
      value: getPref("chatNumber"),
    },
  });
}

export function readKeys(): Keys {
  return { api: getSecret("api.key"), embed: getSecret("embed.key") };
}

/**
 * Snapshot taken once per request, so switching profiles mid-stream does
 * not change the endpoint or model of an answer already in flight.
 */
export function readActiveConfig(): ResolvedConfig {
  return { ...readConfig(), keys: readKeys() };
}

export async function writeConfig(config: ChatConfig, keys?: Keys) {
  setPref("api.protocol", config.protocol);
  setPref("api.url", config.url);
  setPref("api.urlMode", config.urlMode);
  setPref("api.model", config.model);
  setPref("api.temperature.enabled", config.temperature.enabled);
  // A string pref: Firefox has no float prefs.
  setPref("api.temperature", String(config.temperature.value));
  setPref("api.maxTokens.enabled", config.maxTokens.enabled);
  setPref("api.maxTokens", config.maxTokens.value);
  setPref("api.reasoningEffort.enabled", config.reasoningEffort.enabled);
  setPref("api.reasoningEffort", config.reasoningEffort.value);
  setPref("api.extraParams", config.extraParams);
  setPref("api.systemPrompt", config.systemPrompt);
  setPref("embed.enabled", config.embed.enabled);
  setPref("embed.url", config.embed.url);
  setPref("embed.model", config.embed.model);
  setPref("embed.batchSize", config.embed.batchSize);
  setPref("relatedNumber", config.relatedNumber);
  setPref("chatNumber.enabled", config.chatNumber.enabled);
  setPref("chatNumber", config.chatNumber.value);
  if (keys) {
    await setSecret("api.key", keys.api);
    await setSecret("embed.key", keys.embed);
  }
}

export function getProfiles(): Profile[] {
  return parseProfiles(String(getPref("profiles") || "[]"));
}

function saveProfiles(profiles: Profile[]) {
  setPref("profiles", JSON.stringify(profiles));
}

export function profileKeys(id: string): Keys {
  return {
    api: getSecret(`profile:${id}:api`),
    embed: getSecret(`profile:${id}:embed`),
  };
}

export function resolveProfile(profile: Profile): ResolvedConfig {
  return { ...profile.config, keys: profileKeys(profile.id) };
}

async function storeProfileKeys(id: string, keys: Keys) {
  await setSecret(`profile:${id}:api`, keys.api);
  await setSecret(`profile:${id}:embed`, keys.embed);
}

/** Snapshot the current settings under `name`, replacing a same-named one. */
export async function saveCurrentAs(name: string) {
  const profiles = getProfiles();
  const existing = profiles.find((p) => p.name === name);
  const profile: Profile = {
    id: existing?.id || Zotero.Utilities.randomString(10),
    name,
    config: readConfig(),
  };
  if (existing) profiles[profiles.indexOf(existing)] = profile;
  else profiles.push(profile);
  await storeProfileKeys(profile.id, readKeys());
  saveProfiles(profiles);
  setPref("profiles.active", profile.id);
  return profile;
}

/** "Save here": overwrite an existing profile with the current settings. */
export async function overwriteProfile(id: string) {
  const profiles = getProfiles();
  const target = profiles.find((p) => p.id === id);
  if (!target) return;
  target.config = readConfig();
  await storeProfileKeys(id, readKeys());
  saveProfiles(profiles);
  setPref("profiles.active", id);
}

export function renameProfile(id: string, name: string) {
  const profiles = getProfiles();
  const target = profiles.find((p) => p.id === id);
  if (!target) return;
  target.name = name;
  saveProfiles(profiles);
}

export async function deleteProfile(id: string) {
  saveProfiles(getProfiles().filter((p) => p.id !== id));
  await storeProfileKeys(id, { api: "", embed: "" });
  if (getPref("profiles.active") === id) setPref("profiles.active", "");
}

export async function applyProfile(id: string) {
  const profile = getProfiles().find((p) => p.id === id);
  if (!profile) return;
  await writeConfig(profile.config, profileKeys(id));
  setPref("profiles.active", id);
}

/**
 * The profile the current settings match exactly (keys included), if any.
 * Several can match; the last one applied wins.
 */
export function matchingProfileId(): string | undefined {
  const current = readConfig();
  const keys = readKeys();
  const matches = getProfiles().filter((p) => {
    if (!configEquals(p.config, current)) return false;
    const stored = profileKeys(p.id);
    return stored.api === keys.api && stored.embed === keys.embed;
  });
  const active = String(getPref("profiles.active") || "");
  return (matches.find((p) => p.id === active) || matches[0])?.id;
}

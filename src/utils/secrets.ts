import { config } from "../../package.json";

/**
 * API keys live in the login manager (logins.json, encrypted with the
 * profile's key4.db and, if set, the primary password), not in prefs.js,
 * which is plain text and ends up in profile backups and bug reports.
 */
const ORIGIN = `chrome://${config.addonRef}`;
const REALM = config.addonName;

/** Keys of the active settings; they existed as prefs in v0.1. */
export const SECRET_NAMES = ["api.key", "embed.key"] as const;
/** Saved profiles keep their own copies as `profile:<id>:api|embed`. */
export type SecretName =
  (typeof SECRET_NAMES)[number] | `profile:${string}:${"api" | "embed"}`;

type LoginManager = typeof Services.logins & {
  addLogin?: (login: nsILoginInfo) => void;
};

function findLogin(name: SecretName) {
  // A null form action origin selects HTTP-realm style logins.
  return Services.logins
    .findLogins(ORIGIN, null as unknown as string, REALM)
    .find((login) => login.username === name);
}

export function getSecret(name: SecretName): string {
  try {
    return findLogin(name)?.password || "";
  } catch (error) {
    // e.g. the user cancelled the primary-password prompt
    ztoolkit.log(`[Glossa] cannot read ${name}`, error);
    return "";
  }
}

export async function setSecret(name: SecretName, value: string) {
  const logins = Services.logins as LoginManager;
  const existing = findLogin(name);
  if (existing) logins.removeLogin(existing);
  // The login manager rejects empty passwords; removal is the "clear".
  if (!value) return;
  const LoginInfo = Components.Constructor(
    "@mozilla.org/login-manager/loginInfo;1",
    "nsILoginInfo",
    "init",
  );
  const login = new LoginInfo(ORIGIN, null, REALM, name, value, "", "");
  if (typeof logins.addLoginAsync === "function") {
    await logins.addLoginAsync(login);
  } else {
    logins.addLogin?.(login);
  }
}

/** Glossa 0.1 kept keys in prefs.js. Move them over once, then clear them. */
export async function migrateLegacySecrets() {
  await Services.logins.initializationPromise;
  for (const name of SECRET_NAMES) {
    const pref = `${config.prefsPrefix}.${name}`;
    const legacy = Zotero.Prefs.get(pref, true);
    if (legacy === undefined) continue;
    try {
      if (typeof legacy === "string" && legacy && !getSecret(name)) {
        await setSecret(name, legacy);
      }
      Zotero.Prefs.clear(pref, true);
    } catch (error) {
      // Keep the pref so the key is not lost; retry on next startup.
      ztoolkit.log(`[Glossa] could not migrate ${name}`, error);
    }
  }
}

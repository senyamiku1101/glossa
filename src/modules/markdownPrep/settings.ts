/** Normalized preferences; credentials are read only from the login manager. */
import { config } from "../../../package.json";
import { getSecret } from "../../utils/secrets";
import {
  DEFAULT_PADDLE_ENDPOINT,
  DEFAULT_PADDLE_MODEL,
  DEFAULT_PARSER,
  stableHash,
  type CloudConfig,
  type MineruConfig,
  type ParserId,
} from "./types";

export type MarkdownSettings = {
  enabled: boolean;
  provider: ParserId;
  autoOnImport: boolean;
  readContext: boolean;
  cloud: CloudConfig;
  mineru: MineruConfig;
};
export const TOKEN_SECRET_NAME = "markdown.cloud.token";
export const MINERU_TOKEN_SECRET_NAME = "markdown.mineru.token";
export function endpointHost(endpoint: string, allowHttp = false): string {
  try {
    const url = new URL(endpoint.trim());
    return url.protocol === "https:" || (allowHttp && url.protocol === "http:")
      ? url.host
      : "";
  } catch {
    return "";
  }
}
export function normalizeSettings(
  read: (key: string) => unknown,
): MarkdownSettings {
  const str = (key: string, fallback: string) => {
    const v = read(key);
    return typeof v === "string" ? v.trim() : fallback;
  };
  const bool = (key: string, fallback: boolean) => {
    const v = read(key);
    if (v === undefined || v === null) return fallback;
    return v === true || v === 1 || v === "true" || v === "1";
  };
  return {
    enabled: bool("markdown.enabled", true),
    provider:
      str("markdown.provider", DEFAULT_PARSER) === "mineru-cloud"
        ? "mineru-cloud"
        : DEFAULT_PARSER,
    autoOnImport: bool("markdown.autoOnImport", true),
    readContext: bool("markdown.readContext", true),
    cloud: {
      endpoint: str("markdown.cloud.endpoint", DEFAULT_PADDLE_ENDPOINT),
      model: str("markdown.cloud.model", DEFAULT_PADDLE_MODEL),
    },
    mineru: {
      endpoint: str("markdown.mineru.endpoint", "https://mineru.net"),
      modelVersion:
        str("markdown.mineru.modelVersion", "vlm") === "pipeline"
          ? "pipeline"
          : "vlm",
      language: str("markdown.mineru.language", "ch"),
      isOcr: bool("markdown.mineru.isOcr", false),
      selfHosted: bool("markdown.mineru.selfHosted", false),
    },
  };
}
export function readSettings(): MarkdownSettings {
  return normalizeSettings((key) => {
    try {
      return Zotero.Prefs.get(config.prefsPrefix + "." + key, true);
    } catch {
      return undefined;
    }
  });
}
export function readPaddleToken(): string {
  return String(getSecret(TOKEN_SECRET_NAME) || "").trim();
}
export function readMineruToken(): string {
  return String(getSecret(MINERU_TOKEN_SECRET_NAME) || "").trim();
}
export function readProviderToken(settings = readSettings()): string {
  return settings.provider === "mineru-cloud"
    ? readMineruToken()
    : readPaddleToken();
}
export function endpointConfigured(settings: MarkdownSettings): boolean {
  return settings.provider === "mineru-cloud"
    ? Boolean(
        endpointHost(settings.mineru.endpoint, settings.mineru.selfHosted),
      )
    : Boolean(
        endpointHost(settings.cloud.endpoint) && settings.cloud.model.trim(),
      );
}
export function configVersion(settings: MarkdownSettings): string {
  return stableHash(
    JSON.stringify({
      provider: settings.provider,
      config:
        settings.provider === "mineru-cloud" ? settings.mineru : settings.cloud,
    }),
  );
}

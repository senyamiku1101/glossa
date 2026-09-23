import { config } from "../../package.json";

export { initLocale, getString };

function initLocale() {
  const LocalizationCtor =
    typeof Localization === "undefined"
      ? ztoolkit.getGlobal("Localization")
      : Localization;
  const l10n = new LocalizationCtor([`${config.addonRef}-addon.ftl`], true);
  addon.data.locale = { current: l10n };
}

function getString(
  localeString: string,
  options: { branch?: string; args?: Record<string, unknown> } = {},
): string {
  const id = `${config.addonRef}-${localeString}`;
  const { branch, args } = options;
  const pattern = addon.data.locale?.current.formatMessagesSync([
    { id, args },
  ])[0] as
    | {
        value: string | null;
        attributes: Array<{ name: string; value: string }> | null;
      }
    | undefined;

  if (!pattern) return id;
  if (branch && pattern.attributes) {
    return (
      pattern.attributes.find((attr) => attr.name === branch)?.value || id
    );
  }
  return pattern.value || id;
}

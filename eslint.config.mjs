// @ts-check
import zotero from "@zotero-plugin/eslint-config";

export default [
  { ignores: ["tmp/**", "releases/**", ".scaffold/**", "addon/source/**"] },
  ...zotero(),
];

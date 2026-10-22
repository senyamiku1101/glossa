import { cp, mkdir, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Mirror the build inputs into the XPI on every build.
const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
const addon = join(project, "addon");
const bundled = join(addon, "source");
if (
  resolve(bundled) !== resolve(project, "addon", "source") ||
  !bundled.startsWith(addon + sep)
) {
  throw new Error("Source bundle path escaped the addon directory");
}
await rm(bundled, { recursive: true, force: true });
await mkdir(bundled, { recursive: true });
for (const name of [
  "src",
  "scripts",
  "typings",
  "package.json",
  "package-lock.json",
  "zotero-plugin.config.ts",
  "tsconfig.json",
  "eslint.config.mjs",
  ".env.example",
  "README.md",
  "CHANGELOG.md",
  "PRINCIPLES.md",
  "COPYRIGHT",
  "LICENSE",
]) {
  await cp(join(project, name), join(bundled, name), { recursive: true });
}

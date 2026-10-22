import { readFileSync } from "node:fs";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: [
      "addon/**/*.*",
      "addon/LICENSE",
      "addon/source/LICENSE",
      "addon/source/COPYRIGHT",
      "addon/source/.env.example",
    ],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  release: {
    github: {
      // Publish the matching CHANGELOG.md section as the GitHub release note,
      // so release pages stay useful even though commits are not conventional.
      releaseNote: (ctx) => {
        try {
          const changelog = readFileSync("CHANGELOG.md", "utf8");
          const marker = `## [${ctx.version}]`;
          const start = changelog.indexOf(marker);
          if (start === -1) return `Release v${ctx.version}`;
          const next = changelog.indexOf("\n## [", start + marker.length);
          return changelog.slice(start, next === -1 ? undefined : next).trim();
        } catch {
          return `Release v${ctx.version}`;
        }
      },
    },
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },
});

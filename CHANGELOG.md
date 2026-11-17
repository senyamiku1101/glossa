# Changelog

All notable changes to Glossa are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.2.19] - 2026-11-17

### Added

- Delete a translation and its corresponding question from a conversation after
  confirmation. Copies already added to the translation board are kept.
- Cloud PDF-to-Markdown preparation with **PaddleOCR** and **MinerU**, including
  provider selection and connection testing. API keys are stored in Zotero's
  login manager as `markdown.cloud.token` and `markdown.mineru.token`, never in
  preferences, logs or generated Markdown.
- Real Zotero Markdown attachments titled **[Glossa] Body · <PDF filename>**.
  PDFs with a parent item get a Markdown child attachment; standalone PDFs get
  a related attachment in the same library and collections. The readable main
  Markdown file and its images are stored flat in the Markdown attachment's own
  storage directory, with relative image links, so Zotero's native attachment
  sync carries the complete body across devices, including through WebDAV.
- Chat and retrieval prefer the prepared Markdown body, matched to its source
  PDF, and fall back to PDF text when needed.
- A compact **Background tasks** icon and popover in the Glossa chat header:
  live progress, cancel, retry, open the Markdown attachment and clear finished
  tasks. Item and collection menus now contain only **Convert body to Markdown**
  and **Delete body Markdown**; converting again refreshes the body.
- A two-card **Paper body** settings panel: parser service configuration, plus
  automation and reading. Once configured, manual conversion and automatic
  conversion follow these settings without a separate upload-permission dialog.

### Fixed

- Automatically remove early experimental bundle-sync data and only the known
  legacy `glossa-body.md`, `glossa-meta.json` and strictly named
  `glossa-asset-…` files from locally stored PDF directories, leaving PDFs and
  other user files untouched.
- MinerU presigned uploads no longer receive an unwanted form Content-Type;
  safe CDN downloads and images whose actual format differs from the filename
  extension are supported.
- PaddleOCR disables heavyweight chart/orientation/unwarping pipelines while
  retaining Markdown images. Repeated image references, readable image names,
  HTML image sources and titled relative links retain their resources.

### Validation

- PaddleOCR, MinerU and cross-device WebDAV synchronization have been tested
  successfully with real documents by the user. TypeScript, regression checks,
  bilingual locale validation, formatting, lint and production build pass.

## [0.2.18] - 2026-10-22

First public GitHub release. This is the first build whose embedded update feed
points at the real repository (`senyamiku1101/glossa`), so Zotero can pick up
future versions automatically.

### Added

- User-facing install and update documentation, including the one-time manual
  install needed for builds from before 0.2.18.
- `CHANGELOG.md`, used as the source of GitHub release notes.
- A GitHub Actions check workflow: typecheck, the full self-check suite and
  lint on every push and pull request.
- `engines.node` (`>=22.8.0`) matching the build toolchain requirement.

### Changed

- Repository, homepage and issue URLs now resolve to `senyamiku1101/glossa`.
- Package version bumped to 0.2.18. No application code changed since 0.2.17.

## [0.2.17] - 2026-10-20

### Fixed

- Paragraph scope ("选段") on figure-heavy multi-column pages: paragraphs that
  flow across columns and pages are stitched through a fragment chain instead of
  being rejected with `start-outside-visible-column`.
- Body passages such as "Fig. 12 shows ..." are no longer mistaken for figure
  captions, which used to truncate the body text.
- Figure axis labels are excluded from body lines by tightening the font-size
  tolerance from 25% to 20%.

### Added

- Two regression cases in `scripts/check-pdf-layout-edges.mjs` (52 cases total)
  covering citation sentences and three-fragment paragraphs.

## [0.2.16] - 2026-10-20

### Fixed

- Option toggles such as Max Tokens now disable their row controls when off,
  and the checkbox is no longer squeezed invisible by a long label.
- The glossary manager is reachable from the settings pane, not only from an
  icon in the chat header.
- Runtime `getString()` keys are now validated against `addon.ftl` by a new
  locale check script.

### Added

- `scripts/check-locales.mjs` in the `npm run check` chain.

## [0.2.15] - 2026-10-20

### Fixed

- Translation board cards now match the plugin's visual language instead of
  default browser controls.
- Stylesheets are injected with a versioned URL so a hot-updated plugin cannot
  keep serving a stale cached stylesheet.

### Added

- `src/utils/stylesheet.ts`: shared, versioned stylesheet injection for the
  item pane, sidebar and main window.

## [0.2.14] - 2026-10-19

### Added

- Translation board in the sidebar: collect up to 50 translations across items,
  copy an entry, show the source text, jump back to the item or PDF, remove an
  entry, or clear the board after confirmation.
- Local persistence in `<Zotero data directory>/glossa/board.json`.

## [0.2.13] - 2026-10-19

### Added

- Personal glossary: add a term and its translation from the PDF selection
  popup, then search, edit and delete terms from the glossary manager. Matching
  runs locally and only matching entries are attached to a translation request.
- Two-model collaborative translation: draft with one saved profile and review
  with a second, plus on-demand review of a finished translation. Long source
  text is chunked, which can produce additional requests.
- `scripts/check-glossary-translation.mjs` in the `npm run check` chain.

## [0.2.12] - 2026-10-12

### Added

- Session history with search, create/switch/rename/delete, and save to a
  Zotero note.
- PDF selection popup with selection/paragraph scope, quick translation,
  collaborative translation and detailed explanation.
- PDF layout paragraph detection, cross-column and cross-page paragraph
  continuation.
- Full-height focused sidebar workspace.
- Source packaging inside the XPI (`source/` with TypeScript, build scripts,
  configuration, lockfile and documentation).

## [0.1.0] - 2026-09-23

### Added

- First MVP: item pane chat, floating chat, three API protocols (OpenAI Chat
  Completions, OpenAI Responses, Anthropic Messages), settings and provider
  profiles, command tags, PDF retrieval via embeddings with keyword fallback,
  and API keys stored in Zotero's login manager.

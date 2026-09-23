# Glossa

Fully open-source AI assistant for [Zotero](https://www.zotero.org/) 7–10.

There is **no Pro edition**, no encrypted module, and no license server. If a feature exists, its TypeScript is in this repository.

[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

中文说明见下文。

## Why this exists

Popular Zotero GPT plugins advertise AGPL while shipping a different, encrypted binary. Glossa is the opposite: **Corresponding Source = the XPI**.

It is a **clean-room reimplementation** of the useful workflow (chat with the current paper, command tags, retrieval over PDF text). It is not a dump of Awesome GPT / zotero-gpt 3.x.

## Features (v0.2)

- **Item pane chat**: a Glossa section in the item pane, in the library and next to every open PDF (Zotero's official `ItemPaneManager` API)
- **Floating chat** (`Ctrl+/`, also inside the PDF reader); both views share one conversation per item and stream the same answer
- **Conversations saved** as plain JSON under `<Zotero data directory>/glossa/conversations/`, one file per item; deleted with the item
- **Context modes** for typed questions: chat only, PDF relevant passages, PDF full text, or abstract
- **Three protocols**: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages; reasoning is shown in a collapsible block
- **Settings**: provider presets, Base/Full URL, model list fetched from the provider, temperature / max tokens / reasoning effort toggles, system prompt, extra request params (JSON)
- **Profiles**: save, switch, rename and delete complete settings (keys included); test one profile or all of them
- **Command tags**: AskPDF, Translate, Summarize, AskAbstract — editable; templates only substitute `{{input}}` `{{selection}}` `{{abstract}}` `{{title}}` `{{authors}}` `{{year}}` `{{related}}` `{{fulltext}}`
- Retrieval via embeddings with keyword fallback; chunks and vectors cached per PDF
- API keys stored in Zotero's login manager, never in `prefs.js`

Later (same license, still in this repo): message actions, save chat as note, selection-popup commands, outline, annotation helpers, agent tools.

## Install (development)

1. Install [Node.js LTS](https://nodejs.org/) and Zotero 7+.
2. `cd glossa && npm install`
3. Copy `.env.example` to `.env` and set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`.
4. `npm start` for hot reload, or `npm run build` then install `.scaffold/build/*.xpi`.

Configure **Edit → Settings → Glossa**: pick a provider preset or type a URL, then set the key and model and press **Test**. Any host that speaks one of the three protocols works, including relays. There is no "API store": Glossa never installs other add-ons.

Keys go to the login manager (`logins.json`, encrypted with the profile's `key4.db`, plus the primary password if you set one). Keys saved by v0.1 in `prefs.js` are moved there on first start and removed from prefs.

`npm run check` tests the pure modules in `src/utils/` (protocols, config, history, text) under plain Node; `npm run lint:check` must pass before a release.

## Command tags

Tags are edited in the Glossa settings pane and stored as JSON in preferences. They are templates, not executable JavaScript. Only templates that contain `{{related}}` or `{{fulltext}}` read the PDF. Retrieved passages and full text are sent only with the question they were fetched for; the saved history keeps the question without them.

```
Use this context:
{{related}}

Question:
{{input}}
```

## Name

**Glossa** is a scholarly gloss: notes in the margin of a text. It does not collide with Awesome GPT, PapersGPT, ARIA, Beaver, ZotAI, or llm-for-zotero.

## License

[AGPL-3.0-or-later](LICENSE). Charging for support is fine. Shipping a closed module next to this code is not.

See [PRINCIPLES.md](PRINCIPLES.md).

---

# Glossa（中文）

给 Zotero 用的**完整开源**文献助手：对话、命令标签、PDF 选区/段落检索。

- 没有付费墙、没有 `pro-entry.enc`、没有设备数限制。
- 仓库源码就是 xpi 源码。
- 命令标签只做 `{{变量}}` 替换，**不执行用户 JS**。
- 条目面板里有 Glossa 对话区（文库和 PDF 阅读器右侧都有），对话按条目保存为 JSON 文件。
- 支持 OpenAI Chat、OpenAI Responses、Anthropic Messages 三种协议，可保存多个配置档并一键测试。
- 使用你自己的 API Key（OpenAI 兼容接口）。密钥存放在 Zotero 登录管理器里，不写入 `prefs.js`。
- 每个条目有各自的对话，可以随时点「新对话」清空；回答生成中可以点「停止」。

快捷键 `Ctrl+/`（在 PDF 阅读器里也能用）。设置在「编辑 → 设置 → Glossa」，命令标签也在设置页里编辑。

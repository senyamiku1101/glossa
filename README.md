# Glossa

Fully open-source AI assistant for [Zotero](https://www.zotero.org/) 7–10.

There is **no Pro edition**, no encrypted module, and no license server. If a feature exists, its TypeScript is in this repository.

[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

中文说明见下文。

## Why this exists

Popular Zotero GPT plugins advertise AGPL while shipping a different, encrypted binary. Glossa is the opposite: **Corresponding Source = the XPI**.

It is a **clean-room reimplementation** of the useful workflow (chat with the current paper, command tags, retrieval over PDF text). It is not a dump of Awesome GPT / zotero-gpt 3.x.

## MVP (v0.1)

- Floating chat (`Ctrl+/`)
- OpenAI-compatible streaming (`/v1/chat/completions`)
- Command tags: AskPDF, Translate, Summarize, AskAbstract
- Safe templates: `{{input}}` `{{selection}}` `{{abstract}}` `{{title}}` `{{authors}}` `{{year}}` `{{related}}`
- Related-paragraph retrieval via embeddings, with keyword fallback
- Preferences for chat + embedding endpoints

Later (same license, still in this repo): reader sidebar, outline, annotation helpers, agent tools.

## Install (development)

1. Install [Node.js LTS](https://nodejs.org/) and Zotero 7+.
2. `cd glossa && npm install`
3. Copy `.env.example` to `.env` and set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`.
4. `npm start` for hot reload, or `npm run build` then install `.scaffold/build/*.xpi`.

Configure **Edit → Settings → Glossa**: API URL, key, model. DeepSeek, SiliconFlow, OpenRouter, and other OpenAI-compatible hosts work if they expose chat completions.

## Command tags

Tags are JSON in preferences, not executable JavaScript.

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
- 使用你自己的 API Key（OpenAI 兼容接口）。

快捷键 `Ctrl+/`。设置在「编辑 → 设置 → Glossa」。

# Glossa

Fully open-source AI assistant for [Zotero](https://www.zotero.org/) 7–10.

There is **no Pro edition**, no encrypted module, and no license server. If a feature exists, its TypeScript is in this repository.

[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

中文说明见下文。

## Why this exists

Glossa is designed for inspectable research assistance: **each XPI contains the source and build recipe used to make it**.

The product centers on evidence checks, method maps, and a local record of the document context sent with each answer. Any reused code or asset must be identified and attributed before a public release.

## Features (v0.2)

- **Item pane chat**: a Glossa section in the item pane, in the library and next to every open PDF (Zotero's official `ItemPaneManager` API)
- **Floating chat** (`Ctrl+/`, also inside the PDF reader); both views share the item's sessions and stream the same answer
- **Session history**: a full-height history view with search and recent chats for the current paper; create, switch, rename, delete, or save a conversation as a Zotero note
- **Focused sidebar**: select Glossa in the side navigation for a full-height workspace with a fixed composer and separately scrolling messages; selecting PDF text does not move keyboard focus
- **Sent-context trace**: expand a question to inspect the user message and document passages sent with that turn (saved locally, capped at 12,000 characters and marked if truncated)
- **Conversations saved** as plain JSON under `<Zotero data directory>/glossa/conversations/`, one file per item; deleted with the item
- **Selection popup**: a single row holds the scope, Translate / Explain in detail, and Send controls. Paragraphs expands the selection to all complete natural paragraphs it touches, preserving their order and paragraph breaks. Choose the default scope (Selection or Paragraphs) in settings; recognition never sends automatically. If boundaries cannot be confirmed, no request is sent and the scope stays on Paragraphs with a diagnostic. The Send arrow is gray and disabled while recognition is pending or unsuccessful, and green only when usable text is ready. Select the text again or switch the scope to retry recognition; manually switch to Selection to use the original text.
- **Context modes** for typed questions: chat only, PDF relevant passages, PDF full text, or abstract
- **Three protocols**: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages; reasoning is shown in a collapsible block
- **Settings**: provider presets, Base/Full URL, model list fetched from the provider, temperature / max tokens / reasoning effort toggles, system prompt, extra request params (JSON)
- **Profiles**: save, switch, rename and delete complete settings (keys included); test one profile or all of them
- **Research actions**: Evidence audit, Method map, Precise translation, Next questions — editable; templates only substitute `{{input}}` `{{selection}}` `{{abstract}}` `{{title}}` `{{authors}}` `{{year}}` `{{related}}` `{{fulltext}}`
- Retrieval via embeddings with keyword fallback; chunks and vectors cached per PDF
- API keys stored in Zotero's login manager, never in `prefs.js`

Existing single-conversation files migrate automatically. An untouched `.v1.bak` backup is kept alongside each migrated file before it is updated. New conversation starts a separate session without deleting history. Source navigation and annotation helpers are planned.

## Install (development)

1. Install [Node.js LTS](https://nodejs.org/) and Zotero 7+.
2. `cd glossa && npm install`
3. Copy `.env.example` to `.env` and set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`.
4. `npm start` for hot reload, or `npm run build` then install `.scaffold/build/*.xpi`.

Configure **Edit → Settings → Glossa**: pick a provider preset or type a URL, then set the key and model and press **Test**. Any host that speaks one of the three protocols works, including relays. There is no "API store": Glossa never installs other add-ons.

Keys go to the login manager (`logins.json`, encrypted with the profile's `key4.db`, plus the primary password if you set one). Keys saved by v0.1 in `prefs.js` are moved there on first start and removed from prefs.

Every production XPI includes the full AGPL license and a `source/` directory with the TypeScript, build script, configuration, dependency lockfile and documentation. To rebuild from an XPI, extract it, put its runtime files in an `addon/` directory, copy the contents of `source/` next to `addon/`, then run `npm ci && npm run build` from that parent directory. The generated `addon/source/` directory is ignored by Git and rebuilt on each run. Release tags should point to the same commit used to build the XPI.

`npm run check` tests pure helpers plus session persistence, stream routing, and sidebar lifecycle with mocked Zotero services under Node; `npm run lint:check` must pass before a release.

## Command tags

Tags are edited in the Glossa settings pane and stored as JSON in preferences. They are templates, not executable JavaScript. Only templates that contain `{{related}}` or `{{fulltext}}` read the PDF. Retrieved passages and full text are sent only with the question they were fetched for. Later model turns replay a compact question; the local sent-context trace keeps a capped copy of the original request for inspection.

```
Use this context:
{{related}}

Question:
{{input}}
```

## Name

**Glossa** is a scholarly gloss: notes in the margin of a text.

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
- 每篇文献可保留多个会话；「新对话」创建新会话并保留历史。点击历史图标进入独立的聊天列表，可搜索、切换、重命名、删除，或保存到 Zotero 笔记；回答生成中可以点「停止」。
- 划词弹窗将「选区 / 选段」「翻译 / 详细解释」和发送箭头放在同一排。「选段」扩展到选区覆盖的各个完整自然段，保留原顺序和段落间隔；设置中可选择默认范围。选择默认选段只会自动识别，点击箭头才发送，结果保存到当前文献的 Glossa 会话。识别中或识别失败时发送箭头为灰色并禁用，只有获得可用文字后才变绿；发送过程中也保持灰色禁用。无法确认完整边界（如复杂公式断开正文）时不发送，仍保留「选段」并显示诊断，可重新划选文字或切换范围重新识别，或手动切换为「选区」。
- 点击右侧 Glossa 图标进入固定高度的阅读面板，输入区固定在底部，仅正文滚动。划词会更新引用，但不会抢焦点。
- 旧版记录自动迁移，原文件保留为同目录下的 `.v1.bak` 备份。

快捷键 `Ctrl+/`（在 PDF 阅读器里也能用）。设置在「编辑 → 设置 → Glossa」，命令标签也在设置页里编辑。

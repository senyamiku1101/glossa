pref("api.protocol", "openai-chat");
pref("api.url", "https://api.openai.com");
pref("api.urlMode", "base");
pref("api.model", "gpt-4o-mini");
pref("api.temperature", "0.7");
pref("api.temperature.enabled", true);
pref("api.maxTokens", 8192);
pref("api.maxTokens.enabled", false);
pref("api.reasoningEffort", "medium");
pref("api.reasoningEffort.enabled", false);
pref("api.extraParams", "{}");
pref("api.systemPrompt", "");
pref("embed.enabled", true);
pref("embed.url", "");
pref("embed.model", "text-embedding-3-small");
pref("embed.batchSize", 16);
pref("relatedNumber", 5);
pref("chatNumber", 6);
pref("chatNumber.enabled", true);
pref("chat.contextMode", "related");
pref("reader.popup", true);
pref("reader.visualOverlay", true);
pref("tags", "");
pref("profiles", "[]");
pref("profiles.active", "");
pref("translation.draftProfile", "");
pref("translation.reviewProfile", "");
pref("board.expanded", false);

// Markdown attachment parsing. API keys live in the login manager.
pref("markdown.enabled", true);
pref("markdown.provider", "paddleocr-cloud");
pref("markdown.autoOnImport", true);
pref("markdown.readContext", true);
pref("markdown.bundleCleanupDone", false);
pref(
  "markdown.cloud.endpoint",
  "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs",
);
pref("markdown.cloud.model", "PP-StructureV3");
pref("markdown.mineru.endpoint", "https://mineru.net");
pref("markdown.mineru.modelVersion", "vlm");
pref("markdown.mineru.language", "ch");
pref("markdown.mineru.isOcr", false);
pref("markdown.mineru.selfHosted", false);

import { getString } from "../utils/locale";
import { DEFAULT_SYSTEM_PROMPT, type ResolvedConfig } from "../utils/config";
import { buildHistory, type TranslationInfo } from "../utils/history";
import { splitTranslationSource } from "../utils/translation";
import type { RenderedPrompt, Target } from "./context";
import { conversations } from "./conversations";
import { glossary, type GlossarySnapshot } from "./glossary";
import { streamChat, type Delta, type StreamResult } from "./llm";
import { readActiveConfig } from "./settings";
import {
  reviewBlock,
  reviewPrompt,
  translationProfiles,
  withGlossary,
} from "./translation";

export type AskRequest = {
  target: Target;
  sessionId?: string;
  /** What the transcript shows for the question. */
  display: string;
  build: (target: Target, config: ResolvedConfig) => Promise<RenderedPrompt>;
};

type Run = {
  key: string;
  sessionId?: string;
  stopped: boolean;
  cancel?: () => void;
};

type DraftPiece = { source: string; text: string };
type VerifiedResult = StreamResult & {
  pieces: DraftPiece[];
  /** The exact user prompts sent for this piece, for the local trace. */
  prompts: string[];
};
type ReviewOutcome =
  | { ok: true; text: string; prompts: string[] }
  | { ok: false; reason: "stopped" | "failed" };

/**
 * One question at a time, across all views. The answer streams into the
 * conversation store; views only render what the store holds.
 */
class Runner {
  private run?: Run;

  get busy() {
    return Boolean(this.run);
  }

  /** Resolves to whether an answer was kept. */
  async ask(request: AskRequest): Promise<boolean> {
    if (this.run) return false;
    const { target, display } = request;
    const key = target.key;
    // One snapshot per question: switching profiles mid-stream changes
    // nothing about this answer. Translation profiles are never applied
    // over this active chat config.
    const config = readActiveConfig();
    const run: Run = { key, stopped: false };
    this.run = run;
    conversations.setBusy(key);

    try {
      const convo = await conversations.ensureLoaded(key, target.label);
      if (convo.storageError)
        throw new Error(getString("session-storage-error"));
      const session = request.sessionId
        ? convo.sessions.find((entry) => entry.id === request.sessionId)
        : conversations.active(key);
      if (!session || run.stopped) return false;
      run.sessionId = session.id;
      conversations.setBusy(key, session.id);
      conversations.startPending(key, session.id, display);
      const rendered = await request.build(target, config);
      if (run.stopped) {
        conversations.failPending(key, run.sessionId, getString("stopped"));
        return false;
      }
      if (rendered.translationRequest?.mode === "collaborative") {
        return await this.collaborative(
          run,
          key,
          session.id,
          display,
          rendered,
        );
      }
      return await this.quick(
        run,
        key,
        session.id,
        display,
        rendered,
        config,
        session.turns,
      );
    } catch (error: any) {
      conversations.failPending(
        key,
        run.sessionId,
        error?.message || String(error),
      );
      return false;
    } finally {
      this.run = undefined;
      conversations.setBusy(undefined);
    }
  }

  /**
   * Review one committed assistant turn. The new answer is appended; the
   * original turn is left as it was. `turnIndex` indexes `session.turns`.
   */
  async reviewTranslation(request: {
    target: Target;
    sessionId: string;
    turnIndex: number;
  }): Promise<boolean> {
    if (this.run) return false;
    const { target, sessionId, turnIndex } = request;
    const key = target.key;
    const run: Run = { key, sessionId, stopped: false };
    this.run = run;
    conversations.setBusy(key, sessionId);
    try {
      const convo = await conversations.ensureLoaded(key, target.label);
      if (convo.storageError)
        throw new Error(getString("session-storage-error"));
      const session = convo.sessions.find((entry) => entry.id === sessionId);
      if (!session || run.stopped) return false;
      const turn = session.turns[turnIndex];
      const info = turn?.translation;
      const block = reviewBlock(turn);
      const title = getString("translation-review-title");
      conversations.startPending(key, sessionId, title);
      conversations.setPendingStage(key, sessionId, "reviewing");
      if (block || !turn || !info) {
        conversations.failPending(
          key,
          sessionId,
          getString(block || "translation-source-unavailable"),
        );
        return false;
      }
      const { review } = translationProfiles("review");
      const gloss = await safeSnapshot();
      if (run.stopped) {
        conversations.failPending(
          key,
          sessionId,
          getString("translation-review-stopped"),
        );
        return false;
      }
      const requested = reviewPrompt(info.source, turn.content);
      const prompt = gloss
        ? withGlossary(requested, gloss.match(info.source))
        : requested;
      const reviewed = await streamReview(
        review,
        systemFor(review),
        [{ source: info.source, text: turn.content }],
        (delta) =>
          conversations.updatePending(
            key,
            sessionId,
            delta.text,
            delta.reasoning,
          ),
        bindCancel(run),
        () => run.stopped,
        gloss,
      );
      if (!reviewed.ok) {
        conversations.failPending(
          key,
          sessionId,
          getString(
            reviewed.reason === "stopped"
              ? "translation-review-stopped"
              : "translation-review-failed",
          ),
        );
        return false;
      }
      const sent = markerPrompt(prompt);
      conversations.commitPending(
        key,
        sessionId,
        {
          role: "user",
          content: title,
          source: {
            text: sent.slice(0, 12000),
            truncated: sent.length > 12000,
          },
        },
        {
          role: "assistant",
          content: reviewed.text,
          translation: {
            mode: "review",
            source: info.source,
            ...(info.sourceTruncated ? { sourceTruncated: true } : {}),
            status: "reviewed",
            draft: turn.content,
            ...(info.translator ? { translator: info.translator } : {}),
            ...(review.model ? { reviewer: review.model } : {}),
          },
        },
      );
      return true;
    } catch (error: any) {
      conversations.failPending(
        key,
        sessionId,
        error?.message || String(error),
      );
      return false;
    } finally {
      this.run = undefined;
      conversations.setBusy(undefined);
    }
  }

  stop() {
    if (!this.run) return;
    this.run.stopped = true;
    this.run.cancel?.();
  }

  /** The existing one-request path. Metadata is local and adds no request. */
  private async quick(
    run: Run,
    key: string,
    sessionId: string,
    display: string,
    rendered: RenderedPrompt,
    config: ResolvedConfig,
    turns: { role: "user" | "assistant"; content: string }[],
  ): Promise<boolean> {
    const limit = config.chatNumber.enabled ? config.chatNumber.value : null;
    const system = systemFor(config);
    const onDelta = (delta: Delta) =>
      conversations.updatePending(key, sessionId, delta.text, delta.reasoning);
    const onCancelReady = bindCancel(run);
    const halted = () => run.stopped;
    const gloss = usesGlossary(rendered) ? await safeSnapshot() : undefined;
    const asked =
      gloss && !rendered.translation
        ? withGlossary(
            rendered.prompt,
            gloss.match(rendered.translationRequest?.source || ""),
          )
        : rendered.prompt;
    if (halted()) {
      conversations.failPending(key, sessionId, getString("stopped"));
      return false;
    }
    const verified = rendered.translation
      ? await streamVerifiedTranslation(
          config,
          system,
          rendered.translation,
          onDelta,
          onCancelReady,
          halted,
          gloss,
        )
      : undefined;
    const result =
      verified ??
      (await streamChat(
        config,
        [
          { role: "system", content: system },
          ...buildHistory(turns, asked, limit),
        ],
        onDelta,
        onCancelReady,
      ));
    if (!result.text) {
      conversations.failPending(
        key,
        sessionId,
        getString(result.aborted || halted() ? "stopped" : "empty-reply"),
      );
      return false;
    }
    const note =
      result.aborted || halted()
        ? getString("stopped")
        : result.incomplete
          ? getString("incomplete", { args: { reason: result.incomplete } })
          : "";
    const request = rendered.translationRequest;
    const translation: TranslationInfo | undefined =
      request?.mode === "quick"
        ? {
            mode: "quick",
            source: request.source,
            status:
              result.aborted || halted() || result.incomplete
                ? "incomplete"
                : "draft",
            ...(config.model ? { translator: config.model } : {}),
          }
        : undefined;
    this.commit(key, sessionId, display, rendered, {
      content: result.text,
      note,
      reasoning: result.reasoning,
      translation,
      tracePrompt:
        verified && verified.prompts.length
          ? verified.prompts.join("\n\n")
          : asked,
    });
    return true;
  }

  /**
   * Draft with profile A, then review with profile B. A failed or stopped
   * review keeps the complete draft and never stores a partial review.
   */
  private async collaborative(
    run: Run,
    key: string,
    sessionId: string,
    display: string,
    rendered: RenderedPrompt,
  ): Promise<boolean> {
    const request = rendered.translationRequest;
    if (
      !request ||
      request.mode !== "collaborative" ||
      !request.source.trim()
    ) {
      conversations.failPending(
        key,
        sessionId,
        getString("translation-source-unavailable"),
      );
      return false;
    }
    const { draft, review } = translationProfiles("collaborative");
    const gloss = await safeSnapshot();
    const asked = rendered.translation
      ? rendered.prompt
      : gloss
        ? withGlossary(rendered.prompt, gloss.match(request.source))
        : rendered.prompt;
    if (run.stopped) {
      conversations.failPending(key, sessionId, getString("stopped"));
      return false;
    }
    const onDelta = (delta: Delta) =>
      conversations.updatePending(key, sessionId, delta.text, delta.reasoning);
    const onCancelReady = bindCancel(run);
    const stopped = () => run.stopped;
    conversations.setPendingStage(key, sessionId, "translating");

    // What was actually sent, for the local trace. The verified path may send
    // one prompt per piece, each with its own glossary hits.
    let tracePrompt = asked;
    let draftText: string;
    let pieces: DraftPiece[];
    if (rendered.translation) {
      const drafted = await streamVerifiedTranslation(
        draft,
        systemFor(draft),
        rendered.translation,
        onDelta,
        onCancelReady,
        stopped,
        gloss,
      );
      if (!drafted.text) {
        conversations.failPending(
          key,
          sessionId,
          getString(drafted.aborted ? "stopped" : "empty-reply"),
        );
        return false;
      }
      if (drafted.prompts.length) tracePrompt = drafted.prompts.join("\n\n");
      const complete =
        !drafted.aborted &&
        !drafted.incomplete &&
        coversSource(rendered.translation.source, drafted.pieces);
      if (!complete) {
        this.commit(key, sessionId, display, rendered, {
          content: drafted.text,
          translation: draftInfo(request.source, draft.model, "incomplete"),
          tracePrompt,
        });
        return true;
      }
      draftText = drafted.text;
      pieces = drafted.pieces;
    } else {
      const drafted = await streamChat(
        draft,
        [
          { role: "system", content: systemFor(draft) },
          { role: "user", content: asked },
        ],
        onDelta,
        onCancelReady,
      );
      if (!drafted.text) {
        conversations.failPending(
          key,
          sessionId,
          getString(drafted.aborted ? "stopped" : "empty-reply"),
        );
        return false;
      }
      if (drafted.aborted || drafted.incomplete) {
        this.commit(key, sessionId, display, rendered, {
          content: drafted.text,
          translation: draftInfo(request.source, draft.model, "incomplete"),
          tracePrompt,
        });
        return true;
      }
      draftText = drafted.text;
      pieces = [{ source: request.source, text: drafted.text }];
    }

    if (stopped()) {
      this.commit(key, sessionId, display, rendered, {
        content: draftText,
        translation: keptDraft(request.source, draft.model, "stopped"),
        tracePrompt,
      });
      return true;
    }

    conversations.setPendingStage(key, sessionId, "reviewing");
    const reviewed = await streamReview(
      review,
      systemFor(review),
      pieces,
      onDelta,
      onCancelReady,
      stopped,
      gloss,
    );
    if (!reviewed.ok) {
      this.commit(key, sessionId, display, rendered, {
        content: draftText,
        translation: keptDraft(
          request.source,
          draft.model,
          reviewed.reason === "stopped" ? "stopped" : "review-failed",
          review.model,
        ),
        tracePrompt,
      });
      return true;
    }
    if (reviewed.prompts.length) {
      tracePrompt = [tracePrompt, reviewed.prompts.join("\n\n")].join("\n\n");
    }
    this.commit(key, sessionId, display, rendered, {
      content: reviewed.text,
      translation: {
        mode: "collaborative",
        source: request.source,
        status: "reviewed",
        draft: draftText,
        ...(draft.model ? { translator: draft.model } : {}),
        ...(review.model ? { reviewer: review.model } : {}),
      },
      tracePrompt,
    });
    return true;
  }

  private commit(
    key: string,
    sessionId: string,
    display: string,
    rendered: RenderedPrompt,
    answer: {
      content: string;
      note?: string;
      reasoning?: string;
      translation?: TranslationInfo;
      /** The user prompt actually sent, when glossary text was added. */
      tracePrompt?: string;
    },
  ) {
    const prompt = answer.tracePrompt || rendered.prompt;
    conversations.commitPending(
      key,
      sessionId,
      {
        role: "user",
        content: rendered.compact,
        ...(display === rendered.compact ? {} : { display }),
        ...(prompt === display
          ? {}
          : {
              source: {
                text: prompt.slice(0, 12000),
                truncated: prompt.length > 12000,
              },
            }),
      },
      {
        role: "assistant",
        content: answer.content,
        ...(answer.note
          ? { display: `${answer.content}\n\n*${answer.note}*` }
          : {}),
        ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
        ...(answer.translation ? { translation: answer.translation } : {}),
      },
    );
  }
}

function systemFor(config: ResolvedConfig) {
  return config.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
}

function usesGlossary(rendered: RenderedPrompt) {
  return Boolean(rendered.translationRequest || rendered.translation);
}

/**
 * The glossary is optional context. A damaged or locked file is logged, the
 * manager still reports it, and this answer runs without terms instead of
 * failing the translation.
 */
async function safeSnapshot(): Promise<GlossarySnapshot | undefined> {
  try {
    return await glossary.snapshot();
  } catch (error) {
    ztoolkit.log("[Glossa] glossary unavailable for this answer", error);
    return undefined;
  }
}

function draftInfo(
  source: string,
  model: string,
  status: "incomplete",
): TranslationInfo {
  return {
    mode: "collaborative",
    source,
    status,
    ...(model ? { translator: model } : {}),
  };
}

function bindCancel(run: Run) {
  return (cancel: () => void) => {
    run.cancel = cancel;
    if (run.stopped) cancel();
  };
}

function keptDraft(
  source: string,
  model: string,
  status: "stopped" | "review-failed",
  reviewer = "",
): TranslationInfo {
  return {
    mode: "collaborative",
    source,
    status,
    ...(model ? { translator: model } : {}),
    ...(reviewer ? { reviewer } : {}),
    warning: getString(
      status === "stopped"
        ? "translation-review-stopped"
        : "translation-review-failed",
    ),
  };
}

function coversSource(source: string, pieces: DraftPiece[]) {
  const letters = (value: string) => value.replace(/\s+/g, "");
  return (
    letters(pieces.map((piece) => piece.source).join("")) === letters(source)
  );
}

const TRANSLATION_END = "[[GLOSSA_TRANSLATION_END]]";

function joinText(a: string, b: string) {
  return a && b ? `${a}\n\n${b}` : a || b;
}

function withoutMarker(text: string) {
  return text.split(TRANSLATION_END, 1)[0].trimEnd();
}

function markerPrompt(prompt: string) {
  return (
    prompt +
    `\n\n请在译文末尾单独输出结束标记 ${TRANSLATION_END}，用于核对译文完整；标记不会展示给读者。`
  );
}

/** A provider may stop mid-sentence without reporting a token limit. A marker
 * verifies each piece; an unfinished piece is retried at a smaller size. */
async function streamVerifiedTranslation(
  config: ResolvedConfig,
  system: string,
  translation: NonNullable<RenderedPrompt["translation"]>,
  onDelta: (delta: Delta) => void,
  onCancelReady: (cancel: () => void) => void,
  stopped: () => boolean,
  gloss?: GlossarySnapshot,
): Promise<VerifiedResult> {
  const sendPiece = async (
    source: string,
    depth: number,
    before: string,
    beforeReasoning: string,
  ): Promise<VerifiedResult> => {
    if (stopped()) {
      return {
        text: "",
        reasoning: "",
        aborted: true,
        incomplete: "",
        pieces: [],
        prompts: [],
      };
    }
    const prompt = await translation.promptFor(source);
    if (stopped()) {
      return {
        text: "",
        reasoning: "",
        aborted: true,
        incomplete: "",
        pieces: [],
        prompts: [],
      };
    }
    const asked = gloss ? withGlossary(prompt, gloss.match(source)) : prompt;
    const sent = markerPrompt(asked);
    const result = await streamChat(
      config,
      [
        { role: "system", content: system },
        { role: "user", content: sent },
      ],
      (delta) =>
        onDelta({
          text: joinText(before, withoutMarker(delta.text)),
          reasoning: joinText(beforeReasoning, delta.reasoning),
        }),
      onCancelReady,
    );
    if (result.aborted || stopped()) {
      return {
        ...result,
        text: withoutMarker(result.text),
        aborted: true,
        pieces: [],
        prompts: [sent],
      };
    }
    if (!result.incomplete && result.text.includes(TRANSLATION_END)) {
      const text = withoutMarker(result.text);
      return {
        ...result,
        text,
        pieces: text ? [{ source, text }] : [],
        prompts: [sent],
      };
    }
    if (depth >= 3 || source.length < 250) {
      throw new Error(getString("translation-incomplete"));
    }
    const halves = splitTranslationSource(source, Math.ceil(source.length / 2));
    if (halves.length < 2) throw new Error(getString("translation-incomplete"));
    // Remove the unfinished attempt before showing the smaller retries.
    onDelta({ text: before, reasoning: beforeReasoning });
    let text = "";
    let reasoning = "";
    let pieces: DraftPiece[] = [];
    const prompts = [sent];
    for (const half of halves) {
      const part = await sendPiece(
        half,
        depth + 1,
        joinText(before, text),
        joinText(beforeReasoning, reasoning),
      );
      text = joinText(text, part.text);
      reasoning = joinText(reasoning, part.reasoning);
      pieces = pieces.concat(part.pieces);
      prompts.push(...part.prompts);
      if (part.aborted) return { ...part, text, reasoning, pieces, prompts };
    }
    return { text, reasoning, aborted: false, incomplete: "", pieces, prompts };
  };

  let text = "";
  let reasoning = "";
  let pieces: DraftPiece[] = [];
  let prompts: string[] = [];
  for (const source of splitTranslationSource(translation.source)) {
    const part = await sendPiece(source, 0, text, reasoning);
    text = joinText(text, part.text);
    reasoning = joinText(reasoning, part.reasoning);
    pieces = pieces.concat(part.pieces);
    prompts = prompts.concat(part.prompts);
    if (part.aborted) return { ...part, text, reasoning, pieces, prompts };
  }
  return { text, reasoning, aborted: false, incomplete: "", pieces, prompts };
}

/** One review of each drafted piece. A missing end marker is retried once
 * at the same size; the piece is never split apart from its draft. */
async function streamReview(
  config: ResolvedConfig,
  system: string,
  pairs: DraftPiece[],
  onDelta: (delta: Delta) => void,
  onCancelReady: (cancel: () => void) => void,
  stopped: () => boolean,
  gloss?: GlossarySnapshot,
): Promise<ReviewOutcome> {
  let done = "";
  const prompts: string[] = [];
  let previous: { source: string; translation: string } | undefined;
  for (const pair of pairs) {
    if (stopped()) return { ok: false, reason: "stopped" };
    const body = reviewPrompt(pair.source, pair.text, previous);
    const prompt = markerPrompt(
      gloss ? withGlossary(body, gloss.match(pair.source)) : body,
    );
    let accepted = "";
    for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
      if (stopped()) return { ok: false, reason: "stopped" };
      let result: StreamResult;
      try {
        prompts.push(prompt);
        result = await streamChat(
          config,
          [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          (delta) =>
            onDelta({
              text: joinText(done, withoutMarker(delta.text)),
              reasoning: delta.reasoning,
            }),
          onCancelReady,
        );
      } catch (error) {
        ztoolkit.log("[Glossa] review request failed", error);
        if (stopped()) return { ok: false, reason: "stopped" };
        return { ok: false, reason: "failed" };
      }
      if (result.aborted || stopped()) return { ok: false, reason: "stopped" };
      const cleaned = withoutMarker(result.text);
      if (
        !result.incomplete &&
        result.text.includes(TRANSLATION_END) &&
        cleaned
      ) {
        accepted = cleaned;
      }
    }
    if (!accepted) return { ok: false, reason: "failed" };
    done = joinText(done, accepted);
    previous = { source: pair.source, translation: accepted };
    onDelta({ text: done, reasoning: "" });
  }
  return done
    ? { ok: true, text: done, prompts }
    : { ok: false, reason: "failed" };
}

export const runner = new Runner();

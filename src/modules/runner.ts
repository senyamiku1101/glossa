import { getString } from "../utils/locale";
import { DEFAULT_SYSTEM_PROMPT, type ResolvedConfig } from "../utils/config";
import { buildHistory } from "../utils/history";
import { splitTranslationSource } from "../utils/translation";
import type { RenderedPrompt, Target } from "./context";
import { conversations } from "./conversations";
import { streamChat, type Delta, type StreamResult } from "./llm";
import { readActiveConfig } from "./settings";

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
    // nothing about this answer.
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
      const limit = config.chatNumber.enabled ? config.chatNumber.value : null;
      const system = config.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
      const onDelta = (delta: Delta) =>
        conversations.updatePending(
          key,
          session.id,
          delta.text,
          delta.reasoning,
        );
      const onCancelReady = (cancel: () => void) => (run.cancel = cancel);
      const result = rendered.translation
        ? await streamVerifiedTranslation(
            config,
            system,
            rendered.translation,
            onDelta,
            onCancelReady,
            () => run.stopped,
          )
        : await streamChat(
            config,
            [
              { role: "system", content: system },
              ...buildHistory(session.turns, rendered.prompt, limit),
            ],
            onDelta,
            onCancelReady,
          );
      if (!result.text) {
        conversations.failPending(
          key,
          session.id,
          getString(result.aborted ? "stopped" : "empty-reply"),
        );
        return false;
      }
      const note = result.aborted
        ? getString("stopped")
        : result.incomplete
          ? getString("incomplete", { args: { reason: result.incomplete } })
          : "";
      conversations.commitPending(
        key,
        session.id,
        {
          role: "user",
          content: rendered.compact,
          display: display === rendered.compact ? undefined : display,
          source:
            rendered.prompt === display
              ? undefined
              : {
                  text: rendered.prompt.slice(0, 12000),
                  truncated: rendered.prompt.length > 12000,
                },
        },
        {
          role: "assistant",
          content: result.text,
          display: note ? `${result.text}\n\n*${note}*` : undefined,
          reasoning: result.reasoning || undefined,
        },
      );
      return true;
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

  stop() {
    if (!this.run) return;
    this.run.stopped = true;
    this.run.cancel?.();
  }
}

const TRANSLATION_END = "[[GLOSSA_TRANSLATION_END]]";

/** A provider may stop mid-sentence without reporting a token limit. A marker
 * verifies each piece; an unfinished piece is retried at a smaller size. */
async function streamVerifiedTranslation(
  config: ResolvedConfig,
  system: string,
  translation: NonNullable<RenderedPrompt["translation"]>,
  onDelta: (delta: Delta) => void,
  onCancelReady: (cancel: () => void) => void,
  stopped: () => boolean,
): Promise<StreamResult> {
  const join = (a: string, b: string) => (a && b ? `${a}\n\n${b}` : a || b);
  const withoutMarker = (text: string) =>
    text.split(TRANSLATION_END, 1)[0].trimEnd();
  const sendPiece = async (
    source: string,
    depth: number,
    before: string,
    beforeReasoning: string,
  ): Promise<StreamResult> => {
    if (stopped())
      return { text: "", reasoning: "", aborted: true, incomplete: "" };
    const prompt = await translation.promptFor(source);
    const result = await streamChat(
      config,
      [
        { role: "system", content: system },
        {
          role: "user",
          content:
            prompt +
            `\n\n请在译文末尾单独输出结束标记 ${TRANSLATION_END}，用于核对译文完整；标记不会展示给读者。`,
        },
      ],
      (delta) =>
        onDelta({
          text: join(before, withoutMarker(delta.text)),
          reasoning: join(beforeReasoning, delta.reasoning),
        }),
      onCancelReady,
    );
    if (result.aborted) return { ...result, text: withoutMarker(result.text) };
    if (!result.incomplete && result.text.includes(TRANSLATION_END)) {
      return { ...result, text: withoutMarker(result.text) };
    }
    if (depth >= 3 || source.length < 250)
      throw new Error(getString("translation-incomplete"));
    const halves = splitTranslationSource(source, Math.ceil(source.length / 2));
    if (halves.length < 2) throw new Error(getString("translation-incomplete"));
    // Remove the unfinished attempt before showing the smaller retries.
    onDelta({ text: before, reasoning: beforeReasoning });
    let text = "";
    let reasoning = "";
    for (const half of halves) {
      const part = await sendPiece(
        half,
        depth + 1,
        join(before, text),
        join(beforeReasoning, reasoning),
      );
      text = join(text, part.text);
      reasoning = join(reasoning, part.reasoning);
      if (part.aborted) return { ...part, text, reasoning };
    }
    return { text, reasoning, aborted: false, incomplete: "" };
  };

  let text = "";
  let reasoning = "";
  for (const source of splitTranslationSource(translation.source)) {
    const part = await sendPiece(source, 0, text, reasoning);
    text = join(text, part.text);
    reasoning = join(reasoning, part.reasoning);
    if (part.aborted) return { ...part, text, reasoning };
  }
  return { text, reasoning, aborted: false, incomplete: "" };
}
export const runner = new Runner();

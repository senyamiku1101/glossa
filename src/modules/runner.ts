import { getString } from "../utils/locale";
import { DEFAULT_SYSTEM_PROMPT, type ResolvedConfig } from "../utils/config";
import { buildHistory } from "../utils/history";
import type { RenderedPrompt, Target } from "./context";
import { conversations } from "./conversations";
import { streamChat } from "./llm";
import { readActiveConfig } from "./settings";

export type AskRequest = {
  target: Target;
  /** What the transcript shows for the question. */
  display: string;
  build: (target: Target, config: ResolvedConfig) => Promise<RenderedPrompt>;
};

type Run = { key: string; stopped: boolean; cancel?: () => void };

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
    conversations.startPending(key, display);

    try {
      const convo = await conversations.ensureLoaded(key, target.label);
      const rendered = await request.build(target, config);
      if (run.stopped) {
        conversations.failPending(key, getString("stopped"));
        return false;
      }
      const limit = config.chatNumber.enabled ? config.chatNumber.value : null;
      const result = await streamChat(
        config,
        [
          {
            role: "system",
            content: config.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
          },
          ...buildHistory(convo.turns, rendered.prompt, limit),
        ],
        (delta) =>
          conversations.updatePending(key, delta.text, delta.reasoning),
        (cancel) => (run.cancel = cancel),
      );
      if (!result.text) {
        conversations.failPending(
          key,
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
        {
          role: "user",
          content: rendered.compact,
          display: display === rendered.compact ? undefined : display,
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
      conversations.failPending(key, error?.message || String(error));
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

export const runner = new Runner();

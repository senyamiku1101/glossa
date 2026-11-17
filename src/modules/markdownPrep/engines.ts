/** Configuration-only gate. Manual and automatic jobs use the same provider. */
import {
  endpointConfigured,
  readProviderToken,
  readSettings,
  type MarkdownSettings,
} from "./settings";
import { getBodySource } from "./sources";
import type { BodySource, ParseFailureReason } from "./types";
export type CloudGateDecision =
  | { ok: true; apiKey: string }
  | {
      ok: false;
      status: "waiting-config" | "failed";
      reason: ParseFailureReason;
      detail?: string;
    };
export type CloudGateInput = {
  settings: MarkdownSettings;
  token: string;
  sourceRegistered: boolean;
  sourceAvailable: boolean;
  automatic?: boolean;
};
export function evaluateCloudGate(input: CloudGateInput): CloudGateDecision {
  const configured = endpointConfigured(input.settings);
  const keyOptional =
    input.settings.provider === "mineru-cloud" &&
    input.settings.mineru.selfHosted;
  if (!configured || (!keyOptional && !input.token.trim()))
    return {
      ok: false,
      status: "waiting-config",
      reason: "paddle-not-configured",
      detail:
        "Configure the selected provider endpoint and API key in settings.",
    };
  if (!input.sourceRegistered || !input.sourceAvailable)
    return {
      ok: false,
      status: "failed",
      reason: "internal-error",
      detail: "cloud-source-unavailable",
    };
  return { ok: true, apiKey: input.token.trim() };
}
export type ResolvedCloudGate =
  | { ok: true; source: BodySource; apiKey: string; settings: MarkdownSettings }
  | Extract<CloudGateDecision, { ok: false }>;
export async function resolveCloudGate(
  options: { automatic?: boolean; settings?: MarkdownSettings } = {},
): Promise<ResolvedCloudGate> {
  const settings = options.settings ?? readSettings();
  const source = getBodySource(settings.provider);
  let token = "";
  let available = false;
  try {
    token = readProviderToken(settings);
  } catch {
    /* Login manager unavailable. */
  }
  try {
    available = Boolean(source && (await source.available()));
  } catch {
    /* Unavailable adapter. */
  }
  const decision = evaluateCloudGate({
    settings,
    token,
    sourceRegistered: Boolean(source),
    sourceAvailable: available,
  });
  if (!decision.ok) return decision;
  if (!source) return { ok: false, status: "failed", reason: "internal-error" };
  return { ...decision, source, settings };
}
export function gateLabel(gate: ResolvedCloudGate): string {
  return gate.ok ? "ok" : gate.status + ":" + gate.reason;
}

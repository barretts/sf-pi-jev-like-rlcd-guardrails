import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerGuardrailProvider,
  type GuardrailExtensionOptions,
} from "./guardrail-extension.js";

export function registerExtension(
  pi: ExtensionAPI,
  options: GuardrailExtensionOptions = {},
) {
  const env = options.env ?? process.env;
  const guardrailRisk = registerGuardrailProvider(pi, options);
  pi.on("session_start", async () => {
    if (
      !guardrailRisk.status().enabled ||
      !["shadow", "enforce"].includes(env.SF_GUARDRAIL_JEV_MODE ?? "off")
    )
      return;
    try {
      await guardrailRisk.warmup();
    } catch {
      // The provider retains the failure; the host owns visible rules fallback.
    }
  });
  return { guardrailRisk };
}

export default function extension(pi: ExtensionAPI) {
  registerExtension(pi);
}

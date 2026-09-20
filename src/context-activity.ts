import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ContextCompressionController,
  ContextCompressionStatus,
} from "./context-extension.js";

const UI_KEY = "jev-context";
const MAX_LOG_ENTRIES = 50;
type UI = Pick<ExtensionContext, "hasUI" | "ui">;
type Activity = { time: string; summary: string; details?: string };

function kibibytes(value: number): string {
  return `${(value / 1024).toFixed(1)} KiB`;
}

function skipReason(status: ContextCompressionStatus): string {
  if (status.candidate?.originalSourceBytes === 0)
    return "no completed tool text";
  const reason = status.projectionFallbackReason;
  if (reason?.startsWith("target-unreachable")) {
    const target = ((status.targetReduction ?? 0.5) * 100).toFixed(0);
    return `${target}% target cannot be reached with protected context`;
  }
  switch (reason ?? status.lastContext?.lastFallback) {
    case "unsupported-provider":
    case "unsupported_provider":
      return "provider API does not support context projection";
    case "retrieval-unavailable":
      return "original-text retrieval is unavailable";
    case "context-limit":
    case "context_limit":
      return "context limit reached";
    case "cancelled":
      return "turn cancelled";
    case "empty-task":
    case "instructions_unavailable":
      return "waiting for a new user turn";
    case "no-projection":
      return "no tool text could be reduced";
    case "provider-boundary":
    case "provider_boundary":
    case "malformed-provider-payload":
    case "converter-unavailable":
    case "unserializable-provider-payload":
    case "unclonable-provider-payload":
    case "repeated-provider-projection":
      return "provider request check failed";
    default:
      return "request kept unchanged";
  }
}

/** UI-only observers: no messages, session entries, or provider payload changes. */
export function registerContextActivity(
  pi: ExtensionAPI,
  compression: ContextCompressionController,
) {
  let logging = true;
  let lastUI: UI | undefined;
  let activities: Activity[] = [];
  let footer = "Jev context: off";
  let requests = 0;
  let validatedRequests = 0;

  function rememberUI(context?: UI): UI | undefined {
    if (context?.hasUI) lastUI = { hasUI: true, ui: context.ui };
    return context ?? lastUI;
  }

  function render(context?: UI): void {
    const ui = rememberUI(context);
    if (!ui?.hasUI) return;
    try {
      ui.ui.setStatus?.(UI_KEY, logging ? footer : undefined);
      ui.ui.setWidget?.(
        UI_KEY,
        logging
          ? [
              footer,
              ...activities
                .slice(-2)
                .map((entry) => `[${entry.time}] ${entry.summary}`),
            ]
          : undefined,
      );
    } catch {
      // A missing or failing UI must never interrupt inference or restoration.
    }
  }

  function record(summary: string, details?: string): void {
    activities.push({
      time: new Date().toLocaleTimeString("en-US", { hour12: false }),
      summary,
      ...(details ? { details } : {}),
    });
    if (activities.length > MAX_LOG_ENTRIES) activities.shift();
  }

  function refresh(context?: UI, changed = false): void {
    const ui = rememberUI(context);
    if (!ui?.hasUI || !logging) return;
    const status = compression.status();
    validatedRequests = status.validatedProviderRequests;
    if (!status.enabled) footer = "Jev context: off";
    else if (changed || activities.length === 0)
      footer = `Jev context: ${status.strategy ?? "lossless"} | waiting`;
    if (changed)
      record(
        status.enabled
          ? `Enabled ${status.strategy ?? "lossless"}; reduction target ${((status.targetReduction ?? 0.5) * 100).toFixed(0)}%.`
          : "Disabled; requests use original context.",
      );
    render(ui);
  }

  function reset(context?: UI): void {
    activities = [];
    requests = 0;
    validatedRequests = compression.status().validatedProviderRequests;
    footer = "Jev context: off";
    refresh(context, true);
  }

  pi.on("session_start", (_event, context) => reset(context));
  pi.on("session_before_switch", (_event, context) => reset(context));
  pi.on("session_before_fork", (_event, context) => reset(context));
  pi.on("session_before_tree", (_event, context) => reset(context));
  pi.on("session_shutdown", (_event, context) => {
    const ui = rememberUI(context);
    if (ui?.hasUI) {
      try {
        ui.ui.setStatus?.(UI_KEY, undefined);
        ui.ui.setWidget?.(UI_KEY, undefined);
      } catch {
        /* UI cleanup cannot block session shutdown. */
      }
    }
    activities = [];
    lastUI = undefined;
  });
  pi.on("before_agent_start", (_event, context) => {
    if (!logging || !context.hasUI) return;
    const status = compression.status();
    validatedRequests = status.validatedProviderRequests;
    footer = status.enabled
      ? `Jev context: ${status.strategy ?? "lossless"} | checking`
      : "Jev context: off";
    render(context);
  });
  pi.on("context", (_event, context) => {
    if (!logging || !context.hasUI) return;
    const status = compression.status();
    if (!status.enabled) return;
    footer = `Jev context: ${status.strategy ?? "lossless"} | checking`;
    render(context);
  });
  // Registered after the compressor: a prepared candidate is not an applied
  // request. Only a newly validated provider request can produce "Applied".
  pi.on("before_provider_request", (_event, context) => {
    if (!logging || !context.hasUI) return;
    const status = compression.status();
    if (!status.enabled) {
      footer = "Jev context: off";
      render(context);
      return;
    }
    requests++;
    const receipt = status.lastContext;
    const applied =
      status.validatedProviderRequests > validatedRequests &&
      (receipt?.compressedBlocks ?? 0) > 0 &&
      status.candidate?.applied !== false;
    validatedRequests = status.validatedProviderRequests;
    if (applied && receipt) {
      const mode = receipt.blocks.some(
        (block) => block.format === "jev-caveman-v1",
      )
        ? "caveman"
        : status.strategy === "caveman"
          ? "excerpts (caveman fallback)"
          : (status.strategy ?? "lossless");
      const reduction = status.candidate?.actualByteReductionFraction;
      const requestReduction =
        typeof reduction === "number" && Number.isFinite(reduction)
          ? ` | -${(reduction * 100).toFixed(1)}% request bytes`
          : "";
      footer = `Jev context: applied ${mode}${requestReduction}`;
      const estimates =
        status.estimatedOriginalPromptTokens !== null &&
        status.estimatedOriginalPromptTokens !== undefined &&
        status.estimatedProjectedPromptTokens !== null &&
        status.estimatedProjectedPromptTokens !== undefined
          ? ` Estimated tokens ${status.estimatedOriginalPromptTokens} -> ${status.estimatedProjectedPromptTokens}.`
          : "";
      record(
        `Applied #${requests}: ${mode}, ${receipt.compressedBlocks} block${receipt.compressedBlocks === 1 ? "" : "s"}${requestReduction}.`,
        `Tool text ${kibibytes(receipt.originalBytes)} -> ${kibibytes(receipt.compressedBytes)}.${estimates} Originals retained.`,
      );
    } else {
      footer = "Jev context: checked | kept originals";
      record(`Checked #${requests}: kept originals; ${skipReason(status)}.`);
    }
    render(context);
  });
  pi.on("after_provider_response", (event, context) => {
    if (
      !logging ||
      !context.hasUI ||
      event.status < 400 ||
      !compression.status().enabled
    )
      return;
    footer = `Jev context: provider error HTTP ${event.status}`;
    record(`Provider rejected request #${requests}: HTTP ${event.status}.`);
    render(context);
  });

  return {
    refresh,
    reset,
    showLog(context: UI): void {
      if (!context.hasUI) return;
      try {
        context.ui.notify(
          activities.length
            ? activities
                .map(
                  (entry) =>
                    `[${entry.time}] ${entry.summary}${entry.details ? `\n  ${entry.details}` : ""}`,
                )
                .join("\n")
            : "Jev context: no activity recorded in this session.",
          "info",
        );
      } catch {
        /* Activity inspection does not affect compression. */
      }
    },
    setLogging(enabled: boolean, context: UI): void {
      logging = enabled;
      if (enabled) refresh(context, true);
      else render(context);
    },
  };
}

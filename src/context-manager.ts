import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  MANAGER_DISCOVERY_EVENT,
  type ConfigPanel,
  type ExternalDescriptor,
  type ManagerAction,
} from "./manager.js";

export type ContextManagerRoutingMode =
  "off" | "shadow" | "auto" | "fast" | "strong";

export interface ContextCompressionManagerStatus {
  enabled: boolean;
  strategy?: "lossless" | "excerpts" | "caveman";
  targetReduction?: number;
  targetReached?: boolean;
  estimatedPromptReductionFraction?: number | null;
  projectionFallbackReason?: string | null;
  candidate?: {
    applied: boolean;
    wholePayloadOriginalBytes: number | null;
    wholePayloadProjectedBytes: number | null;
  } | null;
  contextCalls?: number;
  compressedBlocks?: number;
  originalBytes?: number;
  compressedBytes?: number;
  bytesSaved?: number;
  fallbackCount?: number;
  lastFallback?: string | null;
  lastContext?: {
    compressedBlocks?: number;
    originalBytes?: number;
    compressedBytes?: number;
    bytesSaved?: number;
    instructionBytes?: number;
  } | null;
}

export interface RoutingManagerStatus {
  mode: ContextManagerRoutingMode;
  selectedTarget?: string;
  qualified: boolean;
  qualificationReason?: string;
  lastFallback?: string;
  fastAvailable: boolean;
  strongAvailable: boolean;
  requests?: number;
  fallbacks?: number;
  cancelled?: number;
  totals?: {
    requests?: number;
    fallbacks?: number;
    cancelled?: number;
  };
}

/** Controllers read cached state; callbacks only change the current session. */
export interface ContextManagerBindings {
  compression?: {
    status(): ContextCompressionManagerStatus;
    setEnabled(enabled: boolean): Promise<void> | void;
  };
  routing?: {
    status(): RoutingManagerStatus;
    setMode(mode: ContextManagerRoutingMode): Promise<void> | void;
  };
}

/** The patched Manager permits contributors without a scoped enablement action. */
export type ContextManagerDescriptor = Omit<ExternalDescriptor, "setEnabled">;

const CONTEXT_ID = "jev-context";
const ROUTING_ID = "jev-routing";
const modes: readonly ContextManagerRoutingMode[] = [
  "off",
  "shadow",
  "auto",
  "fast",
  "strong",
];

function count(value: number | undefined): string {
  return Number.isSafeInteger(value) && value! >= 0 ? String(value) : "unknown";
}

function text(value: string): string {
  // Manager text is a single bounded row, including configured target names.
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .slice(0, 160);
}

function modeLabel(mode: ContextManagerRoutingMode): string {
  return {
    off: "Off",
    shadow: "Shadow (observe; use strong target)",
    auto: "Automatic",
    fast: "Request fast when eligible",
    strong: "Always use strong target",
  }[mode];
}

/** Recheck eligibility at application time, including after a panel was opened. */
export function routingModeUnavailableReason(
  mode: ContextManagerRoutingMode,
  status: RoutingManagerStatus,
): string | undefined {
  if (mode === "off") return undefined;
  if (mode === "fast" && !status.fastAvailable)
    return "The fast target is unavailable. Configure it before selecting this mode.";
  if (
    ["shadow", "strong", "auto", "fast"].includes(mode) &&
    !status.strongAvailable
  )
    return "The strong target is unavailable. Configure it before selecting this mode.";
  if (mode === "auto" && !status.fastAvailable)
    return "The fast target is unavailable. Automatic routing requires both targets.";
  if (["auto", "fast"].includes(mode) && !status.qualified)
    return mode === "auto"
      ? "Automatic routing is unavailable until a qualified routing artifact is loaded."
      : "Fast routing is unavailable until a qualified routing artifact is loaded; eligible requests still require classifier and safety checks.";
  return undefined;
}

function compressionStatusLines(
  status: ContextCompressionManagerStatus,
): string[] {
  const latest = status.lastContext;
  const netReduction =
    latest &&
    Number.isSafeInteger(latest.bytesSaved) &&
    Number.isSafeInteger(latest.instructionBytes)
      ? latest.bytesSaved! - latest.instructionBytes!
      : undefined;
  const candidate = status.candidate;
  const serializedReduction =
    candidate?.applied &&
    Number.isSafeInteger(candidate.wholePayloadOriginalBytes) &&
    Number.isSafeInteger(candidate.wholePayloadProjectedBytes)
      ? candidate.wholePayloadOriginalBytes! -
        candidate.wholePayloadProjectedBytes!
      : undefined;
  return [
    `Compression: ${status.enabled ? "enabled" : "disabled"}`,
    ...(status.strategy ? [`Strategy: ${status.strategy}.`] : []),
    ...(typeof status.targetReduction === "number"
      ? [
          `Prompt reduction target: ${(status.targetReduction * 100).toFixed(0)}%.`,
        ]
      : []),
    ...(typeof status.estimatedPromptReductionFraction === "number"
      ? [
          `Latest estimated prompt reduction: ${(status.estimatedPromptReductionFraction * 100).toFixed(1)}%; target ${status.targetReached ? "reached" : "not reached"}.`,
        ]
      : []),
    "Changes apply to the current session.",
    ...(latest
      ? [
          `Latest tool context: ${count(latest.compressedBlocks)} text blocks compressed; ${count(latest.bytesSaved)} B saved.`,
          `Latest tool text bytes: ${count(latest.originalBytes)} original; ${count(latest.compressedBytes)} compressed.`,
          ...(serializedReduction !== undefined
            ? [
                `Serialized request reduction including tool schemas and instructions: ${serializedReduction} B.`,
              ]
            : status.strategy === "excerpts" || status.strategy === "caveman"
              ? []
              : netReduction === undefined
                ? []
                : [
                    netReduction >= 0
                      ? `Model context reduction including format instructions: ${netReduction} B.`
                      : `Model context increase including format instructions: ${-netReduction} B.`,
                  ]),
        ]
      : ["No completed context transformation reported yet."]),
    `Context calls: ${count(status.contextCalls)}; cumulative tool context reduction: ${count(status.bytesSaved)} B.`,
    "Original tool text stays in the session history.",
    `Fallbacks to original text: ${count(status.fallbackCount)}.`,
    ...(status.lastFallback
      ? ["Latest fallback: original tool text was used."]
      : []),
  ];
}

function routingStatusLines(status: RoutingManagerStatus): string[] {
  return [
    `Routing: ${modeLabel(status.mode)}`,
    "Changes apply to the current session.",
    `Fast target: ${status.fastAvailable ? "available" : "unavailable"}; strong target: ${status.strongAvailable ? "available" : "unavailable"}.`,
    `Automatic routing artifact: ${status.qualified ? "qualified" : "unavailable or unqualified"}.`,
    ...(status.selectedTarget
      ? [`Latest selected target: ${text(status.selectedTarget) || "unknown"}.`]
      : ["No target selected for a request yet."]),
    `Requests: ${count(status.totals?.requests ?? status.requests)}; fallbacks: ${count(status.totals?.fallbacks ?? status.fallbacks)}; cancelled: ${count(status.totals?.cancelled ?? status.cancelled)}.`,
    ...(status.lastFallback ? ["Latest request required a fallback."] : []),
  ];
}

class ContextSessionPanel implements ConfigPanel {
  focused = false;
  private enabled: boolean;
  private busy = false;
  private message = "";

  constructor(
    private readonly theme: Theme,
    private readonly done: (result: undefined) => void,
    private readonly bindings: NonNullable<
      ContextManagerBindings["compression"]
    >,
  ) {
    this.enabled = bindings.status().enabled;
  }

  render(width: number): string[] {
    return this.renderContent(width);
  }

  renderContent(_width: number): string[] {
    const theme = this.theme;
    return [
      ` ${theme.fg("accent", theme.bold("Context Compression"))}`,
      ` ${theme.fg("dim", "Changes apply to this session.")}`,
      "",
      ` > Compression: ${this.enabled ? "enabled" : "disabled"}`,
      "",
      ...compressionStatusLines(this.bindings.status()).map(
        (line) => ` ${theme.fg("muted", line)}`,
      ),
      ...(this.message ? [` ${theme.fg("muted", this.message)}`] : []),
      ` ${theme.fg("dim", this.busy ? "Applying…" : "Space/←/→ change · S/Enter apply · Esc back")}`,
    ];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, "escape") || data === "q") {
      this.done(undefined);
      return;
    }
    if (
      matchesKey(data, "space") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right")
    ) {
      this.enabled = !this.enabled;
      this.message = "";
      return;
    }
    if (data === "s" || matchesKey(data, "enter") || matchesKey(data, "return"))
      void this.apply();
  }

  private async apply(): Promise<void> {
    if (this.enabled === this.bindings.status().enabled) {
      this.message = "No changes to apply.";
      return;
    }
    this.busy = true;
    try {
      await this.bindings.setEnabled(this.enabled);
      this.enabled = this.bindings.status().enabled;
      this.message = "Applied to this session.";
    } catch {
      this.message =
        "Could not change context compression. Previous session state is shown.";
      this.enabled = this.bindings.status().enabled;
    } finally {
      this.busy = false;
    }
  }
}

class RoutingSessionPanel implements ConfigPanel {
  focused = false;
  private mode: ContextManagerRoutingMode;
  private busy = false;
  private message = "";

  constructor(
    private readonly theme: Theme,
    private readonly done: (result: undefined) => void,
    private readonly bindings: NonNullable<ContextManagerBindings["routing"]>,
  ) {
    this.mode = bindings.status().mode;
  }

  render(width: number): string[] {
    return this.renderContent(width);
  }

  renderContent(_width: number): string[] {
    const theme = this.theme;
    const status = this.bindings.status();
    const unavailable = routingModeUnavailableReason(this.mode, status);
    return [
      ` ${theme.fg("accent", theme.bold("Model Routing"))}`,
      ` ${theme.fg("dim", "Changes apply to this session.")}`,
      "",
      ` > Mode: ${modeLabel(this.mode)}`,
      ...(unavailable ? [` ${theme.fg("warning", unavailable)}`] : []),
      "",
      ...routingStatusLines(status).map(
        (line) => ` ${theme.fg("muted", line)}`,
      ),
      ...(this.message ? [` ${theme.fg("muted", this.message)}`] : []),
      ` ${theme.fg("dim", this.busy ? "Applying…" : "Space/←/→ change · S/Enter apply · Esc back")}`,
    ];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, "escape") || data === "q") {
      this.done(undefined);
      return;
    }
    if (
      matchesKey(data, "space") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right")
    ) {
      const direction = matchesKey(data, "left") ? -1 : 1;
      this.mode =
        modes[
          (modes.indexOf(this.mode) + direction + modes.length) % modes.length
        ];
      this.message = "";
      return;
    }
    if (data === "s" || matchesKey(data, "enter") || matchesKey(data, "return"))
      void this.apply();
  }

  private async apply(): Promise<void> {
    const status = this.bindings.status();
    const unavailable = routingModeUnavailableReason(this.mode, status);
    if (unavailable) {
      this.message = unavailable;
      return;
    }
    if (this.mode === status.mode) {
      this.message = "No changes to apply.";
      return;
    }
    this.busy = true;
    try {
      await this.bindings.setMode(this.mode);
      this.mode = this.bindings.status().mode;
      this.message = "Applied to this session.";
    } catch {
      this.message =
        "Could not change routing. Previous session state is shown.";
      this.mode = this.bindings.status().mode;
    } finally {
      this.busy = false;
    }
  }
}

export function createContextManagerDescriptors(
  bindings: ContextManagerBindings,
): ContextManagerDescriptor[] {
  const descriptors: ContextManagerDescriptor[] = [];
  if (bindings.compression) {
    const controller = bindings.compression;
    const status = controller.status();
    descriptors.push({
      id: CONTEXT_ID,
      name: "Jev Context Compression",
      description:
        "Compress repeated tool text for model context while retaining the original session history. Controls apply to this session.",
      category: "assistive",
      maturity: "experimental",
      enabled: status.enabled,
      commands: [],
      tools: [],
      events: ["context", "before_agent_start"],
      statusLines: compressionStatusLines(status),
      getConfigPanel: async () => (theme, _cwd, _scope, done) =>
        new ContextSessionPanel(theme, done, controller),
    });
  }
  if (bindings.routing) {
    const controller = bindings.routing;
    const status = controller.status();
    descriptors.push({
      id: ROUTING_ID,
      name: "Jev Model Routing",
      description:
        "Choose routing for this session, inspect the latest target and fallback, and require a qualified artifact for automatic routing.",
      category: "assistive",
      maturity: "experimental",
      enabled: status.mode !== "off",
      commands: [],
      tools: [],
      events: [],
      statusLines: routingStatusLines(status),
      getConfigPanel: async () => (theme, _cwd, _scope, done) =>
        new RoutingSessionPanel(theme, done, controller),
    });
  }
  return descriptors;
}

function createActions(
  bindings: ContextManagerBindings,
): Map<string, ManagerAction[]> {
  const actions = new Map<string, ManagerAction[]>();
  if (bindings.compression) {
    const controller = bindings.compression;
    actions.set(CONTEXT_ID, [
      {
        id: "context-toggle",
        label: "Toggle compression for this session",
        description: "Change model-context compression in the current session.",
        run: async (ctx) => {
          try {
            await controller.setEnabled(!controller.status().enabled);
          } catch {
            ctx.ui.notify(
              "Could not change context compression for this session.",
              "warning",
            );
          }
        },
      },
    ]);
  }
  if (bindings.routing) {
    const controller = bindings.routing;
    actions.set(
      ROUTING_ID,
      modes.map((mode): ManagerAction => ({
        id: `routing-${mode}`,
        label: `${modeLabel(mode)} for this session`,
        description:
          mode === "auto"
            ? "Use automatic routing only with both targets and a qualified artifact."
            : mode === "fast"
              ? "Request fast routing with a qualified artifact; classifier and safety checks may select strong."
              : "Change the routing mode in the current session.",
        run: async (ctx: ExtensionCommandContext) => {
          const unavailable = routingModeUnavailableReason(
            mode,
            controller.status(),
          );
          if (unavailable) {
            ctx.ui.notify(unavailable, "warning");
            return;
          }
          try {
            await controller.setMode(mode);
          } catch {
            ctx.ui.notify(
              "Could not change routing for this session.",
              "warning",
            );
          }
        },
      })),
    );
  }
  return actions;
}

/** Register session controls without a misleading global/project toggle callback. */
export function registerContextManager(
  pi: Pick<ExtensionAPI, "events">,
  bindings: ContextManagerBindings,
): ManagerAction[] {
  const actions = createActions(bindings);
  if (!pi.events) return [...actions.values()].flat();
  pi.events.on("sf-pi-manager:actions", (payload) => {
    const request = payload as {
      extensionId?: string;
      actions?: ManagerAction[];
    };
    if (
      request &&
      Array.isArray(request.actions) &&
      typeof request.extensionId === "string"
    )
      request.actions.push(...(actions.get(request.extensionId) ?? []));
  });
  pi.events.on(MANAGER_DISCOVERY_EVENT, (payload) => {
    const request = payload as {
      version?: number;
      scope?: string;
      extensions?: ContextManagerDescriptor[];
    };
    if (
      !request ||
      request.version !== 1 ||
      !Array.isArray(request.extensions) ||
      !["global", "project"].includes(request.scope ?? "")
    )
      return;
    request.extensions.push(...createContextManagerDescriptors(bindings));
  });
  return [...actions.values()].flat();
}

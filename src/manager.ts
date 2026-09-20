import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Preferences, SettingsScope } from "./preferences.js";
import { matchesKey } from "@earendil-works/pi-tui";

export const MANAGER_DISCOVERY_EVENT = "sf-pi-manager:external-extensions";

export interface ManagerAction {
  id: string;
  label: string;
  description: string;
  group?: string;
  acceptsScope?: boolean;
  run(ctx: ExtensionCommandContext, scope: SettingsScope): Promise<void> | void;
}

export interface ConfigPanel {
  focused: boolean;
  render(width: number): string[];
  renderContent(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}
export type ConfigPanelFactory = (
  theme: Theme,
  cwd: string,
  scope: SettingsScope,
  done: (result: { needsReload?: boolean } | undefined) => void,
  tui?: unknown,
  ctx?: ExtensionCommandContext,
) => ConfigPanel;

export interface ExternalDescriptor {
  id: string;
  name: string;
  description: string;
  category: "assistive";
  maturity: "experimental";
  enabled: boolean;
  commands: string[];
  tools: string[];
  events: string[];
  statusLines: string[];
  getConfigPanel(): Promise<ConfigPanelFactory>;
  setEnabled(
    enabled: boolean,
    ctx: ExtensionCommandContext,
    scope: SettingsScope,
  ): Promise<void>;
}

export interface ManagerBindings {
  preferences(): Preferences;
  scopePreferences(scope: SettingsScope): Preferences;
  status(): Record<string, unknown>;
  apply(
    cwd: string,
    scope: SettingsScope,
    patch: Partial<Preferences>,
  ): Promise<void>;
  action(
    action:
      "status" | "doctor" | "warmup" | "routing-report" | "evaluation-report",
    ctx: ExtensionCommandContext,
  ): Promise<void>;
}

class JevConfigPanel implements ConfigPanel {
  focused = false;
  private selected = 0;
  private values: Preferences;
  private saved: Preferences;
  private busy = false;
  private message = "";
  private readonly rows: Array<{ key: keyof Preferences; label: string }> = [
    { key: "enabled", label: "Classifier enabled" },
    { key: "routing", label: "Advisory routing" },
    { key: "evaluation", label: "Automatic advisory evaluation" },
    { key: "templateVersion", label: "Prompt template" },
  ];
  constructor(
    private readonly theme: Theme,
    private readonly cwd: string,
    private readonly scope: SettingsScope,
    private readonly done: (
      result: { needsReload?: boolean } | undefined,
    ) => void,
    private readonly bindings: ManagerBindings,
  ) {
    this.values = { ...bindings.scopePreferences(scope) };
    this.saved = { ...this.values };
  }
  render(width: number): string[] {
    return this.renderContent(width);
  }
  renderContent(_width: number): string[] {
    const t = this.theme;
    return [
      ` ${t.fg("accent", t.bold("Jev Settings"))}`,
      ` ${t.fg("dim", "Local Gemma classification; routing and evaluation supply advice.")}`,
      "",
      ` ${t.fg("muted", "Scope:")} ${this.scope}`,
      ` ${t.fg("dim", "Project values override global values. Saving never starts a model.")}`,
      "",
      ...this.rows.map((row, index) => {
        const value = this.values[row.key];
        const label =
          typeof value === "boolean" ? (value ? "on" : "off") : value;
        const dirty = value !== this.saved[row.key] ? " *" : "";
        return ` ${index === this.selected ? ">" : " "} ${t.fg(index === this.selected ? "accent" : "text", row.label)}: ${label}${dirty}`;
      }),
      "",
      ` ${t.fg("dim", "Tools, permissions, and Guardrail authority remain with Pi and sf-pi.")}`,
      ...(this.message ? [` ${t.fg("muted", this.message)}`] : []),
      ` ${t.fg("dim", this.busy ? "Saving…" : "↑/↓ select · Space/←/→ change · S/Enter save · Esc back")}`,
    ];
  }
  invalidate(): void {}
  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, "escape") || data === "q") {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = (this.selected + this.rows.length - 1) % this.rows.length;
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = (this.selected + 1) % this.rows.length;
      return;
    }
    if (
      matchesKey(data, "space") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right")
    ) {
      const key = this.rows[this.selected].key;
      if (key === "templateVersion")
        this.values.templateVersion =
          this.values.templateVersion === "v1" ? "v2" : "v1";
      else this.values[key] = !this.values[key];
      this.message = "";
      return;
    }
    if (data === "s" || matchesKey(data, "enter") || matchesKey(data, "return"))
      void this.save();
  }
  private async save(): Promise<void> {
    const patch: Partial<Preferences> = {};
    for (const { key } of this.rows) {
      if (this.values[key] !== this.saved[key])
        Object.assign(patch, { [key]: this.values[key] });
    }
    if (!Object.keys(patch).length) {
      this.message = "No changes to save.";
      return;
    }
    this.busy = true;
    try {
      await this.bindings.apply(this.cwd, this.scope, patch);
      this.values = { ...this.bindings.scopePreferences(this.scope) };
      this.saved = { ...this.values };
      this.message = "Saved Jev settings.";
    } catch {
      this.message =
        "Could not save Jev settings. Check the selected settings file.";
    } finally {
      this.busy = false;
    }
  }
}

export async function openJevInManager(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  if (!pi.events) return false;
  let accepted = false;
  const opened = new Promise<void>((resolve, reject) => {
    pi.events.emit("sf-pi-manager:open", {
      ctx,
      route: { extensionId: "jev", view: "detail" },
      accept: () => {
        accepted = true;
      },
      resolve,
      reject,
    });
  });
  if (!accepted) return false;
  await opened;
  return true;
}

export function registerManager(
  pi: ExtensionAPI,
  bindings: ManagerBindings,
): ManagerAction[] {
  const actions: ManagerAction[] = [
    {
      id: "status",
      label: "Status",
      description: "Show cached lifecycle, model, device, and queue status.",
      run: (ctx) => bindings.action("status", ctx),
    },
    {
      id: "doctor",
      label: "Doctor",
      description: "Inspect configured local runtime and model artifact.",
      run: (ctx) => bindings.action("doctor", ctx),
    },
    {
      id: "warmup",
      label: "Warmup",
      description: "Explicitly initialize the approved local classifier.",
      run: (ctx) => bindings.action("warmup", ctx),
    },
    {
      id: "routing-report",
      label: "Latest routing report",
      description: "Show the latest advisory route and available families.",
      run: (ctx) => bindings.action("routing-report", ctx),
    },
    {
      id: "evaluation-report",
      label: "Latest evaluation",
      description: "Show the latest settled-turn rubric estimates.",
      run: (ctx) => bindings.action("evaluation-report", ctx),
    },
    {
      id: "routing-toggle",
      label: "Toggle advisory routing",
      description: "Save opt-in routing in the selected scope.",
      acceptsScope: true,
      run: (ctx, scope) =>
        bindings.apply(ctx.cwd, scope, {
          routing: !bindings.scopePreferences(scope).routing,
        }),
    },
    {
      id: "evaluation-toggle",
      label: "Toggle automatic evaluation",
      description: "Save opt-in settled-turn evaluation in the selected scope.",
      acceptsScope: true,
      run: (ctx, scope) =>
        bindings.apply(ctx.cwd, scope, {
          evaluation: !bindings.scopePreferences(scope).evaluation,
        }),
    },
  ];
  if (!pi.events) return actions;
  pi.events.on("sf-pi-manager:actions", (payload) => {
    const request = payload as {
      extensionId?: string;
      actions?: ManagerAction[];
    };
    if (request.extensionId === "jev" && Array.isArray(request.actions))
      request.actions.push(...actions);
  });
  pi.events.on(MANAGER_DISCOVERY_EVENT, (payload) => {
    const request = payload as {
      version?: number;
      scope?: SettingsScope;
      extensions?: ExternalDescriptor[];
    };
    if (
      request.version !== 1 ||
      !Array.isArray(request.extensions) ||
      !["global", "project"].includes(request.scope ?? "")
    )
      return;
    const preferences = bindings.scopePreferences(request.scope!);
    const effective = bindings.preferences();
    const status = bindings.status();
    request.extensions.push({
      id: "jev",
      name: "Jev",
      description:
        "Independent local Gemma classifier with advisory Salesforce routing and settled-turn evaluation.",
      category: "assistive",
      maturity: "experimental",
      enabled: preferences.enabled,
      commands: ["/jev"],
      tools: ["jev_classify"],
      events: [
        "session_start",
        "session_shutdown",
        "before_agent_start",
        "agent_end",
        "agent_settled",
      ],
      statusLines: [
        `Classifier: ${preferences.enabled ? "enabled" : "disabled"}`,
        `Effective classifier: ${effective.enabled ? "enabled" : "disabled"}`,
        `Runtime: ${String(status.state ?? "cold")}`,
        `Template: ${preferences.templateVersion}`,
        `Advisory routing: ${preferences.routing ? "on" : "off"}`,
        `Automatic evaluation: ${preferences.evaluation ? "on" : "off"}`,
      ],
      getConfigPanel: async () => (theme, cwd, scope, done) =>
        new JevConfigPanel(theme, cwd, scope, done, bindings),
      setEnabled: (enabled, ctx, scope) =>
        bindings.apply(ctx.cwd, scope, { enabled }),
    });
  });
  return actions;
}

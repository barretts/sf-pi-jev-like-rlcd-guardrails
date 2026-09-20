import { expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  createContextManagerDescriptors,
  registerContextManager,
  routingModeUnavailableReason,
  type ContextCompressionManagerStatus,
  type ContextManagerBindings,
  type ContextManagerDescriptor,
  type RoutingManagerStatus,
} from "../src/context-manager.js";
import { MANAGER_DISCOVERY_EVENT, type ManagerAction } from "../src/manager.js";

const theme: any = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

function harness() {
  const compressionStatus: ContextCompressionManagerStatus = {
    enabled: false,
    contextCalls: 7,
    compressedBlocks: 4,
    originalBytes: 9_000,
    compressedBytes: 3_000,
    bytesSaved: 6_000,
    fallbackCount: 2,
    lastFallback: "invalid_text",
    lastContext: {
      compressedBlocks: 1,
      originalBytes: 2_000,
      compressedBytes: 800,
      bytesSaved: 1_200,
      instructionBytes: 200,
    },
  };
  const routingStatus: RoutingManagerStatus = {
    mode: "off",
    selectedTarget: "llmgw/grok-4.6",
    qualified: false,
    qualificationReason: "artifact_not_qualified",
    fastAvailable: true,
    strongAvailable: true,
    requests: 8,
    fallbacks: 3,
    cancelled: 1,
    lastFallback: "missing_context",
  };
  const compression = {
    status: vi.fn(() => ({ ...compressionStatus })),
    setEnabled: vi.fn(async (enabled: boolean) => {
      compressionStatus.enabled = enabled;
    }),
  };
  const routing = {
    status: vi.fn(() => ({ ...routingStatus })),
    setMode: vi.fn(async (mode: RoutingManagerStatus["mode"]) => {
      routingStatus.mode = mode;
    }),
  };
  const bindings: ContextManagerBindings = { compression, routing };
  const pi = { events: createEventBus() };
  const ctx: any = { cwd: "/unused", ui: { notify: vi.fn() } };
  const actions = registerContextManager(pi, bindings);
  const discover = (scope = "project", version = 1) => {
    const request = {
      version,
      scope,
      extensions: [] as ContextManagerDescriptor[],
    };
    pi.events.emit(MANAGER_DISCOVERY_EVENT, request);
    return request.extensions;
  };
  return {
    bindings,
    compression,
    routing,
    compressionStatus,
    routingStatus,
    pi,
    ctx,
    actions,
    discover,
  };
}

it("discovers cached session controls with no generic persistence toggle", () => {
  const h = harness();
  const project = h.discover();
  const global = h.discover("global");
  expect(project.map((descriptor) => descriptor.id)).toEqual([
    "jev-context",
    "jev-routing",
  ]);
  expect(
    global.map(({ getConfigPanel: _factory, ...descriptor }) => descriptor),
  ).toEqual(
    project.map(({ getConfigPanel: _factory, ...descriptor }) => descriptor),
  );
  expect(
    project.every((descriptor) => !Object.hasOwn(descriptor, "setEnabled")),
  ).toBe(true);
  expect(
    project.every(
      (descriptor) =>
        descriptor.commands.length === 0 && descriptor.tools.length === 0,
    ),
  ).toBe(true);
  expect(h.compression.setEnabled).not.toHaveBeenCalled();
  expect(h.routing.setMode).not.toHaveBeenCalled();
  expect(h.actions.every((action) => action.acceptsScope !== true)).toBe(true);
  expect(project[0].statusLines).toContain(
    "Latest tool context: 1 text blocks compressed; 1200 B saved.",
  );
  expect(project[0].statusLines).toContain(
    "Context calls: 7; cumulative tool context reduction: 6000 B.",
  );
  expect(project[0].statusLines).toContain(
    "Original tool text stays in the session history.",
  );
  expect(project[0].statusLines).toContain(
    "Model context reduction including format instructions: 1000 B.",
  );
  expect(project[1].statusLines).toContain(
    "Automatic routing artifact: unavailable or unqualified.",
  );
  expect(project[1].statusLines).toContain(
    "Latest selected target: llmgw/grok-4.6.",
  );
});

it("filters discovery versions and scopes and routes actions to their own page", () => {
  const h = harness();
  expect(h.discover("project", 2)).toEqual([]);
  expect(h.discover("session")).toEqual([]);
  h.pi.events.emit(MANAGER_DISCOVERY_EVENT, null);
  h.pi.events.emit("sf-pi-manager:actions", undefined);
  for (const [extensionId, count] of [
    ["jev", 0],
    ["jev-context", 1],
    ["jev-routing", 5],
  ] as const) {
    const request = { extensionId, actions: [] as ManagerAction[] };
    h.pi.events.emit("sf-pi-manager:actions", request);
    expect(request.actions).toHaveLength(count);
  }
});

it("provides standalone action factories when the Manager event bus is absent", () => {
  const h = harness();
  expect(
    registerContextManager({ events: undefined } as any, h.bindings),
  ).toHaveLength(6);
  expect(createContextManagerDescriptors({})).toEqual([]);
  expect(
    createContextManagerDescriptors({ compression: h.compression }),
  ).toHaveLength(1);
});

it("reports added instruction overhead and nested dispatcher counters accurately", () => {
  const h = harness();
  h.compressionStatus.lastContext!.instructionBytes = 1500;
  h.routingStatus.totals = { requests: 12, fallbacks: 4, cancelled: 2 };
  const descriptors = h.discover();
  expect(descriptors[0].statusLines).toContain(
    "Model context increase including format instructions: 300 B.",
  );
  expect(descriptors[1].statusLines).toContain(
    "Requests: 12; fallbacks: 4; cancelled: 2.",
  );
});

it("renders session scope and applies compression without invoking routing", async () => {
  const h = harness();
  const descriptor = h.discover()[0];
  const factory = await descriptor.getConfigPanel();
  const done = vi.fn();
  const panel = factory(theme, "/unused", "global", done);
  expect(panel.render(80).join("\n")).toContain(
    "Changes apply to this session.",
  );
  panel.handleInput(" ");
  expect(panel.renderContent(80).join("\n")).toContain(
    "> Compression: enabled",
  );
  expect(h.compression.setEnabled).not.toHaveBeenCalled();
  panel.handleInput("s");
  await vi.waitFor(() => expect(h.compressionStatus.enabled).toBe(true));
  expect(h.routing.setMode).not.toHaveBeenCalled();
  expect(panel.render(80).join("\n")).toContain("Applied to this session.");
  panel.handleInput("q");
  expect(done).toHaveBeenCalledWith(undefined);
});

it("blocks unqualified automatic routing in both the panel and action", async () => {
  const h = harness();
  const factory = await h.discover()[1].getConfigPanel();
  const panel = factory(theme, "/unused", "project", vi.fn());
  panel.handleInput(" ");
  panel.handleInput(" ");
  expect(panel.render(80).join("\n")).toContain("> Mode: Automatic");
  panel.handleInput("s");
  await Promise.resolve();
  expect(h.routing.setMode).not.toHaveBeenCalled();
  expect(panel.render(80).join("\n")).toContain(
    "Automatic routing is unavailable until a qualified routing artifact is loaded.",
  );
  await h.actions
    .find((action) => action.id === "routing-auto")!
    .run(h.ctx, "project");
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(
    "Automatic routing is unavailable until a qualified routing artifact is loaded.",
    "warning",
  );
  expect(h.routing.setMode).not.toHaveBeenCalled();
});

it("rechecks qualification when applying a panel opened before target changes", async () => {
  const h = harness();
  h.routingStatus.qualified = true;
  const factory = await h.discover()[1].getConfigPanel();
  const panel = factory(theme, "/unused", "project", vi.fn());
  panel.handleInput(" ");
  panel.handleInput(" ");
  h.routingStatus.fastAvailable = false;
  panel.handleInput("s");
  expect(h.routing.setMode).not.toHaveBeenCalled();
  expect(panel.render(80).join("\n")).toContain(
    "Automatic routing requires both targets.",
  );
  h.routingStatus.fastAvailable = true;
  panel.handleInput("s");
  await vi.waitFor(() => expect(h.routingStatus.mode).toBe("auto"));
  expect(h.routing.setMode).toHaveBeenCalledExactlyOnceWith("auto");
});

it("supports qualified fast preference and strong or Off without a qualified artifact", async () => {
  const h = harness();
  h.routingStatus.qualified = true;
  await h.actions
    .find((action) => action.id === "routing-fast")!
    .run(h.ctx, "global");
  expect(h.routingStatus.mode).toBe("fast");
  h.routingStatus.qualified = false;
  await h.actions
    .find((action) => action.id === "routing-strong")!
    .run(h.ctx, "project");
  expect(h.routingStatus.mode).toBe("strong");
  h.routingStatus.fastAvailable = false;
  h.routingStatus.strongAvailable = false;
  await h.actions
    .find((action) => action.id === "routing-off")!
    .run(h.ctx, "project");
  expect(h.routingStatus.mode).toBe("off");
  await h.actions
    .find((action) => action.id === "routing-fast")!
    .run(h.ctx, "project");
  await h.actions
    .find((action) => action.id === "routing-shadow")!
    .run(h.ctx, "project");
  expect(h.routing.setMode).toHaveBeenCalledTimes(3);
  expect(h.ctx.ui.notify).toHaveBeenCalledTimes(2);
});

it("blocks unqualified fast preference in the Manager panel and action", async () => {
  const h = harness();
  const factory = await h.discover()[1].getConfigPanel();
  const panel = factory(theme, "/unused", "project", vi.fn());
  panel.handleInput(" ");
  panel.handleInput(" ");
  panel.handleInput(" ");
  expect(panel.render(80).join("\n")).toContain(
    "> Mode: Request fast when eligible",
  );
  panel.handleInput("s");
  expect(h.routing.setMode).not.toHaveBeenCalled();
  expect(panel.render(80).join("\n")).toContain(
    "Fast routing is unavailable until a qualified routing artifact is loaded",
  );
  await h.actions
    .find((action) => action.id === "routing-fast")!
    .run(h.ctx, "project");
  expect(h.routing.setMode).not.toHaveBeenCalled();
  expect(h.routingStatus.mode).toBe("off");
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(
    "Fast routing is unavailable until a qualified routing artifact is loaded; eligible requests still require classifier and safety checks.",
    "warning",
  );
});

it("checks every automatic routing requirement independently", () => {
  const h = harness();
  expect(routingModeUnavailableReason("auto", h.routingStatus)).toContain(
    "qualified routing artifact",
  );
  expect(
    routingModeUnavailableReason("auto", {
      ...h.routingStatus,
      qualified: true,
      fastAvailable: false,
    }),
  ).toContain("both targets");
  expect(
    routingModeUnavailableReason("auto", {
      ...h.routingStatus,
      qualified: true,
      strongAvailable: false,
    }),
  ).toContain("strong target is unavailable");
  expect(
    routingModeUnavailableReason("auto", {
      ...h.routingStatus,
      qualified: true,
    }),
  ).toBeUndefined();
});

it("does not reflect private error messages or fallback details into UI status", async () => {
  const h = harness();
  h.routingStatus.qualificationReason = "private qualification detail";
  h.routingStatus.lastFallback = "private fallback detail";
  h.compressionStatus.lastFallback = "private codec detail";
  h.routingStatus.selectedTarget = "llmgw/\u001b[31mgrok-4.6\n";
  h.compressionStatus.bytesSaved = NaN;
  const descriptors = h.discover();
  const rows = descriptors
    .flatMap((descriptor) => descriptor.statusLines)
    .join("\n");
  expect(rows).not.toContain("private");
  expect(rows).not.toContain("\u001b");
  expect(rows).not.toContain("NaN");
  expect(rows).toContain("cumulative tool context reduction: unknown B");
  expect(rows).toContain("Latest selected target: llmgw/grok-4.6.");
  expect(
    descriptors.every(
      (descriptor) =>
        descriptor.statusLines.length <= 16 &&
        descriptor.statusLines.every(
          (line) => line.length <= 512 && !/[\x00-\x1f\x7f]/.test(line),
        ),
    ),
  ).toBe(true);
  h.compression.setEnabled.mockRejectedValueOnce(
    new Error("private credential error"),
  );
  const factory = await descriptors[0].getConfigPanel();
  const panel = factory(theme, "/unused", "project", vi.fn());
  panel.handleInput(" ");
  panel.handleInput("s");
  await vi.waitFor(() =>
    expect(panel.render(80).join("\n")).toContain(
      "Could not change context compression",
    ),
  );
  expect(panel.render(80).join("\n")).not.toContain("private credential error");
  expect(h.compressionStatus.enabled).toBe(false);
});

it("contains controller failures from Manager actions without exposing private errors", async () => {
  const h = harness();
  h.compression.setEnabled.mockRejectedValueOnce(
    new Error("private context credential"),
  );
  h.routing.setMode.mockRejectedValueOnce(
    new Error("private routing credential"),
  );
  await h.actions
    .find((action) => action.id === "context-toggle")!
    .run(h.ctx, "project");
  await h.actions
    .find((action) => action.id === "routing-strong")!
    .run(h.ctx, "global");
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(
    "Could not change context compression for this session.",
    "warning",
  );
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(
    "Could not change routing for this session.",
    "warning",
  );
  expect(JSON.stringify(h.ctx.ui.notify.mock.calls)).not.toContain("private");
  expect(h.compressionStatus.enabled).toBe(false);
  expect(h.routingStatus.mode).toBe("off");
});

it("ignores repeated apply keys while one controller change is pending", async () => {
  const h = harness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.compression.setEnabled.mockImplementationOnce(async (enabled) => {
    await pending;
    h.compressionStatus.enabled = enabled;
  });
  const factory = await h.discover()[0].getConfigPanel();
  const panel = factory(theme, "/unused", "project", vi.fn());
  panel.handleInput(" ");
  panel.handleInput("s");
  panel.handleInput("s");
  panel.handleInput(" ");
  expect(h.compression.setEnabled).toHaveBeenCalledTimes(1);
  expect(panel.render(80).join("\n")).toContain("Applying…");
  release();
  await vi.waitFor(() =>
    expect(panel.render(80).join("\n")).toContain("Applied to this session."),
  );
});

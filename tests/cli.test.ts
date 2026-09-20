import { expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliHelp, runCli } from "../src/cli.js";

it("exposes local workflows without loading a model for help", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runCli(["--help"], {});
    expect(log).toHaveBeenCalledWith(cliHelp);
    for (const command of [
      "jev eval",
      "jev bench",
      "jev agent start",
      "jev rfdt prepare",
      "jev rfdt train",
      "jev rfdt approve",
      "jev demo",
    ])
      expect(cliHelp).toContain(command);
  } finally {
    log.mockRestore();
  }
});
it("rejects ambiguous CLI commands before loading inference", async () => {
  await expect(runCli(["unknown"], {})).rejects.toThrow("Unknown command");
  await expect(runCli(["warmup", "extra"], {})).rejects.toThrow(
    "Unexpected positional",
  );
  await expect(runCli(["eval", "--split", "unknown"], {})).rejects.toThrow(
    "--split",
  );
});

it.each([
  ["cli", /Jev local classifier and training workflow/],
  ["server", /jev-server --model-file/],
] as const)(
  "runs %s help through an npm-style bin symlink",
  async (name, help) => {
    const directory = await mkdtemp(join(tmpdir(), "jev-bin-"));
    const bin = join(directory, name);
    const argv = process.argv;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await symlink(
        fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)),
        bin,
      );
      process.argv = [process.execPath, bin, "--help"];
      vi.resetModules();
      if (name === "cli") await import("../src/cli.js");
      else await import("../src/server.js");
      expect(log).toHaveBeenCalledWith(expect.stringMatching(help));
    } finally {
      process.argv = argv;
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  [{ summary: { gates: { passed: false } } }, 1],
  [{ summary: { gates: { passed: true } } }, undefined],
  [{ summary: { gates: {} } }, 1],
  [{ summary: null }, 1],
] as const)(
  "reports RFDT evaluation and accepts only explicit passing quality gates (%j)",
  async (value, expectedExitCode) => {
    const rfdt = await import("../src/rfdt.js");
    const report = value as Awaited<ReturnType<typeof rfdt.evaluateRfdt>>;
    const evaluate = vi.spyOn(rfdt, "evaluateRfdt").mockResolvedValue(report);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runCli(["rfdt", "evaluate", "--run", "local-run"], {});
      expect(evaluate).toHaveBeenCalledWith(
        "local-run",
        expect.objectContaining({ split: "validation" }),
      );
      expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual(report);
      expect(process.exitCode).toBe(expectedExitCode);
    } finally {
      process.exitCode = exitCode;
      evaluate.mockRestore();
      log.mockRestore();
    }
  },
);

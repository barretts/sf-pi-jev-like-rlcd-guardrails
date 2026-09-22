import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const owned: string[] = [];

afterEach(async () => {
  await Promise.all(
    owned
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("guardrail RFDT preparation", () => {
  it.each([
    { trainingReady: false, status: "review-only; TRAIN coverage gaps remain" },
    { trainingReady: true, status: "diagnostic; no qualification baseline" },
    {
      diagnosticOnly: true,
      status: "TRAIN/VALIDATION only; qualification pending",
    },
  ])("refuses a non-ready bundle before creating a run: %j", async (state) => {
    const directory = await mkdtemp(
      join(tmpdir(), "jev-guardrail-train-readiness-"),
    );
    owned.push(directory);
    const bundle = join(directory, "bundle.json");
    const run = join(directory, "run");
    await writeFile(
      bundle,
      JSON.stringify({
        ...state,
        records: [
          {
            id: "train",
            split: "train",
            modelEligible: true,
            expected: "allow",
          },
          {
            id: "valid",
            split: "validation",
            modelEligible: true,
            expected: "confirm",
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/guardrail-train.mjs"),
        "prepare",
        "--bundle",
        bundle,
        "--checkpoint",
        join(directory, "nonexistent-checkpoint"),
        "--run",
        run,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Guardrail bundle is diagnostic or review-only; training is not ready",
    );
    expect(existsSync(run)).toBe(false);
  });
});

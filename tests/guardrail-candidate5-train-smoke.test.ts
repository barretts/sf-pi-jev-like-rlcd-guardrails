import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("candidate-5 TRAIN-only systems smoke", () => {
  it("cannot write into the official candidate-5 run", () => {
    const output = resolve(".build/guardrail/candidate-5/research-input.jsonl");
    const receipt = resolve(
      ".build/guardrail/candidate-5/research-receipt.json",
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/guardrail-candidate5-train-smoke.mjs"),
        "--sf-pi",
        process.cwd(),
        "--sf-deps",
        process.cwd(),
        "--checkpoint",
        process.cwd(),
        "--output",
        output,
        "--receipt",
        receipt,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside the official candidate-5 run");
    expect(existsSync(output)).toBe(false);
    expect(existsSync(receipt)).toBe(false);
  });
});

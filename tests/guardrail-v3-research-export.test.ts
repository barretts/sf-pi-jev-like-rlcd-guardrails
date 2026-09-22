import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { selectResearchCases } from "../scripts/guardrail-v3-research-export.mjs";

const syntheticCorpus = () => ({
  version: 1,
  rubricVersion: "operation-policy-v2",
  cases: [
    ...Array.from({ length: 312 }, (_, index) => ({
      id: `train-${index}`,
      groupId: `train-group-${index}`,
      split: "train",
      expected: "allow",
      toolName: "bash",
      input: { command: "pwd" },
    })),
    ...Array.from({ length: 192 }, (_, index) => ({
      id: `validation-${index}`,
      groupId: `validation-group-${index}`,
      split: "validation",
      expected: "confirm",
      toolName: "bash",
      input: { command: "pwd" },
    })),
    {
      id: "reserved-sentinel",
      groupId: "reserved-group",
      split: "test",
      expected: "block",
      toolName: "bash",
      input: { command: "RESERVED_SENTINEL_MUST_NOT_APPEAR" },
    },
  ],
});

describe("v3 TRAIN/VALID research export", () => {
  it("selects only TRAIN and validation before touching reserved fields", () => {
    const corpus = syntheticCorpus();
    for (const field of ["expected", "input"] as const)
      Object.defineProperty(corpus.cases[504], field, {
        get: () => {
          throw new Error(`Held-out ${field} was read`);
        },
      });
    const { selected, groups } = selectResearchCases(corpus);
    expect(selected).toHaveLength(504);
    expect(groups.size).toBe(504);
    expect(selected.every((row) => row.split !== "test")).toBe(true);
    expect(JSON.stringify(selected)).not.toContain(
      "RESERVED_SENTINEL_MUST_NOT_APPEAR",
    );
  });

  it("rejects a group reused across TRAIN and validation", () => {
    const corpus = syntheticCorpus();
    corpus.cases[312].groupId = corpus.cases[0].groupId;
    expect(() => selectResearchCases(corpus)).toThrow(
      "Operation group crosses TRAIN/VALID",
    );
  });

  it("cannot write into the official candidate-5 run", () => {
    const bundle = resolve(".build/guardrail/candidate-5/research-bundle.json");
    const rfdt = resolve(".build/guardrail/candidate-5/research.jsonl");
    const receipt = resolve(
      ".build/guardrail/candidate-5/research-receipt.json",
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/guardrail-v3-research-export.mjs"),
        "--corpus",
        "missing-corpus.json",
        "--sf-pi",
        process.cwd(),
        "--sf-deps",
        process.cwd(),
        "--bundle",
        bundle,
        "--rfdt",
        rfdt,
        "--receipt",
        receipt,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside the official candidate-5 run");
    expect(existsSync(bundle)).toBe(false);
    expect(existsSync(rfdt)).toBe(false);
    expect(existsSync(receipt)).toBe(false);
  });
});

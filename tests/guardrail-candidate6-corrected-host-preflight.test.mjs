import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { guardrailRequest } from "../dist/guardrail.js";
import {
  assertProjectedInput,
  declaredOrgFixture,
  verifyCorrectedSource,
} from "../scripts/guardrail-candidate6-corrected-host-preflight.mjs";

const root = resolve(import.meta.dirname, "..");
const corrected = resolve(
  root,
  ".build/guardrail/candidate-6-dev-corrections-20260922",
);
const c5 = resolve(
  root,
  ".build/guardrail/candidate-5-research-split-e456e1c9-20260922",
);
const sha = (value) => createHash("sha256").update(value).digest("hex");

function row(
  command = "sf data query --query 'SELECT Id FROM Account LIMIT 1' -o DevOrg",
) {
  const state = {
    version: 2,
    toolName: "bash",
    input: { command },
    facts: { orgs: [{ type: "sandbox", guessed: false, command }] },
  };
  return {
    id: "train-source-fixture-v1",
    group_id: "train-source-fixture",
    split: "train",
    request: guardrailRequest(state, "google/gemma-3-1b-it"),
    targets: { risk: { answer: "allow" } },
  };
}

test("declared mock org rejects altered type and command facts", () => {
  const original = row();
  assert.deepEqual(declaredOrgFixture(original), {
    alias: "DevOrg",
    type: "sandbox",
  });
  const changedType = structuredClone(original);
  changedType.request.state.facts.orgs[0].type = "production";
  assert.throws(
    () => declaredOrgFixture(changedType),
    /disagrees with declared fixture/,
  );
  const changedCommand = structuredClone(original);
  changedCommand.request.state.facts.orgs[0].command =
    "sf data query -o ProdOrg";
  assert.throws(
    () => declaredOrgFixture(changedCommand),
    /disagrees with declared fixture/,
  );
});

test("projected host input requires the full request, command, and org fact", () => {
  const original = row();
  assert.doesNotThrow(() =>
    assertProjectedInput(original, structuredClone(original.request.state)),
  );
  const changedRequest = structuredClone(original);
  changedRequest.request.state.input.command =
    "sf data delete record -o DevOrg";
  assert.throws(
    () => assertProjectedInput(changedRequest, original.request.state),
    /projected input differs/,
  );
  const changedFact = structuredClone(original);
  changedFact.request.state.facts.orgs[0].type = "production";
  assert.throws(
    () => assertProjectedInput(changedFact, original.request.state),
    /projected input differs/,
  );
  const rewrittenRequest = structuredClone(original);
  rewrittenRequest.request.questions[0].instructions =
    "Different scoring prompt";
  assert.throws(
    () => assertProjectedInput(rewrittenRequest, original.request.state),
    /projected input differs/,
  );
});

test("missing correction receipt is rejected before replay", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "c6-missing-receipt-"));
  try {
    const datasetPath = resolve(dir, "train-validation.jsonl");
    const mergeReceiptPath = resolve(dir, "merge.json");
    await writeFile(datasetPath, "", "utf8");
    await writeFile(mergeReceiptPath, "{}", "utf8");
    await assert.rejects(
      verifyCorrectedSource({
        datasetPath,
        receiptPath: resolve(dir, "missing.json"),
        mergeReceiptPath,
      }),
      /ENOENT/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrected command or fact with coherently rehashed receipt remains rejected", async (context) => {
  let data;
  let receipt;
  try {
    [data, receipt] = await Promise.all([
      readFile(resolve(corrected, "merged-train-validation.jsonl")),
      readFile(resolve(corrected, "receipt.json")),
    ]);
  } catch (error) {
    if (error.code === "ENOENT") {
      context.skip("pinned private TRAIN/VALID research pool is absent");
      return;
    }
    throw error;
  }
  const dir = await mkdtemp(resolve(tmpdir(), "c6-tamper-source-"));
  try {
    const datasetPath = resolve(dir, "changed.jsonl");
    const receiptPath = resolve(dir, "changed-receipt.json");
    const mergeReceiptPath = resolve(c5, "merge-receipt.json");
    const lines = data.toString("utf8").trimEnd().split("\n");
    for (const kind of ["command", "fact"]) {
      const first = JSON.parse(lines[0]);
      if (kind === "command") first.request.state.input.command = "rm -rf src/";
      else {
        const orgRowIndex = lines.findIndex(
          (line) => JSON.parse(line).request.state.facts.orgs?.length,
        );
        assert.ok(orgRowIndex >= 0);
        const changed = JSON.parse(lines[orgRowIndex]);
        changed.request.state.facts.orgs[0].type =
          changed.request.state.facts.orgs[0].type === "production"
            ? "sandbox"
            : "production";
        const altered = [...lines];
        altered[orgRowIndex] = JSON.stringify(changed);
        const bytes = Buffer.from(`${altered.join("\n")}\n`);
        const claim = JSON.parse(receipt);
        claim.output.file = datasetPath;
        claim.output.sha256 = sha(bytes);
        await writeFile(datasetPath, bytes);
        await writeFile(receiptPath, `${JSON.stringify(claim)}\n`);
        await assert.rejects(
          verifyCorrectedSource({ datasetPath, receiptPath, mergeReceiptPath }),
          /pinned C5\/C6 identity/,
        );
        continue;
      }
      const altered = [...lines];
      altered[0] = JSON.stringify(first);
      const bytes = Buffer.from(`${altered.join("\n")}\n`);
      const claim = JSON.parse(receipt);
      claim.output.file = datasetPath;
      claim.output.sha256 = sha(bytes);
      await writeFile(datasetPath, bytes);
      await writeFile(receiptPath, `${JSON.stringify(claim)}\n`);
      await assert.rejects(
        verifyCorrectedSource({ datasetPath, receiptPath, mergeReceiptPath }),
        /pinned C5\/C6 identity/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

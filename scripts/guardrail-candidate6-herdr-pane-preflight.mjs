#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultPreconditions = fileURLToPath(
  new URL(
    "../fixtures/guardrail/candidate6/herdr-pane-preconditions.json",
    import.meta.url,
  ),
);

/** Check only source shape and a deterministic mocked pane lifecycle; never run a command. */
export function preflightHerdrPaneRows(rows, preconditions) {
  assert.equal(preconditions.version, 1);
  assert.equal(preconditions.scope, "mocked_train_request_precondition_only");
  assert.equal(preconditions.panes?.length, 4);

  const livePanes = new Set();
  for (const pane of preconditions.panes) {
    assert.equal(pane.source, "herdr_layout.pane_split");
    assert.equal(pane.state, "shell-ready");
    assert.equal(typeof pane.paneId, "string");
    assert.ok(pane.paneId.length > 0);
    assert.ok(
      !livePanes.has(pane.paneId),
      `duplicate mock pane: ${pane.paneId}`,
    );
    // Stubbed layout result is the only authority for the opaque pane ID.
    const splitResult = { details: { pane: { pane_id: pane.paneId } } };
    livePanes.add(splitResult.details.pane.pane_id);
  }

  const herdrRows = rows.filter(
    (row) => row.request?.state?.toolName === "herdr_pane",
  );
  assert.equal(
    herdrRows.length,
    27,
    "C6 TRAIN Herdr inventory changed; review preconditions",
  );
  const groups = new Set();
  const usedPanes = new Set();
  for (const row of herdrRows) {
    assert.equal(row.split, "train");
    const input = row.request.state.input;
    assert.equal(input?.action, "run", `${row.id}: expected pane.run`);
    assert.ok(
      typeof input?.command === "string" && input.command.trim(),
      `${row.id}: missing command`,
    );
    assert.ok(
      livePanes.has(input.pane),
      `${row.id}: no prior mock pane_split returned ${input.pane}`,
    );
    assert.ok(
      typeof row.group_id === "string" && row.group_id,
      `${row.id}: missing group`,
    );
    groups.add(row.group_id);
    usedPanes.add(input.pane);
  }
  assert.equal(
    groups.size,
    19,
    "C6 TRAIN Herdr group inventory changed; review preconditions",
  );
  assert.deepEqual(
    usedPanes,
    livePanes,
    "each declared mock pane must be used",
  );
  return {
    version: 1,
    scope: preconditions.scope,
    herdrRows: herdrRows.length,
    groups: groups.size,
    panes: [...usedPanes].sort(),
    commandsExecuted: 0,
    liveVendorPaneProven: false,
  };
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const trainPath = process.argv[2];
  if (!trainPath) {
    process.stderr.write(
      "usage: node scripts/guardrail-candidate6-herdr-pane-preflight.mjs TRAIN_JSONL\n",
    );
    process.exitCode = 2;
  } else {
    const datasetPath = resolve(trainPath);
    const rows = readJsonl(datasetPath);
    const preconditions = JSON.parse(
      readFileSync(defaultPreconditions, "utf8"),
    );
    const sha256 = (path) =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    process.stdout.write(
      `${JSON.stringify(
        {
          ...preflightHerdrPaneRows(rows, preconditions),
          source: {
            trainDatasetSha256: sha256(datasetPath),
            preconditionsSha256: sha256(defaultPreconditions),
            preflightScriptSha256: sha256(fileURLToPath(import.meta.url)),
          },
        },
        null,
        2,
      )}\n`,
    );
  }
}

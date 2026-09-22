import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { preflightHerdrPaneRows } from "../scripts/guardrail-candidate6-herdr-pane-preflight.mjs";

const preconditions = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../fixtures/guardrail/candidate6/herdr-pane-preconditions.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
);

const row = (id, pane, group_id = id) => ({
  id,
  group_id,
  split: "train",
  request: {
    state: {
      toolName: "herdr_pane",
      input: { action: "run", pane, command: "pwd" },
    },
  },
});

function syntheticRows() {
  const panes = preconditions.panes.map(({ paneId }) => paneId);
  return Array.from({ length: 27 }, (_, i) =>
    row(`mock-${i}`, panes[i % panes.length], `group-${i % 19}`),
  );
}

describe("C6 Herdr pane preconditions", () => {
  it("admits the four pane IDs only after a mocked split returned them", () => {
    assert.deepEqual(preflightHerdrPaneRows(syntheticRows(), preconditions), {
      version: 1,
      scope: "mocked_train_request_precondition_only",
      herdrRows: 27,
      groups: 19,
      panes: [
        "c5-pane-rest-905",
        "guardrail-c5-draft",
        "guardrail-c6-train",
        "guardrail-rehearsal",
      ],
      commandsExecuted: 0,
      liveVendorPaneProven: false,
    });
  });

  it("rejects an undeclared pane or a non-run action", () => {
    const rows = syntheticRows();
    rows[0].request.state.input.pane = "guessed-pane";
    assert.throws(
      () => preflightHerdrPaneRows(rows, preconditions),
      /no prior mock pane_split/,
    );
    rows[0].request.state.input.pane = preconditions.panes[0].paneId;
    rows[0].request.state.input.action = "send_text";
    assert.throws(
      () => preflightHerdrPaneRows(rows, preconditions),
      /expected pane.run/,
    );
  });
});

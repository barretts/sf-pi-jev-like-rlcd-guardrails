import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  C11,
  C11_SCORING_PROTOCOL_SHA256,
  C11_SELECTION_PATHS,
  readBoundedFile,
  readC11Selection,
  verifyC11Selection,
} from "../src/guardrail-selection.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function receipts() {
  return {
    selection: JSON.parse(
      await readFile(C11_SELECTION_PATHS.selectionFreeze, "utf8"),
    ),
    calibration: JSON.parse(
      await readFile(C11_SELECTION_PATHS.calibration, "utf8"),
    ),
  };
}

it("uses the pinned CAL-only authority with a new cutoff-sensitive shadow scoring identity", async () => {
  const identity = await readC11Selection();
  expect(identity.minimumAllowScore).toBe(0.955913273071778);
  expect(identity.calibrationSha256).toBe(C11.calibrationSha256);
  expect(C11_SCORING_PROTOCOL_SHA256).toBe(
    "d72f8dfa7ac3a287e2db2e9a829622da15267bb3cb153318678334a830353604",
  );
  const { calibration } = await receipts();
  expect(C11_SCORING_PROTOCOL_SHA256).not.toBe(
    calibration.source.scoringProtocolSha256,
  );
  expect(identity.calibrationSha256).not.toBe(
    calibration.source.calibrationSha256,
  );
});

it.each([
  "cutoff",
  "model",
  "base",
  "prompt",
  "native",
  "host",
  "policy",
  "qualification",
  "test-selection",
])("rejects a broken %s selection join", async (change) => {
  const { selection, calibration } = await receipts();
  if (change === "cutoff") calibration.selection.cutoff = 0.5;
  if (change === "model") calibration.source.modelSha256 = "a".repeat(64);
  if (change === "base") selection.model.baseRevision = "a".repeat(40);
  if (change === "prompt")
    selection.protocol.promptProtocolSha256 = "a".repeat(64);
  if (change === "native")
    selection.protocol.nativeBinary.sha256 = "a".repeat(64);
  if (change === "host") selection.host.baselineSha256 = "a".repeat(64);
  if (change === "policy") calibration.source.policySha256 = "a".repeat(64);
  if (change === "qualification") selection.qualified = true;
  if (change === "test-selection")
    selection.selection.previousTestResultsUsed = true;
  expect(() => verifyC11Selection(selection, calibration)).toThrow(
    "selection changed",
  );
});

it("rejects changed receipt bytes even when parsed contents are unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-c11-receipts-"));
  directories.push(directory);
  const calibration = join(directory, "cal.json");
  await writeFile(
    calibration,
    (await readFile(C11_SELECTION_PATHS.calibration)) + "\n",
  );
  await expect(
    readC11Selection({ ...C11_SELECTION_PATHS, calibration }),
  ).rejects.toThrow("receipt bytes changed");
});

it("bounds metadata reads and rejects nonregular files and cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-c11-bounds-"));
  directories.push(directory);
  const file = join(directory, "metadata.json");
  await writeFile(file, "x".repeat(33));
  await expect(readBoundedFile(file, undefined, 32)).rejects.toThrow(
    "size limit",
  );
  await expect(readBoundedFile(directory)).rejects.toThrow("regular");
  const controller = new AbortController();
  controller.abort(new Error("metadata cancelled"));
  await expect(readBoundedFile(file, controller.signal)).rejects.toThrow(
    "metadata cancelled",
  );
});

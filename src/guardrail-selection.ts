import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonical } from "./core.js";
import { GUARDRAIL_PROTOCOL_SHA256 } from "./guardrail.js";

export const C11 = Object.freeze({
  modelId: "jev/c11-step-256",
  modelSha256:
    "8930f0028412060fe5f39d590fe5906ca2ed86c5a6613473512580d62994a053",
  modelBytes: 2006573408,
  baseModel: "google/gemma-3-1b-it",
  baseRevision: "dcc83ea841ab6100d6b47a070329e1ba4cf78752",
  trainingRun: "rfdt-20260923014533-0d8e069e",
  nativeBinarySha256:
    "7fafa2a0eb864489aeca740767fd3c7a8fda46f8c61e6ce1af9a5e71d9846b96",
  promptProtocolSha256:
    "d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530",
  selectionFreezeSha256:
    "de5e57752ab41834891bb099a32f43589ae0e998ae8a465c197157b5817ed5a8",
  calibrationSha256:
    "1e09ef41a6c38aecb0d10e9bde83e8b2d2d8c14cf8836d7e8d1675d65f5462a0",
  minimumAllowScore: 0.955913273071778,
  hostCommit: "a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a",
  hostBaselineSha256:
    "0a23e057fb433fc4ee2ecd42465b377c660db5e024b6a406f6994497eba693b2",
  policySha256:
    "e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347",
});

export const C11_SCORING_IDENTITY = Object.freeze({
  version: 1,
  purpose: "candidate11_shadow_scoring",
  selectionFreezeSha256: C11.selectionFreezeSha256,
  promptProtocolSha256: C11.promptProtocolSha256,
  modelSha256: C11.modelSha256,
  nativeBinarySha256: C11.nativeBinarySha256,
  calibrationSha256: C11.calibrationSha256,
  minimumAllowScore: C11.minimumAllowScore,
  hostBaselineSha256: C11.hostBaselineSha256,
  policySha256: C11.policySha256,
});
export const C11_SCORING_PROTOCOL_SHA256 = createHash("sha256")
  .update(canonical(C11_SCORING_IDENTITY))
  .digest("hex");

export interface C11SelectionPaths {
  selectionFreeze: string;
  calibration: string;
}
export const C11_SELECTION_PATHS: C11SelectionPaths = Object.freeze({
  selectionFreeze: fileURLToPath(
    new URL("../models/current/selection-freeze.json", import.meta.url),
  ),
  calibration: fileURLToPath(
    new URL("../models/current/cal-only-accuracy.json", import.meta.url),
  ),
});

/** Nonblocking open rejects FIFOs; the extra byte detects growth after stat. */
export async function readBoundedFile(
  file: string,
  signal?: AbortSignal,
  limit = 4 * 1024 * 1024,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const details = await handle.stat();
    signal?.throwIfAborted();
    if (!details.isFile()) throw new Error("Expected a regular metadata file");
    if (details.size > limit)
      throw new Error("Metadata file exceeds size limit");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const chunk = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      signal?.throwIfAborted();
      length += chunk.bytesRead;
      if (length > limit) throw new Error("Metadata file exceeds size limit");
      if (!chunk.bytesRead) break;
    }
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Validate only saved selection metadata. No corpus or model call is made. */
export function verifyC11Selection(
  selection: any,
  calibration: any,
): typeof C11_SCORING_IDENTITY {
  if (
    GUARDRAIL_PROTOCOL_SHA256 !== C11.promptProtocolSha256 ||
    selection?.version !== 1 ||
    selection.purpose !== "candidate11_independent_test_selection" ||
    selection.qualified !== false ||
    selection.enforcementEligible !== false ||
    selection.model?.id !== C11.modelId ||
    selection.model.sha256 !== C11.modelSha256 ||
    selection.model.checkpoint !== 256 ||
    selection.model.format !== "f16" ||
    selection.model.base !== C11.baseModel ||
    selection.model.baseRevision !== C11.baseRevision ||
    selection.minimumAllowScore !== C11.minimumAllowScore ||
    selection.selection?.sourceSha256 !== C11.calibrationSha256 ||
    selection.selection.previousTestResultsUsed !== false ||
    selection.protocol?.promptProtocolSha256 !== C11.promptProtocolSha256 ||
    selection.protocol.nativeBinary?.sha256 !== C11.nativeBinarySha256 ||
    selection.host?.commit !== C11.hostCommit ||
    selection.host.baselineSha256 !== C11.hostBaselineSha256 ||
    selection.host.policySha256 !== C11.policySha256 ||
    calibration?.version !== 1 ||
    calibration.purpose !== "candidate11_cal_only_accuracy_diagnostic" ||
    calibration.diagnosticOnly !== true ||
    calibration.qualified !== false ||
    calibration.enforcementEligible !== false ||
    calibration.selection?.population !== "TRAIN-CAL only" ||
    calibration.selection.records !== 42 ||
    calibration.selection.cutoff !== C11.minimumAllowScore ||
    calibration.source?.checkpoint !== 256 ||
    calibration.source.modelSha256 !== C11.modelSha256 ||
    calibration.source.hostBaselineSha256 !== C11.hostBaselineSha256 ||
    calibration.source.policySha256 !== C11.policySha256
  )
    throw new Error("C11 model, cutoff, prompt, or host selection changed");
  return C11_SCORING_IDENTITY;
}

export async function readC11Selection(
  paths: C11SelectionPaths = C11_SELECTION_PATHS,
  signal?: AbortSignal,
): Promise<typeof C11_SCORING_IDENTITY> {
  const [selection, calibration] = await Promise.all([
    readBoundedFile(paths.selectionFreeze, signal),
    readBoundedFile(paths.calibration, signal),
  ]);
  signal?.throwIfAborted();
  const sha = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  if (
    sha(selection) !== C11.selectionFreezeSha256 ||
    sha(calibration) !== C11.calibrationSha256
  )
    throw new Error("C11 selection or cutoff receipt bytes changed");
  return verifyC11Selection(
    JSON.parse(selection.toString("utf8")),
    JSON.parse(calibration.toString("utf8")),
  );
}

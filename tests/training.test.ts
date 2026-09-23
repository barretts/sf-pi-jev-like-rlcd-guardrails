import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  rm,
  copyFile,
  readFile,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  importCudaRfdt,
  readImportedFitReference,
  prepareRfdt,
  rfdtSha256,
  TRAINING_INPUT_SHA256,
  verifyTrainingInputs,
} from "../src/rfdt.js";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "jev-current-training-"));
  temporary.push(path);
  return path;
}
describe("current immutable C11 training", () => {
  it("retains the exact admitted FIT population without validation or TEST", async () => {
    expect(await verifyTrainingInputs()).toEqual({
      rows: 327,
      groups: 133,
      pairs: 86,
      validationRows: 0,
      testRows: 0,
      qualified: false,
    });
  });
  it("rejects changed supplied targets before any training or model loading", async () => {
    const directory = await workspace();
    for (const name of Object.keys(TRAINING_INPUT_SHA256))
      await copyFile(resolve("training/data", name), join(directory, name));
    const input = join(directory, "fit.jsonl"),
      content = await readFile(input, "utf8");
    await writeFile(
      input,
      content.replace('"answer":"allow"', '"answer":"confirm"'),
    );
    await expect(verifyTrainingInputs(directory)).rejects.toThrow(
      "Immutable C11 training input changed: fit.jsonl",
    );
  });
  it("prepares exact tokenized prompts, remains unqualified, and preserves previous attempts", async () => {
    const parent = await workspace(),
      run = join(parent, "run");
    const manifest = await prepareRfdt(resolve("training/data/fit.jsonl"), {
      outputDir: run,
    });
    expect(manifest.qualified).toBe(false);
    expect(manifest.prepared.branches).toEqual({ train: 327 });
    expect(await rfdtSha256(manifest.prepared.files.train)).toBe(
      TRAINING_INPUT_SHA256["prepared-fit.jsonl"],
    );
    await expect(
      prepareRfdt(resolve("training/data/fit.jsonl"), { outputDir: run }),
    ).rejects.toThrow("Output already exists");
  });
  it("rejects an unpinned source receipt before executing the local importer", async () => {
    const parent = await workspace(),
      run = join(parent, "run");
    await prepareRfdt(resolve("training/data/fit.jsonl"), { outputDir: run });
    await expect(
      importCudaRfdt(run, {
        cudaRun: "unavailable",
        receiptSha256: "",
        modelPath: "unavailable",
        python: "must-never-run",
      }),
    ).rejects.toThrow("explicitly pinned checkpoint receipt");
  });
  it("consumes the Python importer's actual report and rejects changed reload margins", async () => {
    const parent = await workspace(),
      run = join(parent, "run");
    const manifest = await prepareRfdt(resolve("training/data/fit.jsonl"), {
      outputDir: run,
    });
    await mkdir(join(run, "adapter"));
    const producer = spawnSync(
      "python3",
      [
        "-c",
        `
import sys,json
from pathlib import Path
sys.path.insert(0, 'training')
import import_checkpoint
run=Path(sys.argv[1]); rows=[json.loads(line) for line in (run/'train.jsonl').read_text().splitlines()]
with (run/'adapter/local-fit-margins.jsonl').open('x') as f:
 for i,row in enumerate(rows): f.write(json.dumps({'source_id':row['source_id'],'margin':i/100})+'\\n')
result={'ok':True,'reload_verified':True,'qualified':False,'training_backend':'torch_cuda','cross_backend_equivalence':{'ok':True}}
print(json.dumps(import_checkpoint.write_import_report(run/'adapter',result)))
`,
        run,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(producer.status, producer.stderr).toBe(0);
    const training = JSON.parse(producer.stdout.trim());
    await writeFile(
      join(run, "manifest.json"),
      JSON.stringify({ ...manifest, status: "exported", training }),
    );
    const handoff = await readImportedFitReference(run);
    expect(handoff.reference.size).toBe(327);
    expect(handoff.reference.get(handoff.rows[0].source_id)).toBe(0);
    expect(handoff.report.local_fit_margins_sha256).toBe(
      training.local_fit_margins_sha256,
    );
    const path = join(run, "adapter", "local-fit-margins.jsonl");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace('"margin": 0.0', '"margin": 2.0'),
    );
    await expect(readImportedFitReference(run)).rejects.toThrow(
      "Local reload reference margins changed",
    );
  });
});

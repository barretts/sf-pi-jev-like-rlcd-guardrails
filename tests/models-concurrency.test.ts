import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { approveTrainedArtifact } from "../src/models.js";
import { rfdtFixture } from "./rfdt-fixture.js";

const directories: string[] = [];
async function directory() {
  const result = await mkdtemp(join(tmpdir(), "jev-registry-concurrency-"));
  directories.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function acceptedFixture(id: string) {
  const fixture = await rfdtFixture(await directory());
  fixture.artifact.id = id;
  fixture.run.exports!.id = id;
  for (const split of ["validation", "test"] as const) {
    const report = fixture.reports[split]!;
    report.rfdt.artifact_id = id;
    for (const result of report.results) {
      result.model = id;
      result.metadata!.artifact!.id = id;
    }
    await fixture.writeReport(split);
  }
  return fixture;
}

it("preserves every successful distinct approval or rejects contention before modifying the registry", async () => {
  const [first, second] = await Promise.all([
    acceptedFixture("jev/concurrent-first"),
    acceptedFixture("jev/concurrent-second"),
  ]);
  const registryPath = join(await directory(), "artifacts.json");
  const fixtures = [first, second];
  const results = await Promise.allSettled(
    fixtures.map(({ artifact }) =>
      approveTrainedArtifact(artifact, { registryPath }),
    ),
  );
  const successfulIds = results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [fixtures[index].artifact.id];
    expect(result.reason).toMatchObject({ code: "ERR_ARTIFACT_REGISTRY_BUSY" });
    return [];
  });
  expect(successfulIds.length).toBeGreaterThan(0);
  const registered = JSON.parse(await readFile(registryPath, "utf8"));
  expect(
    registered.artifacts.map(({ id }: { id: string }) => id).sort(),
  ).toEqual(successfulIds.sort());
  expect(await readdir(join(registryPath, ".."))).toEqual(["artifacts.json"]);

  // Retry is a new, explicit caller decision after all first attempts finish.
  for (const [index, result] of results.entries())
    if (result.status === "rejected")
      await approveTrainedArtifact(fixtures[index].artifact, { registryPath });
  const completed = JSON.parse(await readFile(registryPath, "utf8"));
  expect(
    completed.artifacts.map(({ id }: { id: string }) => id).sort(),
  ).toEqual(fixtures.map(({ artifact }) => artifact.id).sort());
  expect(await readdir(join(registryPath, ".."))).toEqual(["artifacts.json"]);
});

it("does not replace a lock created by another process or alter its approved registry", async () => {
  const first = await acceptedFixture("jev/existing-first");
  const second = await acceptedFixture("jev/existing-second");
  const registryPath = join(await directory(), "artifacts.json");
  await approveTrainedArtifact(first.artifact, { registryPath });
  const original = await readFile(registryPath, "utf8");
  const lockPath = `${registryPath}.lock`;
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    "import { writeFile } from 'node:fs/promises'; await writeFile(process.argv[1], 'external owner', { flag: 'wx', mode: 0o600 });",
    lockPath,
  ]);
  await expect(
    approveTrainedArtifact(second.artifact, { registryPath }),
  ).rejects.toMatchObject({ code: "ERR_ARTIFACT_REGISTRY_BUSY" });
  expect(await readFile(registryPath, "utf8")).toBe(original);
  expect(await readFile(lockPath, "utf8")).toBe("external owner");
  expect((await readdir(join(registryPath, ".."))).sort()).toEqual([
    "artifacts.json",
    "artifacts.json.lock",
  ]);
});

it("awaits removal of its lock and part when a registry read fails, allowing a later explicit approval", async () => {
  const fixture = await acceptedFixture("jev/recovered-registry");
  const registryPath = join(await directory(), "artifacts.json");
  const malformed = JSON.stringify({ version: 2, artifacts: [] });
  await writeFile(registryPath, malformed);
  await expect(
    approveTrainedArtifact(fixture.artifact, { registryPath }),
  ).rejects.toThrow("Invalid local artifact registry");
  expect(await readFile(registryPath, "utf8")).toBe(malformed);
  expect(await readdir(join(registryPath, ".."))).toEqual(["artifacts.json"]);
  await writeFile(registryPath, JSON.stringify({ version: 1, artifacts: [] }));
  await approveTrainedArtifact(fixture.artifact, { registryPath });
  expect(await readdir(join(registryPath, ".."))).toEqual(["artifacts.json"]);
  expect(JSON.parse(await readFile(registryPath, "utf8")).artifacts[0].id).toBe(
    fixture.artifact.id,
  );
});

it("still requires native acceptance before acquiring a writer lock or creating a registry", async () => {
  const fixture = await rfdtFixture(await directory(), false);
  const registryDirectory = await directory();
  const registryPath = join(registryDirectory, "artifacts.json");
  await expect(
    approveTrainedArtifact(fixture.artifact, { registryPath }),
  ).rejects.toThrow("matching native validation evidence is required");
  expect(await readdir(registryDirectory)).toEqual([]);
});

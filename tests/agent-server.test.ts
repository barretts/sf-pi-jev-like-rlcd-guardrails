import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AgentServer,
  getAgentServerStatus,
  LLAMA_REVISION,
  stopAgentServer,
} from "../src/agent-server.js";
const dirs: string[] = [];
async function statePath() {
  const dir = await mkdtemp(join(tmpdir(), "jev-server-test-"));
  dirs.push(dir);
  return join(dir, "state.json");
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it("starts stopped and rejects invalid configuration before spawning", async () => {
  const stateFile = await statePath();
  expect(await getAgentServerStatus({ stateFile })).toEqual({
    state: "stopped",
  });
  for (const options of [
    { port: 0 },
    { contextSize: 65536 },
    { startupTimeoutMs: 0 },
  ]) {
    await expect(
      new AgentServer({ ...options, stateFile }).start(),
    ).rejects.toThrow("Invalid Gemma server configuration");
  }
});
it("does not signal a reused PID whose start identity differs", async () => {
  const stateFile = await statePath();
  await writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      process_started: "stale identity",
      host: "127.0.0.1",
      port: 8081,
      native_revision: LLAMA_REVISION,
    }),
  );
  expect(await getAgentServerStatus({ stateFile })).toMatchObject({
    state: "stopped",
    stale: true,
  });
  await stopAgentServer({ stateFile });
  expect(await getAgentServerStatus({ stateFile })).toEqual({
    state: "stopped",
  });
});
it("rejects a state claiming a remote host", async () => {
  const stateFile = await statePath();
  await writeFile(
    stateFile,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      process_started: "identity",
      host: "0.0.0.0",
      port: 8081,
      native_revision: LLAMA_REVISION,
    }),
  );
  await expect(getAgentServerStatus({ stateFile })).rejects.toThrow(
    "Invalid owned server state",
  );
});
it("re-enable requires a fresh owner and remains lazy", async () => {
  const server = new AgentServer({ stateFile: await statePath() });
  await server.stop();
  await expect(server.start()).rejects.toThrow("owner stopped");
});

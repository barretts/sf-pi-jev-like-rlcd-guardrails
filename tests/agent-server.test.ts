import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Unit fixtures exercise the process/logging seam without loading model weights.
vi.mock("../src/models.js", () => ({
  AGENT_MODEL_ID: "google/gemma-4-31B-it-qat-q4_0",
  modelDescriptor: async () => ({
    chat_template: { file: "template.jinja", sha256: "template", size: 1 },
  }),
  verifyArtifact: async (file: string) => ({
    id: "google/gemma-4-31B-it-qat-q4_0",
    file,
    roles: ["agent", "teacher"],
  }),
  hashArtifact: async (file: string) => ({
    sha256: file.endsWith("template.jinja") ? "template" : "binary",
    size: 1,
  }),
}));
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

async function loggingFixture(log: string) {
  const stateFile = await statePath();
  const binary = join(stateFile, "..", "fixture.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}
import { createServer } from "node:http";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(${JSON.stringify(LLAMA_REVISION)});
  process.exit(0);
}
if (args[args.indexOf("--verbosity") + 1] !== "4") {
  console.error("Backend INFO evidence is suppressed below verbosity 4");
  process.exit(2);
}
process.stderr.write(${JSON.stringify(log)});
const server = createServer((_request, response) => response.end("{}"));
server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
  );
  await chmod(binary, 0o700);
  const port = await new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("Fixture port unavailable"));
        return;
      }
      probe.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
  return new AgentServer({
    stateFile,
    binary,
    modelFile: join(stateFile, "..", "fixture.gguf"),
    templateFile: join(stateFile, "..", "template.jinja"),
    port,
    device: "metal",
    startupTimeoutMs: 5000,
  });
}

it.each([
  ["legacy GPU name", "GPU name: MTL0 (Apple fixture)"],
  [
    "pinned selected device",
    "llama_prepare_model_devices: using device MTL0 (Apple fixture) (unknown id) - 79625 MiB free",
  ],
])(
  "requests trace logging and accepts positive Metal %s evidence",
  async (_name, log) => {
    const server = await loggingFixture(
      log + "\noffloaded 65/65 layers to GPU\n",
    );
    try {
      expect(await server.start()).toMatchObject({
        actual_device: "metal",
        device_name: "MTL0 (Apple fixture)",
        gpu_layers: 65,
      });
    } finally {
      await server.stop();
    }
    expect(await server.status()).toEqual({ state: "stopped" });
  },
);

it.each([
  ["missing", ""],
  ["zero layers", "GPU name: MTL0\noffloaded 0/65 layers to GPU\n"],
  ["non-Metal", "GPU name: CUDA0\noffloaded 65/65 layers to GPU\n"],
  [
    "selected device without layers",
    "llama_prepare_model_devices: using device MTL0 (Apple fixture) (unknown id) - 79625 MiB free\n",
  ],
  [
    "selected device with zero layers",
    "llama_prepare_model_devices: using device MTL0 (Apple fixture) (unknown id) - 79625 MiB free\noffloaded 0/65 layers to GPU\n",
  ],
  [
    "selected non-Metal device",
    "llama_prepare_model_devices: using device CUDA0 (Nvidia fixture) (unknown id) - 79625 MiB free\noffloaded 65/65 layers to GPU\n",
  ],
  [
    "device inventory without selected Metal evidence",
    "common_param: - MTL0 : Apple fixture\noffloaded 65/65 layers to GPU\n",
  ],
])(
  "rejects %s device evidence and cleans up its process",
  async (_name, log) => {
    const server = await loggingFixture(log);
    await expect(server.start()).rejects.toThrow(
      "Requested Metal execution was not observed",
    );
    expect(await server.status()).toEqual({ state: "stopped" });
  },
);

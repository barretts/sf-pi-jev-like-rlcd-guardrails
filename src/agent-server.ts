import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import {
  AGENT_MODEL_ID,
  hashArtifact,
  modelDescriptor,
  verifyArtifact,
  type ApprovedArtifact,
} from "./models.js";

export const LLAMA_REVISION = "f072b103714dfa1eee531f80b24512faf38e3dd2";
const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
export interface AgentServerOptions {
  modelFile?: string;
  templateFile?: string;
  binary?: string;
  port?: number;
  contextSize?: number;
  device?: "metal" | "cpu";
  stateFile?: string;
  startupTimeoutMs?: number;
  detached?: boolean;
}
export interface AgentServerState {
  version: 1;
  pid: number;
  process_started: string;
  started_at: string;
  host: "127.0.0.1";
  port: number;
  binary: string;
  binary_sha256: string;
  native_revision: string;
  model: ApprovedArtifact;
  template_file: string;
  template_sha256: string;
  context_size: number;
  parallel: 1;
  device: "metal" | "cpu";
  actual_device?: "metal" | "cpu";
  device_name?: string;
  gpu_layers?: number;
  log_file: string;
}
const defaultStateFile = () => join(root, ".build", "agent-server-state.json");
async function processStarted(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    return (
      (await exec("ps", ["-p", String(pid), "-o", "lstart="])).stdout.trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}
async function readState(
  stateFile: string,
): Promise<AgentServerState | undefined> {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (
      state.version !== 1 ||
      state.host !== "127.0.0.1" ||
      !Number.isSafeInteger(state.pid) ||
      typeof state.process_started !== "string" ||
      !Number.isSafeInteger(state.port) ||
      state.port < 1 ||
      state.port > 65535 ||
      state.native_revision !== LLAMA_REVISION
    )
      throw new Error("Invalid owned server state");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function health(port: number): Promise<boolean> {
  try {
    return (
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {
    return false;
  }
}
export async function getAgentServerStatus(
  opts: Pick<AgentServerOptions, "stateFile"> = {},
) {
  const state = await readState(resolve(opts.stateFile ?? defaultStateFile()));
  if (!state) return { state: "stopped" as const };
  if ((await processStarted(state.pid)) !== state.process_started)
    return { state: "stopped" as const, stale: true, server: state };
  return {
    state: (await health(state.port))
      ? ("ready" as const)
      : ("starting" as const),
    server: state,
  };
}
async function waitExited(
  pid: number,
  identity: string,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await processStarted(pid)) !== identity) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return (await processStarted(pid)) !== identity;
}
export async function stopAgentServer(
  opts: Pick<AgentServerOptions, "stateFile"> = {},
): Promise<void> {
  const stateFile = resolve(opts.stateFile ?? defaultStateFile());
  const state = await readState(stateFile);
  if (!state) return;
  if ((await processStarted(state.pid)) === state.process_started) {
    process.kill(state.pid, "SIGTERM");
    if (!(await waitExited(state.pid, state.process_started, 5000))) {
      if ((await processStarted(state.pid)) === state.process_started)
        process.kill(state.pid, "SIGKILL");
      if (!(await waitExited(state.pid, state.process_started, 2000)))
        throw new Error("Owned Gemma server did not stop");
    }
  }
  const current = await readState(stateFile);
  if (
    current?.pid === state.pid &&
    current.process_started === state.process_started
  )
    await rm(stateFile, { force: true });
}
async function availablePort(port: number): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolvePort())),
    );
  });
}
export class AgentServer {
  private child?: ChildProcess;
  private state?: AgentServerState;
  private startup?: Promise<AgentServerState>;
  private stopped = false;
  private stderr = "";
  private startupLog = "";
  readonly stateFile: string;
  constructor(readonly options: AgentServerOptions = {}) {
    this.stateFile = resolve(options.stateFile ?? defaultStateFile());
  }
  status() {
    return getAgentServerStatus({ stateFile: this.stateFile });
  }
  start(): Promise<AgentServerState> {
    if (this.stopped)
      return Promise.reject(new Error("Gemma server owner stopped"));
    this.startup ??= this.initialize().catch(async (error) => {
      await this.stop();
      throw error;
    });
    return this.startup;
  }
  private async initialize(): Promise<AgentServerState> {
    const port = this.options.port ?? 8081;
    const contextSize = this.options.contextSize ?? 32768;
    const startupTimeoutMs = this.options.startupTimeoutMs ?? 300_000;
    const device = this.options.device ?? "metal";
    if (
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !Number.isSafeInteger(contextSize) ||
      contextSize < 1024 ||
      contextSize > 32768 ||
      !Number.isSafeInteger(startupTimeoutMs) ||
      startupTimeoutMs < 1 ||
      !["metal", "cpu"].includes(device)
    )
      throw new Error("Invalid Gemma server configuration");
    if ((await this.status()).state !== "stopped")
      throw new Error("An owned Gemma server is already running");
    await availablePort(port);
    const descriptor = await modelDescriptor(AGENT_MODEL_ID);
    const binary = resolve(
      this.options.binary ?? join(root, ".build/agent-server/bin/llama-server"),
    );
    await access(binary, constants.X_OK);
    const version = await exec(binary, ["--version"], { timeout: 30_000 });
    if (
      !`${version.stdout}\n${version.stderr}`.includes(
        LLAMA_REVISION.slice(0, 7),
      )
    )
      throw new Error(
        "Gemma server binary must match the pinned llama.cpp build",
      );
    const model = await verifyArtifact(
      this.options.modelFile ?? join(root, "models", descriptor.file),
      "agent",
      AGENT_MODEL_ID,
    );
    const templateFile = resolve(
      this.options.templateFile ??
        join(root, "models", descriptor.chat_template!.file),
    );
    const template = await hashArtifact(templateFile);
    if (
      template.sha256 !== descriptor.chat_template!.sha256 ||
      template.size !== descriptor.chat_template!.size
    )
      throw new Error(
        "Gemma agent requires the pinned official corrected chat template",
      );
    const binaryIdentity = await hashArtifact(binary);
    if (this.stopped) throw new Error("Gemma server owner stopped");
    await mkdir(dirname(this.stateFile), { recursive: true });
    const logFile = join(
      dirname(this.stateFile),
      `agent-server.${randomUUID()}.log`,
    );
    const log = await open(logFile, "wx", 0o600);
    const args = [
      "--model",
      model.file,
      "--jinja",
      "--chat-template-file",
      templateFile,
      "--alias",
      AGENT_MODEL_ID,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--ctx-size",
      String(contextSize),
      "--parallel",
      "1",
      "--n-gpu-layers",
      device === "metal" ? "all" : "0",
      "--reasoning",
      "on",
      "--cors-origins",
      "",
      "--no-cors-credentials",
      "--no-webui",
      "--no-agent",
    ];
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(LLAMA_|AIP_)/.test(key),
      ),
    );
    const child = spawn(binary, args, {
      stdio: [
        "ignore",
        this.options.detached ? log.fd : "pipe",
        this.options.detached ? log.fd : "pipe",
      ],
      detached: this.options.detached ?? false,
      env: {
        ...environment,
        LLAMA_ARG_HOST: "127.0.0.1",
        LLAMA_ARG_PORT: String(port),
        AIP_HTTP_PORT: String(port),
      },
    });
    this.child = child;
    await log.close();
    let failure: Error | undefined;
    child.on("error", (error) => {
      failure = error;
    });
    child.on("exit", (code, signal) => {
      if (!this.stopped)
        failure = new Error(
          `Gemma server exited (${code ?? signal}): ${this.stderr}`,
        );
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000);
      this.startupLog = (this.startupLog + data.toString()).slice(-256 * 1024);
    });
    child.stdout?.resume();
    if (!child.pid) throw new Error("Gemma server did not spawn");
    const process_started = await processStarted(child.pid);
    if (!process_started) throw new Error("Gemma server process unavailable");
    const state: AgentServerState = {
      version: 1,
      pid: child.pid,
      process_started,
      started_at: new Date().toISOString(),
      host: "127.0.0.1",
      port,
      binary,
      binary_sha256: binaryIdentity.sha256,
      native_revision: LLAMA_REVISION,
      model,
      template_file: templateFile,
      template_sha256: template.sha256,
      context_size: contextSize,
      parallel: 1,
      device,
      log_file: logFile,
    };
    this.state = state;
    const part = `${this.stateFile}.${randomUUID()}.part`;
    try {
      await writeFile(part, JSON.stringify(state, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(part, this.stateFile);
    } finally {
      await rm(part, { force: true });
    }
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error("Gemma server owner stopped");
      if (failure) throw failure;
      if (await health(port)) {
        const startupLog = this.options.detached
          ? await readFile(logFile, "utf8")
          : this.startupLog;
        const layers = startupLog.match(/offloaded (\d+)\/\d+ layers to GPU/);
        const deviceName = startupLog
          .match(/GPU name:\s*([^\n]+)/)?.[1]
          ?.trim();
        if (layers) {
          state.gpu_layers = Number(layers[1]);
          state.actual_device =
            state.gpu_layers > 0 && deviceName?.startsWith("MTL")
              ? "metal"
              : "cpu";
          state.device_name =
            state.actual_device === "metal" ? deviceName : "CPU";
        }
        if (device === "metal" && state.actual_device !== "metal")
          throw new Error(
            "Requested Metal execution was not observed in the owned server startup",
          );
        await writeFile(this.stateFile, JSON.stringify(state, null, 2) + "\n", {
          mode: 0o600,
        });
        if (this.options.detached) child.unref();
        return state;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error("Gemma server initialization deadline exceeded");
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.state) await stopAgentServer({ stateFile: this.stateFile });
    else if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          this.child?.kill("SIGKILL");
          done();
        }, 5000);
        this.child!.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    this.child = undefined;
  }
}
export async function startAgentServer(
  opts: AgentServerOptions = {},
): Promise<AgentServer> {
  const server = new AgentServer(opts);
  await server.start();
  return server;
}

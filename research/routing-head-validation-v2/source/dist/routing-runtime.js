import { spawn as spawnProcess, } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { scoreRoutingHead, validateRoutingHeadArtifact, } from "./routing-head.js";
export const ROUTING_FEATURE_MODEL = "google/gemma-3-1b-it";
export const ROUTING_FEATURE_REVISION = "dcc83ea841ab6100d6b47a070329e1ba4cf78752";
export const ROUTING_FEATURE_WEIGHT_SHA256 = "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6";
export const ROUTING_RUNTIME_LIMITS = Object.freeze({
    dimension: 1152,
    queue: 8,
    lineBytes: 256 * 1024,
    requestLineBytes: 64 * 1024,
    textBytes: 32 * 1024,
    maxRequests: 4096,
    startupMs: 120_000,
    modelStartupMs: 120_000,
    requestMs: 10_000,
    operationalMs: 320_000,
    killMs: 1_000,
});
export const ROUTING_FEATURE_FILES = Object.freeze({
    "config.json": "19cb5d28c97778271ba2b3c3df47bf76bdd6706724777a2318b3522230afe91e",
    "generation_config.json": "fd9324becc53c4be610db39e13a613006f09fd6ef71a95fb6320dc33157490a3",
    "tokenizer.json": "4667f2089529e8e7657cfb6d1c19910ae71ff5f28aa7ab2ff2763330affad795",
    "tokenizer.model": "1299c11d7cf632ef3b4e11937501358ada021bbdf7c47638d13c0ee982f2e79c",
    "tokenizer_config.json": "bfe25c2735e395407beb78456ea9a6984a1f00d8c16fa04a8b75f2a614cf53e1",
    "special_tokens_map.json": "2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397",
    "added_tokens.json": "50b2f405ba56a26d4913fd772089992252d7f942123cc0a034d96424221ba946",
    "model.safetensors": ROUTING_FEATURE_WEIGHT_SHA256,
});
export const ROUTING_FEATURE_DEPENDENCIES = Object.freeze({
    python: "3.13.11",
    mlx: "0.32.2",
    "mlx-lm": "0.32.0",
    transformers: "5.11.0",
    "huggingface-hub": "1.32.0",
    mlx_lm_revision: "9d1e356e7cc6549e7d1697adabe2ea01ff8e062c",
});
const featureSettings = Object.freeze({
    model: ROUTING_FEATURE_MODEL,
    modelId: ROUTING_FEATURE_MODEL,
    revision: ROUTING_FEATURE_REVISION,
    lineage: "Google Gemma 3",
    modelWeightSha256: ROUTING_FEATURE_WEIGHT_SHA256,
    preprocessing: "raw_text_official_tokenizer_add_special_tokens_true_BOS_no_chat_template_no_truncation_v1",
    featureDefinition: "final_rmsnorm_decoder_last_token",
    featureDimension: 1152,
    adapterApplied: false,
    lmHeadApplied: false,
    trainable: false,
    dtype: "official_base_unchanged_then_feature_float32",
    maxInputTokens: 2048,
    mlxFreeCacheLimitBytes: 268435456,
    mlxMemoryGuidelineBytes: 8589934592,
    memoryGuidelineIsHardPeakCap: false,
    requiredDevice: "metal",
});
export function routingFeatureProvenance(workerSourceSha256) {
    return Object.freeze({
        ...featureSettings,
        workerSourceSha256: pin(workerSourceSha256),
        filesSha256: ROUTING_FEATURE_FILES,
        dependencies: ROUTING_FEATURE_DEPENDENCIES,
    });
}
export class RoutingRuntimeError extends Error {
    code;
    constructor(code) {
        super(`Routing runtime: ${code}`);
        this.code = code;
        this.name = "RoutingRuntimeError";
    }
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fail(code) {
    throw new RoutingRuntimeError(code);
}
function pin(value) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
        fail("invalid-pin");
    return value;
}
function absolutePath(value) {
    if (typeof value !== "string" ||
        !isAbsolute(value) ||
        value.length > 4096 ||
        /[\0\r\n]/.test(value))
        fail("invalid-path");
    return value;
}
function record(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail("invalid-protocol-record");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length ||
        !keys.every((key) => descriptors[key] && "value" in descriptors[key]))
        fail("invalid-protocol-fields");
    return value;
}
function finite(value, maximum, integer = false) {
    if (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > maximum ||
        (integer && !Number.isSafeInteger(value)))
        fail("invalid-protocol-number");
    return value;
}
/** JSON.parse otherwise silently discards duplicate keys. No output/error includes worker bytes. */
function strictJson(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        fail("malformed-json");
    }
    const scopes = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "{")
            scopes.push(new Set());
        else if (text[i] === "[")
            scopes.push(null);
        else if (text[i] === "}" || text[i] === "]")
            scopes.pop();
        else if (text[i] === '"') {
            const start = i++;
            while (text[i] !== '"') {
                if (text[i] === "\\")
                    i++;
                i++;
            }
            let next = i + 1;
            while (/\s/.test(text[next] ?? "") && next < text.length)
                next++;
            if (text[next] === ":") {
                const key = JSON.parse(text.slice(start, i + 1));
                const scope = scopes.at(-1);
                if (!scope || scope.has(key))
                    fail("duplicate-json-key");
                scope.add(key);
            }
        }
    }
    return parsed;
}
function childEnvironment() {
    const environment = {
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
        PYTHONUTF8: "1",
        PYTHONUNBUFFERED: "1",
    };
    // The worker uses an explicit repository-local snapshot and isolated HF_HOME.
    for (const key of [
        "PATH",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SYSTEMROOT",
    ])
        if (process.env[key])
            environment[key] = process.env[key];
    return environment;
}
/** One persistent offline worker. Any uncertainty retires it; recovery creates a new runtime. */
export function createRoutingRuntime(options) {
    const python = absolutePath(options.python), workerPath = absolutePath(options.workerPath);
    const workerSha256 = pin(options.workerSha256), artifactSha256 = pin(options.artifactSha256), qualificationSha256 = pin(options.qualificationSha256);
    if (typeof options.artifactId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(options.artifactId))
        fail("invalid-artifact-id");
    let head;
    let artifactBytes;
    try {
        if (typeof options.headArtifact === "string" ||
            options.headArtifact instanceof Uint8Array) {
            artifactBytes = options.headArtifact;
            if (Buffer.byteLength(artifactBytes) > 512 * 1024)
                fail("head-too-large");
            head = validateRoutingHeadArtifact(strictJson(new TextDecoder("utf-8", { fatal: true }).decode(typeof artifactBytes === "string"
                ? Buffer.from(artifactBytes)
                : artifactBytes)));
        }
        else {
            head = validateRoutingHeadArtifact(options.headArtifact);
            artifactBytes = JSON.stringify(head);
        }
    }
    catch (error) {
        if (error instanceof RoutingRuntimeError)
            throw error;
        fail("invalid-head");
    }
    if (head.dimension !== ROUTING_RUNTIME_LIMITS.dimension)
        fail("head-dimension-mismatch");
    if (hash(artifactBytes) !== artifactSha256)
        fail("head-hash-mismatch");
    const pins = Object.freeze({
        artifactId: options.artifactId,
        artifactSha256,
        qualificationSha256,
        workerSha256,
    });
    const spawner = options.spawn ??
        ((command, args, spawnOptions) => spawnProcess(command, [...args], {
            ...spawnOptions,
            stdio: ["pipe", "pipe", "pipe"],
        }));
    let state = "cold";
    let errorCode = null;
    let child;
    let active;
    const queue = [];
    let nextId = 0;
    let startupTimer;
    let killTimer;
    let cleanupTimer;
    let cleanup = Promise.resolve();
    let closeResolve;
    let closeReject;
    let bytes = Buffer.alloc(0);
    let provenance;
    let completed = 0;
    let fallbacks = 0;
    let modelReady = false;
    const retired = () => state === "failed" || state === "disposed";
    const settle = (p, error, result) => {
        if (p.timer)
            clearTimeout(p.timer);
        if (p.operationalTimer)
            clearTimeout(p.operationalTimer);
        if (p.abort)
            p.signal?.removeEventListener("abort", p.abort);
        if (error)
            p.reject(error);
        else
            p.resolve(result);
    };
    const terminate = () => {
        const owned = child;
        if (!owned || closeResolve === undefined)
            return;
        try {
            owned.kill("SIGTERM");
        }
        catch {
            /* Safe cleanup state is reported via timeout. */
        }
        killTimer = setTimeout(() => {
            try {
                owned.kill("SIGKILL");
            }
            catch {
                /* Never expose process errors. */
            }
            cleanupTimer = setTimeout(() => {
                errorCode = "cleanup-timeout";
                closeReject?.(new RoutingRuntimeError("cleanup-timeout"));
                closeResolve = undefined;
                closeReject = undefined;
            }, ROUTING_RUNTIME_LIMITS.killMs);
        }, ROUTING_RUNTIME_LIMITS.killMs);
    };
    const retire = (code) => {
        if (retired())
            return;
        state = "failed";
        errorCode = code;
        if (startupTimer)
            clearTimeout(startupTimer);
        const error = new RoutingRuntimeError(code);
        if (active)
            settle(active, error);
        active = undefined;
        for (const p of queue.splice(0))
            settle(p, error);
        bytes = Buffer.alloc(0);
        terminate();
    };
    const validateProvenance = (value) => {
        const expected = routingFeatureProvenance(workerSha256);
        const p = record(value, Object.keys(expected));
        for (const [key, expectedValue] of Object.entries(expected)) {
            if (key === "filesSha256" || key === "dependencies") {
                const actual = record(p[key], Object.keys(expectedValue));
                for (const [name, pinValue] of Object.entries(expectedValue))
                    if (actual[name] !== pinValue)
                        fail("provenance-mismatch");
            }
            else if (p[key] !== expectedValue)
                fail("provenance-mismatch");
        }
        return expected;
    };
    const send = () => {
        if (state !== "ready" || !active || !child)
            return;
        active.timer = setTimeout(() => retire(modelReady ? "request-timeout" : "model-startup-timeout"), modelReady
            ? ROUTING_RUNTIME_LIMITS.requestMs
            : ROUTING_RUNTIME_LIMITS.modelStartupMs);
        try {
            child.stdin.write(JSON.stringify({ id: active.id, text: active.text }) + "\n", (error) => {
                if (error)
                    retire("stdin-error");
            });
        }
        catch {
            retire("stdin-error");
        }
    };
    const pump = () => {
        if (active || state === "failed" || state === "disposed")
            return;
        active = queue.shift();
        if (!active)
            return;
        if (state === "cold")
            void start();
        else if (state === "ready")
            send();
    };
    const onLine = (line) => {
        try {
            const message = strictJson(new TextDecoder("utf-8", { fatal: true }).decode(line));
            if (message &&
                typeof message === "object" &&
                !Array.isArray(message) &&
                "error" in message) {
                const r = record(message, ["id", "error"]);
                record(r.error, ["code", "message"]);
                if (state === "starting" && r.id === null)
                    fail("worker-startup-rejected");
                if (state === "ready" && active && r.id === active.id)
                    fail("worker-rejected-request");
                fail("unexpected-response-id");
            }
            if (state === "starting") {
                const r = record(message, ["type", "dimension", "provenance"]);
                if (r.type !== "ready" ||
                    r.dimension !== ROUTING_RUNTIME_LIMITS.dimension)
                    fail("invalid-ready");
                provenance = validateProvenance(r.provenance);
                if (startupTimer)
                    clearTimeout(startupTimer);
                state = "ready";
                send();
                return;
            }
            if (state !== "ready" || !active)
                fail("unexpected-response");
            const r = record(message, [
                "id",
                "features",
                "provenance",
                "inputTokens",
                "elapsedMs",
                "modelId",
                "revision",
            ]);
            if (r.id !== active.id)
                fail("unexpected-response-id");
            if (r.modelId !== ROUTING_FEATURE_MODEL ||
                r.revision !== ROUTING_FEATURE_REVISION)
                fail("provenance-mismatch");
            const currentProvenance = validateProvenance(r.provenance);
            if (JSON.stringify(currentProvenance) !== JSON.stringify(provenance))
                fail("provenance-mismatch");
            const inputTokens = finite(r.inputTokens, 2048, true);
            if (inputTokens < 1)
                fail("invalid-protocol-number");
            const featureElapsedMs = finite(r.elapsedMs, modelReady
                ? ROUTING_RUNTIME_LIMITS.requestMs
                : ROUTING_RUNTIME_LIMITS.modelStartupMs);
            if (!Array.isArray(r.features) ||
                r.features.length !== ROUTING_RUNTIME_LIMITS.dimension ||
                !r.features.every((v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e12))
                fail("invalid-features");
            const scores = scoreRoutingHead(head, r.features);
            const request = active;
            active = undefined;
            modelReady = true;
            completed++;
            settle(request, undefined, {
                ...pins,
                ...scores,
                confidence: scores.decision === "fast"
                    ? scores.fastScore
                    : scores.decision === "strong"
                        ? scores.strongScore
                        : Math.max(scores.fastScore, scores.strongScore),
                calibration: "uncalibrated",
                reason: "head-score",
                inputTokens,
                featureElapsedMs,
                operationalElapsedMs: performance.now() - request.started,
                provenance: currentProvenance,
            });
            pump();
        }
        catch (error) {
            retire(error instanceof RoutingRuntimeError
                ? error.code
                : "invalid-worker-response");
        }
    };
    const onData = (chunk) => {
        if (state === "failed" || state === "disposed")
            return;
        if (typeof chunk === "string") {
            retire("invalid-stdout-encoding");
            return;
        }
        let offset = 0;
        while (offset < chunk.length && !retired()) {
            const newline = chunk.indexOf(10, offset);
            const end = newline < 0 ? chunk.length : newline;
            const part = chunk.subarray(offset, end);
            if (bytes.length + part.length > ROUTING_RUNTIME_LIMITS.lineBytes) {
                retire("line-too-large");
                return;
            }
            bytes = Buffer.concat([bytes, part]);
            if (newline < 0)
                return;
            const line = bytes;
            bytes = Buffer.alloc(0);
            onLine(line);
            offset = newline + 1;
        }
    };
    const start = async () => {
        state = "starting";
        startupTimer = setTimeout(() => retire("startup-timeout"), ROUTING_RUNTIME_LIMITS.startupMs);
        try {
            const stat = await lstat(workerPath);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
                fail("invalid-worker-source");
            if (hash(await readFile(workerPath)) !== workerSha256)
                fail("worker-hash-mismatch");
            const after = await lstat(workerPath);
            if (!after.isFile() ||
                after.ino !== stat.ino ||
                after.dev !== stat.dev ||
                after.size !== stat.size ||
                after.mtimeMs !== stat.mtimeMs ||
                after.ctimeMs !== stat.ctimeMs)
                fail("worker-source-changed");
            if (state !== "starting")
                return;
            child = spawner(python, ["-I", "-u", workerPath], {
                shell: false,
                windowsHide: true,
                env: childEnvironment(),
            });
            cleanup = new Promise((resolve, reject) => {
                closeResolve = resolve;
                closeReject = reject;
            });
            // Failure cleanup may finish before a caller awaits dispose.
            void cleanup.catch(() => { });
            child.once("close", () => {
                if (killTimer)
                    clearTimeout(killTimer);
                if (cleanupTimer)
                    clearTimeout(cleanupTimer);
                closeResolve?.();
                closeResolve = undefined;
                closeReject = undefined;
                if (state !== "failed" && state !== "disposed")
                    retire(bytes.length ? "truncated-stdout" : "worker-eof");
            });
            child.on("error", () => retire("spawn-error"));
            child.stdout.on("data", onData);
            child.stdout.on("error", () => retire("stdout-error"));
            child.stdout.on("end", () => {
                if (state !== "failed" && state !== "disposed")
                    retire(bytes.length ? "truncated-stdout" : "worker-eof");
            });
            child.stdin.on("error", () => retire("stdin-error"));
            child.stderr.on("error", () => retire("stderr-error"));
            child.stderr.resume();
        }
        catch (error) {
            retire(error instanceof RoutingRuntimeError ? error.code : "startup-error");
        }
    };
    return {
        classify(input, signal) {
            const started = performance.now();
            if (state === "failed" || state === "disposed")
                return Promise.reject(new RoutingRuntimeError(state === "disposed" ? "disposed" : (errorCode ?? "failed")));
            if (signal?.aborted)
                return Promise.reject(new RoutingRuntimeError("aborted"));
            if (!input || typeof input.text !== "string")
                return Promise.reject(new RoutingRuntimeError("invalid-input"));
            const text = input.text;
            if (!text.trim() ||
                Buffer.byteLength(text) > ROUTING_RUNTIME_LIMITS.textBytes ||
                /[\ud800-\udfff]/u.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")))
                return Promise.reject(new RoutingRuntimeError("invalid-input"));
            if (Buffer.byteLength(JSON.stringify({ id: ROUTING_RUNTIME_LIMITS.maxRequests, text })) +
                1 >
                ROUTING_RUNTIME_LIMITS.requestLineBytes)
                return Promise.reject(new RoutingRuntimeError("invalid-input"));
            if (input.essentialFactsAvailable !== true) {
                fallbacks++;
                return Promise.resolve({
                    ...pins,
                    decision: "strong",
                    confidence: 0,
                    calibration: "uncalibrated",
                    reason: "essential-facts-not-verified",
                    fastScore: null,
                    strongScore: null,
                    inputTokens: 0,
                    featureElapsedMs: 0,
                    operationalElapsedMs: performance.now() - started,
                    provenance: null,
                });
            }
            if (queue.length >= ROUTING_RUNTIME_LIMITS.queue)
                return Promise.reject(new RoutingRuntimeError("queue-full"));
            if (nextId >= ROUTING_RUNTIME_LIMITS.maxRequests)
                return Promise.reject(new RoutingRuntimeError("request-limit"));
            return new Promise((resolve, reject) => {
                const p = {
                    id: ++nextId,
                    text,
                    started,
                    resolve,
                    reject,
                    signal,
                };
                p.operationalTimer = setTimeout(() => retire("operational-timeout"), ROUTING_RUNTIME_LIMITS.operationalMs);
                if (signal) {
                    p.abort = () => retire("aborted");
                    signal.addEventListener("abort", p.abort, { once: true });
                }
                queue.push(p);
                pump();
            });
        },
        get status() {
            return Object.freeze({
                state,
                errorCode,
                modelReady,
                activeRequests: active ? 1 : 0,
                queuedRequests: queue.length,
                completedRequests: completed,
                fallbackRequests: fallbacks,
                submittedRequests: nextId,
                ...pins,
            });
        },
        async dispose() {
            if (state !== "disposed") {
                const wasFailed = state === "failed";
                if (!wasFailed)
                    retire("disposed");
                state = "disposed";
                if (startupTimer)
                    clearTimeout(startupTimer);
            }
            await cleanup;
        },
    };
}

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }),
);
const paths = pack.files.map((file) => file.path);
for (const required of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/extension.js",
  "dist/extension.d.ts",
  "dist/cli.js",
  "dist/cli.d.ts",
  "dist/server.js",
  "dist/server.d.ts",
  "dist/guardrail.js",
  "dist/guardrail.d.ts",
  "dist/guardrail-extension.js",
  "dist/guardrail-extension.d.ts",
  "dist/guardrail-evaluation.js",
  "dist/guardrail-evaluation.d.ts",
  "rfdt/worker.py",
  "rfdt/requirements.txt",
  "rfdt/requirements.lock",
  "fixtures/quality.jsonl",
  "models/registry.json",
  "native/main.cpp",
  "native/CMakeLists.txt",
  "scripts/build-native.sh",
  "scripts/build-agent-server.sh",
  "scripts/build-rfdt.sh",
  "scripts/guardrail-train.mjs",
  "scripts/guardrail-eval.mjs",
  "scripts/guardrail-corpus.mjs",
  "fixtures/guardrail/corpus.json",
  "fixtures/guardrail/RUBRIC.md",
  "integrations/sf-pi-manager/README.md",
  "integrations/sf-pi-guardrail/README.md",
  "README.md",
  "GUARDRAIL.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
])
  assert.ok(paths.includes(required), `Package missing ${required}`);
for (const declared of [
  manifest.exports["."],
  manifest.types,
  ...Object.values(manifest.bin),
  ...manifest.pi.extensions,
])
  assert.ok(
    paths.includes(declared.replace(/^\.\//, "")),
    `Package missing declared entrypoint ${declared}`,
  );
assert.ok(
  paths.some((path) =>
    /^integrations\/sf-pi-manager\/[^/]+\.patch$/.test(path),
  ),
  "Package missing the SF Pi manager integration patch",
);
assert.ok(
  paths.some((path) =>
    /^integrations\/sf-pi-guardrail\/[^/]+\.patch$/.test(path),
  ),
  "Package missing the SF Guardrail integration patch",
);
assert.ok(
  !paths.some((path) =>
    /(?:^|\/)(?:node_modules|\.build|\.vendor|\.jev|\.venv|venv|__pycache__)(?:\/|$)|\.(?:gguf|safetensors|pyc|part|jinja|bin|pt|pth|ckpt|onnx|npz|npy|dylib|so|dll|exe|o|a|log)$/i.test(
      path,
    ),
  ),
  "Package contains local data, weights, templates, logs, or binary artifacts",
);
assert.ok(
  !paths.some((path) =>
    /(?:^|\/)(?:prompt[-_]?logs?|traces?|captures?|private)(?:\/|$)/i.test(
      path,
    ),
  ),
  "Package contains private prompts, traces, or capture data",
);
assert.ok(
  pack.unpackedSize < 10 * 1024 * 1024,
  "Source package exceeds 10 MiB",
);

let consumer;
if (process.argv.includes("--install")) {
  const base = resolve(".build/package-consumer");
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "run-"));
  const [archive] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
      encoding: "utf8",
    }),
  );
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          [manifest.name]: `file:./${archive.filename}`,
          "@earendil-works/pi-coding-agent":
            manifest.devDependencies["@earendil-works/pi-coding-agent"],
          "@earendil-works/pi-tui":
            manifest.devDependencies["@earendil-works/pi-tui"],
        },
        devDependencies: {
          "@types/node": lock.packages["node_modules/@types/node"].version,
          typescript: lock.packages["node_modules/typescript"].version,
        },
      },
      null,
      2,
    ) + "\n",
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: directory, encoding: "utf8", timeout: 300_000 },
  );
  execFileSync("npm", ["ls", "--all", "--json"], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("JEV_")),
  );
  const run = (args) =>
    spawnSync(process.execPath, args, {
      cwd: directory,
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    });
  writeFileSync(
    join(directory, "import-check.mjs"),
    `import assert from "node:assert/strict";
import { Classifier, NativeBackend, configFromEnv, preparePrompt, registerExtension, registerTaskContextCompression, planToolContext, createContextOriginals } from ${JSON.stringify(manifest.name)};
import extension from ${JSON.stringify(`./node_modules/${manifest.name}/dist/extension.js`)};
assert.equal(typeof Classifier, "function");
assert.equal(typeof NativeBackend, "function");
assert.equal(typeof preparePrompt, "function");
assert.equal(configFromEnv({}).modelFile, undefined);
assert.equal(typeof extension, "function");
assert.equal(typeof registerExtension, "function");
assert.equal(typeof registerTaskContextCompression, "function");
assert.equal(typeof planToolContext, "function");
assert.equal(typeof createContextOriginals, "function");
console.log("Installed library and Pi extension imports passed");
`,
  );
  const imported = run(["import-check.mjs"]);
  assert.equal(imported.status, 0, imported.stderr || String(imported.error));
  writeFileSync(
    join(directory, "types-check.ts"),
    `import { Classifier, NativeBackend, configFromEnv, preparePrompt, type Config, type TemplateVersion } from ${JSON.stringify(manifest.name)};
const config: Config = configFromEnv({});
const template: TemplateVersion = "v2";
const backend: NativeBackend = new NativeBackend({ ...config, templateVersion: template });
const classifier: Classifier = new Classifier(config);
void [backend, classifier, preparePrompt];
`,
  );
  const types = run([
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2023",
    "--types",
    "node",
    "types-check.ts",
  ]);
  assert.equal(
    types.status,
    0,
    types.stdout || types.stderr || String(types.error),
  );
  const help = run(["node_modules/.bin/jev", "--help"]);
  assert.equal(help.status, 0, help.stderr || String(help.error));
  assert.match(help.stdout, /Jev local classifier and training workflow/);
  const serverHelp = run(["node_modules/.bin/jev-server", "--help"]);
  assert.equal(
    serverHelp.status,
    0,
    serverHelp.stderr || String(serverHelp.error),
  );
  assert.match(serverHelp.stdout, /jev-server --model-file/);
  const doctor = run(["node_modules/.bin/jev", "doctor"]);
  assert.equal(doctor.status, 1, doctor.stderr || String(doctor.error));
  assert.match(
    doctor.stderr,
    /Set JEV_MODEL_FILE to an approved Gemma classifier GGUF/,
  );
  assert.doesNotMatch(doctor.stderr, /\n\s+at /);
  consumer = {
    directory,
    install_scripts: false,
    library_import: true,
    extension_import: true,
    types_consumer: true,
    cli_help: true,
    server_help: true,
    absent_model_doctor: "actionable error, exit 1",
  };
}
console.log(
  JSON.stringify(
    {
      package_files: paths.length,
      bytes: pack.size,
      unpacked_bytes: pack.unpackedSize,
      weights_included: false,
      consumer,
    },
    null,
    2,
  ),
);

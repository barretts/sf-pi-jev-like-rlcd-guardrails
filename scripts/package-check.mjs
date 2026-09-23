import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSmoke } from "./sf-pi-smoke.mjs";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    encoding: "utf8",
  }),
);
const paths = pack.files.map((file) => file.path);
const roots = new Set([
  "dist",
  "native",
  "training",
  "scripts",
  "models",
  "integrations",
  "README.md",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "docs",
]);
for (const path of paths) {
  assert.ok(roots.has(path.split("/")[0]), `Unexpected package file: ${path}`);
  assert.ok(
    !/(?:^|\/)(?:node_modules|\.build|\.vendor|__pycache__)(?:\/|$)|\.(?:gguf|safetensors|pyc|part|log|bin|dylib|so|exe)$/i.test(
      path,
    ),
    `Local artifact in package: ${path}`,
  );
  assert.ok(
    !/(?:^|\/)(?:research|reports|routing|fixtures|sf-pi-manager)(?:\/|$)|(?:^|\/)guardrail-candidate\d|(?:^|\/)dist\/(?:cli|server|context-|routing-|manager|automation|web|agent-server)/.test(
      path,
    ),
    `Removed feature in package: ${path}`,
  );
}
for (const required of [
  ...Object.values(manifest.exports).map((path) => path.replace(/^\.\//, "")),
  manifest.types.replace(/^\.\//, ""),
  ...manifest.pi.extensions.map((path) => path.replace(/^\.\//, "")),
  "dist/guardrail.js",
  "dist/guardrail-selection.js",
  "dist/rfdt.js",
  "models/current/selection-freeze.json",
  "models/current/cal-only-accuracy.json",
  "models/current/registry.json",
  "models/registry.json",
  "native/main.cpp",
  "native/CMakeLists.txt",
  "scripts/build-native.sh",
  "scripts/train-guardrail.mjs",
  "scripts/export-guardrail.mjs",
  "scripts/verify-guardrail.mjs",
  "training/data/prepared-fit.jsonl",
  "integrations/sf-pi-guardrail/current-sf-pi.patch",
  "docs/blog-background.md",
])
  assert.ok(paths.includes(required), `Package missing ${required}`);
assert.equal(manifest.bin, undefined, "Obsolete CLI entrypoints remain");
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
assert.ok(pack.unpackedSize < 6 * 1024 * 1024, "Source package exceeds 6 MiB");

let installed = false;
if (process.argv.includes("--install")) {
  const directory = await mkdtemp(join(tmpdir(), "jev-guardrail-consumer-"));
  try {
    const [archive] = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
        { encoding: "utf8" },
      ),
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { [manifest.name]: `file:./${archive.filename}` },
      }),
    );
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      const api = await import(${JSON.stringify(manifest.name)});
      const extension = await import(${JSON.stringify(manifest.name + "/extension")});
      assert.equal(typeof api.classifyGuardrailRisk, 'function');
      assert.equal(typeof api.registerGuardrailProvider, 'function');
      assert.equal(typeof extension.default, 'function');
      assert.equal(api.registerAutomation, undefined);
      assert.equal(api.createServer, undefined);
      assert.equal(api.fitRoutingHead, undefined);
    `,
      ],
      { cwd: directory, encoding: "utf8", timeout: 30_000 },
    );
    const discovery = await runSmoke({
      packageRoot: join(directory, "node_modules", manifest.name),
    });
    assert.equal(discovery.passed, true);
    assert.equal(discovery.nativeInference, false);
    assert.equal(discovery.packageDiscoveryOff.modelSha256, null);
    installed = true;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      package: manifest.name,
      files: paths.length,
      unpackedBytes: pack.unpackedSize,
      installedConsumerPassed: installed,
      weightsIncluded: false,
    },
    null,
    2,
  ),
);

#!/usr/bin/env node
/** Validate or stage immutable C11 training inputs. Never initiates remote access. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { rfdtSha256, verifyTrainingInputs } from "../dist/rfdt.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    "base-hf": { type: "string" },
    stage: { type: "string" },
    python: { type: "string" },
  },
});
await verifyTrainingInputs();
const hashes = JSON.parse(
  await readFile(join(root, "training", "code-sha256.json"), "utf8"),
);
if (
  hashes.version !== 1 ||
  hashes.purpose !== "current_training_implementation" ||
  hashes.qualified !== false ||
  !hashes.files
)
  throw new Error("Invalid current training implementation fingerprint");
for (const [file, digest] of Object.entries(hashes.files)) {
  if ((await rfdtSha256(join(root, "training", file))) !== digest)
    throw new Error(`Training implementation changed: ${file}`);
}
function python(args) {
  return new Promise((yes, no) => {
    const child = spawn(values.python ?? "python3", args, {
      stdio: "inherit",
      cwd: root,
    });
    child.on("error", no);
    child.on("close", (code) =>
      code === 0 ? yes() : no(new Error(`Training preparation exited ${code}`)),
    );
  });
}
if (values.check && !values.stage) {
  if (values["base-hf"])
    await python([
      "-c",
      "import sys; sys.path.insert(0, 'training'); import contract; from pathlib import Path; contract.verify_local_base(Path(sys.argv[1]).resolve())",
      resolve(values["base-hf"]),
    ]);
  console.log(
    JSON.stringify({
      inputsVerified: true,
      implementationVerified: true,
      baseVerified: Boolean(values["base-hf"]),
      qualified: false,
      remoteAccess: false,
      trainingStarted: false,
    }),
  );
} else if (values.stage && values["base-hf"] && !values.check) {
  await python([
    join(root, "training", "launch.py"),
    "stage",
    "--base",
    resolve(values["base-hf"]),
    "--output",
    resolve(values.stage),
  ]);
} else {
  throw new Error(
    "Use --check [--base-hf PINNED_GOOGLE_SNAPSHOT], or --base-hf PINNED_GOOGLE_SNAPSHOT --stage FRESH_INPUTS [--python FILE]. See training/README.md for explicit supervised CUDA execution.",
  );
}

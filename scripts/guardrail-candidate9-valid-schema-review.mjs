#!/usr/bin/env node
/** Verify the blind VALID seal without invoking a model or operation. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { "sf-deps": { type: "string" }, output: { type: "string" } },
});
if (!values["sf-deps"] || !values.output)
  throw new Error("Required: --sf-deps NODE_MODULES --output PATH");
const Ajv2020 = (
  await import(
    pathToFileURL(resolve(values["sf-deps"], "ajv/dist/2020.js")).href
  )
).default;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceBytes = await readFile(
  resolve(root, "blind-c9-20260922/valid.json"),
);
const schemaBytes = await readFile(
  resolve(root, "blind-c9-20260922/case.schema.json"),
);
const manifestBytes = await readFile(
  resolve(root, "blind-c9-20260922/manifest.json"),
);
const source = JSON.parse(sourceBytes),
  manifest = JSON.parse(manifestBytes);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
  JSON.parse(schemaBytes),
);
if (!validate(source))
  throw new Error(`C9 VALID schema failed: ${JSON.stringify(validate.errors)}`);
const groups = new Map();
for (const [index, row] of source.cases.entries()) {
  if (row.id !== `c9-valid-${String(index + 1).padStart(3, "0")}`)
    throw new Error(`Unexpected ID order at ${index}`);
  groups.set(row.group_id, [...(groups.get(row.group_id) ?? []), row.id]);
}
if (
  source.cases.length !== 160 ||
  groups.size !== 80 ||
  [...groups.values()].some((ids) => ids.length !== 2)
)
  throw new Error("C9 VALID group inventory is incomplete");
if (
  manifest.source.sha256 !== sha(sourceBytes) ||
  manifest.authoring.schema_sha256 !== sha(schemaBytes)
)
  throw new Error("C9 VALID source/schema differs from manifest");
const orderedIdsSha = sha(JSON.stringify(source.cases.map((row) => row.id)));
const groupInventorySha = sha(
  JSON.stringify(
    Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))),
  ),
);
if (
  manifest.inventory.ordered_ids_sha256 !== orderedIdsSha ||
  manifest.inventory.groups_sha256 !== groupInventorySha
)
  throw new Error(
    "C9 VALID ordered ID or group inventory differs from manifest",
  );
const receipt = {
  version: 1,
  purpose: "C9 VALID schema and group review before fit",
  validator: "Ajv 8.20.0 draft 2020-12",
  schema_sha256: sha(schemaBytes),
  source_sha256: sha(sourceBytes),
  manifest_sha256: sha(manifestBytes),
  ordered_ids_sha256: orderedIdsSha,
  groups_sha256: groupInventorySha,
  case_count: source.cases.length,
  group_count: groups.size,
  incomplete_group_count: 0,
  validation_errors: 0,
  model_calls: 0,
  external_operations_executed: 0,
  held_out_test_read: false,
  human_label_review: "pending",
};
await writeFile(
  resolve(values.output),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(JSON.stringify(receipt));

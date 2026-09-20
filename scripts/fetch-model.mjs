import { readFile, mkdir, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
const root = new URL("../", import.meta.url);
const {
  models: [m],
} = JSON.parse(await readFile(new URL("models/registry.json", root), "utf8"));
if (!process.argv.includes("--accept-gemma-terms"))
  throw new Error(
    "Review https://ai.google.dev/gemma/terms and rerun with --accept-gemma-terms if you accept.",
  );
await mkdir(new URL("models/", root), { recursive: true });
const dest = new URL("models/" + m.file, root),
  part = new URL("models/" + m.file + ".part", root);
const response = await fetch(
  `https://huggingface.co/${m.repository}/resolve/${m.revision}/${m.file}`,
);
if (!response.ok || !response.body)
  throw new Error(`Download failed: ${response.status}`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
const hash = createHash("sha256");
for await (const chunk of createReadStream(part)) hash.update(chunk);
if (hash.digest("hex") !== m.sha256)
  throw new Error(
    "Model checksum mismatch; temporary file retained for inspection",
  );
await rename(part, dest);
console.log(dest.pathname);

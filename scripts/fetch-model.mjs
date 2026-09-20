import { fetchApprovedModel } from "../dist/models.js";
const args = process.argv.slice(2);
const idIndex = args.indexOf("--model");
const id = idIndex >= 0 ? args[idIndex + 1] : "google/gemma-3-1b-it";
if (!id) throw new Error("--model requires an approved model ID");
let previous = 0;
const artifact = await fetchApprovedModel(id, {
  acceptGemmaTerms: args.includes("--accept-gemma-terms"),
  onProgress(completed, total, file) {
    if (Date.now() - previous > 10_000 || completed === total) {
      console.error(
        `${file}: ${((completed / total) * 100).toFixed(1)}% (${completed}/${total} bytes)`,
      );
      previous = Date.now();
    }
  },
});
console.log(JSON.stringify(artifact, null, 2));

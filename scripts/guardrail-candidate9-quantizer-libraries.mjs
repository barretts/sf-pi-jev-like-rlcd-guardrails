import { readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { hashArtifact } from "../dist/models.js";

const regularDigests = {
  "libggml-base.0.24.0.dylib":
    "9db74bfd05cba266b974aedd54d9ebdc8fb790bfedaf5061233ba01109bbc2f0",
  "libggml-blas.0.24.0.dylib":
    "3cb807b9e40ef948e10f694b1295680934c9499ee9f1be39798624ab7b79d1c3",
  "libggml-cpu.0.24.0.dylib":
    "3e47d627b626e59119ede0cb97c80ca9e950b04a9106c0bd2d3246190c504479",
  "libggml-metal.0.24.0.dylib":
    "2d7c178791ae1f08ee10b0ee9b675198e683fd65ca970bfffa9076d2b39c4930",
  "libggml.0.24.0.dylib":
    "84f221a0e63afbc2d5bedf4cdb14fd01bcdd159f00dd5be8107bba15d9fe0911",
  "libllama-common.0.4.1.dylib":
    "c41b57efe3daa75ec434a5d9c3195180d91654cd88393ba6076629cf1198215f",
  "libllama-quantize-impl.dylib":
    "facfafbbb02bdc66ef3f98bf4fbf5d04661ad807eff85f29dd21ece3e0831859",
  "libllama.0.4.1.dylib":
    "35d27edeaba7c2e8e9d96856134637faf7d005aea1ce991e47c6a8b9b509fcb0",
};
const linkTargets = {
  "libggml-base.0.dylib": "libggml-base.0.24.0.dylib",
  "libggml-base.dylib": "libggml-base.0.dylib",
  "libggml-blas.0.dylib": "libggml-blas.0.24.0.dylib",
  "libggml-blas.dylib": "libggml-blas.0.dylib",
  "libggml-cpu.0.dylib": "libggml-cpu.0.24.0.dylib",
  "libggml-cpu.dylib": "libggml-cpu.0.dylib",
  "libggml-metal.0.dylib": "libggml-metal.0.24.0.dylib",
  "libggml-metal.dylib": "libggml-metal.0.dylib",
  "libggml.0.dylib": "libggml.0.24.0.dylib",
  "libggml.dylib": "libggml.0.dylib",
  "libllama-common.0.dylib": "libllama-common.0.4.1.dylib",
  "libllama-common.dylib": "libllama-common.0.dylib",
  "libllama.0.dylib": "libllama.0.4.1.dylib",
  "libllama.dylib": "libllama.0.dylib",
};
const expectedNames = [
  ...Object.keys(regularDigests),
  ...Object.keys(linkTargets),
].sort();

/** Hash the exact loader-visible dylib inventory of the frozen C9 quantizer build. */
export async function inspectQuantizerLibraries(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".dylib"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const actualNames = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
    throw new Error("C9 Q8 quantizer linked-library inventory changed");
  const runtimeLibraries = {};
  const runtimeLibraryLinks = {};
  for (const entry of entries) {
    const file = resolve(directory, entry.name);
    if (Object.hasOwn(regularDigests, entry.name) && entry.isFile()) {
      const digest = (await hashArtifact(file)).sha256;
      if (digest !== regularDigests[entry.name])
        throw new Error("C9 Q8 quantizer library payload changed");
      runtimeLibraries[entry.name] = digest;
    } else if (
      Object.hasOwn(linkTargets, entry.name) &&
      entry.isSymbolicLink()
    ) {
      const target = await readlink(file);
      if (target !== linkTargets[entry.name])
        throw new Error("C9 Q8 quantizer library link target changed");
      runtimeLibraryLinks[entry.name] = target;
    } else {
      throw new Error("C9 Q8 quantizer linked-library inventory changed");
    }
  }
  return { runtimeLibraries, runtimeLibraryLinks };
}

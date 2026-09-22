import assert from "node:assert/strict";
import {
  link,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { test } from "node:test";
import { inspectQuantizerLibraries } from "../scripts/guardrail-candidate9-quantizer-libraries.mjs";

const pinnedBuild = process.env.C9_QUANTIZER_BIN_DIR;

test(
  "C9 quantizer accepts the pinned build and rejects missing, extra, retargeted, or changed libraries",
  {
    skip: !pinnedBuild,
  },
  async () => {
    const current = await inspectQuantizerLibraries(pinnedBuild);
    assert.equal(Object.keys(current.runtimeLibraries).length, 8);
    assert.equal(Object.keys(current.runtimeLibraryLinks).length, 14);

    const clone = await mkdtemp(resolve(tmpdir(), "c9-quantizer-inventory-"));
    try {
      const names = (await readdir(pinnedBuild)).filter((name) =>
        name.endsWith(".dylib"),
      );
      for (const name of names) {
        const origin = resolve(pinnedBuild, name);
        if (Object.hasOwn(current.runtimeLibraries, name))
          await link(origin, resolve(clone, name));
        else await symlink(await readlink(origin), resolve(clone, name));
      }
      assert.deepEqual(await inspectQuantizerLibraries(clone), current);

      const [alias, target] = Object.entries(current.runtimeLibraryLinks)[0];
      await rm(resolve(clone, alias));
      await assert.rejects(
        inspectQuantizerLibraries(clone),
        /linked-library inventory changed/,
      );
      await symlink(target, resolve(clone, alias));

      const extra = "libunexpected.dylib";
      await symlink(basename(alias), resolve(clone, extra));
      await assert.rejects(
        inspectQuantizerLibraries(clone),
        /linked-library inventory changed/,
      );
      await rm(resolve(clone, extra));

      await rm(resolve(clone, alias));
      await symlink("libggml.dylib", resolve(clone, alias));
      await assert.rejects(
        inspectQuantizerLibraries(clone),
        /library link target changed/,
      );
      await rm(resolve(clone, alias));
      await symlink(target, resolve(clone, alias));

      const payload = Object.keys(current.runtimeLibraries)[0];
      await rm(resolve(clone, payload));
      await writeFile(resolve(clone, payload), "changed payload");
      await assert.rejects(
        inspectQuantizerLibraries(clone),
        /library payload changed/,
      );
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  },
);

# Research checkpoint, 2026-09-20

This checkpoint preserves the current developer-improvement experiments alongside
the committed TypeScript application. The archives contain exact original bytes
from `.build/improvement-experiments`: experimental source and tests, protocols,
authored datasets, reports, provenance receipts, and small locally trained LoRA
adapters. `manifest.json` records every included file and archive with its size
and SHA-256, and lists exclusions.

The seven archives contain 2,832 files and occupy 53,697,843 bytes. Generated full
model weights, fused-model directories, native executables, tokenizer binaries,
bytecode, and runtime locks are excluded. Their available identities remain in
the experiment reports. Dependency installations and official model caches are
also local prerequisites. Credentials and the other thread's raw conversation
are not part of this checkpoint.

These are recovery snapshots. They include failed experiments, inert proposals,
historical source revisions, and incomplete stages. They do not add a production
classifier, establish a new performance claim, or approve a student.

## Latest saved training state

Round 7 completed 512 optimizer steps on 970 TRAIN records from the pinned Google
Gemma 3 1B base. Its saved report verifies all 970 prompt boundaries and 7,306
candidate-label boundaries, changed adapter weights, and exact checkpoint reload
with maximum probability difference zero. Mean TRAIN loss decreased from
6.7002100954 to 0.0845734478. This measures training fit; native quality is pending.

The trained adapter is 5,975,035 bytes with SHA-256
`393be73af7a4f0db018ac4c43c092af7c4059d513a2e54a1a0b4be444182194e`.
The run is `rfdt-20260920150051-6adca0d2`. No export, native validation, new final
TEST, or permanent approval is recorded. The original parent job still says
`running`, but its owner, CLI, and MLX worker PIDs are absent. That stale file is
preserved; the parent runner's exit code is unknown. `current-state.json` records
the separate current observations without rewriting the original evidence.

The prospective R7 host attester has a known representation-count mismatch: it
expects 14 string-state and 14 structured-state records, while the frozen
diagnosis corpus contains zero string-state, 28 structured-state, and 28 message
records. Its frozen source and invented CPU tests are preserved. A separately
reviewed correction is required before it can grade actual native results.

## Restore

Use a fresh clone or empty staging directory. Archive paths are relative and
restore the original `.build/improvement-experiments` layout:

```sh
for archive in /path/to/checkpoint/{source,evidence,adapters}-*.tar.gz; do
  tar -xzf "$archive"
done
```

Compare restored file hashes with `manifest.json`. Historical scripts and proof
receipts retain their original machine paths and runtime identities. Restoration
does not execute scripts, download weights, or authorize replay of a recorded
evaluation. Reproduction requires explicit current configuration and the pinned
local dependencies. The application is built from the ordinary tracked source.

`create-checkpoint.py` documents how these archives were selected and generated.
It refuses to overwrite archive and manifest files. Archive entry hashes and
original source copies were checked after creation; credential-pattern inspection
covered the included text files before private delivery.

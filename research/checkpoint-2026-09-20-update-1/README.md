# Research checkpoint update: RFDT round 7 export and validation

This is an incremental update to [the delivered research checkpoint](../checkpoint-2026-09-20/README.md). Its two archives preserve 42 changed or new research files; 2,831 other files remain byte-identical in the base checkpoint. No previously archived path is absent. The archive payload totals 211,295 bytes. [manifest.json](manifest.json) records the base-manifest digest, each archive/member digest and size, and the full-model/runtime exclusions. [create-delta.py](create-delta.py) reproduces the selection against the base checkpoint without modifying original research paths.

The update preserves the export-only and validation-only recovery wrappers, their frozen preparation and process journals, original manifest/job snapshots, all three native validation reports, the prospectively corrected host-attester source and invented CPU proof, and ROOT's independently regraded selection and receipt. The original stale round-7 job, runner, lock and prior attester remain unchanged. The original trained state is preserved by the base checkpoint and the recovery snapshots.

Round 7 trained Google Gemma 3 1B for 512 updates on 970 TRAIN rows. Mean TRAIN loss decreased from 6.7002100954 to 0.0845734478; adapter reload reproduced probabilities exactly. Recovery exported artifact `jev/gemma-3-1b-rfdt-20260920150051-6adca0d2` to a 2,006,573,408-byte GGUF with SHA-256 `d350a4dc0ecf2384b02bb6ab323c27fc12ff6738b5e6279d118f2069bba0040e`. The full model is excluded; the unchanged small trained adapter remains in the base checkpoint.

All 194 native VALIDATION rows ran, with 194 unique IDs, 83 groups, no inference errors and no unrun rows. All three unchanged quality suites failed. Legacy routing was 17/20; developer routing 22/26, clear truth 8/20, and individual scores 13/26 against the required 24/26; diagnosis was 48/56 against the 95% gate. Unknown handling passed. ROOT's prospective host attester independently reconstructed original grades and summaries and confirmed the honest negative. No new TEST inference or role approval occurred.

The host-attester correction was frozen before native validation. It changes only the assumed diagnosis inventory to the original stage's actual 0 string / 28 structured / 28 chat rows and 0 / 2 / 2 rows per group. All original gates remain unchanged. Seven invented CPU regressions passed both independently and in ROOT's rerun before model evaluation.

Native CLI subprocess waits, exit 1, closed output handles and absent owned process groups are recorded. Wrapper owners became defunct under external tool infrastructure; their tool sessions have not supplied terminal exit codes. The native binary fingerprint in the recovery evidence was collected after execution, and these evaluators did not retain raw RPC logits. The checkpoint therefore makes no complete independent native-parity, speed, billing or developer-workflow improvement claim. Training fit did not establish validation reliability.

To inspect or recover this state, use a separate clone or staging directory. Extract the base checkpoint's archives first, then these update archives from that directory:

```sh
tar -xzf /path/to/checkpoint-2026-09-20-update-1/source-01.tar.gz
tar -xzf /path/to/checkpoint-2026-09-20-update-1/evidence-01.tar.gz
```

Members preserve their original `.build/improvement-experiments/...` paths. The manifest verifies exact recovery bytes. Original machine paths in historical reports and wrappers are retained; a fresh machine also needs the documented pinned toolchain and authorized Google base checkpoint. Restore is not an execution or qualification result.

The separate [Grok context pilot](../context-compression-pilot.md) keeps the remote answer model fixed while measuring a harness representation change. It preserves six sample answers and reduces prompt tokens, but increases observed answer latency. That pilot does not clear these local Gemma quality failures.

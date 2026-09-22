# C10 one-step native precision probe status

The native F16/Q8 precision checks have **not completed**. The first local FP32 fusion attempt failed while writing safetensors because local disk space was exhausted (`Unable to write 1207959552 bytes to file`). This is an operational setup failure, not a measured numerical disagreement.

The failed fusion log is retained under `candidate-10-evidence/probe-native/fusion-v1-failed.log`. With explicit parent authorization, only the earlier rebuildable C9-B diagnostic fused directory and this failed C10 partial fusion directory were removed. Their file inventories and hashes/contents of completed manifest JSON files are retained in `cleanup-inventory.json`. Source adapters, source receipts, FP32 reference margins, and earlier C9 F16/Q8 native exports remain intact.

No second fusion or native scoring attempt was launched. The parent separately reported that the C10 probe's source CUDA-to-MLX comparison exceeded the unchanged 0.05 maximum probability delta limit (observed 0.068535872); that upstream precision gate must pass before native probe checks resume. This status report does not independently verify that comparison, qualify the model, or establish effectiveness.

The standalone precision diagnostic now accepts an optional `--purpose` from an explicit two-value enum: rejected C9-B weights or C10 one-step probe. Its default remains the prior rejected C9-B diagnostic purpose. Every result continues to record `qualified: false` and `candidateAdmitted: false`. This descriptive extension changes no comparator tolerance and no frozen training code or model contract. Five CLI tests verify unsupported purpose values are rejected and supported values still require the complete hash-bound input set.

No blind VALID/TEST contents were read and no remote GPU jobs were launched by this task.

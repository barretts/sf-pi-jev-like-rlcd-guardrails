# C10 one-step native precision probe status

The resumed native precision checks completed: **F16 passed; Q8 failed**. The first attempt below remains retained.

| Export | FIT calls completed | Maximum probability delta | Decisive sign flips | Result                 |
| ------ | ------------------: | ------------------------: | ------------------: | ---------------------- |
| F16    |             327/327 |      0.032894627412527244 |                   0 | Pass                   |
| Q8_0   |             327/327 |        0.7811201890113934 |                   8 | Reject this derivative |

The limits remain maximum probability delta ≤0.05 and zero decisive sign flips for reference absolute margins ≥0.5. F16 precision eligibility is independent of the failed Q8 derivative. These one-step probe scores are precision evidence; they do not establish model effectiveness or qualify enforcement.

The corrected FP32 MLX reference uses the explicit `sqrt_hidden_size_in_fp32` embedding normalizer, helper SHA256 `ce62f5b1928d981c3276776f9100f10f252f3904337774be63a74347b46a5256`. Its margins SHA256 is `2e9e1dd657879c378f36d7df690d216a583b2d8a4566172227b038ea9c08e509`. The byte-identical probe adapter SHA256 is `6d4e010adc063f5e694863859937a2d4fabd4158da294d2f13ca415ba0136766`. F16 SHA256 is `dd63ae566312a16ee1fe8a657ff5884cb60e20248239af20994f1305ec50fa86`; Q8 SHA256 is `b60410d2a2cdecd94e4e1b696b60b911f91bb90ffd60dcb98f4407fc78808e34`. Both runs verified pinned FIT bytes, reference bytes, private diagnostic artifact identity, and native binary hash before/after scoring. Q8 used the pinned C9 quantizer with `--leave-output-tensor` and no importance matrix. All raw records and the completed fusion manifest are retained alongside the failure below. The first local FP32 fusion attempt failed while writing safetensors because local disk space was exhausted (`Unable to write 1207959552 bytes to file`). This is an operational setup failure, not a measured numerical disagreement.

The failed fusion log is retained under `candidate-10-evidence/probe-native/fusion-v1-failed.log`. With explicit parent authorization, only the earlier rebuildable C9-B diagnostic fused directory and this failed C10 partial fusion directory were removed. Their file inventories and hashes/contents of completed manifest JSON files are retained in `cleanup-inventory.json`. Source adapters, source receipts, FP32 reference margins, and earlier C9 F16/Q8 native exports remain intact.

At the initial hold point, no second fusion or native scoring attempt had been launched. After the corrected upstream reference passed, the parent authorized fusion v2 and both native checks reported above. The parent separately reported that the C10 probe's source CUDA-to-MLX comparison exceeded the unchanged 0.05 maximum probability delta limit (observed 0.068535872); that upstream precision gate must pass before native probe checks resume. This status report does not independently verify that comparison, qualify the model, or establish effectiveness.

The standalone precision diagnostic now accepts an optional `--purpose` from an explicit two-value enum: rejected C9-B weights or C10 one-step probe. Its default remains the prior rejected C9-B diagnostic purpose. Every result continues to record `qualified: false` and `candidateAdmitted: false`. This descriptive extension changes no comparator tolerance and no frozen training code or model contract. Five CLI tests verify unsupported purpose values are rejected and supported values still require the complete hash-bound input set.

No blind VALID/TEST contents were read and no remote GPU jobs were launched by this task.

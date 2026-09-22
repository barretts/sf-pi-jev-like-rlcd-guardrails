# C8 final-host VALID fake shadow comparison

`fake-shadow-report.json` is the complete operation-free 96-case VALID replay
from evaluator commit `a45ced409e46d62a8cfee69a1aad99447842e05b`. It used
the final model-free VALID-only source, sf-pi's shadow bridge, authored org and
browser facts, and an always-confirm **fake** provider. No model or external
tool operation ran. Its SHA-256 is
`84db721ed57b800815317c691a4d7b90821e8f0ff882714ad6b9763bbd0cfbbc`.

| Bound component           | SHA or commit                                                      |
| ------------------------- | ------------------------------------------------------------------ |
| VALID corpus              | `83c6568bca079f1148feb92ee2b2ecc87f72cfc0d2466ac4838b58cec6bb2714` |
| Model-free host preflight | `6e1105e8b78ee030d61b9321fd51cd6bb95978d3f504ff966b5232f99bd04bba` |
| Final sf-pi host          | `bdbf6292f383a8b2e12cd236aafb2be9c335f463`                         |
| Final host baseline       | `1e5e8167f25ce8fb440d7bf8054be44a27d67c0fa71272a5558b01204c24bd0e` |
| VALID agent label audit   | `504656ca22634e09e2bbf58611ce6b566f5905a759121644017116e68e19f2f2` |

All 96 original-operation hashes matched the independently authored model-free
preflight. The shadow bridge routed 59 requests to the fake provider and all 59
answered; six used explicit pre-model fallback, and three exact hard blocks
remained code-owned. There were no attempted-model fallbacks or replay errors.
The existing engine matched 84/96 authored labels, with 11 unsafe automatic
allows and one benign interruption. The fake always-confirm decisions matched
57/96, with zero unsafe automatic allows and 39 benign interruptions. These
fake-provider counts and timings do **not** measure a trained candidate.

The timer for each host row begins before policy configuration, baseline
evaluation, model request preparation, and queueing. Cold initialization is
reported separately. Real VALID scoring remains locked until the final
TRAIN-CAL cutoff receipt and held-out qualification runtime are frozen. The
agent label audit reports zero suspected mislabels on this revised corpus but
explicitly records `humanSignoff: false`.

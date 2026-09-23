# sf-pi-jev-guardrails third-party notices

[LICENSE](./LICENSE) covers this project's first-party code under Apache 2.0.
Installed dependencies, native-runtime components and model weights keep their
own licenses. The source package excludes local weights, the vendor checkout
and compiled native binaries.

| Component                                          | License                                             | Source or retained notice                                                                                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| llama.cpp and ggml                                 | MIT, with notices for incorporated components       | [Pinned revision `f072b103714dfa1eee531f80b24512faf38e3dd2`](https://github.com/ggml-org/llama.cpp/tree/f072b103714dfa1eee531f80b24512faf38e3dd2) and its `LICENSE`                        |
| nlohmann JSON and native vendor components         | Their respective MIT, BSD and public-domain notices | Exact pinned llama.cpp `vendor/` sources; the Desktop bundle's `licenses/` directory contains the supplied binary's notices                                                                |
| Pi SDK and its installed dependencies              | MIT and dependencies' respective licenses           | [Pi source](https://github.com/earendil-works/pi), installed package license files and dependency lock                                                                                     |
| MLX and MLX-LM                                     | MIT                                                 | [MLX](https://github.com/ml-explore/mlx), [MLX-LM](https://github.com/ml-explore/mlx-lm); local export environment pins MLX-LM commit `9d1e356e7cc6549e7d1697adabe2ea01ff8e062c`           |
| Transformers, Hugging Face Hub and safetensors     | Apache 2.0                                          | [Transformers](https://github.com/huggingface/transformers), [Hugging Face Hub](https://github.com/huggingface/huggingface_hub), [safetensors](https://github.com/huggingface/safetensors) |
| PyTorch, used by CUDA training and GGUF conversion | BSD-style, with incorporated component notices      | [PyTorch](https://github.com/pytorch/pytorch) and installed package notices                                                                                                                |
| Google Gemma 3 1B Instruct and C11 derivatives     | Gemma Terms of Use                                  | [Gemma terms](https://ai.google.dev/gemma/terms), bundle `GemmaTerms.txt`, `PROHIBITED_USE_POLICY.txt` and model notices                                                                   |

The optional Pi peer supplies the extension host API. Guardrail inference uses
Node built-ins and the separate native executable; local training/export uses
the pinned Python environment. Installing dependencies preserves their license
files. This inventory does not replace those license texts or the additional
notices incorporated in a built executable.

Native builds fetch the exact llama.cpp revision above. When sharing a native
binary, preserve the relevant notices from that build's inputs. The supplied
Apple-silicon binary's bundle carries llama.cpp/ggml, CPU/Metal, nlohmann JSON,
cpp-httplib, rotate-bits, xxHash, SHA-1/SHA-256, subprocess and related notices.

The original training checkpoint is `google/gemma-3-1b-it` at revision
`dcc83ea841ab6100d6b47a070329e1ba4cf78752`. C11 `jev/c11-step-256` is a fully
merged, locally trained derivative; its model card records the changes, base
lineage, checksum and qualification limits.
Gemma terms and access requirements also apply to exported C11 artifacts.
The code license does not relicense weights. Keep the model card, terms,
prohibited-use policy and third-party notices with any shared model bundle.

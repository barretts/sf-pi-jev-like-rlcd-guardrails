# Third-party software and models

The Apache 2.0 license in LICENSE covers this project's first-party code.
Installed dependencies, native-runtime components, models, and templates
retain their own licenses. This source package does not redistribute weights,
the native vendor checkout, or built native executables.

| Component                                        | License            | Source                                                                                      |
| ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------- |
| llama.cpp and ggml                               | MIT                | https://github.com/ggml-org/llama.cpp/blob/f072b103714dfa1eee531f80b24512faf38e3dd2/LICENSE |
| nlohmann JSON                                    | MIT                | https://github.com/nlohmann/json/blob/develop/LICENSE.MIT                                   |
| Fastify, Swagger and Swagger UI plugins          | MIT                | Installed package LICENSE files                                                             |
| TypeBox                                          | MIT                | Installed package license file                                                              |
| pi SDK, agent core and TUI                       | MIT                | https://github.com/earendil-works/pi                                                        |
| MLX and MLX-LM                                   | MIT                | https://github.com/ml-explore/mlx and https://github.com/ml-explore/mlx-lm                  |
| Transformers                                     | Apache 2.0         | https://github.com/huggingface/transformers                                                 |
| PyTorch, used for GGUF conversion                | BSD-style          | https://github.com/pytorch/pytorch/blob/main/LICENSE                                        |
| Google Gemma 3 1B/4B and trained derivatives     | Gemma Terms of Use | https://ai.google.dev/gemma/terms                                                           |
| Google Gemma 4 QAT weights and official template | Apache 2.0         | Pinned Google model repositories in models/registry.json                                    |

Native builds fetch the exact llama.cpp revision. Dependency installation
preserves the dependencies' license files. If redistributing a built executable
or dependencies, preserve all relevant notices from the exact build inputs;
this inventory does not replace their license texts.

Gemma 3 terms and access requirements also apply to exported RFDT artifacts.
Artifacts stay local by default and are excluded from Git and npm packaging.
Training/export manifests identify modifications, base lineage and checksums;
the code license does not relicense model weights.

The optional Gemma 3 4B Instruct classifier candidate uses the F16 GGUF
conversion published by ggml-org, pinned to revision
`d0976223747697cb51e056d85c532013931fe52e` in the model registry. Its
[publisher model card](https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF/blob/d0976223747697cb51e056d85c532013931fe52e/README.md)
identifies [Google Gemma 3 4B Instruct](https://huggingface.co/google/gemma-3-4b-it)
as the base model and carries the Gemma license. The classifier uses text
inference; the separate image projection artifact is not downloaded.
Downloading requires explicit acceptance of the external Gemma Terms of Use.
The public GGUF endpoint does not grant or automatically accept access to
Google's separately gated training checkpoint. Gemma 3 1B remains the default;
this registry entry permits an explicit candidate selection and does not
establish validation, test, or promotion results.

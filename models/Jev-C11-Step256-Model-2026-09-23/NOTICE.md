Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms

# Jev C11 step-256 bundle notice

MODIFIED MODEL: `model.gguf` is a trained and modified Google Gemma derivative. The Jev C11 step-256 adapter was merged into Google Gemma 3 1B Instruct, and the merged weights were exported to F16 GGUF. It is not an unmodified Google release. The prominent accompanying per-model notice is `model.gguf.NOTICE.txt`.

- Model identifier: `jev/c11-step-256`
- Base model: `google/gemma-3-1b-it`
- Base revision: `dcc83ea841ab6100d6b47a070329e1ba4cf78752`
- Adapter SHA-256: `91e6d3a90369d90f34fd760c52dc27c97212087ede99aea9f8c861723bbe06b2`
- Export tokenizer modification: the untrained, out-of-range `<image_soft_token>` placeholder at token ID 262144 was removed; the model vocabulary remains 262144 entries.

The model and its use, reproduction, modification, and redistribution are governed by `GemmaTerms.txt`. The use restrictions in Section 3.2 of those terms are incorporated into these model distribution terms: users must comply with `PROHIBITED_USE_POLICY.txt` and applicable laws and regulations. Subsequent distribution must preserve the Gemma agreement, required notice, use restrictions, and prominent notices identifying modified files, as required by Section 3.1.

Simple Jev for TypeScript and pi
Copyright 2026 Barrett Sonntag

The included first-party Simple Jev runtime code is licensed under Apache 2.0; see `licenses/APACHE-2.0.txt` and the preserved project notice in `licenses/Simple-Jev-PROJECT-NOTICE.txt`. That license does not relicense the Gemma model weights. The included native runtime uses llama.cpp/ggml and third-party code under their own licenses, retained in `licenses/`. Its pinned llama.cpp revision is `f072b103714dfa1eee531f80b24512faf38e3dd2`.

The preserved project third-party inventory describes the source package; its statements about weights not being included in that source package do not describe this separate model bundle.

Official sources:
- Gemma Terms of Use: https://ai.google.dev/gemma/terms
- Gemma Prohibited Use Policy: https://ai.google.dev/gemma/prohibited_use_policy

The model and generated outputs are provided as is, subject to the disclaimers in the Gemma Terms of Use. This derivative does not imply Google endorsement.

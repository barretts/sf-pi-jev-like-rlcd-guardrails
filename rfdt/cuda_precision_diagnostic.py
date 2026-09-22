#!/usr/bin/env python3
"""FIT-only frozen FP32 precision diagnosis; never admits a candidate."""
import argparse
import json
from pathlib import Path
import time
import worker


def run(args):
    output = Path(args.output).resolve()
    if output.exists():
        raise ValueError("Use a fresh diagnostic directory")
    data = Path(args.data).resolve()
    import cuda_worker
    cuda_worker.exact_file(data, cuda_worker.TRAIN_SHA256)
    rows = worker.read_rows(data, "train")
    if len(rows) != 327:
        raise ValueError("Expected complete admitted FIT inventory")
    output.mkdir(parents=True)
    started = time.monotonic()
    try:
        if args.backend == "cuda":
            import torch
            from transformers import Gemma3ForCausalLM
            from safetensors.torch import load_file
            free, total = torch.cuda.mem_get_info()
            if free < 7_000_000_000:
                raise ValueError("Insufficient headroom for bounded FP32 diagnosis")
            torch.cuda.set_per_process_memory_fraction(6_500_000_000 / total)
            torch.cuda.reset_peak_memory_stats()
            torch.backends.cuda.matmul.allow_tf32 = False
            torch.backends.cudnn.allow_tf32 = False
            worker.verify_local_base(Path(args.model))
            model = Gemma3ForCausalLM.from_pretrained(args.model, local_files_only=True,
                dtype=torch.float32, attn_implementation="eager").to("cuda:0")
            model.config.use_cache = False
            trainable = cuda_worker.attach_lora(model)
            weights = load_file(str(Path(args.adapter) / "adapters.safetensors"), device="cuda:0")
            cuda_worker.check_adapter_tensors(weights)
            with torch.no_grad():
                for name, value in trainable:
                    value.copy_(weights[name])
            actual, _ = cuda_worker.score_rows(model, rows, torch.device("cuda:0"))
            memory = cuda_worker.memory_sample(torch.device("cuda:0"), free)
        else:
            import mlx.core as mx
            from mlx.utils import tree_map
            model, tokenizer, _ = worker.load_model(Path(args.model), Path(args.adapter))
            worker.verify_prompt_parity(tokenizer, rows)
            model.update(tree_map(lambda p: p.astype(mx.float32)
                if mx.issubdtype(p.dtype, mx.floating) else p, model.parameters()))
            actual = {row["source_id"]: float(worker.selected_logit_margin(model,
                mx.array([row["prompt_token_ids"]]), mx.array(row["allowed_token_ids"])).item())
                for row in rows}
            memory = {"peak_memory_bytes": mx.get_peak_memory()}
        with (output / "margins.jsonl").open("x") as handle:
            for row in rows:
                handle.write(json.dumps({"source_id": row["source_id"],
                    "tokens": len(row["prompt_token_ids"]), "margin": actual[row["source_id"]]}) + "\n")
        result = {"qualified": False, "purpose": "FIT_only_FP32_precision_diagnosis",
            "backend": args.backend, "base_precision": "float32", "lora_precision": "float32",
            "attention": "eager" if args.backend == "cuda" else "mlx_default",
            "tf32": False, "rows": len(actual), "elapsed_seconds": time.monotonic()-started,
            "data_sha256": worker.sha256(data),
            "adapter_sha256": worker.sha256(Path(args.adapter)/"adapters.safetensors"),
            "source_sha256": worker.sha256(Path(__file__)), "memory": memory}
        worker.write_json(output / "receipt.json", result)
        worker.write_json(output / "exit.json", {"ok": True})
        return result
    except BaseException as error:
        worker.write_json(output / "exit.json", {"ok": False, "error": str(error)})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=["cuda", "mlx"], required=True)
    for name in ("model", "adapter", "data", "output"):
        parser.add_argument("--"+name, required=True)
    print(json.dumps(run(parser.parse_args())))

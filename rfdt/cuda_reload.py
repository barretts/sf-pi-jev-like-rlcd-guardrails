#!/usr/bin/env python3
"""FIT-only saved-adapter reload diagnostic on the original CUDA backend."""
import argparse
import json
from pathlib import Path
import time

import cuda_worker
import worker


def run(args):
    import torch
    from safetensors.torch import load_file
    source, inputs, output = map(lambda p: Path(p).resolve(), (args.source, args.inputs, args.output))
    if output.exists():
        raise ValueError("Use a fresh reload diagnostic directory")
    source_receipt = source / "run/receipt.json"
    if worker.sha256(source_receipt) != args.receipt_sha256:
        raise ValueError("Source receipt changed")
    receipt = json.loads(source_receipt.read_text())
    if receipt["mode"] != "train" or receipt["steps"] != 256 or receipt["qualified"] is not False:
        raise ValueError("Expected the completed CUDA training experiment")
    train = inputs / "fit/prepared-train.jsonl"
    cuda_worker.exact_file(train, cuda_worker.TRAIN_SHA256)
    rows = worker.read_rows(train, "train")
    adapter = source / "run/adapter/adapters.safetensors"
    cuda_worker.exact_file(adapter, receipt["adapter_sha256"])
    reference_path = source / "run/fit-margins.jsonl"
    cuda_worker.exact_file(reference_path, receipt["fit_margins_sha256"])
    expected = {row["source_id"]: row["final"] for row in map(json.loads, reference_path.read_text().splitlines())}
    output.mkdir(parents=True)
    started = time.monotonic()
    try:
        device = torch.device("cuda:0")
        free, total = torch.cuda.mem_get_info()
        if free < 4_500_000_000:
            raise ValueError("Insufficient shared-host CUDA headroom")
        torch.cuda.set_per_process_memory_fraction(6_500_000_000 / total)
        torch.cuda.reset_peak_memory_stats()
        model = cuda_worker.load_model(inputs / "base", device)
        trainable = cuda_worker.attach_lora(model)
        weights = load_file(str(adapter), device="cuda:0")
        cuda_worker.check_adapter_tensors(weights)
        with torch.no_grad():
            for name, parameter in trainable:
                parameter.copy_(weights[name])
        actual, _ = cuda_worker.score_rows(model, rows, device)
        delta = max(abs(expected[key] - actual[key]) for key in expected)
        result = {"purpose": "cuda_saved_adapter_fit_reload_only", "qualified": False,
                  "source_receipt_sha256": args.receipt_sha256, "adapter_sha256": receipt["adapter_sha256"],
                  "rows": len(actual), "max_margin_delta": delta, "margin_delta_limit": 1e-5,
                  "ok": len(actual) == 327 and delta <= 1e-5,
                  "attention_implementation": model.config._attn_implementation,
                  "memory": cuda_worker.memory_sample(device, free)}
        with (output / "margins.jsonl").open("x") as handle:
            for key, value in actual.items():
                handle.write(json.dumps({"source_id": key, "expected": expected[key], "actual": value}) + "\n")
        worker.write_json(output / "receipt.json", result)
        worker.write_json(output / "exit.json", {"ok": result["ok"], "elapsed_seconds": time.monotonic() - started})
        return result
    except BaseException as error:
        worker.write_json(output / "exit.json", {"ok": False, "error": str(error), "elapsed_seconds": time.monotonic() - started})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "inputs", "output", "receipt-sha256"):
        parser.add_argument("--" + name, required=True)
    print(json.dumps(run(parser.parse_args()), allow_nan=False))

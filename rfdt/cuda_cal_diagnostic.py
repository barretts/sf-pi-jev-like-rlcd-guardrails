#!/usr/bin/env python3
"""Score frozen compiled TRAIN-CAL inputs on a saved CUDA adapter.

This reports source-model predictions only; it cannot qualify the native
integration or conceal a failed export/precision bridge.
"""
import argparse
import json
from pathlib import Path
import time

import worker
import cuda_worker


def run(args):
    import torch
    from safetensors.torch import load_file
    source, inputs, data, output = [Path(p).resolve() for p in (args.source, args.inputs, args.data, args.output)]
    if output.exists(): raise ValueError("Use a new diagnostic run directory")
    cuda_worker.exact_file(source / "run/receipt.json", args.receipt_sha256)
    receipt = json.loads((source / "run/receipt.json").read_text())
    if receipt["mode"] != "train" or receipt["steps"] != 256 or receipt["qualified"] is not False:
        raise ValueError("Expected the completed CUDA training experiment")
    content = cuda_worker.exact_file(data, args.data_sha256)
    document = json.loads(content)
    rows = document["rows"]
    if document["purpose"] != "raw_CUDA_TRAIN_CAL_diagnostic_only" or len(rows) != 42:
        raise ValueError("Expected the frozen 42-case TRAIN-CAL diagnostic")
    if len({row["id"] for row in rows}) != 42: raise ValueError("Duplicate CAL input")
    worker.verify_local_base(inputs / "base")
    adapter = source / "run/adapter/adapters.safetensors"
    cuda_worker.exact_file(adapter, receipt["adapter_sha256"])
    output.mkdir(parents=True)
    started = time.monotonic()
    try:
        device = torch.device("cuda:0")
        free, total = torch.cuda.mem_get_info()
        if free < 4_500_000_000: raise ValueError("Insufficient shared-host headroom")
        torch.cuda.set_per_process_memory_fraction(6_500_000_000 / total)
        torch.cuda.reset_peak_memory_stats()
        model = cuda_worker.load_model(inputs / "base", device)
        trainable = cuda_worker.attach_lora(model)
        weights = load_file(str(adapter), device="cuda:0")
        cuda_worker.check_adapter_tensors(weights)
        with torch.no_grad():
            for name, parameter in trainable: parameter.copy_(weights[name])
        model.eval()
        cold_ms = (time.monotonic() - started) * 1000
        records = []
        with torch.no_grad():
            for row in rows:
                if not 0 < len(row["tokens"]) <= 2048 or len(row["allowed_token_ids"]) != 2:
                    raise ValueError("Invalid bounded selected-token request")
                begin = time.monotonic()
                margin = float(cuda_worker.selected_margin(model, {
                    "prompt_token_ids": row["tokens"], "allowed_token_ids": row["allowed_token_ids"]}, device).item())
                torch.cuda.synchronize()
                records.append({"id": row["id"], "allowScore": worker.sigmoid(margin), "margin": margin,
                                "modelElapsedMs": (time.monotonic() - begin) * 1000})
        result = {"purpose": "raw_CUDA_TRAIN_CAL_diagnostic_only", "qualified": False,
                  "nativeBridgeQualified": False, "calibration": "uncalibrated",
                  "adapterSha256": receipt["adapter_sha256"], "sourceReceiptSha256": args.receipt_sha256,
                  "compiledInputsSha256": args.data_sha256, "protocolSha256": document["protocolSha256"],
                  "coldModelInitializationMs": cold_ms, "admitted": 42, "answered": len(records),
                  "latencyBasis": "CUDA tensor preparation and inference only; no Pi hook, network, or queue",
                  "memory": cuda_worker.memory_sample(device, free), "records": records}
        worker.write_json(output / "receipt.json", result)
        worker.write_json(output / "exit.json", {"ok": True, "elapsed_seconds": time.monotonic() - started})
        return {key: value for key, value in result.items() if key != "records"}
    except BaseException as error:
        worker.write_json(output / "exit.json", {"ok": False, "error": str(error)})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "inputs", "data", "output", "receipt-sha256", "data-sha256"):
        parser.add_argument("--" + name, required=True)
    print(json.dumps(run(parser.parse_args()), allow_nan=False))

#!/usr/bin/env python3
"""FIT-only embedding-scale A/B proof; this does not qualify a candidate."""
import argparse
import json
from pathlib import Path
import time
import cuda_worker
import cuda_import
import worker


def run(args):
    import mlx.core as mx
    from mlx.utils import tree_map
    import gemma3_fp32
    output = Path(args.output).resolve()
    if output.exists(): raise ValueError('Use fresh diagnostic output')
    data, reference, adapter = map(Path, (args.data, args.reference, args.adapter))
    cuda_worker.exact_file(data, cuda_worker.TRAIN_SHA256)
    cuda_worker.exact_file(reference, args.reference_sha256)
    cuda_worker.exact_file(adapter / 'adapters.safetensors', args.adapter_sha256)
    rows = worker.read_rows(data, 'train')
    references = [json.loads(line) for line in reference.read_text().splitlines()]
    expected = {row['source_id']: row['final'] for row in references}
    if len(rows) != 327 or len(references) != 327 or len(expected) != 327 or set(expected) != {r['source_id'] for r in rows}:
        raise ValueError('Expected complete fixed327 FIT inventory')
    output.mkdir(parents=True)
    started = time.monotonic()
    try:
        model, tokenizer, _ = worker.load_model(Path(args.model), adapter)
        worker.verify_prompt_parity(tokenizer, rows)
        model.update(tree_map(lambda p: p.astype(mx.float32) if mx.issubdtype(p.dtype, mx.floating) else p, model.parameters()))
        reports = {}
        for arm in ('original_bf16_normalizer', 'explicit_fp32_normalizer'):
            if arm == 'explicit_fp32_normalizer': gemma3_fp32.install_fp32_embedding_scale(model)
            margins = {row['source_id']: float(worker.selected_logit_margin(model,
                mx.array([row['prompt_token_ids']]), mx.array(row['allowed_token_ids'])).item()) for row in rows}
            with (output / (arm + '.jsonl')).open('x') as handle:
                for row in rows:
                    handle.write(json.dumps({'source_id':row['source_id'], 'tokens':len(row['prompt_token_ids']), 'margin':margins[row['source_id']]}, allow_nan=False)+'\n')
            reports[arm] = cuda_import.compare_margins(expected, margins)
        result = {'qualified': False, 'purpose':'FIT_only_embedding_normalizer_AB',
            'rows':327, 'reports':reports, 'elapsed_seconds':time.monotonic()-started,
            'data_sha256':worker.sha256(data), 'reference_sha256':worker.sha256(reference),
            'adapter_sha256':worker.sha256(adapter/'adapters.safetensors'),
            'helper_sha256':worker.sha256(Path(gemma3_fp32.__file__)),
            'script_sha256':worker.sha256(Path(__file__)),
            'worker_sha256':worker.sha256(Path(worker.__file__)),
            'memory':{'peak_memory_bytes':mx.get_peak_memory()},
            'normalizer': {'original':float(mx.array(1152**0.5,mx.bfloat16).item()),
                           'explicit':float(mx.array(1152**0.5,mx.float32).item())}}
        worker.write_json(output/'receipt.json', result)
        worker.write_json(output/'exit.json', {'ok':True, 'comparison_ok':reports['explicit_fp32_normalizer']['ok']})
        return result
    except BaseException as error:
        worker.write_json(output/'exit.json', {'ok':False,'error':str(error)})
        raise


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('model','adapter','adapter-sha256','data','reference','reference-sha256','output'):
        parser.add_argument('--'+name,required=True)
    print(json.dumps(run(parser.parse_args())))

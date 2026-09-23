"""No-GPU tests for current staging, independent watchdog and pinned supervision."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch, Mock

import launch


class LaunchTests(unittest.TestCase):
    def setUp(self):
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)
        births = patch.object(launch, 'process_start_ticks', side_effect=lambda pid: 501 if pid == 101 else 502)
        births.start()
        self.addCleanup(births.stop)

    def prepare(self, root):
        source = Path(launch.__file__).resolve().parent
        code = root / 'inputs/code'
        code.mkdir(parents=True)
        for name in launch.CODE_NAMES:
            (code / name).write_bytes((source / name).read_bytes())
        recipe = json.loads((source / 'recipe.json').read_text())
        recipe['source_sha256'] = {name: launch.digest(code / name) for name in launch.CODE_NAMES}
        (code / 'recipe.json').write_text(json.dumps(recipe))
        return argparse.Namespace(inputs=str(root / 'inputs'), run_root=str(root / 'run'),
            adapter_tag='pinned', mode='train', recipe_sha256=launch.digest(code / 'recipe.json'))

    def test_exact_code_inventory_rejects_missing_file_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.prepare(Path(temporary))
            code = Path(args.inputs) / 'code'
            hashes = {name: launch.digest(code / name) for name in launch.CODE_NAMES}
            with self.assertRaisesRegex(ValueError, 'exactly'):
                launch.verify_code(code, {})
            (code / 'sampler.py').unlink()
            (code / 'sampler.py').symlink_to(code / 'contract.py')
            with self.assertRaisesRegex(ValueError, 'regular'):
                launch.verify_code(code, hashes)

    def test_staged_modules_import_without_historical_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.prepare(Path(temporary))
            result = subprocess.run([sys.executable, '-B', '-c',
                'import launch, campaign, contract, cuda_train, sampler, memory_monitor; print("current imports")'],
                cwd=Path(args.inputs) / 'code', capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'current imports')

    def test_recipe_pin_rejects_before_sampling_or_spawn(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.prepare(Path(temporary))
            args.recipe_sha256 = 'f' * 64
            with patch.object(launch.monitor, 'sample') as sample, patch.object(launch.subprocess, 'Popen') as process:
                with self.assertRaises(ValueError): launch.run(args)
            sample.assert_not_called(); process.assert_not_called()
            self.assertFalse(Path(args.run_root).exists())

    def test_local_stage_copies_verified_regular_inputs_without_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = Path(launch.__file__).resolve().parent
            source = root / 'source'
            source.mkdir()
            for name in launch.CODE_NAMES | {'recipe.json'}:
                (source / name).write_bytes((current / name).read_bytes())
            recipe = json.loads((source / 'recipe.json').read_text())
            recipe['source_sha256'] = {name: launch.digest(source / name) for name in launch.CODE_NAMES}
            (source / 'recipe.json').write_text(json.dumps(recipe))
            (source / 'data').mkdir()
            for name in ('prepared-fit.jsonl', 'pairs.json', 'families.json', 'objective.json'):
                (source / 'data' / name).write_text('immutable ' + name)
            base = root / 'google-base'
            base.mkdir()
            for name in ('model.safetensors', 'config.json', 'tokenizer.json', 'tokenizer_config.json'):
                (base / name).write_text('original ' + name)
            hashes = {name: launch.digest(base / name) for name in launch.objective.BASE_HASHES}
            args = argparse.Namespace(training_dir=source, base=base, output=root / 'inputs')
            with patch.object(launch.objective, 'BASE_HASHES', hashes), \
                    patch.object(launch.objective, 'load_contract', return_value=([{}] * 327, [{}] * 86, {} , {})), \
                    patch.object(launch.subprocess, 'Popen') as process, patch.object(launch.monitor, 'sample') as sample:
                receipt = launch.stage(args)
            process.assert_not_called(); sample.assert_not_called()
            self.assertEqual(receipt['fit_rows'], 327)
            self.assertEqual(receipt['explicit_pairs'], 86)
            self.assertEqual(receipt['recipe_sha256'], launch.digest(source / 'recipe.json'))
            self.assertEqual((args.output / 'fit/prepared-train.jsonl').read_bytes(),
                             (source / 'data/prepared-fit.jsonl').read_bytes())
            manifest = json.loads((args.output / 'base/base-manifest.json').read_text())
            self.assertEqual(manifest['base_model'], 'google/gemma-3-1b-it')
            for name, checksum in manifest['files'].items():
                self.assertEqual(launch.digest(args.output / 'base' / name), checksum)
            self.assertTrue(all(not path.is_symlink() for path in args.output.rglob('*')))
            with self.assertRaisesRegex(ValueError, 'already exists'): launch.stage(args)

    def test_hash_tampering_rejects_before_monitor_or_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self.prepare(root)
            (root / 'inputs/code/contract.py').write_text('tampered')
            with patch.object(launch.monitor, 'sample') as sample, patch.object(launch.subprocess, 'Popen') as process:
                with self.assertRaisesRegex(ValueError, 'checksum'):
                    launch.run(args)
            sample.assert_not_called()
            process.assert_not_called()
            self.assertFalse(Path(args.run_root).exists())

    def test_train_and_probe_launch_exact_owned_watchdog_with_total_cap(self):
        for mode, steps in [('train', '1024'), ('probe', '1')]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary))
                args.mode = mode
                with patch.object(launch.objective, 'load_contract'), patch.object(
                    launch.monitor, 'sample', return_value=(7_000_000_000, 30)
                ), patch.object(launch.subprocess, 'Popen', side_effect=[Mock(pid=101), Mock(pid=102)]) as process:
                    receipt = launch.run(args)
                command = receipt['worker_command']
                self.assertEqual(command[command.index('--steps') + 1], steps)
                self.assertEqual(command[command.index('--allocator-cap-bytes') + 1], '6500000000')
                watchdog = receipt['watchdog_command']
                self.assertEqual(watchdog[watchdog.index('--stop-total-dedicated-bytes') + 1], '16000000000')
                self.assertEqual(watchdog[watchdog.index('--worker') + 1], command[1])
                self.assertEqual(receipt['campaign_sha256'], args.recipe_sha256)
                self.assertEqual(receipt['stop_total_dedicated_bytes'], 16_000_000_000)
                self.assertEqual(receipt['worker_pid'], 102)
                self.assertEqual(receipt['worker_start_ticks'], 502)
                self.assertEqual(receipt['watchdog_start_ticks'], 501)
                self.assertTrue(all(call.kwargs['stdin'] == launch.subprocess.DEVNULL for call in process.call_args_list))

    def test_existing_root_and_total_usage_reject_without_spawn(self):
        for existing in [False, True]:
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary))
                if existing:
                    Path(args.run_root).mkdir()
                with patch.object(launch.objective, 'load_contract'), patch.object(
                    launch.monitor, 'sample', return_value=(16_000_000_000, 0)
                ), patch.object(launch.subprocess, 'Popen') as process:
                    with self.assertRaises(ValueError):
                        launch.run(args)
                process.assert_not_called()

    def snapshot_fixture(self, root):
        now = launch.time.time()
        args = self.prepare(root)
        code = root / 'inputs/code'
        recipe = json.loads((code / 'recipe.json').read_text())
        hashes = recipe['source_sha256']
        checkpoint = root / 'run/checkpoints/step-128'
        (checkpoint / 'adapter').mkdir(parents=True)
        (checkpoint / 'adapter/adapters.safetensors').write_bytes(b'complete checkpoint adapter')
        config = {'fine_tune_type': 'lora', 'num_layers': 26, 'lora_parameters': launch.contract.LORA}
        (checkpoint / 'adapter/adapter_config.json').write_text(json.dumps(config))
        margins = ''.join(json.dumps({'source_id': str(index), 'initial': 0.0, 'final': 1.0}) + '\n'
                          for index in range(327))
        (checkpoint / 'fit-margins.jsonl').write_text(margins)
        reload = {'ok': True, 'rows': 327, 'max_margin_delta': 0.0, 'margin_delta_limit': 1e-5,
            'precision': recipe['precision'],
            'adapter_sha256': launch.digest(checkpoint / 'adapter/adapters.safetensors'),
            'fit_margins_sha256': launch.digest(checkpoint / 'fit-margins.jsonl')}
        (checkpoint / 'reload.json').write_text(json.dumps(reload))
        objective = json.loads((Path(launch.__file__).parent / 'data/objective.json').read_text())
        plan = {'experiment': 'c11', 'mode': 'train', 'steps': 128, 'checkpoint_step': 128,
            'campaign_steps': 1024, 'campaign': recipe, 'campaign_sha256': args.recipe_sha256,
            'source_sha256': hashes['campaign.py'], 'contract_sha256': hashes['contract.py'],
            'objective_worker_sha256': hashes['cuda_train.py'], 'precision': recipe['precision'],
            'initialization': recipe['initialization'], 'sampler_source_sha256': hashes['sampler.py'],
            'source_objective_plan': objective,
            'objective': {**objective, 'purpose': 'c11_train_only', 'sampler': recipe['sampler'], 'steps': 1024},
            'budget_bytes': 8_000_000_000, 'allocator_cap_bytes': 6_500_000_000,
            'inputs': {'train': launch.objective.TRAIN_SHA256, 'pairs': launch.objective.PAIR_SHA256,
                'families': launch.objective.FAMILY_SHA256, 'plan': launch.objective.PLAN_SHA256,
                'base': launch.objective.BASE_HASHES}}
        receipt = {'checkpoint_step': 128, 'steps': 128, 'mode': 'train', 'qualified': False,
            'adapter_changed': True, 'source': plan, 'saved_adapter_reload': reload,
            'adapter_sha256': reload['adapter_sha256'], 'fit_margins_sha256': reload['fit_margins_sha256'],
            'pre_step_placement': {'parameters': 444, 'buffers': 5, 'gradients': 104},
            'post_step_placement': {'parameters': 444, 'buffers': 5, 'gradients': 0, 'optimizer_tensors': 208},
            'memory': {'peak_reserved_bytes': 2_500_000_000}}
        (checkpoint / 'plan.json').write_text(json.dumps(plan))
        (checkpoint / 'receipt.json').write_text(json.dumps(receipt))
        (checkpoint / 'exit.json').write_text(json.dumps({'ok': True, 'steps_completed': 128, 'completed_time_unix': now - 7}))
        launch_record = {'version': 2, 'purpose': 'guardrail_cuda_fit_only_training', 'mode': 'train',
            'run_root': str(root.resolve()), 'inputs': str((root / 'inputs').resolve()),
            'recipe_sha256': args.recipe_sha256, 'campaign_sha256': args.recipe_sha256,
            'code_sha256': hashes, 'launcher_sha256': hashes['launch.py'], 'worker_sha256': hashes['campaign.py'],
            'watchdog_sha256': hashes['memory_monitor.py'], 'monitor_sha256': hashes['memory_monitor.py'],
            'contract_sha256': hashes['contract.py'], 'objective_worker_sha256': hashes['cuda_train.py'],
            'prepared_fit_sha256': launch.objective.TRAIN_SHA256, 'plan_sha256': launch.objective.PLAN_SHA256,
            'worker_pid': 123, 'watchdog_pid': 124, 'worker_start_ticks': 1001, 'watchdog_start_ticks': 1002,
            'baseline_dedicated_bytes': 7_000_000_000, 'baseline_shared_bytes': 30,
            **launch.MEMORY_LIMITS}
        (root / 'launch.json').write_text(json.dumps(launch_record))
        rows = [{'time_unix': t, 'elapsed_seconds': t - 5, 'dedicated_bytes': 9_000_000_000,
                 'shared_bytes': 40, 'dedicated_delta_bytes': 2_000_000_000, 'shared_delta_bytes': 10}
                for t in [now - 12, now - 2]]
        prefix = ''.join(json.dumps(row) + '\n' for row in rows).encode()
        (root / 'memory.jsonl').write_bytes(prefix + b'{"partial":')
        guardian = [{'status': 'watching', 'worker_pid': 123, 'watchdog_pid': 124,
            'worker_start_ticks': 1001, 'watchdog_start_ticks': 1002, 'time_unix': now - 13},
            {'status': 'healthy', 'sample': rows[-1], 'journalAgeSeconds': 0.5, 'time_unix': now - 1.5}]
        (root / 'root-guardian.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in guardian))
        return checkpoint, rows, prefix

    def final_snapshot_fixture(self, root):
        checkpoint, rows, _ = self.snapshot_fixture(root)
        final = checkpoint.with_name('step-1024')
        checkpoint.rename(final)
        plan = json.loads((final / 'plan.json').read_text())
        plan.update({'steps': 1024, 'checkpoint_step': 1024})
        receipt = json.loads((final / 'receipt.json').read_text())
        receipt.update({'steps': 1024, 'checkpoint_step': 1024, 'source': plan})
        leaf_exit = json.loads((final / 'exit.json').read_text())
        leaf_exit['steps_completed'] = 1024
        for name, data in (('plan.json', plan), ('receipt.json', receipt), ('exit.json', leaf_exit)):
            (final / name).write_text(json.dumps(data))
        root_exit = {'ok': True, 'steps_completed': 1024, 'elapsed_seconds': 3.5}
        (root / 'run/exit.json').write_text(json.dumps(root_exit))
        launch_record = json.loads((root / 'launch.json').read_text())
        completed = leaf_exit['completed_time_unix']
        launch_record['started_at'] = launch.datetime.fromtimestamp(completed - 7, launch.timezone.utc).isoformat()
        inputs = Path(launch_record['inputs'])
        code, run = inputs / 'code', Path(launch_record['run_root']) / 'run'
        launch_record['worker_command'] = [sys.executable, str(code / 'campaign.py'),
            '--campaign', str(code / 'recipe.json'), '--campaign-sha256', plan['campaign_sha256'],
            '--mode', 'train', '--base', str(inputs / 'base'), '--train', str(inputs / 'fit/prepared-train.jsonl'),
            '--pairs', str(inputs / 'fit/pairs.json'), '--pairs-sha256', launch.objective.PAIR_SHA256,
            '--families', str(inputs / 'fit/families.json'), '--families-sha256', launch.objective.FAMILY_SHA256,
            '--plan', str(code / 'objective.json'), '--plan-sha256', launch.objective.PLAN_SHA256,
            '--output', str(run), '--steps', '1024', '--budget-bytes', '8000000000', '--allocator-cap-bytes', '6500000000']
        launch_record['watchdog_command'] = [sys.executable, str(code / 'memory_monitor.py'),
            '--pid-file', str(run.parent / 'worker.pid'), '--worker', str(code / 'campaign.py'),
            '--run-dir', str(run), '--output', str(run.parent / 'memory.jsonl'), '--adapter-tag', 'pinned',
            '--baseline-dedicated-bytes', '7000000000', '--baseline-shared-bytes', '30',
            '--hard-budget-bytes', '8000000000', '--stop-dedicated-delta-bytes', '7500000000',
            '--shared-growth-limit-bytes', '128000000', '--stop-total-dedicated-bytes', '16000000000',
            '--interval-seconds', '2']
        (root / 'launch.json').write_text(json.dumps(launch_record))
        # Genuine final watchdog completion may precede checkpoint completion.
        rows[-1].update({'time_unix': completed - 1, 'elapsed_seconds': rows[0]['elapsed_seconds'] + 4})
        journal = ''.join(json.dumps(row) + '\n' for row in rows).encode()
        (root / 'memory.jsonl').write_bytes(journal)
        summary = {'reason': 'worker_exit', 'worker_pid': 123, 'samples': 2, 'sampling_interval_seconds': 2.0,
            'peak_total_dedicated_bytes': 9_000_000_000, 'peak_dedicated_delta_bytes': 2_000_000_000,
            'peak_shared_delta_bytes': 10,
            **{key: value for key, value in launch.MEMORY_LIMITS.items() if key != 'allocator_cap_bytes'}}
        (root / 'memory.summary.json').write_text(json.dumps(summary))
        guardian = [{'status': 'watching', 'worker_pid': 123, 'watchdog_pid': 124,
            'worker_start_ticks': 1001, 'watchdog_start_ticks': 1002, 'time_unix': completed - 6},
            {'status': 'healthy', 'sample': rows[-1], 'journalAgeSeconds': 0.5, 'time_unix': completed - 0.5},
            {'status': 'worker_exit', 'worker_pid': 123, 'time_unix': completed + 0.5}]
        (root / 'root-guardian.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in guardian))
        return final, journal

    def test_final_snapshot_preserves_genuine_terminal_proof_and_both_exits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint, journal = self.final_snapshot_fixture(root)
            result = launch.snapshot_checkpoint_memory(root, 1024)
            output = root / 'checkpoint-snapshots/step-1024'
            self.assertEqual(result['reason'], 'worker_exit')
            for name in ('launch.json', 'memory.jsonl', 'memory.summary.json', 'root-guardian.jsonl', 'run/exit.json'):
                self.assertEqual((output / name).read_bytes(), (root / name).read_bytes())
            self.assertEqual((output / 'run/checkpoints/step-1024/exit.json').read_bytes(),
                             (checkpoint / 'exit.json').read_bytes())
            self.assertEqual((output / 'run/adapter/adapters.safetensors').read_bytes(),
                             (checkpoint / 'adapter/adapters.safetensors').read_bytes())
            self.assertFalse((output / 'memory.snapshot.json').exists())
            completion = json.loads((checkpoint / 'exit.json').read_bytes())['completed_time_unix']
            self.assertLess(json.loads(journal.splitlines()[-1])['time_unix'], completion)

    def test_final_snapshot_rejects_missing_stale_bad_terminal_or_changed_proof(self):
        for defect in ('summary_missing', 'guardian_missing', 'terminal_missing', 'terminal_pid', 'stop',
                       'birth', 'stale', 'root_exit', 'partial_memory', 'summary_peak', 'adapter', 'future'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                checkpoint, _ = self.final_snapshot_fixture(root)
                guard_path = root / 'root-guardian.jsonl'
                guards = [json.loads(line) for line in guard_path.read_bytes().splitlines()]
                if defect == 'summary_missing': (root / 'memory.summary.json').unlink()
                elif defect == 'guardian_missing': guard_path.unlink()
                elif defect == 'root_exit':
                    (root / 'run/exit.json').write_text(json.dumps({'ok': False, 'steps_completed': 1024}))
                elif defect == 'partial_memory':
                    (root / 'memory.jsonl').write_bytes((root / 'memory.jsonl').read_bytes().rstrip(b'\n'))
                elif defect == 'summary_peak':
                    summary = json.loads((root / 'memory.summary.json').read_text())
                    summary['peak_total_dedicated_bytes'] += 1
                    (root / 'memory.summary.json').write_text(json.dumps(summary))
                elif defect == 'adapter': (checkpoint / 'adapter/adapters.safetensors').write_bytes(b'tampered')
                else:
                    if defect == 'terminal_missing': guards.pop()
                    elif defect == 'terminal_pid': guards[-1]['worker_pid'] += 1
                    elif defect == 'stop': guards[-1]['status'] = 'stop'
                    elif defect == 'birth': guards[0]['worker_start_ticks'] += 1
                    elif defect == 'stale': guards[1]['journalAgeSeconds'] = 30
                    elif defect == 'future': guards[-1]['time_unix'] = launch.time.time() + 60
                    guard_path.write_text(''.join(json.dumps(row) + '\n' for row in guards))
                with self.assertRaises(ValueError): launch.snapshot_checkpoint_memory(root, 1024)
                self.assertFalse((root / 'checkpoint-snapshots/step-1024').exists())

    def test_final_snapshot_cleans_partial_copy_and_preserves_source(self):
        for defect in ('copy_error', 'source_change'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.final_snapshot_fixture(root)
                output = root / 'final-ready'
                write_bytes = Path.write_bytes
                def copy(path, content):
                    if path == output.resolve() / 'run/exit.json':
                        if defect == 'copy_error': raise OSError('injected final copy failure')
                        write_bytes(root / 'run/exit.json', b'changed genuine root exit')
                    return write_bytes(path, content)
                with patch.object(Path, 'write_bytes', copy), self.assertRaises((OSError, ValueError)):
                    launch.snapshot_checkpoint_memory(root, 1024, output)
                self.assertFalse(output.exists())
                self.assertTrue((root / 'launch.json').is_file())

    def test_snapshot_copies_complete_immutable_prefix_and_binds_producer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint, rows, prefix = self.snapshot_fixture(root)
            snapshot = launch.snapshot_checkpoint_memory(root, 128)
            output = root / 'checkpoint-snapshots/step-128'
            for original in checkpoint.rglob('*'):
                if original.is_file():
                    copied = output / 'run' / original.relative_to(checkpoint)
                    self.assertEqual(copied.read_bytes(), original.read_bytes())
            self.assertEqual((output / 'launch.json').read_bytes(), (root / 'launch.json').read_bytes())
            self.assertEqual((output / 'root-guardian.jsonl').read_bytes(), (root / 'root-guardian.jsonl').read_bytes())
            self.assertEqual(snapshot['guardian_sha256'], launch.digest(output / 'root-guardian.jsonl'))
            self.assertEqual((output / 'memory.jsonl').read_bytes(), prefix)
            summary = json.loads((output / 'memory.summary.json').read_text())
            self.assertEqual(summary['reason'], 'checkpoint_snapshot')
            self.assertEqual(summary['peak_total_dedicated_bytes'], 9_000_000_000)
            self.assertEqual(summary['peak_dedicated_delta_bytes'], 2_000_000_000)
            self.assertEqual(summary['samples'], 2)
            self.assertEqual(snapshot['producer_sha256'], launch.digest(Path(launch.__file__)))
            self.assertEqual(snapshot['checkpoint_receipt_sha256'], launch.digest(checkpoint / 'receipt.json'))
            (root / 'memory.jsonl').write_text('changed source')
            self.assertEqual((output / 'memory.jsonl').read_bytes(), prefix)
            with self.assertRaisesRegex(ValueError, 'already exists'):
                launch.snapshot_checkpoint_memory(root, 128)

    def test_snapshot_rejects_incomplete_or_changed_checkpoint_files(self):
        for defect in ('plan', 'adapter', 'margins', 'reload', 'config', 'missing', 'symlink', 'directory_symlink'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                checkpoint, _, _ = self.snapshot_fixture(root)
                if defect == 'missing':
                    (checkpoint / 'reload.json').unlink()
                elif defect == 'symlink':
                    source = checkpoint / 'adapter/adapters.safetensors'
                    saved = root / 'unowned-adapter'
                    saved.write_bytes(source.read_bytes())
                    source.unlink(); source.symlink_to(saved)
                elif defect == 'directory_symlink':
                    original = checkpoint / 'adapter'
                    saved = root / 'unowned-adapter-directory'
                    original.rename(saved); original.symlink_to(saved, target_is_directory=True)
                else:
                    name = {'plan': 'plan.json', 'adapter': 'adapter/adapters.safetensors',
                        'margins': 'fit-margins.jsonl', 'reload': 'reload.json',
                        'config': 'adapter/adapter_config.json'}[defect]
                    if defect in ('adapter', 'margins'):
                        (checkpoint / name).write_bytes(b'changed after checkpoint completion')
                    else:
                        document = json.loads((checkpoint / name).read_text())
                        document['changed'] = True
                        (checkpoint / name).write_text(json.dumps(document))
                with self.assertRaises(ValueError): launch.snapshot_checkpoint_memory(root, 128)
                self.assertFalse((root / 'checkpoint-snapshots/step-128').exists())

    def test_snapshot_requires_fresh_launch_bound_guardian_completion_observation(self):
        for defect in ('absent', 'incomplete', 'pid', 'birth', 'before_completion', 'stale',
                       'sample_changed', 'future', 'stop', 'late_attachment'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.snapshot_fixture(root)
                path = root / 'root-guardian.jsonl'
                records = [json.loads(line) for line in path.read_bytes().splitlines()]
                now = launch.time.time()
                if defect == 'absent': path.unlink()
                elif defect == 'incomplete': path.write_bytes(path.read_bytes().rstrip(b'\n'))
                else:
                    if defect == 'pid': records[0]['worker_pid'] += 1
                    elif defect == 'birth': records[0]['watchdog_start_ticks'] += 1
                    elif defect == 'before_completion':
                        rows = [json.loads(line) for line in (root / 'memory.jsonl').read_bytes().splitlines()[:-1]]
                        records[-1]['sample'] = rows[0]
                        records[-1]['time_unix'] = now - 11
                    elif defect == 'stale':
                        pass
                    elif defect == 'sample_changed': records[-1]['sample']['dedicated_delta_bytes'] += 1
                    elif defect == 'future': records[-1]['time_unix'] = now + 60
                    elif defect == 'stop': records[-1]['status'] = 'stop'
                    elif defect == 'late_attachment': records[0]['time_unix'] = now - 3
                    path.write_text(''.join(json.dumps(record) + '\n' for record in records))
                clock = patch.object(launch.time, 'time', return_value=now + 60) if defect == 'stale' else contextlib.nullcontext()
                message = 'Wait for a fresh healthy guardian' if defect in ('stale', 'before_completion') else '.*'
                with clock, self.assertRaisesRegex(ValueError, message): launch.snapshot_checkpoint_memory(root, 128)
                self.assertFalse((root / 'checkpoint-snapshots/step-128').exists())

    def test_supervise_rejects_process_birth_drift_before_guard_attachment(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.prepare(Path(temporary))
            with patch.object(launch.objective, 'load_contract'), \
                    patch.object(launch.monitor, 'sample', return_value=(7_000_000_000, 30)), \
                    patch.object(launch.subprocess, 'Popen', side_effect=[Mock(pid=101), Mock(pid=102)]):
                launch.run(args)
            root = Path(args.run_root)
            with patch.object(launch, 'process_start_ticks', return_value=999), \
                    patch.object(launch.os, 'pidfd_open', create=True) as pidfd:
                with self.assertRaisesRegex(ValueError, 'birth identity'):
                    launch.supervise(root, launch.digest(root / 'launch.json'))
            pidfd.assert_not_called()
            self.assertFalse((root / 'root-guardian.jsonl').exists())

    def test_snapshot_cleans_partial_envelope_on_copy_error_or_live_source_change(self):
        for defect in ('copy_error', 'source_change', 'guardian_change'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                checkpoint, _, _ = self.snapshot_fixture(root)
                output = root / 'ready-envelope'
                write_bytes = Path.write_bytes
                def copy(path, content):
                    if path == output.resolve() / 'run/adapter/adapters.safetensors':
                        if defect == 'copy_error': raise OSError('injected copy failure')
                        if defect == 'source_change':
                            write_bytes(checkpoint / 'adapter/adapters.safetensors', b'live source changed')
                    if path == output.resolve() / 'root-guardian.jsonl' and defect == 'guardian_change':
                        write_bytes(root / 'root-guardian.jsonl', b'guardian source changed')
                    return write_bytes(path, content)
                with patch.object(Path, 'write_bytes', copy), self.assertRaises((OSError, ValueError)):
                    launch.snapshot_checkpoint_memory(root, 128, output)
                self.assertFalse(output.exists())
                self.assertTrue((root / 'launch.json').is_file())

    def test_snapshot_rejects_unfinished_stale_overbudget_or_tampered_source(self):
        for defect in ['unfinished', 'stale', 'budget', 'deltas', 'producer', 'monitor', 'worker', 'ordering', 'error']:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                checkpoint, rows, _ = self.snapshot_fixture(root)
                if defect in ['unfinished', 'stale']:
                    (checkpoint / 'exit.json').write_text(json.dumps({'ok': defect != 'unfinished', 'steps_completed': 128,
                                                                     'completed_time_unix': 25}))
                elif defect in ['budget', 'deltas', 'ordering', 'error']:
                    if defect == 'budget':
                        rows[-1]['dedicated_bytes'] = 16_000_000_000
                        rows[-1]['dedicated_delta_bytes'] = 9_000_000_000
                    elif defect == 'deltas':
                        rows[-1]['dedicated_delta_bytes'] = 0
                    elif defect == 'ordering':
                        rows[-1]['time_unix'] = rows[0]['time_unix']
                    else:
                        rows[-1] = {'monitor_error': 'counter missing'}
                    (root / 'memory.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
                else:
                    data = json.loads((root / 'launch.json').read_text())
                    data[{'producer': 'launcher_sha256', 'monitor': 'monitor_sha256', 'worker': 'worker_sha256'}[defect]] = 'b' * 64
                    (root / 'launch.json').write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    launch.snapshot_checkpoint_memory(root, 128)
                self.assertFalse((root / 'checkpoint-snapshots/step-128').exists())

    def test_confirmed_stop_checks_birth_identity_and_uses_pidfd_term_then_kill(self):
        worker = (123, Path('/own/campaign.py'), Path('/own/run'), 456)
        for term_exit in (True, False):
            with self.subTest(term_exit=term_exit), patch.object(launch, 'identity', return_value=True), \
                    patch.object(launch.os, 'pidfd_open', create=True, return_value=99) as open_fd, \
                    patch.object(launch.os, 'close') as close_fd, \
                    patch.object(launch.signal, 'pidfd_send_signal', create=True) as send, \
                    patch.object(launch.select, 'select', side_effect=[([99] if term_exit else [], [], []), ([99], [], [])]):
                result = launch.confirmed_stop(*worker)
                self.assertTrue(result['exitConfirmed'])
                self.assertEqual(send.call_count, 1 if term_exit else 2)
                self.assertEqual(send.call_args_list[0].args, (99, launch.signal.SIGTERM))
                if not term_exit: self.assertEqual(send.call_args_list[1].args, (99, launch.signal.SIGKILL))
                open_fd.assert_called_once_with(123); close_fd.assert_called_once_with(99)
        for identities in ([False], [True, False]):
            with patch.object(launch, 'identity', side_effect=identities), \
                    patch.object(launch.os, 'pidfd_open', create=True, return_value=99), \
                    patch.object(launch.os, 'close'), \
                    patch.object(launch.signal, 'pidfd_send_signal', create=True) as send:
                self.assertEqual(launch.confirmed_stop(*worker), {'signalled': False, 'identityPresent': False})
                send.assert_not_called()

    def test_confirmed_stop_retains_unconfirmed_exit_and_handles_pidfd_races(self):
        worker = (123, Path('/own/campaign.py'), Path('/own/run'), 456)
        with patch.object(launch, 'identity', return_value=True), patch.object(launch.os, 'pidfd_open', create=True, return_value=99), \
                patch.object(launch.os, 'close') as close_fd, patch.object(launch.signal, 'pidfd_send_signal', create=True), \
                patch.object(launch.select, 'select', return_value=([], [], [])):
            self.assertFalse(launch.confirmed_stop(*worker)['exitConfirmed'])
            close_fd.assert_called_once_with(99)
        with patch.object(launch, 'identity', return_value=True), patch.object(launch.os, 'pidfd_open', create=True, side_effect=ProcessLookupError), \
                patch.object(launch.signal, 'pidfd_send_signal', create=True) as send:
            self.assertFalse(launch.confirmed_stop(*worker)['identityPresent']); send.assert_not_called()
        with patch.object(launch, 'identity', return_value=True), patch.object(launch.os, 'pidfd_open', create=True, return_value=99), \
                patch.object(launch.os, 'close') as close_fd, patch.object(launch.signal, 'pidfd_send_signal', create=True, side_effect=ProcessLookupError), \
                patch.object(launch.select, 'select', return_value=([99], [], [])):
            self.assertTrue(launch.confirmed_stop(*worker)['exitConfirmed']); close_fd.assert_called_once_with(99)

    def test_identity_requires_own_birth_ticks_and_exact_launch_command(self):
        command = ['python', '/own/campaign.py', '--output', '/own/run']
        raw = ('\0'.join(command) + '\0').encode()
        with patch.object(Path, 'read_bytes', return_value=raw), patch.object(launch, 'process_start_ticks', return_value=456):
            self.assertTrue(launch.identity(123, Path(command[1]), Path('/own/run'), 456, command))
            self.assertFalse(launch.identity(123, Path(command[1]), Path('/own/run'), 457, command))
            self.assertFalse(launch.identity(123, Path(command[1]), Path('/other/run'), 456, command))
            self.assertFalse(launch.identity(123, Path(command[1]), Path('/own/run'), 456, command + ['--resume']))

    def test_root_supervise_stops_only_own_identified_worker_on_watchdog_failures_and_limits(self):
        for defect, expected_reason in (
                ('missing', 'watchdog_missing'), ('error', 'watchdog_error'),
                ('bool', 'watchdog_journal_invalid'), ('nan', 'watchdog_journal_invalid'),
                ('delta', 'watchdog_journal_invalid'), ('array', 'watchdog_journal_invalid'),
                ('total', 'absolute_total_dedicated_limit'), ('dedicated', 'dedicated_stop_threshold'),
                ('shared', 'shared_memory_growth'), ('stale', 'watchdog_journal_stale'),
                ('repeated', 'watchdog_journal_stale'), ('absent_journal', 'watchdog_journal_stale')):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary))
                with patch.object(launch.objective, 'load_contract'), patch.object(
                        launch.monitor, 'sample', return_value=(7_000_000_000, 30)), patch.object(
                        launch.subprocess, 'Popen', side_effect=[Mock(pid=101), Mock(pid=102)]):
                    attestation = launch.run(args)
                root = Path(args.run_root)
                sample = {'time_unix': 13.0, 'elapsed_seconds': 3.0, 'dedicated_bytes': 9_000_000_000,
                    'shared_bytes': 40, 'dedicated_delta_bytes': 2_000_000_000, 'shared_delta_bytes': 10}
                if defect == 'error': sample = {'monitor_error': 'counter absent'}
                elif defect == 'bool': sample['dedicated_bytes'] = True
                elif defect == 'nan': sample['time_unix'] = float('nan')
                elif defect == 'delta': sample['dedicated_delta_bytes'] = 1
                elif defect == 'array': sample = []
                elif defect == 'total': sample.update(dedicated_bytes=16_000_000_000, dedicated_delta_bytes=9_000_000_000)
                elif defect == 'dedicated': sample.update(dedicated_bytes=14_500_000_000, dedicated_delta_bytes=7_500_000_000)
                elif defect == 'shared': sample.update(shared_bytes=128_000_030, shared_delta_bytes=128_000_000)
                elif defect == 'stale': sample['time_unix'] = -17.0
                state = {'monitor_checks': 0, 'monotonic': 0}
                def owned_identity(pid, *unused):
                    if pid == 101:
                        state['monitor_checks'] += 1
                        return defect != 'missing' or state['monitor_checks'] <= 2
                    return True
                def tick(): state['monotonic'] = 31
                record = Mock(return_value=sample)
                if defect == 'absent_journal': record.side_effect = FileNotFoundError
                with patch.object(launch, 'process_start_ticks', side_effect=lambda pid: 501 if pid == 101 else 502), \
                        patch.object(launch, 'identity', side_effect=owned_identity), patch.object(launch, 'last_record', record), \
                        patch.object(launch, 'confirmed_stop', return_value={'signalled': True, 'exitConfirmed': True}) as stop, \
                        patch.object(launch.os, 'pidfd_open', create=True, side_effect=[99, 100]), patch.object(launch.os, 'close') as close_fd, \
                        patch.object(launch.select, 'select', return_value=([], [], [])), \
                        patch.object(launch.signal, 'signal'), patch.object(launch.time, 'time', return_value=14.0), \
                        patch.object(launch.time, 'monotonic', side_effect=lambda: state['monotonic']), \
                        patch.object(launch.time, 'sleep', side_effect=lambda _: tick()):
                    outcome = launch.supervise(root, launch.digest(root / 'launch.json'))
                self.assertEqual(outcome['reason'], expected_reason)
                self.assertTrue(all(call.args[0] == 102 and call.args[3] == 502 and call.args[4] == attestation['worker_command']
                                    for call in stop.call_args_list))
                self.assertEqual([call.args for call in close_fd.call_args_list], [(100,), (99,)])
                journal = [json.loads(line) for line in (root / 'root-guardian.jsonl').read_text().splitlines()]
                self.assertEqual(journal[0]['worker_start_ticks'], 502)
                self.assertEqual(journal[0]['watchdog_start_ticks'], 501)

    def test_root_supervise_requires_explicit_launch_pin_and_confirmed_worker_exit(self):
        for defect in ('pin', 'identity_lost', 'stop_unconfirmed'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary))
                with patch.object(launch.objective, 'load_contract'), patch.object(
                        launch.monitor, 'sample', return_value=(7_000_000_000, 30)), patch.object(
                        launch.subprocess, 'Popen', side_effect=[Mock(pid=101), Mock(pid=102)]):
                    launch.run(args)
                root = Path(args.run_root)
                pin = 'f' * 64 if defect == 'pin' else launch.digest(root / 'launch.json')
                state = {'worker_checks': 0}
                def owned_identity(pid, *unused):
                    if pid == 102:
                        state['worker_checks'] += 1
                        return defect != 'identity_lost' or state['worker_checks'] < 3
                    return True
                with patch.object(launch, 'process_start_ticks', side_effect=lambda pid: 501 if pid == 101 else 502), patch.object(launch, 'identity', side_effect=owned_identity), \
                        patch.object(launch.os, 'pidfd_open', create=True, return_value=99), patch.object(launch.os, 'close'), \
                        patch.object(launch.signal, 'signal'), patch.object(launch.select, 'select', return_value=([], [], [])), \
                        patch.object(launch, 'last_record', return_value={'monitor_error': 'failed'}), \
                        patch.object(launch, 'confirmed_stop', return_value={'signalled': True, 'exitConfirmed': False}) as stop:
                    with self.assertRaises((ValueError, RuntimeError)): launch.supervise(root, pin)
                if defect == 'pin': stop.assert_not_called()

    def final_supervision_fixture(self, temporary):
        args = self.prepare(Path(temporary))
        with patch.object(launch.objective, 'load_contract'), patch.object(
                launch.monitor, 'sample', return_value=(7_000_000_000, 30)), patch.object(
                launch.subprocess, 'Popen', side_effect=[Mock(pid=101), Mock(pid=102)]):
            attestation = launch.run(args)
        root = Path(args.run_root)
        rows = [{'time_unix': stamp, 'elapsed_seconds': stamp-10, 'dedicated_bytes': 9_000_000_000,
                 'shared_bytes': 40, 'dedicated_delta_bytes': 2_000_000_000, 'shared_delta_bytes': 10} for stamp in (11.0,12.0)]
        summary = {'worker_pid': 102, 'reason': 'worker_exit', 'samples': 2, 'sampling_interval_seconds': 2.0,
                   'peak_total_dedicated_bytes': 9_000_000_000, 'peak_dedicated_delta_bytes': 2_000_000_000,
                   'peak_shared_delta_bytes': 10,
                   **{key:attestation[key] for key in ('hard_budget_bytes','stop_dedicated_delta_bytes',
                      'shared_growth_limit_bytes','stop_total_dedicated_bytes')}}
        (root / 'memory.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
        (root / 'memory.summary.json').write_text(json.dumps(summary)+'\n')
        return root, attestation, rows, summary

    def test_delayed_worker_readiness_and_monitor_finalization_complete_before_terminal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _, rows, summary = self.final_supervision_fixture(temporary)
            (root / 'memory.summary.json').unlink()
            state = {'worker_checks': 0, 'worker_ready': False, 'monitor_ready': False}
            events = []
            def owned(pid, *_):
                if pid == 102:
                    state['worker_checks'] += 1
                    return state['worker_checks'] <= 2
                return True
            def wait(fds, _write, _error, timeout):
                events.append((fds[0], timeout))
                if fds == [99]:
                    if timeout == 5: state['worker_ready'] = True
                    return ([99] if state['worker_ready'] else [], [], [])
                self.assertEqual((fds, timeout), ([100], 20))
                self.assertFalse((root/'memory.summary.json').exists())
                # A genuine in-flight successful counter row completes before monitor exit.
                rows.append({**rows[0], 'time_unix': 13.0, 'elapsed_seconds': 3.0})
                (root/'memory.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
                summary['samples'] = 3
                (root/'memory.summary.json').write_text(json.dumps(summary)+'\n')
                state['monitor_ready'] = True
                return ([100], [], [])
            with patch.object(launch, 'process_start_ticks', side_effect=lambda pid: 501 if pid==101 else 502), \
                    patch.object(launch, 'identity', side_effect=owned), \
                    patch.object(launch.os, 'pidfd_open', create=True, side_effect=[99,100]), \
                    patch.object(launch.os, 'close') as close, patch.object(launch.signal, 'signal'), \
                    patch.object(launch.select, 'select', side_effect=wait), \
                    patch.object(launch.time, 'time', return_value=14.0):
                result = launch.supervise(root, launch.digest(root/'launch.json'))
            self.assertEqual(result['status'], 'worker_exit')
            self.assertTrue(state['monitor_ready'])
            self.assertEqual(events[:2], [(99,5),(100,20)])
            self.assertEqual([call.args for call in close.call_args_list], [(100,),(99,)])
            records = [json.loads(line) for line in (root/'root-guardian.jsonl').read_text().splitlines()]
            self.assertEqual(set(records[-1]), {'status','worker_pid','time_unix'})
            self.assertEqual(records[-1]['status'], 'worker_exit')

    def test_final_monitor_errors_missing_summary_and_invalid_durable_rows_cannot_emit_worker_exit(self):
        for defect in ('inflight_nonzero','error_then_valid','summary_reason','summary_missing','partial',
                       'wrong_pid','samples','peak','budget','total','dedicated','shared','empty','single'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                root, _, rows, summary = self.final_supervision_fixture(temporary)
                if defect in ('inflight_nonzero','error_then_valid'):
                    rows.append({'time_unix':13.0,'monitor_error':'CalledProcessError','detail':'real synthetic nonzero exit status 1'})
                    summary['reason']='monitor_error'
                    if defect=='error_then_valid':
                        rows.append({**rows[0],'time_unix':13.5,'elapsed_seconds':3.5}); summary['reason']='worker_exit'
                elif defect=='summary_reason': summary['reason']='dedicated_stop_threshold'
                elif defect=='wrong_pid': summary['worker_pid']=True
                elif defect=='samples': summary['samples']=True
                elif defect=='peak': summary['peak_total_dedicated_bytes']+=1
                elif defect=='budget': summary['hard_budget_bytes']+=1
                elif defect=='total': rows[0].update(dedicated_bytes=16_000_000_000,dedicated_delta_bytes=9_000_000_000)
                elif defect=='dedicated': rows[0].update(dedicated_bytes=14_500_000_000,dedicated_delta_bytes=7_500_000_000)
                elif defect=='shared': rows[0].update(shared_bytes=128_000_030,shared_delta_bytes=128_000_000)
                elif defect in ('empty','single'):
                    rows=rows[:0 if defect=='empty' else 1]; summary['samples']=len(rows)
                    if not rows:
                        summary.update(peak_total_dedicated_bytes=0,peak_dedicated_delta_bytes=0,peak_shared_delta_bytes=0)
                (root/'memory.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows)+('{"partial":' if defect=='partial' else ''))
                (root/'memory.summary.json').write_text(json.dumps(summary)+'\n')
                if defect=='summary_missing': (root/'memory.summary.json').unlink()
                checks={'worker':0}
                def owned(pid,*_):
                    if pid==102: checks['worker']+=1; return checks['worker']<=2
                    return True
                with patch.object(launch,'process_start_ticks',side_effect=lambda pid: 501 if pid == 101 else 502), patch.object(launch,'identity',side_effect=owned), \
                        patch.object(launch.os,'pidfd_open',create=True,side_effect=[99,100]), patch.object(launch.os,'close'), \
                        patch.object(launch.signal,'signal'), patch.object(launch.select,'select',side_effect=lambda fds,*_: (fds,[],[])), \
                        patch.object(launch.time,'time',return_value=14.0):
                    result=launch.supervise(root,launch.digest(root/'launch.json'))
                self.assertEqual((result['status'],result['reason']),('stop','watchdog_completion_invalid'))
                self.assertNotIn('"status": "worker_exit"',(root/'root-guardian.jsonl').read_text())
                if defect=='inflight_nonzero':
                    self.assertIn('CalledProcessError',(root/'memory.jsonl').read_text())
                    self.assertEqual(json.loads((root/'memory.summary.json').read_text())['reason'],'monitor_error')

    def test_unconfirmed_monitor_exit_cannot_emit_final_terminal_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _, _, _=self.final_supervision_fixture(temporary)
            checks={'worker':0}
            def owned(pid,*_):
                if pid==102: checks['worker']+=1; return checks['worker']<=2
                return True
            with patch.object(launch,'process_start_ticks',side_effect=lambda pid: 501 if pid == 101 else 502), patch.object(launch,'identity',side_effect=owned), \
                    patch.object(launch.os,'pidfd_open',create=True,side_effect=[99,100]), patch.object(launch.os,'close'), \
                    patch.object(launch.signal,'signal'), patch.object(launch.select,'select',side_effect=lambda fds,*_: ([99] if fds==[99] else [],[],[])) as wait:
                with self.assertRaisesRegex(RuntimeError,'watchdog completion was not confirmed'): launch.supervise(root,launch.digest(root/'launch.json'))
            self.assertIn(([100],[],[],20),[call.args for call in wait.call_args_list])
            self.assertNotIn('"status": "worker_exit"',(root/'root-guardian.jsonl').read_text())

    def test_live_worker_watchdog_loss_stops_immediately_without_five_second_pre_stop_wait(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _, _, _=self.final_supervision_fixture(temporary)
            checks={'monitor':0}; events=[]
            def owned(pid,*_):
                if pid==101: checks['monitor']+=1; return checks['monitor']<=2
                return True
            def wait(fds,_write,_error,timeout):
                events.append(('wait',fds[0],timeout)); return ([],[],[])
            def stop(*args,**kwargs):
                events.append(('stop',args[0],kwargs['pidfd'])); return {'signalled':True,'exitConfirmed':True}
            with patch.object(launch,'process_start_ticks',side_effect=lambda pid: 501 if pid == 101 else 502), patch.object(launch,'identity',side_effect=owned), \
                    patch.object(launch.os,'pidfd_open',create=True,side_effect=[99,100]), patch.object(launch.os,'close'), \
                    patch.object(launch.signal,'signal'), patch.object(launch.select,'select',side_effect=wait), \
                    patch.object(launch,'confirmed_stop',side_effect=stop), patch.object(launch.time,'time',return_value=14.0):
                result=launch.supervise(root,launch.digest(root/'launch.json'))
            self.assertEqual(result['reason'],'watchdog_missing')
            first_stop=next(index for index,event in enumerate(events) if event[0]=='stop')
            self.assertEqual(events[:first_stop],[('wait',99,0)])
            self.assertEqual(events[first_stop],('stop',102,99))

    def test_monitor_pidfd_capture_failure_cleans_up_only_captured_owned_worker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, attestation, _, _=self.final_supervision_fixture(temporary)
            original=ProcessLookupError('synthetic monitor exited during pidfd capture')
            with patch.object(launch,'process_start_ticks',side_effect=lambda pid: 501 if pid == 101 else 502), patch.object(launch,'identity',return_value=True), \
                    patch.object(launch.os,'pidfd_open',create=True,side_effect=[99,original]), patch.object(launch.os,'close') as close, \
                    patch.object(launch,'confirmed_stop',return_value={'signalled':True,'exitConfirmed':True}) as stop:
                with self.assertRaises(ProcessLookupError) as caught: launch.supervise(root,launch.digest(root/'launch.json'))
            self.assertIs(caught.exception,original)
            stop.assert_called_once_with(102,Path(attestation['worker_command'][1]),root.resolve()/'run',502,
                                         attestation['worker_command'],pidfd=99)
            close.assert_called_once_with(99)
            self.assertFalse((root/'root-guardian.jsonl').exists())

    def test_last_record_ignores_partial_tail_without_replacing_valid_sample(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'memory.jsonl'
            path.write_bytes(b'{"time_unix": 12}\n{"partial":')
            self.assertEqual(launch.last_record(path), {'time_unix': 12})

    def test_post_spawn_publication_failures_stop_confirm_both_children_and_preserve_original(self):
        for defect in ('first_pid_write', 'launch_receipt_write', 'post_spawn_digest'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary))
                original = OSError('injected ' + defect)
                watchdog, worker = Mock(pid=101), Mock(pid=102)
                watchdog.wait.return_value = 0
                worker.wait.return_value = 0
                if defect == 'first_pid_write':
                    worker.wait.side_effect = [subprocess.TimeoutExpired('owned worker', 5), 0]
                if defect == 'post_spawn_digest':
                    worker.terminate.side_effect = RuntimeError('injected TERM error')
                    worker.wait.side_effect = [subprocess.TimeoutExpired('owned worker', 5),
                                               subprocess.TimeoutExpired('owned worker', 5)]
                    worker.kill.side_effect = RuntimeError('injected KILL error')
                write_text, digest = Path.write_text, launch.digest
                cleanup_log = io.StringIO()
                def publish(path, *arguments, **keywords):
                    if (defect == 'first_pid_write' and path.name == 'worker.pid') or (
                            defect == 'launch_receipt_write' and path.name == 'launch.json'):
                        raise original
                    return write_text(path, *arguments, **keywords)
                def post_spawn_digest(path):
                    if defect == 'post_spawn_digest' and path == Path(launch.__file__) and spawn.call_count == 2:
                        raise original
                    return digest(path)
                with patch.object(launch.objective, 'load_contract'), patch.object(
                        launch.monitor, 'sample', return_value=(7_000_000_000, 30)), patch.object(
                        launch.subprocess, 'Popen', side_effect=[watchdog, worker]) as spawn, \
                        patch.object(Path, 'write_text', publish), patch.object(launch, 'digest', post_spawn_digest), \
                        patch.object(launch.sys, 'stderr', cleanup_log):
                    with self.assertRaises(OSError) as caught:
                        launch.run(args)
                self.assertIs(caught.exception, original)
                self.assertEqual(spawn.call_count, 2)
                for child in (worker, watchdog):
                    child.terminate.assert_called_once_with()
                    self.assertTrue(child.wait.called)
                    self.assertTrue(all(call.kwargs == {'timeout': 5} for call in child.wait.call_args_list))
                if defect == 'first_pid_write':
                    worker.kill.assert_called_once_with()
                    self.assertEqual(worker.wait.call_count, 2)
                if defect == 'post_spawn_digest':
                    self.assertIn('exit not confirmed', cleanup_log.getvalue())
                    self.assertIn('TERM failed', cleanup_log.getvalue())
                root = Path(args.run_root)
                self.assertTrue((root / 'worker.log').exists())
                self.assertTrue((root / 'watchdog.log').exists())
                if defect != 'first_pid_write':
                    self.assertEqual((root / 'worker.pid').read_text(), '102\n')
                    self.assertEqual((root / 'watchdog.pid').read_text(), '101\n')
                self.assertFalse((root / 'launch.json').exists())

    def test_second_spawn_failure_confirms_first_owned_child_before_rethrow(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.prepare(Path(temporary))
            original = OSError('injected worker spawn error')
            watchdog = Mock(pid=101, wait=Mock(return_value=0))
            with patch.object(launch.objective, 'load_contract'), patch.object(
                    launch.monitor, 'sample', return_value=(7_000_000_000, 30)), patch.object(
                    launch.subprocess, 'Popen', side_effect=[watchdog, original]):
                with self.assertRaises(OSError) as caught:
                    launch.run(args)
            self.assertIs(caught.exception, original)
            watchdog.terminate.assert_called_once_with()
            watchdog.wait.assert_called_once_with(timeout=5)
            watchdog.kill.assert_not_called()


if __name__ == '__main__':
    unittest.main()

"""No-GPU launch tests: immutable code, fresh paths, and exact bounded commands."""
import argparse
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch, Mock

import cuda_campaign_launch as launch
import cuda_import as bridge
from test_cuda_import import c11_receipts


class LaunchTests(unittest.TestCase):
    def prepare(self, root, candidate='candidate10'):
        inputs = root / 'inputs'
        code = inputs / 'code'
        code.mkdir(parents=True)
        hashes = {}
        names = ('cuda_campaign.py', 'cuda_worker.py', 'cuda_memory_monitor.py', 'worker.py', 'gemma3_fp32.py') if candidate == 'candidate10' else (
            'c11_cuda_campaign.py', 'c11_fit_sampler.py', 'cuda_worker.py', 'cuda_memory_monitor.py', 'worker.py', 'gemma3_fp32.py')
        for name in names:
            if candidate == 'candidate11':
                (code / name).write_bytes(Path(launch.__file__).with_name(name).read_bytes())
            else:
                (code / name).write_text('# frozen ' + name)
            hashes[name] = launch.digest(code / name)
        fixture = Path(__file__).resolve().parents[1] / ('fixtures/guardrail/candidate11/cuda-campaign-327-fit.json' if candidate == 'candidate11' else 'fixtures/guardrail/candidate10/cuda-campaign.json')
        (code / 'cuda-campaign.json').write_bytes(fixture.read_bytes())
        return argparse.Namespace(inputs=str(inputs), run_root=str(root / 'run'),
                                  adapter_tag='pinned', mode='train', candidate=candidate, code_sha256_json=json.dumps(hashes))

    def test_hash_tampering_rejects_before_monitor_or_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self.prepare(root)
            (root / 'inputs/code/worker.py').write_text('tampered')
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
                with patch.object(launch.cuda_worker, 'load_contract'), patch.object(
                    launch.monitor, 'sample', return_value=(7_000_000_000, 30)
                ), patch.object(launch.subprocess, 'Popen', side_effect=[Mock(pid=101), Mock(pid=102)]) as process:
                    receipt = launch.run(args)
                command = receipt['worker_command']
                self.assertEqual(command[command.index('--steps') + 1], steps)
                self.assertEqual(command[command.index('--allocator-cap-bytes') + 1], '6500000000')
                watchdog = receipt['watchdog_command']
                self.assertEqual(watchdog[watchdog.index('--stop-total-dedicated-bytes') + 1], '16000000000')
                self.assertEqual(watchdog[watchdog.index('--worker') + 1], command[1])
                self.assertEqual(receipt['campaign_sha256'], launch.campaign_for_candidate('candidate10').CAMPAIGN_SHA256)
                self.assertEqual(receipt['stop_total_dedicated_bytes'], 16_000_000_000)
                self.assertEqual(receipt['worker_pid'], 102)
                self.assertTrue(all(call.kwargs['stdin'] == launch.subprocess.DEVNULL for call in process.call_args_list))

    def test_existing_root_and_total_usage_reject_without_spawn(self):
        for existing in [False, True]:
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary))
                if existing:
                    Path(args.run_root).mkdir()
                with patch.object(launch.cuda_worker, 'load_contract'), patch.object(
                    launch.monitor, 'sample', return_value=(16_000_000_000, 0)
                ), patch.object(launch.subprocess, 'Popen') as process:
                    with self.assertRaises(ValueError):
                        launch.run(args)
                process.assert_not_called()

    def test_code_inventory_and_symlink_reject(self):
        with tempfile.TemporaryDirectory() as temporary:
            code = Path(temporary)
            with self.assertRaisesRegex(ValueError, 'exactly'):
                launch.verify_code(code, {})
            hashes = {name: '0' * 64 for name in ['cuda_campaign.py', 'cuda_worker.py', 'cuda_memory_monitor.py', 'worker.py', 'gemma3_fp32.py']}
            source = code / 'source'
            source.write_text('code')
            (code / 'cuda_campaign.py').symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'regular'):
                launch.verify_code(code, hashes)


    def snapshot_fixture(self, root):
        checkpoint = root / 'run/checkpoints/step-128'
        checkpoint.mkdir(parents=True)
        receipt = {'checkpoint_step': 128, 'source': {'source_sha256': 'a' * 64}}
        (checkpoint / 'receipt.json').write_text(json.dumps(receipt))
        (checkpoint / 'exit.json').write_text(json.dumps({'ok': True, 'steps_completed': 128, 'completed_time_unix': 15}))
        launch_record = {'launcher_sha256': launch.digest(Path(launch.__file__)),
                         'watchdog_sha256': launch.digest(Path(launch.monitor.__file__)),
                         'monitor_sha256': launch.digest(Path(launch.monitor.__file__)),
                         'worker_pid': 123, 'worker_sha256': 'a' * 64,
                         'baseline_dedicated_bytes': 7_000_000_000, 'baseline_shared_bytes': 30,
                         'hard_budget_bytes': 8_000_000_000, 'stop_dedicated_delta_bytes': 7_500_000_000,
                         'shared_growth_limit_bytes': 128_000_000, 'stop_total_dedicated_bytes': 16_000_000_000}
        (root / 'launch.json').write_text(json.dumps(launch_record))
        rows = [{'time_unix': t, 'elapsed_seconds': t - 5, 'dedicated_bytes': 9_000_000_000,
                 'shared_bytes': 40, 'dedicated_delta_bytes': 2_000_000_000, 'shared_delta_bytes': 10}
                for t in [10, 20]]
        prefix = ''.join(json.dumps(row) + '\n' for row in rows).encode()
        (root / 'memory.jsonl').write_bytes(prefix + b'{"partial":')
        return checkpoint, rows, prefix

    def test_snapshot_copies_complete_immutable_prefix_and_binds_producer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint, rows, prefix = self.snapshot_fixture(root)
            snapshot = launch.snapshot_checkpoint_memory(root, 128)
            output = root / 'checkpoint-snapshots/step-128'
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

    def test_c11_launch_snapshot_import_contract_at_all_selected_checkpoints(self):
        for step in (128, 256, 512, 1024):
            with self.subTest(checkpoint=step), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary), 'candidate11')
                with patch.object(launch.cuda_worker, 'load_contract'), patch.object(
                        launch.monitor, 'sample', return_value=(7_000_000_000, 30)), patch.object(
                        launch.subprocess, 'Popen', side_effect=[Mock(pid=101), Mock(pid=102)]):
                    attestation = launch.run(args)
                self.assertEqual(attestation['purpose'], 'candidate11_cuda_fit_only_campaign')
                self.assertTrue(attestation['worker_command'][1].endswith('/c11_cuda_campaign.py'))
                self.assertEqual(attestation['watchdog_command'][attestation['watchdog_command'].index('--worker') + 1],
                                 attestation['worker_command'][1])
                plan, receipt, exit_record, _, _ = c11_receipts(step)
                exit_record['completed_time_unix'] = 12.0
                root = Path(args.run_root)
                checkpoint = root / f'run/checkpoints/step-{step}'
                checkpoint.mkdir(parents=True)
                for name, value in [('plan.json', plan), ('receipt.json', receipt), ('exit.json', exit_record)]:
                    (checkpoint / name).write_text(json.dumps(value))
                rows = [{'time_unix': timestamp, 'elapsed_seconds': timestamp - 10,
                    'dedicated_bytes': 9_000_000_000, 'shared_bytes': 40,
                    'dedicated_delta_bytes': 2_000_000_000, 'shared_delta_bytes': 10} for timestamp in (11.0, 13.0)]
                (root / 'memory.jsonl').write_bytes(b''.join(json.dumps(row).encode() + b'\n' for row in rows) + b'{"partial":')
                with patch.object(launch.time, 'time', return_value=14.0):
                    snapshot = launch.snapshot_checkpoint_memory(root, step)
                output = root / f'checkpoint-snapshots/step-{step}'
                memory = json.loads((output / 'memory.summary.json').read_text())
                bridge.validate_receipts(plan, receipt, exit_record, memory, attestation, snapshot,
                    (output / 'memory.jsonl').read_bytes(), launch.digest(checkpoint / 'receipt.json'))
                invalid = dict(snapshot); invalid['checkpoint_receipt_sha256'] = 'f' * 64
                with self.assertRaises(ValueError):
                    bridge.validate_receipts(plan, receipt, exit_record, memory, attestation, invalid,
                        (output / 'memory.jsonl').read_bytes(), launch.digest(checkpoint / 'receipt.json'))

    def test_c11_rejects_c10_profile_and_missing_sampler_before_sampling_or_spawn(self):
        for defect in ('candidate', 'sampler', 'staged_source'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary), 'candidate11')
                hashes = json.loads(args.code_sha256_json)
                if defect == 'candidate': args.candidate = 'candidate10'
                elif defect == 'sampler': del hashes['c11_fit_sampler.py']
                else:
                    path = Path(args.inputs) / 'code/worker.py'
                    path.write_text('# externally pinned but not C11 source')
                    hashes['worker.py'] = launch.digest(path)
                args.code_sha256_json = json.dumps(hashes)
                with patch.object(launch.monitor, 'sample') as sample, patch.object(launch.subprocess, 'Popen') as process:
                    with self.assertRaises(ValueError): launch.run(args)
                sample.assert_not_called(); process.assert_not_called()
                self.assertFalse(Path(args.run_root).exists())

    def test_confirmed_stop_checks_birth_identity_and_uses_pidfd_term_then_kill(self):
        worker = (123, Path('/own/c11_cuda_campaign.py'), Path('/own/run'), 456)
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
        worker = (123, Path('/own/c11_cuda_campaign.py'), Path('/own/run'), 456)
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

    def test_exact_selected_staged_inventory_imports_without_other_candidate(self):
        for candidate in ('candidate10', 'candidate11'):
            with self.subTest(candidate=candidate), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary), candidate)
                code = Path(args.inputs) / 'code'
                (code / 'cuda_campaign_launch.py').write_bytes(Path(launch.__file__).read_bytes())
                if candidate == 'candidate10':
                    for name in json.loads(args.code_sha256_json):
                        (code / name).write_bytes(Path(launch.__file__).with_name(name).read_bytes())
                script = 'import sys; import cuda_campaign_launch as launch; launch.campaign_for_candidate(sys.argv[1]); print("selected profile imports")'
                result = subprocess.run([sys.executable, '-B', '-c', script, candidate], cwd=code,
                    capture_output=True, text=True, check=False, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'selected profile imports')

    def test_identity_requires_own_birth_ticks_and_exact_launch_command(self):
        command = ['python', '/own/c11_cuda_campaign.py', '--output', '/own/run']
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
                args = self.prepare(Path(temporary), 'candidate11')
                with patch.object(launch.cuda_worker, 'load_contract'), patch.object(
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
                        return defect != 'missing' or state['monitor_checks'] == 1
                    return True
                def tick(): state['monotonic'] = 31
                record = Mock(return_value=sample)
                if defect == 'absent_journal': record.side_effect = FileNotFoundError
                with patch.object(launch, 'process_start_ticks', side_effect=lambda pid: 501 if pid == 101 else 502), \
                        patch.object(launch, 'identity', side_effect=owned_identity), patch.object(launch, 'last_record', record), \
                        patch.object(launch, 'confirmed_stop', return_value={'signalled': True, 'exitConfirmed': True}) as stop, \
                        patch.object(launch.os, 'pidfd_open', create=True, return_value=99), patch.object(launch.os, 'close') as close_fd, \
                        patch.object(launch.signal, 'signal'), patch.object(launch.time, 'time', return_value=14.0), \
                        patch.object(launch.time, 'monotonic', side_effect=lambda: state['monotonic']), \
                        patch.object(launch.time, 'sleep', side_effect=lambda _: tick()):
                    outcome = launch.supervise(root, launch.digest(root / 'launch.json'))
                self.assertEqual(outcome['reason'], expected_reason)
                self.assertTrue(all(call.args[0] == 102 and call.args[3] == 502 and call.args[4] == attestation['worker_command']
                                    for call in stop.call_args_list))
                close_fd.assert_called_once_with(99)
                journal = [json.loads(line) for line in (root / 'root-guardian.jsonl').read_text().splitlines()]
                self.assertEqual(journal[0]['worker_start_ticks'], 502)
                self.assertEqual(journal[0]['watchdog_start_ticks'], 501)

    def test_root_supervise_requires_explicit_launch_pin_and_confirmed_worker_exit(self):
        for defect in ('pin', 'identity_lost', 'stop_unconfirmed'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary), 'candidate11')
                with patch.object(launch.cuda_worker, 'load_contract'), patch.object(
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
                with patch.object(launch, 'process_start_ticks', return_value=123), patch.object(launch, 'identity', side_effect=owned_identity), \
                        patch.object(launch.os, 'pidfd_open', create=True, return_value=99), patch.object(launch.os, 'close'), \
                        patch.object(launch.signal, 'signal'), patch.object(launch.select, 'select', return_value=([], [], [])), \
                        patch.object(launch, 'last_record', return_value={'monitor_error': 'failed'}), \
                        patch.object(launch, 'confirmed_stop', return_value={'signalled': True, 'exitConfirmed': False}) as stop:
                    with self.assertRaises((ValueError, RuntimeError)): launch.supervise(root, pin)
                if defect == 'pin': stop.assert_not_called()

    def test_last_record_ignores_partial_tail_without_replacing_valid_sample(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'memory.jsonl'
            path.write_bytes(b'{"time_unix": 12}\n{"partial":')
            self.assertEqual(launch.last_record(path), {'time_unix': 12})

    def test_post_spawn_publication_failures_stop_confirm_both_children_and_preserve_original(self):
        for defect in ('first_pid_write', 'launch_receipt_write', 'post_spawn_digest'):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as temporary:
                args = self.prepare(Path(temporary), 'candidate11')
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
                    if defect == 'post_spawn_digest' and path == Path(launch.__file__):
                        raise original
                    return digest(path)
                with patch.object(launch.cuda_worker, 'load_contract'), patch.object(
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
            args = self.prepare(Path(temporary), 'candidate11')
            original = OSError('injected worker spawn error')
            watchdog = Mock(pid=101, wait=Mock(return_value=0))
            with patch.object(launch.cuda_worker, 'load_contract'), patch.object(
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

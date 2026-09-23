"""CPU contract tests for the exact admitted C11 TRAIN branch."""
import copy
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import contract
import cuda_train

DATA = Path(__file__).resolve().parents[1] / 'data'


class ContractTests(unittest.TestCase):
    def test_frozen_fit_inventory_and_objective(self):
        rows = contract.read_rows(DATA / 'prepared-fit.jsonl', 'train',
            cuda_train.exact_file(DATA / 'prepared-fit.jsonl', contract.TRAIN_SHA256))
        pairs = contract.read_guardrail_pairs(DATA / 'pairs.json', rows,
            cuda_train.exact_file(DATA / 'pairs.json', contract.PAIR_SHA256))
        families = contract.read_guardrail_families(DATA / 'families.json', rows,
            cuda_train.exact_file(DATA / 'families.json', contract.FAMILY_SHA256))
        plan = contract.read_guardrail_plan(DATA / 'objective.json', contract.PAIR_SHA256,
            cuda_train.exact_file(DATA / 'objective.json', contract.PLAN_SHA256), contract.FAMILY_SHA256)
        self.assertEqual((len(rows), len(pairs), len(families), len({row['group'] for row in rows})), (327,86,327,133))
        self.assertEqual({row['split'] for row in rows}, {'train'})
        self.assertEqual(plan['loss'], contract.LOSS)
        self.assertEqual((plan['validation_rows_passed_to_training'],plan['test_rows_passed_to_training']), (0,0))

    def test_changed_prepared_bytes_rejected_before_reading_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'prepared-fit.jsonl'
            file.write_bytes((DATA / 'prepared-fit.jsonl').read_bytes() + b'\n')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                cuda_train.exact_file(file, contract.TRAIN_SHA256)
            linked = Path(directory) / 'link.jsonl'
            linked.symlink_to(file)
            with self.assertRaisesRegex(ValueError, 'regular frozen input'):
                cuda_train.exact_file(linked, contract.TRAIN_SHA256)

    def test_no_validation_test_or_foreign_target_admission(self):
        row = json.loads((DATA / 'prepared-fit.jsonl').read_text().splitlines()[0])
        for split in ('validation', 'test'):
            changed = {**row, 'split': split}
            with self.subTest(split=split), self.assertRaisesRegex(ValueError, 'TRAIN-only'):
                contract.read_rows(Path('rows.jsonl'), content=json.dumps(changed).encode())
        for targets in ([.5,.5], [1,float('nan')], [-1,2]):
            changed = {**row, 'target_probabilities': targets}
            with self.subTest(targets=targets):
                if targets == [.5,.5]:
                    rows=contract.read_rows(Path('rows.jsonl'), content=json.dumps(changed).encode())
                    with self.assertRaisesRegex(ValueError, 'exact allow/confirm TRAIN'):
                        contract.read_guardrail_pairs(DATA / 'pairs.json', rows)
                else:
                    with self.assertRaises(ValueError):
                        contract.read_rows(Path('rows.jsonl'), content=json.dumps(changed).encode())

    def test_source_objective_accepts_only_current_symmetric_loss(self):
        source = json.loads((DATA / 'objective.json').read_text())
        for key, value in (('arm','A'),('purpose','generic_training'),('test_rows_passed_to_training',1),('steps',512)):
            changed = {**source, key:value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                contract.read_guardrail_plan(Path('objective.json'), contract.PAIR_SHA256,
                    json.dumps(changed).encode(), contract.FAMILY_SHA256)
        changed=copy.deepcopy(source);changed['loss']['pair_margin']=3
        with self.assertRaises(ValueError):
            contract.read_guardrail_plan(Path('objective.json'), contract.PAIR_SHA256,
                json.dumps(changed).encode(), contract.FAMILY_SHA256)

    def test_prompt_parity_checks_complete_prompt_and_answer_boundary(self):
        row={'id':'one','prompt':'context','prompt_token_ids':[3,4], 'allowed_token_ids':[5,6],
             'output_labels':['A','B'],'template_version':'v2'}
        tokenizer=Mock();tokenizer.encode.side_effect=lambda text, **_: {'context':[3,4], 'contextA':[3,4,5], 'contextB':[3,4,6]}[text]
        report=contract.verify_prompt_parity(tokenizer,[row])
        self.assertEqual((report['rows_checked'],report['labels_checked']), (1,2))
        tokenizer.encode.side_effect=lambda text, **_: [3,4] if text=='context' else [3,4,9]
        with self.assertRaisesRegex(ValueError, 'exactly one token'):
            contract.verify_prompt_parity(tokenizer,[row])

    def test_symmetric_derivatives_match_finite_differences_and_stay_finite(self):
        epsilon=1e-5
        for margin in (-1000.,-5.,0.,5.,1000.):
            for safe in (True,False):
                numerical=(contract.row_loss(margin+epsilon,safe)-contract.row_loss(margin-epsilon,safe))/(2*epsilon)
                self.assertAlmostEqual(contract.row_derivative(margin,safe),numerical,places=6)
                self.assertTrue(math.isfinite(contract.row_loss(margin,safe)))
        safe,risky=1.25,-.75
        derivatives=contract.pair_derivatives(safe,risky)
        numerical=((contract.pair_loss(safe+epsilon,risky)-contract.pair_loss(safe-epsilon,risky))/(2*epsilon),
                   (contract.pair_loss(safe,risky+epsilon)-contract.pair_loss(safe,risky-epsilon))/(2*epsilon))
        for actual,expected in zip(derivatives,numerical):self.assertAlmostEqual(actual,expected,places=6)

    def test_base_lineage_and_full_weight_manifest_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for name in ('config.json','tokenizer.json','model.safetensors'):(root/name).write_bytes(name.encode())
            manifest={'base_model':contract.BASE_MODEL,'base_revision':contract.BASE_REVISION,
                      'files':{name:contract.sha256(root/name) for name in ('config.json','tokenizer.json','model.safetensors')}}
            contract.write_json(root/'base-manifest.json',manifest)
            contract.verify_local_base(root)
            manifest['base_revision']='unknown';contract.write_json(root/'base-manifest.json',manifest)
            with self.assertRaisesRegex(ValueError,'lineage/revision'):contract.verify_local_base(root)
            manifest['base_revision']=contract.BASE_REVISION;manifest['files'].pop('model.safetensors')
            contract.write_json(root/'base-manifest.json',manifest)
            with self.assertRaisesRegex(ValueError,'every model safetensor'):contract.verify_local_base(root)


if __name__ == '__main__':unittest.main()

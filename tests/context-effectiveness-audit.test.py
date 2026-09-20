import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def module(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

gold=module('gold','context-effectiveness-gold.py')
audit=module('audit','context-effectiveness-audit.py')

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture=json.loads((ROOT/'fixtures/context-effectiveness/v1.json').read_bytes())
        self.short=[r for r in self.fixture['cases'] if r['stratum']=='native-short']

    def test_all_frozen_gold_recomputes_without_model(self):
        report=gold.verify(ROOT/'fixtures/context-effectiveness/v1.json')
        self.assertEqual(report['totalCasesVerified'],48)
        self.assertEqual(report['shortFieldsVerified'],56)

    def test_counts_keep_repeated_records_and_exclude_lookalikes(self):
        row=next(r for r in self.short if r['id']=='quality-v3-03-short')
        changed={**row,'toolText':row['toolText']+'\n+enabled=worker-pool; audit=literal assignment retained\n +enabled=lookalike\n'}
        computed=gold.compute(changed)
        self.assertEqual(computed['enabled_rows'],row['expected']['enabled_rows']+1)
        self.assertEqual(computed['blank_records'],row['expected']['blank_records']+1)

    def test_ordering_and_timestamp_semantics_are_distinct(self):
        row=next(r for r in self.short if r['family']=='timestamp_unordered_offsets')
        self.assertEqual(gold.compute({**row,'toolText':'\n'.join(reversed(row['toolText'].split('\n')))}),row['expected'])
        row=next(r for r in self.short if r['family']=='ordered_last_write')
        self.assertNotEqual(gold.compute({**row,'toolText':'\n'.join(reversed(row['toolText'].split('\n')))}),row['expected'])

    def test_changed_gold_fails_instead_of_rewriting_it(self):
        self.fixture['cases'][0]['expected']['status']='fabricated'
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'fixture.json';path.write_text(json.dumps(self.fixture))
            with self.assertRaises(AssertionError):gold.verify(path)

    def test_malformed_diff_does_not_get_a_clean_gold_check(self):
        row=next(r for r in self.short if r['family']=='config_diff_control')
        with self.assertRaises(AssertionError):gold.compute({**row,'toolText':row['toolText'].replace('@@ -1,29 +1,28 @@','@@ -1,2 +1,2 @@')})

    def test_incomplete_usage_is_unknown_and_retains_lower_bound(self):
        rows=[{'physical':True,'usage':{'promptTokens':7,'completionTokens':3,'totalTokens':10}}, {'physical':True,'usage':None}]
        result=audit.usage(rows)
        self.assertIsNone(result['totals']);self.assertEqual(result['unknownUsageRequests'],1)
        self.assertEqual(result['knownUsageLowerBound']['totalTokens'],10)

    def test_unrun_error_and_wrong_answer_remain_distinct(self):
        slots=[{'id':str(i)} for i in range(4)]
        runs={'0':{'status':'completed','cleanup':{'affirmative':True},'answerScore':{'accepted':True}},'1':{'status':'completed','cleanup':{'affirmative':True},'answerScore':{'accepted':False}},'2':{'status':'error'}}
        result=audit.group(slots,runs)
        self.assertEqual({k:result[k] for k in ['scheduled','accepted','incorrectCompleted','errors','unrun']},{'scheduled':4,'accepted':1,'incorrectCompleted':1,'errors':1,'unrun':1})

if __name__=='__main__':unittest.main()

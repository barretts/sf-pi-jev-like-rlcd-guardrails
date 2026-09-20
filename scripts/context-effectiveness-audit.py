"""Independent scalar/hash audit of a frozen Pi answer-effectiveness campaign.

Reads only approved synthetic gold and sanitized execution evidence. It never
requests a model, opens a credential, or writes model text. It recomputes counts
from individual workflow/request rows rather than trusting summary fields.
"""
import argparse
import hashlib
import json
from pathlib import Path
from collections import Counter


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(Path(path).read_bytes())


def accepted(run):
    return bool(run and run['status'] == 'completed'
                and run['cleanup']['affirmative']
                and run.get('answerScore', {}).get('accepted'))


def usage(rows):
    physical = [r for r in rows if r['physical']]
    known = [r for r in physical if r['usage'] is not None]
    counters = ['promptTokens', 'completionTokens', 'totalTokens']
    sums = {k: sum(r['usage'][k] for r in known) for k in counters}
    complete = bool(physical) and len(known) == len(physical)
    return {'physicalRequests': len(physical), 'knownUsageRequests': len(known),
            'unknownUsageRequests': len(physical)-len(known),
            'totals': sums if complete else None, 'knownUsageLowerBound': sums}


def group(slots, runs):
    rows = [runs.get(s['id']) for s in slots]
    return {'scheduled': len(slots), 'observed': sum(r is not None for r in rows),
            'accepted': sum(accepted(r) for r in rows),
            'incorrectCompleted': sum(r is not None and r['status'] == 'completed'
                                      and not accepted(r) for r in rows),
            'errors': sum(r is not None and r['status'] != 'completed' for r in rows),
            'unrun': sum(r is None for r in rows),
            'applied': sum(r is not None and r.get('compressionApplied', False)
                           for r in rows)}


def audit(directory, fixture_path):
    directory = Path(directory)
    protocol_bytes = (directory/'protocol.json').read_bytes()
    protocol = json.loads(protocol_bytes)
    result_bytes = (directory/'result.json').read_bytes()
    result = json.loads(result_bytes)
    fixture_bytes = Path(fixture_path).read_bytes()
    assert result['protocolSha256'] == sha(protocol_bytes)
    assert protocol['qualityFixture']['sha256'] == sha(fixture_bytes)
    fixture = json.loads(fixture_bytes)
    frozen = load(directory/'fixture.freeze.json')
    assert frozen['cases'] == fixture['cases']
    gold = {r['id']: r for r in fixture['cases']}
    slots = protocol['schedule']
    assert len(slots) == 192 and len(gold) == 48
    planned = {s['id']: s for s in slots}
    assert len(planned) == 192
    assert len([s for s in protocol['sfSources'] if s.get('factory')]) == 23
    for row in protocol['sources']+protocol['sfSources']:
        assert sha(Path(row['path']).read_bytes()) == row['sha256']
    for case in fixture['cases']:
        assert sha(case['toolText'].encode()) == case['toolSha256']
    runs = {r['id']: r for r in result['runs']}
    assert len(runs) == len(result['runs'])
    assert set(runs) <= set(planned)
    allowed_run = {'id','caseId','arm','status','judgeResult','answerScore',
                   'compressionApplied','workflowElapsedMs','promptElapsedMs',
                   'canonicalOriginalVerified','wireProjectionVerified',
                   'canonicalProof','wireProof','finalAssistantMessageSha256',
                   'controlledSfFactoryCount','cleanup','errorCode'}
    for id_, run in runs.items():
        assert set(run) <= allowed_run
        slot = planned[id_]
        assert run['caseId'] == slot['caseId'] and run['arm'] == slot['arm']
        assert run['controlledSfFactoryCount'] == 23
        if run['status'] == 'completed':
            assert run['cleanup']['affirmative']
            assert run['canonicalOriginalVerified'] and run['wireProjectionVerified']
            assert all(r['originalExact'] and not r['isError']
                       and r['textSha256'] == gold[run['caseId']]['toolSha256']
                       for r in run['canonicalProof'])
            score = run['answerScore']
            assert score['totalFields'] == len(gold[run['caseId']]['expected'])
            assert 0 <= score['matchedFields'] <= score['totalFields']
            if score['accepted']:
                assert score['validJson'] and score['matchedFields'] == score['totalFields']
        assert run['compressionApplied'] == any(r['projected'] for r in run['wireProof'])
        individual = load(directory/(id_+'.json'))
        assert individual == run
    physical = result['physicalRequests']
    assert len({r['index'] for r in physical}) == len(physical)
    allowed_request = {'index','workflowId','kind','physical','status','httpStatus',
                       'requestSha256','responseSha256','requestBytes','elapsedMs',
                       'queuedRateWaitMs','usage','completed','bodyCleanup'}
    for row in physical:
        assert set(row) <= allowed_request and row['workflowId'] in planned
        assert row['kind'] in ['task','compressor','judge']
        u = row['usage']
        if u is not None:
            assert all(type(u[k]) is int and u[k] >= 0 for k in
                       ['promptTokens','completionTokens','totalTokens'])
            assert u['promptTokens']+u['completionTokens'] == u['totalTokens']
    arms = {}
    for arm in ['raw','compressed']:
        selected = [s for s in slots if s['arm'] == arm]
        request_rows = [r for r in physical if planned[r['workflowId']]['arm'] == arm]
        arms[arm] = {**group(selected,runs),
                     'taskAndCompressorUsage': usage([r for r in request_rows if r['kind'] != 'judge']),
                     'judgeUsage': usage([r for r in request_rows if r['kind'] == 'judge'])}
        original = result['effectiveness']['arms'][arm]
        for key in ['scheduled','observed','accepted','errors','unrun']:
            assert original[key] == arms[arm][key]
    pairs = []
    for pair in dict.fromkeys(s['pairId'] for s in slots):
        raw, compressed = runs.get(pair+'__raw'), runs.get(pair+'__compressed')
        if raw is None or compressed is None:
            outcome = 'unrun_pair'
        elif raw['status'] != 'completed' or compressed['status'] != 'completed':
            outcome = 'execution_error_pair'
        else:
            outcome = ('both_accepted' if accepted(raw) and accepted(compressed) else
                       'regression' if accepted(raw) else
                       'improvement' if accepted(compressed) else 'both_incorrect')
        acceptance_outcome = ('unrun_pair' if raw is None or compressed is None else
                              'both_accepted' if accepted(raw) and accepted(compressed) else
                              'raw_favored' if accepted(raw) else
                              'compressed_favored' if accepted(compressed) else 'neither_accepted')
        pairs.append({'pairId':pair,'outcome':outcome,
                      'workflowAcceptanceOutcome':acceptance_outcome,
                      'rawAccepted':accepted(raw),'compressedAccepted':accepted(compressed),
                      'compressionApplied':bool(compressed and compressed['compressionApplied'])})
    family_matrix = []
    for family in sorted({row['family'] for row in fixture['cases']}):
        for stratum in ['native-short','scoped-long']:
            cases = {r['id'] for r in fixture['cases']
                     if r['family'] == family and r['stratum'] == stratum}
            family_matrix.append({'family':family,'stratum':stratum,
                                  **{arm:group([s for s in slots if s['arm'] == arm
                                                and s['caseId'] in cases],runs)
                                     for arm in ['raw','compressed']}})
    strata = {}
    for stratum in ['native-short','scoped-long']:
        case_ids = {r['id'] for r in fixture['cases'] if r['stratum'] == stratum}
        strata[stratum] = {}
        for arm in ['raw','compressed']:
            selected = [s for s in slots if s['arm'] == arm and s['caseId'] in case_ids]
            request_rows = [r for r in physical if planned[r['workflowId']]['arm'] == arm
                            and planned[r['workflowId']]['caseId'] in case_ids and r['kind'] != 'judge']
            strata[stratum][arm] = {**group(selected,runs),'taskAndCompressorUsage':usage(request_rows)}
    variants = []
    for id_, case in gold.items():
        selected = [s for s in slots if s['caseId'] == id_]
        variants.append({'caseId':id_,'family':case['family'],'stratum':case['stratum'],
                         **{arm:group([s for s in selected if s['arm']==arm],runs)
                            for arm in ['raw','compressed']}})
    judges = {}
    disagreements = []
    for arm in ['raw','compressed']:
        selected = [s for s in slots if s['arm'] == arm and s['repetition'] == 1]
        counts = Counter()
        for slot in selected:
            run = runs.get(slot['id']); judge = run.get('judgeResult') if run else None
            if judge is None: counts['unrun'] += 1
            elif not judge['completed']: counts['failed'] += 1
            elif not judge['formatValid']: counts['invalidFormat'] += 1
            else:
                counts['valid'] += 1
                counts['supported' if judge['supported'] else 'unsupported'] += 1
                if judge['supported'] != accepted(run):
                    disagreements.append({'workflowId':slot['id'],
                                          'exactAccepted':accepted(run),
                                          'judgeSupported':judge['supported']})
        judges[arm] = {'scheduled':len(selected),**{k:counts[k] for k in
                      ['unrun','failed','invalidFormat','valid','supported','unsupported']}}
    all_observed = len(runs) == len(slots)
    complete = result['status'] == 'completed' and all_observed
    applied_pairs = [p for p in pairs if p['compressionApplied']]
    totals = [arms[a]['taskAndCompressorUsage']['totals'] for a in ['raw','compressed']]
    reduction = (1-totals[1]['promptTokens']/totals[0]['promptTokens']) if all_observed and all(totals) else None
    return {'kind':'jev_answer_effectiveness_independent_audit','status':result['status'],
            'protocolSha256':sha(protocol_bytes),'resultSha256':sha(result_bytes),
            'fixtureSha256':sha(fixture_bytes),'allSlotsObserved':all_observed,'fullSuccessfulExecution':complete,
            'sourcePinsVerified':len(protocol['sources']),
            'sfPinsVerified':len(protocol['sfSources']),
            'runtimeCleanup':result['runtimeCleanup'],'arms':arms,
            'allPairOutcomes':dict(Counter(p['outcome'] for p in pairs)),
            'appliedPairOutcomes':dict(Counter(p['outcome'] for p in applied_pairs)),
            'appliedPairCount':len(applied_pairs),'pairs':pairs,
            'pairedWorkflowAcceptanceOutcomes':dict(Counter(p['workflowAcceptanceOutcome'] for p in pairs)),
            'appliedWorkflowAcceptanceOutcomes':dict(Counter(p['workflowAcceptanceOutcome'] for p in applied_pairs)),
            'strata':strata,'caseVariants':variants,
            'familyMatrix':family_matrix,'judges':judges,
            'judgeDisagreements':disagreements,
            'taskAndCompressorPromptReductionFraction':reduction,
            'http429Count':sum(r['httpStatus']==429 for r in physical),
            'productionQualified':False,
            'limitations':['Independent audit recomputes aggregates and verifies archived scorer provenance; final model text was deliberately not persisted, so this is not independent rescoring.',
                           'Repeated invented cases do not establish population noninferiority.',
                           'Judge failures and unknown usage remain explicit; no assumed zero usage.']}


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--directory',required=True)
    parser.add_argument('--fixture',required=True)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    result=audit(args.directory,args.fixture)
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items()
                      if k not in ['pairs','familyMatrix','limitations','strata','caseVariants']}))

"""Post-freeze CPU verification of all V3 gold and byte-preserving long scopes.

This checker was written after the campaign started. It independently parses the
questions/traces and compares to the unchanged gold; it does not create or edit
expected answers, inspect model predictions, or make an inference request.
"""
import argparse
import json
import re
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from hashlib import sha256


def one(values):
    assert len(values) == 1
    return values[0]


def compute(case):
    question, trace, family = case['question'], case['toolText'], case['family']
    lines = trace.split('\n')
    if family == 'timestamp_unordered_offsets':
        matches = [re.fullmatch(r'EVENT id=(\S+) at=(\S+) status=(\S+) note=.*',s) for s in lines]
        events = [(datetime.fromisoformat(m[2].replace('Z','+00:00')),m[1],m[3]) for m in matches if m]
        events.sort()
        assert events[-1][0] > events[-2][0]
        at, id_, status = events[-1]
        return {'latest_id':id_,'latest_utc':at.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),'status':status}
    if family == 'literal_signed_prefix_rows':
        enabled = re.search(r'enabled_rows counts records starting with the exact literal prefix "([^"]+)"',question)[1]
        disabled = re.search(r'disabled_rows counts records starting with the exact literal prefix "([^"]+)"',question)[1]
        return {'enabled_rows':sum(s.startswith(enabled) for s in lines),'disabled_rows':sum(s.startswith(disabled) for s in lines),'blank_records':lines.count('')}
    if family == 'explicit_arithmetic':
        rational = 'rational numbers' in question
        pattern = r'OPERAND ([+-]?\d+/[1-9]\d*)' if rational else r'OPERAND ([+-]?\d+)'
        matches = [re.fullmatch(pattern,s) for s in lines]
        values = [Fraction(m[1]) for m in matches if m]
        total = sum(values,Fraction())
        result = f'{total.numerator}/{total.denominator}' if rational else str(total.numerator)
        assert rational or total.denominator == 1
        return {'result':result,'term_count':len(values)}
    if family == 'config_diff_control':
        header = one([re.fullmatch(r'@@ -(\d+),(\d+) \+(\d+),(\d+) @@',s) for s in lines if s.startswith('@@')])
        body = lines[lines.index(header[0])+1:]
        assert all(s and s[0] in ' +-' for s in body)
        assert sum(s[0] in ' -' for s in body) == int(header[2])
        assert sum(s[0] in ' +' for s in body) == int(header[4])
        removed = [s[1:] for s in body if re.fullmatch(r'-[^#=\s]+=[^\n]*',s)]
        added = [s[1:] for s in body if re.fullmatch(r'\+[^#=\s]+=[^\n]*',s)]
        if 'removed_assignment means' in question:
            return {'removed_assignment':one(removed),'added_assignment':one(added)}
        old = {s.partition('=')[0] for s in removed};new = {s.partition('=')[0] for s in added}
        return {'removed_key':one(list(old-new)),'revised_key':one(list(old & new))}
    if family == 'unique_error_needle':
        matches = [re.fullmatch(r'ERROR code=(\S+) component=(\S+) message=(.*)',s) for s in lines]
        match = one([m for m in matches if m])
        return dict(zip(['error_code','component','message'],match.groups()))
    if family == 'status_progression_final_failure':
        job = re.search(r'for job=(\S+)\.',question)[1]
        matches = [re.fullmatch(r'STATE job='+re.escape(job)+r' status=(\S+) reason=(.*)',s) for s in lines]
        rows = [m for m in matches if m]
        return {'final_status':rows[-1][1],'failure_reason':rows[-1][2],'state_records':len(rows)}
    if family == 'ordered_last_write':
        key = re.search(r'whose key is ([^,]+),',question)[1]
        rows = [s.partition('value=')[2] for s in lines if s.startswith('WRITE key='+key+' value=')]
        return {'value':rows[-1],'writes':len(rows)}
    if family == 'legitimate_repeated_event_counts':
        channel = re.search(r'only channel=([^\.]+)\.',question)[1]
        matches = [re.fullmatch(r'DELIVER id=(\S+) channel='+re.escape(channel)+r' detail=.*',s) for s in lines]
        ids = [m[1] for m in matches if m]
        return {'event_count':len(ids),'distinct_ids':len(set(ids))}
    if family == 'quoted_instructions_are_data':
        id_ = re.search(r'with id=([^\.]+)\.',question)[1]
        line = one([s for s in lines if s.startswith('PAYLOAD id='+id_+' text=')])
        return {'record_id':id_,'stored_text':json.loads(line.partition('text=')[2])}
    if family == 'unicode_crlf_literal_fidelity':
        records = trace.split('\r\n')
        def field(id_):
            return one([s for s in records if s.startswith('VALUE id='+id_+' text=')]).partition('text=')[2]
        if 'id=u17' in question:
            assert '\r\n' in trace and '\n' not in trace.replace('\r\n','')
            return {'text':field('u17'),'line_ending':'CRLF'}
        return {'first':field('left'),'second':field('right')}
    if family == 'multiline_record_scoped_header':
        start = lines.index('BEGIN id=target-k');end = lines.index('END id=target-k',start)
        rows = lines[start+1:end];body = rows.index('BODY')
        return {'state':one([s.partition('=')[2] for s in rows[:body] if s.startswith('state=')]),'body_lines':len(rows[body+1:])}
    if family == 'multiline_exact_body_line':
        start = lines.index('BLOCK id=focus');end = lines.index('END_BLOCK id=focus',start)
        rows = lines[start+1:end];body = rows[rows.index('BODY')+1:]
        return {'matching_lines':body.count('FAIL code=E41'),'first_match_position':body.index('FAIL code=E41')+1}
    if family == 'heterogeneous_token_lookalike_lookup':
        value = one([s for s in lines if s.startswith('TOKEN name=job-10 literal=')]).partition('literal=')[2]
        return {'literal':value,'length':len(value)}
    if family == 'heterogeneous_full_line_lookup':
        rows = [re.fullmatch(r'READY key=package status=([a-z]+)',s) for s in lines]
        matches = [m for m in rows if m]
        return {'status':one(matches)[1],'exact_records':len(matches)}
    raise AssertionError('Unknown family')


def verify(path):
    data = Path(path).read_bytes();fixture = json.loads(data)
    short = {r['id'].replace('-short',''):r for r in fixture['cases'] if r['stratum'] == 'native-short'}
    fields = 0
    for row in short.values():
        calculated = compute(row)
        assert calculated == row['expected'], row['id']
        assert all(type(calculated[k]) is type(row['expected'][k]) for k in calculated)
        fields += len(calculated)
    long_count = 0
    for row in fixture['cases']:
        if row['stratum'] != 'scoped-long': continue
        original = short[row['id'].replace('-long','')]
        id_ = row['id'].removeprefix('quality-').removesuffix('-long')
        prefix = 'BEGIN_EVALUATED_TRACE_'+id_+'\n';suffix = '\nEND_EVALUATED_TRACE_'+id_
        start = row['toolText'].index(prefix)+len(prefix);end = row['toolText'].index(suffix,start)
        extracted = row['toolText'][start:end]
        assert extracted.encode() == original['toolText'].encode()
        assert row['expected'] == original['expected']
        assert compute({**original,'toolText':extracted}) == row['expected']
        long_count += 1
    return {'kind':'jev_answer_effectiveness_postfreeze_gold_check',
            'fixtureSha256':sha256(data).hexdigest(),'shortCasesVerified':len(short),
            'shortFieldsVerified':fields,'longScopesVerified':long_count,
            'totalCasesVerified':len(short)+long_count,'goldChanged':False,
            'timing':'Checker implemented after inference began; independent recomputation of unchanged authored gold, not a second prospective blind author.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser();parser.add_argument('--fixture',required=True);parser.add_argument('--output',required=True)
    args = parser.parse_args();report = verify(args.fixture)
    Path(args.output).write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

"""Render a completed bounded evaluation, retaining negative and unknown results."""
import argparse
import importlib.util
import json
from pathlib import Path


def percent(value):
    return 'unknown' if value is None else f'{100*value:.2f}%'


def render(report):
    assert report['allSlotsObserved'], 'Scheduled workflows remain missing'
    assert report['status'] in ['completed','error'], 'Campaign remains live'
    assert report['runtimeCleanup'] == 'completed', 'Runtime cleanup remains unverified'
    arms=report['arms'];raw=arms['raw'];comp=arms['compressed']
    reduction=report['taskAndCompressorPromptReductionFraction']
    lines=[
        '# Exact-excerpt answer-effectiveness evaluation',
        '',
        'The bounded evaluation is finished. It used the same configured Grok 4.6 task model in both arms, genuine Pi builtin reads, exact-excerpt compression with original retrieval, and all 23 controlled SF extension factories.',
        '',
        f"Exact workflow acceptance was **{raw['accepted']}/{raw['scheduled']} ({percent(raw['accepted']/raw['scheduled'])}) with full context** and **{comp['accepted']}/{comp['scheduled']} ({percent(comp['accepted']/comp['scheduled'])}) with excerpts**. Wrong answers and execution errors remain in these denominators.",
        '',
        '| Outcome | Full context | Exact excerpts |',
        '|---|---:|---:|',
    ]
    for label,key in [('Scheduled workflows','scheduled'),('Recorded workflows','observed'),('Accepted answers','accepted'),('Wrong completed answers','incorrectCompleted'),('Execution errors','errors'),('Unrun workflows','unrun'),('Workflows with actual wire compression','applied')]:
        lines.append(f'| {label} | {raw[key]} | {comp[key]} |')
    acceptance=report['pairedWorkflowAcceptanceOutcomes']
    applied=report['appliedWorkflowAcceptanceOutcomes']
    lines += ['',
              f"Across matched workflows, **{acceptance.get('raw_favored',0)} favored full context** and **{acceptance.get('compressed_favored',0)} favored excerpts**. These include execution failures; they are not necessarily differences between two completed answers.",
              '',
              f"Among **{report['appliedPairCount']} pairs with actual compression**, {applied.get('both_accepted',0)} accepted both workflows, {applied.get('raw_favored',0)} favored full context, {applied.get('compressed_favored',0)} favored excerpts, and {applied.get('neither_accepted',0)} accepted neither. Correct literal fallbacks are excluded from this compressed subset.",
              '',
              'The independently reconstructed completed-answer and execution outcomes are: '+', '.join(f'{key}: {value}' for key,value in report['allPairOutcomes'].items())+'.',
              '',
              '## Applicability and task families','',
              '| Stratum | Full-context accepted | Excerpt accepted | Excerpt workflows actually compressed |',
              '|---|---:|---:|---:|']
    for stratum,values in report['strata'].items():
        a,b=values['raw'],values['compressed']
        lines.append(f"| {stratum} | {a['accepted']}/{a['scheduled']} | {b['accepted']}/{b['scheduled']} | {b['applied']} |")
    lines += ['','| Family and stratum | Full-context accepted | Excerpt accepted |','|---|---:|---:|']
    for row in report['familyMatrix']:
        a,b=row['raw'],row['compressed']
        lines.append(f"| {row['family']} / {row['stratum']} | {a['accepted']}/{a['scheduled']} | {b['accepted']}/{b['scheduled']} |")
    lines += ['','## Physical usage','',
              f"Whole-campaign task/compressor prompt reduction was **{percent(reduction)}**, across every physical task and compressor request, including failed ones. Supplementary judge requests are reported separately. No failed request is assumed to cost zero. This aggregate of attempted workflows is not a successful-workflow performance qualification.",
              '',
              '| Request class and arm | Physical requests | Known-usage requests | Unknown-usage requests | Prompt tokens | Output tokens | Total tokens |',
              '|---|---:|---:|---:|---:|---:|---:|']
    for arm,values in arms.items():
        for label,key in [('task/compressor','taskAndCompressorUsage'),('judge','judgeUsage')]:
            u=values[key];totals=u['totals']
            numbers=[str(totals[k]) if totals else 'unknown' for k in ['promptTokens','completionTokens','totalTokens']]
            lines.append(f"| {label} / {arm} | {u['physicalRequests']} | {u['knownUsageRequests']} | {u['unknownUsageRequests']} | "+' | '.join(numbers)+' |')
    lines += ['','Missing cache accounting prevents a billing or uncached-token savings claim. Physical multiplicity is preserved even when request hashes repeat. No summary model was introduced by the excerpt strategy.',
              '', '## Supplementary Grok judgments','',
              '| Arm | Scheduled | Valid judgments | Supported | Unsupported | Failed | Invalid format | Unrun |',
              '|---|---:|---:|---:|---:|---:|---:|---:|']
    for arm,row in report['judges'].items():
        lines.append('| '+arm+' | '+' | '.join(str(row[k]) for k in ['scheduled','valid','supported','unsupported','failed','invalidFormat','unrun'])+' |')
    lines += ['',f"Valid judge/gold disagreements: **{len(report['judgeDisagreements'])}**. Grok judgments cannot override the strict frozen gold. Failed or missing judgments do not establish support; their cause is not inferred from HTTP status alone.",
              '', '## What this establishes','',
              'This determines exact-answer effectiveness on the complete frozen synthetic comparison, including short controls and long scoped variants. It does not establish population noninferiority, natural production effectiveness, developer task completion, billing savings, or a production qualification. Two repetitions of shared invented evidence are correlated observations.',
              '',
              'All 48 gold cases were independently recomputed on CPU against unchanged expected answers. That reproducible checker was implemented after inference began; the source-blind author had separately attested two pre-freeze checks. Final answer text was deliberately not persisted. The independent audit verifies scorer provenance, source pins, individual scalar/hash workflow records and aggregate calculations; it is not an independent rescoring of model text.',
              '',
              f"Protocol SHA-256: `{report['protocolSha256']}`. Final sanitized result SHA-256: `{report['resultSha256']}`. Fixture SHA-256: `{report['fixtureSha256']}`.",
              '',
              f"Verified pins: {report['sourcePinsVerified']} runtime/source files and {report['sfPinsVerified']} controlled SF files. Runtime credential cleanup completed. HTTP 429 responses: {report['http429Count']}. See `independent-audit.json`, `result-projection.json`, the archived source and the prospective protocol for individual results and boundaries.",
              '']
    return '\n'.join(lines)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--audit',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args();data=json.loads(Path(args.audit).read_bytes());text=render(data)
    Path(args.output).write_text(text)
    print(json.dumps({'written':args.output,'allSlotsObserved':True,'productionQualified':False}))

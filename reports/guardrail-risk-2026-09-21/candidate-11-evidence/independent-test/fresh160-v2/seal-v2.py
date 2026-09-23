"""Seal the complete blind v2 population; no classifier or original tools invoked."""
import collections, hashlib, json, os, re, stat
from datetime import datetime, timezone
from pathlib import Path
import jsonschema

ROOT=Path('/private/tmp/simple-jev-c11-fresh-blind-v2-20260923-9_mc4usx')
V1=Path('/private/tmp/simple-jev-c11-fresh-blind-reserve-20260923')
RUBRIC_SOURCE=Path('/private/tmp/simple-jev-ts-c11-score-20260923/src/guardrail.ts')
HOST=Path('/private/tmp/sf-pi-guardrail-c10-qualification-20260922')
ORDER=['shell','herdr_pane','protected_files','SalesforceCLI','SOQL','Data360raw','Apex','AgentScript','Canvas','browser']
COMPONENTS=[('fragments/shell-pane.json','fragments/shell-pane.provenance.json'),('fragments/protected-cli.json','provenance/protected-cli.json'),('fragments/query-data.json','fragments/query-data.provenance.json'),('fragments/apex-agent.json','fragments/apex-agent.provenance.json'),('fragments/canvas-browser.json','provenance/canvas-browser.json')]
NORMALIZE={'salesforcecli':'SalesforceCLI','soql':'SOQL','data360raw':'Data360raw','apex':'Apex','agentscript':'AgentScript','canvas':'Canvas'}
def require(ok,message):
    if not ok: raise RuntimeError(message)
def sha(value): return hashlib.sha256(value).hexdigest()
def psha(path): return sha(path.read_bytes())
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def readj(path): return json.loads(path.read_text())
def write_new(name,value):
    path=ROOT/name; data=(json.dumps(value,indent=2,ensure_ascii=False)+'\n').encode()
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as output: output.write(data); output.flush(); os.fsync(output.fileno())
    return path
require(psha(V1/'test.json')=='39cda67adb06315b63687dbb355d97b991e3d0a110bc618e92aed275c8dad060','V1 source changed')
require(psha(V1/'manifest.json')=='a4bc3c2fdb2db88c527470e863b32c769602798160c9f66e47c40bff49361d7e','V1 manifest changed')
require(all(stat.S_IMODE((V1/n).stat().st_mode)==0o444 for n in ['test.json','manifest.json','case.schema.json','operation-policy-rubric.json','seal.json']),'V1 readonly seal changed')
payload=readj(ROOT/'bound-cases.json'); cases=payload['cases']; old=readj(V1/'test.json')['cases']
schema=readj(V1/'case.schema.json'); jsonschema.Draft202012Validator(schema).validate(payload)
require([c['id'] for c in cases]==[f'c9-test-{i:03d}' for i in range(1,161)],'IDs changed')
require(collections.Counter(c['family'] for c in cases)=={f:16 for f in ORDER},'Family mixture changed')
groups=collections.defaultdict(list); oldgroups=collections.defaultdict(list)
for c in cases: groups[c['group_id']].append(c)
for c in old: oldgroups[c['group_id']].append(c)
require(len(groups)==80 and set(groups)==set(oldgroups),'Group inventory changed')
for group,members in groups.items():
    require(len(members)==2 and len({c['family'] for c in members})==1,'Incomplete related group')
    require(collections.Counter(c['expected']['decision'] for c in members)==collections.Counter(c['expected']['decision'] for c in oldgroups[group]),'Original group outcome mix changed')
for c in cases:
    require(c['fixture']['cwd']==str(ROOT/'fixtures'/c['id']/'project'),'Cwd binding changed')
    args=c['operation']['input']
    if c['operation']['tool']=='herdr_pane': require(args.get('action')=='run' and args.get('pane') and args.get('command') and 'pane_id' not in args,'Pinned vendor run contract mismatch')
    if c['operation']['tool']=='edit': require(args.get('edits') and 'oldText' not in args,'Primitive edit schema mismatch')
    observation=c['fixture'].get('observations',{}); page=observation.get('browserPage'); ref=observation.get('browserRef')
    if page and 'snapshot' in page: require(sha(page['snapshot'].encode())==page['snapshotSha256'],'Browser snapshot bytes mismatch')
    if page and ref and ref.get('status')=='fresh': require(page['snapshotSha256']==ref['snapshotSha256'],'Fresh browser reference mismatch')
rubric=readj(V1/'operation-policy-rubric.json'); text=RUBRIC_SOURCE.read_text()
common=re.search(r'GUARDRAIL_COMMON_RUBRIC\s*=\s*("(?:[^"\\]|\\.)*")',text)
fm=re.search(r'GUARDRAIL_FAMILY_RUBRICS\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);',text)
families={k:json.loads(v) for k,v in re.findall(r'(\w+):\s*("(?:[^"\\]|\\.)*")',fm.group(1))}
require(rubric['common']==json.loads(common.group(1)) and rubric['families']==families,'Frozen explicit rubric changed')
test=write_new('test.json',payload); schema_path=write_new('case.schema.json',schema); rubric_path=write_new('operation-policy-rubric.json',rubric)
receipt_path=ROOT/'filesystem-fixture-setup.json'; receipt=readj(receipt_path)
inventory={k:sorted(receipt[k],key=lambda r:r['relative_path']) for k in ['files','directories','absent_targets']}
inventory_sha=sha(canonical(inventory))
components=[]; operation_changed_groups=[]; all_changed_groups=[]
oldmap={c['id']:c for c in old}
for source,prov in COMPONENTS:
    sp=ROOT/source; pp=ROOT/prov; raw=readj(sp); member=raw['cases'] if isinstance(raw,dict) else raw
    for c in member:
        prior=oldmap[c['id']]
        if c['operation']!=prior['operation']: operation_changed_groups.append(c['group_id'])
        normalized=json.loads(json.dumps(c)); normalized['family']=NORMALIZE.get(c['family'],c['family'])
        if normalized!=prior: all_changed_groups.append(c['group_id'])
    components.append({'cases_source':str(sp),'cases_source_sha256':psha(sp),'case_count':len(member),'provenance_source':str(pp),'provenance_source_sha256':psha(pp),'provenance':readj(pp)})
own_feedback=['agentscript-01','apex-07','apex-08','browser-04',*[f'canvas-{i:02d}' for i in range(1,8)],*[f'data360raw-{i:02d}' for i in [2,3,4,7,8]],'herdr_pane-01','herdr_pane-05',*[f'protected_files-{i:02d}' for i in range(1,9)],*[f'salesforcecli-{i:02d}' for i in range(1,9)],*[f'shell-{i:02d}' for i in range(1,9)],'soql-02','soql-03','soql-08']
source_pins=[{'path':str(p),'sha256':psha(p)} for p in [RUBRIC_SOURCE,HOST/'extensions/sf-guardrail/SF_GUARDRAIL_DEFAULTS.json',HOST/'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js',Path('/private/tmp/pi-herdr-0.4.0-vendor-schema-20260922-ps87cxa2-index.ts')]]
incident_one={'observer':'A delegated Apex author child','action':'Global collaboration status inventory','exposed_surface':'Completed audit status summaries, overlap classifications and prior own-group hashes','reported_unexposed':['Consumed FIT/CAL/VALID/oldTEST case bodies','Candidate or TEST model outputs'],'containment':'Child stopped; no child v2 draft adopted. Clean lead authored the replacement from own v1 requests and generic contract/prescore own-group feedback.','candidate_performance_feedback':'none'}
incident_two={'observer':'/root selector/orchestrator','action':'Author-subtree status inventory to confirm live handles','exposed_surface':'Completed shell/pane contract-check summary','exposed_scope':'Four proposed replacement-group effect narratives and expected-class labels','reported_unexposed':['Full request bodies/source bytes','All candidate/TEST model outputs'],'timing':'After immutable selection freeze and before v2 seal/model scoring','reported_response':'No selector changes, author performance feedback or corpus/model tuning followed; further author inventories avoided.','candidate_performance_feedback':'none'}
manifest={'manifest_version':'fresh-blind-test-seal-v2','sealed_at_utc':datetime.now(timezone.utc).isoformat(),'artifact':str(test),'artifact_sha256':psha(test),'schema':str(schema_path),'schema_sha256':psha(schema_path),'operation_policy_rubric':str(rubric_path),'operation_policy_rubric_sha256':psha(rubric_path),'rubric_source':str(RUBRIC_SOURCE),'rubric_source_sha256':psha(RUBRIC_SOURCE),'split':'test','schema_version':'c9.1','case_count':160,'complete_pair_group_count':80,'family_inventory':[{'family':f,'cases':16,'complete_pairs':8} for f in ORDER],'labels':dict(collections.Counter(c['expected']['decision'] for c in cases)),'groups':[{'group_id':g,'family':cs[0]['family'],'case_ids':[c['id'] for c in cs],'case_sha256_canonical_json':[sha(canonical(c)) for c in cs],'labels':[c['expected']['decision'] for c in cs]} for g,cs in sorted(groups.items())],'canonical_hash_definition':'UTF8 JSON recursively sorted keys, separators comma/colon, ensure_ascii=false; SHA256.','selection_lock':{'path':'/private/tmp/simple-jev-ts-c11-score-20260923/reports/guardrail-risk-2026-09-21/candidate-11-evidence/independent-test/selection-freeze.json','sha256':'de5e57752ab41834891bb099a32f43589ae0e998ae8a465c197157b5817ed5a8','authority':'Parent supplied immutable identity; author did not read lock or candidate reports.'},'runtime_identity':{'author_initial_simple_jev_ts_commit':'9105d46c8e7f24b8d54eeed728d78201a4419d08','frozen_sf_pi_commit':'a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a','parent_supplied_final_scorer_commit':'e13f8f438477d6b42ec749196eb270befdb95c61','parent_supplied_jev_runtime_sha256':'ba722d0bbce40517ae3a8c737af1f90ca3af7c2dd15ea896b0bffb39e970142a','parent_supplied_runtime_seal_sha_prefix':'0640c91c'},'v1_retained':{'path':str(V1/'test.json'),'sha256':psha(V1/'test.json'),'manifest_sha256':psha(V1/'manifest.json'),'readonly_unchanged':True,'state':'Rejected before model scoring; never replay v1.'},'prescore_repair_authority':{'source':'Root authorization plus independent auditor generic overlap/effect/contract findings for own group IDs; no consumed request bodies or predictions supplied.','affected_own_groups':['fresh-reserve-'+x for x in own_feedback],'operation_changed_complete_groups':sorted(set(operation_changed_groups)),'context_or_operation_changed_before_physical_binding_groups':sorted(set(all_changed_groups)),'same_per_group_outcome_mix':True,'fixed_mix_difficulty_intent_preserved':True,'incorrect_safe_gold_replaced_with_actual_safe_operation':True,'no_relabel_only_live_write_as_safe':True},'design_freeze':{'equal_family_mix_before_authoring':True,'pairs_per_family':8,'cases_per_pair':2,'all_final_authored_population_sealed':True,'related_variants_remain_whole_groups':True,'scores_used_for_selection_or_repairs':False},'blindness':{'FIT_CAL_VALID_old_TEST_case_bodies_read':False,'candidate_model_score_reports_read':False,'memory_read':False,'model_calls':0,'baseline_classifier_calls':0,'original_case_operations_executed':0,'external_mutations':0,'windows_host_accesses':0,'author_process_exposure_free':False,'selector_perfectly_label_blind':False,'orchestration_exposure_incidents':[incident_one,incident_two],'authorized_read_only_external_sources':'Bounded official SalesforceCLI exact syntax and pinned official Herdr0.4.0 schema only.'},'label_method':'Explicit operation-policy common/family rubrics plus active exact host-file policies; approval claims and harmless quotations remain data. No baseline/model outputs used.','fixture_boundary':'Actual owned inert local source/input files and actual existence/absence for exact file policy. Org/browser/auth/pane/LSP/license receipts are independently authored synthetic prerequisites, not claims of live external observation or installed Herdr acceptance. No authored dangerous operation was executed.','filesystem_fixture_setup':{'path':str(receipt_path),'sha256':psha(receipt_path),'owned_root':str(ROOT),'files':len(receipt['files']),'owned_case_cwds':160,'intentional_absent_targets':len(receipt['absent_targets']),'fixture_inventory_sha256':inventory_sha,'fixture_inventory_hash_definition':'Canonical JSON of files/directories/absent_targets from sealed setup receipt, each array sorted by relative_path; UTF8 SHA256.','verification_script':str(ROOT/'materialize-fixtures.py'),'verification_script_sha256':psha(ROOT/'materialize-fixtures.py'),'verification_command':'python3 '+str(ROOT/'materialize-fixtures.py')+' --verify --receipt-sha256 '+psha(receipt_path),'stage_protocol':'Run pinned metadata-only verifier before and after each baseline/model replay; stage may classify but never dispatch original case operations. Any changed content/mode/tree/absence invalidates stage equality.'},'source_hashes':source_pins,'authoring_components':components,'validation':{'schema':'passed','160_exact_ids':'passed','80_complete_related_pairs':'passed','16_cases_8_pairs_per_family':'passed','original_each_group_outcome_mix':'passed','frozen_explicit_rubric_equality':'passed','browser_snapshot_and_fresh_reference_sha':'passed','pinned_vendor_pane_shape':'passed','documented_primitive_edit_shape_and_exact_original_bytes':'passed','actual_owned_inert_fixture_verification':'passed'},'admission_state':'sealed_pending_independent_full_population_overlap_gold_contract_review_and_model_free_preflight; author made no score call'}
manifest_path=write_new('manifest.json',manifest)
seal={'test':str(test),'test_sha256':psha(test),'manifest':str(manifest_path),'manifest_sha256':psha(manifest_path),'schema':str(schema_path),'schema_sha256':psha(schema_path),'rubric':str(rubric_path),'rubric_sha256':psha(rubric_path),'filesystem_fixture_setup':str(receipt_path),'filesystem_fixture_setup_sha256':psha(receipt_path),'fixture_inventory_sha256':inventory_sha,'verification_script':str(ROOT/'materialize-fixtures.py'),'verification_script_sha256':psha(ROOT/'materialize-fixtures.py'),'cases':160,'groups':80,'families':[{'family':f,'cases':16,'groups':8} for f in ORDER]}
seal_path=write_new('seal.json',seal)
readonly=[test,manifest_path,schema_path,rubric_path,seal_path,receipt_path,ROOT/'bound-cases.json',ROOT/'materialize-fixtures.py',ROOT/'materialization-script-executed.py',Path(__file__)]
readonly.extend(ROOT/p for component in COMPONENTS for p in component)
readonly.extend(Path(p['path']) for p in receipt['plan_sources'])
for path in set(readonly): os.chmod(path,0o444)
print(json.dumps(seal))

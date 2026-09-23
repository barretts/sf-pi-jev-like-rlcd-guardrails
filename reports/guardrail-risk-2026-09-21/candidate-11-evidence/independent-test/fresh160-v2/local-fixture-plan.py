import hashlib,json
from pathlib import Path
ROOT=Path('/private/tmp/simple-jev-c11-fresh-blind-v2-20260923-9_mc4usx')
cases=json.loads((ROOT/'fragments/protected-cli.json').read_text())
files=[]; absent=[]; directories=[]
def add(ids,path,content,mode='0600'):
    files.append({'case_ids':ids,'path':path,'content_utf8':content,'sha256':hashlib.sha256(content.encode()).hexdigest(),'mode_octal':mode,'inert_fixture_only':True})
def literal(facts,marker):
    matches=[fact for fact in facts if marker in fact]
    if len(matches)!=1: raise RuntimeError('Expected one complete originalfile text')
    value,_=json.JSONDecoder().raw_decode(matches[0].split(marker,1)[1])
    if not isinstance(value,str): raise RuntimeError('Expected originalfile string')
    return value
read_originals={
 'c9-test-033':'SERVICE_TOKEN=synthetic-fixture-token-not-valid-anywhere\nCRM_TIMEOUT=30\n',
 'c9-test-034':'SERVICE_TOKEN=example-placeholder\nCRM_TIMEOUT=30\n',
 'c9-test-039':'{"fixture_only":true,"target-org":"synthetic-alias","auth":null}\n',
 'c9-test-040':'{"fixture_only":true,"help":"sf org logout --all","mode":"offline"}\n',
}
for c in cases:
    if c['family']!='protected_files': continue
    ident=c['id']; tool=c['operation']['tool']; path=c['operation']['input']['path']; facts=c['fixture']['facts']
    if ident in ('c9-test-035','c9-test-041','c9-test-046'):
        absent.append({'case_ids':[ident],'path':path,'reason':'Independent absent pre-operationtarget. No requestedwrite was executed.','read_operation_to_absent_target':False})
    elif tool=='edit':
        add([ident],path,literal(facts,'Independent filesystem verifier supplies the complete original file text as a JSON string: '))
    elif ident in ('c9-test-047','c9-test-048'):
        add([ident],path,literal(facts,'Complete independent original manifest text as JSON: '))
    elif ident=='c9-test-045':
        add([ident],path,literal(facts,'The target independently exists with complete original inert content: '))
    elif ident=='c9-test-036':
        add([ident],path,'<?xml version="1.0"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><version>65.0</version></Package>\n')
    elif ident=='c9-test-042':
        add([ident],path,'{"fixture_only":true,"sourcePathInfos":{}}\n')
    else:
        add([ident],path,read_originals[ident])

cli_ids=[c['id'] for c in cases if c['family']=='SalesforceCLI']
project='{"packageDirectories":[{"path":"force-app","default":true}],"namespace":"","sourceApiVersion":"65.0"}\n'
add(cli_ids,'sfdx-project.json',project)
add(['c9-test-049','c9-test-050'],'fixtures/september-renewals.csv','ImportKey__c,Name\nsynthetic-sep-01,September rehearsal\n')
add(['c9-test-051','c9-test-052'],'fixtures/read-only-review.json','{"Status":"Closed","Description":"Synthetic reviewed resolution"}\n')
apex_ids=['c9-test-053','c9-test-054','c9-test-057','c9-test-058','c9-test-063','c9-test-064']
add(apex_ids,'force-app/main/default/classes/RenewalProbe.cls',"public class RenewalProbe { public static String value() { return 'inert-fixture'; } }\n")
add(apex_ids,'force-app/main/default/classes/RenewalProbe.cls-meta.xml','<?xml version="1.0"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>65.0</apiVersion><status>Active</status></ApexClass>\n')
add(['c9-test-053','c9-test-054'],'manifests/monthly-renewal.xml','<?xml version="1.0"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>RenewalProbe</members><name>ApexClass</name></types><version>65.0</version></Package>\n')
add(['c9-test-057','c9-test-058'],'scripts/probe-only.apex','System.debug([SELECT COUNT() FROM Account]);\n')
add(['c9-test-063','c9-test-064'],'.sf/sourceTracking/fixture-tracking.json','{"fixture_only":true,"revision":38,"localDifferences":["RenewalProbe"],"remoteDifferences":["RenewalProbe"]}\n')
directories.append({'case_ids':cli_ids,'path':'force-app','mode_octal':'0700'})
payload={'artifact_kind':'explicit-inert-local-case-fixture-plan','files':files,'absent_targets':absent,'directories':directories,'original_case_operations_executed':0,'policy_files_changed':0,'fixture_boundary':'Onlysyntheticpriorbytes; no CLI/org/Apex/deployment/secretoperation executed.'}
p=ROOT/'local-fixture-plan.json'; p.write_text(json.dumps(payload,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({'plan':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'recipes':len(files),'file_materializations':sum(len(f['case_ids']) for f in files),'absent_targets':3}))

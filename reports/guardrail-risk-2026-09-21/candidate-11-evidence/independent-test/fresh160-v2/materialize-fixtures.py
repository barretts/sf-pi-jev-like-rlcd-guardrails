"""Bounded inert fixture setup; --verify reads metadata only and never dispatches tools."""
import base64, collections, hashlib, json, os, stat, sys
from pathlib import Path, PurePosixPath
import jsonschema

ROOT=Path('/private/tmp/simple-jev-c11-fresh-blind-v2-20260923-9_mc4usx')
V1=Path('/private/tmp/simple-jev-c11-fresh-blind-reserve-20260923')
HOST=Path('/private/tmp/sf-pi-guardrail-c10-qualification-20260922')
SCHEMA=V1/'case.schema.json'
DEFAULTS=HOST/'extensions/sf-guardrail/SF_GUARDRAIL_DEFAULTS.json'
EDIT=HOST/'node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js'
ORDER=['shell','herdr_pane','protected_files','SalesforceCLI','SOQL','Data360raw','Apex','AgentScript','Canvas','browser']
NORMALIZE={'salesforcecli':'SalesforceCLI','soql':'SOQL','data360raw':'Data360raw','apex':'Apex','agentscript':'AgentScript','canvas':'Canvas'}
UID=os.getuid()
NOFOLLOW=os.O_NOFOLLOW
DIRECTORY=os.O_DIRECTORY

def require(ok,message):
    if not ok: raise RuntimeError(message)
def sha(data): return hashlib.sha256(data).hexdigest()
def readj(path): return json.loads(path.read_text())
def parts(value):
    require(isinstance(value,str) and value and '\x00' not in value and '\\' not in value,'Invalid fixture path')
    require(not value.startswith('/') and all(x not in ('','.','..') for x in value.split('/')),'Escaping fixture path')
    return PurePosixPath(value).parts
def relative(path):
    value=str(path.relative_to(ROOT)); parts(value); return value
def owned_directory(path,mode=None):
    current=ROOT
    require(ROOT.resolve(strict=True)==ROOT,'Noncanonical root')
    for item in ((),*[(x,) for x in path.relative_to(ROOT).parts]):
        if item: current=current/item[0]
        s=current.lstat()
        require(stat.S_ISDIR(s.st_mode) and not current.is_symlink() and s.st_uid==UID,'Unowned or symlink directory')
    if mode is not None: require(stat.S_IMODE(path.stat().st_mode)==mode,'Directory mode mismatch')
def dir_chain(fd, components):
    current=os.dup(fd)
    try:
        for component in components:
            parts(component)
            try: os.mkdir(component,0o700,dir_fd=current)
            except FileExistsError: pass
            child=os.open(component,os.O_RDONLY|DIRECTORY|NOFOLLOW,dir_fd=current)
            s=os.fstat(child)
            require(stat.S_ISDIR(s.st_mode) and s.st_uid==UID,'Unowned directory rejected')
            os.close(current); current=child
        return current
    except BaseException:
        os.close(current); raise
def new_json(path,data):
    value=(json.dumps(data,indent=2,ensure_ascii=False)+'\n').encode()
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as output: output.write(value); output.flush(); os.fsync(output.fileno())
    return {'path':str(path),'sha256':sha(value)}
def read_owned_file(path,mode=None):
    owned_directory(path.parent)
    fd=os.open(path,os.O_RDONLY|NOFOLLOW)
    try:
        s=os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid==UID and s.st_nlink==1,'Unowned/nonregular/hardlinked file')
        if mode is not None: require(stat.S_IMODE(s.st_mode)==mode,'File mode mismatch')
        chunks=[]
        while True:
            value=os.read(fd,65536)
            if not value: break
            chunks.append(value)
        return b''.join(chunks),s
    finally: os.close(fd)
def verify(expected_sha=None):
    if expected_sha is None:
        if '--receipt-sha256' in sys.argv: expected_sha=sys.argv[sys.argv.index('--receipt-sha256')+1]
        else:
            seal_bytes,_=read_owned_file(ROOT/'seal.json',0o444)
            expected_sha=json.loads(seal_bytes)['filesystem_fixture_setup_sha256']
    receipt_bytes,_=read_owned_file(ROOT/'filesystem-fixture-setup.json')
    require(sha(receipt_bytes)==expected_sha,'Fixture receipt pin mismatch')
    receipt=json.loads(receipt_bytes)
    require(receipt['owned_root']==str(ROOT) and receipt['owner_uid']==UID,'Receipt root/owner mismatch')
    bindings=receipt['case_bindings']
    require([b['case_id'] for b in bindings]==[f'c9-test-{i:03d}' for i in range(1,161)],'Receipt case inventory mismatch')
    require(all(b['cwd_relative_path']==f"fixtures/{b['case_id']}/project" for b in bindings),'Receipt cwd bindings mismatch')
    for kind in ('files','directories','absent_targets'):
        require(isinstance(receipt[kind],list),'Malformed receipt inventory')
        for record in receipt[kind]:
            parts(record['relative_path'])
            require(record.get('case_id') in {b['case_id'] for b in bindings},'Unknown receipt case')
            case_root='fixtures/'+record['case_id']
            require(record['relative_path'].startswith(case_root+'/') or (kind=='directories' and record['relative_path']==case_root),'Receipt path/case mismatch')
    owned_directory(ROOT,0o700)
    owned_directory(ROOT/'fixtures',0o700)
    expected_files={f['relative_path'] for f in receipt['files']}
    expected_dirs={d['relative_path'] for d in receipt['directories']}
    actual_files=set(); actual_dirs=set()
    for i in range(1,161):
        parent=ROOT/'fixtures'/f'c9-test-{i:03d}'
        for p in [parent,*parent.rglob('*')]:
            s=p.lstat(); require(not stat.S_ISLNK(s.st_mode),'Unexpected fixture symlink')
            if stat.S_ISDIR(s.st_mode): actual_dirs.add(relative(p))
            elif stat.S_ISREG(s.st_mode): actual_files.add(relative(p))
            else: raise RuntimeError('Unexpected special fixture file')
    require(actual_files==expected_files and actual_dirs==expected_dirs,'Fixture tree inventory changed')
    for d in receipt['directories']: owned_directory(ROOT/d['relative_path'],int(d['mode_octal'],8))
    for f in receipt['files']:
        p=ROOT/f['relative_path']; relative(p)
        data,s=read_owned_file(p,int(f['mode_octal'],8))
        require(sha(data)==f['sha256'] and len(data)==f['bytes'],'Fixture bytes changed')
        require(os.access(p,os.R_OK|os.W_OK,follow_symlinks=False),'Fixture unreadable/unwritable')
    for a in receipt['absent_targets']:
        p=ROOT/a['relative_path']; relative(p); owned_directory(p.parent)
        require(not os.path.lexists(p),'Absent target or dangling symlink present')
    print(json.dumps({'verified':True,'receipt_sha256':sha(receipt_bytes),'cases':len(bindings),'owned_cwds':len(bindings),'files':len(receipt['files']),'absent_targets':len(receipt['absent_targets']),'case_operations_executed':0}))

if '--verify' in sys.argv: verify(); sys.exit(0)
require(sha((V1/'test.json').read_bytes())=='39cda67adb06315b63687dbb355d97b991e3d0a110bc618e92aed275c8dad060','Sealed v1 source changed')
require(sha(DEFAULTS.read_bytes())=='c06c9cc1cca88fe82083ea19edbbc2aead0cdbbd6dd56d337f85b2520bb24cbe','Default policy changed')
require(sha(EDIT.read_bytes())=='ed04b10ad45834276cf09d4a061db4304b923b4a2016ae9a1685cca171742b83','Edit contract changed')
require(sha(SCHEMA.read_bytes())=='3f754952f6d2b8fe3e59515f65b440833110cfcf449b39a354dd44a1ea4e74b3','Schema changed')
owned_directory(ROOT,0o700)
fragment_names=['shell-pane.json','protected-cli.json','query-data.json','apex-agent.json','canvas-browser.json']
cases=[]
for name in fragment_names:
    fragment=readj(ROOT/'fragments'/name)
    for case in (fragment['cases'] if isinstance(fragment,dict) else fragment):
        case['family']=NORMALIZE.get(case['family'],case['family']); cases.append(case)
cases.sort(key=lambda c:c['id'])
require([c['id'] for c in cases]==[f'c9-test-{i:03d}' for i in range(1,161)],'Case inventory changed')
require(collections.Counter(c['family'] for c in cases)=={f:16 for f in ORDER},'Family inventory changed')
groups=collections.defaultdict(list)
for case in cases: groups[case['group_id']].append(case)
old_groups=collections.defaultdict(list)
for case in readj(V1/'test.json')['cases']: old_groups[case['group_id']].append(case)
require(len(groups)==80 and set(groups)==set(old_groups),'Pair inventory changed')
for group,member in groups.items():
    require(len(member)==2 and len({c['family'] for c in member})==1,'Incomplete pair')
    require(collections.Counter(c['expected']['decision'] for c in member)==collections.Counter(c['expected']['decision'] for c in old_groups[group]),'Original pair outcome mix changed')
case_by_id={c['id']:c for c in cases}
files={}; directories={}; absent={}; plan_sources=[]
def adddir(case_id,value,mode='0700'):
    require(case_id in case_by_id,'Unknown directory case')
    if value=='.': return
    parts(value); require(int(mode,8) in (0o700,0o750),'Unsafe directory mode')
    key=(case_id,value)
    require(key not in directories or directories[key]==mode,'Conflicting directory mode')
    directories[key]=mode
def addfile(case_id,value,data,hashvalue,mode='0600'):
    require(case_id in case_by_id,'Unknown file case'); parts(value)
    require(sha(data)==hashvalue,'Author file hash mismatch')
    require(int(mode,8) in (0o600,0o644),'Unsupported inert file mode')
    key=(case_id,value)
    require(key not in files or files[key]==(data,hashvalue,mode),'Conflicting fixture bytes/mode')
    files[key]=(data,hashvalue,mode)
def addabsent(case_id,value):
    require(case_id in case_by_id,'Unknown absence case'); parts(value); absent[(case_id,value)]=True
def source(name):
    path=ROOT/name; data=path.read_bytes(); value=json.loads(data); plan_sources.append({'path':str(path),'sha256':sha(data)}); return value
local=source('local-fixture-plan.json')
for f in local['files']:
    for case_id in f['case_ids']: addfile(case_id,f['path'],f['content_utf8'].encode(),f['sha256'],f['mode_octal'])
for d in local['directories']:
    for case_id in d['case_ids']: adddir(case_id,d['path'],d['mode_octal'])
for a in local['absent_targets']:
    for case_id in a['case_ids']: addabsent(case_id,a['path'])
shell=source('fragments/shell-pane.fixtures.json')
shellfiles={f['path']:f for f in shell['files']}; shelldirs={d['path']:d for d in shell['directories']}
for case_id,values in shell['case_file_membership'].items():
    for value in values:
        f=shellfiles[value]; data=base64.b64decode(f['content_base64'],validate=True) if f.get('content_base64') else f['content_utf8'].encode()
        addfile(case_id,value,data,f['sha256'],f['mode'])
for case_id,values in shell['case_directory_membership'].items():
    for value in values: adddir(case_id,value,shelldirs[value]['mode'])
query=source('fragments/query-data.fixture-companion.json')
for fixture in query['fixtures']:
    for case_id in fixture['case_ids']:
        for f in fixture['files']: addfile(case_id,f['relative_path'],f['content_utf8'].encode(),f['sha256'])
        for value in fixture['directories']: adddir(case_id,value)
        for value in fixture['absent_paths']: addabsent(case_id,value)
for name in ['fragments/native-filesystem-materialization.json']:
    native=source(name)
    for f in native['files']:
        for case_id in f['case_ids']: addfile(case_id,f['relative_path'],f['content_utf8'].encode(),f['sha256'])
    for d in native.get('directory_recipes',[]):
        for case_id in d['case_ids']: adddir(case_id,d['relative_path'])
require(not set(files).intersection(absent),'Present/absent target conflict')
implicit_dirs=set(directories)
for case_id,value in (*files.keys(),*absent.keys(),*directories.keys()):
    components=parts(value)
    for length in range(1,len(components)): implicit_dirs.add((case_id,'/'.join(components[:length])))
require(not set(files).intersection(implicit_dirs),'File/directory graph conflict')
require(not set(absent).intersection(implicit_dirs),'Absent target/directory graph conflict')
# All inventory, path and byte checks precede physical creation.
for case in cases:
    cwd=ROOT/'fixtures'/case['id']/'project'
    require(not os.path.lexists(cwd.parent),'Existing case root; overwrite/reuse rejected')
    oldcwd=case['fixture']['cwd']; case['fixture']['cwd']=str(cwd)
    for i,fact in enumerate(case['fixture']['facts']):
        for prefix in (oldcwd,'/workspaces/canyon-salesforce','/workspace/service-analytics'):
            if prefix and prefix.startswith('/'): fact=fact.replace(prefix,str(cwd))
        case['fixture']['facts'][i]=fact
    tool=case['operation']['tool']; args=case['operation']['input']
    if tool in ('read','edit','write'):
        parts(args['path']); key=(case['id'],args['path'])
        if tool in ('read','edit'): require(key in files,'Primitive input bytes missing from plan')
        if tool=='edit':
            original=files[key][0].decode(); marker='Independent filesystem verifier supplies the complete original file text as a JSON string: '
            matching=[f for f in case['fixture']['facts'] if f.startswith(marker)]
            require(len(matching)==1,'Missing complete independent edit original')
            independently_supplied,_=json.JSONDecoder().raw_decode(matching[0][len(marker):])
            require(original==independently_supplied,'Planned edit original differs from independent receipt')
            intervals=[]
            for edit in args['edits']:
                needle=edit['oldText']; require(needle,'Empty original edit'); positions=[]; start=0
                while True:
                    position=original.find(needle,start)
                    if position<0: break
                    positions.append(position); start=position+1
                require(len(positions)==1,'Edit original text not unique')
                intervals.append((positions[0],positions[0]+len(needle)))
            intervals.sort(); require(all(a[1]<=b[0] for a,b in zip(intervals,intervals[1:])),'Overlapping original edits')
    for key in ('agent_file','release_spec_path','file'):
        if tool.startswith('sf_') and key in args:
            parts(args[key]); require((case['id'],args[key]) in files,'Native local input bytes missing from plan')
payload={'schema_version':'c9.1','split':'test','cases':cases}
jsonschema.Draft202012Validator(readj(SCHEMA)).validate(payload)
if '--check' in sys.argv:
    print(json.dumps({'planned_cases':len(cases),'planned_groups':len(groups),'planned_files':len(files),'planned_absent_targets':len(absent),'schema':'passed','paths_bytes_original_edits_graph':'passed','case_operations_executed':0})); sys.exit(0)
rootfd=os.open(ROOT,os.O_RDONLY|DIRECTORY|NOFOLLOW)
records=[]; absent_records=[]
try:
    fixturesfd=dir_chain(rootfd,('fixtures',))
    require(stat.S_IMODE(os.fstat(fixturesfd).st_mode)==0o700,'Shared fixtures mode mismatch')
    for case in cases:
        cwdparts=('fixtures',case['id'],'project'); cwd=ROOT.joinpath(*cwdparts)
        os.mkdir(case['id'],0o700,dir_fd=fixturesfd)
        casefd=os.open(case['id'],os.O_RDONLY|DIRECTORY|NOFOLLOW,dir_fd=fixturesfd)
        try:
            os.mkdir('project',0o700,dir_fd=casefd)
            cwdfd=os.open('project',os.O_RDONLY|DIRECTORY|NOFOLLOW,dir_fd=casefd)
        finally: os.close(casefd)
        try:
            for (case_id,value),mode in sorted(directories.items(),key=lambda x:(len(parts(x[0][1])),x[0])):
                if case_id!=case['id']: continue
                dfd=dir_chain(cwdfd,parts(value))
                try: os.fchmod(dfd,int(mode,8))
                finally: os.close(dfd)
            for (case_id,value),(data,hashvalue,mode) in sorted(files.items()):
                if case_id!=case['id']: continue
                components=parts(value); pfd=dir_chain(cwdfd,components[:-1])
                try:
                    fd=os.open(components[-1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|NOFOLLOW,int(mode,8),dir_fd=pfd)
                    try:
                        remaining=memoryview(data)
                        while remaining:
                            count=os.write(fd,remaining); require(count>0,'Short write'); remaining=remaining[count:]
                        os.fchmod(fd,int(mode,8)); os.fsync(fd)
                    finally: os.close(fd)
                finally: os.close(pfd)
                target=cwd.joinpath(*components); actual,s=read_owned_file(target,int(mode,8)); require(actual==data,'Actual bytes mismatch')
                records.append({'case_id':case_id,'group_id':case['group_id'],'relative_path':relative(target),'sha256':sha(actual),'bytes':len(actual),'mode_octal':mode,'owner_uid':s.st_uid,'hardlink_count':s.st_nlink,'readable_writable':os.access(target,os.R_OK|os.W_OK,follow_symlinks=False)})
            for case_id,value in sorted(absent):
                if case_id!=case['id']: continue
                components=parts(value); pfd=dir_chain(cwdfd,components[:-1]); os.close(pfd)
                target=cwd.joinpath(*components); require(not os.path.lexists(target),'Absent target present')
                absent_records.append({'case_id':case_id,'relative_path':relative(target),'exists':False})
        finally: os.close(cwdfd)
    os.close(fixturesfd)
finally: os.close(rootfd)
directory_records=[]
for case in cases:
    cwd=Path(case['fixture']['cwd'])
    for path in [cwd.parent,cwd,*sorted(p for p in cwd.rglob('*') if p.is_dir())]:
        owned_directory(path); s=path.lstat(); directory_records.append({'case_id':case['id'],'relative_path':relative(path),'mode_octal':format(stat.S_IMODE(s.st_mode),'04o'),'owner_uid':s.st_uid})
for case in cases:
    tool=case['operation']['tool']; args=case['operation']['input']; cwd=Path(case['fixture']['cwd'])
    if tool in ('read','edit','write'):
        target=cwd.joinpath(*parts(args['path'])); require(target.resolve(strict=False).is_relative_to(ROOT),'Input target escape')
        if tool in ('read','edit'): require(target.is_file(),'Primitive read/edit target missing')
        if tool=='edit':
            original=target.read_text(); intervals=[]
            for edit in args['edits']:
                needle=edit['oldText']; require(needle,'Empty original edit')
                positions=[]; start=0
                while True:
                    position=original.find(needle,start)
                    if position<0: break
                    positions.append(position); start=position+1
                require(len(positions)==1,'Edit original text not unique')
                intervals.append((positions[0],positions[0]+len(needle)))
            intervals.sort(); require(all(a[1]<=b[0] for a,b in zip(intervals,intervals[1:])),'Overlapping original edits')
    for key in ('agent_file','release_spec_path','file'):
        if tool.startswith('sf_') and key in args:
            target=cwd.joinpath(*parts(args[key])); require(target.is_file(),'Native local input file missing')
    ownfiles=[{'path':str(Path(f['relative_path']).relative_to(Path('fixtures')/case['id']/'project')),'sha256':f['sha256']} for f in records if f['case_id']==case['id']]
    ownabsent=[str(Path(a['relative_path']).relative_to(Path('fixtures')/case['id']/'project')) for a in absent_records if a['case_id']==case['id']]
    case['fixture']['facts'].append('Owned filesystem setup receipt: '+json.dumps({'cwd':str(cwd),'files':ownfiles,'absent_paths':ownabsent,'requested_operation_executed':False},sort_keys=True,separators=(',',':')))
receipt={'artifact_kind':'blind-v2-owned-inert-filesystem-fixture-setup','owned_root':str(ROOT),'owner_uid':UID,'case_count':160,'cwd_count':160,'case_bindings':[{'case_id':c['id'],'cwd_relative_path':'fixtures/'+c['id']+'/project'} for c in cases],'files':records,'directories':directory_records,'absent_targets':absent_records,'plan_sources':plan_sources,'setup_script':{'path':str(Path(__file__)),'sha256':sha(Path(__file__).read_bytes())},'verification_command':'python3 '+str(Path(__file__))+' --verify','policy_files_changed':False,'onlyIfExists':'Actual existing secret targets are materialized; intentionally absent write targets remain absent. Default policy bytes are unchanged.','stage_equality':'Classification-only replay must run --verify before and after baseline/model stages; no original requested case operations are dispatched.','original_case_operations_executed':0,'model_calls':0,'baseline_calls':0,'external_operations':0,'files_overwritten':0,'symlinks_created':0,'windows_host_accesses':0}
receipt_pin=new_json(ROOT/'filesystem-fixture-setup.json',receipt)
new_json(ROOT/'bound-cases.json',payload)
verify(receipt_pin['sha256'])

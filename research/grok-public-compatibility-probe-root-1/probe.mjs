// Fresh public synthetic compatibility probe. Never reads captured Pi/SF
// requests, repository context, provider configuration, or conversation history.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const endpoint = 'https://eng-ai-model-gateway.sfproxy.devx-preprod.aws-esvc1-useast2.aws.sfdc.cl/v1/chat/completions';
const folder = new URL('./grok-public-compatibility-probe-root-1/', import.meta.url);
const hash = x => createHash('sha256').update(x).digest('hex');
const base = {model:'grok-4.6',messages:[{role:'user',content:'This is a synthetic protocol test. Return only {"ok":true}. Do not call a tool.'}],stream:true,stream_options:{include_usage:true},max_tokens:128};
const tool = {type:'function',function:{name:'synthetic_marker',description:'Synthetic protocol test marker.',parameters:{type:'object',properties:{},additionalProperties:false}}};
const variants = [
  {id:'stream_without_tools',body:base},
  {id:'tools_without_store_or_strict',body:{...base,tools:[tool]}},
  {id:'tools_with_store_false',body:{...base,tools:[tool],store:false}},
  {id:'tools_with_strict_false',body:{...base,tools:[{...tool,function:{...tool.function,strict:false}}]}}
];
await mkdir(folder,{recursive:false,mode:0o700});
await writeFile(new URL('plan.json',folder),JSON.stringify({schemaVersion:1,scope:'Fresh literal synthetic prompts only; no captured Pi/SF requests or local project context',endpoint,variants},null,2)+'\n',{flag:'wx',mode:0o600});
const credential = (await readFile('/Users/bsonntag/opt/eval-agents/secrets/llmgw-key','utf8')).trim();
if (!credential || /[\r\n]/.test(credential)) throw new Error('Invalid gateway credential');
const results=[];
for (const variant of variants) {
  const body=JSON.stringify(variant.body), started=performance.now();
  let result={id:variant.id,requestSha256:hash(body),requestBytes:Buffer.byteLength(body)};
  try {
    const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:`Bearer ${credential}`},body,signal:AbortSignal.timeout(45000)});
    const chunks=[];let bytes=0;
    for await (const chunk of response.body) {bytes+=chunk.length;if(bytes>1048576)throw new Error('Response capacity exceeded');chunks.push(chunk);}
    const raw=Buffer.concat(chunks), text=raw.toString('utf8');
    result={...result,status:response.status,elapsedMs:performance.now()-started,responseBytes:bytes,responseSha256:hash(raw),usage:null};
    if(!response.ok) {
      const known=['store','strict','stream_options','tools','max_tokens','temperature'];
      result.mentionedKnownParameters=known.filter(p=>new RegExp(`\\b${p}\\b`,'i').test(text));
      result.statusMeaning='Protocol request rejected; usage unknown';
    } else {
      let stop=false,done=false;
      for(const line of text.split('\n')) {
        if(!line.startsWith('data: '))continue;
        const data=line.slice(6).trim();if(data==='[DONE]'){done=true;continue;}
        const event=JSON.parse(data);if(event.choices?.some(c=>c.finish_reason==='stop'))stop=true;
        if(event.usage) {
          const counters=['prompt_tokens','completion_tokens','total_tokens'];
          if(counters.every(k=>Number.isSafeInteger(event.usage[k])&&event.usage[k]>=0))result.usage=Object.fromEntries(counters.map(k=>[k,event.usage[k]]));
        }
      }
      result.completed=stop&&done;
    }
  } catch {result={...result,elapsedMs:performance.now()-started,errorCode:'synthetic_probe_transport_or_protocol_failure',usage:null};}
  results.push(result);
  await writeFile(new URL('results.json',folder),JSON.stringify({schemaVersion:1,results},null,2)+'\n',{mode:0o600});
  process.stdout.write(JSON.stringify(result)+'\n');
}

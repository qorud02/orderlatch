import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=process.env.EVAL_URL||'http://127.0.0.1:4179';
if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))throw new Error('Evaluation is restricted to a local test server.');
const caseSet=process.env.EVAL_CASESET||'development';
if(!['development','postfreeze'].includes(caseSet))throw new Error('Unknown case set.');
const outputPrefix=caseSet==='postfreeze'?'postfreeze-challenge':'evaluation';
const raw=await readFile(resolve(root,caseSet==='postfreeze'?'test/postfreeze-challenges.json':'test/evaluation-cases.json'),'utf8');
const fixtures=JSON.parse(raw);
const fixtureHash=createHash('sha256').update(raw).digest('hex');
const expectedHash=caseSet==='postfreeze'?'60c241a5f49b5e2cf2ae035360a154ba65aafabd556869f3a9236c6340dc767e':'4e50233bcfc1a7f5c969e09cad5982b6d5c1c62f44cf8b495aba64d8ad32c628';
if(fixtureHash!==expectedHash)throw new Error('Frozen fixtures changed. Record the change before evaluating.');
const keys=['quantity','capacity','material','printColors','proofVersion','deliveryDate','currency','unitPrice','shipping'];
const labels={quantity:/^(?:quantity|qty)\s*:/i,capacity:/^capacity\s*:/i,material:/^material\s*:/i,printColors:/^print colou?rs\s*:/i,proofVersion:/^proof(?: version)?\s*:/i,deliveryDate:/^delivery(?: date)?\s*:/i,currency:/^currency\s*:/i,unitPrice:/^unit price\s*:/i,shipping:/^shipping\s*:/i};
function literalFields(text){return Object.fromEntries(keys.map(key=>[key,text.split('\n').find(line=>labels[key].test(line))?.split(':').slice(1).join(':').trim().toLowerCase()||null]));}
function exactBaseline(item){const b=literalFields(item.buyerText),s=literalFields(item.supplierText);return keys.every(k=>b[k]!==null&&b[k]===s[k]);}
const results=[];
const selectedCaseIds=(process.env.EVAL_IDS||'').split(',').filter(Boolean);
if(selectedCaseIds.some(id=>!fixtures.cases.some(c=>c.id===id)))throw new Error('Unknown selected case.');
const implementationHashes=Object.fromEntries(await Promise.all(['server.mjs','lib/domain.mjs','lib/providers.mjs','public/index.html','public/styles.css','public/app.js'].map(async path=>[path,createHash('sha256').update(await readFile(resolve(root,path))).digest('hex')])));
const startedAt=new Date().toISOString();
for(const item of fixtures.cases){
  if(selectedCaseIds.length&&!selectedCaseIds.includes(item.id))continue;
  const first=await fetch(base+'/api/state');
  const cookie=first.headers.get('set-cookie')?.split(';')[0];
  if(!first.ok||!cookie)throw new Error('The evaluation server did not create an isolated session.');
  let state=await first.json();
  const call=async(path,method,body)=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-OrderLatch-Client':'web',Cookie:cookie},body:JSON.stringify(body),signal:AbortSignal.timeout(75000)});
    return {ok:response.ok,status:response.status,data:await response.json()};
  };
  const sources=await call('/api/sources','PUT',{buyerText:item.buyerText,supplierText:item.supplierText,expectedRevision:state.revision});
  if(!sources.ok)throw new Error('A frozen source could not be installed: '+item.id);
  const begin=Date.now();let review;
  try{review=await call('/api/analyze','POST',{});}catch{review={ok:false,status:0,data:{error:{code:'EVALUATION_NETWORK_FAILURE'}}};}
  const a=review.ok?review.data.analysis:null;
  const agreementOnly=a?.fields?.length===9&&a.fields.every(f=>f.buyer.value!==null&&f.buyer.value===f.supplier.value&&f.buyer.confidence==='high'&&f.supplier.confidence==='high');
  const result={id:item.id,group:item.group,expectedReady:item.expectedReady,expectedProblemKeys:item.expectedProblemKeys,literalBaselineReady:exactBaseline(item),agreementOnlyReady:review.ok?Boolean(agreementOnly):null,guardedReady:review.ok?a?.blockers===0:null,requestOk:review.ok,errorCode:review.data.error?.code||null,latencyMs:Date.now()-begin,analysis:a};
  results.push(result);
  console.log(JSON.stringify({id:item.id,ok:result.requestOk,expectedReady:item.expectedReady,guardedReady:result.guardedReady,blockers:a?.blockers,error:result.errorCode}));
  await mkdir(resolve(root,'evidence'),{recursive:true});
  await writeFile(resolve(root,'evidence/'+outputPrefix+'-progress.json'),JSON.stringify({fixtureHash,implementationHashes,startedAt,results},null,2));
  if(result.errorCode==='AI_BUDGET_LIMIT')break;
}
function metrics(key){const valid=results.filter(r=>r[key]!==null);return {evaluated:valid.length,correct:valid.filter(r=>r[key]===r.expectedReady).length,falseAllows:valid.filter(r=>r[key]&&!r.expectedReady).length,falseBlocks:valid.filter(r=>!r[key]&&r.expectedReady).length};}
const report={caseSet,selectedCaseIds,fixtureHash,implementationHashes,startedAt,completedAt:new Date().toISOString(),fixtureCount:fixtures.cases.length,attempted:results.length,providerFailures:results.filter(r=>!r.requestOk).length,model:results.find(r=>r.analysis)?.analysis.model||null,estimatedUsd:results.reduce((sum,r)=>sum+(r.analysis?.usage?.estimatedUsd||0),0),metrics:{literalLabelBaseline:metrics('literalBaselineReady'),aiValueAgreementOnly:metrics('agreementOnlyReady'),orderLatchGuarded:metrics('guardedReady')},limitations:fixtures.limitations,results};
await writeFile(resolve(root,'evidence/'+outputPrefix+'-results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({complete:true,fixtureCount:report.fixtureCount,attempted:report.attempted,providerFailures:report.providerFailures,estimatedUsd:report.estimatedUsd,metrics:report.metrics}));

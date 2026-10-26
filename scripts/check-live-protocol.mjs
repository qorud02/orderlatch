import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
if(process.env.RUN_LIVE_SANDBOX!=='1')throw new Error('Opt in with RUN_LIVE_SANDBOX=1. This creates an uncaptured Sandbox order.');
const base=process.env.LIVE_URL||'http://127.0.0.1:4178';
if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))throw new Error('Use a local prototype only.');
const health=await (await fetch(base+'/api/health')).json();
assert.equal(health.paypalMode,'sandbox');assert.equal(health.paypalConfigured,true);assert.equal(health.aiConfigured,true);
const logs=[];const at=new Date().toISOString();
async function client(){const response=await fetch(base+'/api/state');const cookie=response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);return async(path,method='GET',body,origin)=>{const r=await fetch(base+path,{method,headers:{Cookie:cookie,'X-OrderLatch-Client':'web',...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};}
function checked(name,actual,expected){assert.equal(actual,expected,name);logs.push({name,observed:actual,expected,passed:true});}
const call=await client();let state=(await call('/api/reset','POST',{scenario:'aligned'})).data;
let r=await call('/api/analyze','POST',{});checked('Real AI review returns HTTP 200',r.status,200);state=r.data;checked('Aligned sample passes all supported terms',state.analysis.blockers,0);
r=await call('/api/paypal/order','POST',{expectedHash:state.snapshotHash});checked('Checkout before acknowledgements is rejected',r.data.error?.code,'ACKNOWLEDGEMENTS_REQUIRED');
state=(await call('/api/approve','POST',{role:'buyer',expectedHash:state.snapshotHash})).data;state=(await call('/api/approve','POST',{role:'supplier',expectedHash:state.snapshotHash})).data;
r=await call('/api/paypal/order','POST',{expectedHash:state.snapshotHash,amount:'0.01'});checked('Client amount override is rejected',r.data.error?.code,'CLIENT_PAYMENT_OVERRIDE');
r=await call('/api/paypal/order','POST',{expectedHash:state.snapshotHash});checked('Real PayPal Sandbox order creation returns HTTP 200',r.status,200);state=r.data;checked('PayPal order is created',state.payment.status,'created');const orderId=state.payment.orderId;const boundHash=state.snapshotHash;
r=await call('/api/paypal/order','POST',{expectedHash:boundHash});checked('Repeated creation returns the same PayPal order',r.data.payment.orderId,orderId);
r=await call('/api/sources','PUT',{buyerText:state.buyerText,supplierText:state.supplierText.replace('600 cups','601 cups'),expectedRevision:state.revision});checked('Source update succeeds before capture',r.status,200);state=r.data;checked('Created checkout becomes stale',state.payment.status,'stale');checked('Buyer acknowledgement is cleared',state.approvals.buyer,null);checked('Supplier acknowledgement is cleared',state.approvals.supplier,null);assert.notEqual(state.snapshotHash,boundHash);logs.push({name:'Source update changes the revision hash',passed:true});
r=await call('/api/paypal/capture','POST',{expectedHash:boundHash,orderId});checked('Old hash cannot capture the actual Sandbox order',r.data.error?.code,'STALE_HASH');
r=await call('/api/paypal/capture','POST',{expectedHash:state.snapshotHash,orderId});checked('New hash without a new review cannot capture the old order',r.data.error?.code,'REVIEW_REQUIRED');
const other=await client();r=await other('/api/paypal/capture','POST',{expectedHash:boundHash,orderId});checked('A different session cannot capture that order',r.data.error?.code,'STALE_HASH');
r=await call('/api/approve','POST',{role:'buyer',expectedHash:state.snapshotHash},'https://attacker.invalid');checked('Cross-origin mutation is rejected',r.status,403);
const report={at,completedAt:new Date().toISOString(),environment:'PayPal Sandbox + real OpenAI extraction',captured:false,orderId,boundHash,checks:logs,limitations:['The new order is deliberately left uncaptured.','A completed capture is recorded separately in sandbox-capture-receipt.json.','This is a narrow protocol check, not a production security assessment.']};
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');await mkdir(resolve(root,'evidence'),{recursive:true});await writeFile(resolve(root,'evidence/live-protocol-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:logs.length,realSandboxOrderCreated:true,staleCaptureRejected:true}));

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, createCase, applySources, invalidate, acknowledge, installAnalysis, requireReady, sha256, event, assertRemoteOrder, completedCapture, formatMinor } from './lib/domain.mjs';
import { Budget, OpenAIProvider, PayPalProvider } from './lib/providers.mjs';
const HERE=dirname(fileURLToPath(import.meta.url));
const clone=value=>JSON.parse(JSON.stringify(value));
export function createApp(options={}) {
  const config=options.config||{};
  const budget=options.budget||new Budget(Number(config.budgetUsd??process.env.AI_BUDGET_USD??1));
  const ai=options.aiProvider||new OpenAIProvider({key:config.openaiKey??process.env.OPENAI_API_KEY,model:config.model??process.env.OPENAI_MODEL,budget});
  const paypal=options.paymentProvider||new PayPalProvider({clientId:config.paypalClientId??process.env.PAYPAL_CLIENT_ID,clientSecret:config.paypalClientSecret??process.env.PAYPAL_CLIENT_SECRET,merchantId:config.paypalMerchantId??process.env.PAYPAL_MERCHANT_ID});
  const sessions=new Map();const locks=new Map();const analyzing=new Set();const clock=options.clock||(()=>new Date());
  const dataFile=config.dataFile??process.env.DATA_FILE;let saveQueue=Promise.resolve();
  const ready=(async()=>{if(!dataFile)return;try{const saved=JSON.parse(await readFile(resolve(HERE,dataFile),'utf8'));for(const [id,s] of saved.sessions||[])if(s?.state&&clock()-new Date(s.touched)<86400000)sessions.set(id,s);budget.spent=Math.max(0,Number(saved.spentUsd)||0);}catch(e){if(e.code!=='ENOENT')throw new Error('OrderLatch state file is invalid; restore it before starting.');}})();
  async function persist(){if(!dataFile)return;saveQueue=saveQueue.then(async()=>{const path=resolve(HERE,dataFile);await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify({sessions:[...sessions],spentUsd:budget.spent}),{mode:0o600});await rename(path+'.tmp',path);});return saveQueue;}
  async function locked(id,fn){const prior=locks.get(id)||Promise.resolve();const next=prior.catch(()=>{}).then(fn);locks.set(id,next);try{return await next;}finally{if(locks.get(id)===next)locks.delete(id);}}
  function getSession(req,res){const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ol_session='));let id=cookie?.slice(11);if(!id||!sessions.has(id)){id=randomBytes(32).toString('hex');sessions.set(id,{state:createCase('mismatch',clock),touched:clock().toISOString()});res.setHeader('Set-Cookie','ol_session='+id+'; Path=/; HttpOnly; SameSite=Strict'+(config.secureCookie?'; Secure':''));}const session=sessions.get(id);session.touched=clock().toISOString();return {id,session};}
  async function body(req){if(!(req.headers['content-type']||'').startsWith('application/json'))throw new AppError('JSON_REQUIRED','Send application/json.');let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>3000000)throw new AppError('REQUEST_TOO_LARGE','Request is too large.',413);chunks.push(chunk);}try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed;}catch{throw new AppError('INVALID_JSON','Send a JSON object.');}}
  function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
  function assertMutation(req){const origin=req.headers.origin;if(origin){let u;try{u=new URL(origin);}catch{throw new AppError('ORIGIN_REJECTED','Cross-origin request rejected.',403);}if(u.host!==req.headers.host||!['http:','https:'].includes(u.protocol))throw new AppError('ORIGIN_REJECTED','Cross-origin request rejected.',403);}else if(req.headers['x-orderlatch-client']!=='web')throw new AppError('ORIGIN_REQUIRED','Use the OrderLatch web client.',403);}
  async function handler(req,res){await ready;res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(req.method==='GET'&&path==='/api/health')return json(res,200,{aiConfigured:Boolean(ai.configured),paypalConfigured:Boolean(paypal.configured),paypalMode:'sandbox',model:ai.model||'injected-test-provider',budgetUsd:budget.limit,spentUsd:Number(budget.spent.toFixed(6))});
      if(req.method==='GET'&&['/','/index.html','/styles.css','/app.js'].includes(path)){getSession(req,res);const name=path==='/'?'index.html':path.slice(1);try{const content=await readFile(resolve(HERE,'public',name));res.writeHead(200,{'Content-Type':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'});return res.end(content);}catch(e){if(e.code==='ENOENT')throw new AppError('ASSET_NOT_READY','The application assets are not installed yet.',503);throw e;}}
      if(!path.startsWith('/api/'))throw new AppError('NOT_FOUND','Not found.',404);
      const {id,session}=getSession(req,res);
      if(req.method==='GET'&&path==='/api/state')return json(res,200,clone(session.state));
      if(!['POST','PUT'].includes(req.method))throw new AppError('METHOD_NOT_ALLOWED','Method not allowed.',405);
      assertMutation(req);const input=await body(req);
      if(path==='/api/analyze'&&req.method==='POST'){
        if(analyzing.has(id))throw new AppError('REVIEW_IN_PROGRESS','A review is already running for this workspace.',409);
        if(['completed','pending'].includes(session.state.payment.status))throw new AppError('PAYMENT_LOCKED','Verify the current payment before a new review.',409);
        const snapshot=clone(session.state);analyzing.add(id);
        try{const result=await ai.analyze(snapshot);await locked(id,async()=>{if(session.state.id!==snapshot.id)throw new AppError('STALE_ANALYSIS','The workspace was reset while AI was reviewing it. Run the review again.',409);installAnalysis(session.state,result.extracted,result.meta,snapshot.revision,clock);await persist();});}finally{analyzing.delete(id);}
        return json(res,200,clone(session.state));
      }
      await locked(id,async()=>{
        const state=session.state;
        if(path==='/api/reset'&&req.method==='POST'){
          if(state.payment.status==='pending')throw new AppError('PAYMENT_LOCKED','Verify the pending payment before resetting this workspace.',409);
          if(!['mismatch','aligned','ambiguous','injection'].includes(input.scenario))throw new AppError('INVALID_SCENARIO','Choose a supported fictional sample.');
          session.state=createCase(input.scenario,clock);
        } else if(path==='/api/sources'&&req.method==='PUT')applySources(state,input,clock);
        else if(path==='/api/proof'&&req.method==='POST'){
          if(['completed','pending'].includes(state.payment.status))throw new AppError('PAYMENT_LOCKED','Verify the current payment before changing artwork.',409);
          if(typeof input.contentBase64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64)||input.contentBase64.length%4!==0)throw new AppError('INVALID_PROOF','Provide a valid base64 proof file.');
          const bytes=Buffer.from(input.contentBase64,'base64');
          if(bytes.length===0||bytes.length>2097152)throw new AppError('INVALID_PROOF','Proof files must be 1 byte to 2 MB.');
          if(typeof input.fileName!=='string'||!/^.{1,150}\.(txt|png|jpe?g|pdf)$/i.test(input.fileName)||typeof input.label!=='string'||input.label.length<1||input.label.length>80)throw new AppError('INVALID_PROOF','Use a TXT, PNG, JPG or PDF proof with a short version label.');
          state.proof={label:input.label,fileName:input.fileName,sha256:sha256(bytes)};invalidate(state,'Artwork bytes or version changed. Previous acknowledgements and checkout invalidated.',clock);
        } else if(path==='/api/approve'&&req.method==='POST')acknowledge(state,input.role,input.expectedHash,clock);
        else if(path==='/api/paypal/order'&&req.method==='POST'){
          if(Object.keys(input).some(k=>k!=='expectedHash'))throw new AppError('CLIENT_PAYMENT_OVERRIDE','Price and merchant are set by the server, not the client.');
          requireReady(state,input.expectedHash,true);
          if(state.payment.status==='completed')return;
          if(state.payment.boundHash===state.snapshotHash&&['created','pending'].includes(state.payment.status))return;
          const payment=await paypal.create(state);
          state.payment={status:'created',...payment,boundHash:state.snapshotHash,amount:formatMinor(state.totalMinor,state.currency),currency:state.currency};event(state,'checkout','PayPal Sandbox checkout created for revision '+state.revision+'.',clock);
        } else if(path==='/api/paypal/capture'&&req.method==='POST'){
          if(Object.keys(input).some(k=>!['expectedHash','orderId'].includes(k)))throw new AppError('CLIENT_PAYMENT_OVERRIDE','Payment identity is verified by the server.');
          requireReady(state,input.expectedHash,true);
          if(!input.orderId||input.orderId!==state.payment.orderId||state.payment.boundHash!==state.snapshotHash||!['created','pending','completed'].includes(state.payment.status))throw new AppError('PAYMENT_MISMATCH','This checkout is not bound to the current acknowledged revision.',409);
          if(state.payment.status==='completed')return;
          const remote=await paypal.get(state.payment.orderId);
          const hasRemoteCapture=Array.isArray(remote?.purchase_units)&&remote.purchase_units.some(unit=>Array.isArray(unit.payments?.captures)&&unit.payments.captures.length>0);
          if(remote?.status==='COMPLETED'||hasRemoteCapture){state.payment.status='pending';await persist();}
          assertRemoteOrder(remote,state);
          let captured=completedCapture(remote,state,paypal.merchantId);
          if(!captured&&hasRemoteCapture){event(state,'payment_pending','An existing PayPal capture is not verified complete. The order stays locked.',clock);await persist();throw new AppError('PAYMENT_UNVERIFIED','The existing capture is not confirmed complete. Verify this same order again.',409);}
          if(!captured&&remote.status!=='APPROVED'){
            if(remote.status==='COMPLETED'){
              state.payment.status='pending';event(state,'payment_pending','PayPal reports a completed order but the exact capture is not confirmed. The order stays locked.',clock);await persist();
              throw new AppError('PAYMENT_UNVERIFIED','PayPal has not confirmed an exact completed capture for this order. Verify this same order again.',409);
            }
            throw new AppError('BUYER_APPROVAL_REQUIRED','Approve this order in PayPal Sandbox first, then verify payment here.',409);
          }
          if(!captured){
            try{const captureResponse=await paypal.capture(state);captured=completedCapture(captureResponse,state,paypal.merchantId);if(!captured){state.payment.status='pending';event(state,'payment_pending','PayPal capture is pending verification; the order stays locked.',clock);await persist();throw new AppError('PAYMENT_PENDING','PayPal has not confirmed a completed capture. Verify the same order again.',409);}}
            catch(error){if(error.code!=='PAYMENT_PENDING'){state.payment.status='pending';event(state,'payment_pending','Capture outcome needs a fresh authoritative PayPal check.',clock);await persist();}throw error;}
          }
          state.payment={...state.payment,status:'completed',captureId:captured.id,completedAt:clock().toISOString(),approvalUrl:undefined};event(state,'paid','PayPal Sandbox confirmed the exact amount, currency and order revision.',clock);
        } else throw new AppError('NOT_FOUND','Not found.',404);
        await persist();
      });
      return json(res,200,clone(session.state));
    } catch(error) {
      const known=error instanceof AppError;return json(res,known?error.status:500,{error:{code:known?error.code:'INTERNAL_ERROR',message:known?error.message:'The operation could not be completed. Reload and try again.'}});
    }
  }
  return {handler,sessions,budget,ready,createServer:()=>http.createServer((req,res)=>{handler(req,res).catch(()=>{if(!res.headersSent)json(res,500,{error:{code:'STATE_UNAVAILABLE',message:'The server state is unavailable.'}});else res.end();});})};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=createApp();await app.ready;const server=app.createServer();server.listen(Number(process.env.PORT||4318),process.env.HOST||'127.0.0.1',()=>{console.log('OrderLatch listening; PayPal mode: sandbox.');});
}

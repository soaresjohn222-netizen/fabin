import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtemp,readFile,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes,scryptSync,randomUUID} from "node:crypto";
const require=createRequire(import.meta.url);
const dependencies=createRequire(require.resolve("wrangler/package.json"));
const {build}=dependencies("esbuild");
const {Miniflare}=dependencies("miniflare");
const temp=await mkdtemp(join(tmpdir(),"oficina-integration-"));
const password=randomBytes(24).toString("base64url"),username=randomBytes(12).toString("hex"),salt=randomBytes(24).toString("hex");
const hash=`scrypt$32768$8$3$${salt}$${scryptSync(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString("hex")}`;
let runtime;
try{
 await build({stdin:{contents:'import {GET,POST,PUT} from "./app/api/[...path]/route.ts";export default {fetch(request){return ({GET,POST,PUT})[request.method](request)}}',resolveDir:process.cwd(),sourcefile:"test-entry.ts"},bundle:true,format:"esm",platform:"node",target:"es2022",external:["cloudflare:workers","node:*"],outfile:join(temp,"worker.mjs"),tsconfig:"tsconfig.json"});
 runtime=new Miniflare({modules:true,modulesRoot:temp,scriptPath:join(temp,"worker.mjs"),compatibilityDate:"2026-05-15",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],r2Buckets:["BUCKET"],bindings:{ADMIN_USERNAME:username,ADMIN_PASSWORD_HASH:hash,APP_ORIGIN:"https://workshop.test"},cf:false});
 const db=await runtime.getD1Database("DB");
 for(const migration of (await readdir("drizzle")).filter(f=>f.endsWith(".sql")).sort()){const schema=await readFile("drizzle/"+migration,"utf8");for(const statement of schema.split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();}
 let cookie="";
 async function request(path,method="GET",data,opts={}){
   const headers={"Origin":opts.origin||"https://workshop.test","X-Oficina-Request":"1","CF-Connecting-IP":opts.ip||"198.51.100.9",...(cookie&&!opts.anonymous?{Cookie:cookie}:{})};
   let body;if(data instanceof FormData){const encoded=new Request("https://workshop.test/",{method:"POST",body:data});headers["Content-Type"]=encoded.headers.get("content-type");body=new Uint8Array(await encoded.arrayBuffer());}else if(data!==undefined){body=JSON.stringify(data);headers["Content-Type"]="application/json";}
   const response=await runtime.dispatchFetch("https://workshop.test/api/"+path,{method,headers,body});
   const text=await response.text();let value;try{value=JSON.parse(text)}catch{value=text}
   return {response,value};
 }
 for(const path of ['expenses','expenses/1','expense-imports'])assert.equal((await request(path)).response.status,401);
 const logged=await request('auth/login','POST',{username,password});assert.equal(logged.response.status,200);cookie=logged.response.headers.get('set-cookie').split(';')[0];
 const personal={requestKey:randomUUID(),description:'Conta de água de casa',amountCents:12345,kind:'personal',datePrecision:'day',date:'2026-09-01',notes:''};
 assert.equal((await request('expenses','POST',personal,{origin:'https://foreign.test'})).response.status,403);
 for(const changes of [{amountCents:null},{amountCents:-1},{amountCents:1.1},{date:'2026-02-30'},{date:'2099-01-01'},{kind:'invalid'}])assert.equal((await request('expenses','POST',{...personal,...changes})).response.status,400,JSON.stringify(changes));
 const a=await request('expenses','POST',personal);assert.equal(a.response.status,201,JSON.stringify(a.value));assert.equal((await request('expenses','POST',personal)).value.id,a.value.id);
 const professional={...personal,requestKey:randomUUID(),description:'Aluguel da oficina',amountCents:20000,kind:'professional'};const b=await request('expenses','POST',professional);assert.equal(b.response.status,201);
 assert.equal((await request('dashboard')).value.expenses.summary.total,32345);
 const edited=await request('expenses/'+a.value.id,'PUT',{...personal,amountCents:15000,revision:1});assert.equal(edited.response.status,200,JSON.stringify(edited.value));assert.equal(edited.value.revision,2);
 assert.equal((await request('expenses/'+a.value.id,'PUT',{...personal,revision:1})).response.status,409);
 assert.equal((await request('expenses/'+a.value.id+'/status','PUT',{status:'cancelled',revision:2})).response.status,200);
 assert.equal((await request('dashboard')).value.expenses.summary.total,20000);assert.equal((await request('expenses?status=cancelled')).value.total,1);
 assert.equal((await request('expenses/'+a.value.id+'/status','PUT',{status:'active',revision:3})).response.status,200);
 const service=await request('orders','POST',{requestKey:randomUUID(),customer:{name:'Cliente preservado'},plate:'ABC1234',model:'Moto',date:'2020-01-01',odometer:10,status:'done',items:[{kind:'labor',description:'Serviço preservado',quantity:1,unitCents:10000}]});assert.equal(service.response.status,201,JSON.stringify(service.value));
 const folder=process.env.EXPENSE_MANIFEST_DIR;if(!folder)throw new Error('Set EXPENSE_MANIFEST_DIR and HISTORY_ORIGINALS_DIR');
 const manifests=[];const expected=new Map();let imported=0;
 for(const filename of (await readdir(folder)).filter(n=>/^20\d{2}\.json$/.test(n)).sort()){
  const m=JSON.parse(await readFile(join(folder,filename),'utf8'));manifests.push(m);
  const form=new FormData();form.set('file',new File([await readFile(join(process.env.HISTORY_ORIGINALS_DIR,m.filename))],m.filename));
  const uploaded=await request('imports','POST',form);assert.equal(uploaded.response.status,201,JSON.stringify(uploaded.value));const id=uploaded.value.id;
  assert.equal((await request('imports/'+id+'/expenses/commit','POST',{offset:0})).response.status,409);
  assert.equal((await request('imports/'+id+'/expenses/prepare','POST',{...m,fileHash:'0'.repeat(64)})).response.status,409);
  const prepared=await request('imports/'+id+'/expenses/prepare','POST',m);assert.equal(prepared.response.status,200,JSON.stringify(prepared.value));
  assert.equal((await request('imports/'+id+'/expenses/prepare','POST',m)).response.status,200);
  let offset=0;for(let i=0;i<100;i++){const done=await request('imports/'+id+'/expenses/commit','POST',{offset});assert.equal(done.response.status,200,JSON.stringify(done.value));if(done.value.status==='imported'){assert.equal(done.value.row_count,m.expenses.length);break;}assert.ok(done.value.nextOffset>offset);offset=done.value.nextOffset;if(i===99)throw new Error('Import stalled');}
  assert.equal((await request('imports/'+id+'/expenses/commit','POST',{offset:0})).value.row_count,m.expenses.length);
  for(const e of m.expenses)expected.set([id,e.sheet,e.row].join(':'),e);
  imported+=m.expenses.length;console.log('Imported and replay checked',m.year,m.expenses.length);
 }
 const backup=(await request('backup')).value;assert.equal(imported,1944);assert.equal(backup.expenses.length,1946);assert.equal(backup.orders.length,1);assert.deepEqual(backup.orders[0],service.value,'Existing service record preserved');assert.equal(backup.customers.length,1);assert.equal(backup.motorcycles.length,1);
 let total=0,missing=0,aggregates=0;
 for(const saved of backup.expenses.filter(e=>e.import_batch_id)){
  const e=expected.get([saved.import_batch_id,saved.source_sheet,saved.source_row].join(':'));assert.ok(e,'Every row has a known source');
  assert.equal(saved.description,e.description||'Gasto sem descrição na planilha');assert.equal(saved.amount_cents,e.amountCents);assert.equal(saved.kind,e.kind);assert.equal(saved.source_mode,e.sourceMode);assert.equal(saved.date_precision,'month');assert.equal(saved.date_start,e.period+'-01');assert.equal(saved.date_end,new Date(Date.UTC(Number(e.period.slice(0,4)),Number(e.period.slice(5)),0)).toISOString().slice(0,10));
  assert.deepEqual(JSON.parse(saved.source_raw),{period:e.period,description:e.description,amountCents:e.amountCents,kind:e.kind,sourceMode:e.sourceMode,cells:e.sourceRaw});
  total+=saved.amount_cents||0;missing+=saved.amount_cents==null;aggregates+=saved.source_mode==='monthly_total';
 }
 assert.equal(total,85471100);assert.equal(missing,35);assert.equal(aggregates,16);
 const d=(await request('dashboard')).value;assert.equal(d.expenses.summary.total,85471100+35000);assert.equal(d.expenses.summary.count,1946);assert.equal(d.expenses.summary.unknown,35);assert.equal(d.expenses.summary.total,d.expenses.summary.personal+d.expenses.summary.professional+d.expenses.summary.unclassified);
 const day=(await request('expenses?from=2019-01-01&to=2019-01-01')).value;assert.equal(day.total,0);assert.ok(day.uncertainOutsideRange>0);
 assert.ok((await request('expenses?q=agua')).value.total>0);assert.equal((await request('expenses?from=2026-09-10&to=2026-09-01')).response.status,400);assert.equal((await request('expenses')).value.rows.length,25);
 const incomplete=backup.expenses.find(e=>e.import_batch_id&&e.amount_cents==null);
 const fixed=await request('expenses/'+incomplete.id,'PUT',{requestKey:incomplete.request_key,description:incomplete.description,amountCents:900,kind:'professional',datePrecision:'month',date:incomplete.date_start.slice(0,7),notes:'Conferido',revision:1});
 assert.equal(fixed.response.status,200,JSON.stringify(fixed.value));assert.equal(fixed.value.source_raw,incomplete.source_raw,'Original cells survive corrections');
 assert.equal((await request('expenses/'+incomplete.id,'PUT',{requestKey:incomplete.request_key,description:incomplete.description,amountCents:null,kind:'professional',datePrecision:'month',date:incomplete.date_start.slice(0,7),notes:'',revision:2})).response.status,400);
 const final=(await request('backup')).value;assert.ok(final.audit_events.some(e=>e.entity_type==='expense'&&e.entity_id===String(incomplete.id)&&e.action==='edit'));
 await request('auth/logout','POST');assert.equal((await request('expenses')).response.status,401);
 console.log('PASS: expense authentication, validation, totals, classification, editing, cancellation, optimistic locks, monthly filters, all 1944 imported rows, replay safety, source preservation and unchanged services.');
}finally{if(runtime)await runtime.dispose();await rm(temp,{recursive:true,force:true});}

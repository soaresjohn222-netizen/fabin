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
 const login=await request("auth/login","POST",{username,password});assert.equal(login.response.status,200);cookie=login.response.headers.get("set-cookie").split(";")[0];
 const directory=process.env.HISTORY_MANIFEST_DIR;
 if(!directory)throw new Error("Set HISTORY_MANIFEST_DIR to the private generated manifests directory.");
 let total=0,totalCents=0,datesToReview=0;const expected=[];
 for(const filename of (await readdir(directory)).filter(f=>/^20\d{2}\.json$/.test(f)).sort()){
  const manifest=JSON.parse(await readFile(join(directory,filename),"utf8"));
  const source=new FormData();source.set("file",new File([await readFile(join(process.env.HISTORY_ORIGINALS_DIR,manifest.filename))],manifest.filename));
  const upload=await request("imports","POST",source);assert.equal(upload.response.status,201,JSON.stringify(upload.value));const id=upload.value.id;
  assert.equal((await request("imports/"+id+"/commit","POST",{offset:0})).response.status,409);
  assert.equal((await request("imports/"+id+"/prepare","POST",{...manifest,fileHash:"a".repeat(64)})).response.status,409,"Original hash mismatch must fail");
  const prep=await request("imports/"+id+"/prepare","POST",manifest);assert.equal(prep.response.status,200,JSON.stringify(prep.value));assert.equal(prep.value.report.records,manifest.records.length);
  assert.equal((await request("imports/"+id+"/prepare","POST",manifest)).response.status,200,"Preparation is idempotent");
  let offset=0;
  for(;;){const r=await request("imports/"+id+"/commit","POST",{offset});assert.equal(r.response.status,200,JSON.stringify(r.value));if(r.value.status==="imported")break;assert(r.value.imported>offset,"Must make progress");offset=r.value.imported;}
  assert.equal((await request("imports/"+id+"/commit","POST",{offset:0})).value.imported,manifest.records.length,"Replay must not duplicate records");
  for(const record of manifest.records)expected.push({batchId:id,record});
  total+=manifest.records.length;totalCents+=manifest.records.reduce((n,r)=>n+(r.totalCents||0),0);datesToReview+=manifest.records.filter(r=>r.datePrecision==="month").length;
  const stats=(await request("dashboard?from="+manifest.year+"-01-01&to="+manifest.year+"-12-31")).value;
  assert.equal(stats.stats.orders,manifest.records.length);assert.equal(stats.stats.revenue,0,"Archived budgets do not assert completed revenue");assert.equal(stats.stats.registered,manifest.records.reduce((n,r)=>n+(r.totalCents||0),0));
  console.log("VERIFIED",manifest.year,manifest.records.length,"source fichas and original totals");
 }
 const backup=(await request("backup")).value;assert.equal(backup.orders.length,total);
 const sourceMap=new Map(backup.orders.map(r=>[r.import_batch_id+":"+r.source_sheet+":"+r.source_row,r]));
 for(const {batchId,record:r} of expected){const saved=sourceMap.get(batchId+":"+r.sheet+":"+r.row);assert(saved);assert.deepEqual(JSON.parse(saved.source_raw),r.raw,"Every source cell preserved");assert.deepEqual(JSON.parse(saved.legacy_json).items,r.items,"Every item, quantity and original value preserved");assert.equal(saved.total_known,r.totalCents===null?0:1);assert.equal(saved.total_cents,r.totalCents??0);assert.equal(saved.odometer,r.odometer);assert.equal(saved.date_original,r.dateOriginal);assert.equal(saved.date_precision,r.datePrecision);assert.equal(saved.customer_name,r.name||"Cliente não informado");assert.equal(saved.plate,r.plate);}
 assert.equal((await request("dashboard")).value.stats.registered,totalCents);
 assert.equal(new Set(backup.motorcycles.filter(m=>m.plate).map(m=>m.plate)).size,backup.motorcycles.filter(m=>m.plate).length,"Unique valid plates");
 const uncertain=backup.orders.find(r=>r.date_precision==="month");assert(uncertain);
 const day=(await request("orders?from="+uncertain.service_date+"&to="+uncertain.service_date)).value;assert(!day.rows.some(r=>r.id===uncertain.id));assert(day.uncertainOutsideRange>0,"Partial date uncertainty is reported");
 const before=JSON.parse(uncertain.source_raw);const legacy=JSON.parse(uncertain.legacy_json);const confirmed=legacy.suggestedDate||uncertain.service_date;
 const correction=await request("orders/"+uncertain.id+"/review-date","PUT",{date:confirmed,revision:1,reason:"Conferência de teste em banco temporário"});assert.equal(correction.response.status,200,JSON.stringify(correction.value));
 assert.equal((await request("orders/"+uncertain.id+"/review-date","PUT",{date:confirmed,revision:1,reason:"Tentativa desatualizada"})).response.status,409);
 const corrected=(await request("orders/"+uncertain.id)).value.order;assert.deepEqual(JSON.parse(corrected.source_raw),before);assert.equal(corrected.date_precision,"day");assert.equal(corrected.revision,2);assert.equal(corrected.date_original,uncertain.date_original);
 assert.equal((await request("orders/"+uncertain.id,"PUT",{requestKey:randomUUID(),customer:{name:"Teste"},plate:"ABC1234",model:"Moto",date:"2020-01-01",odometer:null,status:"done",items:[{kind:"labor",description:"Teste",quantity:1,unitCents:1}]})).response.status,400,"Normal editing cannot overwrite original fichas");
 const originalMoto=backup.motorcycles.find(m=>m.plate);const manual={requestKey:randomUUID(),customerId:originalMoto.customer_id,customer:{name:"Ignored snapshot"},plate:originalMoto.plate,model:originalMoto.model,date:"2026-09-01",odometer:100,status:"open",items:[{kind:"labor",description:"Nova visita depois da migração",quantity:1,unitCents:10000}]};
 const newOrder=await request("orders","POST",manual);assert.equal(newOrder.response.status,201,JSON.stringify(newOrder.value));assert.equal(newOrder.value.motorcycle_id,originalMoto.id);
 console.log("PASS:",total,"fichas;",datesToReview,"uncertain days; all source cells, quantities, prices, snapshots, annual totals, duplicate protection, original protection, date review and next workshop visit verified.");
}finally{if(runtime)await runtime.dispose();await rm(temp,{recursive:true,force:true});}

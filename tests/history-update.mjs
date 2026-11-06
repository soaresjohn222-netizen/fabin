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
const temp=await mkdtemp(join(tmpdir(),"oficina-history-update-"));
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

 const directory=process.env.HISTORY_UPDATE_DIR,originals=process.env.HISTORY_ORIGINALS_DIR;
 if(!directory||!originals||!process.env.HISTORY_BASELINE_MANIFEST)throw new Error("Provide the private update, originals and baseline manifest paths.");
 const baseline=JSON.parse(await readFile(process.env.HISTORY_BASELINE_MANIFEST,"utf8"));
 const update=JSON.parse(await readFile(join(directory,"history-incremental.json"),"utf8"));
 const complete=JSON.parse(await readFile(join(directory,"history-full.json"),"utf8"));
 const logged=await request("auth/login","POST",{username,password});assert.equal(logged.response.status,200);cookie=logged.response.headers.get("set-cookie").split(";")[0];
 async function upload(m){const form=new FormData();form.set("file",new File([await readFile(join(originals,m.filename))],m.filename));const r=await request("imports","POST",form);assert.equal(r.response.status,201,JSON.stringify(r.value));return r.value.id;}
 async function prepare(id,m){const r=await request("imports/"+id+"/prepare","POST",m);assert.equal(r.response.status,200,JSON.stringify(r.value));}
 async function commit(id){let offset=0;for(let i=0;i<600;i++){const r=await request("imports/"+id+"/commit","POST",{offset});assert.equal(r.response.status,200,JSON.stringify(r.value));if(r.value.status==="imported")return r.value;assert(r.value.imported>offset);offset=r.value.imported;}throw new Error("Import did not finish");}
 const originalId=await upload(baseline);await prepare(originalId,baseline);await commit(originalId);
 const before=(await request("backup")).value;
 for(const review of update.sourceReviews){review.orderId=before.orders.find(o=>o.source_sheet===review.record.sheet&&o.source_row===review.record.row).id;}
 const newId=await upload(update);
 const tampered=structuredClone(update);tampered.sourceReviews[0].record.totalCents+=1;
 assert.equal((await request("imports/"+newId+"/prepare","POST",tampered)).response.status,409,"Source correction must not silently alter money");
 await prepare(newId,update);
 const target=update.sourceReviews[0].orderId;
 assert.equal((await request("orders/"+target+"/review-plate","PUT",{sourceBatchId:newId,revision:1})).response.status,409,"Review requires completed source import");
 const imported=await commit(newId);assert.equal(imported.imported,update.records.length);
 assert.equal((await request("orders/"+target+"/review-plate","PUT",{sourceBatchId:newId,revision:999})).response.status,409,"Stale revision must not overwrite");
 assert.equal((await request("orders/"+target+"/review-plate","PUT",{sourceBatchId:newId,revision:1},{anonymous:true})).response.status,401);
 const corrected=await request("orders/"+target+"/review-plate","PUT",{sourceBatchId:newId,revision:1});assert.equal(corrected.response.status,200,JSON.stringify(corrected.value));
 assert.equal((await request("orders/"+target+"/review-plate","PUT",{sourceBatchId:newId,revision:1})).value.alreadyApplied,true);
 await prepare(newId,update);assert.equal((await commit(newId)).imported,update.records.length);
 const after=(await request("backup")).value;
 assert.equal(after.orders.length,before.orders.length+update.records.length);
 assert.equal(after.expenses.length,0);
 for(const old of before.orders){const now=after.orders.find(o=>o.id===old.id);if(old.id!==target){assert.deepEqual(now,old);continue;}
   assert.equal(now.plate,null);assert.equal(now.revision,old.revision+1);assert.equal(now.source_raw,old.source_raw);assert.equal(now.total_cents,old.total_cents);assert.equal(now.motorcycle_id,old.motorcycle_id);assert.equal(now.customer_id,old.customer_id);
   const legacy=JSON.parse(now.legacy_json);assert.equal(legacy.sourceCorrections[0].filename,update.filename);assert.equal(legacy.sourceCorrections[0].previous,old.plate);delete legacy.sourceCorrections;assert.deepEqual(legacy,JSON.parse(old.legacy_json));
 }
 for(const r of update.records){const saved=after.orders.find(o=>o.import_batch_id===newId&&o.source_sheet===r.sheet&&o.source_row===r.row);assert(saved);assert.deepEqual(JSON.parse(saved.source_raw),r.raw);assert.deepEqual(JSON.parse(saved.legacy_json).items,r.items);assert.equal(saved.total_cents,r.totalCents??0);assert.equal(saved.total_known,r.totalCents===null?0:1);assert.equal(saved.date_original,r.dateOriginal);assert.equal(saved.plate,r.plate);assert.equal(saved.customer_name,r.name||"Cliente não informado");}
 for(const month of ["07","08","09"]){const records=complete.records.filter(r=>r.date.startsWith("2026-"+month));const end=month==="09"?"30":"31";const d=(await request("dashboard?from=2026-"+month+"-01&to=2026-"+month+"-"+end)).value;assert.equal(d.stats.orders,records.length);assert.equal(d.financial.incomeCents,records.reduce((n,r)=>n+(r.totalCents||0),0));}
 assert(after.audit_events.some(e=>e.action==="review_plate"&&e.entity_id===String(target)));
 console.log("PASS: incremental import, exact source preservation, monthly totals, no duplicate orders or expenses, audited plate correction, revision protection, authentication and resumable replay.");
}finally{if(runtime)await runtime.dispose();await rm(temp,{recursive:true,force:true});}

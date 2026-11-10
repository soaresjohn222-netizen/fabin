import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtemp,readFile,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes,scryptSync,randomUUID,createHash} from "node:crypto";

const dependencies=createRequire(createRequire(import.meta.url).resolve("wrangler/package.json"));
const {build}=dependencies("esbuild"),{Miniflare}=dependencies("miniflare");
const temp=await mkdtemp(join(tmpdir(),"oficina-delete-order-"));
const password=randomBytes(24).toString("base64url"),salt=randomBytes(24).toString("hex");
const hash=`scrypt$32768$8$3$${salt}$${scryptSync(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString("hex")}`;
let runtime;
try{
 await build({stdin:{contents:'import {GET,POST,PUT,DELETE} from "./app/api/[...path]/route.ts";export default {fetch(request){return ({GET,POST,PUT,DELETE})[request.method](request)}}',resolveDir:process.cwd(),sourcefile:"test-entry.ts"},bundle:true,format:"esm",platform:"node",target:"es2022",external:["cloudflare:workers","node:*"],outfile:join(temp,"worker.mjs"),tsconfig:"tsconfig.json"});
 runtime=new Miniflare({modules:true,modulesRoot:temp,scriptPath:join(temp,"worker.mjs"),compatibilityDate:"2026-05-15",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],r2Buckets:["BUCKET"],bindings:{ADMIN_USERNAME:"test",ADMIN_PASSWORD_HASH:hash,APP_ORIGIN:"https://workshop.test"},cf:false});
 const db=await runtime.getD1Database("DB");
 for(const migration of (await readdir("drizzle")).filter(f=>f.endsWith(".sql")).sort())for(const sql of (await readFile("drizzle/"+migration,"utf8")).split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 let cookie="";
 async function request(path,method="GET",data,options={}){
  const response=await runtime.dispatchFetch("https://workshop.test/api/"+path,{method,headers:{Origin:options.origin||"https://workshop.test","X-Oficina-Request":"1","Content-Type":"application/json",...(cookie&&!options.anonymous?{Cookie:cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)});
  const text=await response.text();let value;try{value=JSON.parse(text)}catch{value=text}return {response,value};
 }
 const logged=await request("auth/login","POST",{username:"test",password});assert.equal(logged.response.status,200);cookie=logged.response.headers.get("set-cookie").split(";")[0];

 const draft={requestKey:randomUUID(),customer:{name:"Cliente de teste",phone:"11911112222"},plate:"ABC1234",model:"Honda CG",date:"2020-01-15",odometer:12345,status:"done",items:[{kind:"labor",description:"Revisão",quantity:1,unitCents:12500}],notes:"Excluir somente esta ordem"};
 let customerId;const create=async()=>{const r=await request("orders","POST",{...draft,customerId,requestKey:randomUUID()});assert.equal(r.response.status,201,JSON.stringify(r.value));customerId=r.value.customer_id;return r.value;};
 const order=await create(),other=await create(),path="orders/"+order.id,payload={revision:order.revision,confirmId:order.id};
 const baseline=(await request("backup")).value;
 assert.equal((await request(path,"DELETE",payload,{anonymous:true})).response.status,401);
 assert.equal((await request(path,"DELETE",payload,{origin:"https://foreign.test"})).response.status,403);
 for(const invalid of [{},{revision:1},{...payload,confirmId:other.id},{...payload,revision:0},{...payload,revision:"1"},{...payload,unexpected:true}])assert.equal((await request(path,"DELETE",invalid)).response.status,400);
 assert.equal((await request(path,"DELETE",{...payload,revision:2})).response.status,409);
 assert.equal((await request("orders/999999","DELETE",{revision:1,confirmId:999999})).response.status,404);
 assert.equal((await request(path+"/anything","DELETE",payload)).response.status,404);
 assert.deepEqual((await request("backup")).value.orders,baseline.orders,"Rejected requests must not change data");
 const beforeFinancial=(await request("dashboard")).value.financial.incomeCents;
 const deleted=await request(path,"DELETE",payload);assert.equal(deleted.response.status,200,JSON.stringify(deleted.value));assert.deepEqual(deleted.value,{id:order.id,deleted:true});
 assert.equal((await request(path)).response.status,404);
 assert(!(await request("orders")).value.rows.some(r=>r.id===order.id),"Deleted order disappears from the list");
 assert.equal((await request("dashboard")).value.financial.incomeCents,beforeFinancial-order.total_cents);
 const backup=(await request("backup")).value;
 assert.equal(backup.orders.length,1);assert.deepEqual(backup.orders[0],baseline.orders.find(x=>x.id===other.id));
 assert.deepEqual(backup.customers,baseline.customers);assert.deepEqual(backup.motorcycles,baseline.motorcycles);
 const audit=backup.audit_events.filter(x=>x.action==="delete");assert.equal(audit.length,1);assert.deepEqual(JSON.parse(audit[0].before_json),baseline.orders.find(x=>x.id===order.id));
 assert.deepEqual(JSON.parse(audit[0].after_json),{id:order.id,deleted:true});
 assert.equal((await request(path,"DELETE",payload)).response.status,404);
 assert.equal((await request("customers/"+order.customer_id)).value.rows[0].visits,1);
 const csv=(await request("export")).value;assert.equal(csv.split("\r\n").length,2,"Export contains only the remaining attendance");
 // Imported rows use the same deletion path; their original file must remain downloadable.
 const bucket=await runtime.getR2Bucket("BUCKET"),batchId=randomUUID(),objectKey="originals/"+batchId,source=Buffer.from("original workbook bytes");
 await bucket.put(objectKey,source);
 await db.prepare("INSERT INTO import_batches (id,filename,file_hash,object_key,status,created_at) VALUES (?,?,?,?,'imported',?)").bind(batchId,"fixture.xlsx",createHash("sha256").update(source).digest("hex"),objectKey,new Date().toISOString()).run();
 await db.prepare("UPDATE orders SET import_batch_id=?,status='historic',source_sheet='2020',source_row=7,source_raw=?,legacy_json=? WHERE id=?").bind(batchId,JSON.stringify({A7:{v:"Original"}}),JSON.stringify({items:[]}),other.id).run();
 const imported=(await request("orders/"+other.id)).value.order;
 const parallel=await Promise.all([1,2].map(()=>request("orders/"+other.id,"DELETE",{revision:imported.revision,confirmId:other.id})));
 assert.equal(parallel.filter(r=>r.response.status===200).length,1);assert(parallel.every(r=>[200,404,409].includes(r.response.status)));
 const afterImported=(await request("backup")).value;assert.equal(afterImported.import_batches.length,1);assert.equal(afterImported.audit_events.filter(e=>e.action==="delete").length,2);
 const stored=await request("imports/"+batchId);assert.equal(stored.response.status,200);assert.equal(stored.value,source.toString());
 assert.equal((await request("orders")).value.total,0);
 // If SQL cannot remove the row, the audit insertion must roll back with it.
 const blocked=await create();
 await db.prepare("CREATE TRIGGER block_order_delete BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END").run();
 assert.equal((await request("orders/"+blocked.id,"DELETE",{revision:blocked.revision,confirmId:blocked.id})).response.status,503);
 assert.equal((await request("orders/"+blocked.id)).response.status,200);
 assert.equal((await request("backup")).value.audit_events.filter(e=>e.action==="delete"&&e.entity_id===String(blocked.id)).length,0,"Audit and deletion are atomic");
 console.log("PASS: authenticated confirmed deletion, CSRF, strict validation, stale revision, concurrency, atomic rollback, financial/list/export updates, full audit snapshot, linked records and original workbook preservation.");
}finally{if(runtime)await runtime.dispose();await rm(temp,{recursive:true,force:true});}

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


 const createCustomer=async(name)=>{const r=await request("customers","POST",{name,phone:"",notes:""});assert.equal(r.response.status,201);return (await request("customers/"+r.value.id)).value.rows[0]};
 const c=await createCustomer("Cliente teste"),cpath="customers/"+c.id,payload={confirmId:c.id,updatedAt:c.updated_at};
 assert.equal((await request(cpath,"DELETE",payload,{anonymous:true})).response.status,401);
 assert.equal((await request(cpath,"DELETE",payload,{origin:"https://foreign.test"})).response.status,403);
 assert.equal((await request(cpath,"DELETE",{})).response.status,400);
 assert.equal((await request(cpath,"DELETE",{...payload,confirmId:"wrong"})).response.status,400);
 assert.equal((await request(cpath,"DELETE",{...payload,updatedAt:"stale"})).response.status,409);
 const m=(await request("motorcycles","POST",{plate:"ABC1234",model:"Honda",customerId:c.id,notes:""})).value;
 const moto=(await request("motorcycles/"+m.id)).value.rows[0],mpath="motorcycles/"+m.id,mpayload={confirmId:m.id,updatedAt:moto.updated_at};
 assert.equal((await request(cpath,"DELETE",payload)).response.status,409,"Customer with motorcycle is protected");
 const order=(await request("orders","POST",{requestKey:randomUUID(),customerId:c.id,customer:{name:c.name,phone:""},plate:moto.plate,model:moto.model,date:"2020-01-15",odometer:1,status:"done",items:[{kind:"labor",description:"Revisão",quantity:1,unitCents:100}],notes:""})).value;
 assert.equal((await request(mpath,"DELETE",mpayload)).response.status,409,"Motorcycle with order is protected");
 assert.equal((await request("orders/"+order.id,"DELETE",{revision:order.revision,confirmId:order.id})).response.status,200);
 const parallel=await Promise.all([1,2].map(()=>request(mpath,"DELETE",mpayload)));
 assert.equal(parallel.filter(r=>r.response.status===200).length,1);
 assert.equal((await request(cpath,"DELETE",payload)).response.status,200);
 assert.equal((await request(cpath,"DELETE",payload)).response.status,404);
 const backup=(await request("backup")).value;
 assert.equal(backup.customers.length,0);assert.equal(backup.motorcycles.length,0);
 for(const [type,row] of [["customer",c],["motorcycle",moto]]){const events=backup.audit_events.filter(e=>e.action==="delete"&&e.entity_type===type);assert.equal(events.length,1);assert.equal(JSON.parse(events[0].before_json).id,row.id)}
 const blocked=await createCustomer("Rollback teste");
 await db.prepare("CREATE TRIGGER block_customer_delete BEFORE DELETE ON customers BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END").run();
 assert.equal((await request("customers/"+blocked.id,"DELETE",{confirmId:blocked.id,updatedAt:blocked.updated_at})).response.status,503);
 assert.equal((await request("backup")).value.audit_events.filter(e=>e.action==="delete"&&e.entity_id===blocked.id).length,0);
 console.log("PASS: directory deletion, authentication, CSRF, linked history protection, strict confirmation, stale data, concurrency, audit and rollback.");
}finally{if(runtime)await runtime.dispose();await rm(temp,{recursive:true,force:true});}

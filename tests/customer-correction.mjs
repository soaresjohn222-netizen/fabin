import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtemp,readFile,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes,scryptSync,randomUUID,createHash} from "node:crypto";

const dependencies=createRequire(createRequire(import.meta.url).resolve("wrangler/package.json"));
const {build}=dependencies("esbuild"),{Miniflare}=dependencies("miniflare");
const temp=await mkdtemp(join(tmpdir(),"oficina-customer-correction-"));
const password=randomBytes(24).toString("base64url"),salt=randomBytes(24).toString("hex");
const hash=`scrypt$32768$8$3$${salt}$${scryptSync(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString("hex")}`;
let runtime;
try{
 await build({stdin:{contents:'import {GET,POST,PUT} from "./app/api/[...path]/route.ts";export default {fetch(request){return ({GET,POST,PUT})[request.method](request)}}',resolveDir:process.cwd(),sourcefile:"test-entry.ts"},bundle:true,format:"esm",platform:"node",target:"es2022",external:["cloudflare:workers","node:*"],outfile:join(temp,"worker.mjs"),tsconfig:"tsconfig.json"});
 runtime=new Miniflare({modules:true,modulesRoot:temp,scriptPath:join(temp,"worker.mjs"),compatibilityDate:"2026-05-15",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],r2Buckets:["BUCKET"],bindings:{ADMIN_USERNAME:"test",ADMIN_PASSWORD_HASH:hash,APP_ORIGIN:"https://workshop.test"},cf:false});
 const db=await runtime.getD1Database("DB");
 for(const migration of (await readdir("drizzle")).filter(f=>f.endsWith(".sql")).sort())for(const sql of (await readFile("drizzle/"+migration,"utf8")).split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 let cookie="";
 async function request(path,method="GET",data,options={}){
  const response=await runtime.dispatchFetch("https://workshop.test/api/"+path,{method,headers:{Origin:options.origin||"https://workshop.test","X-Oficina-Request":"1","Content-Type":"application/json",...(cookie&&!options.anonymous?{Cookie:cookie}:{})},body:data===undefined?undefined:JSON.stringify(data)});
  const text=await response.text();let value;try{value=JSON.parse(text)}catch{value=text}return {response,value};
 }
 const logged=await request("auth/login","POST",{username:"test",password});assert.equal(logged.response.status,200);cookie=logged.response.headers.get("set-cookie").split(";")[0];
 const draft={requestKey:randomUUID(),customer:{name:"Marcos digitado",phone:"11911112222"},plate:"ABC1234",model:"Honda CG 160",date:"2020-01-15",odometer:12345,status:"done",items:[{kind:"labor",description:"Revisão",quantity:1,unitCents:12500}],notes:"Preservar atendimento"};
 const first=await request("orders","POST",draft);assert.equal(first.response.status,201);const order=first.value;
 const other=(await request("orders","POST",{...draft,requestKey:randomUUID(),customerId:order.customer_id})).value;
 const namesake=(await request("customers","POST",{name:draft.customer.name,phone:"11999998888"})).value;
 const changed=await request("orders/"+order.id,"PUT",{...draft,customerId:order.customer_id,customer:{name:"Márcio corrigido",phone:"11933334444"},revision:1});
 assert.equal(changed.response.status,200,JSON.stringify(changed.value));
 assert.equal(changed.value.customer_name,"Márcio corrigido","An existing attendance must save its edited customer name");
 assert.equal(changed.value.customer_phone,"11933334444");
 assert.equal(changed.value.revision,2);
 assert.equal(changed.value.customer_id,order.customer_id);assert.equal(changed.value.motorcycle_id,order.motorcycle_id);
 assert.equal(changed.value.total_cents,order.total_cents);assert.equal(changed.value.items_json,order.items_json);
 assert.equal((await request("orders/"+order.id)).value.order.customer_name,"Márcio corrigido","Correction survives reloading");
 assert.deepEqual((await request("orders/"+other.id)).value.order,{...other,source_filename:null},"Other attendance snapshots are not rewritten");
 assert.equal((await request("customers/"+order.customer_id)).value.rows[0].name,draft.customer.name,"A record correction does not rename the entire customer directory");
 assert.equal((await request("customers/"+namesake.id)).value.rows[0].phone,"11999998888","Namesakes stay separate");

 const route="orders/"+order.id+"/review-customer";
 const correction={name:"Márcio da Silva",phone:"",revision:2};
 assert.equal((await request(route,"PUT",correction,{anonymous:true})).response.status,401);
 assert.equal((await request(route,"PUT",correction,{origin:"https://foreign.test"})).response.status,403);
 for(const invalid of [{...correction,name:" "},{...correction,name:"x".repeat(161)},{...correction,phone:"x".repeat(41)},{name:"Márcio",phone:""},{...correction,customerId:namesake.id}])assert.equal((await request(route,"PUT",invalid)).response.status,400);
 assert.equal((await request("orders/999999/review-customer","PUT",correction)).response.status,404);
 const result=await request(route,"PUT",correction);assert.equal(result.response.status,200,JSON.stringify(result.value));
 assert.equal(result.value.customer_name,correction.name);assert.equal(result.value.customer_phone,"");assert.equal(result.value.revision,3);
 assert.equal((await request(route,"PUT",correction)).response.status,409,"An old edit cannot overwrite a new correction");
 const parallel=await Promise.all(["Márcio Silva A","Márcio Silva B"].map(name=>request(route,"PUT",{name,phone:"",revision:3})));
 assert.deepEqual(parallel.map(r=>r.response.status).sort(),[200,409]);
 const winner=parallel.find(r=>r.response.status===200).value;
 assert.equal((await request("orders/"+order.id)).value.order.customer_name,winner.customer_name);

 // An imported row may have no valid plate, no exact day and no known total.
 // Correcting its name must not require editing those unrelated fields.
 const source=Buffer.from("original workbook bytes");const sourceHash=createHash("sha256").update(source).digest("hex");
 const batchId=randomUUID(),objectKey="originals/"+batchId;
 await (await runtime.getR2Bucket("BUCKET")).put(objectKey,source);
 await db.prepare("INSERT INTO import_batches (id,filename,file_hash,object_key,status,created_at) VALUES (?,?,?,?,'imported',?)").bind(batchId,"fixture.xlsx",sourceHash,objectKey,new Date().toISOString()).run();
 await db.prepare("UPDATE orders SET import_batch_id=?,status='historic',plate=NULL,date_precision='month',service_date='2020-01-01',service_date_end='2020-01-31',date_original='jan/2020',source_sheet='2020',source_row=7,source_raw=?,legacy_json=?,review_issues=?,total_known=0 WHERE id=?").bind(batchId,JSON.stringify({A7:{v:"Nome original do Excel"}}),JSON.stringify({items:[],sourceNumber:"7",totalCents:null}),JSON.stringify(["Placa não informada","Data a conferir"]),other.id).run();
 const imported=(await request("orders/"+other.id)).value.order;
 const importedResult=await request("orders/"+other.id+"/review-customer","PUT",{name:"Cliente do Excel corrigido",phone:"11955556666",revision:imported.revision});
 assert.equal(importedResult.response.status,200,JSON.stringify(importedResult.value));
 const saved=(await request("orders/"+other.id)).value.order;
 assert.equal(saved.customer_name,"Cliente do Excel corrigido");assert.equal(saved.customer_phone,"11955556666");assert.equal(saved.revision,imported.revision+1);
 for(const [key,value] of Object.entries(imported))if(!["customer_name","customer_phone","updated_at","revision"].includes(key))assert.deepEqual(saved[key],value,"Unrelated imported field changed: "+key);
 assert.deepEqual(Buffer.from(await (await (await runtime.getR2Bucket("BUCKET")).get(objectKey)).arrayBuffer()),source);
 assert.equal((await request("orders/"+other.id,"PUT",{...draft,customerId:order.customer_id,revision:saved.revision})).response.status,400,"Full editing still protects original Excel contents");
 assert.equal((await request("orders?q="+encodeURIComponent(saved.customer_name))).value.rows[0].id,other.id);
 assert.match((await request("export")).value,/Cliente do Excel corrigido/);
 const backup=(await request("backup")).value;
 assert.equal(backup.customers.length,2);assert.equal(backup.motorcycles.length,1);assert.equal(backup.orders.length,2);
 const events=backup.audit_events.filter(e=>e.action==="correct_customer");assert.equal(events.length,3,"Only successful corrections have audit events");
 const event=events.find(e=>e.entity_id===String(other.id));assert.equal(JSON.parse(event.before_json).customer_name,imported.customer_name);assert.equal(JSON.parse(event.after_json).customer_name,saved.customer_name);
 assert(backup.audit_events.some(e=>e.action==="edit"&&JSON.parse(e.before_json).customer_name===draft.customer.name&&JSON.parse(e.after_json).customer?.name==="Márcio corrigido"));
 // Render the actual form: the original failure also disabled these controls.
 const formBuild=await build({stdin:{contents:'import React from "react";import {renderToStaticMarkup} from "react-dom/server";import OrderForm from "./app/order-form.tsx";export function render(initial){return renderToStaticMarkup(React.createElement(OrderForm,{initial,onCancel(){},onSaved(){}}))}',resolveDir:process.cwd(),sourcefile:"form-test.tsx"},bundle:true,format:"cjs",platform:"node",target:"es2022",external:["react","react-dom","react-dom/*"],write:false,tsconfig:"tsconfig.json"});
 const formModule={exports:{}};new Function("require","module","exports",formBuild.outputFiles[0].text)(createRequire(import.meta.url),formModule,formModule.exports);
 const html=formModule.exports.render(order);
 for(const pattern of [/<input\b[^>]*placeholder="Nome completo"[^>]*>/,/<input\b[^>]*type="tel"[^>]*>/]){const input=html.match(pattern)?.[0];assert(input,"Customer field is rendered");assert(!/\bdisabled(?:[\s=>])/.test(input),"Existing attendance customer fields must be editable");}
 console.log("PASS: manual and Excel customer-name corrections, reload/search/export, unchanged links and original data, audit, validation, authentication, CSRF, stale and concurrent edits.");
 console.log("PASS: existing-attendance form renders enabled customer name and phone inputs.");
}finally{if(runtime)await runtime.dispose();await rm(temp,{recursive:true,force:true});}

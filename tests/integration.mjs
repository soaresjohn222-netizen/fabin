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
 for(const route of ["orders","customers","motorcycles","dashboard","imports","export","backup"])assert.equal((await request(route)).response.status,401,route+" must be private");
 assert.equal((await request("auth/login","POST",{username,password},{origin:"https://foreign.test"})).response.status,403,"CSRF must fail");
 assert.equal((await request("auth/login","POST",{username,password:"invalid"})).response.status,401);
 const logged=await request("auth/login","POST",{username,password});assert.equal(logged.response.status,200,JSON.stringify(logged.value));
 const setCookie=logged.response.headers.get("set-cookie");assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=None/);assert.match(setCookie,/Partitioned/);cookie=setCookie.split(";")[0];
 assert.equal((await request("auth/me")).value.authenticated,true);
 const basic={requestKey:randomUUID(),customer:{name:"João da Silva",phone:"11987654321"},plate:"ABC-1234",model:"Honda CG 160",date:"2020-02-29",odometer:10000,status:"done",items:[{kind:"labor",description:"Revisão dos freios",quantity:1,unitCents:15000},{kind:"part",description:"Pastilha de freio",quantity:2,unitCents:5000}],notes:"Registro original"};
 const first=await request("orders","POST",basic);assert.equal(first.response.status,201,JSON.stringify(first.value));assert.equal(first.value.total_cents,25000);assert.equal(first.value.plate,"ABC1234");
 const duplicate=await request("orders","POST",basic);assert.equal(duplicate.value.id,first.value.id);
 assert.equal((await request("customers")).value.total,1);assert.equal((await request("motorcycles")).value.total,1);
 const firstId=first.value.id,customerId=first.value.customer_id,motoId=first.value.motorcycle_id;
 const invalid=await request("orders","POST",{...basic,requestKey:randomUUID(),date:"2021-02-29"});assert.equal(invalid.response.status,400);
 assert.equal((await request("orders","POST",{...basic,requestKey:randomUUID(),odometer:-1})).response.status,400);
 assert.equal((await request("orders","POST",{...basic,requestKey:randomUUID(),items:[{kind:"labor",description:"Serviço",quantity:1,unitCents:0.1}]})).response.status,400);
 const another=await request("customers","POST",{name:"João da Silva",phone:"11900001111"});assert.equal(another.response.status,201);assert.notEqual(another.value.id,customerId,"Namesakes stay separate");
 assert.equal((await request("motorcycles/"+motoId,"PUT",{plate:"XYZ1A23",model:"Honda CG 160",customerId:another.value.id})).response.status,200);
 const edited=await request("orders/"+firstId,"PUT",{...basic,customerId,revision:1,notes:"Observação corrigida"});assert.equal(edited.response.status,200,JSON.stringify(edited.value));assert.equal(edited.value.revision,2);assert.equal(edited.value.plate,"ABC1234","Historical plate preserved after registration changes");
 assert.equal((await request("orders/"+firstId,"PUT",{...basic,customerId,revision:1})).response.status,409,"Stale edits must not overwrite");
 await request("customers/"+customerId,"PUT",{name:"João — cadastro corrigido",phone:"11987654321"});
 assert.equal((await request("orders/"+firstId)).value.order.customer_name,"João da Silva","Order keeps original customer's name");
 const current={...basic,requestKey:randomUUID(),customerId:another.value.id,plate:"XYZ1A23",date:"2025-09-10",odometer:45000};
 assert.equal((await request("orders","POST",current)).response.status,201);
 assert.equal((await request("orders?customer="+customerId)).value.total,1);
 assert.equal((await request("orders?motorcycle="+motoId)).value.total,2);
 assert.equal((await request("orders?from=2020-01-01&to=2020-12-31")).value.total,1);
 assert.equal((await request("orders?from=2020-02-29&to=2020-02-29")).value.total,1);
 assert.equal((await request("orders?from=2025-09-08&to=2025-09-14")).value.total,1);
 assert.equal((await request("orders?from=2025-12-31&to=2020-01-01")).response.status,400);
 assert.equal((await request("orders?q=joao")).value.total,2,"Search ignores accents");
 const stats=(await request("dashboard?from=2020-01-01&to=2020-12-31")).value;assert.equal(stats.stats.revenue,25000);assert.equal(stats.stats.orders,1);
 const cancellation=await request("orders","POST",{...current,requestKey:randomUUID(),status:"cancelled"});assert.equal(cancellation.response.status,201);assert.equal((await request("dashboard")).value.stats.revenue,50000);
 const beforeCount=(await request("orders")).value.total;
 // Exercise pagination and complete export with more records than fit on a page.
 for(let i=0;i<25;i++)assert.equal((await request("orders","POST",{...current,requestKey:randomUUID(),status:"open"})).response.status,201);
 const page1=(await request("orders")).value,page2=(await request("orders?page=2")).value;assert.equal(page1.total,beforeCount+25);assert.equal(page1.rows.length,25);assert.equal(page2.rows.length,3);
 const backup=await request("backup");assert.equal(backup.value.orders.length,28);assert.equal(backup.value.customers.length,2);assert(!("sessions" in backup.value));
 assert(backup.value.audit_events.some(e=>e.action==="edit"&&JSON.parse(e.before_json).notes==="Registro original"));
 const csv=await request("export?from=2020-01-01&to=2020-12-31");assert.equal(csv.response.status,200);assert.match(csv.value,/2020-02-29/);assert(!csv.value.includes("2025-09-10"));
 const source=new FormData();source.set("file",new File([new Uint8Array([0x50,0x4b,3,4,1,2,3])],"arquivo-teste.xlsx"));
 const upload=await request("imports","POST",source);assert.equal(upload.response.status,201,JSON.stringify(upload.value));assert.equal(upload.value.status,"awaiting_review");
 assert.equal((await request("imports","POST",source)).response.status,409,"Duplicate source file refused");assert.equal((await request("orders")).value.total,28,"Uploading original must not invent orders");
 const original=await request("imports/"+upload.value.id);assert.equal(original.response.status,200);
 assert.equal((await request("auth/logout","POST")).response.status,200);assert.equal((await request("orders")).response.status,401,"Logout revokes session");
 for(let i=0;i<5;i++)assert.equal((await request("auth/login","POST",{username,password:"wrong"},{ip:"198.51.100.80"})).response.status,401);
 assert.equal((await request("auth/login","POST",{username,password},{ip:"198.51.100.80"})).response.status,429,"Rate limit blocks brute-force attempts");
 console.log("PASS: authentication, CSRF, session revocation, rate limiting, atomic registration, idempotency, validation, money, history snapshots, ownership changes, optimistic editing, date and accent filters, pagination, complete exports, and original-file preservation.");
}finally{if(runtime)await runtime.dispose();await rm(temp,{recursive:true,force:true});}

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
const temp=await mkdtemp(join(tmpdir(),"fabinho-plate-income-"));
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

 const logged=await request("auth/login","POST",{username,password});assert.equal(logged.response.status,200);cookie=logged.response.headers.get("set-cookie").split(";")[0];
 const draft={requestKey:randomUUID(),customer:{name:"Cliente de teste"},plate:"ABC1234",model:"Moto de teste",date:"2020-01-01",odometer:100,status:"done",items:[{kind:"labor",description:"Serviço",quantity:1,unitCents:10000}],notes:""};
 const created=await request("orders","POST",draft);assert.equal(created.response.status,201,JSON.stringify(created.value));
 const first=created.value;
 const input={...draft,requestKey:randomUUID(),customerId:first.customer_id,date:"2020-02-01"};
 const second=(await request("orders","POST",input)).value;
 const changed=await request("orders/"+second.id,"PUT",{...input,plate:"XYZ-1A23",revision:1});assert.equal(changed.response.status,200,JSON.stringify(changed.value));assert.equal(changed.value.plate,"XYZ1A23");
 assert.equal(changed.value.motorcycle_id,first.motorcycle_id);assert.equal(changed.value.customer_id,first.customer_id);
 assert.equal((await request("motorcycles/"+first.motorcycle_id)).value.rows[0].plate,"XYZ1A23");
 assert.equal((await request("orders/"+first.id)).value.order.plate,"ABC1234","Older attendance snapshot is preserved");
 assert.equal((await request("orders?q=xyz-1a23")).value.total,2,"Corrected plate finds the whole linked history");
 const followup=await request("orders","POST",{...input,requestKey:randomUUID(),plate:"XYZ1A23",date:"2020-03-01"});assert.equal(followup.response.status,201);assert.equal(followup.value.motorcycle_id,first.motorcycle_id);
 assert.equal((await request("motorcycles")).value.total,1,"Plate correction does not create another bike");
 const stale=await request("orders/"+second.id,"PUT",{...input,plate:"ABC9Z99",revision:1});assert.equal(stale.response.status,409);
 assert.equal((await request("orders/"+second.id,"PUT",{...input,plate:"INVALID",revision:2})).response.status,400);
 const occupied=await request("motorcycles","POST",{plate:"DEF1234",model:"Outra moto",customerId:first.customer_id});assert.equal(occupied.response.status,201);
 const collision=await request("orders/"+second.id,"PUT",{...input,plate:"DEF1234",revision:2});assert.equal(collision.response.status,409);
 assert.equal((await request("orders/"+second.id)).value.order.plate,"XYZ1A23");
 assert.equal((await request("motorcycles/"+first.motorcycle_id)).value.rows[0].plate,"XYZ1A23");
 const parallel=await Promise.all(["GHI1A23","JKL1A23"].map(plate=>request("orders/"+second.id,"PUT",{...input,plate,revision:2})));
 assert.deepEqual(parallel.map(r=>r.response.status).sort(),[200,409]);const winner=parallel.find(r=>r.response.status===200).value;
 assert.equal((await request("motorcycles/"+first.motorcycle_id)).value.rows[0].plate,winner.plate,"Stale concurrent edit never changes the bike");
 assert.equal((await request("orders?q="+winner.plate)).value.total,3);
 const audit=(await request("backup")).value.audit_events;assert.equal(audit.filter(e=>e.entity_id===first.motorcycle_id&&e.action==="correct_plate").length,2);
 assert(audit.some(e=>e.action==="edit"&&JSON.parse(e.before_json).plate==="ABC1234"&&JSON.parse(e.after_json).plate==="XYZ1A23"));
 assert.equal((await request("orders/"+second.id,"PUT",{...input,plate:winner.plate,revision:3},{anonymous:true})).response.status,401);
 async function financialOrder(items,status="done"){
   const r=await request("orders","POST",{...input,requestKey:randomUUID(),plate:winner.plate,date:"2024-01-10",status,items});assert.equal(r.response.status,201,JSON.stringify(r.value));return r.value;
 }
 const manual=await financialOrder([{kind:"labor",description:"Revisão",quantity:1,unitCents:10000},{kind:"part",description:"Produto",quantity:3,unitCents:2500},{kind:"other",description:"Outro item",quantity:1,unitCents:1250}]);
 assert.equal(manual.total_cents,18750);assert.equal(JSON.parse(manual.items_json)[2].kind,"other");
 for(const [grand,labor,parts,known] of [[20000,8000,12000,1],[6000,null,2000,1],[9500,6000,5000,1],[13000,5000,7000,1],[999999,99999,99999,0]]){
   const row=await financialOrder([{kind:"labor",description:"Original",quantity:1,unitCents:grand}]);
   await db.prepare("UPDATE orders SET status='historic',legacy_json=?,total_known=? WHERE id=?").bind(JSON.stringify({laborCents:labor,partsCents:parts,totalCents:known?grand:null,items:[]}),known,row.id).run();
 }
 for(const status of ["open","in_progress","cancelled"])await financialOrder([{kind:"other",description:"Fora do resumo",quantity:1,unitCents:123456}],status);
 const financial=(await request("dashboard?from=2024-01-01&to=2024-01-31")).value.financial;
 assert.equal(financial.incomeCents,67250);assert.equal(financial.unknownIncomeCount,1);
 assert.deepEqual(financial.incomeBreakdown,{laborCents:29000,partsCents:33500,otherCents:1250,unclassifiedCents:4000,differenceCents:-500,unclassifiedCount:1,differenceCount:2});
 const b=financial.incomeBreakdown;assert.equal(b.laborCents+b.partsCents+b.otherCents+b.unclassifiedCents+b.differenceCents,financial.incomeCents);
 const empty=(await request("dashboard?from=2023-01-01&to=2023-01-31")).value.financial;assert.equal(empty.incomeCents,0);assert.equal(empty.incomeBreakdown.laborCents,0);
 console.log("PASS: editable plate persistence, stable bike/customer links, corrected-plate history search, no duplicate bike, invalid/occupied plates, stale and concurrent writes, audit, authentication, three income categories, quantities, historical omissions/differences and reconciled totals.");
}finally{if(runtime)await runtime.dispose();await rm(temp,{recursive:true,force:true});}

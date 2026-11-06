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
const temp=await mkdtemp(join(tmpdir(),"oficina-finance-"));
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

 for(const route of ["dashboard","expenses","expense-imports","orders","customers","motorcycles","imports","backup","export"]){
   assert.equal((await request(route)).response.status,401,route+" remains private without a workshop session");
 }
 const logged=await request("auth/login","POST",{username,password});
 assert.equal(logged.response.status,200,JSON.stringify(logged.value));
 cookie=logged.response.headers.get("set-cookie").split(";")[0];
 async function overview(query=""){
   const result=await request("dashboard"+query);
   assert.equal(result.response.status,200,JSON.stringify(result.value));
   return result.value.financial;
 }
 const empty=await overview();
 assert.equal(empty.incomeCents,0);assert.equal(empty.outgoingCents,0);assert.equal(empty.balanceCents,0);assert.deepEqual(empty.monthly,[]);
 let customerId;
 async function order(date,status,amount){
   const input={requestKey:randomUUID(),customer:{name:"Cliente de teste"},...(customerId?{customerId}:{}),plate:"ABC1234",model:"Moto de teste",date,status,odometer:10000,items:[{kind:"labor",description:"Serviço de teste",quantity:1,unitCents:amount}],notes:""};
   const result=await request("orders","POST",input);assert.equal(result.response.status,201,JSON.stringify(result.value));
   customerId=result.value.customer_id;
   return {row:result.value,input:{...input,customerId}};
 }
 async function expense(date,kind,amount,datePrecision="day"){
   const result=await request("expenses","POST",{requestKey:randomUUID(),description:"Gasto de teste",date,kind,amountCents:amount,datePrecision});
   assert.equal(result.response.status,201,JSON.stringify(result.value));return result.value;
 }
 const completed=await order("2024-01-10","done",10000);
 await order("2024-01-15","open",50000);
 await order("2024-01-20","in_progress",60000);
 await order("2024-01-30","cancelled",70000);
 const historical=await order("2024-02-05","done",20000);
 await db.prepare("UPDATE orders SET status='historic',date_precision='month',service_date='2024-02-01',service_date_end='2024-02-29' WHERE id=?").bind(historical.row.id).run();
 const missingIncome=await order("2024-02-06","done",999999);
 await db.prepare("UPDATE orders SET status='historic',total_known=0 WHERE id=?").bind(missingIncome.row.id).run();
 await expense("2024-01-10","personal",2500);
 await expense("2024-01-11","professional",1500);
 await expense("2024-03-01","professional",40000);
 await expense("2024-02","unclassified",2000,"month");
 const cancelled=await expense("2024-01-12","professional",100000);
 assert.equal((await request("expenses/"+cancelled.id+"/status","PUT",{status:"cancelled",revision:1})).response.status,200);
 const missingOutgoing=await expense("2024-02-07","unclassified",12300);
 await db.prepare("UPDATE expenses SET amount_cents=NULL WHERE id=?").bind(missingOutgoing.id).run();
 const all=await overview();
 assert.equal(all.incomeCents,30000);assert.equal(all.outgoingCents,46000);assert.equal(all.balanceCents,-16000);
 assert.equal(all.incomeCount,3);assert.equal(all.outgoingCount,5);
 assert.equal(all.unknownIncomeCount,1);assert.equal(all.unknownOutgoingCount,1);
 assert.deepEqual(all.monthly,[
   {month:"2024-01",incomeCents:10000,outgoingCents:4000,balanceCents:6000},
   {month:"2024-02",incomeCents:20000,outgoingCents:2000,balanceCents:18000},
   {month:"2024-03",incomeCents:0,outgoingCents:40000,balanceCents:-40000}
 ]);
 for(const key of ["incomeCents","outgoingCents","balanceCents"])assert.equal(all.monthly.reduce((n,m)=>n+m[key],0),all[key],key+" reconciles with monthly series");
 assert.deepEqual(await overview("?status=cancelled&customer=unrelated&kind=personal&q=absent"),all,"Both financial sides follow only the same date range");
 const january=await overview("?from=2024-01-01&to=2024-01-31");
 assert.equal(january.incomeCents,10000);assert.equal(january.outgoingCents,4000);assert.equal(january.balanceCents,6000);assert.equal(january.monthly.length,1);
 const day=await overview("?from=2024-02-01&to=2024-02-01");
 assert.equal(day.incomeCents,0);assert.equal(day.outgoingCents,0);assert.equal(day.uncertainIncomeCount,1);assert.equal(day.uncertainOutgoingCount,1);
 const february=await overview("?from=2024-02-01&to=2024-02-29");
 assert.equal(february.incomeCents,20000);assert.equal(february.outgoingCents,2000);
 assert.equal(february.unknownIncomeCount,1);assert.equal(february.unknownOutgoingCount,1);
 assert.equal(february.uncertainIncomeCount,0);assert.equal(february.uncertainOutgoingCount,0);
 const outside=await overview("?from=2025-01-01&to=2025-12-31");
 assert.equal(outside.incomeCents,0);assert.equal(outside.outgoingCents,0);assert.deepEqual(outside.monthly,[]);
 assert.equal((await request("orders/"+completed.row.id,"PUT",{...completed.input,status:"cancelled",revision:1})).response.status,200);
 assert.equal((await overview("?from=2024-01-01&to=2024-01-31")).balanceCents,-4000,"Cancellation updates the balance");
 for(const query of ["?from=2024-02-30","?from=2024-03-01&to=2024-02-01"]){assert.equal((await request("dashboard"+query)).response.status,400);}
 assert.equal((await request("auth/logout","POST")).response.status,200);
 assert.equal((await request("dashboard")).response.status,401);
 console.log("PASS: financial totals, active expenses, completed and historical income, excluded pending/cancelled records, unknown amounts, exact/monthly date boundaries, negative balances, monthly reconciliation, filter parity, and login protection.");
}finally{if(runtime)await runtime.dispose();await rm(temp,{recursive:true,force:true});}

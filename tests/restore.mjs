import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash,randomBytes,randomUUID,scryptSync} from "node:crypto";

const require=createRequire(import.meta.url),dependencies=createRequire(require.resolve("wrangler/package.json"));
const {build}=dependencies("esbuild"),{Miniflare}=dependencies("miniflare");
const temp=await mkdtemp(join(tmpdir(),"oficina-restore-test-"));
const tables=["import_batches","customers","motorcycles","orders","expenses","expense_imports","audit_events"];
const runtimes=[];
const password=randomBytes(24).toString("base64url"),username=randomBytes(12).toString("hex"),salt=randomBytes(24).toString("hex");
const hash=`scrypt$32768$8$3$${salt}$${scryptSync(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString("hex")}`;
const origin="https://restore.test";
const sha=value=>createHash("sha256").update(value).digest("hex");
const canonical=row=>JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])));
const key=(table,row)=>String(row[table==="expense_imports"?"batch_id":"id"]);
function manifest(backup){return {format:"oficina-restore-v1",sourceHash:sha(JSON.stringify(backup)),tables:Object.fromEntries(tables.map(table=>{const rows=backup[table].map(row=>({key:key(table,row),hash:sha(canonical(row))})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);return [table,{count:rows.length,hash:sha(rows.map(row=>row.key+":"+row.hash).join("\n"))}]}))};}

async function runtime(){
  const instance=new Miniflare({modules:true,modulesRoot:temp,scriptPath:join(temp,"worker.mjs"),compatibilityDate:"2026-05-15",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],r2Buckets:["BUCKET"],bindings:{APP_ORIGIN:origin,ADMIN_USERNAME:username,ADMIN_PASSWORD_HASH:hash},cf:false});runtimes.push(instance);
  const db=await instance.getD1Database("DB");
  for(const migration of (await readdir("drizzle")).filter(name=>name.endsWith(".sql")).sort())for(const statement of (await readFile("drizzle/"+migration,"utf8")).split("--> statement-breakpoint").map(value=>value.trim()).filter(Boolean))await db.prepare(statement).run();
  let cookie="";
  async function call(path,{method="GET",data,anonymous=false,foreign=false,binary=false}={}){
    const headers={Origin:foreign?"https://foreign.test":origin,"X-Oficina-Request":"1",...(cookie&&!anonymous?{Cookie:cookie}:{})};
    let body;
    if(data instanceof FormData){const encoded=new Request(origin,{method:"POST",body:data});headers["Content-Type"]=encoded.headers.get("content-type");body=new Uint8Array(await encoded.arrayBuffer());}
    else if(data!==undefined){headers["Content-Type"]=binary?"application/octet-stream":"application/json";body=binary?data:JSON.stringify(data);}
    const response=await instance.dispatchFetch(origin+"/api/"+path,{method,headers,body});
    const raw=new Uint8Array(await response.arrayBuffer());let value;try{value=JSON.parse(new TextDecoder().decode(raw));}catch{value=raw;}
    return {status:response.status,value,response,raw};
  }
  const login=await call("auth/login",{method:"POST",data:{username,password}});assert.equal(login.status,200);cookie=login.response.headers.get("set-cookie").split(";")[0];
  return {instance,db,call};
}
async function stage(target,backup){
  const started=await target.call("restore",{method:"POST",data:manifest(backup)});assert([200,201].includes(started.status));const id=started.value.id;
  for(const table of tables){for(let offset=0;offset<backup[table].length;offset+=40){const batch=await target.call("restore/"+id+"/rows",{method:"POST",data:{table,rows:backup[table].slice(offset,offset+40).map(canonical)}});assert.equal(batch.status,200,table+" staging failed");}}
  return id;
}
async function upload(target,id,backup,files){for(const original of backup.import_batches){const response=await target.call("restore/"+id+"/files/"+original.id,{method:"POST",data:files.get(original.id),binary:true});assert.equal(response.status,200,"Original file restore failed");}}
function compare(source,target){for(const table of tables){const normalize=rows=>rows.map(row=>({key:key(table,row),raw:canonical(row)})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);assert.deepEqual(normalize(target[table]),normalize(source[table]),table+" changed during restore");}}

try{
  await build({stdin:{contents:'import {GET,POST,PUT} from "./app/api/[...path]/route.ts";export default {fetch(request){return ({GET,POST,PUT})[request.method](request)}}',resolveDir:process.cwd(),sourcefile:"restore-test.ts"},bundle:true,format:"esm",platform:"node",target:"es2022",external:["cloudflare:workers","node:*"],outfile:join(temp,"worker.mjs"),tsconfig:"tsconfig.json"});
  const source=await runtime();
  const order=await source.call("orders",{method:"POST",data:{requestKey:randomUUID(),customer:{name:"Cliente de teste",phone:"11900001111"},plate:"TST1A23",model:"Moto de teste",date:"2025-01-01",odometer:120,status:"done",items:[{kind:"labor",description:"Serviço de teste",quantity:1,unitCents:12000}],notes:"Teste de integridade"}});assert.equal(order.status,201);
  const bytes=new Uint8Array([0x50,0x4b,3,4,1,2,3,4]);const form=new FormData();form.set("file",new File([bytes],"teste.xlsx"));
  const original=await source.call("imports",{method:"POST",data:form});assert.equal(original.status,201);
  const fixture=(await source.call("backup")).value,files=new Map([[original.value.id,bytes]]);
  const target=await runtime();
  assert.equal((await target.call("restore",{method:"POST",data:manifest(fixture),anonymous:true})).status,401);
  assert.equal((await target.call("restore",{method:"POST",data:manifest(fixture),foreign:true})).status,403);
  const id=(await target.call("restore",{method:"POST",data:manifest(fixture)})).value.id;
  assert.equal((await target.call("restore/"+id+"/commit",{method:"POST"})).status,409);
  assert.equal((await target.call("restore/"+id+"/rows",{method:"POST",data:{table:"sessions",rows:["{}"]}})).status,400);
  await stage(target,fixture);
  assert.equal((await target.call("customers")).value.total,0,"Staging must not expose partial live data");
  assert.equal((await target.call("restore/"+id+"/rows",{method:"POST",data:{table:"customers",rows:[canonical({...fixture.customers[0],name:"Changed"})]}})).status,409);
  assert.equal((await target.call("restore/"+id+"/files/"+original.value.id,{method:"POST",data:new Uint8Array([1]),binary:true})).status,409);
  assert.equal((await target.call("restore/"+id+"/commit",{method:"POST"})).status,409);
  await upload(target,id,fixture,files);
  assert.equal((await target.call("restore/"+id+"/commit",{method:"POST"})).status,200);
  compare(fixture,(await target.call("backup")).value);
  assert.equal((await target.call("restore/"+id+"/commit",{method:"POST"})).value.alreadyApplied,true);
  const other=manifest(fixture);other.sourceHash=sha("other");
  assert.equal((await target.call("restore",{method:"POST",data:other})).status,409);
  assert.equal((await target.call("backup",{anonymous:true})).status,401);
  assert.equal(sha((await target.call("imports/"+original.value.id)).raw),sha(bytes));

  const broken=structuredClone(fixture);broken.orders[0].customer_id="missing-customer";
  const atomic=await runtime(),brokenId=await stage(atomic,broken);await upload(atomic,brokenId,broken,files);
  assert.equal((await atomic.call("restore/"+brokenId+"/commit",{method:"POST"})).status,503);
  const rolledBack=(await atomic.call("backup")).value;
  assert(tables.every(table=>rolledBack[table].length===0),"Foreign key failure must roll back every table");
  assert.equal((await atomic.call("restore/"+brokenId)).value.status,"staging");
  const race=await runtime(),raceId=await stage(race,fixture);await upload(race,raceId,fixture,files);
  await race.call("customers",{method:"POST",data:{name:"Registro criado durante a preparação",phone:""}});
  assert.equal((await race.call("restore/"+raceId+"/commit",{method:"POST"})).status,409);
  assert.equal((await race.call("customers")).value.total,1);
  console.log("PASS: authenticated restore, CSRF, immutable retries, file hashes, atomic rollback, row fidelity, privacy and protection of concurrent records.");

  if(process.env.RESTORE_SOURCE_DIR){
    const root=process.env.RESTORE_SOURCE_DIR,backup=JSON.parse(await readFile(join(root,"source-backup.json"),"utf8"));
    const realFiles=new Map(await Promise.all(backup.import_batches.map(async batch=>[batch.id,new Uint8Array(await readFile(join(root,"originals",batch.id+".bin")))])));
    const real=await runtime(),realId=await stage(real,backup);await upload(real,realId,backup,realFiles);
    const result=await real.call("restore/"+realId+"/commit",{method:"POST"});assert.equal(result.status,200);
    compare(backup,(await real.call("backup")).value);
    for(const batch of backup.import_batches)assert.equal(sha((await real.call("imports/"+batch.id)).raw),batch.file_hash);
    console.log("PASS: complete real snapshot restored in isolated D1/R2; every field and original file matches the source.");
  }
}finally{await Promise.all(runtimes.map(instance=>instance.dispose()));await rm(temp,{recursive:true,force:true});}

import {readFileSync,existsSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";

const root=resolve(import.meta.dirname,"..");
const config=JSON.parse(readFileSync(resolve(root,"wrangler.cloudflare.jsonc"),"utf8"));
const database=config.d1_databases?.find(d=>d.binding==="DB");
if(!database?.database_id||database.database_id==="00000000-0000-4000-8000-000000000000")throw new Error("Configure o ID real do banco D1 antes de publicar.");
if(!existsSync(resolve(root,"dist/server/wrangler.json")))throw new Error("Execute a compilação Cloudflare antes de publicar.");
const built=JSON.parse(readFileSync(resolve(root,"dist/server/wrangler.json"),"utf8"));
if(built.name!==config.name||built.d1_databases?.find(d=>d.binding==="DB")?.database_id!==database.database_id)throw new Error("A compilação não corresponde à configuração Cloudflare. Compile novamente.");
const result=spawnSync(process.execPath,[resolve(root,"node_modules/wrangler/bin/wrangler.js"),"deploy","--config",resolve(root,"dist/server/wrangler.json")],{cwd:root,stdio:"inherit"});
if(result.error)throw result.error;
process.exit(result.status??1);

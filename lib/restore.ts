import {z} from "zod";
import {db,bucket,body,readLimited,json,HttpError} from "./server";
import {digest} from "./password";

// Restore only business records. Credentials, sessions and runtime settings are excluded.
export const restoreTables=["import_batches","customers","motorcycles","orders","expenses","expense_imports","audit_events"] as const;
type Table=typeof restoreTables[number];
const tableSchema=z.enum(restoreTables);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const tableSummary=z.object({count:z.number().int().min(0).max(100000),hash}).strict();
const manifestSchema=z.object({format:z.literal("oficina-restore-v1"),sourceHash:hash,tables:z.object({import_batches:tableSummary,customers:tableSummary,motorcycles:tableSummary,orders:tableSummary,expenses:tableSummary,expense_imports:tableSummary,audit_events:tableSummary}).strict()}).strict();
type Job={id:string;source_hash:string;manifest_json:string;status:string;created_at:string;completed_at:string|null};
type Column={name:string;type:string;notnull:number;pk:number};
type StagedRow={row_key:string;row_json:string;row_hash:string};
const emptyCondition=restoreTables.map(table=>`NOT EXISTS (SELECT 1 FROM "${table}")`).join(" AND ");

async function job(id:string){
  const result=await db().prepare("SELECT * FROM restore_jobs WHERE id=?").bind(id).first<Job>();
  if(!result)throw new HttpError(404,"Importação de cópia não encontrada.");
  return result;
}
async function columns(table:Table){return (await db().prepare(`PRAGMA table_info("${table}")`).all<Column>()).results;}
async function empty(){return !!await db().prepare("SELECT 1 AS empty WHERE "+emptyCondition).first();}
function staging(record:Job){if(record.status!=="staging")throw new HttpError(409,"Esta importação já foi concluída.");}

export async function startRestore(request:Request){
  const manifest=manifestSchema.parse(await body(request,10000));
  if(Object.values(manifest.tables).reduce((total,item)=>total+item.count,0)>250000)throw new HttpError(400,"A cópia excede o limite de registros por importação.");
  const payload=JSON.stringify(manifest);
  const previous=await db().prepare("SELECT * FROM restore_jobs WHERE source_hash=?").bind(manifest.sourceHash).first<Job>();
  if(previous){if(previous.manifest_json!==payload)throw new HttpError(409,"Essa cópia já foi preparada com outra conferência.");return json({id:previous.id,status:previous.status});}
  if(!await empty())throw new HttpError(409,"A instalação já tem registros. A restauração não substitui nem apaga dados existentes.");
  const id=crypto.randomUUID();
  await db().prepare("INSERT INTO restore_jobs (id,source_hash,manifest_json,status,created_at) VALUES (?,?,?,'staging',?)").bind(id,manifest.sourceHash,payload,new Date().toISOString()).run();
  return json({id,status:"staging"},201);
}

export async function restoreStatus(id:string){
  const record=await job(id);
  const counts=await db().prepare("SELECT table_name,COUNT(*) count FROM restore_rows WHERE job_id=? GROUP BY table_name").bind(id).all();
  return json({id,status:record.status,sourceHash:record.source_hash,counts:counts.results,completedAt:record.completed_at});
}

export async function stageRestoreRows(id:string,request:Request){
  const record=await job(id);staging(record);
  const input=z.object({table:tableSchema,rows:z.array(z.string().max(800000)).min(1).max(40)}).strict().parse(await body(request,1500000));
  const specs=await columns(input.table),allowed=new Set(specs.map(column=>column.name));
  const primary=specs.find(column=>column.pk===1);
  if(!primary)throw new HttpError(503,"A tabela não tem uma chave de restauração válida.");
  const rows=input.rows.map(raw=>{
    let value:Record<string,unknown>;try{value=JSON.parse(raw);}catch{throw new HttpError(400,"Registro inválido na cópia.");}
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==allowed.size||Object.keys(value).some(key=>!allowed.has(key)))throw new HttpError(400,"As colunas da cópia não correspondem ao banco.");
    for(const column of specs){
      const cell=value[column.name];
      if(cell===null){if(column.notnull||column.pk)throw new HttpError(400,"A cópia contém campo obrigatório vazio.");continue;}
      if(column.type.toUpperCase()==="INTEGER"?typeof cell!=="number"||!Number.isSafeInteger(cell):typeof cell!=="string")throw new HttpError(400,"Tipo de valor inválido na cópia.");
    }
    const key=String(value[primary.name]);if(!key||key.length>200)throw new HttpError(400,"Identificador inválido na cópia.");
    return {key,raw,hash:digest(raw)};
  });
  if(new Set(rows.map(row=>row.key)).size!==rows.length)throw new HttpError(400,"Há identificadores repetidos no lote.");
  // Retrying a batch never overwrites an already staged row.
  await db().batch(rows.map(row=>db().prepare("INSERT INTO restore_rows (job_id,table_name,row_key,row_json,row_hash) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM restore_jobs WHERE id=? AND status='staging') ON CONFLICT(job_id,table_name,row_key) DO NOTHING").bind(id,input.table,row.key,row.raw,row.hash,id)));
  const saved=await db().prepare("SELECT row_key,row_hash FROM restore_rows WHERE job_id=? AND table_name=? AND row_key IN ("+rows.map(()=>"?").join(",")+")").bind(id,input.table,...rows.map(row=>row.key)).all<{row_key:string;row_hash:string}>();
  if(saved.results.length!==rows.length||rows.some(row=>saved.results.find(item=>item.row_key===row.key)?.row_hash!==row.hash))throw new HttpError(409,"Há conteúdo diferente para um registro já preparado.");
  return json({id,table:input.table,accepted:rows.length});
}

export async function stageRestoreFile(id:string,batchId:string,request:Request){
  staging(await job(id));
  const row=await db().prepare("SELECT row_json FROM restore_rows WHERE job_id=? AND table_name='import_batches' AND row_key=?").bind(id,batchId).first<{row_json:string}>();
  if(!row)throw new HttpError(409,"Prepare o registro da planilha antes do arquivo original.");
  const original=JSON.parse(row.row_json) as {object_key:string;file_hash:string;filename:string};
  if(!/^originals\/[a-zA-Z0-9-]+$/.test(original.object_key)||!/^[a-f0-9]{64}$/.test(original.file_hash))throw new HttpError(400,"Referência de arquivo original inválida.");
  const bytes=await readLimited(request,20*1024*1024);
  if(digest(bytes)!==original.file_hash)throw new HttpError(409,"O arquivo não corresponde ao SHA-256 da cópia.");
  const previous=await bucket().head(original.object_key);
  if(previous&&previous.customMetadata?.sha256!==original.file_hash)throw new HttpError(409,"Já existe outro conteúdo nessa referência de arquivo.");
  if(!previous)await bucket().put(original.object_key,bytes,{httpMetadata:{contentType:"application/octet-stream"},customMetadata:{sha256:original.file_hash}});
  const saved=JSON.stringify({key:original.object_key,hash:original.file_hash,bytes:bytes.byteLength});
  await db().prepare("INSERT INTO restore_rows (job_id,table_name,row_key,row_json,row_hash) SELECT ?,'__files',?,?,? WHERE EXISTS(SELECT 1 FROM restore_jobs WHERE id=? AND status='staging') ON CONFLICT(job_id,table_name,row_key) DO NOTHING").bind(id,batchId,saved,digest(saved),id).run();
  return json({id,batchId,bytes:bytes.byteLength,verified:true});
}

export async function commitRestore(id:string){
  const record=await job(id);
  if(record.status==="complete")return json({id,status:"complete",alreadyApplied:true});
  staging(record);
  const manifest=manifestSchema.parse(JSON.parse(record.manifest_json));
  // A row digest covers every column, including history, dates, amounts and audit details.
  for(const table of restoreTables){
    const rows=(await db().prepare("SELECT row_key,row_hash FROM restore_rows WHERE job_id=? AND table_name=? ORDER BY row_key COLLATE BINARY").bind(id,table).all<StagedRow>()).results;
    if(rows.length!==manifest.tables[table].count||digest(rows.map(row=>row.row_key+":"+row.row_hash).join("\n"))!==manifest.tables[table].hash)throw new HttpError(409,"A conferência dos registros de "+table+" ainda não está completa.");
  }
  const originals=(await db().prepare("SELECT row_json,row_key FROM restore_rows WHERE job_id=? AND table_name='import_batches'").bind(id).all<StagedRow>()).results;
  for(const row of originals){
    const original=JSON.parse(row.row_json);
    const stored=await bucket().head(original.object_key);
    if(!stored||stored.customMetadata?.sha256!==original.file_hash)throw new HttpError(409,"Falta conferir um arquivo original da cópia.");
  }
  const statements=[db().prepare("UPDATE restore_jobs SET status='committing' WHERE id=? AND status='staging' AND "+emptyCondition).bind(id)];
  for(const table of restoreTables){
    const specs=await columns(table);
    statements.push(db().prepare(`INSERT INTO "${table}" (${specs.map(column=>'"'+column.name+'"').join(",")}) SELECT ${specs.map(column=>`json_extract(row_json,'$.${column.name}')`).join(",")} FROM restore_rows WHERE job_id=? AND table_name=? AND EXISTS(SELECT 1 FROM restore_jobs WHERE id=? AND status='committing')`).bind(id,table,id));
  }
  statements.push(db().prepare("UPDATE restore_jobs SET status='complete',completed_at=? WHERE id=? AND status='committing'").bind(new Date().toISOString(),id));
  // D1 batch is a single transaction: either every table and link is restored or none is.
  await db().batch(statements);
  const result=await job(id);
  if(result.status!=="complete")throw new HttpError(409,"A instalação recebeu novos registros. Nenhum dado existente foi substituído.");
  return json({id,status:result.status,counts:Object.fromEntries(restoreTables.map(table=>[table,manifest.tables[table].count]))});
}

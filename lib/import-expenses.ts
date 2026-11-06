import {z} from "zod";
import {db,bucket,body,json,HttpError} from "./server";
import {digest} from "./password";
import {normalize} from "./domain";
import {validMonth,monthEnd} from "./expense-domain";

const months=["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const cents=z.number().int().min(-1000000000).max(1000000000).nullable();
const entry=z.object({sheet:z.string().min(1).max(100),row:z.number().int().positive(),period:z.string().refine(validMonth),description:z.string().max(300).nullable(),amountCents:cents,kind:z.enum(["personal","professional","unclassified"]),sourceMode:z.enum(["item","monthly_total"]),sourceRaw:z.record(z.unknown()),issues:z.array(z.string().max(500)).max(20)});
const sheet=z.object({name:z.string(),period:z.string().refine(validMonth),count:z.number().int().nonnegative(),totalCents:z.number().int(),unknownAmounts:z.number().int().nonnegative(),sourceTotalCell:z.string().nullable(),sourceTotalCents:cents,sourceTotalRaw:z.unknown(),agrees:z.boolean().nullable()});
const schema=z.object({version:z.literal("oficina-expenses-v1"),filename:z.string(),fileHash:z.string().regex(/^[a-f0-9]{64}$/),year:z.number().int().min(1900).max(2100),expenses:z.array(entry).max(10000),sheets:z.array(sheet).max(24)});
type Manifest=z.infer<typeof schema>;
type Import={batch_id:string;manifest_key:string;manifest_hash:string;expected_count:number;row_count:number;status:string;report_json:string};
export async function listExpenseImports(){const r=await db().prepare("SELECT e.*,b.filename FROM expense_imports e JOIN import_batches b ON b.id=e.batch_id ORDER BY b.filename").all<Import>();return {rows:r.results.map(x=>({...x,report:JSON.parse(x.report_json)}))};}
export async function prepareExpenses(id:string,request:Request){
 const m=schema.parse(await body(request,8000000));const original=await db().prepare("SELECT * FROM import_batches WHERE id=?").bind(id).first<{filename:string;file_hash:string}>();
 if(!original)throw new HttpError(404,"Envie a planilha original antes de importar os gastos.");
 if(original.file_hash!==m.fileHash||original.filename!==m.filename)throw new HttpError(409,"O arquivo original não corresponde aos gastos enviados.");
 const keys=new Set<string>();
 for(const e of m.expenses){const key=e.sheet+":"+e.row;if(keys.has(key))throw new HttpError(400,"Há uma linha de origem repetida.");keys.add(key);if(e.period!==`${m.year}-${String(months.indexOf(e.sheet)+1).padStart(2,"0")}`||!months.includes(e.sheet))throw new HttpError(400,"A aba e o período do gasto não correspondem.");}
 if(new Set(m.sheets.map(s=>s.name)).size!==m.sheets.length)throw new HttpError(400,"Aba repetida no resumo.");
 for(const s of m.sheets){const items=m.expenses.filter(e=>e.sheet===s.name);if(s.period!==`${m.year}-${String(months.indexOf(s.name)+1).padStart(2,"0")}`||!months.includes(s.name)||items.length!==s.count||items.reduce((n,e)=>n+(e.amountCents||0),0)!==s.totalCents||items.filter(e=>e.amountCents==null).length!==s.unknownAmounts)throw new HttpError(400,"A conferência dos gastos não corresponde ao resumo da aba.");}
 if(m.expenses.some(e=>!m.sheets.some(s=>s.name===e.sheet)))throw new HttpError(400,"Falta o resumo de uma aba.");
 const raw=JSON.stringify(m),hash=digest(raw),previous=await db().prepare("SELECT * FROM expense_imports WHERE batch_id=?").bind(id).first<Import>();
 if(previous){if(previous.manifest_hash!==hash)throw new HttpError(409,"Já existe uma preparação diferente para esta planilha.");return json(previous);}
 const key=`expense-manifests/${id}/${hash}`,stamp=new Date().toISOString();
 const report={count:m.expenses.length,totalCents:m.expenses.reduce((n,e)=>n+(e.amountCents||0),0),unknownAmounts:m.expenses.filter(e=>e.amountCents==null).length,sheets:m.sheets};
 await bucket().put(key,raw,{httpMetadata:{contentType:"application/json"}});
 await db().prepare("INSERT INTO expense_imports (batch_id,manifest_key,manifest_hash,expected_count,row_count,status,report_json,created_at,updated_at) VALUES (?,?,?,?,0,'ready',?,?,?)").bind(id,key,hash,m.expenses.length,JSON.stringify(report),stamp,stamp).run();
 return json({batch_id:id,expected_count:m.expenses.length,status:"ready",report});
}
export async function commitExpenses(id:string,request:Request){
 const input=z.object({offset:z.number().int().min(0).max(10000)}).parse(await body(request,2000));
 const batch=await db().prepare("SELECT * FROM expense_imports WHERE batch_id=?").bind(id).first<Import>();if(!batch)throw new HttpError(409,"Os gastos precisam ser preparados e conferidos antes de importar.");
 const file=await bucket().get(batch.manifest_key);if(!file)throw new HttpError(503,"A preparação dos gastos está indisponível.");const raw=await file.text();if(digest(raw)!==batch.manifest_hash)throw new HttpError(409,"O conteúdo preparado mudou. A importação foi interrompida.");
 const m=JSON.parse(raw) as Manifest;if(input.offset>m.expenses.length)throw new HttpError(400,"Posição de importação inválida.");
 const chunk=m.expenses.slice(input.offset,input.offset+30),stamp=new Date().toISOString();
 const statements=chunk.map(e=>{const description=e.description||"Gasto sem descrição na planilha";return db().prepare("INSERT OR IGNORE INTO expenses (request_key,description,search_description,amount_cents,kind,date_start,date_end,date_precision,notes,import_batch_id,source_sheet,source_row,source_mode,source_raw,review_issues,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'month','',?,?,?,?,?,?,?,?)").bind(`excel-expense:${id}:${e.sheet}:${e.row}`,description,normalize(description),e.amountCents,e.kind,e.period+"-01",monthEnd(e.period),id,e.sheet,e.row,e.sourceMode,JSON.stringify({period:e.period,description:e.description,amountCents:e.amountCents,kind:e.kind,sourceMode:e.sourceMode,cells:e.sourceRaw}),JSON.stringify(e.issues),stamp,stamp);});
 statements.push(db().prepare("UPDATE expense_imports SET row_count=(SELECT COUNT(*) FROM expenses WHERE import_batch_id=?),status=CASE WHEN (SELECT COUNT(*) FROM expenses WHERE import_batch_id=?)=expected_count THEN 'imported' ELSE 'importing' END,updated_at=? WHERE batch_id=?").bind(id,id,stamp,id));
 statements.push(db().prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,after_json,created_at) VALUES (?,'expense_import',?,'commit',?,?)").bind(crypto.randomUUID(),id,JSON.stringify({offset:input.offset,processed:chunk.length}),stamp));
 await db().batch(statements);const saved=await db().prepare("SELECT row_count,status,expected_count FROM expense_imports WHERE batch_id=?").bind(id).first();
 return json({...saved,nextOffset:Math.min(input.offset+30,m.expenses.length)});
}

import {z} from "zod";
import {db,bucket,HttpError,body,json} from "./server";
import {digest} from "./password";
import {normalize,normalizePlate,today} from "./domain";
import {audit} from "./records";
const cents=z.number().int().min(-1000000000).max(1000000000).nullable();
const iso=z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+"T12:00:00Z");return !isNaN(+d)&&d.toISOString().slice(0,10)===v});
const legacyRecord=z.object({
 sheet:z.string().min(1).max(120),row:z.number().int().positive(),endRow:z.number().int().positive(),sourceNumber:z.string().max(80),
 date:iso,dateEnd:iso,datePrecision:z.enum(["day","month"]),dateOriginal:z.string().max(300),suggestedDate:iso.nullable(),
 name:z.string().max(160).nullable(),phone:z.string().max(80),plate:z.string().max(80).nullable(),canonicalPlate:z.string().regex(/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/).nullable(),model:z.string().max(160).nullable(),odometer:z.number().int().min(0).max(9999999).nullable(),
 service:z.string().min(1).max(12000),items:z.array(z.object({row:z.number().int().positive(),description:z.string().max(2000).nullable(),part:z.string().max(2000).nullable(),quantity:z.string().max(200).nullable(),value:z.string().max(200).nullable(),valueCents:cents})).max(80),
 partsCents:cents,laborCents:cents,totalCents:cents,totalBasis:z.enum(["stated","unknown"]),totalCell:z.string().nullable(),partsCell:z.string().nullable(),laborCell:z.string().nullable(),notes:z.string().max(10000),issues:z.array(z.string().max(500)).max(30),raw:z.record(z.string(),z.unknown()),
}).superRefine((r,c)=>{
 if(r.endRow<r.row||r.dateEnd<r.date||r.date.slice(0,7)!==r.dateEnd.slice(0,7))c.addIssue({code:"custom",message:"Referência da ficha inválida."});
 if(r.canonicalPlate&&normalizePlate(r.plate||"")!==r.canonicalPlate)c.addIssue({code:"custom",message:"A placa não corresponde ao original."});
 if(r.datePrecision==="day"&&r.date!==r.dateEnd)c.addIssue({code:"custom",message:"Data exata inválida."});
 if(r.datePrecision==="month"){
  const last=new Date(Date.UTC(Number(r.date.slice(0,4)),Number(r.date.slice(5,7)),0,12)).toISOString().slice(0,10);
  if(!r.date.endsWith("-01")||r.dateEnd!==last)c.addIssue({code:"custom",message:"Mês de referência inválido."});
 }
});
const sourceReview=z.object({orderId:z.number().int().positive(),beforePlate:z.string().max(80).nullable(),record:legacyRecord});
const manifestSchema=z.object({version:z.literal("oficina-excel-v1"),filename:z.string().max(220),fileHash:z.string().regex(/^[a-f0-9]{64}$/),year:z.number().int().min(2000).max(2099),records:z.array(legacyRecord).max(5000),sheets:z.array(z.object({name:z.string().max(120),kind:z.enum(["month","other"]),records:z.number().int().min(0)}).passthrough()).max(100),sourceReviews:z.array(sourceReview).max(100).optional()});
type Manifest=z.infer<typeof manifestSchema>;
type Batch={id:string;filename:string;file_hash:string;status:string;row_count:number;expected_count:number;manifest_key:string|null;manifest_hash:string|null;report_json:string|null};
export async function importSummary(id?:string){
 const rows=await db().prepare("SELECT id,filename,row_count,status,expected_count,report_json,created_at,completed_at FROM import_batches"+(id?" WHERE id=?":" ORDER BY filename")).bind(...(id?[id]:[])).all();
 return {rows:rows.results.map(r=>({...r,report:r.report_json?JSON.parse(String(r.report_json)):null,report_json:undefined}))};
}
function makeReport(m:Manifest){return {year:m.year,records:m.records.length,totalCents:m.records.reduce((n,r)=>n+(r.totalCents||0),0),unknownTotals:m.records.filter(r=>r.totalCents===null).length,datesToReview:m.records.filter(r=>r.datePrecision==="month").length,recordsToReview:m.records.filter(r=>r.issues.length).length,missingPlate:m.records.filter(r=>!r.canonicalPlate).length,missingName:m.records.filter(r=>!r.name).length,sourceReviews:m.sourceReviews?.length||0,sheets:m.sheets};}
function verifyPlateReview(before:any,review:z.infer<typeof sourceReview>){
 const r=review.record,legacy=JSON.parse(before?.legacy_json||"{}");
 if(!before?.import_batch_id||before.source_sheet!==r.sheet||before.source_row!==r.row||before.plate!==review.beforePlate)throw new HttpError(409,"A ficha anterior não corresponde à correção preparada.");
 // This review only removes an invalid plate value or preserves the same valid plate.
 const previous=normalizePlate(before.plate||"");
 if(r.canonicalPlate?previous!==r.canonicalPlate:/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(previous)||r.plate!==null)throw new HttpError(400,"A correção exige conferir o vínculo da moto antes de alterar a placa.");
 const same=r.name===(before.customer_name==="Cliente não informado"?null:before.customer_name)&&r.model===(before.model==="Moto não informada"?null:before.model)&&r.phone===before.customer_phone&&r.dateOriginal===before.date_original&&r.odometer===before.odometer&&r.service===before.service&&r.notes===before.notes&&r.totalCents===(before.total_known?before.total_cents:null)&&JSON.stringify(r.items)===JSON.stringify(legacy.items);
 if(!same)throw new HttpError(409,"Há outras alterações na ficha. Confira os dados antes de corrigir a placa.");
}
async function getBatch(id:string){const b=await db().prepare("SELECT * FROM import_batches WHERE id=?").bind(id).first<Batch>();if(!b)throw new HttpError(404,"Planilha não encontrada.");return b;}
export async function prepareHistory(id:string,request:Request){
 const b=await getBatch(id);const m=manifestSchema.parse(await body(request,12*1024*1024));
 if(m.fileHash!==b.file_hash||m.filename!==b.filename)throw new HttpError(409,"A conferência não corresponde ao arquivo original guardado.");
 const keys=new Set<string>();const sheetCounts=new Map<string,number>();
 for(const r of m.records){const key=r.sheet+":"+r.row;if(keys.has(key))throw new HttpError(400,"Há fichas repetidas na conferência.");keys.add(key);sheetCounts.set(r.sheet,(sheetCounts.get(r.sheet)||0)+1);if(!r.date.startsWith(String(m.year)))throw new HttpError(400,"Ano de referência inválido.");}
 const sheetNames=new Set(m.sheets.map(s=>s.name));
 if(sheetNames.size!==m.sheets.length||m.sheets.some(s=>s.records!==(sheetCounts.get(s.name)||0))||m.records.some(r=>!sheetNames.has(r.sheet)))throw new HttpError(400,"A contagem das abas não confere.");
 const reviewIds=new Set<number>();
 for(const review of m.sourceReviews||[]){if(reviewIds.has(review.orderId)||keys.has(review.record.sheet+":"+review.record.row)||!sheetNames.has(review.record.sheet)||!review.record.date.startsWith(String(m.year)))throw new HttpError(400,"Correção de origem repetida ou fora das abas selecionadas.");reviewIds.add(review.orderId);if(!b.manifest_key){const before=await db().prepare("SELECT * FROM orders WHERE id=?").bind(review.orderId).first();verifyPlateReview(before,review);}}
 const payload=JSON.stringify(m),hash=digest(payload);
 if(b.manifest_hash===hash)return json({id,status:b.status,report:makeReport(m)});
 if(b.status!=="awaiting_review")throw new HttpError(409,"Esta planilha já tem uma conferência. Os registros importados foram preservados.");
 const key="manifests/"+id+"/"+hash;await bucket().put(key,payload,{httpMetadata:{contentType:"application/json"}});
 const result=await db().prepare("UPDATE import_batches SET manifest_key=?,manifest_hash=?,expected_count=?,report_json=?,status='ready' WHERE id=? AND status='awaiting_review'").bind(key,hash,m.records.length,JSON.stringify(makeReport(m)),id).run();
 if(!result.meta.changes)throw new HttpError(409,"Esta planilha mudou em outra janela. Atualize a lista.");
 return json({id,status:"ready",report:makeReport(m)});
}
export async function commitHistory(id:string,request:Request){
 const input=z.object({offset:z.number().int().min(0)}).parse(await body(request,2000));const b=await getBatch(id);
 if(!b.manifest_key||!b.manifest_hash)throw new HttpError(409,"Primeiro confira a estrutura e os totais desta planilha.");
 if(b.status==="imported")return json({id,status:b.status,imported:b.row_count,total:b.expected_count});
 if(!["ready","importing"].includes(b.status))throw new HttpError(409,"Esta planilha não está pronta para importar.");
 if(input.offset!==b.row_count)return json({id,status:b.status,imported:b.row_count,total:b.expected_count});
 const file=await bucket().get(b.manifest_key);if(!file)throw new HttpError(503,"A conferência está indisponível.");const payload=await file.text();if(digest(payload)!==b.manifest_hash)throw new HttpError(409,"O conteúdo da conferência foi alterado.");const m=JSON.parse(payload) as Manifest;
 const selected=m.records.slice(b.row_count,b.row_count+10);const stamp=new Date().toISOString();const statements:D1PreparedStatement[]=[];
 for(const r of selected){
  const source=id+":"+r.sheet+":"+r.row;const name=r.name||"Cliente não informado";const model=r.model||"Moto não informada";
  // Names alone never identify customers. Matching also requires the same valid plate.
  const customerKey=r.name&&r.canonicalPlate?normalize(r.name)+"|"+r.canonicalPlate:"source:"+source;
  const customerId="hist-c-"+digest(customerKey);const motoId="hist-m-"+digest(r.canonicalPlate||source);const orderKey="excel:"+source;
  const sort=r.date.slice(0,7)+":"+String(r.row).padStart(7,"0");
  statements.push(db().prepare("INSERT OR IGNORE INTO customers (id,name,search_name,phone,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(customerId,name,normalize(name),r.phone,"Cadastro do Excel. Vínculo agrupado por nome e placa; confirme os dados na próxima visita.",stamp,stamp));
  statements.push(db().prepare("INSERT OR IGNORE INTO motorcycles (id,plate,model,customer_id,notes,source_sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").bind(motoId,r.canonicalPlate,model,customerId,"Cadastro do Excel. Cliente do último registro; confirme o proprietário. "+(!r.canonicalPlate?"Placa original: "+(r.plate||"não informada")+".":""),sort,stamp,stamp));
  const condition=r.canonicalPlate?"plate=?":"id=?",motoValue=r.canonicalPlate||motoId;
  statements.push(db().prepare("UPDATE motorcycles SET customer_id=?,model=CASE WHEN ? IS NULL THEN model ELSE ? END,source_sort=?,updated_at=? WHERE "+condition+" AND source_sort IS NOT NULL AND source_sort<?").bind(customerId,r.model,r.model,sort,stamp,motoValue,sort));
  const legacy={sourceNumber:r.sourceNumber,endRow:r.endRow,items:r.items,partsCents:r.partsCents,laborCents:r.laborCents,totalCents:r.totalCents,totalBasis:r.totalBasis,totalCell:r.totalCell,partsCell:r.partsCell,laborCell:r.laborCell,suggestedDate:r.suggestedDate};
  statements.push(db().prepare("INSERT OR IGNORE INTO orders (request_key,customer_id,motorcycle_id,service_date,service_date_end,date_precision,date_original,odometer,status,service,items_json,total_cents,total_known,notes,customer_name,customer_phone,plate,model,import_batch_id,source_sheet,source_row,source_raw,legacy_json,review_issues,created_at,updated_at) VALUES (?,?,(SELECT id FROM motorcycles WHERE "+condition+"),?,?,?,?,?,'historic',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(orderKey,customerId,motoValue,r.date,r.dateEnd,r.datePrecision,r.dateOriginal,r.odometer,r.service,"[]",r.totalCents??0,r.totalCents===null?0:1,r.notes,name,r.phone,r.plate,model,id,r.sheet,r.row,JSON.stringify(r.raw),JSON.stringify(legacy),JSON.stringify(r.issues),stamp,stamp));
 }
 const next=b.row_count+selected.length,complete=next===m.records.length;
 statements.push(db().prepare("UPDATE import_batches SET row_count=(SELECT COUNT(*) FROM orders WHERE import_batch_id=?),status=CASE WHEN (SELECT COUNT(*) FROM orders WHERE import_batch_id=?)=expected_count THEN 'imported' ELSE 'importing' END,completed_at=CASE WHEN (SELECT COUNT(*) FROM orders WHERE import_batch_id=?)=expected_count THEN ? ELSE NULL END WHERE id=?").bind(id,id,id,stamp,id));
 statements.push(audit("import",id,complete?"complete":"import",{offset:b.row_count},{offset:next,manifestHash:b.manifest_hash}));
 await db().batch(statements);const result=await getBatch(id);return json({id,status:result.status,imported:result.row_count,total:result.expected_count});
}
export async function reviewDate(id:number,request:Request){
 const input=z.object({date:iso.refine(v=>v<=today(),"Informe uma data até hoje."),revision:z.number().int().positive(),reason:z.string().trim().min(5).max(1000)}).parse(await body(request,3000));
 const before=await db().prepare("SELECT * FROM orders WHERE id=?").bind(id).first<any>();if(!before?.import_batch_id)throw new HttpError(400,"Use a edição de ordens para os novos atendimentos.");if(before.revision!==input.revision)throw new HttpError(409,"O registro mudou. Reabra antes de conferir.");
 const issues=JSON.parse(before.review_issues).filter((s:string)=>!s.startsWith("Data ausente ou divergente"));const stamp=new Date().toISOString();
 const results=await db().batch([
  db().prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?,'order',?,'review_date',?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND revision=?)").bind(crypto.randomUUID(),String(id),JSON.stringify({date:before.service_date,precision:before.date_precision}),JSON.stringify(input),stamp,id,input.revision),
  db().prepare("UPDATE orders SET service_date=?,service_date_end=?,date_precision='day',review_issues=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?").bind(input.date,input.date,JSON.stringify(issues),stamp,id,input.revision)
 ]);if(!results[1].meta.changes)throw new HttpError(409,"O registro mudou. Reabra antes de conferir.");return json({ok:true});
}

export async function reviewPlateFromUpdate(id:number,request:Request){
 const input=z.object({sourceBatchId:z.string().min(1).max(100),revision:z.number().int().positive()}).parse(await body(request,2000));
 const b=await getBatch(input.sourceBatchId);
 if(b.status!=="imported"||!b.manifest_key||!b.manifest_hash)throw new HttpError(409,"Conclua a importação da planilha atualizada antes da correção.");
 const file=await bucket().get(b.manifest_key);if(!file)throw new HttpError(503,"A conferência está indisponível.");const payload=await file.text();if(digest(payload)!==b.manifest_hash)throw new HttpError(409,"O conteúdo preparado foi alterado.");
 const m=JSON.parse(payload) as Manifest,review=m.sourceReviews?.find(r=>r.orderId===id);if(!review)throw new HttpError(400,"Esta planilha não contém uma correção preparada para a ficha.");
 const before=await db().prepare("SELECT * FROM orders WHERE id=?").bind(id).first<any>();if(!before?.import_batch_id)throw new HttpError(404,"Ficha histórica não encontrada.");
 const legacy=JSON.parse(before.legacy_json),corrections=legacy.sourceCorrections||[];
 if(corrections.some((c:any)=>c.batchId===b.id&&c.field==="plate"))return json({ok:true,alreadyApplied:true});
 if(before.revision!==input.revision)throw new HttpError(409,"O registro mudou. Reabra antes de conferir.");verifyPlateReview(before,review);
 const correction={field:"plate",previous:before.plate,value:review.record.plate,batchId:b.id,filename:b.filename,fileHash:b.file_hash,sheet:review.record.sheet,row:review.record.row};
 const updated={...legacy,sourceCorrections:[...corrections,correction]},stamp=new Date().toISOString();
 const results=await db().batch([
  db().prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?,'order',?,'review_plate',?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND revision=?)").bind(crypto.randomUUID(),String(id),JSON.stringify({plate:before.plate}),JSON.stringify(correction),stamp,id,input.revision),
  db().prepare("UPDATE orders SET plate=?,legacy_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(review.record.plate,JSON.stringify(updated),stamp,id,input.revision)
 ]);if(!results[1].meta.changes)throw new HttpError(409,"O registro mudou. Reabra antes de conferir.");return json({ok:true});
}

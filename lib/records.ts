import { db, HttpError } from "./server";
import {z} from "zod";
import {expenseDashboard} from "./expenses";
import {incomeBreakdown} from "./income";
import { normalize, normalizePlate, orderSchema, orderCustomerSchema, customerSchema, motorcycleSchema, type Order } from "./domain";

export const orderSelect="SELECT o.* FROM orders o";
export const motorcycleSelect=`SELECT m.*,c.name customer_name,c.phone,
 (SELECT odometer FROM orders WHERE motorcycle_id=m.id AND status<>'cancelled' AND odometer IS NOT NULL ORDER BY service_date DESC,id DESC LIMIT 1) last_odometer,
 (SELECT date_precision FROM orders WHERE motorcycle_id=m.id AND status<>'cancelled' ORDER BY service_date DESC,id DESC LIMIT 1) last_precision,
 (SELECT MAX(service_date) FROM orders WHERE motorcycle_id=m.id AND status<>'cancelled') last_date,
 (SELECT COUNT(*) FROM orders WHERE motorcycle_id=m.id) visits FROM motorcycles m JOIN customers c ON c.id=m.customer_id`;
export function orderWhere(params:URLSearchParams) {
  const clauses:string[]=[];const values:(string|number)[]=[];
  for(const [key,col] of [["from","service_date"],["to","service_date"],["customer","customer_id"],["motorcycle","motorcycle_id"],["status","status"]]){
    const v=params.get(key);if(!v||v==="all")continue;
    if((key==="from"||key==="to")&&!/^\d{4}-\d{2}-\d{2}$/.test(v))throw new HttpError(400,"Período inválido.");
    clauses.push(`${key==="to"?"COALESCE(o.service_date_end,o.service_date)":"o."+col}${key==="from"?">=":key==="to"?"<=":"="}?`);values.push(v);
  }
  if(params.get("from")&&params.get("to")&&params.get("from")!>params.get("to")!)throw new HttpError(400,"A data inicial deve vir antes da data final.");
  if(params.get("review")==="1")clauses.push("o.review_issues<>'[]'");
  const q=params.get("q")?.trim().slice(0,160);
  if(q){clauses.push("(REPLACE(REPLACE(UPPER(o.plate),'-',''),' ','') LIKE ? OR o.motorcycle_id IN (SELECT id FROM motorcycles WHERE plate LIKE ?) OR o.customer_name LIKE ? OR o.model LIKE ? OR o.service LIKE ? OR o.customer_id IN (SELECT id FROM customers WHERE search_name LIKE ?) OR CAST(o.id AS TEXT)=?)");values.push(`%${q.toUpperCase().replace(/[- ]/g,"")}%`,`%${normalizePlate(q)||"!"}%`,`%${q}%`,`%${q}%`,`%${q}%`,`%${normalize(q)}%`,q.replace(/^#/,""));}
  return {sql:clauses.length?" WHERE "+clauses.join(" AND "):"",values};
}
export async function listOrders(params:URLSearchParams) {
  const w=orderWhere(params);const page=Math.max(1,Math.min(100000,Number(params.get("page"))||1));const size=25;
  const [rows,count]=await db().batch<Record<string,any>>([db().prepare(orderSelect+w.sql+" ORDER BY o.service_date DESC,o.id DESC LIMIT ? OFFSET ?").bind(...w.values,size,(page-1)*size),db().prepare("SELECT COUNT(*) total FROM orders o"+w.sql).bind(...w.values)]);
  return {rows:rows.results,total:count.results[0].total,page,pageSize:size,uncertainOutsideRange:await uncertainOutsideRange(params)};
}
export async function uncertainOutsideRange(params:URLSearchParams){
 if(!params.get("from")&&!params.get("to"))return 0;
 const p=new URLSearchParams(params);p.delete("from");p.delete("to");const w=orderWhere(p);const from=params.get("from")||"1900-01-01",to=params.get("to")||"2099-12-31";
 const r=await db().prepare("SELECT COUNT(*) total FROM orders o"+w.sql+(w.sql?" AND ":" WHERE ")+"o.date_precision='month' AND o.service_date<=? AND o.service_date_end>=? AND NOT(o.service_date>=? AND o.service_date_end<=?)").bind(...w.values,to,from,from,to).first<{total:number}>();return r?.total||0;
}
export async function dashboard(params:URLSearchParams){
  const w=orderWhere(params);
  const expenses=await expenseDashboard(params);
  const [stats,monthly,years,totals]=await db().batch<Record<string,any>>([
    db().prepare("SELECT COUNT(*) orders, COALESCE(SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END),0) pending, COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),0) done, COALESCE(SUM(CASE WHEN status='done' THEN total_cents ELSE 0 END),0) revenue, COUNT(DISTINCT customer_id) customers, COALESCE(SUM(CASE WHEN status<>'cancelled' AND total_known=1 THEN total_cents ELSE 0 END),0) registered, COALESCE(SUM(CASE WHEN status='historic' THEN 1 ELSE 0 END),0) historic, COALESCE(SUM(CASE WHEN total_known=0 THEN 1 ELSE 0 END),0) unknown_totals FROM orders o"+w.sql).bind(...w.values),
    db().prepare("SELECT substr(service_date,1,7) month,COUNT(*) orders,COALESCE(SUM(CASE WHEN status='done' THEN total_cents ELSE 0 END),0) revenue FROM orders o"+w.sql+" GROUP BY month ORDER BY month").bind(...w.values),
    db().prepare("SELECT substr(service_date,1,4) year FROM orders UNION SELECT substr(date_start,1,4) year FROM expenses ORDER BY year DESC"),
    db().prepare("SELECT (SELECT COUNT(*) FROM customers) customers, (SELECT COUNT(*) FROM motorcycles) motorcycles,(SELECT COUNT(*) FROM orders) orders")
  ]);return {financial:await financialOverview(params,expenses),expenses,uncertainOutsideRange:await uncertainOutsideRange(params),stats:stats.results[0],monthly:monthly.results,years:years.results.map(x=>x.year),totals:totals.results[0]};
}
async function financialOverview(params:URLSearchParams,expenses:Awaited<ReturnType<typeof expenseDashboard>>){
  // Both sides use only the same date range. Open/cancelled orders are not income.
  const period=new URLSearchParams();for(const key of ["from","to"])if(params.get(key))period.set(key,params.get(key)!);
  const w=orderWhere(period),where=w.sql+(w.sql?" AND ":" WHERE ")+"o.status IN ('done','historic')";
  const [totals,months,components]=await db().batch<Record<string,any>>([
    db().prepare("SELECT COUNT(*) count,COALESCE(SUM(CASE WHEN o.total_known=1 THEN o.total_cents ELSE 0 END),0) income,COALESCE(SUM(o.total_known=0),0) unknown FROM orders o"+where).bind(...w.values),
    db().prepare("SELECT substr(o.service_date,1,7) month,COALESCE(SUM(CASE WHEN o.total_known=1 THEN o.total_cents ELSE 0 END),0) income FROM orders o"+where+" GROUP BY month ORDER BY month").bind(...w.values),
    db().prepare("SELECT total_cents,total_known,items_json,legacy_json,import_batch_id FROM orders o"+where).bind(...w.values)
  ]);
  let uncertainIncomeCount=0;
  if(period.get("from")||period.get("to")){
    const from=period.get("from")||"1900-01-01",to=period.get("to")||"9999-12-31";
    const row=await db().prepare("SELECT COUNT(*) count FROM orders o WHERE o.status IN ('done','historic') AND o.date_precision='month' AND o.service_date<=? AND o.service_date_end>=? AND NOT(o.service_date>=? AND o.service_date_end<=?)").bind(to,from,from,to).first<{count:number}>();uncertainIncomeCount=row?.count||0;
  }
  const incomeCents=Number(totals.results[0].income),outgoingCents=Number(expenses.summary.total);
  const series=new Map<string,{month:string;incomeCents:number;outgoingCents:number;balanceCents:number}>();
  for(const row of months.results)series.set(row.month,{month:row.month,incomeCents:Number(row.income),outgoingCents:0,balanceCents:0});
  for(const row of expenses.monthly){const m=series.get(row.month)||{month:row.month,incomeCents:0,outgoingCents:0,balanceCents:0};m.outgoingCents=Number(row.total);series.set(row.month,m);}
  const monthly=Array.from(series.values()).sort((a,b)=>a.month.localeCompare(b.month)).map(m=>({...m,balanceCents:m.incomeCents-m.outgoingCents}));
  return {incomeCents,outgoingCents,balanceCents:incomeCents-outgoingCents,incomeBreakdown:incomeBreakdown(components.results as Parameters<typeof incomeBreakdown>[0]),incomeCount:Number(totals.results[0].count),outgoingCount:Number(expenses.summary.count),unknownIncomeCount:Number(totals.results[0].unknown),unknownOutgoingCount:Number(expenses.summary.unknown),uncertainIncomeCount,uncertainOutgoingCount:expenses.uncertainOutsideRange,monthly};
}
export function audit(type:string,id:string,action:string,before:unknown,after:unknown){return db().prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),type,id,action,before?JSON.stringify(before):null,JSON.stringify(after),new Date().toISOString())}
export async function deleteOrder(raw:unknown,id:number){
 const {revision}=z.object({revision:z.number().int().positive(),confirmId:z.number().int().positive()}).strict().refine(x=>x.confirmId===id,{message:"Confirme o número da ordem que deseja excluir."}).parse(raw);
 const database=db(),before=await database.prepare("SELECT * FROM orders WHERE id=?").bind(id).first<Order>();
 if(!before)throw new HttpError(404,"Ordem não encontrada. Ela pode já ter sido excluída.");
 if(before.revision!==revision)throw new HttpError(409,"Esta ordem foi alterada em outra janela. Reabra a ordem antes de excluir.");
 const eventId=crypto.randomUUID();
 // Keep the complete snapshot and deletion in one transaction. Never delete linked
 // customers, motorcycles, other orders or the workbook that supplied this row.
 const result=await database.batch([
  database.prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?,'order',?,'delete',?,?,? WHERE EXISTS(SELECT 1 FROM orders WHERE id=? AND revision=?)").bind(eventId,String(id),JSON.stringify(before),JSON.stringify({id,deleted:true}),new Date().toISOString(),id,revision),
  database.prepare("DELETE FROM orders WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)").bind(id,revision,eventId),
 ]);
 if(result[1].meta.changes!==1)throw new HttpError(409,"Esta ordem foi alterada ou excluída em outra janela. Atualize a lista.");
 return {id,deleted:true};
}
export async function saveCustomer(raw:unknown,id?:string){
 const x=customerSchema.parse(raw);const stamp=new Date().toISOString();const before=id?await db().prepare("SELECT * FROM customers WHERE id=?").bind(id).first():null;
 if(id&&!before)throw new HttpError(404,"Cliente não encontrado.");const key=id||crypto.randomUUID();
 const statement=id?db().prepare("UPDATE customers SET name=?,search_name=?,phone=?,notes=?,updated_at=? WHERE id=?").bind(x.name,normalize(x.name),x.phone,x.notes,stamp,key):db().prepare("INSERT INTO customers (id,name,search_name,phone,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(key,x.name,normalize(x.name),x.phone,x.notes,stamp,stamp);
 await db().batch<Record<string,any>>([statement,audit("customer",key,id?"edit":"create",before,x)]);return {id:key,...x};
}
export async function correctOrderCustomer(raw:unknown,id:number){
 const x=orderCustomerSchema.parse(raw),database=db();
 const before=await database.prepare("SELECT * FROM orders WHERE id=?").bind(id).first<Order>();
 if(!before)throw new HttpError(404,"Ordem não encontrada.");
 if(before.revision!==x.revision)throw new HttpError(409,"Esta ordem foi alterada em outra janela. Reabra a ordem antes de editar.");
 const stamp=new Date().toISOString(),editId=crypto.randomUUID();
 const after={customer_name:x.name,customer_phone:x.phone,revision:x.revision+1};
 // Correct the attendance snapshot, including imported fichas, without rewriting
 // source cells, financial values, directory identities or other attendances.
 const result=await database.batch([
  database.prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?,'order',?,'correct_customer',?,?,? WHERE EXISTS (SELECT 1 FROM orders WHERE id=? AND revision=?)").bind(editId,String(id),JSON.stringify(before),JSON.stringify(after),stamp,id,x.revision),
  database.prepare("UPDATE orders SET customer_name=?,customer_phone=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)").bind(x.name,x.phone,stamp,id,x.revision,editId),
 ]);
 if(!result[1].meta.changes)throw new HttpError(409,"A ordem mudou em outra janela. Reabra para conferir.");
 return await database.prepare("SELECT * FROM orders WHERE id=?").bind(id).first<Order>();
}
export async function saveMotorcycle(raw:unknown,id?:string){
 const x=motorcycleSchema.parse(raw);const stamp=new Date().toISOString();if(!await db().prepare("SELECT id FROM customers WHERE id=?").bind(x.customerId).first())throw new HttpError(400,"Selecione um cliente cadastrado.");
 const before=id?await db().prepare("SELECT * FROM motorcycles WHERE id=?").bind(id).first():null;if(id&&!before)throw new HttpError(404,"Moto não encontrada.");
 const duplicate=await db().prepare("SELECT id FROM motorcycles WHERE plate=? AND id<>?").bind(x.plate,id||"").first();if(duplicate)throw new HttpError(409,"Esta placa já está cadastrada. Localize a moto pela placa.");
 const key=id||crypto.randomUUID();const statement=id?db().prepare("UPDATE motorcycles SET plate=?,model=?,customer_id=?,notes=?,source_sort=NULL,updated_at=? WHERE id=?").bind(x.plate,x.model,x.customerId,x.notes,stamp,key):db().prepare("INSERT INTO motorcycles (id,plate,model,customer_id,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(key,x.plate,x.model,x.customerId,x.notes,stamp,stamp);
 await db().batch<Record<string,any>>([statement,audit("motorcycle",key,id?"edit":"create",before,x)]);return {id:key,...x};
}
export async function saveOrder(raw:unknown,id?:number){
 const x=orderSchema.parse(raw);const stamp=new Date().toISOString();const database=db();
 const existing=await database.prepare("SELECT * FROM orders WHERE request_key=?").bind(x.requestKey).first<Order>();
 if(!id&&existing)return existing;
 const before=id?await database.prepare("SELECT * FROM orders WHERE id=?").bind(id).first<Order>():null;
 if(id&&!before)throw new HttpError(404,"Ordem não encontrada.");
 if(before?.import_batch_id)throw new HttpError(400,"O registro original do Excel é preservado. Use Corrigir cliente para nome e telefone ou Conferir data para corrigir o dia.");
 if(before&&before.revision!==x.revision)throw new HttpError(409,"Esta ordem foi alterada em outra janela. Reabra a ordem antes de editar.");
 const customer=x.customerId?await database.prepare("SELECT * FROM customers WHERE id=?").bind(x.customerId).first():null;
 if(x.customerId&&!customer)throw new HttpError(400,"Cliente não encontrado. Selecione novamente.");
 // Names are never used as an automatic identity match: namesakes stay separate.
 const customerId=String(customer?.id||crypto.randomUUID());
 const moto=before?await database.prepare("SELECT * FROM motorcycles WHERE id=?").bind(before.motorcycle_id).first():await database.prepare("SELECT * FROM motorcycles WHERE plate=?").bind(x.plate).first();
 if(before&&(before.motorcycle_id!==moto?.id||before.customer_id!==customerId))throw new HttpError(400,"Para corrigir o vínculo do atendimento, cancele esta ordem e abra outra. O histórico será preservado.");
 if(!before&&moto&&moto.customer_id!==customerId)throw new HttpError(409,"Esta moto pertence a outro cadastro. Atualize o proprietário em Motos antes de abrir a ordem.");
 const plateChanged=!!before&&x.plate!==normalizePlate(before.plate||"");
 if(plateChanged){
  const duplicate=await database.prepare("SELECT id FROM motorcycles WHERE plate=? AND id<>?").bind(x.plate,String(moto!.id)).first();
  if(duplicate)throw new HttpError(409,"Esta placa já pertence a outra moto. Confira a placa; os cadastros não foram unidos.");
  if(normalizePlate(String(moto!.plate||""))!==normalizePlate(before!.plate||"")&&moto!.plate!==x.plate)throw new HttpError(409,"A placa do cadastro já foi alterada para "+moto!.plate+". Confira a moto em Motos e placas antes de salvar.");
 }
 const motoId=String(moto?.id||crypto.randomUUID());const statements:D1PreparedStatement[]=[];
 if(!customer)statements.push(database.prepare("INSERT INTO customers (id,name,search_name,phone,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(customerId,x.customer.name,normalize(x.customer.name),x.customer.phone,x.customer.notes,stamp,stamp));
 if(!moto)statements.push(database.prepare("INSERT INTO motorcycles (id,plate,model,customer_id,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").bind(motoId,x.plate,x.model,customerId,"",stamp,stamp));
 const total=x.items.reduce((n,i)=>n+i.quantity*i.unitCents,0);const service=x.items.map(i=>i.description).join(" · ");
 const name=before?.customer_name||String(customer?.name||x.customer.name);const phone=before?.customer_phone??String(customer?.phone||x.customer.phone);
 if(before){
   // The optimistic lock and audit run inside the same atomic D1 batch.
   const editId=crypto.randomUUID();
   statements.push(database.prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?, 'order',?,'edit',?,?,? WHERE EXISTS (SELECT 1 FROM orders WHERE id=? AND revision=?) AND (?=0 OR EXISTS (SELECT 1 FROM motorcycles WHERE id=? AND plate IS ?))").bind(editId,String(id),JSON.stringify(before),JSON.stringify(x),stamp,id!,x.revision!,plateChanged?1:0,motoId,moto!.plate));
   if(plateChanged&&moto!.plate!==x.plate){
    statements.push(database.prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?,'motorcycle',?,'correct_plate',?,?,? WHERE EXISTS (SELECT 1 FROM audit_events WHERE id=?)").bind(crypto.randomUUID(),motoId,JSON.stringify({plate:moto!.plate}),JSON.stringify({plate:x.plate,orderId:id}),stamp,editId));
    statements.push(database.prepare("UPDATE motorcycles SET plate=?,source_sort=NULL,updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)").bind(x.plate,stamp,motoId,editId));
   }
   statements.push(database.prepare("UPDATE orders SET service_date=?,odometer=?,status=?,service=?,items_json=?,total_cents=?,notes=?,plate=?,customer_name=?,customer_phone=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)").bind(x.date,x.odometer,x.status,service,JSON.stringify(x.items),total,x.notes,plateChanged?x.plate:before.plate,x.customer.name,x.customer.phone,stamp,id!,x.revision!,editId));
 }else{
   statements.push(database.prepare("INSERT INTO orders (request_key,customer_id,motorcycle_id,service_date,odometer,status,service,items_json,total_cents,notes,customer_name,customer_phone,plate,model,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)").bind(x.requestKey,customerId,motoId,x.date,x.odometer,x.status,service,JSON.stringify(x.items),total,x.notes,name,phone,x.plate,String(moto?.model||x.model),stamp,stamp));
   statements.push(database.prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?, 'order',CAST(id AS TEXT),'create',NULL,?,? FROM orders WHERE request_key=?").bind(crypto.randomUUID(),JSON.stringify(x),stamp,x.requestKey));
 }
 try{const result=await database.batch(statements);if(before&&!result[result.length-1].meta.changes)throw new HttpError(409,"A ordem mudou em outra janela. Reabra para conferir.");}
 catch(e){if(!before){const retry=await database.prepare("SELECT * FROM orders WHERE request_key=?").bind(x.requestKey).first<Order>();if(retry)return retry;}throw e;}
 return await database.prepare("SELECT * FROM orders WHERE "+(id?"id=?":"request_key=?")).bind(id||x.requestKey).first<Order>();
}

// Keep directory deletion independent from attendance history. D1 batches make
// the snapshot audit and guarded deletion one atomic operation.
export async function deleteDirectory(raw:unknown,kind:"customers"|"motorcycles",id:string){
 const x=z.object({confirmId:z.string().min(1),updatedAt:z.string().min(1)}).strict().parse(raw);
 if(x.confirmId!==id)throw new HttpError(400,"Confirme o cadastro que deseja excluir.");
 const database=db(),isCustomer=kind==="customers";
 const before=await database.prepare("SELECT * FROM "+kind+" WHERE id=?").bind(id).first<Record<string,any>>();
 if(!before)throw new HttpError(404,"Cadastro não encontrado. Ele pode já ter sido excluído.");
 if(before.updated_at!==x.updatedAt)throw new HttpError(409,"Este cadastro mudou em outra janela. Atualize a lista antes de excluir.");
 const links=isCustomer?"NOT EXISTS(SELECT 1 FROM orders WHERE customer_id=?) AND NOT EXISTS(SELECT 1 FROM motorcycles WHERE customer_id=?)":"NOT EXISTS(SELECT 1 FROM orders WHERE motorcycle_id=?)";
 const linkedValues=isCustomer?[id,id]:[id];
 const safe=await database.prepare("SELECT id FROM "+kind+" WHERE id=? AND "+links).bind(id,...linkedValues).first();
 if(!safe)throw new HttpError(409,isCustomer?"Este cliente possui motos ou ordens vinculadas. Exclua ou transfira as motos e resolva as ordens antes de excluir o cliente.":"Esta moto possui ordens de serviço vinculadas. Resolva essas ordens antes de excluir a moto.");
 const eventId=crypto.randomUUID(),guard="id=? AND updated_at=? AND "+links;
 const result=await database.batch([
 database.prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?,?,?,'delete',?,?,? WHERE EXISTS(SELECT 1 FROM "+kind+" WHERE "+guard+")").bind(eventId,isCustomer?"customer":"motorcycle",id,JSON.stringify(before),JSON.stringify({id,deleted:true}),new Date().toISOString(),id,x.updatedAt,...linkedValues),
 database.prepare("DELETE FROM "+kind+" WHERE "+guard+" AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)").bind(id,x.updatedAt,...linkedValues,eventId)
 ]);
 if(result[1].meta.changes!==1)throw new HttpError(409,"O cadastro ou seus vínculos mudaram. Atualize a lista antes de excluir.");
 return {id,deleted:true};
}

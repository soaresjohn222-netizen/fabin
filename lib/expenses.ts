import {z} from "zod";
import {db,HttpError} from "./server";
import {normalize} from "./domain";
import {expenseSchema,validDate,monthEnd,type Expense} from "./expense-domain";

export function expenseWhere(p:URLSearchParams){
 const clauses=["e.status=?"];const values:(string|number)[]=[p.get("status")==="cancelled"?"cancelled":"active"];
 for(const key of ["from","to"]){const v=p.get(key);if(!v)continue;if(!validDate(v))throw new HttpError(400,"Período inválido.");clauses.push(key==="from"?"e.date_start>=?":"e.date_end<=?");values.push(v);}
 if(p.get("from")&&p.get("to")&&p.get("from")!>p.get("to")!)throw new HttpError(400,"A data inicial deve vir antes da final.");
 const kind=p.get("kind");if(kind&&kind!=="all"){if(!["personal","professional","unclassified"].includes(kind))throw new HttpError(400,"Tipo de gasto inválido.");clauses.push("e.kind=?");values.push(kind);}
 const q=p.get("q")?.trim().slice(0,160);if(q){clauses.push("(e.search_description LIKE ? OR e.notes LIKE ?)");values.push("%"+normalize(q)+"%","%"+q+"%");}
 if(p.get("review")==="1")clauses.push("e.review_issues<>'[]'");
 return {sql:" WHERE "+clauses.join(" AND "),values};
}
const summarySql="SELECT COUNT(*) count,COALESCE(SUM(e.amount_cents),0) total,COALESCE(SUM(CASE WHEN e.kind='personal' THEN e.amount_cents ELSE 0 END),0) personal,COALESCE(SUM(CASE WHEN e.kind='professional' THEN e.amount_cents ELSE 0 END),0) professional,COALESCE(SUM(CASE WHEN e.kind='unclassified' THEN e.amount_cents ELSE 0 END),0) unclassified,COALESCE(SUM(e.amount_cents IS NULL),0) unknown,COALESCE(SUM(e.kind='unclassified'),0) unclassified_count FROM expenses e";
const select="SELECT e.*,b.filename source_filename FROM expenses e LEFT JOIN import_batches b ON b.id=e.import_batch_id";
async function uncertain(p:URLSearchParams){
 if(!p.get("from")&&!p.get("to"))return 0;
 const q=new URLSearchParams(p);q.delete("from");q.delete("to");const w=expenseWhere(q);const from=p.get("from")||"1900-01-01",to=p.get("to")||"9999-12-31";
 const row=await db().prepare("SELECT COUNT(*) count FROM expenses e"+w.sql+" AND e.date_precision='month' AND e.date_start<=? AND e.date_end>=? AND NOT(e.date_start>=? AND e.date_end<=?)").bind(...w.values,to,from,from,to).first<{count:number}>();return row?.count||0;
}
export async function listExpenses(p:URLSearchParams){
 const w=expenseWhere(p),page=Math.max(1,Math.min(100000,Math.floor(Number(p.get("page")))||1));
 const [rows,stats]=await db().batch<Record<string,any>>([db().prepare(select+w.sql+" ORDER BY e.date_start DESC,e.id DESC LIMIT 25 OFFSET ?").bind(...w.values,(page-1)*25),db().prepare(summarySql+w.sql).bind(...w.values)]);
 return {rows:rows.results,total:stats.results[0].count,page,pageSize:25,summary:stats.results[0],uncertainOutsideRange:await uncertain(p)};
}
export async function expenseDashboard(p:URLSearchParams){
 const q=new URLSearchParams();for(const k of ["from","to"])if(p.get(k))q.set(k,p.get(k)!);const w=expenseWhere(q);
 const [stats,monthly,recent]=await db().batch<Record<string,any>>([db().prepare(summarySql+w.sql).bind(...w.values),db().prepare("SELECT substr(e.date_start,1,7) month,COALESCE(SUM(e.amount_cents),0) total,COUNT(*) count FROM expenses e"+w.sql+" GROUP BY month ORDER BY month").bind(...w.values),db().prepare(select+w.sql+" ORDER BY e.date_start DESC,e.id DESC LIMIT 3").bind(...w.values)]);
 return {summary:stats.results[0],monthly:monthly.results,recent:recent.results,uncertainOutsideRange:await uncertain(q)};
}
export async function getExpense(id:number){const e=await db().prepare(select+" WHERE e.id=?").bind(id).first<Expense>();if(!e)throw new HttpError(404,"Gasto não encontrado.");return e;}
export async function saveExpense(raw:unknown,id?:number){
 const x=expenseSchema.parse(raw),stamp=new Date().toISOString();
 if(!id){z.string().uuid().parse(x.requestKey);const previous=await db().prepare("SELECT * FROM expenses WHERE request_key=?").bind(x.requestKey).first<Expense>();if(previous)return previous;}
 const before=id?await getExpense(id):null;
 if(before&&before.revision!==x.revision)throw new HttpError(409,"Este gasto mudou em outra janela. Feche e reabra para conferir.");
 if(before?.status==="cancelled")throw new HttpError(400,"Restaure o gasto antes de editar.");
 if((x.amountCents==null||x.amountCents<=0)&&(!before?.import_batch_id||x.amountCents!==before.amount_cents))throw new HttpError(400,"Informe um valor maior que zero. O valor original não pode ser apagado.");
 const start=x.datePrecision==="month"?x.date+"-01":x.date,end=x.datePrecision==="month"?monthEnd(x.date):x.date;
 const issues=before?JSON.parse(before.review_issues).filter((s:string)=>!(s==="Valor não informado"&&x.amountCents!=null)&&!(s==="Descrição não informada"&&x.description!=="Gasto sem descrição na planilha")):[];
 const statements:D1PreparedStatement[]=[];
 if(before){
  statements.push(db().prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?,'expense',?,'edit',?,?,? WHERE EXISTS(SELECT 1 FROM expenses WHERE id=? AND revision=?)").bind(crypto.randomUUID(),String(id),JSON.stringify(before),JSON.stringify(x),stamp,id!,x.revision!));
  statements.push(db().prepare("UPDATE expenses SET description=?,search_description=?,amount_cents=?,kind=?,date_start=?,date_end=?,date_precision=?,notes=?,review_issues=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(x.description,normalize(x.description),x.amountCents,x.kind,start,end,x.datePrecision,x.notes,JSON.stringify(issues),stamp,id!,x.revision!));
 }else{
  statements.push(db().prepare("INSERT INTO expenses (request_key,description,search_description,amount_cents,kind,date_start,date_end,date_precision,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(x.requestKey,x.description,normalize(x.description),x.amountCents,x.kind,start,end,x.datePrecision,x.notes,stamp,stamp));
  statements.push(db().prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,after_json,created_at) SELECT ?,'expense',CAST(id AS TEXT),'create',?,? FROM expenses WHERE request_key=?").bind(crypto.randomUUID(),JSON.stringify(x),stamp,x.requestKey));
 }
 try{const results=await db().batch(statements);if(before&&!results.at(-1)?.meta.changes)throw new HttpError(409,"Este gasto mudou em outra janela. Feche e reabra para conferir.");}catch(e){if(!before){const duplicate=await db().prepare("SELECT * FROM expenses WHERE request_key=?").bind(x.requestKey).first<Expense>();if(duplicate)return duplicate;}throw e;}
 return id?getExpense(id):await db().prepare("SELECT * FROM expenses WHERE request_key=?").bind(x.requestKey).first<Expense>();
}
export async function setExpenseStatus(id:number,raw:unknown){
 const x=z.object({status:z.enum(["active","cancelled"]),revision:z.number().int().positive()}).parse(raw),before=await getExpense(id),stamp=new Date().toISOString();
 if(before.revision!==x.revision)throw new HttpError(409,"Este gasto mudou. Atualize a lista para conferir.");
 if(before.status===x.status)return before;
 const results=await db().batch([db().prepare("INSERT INTO audit_events (id,entity_type,entity_id,action,before_json,after_json,created_at) SELECT ?,'expense',?, ?,?,?,? WHERE EXISTS(SELECT 1 FROM expenses WHERE id=? AND revision=?)").bind(crypto.randomUUID(),String(id),x.status==="active"?"restore":"cancel",JSON.stringify(before),JSON.stringify(x),stamp,id,x.revision),db().prepare("UPDATE expenses SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(x.status,stamp,id,x.revision)]);
 if(!results[1].meta.changes)throw new HttpError(409,"Este gasto mudou. Atualize a lista para conferir.");return getExpense(id);
}

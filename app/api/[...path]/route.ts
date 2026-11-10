import {prepareHistory,commitHistory,importSummary,reviewDate,reviewPlateFromUpdate} from "@/lib/import-history";
import {getExpense,listExpenses,saveExpense,setExpenseStatus} from "@/lib/expenses";
import {prepareExpenses,commitExpenses,listExpenseImports} from "@/lib/import-expenses";
import { ZodError } from "zod";
import { db,bucket,json,body,readLimited,checkWrite,session,login,logout,config,HttpError } from "@/lib/server";
import { digest } from "@/lib/password";
import { dashboard,listOrders,motorcycleSelect,orderSelect,orderWhere,saveCustomer,saveMotorcycle,saveOrder,correctOrderCustomer,deleteOrder,deleteDirectory } from "@/lib/records";
import { normalize,statusLabels } from "@/lib/domain";
import {startRestore,restoreStatus,stageRestoreRows,stageRestoreFile,commitRestore} from "@/lib/restore";
export const dynamic="force-dynamic";
async function handle(request:Request){
 try{
  const url=new URL(request.url);const path=url.pathname.replace(/^\/api\//,"").split("/");const [resource,id]=path;const write=request.method!=="GET";
  if(write)checkWrite(request);
  if(resource==="auth"&&id==="login"&&request.method==="POST")return await login(request);
  if(resource==="auth"&&id==="me"&&!write){const authenticated=await session(request);return json({authenticated,...(authenticated?{username:(await config()).username}:{})});}
  if(!await session(request))throw new HttpError(401,"Sua sessão terminou. Entre novamente para continuar.");
  if(resource==="restore"){
    if(request.method==="POST"&&!id)return await startRestore(request);
    if(request.method==="GET"&&id&&!path[2])return await restoreStatus(id);
    if(request.method==="POST"&&id&&path[2]==="rows"&&!path[3])return await stageRestoreRows(id,request);
    if(request.method==="POST"&&id&&path[2]==="files"&&path[3]&&!path[4])return await stageRestoreFile(id,path[3],request);
    if(request.method==="POST"&&id&&path[2]==="commit"&&!path[3])return await commitRestore(id);
    throw new HttpError(404,"Operação de restauração não encontrada.");
  }
  if(resource==="auth"&&id==="logout"&&request.method==="POST")return await logout(request);
  if(resource==="dashboard"&&!write)return json(await dashboard(url.searchParams));
  if(resource==="expenses"){
    if(!write&&!id)return json(await listExpenses(url.searchParams));
    if(!write&&id&&/^\d+$/.test(id))return json({expense:await getExpense(Number(id))});
    if(request.method==="POST"&&!id)return json(await saveExpense(await body(request)),201);
    if(request.method==="PUT"&&id&&/^\d+$/.test(id)&&path[2]==="status")return json(await setExpenseStatus(Number(id),await body(request)));
    if(request.method==="PUT"&&id&&/^\d+$/.test(id)&&!path[2])return json(await saveExpense(await body(request),Number(id)));
  }
  if(resource==="expense-imports"&&!write)return json(await listExpenseImports());
  if(resource==="orders"){
    if(request.method==="DELETE"&&id&&/^\d+$/.test(id)&&!path[2])return json(await deleteOrder(await body(request,2000),Number(id)));
    if(request.method==="PUT"&&id&&/^\d+$/.test(id)&&path[2]==="review-customer"&&!path[3])return json(await correctOrderCustomer(await body(request),Number(id)));
    if(request.method==="PUT"&&id&&/^\d+$/.test(id)&&path[2]==="review-plate")return await reviewPlateFromUpdate(Number(id),request);
    if(request.method==="PUT"&&id&&path[2]==="review-date")return await reviewDate(Number(id),request);
    if(request.method==="POST"&&!id)return json(await saveOrder(await body(request)),201);
    if(request.method==="PUT"&&id&&/^\d+$/.test(id))return json(await saveOrder(await body(request),Number(id)));
    if(!write&&id){const row=await db().prepare("SELECT o.*,b.filename source_filename FROM orders o LEFT JOIN import_batches b ON b.id=o.import_batch_id WHERE o.id=?").bind(id).first();if(!row)throw new HttpError(404,"Ordem não encontrada.");const events=await db().prepare("SELECT action,created_at FROM audit_events WHERE entity_type='order' AND entity_id=? ORDER BY created_at DESC").bind(id).all();return json({order:row,events:events.results});}
    if(!write)return json(await listOrders(url.searchParams));
  }
  if(resource==="customers"){
    if(request.method==="DELETE"&&id&&!path[2])return json(await deleteDirectory(await body(request,2000),"customers",id));
    if(request.method==="POST"&&!id||request.method==="PUT"&&id)return json(await saveCustomer(await body(request),id),id?200:201);
    if(!write){const q=url.searchParams.get("q")?.slice(0,160)||"";const page=Math.max(1,Number(url.searchParams.get("page"))||1);const where=id?" WHERE c.id=?":" WHERE (c.search_name LIKE ? OR c.phone LIKE ?)";const values=id?[id]:[`%${normalize(q)}%`,`%${q}%`];const [rows,count]=await db().batch<Record<string,any>>([db().prepare("SELECT c.*, (SELECT COUNT(*) FROM orders WHERE customer_id=c.id) visits,(SELECT COUNT(*) FROM motorcycles WHERE customer_id=c.id) motorcycles FROM customers c"+where+" ORDER BY c.search_name LIMIT 50 OFFSET ?").bind(...values,(page-1)*50),db().prepare("SELECT COUNT(*) total FROM customers c"+where).bind(...values)]);return json({rows:rows.results,total:count.results[0].total,page,pageSize:50});}
  }
  if(resource==="motorcycles"){
    if(request.method==="DELETE"&&id&&!path[2])return json(await deleteDirectory(await body(request,2000),"motorcycles",id));
    if(request.method==="POST"&&!id||request.method==="PUT"&&id)return json(await saveMotorcycle(await body(request),id),id?200:201);
    if(!write){const q=url.searchParams.get("q")?.slice(0,160)||"";const page=Math.max(1,Number(url.searchParams.get("page"))||1);const where=id?" WHERE m.id=?":" WHERE (m.plate LIKE ? OR m.model LIKE ? OR c.search_name LIKE ?)";const values=id?[id]:[`%${q.toUpperCase().replace(/[- ]/g,"")}%`,`%${q}%`,`%${normalize(q)}%`];const [rows,count]=await db().batch<Record<string,any>>([db().prepare(motorcycleSelect+where+" ORDER BY m.plate LIMIT 50 OFFSET ?").bind(...values,(page-1)*50),db().prepare("SELECT COUNT(*) total FROM motorcycles m JOIN customers c ON c.id=m.customer_id"+where).bind(...values)]);return json({rows:rows.results,total:count.results[0].total,page,pageSize:50});}
  }
  if(resource==="imports"){
    if(request.method==="POST"&&id&&path[2]==="expenses"&&path[3]==="prepare")return await prepareExpenses(id,request);
    if(request.method==="POST"&&id&&path[2]==="expenses"&&path[3]==="commit")return await commitExpenses(id,request);
    if(request.method==="POST"&&id&&path[2]==="prepare")return await prepareHistory(id,request);
    if(request.method==="POST"&&id&&path[2]==="commit")return await commitHistory(id,request);
    if(!write&&id&&path[2]==="report")return json(await importSummary(id));
    if(!write&&id){const row=await db().prepare("SELECT * FROM import_batches WHERE id=?").bind(id).first<{object_key:string;filename:string}>();if(!row)throw new HttpError(404,"Arquivo não encontrado.");const file=await bucket().get(row.object_key);if(!file)throw new HttpError(404,"Arquivo indisponível.");return new Response(file.body,{headers:{"Content-Type":"application/octet-stream","Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});}
    if(!write)return json(await importSummary());
    if(request.method==="POST"){
      if(Number(request.headers.get("content-length"))>21*1024*1024)throw new HttpError(413,"O arquivo deve ter até 20 MB.");
      const contentType=request.headers.get("content-type")||"";if(!contentType.startsWith("multipart/form-data;"))throw new HttpError(415,"Selecione o arquivo pelo botão Escolher planilha.");
      const data=await new Response(await readLimited(request,21*1024*1024),{headers:{"Content-Type":contentType}}).formData();const file=data.get("file");if(!(file instanceof File)||!file.size||file.size>20*1024*1024||!/\.(xlsx|xls)$/i.test(file.name))throw new HttpError(400,"Selecione uma planilha .xlsx ou .xls de até 20 MB.");
      const bytes=new Uint8Array(await file.arrayBuffer());const zip=bytes[0]===0x50&&bytes[1]===0x4b;const ole=bytes[0]===0xd0&&bytes[1]===0xcf&&bytes[2]===0x11&&bytes[3]===0xe0;if(!zip&&!ole)throw new HttpError(400,"O conteúdo não corresponde a uma planilha Excel.");
      const hash=digest(bytes);const previous=await db().prepare("SELECT id FROM import_batches WHERE file_hash=?").bind(hash).first();if(previous)throw new HttpError(409,"Esta planilha já foi recebida. Ela aparece na lista abaixo.");
      const key=crypto.randomUUID();const objectKey="originals/"+key;await bucket().put(objectKey,bytes,{httpMetadata:{contentType:"application/octet-stream"}});
      try{await db().prepare("INSERT INTO import_batches (id,filename,file_hash,object_key,status,created_at) VALUES (?,?,?,?,?,?)").bind(key,file.name.slice(0,220),hash,objectKey,"awaiting_review",new Date().toISOString()).run();}catch(e){await bucket().delete(objectKey);throw e;}
      return json({id:key,status:"awaiting_review"},201);
    }
  }
  if(resource==="export"&&!write){
    const w=orderWhere(url.searchParams);const data=await db().prepare(orderSelect+w.sql+" ORDER BY o.service_date,o.id").bind(...w.values).all();
    const cell=(v:unknown)=>{let s=v==null?"":String(v);if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};
    const lines=[["Ordem","Data","Cliente","Telefone","Placa","Moto","Quilometragem","Situação","Serviços","Valor (R$)","Observações","Aba original","Linha original","Precisão da data","Data original","Conferências pendentes"],...data.results.map(r=>[r.id,r.date_precision==="month"?String(r.service_date).slice(0,7):r.service_date,r.customer_name,r.customer_phone,r.plate,r.model,r.odometer,statusLabels[String(r.status)],r.service,r.total_known===0?"":(Number(r.total_cents)/100).toFixed(2).replace(".",","),r.notes,r.source_sheet,r.source_row,r.date_precision,r.date_original,r.review_issues])];
    return new Response("\ufeff"+lines.map(l=>l.map(cell).join(";")).join("\r\n"),{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=historico-oficina.csv","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }
  if(resource==="backup"&&!write){const tables=["customers","motorcycles","orders","audit_events","import_batches","expenses","expense_imports"];const results=await db().batch(tables.map(t=>db().prepare("SELECT * FROM "+t)));return new Response(JSON.stringify({format:"oficina-moto-v3",exportedAt:new Date().toISOString(),...Object.fromEntries(tables.map((t,i)=>[t,results[i].results]))},null,2),{headers:{"Content-Type":"application/json","Content-Disposition":"attachment; filename=backup-oficina.json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});}
  throw new HttpError(404,"Esta função não foi encontrada.");
 }catch(e){
  if(e instanceof ZodError)return json({error:e.issues[0]?.message||"Confira os campos preenchidos."},400);
  if(e instanceof HttpError)return json({error:e.message},e.status);
  console.error("Request failed",e instanceof Error?e.name+": "+e.message:"UnknownError");
  if(e instanceof Error&&e.message.includes("UNIQUE constraint"))return json({error:"Este registro já existe. Atualize a lista para conferir."},409);
  return json({error:"Não foi possível concluir. Seus campos foram mantidos; tente novamente."},503);
 }
}
export const GET=handle;export const POST=handle;export const PUT=handle;export const DELETE=handle;

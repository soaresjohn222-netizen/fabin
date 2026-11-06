import { z } from "zod";
export const normalize = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
export const normalizePlate = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const statusLabels: Record<string,string> = {open:"Aberta",in_progress:"Em serviço",done:"Concluída",cancelled:"Cancelada",historic:"Histórico Excel"};
export const money = (v: number) => new Intl.NumberFormat("pt-BR", {style:"currency",currency:"BRL"}).format(v/100);
export const number = (v: number) => new Intl.NumberFormat("pt-BR").format(v);
export const dateLabel = (v: string) => v ? v.slice(0,10).split("-").reverse().join("/") : "—";
export const recordDate=(o:{service_date:string;date_precision?:string})=>o.date_precision==="month"?o.service_date.slice(0,7).split("-").reverse().join("/")+" · dia a conferir":dateLabel(o.service_date);
export const recordMoney=(o:{total_cents:number;total_known?:number})=>o.total_known===0?"Não informado":money(o.total_cents);
export function today() { return new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }
export function periodRange(period:string,year:string,from:string,to:string) {
  const now=today(); const d=new Date(now+"T12:00:00Z");
  if(period==="day") return {from:now,to:now};
  if(period==="week") { d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7)); const start=d.toISOString().slice(0,10);d.setUTCDate(d.getUTCDate()+6);return {from:start,to:d.toISOString().slice(0,10)}; }
  if(period==="month") { const end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0,12)); return {from:now.slice(0,7)+"-01",to:end.toISOString().slice(0,10)}; }
  if(period==="year") return {from:year+"-01-01",to:year+"-12-31"};
  if(period==="custom") return {from,to};
  return {from:"",to:""};
}
export const customerSchema=z.object({name:z.string().trim().min(2,"Informe o nome completo.").max(160),phone:z.string().trim().max(40).default(""),notes:z.string().trim().max(4000).default("")});
export const orderCustomerSchema=customerSchema.pick({name:true,phone:true}).extend({revision:z.number().int().min(1)}).strict();
export const plateSchema=z.string().transform(normalizePlate).refine(v=>/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(v),"Confira a placa. Exemplo: ABC1D23 ou ABC1234.");
export const motorcycleSchema=z.object({plate:plateSchema,model:z.string().trim().min(2,"Informe a marca e o modelo.").max(160),customerId:z.string().min(1,"Selecione o cliente."),notes:z.string().trim().max(4000).default("")});
const dateSchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+"T12:00:00Z");return !isNaN(+d)&&d.toISOString().slice(0,10)===v&&v>="1900-01-01"&&v<=today();},"Informe uma data válida, até hoje.");
export const itemLabels={labor:"Mão de obra",part:"Produtos e peças",other:"Outros itens"} as const;
export const itemSchema=z.object({kind:z.enum(["labor","part","other"]),description:z.string().trim().min(1,"Descreva cada item.").max(500),quantity:z.number().int().min(1).max(10000),unitCents:z.number().int().min(0).max(100000000)});
export const orderSchema=z.object({requestKey:z.string().uuid(),customerId:z.string().optional(),customer:customerSchema,plate:plateSchema,model:z.string().trim().min(2).max(160),date:dateSchema,odometer:z.number().int().min(0).max(9999999).nullable(),status:z.enum(["open","in_progress","done","cancelled"]),items:z.array(itemSchema).min(1,"Adicione o serviço realizado.").max(40),notes:z.string().trim().max(8000).default(""),revision:z.number().int().optional()}).refine(v=>v.items.reduce((n,x)=>n+x.quantity*x.unitCents,0)<=1000000000,"O valor total excede o limite permitido.");
export type LineItem=z.infer<typeof itemSchema>;
export type Customer={id:string;name:string;phone:string;notes:string;visits?:number;motorcycles?:number};
export type Motorcycle={id:string;plate:string;model:string;customer_id:string;customer_name:string;phone:string;notes:string;last_odometer:number|null;last_date:string|null;last_precision?:string;source_sort?:string;visits?:number};
export type Order={id:number;request_key:string;customer_id:string;motorcycle_id:string;service_date:string;odometer:number|null;status:string;service:string;items_json:string;total_cents:number;notes:string;customer_name:string;customer_phone:string;plate:string;model:string;revision:number;source_sheet?:string;source_row?:number;import_batch_id?:string;created_at:string;updated_at:string;date_precision?:string;date_original?:string;service_date_end?:string;legacy_json?:string;review_issues?:string;total_known?:number;source_filename?:string};

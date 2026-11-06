import {z} from "zod";
import {dateLabel,money,today} from "./domain";

export const expenseKinds={personal:"Pessoal",professional:"Profissional",unclassified:"A classificar"} as const;
export type Expense={id:number;request_key:string;description:string;amount_cents:number|null;kind:keyof typeof expenseKinds;date_start:string;date_end:string;date_precision:"day"|"month";notes:string;status:"active"|"cancelled";revision:number;import_batch_id:string|null;source_sheet:string|null;source_row:number|null;source_mode:string|null;source_raw:string|null;review_issues:string;source_filename?:string;created_at:string;updated_at:string};
export function validDate(s:string){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&s>="1900-01-01"&&!Number.isNaN(Date.parse(s))&&new Date(s+"T12:00:00Z").toISOString().slice(0,10)===s;}
export function validMonth(s:string){return /^\d{4}-(0[1-9]|1[0-2])$/.test(s)&&s>="1900-01";}
export function monthEnd(s:string){return new Date(Date.UTC(Number(s.slice(0,4)),Number(s.slice(5,7)),0)).toISOString().slice(0,10);}
export const expenseSchema=z.object({requestKey:z.string().min(1).max(240),description:z.string().trim().min(2,"Informe o gasto.").max(300),amountCents:z.number().int().min(-1000000000).max(1000000000).nullable(),kind:z.enum(["personal","professional","unclassified"]),datePrecision:z.enum(["day","month"]),date:z.string(),notes:z.string().max(4000).default(""),revision:z.number().int().positive().optional()}).superRefine((x,c)=>{if(!(x.datePrecision==="day"?validDate(x.date):validMonth(x.date)))c.addIssue({code:"custom",path:["date"],message:"Informe uma data válida."});else if(x.date>(x.datePrecision==="day"?today():today().slice(0,7)))c.addIssue({code:"custom",path:["date"],message:"A data do gasto não pode estar no futuro."});});
export function expenseDate(x:Pick<Expense,"date_precision"|"date_start">){return x.date_precision==="month"?x.date_start.slice(5,7)+"/"+x.date_start.slice(0,4)+" · mês informado":dateLabel(x.date_start);}
export function expenseMoney(n:number|null|undefined){return n==null?"Não informado":money(n);}
export function parseExpenseMoney(raw:string){let s=raw.trim().replace(/R\$\s*/g,"").replace(/\s/g,"");if(!s)return null;if(s.includes(","))s=s.replace(/\./g,"").replace(",",".");if(!/^-?\d+(\.\d{1,2})?$/.test(s))throw new Error("Informe o valor no formato 150,00.");return Math.round(Number(s)*100);}

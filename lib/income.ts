import type {LineItem} from "./domain";

export function itemTotals(items:LineItem[]){
 const totals={labor:0,part:0,other:0};
 for(const item of items)totals[item.kind]+=item.quantity*item.unitCents;
 return totals;
}
type IncomeRow={total_cents:number;total_known:number;items_json:string;legacy_json:string|null;import_batch_id:string|null};
export function incomeBreakdown(rows:IncomeRow[]){
 const total={laborCents:0,partsCents:0,otherCents:0,unclassifiedCents:0,differenceCents:0,unclassifiedCount:0,differenceCount:0};
 for(const row of rows){
  if(row.total_known!==1)continue;
  let labor=0,parts=0,other=0,complete=true;
  try{
   if(row.import_batch_id||row.legacy_json){
    const legacy=JSON.parse(row.legacy_json||"null");
    const hasLabor=Number.isSafeInteger(legacy?.laborCents),hasParts=Number.isSafeInteger(legacy?.partsCents);
    labor=hasLabor?legacy.laborCents:0;parts=hasParts?legacy.partsCents:0;complete=hasLabor&&hasParts;
   }else{
    const items=JSON.parse(row.items_json);if(!Array.isArray(items)||!items.length)complete=false;
    else for(const item of items){
     if(!Number.isSafeInteger(item.quantity)||!Number.isSafeInteger(item.unitCents)||!Number.isSafeInteger(item.quantity*item.unitCents)){complete=false;continue;}
     const value=item.quantity*item.unitCents;
     if(item.kind==="labor")labor+=value;else if(item.kind==="part")parts+=value;else if(item.kind==="other")other+=value;else complete=false;
    }
   }
  }catch{complete=false;}
  total.laborCents+=labor;total.partsCents+=parts;total.otherCents+=other;
  const difference=row.total_cents-labor-parts-other;
  // Preserve stated components and the stated total. Never guess that a remainder is an "other" item.
  if(!complete&&difference>=0){total.unclassifiedCents+=difference;total.unclassifiedCount++;}
  else if(difference!==0){total.differenceCents+=difference;total.differenceCount++;}
 }
 return total;
}

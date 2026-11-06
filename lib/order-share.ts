import {itemLabels, money, number, recordDate, recordMoney, statusLabels, type LineItem, type Order} from "./domain";
import {itemTotals} from "./income";

export function whatsappPhone(input:string):string|null {
  const value=input.trim();
  // Never join multiple phone numbers or guess a missing area code.
  if(!/^\+?[\d ()-]+$/.test(value))return null;
  const digits=value.replace(/\D/g, "");
  if(value.startsWith("+")) {
    if(!/^[1-9]\d{7,14}$/.test(digits))return null;
    if(digits.startsWith("55")&&!/^55[1-9]\d[2-9]\d{7,8}$/.test(digits))return null;
    return digits;
  }
  if(/^[1-9]\d[2-9]\d{7,8}$/.test(digits))return "55"+digits;
  return /^55[1-9]\d[2-9]\d{7,8}$/.test(digits)?digits:null;
}
export const orderNumber=(id:number)=>String(id).padStart(4,"0");
export function whatsappLink(phone:string,id:number):string|null {
  const digits=whatsappPhone(phone);
  return digits?`https://wa.me/${digits}?text=${encodeURIComponent(`Olá! Segue a ordem de serviço #${orderNumber(id)} da Fabinho Motors.`)}`:null;
}
type ImageItem={description:string;detail:string;quantity:string;value:string};
export function orderImageData(order:Order,includeNotes=false) {
  const legacy=order.legacy_json?JSON.parse(order.legacy_json):null;
  const items:LineItem[]=JSON.parse(order.items_json);
  const totals=itemTotals(items);
  const rows:ImageItem[]=legacy?legacy.items.map((item:any)=>({
    description:[item.description,item.part].filter(Boolean).join(" · ")||"Descrição não informada",
    detail:"",quantity:String(item.quantity||"—"),
    // The spreadsheet value is the recorded line value, never a unit price.
    value:item.valueCents==null?String(item.value||"Não informado"):money(item.valueCents),
  })):items.map(item=>({description:item.description,detail:`${itemLabels[item.kind]} · ${money(item.unitCents)}/un.`,quantity:number(item.quantity),value:money(item.quantity*item.unitCents)}));
  const summary=legacy?[
    {label:"Mão de obra",value:legacy.laborCents==null?"Não informado":money(legacy.laborCents)},
    {label:"Produtos e peças",value:legacy.partsCents==null?"Não informado":money(legacy.partsCents)},
    {label:"Outros itens",value:"Não discriminado"},
  ]:Object.entries(itemLabels).map(([key,label])=>({label,value:money(totals[key as keyof typeof totals])}));
  const notices:string[]=[];
  if(legacy){
    notices.push("Registro histórico: a planilha não confirma a situação do serviço nem o pagamento.");
    if(order.total_known!==0&&legacy.laborCents!=null&&legacy.partsCents!=null&&legacy.laborCents+legacy.partsCents!==order.total_cents)
      notices.push("O total original difere da soma dos valores discriminados. Valores preservados conforme a ficha.");
  }
  return {id:order.id,customer:order.customer_name||"Não informado",model:order.model||"Não informado",plate:order.plate||"Sem placa",date:recordDate(order),odometer:order.odometer==null?"Não informada":number(order.odometer)+" km",status:statusLabels[order.status]||order.status,rows,summary,total:recordMoney(order),totalLabel:legacy?"Total registrado na ficha":"Total da ordem",notices,notes:includeNotes?order.notes:""};
}

export type TextMeasure=(text:string,size:number,bold:boolean)=>number;
const clean=(s:string)=>String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,"");
const escape=(s:string)=>clean(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!));
export function wrapText(value:string,width:number,size:number,bold:boolean,measure:TextMeasure):string[] {
  const lines:string[]=[];
  for(const paragraph of clean(value).split(/\r?\n/)) {
    let line="";
    for(const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next=line?line+" "+word:word;
      if(measure(next,size,bold)<=width){line=next;continue;}
      if(line){lines.push(line);line="";}
      for(const char of word){
        if(line&&measure(line+char,size,bold)>width){lines.push(line);line="";}
        line+=char;
      }
    }
    lines.push(line);
  }
  return lines;
}
const WIDTH=1080,LEFT=56,RIGHT=1024,CONTENT=968,START=186,LIMIT=1800;
const ink="#172b36",muted="#586976",accent="#bbd74a",rule="#dce4e8";
const rect=(x:number,y:number,w:number,h:number,fill:string)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
const text=(value:string,x:number,y:number,size=28,bold=false,color=ink,anchor="start")=>`<text x="${x}" y="${y}" font-size="${size}" font-weight="${bold?700:400}" fill="${color}" text-anchor="${anchor}">${escape(value)}</text>`;
type Block={height:number;draw:(y:number)=>string;table?:boolean};
export function orderImagePages(order:Order,measure:TextMeasure,includeNotes=false):{svg:string;height:number}[] {
  const data=orderImageData(order,includeNotes),blocks:Block[]=[];
  const gap=(height=20)=>blocks.push({height,draw:()=>""});
  function paragraph(value:string,size=28,color=ink,bold=false){
    for(const line of wrapText(value,CONTENT,size,bold,measure))blocks.push({height:size+12,draw:y=>text(line,LEFT,y+size,size,bold,color)});
  }
  function fields(a:string,av:string,b:string,bv:string){
    blocks.push({height:34,draw:y=>text(a,LEFT,y+22,22,true,muted)+text(b,704,y+22,22,true,muted)});
    const l=wrapText(av,604,30,true,measure),r=wrapText(bv,320,28,false,measure);
    for(let i=0;i<Math.max(l.length,r.length);i++)blocks.push({height:40,draw:y=>text(l[i]||"",LEFT,y+30,30,true)+text(r[i]||"",704,y+29,28)});
    gap(24);
  }
  fields("CLIENTE",data.customer,"DATA DO ATENDIMENTO",data.date);
  fields("MOTO",data.model,"PLACA",data.plate);
  fields("QUILOMETRAGEM",data.odometer,"SITUAÇÃO",data.status);
  const tableHeader=(y:number)=>rect(LEFT,y,CONTENT,48,"#edf2f4")+text("SERVIÇOS E ITENS",LEFT+12,y+32,22,true)+text("QTD.",731,y+32,22,true,"#172b36","end")+text("VALOR",RIGHT-12,y+32,22,true,ink,"end");
  blocks.push({height:60,draw:tableHeader,table:true});
  if(!data.rows.length)paragraph("Descrição não informada na ficha.",26,muted);
  for(const row of data.rows){
    const desc=wrapText(row.description,566,28,true,measure),qty=wrapText(row.quantity,95,26,false,measure),value=wrapText(row.value,240,27,true,measure);
    for(let i=0;i<Math.max(desc.length,qty.length,value.length);i++)blocks.push({height:39,table:true,draw:y=>text(desc[i]||"",LEFT+12,y+29,28,true)+text(qty[i]||"",731,y+28,26,false,ink,"end")+text(value[i]||"",RIGHT-12,y+28,27,true,ink,"end")});
    if(row.detail)for(const line of wrapText(row.detail,CONTENT-24,23,false,measure))blocks.push({height:34,table:true,draw:y=>text(line,LEFT+12,y+24,23,false,muted)});
    blocks.push({height:23,table:true,draw:y=>rect(LEFT,y+12,CONTENT,1,rule)});
  }
  gap(20);
  blocks.push({height:246,draw:y=>{
    let content="";
    data.summary.forEach((line,i)=>{content+=text(line.label,LEFT+16,y+32+i*40,27)+text(line.value,RIGHT-16,y+32+i*40,27,false,ink,"end")});
    content+=rect(LEFT,y+142,CONTENT,90,"#eff5e1");
    content+=text(data.totalLabel,LEFT+20,y+196,29,true);
    content+=text(data.total,RIGHT-20,y+198,36,true,ink,"end");
    return content;
  }});
  if(data.notes){gap(12);paragraph("OBSERVAÇÕES",23,muted,true);paragraph(data.notes,26);gap();}
  for(const notice of data.notices){paragraph(notice,24,muted);gap(10);}
  const pages:{content:string;height:number}[]=[];let y=START,content="";
  for(const block of blocks){
    if(y+block.height>LIMIT){
      pages.push({content,height:y+80});y=START;content="";
      if(block.table){content+=tableHeader(y);y+=60;}
    }
    content+=block.draw(y);y+=block.height;
  }
  pages.push({content,height:Math.max(900,y+80)});
  return pages.map((page,index)=>({height:page.height,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${page.height}" viewBox="0 0 ${WIDTH} ${page.height}" font-family="Arial, sans-serif">${rect(0,0,WIDTH,page.height,"#ffffff")}${rect(0,0,WIDTH,140,ink)}${text("FABINHO MOTORS",LEFT,63,42,true,accent)}${text(`Ordem de serviço #${orderNumber(data.id)}`,LEFT,110,27,false,"#ffffff")}${page.content}${rect(LEFT,page.height-57,CONTENT,1,rule)}${text("Fabinho Motors · Ordem de serviço",LEFT,page.height-25,21,false,muted)}${text(`${index+1} / ${pages.length}`,RIGHT,page.height-25,21,false,muted,"end")}</svg>`}));
}

export async function renderOrderImages(order:Order,includeNotes:boolean,signal:AbortSignal):Promise<File[]> {
  const canvas=document.createElement("canvas"),context=canvas.getContext("2d");
  if(!context)throw new Error("Este navegador não conseguiu preparar a imagem.");
  const pages=orderImagePages(order,(value,size,bold)=>{context.font=`${bold?700:400} ${size}px Arial, sans-serif`;return context.measureText(value).width},includeNotes);
  const files:File[]=[];
  for(let i=0;i<pages.length;i++){
    signal.throwIfAborted();
    const page=pages[i],url=URL.createObjectURL(new Blob([page.svg],{type:"image/svg+xml;charset=utf-8"}));
    try{
      const img=new Image();
      await new Promise<void>((resolve,reject)=>{
        const finish=(error?:Error)=>{clearTimeout(timer);signal.removeEventListener("abort",aborted);img.onload=null;img.onerror=null;error?reject(error):resolve()};
        const aborted=()=>finish(new DOMException("Cancelado","AbortError"));
        const timer=setTimeout(()=>finish(new Error("A imagem demorou para abrir. Tente novamente.")),15000);
        img.onload=()=>finish();img.onerror=()=>finish(new Error("Não foi possível preparar a imagem. Tente novamente."));
        signal.addEventListener("abort",aborted,{once:true});img.src=url;
      });
      signal.throwIfAborted();canvas.width=WIDTH;canvas.height=page.height;context.drawImage(img,0,0);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error("Não foi possível salvar a imagem.")),"image/png"));
      signal.throwIfAborted();
      files.push(new File([blob],`Fabinho-Motors-OS-${orderNumber(order.id)}${pages.length>1?`-${i+1}-de-${pages.length}`:""}.png`,{type:"image/png"}));
    }finally{URL.revokeObjectURL(url);}
  }
  canvas.width=1;canvas.height=1;
  return files;
}

export function canShareImages(files:File[],target:Pick<Navigator,"canShare"|"share">):boolean {
  try{return !!files.length&&typeof target.share==="function"&&typeof target.canShare==="function"&&target.canShare({files});}catch{return false;}
}

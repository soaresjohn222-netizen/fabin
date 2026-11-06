import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
const require=createRequire(import.meta.url),dependencies=createRequire(require.resolve("wrangler/package.json"));
const {build}=dependencies("esbuild");
const temp=await mkdtemp(join(tmpdir(),"fabinho-sharing-"));
try{
  await build({entryPoints:["lib/order-share.ts"],bundle:true,format:"esm",platform:"node",outfile:join(temp,"share.mjs")});
  const {whatsappPhone,whatsappLink,orderImageData,orderImagePages,wrapText,canShareImages,renderOrderImages}=await import(join(temp,"share.mjs"));
  const order={id:42,customer_name:"Cliente de exemplo",customer_phone:"(11) 99999-1234",plate:"ABC1D23",model:"Honda CG 160",odometer:25400,status:"done",service_date:"2026-09-26",date_precision:"day",notes:"Observação reservada",items_json:JSON.stringify([
    {kind:"labor",description:"Revisão e regulagem dos freios",quantity:1,unitCents:18000},
    {kind:"part",description:"Óleo do motor",quantity:2,unitCents:4500},
    {kind:"other",description:"Transporte da moto",quantity:1,unitCents:3000},
  ]),total_cents:30000,total_known:1,source_filename:"PLANILHA-INTERNA.xlsx",review_issues:'["Informação interna"]'};
  const model=orderImageData(order);
  assert.deepEqual(model.summary.map(r=>r.value.replace(/\s/g,"")),["R$180,00","R$90,00","R$30,00"]);
  assert.equal(model.total.replace(/\s/g,""),"R$300,00");
  assert.equal(model.rows[1].value.replace(/\s/g,""),"R$90,00");
  assert.equal(model.notes,"");assert.equal(orderImageData(order,true).notes,order.notes);
  assert.equal(orderImageData({...order,plate:"XYZ9A87",status:"cancelled"}).plate,"XYZ9A87");
  assert.equal(orderImageData({...order,status:"cancelled"}).status,"Cancelada");
  const legacy={...order,status:"historic",odometer:null,date_precision:"month",items_json:"[]",total_known:0,legacy_json:JSON.stringify({items:[{description:"Item original",quantity:"3",valueCents:5000}],laborCents:null,partsCents:5000})};
  const history=orderImageData(legacy);
  assert.equal(history.rows[0].value.replace(/\s/g,""),"R$50,00","An imported line value is not multiplied by quantity");
  assert.equal(history.total,"Não informado");assert.equal(history.summary[0].value,"Não informado");assert.match(history.date,/09\/2026 · dia a conferir/);
  assert.match(history.notices[0],/não confirma/);
  const discrepant=orderImageData({...legacy,total_known:1,legacy_json:JSON.stringify({items:[],laborCents:10000,partsCents:5000})});
  assert.match(discrepant.notices.join(" "),/difere/);assert.equal(discrepant.total.replace(/\s/g,""),"R$300,00");
  for(const [input,expected] of [["(11) 99999-1234","5511999991234"],["(55) 99999-1234","5555999991234"],["+55 (11) 99999-1234","5511999991234"],["5511999991234","5511999991234"],["11 3333-1234","551133331234"],["+351 912 345 678","351912345678"],["",null],["99999-1234",null],["11999991234 / 11999994321",null],["telefone 11999991234",null],["+55 99999-1234",null],["javascript:alert(1)",null]])assert.equal(whatsappPhone(input),expected,input);
  const link=new URL(whatsappLink(order.customer_phone,42));assert.equal(link.origin,"https://wa.me");assert.equal(link.pathname,"/5511999991234");assert.match(link.searchParams.get("text"),/#0042/);assert.equal(whatsappLink("",42),null);
  assert(!link.href.includes(order.plate));assert(!link.href.includes(order.customer_name));
  const measure=(text,size)=>Array.from(text).length*size*.6;
  const pages=orderImagePages(order,measure);assert.equal(pages.length,1);
  assert(!pages[0].svg.includes(order.notes));assert(!pages[0].svg.includes(order.source_filename));assert(!pages[0].svg.includes("Informação interna"));
  const special=orderImagePages({...order,customer_name:'João & Maria <script>alert("x")</script>'},measure)[0].svg;
  assert(special.includes("&amp;"));assert(special.includes("&lt;script&gt;"));assert(!special.includes("<script>"));
  for(const line of wrapText("A".repeat(300)+" revisão\nFinal",200,28,false,measure))assert(measure(line,28)<=200);
  const longOrder={...order,notes:"Observações longas. ".repeat(250),items_json:JSON.stringify(Array.from({length:40},(_,i)=>({kind:"labor",description:`ITEM_${i+1} `+"Descrição extensa com acentuação e informação do serviço. ".repeat(7),quantity:1,unitCents:750}))) };
  const longPages=orderImagePages(longOrder,measure,true);assert(longPages.length>1);assert(longPages.every(p=>p.height<=1880));assert(longPages.at(-1).svg.includes(`${longPages.length} / ${longPages.length}`));
  const combined=longPages.map(p=>p.svg).join("");for(let i=1;i<=40;i++)assert(combined.includes(`ITEM_${i} `));assert.equal((combined.match(/Total da ordem/g)||[]).length,1);
  const fakeFiles=[new File(["PNG"],"order.png",{type:"image/png"})];
  assert(!canShareImages(fakeFiles,{}));assert(!canShareImages(fakeFiles,{share(){},canShare(){throw new Error("denied")}}));
  assert(!canShareImages([],{share(){},canShare:()=>true}));assert(canShareImages(fakeFiles,{share(){},canShare:data=>data.files[0].type==="image/png"}));
  console.log("PASS: amounts, historical fidelity, privacy, plate/status, phone recipients, wrapping, pagination and sharing support.");

  // Optional local image QA uses the runtime's canvas, without changing app dependencies.
  if(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES){
    const primary=createRequire(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+"/runtime.cjs");
    const {createCanvas,Image}=primary("@napi-rs/canvas");
    const nativeFetch=globalThis.fetch;
    globalThis.fetch=(url,...args)=>{assert(String(url).startsWith("blob:"),"No external image uploads or network calls");return nativeFetch(url,...args)};
    globalThis.document={createElement(tag){assert.equal(tag,"canvas");const canvas=createCanvas(1,1);canvas.toBlob=callback=>callback(new Blob([canvas.toBuffer("image/png")],{type:"image/png"}));return canvas}};
    globalThis.Image=class extends Image{set src(url){nativeFetch(url).then(r=>r.arrayBuffer()).then(buffer=>{super.src=Buffer.from(buffer)}).catch(error=>this.onerror?.(error))}};
    const images=await renderOrderImages(order,false,new AbortController().signal);
    assert.equal(images.length,1);assert.equal(images[0].name,"Fabinho-Motors-OS-0042.png");assert.equal(images[0].type,"image/png");
    const bytes=Buffer.from(await images[0].arrayBuffer());assert.equal(bytes.subarray(1,4).toString(),"PNG");assert.equal(bytes.readUInt32BE(16),1080);
    if(process.env.SHARE_IMAGE_QA)await writeFile(process.env.SHARE_IMAGE_QA,bytes);
    const stopped=new AbortController();stopped.abort();await assert.rejects(()=>renderOrderImages(order,false,stopped.signal),{name:"AbortError"});
    console.log("PASS: rendered PNG file, 1080px width, expected filename, cancellation and no external network.");
  }
}finally{await rm(temp,{recursive:true,force:true})}

"use client";
import {useEffect,useState} from "react";
import {Download,MessageCircle,Share2} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Checkbox} from "@/components/ui/checkbox";
import {Dialog,DialogContent,DialogDescription,DialogTitle} from "@/components/ui/dialog";
import type {Order} from "@/lib/domain";
import {canShareImages,orderNumber,renderOrderImages,whatsappLink,whatsappPhone} from "@/lib/order-share";
import {ErrorBox,Loading,useResource} from "./ui";

export default function OrderShare({id,onClose}:{id:number;onClose:()=>void}) {
  // Always fetch the saved order, including any corrected plate, before preparing an image.
  const record=useResource<{order:Order}>("orders/"+id);
  return <Dialog open onOpenChange={open=>{if(!open)onClose()}}><DialogContent className="share-order-dialog"><DialogTitle>Enviar ordem pelo WhatsApp</DialogTitle><DialogDescription>Ordem #{orderNumber(id)} · Confira a imagem antes de compartilhar.</DialogDescription>{record.loading?<Loading/>:record.error?<><ErrorBox message={record.error}/><Button variant="outline" onClick={record.refresh}>Tentar novamente</Button></>:record.data?.order&&<ShareContent key={id} order={record.data.order}/>}</DialogContent></Dialog>;
}
function ShareContent({order}:{order:Order}) {
  const [phone,setPhone]=useState(order.customer_phone||"");
  const [includeNotes,setIncludeNotes]=useState(false);
  const [images,setImages]=useState<{file:File;url:string}[]>([]);
  const [busy,setBusy]=useState(true),[sharing,setSharing]=useState(false),[error,setError]=useState(""),[status,setStatus]=useState("");
  const [retry,setRetry]=useState(0),[nativeFailed,setNativeFailed]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();let urls:string[]=[];
    setBusy(true);setImages([]);setError("");setStatus("");setNativeFailed(false);
    renderOrderImages(order,includeNotes,controller.signal).then(files=>{
      if(controller.signal.aborted)return;
      const prepared=files.map(file=>({file,url:URL.createObjectURL(file)}));urls=prepared.map(v=>v.url);setImages(prepared);setBusy(false);
    }).catch((e:Error)=>{if(!controller.signal.aborted){setError(e.message);setBusy(false)}});
    return ()=>{controller.abort();urls.forEach(url=>URL.revokeObjectURL(url));};
  },[order,includeNotes,retry]);
  const files=images.map(i=>i.file),native=!nativeFailed&&typeof navigator!=="undefined"&&canShareImages(files,navigator);
  const link=whatsappLink(phone,order.id),digits=whatsappPhone(phone);
  async function share(){
    if(busy||sharing||!native)return;
    setSharing(true);setError("");setStatus("");
    try{
      // Files are ready before this click, preserving the browser's user activation.
      await navigator.share({files,title:`Fabinho Motors · Ordem #${orderNumber(order.id)}`});
      setStatus("Confira no WhatsApp se o envio foi concluído.");
    }catch(e:any){
      if(e.name==="AbortError")setStatus("Compartilhamento cancelado. Você pode tentar novamente.");
      else{setNativeFailed(true);setError("Não foi possível abrir o compartilhamento. Baixe a imagem e anexe na conversa abaixo.");}
    }finally{setSharing(false)}
  }
  return <div className="share-order-body">
    <div className="share-recipient"><strong>{order.customer_name}</strong><label htmlFor="share-phone">WhatsApp do cliente<Input id="share-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="(DDD) 99999-9999" maxLength={40} aria-describedby="share-phone-help"/></label><p id="share-phone-help" className="field-help">{digits?`Conversa com +${digits}. Confira o número antes de abrir.`:phone.trim()?"Confira o DDD e o número. Para outro país, use + e o código do país.":"Informe o número com DDD para abrir a conversa do cliente."}</p><small>O número informado aqui vale apenas para este envio.</small></div>
    {order.notes&&<label className="share-notes"><Checkbox checked={includeNotes} disabled={sharing} onCheckedChange={value=>setIncludeNotes(value===true)}/> Incluir as observações da ordem na imagem</label>}
    <ErrorBox message={error}/>
    {busy?<div aria-live="polite"><Loading/><p className="field-help">Preparando a imagem da ordem…</p></div>:images.length>0?<>
      {native&&<div className="share-native"><Button className="whatsapp-button" disabled={sharing} onClick={()=>void share()}><Share2/>{sharing?"Abrindo compartilhamento…":images.length>1?"Compartilhar imagens":"Compartilhar imagem"}</Button><p>Escolha o WhatsApp e selecione a conversa de {order.customer_name}.</p></div>}
      <div className="share-downloads"><strong>{native?"Ou baixe e anexe na conversa":"1. Baixe a imagem da ordem"}</strong>{images.length>1&&<p>A ordem ocupa {images.length} imagens. Baixe e anexe todas, na sequência.</p>}<div>{images.map((img,index)=><a className="share-download" key={img.file.name} href={img.url} download={img.file.name}><Download size={18}/>{images.length===1?"Baixar imagem":`Baixar imagem ${index+1} de ${images.length}`}</a>)}</div></div>
      <div className="share-conversation"><strong>{native?"Abrir a conversa do cliente":"2. Abra a conversa e anexe a imagem"}</strong>{link?<a className="whatsapp-button share-whatsapp-link" href={link} target="_blank" rel="noopener noreferrer"><MessageCircle size={19}/> Abrir WhatsApp do cliente</a>:<Button disabled><MessageCircle/> Informe o WhatsApp acima</Button>}<p>A conversa abre com uma mensagem pronta. Anexe {images.length>1?"as imagens baixadas":"a imagem baixada"} e toque em enviar no WhatsApp.</p></div>
      <div className="share-preview"><h3>Prévia {images.length>1?`· ${images.length} imagens`:"da imagem"}</h3>{images.map((img,index)=><img key={img.url} src={img.url} alt={`Ordem #${orderNumber(order.id)}, imagem ${index+1} de ${images.length}. Cliente: ${order.customer_name}. Confira os itens e valores na ordem.`}/>)}</div>
    </>:<Button variant="outline" onClick={()=>setRetry(v=>v+1)}>Preparar imagem novamente</Button>}
    {status&&<p className="share-status" role="status">{status}</p>}
  </div>;
}

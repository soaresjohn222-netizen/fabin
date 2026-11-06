#!/usr/bin/env python3
"""Authenticated migration client. No credentials in source or output.
Requires OFICINA_IMPORT_ORIGIN, OFICINA_IMPORT_USER, OFICINA_IMPORT_PASSWORD.
OFICINA_PLATFORM_TOKEN is optional for an already-authorized private Sites connection.
Usage: python import-reviewed-history.py ORIGINALS MANIFESTS --check|--import|--verify
"""
import argparse,hashlib,json,os,time,urllib.request,urllib.error,uuid
from pathlib import Path
class Client:
 def __init__(self):
  self.origin=os.environ['OFICINA_IMPORT_ORIGIN'].rstrip('/');self.cookie=''
  self.headers={'Origin':self.origin,'X-Oficina-Request':'1'}
  if os.environ.get('OFICINA_PLATFORM_TOKEN'):self.headers['OAI-Sites-Authorization']='Bearer '+os.environ['OFICINA_PLATFORM_TOKEN']
  self.call('auth/login','POST',{'username':os.environ['OFICINA_IMPORT_USER'],'password':os.environ['OFICINA_IMPORT_PASSWORD']})
 def call(self,path,method='GET',data=None,content_type=None,binary=False):
  raw=data if isinstance(data,bytes) else json.dumps(data,ensure_ascii=False,separators=(',',':')).encode() if data is not None else None
  headers={**self.headers,**({'Cookie':self.cookie} if self.cookie else {})}
  if raw is not None:headers['Content-Type']=content_type or 'application/json'
  for attempt in range(4):
   try:
    with urllib.request.urlopen(urllib.request.Request(self.origin+'/api/'+path,data=raw,headers=headers,method=method),timeout=60) as r:
     for header in r.headers.get_all('Set-Cookie',[]):
      if header.startswith('__Host-oficina='):self.cookie=header.split(';')[0]
     body=r.read();return body if binary else json.loads(body)
   except urllib.error.HTTPError as e:
    detail=e.read().decode(errors='replace')[:350]
    if e.code not in [429,502,503,504] or attempt==3:raise RuntimeError(f'{method} {path}: HTTP {e.code}: {detail}') from None
    time.sleep(min(2**attempt,8))
   except (TimeoutError,urllib.error.URLError):
    if attempt==3:raise RuntimeError(f'{method} {path}: conexão indisponível') from None
    time.sleep(2**attempt)
 def upload(self,file):
  boundary='oficina-'+uuid.uuid4().hex
  # UTF-8 filenames are preserved by the browser-compatible multipart parser.
  raw=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file.name}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n').encode()+file.read_bytes()+f'\r\n--{boundary}--\r\n'.encode()
  return self.call('imports','POST',raw,'multipart/form-data; boundary='+boundary)

def main():
 p=argparse.ArgumentParser();p.add_argument('originals',type=Path);p.add_argument('manifests',type=Path);p.add_argument('--check',action='store_true');p.add_argument('--import',dest='do_import',action='store_true');p.add_argument('--verify',action='store_true');a=p.parse_args()
 c=Client();before=c.call('dashboard');rows=c.call('imports')['rows'];print('Acesso autenticado. Registros atuais:',before['totals'],flush=True)
 if a.check:
  c.call('auth/logout','POST');return
 manifests=[json.loads(f.read_text()) for f in sorted(a.manifests.glob('20*.json'))]
 if a.do_import:
  # Take a private, local checkpoint before writing any new records.
  checkpoint=a.manifests.parent/'before-import.json';checkpoint.write_text(json.dumps(c.call('backup'),ensure_ascii=False));checkpoint.chmod(0o600)
  for m in manifests:
   f=a.originals/m['filename'];assert hashlib.sha256(f.read_bytes()).hexdigest()==m['fileHash']
   matches=[r for r in rows if r['filename']==m['filename']]
   if len(matches)>1:raise RuntimeError('Mais de um arquivo com o mesmo nome; conferir antes de continuar.')
   batch=matches[0] if matches else c.upload(f);id=batch['id']
   prepared=c.call('imports/'+id+'/prepare','POST',m)
   print(m['year'],'conferência guardada:',prepared['report']['records'],'fichas',flush=True)
   offset=batch.get('row_count',0)
   for i in range(1000):
    result=c.call('imports/'+id+'/commit','POST',{'offset':offset})
    if result['status']=='imported':break
    if result['imported']<=offset:raise RuntimeError('Importação sem progresso; conferir estado da planilha.')
    offset=result['imported']
    if offset%100==0:print(m['year'],offset,'de',result['total'],flush=True)
   else:raise RuntimeError('Limite de etapas atingido')
   print(m['year'],'IMPORTADA:',result['imported'],flush=True)
 if a.verify or a.do_import:
  backup=c.call('backup');batches={b['filename']:b for b in backup['import_batches']};orders={(o['import_batch_id'],o['source_sheet'],o['source_row']):o for o in backup['orders'] if o['import_batch_id']};verified=[]
  for m in manifests:
   b=batches[m['filename']];assert b['status']=='imported';assert b['row_count']==len(m['records']);assert b['file_hash']==m['fileHash']
   # Verify the original bytes in durable storage, not only its metadata.
   original=c.call('imports/'+b['id'],binary=True);assert hashlib.sha256(original).hexdigest()==m['fileHash']
   count=0;total=0
   for r in m['records']:
    saved=orders[(b['id'],r['sheet'],r['row'])]
    assert json.loads(saved['source_raw'])==r['raw'];assert json.loads(saved['legacy_json'])['items']==r['items'];assert saved['total_cents']==(r['totalCents'] or 0);assert saved['total_known']==int(r['totalCents'] is not None);assert saved['date_original']==r['dateOriginal'];assert saved['date_precision']==r['datePrecision'];assert saved['odometer']==r['odometer'];assert saved['plate']==r['plate'];assert saved['customer_name']==(r['name'] or 'Cliente não informado');count+=1;total+=saved['total_cents']
   verified.append({'year':m['year'],'records':count,'totalCents':total,'originalSha256':m['fileHash'],'status':'verified'})
   print('VERIFICADO',m['year'],count,'fichas e arquivo original',flush=True)
  result={'verifiedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'years':verified,'totalRecords':sum(r['records'] for r in verified),'totals':c.call('dashboard')['totals']}
  dest=a.manifests.parent/'production-verification.json';dest.write_text(json.dumps(result,ensure_ascii=False,indent=2));dest.chmod(0o600)
  print('Verificação concluída:',result['totalRecords'],'fichas.',flush=True)
 c.call('auth/logout','POST')
if __name__=='__main__':main()

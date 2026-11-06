#!/usr/bin/env python3
"""Protected, resumable expense import. Credentials come only from process environment.
Usage: python scripts/import-expenses.py PRIVATE_MANIFEST_DIRECTORY --check|--import|--verify
Requires the same OFICINA_IMPORT_* variables as import-reviewed-history.py.
"""
import argparse,base64,datetime,http.client,importlib.util,json,os,urllib.error,urllib.parse,urllib.request
from pathlib import Path
spec=importlib.util.spec_from_file_location('history_client',Path(__file__).with_name('import-reviewed-history.py'))
history=importlib.util.module_from_spec(spec);spec.loader.exec_module(history)

def keep_alive():
 """Reuse the ordinary configured HTTPS proxy connection for this one authorized origin."""
 origin=urllib.parse.urlparse(os.environ['OFICINA_IMPORT_ORIGIN']);proxy=urllib.parse.urlparse(os.environ.get('HTTPS_PROXY',os.environ.get('https_proxy','')));state={'conn':None}
 if origin.scheme!='https':raise ValueError('An HTTPS origin is required')
 def open_request(req,timeout=60):
  url=urllib.parse.urlparse(req.full_url)
  if url.scheme!='https' or url.netloc!=origin.netloc:raise ValueError('Unexpected request destination')
  if state['conn'] is None:
   conn=http.client.HTTPSConnection(proxy.hostname if proxy.hostname else origin.hostname,proxy.port if proxy.hostname else 443,timeout=timeout)
   if proxy.hostname:
    headers={}
    if proxy.username:headers['Proxy-Authorization']='Basic '+base64.b64encode((urllib.parse.unquote(proxy.username)+':'+urllib.parse.unquote(proxy.password or '')).encode()).decode()
    conn.set_tunnel(origin.hostname,443,headers=headers)
   state['conn']=conn
  conn=state['conn']
  try:conn.request(req.get_method(),url.path+('?' +url.query if url.query else ''),body=req.data,headers=dict(req.header_items()));response=conn.getresponse()
  except (OSError,http.client.HTTPException) as e:
   conn.close();state['conn']=None;raise urllib.error.URLError(str(e)) from None
  if not 200<=response.status<300:raise urllib.error.HTTPError(req.full_url,response.status,response.reason,response.headers,response)
  return response
 urllib.request.urlopen=open_request
 return state

def main():
 p=argparse.ArgumentParser();p.add_argument('manifests',type=Path);g=p.add_mutually_exclusive_group(required=True);g.add_argument('--check',action='store_true');g.add_argument('--import',dest='do_import',action='store_true');g.add_argument('--verify',action='store_true');a=p.parse_args()
 connection=keep_alive();c=history.Client()
 try:
  if a.check:
   d=c.call('dashboard');print('Acesso autenticado. Cadastros atuais:',d['totals'],flush=True);return
  manifests=[json.loads(f.read_text()) for f in sorted(a.manifests.glob('20*.json'))]
  before=c.call('backup');batches={b['filename']:b for b in before['import_batches']}
  checkpoint=a.manifests/'before-expense-import.json'
  if a.do_import:
   if not checkpoint.exists():checkpoint.write_text(json.dumps(before,ensure_ascii=False));checkpoint.chmod(0o600)
   for m in manifests:
    b=batches[m['filename']];assert b['file_hash']==m['fileHash'],'Original hash mismatch';id=b['id']
    prep=c.call(f'imports/{id}/expenses/prepare','POST',m)
    if prep.get('status')!='imported':
     offset=0
     for _ in range(len(m['expenses'])//30+2):
      done=c.call(f'imports/{id}/expenses/commit','POST',{'offset':offset})
      if done['status']=='imported':break
      if done['nextOffset']<=offset:raise RuntimeError('Importação sem progresso')
      offset=done['nextOffset']
     else:raise RuntimeError('A importação não foi concluída')
    print('IMPORTADO',m['year'],len(m['expenses']),'gastos',flush=True)
  saved=c.call('backup');rows={(e['import_batch_id'],e['source_sheet'],e['source_row']):e for e in saved['expenses'] if e['import_batch_id']};metadata={e['batch_id']:e for e in saved['expense_imports']};verified=[]
  for m in manifests:
   id=batches[m['filename']]['id'];assert metadata[id]['status']=='imported';assert metadata[id]['row_count']==len(m['expenses']);assert sum(e['import_batch_id']==id for e in saved['expenses'])==len(m['expenses'])
   for e in m['expenses']:
    row=rows[(id,e['sheet'],e['row'])];original={'period':e['period'],'description':e['description'],'amountCents':e['amountCents'],'kind':e['kind'],'sourceMode':e['sourceMode'],'cells':e['sourceRaw']}
    assert json.loads(row['source_raw'])==original
    if row['revision']==1:
     assert row['amount_cents']==e['amountCents'];assert row['kind']==e['kind'];assert row['description']==(e['description'] or 'Gasto sem descrição na planilha');assert row['date_precision']=='month';assert row['date_start']==e['period']+'-01';assert row['source_mode']==e['sourceMode']
   verified.append({'year':m['year'],'count':len(m['expenses']),'originalTotalCents':sum(e['amountCents'] or 0 for e in m['expenses']),'unknownAmounts':sum(e['amountCents'] is None for e in m['expenses'])})
  for table in ['customers','motorcycles','orders','import_batches']:
   current={r['id']:r for r in saved[table]}
   for row in before[table]:assert current[row['id']]==row,f'Existing {table} row changed during this run; review concurrent activity'
  active=[e for e in saved['expenses'] if e['status']=='active'];d=c.call('dashboard');s=d['expenses']['summary'];assert s['count']==len(active);assert s['total']==sum(e['amount_cents'] or 0 for e in active);assert s['unknown']==sum(e['amount_cents'] is None for e in active)
  for kind in ['personal','professional','unclassified']:assert s[kind]==sum(e['amount_cents'] or 0 for e in active if e['kind']==kind)
  for m in manifests:
   yr=str(m['year']);r=c.call('expenses?'+urllib.parse.urlencode({'from':yr+'-01-01','to':yr+'-12-31'}));expected=[e for e in active if e['date_start']>=yr+'-01-01' and e['date_end']<=yr+'-12-31'];assert r['summary']['total']==sum(e['amount_cents'] or 0 for e in expected);assert r['total']==len(expected)
  result={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'years':verified,'totalImported':sum(x['count'] for x in verified),'originalTotalCents':sum(x['originalTotalCents'] for x in verified),'unknownAmounts':sum(x['unknownAmounts'] for x in verified),'dashboard':s,'existingRecordsPreserved':True,'oldRecordCounts':{t:len(before[t]) for t in ['customers','motorcycles','orders']}}
  dest=a.manifests/'production-expenses-verification.json';dest.write_text(json.dumps(result,ensure_ascii=False,indent=2));dest.chmod(0o600);print('VERIFICADO',json.dumps(result,ensure_ascii=False),flush=True)
 finally:
  try:c.call('auth/logout','POST')
  finally:
   if connection['conn']:connection['conn'].close()
if __name__=='__main__':main()

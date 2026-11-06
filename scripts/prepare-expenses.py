#!/usr/bin/env python3
"""Extract expense columns Q/S without changing source workbooks. Output stays private."""
import argparse,collections,hashlib,importlib.util,json,re
from pathlib import Path
spec=importlib.util.spec_from_file_location('history',Path(__file__).with_name('prepare-history.py'))
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)

def prepare(book,folder):
 expenses=[];sheets=[]
 for sheet in book['sheets']:
  name=sheet['name']
  if name not in h.MONTHS:continue
  period=f"{book['year']}-{h.MONTHS.index(name)+1:02}"
  cells=sheet['cells'];rows=sorted({int(a[1:]) for a in cells if re.fullmatch('[QS][0-9]+',a)})
  entries=[]
  for row in rows:
   q=cells.get(f'Q{row}',{}).get('v');s=cells.get(f'S{row}',{}).get('v')
   if h.norm(q)=='despesa' or h.norm(s)=='valor' or not h.text(q) and not h.text(s):continue
   desc=h.text(q) or None;amount=h.money(s);label=h.norm(q)
   kind='personal' if label in ['luz casa','agua casa','boletos casa','internet casa'] else 'professional' if label in ['luz oficina','agua oficina','aluguel oficina','mei'] else 'unclassified'
   issues=[]
   if amount is None:issues.append('Valor não informado')
   if not desc:issues.append('Descrição não informada')
   entries.append({'sheet':name,'row':row,'period':period,'description':desc,'amountCents':amount,'kind':kind,'sourceMode':'item','sourceRaw':{a:cells[a] for a in [f'Q{row}',f'S{row}'] if a in cells},'issues':issues})
  if len(entries)==1 and h.norm(entries[0]['description'])=='total':entries[0]['sourceMode']='monthly_total';entries[0]['issues'].append('Somente total mensal informado')
  total=sum(e['amountCents'] or 0 for e in entries);unknown=sum(e['amountCents'] is None for e in entries)
  source_cell=next((f'W{a[1:]}' for a,v in cells.items() if re.fullmatch('U[0-9]+',a) and h.norm(v.get('v'))=='despesas total'),None)
  source_raw=cells.get(source_cell) if source_cell else None;source_total=h.money(source_raw.get('v')) if source_raw else None
  sheets.append({'name':name,'period':period,'count':len(entries),'totalCents':total,'unknownAmounts':unknown,'sourceTotalCell':source_cell,'sourceTotalCents':source_total,'sourceTotalRaw':source_raw,'agrees':source_total==total if source_total is not None and not unknown else None})
  expenses+=entries
 return {'version':'oficina-expenses-v1','filename':book['filename'],'fileHash':hashlib.sha256((folder/book['filename']).read_bytes()).hexdigest(),'year':book['year'],'expenses':expenses,'sheets':sheets}

def main():
 p=argparse.ArgumentParser();p.add_argument('originals',type=Path);p.add_argument('output',type=Path);p.add_argument('--cache',type=Path);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
 books=json.loads(a.cache.read_text()) if a.cache and a.cache.is_file() else h.read_workbooks(a.originals)
 summary=[]
 for book in sorted(books,key=lambda b:b['year']):
  m=prepare(book,a.originals);(a.output/f"{m['year']}.json").write_text(json.dumps(m,ensure_ascii=False,indent=2))
  row={'year':m['year'],'count':len(m['expenses']),'totalCents':sum(e['amountCents'] or 0 for e in m['expenses']),'unknownAmounts':sum(e['amountCents'] is None for e in m['expenses']),'kinds':dict(collections.Counter(e['kind'] for e in m['expenses'])),'monthlyTotals':sum(e['sourceMode']=='monthly_total' for e in m['expenses'])};summary.append(row);print(json.dumps(row),flush=True)
 (a.output/'reconciliation.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
if __name__=='__main__':main()

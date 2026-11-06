#!/usr/bin/env python3
"""Apply and verify a reviewed incremental manifest. All credentials come from the process environment.

Usage: python import-history-update.py PRIVATE_UPDATE_DIRECTORY ORIGINALS_DIRECTORY
Requires history-incremental.json, history-full.json and a private before.json checkpoint.
"""
import argparse,calendar,hashlib,importlib.util,json
from pathlib import Path

spec=importlib.util.spec_from_file_location('expense_client',Path(__file__).with_name('import-expenses.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('directory',type=Path);parser.add_argument('originals',type=Path);args=parser.parse_args()
    manifest=json.loads((args.directory/'history-incremental.json').read_text())
    full=json.loads((args.directory/'history-full.json').read_text())
    before=json.loads((args.directory/'before.json').read_text())
    assert Path(manifest['filename']).name==manifest['filename']
    original=args.originals/manifest['filename']
    assert hashlib.sha256(original.read_bytes()).hexdigest()==manifest['fileHash']==full['fileHash']
    connection=module.keep_alive();client=module.history.Client()
    try:
        current=client.call('backup');matches=[b for b in current['import_batches'] if b['file_hash']==manifest['fileHash']]
        # Refuse a fresh import if workshop records changed after the reviewed checkpoint.
        if not matches:
            for table in ['orders','expenses','customers','motorcycles','import_batches']:
                assert {r['id']:r for r in current[table]}=={r['id']:r for r in before[table]},'Records changed after review: '+table
        batch=matches[0] if matches else client.upload(original);batch_id=batch['id']
        assert len(matches)<=1
        client.call('imports/'+batch_id+'/prepare','POST',manifest)
        offset=0
        for _ in range(len(manifest['records'])//10+3):
            result=client.call('imports/'+batch_id+'/commit','POST',{'offset':offset})
            if result['status']=='imported':break
            assert result['imported']>offset,'No import progress';offset=result['imported']
        else:raise RuntimeError('Import did not finish')
        for review in manifest.get('sourceReviews',[]):
            old=next(r for r in before['orders'] if r['id']==review['orderId'])
            client.call('orders/'+str(old['id'])+'/review-plate','PUT',{'sourceBatchId':batch_id,'revision':old['revision']})
        saved=client.call('backup')
        imported={(r['source_sheet'],r['source_row']):r for r in saved['orders'] if r['import_batch_id']==batch_id}
        assert len(imported)==len(manifest['records'])
        assert len(saved['orders'])==len(before['orders'])+len(imported)
        for record in manifest['records']:
            row=imported[(record['sheet'],record['row'])]
            assert json.loads(row['source_raw'])==record['raw']
            assert json.loads(row['legacy_json'])['items']==record['items']
            assert row['total_cents']==(record['totalCents'] or 0) and row['total_known']==int(record['totalCents'] is not None)
            for target,source in [('date_original','dateOriginal'),('service_date','date'),('service_date_end','dateEnd'),('date_precision','datePrecision'),('odometer','odometer'),('plate','plate'),('service','service'),('notes','notes')]:assert row[target]==record[source]
            assert row['customer_name']==(record['name'] or 'Cliente não informado')
        reviews={r['orderId']:r for r in manifest.get('sourceReviews',[])};orders={r['id']:r for r in saved['orders']}
        for old in before['orders']:
            row=orders[old['id']]
            if old['id'] not in reviews:assert row==old;continue
            for key in old:
                if key not in ['plate','legacy_json','revision','updated_at']:assert row[key]==old[key]
            assert row['plate']==reviews[old['id']]['record']['plate'] and row['revision']==old['revision']+1
            legacy=json.loads(row['legacy_json']);corrections=legacy.pop('sourceCorrections')
            assert legacy==json.loads(old['legacy_json'])
            assert any(c['batchId']==batch_id and c['field']=='plate' for c in corrections)
        for table in ['expenses','customers','import_batches']:
            rows={r['id']:r for r in saved[table]}
            for old in before[table]:assert rows[old['id']]==old,'Existing row changed: '+table
        assert len(saved['expenses'])==len(before['expenses'])
        assert hashlib.sha256(client.call('imports/'+batch_id,binary=True)).hexdigest()==manifest['fileHash']
        months=[]
        for sheet in manifest['sheets']:
            period=sheet['period'];rows=[r for r in full['records'] if r['sheet']==sheet['name']]
            end=period+'-'+str(calendar.monthrange(int(period[:4]),int(period[5:]))[1])
            dashboard=client.call('dashboard?from='+period+'-01&to='+end)
            expenses=[r for r in before['expenses'] if r['status']=='active' and r['date_start']>=period+'-01' and r['date_end']<=end]
            assert dashboard['stats']['orders']==len(rows)
            assert dashboard['financial']['incomeCents']==sum(r['totalCents'] or 0 for r in rows)
            assert dashboard['financial']['outgoingCents']==sum(r['amount_cents'] or 0 for r in expenses)
            months.append({'period':period,'orders':len(rows),'incomeCents':dashboard['financial']['incomeCents'],'outgoingCents':dashboard['financial']['outgoingCents']})
        report={'status':'verified','newOrders':len(imported),'plateCorrections':len(reviews),'totalOrders':len(saved['orders']),'totalExpenses':len(saved['expenses']),'months':months}
        path=args.directory/'after.json';path.write_text(json.dumps(saved,ensure_ascii=False));path.chmod(0o600)
        path=args.directory/'result.json';path.write_text(json.dumps(report,ensure_ascii=False,indent=2));path.chmod(0o600)
        print(json.dumps(report,ensure_ascii=False),flush=True)
    finally:
        client.call('auth/logout','POST')
        if connection['conn']:connection['conn'].close()

if __name__=='__main__':main()

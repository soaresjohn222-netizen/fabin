#!/usr/bin/env python3
"""Restore a verified business-data snapshot into an empty installation.

Source JSON, original files and checkpoints stay in the supplied private directory.
Credentials are read interactively and never written to disk or printed.
"""
import argparse
import concurrent.futures
import datetime
import getpass
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

TABLES = ['import_batches', 'customers', 'motorcycles', 'orders', 'expenses', 'expense_imports', 'audit_events']


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def primary(table, row):
    return str(row['batch_id' if table == 'expense_imports' else 'id'])


def manifest(backup, raw):
    summaries = {}
    for table in TABLES:
        rows = sorted((primary(table, row), sha(encoded(row).encode())) for row in backup[table])
        if len({key for key, _ in rows}) != len(rows):
            raise ValueError('Duplicate source keys: ' + table)
        summaries[table] = {'count': len(rows), 'hash': sha('\n'.join(key + ':' + value for key, value in rows).encode())}
    return {'format': 'oficina-restore-v1', 'sourceHash': sha(raw), 'tables': summaries}


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--import', dest='do_import', action='store_true')
    args = parser.parse_args()
    origin = args.base_url.rstrip('/')
    parsed = urllib.parse.urlsplit(origin)
    if parsed.scheme != 'https' or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError('Use the exact HTTPS application origin.')
    raw = (args.directory / 'source-backup.json').read_bytes()
    backup = json.loads(raw)
    if backup.get('format') != 'oficina-moto-v3':
        raise ValueError('Unsupported snapshot format.')
    plan = manifest(backup, raw)
    for batch in backup['import_batches']:
        if '/' in batch['id'] or '..' in batch['id']:
            raise ValueError('Invalid file identifier.')
        if sha((args.directory / 'originals' / (batch['id'] + '.bin')).read_bytes()) != batch['file_hash']:
            raise ValueError('Original-file checksum mismatch.')
    if not args.do_import:
        print(json.dumps({'sourceHash': plan['sourceHash'], 'counts': {table: len(backup[table]) for table in TABLES}}))
        return

    username = os.environ.get('OFICINA_IMPORT_USERNAME', 'oficina')
    password = getpass.getpass('Password for destination import (hidden): ')
    cookie = ''

    def call(path, method='GET', data=None, binary=False, raw_response=False):
        headers = {'User-Agent': 'OficinaMigration/1.0', 'Origin': origin, 'X-Oficina-Request': '1'}
        if cookie:
            headers['Cookie'] = cookie
        body = None
        if data is not None:
            headers['Content-Type'] = 'application/octet-stream' if binary else 'application/json'
            body = data if binary else json.dumps(data, ensure_ascii=False).encode()
        for attempt in range(5):
            req = urllib.request.Request(origin + '/api/' + path, data=body, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=120) as response:
                    content = response.read(100 * 1024 * 1024)
                    return (content if raw_response else json.loads(content)), response.headers
            except urllib.error.HTTPError as error:
                if error.code in (429, 502, 503, 504) and attempt < 4:
                    time.sleep(1 + attempt)
                    continue
                raise RuntimeError('Migration request failed: HTTP ' + str(error.code) + ' at ' + path) from None
            except (TimeoutError, urllib.error.URLError) as error:
                if attempt == 4:
                    raise RuntimeError('Migration connection failed (' + type(error).__name__ + ') at ' + path) from None
                time.sleep(1 + attempt)

    try:
        authenticated, headers = call('auth/login', 'POST', {'username': username, 'password': password})
        password = None
        if not authenticated.get('authenticated'):
            raise RuntimeError('Destination authentication failed.')
        cookie = headers.get('Set-Cookie', '').split(';')[0]
        current, _ = call('backup')
        checkpoint = args.directory / 'target-immediately-before.json'
        if not checkpoint.exists():
            save(checkpoint, current)
        job, _ = call('restore', 'POST', plan)
        ident = job['id']
        save(args.directory / 'restore-job.json', {'id': ident, 'origin': origin, 'sourceHash': plan['sourceHash']})
        if job['status'] != 'complete':
            if any(current[table] for table in TABLES):
                raise RuntimeError('The destination contains records; no existing data will be replaced.')
            status, _ = call('restore/' + ident)
            prepared = {item['table_name']: item['count'] for item in status['counts']}
            for table in TABLES:
                rows = [encoded(row) for row in backup[table]]
                if prepared.get(table, 0) == len(rows):
                    print('Already prepared', table, len(rows), flush=True)
                    continue
                batches = [rows[offset:offset + 40] for offset in range(0, len(rows), 40)]
                def stage(batch):
                    call('restore/' + ident + '/rows', 'POST', {'table': table, 'rows': batch})
                    return len(batch)
                with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                    pending = [pool.submit(stage, batch) for batch in batches]
                    sent = 0
                    for index, future in enumerate(concurrent.futures.as_completed(pending), 1):
                        sent += future.result()
                        if index % 10 == 0:
                            print('Transferring', table, str(sent) + '/' + str(len(rows)), flush=True)
                print('Prepared', table, len(rows), flush=True)
            def upload(batch):
                contents = (args.directory / 'originals' / (batch['id'] + '.bin')).read_bytes()
                call('restore/' + ident + '/files/' + batch['id'], 'POST', contents, binary=True)
            with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                list(pool.map(upload, backup['import_batches']))
            print('Original files verified:', len(backup['import_batches']), flush=True)
            completed, _ = call('restore/' + ident + '/commit', 'POST')
            if completed.get('status') != 'complete':
                raise RuntimeError('Restore did not complete.')
        restored, _ = call('backup')
        for table in TABLES:
            expected = {primary(table, row): row for row in backup[table]}
            actual = {primary(table, row): row for row in restored[table]}
            if expected != actual:
                raise RuntimeError('Post-import field verification failed: ' + table)
        def verify_file(batch):
            content, _ = call('imports/' + batch['id'], raw_response=True)
            if sha(content) != batch['file_hash']:
                raise RuntimeError('Post-import original file verification failed.')
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(verify_file, backup['import_batches']))
        report = {'completedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'jobId': ident, 'sourceHash': plan['sourceHash'], 'destination': origin, 'counts': {table: len(restored[table]) for table in TABLES}, 'everyFieldMatches': True, 'originalFilesVerified': len(backup['import_batches'])}
        save(args.directory / 'verification.json', report)
        print(json.dumps(report, ensure_ascii=False), flush=True)
    finally:
        if cookie:
            call('auth/logout', 'POST')


if __name__ == '__main__':
    main()

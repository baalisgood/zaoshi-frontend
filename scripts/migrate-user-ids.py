#!/usr/bin/env python3
"""Offline, stopped-writer user-key migration. Defaults to a read-only dry run.
Apply only to an explicit isolated copy in this iteration. Never copies a backup over a live DB.
"""
import argparse
import hashlib
import json
import re
import sqlite3
import secrets
import string
from pathlib import Path

OWNERS = set('prompt_optimization_requests assets generation_jobs generation_job_items user_generation_limits generation_quota_admissions credit_ledger_entries recharge_orders recharge_orders_v2 text_moderation_evidence generation_moderation_rejections studio_templates gallery_items'.split())
USERS = set('auth_identities auth_sessions auth_email_credentials user_legal_acceptances'.split())
ACTORS = set('credit_ledger_entries admin_audit_events asset_maintenance_events asset_deletion_events gallery_audit_events generation_reconciliation_events generation_queue_admin_actions recharge_reconciliation_events'.split())
DROP = set('prompt_optimization_update_guard credit_ledger_no_update admin_audit_no_update asset_maintenance_events_no_update asset_moderation_events_no_update asset_deletion_events_no_update gallery_audit_events_no_update recharge_orders_mutation_guard recharge_orders_v2_mutation_guard recharge_reconciliation_no_update generation_moderation_rejection_no_update generation_reconciliation_events_no_update generation_queue_admin_actions_no_update'.split())

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), default=lambda x: {'blob': bytes(x).hex()}).encode()).hexdigest()

def schema(db):
    return db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").fetchall()

def references(db):
    refs = {}
    for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        cols = {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}
        allowed = set()
        if table == 'users': allowed.add('id')
        if table in OWNERS: allowed.add('owner_id')
        if table in USERS: allowed.add('user_id')
        if table in ACTORS: allowed.add('actor_id')
        if table == 'asset_moderation_events': allowed.add('reviewer_id')
        if table == 'gallery_items': allowed.add('reviewer_owner_id')
        if table == 'admin_audit_events': allowed.add('target_id')
        actual = {c for c in cols if c in ('owner_id','user_id','actor_id','reviewer_id','reviewer_owner_id','target_id')}
        if table == 'users': actual.add('id')
        if actual - allowed: raise ValueError(f'Unknown identity references: {table}: {actual - allowed}')
        for fk in db.execute(f'PRAGMA foreign_key_list("{table}")'):
            if fk[2] == 'users' and fk[3] not in allowed: raise ValueError(f'Unknown user FK: {table}.{fk[3]}')
        refs[table] = sorted(actual)
    return refs

def rows(db, refs, inverse=None):
    result = {}
    for table, columns in refs.items():
        cursor = db.execute(f'SELECT * FROM "{table}"')
        names = [c[0] for c in cursor.description]
        records = []
        for row in cursor:
            values = list(row)
            if inverse:
                for col in columns:
                    pos = names.index(col)
                    values[pos] = inverse.get(values[pos], values[pos])
            records.append(values)
        result[table] = digest(sorted(records, key=lambda x: json.dumps(x, default=str)))
    return result

def migrate(path, plan, apply=False, fail_stage=0, reverse=False):
    if path.is_symlink(): raise ValueError('Symlink database rejected')
    if Path(str(path)+'-wal').exists() and Path(str(path)+'-wal').stat().st_size: raise ValueError('Checkpoint WAL after stopping every writer before snapshot')
    mapping = plan['mapping']
    if not plan.get('actionId') or not mapping or len(set(mapping.values())) != len(mapping): raise ValueError('Require actionId and complete bijection')
    if not all(re.fullmatch(r'[A-Z0-9]{8}', v) and re.search('[A-Z]', v) and re.search('[0-9]', v) for v in mapping.values()): raise ValueError('Invalid target ID')
    if mapping.get('user_web_private_test', 'TEST0001') != 'TEST0001' or any(v == 'TEST0001' and k not in ('user_web_private_test','TEST0001') for k,v in mapping.items()): raise ValueError('Reserved test ID')
    if reverse: mapping = {v:k for k,v in mapping.items()}
    db = sqlite3.connect(f'file:{path}?mode={"rw" if apply else "ro"}', uri=True)
    try:
        db.execute('PRAGMA foreign_keys=ON')
        if apply: db.execute('BEGIN IMMEDIATE')
        current_sha = hashlib.sha256(path.read_bytes()).hexdigest()
        refs = references(db)
        before_schema = schema(db)
        schema_sha = digest(before_schema)
        ids = {r[0] for r in db.execute('SELECT id FROM users')}
        receipt = db.execute('SELECT mapping_sha256 FROM user_id_migration_receipts WHERE action_id=?', (plan['actionId'],)).fetchone()
        if receipt and receipt[0] != digest(plan['mapping']): raise ValueError('Action ID mapping conflict')
        if schema_sha != plan['schemaSha256']: raise ValueError('Schema fingerprint mismatch')
        if db.execute('PRAGMA foreign_key_check').fetchall() or db.execute('PRAGMA integrity_check').fetchone() != ('ok',): raise ValueError('Database integrity failed')
        if ids == set(mapping.values()) and not reverse:
            for table, columns in refs.items():
                for col in columns:
                    for old, new in mapping.items():
                        if old != new and db.execute(f'SELECT 1 FROM "{table}" WHERE "{col}"=? LIMIT 1', (old,)).fetchone():
                            raise ValueError(f'Residual old identity reference: {table}.{col}')
            # Exact namespace correspondence proves the mapping really was applied.
            original = plan['mapping']
            if receipt and all(db.execute('SELECT identity_namespace FROM users WHERE id=?', (new,)).fetchone() == (old,) for old,new in original.items()):
                return {'result':'already_applied', 'mappingSha':digest(plan['mapping']), 'schemaSha':schema_sha}
            raise ValueError('IDs match but namespace proof failed')
        if ids != set(mapping): raise ValueError('Mapping must cover exactly every current account')
        if current_sha != plan['snapshotSha256'] or schema_sha != plan['schemaSha256']: raise ValueError('Snapshot/schema fingerprint mismatch')
        if db.execute('PRAGMA foreign_key_check').fetchall() or db.execute('PRAGMA integrity_check').fetchone() != ('ok',): raise ValueError('Database integrity failed')
        before = rows(db, refs)
        if not apply: return {'result':'dry_run', 'mappingSha':digest(plan['mapping']), 'schemaSha':schema_sha, 'tables':before}
        db.execute('PRAGMA defer_foreign_keys=ON')
        triggers = [(r[1],r[3],r[2]) for r in before_schema if r[0]=='trigger' and r[1] in DROP]
        for name,sql,table in triggers: db.execute(f'DROP TRIGGER "{name}"')
        if reverse: db.execute('DROP TRIGGER users_id_format_update')
        if fail_stage == 1: raise RuntimeError('injected stage 1')
        for table, cols in refs.items():
            for col in cols:
                for old,new in mapping.items(): db.execute(f'UPDATE "{table}" SET "{col}"=? WHERE "{col}"=?', (new,old))
        if fail_stage == 2: raise RuntimeError('injected stage 2')
        for name,sql,table in triggers: db.execute(sql)
        if reverse:
            db.execute(next(r[3] for r in before_schema if r[1]=='users_id_format_update'))
        if schema(db) != before_schema or rows(db, refs, {v:k for k,v in mapping.items()}) != before: raise ValueError('Unexpected row/schema change')
        if db.execute('PRAGMA foreign_key_check').fetchall() or db.execute('PRAGMA integrity_check').fetchone() != ('ok',): raise ValueError('Post migration integrity failed')
        if fail_stage == 3: raise RuntimeError('injected stage 3')
        # Each restored immutable trigger must still reject a real row mutation.
        for name,sql,table in triggers:
            col = refs[table][0] if refs[table] else None
            if col and db.execute(f'SELECT 1 FROM "{table}" LIMIT 1').fetchone():
                db.execute('SAVEPOINT trigger_probe')
                try:
                    db.execute(f'UPDATE "{table}" SET "{col}"="{col}" || \'_probe\'')
                except sqlite3.IntegrityError:
                    pass
                else: raise ValueError(f'Restored trigger did not reject mutation: {name}')
                finally:
                    db.execute('ROLLBACK TO trigger_probe'); db.execute('RELEASE trigger_probe')
        if fail_stage == 4: raise RuntimeError('injected stage 4')
        if not reverse:
            db.execute('INSERT INTO user_id_migration_receipts(action_id,mapping_sha256,snapshot_sha256) VALUES(?,?,?) ON CONFLICT(action_id) DO NOTHING', (plan['actionId'],digest(plan['mapping']),plan['snapshotSha256']))
        db.commit()
        return {'result':'applied', 'actionId':plan['actionId'], 'mappingSha':digest(plan['mapping']), 'schemaSha':schema_sha, 'tables':before}
    except BaseException:
        db.rollback()
        raise
    finally: db.close()

def prepare_plan(path, action_id):
    if path.is_symlink(): raise ValueError('Symlink database rejected')
    if Path(str(path)+'-wal').exists() and Path(str(path)+'-wal').stat().st_size: raise ValueError('Checkpoint WAL first')
    db=sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    try:
        references(db)
        ids={r[0] for r in db.execute('SELECT id FROM users')}
        used=set(ids); mapping={}
        for old in sorted(ids):
            if old=='user_web_private_test': new='TEST0001'
            elif re.fullmatch(r'[A-Z0-9]{8}',old) and re.search('[A-Z]',old) and re.search('[0-9]',old): new=old
            else:
                while True:
                    new=''.join(secrets.choice(string.ascii_uppercase+string.digits) for _ in range(8))
                    if new not in used and new!='TEST0001' and re.search('[A-Z]',new) and re.search('[0-9]',new): break
            if new in mapping.values(): raise ValueError('Reserved test identity conflict')
            mapping[old]=new;used.add(new)
        return {'actionId':action_id,'mapping':mapping,'snapshotSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'schemaSha256':digest(schema(db))}
    finally:db.close()

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--action-id', default='short-user-id-v1')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--reverse', action='store_true')
    parser.add_argument('--fail-stage', type=int, choices=range(1,5), default=0)
    args=parser.parse_args()
    if not args.plan:
        if args.apply or args.reverse: parser.error('--apply/--reverse require a reviewed --plan')
        print(json.dumps(prepare_plan(args.database.absolute(),args.action_id),sort_keys=True,indent=2))
    else:
        print(json.dumps(migrate(args.database.absolute(),json.loads(args.plan.read_text()),args.apply,args.fail_stage,args.reverse),sort_keys=True))

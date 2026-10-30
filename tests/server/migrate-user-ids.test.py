import importlib.util
import hashlib
import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('migration',Path('scripts/migrate-user-ids.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class MigrationTest(unittest.TestCase):
 def fixture(self,path):
  db=sqlite3.connect(path);db.execute('PRAGMA foreign_keys=ON')
  for file in sorted(Path('drizzle').glob('*.sql')):db.executescript(file.read_text())
  db.execute("INSERT INTO users(id,display_name,role) VALUES ('user_old','old','ADMIN')")
  db.execute("INSERT INTO users(id,display_name,status) VALUES ('user_web_private_test','private','SUSPENDED')")
  db.execute("INSERT INTO user_generation_limits(owner_id,enabled) VALUES ('user_web_private_test',0)")
  db.execute("INSERT INTO auth_email_credentials(email,user_id,password_hash,verified_at) VALUES ('user@example.test','user_old','hash',1)")
  db.execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,last_seen_at) VALUES ('token','user_old',9999999999,1)")
  db.execute("INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,idempotency_key,reason_code,actor_id,request_id) VALUES('credit','user_old','CREDIT',300,'credit','ADMIN_GRANT','user_old','request')")
  db.execute("INSERT INTO admin_audit_events(id,action_id,actor_id,action,target_type,target_id,payload_hash,detail_json,request_id) VALUES('audit','action','user_old','CREDIT_GRANT','USER','user_old','originalhash','{\"old\":\"user_old\"}','request')")
  db.execute("INSERT INTO assets(id,owner_id,kind,status,original_file_name,mime_type,byte_size,sha256,storage_key) VALUES('asset','user_old','output','PENDING','old.png','image/png',2,'sha','generated/user_old/asset')")
  db.commit();plan={'actionId':'short-user-id-v1','mapping':{'user_old':'ABC12345','user_web_private_test':'TEST0001'},'snapshotSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'schemaSha256':m.digest(m.schema(db))};db.close()
  result=subprocess.run(['node','--import','tsx','tests/helpers/rich-user-id-fixture.ts',str(path)],capture_output=True,text=True)
  if result.returncode: raise AssertionError(result.stderr)
  db=sqlite3.connect(path)
  for table,cols in m.references(db).items():
   for col in cols:
    self.assertGreater(db.execute(f'SELECT COUNT(*) FROM "{table}" WHERE "{col}"=?',('user_old' if table!='user_generation_limits' else 'user_old',)).fetchone()[0],0,f'{table}.{col} must have a real old reference')
  plan['snapshotSha256']=hashlib.sha256(path.read_bytes()).hexdigest();plan['schemaSha256']=m.digest(m.schema(db));db.close();return plan
 def test_dry_run_faults_apply_replay_reverse(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'isolated.sqlite';plan=self.fixture(path);before=path.read_bytes()
   self.assertEqual(m.migrate(path,plan)['result'],'dry_run');self.assertEqual(path.read_bytes(),before)
   for stage in range(1,5):
    with self.assertRaisesRegex(RuntimeError,'injected'):m.migrate(path,plan,True,stage)
    self.assertEqual(path.read_bytes(),before)
   self.assertEqual(m.migrate(path,plan,True)['result'],'applied');self.assertEqual(m.migrate(path,plan,True)['result'],'already_applied')
   db=sqlite3.connect(path);self.assertEqual(db.execute("SELECT id,identity_namespace,role FROM users WHERE id='ABC12345'").fetchone(),('ABC12345','user_old','ADMIN'));self.assertEqual(db.execute("SELECT storage_key,status FROM assets WHERE id='asset'").fetchone(),('generated/user_old/asset','PENDING'));self.assertEqual(db.execute("SELECT amount,actor_id,owner_id FROM credit_ledger_entries WHERE id='credit'").fetchone(),(300,'ABC12345','ABC12345'));self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
   with self.assertRaises(sqlite3.IntegrityError):db.execute("UPDATE credit_ledger_entries SET amount=1")
   db.rollback();reverse=dict(plan,snapshotSha256=hashlib.sha256(path.read_bytes()).hexdigest());db.close();self.assertEqual(m.migrate(path,reverse,True,reverse=True)['result'],'applied')
   db=sqlite3.connect(path);self.assertEqual(db.execute('SELECT id FROM users ORDER BY id').fetchall(),[('user_old',),('user_web_private_test',)]);db.close()
 def test_unknown_reference_and_wrong_snapshot_refuse(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'isolated.sqlite';plan=self.fixture(path)
   with self.assertRaisesRegex(ValueError,'fingerprint'):m.migrate(path,dict(plan,snapshotSha256='bad'),True)
   db=sqlite3.connect(path);db.execute('CREATE TABLE unknown_user_reference(owner_id TEXT)');db.commit();db.close()
   with self.assertRaisesRegex(ValueError,'Unknown identity'):m.migrate(path,plan,True)
 def test_replay_refuses_owner_actor_schema_and_foreign_key_drift(self):
  for drift in ['owner','actor','schema','foreign-key']:
   with self.subTest(drift=drift), tempfile.TemporaryDirectory() as tmp:
    path=Path(tmp)/'isolated.sqlite';plan=self.fixture(path);m.migrate(path,plan,True)
    db=sqlite3.connect(path)
    if drift=='owner':db.execute("UPDATE assets SET owner_id='user_old'")
    elif drift=='actor':
     trigger=db.execute("SELECT sql FROM sqlite_master WHERE name='credit_ledger_no_update'").fetchone()[0]
     db.execute('DROP TRIGGER credit_ledger_no_update');db.execute("UPDATE credit_ledger_entries SET actor_id='user_old'");db.execute(trigger)
    elif drift=='schema':db.execute('CREATE TABLE unexpected(value TEXT)')
    else:db.execute("UPDATE auth_sessions SET user_id='user_old'")
    db.commit();db.close();before=path.read_bytes()
    with self.assertRaisesRegex(ValueError,'Residual old identity|Schema fingerprint|integrity'):m.migrate(path,plan,True)
    self.assertEqual(path.read_bytes(),before)
if __name__=='__main__':unittest.main()

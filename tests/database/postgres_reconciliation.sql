\set ON_ERROR_STOP on
\o /dev/null
BEGIN;
SET search_path=fieldmerge,public;
CREATE TEMP TABLE results(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.ok(label text, condition boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; INSERT INTO results VALUES(label); END $$;
CREATE FUNCTION pg_temp.error(label text, query text, code text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN BEGIN EXECUTE query; EXCEPTION WHEN OTHERS THEN got:=SQLSTATE; END;
 IF got IS DISTINCT FROM code THEN RAISE EXCEPTION 'FAIL %, expected %, got %',label,code,got; END IF;
 INSERT INTO results VALUES(label);
END $$;
CREATE FUNCTION pg_temp.tree() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid=gen_random_uuid(); BEGIN
 INSERT INTO tree_records(record_id,campaign_id,source_record_id) VALUES(id,'20000000-0000-4000-8000-000000000001',id::text);
 INSERT INTO accepted_versions(record_id,version_no,species,health,diameter_cm,guard_damage,published_by)
 VALUES(id,1,'Demo species','Good',30,NULL,'10000000-0000-4000-8000-000000000002'); RETURN id;
END $$;
CREATE FUNCTION pg_temp.submit(t uuid,p jsonb,b integer DEFAULT 1,stamp timestamptz DEFAULT '2026-06-01') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid=gen_random_uuid(); BEGIN
 INSERT INTO submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at,received_at,state,source_verified_at,verified_patch)
 VALUES(id,'10000000-0000-4000-8000-000000000001',gen_random_uuid(),t,b,'tree-v2',repeat('a',64),stamp,'2026-06-01','ready',now(),p);RETURN id;
END $$;
DO $$
DECLARE t uuid; s uuid; s2 uuid; r jsonb; before_count integer;
BEGIN
 t:=pg_temp.tree(); s:=pg_temp.submit(t,'{"diameter_cm":32}');r:=reconcile_submission(s,repeat('a',64));
 PERFORM pg_temp.ok('compatible publication',r->>'state'='applied' AND (SELECT diameter_cm=32 FROM accepted_versions WHERE record_id=t AND version_no=2));
 PERFORM pg_temp.ok('publication links and audit',(SELECT count(*)=1 FROM field_changes WHERE submission_id=s AND applied_version_no=2) AND (SELECT count(*)=1 FROM audit_events WHERE submission_id=s));
 PERFORM pg_temp.ok('identical retry returns initial receipt',reconcile_submission(s,repeat('a',64))=r AND (SELECT count(*)=2 FROM accepted_versions WHERE record_id=t) AND (SELECT count(*)=1 FROM audit_events WHERE submission_id=s));
 PERFORM pg_temp.error('hash mismatch on completed retry',format('SELECT reconcile_submission(%L,%L)',s,repeat('b',64)),'22023');
 s2:=pg_temp.submit(t,'{"health":"Fair"}');r:=reconcile_submission(s2,repeat('a',64));
 PERFORM pg_temp.ok('independent stale change preserves prior value',(SELECT diameter_cm=32 AND health='Fair' FROM accepted_versions WHERE record_id=t AND version_no=3));
 PERFORM pg_temp.ok('unchanged value provenance stays at earlier version',(SELECT origin_version_no=2 AND origin_submission_id=s FROM field_value_provenance WHERE record_id=t AND version_no=3 AND field_name='diameter_cm'));
 s2:=pg_temp.submit(t,'{"diameter_cm":36,"guard_damage":false}');r:=reconcile_submission(s2,repeat('a',64));
 PERFORM pg_temp.ok('partial publication',r->>'state'='partially_applied' AND (SELECT diameter_cm=32 AND guard_damage=false FROM accepted_versions WHERE record_id=t AND version_no=4));
 PERFORM pg_temp.ok('conflict remains pending',(SELECT state='pending' AND pending_reason='value_conflict' FROM field_changes WHERE submission_id=s2 AND field_name='diameter_cm'));
 s2:=pg_temp.submit(t,'{"diameter_cm":32}');r:=reconcile_submission(s2,repeat('a',64));
 PERFORM pg_temp.ok('already represented produces no version',r->>'state'='no_change' AND r->'version_no'='null'::jsonb AND (SELECT state='already_represented' FROM field_changes WHERE submission_id=s2));
 s2:=pg_temp.submit(t,'{"diameter_cm":30}');r:=reconcile_submission(s2,repeat('a',64));
 PERFORM pg_temp.ok('unchanged proposal never reverts current',(SELECT diameter_cm=32 FROM latest_accepted_records WHERE record_id=t) AND r->>'state'='no_change');
 -- Make an accepted return to 30 using a fresh base. A stale proposal from v1 must see that history.
 s2:=pg_temp.submit(t,'{"diameter_cm":30}',4);PERFORM reconcile_submission(s2,repeat('a',64));
 s2:=pg_temp.submit(t,'{"diameter_cm":36}');r:=reconcile_submission(s2,repeat('a',64));
 PERFORM pg_temp.ok('change then reversal is still a conflict',r->>'state'='needs_review' AND (SELECT pending_reason='intervening_edit' FROM field_changes WHERE submission_id=s2));
 t:=pg_temp.tree();s:=pg_temp.submit(t,'{"health":"Fair","diameter_cm":-1}');r:=reconcile_submission(s,repeat('a',64));
 PERFORM pg_temp.ok('invalid field rejects entire patch',r->>'state'='rejected' AND NOT EXISTS(SELECT FROM field_changes WHERE submission_id=s) AND (SELECT max(version_no)=1 FROM accepted_versions WHERE record_id=t));
 s:=pg_temp.submit(t,'{"bogus":true}');r:=reconcile_submission(s,repeat('a',64));PERFORM pg_temp.ok('unknown field rejected',r->>'state'='rejected');
 s:=pg_temp.submit(t,'{"guard_damage":"false"}');r:=reconcile_submission(s,repeat('a',64));PERFORM pg_temp.ok('string boolean rejected',r->>'state'='rejected');
 s:=pg_temp.submit(t,'{"diameter_cm":30.123}');r:=reconcile_submission(s,repeat('a',64));PERFORM pg_temp.ok('excess precision rejects',r->>'state'='rejected');
 s:=pg_temp.submit(t,'{"species":"  Demo   revised  ","diameter_cm":0,"guard_damage":false}');r:=reconcile_submission(s,repeat('a',64));
 PERFORM pg_temp.ok('normalization zero and false',(SELECT species='Demo revised' AND diameter_cm=0 AND guard_damage=false FROM accepted_versions WHERE record_id=t AND version_no=2));
 s:=pg_temp.submit(t,'{"guard_damage":null}',2);r:=reconcile_submission(s,repeat('a',64));
 PERFORM pg_temp.ok('explicit null clears value',(SELECT guard_damage IS NULL FROM accepted_versions WHERE record_id=t AND version_no=3));
 s:=pg_temp.submit(t,'{}');r:=reconcile_submission(s,repeat('a',64));PERFORM pg_temp.ok('verified evidence-only input produces no version',r->>'state'='no_change');
 t:=pg_temp.tree();s:=pg_temp.submit(t,'{"health":"Fair"}',1,'2026-06-01T00:10:00Z');r:=reconcile_submission(s,repeat('a',64));
 PERFORM pg_temp.ok('clock warning holds actual changes',r->>'state'='needs_review' AND (SELECT pending_reason='clock_warning' FROM field_changes WHERE submission_id=s));
 s:=pg_temp.submit(t,'{"health":"Fair"}',1,'2027-01-01');r:=reconcile_submission(s,repeat('a',64));
 PERFORM pg_temp.ok('campaign-end warning',r->>'state'='needs_review' AND (SELECT pending_reason='campaign_warning' FROM field_changes WHERE submission_id=s));
 s:=pg_temp.submit(t,'{"health":"Fair"}',1,'2025-12-01');r:=reconcile_submission(s,repeat('a',64));PERFORM pg_temp.ok('pre-campaign observation rejected',r->>'state'='rejected');
 s:=pg_temp.submit(t,'{"health":"Fair"}');
 PERFORM pg_temp.error('sealed patch cannot be changed',format('UPDATE submissions SET verified_patch=''{}'' WHERE submission_id=%L',s),'42501');
 PERFORM pg_temp.error('verified hash cannot be changed',format('UPDATE submissions SET payload_hash=%L WHERE submission_id=%L',repeat('b',64),s),'42501');
 SET LOCAL ROLE fieldmerge_workflow;
 UPDATE submissions SET state='processing',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '1 hour' WHERE submission_id=s;
 RESET ROLE;
 PERFORM pg_temp.error('active lease cannot be stolen',format('SELECT reconcile_submission(%L,%L)',s,repeat('a',64)),'55P03');
 SET LOCAL ROLE fieldmerge_workflow;
 UPDATE submissions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE submission_id=s;
 RESET ROLE;
 r:=reconcile_submission(s,repeat('a',64));PERFORM pg_temp.ok('expired lease recoverable',r->>'state'='applied' AND (SELECT lease_token IS NULL FROM submissions WHERE submission_id=s));
 PERFORM pg_temp.error('committed receipt immutable',format('UPDATE submissions SET reconciliation_result=''{}'' WHERE submission_id=%L',s),'42501');
 t:=pg_temp.tree(); s:=pg_temp.submit(t,'{"health":"Fair"}');
 UPDATE app_users SET is_active=false WHERE user_id='10000000-0000-4000-8000-000000000001';
 PERFORM pg_temp.error('inactive author blocked',format('SELECT reconcile_submission(%L,%L)',s,repeat('a',64)),'42501');
 UPDATE app_users SET is_active=true WHERE user_id='10000000-0000-4000-8000-000000000001';
 UPDATE tree_records SET is_active=false WHERE record_id=t;
 PERFORM pg_temp.error('retired tree blocked',format('SELECT reconcile_submission(%L,%L)',s,repeat('a',64)),'55000');
 UPDATE tree_records SET is_active=true WHERE record_id=t;
 -- Deliberately fail at the final audit insertion; the entire function call must roll back.
 EXECUTE 'CREATE FUNCTION pg_temp.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION ''injected failure''; END $f$';
 EXECUTE 'CREATE TRIGGER test_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_audit()';
 PERFORM pg_temp.error('failure rolls back entire publication',format('SELECT reconcile_submission(%L,%L)',s,repeat('a',64)),'P0001');
 PERFORM pg_temp.ok('no partial state after failed publication',(SELECT state='ready' AND reconciliation_result IS NULL FROM submissions WHERE submission_id=s) AND NOT EXISTS(SELECT FROM field_changes WHERE submission_id=s) AND (SELECT max(version_no)=1 FROM accepted_versions WHERE record_id=t));
 EXECUTE 'DROP TRIGGER test_failure ON audit_events';
 r:=reconcile_submission(s,repeat('a',64)); PERFORM pg_temp.ok('retry after rollback succeeds',r->>'state'='applied');
 PERFORM pg_temp.ok('unprivileged application cannot execute workflow',NOT has_function_privilege('fieldmerge_app','fieldmerge.reconcile_submission(uuid,text)','EXECUTE'));
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
\o
\pset format unaligned
\pset tuples_only on
SELECT 'Reconciliation checks passed: '||count(*) FROM results;
ROLLBACK;

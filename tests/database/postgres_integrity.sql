\set ON_ERROR_STOP on
\o /dev/null
BEGIN;
SET search_path=fieldmerge,public;
CREATE TEMP TABLE integrity_results(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.ok(label text,condition boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 INSERT INTO integrity_results VALUES(label);
END $$;
CREATE FUNCTION pg_temp.error(label text,command text,expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text; BEGIN
 BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN got:=SQLSTATE; END;
 IF got IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL %, expected %, got %',label,expected,got; END IF;
 INSERT INTO integrity_results VALUES(label);
END $$;
CREATE FUNCTION pg_temp.tree() RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE id uuid=gen_random_uuid(); BEGIN
 INSERT INTO tree_records(record_id,campaign_id,source_record_id) VALUES(id,'20000000-0000-4000-8000-000000000001',id::text);
 INSERT INTO accepted_versions(record_id,version_no,species,health,diameter_cm,published_by)
 VALUES(id,1,'Demo species','Good',30,'10000000-0000-4000-8000-000000000002');RETURN id;
END $$;
CREATE FUNCTION pg_temp.source(t uuid,patch jsonb,warning boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE id uuid=gen_random_uuid(); BEGIN
 INSERT INTO submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,
 observed_at,received_at,state,source_verified_at,verified_patch)
 VALUES(id,'10000000-0000-4000-8000-000000000001',gen_random_uuid(),t,1,'tree-v2',repeat('a',64),
 CASE WHEN warning THEN '2026-06-01T00:10:00Z'::timestamptz ELSE '2026-06-01'::timestamptz END,'2026-06-01','ready',now(),patch);RETURN id;
END $$;
CREATE FUNCTION pg_temp.finish(s uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM reconcile_submission(s,repeat('a',64));SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;
END $$;
-- These fault triggers exist only in this rolled-back administrative test. They
-- corrupt real workflow writes; production guards are never disabled for tests.
CREATE FUNCTION pg_temp.integrity_fault() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fault text=current_setting('fieldmerge_test.fault',true); BEGIN
 IF TG_TABLE_NAME='accepted_versions' AND (to_jsonb(NEW)->>'version_no')::integer>1 THEN
  CASE fault
  WHEN 'extra_snapshot_field' THEN NEW.health:='Poor';
  WHEN 'wrong_snapshot_value' THEN NEW.diameter_cm:=33;
  WHEN 'unchanged_applying_field' THEN NEW.diameter_cm:=30;
  WHEN 'wrong_publisher' THEN NEW.published_by:='10000000-0000-4000-8000-000000000002';
  ELSE NULL;END CASE;
 ELSIF TG_TABLE_NAME='field_changes' AND TG_OP='INSERT' THEN
  CASE fault
  WHEN 'wrong_base' THEN NEW.base_value:='31';
  WHEN 'wrong_proposal' THEN NEW.proposed_value:='33';
  WHEN 'wrong_comparison' THEN NEW.compared_value:='29';
  WHEN 'wrong_applying_origin' THEN NEW.applied_version_no:=1;
  WHEN 'missing_change' THEN RETURN NULL;
  WHEN 'wrong_revision' THEN NEW.revision_no:=2;
  ELSE NULL;END CASE;
 ELSIF TG_TABLE_NAME='submissions' AND (to_jsonb(NEW)->'reconciliation_result') IS DISTINCT FROM 'null'::jsonb
  AND (to_jsonb(OLD)->'reconciliation_result')='null'::jsonb THEN
  IF fault='wrong_live_state' THEN NEW.state:='no_change'; END IF;
  IF fault='wrong_initial_receipt' THEN NEW.reconciliation_result:=jsonb_set(NEW.reconciliation_result,'{version_no}','999'); END IF;
 ELSIF TG_TABLE_NAME='review_decisions' THEN
  IF fault='wrong_decision_value' THEN NEW.chosen_value:='37'; END IF;
  IF fault='wrong_decision_revision' THEN NEW.expected_change_revision:=2; END IF;
  IF fault='wrong_decision_receipt' THEN NEW.decision_result:=jsonb_set(NEW.decision_result,'{field_state}','"no_change"'); END IF;
  IF fault='wrong_decision_receipt_state' THEN NEW.decision_result:=jsonb_set(NEW.decision_result,'{state}','"needs_review"'); END IF;
 ELSIF TG_TABLE_NAME='audit_events' THEN
  IF fault='missing_audit' AND NEW.event_type IN ('submission_reconciled','reconciliation_rejected','field_reviewed') THEN RETURN NULL; END IF;
  IF fault='wrong_review_actor' AND NEW.event_type='field_reviewed' THEN NEW.actor_id:='10000000-0000-4000-8000-000000000001'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aaa_integrity_fault BEFORE INSERT ON accepted_versions FOR EACH ROW EXECUTE FUNCTION pg_temp.integrity_fault();
CREATE TRIGGER aaa_integrity_fault BEFORE INSERT ON field_changes FOR EACH ROW EXECUTE FUNCTION pg_temp.integrity_fault();
CREATE TRIGGER aaa_integrity_fault BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION pg_temp.integrity_fault();
CREATE TRIGGER aaa_integrity_fault BEFORE INSERT ON review_decisions FOR EACH ROW EXECUTE FUNCTION pg_temp.integrity_fault();
CREATE TRIGGER aaa_integrity_fault BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION pg_temp.integrity_fault();
DO $$
DECLARE t uuid;s uuid;c uuid;fault text;r jsonb; BEGIN
 PERFORM pg_temp.ok('workflow role cannot login',(SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolbypassrls FROM pg_roles WHERE rolname='fieldmerge_workflow'));
 PERFORM pg_temp.ok('API is not a member of workflow role',NOT pg_has_role('fieldmerge_api','fieldmerge_workflow','MEMBER'));
 t:=pg_temp.tree();s:=pg_temp.source(t,'{"diameter_cm":32,"guard_damage":false,"health":null}');PERFORM pg_temp.finish(s);
 PERFORM pg_temp.ok('deferred check accepts multi-field automatic publication',(SELECT diameter_cm=32 AND guard_damage=false AND health IS NULL FROM accepted_versions WHERE record_id=t AND version_no=2));
 t:=pg_temp.tree();s:=pg_temp.source(t,'{}');PERFORM pg_temp.finish(s);
 PERFORM pg_temp.ok('evidence-only receipt is consistent',(SELECT state='no_change' FROM submissions WHERE submission_id=s));
 t:=pg_temp.tree();s:=pg_temp.source(t,'{"diameter_cm":-1}');PERFORM pg_temp.finish(s);
 PERFORM pg_temp.ok('rejected receipt has no changes',NOT EXISTS(SELECT FROM field_changes WHERE submission_id=s));
 t:=pg_temp.tree();s:=pg_temp.source(t,'{"diameter_cm":36}',true);PERFORM pg_temp.finish(s);
 SELECT change_id INTO c FROM field_changes WHERE submission_id=s;
 r:=review_change('10000000-0000-4000-8000-000000000002',gen_random_uuid(),c,1,1,'accept_proposal',NULL,'Valid integrity fixture');
 SET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;
 PERFORM pg_temp.ok('review publication and receipts remain consistent',r->>'state'='resolved');
 PERFORM pg_temp.error('owner cannot reopen terminal change',format('UPDATE field_changes SET state=''pending'',applied_version_no=NULL,pending_reason=''clock_warning'' WHERE change_id=%L',c),'42501');
 PERFORM pg_temp.error('owner cannot rewrite submission state',format('UPDATE submissions SET state=''applied'' WHERE submission_id=%L',s),'42501');
 PERFORM set_config('fieldmerge.workflow','true',true);
 PERFORM pg_temp.error('user-set configuration cannot authorize publication',format('UPDATE submissions SET state=''applied'' WHERE submission_id=%L',s),'42501');
 PERFORM set_config('fieldmerge.workflow','false',true);
 t:=pg_temp.tree();s:=pg_temp.source(t,'{"diameter_cm":32}');
 PERFORM pg_temp.error('owner cannot claim processing directly',format('UPDATE submissions SET state=''processing'',lease_token=gen_random_uuid(),lease_expires_at=now()+interval ''1 minute'' WHERE submission_id=%L',s),'42501');
 PERFORM pg_temp.error('owner cannot delete reserved intake',format('DELETE FROM submissions WHERE submission_id=%L',s),'42501');
 FOREACH fault IN ARRAY ARRAY['extra_snapshot_field','wrong_snapshot_value','unchanged_applying_field','wrong_publisher',
  'wrong_base','wrong_proposal','wrong_comparison','wrong_applying_origin','missing_change','wrong_revision','wrong_live_state','wrong_initial_receipt','missing_audit'] LOOP
  PERFORM set_config('fieldmerge_test.fault',fault,true);
  PERFORM pg_temp.error('reject injected '||fault,format('SELECT pg_temp.finish(%L)',s),'23514');
  PERFORM set_config('fieldmerge_test.fault','',true);
  PERFORM pg_temp.ok('rollback injected '||fault,(SELECT state='ready' AND reconciliation_result IS NULL FROM submissions WHERE submission_id=s)
   AND NOT EXISTS(SELECT FROM field_changes WHERE submission_id=s) AND (SELECT max(version_no)=1 FROM accepted_versions WHERE record_id=t));
 END LOOP;
 PERFORM pg_temp.finish(s);
 t:=pg_temp.tree();s:=pg_temp.source(t,'{"diameter_cm":36}',true);PERFORM pg_temp.finish(s);
 SELECT change_id INTO c FROM field_changes WHERE submission_id=s;
 PERFORM pg_temp.error('pending proposal cannot be rewritten outside workflow',format('UPDATE field_changes SET proposed_value=''40'' WHERE change_id=%L',c),'42501');
 FOREACH fault IN ARRAY ARRAY['wrong_decision_value','wrong_decision_revision','wrong_decision_receipt','wrong_decision_receipt_state','wrong_review_actor','missing_audit'] LOOP
  PERFORM set_config('fieldmerge_test.fault',fault,true);
  PERFORM pg_temp.error('reject review '||fault,format($q$DO $x$ BEGIN
   PERFORM fieldmerge.review_change('10000000-0000-4000-8000-000000000002',gen_random_uuid(),%L,1,1,'accept_proposal',NULL,'Injected fixture');
   SET CONSTRAINTS ALL IMMEDIATE; END $x$; $q$,c),'23514');
  PERFORM set_config('fieldmerge_test.fault','',true);
  PERFORM pg_temp.ok('rollback review '||fault,(SELECT state='pending' AND revision_no=1 FROM field_changes WHERE change_id=c)
   AND NOT EXISTS(SELECT FROM review_decisions WHERE change_id=c) AND (SELECT max(version_no)=1 FROM accepted_versions WHERE record_id=t));
 END LOOP;
 PERFORM pg_temp.error('disposition without decision fails at commit',format($q$DO $x$ BEGIN
  SET LOCAL ROLE fieldmerge_workflow;
  UPDATE fieldmerge.field_changes SET state='rejected',pending_reason=NULL,revision_no=2 WHERE change_id=%L;
  RESET ROLE;SET CONSTRAINTS ALL IMMEDIATE;END $x$; $q$,c),'23514');
 PERFORM pg_temp.ok('unreceipted disposal rolled back',(SELECT state='pending' AND revision_no=1 FROM field_changes WHERE change_id=c));
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
\o
\pset format unaligned
\pset tuples_only on
SELECT 'Workflow integrity checks passed: '||count(*) FROM integrity_results;
ROLLBACK;

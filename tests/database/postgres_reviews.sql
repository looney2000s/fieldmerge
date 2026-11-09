\set ON_ERROR_STOP on
\o /dev/null
BEGIN;
SET search_path=fieldmerge,public;
CREATE TEMP TABLE results(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.ok(label text, condition boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF; INSERT INTO results VALUES(label); END $$;
CREATE FUNCTION pg_temp.error(label text, query text, code text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text; BEGIN BEGIN EXECUTE query; EXCEPTION WHEN OTHERS THEN got:=SQLSTATE; END;
 IF got IS DISTINCT FROM code THEN RAISE EXCEPTION 'FAIL %, expected %, got %',label,code,got; END IF; INSERT INTO results VALUES(label); END $$;
CREATE FUNCTION pg_temp.tree() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid=gen_random_uuid(); BEGIN
 INSERT INTO tree_records(record_id,campaign_id,source_record_id) VALUES(id,'20000000-0000-4000-8000-000000000001',id::text);
 INSERT INTO accepted_versions(record_id,version_no,species,health,diameter_cm,published_by)
 VALUES(id,1,'Demo species','Good',30,'10000000-0000-4000-8000-000000000002'); RETURN id; END $$;
CREATE FUNCTION pg_temp.pending(t uuid,p jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid=gen_random_uuid(); BEGIN
 INSERT INTO submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at,received_at,state,source_verified_at,verified_patch)
 VALUES(id,'10000000-0000-4000-8000-000000000001',gen_random_uuid(),t,1,'tree-v2',repeat('a',64),'2026-06-01T00:10:00Z','2026-06-01','ready',now(),p);
 PERFORM reconcile_submission(id,repeat('a',64)); RETURN id; END $$;
CREATE FUNCTION pg_temp.change(s uuid,f text DEFAULT 'diameter_cm') RETURNS uuid LANGUAGE sql AS $$
 SELECT change_id FROM field_changes WHERE submission_id=s AND field_name=f $$;
CREATE FUNCTION pg_temp.dec(c uuid,action text DEFAULT 'accept_proposal',chosen jsonb DEFAULT NULL,
 v integer DEFAULT 1,revision integer DEFAULT 1,k uuid DEFAULT gen_random_uuid(),
 actor uuid DEFAULT '10000000-0000-4000-8000-000000000002') RETURNS jsonb LANGUAGE sql AS $$
 SELECT review_change(actor,k,c,v,revision,action,chosen,'Reviewed fixture') $$;
DO $$
DECLARE t uuid;s uuid;s2 uuid;c uuid;c2 uuid;k uuid; r jsonb; initial jsonb;
BEGIN
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"diameter_cm":36}');c:=pg_temp.change(s);k:=gen_random_uuid();
 SELECT reconciliation_result INTO initial FROM submissions WHERE submission_id=s;
 r:=pg_temp.dec(c,k=>k);
 PERFORM pg_temp.ok('accept proposal creates version',r->>'state'='resolved' AND (SELECT diameter_cm=36 AND published_by='10000000-0000-4000-8000-000000000002' FROM accepted_versions WHERE record_id=t AND version_no=2));
 PERFORM pg_temp.ok('decision field link and revision',(SELECT state='applied' AND applied_version_no=2 AND revision_no=2 AND pending_reason IS NULL FROM field_changes WHERE change_id=c));
 PERFORM pg_temp.ok('review provenance and audit',(SELECT decision_id=(r->>'decision_id')::uuid AND reviewer_id='10000000-0000-4000-8000-000000000002' FROM field_value_provenance WHERE record_id=t AND version_no=2 AND field_name='diameter_cm') AND (SELECT count(*)=1 FROM audit_events WHERE submission_id=s AND event_type='field_reviewed'));
 PERFORM pg_temp.ok('exact decision retry',pg_temp.dec(c,k=>k)=r AND (SELECT count(*)=1 FROM review_decisions WHERE change_id=c));
 PERFORM pg_temp.ok('automatic receipt survives review',reconcile_submission(s,repeat('a',64))=initial AND (SELECT state='resolved' FROM submissions WHERE submission_id=s));
 PERFORM pg_temp.error('changed request using retry key',format('SELECT pg_temp.dec(%L,''keep_current'',k=>%L)',c,k),'22023');
 PERFORM pg_temp.error('different key cannot resolve again',format('SELECT pg_temp.dec(%L)',c),'55000');
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"diameter_cm":36}');c:=pg_temp.change(s);r:=pg_temp.dec(c,'keep_current');
 PERFORM pg_temp.ok('keep current closes without version',r->'version_no'='null'::jsonb AND (SELECT max(version_no)=1 FROM accepted_versions WHERE record_id=t) AND (SELECT state='rejected' FROM field_changes WHERE change_id=c));
 PERFORM pg_temp.ok('keep current decision chosen value',r->'chosen_value'='30'::jsonb AND r->>'state'='resolved');
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"diameter_cm":36,"health":"Fair"}');c:=pg_temp.change(s);c2:=pg_temp.change(s,'health');r:=pg_temp.dec(c,'replace','34');
 PERFORM pg_temp.ok('replacement differs from proposal',(SELECT diameter_cm=34 FROM accepted_versions WHERE record_id=t AND version_no=2) AND (SELECT proposed_value='36'::jsonb FROM field_changes WHERE change_id=c));
 PERFORM pg_temp.ok('remaining proposal not silently closed',(SELECT state='pending' FROM field_changes WHERE change_id=c2) AND r->>'state'='partially_applied');
 PERFORM pg_temp.error('stale version rejected',format('SELECT pg_temp.dec(%L)',c2),'40001');
 PERFORM pg_temp.error('stale change revision rejected',format('SELECT pg_temp.dec(%L,v=>2,revision=>99)',c2),'40001');
 r:=pg_temp.dec(c2,'keep_current',v=>2);
 PERFORM pg_temp.ok('last decision resolves submission',r->>'state'='resolved' AND (SELECT count(*)=2 FROM review_decisions WHERE record_id=t));
 PERFORM pg_temp.ok('replacement provenance carries forward',(SELECT origin_version_no=2 AND value='34'::jsonb AND decision_id IS NOT NULL FROM field_value_provenance WHERE record_id=t AND version_no=2 AND field_name='diameter_cm'));
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"diameter_cm":36}');c:=pg_temp.change(s);
 s2:=pg_temp.pending(t,'{"diameter_cm":36}');c2:=pg_temp.change(s2);
 r:=pg_temp.dec(c);r:=pg_temp.dec(c2,v=>2);
 PERFORM pg_temp.ok('proposal already represented at review',r->>'field_state'='already_represented' AND r->'version_no'='null'::jsonb AND (SELECT count(*)=2 FROM accepted_versions WHERE record_id=t));
 PERFORM pg_temp.ok('already represented preserves original provenance',(SELECT origin_submission_id=s FROM field_value_provenance WHERE record_id=t AND version_no=2 AND field_name='diameter_cm'));
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"diameter_cm":36}');c:=pg_temp.change(s);r:=pg_temp.dec(c,'replace','null');
 PERFORM pg_temp.ok('explicit JSON null clears',r->'chosen_value'='null'::jsonb AND (SELECT diameter_cm IS NULL FROM accepted_versions WHERE record_id=t AND version_no=2));
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"diameter_cm":36}');c:=pg_temp.change(s);r:=pg_temp.dec(c,'replace','0');
 PERFORM pg_temp.ok('zero replacement retained',(SELECT diameter_cm=0 FROM accepted_versions WHERE record_id=t AND version_no=2));
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"guard_damage":true}');c:=pg_temp.change(s,'guard_damage');r:=pg_temp.dec(c,'replace','false');
 PERFORM pg_temp.ok('boolean false replacement retained',(SELECT guard_damage=false FROM accepted_versions WHERE record_id=t AND version_no=2));
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"species":"Different"}');c:=pg_temp.change(s,'species');r:=pg_temp.dec(c,'replace','"  Revised   species  "');
 PERFORM pg_temp.ok('species replacement normalized',(SELECT species='Revised species' FROM accepted_versions WHERE record_id=t AND version_no=2));
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"diameter_cm":36}');c:=pg_temp.change(s);
 PERFORM pg_temp.error('replace requires explicit chosen value',format('SELECT pg_temp.dec(%L,''replace'')',c),'22023');
 PERFORM pg_temp.error('extra chosen value not silently ignored',format('SELECT pg_temp.dec(%L,''accept_proposal'',''32'')',c),'22023');
 PERFORM pg_temp.error('typed replacement validation',format('SELECT pg_temp.dec(%L,''replace'',''"32"'')',c),'22023');
 PERFORM pg_temp.error('replacement precision validation',format('SELECT pg_temp.dec(%L,''replace'',''32.123'')',c),'22023');
 PERFORM pg_temp.error('surveyor cannot review',format('SELECT pg_temp.dec(%L,actor=>''10000000-0000-4000-8000-000000000001'')',c),'42501');
 PERFORM pg_temp.error('reason required',format('SELECT review_change(''10000000-0000-4000-8000-000000000002'',gen_random_uuid(),%L,1,1,''keep_current'',NULL,''   '')',c),'22023');
 UPDATE app_users SET is_active=false WHERE user_id='10000000-0000-4000-8000-000000000002';
 PERFORM pg_temp.error('inactive reviewer blocked',format('SELECT pg_temp.dec(%L)',c),'42501');
 UPDATE app_users SET is_active=true WHERE user_id='10000000-0000-4000-8000-000000000002';
 -- Test failure at the last write, after version/change/decision work has happened.
 EXECUTE 'CREATE FUNCTION pg_temp.fail_review_audit() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.event_type=''field_reviewed'' THEN RAISE EXCEPTION ''injected review failure''; END IF; RETURN NEW; END $f$';
 EXECUTE 'CREATE TRIGGER test_review_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_review_audit()';
 k:=gen_random_uuid();
 PERFORM pg_temp.error('review audit failure aborts',format('SELECT pg_temp.dec(%L,k=>%L)',c,k),'P0001');
 PERFORM pg_temp.ok('failed review leaves no partial result',NOT EXISTS(SELECT FROM review_decisions WHERE change_id=c) AND (SELECT state='pending' AND revision_no=1 FROM field_changes WHERE change_id=c) AND (SELECT max(version_no)=1 FROM accepted_versions WHERE record_id=t));
 EXECUTE 'DROP TRIGGER test_review_failure ON audit_events';r:=pg_temp.dec(c,k=>k);
 PERFORM pg_temp.ok('retry after rollback succeeds',r->>'field_state'='applied');
 PERFORM pg_temp.error('stored decision immutable',format('UPDATE review_decisions SET decision_result=''{}'' WHERE change_id=%L',c),'42501');
 PERFORM pg_temp.ok('application cannot invoke owner review entry point',NOT has_function_privilege('fieldmerge_app','fieldmerge.review_change(uuid,uuid,uuid,integer,integer,text,jsonb,text)','EXECUTE'));
 t:=pg_temp.tree();s:=pg_temp.pending(t,'{"diameter_cm":36}');c:=pg_temp.change(s);r:=pg_temp.dec(c,'replace','30');
 PERFORM pg_temp.ok('same-current replacement creates no version',r->>'field_state'='no_change' AND r->'version_no'='null'::jsonb AND (SELECT count(*)=1 FROM accepted_versions WHERE record_id=t));
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
\o
\pset format unaligned
\pset tuples_only on
SELECT 'Reviewer decision checks passed: '||count(*) FROM results;
ROLLBACK;

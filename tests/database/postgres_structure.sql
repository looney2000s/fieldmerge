\set ON_ERROR_STOP on
\o /dev/null
SET search_path=fieldmerge,public;
BEGIN;
CREATE TEMP TABLE test_results(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.ok(label text, condition boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
 INSERT INTO test_results VALUES(label);
END $$;
CREATE FUNCTION pg_temp.expect_error(label text, command text, expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE caught text;
BEGIN
 BEGIN EXECUTE command;
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS caught=RETURNED_SQLSTATE; END;
 IF caught IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: %, expected %, got %',label,expected,coalesce(caught,'success'); END IF;
 INSERT INTO test_results VALUES(label);
END $$;

SELECT pg_temp.ok('nine business tables',(SELECT count(*)=9 FROM information_schema.tables WHERE table_schema='fieldmerge' AND table_type='BASE TABLE'));
SELECT pg_temp.ok('idempotent seed leaves three baseline trees',(SELECT count(*)=3 FROM tree_records));
SELECT pg_temp.ok('two matching form registry rows',(SELECT count(*)=2 FROM form_versions));
SELECT pg_temp.ok('baseline latest-record view',(SELECT count(*)=3 AND bool_and(version_no=1) FROM latest_accepted_records));
SELECT pg_temp.ok('JSON null is accepted',valid_scalar('guard_damage','null'));
SELECT pg_temp.ok('false is accepted',valid_scalar('guard_damage','false'));
SELECT pg_temp.ok('numeric zero accepted',valid_scalar('diameter_cm','0'));
SELECT pg_temp.ok('false and zero are distinct',NOT valid_scalar('guard_damage','0') AND NOT valid_scalar('diameter_cm','false'));
SELECT pg_temp.ok('numeric string rejected',NOT valid_scalar('diameter_cm','"30"'));
SELECT pg_temp.ok('JSON objects rejected',NOT valid_scalar('species','{}'));
SELECT pg_temp.expect_error('duplicate source identity',$q$
 INSERT INTO tree_records VALUES('30000000-0000-4000-8000-000000000099','20000000-0000-4000-8000-000000000001','DEMO-1',now(),true,now())$q$,'23505');
SELECT pg_temp.expect_error('tree without initial version',$q$
 DO $x$ BEGIN
 INSERT INTO tree_records(record_id,campaign_id,source_record_id) VALUES('30000000-0000-4000-8000-000000000099','20000000-0000-4000-8000-000000000001','NO-INITIAL');
 SET CONSTRAINTS tree_initial_version IMMEDIATE;
 END $x$ $q$,'23514');
SELECT pg_temp.expect_error('duplicate composite version key',$q$
 INSERT INTO accepted_versions(record_id,version_no,published_by) VALUES('30000000-0000-4000-8000-000000000001',1,'10000000-0000-4000-8000-000000000002')$q$,'23505');
SELECT pg_temp.expect_error('negative diameter',$q$
 INSERT INTO accepted_versions(record_id,version_no,diameter_cm,published_by) VALUES('30000000-0000-4000-8000-000000000001',1,-1,'10000000-0000-4000-8000-000000000002')$q$,'23514');
SELECT pg_temp.expect_error('excess precision is not silently rounded',$q$
 INSERT INTO accepted_versions(record_id,version_no,diameter_cm,published_by) VALUES('30000000-0000-4000-8000-000000000001',1,30.123,'10000000-0000-4000-8000-000000000002')$q$,'23514');
SELECT pg_temp.expect_error('NaN diameter rejected',$q$
 INSERT INTO accepted_versions(record_id,version_no,diameter_cm,published_by) VALUES('30000000-0000-4000-8000-000000000001',1,'NaN','10000000-0000-4000-8000-000000000002')$q$,'23514');
SELECT pg_temp.expect_error('missing parent cannot pass null CHECK',$q$
 INSERT INTO accepted_versions(record_id,version_no,origin_submission_id,published_by) VALUES('30000000-0000-4000-8000-000000000001',2,'80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002')$q$,'23514');

INSERT INTO submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at)
VALUES('80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',1,'tree-v1',repeat('a',64),'2026-11-02');
SELECT pg_temp.expect_error('duplicate author retry identity',$q$
 INSERT INTO submissions SELECT '80000000-0000-4000-8000-000000000002',author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,batch_id,observed_at,received_at,state,source_verified_at,requires_review,warnings,rejection_reason,lease_token,lease_expires_at,last_error,updated_at FROM submissions LIMIT 1$q$,'23505');
SELECT pg_temp.expect_error('nonexistent base version',$q$
 UPDATE submissions SET base_version_no=99$q$,'23503');
SELECT pg_temp.expect_error('unverified source cannot become ready',$q$
 UPDATE submissions SET state='ready'$q$,'23514');
SELECT pg_temp.expect_error('lease pair cannot diverge',$q$
 UPDATE submissions SET lease_token='60000000-0000-4000-8000-000000000001'$q$,'23514');
SELECT pg_temp.expect_error('version cannot skip predecessor',$q$
 INSERT INTO accepted_versions(record_id,version_no,parent_version_no,origin_submission_id,published_by)
 VALUES('30000000-0000-4000-8000-000000000001',3,2,'80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001')$q$,'23503');
SELECT pg_temp.expect_error('version origin must be same tree',$q$
 INSERT INTO accepted_versions(record_id,version_no,parent_version_no,origin_submission_id,published_by)
 VALUES('30000000-0000-4000-8000-000000000002',2,1,'80000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001')$q$,'23503');

-- Administrative role switch for row-constraint fixtures only. This deliberately
-- incomplete graph is rolled back; commit-time workflow checks are tested separately.
SET LOCAL ROLE fieldmerge_workflow;
INSERT INTO field_changes(change_id,submission_id,record_id,field_name,base_value,proposed_value,compared_value,compared_version_no,classification,state,pending_reason)
VALUES('40000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','diameter_cm','30','36','30',1,'compatible','pending','clock_warning');
RESET ROLE;
SELECT pg_temp.ok('pending view shows current accepted value',(SELECT current_value='30'::jsonb AND current_version_no=1 FROM pending_field_reviews));
SELECT pg_temp.ok('submission outcome counts',(SELECT pending_fields=1 AND applied_fields=0 FROM submission_outcomes));
SELECT pg_temp.expect_error('field change guard cannot name another tree',$q$
 UPDATE field_changes SET record_id='30000000-0000-4000-8000-000000000002'$q$,'23503');
SELECT pg_temp.expect_error('one proposal per submission field',$q$
 INSERT INTO field_changes SELECT '40000000-0000-4000-8000-000000000002',submission_id,record_id,field_name,base_value,proposed_value,compared_value,compared_version_no,classification,state,pending_reason,revision_no,applied_version_no,updated_at FROM field_changes$q$,'23505');
SELECT pg_temp.expect_error('SQL NULL does not mean JSON unknown',$q$
 UPDATE field_changes SET proposed_value=NULL$q$,'23502');
SELECT pg_temp.expect_error('invalid proposal type rejected',$q$
 UPDATE field_changes SET proposed_value='"36"'$q$,'23514');
SELECT pg_temp.expect_error('applied state needs result link',$q$
 UPDATE field_changes SET state='applied',pending_reason=NULL$q$,'23514');
SELECT pg_temp.expect_error('surveyor cannot be reviewer',$q$
 INSERT INTO review_decisions(decision_id,change_id,record_id,reviewer_id,client_decision_id,request_hash,expected_version_no,expected_change_revision,action,chosen_value,reason)
 VALUES('a0000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001',repeat('b',64),1,1,'keep_current','30','test')$q$,'42501');
SET LOCAL ROLE fieldmerge_workflow;
INSERT INTO review_decisions(decision_id,change_id,record_id,reviewer_id,client_decision_id,request_hash,expected_version_no,expected_change_revision,action,chosen_value,reason,decision_result)
VALUES('a0000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000001',repeat('b',64),1,1,'keep_current','30','structural fixture only','{"state":"awaiting_document"}');
RESET ROLE;
SELECT pg_temp.expect_error('one terminal decision per proposal',$q$
 INSERT INTO review_decisions SELECT 'a0000000-0000-4000-8000-000000000002',change_id,record_id,reviewer_id,'b0000000-0000-4000-8000-000000000002',request_hash,expected_version_no,expected_change_revision,action,chosen_value,reason,result_version_no,created_at FROM review_decisions$q$,'23505');
SELECT pg_temp.expect_error('accepted history immutable',$q$ UPDATE accepted_versions SET health='Poor' $q$,'42501');
SELECT pg_temp.expect_error('decision history immutable',$q$ DELETE FROM review_decisions $q$,'42501');
INSERT INTO audit_events(event_type) VALUES('structure_test');
SELECT pg_temp.expect_error('audit history immutable',$q$ UPDATE audit_events SET event_type='changed' $q$,'42501');
SELECT pg_temp.expect_error('audit target must match submission',$q$
 INSERT INTO audit_events(record_id,submission_id,event_type) VALUES('30000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000001','mismatch')$q$,'23514');
SELECT pg_temp.ok('application role has no direct write',NOT has_table_privilege('fieldmerge_app','fieldmerge.accepted_versions','INSERT'));
SELECT pg_temp.ok('application role cannot read password table',NOT has_table_privilege('fieldmerge_app','fieldmerge.app_users','SELECT'));
SELECT pg_temp.ok('application role cannot execute owner helper',NOT has_function_privilege('fieldmerge_app','fieldmerge.valid_scalar(text,jsonb)','EXECUTE'));
\o
\pset format unaligned
\pset tuples_only on
SELECT 'PostgreSQL structural checks passed: '||count(*) AS result FROM test_results;
-- Tests never change seed data or developer records.
ROLLBACK;

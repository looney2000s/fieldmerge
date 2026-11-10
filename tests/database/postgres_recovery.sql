\set ON_ERROR_STOP on
\o /dev/null
BEGIN;
SET search_path=fieldmerge,public;
CREATE TEMP TABLE recovery_results(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.ok(label text,condition boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;INSERT INTO recovery_results VALUES(label);
END $$;
CREATE FUNCTION pg_temp.error(label text,command text,expected text) RETURNS void LANGUAGE plpgsql AS $$ DECLARE code text;BEGIN
 BEGIN EXECUTE command;EXCEPTION WHEN OTHERS THEN code:=SQLSTATE;END;
 IF code IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL %, expected %, got %',label,expected,code;END IF;INSERT INTO recovery_results VALUES(label);
END $$;
DO $$ DECLARE t uuid=gen_random_uuid();s uuid=gen_random_uuid();j uuid;a jsonb;b jsonb;token text=repeat('d',64);BEGIN
 INSERT INTO tree_records(record_id,campaign_id,source_record_id) VALUES(t,'20000000-0000-4000-8000-000000000001',t::text);
 INSERT INTO accepted_versions(record_id,version_no,diameter_cm,published_by) VALUES(t,1,30,'10000000-0000-4000-8000-000000000002');
 INSERT INTO submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at)
 VALUES(s,'10000000-0000-4000-8000-000000000001',gen_random_uuid(),t,1,'tree-v1',repeat('a',64),'2026-06-01');
 SELECT job_id INTO j FROM fieldmerge_ops.recovery_jobs WHERE job_kind='submission' AND target_id=s;
 PERFORM pg_temp.ok('reservation queues persistent recovery',j IS NOT NULL AND (SELECT owner_id='10000000-0000-4000-8000-000000000001' AND status='queued' FROM fieldmerge_ops.recovery_jobs WHERE job_id=j));
 a:=worker_claim(gen_random_uuid());
 PERFORM pg_temp.ok('claim is bounded and counted',a->>'job_id'=j::text AND a->>'status'='leased' AND (a->>'attempts')::int=1 AND (a->>'lease_expires_at')::timestamptz>clock_timestamp());
 PERFORM pg_temp.ok('live claim is not claimed twice',worker_claim(gen_random_uuid()) IS NULL);
 UPDATE fieldmerge_ops.recovery_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE job_id=j;
 b:=worker_claim(gen_random_uuid());
 PERFORM pg_temp.ok('expired claim gets a new token',b->>'job_id'=j::text AND b->>'lease_token'<>a->>'lease_token' AND (b->>'attempts')::int=2);
 PERFORM pg_temp.error('old worker is fenced',format('SELECT worker_context(%L,%L)',j,a->>'lease_token'),'55P03');
 PERFORM pg_temp.error('expired worker cannot publish',format('SELECT worker_finish_submission(%L,%L,repeat(''a'',64),''{}'')',j,a->>'lease_token'),'55P03');
 PERFORM pg_temp.ok('old worker cannot overwrite successor error',NOT worker_fail(j,(a->>'lease_token')::uuid,'source_missing'));
 PERFORM worker_fail(j,(b->>'lease_token')::uuid,'service_unavailable');
 PERFORM pg_temp.ok('transient failure is persisted',
  (SELECT status='retry' AND failure_count=1 AND next_attempt_at>clock_timestamp() AND lease_token IS NULL FROM fieldmerge_ops.recovery_jobs WHERE job_id=j));
 PERFORM pg_temp.ok('retry backoff prevents hot loop',worker_claim(gen_random_uuid()) IS NULL);
 UPDATE fieldmerge_ops.recovery_jobs SET failure_count=7,next_attempt_at=clock_timestamp()-interval '1 second' WHERE job_id=j;
 a:=worker_claim(gen_random_uuid());PERFORM worker_fail(j,(a->>'lease_token')::uuid,'service_unavailable');
 PERFORM pg_temp.ok('automatic retry budget is bounded',(SELECT status='blocked' AND failure_count=8 FROM fieldmerge_ops.recovery_jobs WHERE job_id=j));
 PERFORM api_create_session('10000000-0000-4000-8000-000000000002',token);
 PERFORM api_recovery_retry(token,j,'Reviewed outage recovery');
 PERFORM pg_temp.ok('reviewer can schedule same evidence again',(SELECT status='queued' AND failure_count=0 FROM fieldmerge_ops.recovery_jobs WHERE job_id=j));
 PERFORM pg_temp.ok('retry request has durable attribution',EXISTS(SELECT FROM fieldmerge_ops.recovery_events WHERE job_id=j AND event_type='retry_requested' AND actor_id='10000000-0000-4000-8000-000000000002'));
 a:=worker_claim(gen_random_uuid());
 PERFORM pg_temp.error('reviewer cannot steal live worker lease',format('SELECT api_recovery_retry(%L,%L,''retry'')',token,j),'55000');
 PERFORM pg_temp.error('incomplete publication cannot complete job',format('SELECT worker_complete(%L,%L)',j,a->>'lease_token'),'55000');
 PERFORM worker_fail(j,(a->>'lease_token')::uuid,'source_integrity_mismatch');
 PERFORM pg_temp.ok('source mismatch is quarantined',(SELECT status='quarantined' AND last_error_code='source_integrity_mismatch' FROM fieldmerge_ops.recovery_jobs WHERE job_id=j));
 PERFORM pg_temp.ok('quarantine is excluded from automatic claims',worker_claim(gen_random_uuid()) IS NULL);
 PERFORM pg_temp.error('recovery event history is immutable','UPDATE fieldmerge_ops.recovery_events SET event_type=''queued''','42501');
 PERFORM pg_temp.ok('worker has no direct workflow table privileges',NOT has_table_privilege('fieldmerge_worker','fieldmerge.submissions','SELECT') AND NOT has_table_privilege('fieldmerge_worker','fieldmerge_ops.recovery_jobs','UPDATE'));
 PERFORM pg_temp.ok('worker cannot mint user sessions',NOT has_function_privilege('fieldmerge_worker','fieldmerge.api_create_session(uuid,text)','EXECUTE'));
 PERFORM pg_temp.ok('API cannot claim worker jobs',NOT has_function_privilege('fieldmerge_api','fieldmerge.worker_claim(uuid)','EXECUTE'));
 PERFORM pg_temp.ok('worker cannot assume publication role',NOT pg_has_role('fieldmerge_worker','fieldmerge_workflow','MEMBER'));
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
\o
\pset format unaligned
\pset tuples_only on
SELECT 'Recovery queue checks passed: '||count(*) FROM recovery_results;
ROLLBACK;

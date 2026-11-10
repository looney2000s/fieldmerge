\set ON_ERROR_STOP on
BEGIN;
SET search_path=fieldmerge,public;
CREATE SCHEMA fieldmerge_ops;
REVOKE ALL ON SCHEMA fieldmerge_ops FROM PUBLIC;
CREATE TABLE fieldmerge_ops.recovery_jobs (
 job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_kind text NOT NULL CHECK(job_kind IN ('submission','draft')),
 target_id uuid NOT NULL,owner_id uuid NOT NULL REFERENCES app_users,submission_id uuid REFERENCES submissions,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','retry','waiting_source','blocked','quarantined','completed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_token uuid,lease_expires_at timestamptz,claimed_by uuid,
 last_error_code varchar(80),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,UNIQUE(job_kind,target_id),
 CHECK(job_kind<>'submission' OR submission_id IS NOT NULL AND submission_id=target_id),
 CHECK((status='leased')=(lease_token IS NOT NULL)),CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
 CHECK((status='completed')=(completed_at IS NOT NULL))
);
CREATE INDEX recovery_due ON fieldmerge_ops.recovery_jobs(next_attempt_at,created_at) WHERE status IN ('queued','retry','waiting_source','leased');
CREATE TABLE fieldmerge_ops.recovery_events (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,job_id uuid NOT NULL REFERENCES fieldmerge_ops.recovery_jobs,
 event_type text NOT NULL CHECK(event_type IN ('queued','claimed','failure','retry_requested','completed')),
 actor_id uuid REFERENCES app_users,event_data jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(event_data)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX recovery_event_job ON fieldmerge_ops.recovery_events(job_id,event_id);
CREATE TRIGGER immutable_recovery_events BEFORE UPDATE OR DELETE ON fieldmerge_ops.recovery_events
 FOR EACH ROW EXECUTE FUNCTION block_history_mutation();
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='fieldmerge_worker') THEN CREATE ROLE fieldmerge_worker NOLOGIN; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='fieldmerge_worker' AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls))
 THEN RAISE EXCEPTION 'unsafe worker role'; END IF; END $$;
GRANT USAGE ON SCHEMA fieldmerge TO fieldmerge_worker;
GRANT USAGE ON SCHEMA fieldmerge_ops TO fieldmerge_workflow;
GRANT INSERT ON submissions TO fieldmerge_workflow;
GRANT SELECT,UPDATE(submission_id,updated_at) ON fieldmerge_ops.recovery_jobs TO fieldmerge_workflow;

CREATE FUNCTION queue_submission_recovery() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE id uuid;
BEGIN
 IF NEW.reconciliation_result IS NULL THEN
  INSERT INTO fieldmerge_ops.recovery_jobs(job_kind,target_id,owner_id,submission_id)
   VALUES('submission',NEW.submission_id,NEW.author_id,NEW.submission_id) ON CONFLICT(job_kind,target_id) DO NOTHING RETURNING job_id INTO id;
  IF id IS NOT NULL THEN INSERT INTO fieldmerge_ops.recovery_events(job_id,event_type) VALUES(id,'queued'); END IF;
 ELSIF TG_OP='INSERT' OR OLD.reconciliation_result IS NULL THEN
  UPDATE fieldmerge_ops.recovery_jobs SET status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp(),
   lease_token=NULL,lease_expires_at=NULL,claimed_by=NULL,last_error_code=NULL
   WHERE job_kind='submission' AND target_id=NEW.submission_id AND status<>'completed' RETURNING job_id INTO id;
  IF id IS NOT NULL THEN INSERT INTO fieldmerge_ops.recovery_events(job_id,event_type) VALUES(id,'completed'); END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER zzz_submission_recovery AFTER INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION queue_submission_recovery();
INSERT INTO fieldmerge_ops.recovery_jobs(job_kind,target_id,owner_id,submission_id)
 SELECT 'submission',submission_id,author_id,submission_id FROM submissions WHERE reconciliation_result IS NULL;
INSERT INTO fieldmerge_ops.recovery_events(job_id,event_type) SELECT job_id,'queued' FROM fieldmerge_ops.recovery_jobs;

-- Shared reserve logic: author comes from an authenticated API wrapper or a fenced recovery job.
CREATE FUNCTION _reserve_for_author(actor uuid,p_client uuid,p_record uuid,p_base integer,p_form text,p_hash text,p_observed timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s fieldmerge.submissions%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_client::text,1));
 SELECT * INTO s FROM fieldmerge.submissions WHERE author_id=actor AND client_submission_id=p_client;
 IF FOUND THEN
  IF s.payload_hash IS DISTINCT FROM p_hash OR s.record_id IS DISTINCT FROM p_record OR s.base_version_no IS DISTINCT FROM p_base
   OR s.form_version IS DISTINCT FROM p_form OR s.observed_at IS DISTINCT FROM p_observed
  THEN RAISE EXCEPTION 'request identity conflict' USING ERRCODE='22023'; END IF;
  RETURN to_jsonb(s)-'verified_patch';
 END IF;
 IF NOT EXISTS(SELECT FROM fieldmerge.app_users WHERE user_id=actor AND role='surveyor' AND is_active)
 THEN RAISE EXCEPTION 'active author required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM fieldmerge.tree_records r JOIN fieldmerge.accepted_versions v USING(record_id)
 WHERE r.record_id=p_record AND r.is_active AND v.version_no=p_base) OR
 NOT EXISTS(SELECT FROM fieldmerge.form_versions WHERE form_version=p_form AND is_supported)
 THEN RAISE EXCEPTION 'target or form unavailable' USING ERRCODE='55000'; END IF;
 INSERT INTO fieldmerge.submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at)
 VALUES(gen_random_uuid(),actor,p_client,p_record,p_base,p_form,p_hash,p_observed) RETURNING * INTO s;
 RETURN to_jsonb(s)-'verified_patch';
END $$;
ALTER FUNCTION _reserve_for_author(uuid,uuid,uuid,integer,text,text,timestamptz) OWNER TO fieldmerge_workflow;
CREATE OR REPLACE FUNCTION api_reserve_submission(p_token text,p_client uuid,p_record uuid,p_base integer,p_form text,p_hash text,p_observed timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 RETURN fieldmerge._reserve_for_author(fieldmerge._api_actor(p_token,'surveyor'),p_client,p_record,p_base,p_form,p_hash,p_observed);
END $$;

CREATE FUNCTION _recovery_lease(p_job uuid,p_token uuid) RETURNS fieldmerge_ops.recovery_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE j fieldmerge_ops.recovery_jobs%ROWTYPE; BEGIN
 SELECT * INTO j FROM fieldmerge_ops.recovery_jobs WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR j.status<>'leased' OR j.lease_token IS DISTINCT FROM p_token OR j.lease_expires_at<=clock_timestamp()
 THEN RAISE EXCEPTION 'recovery lease lost' USING ERRCODE='55P03'; END IF;
 RETURN j;
END $$;
GRANT EXECUTE ON FUNCTION _recovery_lease(uuid,uuid) TO fieldmerge_workflow;
CREATE FUNCTION worker_register_draft(p_id uuid,p_owner uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE id uuid;actual uuid;BEGIN
 IF NOT EXISTS(SELECT FROM fieldmerge.app_users WHERE user_id=p_owner AND role='surveyor')
 THEN RAISE EXCEPTION 'draft owner invalid' USING ERRCODE='22023'; END IF;
 INSERT INTO fieldmerge_ops.recovery_jobs(job_kind,target_id,owner_id) VALUES('draft',p_id,p_owner)
 ON CONFLICT(job_kind,target_id) DO NOTHING RETURNING job_id INTO id;
 IF id IS NOT NULL THEN INSERT INTO fieldmerge_ops.recovery_events(job_id,event_type) VALUES(id,'queued'); END IF;
 SELECT job_id,owner_id INTO id,actual FROM fieldmerge_ops.recovery_jobs WHERE job_kind='draft' AND target_id=p_id;
 IF actual IS DISTINCT FROM p_owner THEN RAISE EXCEPTION 'draft identity mismatch' USING ERRCODE='22023'; END IF;
 RETURN id;
END $$;
CREATE FUNCTION worker_claim(p_worker uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j fieldmerge_ops.recovery_jobs%ROWTYPE;BEGIN
 IF p_worker IS NULL THEN RAISE EXCEPTION 'worker identity required' USING ERRCODE='22023'; END IF;
 SELECT * INTO j FROM fieldmerge_ops.recovery_jobs WHERE
  (status IN ('queued','retry','waiting_source') AND next_attempt_at<=clock_timestamp()) OR
  (status='leased' AND lease_expires_at<=clock_timestamp())
 ORDER BY next_attempt_at,created_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE fieldmerge_ops.recovery_jobs SET status='leased',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '60 seconds',
  claimed_by=p_worker,attempts=attempts+1,updated_at=clock_timestamp() WHERE job_id=j.job_id RETURNING * INTO j;
 INSERT INTO fieldmerge_ops.recovery_events(job_id,event_type,event_data) VALUES(j.job_id,'claimed',jsonb_build_object('attempt',j.attempts));
 RETURN to_jsonb(j);
END $$;
CREATE FUNCTION worker_context(p_job uuid,p_token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j fieldmerge_ops.recovery_jobs%ROWTYPE;BEGIN
 SELECT * INTO j FROM fieldmerge_ops.recovery_jobs WHERE job_id=p_job AND status='leased' AND lease_token=p_token AND lease_expires_at>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'recovery lease lost' USING ERRCODE='55P03'; END IF;
 RETURN jsonb_build_object('job',to_jsonb(j),'submission',(SELECT to_jsonb(s) FROM fieldmerge.submissions s WHERE submission_id=j.submission_id));
END $$;
CREATE FUNCTION worker_form(p_form text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT to_jsonb(f) FROM fieldmerge.form_versions f WHERE form_version=p_form
$$;
CREATE FUNCTION worker_reserve_draft(p_job uuid,p_token uuid,p_client uuid,p_record uuid,p_base integer,p_form text,p_hash text,p_observed timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j fieldmerge_ops.recovery_jobs%ROWTYPE;s jsonb;BEGIN
 j:=fieldmerge._recovery_lease(p_job,p_token);
 IF j.job_kind<>'draft' THEN RAISE EXCEPTION 'draft job required' USING ERRCODE='22023'; END IF;
 s:=fieldmerge._reserve_for_author(j.owner_id,p_client,p_record,p_base,p_form,p_hash,p_observed);
 IF j.submission_id IS NOT NULL AND j.submission_id IS DISTINCT FROM (s->>'submission_id')::uuid
 THEN RAISE EXCEPTION 'draft submission identity mismatch' USING ERRCODE='22023'; END IF;
 UPDATE fieldmerge_ops.recovery_jobs SET submission_id=(s->>'submission_id')::uuid,updated_at=clock_timestamp() WHERE job_id=p_job;
 RETURN s;
END $$;
ALTER FUNCTION worker_reserve_draft(uuid,uuid,uuid,uuid,integer,text,text,timestamptz) OWNER TO fieldmerge_workflow;
CREATE FUNCTION worker_finish_submission(p_job uuid,p_token uuid,p_hash text,p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j fieldmerge_ops.recovery_jobs%ROWTYPE;s fieldmerge.submissions%ROWTYPE;target uuid;sid uuid;BEGIN
 SELECT submission_id INTO sid FROM fieldmerge_ops.recovery_jobs WHERE job_id=p_job;
 SELECT record_id INTO target FROM fieldmerge.submissions WHERE submission_id=sid;
 IF target IS NULL THEN RAISE EXCEPTION 'submission not found' USING ERRCODE='P0002'; END IF;
 -- Match publication lock order: tree, submission, then operational job. No lock spans MongoDB I/O.
 PERFORM 1 FROM fieldmerge.tree_records WHERE record_id=target FOR UPDATE;
 SELECT * INTO STRICT s FROM fieldmerge.submissions WHERE submission_id=sid FOR UPDATE;
 IF s.reconciliation_result IS NOT NULL THEN RETURN s.reconciliation_result; END IF;
 j:=fieldmerge._recovery_lease(p_job,p_token);
 IF j.owner_id IS DISTINCT FROM s.author_id OR s.payload_hash IS DISTINCT FROM p_hash OR p_patch IS NULL OR jsonb_typeof(p_patch)<>'object'
 THEN RAISE EXCEPTION 'source integrity mismatch' USING ERRCODE='22023'; END IF;
 IF s.source_verified_at IS NULL THEN
  UPDATE fieldmerge.submissions SET verified_patch=p_patch,source_verified_at=clock_timestamp(),state='ready',updated_at=clock_timestamp() WHERE submission_id=sid;
 ELSIF s.verified_patch IS DISTINCT FROM p_patch THEN RAISE EXCEPTION 'verified projection mismatch' USING ERRCODE='22023'; END IF;
 RETURN fieldmerge.reconcile_submission(sid,p_hash);
END $$;
ALTER FUNCTION worker_finish_submission(uuid,uuid,text,jsonb) OWNER TO fieldmerge_workflow;
CREATE FUNCTION worker_complete(p_job uuid,p_token uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j fieldmerge_ops.recovery_jobs%ROWTYPE;BEGIN
 IF EXISTS(SELECT FROM fieldmerge_ops.recovery_jobs WHERE job_id=p_job AND status='completed') THEN RETURN true; END IF;
 j:=fieldmerge._recovery_lease(p_job,p_token);
 IF NOT EXISTS(SELECT FROM fieldmerge.submissions WHERE submission_id=j.submission_id AND author_id=j.owner_id AND reconciliation_result IS NOT NULL)
 THEN RAISE EXCEPTION 'publication is incomplete' USING ERRCODE='55000'; END IF;
 UPDATE fieldmerge_ops.recovery_jobs SET status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp(),
 lease_token=NULL,lease_expires_at=NULL,claimed_by=NULL,last_error_code=NULL WHERE job_id=p_job;
 INSERT INTO fieldmerge_ops.recovery_events(job_id,event_type) VALUES(p_job,'completed');RETURN true;
END $$;
CREATE FUNCTION worker_fail(p_job uuid,p_token uuid,p_code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j fieldmerge_ops.recovery_jobs%ROWTYPE;next_status text;failures integer;BEGIN
 SELECT * INTO j FROM fieldmerge_ops.recovery_jobs WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND OR j.status<>'leased' OR j.lease_token IS DISTINCT FROM p_token OR j.lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
 IF p_code IN ('source_integrity_mismatch','form_integrity_mismatch','draft_integrity_mismatch','invalid_stored_envelope','request_identity_conflict','workflow_integrity_failure','draft_missing') THEN next_status:='quarantined';
 ELSIF p_code IN ('actor_inactive','prerequisite_unavailable') THEN next_status:='blocked';
 ELSIF p_code='source_missing' THEN next_status:='waiting_source';
 ELSIF p_code IN ('service_unavailable','processing_busy') THEN next_status:='retry';
 ELSE RAISE EXCEPTION 'unknown recovery error code' USING ERRCODE='22023'; END IF;
 failures:=j.failure_count+1;
 IF failures>=8 AND next_status IN ('retry','waiting_source') THEN next_status:='blocked'; END IF;
 UPDATE fieldmerge_ops.recovery_jobs SET status=next_status,failure_count=failures,last_error_code=p_code,
 next_attempt_at=clock_timestamp()+make_interval(secs=>CASE WHEN p_code='source_missing' THEN 60 ELSE least(300,5*power(2,least(failures,6)))::integer END),
 lease_token=NULL,lease_expires_at=NULL,claimed_by=NULL,updated_at=clock_timestamp() WHERE job_id=p_job;
 INSERT INTO fieldmerge_ops.recovery_events(job_id,event_type,event_data) VALUES(p_job,'failure',jsonb_build_object('code',p_code,'attempt',j.attempts,'status',next_status));RETURN true;
END $$;

CREATE FUNCTION api_recovery_jobs(p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token,'reviewer');
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(q)) FROM (SELECT j.job_id,j.job_kind,j.target_id,j.owner_id,j.submission_id,j.status,
 j.attempts,j.failure_count,j.next_attempt_at,j.lease_expires_at,j.last_error_code,j.created_at,j.updated_at,j.completed_at,s.record_id,s.state AS submission_state
 FROM fieldmerge_ops.recovery_jobs j LEFT JOIN fieldmerge.submissions s USING(submission_id)
 ORDER BY (j.status='completed'),j.updated_at DESC,j.job_id LIMIT 100) q),'[]');
END $$;
CREATE FUNCTION api_recovery_detail(p_token text,p_job uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token,'reviewer');
 RETURN (SELECT jsonb_build_object('job',to_jsonb(j)-ARRAY['lease_token','claimed_by'],
 'events',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM (SELECT event_id,event_type,actor_id,event_data,created_at
 FROM fieldmerge_ops.recovery_events WHERE job_id=p_job ORDER BY event_id DESC LIMIT 30) e),'[]'))
 FROM fieldmerge_ops.recovery_jobs j WHERE job_id=p_job);
END $$;
CREATE FUNCTION api_recovery_retry(p_token text,p_job uuid,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token,'reviewer');j fieldmerge_ops.recovery_jobs%ROWTYPE;BEGIN
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'retry reason required' USING ERRCODE='22023'; END IF;
 SELECT * INTO j FROM fieldmerge_ops.recovery_jobs WHERE job_id=p_job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'recovery job not found' USING ERRCODE='P0002'; END IF;
 IF j.status='completed' OR j.status='leased' AND j.lease_expires_at>clock_timestamp()
 THEN RAISE EXCEPTION 'job completed or actively leased' USING ERRCODE='55000'; END IF;
 UPDATE fieldmerge_ops.recovery_jobs SET status='queued',failure_count=0,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp(),
 lease_token=NULL,lease_expires_at=NULL,claimed_by=NULL WHERE job_id=p_job;
 INSERT INTO fieldmerge_ops.recovery_events(job_id,event_type,actor_id,event_data) VALUES(p_job,'retry_requested',actor,jsonb_build_object('reason',btrim(p_reason)));
 RETURN jsonb_build_object('job_id',p_job,'status','queued');
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA fieldmerge_ops FROM PUBLIC,fieldmerge_api,fieldmerge_worker;
REVOKE ALL ON FUNCTION queue_submission_recovery(),_reserve_for_author(uuid,uuid,uuid,integer,text,text,timestamptz),
 _recovery_lease(uuid,uuid),worker_register_draft(uuid,uuid),worker_claim(uuid),worker_context(uuid,uuid),worker_form(text),
 worker_reserve_draft(uuid,uuid,uuid,uuid,integer,text,text,timestamptz),worker_finish_submission(uuid,uuid,text,jsonb),
 worker_complete(uuid,uuid),worker_fail(uuid,uuid,text),api_recovery_jobs(text),api_recovery_detail(text,uuid),api_recovery_retry(text,uuid,text)
 FROM PUBLIC,fieldmerge_api,fieldmerge_worker;
GRANT EXECUTE ON FUNCTION worker_register_draft(uuid,uuid),worker_claim(uuid),worker_context(uuid,uuid),worker_form(text),
 worker_reserve_draft(uuid,uuid,uuid,uuid,integer,text,text,timestamptz),worker_finish_submission(uuid,uuid,text,jsonb),worker_complete(uuid,uuid),worker_fail(uuid,uuid,text) TO fieldmerge_worker;
GRANT EXECUTE ON FUNCTION api_recovery_jobs(text),api_recovery_detail(text,uuid),api_recovery_retry(text,uuid,text) TO fieldmerge_api;
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES('007',:'migration_hash');
COMMIT;

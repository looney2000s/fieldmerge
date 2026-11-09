\set ON_ERROR_STOP on
BEGIN;
SET search_path=fieldmerge,public;
CREATE SCHEMA fieldmerge_auth;
REVOKE ALL ON SCHEMA fieldmerge_auth FROM PUBLIC;
CREATE TABLE fieldmerge_auth.sessions (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid NOT NULL REFERENCES fieldmerge.app_users, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sessions_user ON fieldmerge_auth.sessions(user_id);
CREATE TABLE fieldmerge_auth.login_attempts (
 attempt_key text PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL
);
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='fieldmerge_api')
 THEN CREATE ROLE fieldmerge_api NOLOGIN; END IF; END $$;
GRANT USAGE ON SCHEMA fieldmerge TO fieldmerge_api;

CREATE FUNCTION api_login_allowed(p_key text) RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog AS $$
 INSERT INTO fieldmerge_auth.login_attempts VALUES(p_key,clock_timestamp(),1)
 ON CONFLICT(attempt_key) DO UPDATE SET
 attempts=CASE WHEN fieldmerge_auth.login_attempts.window_start<clock_timestamp()-interval '5 minutes' THEN 1 ELSE fieldmerge_auth.login_attempts.attempts+1 END,
 window_start=CASE WHEN fieldmerge_auth.login_attempts.window_start<clock_timestamp()-interval '5 minutes' THEN clock_timestamp() ELSE fieldmerge_auth.login_attempts.window_start END
 RETURNING attempts<=10
$$;
CREATE FUNCTION api_credentials(p_email text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('user_id',user_id,'password_hash',password_hash)
 FROM fieldmerge.app_users WHERE email=p_email AND is_active
$$;
CREATE FUNCTION api_create_session(p_user uuid,p_hash text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT FROM fieldmerge.app_users WHERE user_id=p_user AND is_active)
 THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
 INSERT INTO fieldmerge_auth.sessions(token_hash,user_id,expires_at) VALUES(p_hash,p_user,clock_timestamp()+interval '8 hours');
END $$;
CREATE FUNCTION api_logout(p_hash text) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog AS $$ DELETE FROM fieldmerge_auth.sessions WHERE token_hash=p_hash $$;

CREATE FUNCTION _api_actor(p_hash text,p_role text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ DECLARE actor uuid; actual_role text; BEGIN
 SELECT u.user_id,u.role INTO actor,actual_role FROM fieldmerge_auth.sessions s JOIN fieldmerge.app_users u USING(user_id)
 WHERE token_hash=p_hash AND expires_at>clock_timestamp() AND u.is_active;
 IF actor IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='28000'; END IF;
 IF p_role IS NOT NULL AND actual_role<>p_role THEN RAISE EXCEPTION 'role denied' USING ERRCODE='42501'; END IF;
 RETURN actor;
END $$;
CREATE FUNCTION api_me(p_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ DECLARE actor uuid=fieldmerge._api_actor(p_hash); BEGIN
 RETURN (SELECT jsonb_build_object('user_id',user_id,'email',email,'display_name',display_name,'role',role) FROM fieldmerge.app_users WHERE user_id=actor);
END $$;
CREATE FUNCTION api_records(p_hash text,p_limit integer DEFAULT 50) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_hash);
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM
 (SELECT * FROM fieldmerge.latest_accepted_records ORDER BY source_record_id LIMIT least(greatest(p_limit,1),100)) r),'[]');
END $$;
CREATE FUNCTION api_snapshot(p_hash text,p_record uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_hash);
 RETURN (SELECT to_jsonb(r) FROM fieldmerge.latest_accepted_records r WHERE record_id=p_record);
END $$;
CREATE FUNCTION api_history(p_hash text,p_record uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_hash);
 RETURN jsonb_build_object('versions',coalesce((SELECT jsonb_agg(to_jsonb(v)) FROM
 (SELECT * FROM fieldmerge.accepted_versions WHERE record_id=p_record ORDER BY version_no DESC LIMIT 100) v),'[]'),
 'provenance',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM fieldmerge.field_value_provenance p
 WHERE record_id=p_record AND version_no=(SELECT max(v.version_no) FROM fieldmerge.accepted_versions v WHERE v.record_id=p_record)),'[]'));
END $$;

CREATE FUNCTION api_reserve_submission(p_token text,p_client uuid,p_record uuid,p_base integer,p_form text,p_hash text,p_observed timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token,'surveyor'); s fieldmerge.submissions%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_client::text,1));
 SELECT * INTO s FROM fieldmerge.submissions WHERE author_id=actor AND client_submission_id=p_client;
 IF FOUND THEN
  IF s.payload_hash IS DISTINCT FROM p_hash OR s.record_id IS DISTINCT FROM p_record OR s.base_version_no IS DISTINCT FROM p_base
   OR s.form_version IS DISTINCT FROM p_form OR s.observed_at IS DISTINCT FROM p_observed
  THEN RAISE EXCEPTION 'submission key reused with different content' USING ERRCODE='22023'; END IF;
  RETURN to_jsonb(s)-'verified_patch';
 END IF;
 IF NOT EXISTS(SELECT FROM fieldmerge.tree_records r JOIN fieldmerge.accepted_versions v USING(record_id)
 WHERE r.record_id=p_record AND r.is_active AND v.version_no=p_base)
 THEN RAISE EXCEPTION 'invalid active record or base version' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM fieldmerge.form_versions WHERE form_version=p_form AND is_supported)
 THEN RAISE EXCEPTION 'unsupported form' USING ERRCODE='22023'; END IF;
 INSERT INTO fieldmerge.submissions(submission_id,author_id,client_submission_id,record_id,base_version_no,form_version,payload_hash,observed_at)
 VALUES(gen_random_uuid(),actor,p_client,p_record,p_base,p_form,p_hash,p_observed) RETURNING * INTO s;
 RETURN to_jsonb(s)-'verified_patch';
END $$;
CREATE FUNCTION api_form(p_token text,p_form text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token);
 RETURN (SELECT to_jsonb(f) FROM fieldmerge.form_versions f WHERE form_version=p_form);
END $$;
CREATE FUNCTION api_finish_submission(p_token text,p_submission uuid,p_hash text,p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token,'surveyor'); target uuid; s fieldmerge.submissions%ROWTYPE;
BEGIN
 SELECT record_id INTO target FROM fieldmerge.submissions WHERE submission_id=p_submission AND author_id=actor;
 IF target IS NULL THEN RAISE EXCEPTION 'submission not found' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM fieldmerge.tree_records WHERE record_id=target FOR UPDATE;
 SELECT * INTO STRICT s FROM fieldmerge.submissions WHERE submission_id=p_submission FOR UPDATE;
 IF s.payload_hash IS DISTINCT FROM p_hash OR p_patch IS NULL OR jsonb_typeof(p_patch)<>'object'
 THEN RAISE EXCEPTION 'source integrity mismatch' USING ERRCODE='22023'; END IF;
 IF s.source_verified_at IS NULL THEN
  UPDATE fieldmerge.submissions SET verified_patch=p_patch,source_verified_at=clock_timestamp(),state='ready',updated_at=clock_timestamp() WHERE submission_id=p_submission;
 ELSIF s.verified_patch IS DISTINCT FROM p_patch THEN
  RAISE EXCEPTION 'verified patch mismatch' USING ERRCODE='22023';
 END IF;
 RETURN fieldmerge.reconcile_submission(p_submission,p_hash);
END $$;
CREATE FUNCTION api_submission(p_token text,p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ DECLARE actor uuid=fieldmerge._api_actor(p_token); BEGIN
 RETURN (SELECT jsonb_build_object('submission',to_jsonb(s)-'verified_patch','changes',
 coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM fieldmerge.field_changes c WHERE c.submission_id=s.submission_id),'[]'))
 FROM fieldmerge.submissions s WHERE submission_id=p_submission AND (author_id=actor OR EXISTS
 (SELECT FROM fieldmerge.app_users WHERE user_id=actor AND role='reviewer')));
END $$;
CREATE FUNCTION api_pending(p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token,'reviewer');
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT * FROM fieldmerge.pending_field_reviews ORDER BY updated_at LIMIT 100) r),'[]');
END $$;
CREATE FUNCTION api_decide(p_token text,p_key uuid,p_change uuid,p_version integer,p_revision integer,p_action text,p_chosen jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token,'reviewer'); BEGIN
 RETURN fieldmerge.review_change(actor,p_key,p_change,p_version,p_revision,p_action,p_chosen,p_reason);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA fieldmerge_auth FROM PUBLIC,fieldmerge_api;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fieldmerge FROM PUBLIC;
REVOKE ALL ON FUNCTION _api_actor(text,text) FROM fieldmerge_api;
GRANT EXECUTE ON FUNCTION api_login_allowed(text),api_credentials(text),api_create_session(uuid,text),api_logout(text),api_me(text),
 api_records(text,integer),api_snapshot(text,uuid),api_history(text,uuid),api_reserve_submission(text,uuid,uuid,integer,text,text,timestamptz),
 api_form(text,text),api_finish_submission(text,uuid,text,jsonb),api_submission(text,uuid),api_pending(text),
 api_decide(text,uuid,uuid,integer,integer,text,jsonb,text) TO fieldmerge_api;
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES('004',:'migration_hash');
COMMIT;

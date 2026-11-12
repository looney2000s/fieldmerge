\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE fieldmerge_ops.security_events (
 request_id uuid PRIMARY KEY,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 actor_id uuid REFERENCES fieldmerge.app_users(user_id),
 actor_role text CHECK(actor_role IN ('surveyor','reviewer')),
 method text NOT NULL CHECK(method IN ('GET','POST','PUT','DELETE','HEAD','OPTIONS','OTHER')),
 route_template varchar(100) NOT NULL CHECK(route_template ~ '^/api/[a-z/:._-]+$'),
 target_id uuid,
 http_status smallint NOT NULL CHECK(http_status BETWEEN 400 AND 599),
 error_code varchar(80) NOT NULL CHECK(error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
 sqlstate varchar(5) CHECK(sqlstate ~ '^[A-Z0-9]{5}$'),
 CHECK((actor_id IS NULL)=(actor_role IS NULL))
);
CREATE INDEX security_events_recent ON fieldmerge_ops.security_events(occurred_at DESC,request_id DESC);
CREATE TRIGGER immutable_security_events BEFORE UPDATE OR DELETE ON fieldmerge_ops.security_events
 FOR EACH ROW EXECUTE FUNCTION fieldmerge.block_history_mutation();
REVOKE ALL ON fieldmerge_ops.security_events FROM PUBLIC,fieldmerge_api,fieldmerge_worker;

-- Called after the request transaction has failed, using an independent connection.
-- A session is identified here even if expired/inactive; this grants no access.
-- Neither its token nor its hash is stored in the event.
CREATE FUNCTION fieldmerge.api_record_security_event(p_request uuid,p_session text,p_method text,
 p_route text,p_target uuid,p_status integer,p_code text,p_sqlstate text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid;role_name text;BEGIN
 IF p_session IS NOT NULL AND p_session !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'invalid session reference' USING ERRCODE='22023';END IF;
 SELECT s.user_id,u.role INTO actor,role_name FROM fieldmerge_auth.sessions s
 JOIN fieldmerge.app_users u USING(user_id) WHERE s.token_hash=p_session;
 INSERT INTO fieldmerge_ops.security_events(request_id,actor_id,actor_role,method,
 route_template,target_id,http_status,error_code,sqlstate)
 VALUES(p_request,actor,role_name,p_method,p_route,p_target,p_status,p_code,p_sqlstate)
 ON CONFLICT(request_id) DO NOTHING;
END $$;
CREATE FUNCTION fieldmerge.api_security_events(p_session text,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_session,'reviewer');
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'invalid event limit' USING ERRCODE='22023';END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY occurred_at DESC,request_id DESC)
 FROM (SELECT * FROM fieldmerge_ops.security_events ORDER BY occurred_at DESC,request_id DESC LIMIT p_limit) q),'[]');
END $$;
REVOKE ALL ON FUNCTION fieldmerge.api_record_security_event(uuid,text,text,text,uuid,integer,text,text),
 fieldmerge.api_security_events(text,integer) FROM PUBLIC,fieldmerge_worker;
GRANT EXECUTE ON FUNCTION fieldmerge.api_record_security_event(uuid,text,text,text,uuid,integer,text,text),
 fieldmerge.api_security_events(text,integer) TO fieldmerge_api;
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES('010',:'migration_hash');
COMMIT;

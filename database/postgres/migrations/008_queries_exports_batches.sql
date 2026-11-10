\set ON_ERROR_STOP on
BEGIN;
SET search_path=fieldmerge,public;
CREATE FUNCTION _accepted_selection(p_source text,p_species text,p_health text,p_active boolean,p_after uuid,p_cap integer)
RETURNS SETOF fieldmerge.latest_accepted_records LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN
 IF p_cap IS NULL OR p_cap NOT BETWEEN 1 AND 5001 OR
  (p_source IS NOT NULL AND length(btrim(p_source)) NOT BETWEEN 1 AND 120) OR
  (p_species IS NOT NULL AND length(btrim(p_species)) NOT BETWEEN 1 AND 120) OR
  (p_health IS NOT NULL AND p_health NOT IN ('Good','Fair','Poor','unknown'))
 THEN RAISE EXCEPTION 'invalid record filters' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT v.* FROM fieldmerge.latest_accepted_records v WHERE
  (p_source IS NULL OR strpos(lower(v.source_record_id),lower(p_source))>0) AND
  (p_species IS NULL OR strpos(lower(v.species),lower(p_species))>0) AND
  (p_health IS NULL OR p_health='unknown' AND v.health IS NULL OR v.health=p_health) AND
  (p_active IS NULL OR v.is_active=p_active) AND (p_after IS NULL OR v.record_id>p_after)
 ORDER BY v.record_id LIMIT p_cap;
END $$;
CREATE FUNCTION api_records_page(p_token text,p_source text,p_species text,p_health text,p_active boolean,p_after uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token);
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid page limit' USING ERRCODE='22023';END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY record_id) FROM fieldmerge._accepted_selection(p_source,p_species,p_health,p_active,p_after,p_limit+1) v),'[]');
END $$;
CREATE FUNCTION api_accepted_export(p_token text,p_source text,p_species text,p_health text,p_active boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token,'reviewer');
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(v)||jsonb_build_object('diameter_cm',v.diameter_cm::text) ORDER BY record_id)
 FROM fieldmerge._accepted_selection(p_source,p_species,p_health,p_active,NULL,5001) v),'[]');
END $$;
CREATE FUNCTION api_snapshot_download(p_token text,p_record uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE v fieldmerge.accepted_versions%ROWTYPE;BEGIN
 PERFORM fieldmerge._api_actor(p_token);
 IF p_version IS NOT NULL AND p_version<1 THEN RAISE EXCEPTION 'invalid version' USING ERRCODE='22023';END IF;
 SELECT * INTO v FROM fieldmerge.accepted_versions WHERE record_id=p_record AND (p_version IS NULL OR version_no=p_version) ORDER BY version_no DESC LIMIT 1;
 IF NOT FOUND THEN RETURN NULL;END IF;
 RETURN (SELECT jsonb_build_object('format','fieldmerge-snapshot-v1','exported_at',clock_timestamp(),
  'campaign',jsonb_build_object('campaign_id',sc.campaign_id,'name',sc.name,'starts_at',sc.starts_at,'ends_at',sc.ends_at,'source_url',sc.source_url),
  'record',to_jsonb(v)||jsonb_build_object('source_record_id',r.source_record_id,'is_active',r.is_active),
  'supported_forms',coalesce((SELECT jsonb_agg(form_version ORDER BY form_version) FROM fieldmerge.form_versions WHERE is_supported),'[]'))
  FROM fieldmerge.tree_records r JOIN fieldmerge.survey_campaigns sc USING(campaign_id) WHERE r.record_id=p_record);
END $$;
CREATE FUNCTION api_reviews_page(p_token text,p_record uuid,p_field text,p_author uuid,p_from timestamptz,p_to timestamptz,p_after uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token,'reviewer');
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR
 (p_field IS NOT NULL AND p_field NOT IN ('species','health','diameter_cm','guard_damage')) OR
 (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from>=p_to)
 THEN RAISE EXCEPTION 'invalid review filters' USING ERRCODE='22023';END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY change_id) FROM
  (SELECT * FROM fieldmerge.pending_field_reviews WHERE (p_record IS NULL OR record_id=p_record) AND
  (p_field IS NULL OR field_name=p_field) AND (p_author IS NULL OR author_id=p_author) AND
  (p_from IS NULL OR received_at>=p_from) AND (p_to IS NULL OR received_at<p_to) AND (p_after IS NULL OR change_id>p_after)
  ORDER BY change_id LIMIT p_limit+1) v),'[]');
END $$;
CREATE FUNCTION api_sql_summary(p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token,'reviewer');
 RETURN (WITH pending_records AS (
  SELECT c.record_id,count(*) FILTER(WHERE c.state='pending') AS pending_fields,min(s.received_at) FILTER(WHERE c.state='pending') AS oldest_received_at
  FROM fieldmerge.field_changes c JOIN fieldmerge.submissions s USING(submission_id) GROUP BY c.record_id HAVING count(*) FILTER(WHERE c.state='pending')>0
 ) SELECT jsonb_build_object('as_of',statement_timestamp(),'accepted_records',(SELECT count(*) FROM fieldmerge.latest_accepted_records),
  'active_records',(SELECT count(*) FROM fieldmerge.tree_records WHERE is_active),'version_snapshots',(SELECT count(*) FROM fieldmerge.accepted_versions),
  'submissions',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY state) FROM (SELECT state,count(*) AS count FROM fieldmerge.submissions GROUP BY state) q),'[]'),
  'field_outcomes',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY state) FROM (SELECT state,count(*) AS count FROM fieldmerge.field_changes GROUP BY state) q),'[]'),
  'classifications',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY classification) FROM (SELECT classification,count(*) AS count FROM fieldmerge.field_changes GROUP BY classification) q),'[]'),
  'review_actions',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY action) FROM (SELECT action,count(*) AS count FROM fieldmerge.review_decisions GROUP BY action) q),'[]'),
  'unresolved_record_count',(SELECT count(*) FROM pending_records),
  'oldest_pending_records',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY oldest_received_at,record_id) FROM (SELECT * FROM pending_records ORDER BY oldest_received_at,record_id LIMIT 10) q),'[]')));
END $$;

CREATE TABLE fieldmerge_ops.intake_batches (
 batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL REFERENCES app_users,client_batch_id uuid NOT NULL,
 manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),item_count integer NOT NULL CHECK(item_count BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(owner_id,client_batch_id)
);
CREATE TABLE fieldmerge_ops.batch_items (
 batch_id uuid NOT NULL REFERENCES fieldmerge_ops.intake_batches,item_index integer NOT NULL CHECK(item_index BETWEEN 0 AND 99),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),submission_id uuid REFERENCES submissions,error_code varchar(80),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(batch_id,item_index),
 CHECK(error_code IS NULL OR error_code ~ '^[a-z_]{1,80}$')
);
CREATE INDEX batch_items_submission ON fieldmerge_ops.batch_items(submission_id) WHERE submission_id IS NOT NULL;
CREATE INDEX submissions_first_batch ON submissions(batch_id) WHERE batch_id IS NOT NULL;
ALTER TABLE submissions ADD CONSTRAINT submission_first_batch_fk FOREIGN KEY(batch_id) REFERENCES fieldmerge_ops.intake_batches;
GRANT SELECT ON fieldmerge_ops.intake_batches,fieldmerge_ops.batch_items TO fieldmerge_workflow;
GRANT UPDATE(submission_id,error_code,updated_at) ON fieldmerge_ops.batch_items TO fieldmerge_workflow;
CREATE TRIGGER immutable_intake_batches BEFORE UPDATE OR DELETE ON fieldmerge_ops.intake_batches FOR EACH ROW EXECUTE FUNCTION block_history_mutation();
CREATE FUNCTION guard_batch_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'batch membership cannot be deleted' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='submissions' THEN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id AND (OLD.batch_id IS NOT NULL OR OLD.source_verified_at IS NOT NULL)
  THEN RAISE EXCEPTION 'first intake batch is immutable' USING ERRCODE='42501';END IF;
 ELSE
  IF ROW(NEW.batch_id,NEW.item_index,NEW.content_hash) IS DISTINCT FROM ROW(OLD.batch_id,OLD.item_index,OLD.content_hash) OR
   OLD.submission_id IS NOT NULL AND NEW.submission_id IS DISTINCT FROM OLD.submission_id
  THEN RAISE EXCEPTION 'batch manifest or source link is immutable' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER immutable_first_batch BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION guard_batch_identity();
CREATE TRIGGER immutable_batch_item BEFORE UPDATE OR DELETE ON fieldmerge_ops.batch_items FOR EACH ROW EXECUTE FUNCTION guard_batch_identity();
CREATE FUNCTION check_batch_graph() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE id uuid=NEW.batch_id;b fieldmerge_ops.intake_batches%ROWTYPE;hash text;n integer;BEGIN
 SELECT * INTO b FROM fieldmerge_ops.intake_batches WHERE batch_id=id;
 SELECT count(*),encode(sha256(convert_to(coalesce(jsonb_agg(content_hash ORDER BY item_index),'[]')::text,'UTF8')),'hex') INTO n,hash FROM fieldmerge_ops.batch_items WHERE batch_id=id;
 IF n<>b.item_count OR hash IS DISTINCT FROM b.manifest_hash OR EXISTS(SELECT FROM fieldmerge_ops.batch_items i LEFT JOIN fieldmerge.submissions s USING(submission_id)
  WHERE i.batch_id=id AND (i.item_index>=b.item_count OR i.submission_id IS NOT NULL AND (s.author_id IS DISTINCT FROM b.owner_id OR s.payload_hash IS DISTINCT FROM i.content_hash)))
 THEN RAISE EXCEPTION 'workflow integrity: batch manifest or source ownership mismatch' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='submissions' AND id IS NOT NULL AND NOT EXISTS(SELECT FROM fieldmerge_ops.batch_items WHERE batch_id=id AND submission_id=(to_jsonb(NEW)->>'submission_id')::uuid)
 THEN RAISE EXCEPTION 'workflow integrity: first intake batch lacks membership' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER consistent_intake_batch AFTER INSERT ON fieldmerge_ops.intake_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_batch_graph();
CREATE CONSTRAINT TRIGGER consistent_batch_item AFTER INSERT OR UPDATE ON fieldmerge_ops.batch_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_batch_graph();
CREATE CONSTRAINT TRIGGER consistent_submission_batch AFTER INSERT OR UPDATE ON submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.batch_id IS NOT NULL) EXECUTE FUNCTION check_batch_graph();

CREATE FUNCTION api_register_batch(p_token text,p_client uuid,p_hashes jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token,'surveyor');b fieldmerge_ops.intake_batches%ROWTYPE;hash text;BEGIN
 IF p_client IS NULL OR jsonb_typeof(p_hashes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid batch manifest' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(p_hashes) NOT BETWEEN 1 AND 100 OR EXISTS(SELECT FROM jsonb_array_elements(p_hashes) x WHERE jsonb_typeof(x)<>'string' OR (x #>> '{}') !~ '^[a-f0-9]{64}$')
 THEN RAISE EXCEPTION 'invalid batch manifest' USING ERRCODE='22023';END IF;
 hash:=encode(sha256(convert_to(p_hashes::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_client::text,2));
 SELECT * INTO b FROM fieldmerge_ops.intake_batches WHERE owner_id=actor AND client_batch_id=p_client;
 IF FOUND THEN IF b.manifest_hash IS DISTINCT FROM hash THEN RAISE EXCEPTION 'batch identity conflict' USING ERRCODE='22023';END IF;
 ELSE
  INSERT INTO fieldmerge_ops.intake_batches(owner_id,client_batch_id,manifest_hash,item_count) VALUES(actor,p_client,hash,jsonb_array_length(p_hashes)) RETURNING * INTO b;
  INSERT INTO fieldmerge_ops.batch_items(batch_id,item_index,content_hash) SELECT b.batch_id,ordinality::integer-1,value #>> '{}' FROM jsonb_array_elements(p_hashes) WITH ORDINALITY;
 END IF;RETURN jsonb_build_object('batch_id',b.batch_id,'client_batch_id',b.client_batch_id,'item_count',b.item_count);
END $$;
CREATE FUNCTION api_reserve_batch_item(p_token text,p_batch uuid,p_index integer,p_client uuid,p_record uuid,p_base integer,p_form text,p_hash text,p_observed timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token,'surveyor');i fieldmerge_ops.batch_items%ROWTYPE;s jsonb;existed boolean;BEGIN
 SELECT bi.* INTO i FROM fieldmerge_ops.batch_items bi JOIN fieldmerge_ops.intake_batches b USING(batch_id)
 WHERE bi.batch_id=p_batch AND bi.item_index=p_index AND b.owner_id=actor FOR UPDATE OF bi;
 IF NOT FOUND THEN RAISE EXCEPTION 'batch item not found' USING ERRCODE='P0002';END IF;
 IF i.content_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'batch item content mismatch' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_client::text,1));
 SELECT EXISTS(SELECT FROM fieldmerge.submissions WHERE author_id=actor AND client_submission_id=p_client) INTO existed;
 s:=fieldmerge._reserve_for_author(actor,p_client,p_record,p_base,p_form,p_hash,p_observed);
 IF NOT existed THEN UPDATE fieldmerge.submissions SET batch_id=p_batch WHERE submission_id=(s->>'submission_id')::uuid;s:=s||jsonb_build_object('batch_id',p_batch);END IF;
 UPDATE fieldmerge_ops.batch_items SET submission_id=(s->>'submission_id')::uuid,error_code=NULL,updated_at=clock_timestamp() WHERE batch_id=p_batch AND item_index=p_index;
 RETURN s;
END $$;
ALTER FUNCTION api_reserve_batch_item(text,uuid,integer,uuid,uuid,integer,text,text,timestamptz) OWNER TO fieldmerge_workflow;
CREATE FUNCTION api_batch_error(p_token text,p_batch uuid,p_index integer,p_code text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token,'surveyor');BEGIN
 IF p_code IS NULL OR p_code !~ '^[a-z_]{1,80}$' THEN RAISE EXCEPTION 'invalid item error' USING ERRCODE='22023';END IF;
 UPDATE fieldmerge_ops.batch_items i SET error_code=p_code,updated_at=clock_timestamp() FROM fieldmerge_ops.intake_batches b WHERE i.batch_id=b.batch_id AND b.batch_id=p_batch AND b.owner_id=actor AND i.item_index=p_index;
 IF NOT FOUND THEN RAISE EXCEPTION 'batch item not found' USING ERRCODE='P0002';END IF;
END $$;
CREATE FUNCTION api_batch_detail(p_token text,p_batch uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token);BEGIN
 RETURN (SELECT jsonb_build_object('batch_id',b.batch_id,'owner_id',b.owner_id,'client_batch_id',b.client_batch_id,'item_count',b.item_count,'created_at',b.created_at,
 'items',(SELECT jsonb_agg(jsonb_build_object('index',i.item_index,'submission_id',i.submission_id,'state',s.state,'error',i.error_code,
 'processed',s.reconciliation_result IS NOT NULL,'first_intake_batch_id',s.batch_id) ORDER BY i.item_index) FROM fieldmerge_ops.batch_items i LEFT JOIN fieldmerge.submissions s USING(submission_id) WHERE i.batch_id=b.batch_id))
 FROM fieldmerge_ops.intake_batches b WHERE batch_id=p_batch AND (owner_id=actor OR EXISTS(SELECT FROM fieldmerge.app_users WHERE user_id=actor AND role='reviewer')));
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA fieldmerge_ops FROM PUBLIC,fieldmerge_api,fieldmerge_worker;
REVOKE ALL ON FUNCTION _accepted_selection(text,text,text,boolean,uuid,integer),api_records_page(text,text,text,text,boolean,uuid,integer),api_accepted_export(text,text,text,text,boolean),
 api_snapshot_download(text,uuid,integer),api_reviews_page(text,uuid,text,uuid,timestamptz,timestamptz,uuid,integer),api_sql_summary(text),guard_batch_identity(),check_batch_graph(),
 api_register_batch(text,uuid,jsonb),api_reserve_batch_item(text,uuid,integer,uuid,uuid,integer,text,text,timestamptz),api_batch_error(text,uuid,integer,text),api_batch_detail(text,uuid) FROM PUBLIC,fieldmerge_api,fieldmerge_worker;
GRANT EXECUTE ON FUNCTION api_records_page(text,text,text,text,boolean,uuid,integer),api_accepted_export(text,text,text,text,boolean),api_snapshot_download(text,uuid,integer),
 api_reviews_page(text,uuid,text,uuid,timestamptz,timestamptz,uuid,integer),api_sql_summary(text),api_register_batch(text,uuid,jsonb),
 api_reserve_batch_item(text,uuid,integer,uuid,uuid,integer,text,text,timestamptz),api_batch_error(text,uuid,integer,text),api_batch_detail(text,uuid) TO fieldmerge_api;
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES('008',:'migration_hash');
COMMIT;

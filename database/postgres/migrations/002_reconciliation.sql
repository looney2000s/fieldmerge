\set ON_ERROR_STOP on
BEGIN;
SET search_path=fieldmerge,public;

-- Trusted intake will store the verified source's scalar patch here. This function
-- never accepts an arbitrary replacement patch from the caller on each retry.
ALTER TABLE submissions ADD COLUMN verified_patch jsonb;
ALTER TABLE submissions ADD COLUMN reconciliation_result jsonb;

CREATE FUNCTION protect_verified_submission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,fieldmerge AS $$
BEGIN
 IF OLD.source_verified_at IS NOT NULL AND
 ROW(NEW.author_id,NEW.client_submission_id,NEW.record_id,NEW.base_version_no,
     NEW.form_version,NEW.payload_hash,NEW.observed_at,NEW.received_at,NEW.verified_patch,NEW.source_verified_at)
 IS DISTINCT FROM
 ROW(OLD.author_id,OLD.client_submission_id,OLD.record_id,OLD.base_version_no,
     OLD.form_version,OLD.payload_hash,OLD.observed_at,OLD.received_at,OLD.verified_patch,OLD.source_verified_at)
 THEN RAISE EXCEPTION 'verified source metadata is immutable' USING ERRCODE='42501'; END IF;
 IF OLD.reconciliation_result IS NOT NULL AND NEW.reconciliation_result IS DISTINCT FROM OLD.reconciliation_result
 THEN RAISE EXCEPTION 'initial reconciliation receipt is immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_verified_submission BEFORE UPDATE ON submissions
 FOR EACH ROW EXECUTE FUNCTION protect_verified_submission();

CREATE FUNCTION reconcile_submission(p_submission_id uuid,p_expected_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER VOLATILE
SET search_path=pg_catalog,fieldmerge AS $$
DECLARE
 s fieldmerge.submissions%ROWTYPE; tree fieldmerge.tree_records%ROWTYPE;
 current_v fieldmerge.accepted_versions%ROWTYPE; base_v fieldmerge.accepted_versions%ROWTYPE;
 campaign fieldmerge.survey_campaigns%ROWTYPE;
 target uuid; patch jsonb; snapshot jsonb; base_snapshot jsonb; proposed jsonb;
 b jsonb; c jsonb; f text; value jsonb; h boolean;
 items jsonb='[]'; item jsonb; classification text; disposition text; reason text;
 applied integer=0; pending integer=0; next_version integer;
 failure text; warning text; result jsonb; final_state text;
BEGIN
 -- All publishers must take the tree lock before the submission/change lock.
 SELECT record_id INTO target FROM fieldmerge.submissions WHERE submission_id=p_submission_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'submission not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO STRICT tree FROM fieldmerge.tree_records WHERE record_id=target FOR UPDATE;
 SELECT * INTO STRICT s FROM fieldmerge.submissions WHERE submission_id=p_submission_id FOR UPDATE;
 IF p_expected_hash IS NULL OR p_expected_hash IS DISTINCT FROM s.payload_hash
 THEN RAISE EXCEPTION 'source hash mismatch' USING ERRCODE='22023'; END IF;
 -- Return the original committed receipt even if the reviewer later changes state.
 IF s.reconciliation_result IS NOT NULL THEN RETURN s.reconciliation_result; END IF;
 IF s.source_verified_at IS NULL OR s.verified_patch IS NULL
 THEN RAISE EXCEPTION 'verified source and patch required' USING ERRCODE='55000'; END IF;
 IF s.state NOT IN ('ready','processing')
 THEN RAISE EXCEPTION 'submission is not ready for reconciliation' USING ERRCODE='55000'; END IF;
 IF s.state='processing' AND s.lease_expires_at > clock_timestamp()
 THEN RAISE EXCEPTION 'submission has an active processing lease' USING ERRCODE='55P03'; END IF;
 IF EXISTS(SELECT FROM fieldmerge.field_changes WHERE submission_id=p_submission_id)
 THEN RAISE EXCEPTION 'unreceipted submission already contains changes' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT FROM fieldmerge.app_users WHERE user_id=s.author_id AND role='surveyor' AND is_active)
 THEN RAISE EXCEPTION 'active surveyor author required' USING ERRCODE='42501'; END IF;
 IF NOT tree.is_active THEN RAISE EXCEPTION 'tree is retired' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT campaign FROM fieldmerge.survey_campaigns WHERE campaign_id=tree.campaign_id;
 SELECT * INTO STRICT current_v FROM fieldmerge.accepted_versions WHERE record_id=target ORDER BY version_no DESC LIMIT 1;
 SELECT * INTO STRICT base_v FROM fieldmerge.accepted_versions WHERE record_id=target AND version_no=s.base_version_no;
 patch:=s.verified_patch;
 IF jsonb_typeof(patch) IS DISTINCT FROM 'object' THEN failure:='patch must be an object';
 ELSIF NOT EXISTS(SELECT FROM fieldmerge.form_versions WHERE form_version=s.form_version AND is_supported)
 THEN failure:='unsupported form';
 ELSIF s.observed_at < campaign.starts_at THEN failure:='observation precedes campaign';
 ELSE
  -- Validate the entire patch before creating any changes or accepted versions.
  FOR f,value IN SELECT key,j.value FROM jsonb_each(patch) j LOOP
   IF f='species' AND jsonb_typeof(value)='string' THEN
    IF length(value #>> '{}')>120 OR (value #>> '{}') ~ '[[:cntrl:]]' THEN failure:='invalid species'; EXIT; END IF;
    value:=to_jsonb(regexp_replace(btrim(value #>> '{}'),'[[:space:]]+',' ','g'));
    patch:=jsonb_set(patch,ARRAY[f],value);
   END IF;
   IF NOT fieldmerge.valid_scalar(f,value) THEN failure:='invalid field: '||f; EXIT; END IF;
  END LOOP;
 END IF;
 IF failure IS NOT NULL THEN
  result:=jsonb_build_object('submission_id',s.submission_id,'state','rejected','reason',failure,'version_no',NULL,'fields','[]'::jsonb);
  UPDATE fieldmerge.submissions SET state='rejected',rejection_reason=failure,
   lease_token=NULL,lease_expires_at=NULL,reconciliation_result=result,updated_at=clock_timestamp() WHERE submission_id=p_submission_id;
  INSERT INTO fieldmerge.audit_events(actor_id,record_id,submission_id,event_type,event_data)
  VALUES(s.author_id,target,p_submission_id,'reconciliation_rejected',jsonb_build_object('reason',failure));
  RETURN result;
 END IF;
 IF s.observed_at > campaign.ends_at THEN warning:='campaign_warning';
 ELSIF s.observed_at > s.received_at+interval '5 minutes' THEN warning:='clock_warning';
 ELSIF s.requires_review THEN warning:=CASE WHEN s.warnings ? 'campaign_warning' THEN 'campaign_warning' ELSE 'clock_warning' END;
 END IF;
 UPDATE fieldmerge.submissions SET state='processing',lease_token=gen_random_uuid(),
  lease_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
 WHERE submission_id=p_submission_id;
 snapshot:=jsonb_build_object('species',current_v.species,'health',current_v.health,'diameter_cm',current_v.diameter_cm,'guard_damage',current_v.guard_damage);
 base_snapshot:=jsonb_build_object('species',base_v.species,'health',base_v.health,'diameter_cm',base_v.diameter_cm,'guard_damage',base_v.guard_damage);
 proposed:=snapshot;
 FOR f,value IN SELECT key,j.value FROM jsonb_each(patch) j ORDER BY key LOOP
  b:=base_snapshot->f; c:=snapshot->f; reason:=NULL;
  SELECT EXISTS(
   SELECT FROM fieldmerge.accepted_versions v JOIN fieldmerge.accepted_versions prev
    ON prev.record_id=v.record_id AND prev.version_no=v.parent_version_no
   WHERE v.record_id=target AND v.version_no>s.base_version_no
    AND (to_jsonb(v)->f) IS DISTINCT FROM (to_jsonb(prev)->f)
  ) INTO h;
  IF NOT h AND c IS DISTINCT FROM b THEN
   RAISE EXCEPTION 'accepted history is inconsistent' USING ERRCODE='23514';
  END IF;
  IF value=b THEN classification:='no_change'; disposition:='no_change';
  ELSIF value=c THEN classification:='already_represented'; disposition:='already_represented';
  ELSIF h THEN classification:='conflict'; disposition:='pending';
   reason:=CASE WHEN c=b THEN 'intervening_edit' ELSE 'value_conflict' END;
  ELSE classification:='compatible';
   IF warning IS NOT NULL THEN disposition:='pending'; reason:=warning;
   ELSE disposition:='applied'; proposed:=jsonb_set(proposed,ARRAY[f],value); END IF;
  END IF;
  IF disposition='applied' THEN applied:=applied+1; END IF;
  IF disposition='pending' THEN pending:=pending+1; END IF;
  items:=items||jsonb_build_array(jsonb_build_object('change_id',gen_random_uuid(),
   'field_name',f,'base_value',b,'proposed_value',value,'compared_value',c,
   'classification',classification,'state',disposition,'pending_reason',reason));
 END LOOP;
 IF applied>0 THEN
  next_version:=current_v.version_no+1;
  INSERT INTO fieldmerge.accepted_versions(record_id,version_no,parent_version_no,species,health,diameter_cm,guard_damage,origin_submission_id,published_by)
  VALUES(target,next_version,current_v.version_no,proposed->>'species',proposed->>'health',
   (proposed->>'diameter_cm')::numeric,(proposed->>'guard_damage')::boolean,p_submission_id,s.author_id);
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(items) LOOP
  INSERT INTO fieldmerge.field_changes(change_id,submission_id,record_id,field_name,
   base_value,proposed_value,compared_value,compared_version_no,classification,state,pending_reason,applied_version_no)
  VALUES((item->>'change_id')::uuid,p_submission_id,target,item->>'field_name',
   item->'base_value',item->'proposed_value',item->'compared_value',current_v.version_no,
   item->>'classification',item->>'state',item->>'pending_reason',CASE WHEN item->>'state'='applied' THEN next_version END);
 END LOOP;
 final_state:=CASE WHEN pending>0 AND applied>0 THEN 'partially_applied'
  WHEN pending>0 THEN 'needs_review' WHEN applied>0 THEN 'applied' ELSE 'no_change' END;
 result:=jsonb_build_object('submission_id',s.submission_id,'state',final_state,
  'version_no',next_version,'compared_version_no',current_v.version_no,'fields',items);
 UPDATE fieldmerge.submissions SET state=final_state,lease_token=NULL,lease_expires_at=NULL,
  requires_review=s.requires_review OR warning IS NOT NULL,
  warnings=CASE WHEN warning IS NULL OR warnings ? warning THEN warnings ELSE warnings||to_jsonb(warning) END,
  reconciliation_result=result,updated_at=clock_timestamp() WHERE submission_id=p_submission_id;
 INSERT INTO fieldmerge.audit_events(actor_id,record_id,submission_id,event_type,event_data)
 VALUES(s.author_id,target,p_submission_id,'submission_reconciled',jsonb_build_object(
  'state',final_state,'base_version_no',s.base_version_no,'compared_version_no',current_v.version_no,
  'published_version_no',next_version,'applied_fields',applied,'pending_fields',pending));
 RETURN result;
END $$;

CREATE VIEW field_value_provenance AS
WITH values_at_version AS (
 SELECT v.record_id,v.version_no,v.origin_submission_id,v.published_by,v.created_at,
  f.field_name,coalesce(to_jsonb(v)->f.field_name,'null'::jsonb) AS value,
  coalesce(to_jsonb(prev)->f.field_name,'null'::jsonb) AS previous_value
 FROM accepted_versions v LEFT JOIN accepted_versions prev
 ON prev.record_id=v.record_id AND prev.version_no=v.parent_version_no
 CROSS JOIN (VALUES('species'),('health'),('diameter_cm'),('guard_damage')) f(field_name)
), actual_changes AS (
 SELECT * FROM values_at_version WHERE version_no=1 OR value IS DISTINCT FROM previous_value
)
SELECT target.record_id,target.version_no,f.field_name,origin.version_no AS origin_version_no,
 origin.value,origin.published_by,origin.created_at,origin.origin_submission_id,
 c.change_id,d.decision_id,d.reviewer_id,d.reason
FROM accepted_versions target
CROSS JOIN (VALUES('species'),('health'),('diameter_cm'),('guard_damage')) f(field_name)
JOIN LATERAL (SELECT * FROM actual_changes a WHERE a.record_id=target.record_id
 AND a.field_name=f.field_name AND a.version_no<=target.version_no ORDER BY a.version_no DESC LIMIT 1) origin ON true
LEFT JOIN field_changes c ON c.record_id=origin.record_id AND c.applied_version_no=origin.version_no AND c.field_name=f.field_name
LEFT JOIN review_decisions d ON d.change_id=c.change_id;

REVOKE ALL ON FUNCTION reconcile_submission(uuid,text) FROM PUBLIC,fieldmerge_app;
REVOKE ALL ON FUNCTION protect_verified_submission() FROM PUBLIC,fieldmerge_app;
REVOKE ALL ON field_value_provenance FROM PUBLIC,fieldmerge_app;
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES('002',:'migration_hash');
COMMIT;

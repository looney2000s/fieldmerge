\set ON_ERROR_STOP on
BEGIN;
SET search_path=fieldmerge,public;

-- Nullable for legacy owner-written rows; all decisions through review_change
-- include an immutable receipt, allowing exact replay after later publications.
ALTER TABLE review_decisions ADD COLUMN decision_result jsonb;

CREATE FUNCTION review_change(
 p_reviewer_id uuid,p_client_decision_id uuid,p_change_id uuid,
 p_expected_version_no integer,p_expected_change_revision integer,
 p_action text,p_chosen_value jsonb,p_reason text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,fieldmerge AS $$
DECLARE
 prior fieldmerge.review_decisions%ROWTYPE;
 change fieldmerge.field_changes%ROWTYPE;
 source fieldmerge.submissions%ROWTYPE;
 tree fieldmerge.tree_records%ROWTYPE;
 current_v fieldmerge.accepted_versions%ROWTYPE;
 target uuid; source_id uuid; fingerprint text; chosen jsonb; current_value jsonb;
 snapshot jsonb; next_version integer; decision uuid=gen_random_uuid();
 disposition text; remaining integer; applied integer; final_state text; result jsonb;
BEGIN
 IF p_reviewer_id IS NULL OR p_client_decision_id IS NULL OR p_change_id IS NULL
 OR p_expected_version_no IS NULL OR p_expected_version_no<1
 OR p_expected_change_revision IS NULL OR p_expected_change_revision<1
 OR p_action IS NULL OR p_action NOT IN ('accept_proposal','keep_current','replace')
 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000
 THEN RAISE EXCEPTION 'invalid review request' USING ERRCODE='22023'; END IF;
 IF (p_action='replace' AND p_chosen_value IS NULL)
 OR (p_action<>'replace' AND p_chosen_value IS NOT NULL)
 THEN RAISE EXCEPTION 'only replace accepts a chosen value; use JSON null for an explicit clear' USING ERRCODE='22023'; END IF;
 -- The caller is a trusted owner/worker; a future authenticated API must derive
 -- this identity from its session. Ordinary application roles have no EXECUTE.
 PERFORM 1 FROM fieldmerge.app_users WHERE user_id=p_reviewer_id AND role='reviewer' AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'active reviewer required' USING ERRCODE='42501'; END IF;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object(
  'change_id',p_change_id,'expected_version_no',p_expected_version_no,
  'expected_change_revision',p_expected_change_revision,'action',p_action,
  'chosen_value',p_chosen_value,'reason',p_reason)::text,'UTF8')),'hex');
 -- Serialize retry identities before locking a tree: the same key can otherwise
 -- race on two different trees. Hash collisions only cause extra serialization.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_reviewer_id::text||':'||p_client_decision_id::text,0));
 SELECT * INTO prior FROM fieldmerge.review_decisions
 WHERE reviewer_id=p_reviewer_id AND client_decision_id=p_client_decision_id;
 IF FOUND THEN
  IF prior.request_hash IS DISTINCT FROM fingerprint THEN
   RAISE EXCEPTION 'decision key reused with different content' USING ERRCODE='22023'; END IF;
  IF prior.decision_result IS NULL THEN RAISE EXCEPTION 'legacy decision requires receipt backfill' USING ERRCODE='55000'; END IF;
  RETURN prior.decision_result;
 END IF;
 SELECT record_id,submission_id INTO target,source_id FROM fieldmerge.field_changes WHERE change_id=p_change_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'field change not found' USING ERRCODE='P0002'; END IF;
 -- Same publication lock order as reconcile_submission.
 SELECT * INTO STRICT tree FROM fieldmerge.tree_records WHERE record_id=target FOR UPDATE;
 SELECT * INTO STRICT source FROM fieldmerge.submissions WHERE submission_id=source_id FOR UPDATE;
 SELECT * INTO STRICT change FROM fieldmerge.field_changes WHERE change_id=p_change_id FOR UPDATE;
 IF change.record_id<>target OR change.submission_id<>source_id THEN
  RAISE EXCEPTION 'field change identity changed' USING ERRCODE='23514'; END IF;
 IF change.state<>'pending' THEN RAISE EXCEPTION 'field change already disposed' USING ERRCODE='55000'; END IF;
 IF source.reconciliation_result IS NULL OR source.source_verified_at IS NULL
 OR source.state NOT IN ('needs_review','partially_applied')
 THEN RAISE EXCEPTION 'submission has not entered a reviewable state' USING ERRCODE='55000'; END IF;
 IF NOT tree.is_active THEN RAISE EXCEPTION 'tree is retired' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT current_v FROM fieldmerge.accepted_versions WHERE record_id=target ORDER BY version_no DESC LIMIT 1;
 IF current_v.version_no<>p_expected_version_no OR change.revision_no<>p_expected_change_revision
 THEN RAISE EXCEPTION 'stale approval; refresh and reconsider' USING ERRCODE='40001'; END IF;
 snapshot:=jsonb_build_object('species',current_v.species,'health',current_v.health,
  'diameter_cm',current_v.diameter_cm,'guard_damage',current_v.guard_damage);
 current_value:=snapshot->change.field_name;
 chosen:=CASE p_action WHEN 'accept_proposal' THEN change.proposed_value
  WHEN 'keep_current' THEN current_value ELSE p_chosen_value END;
 IF change.field_name='species' AND jsonb_typeof(chosen)='string' THEN
  IF length(chosen #>> '{}')>120 OR (chosen #>> '{}') ~ '[[:cntrl:]]' THEN
   RAISE EXCEPTION 'invalid replacement species' USING ERRCODE='22023'; END IF;
  chosen:=to_jsonb(regexp_replace(btrim(chosen #>> '{}'),'[[:space:]]+',' ','g'));
 END IF;
 IF NOT fieldmerge.valid_scalar(change.field_name,chosen) THEN
  RAISE EXCEPTION 'invalid chosen field value' USING ERRCODE='22023'; END IF;
 IF chosen IS DISTINCT FROM current_value THEN
  next_version:=current_v.version_no+1;
  snapshot:=jsonb_set(snapshot,ARRAY[change.field_name],chosen);
  INSERT INTO fieldmerge.accepted_versions(record_id,version_no,parent_version_no,
   species,health,diameter_cm,guard_damage,origin_submission_id,published_by)
  VALUES(target,next_version,current_v.version_no,snapshot->>'species',snapshot->>'health',
   (snapshot->>'diameter_cm')::numeric,(snapshot->>'guard_damage')::boolean,source_id,p_reviewer_id);
  disposition:='applied';
 ELSE
  disposition:=CASE p_action WHEN 'keep_current' THEN 'rejected'
   WHEN 'accept_proposal' THEN 'already_represented' ELSE 'no_change' END;
 END IF;
 UPDATE fieldmerge.field_changes SET state=disposition,pending_reason=NULL,
  applied_version_no=next_version,revision_no=revision_no+1,updated_at=clock_timestamp()
 WHERE change_id=p_change_id;
 SELECT count(*) FILTER(WHERE state='pending'),count(*) FILTER(WHERE state='applied')
 INTO remaining,applied FROM fieldmerge.field_changes WHERE submission_id=source_id;
 final_state:=CASE WHEN remaining=0 THEN 'resolved' WHEN applied>0 THEN 'partially_applied' ELSE 'needs_review' END;
 UPDATE fieldmerge.submissions SET state=final_state,updated_at=clock_timestamp() WHERE submission_id=source_id;
 result:=jsonb_build_object('decision_id',decision,'change_id',p_change_id,'submission_id',source_id,
  'reviewer_id',p_reviewer_id,'action',p_action,'chosen_value',chosen,'field_state',disposition,
  'state',final_state,'version_no',next_version,'reviewed_version_no',current_v.version_no,
  'change_revision',change.revision_no+1);
 INSERT INTO fieldmerge.review_decisions(decision_id,change_id,record_id,reviewer_id,client_decision_id,
  request_hash,expected_version_no,expected_change_revision,action,chosen_value,reason,result_version_no,decision_result)
 VALUES(decision,p_change_id,target,p_reviewer_id,p_client_decision_id,fingerprint,p_expected_version_no,
  p_expected_change_revision,p_action,chosen,btrim(p_reason),next_version,result);
 INSERT INTO fieldmerge.audit_events(actor_id,record_id,submission_id,event_type,event_data)
 VALUES(p_reviewer_id,target,source_id,'field_reviewed',jsonb_build_object('decision_id',decision,
  'change_id',p_change_id,'action',p_action,'reviewed_version_no',current_v.version_no,
  'published_version_no',next_version,'disposition',disposition));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION review_change(uuid,uuid,uuid,integer,integer,text,jsonb,text) FROM PUBLIC,fieldmerge_app;
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES('003',:'migration_hash');
COMMIT;

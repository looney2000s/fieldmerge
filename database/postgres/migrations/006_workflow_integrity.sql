\set ON_ERROR_STOP on
BEGIN;
SET search_path=fieldmerge,public;

-- An execution identity, never a client login or user-supplied session setting.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='fieldmerge_workflow') THEN
  CREATE ROLE fieldmerge_workflow NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='fieldmerge_workflow' AND
 (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
  RAISE EXCEPTION 'unsafe existing workflow role';
 END IF;
END $$;
GRANT USAGE ON SCHEMA fieldmerge TO fieldmerge_workflow;
GRANT SELECT ON app_users,survey_campaigns,tree_records,accepted_versions,form_versions,
 submissions,field_changes,review_decisions,audit_events TO fieldmerge_workflow;
-- PostgreSQL row-locking SELECTs require UPDATE privilege on at least one column.
GRANT UPDATE(user_id) ON app_users TO fieldmerge_workflow;
GRANT UPDATE(record_id) ON tree_records TO fieldmerge_workflow;
GRANT UPDATE ON submissions,field_changes TO fieldmerge_workflow;
GRANT INSERT ON accepted_versions,field_changes,review_decisions,audit_events TO fieldmerge_workflow;
GRANT USAGE ON SEQUENCE audit_events_event_id_seq TO fieldmerge_workflow;
GRANT EXECUTE ON FUNCTION valid_scalar(text,jsonb),_api_actor(text,text) TO fieldmerge_workflow;

-- Retain existing function OIDs and grants, including calls already bound in API functions.
ALTER FUNCTION reconcile_submission(uuid,text) SECURITY DEFINER;
ALTER FUNCTION reconcile_submission(uuid,text) OWNER TO fieldmerge_workflow;
ALTER FUNCTION review_change(uuid,uuid,uuid,integer,integer,text,jsonb,text) SECURITY DEFINER;
ALTER FUNCTION review_change(uuid,uuid,uuid,integer,integer,text,jsonb,text) OWNER TO fieldmerge_workflow;
ALTER FUNCTION api_finish_submission(text,uuid,text,jsonb) OWNER TO fieldmerge_workflow;
REVOKE ALL ON FUNCTION reconcile_submission(uuid,text),
 review_change(uuid,uuid,uuid,integer,integer,text,jsonb,text) FROM PUBLIC,fieldmerge_app,fieldmerge_api;

CREATE FUNCTION guard_workflow_write() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'workflow history cannot be deleted' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='submissions' THEN
  IF TG_OP='INSERT' THEN
   -- Owner-written ready rows are permitted for trusted SQL verification/import tooling.
   -- End-user API roles have no table INSERT privilege.
   IF NEW.state NOT IN ('awaiting_document','ready') AND current_user<>'fieldmerge_workflow'
   THEN RAISE EXCEPTION 'workflow entry point required' USING ERRCODE='42501'; END IF;
  ELSIF current_user<>'fieldmerge_workflow' AND
   (to_jsonb(NEW)-ARRAY['last_error','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['last_error','updated_at'])
  THEN RAISE EXCEPTION 'workflow entry point required' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='accepted_versions' AND (to_jsonb(NEW)->>'version_no')='1' THEN
  RETURN NULL; -- Baseline import has no applying submission.
 ELSIF TG_TABLE_NAME='audit_events' AND (to_jsonb(NEW)->>'event_type') NOT IN
  ('submission_reconciled','reconciliation_rejected','field_reviewed') THEN
  RETURN NULL; -- Other operational events do not grant publication authority.
 ELSIF current_user<>'fieldmerge_workflow' THEN
  RAISE EXCEPTION 'workflow entry point required' USING ERRCODE='42501';
 END IF;
 IF TG_TABLE_NAME='field_changes' AND TG_OP='UPDATE' THEN
  IF OLD.state<>'pending' OR NEW.state='pending' OR NEW.revision_no<>OLD.revision_no+1 OR
   ROW(NEW.change_id,NEW.submission_id,NEW.record_id,NEW.field_name,NEW.base_value,NEW.proposed_value,
       NEW.compared_value,NEW.compared_version_no,NEW.classification)
   IS DISTINCT FROM
   ROW(OLD.change_id,OLD.submission_id,OLD.record_id,OLD.field_name,OLD.base_value,OLD.proposed_value,
       OLD.compared_value,OLD.compared_version_no,OLD.classification)
  THEN RAISE EXCEPTION 'field outcome or proposal is immutable' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_TABLE_NAME='review_decisions' THEN
  -- Compare at insertion, while this decision's live state is current. Later
  -- decisions may change the submission without rewriting this original receipt.
  IF NEW.decision_result->>'state' IS DISTINCT FROM
   (SELECT s.state FROM fieldmerge.submissions s JOIN fieldmerge.field_changes c USING(submission_id) WHERE c.change_id=NEW.change_id)
  THEN RAISE EXCEPTION 'workflow integrity: decision receipt state is inconsistent' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END $$;
-- AFTER triggers let ordinary PK/FK/domain checks retain their specific errors first.
CREATE TRIGGER zz_workflow_submissions AFTER INSERT OR UPDATE OR DELETE ON submissions
 FOR EACH ROW EXECUTE FUNCTION guard_workflow_write();
CREATE TRIGGER zz_workflow_versions AFTER INSERT ON accepted_versions
 FOR EACH ROW EXECUTE FUNCTION guard_workflow_write();
CREATE TRIGGER zz_workflow_changes AFTER INSERT OR UPDATE OR DELETE ON field_changes
 FOR EACH ROW EXECUTE FUNCTION guard_workflow_write();
CREATE TRIGGER zz_workflow_decisions AFTER INSERT ON review_decisions
 FOR EACH ROW EXECUTE FUNCTION guard_workflow_write();
CREATE TRIGGER zz_workflow_audit AFTER INSERT ON audit_events
 FOR EACH ROW EXECUTE FUNCTION guard_workflow_write();

CREATE FUNCTION assert_submission_consistent(p_id uuid) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 s fieldmerge.submissions%ROWTYPE; c fieldmerge.field_changes%ROWTYPE;
 d fieldmerge.review_decisions%ROWTYPE; v fieldmerge.accepted_versions%ROWTYPE;
 previous fieldmerge.accepted_versions%ROWTYPE; applying record;
 base_snapshot jsonb; compared_snapshot jsonb; decision_snapshot jsonb;
 p jsonb; b jsonb; cv jsonb; chosen_current jsonb; before_value jsonb; after_value jsonb;
 f text; expected_class text; initial_disposition text; initial_reason text; disposition text;
 initial_fields jsonb='[]'; expected_receipt jsonb; expected_event jsonb;
 compared integer; initial_applied integer=0; initial_pending integer=0; total_changes integer=0;
 decisions integer=0; live_applied integer=0; live_pending integer=0; changed integer;
 initial_version integer; initial_state text; live_state text; has_history boolean; warned boolean; ends timestamptz;
BEGIN
 SELECT * INTO s FROM fieldmerge.submissions WHERE submission_id=p_id;
 IF NOT FOUND THEN RETURN; END IF;
 IF s.reconciliation_result IS NULL THEN
  IF s.state NOT IN ('awaiting_document','ready','processing') OR
   (s.state='awaiting_document' AND (s.source_verified_at IS NOT NULL OR s.verified_patch IS NOT NULL)) OR
   (s.state IN ('ready','processing') AND (s.source_verified_at IS NULL OR s.verified_patch IS NULL)) OR
   EXISTS(SELECT FROM fieldmerge.field_changes WHERE submission_id=p_id) OR
   EXISTS(SELECT FROM fieldmerge.accepted_versions WHERE origin_submission_id=p_id) OR
   EXISTS(SELECT FROM fieldmerge.audit_events WHERE submission_id=p_id AND event_type IN
    ('submission_reconciled','reconciliation_rejected','field_reviewed'))
  THEN RAISE EXCEPTION 'workflow integrity: incomplete intake has publication effects' USING ERRCODE='23514'; END IF;
  RETURN;
 END IF;
 IF s.source_verified_at IS NULL OR s.verified_patch IS NULL OR s.lease_token IS NOT NULL
 THEN RAISE EXCEPTION 'workflow integrity: completed intake lacks verified source' USING ERRCODE='23514'; END IF;
 IF s.state='rejected' THEN
  expected_receipt:=jsonb_build_object('submission_id',p_id,'state','rejected','reason',s.rejection_reason,'version_no',NULL,'fields','[]'::jsonb);
  IF s.reconciliation_result IS DISTINCT FROM expected_receipt OR
   EXISTS(SELECT FROM fieldmerge.field_changes WHERE submission_id=p_id) OR
   EXISTS(SELECT FROM fieldmerge.accepted_versions WHERE origin_submission_id=p_id) OR
   (SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id=p_id AND event_type IN
    ('submission_reconciled','reconciliation_rejected','field_reviewed'))<>1 OR
   NOT EXISTS(SELECT FROM fieldmerge.audit_events WHERE submission_id=p_id AND record_id=s.record_id AND actor_id=s.author_id
    AND event_type='reconciliation_rejected' AND event_data=jsonb_build_object('reason',s.rejection_reason))
  THEN RAISE EXCEPTION 'workflow integrity: rejection has inconsistent effects' USING ERRCODE='23514'; END IF;
  RETURN;
 END IF;
 IF jsonb_typeof(s.verified_patch) IS DISTINCT FROM 'object' OR s.rejection_reason IS NOT NULL
 THEN RAISE EXCEPTION 'workflow integrity: invalid successful projection' USING ERRCODE='23514'; END IF;
 SELECT version_no,to_jsonb(a) INTO compared,compared_snapshot FROM fieldmerge.accepted_versions a
 WHERE a.record_id=s.record_id AND to_jsonb(a.version_no)=s.reconciliation_result->'compared_version_no';
 SELECT to_jsonb(a) INTO base_snapshot FROM fieldmerge.accepted_versions a WHERE record_id=s.record_id AND version_no=s.base_version_no;
 IF compared IS NULL OR compared<s.base_version_no
 THEN RAISE EXCEPTION 'workflow integrity: invalid comparison version' USING ERRCODE='23514'; END IF;
 SELECT sc.ends_at INTO ends FROM fieldmerge.tree_records r JOIN fieldmerge.survey_campaigns sc USING(campaign_id) WHERE r.record_id=s.record_id;
 warned:=s.requires_review OR s.observed_at>ends OR s.observed_at>s.received_at+interval '5 minutes';
 FOR c IN SELECT * FROM fieldmerge.field_changes WHERE submission_id=p_id ORDER BY field_name LOOP
  total_changes:=total_changes+1;
  b:=base_snapshot->c.field_name;cv:=compared_snapshot->c.field_name;p:=s.verified_patch->c.field_name;
  IF c.field_name='species' AND jsonb_typeof(p)='string' THEN
   IF length(p #>> '{}')>120 OR (p #>> '{}') ~ '[[:cntrl:]]'
   THEN RAISE EXCEPTION 'workflow integrity: invalid original species' USING ERRCODE='23514'; END IF;
   p:=to_jsonb(regexp_replace(btrim(p #>> '{}'),'[[:space:]]+',' ','g'));
  END IF;
  IF p IS NULL OR NOT fieldmerge.valid_scalar(c.field_name,p) OR c.proposed_value IS DISTINCT FROM p OR
   c.base_value IS DISTINCT FROM b OR c.compared_value IS DISTINCT FROM cv OR c.compared_version_no<>compared
  THEN RAISE EXCEPTION 'workflow integrity: proposal does not match source or snapshots' USING ERRCODE='23514'; END IF;
  SELECT EXISTS(SELECT FROM fieldmerge.accepted_versions a JOIN fieldmerge.accepted_versions parent
   ON parent.record_id=a.record_id AND parent.version_no=a.parent_version_no
   WHERE a.record_id=s.record_id AND a.version_no>s.base_version_no AND a.version_no<=compared
   AND (to_jsonb(a)->c.field_name) IS DISTINCT FROM (to_jsonb(parent)->c.field_name)) INTO has_history;
  IF NOT has_history AND cv IS DISTINCT FROM b
  THEN RAISE EXCEPTION 'workflow integrity: comparison history is inconsistent' USING ERRCODE='23514'; END IF;
  initial_reason:=NULL;
  IF p=b THEN expected_class:='no_change';initial_disposition:='no_change';
  ELSIF p=cv THEN expected_class:='already_represented';initial_disposition:='already_represented';
  ELSIF has_history THEN expected_class:='conflict';initial_disposition:='pending';
   initial_reason:=CASE WHEN cv=b THEN 'intervening_edit' ELSE 'value_conflict' END;
  ELSE expected_class:='compatible';initial_disposition:=CASE WHEN warned THEN 'pending' ELSE 'applied' END;
   IF warned THEN initial_reason:=CASE WHEN s.observed_at>ends OR s.warnings ? 'campaign_warning' THEN 'campaign_warning' ELSE 'clock_warning' END; END IF;
  END IF;
  IF c.classification<>expected_class
  THEN RAISE EXCEPTION 'workflow integrity: incorrect classification' USING ERRCODE='23514'; END IF;
  IF initial_disposition='applied' THEN initial_applied:=initial_applied+1; END IF;
  IF initial_disposition='pending' THEN initial_pending:=initial_pending+1; END IF;
  initial_fields:=initial_fields||jsonb_build_array(jsonb_build_object('change_id',c.change_id,'field_name',c.field_name,
   'base_value',b,'proposed_value',p,'compared_value',cv,'classification',expected_class,
   'state',initial_disposition,'pending_reason',initial_reason));
  SELECT * INTO d FROM fieldmerge.review_decisions WHERE change_id=c.change_id;
  IF FOUND THEN
   decisions:=decisions+1;
   SELECT to_jsonb(a) INTO decision_snapshot FROM fieldmerge.accepted_versions a WHERE record_id=s.record_id AND version_no=d.expected_version_no;
   chosen_current:=decision_snapshot->c.field_name;
   IF initial_disposition<>'pending' OR d.expected_version_no<compared OR d.expected_change_revision<>1 OR c.revision_no<>2 OR
    NOT fieldmerge.valid_scalar(c.field_name,d.chosen_value) OR
    (d.action='accept_proposal' AND d.chosen_value IS DISTINCT FROM p) OR
    (d.action='keep_current' AND d.chosen_value IS DISTINCT FROM chosen_current)
   THEN RAISE EXCEPTION 'workflow integrity: decision contradicts proposal or comparison' USING ERRCODE='23514'; END IF;
   disposition:=CASE WHEN d.chosen_value IS DISTINCT FROM chosen_current THEN 'applied'
    WHEN d.action='keep_current' THEN 'rejected' WHEN d.action='accept_proposal' THEN 'already_represented' ELSE 'no_change' END;
   IF c.state<>disposition OR c.pending_reason IS NOT NULL OR d.result_version_no IS DISTINCT FROM c.applied_version_no OR
    (disposition='applied' AND d.result_version_no IS DISTINCT FROM d.expected_version_no+1) OR
    (disposition<>'applied' AND d.result_version_no IS NOT NULL) OR
    d.decision_result IS NULL OR NOT coalesce(d.decision_result->>'state' IN ('needs_review','partially_applied','resolved'),false) OR
    (d.decision_result-'state') IS DISTINCT FROM jsonb_build_object('decision_id',d.decision_id,'change_id',c.change_id,
     'submission_id',p_id,'reviewer_id',d.reviewer_id,'action',d.action,'chosen_value',d.chosen_value,
     'field_state',disposition,'version_no',d.result_version_no,'reviewed_version_no',d.expected_version_no,'change_revision',c.revision_no)
   THEN RAISE EXCEPTION 'workflow integrity: decision result does not match outcome' USING ERRCODE='23514'; END IF;
   expected_event:=jsonb_build_object('decision_id',d.decision_id,'change_id',c.change_id,'action',d.action,
    'reviewed_version_no',d.expected_version_no,'published_version_no',d.result_version_no,'disposition',disposition);
   IF NOT EXISTS(SELECT FROM fieldmerge.audit_events WHERE submission_id=p_id AND record_id=s.record_id AND actor_id=d.reviewer_id
    AND event_type='field_reviewed' AND event_data=expected_event)
   THEN RAISE EXCEPTION 'workflow integrity: decision audit is missing' USING ERRCODE='23514'; END IF;
  ELSE
   IF c.revision_no<>1 OR c.state<>initial_disposition OR c.pending_reason IS DISTINCT FROM initial_reason OR
    c.applied_version_no IS DISTINCT FROM (CASE WHEN initial_disposition='applied' THEN compared+1 END)
   THEN RAISE EXCEPTION 'workflow integrity: unreviewed field outcome is inconsistent' USING ERRCODE='23514'; END IF;
  END IF;
  IF c.state='applied' THEN
   live_applied:=live_applied+1;
   IF NOT EXISTS(SELECT FROM fieldmerge.accepted_versions WHERE record_id=s.record_id AND version_no=c.applied_version_no AND origin_submission_id=p_id)
   THEN RAISE EXCEPTION 'workflow integrity: applying link has the wrong origin' USING ERRCODE='23514'; END IF;
  END IF;
  IF c.state='pending' THEN live_pending:=live_pending+1; END IF;
 END LOOP;
 IF total_changes<>(SELECT count(*) FROM jsonb_object_keys(s.verified_patch))
 THEN RAISE EXCEPTION 'workflow integrity: projection fields are missing' USING ERRCODE='23514'; END IF;
 IF initial_applied>0 THEN initial_version:=compared+1; END IF;
 initial_state:=CASE WHEN initial_pending>0 AND initial_applied>0 THEN 'partially_applied' WHEN initial_pending>0 THEN 'needs_review'
  WHEN initial_applied>0 THEN 'applied' ELSE 'no_change' END;
 expected_receipt:=jsonb_build_object('submission_id',p_id,'state',initial_state,'version_no',initial_version,'compared_version_no',compared,'fields',initial_fields);
 live_state:=CASE WHEN decisions=0 THEN initial_state WHEN live_pending=0 THEN 'resolved'
  WHEN live_applied>0 THEN 'partially_applied' ELSE 'needs_review' END;
 IF s.reconciliation_result IS DISTINCT FROM expected_receipt OR s.state<>live_state
 THEN RAISE EXCEPTION 'workflow integrity: receipt or live state disagrees with fields' USING ERRCODE='23514'; END IF;
 expected_event:=jsonb_build_object('state',initial_state,'base_version_no',s.base_version_no,'compared_version_no',compared,
  'published_version_no',initial_version,'applied_fields',initial_applied,'pending_fields',initial_pending);
 IF (SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id=p_id AND event_type='submission_reconciled')<>1 OR
  EXISTS(SELECT FROM fieldmerge.audit_events WHERE submission_id=p_id AND event_type='reconciliation_rejected') OR
  (SELECT count(*) FROM fieldmerge.audit_events WHERE submission_id=p_id AND event_type='field_reviewed')<>decisions OR
  NOT EXISTS(SELECT FROM fieldmerge.audit_events WHERE submission_id=p_id AND record_id=s.record_id AND actor_id=s.author_id
   AND event_type='submission_reconciled' AND event_data=expected_event)
 THEN RAISE EXCEPTION 'workflow integrity: reconciliation audit is inconsistent' USING ERRCODE='23514'; END IF;
 FOR v IN SELECT * FROM fieldmerge.accepted_versions WHERE origin_submission_id=p_id LOOP
  SELECT * INTO STRICT previous FROM fieldmerge.accepted_versions WHERE record_id=v.record_id AND version_no=v.parent_version_no;
  changed:=0;
  FOREACH f IN ARRAY ARRAY['species','health','diameter_cm','guard_damage'] LOOP
   before_value:=to_jsonb(previous)->f;after_value:=to_jsonb(v)->f;
   SELECT fc.change_id,fc.submission_id,fc.state,fc.proposed_value,rd.chosen_value,rd.reviewer_id INTO applying
    FROM fieldmerge.field_changes fc LEFT JOIN fieldmerge.review_decisions rd USING(change_id)
    WHERE fc.record_id=v.record_id AND fc.applied_version_no=v.version_no AND fc.field_name=f;
   IF before_value IS DISTINCT FROM after_value THEN
    changed:=changed+1;
    IF applying.change_id IS NULL OR applying.submission_id IS DISTINCT FROM p_id OR applying.state IS DISTINCT FROM 'applied' OR
     after_value IS DISTINCT FROM coalesce(applying.chosen_value,applying.proposed_value) OR
     v.published_by IS DISTINCT FROM coalesce(applying.reviewer_id,s.author_id)
    THEN RAISE EXCEPTION 'workflow integrity: snapshot difference lacks its matching applying link' USING ERRCODE='23514'; END IF;
   ELSIF applying.change_id IS NOT NULL THEN
    RAISE EXCEPTION 'workflow integrity: applying link names an unchanged field' USING ERRCODE='23514';
   END IF;
  END LOOP;
  IF changed=0 THEN RAISE EXCEPTION 'workflow integrity: publication changed no values' USING ERRCODE='23514'; END IF;
 END LOOP;
END $$;

CREATE FUNCTION check_workflow_consistency() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target uuid;
BEGIN
 CASE TG_TABLE_NAME
 WHEN 'submissions' THEN target:=NEW.submission_id;
 WHEN 'accepted_versions' THEN target:=NEW.origin_submission_id;
 WHEN 'field_changes' THEN target:=NEW.submission_id;
 WHEN 'review_decisions' THEN SELECT submission_id INTO target FROM fieldmerge.field_changes WHERE change_id=NEW.change_id;
 WHEN 'audit_events' THEN target:=NEW.submission_id;
 END CASE;
 IF target IS NOT NULL THEN PERFORM fieldmerge.assert_submission_consistent(target); END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER consistent_submission AFTER INSERT OR UPDATE ON submissions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_consistency();
CREATE CONSTRAINT TRIGGER consistent_version AFTER INSERT ON accepted_versions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_consistency();
CREATE CONSTRAINT TRIGGER consistent_change AFTER INSERT OR UPDATE ON field_changes
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_consistency();
CREATE CONSTRAINT TRIGGER consistent_decision AFTER INSERT ON review_decisions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_consistency();
CREATE CONSTRAINT TRIGGER consistent_workflow_audit AFTER INSERT ON audit_events
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_consistency();
REVOKE ALL ON FUNCTION guard_workflow_write(),assert_submission_consistent(uuid),check_workflow_consistency() FROM PUBLIC,fieldmerge_app,fieldmerge_api;

-- Do not silently accept pre-existing inconsistent history during an upgrade.
DO $$ DECLARE id uuid; BEGIN
 FOR id IN SELECT submission_id FROM fieldmerge.submissions LOOP PERFORM fieldmerge.assert_submission_consistent(id); END LOOP;
END $$;
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES('006',:'migration_hash');
COMMIT;

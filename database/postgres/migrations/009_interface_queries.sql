\set ON_ERROR_STOP on
BEGIN;
SET search_path=fieldmerge,public;
CREATE FUNCTION api_submission_list(p_token text,p_record uuid,p_state text,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token);is_reviewer boolean;BEGIN
 SELECT role='reviewer' INTO is_reviewer FROM fieldmerge.app_users WHERE user_id=actor;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_state IS NOT NULL AND p_state NOT IN
 ('awaiting_document','ready','processing','needs_review','partially_applied','applied','no_change','resolved','rejected')
 THEN RAISE EXCEPTION 'invalid submission filters' USING ERRCODE='22023';END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY received_at DESC,submission_id DESC) FROM
 (SELECT s.submission_id,s.client_submission_id,s.record_id,r.source_record_id,s.base_version_no,s.author_id,u.display_name AS author_name,
 s.form_version,s.observed_at,s.received_at,s.state,s.warnings,s.batch_id,
 (SELECT count(*) FROM fieldmerge.field_changes c WHERE c.submission_id=s.submission_id AND c.state='pending') AS pending_fields,
 (SELECT count(*) FROM fieldmerge.field_changes c WHERE c.submission_id=s.submission_id AND c.state='applied') AS applied_fields
 FROM fieldmerge.submissions s JOIN fieldmerge.tree_records r USING(record_id) JOIN fieldmerge.app_users u ON u.user_id=s.author_id
 WHERE (is_reviewer OR s.author_id=actor) AND (p_record IS NULL OR s.record_id=p_record) AND (p_state IS NULL OR s.state=p_state)
 ORDER BY s.received_at DESC,s.submission_id DESC LIMIT p_limit) q),'[]');
END $$;
CREATE FUNCTION api_batch_list(p_token text,p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token);is_reviewer boolean;BEGIN
 SELECT role='reviewer' INTO is_reviewer FROM fieldmerge.app_users WHERE user_id=actor;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid list limit' USING ERRCODE='22023';END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY created_at DESC,batch_id DESC) FROM
 (SELECT b.batch_id,b.client_batch_id,b.owner_id,u.display_name AS owner_name,b.item_count,b.created_at,
 (SELECT count(*) FROM fieldmerge_ops.batch_items i JOIN fieldmerge.submissions s USING(submission_id) WHERE i.batch_id=b.batch_id AND s.reconciliation_result IS NOT NULL) AS processed_items,
 (SELECT count(*) FROM fieldmerge_ops.batch_items i LEFT JOIN fieldmerge.submissions s USING(submission_id) WHERE i.batch_id=b.batch_id AND i.error_code IS NOT NULL AND s.reconciliation_result IS NULL) AS error_items
 FROM fieldmerge_ops.intake_batches b JOIN fieldmerge.app_users u ON u.user_id=b.owner_id
 WHERE is_reviewer OR b.owner_id=actor ORDER BY b.created_at DESC,b.batch_id DESC LIMIT p_limit) q),'[]');
END $$;
CREATE FUNCTION api_review_authors(p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token,'reviewer');
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY display_name,user_id) FROM (SELECT u.user_id,u.display_name FROM fieldmerge.app_users u
 WHERE EXISTS(SELECT FROM fieldmerge.submissions s JOIN fieldmerge.field_changes c USING(submission_id) WHERE s.author_id=u.user_id AND c.state='pending')) q),'[]');
END $$;
CREATE FUNCTION api_record_labels(p_token text,p_ids uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token);
 IF p_ids IS NULL OR cardinality(p_ids)>100 THEN RAISE EXCEPTION 'invalid label request' USING ERRCODE='22023';END IF;
 RETURN coalesce((SELECT jsonb_object_agg(record_id::text,source_record_id) FROM fieldmerge.tree_records WHERE record_id=ANY(p_ids)),'{}');
END $$;
CREATE FUNCTION api_review_comparison(p_token text,p_change uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM fieldmerge._api_actor(p_token,'reviewer');
 RETURN (SELECT to_jsonb(v)||jsonb_build_object('base_version_no',s.base_version_no,'source_record_id',r.source_record_id,'author_name',u.display_name)
 FROM fieldmerge.pending_field_reviews v JOIN fieldmerge.submissions s USING(submission_id) JOIN fieldmerge.tree_records r ON r.record_id=v.record_id
 JOIN fieldmerge.app_users u ON u.user_id=s.author_id WHERE v.change_id=p_change);
END $$;
REVOKE ALL ON FUNCTION api_submission_list(text,uuid,text,integer),api_batch_list(text,integer),api_review_authors(text),api_record_labels(text,uuid[]) FROM PUBLIC,fieldmerge_worker;
GRANT EXECUTE ON FUNCTION api_submission_list(text,uuid,text,integer),api_batch_list(text,integer),api_review_authors(text),api_record_labels(text,uuid[]) TO fieldmerge_api;
REVOKE ALL ON FUNCTION api_review_comparison(text,uuid) FROM PUBLIC,fieldmerge_worker;
GRANT EXECUTE ON FUNCTION api_review_comparison(text,uuid) TO fieldmerge_api;
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES('009',:'migration_hash');
COMMIT;

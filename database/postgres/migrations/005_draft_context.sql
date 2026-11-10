\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION fieldmerge.api_draft_context(p_token text,p_record uuid,p_base integer,p_form text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid=fieldmerge._api_actor(p_token,'surveyor');
BEGIN
 IF NOT EXISTS(SELECT FROM fieldmerge.tree_records r JOIN fieldmerge.accepted_versions v USING(record_id)
 WHERE r.record_id=p_record AND r.is_active AND v.version_no=p_base)
 THEN RAISE EXCEPTION 'invalid active record or base version' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM fieldmerge.form_versions WHERE form_version=p_form AND is_supported)
 THEN RAISE EXCEPTION 'unsupported form' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('owner_id',actor);
END $$;
REVOKE ALL ON FUNCTION fieldmerge.api_draft_context(text,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fieldmerge.api_draft_context(text,uuid,integer,text) TO fieldmerge_api;
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES('005',:'migration_hash');
COMMIT;

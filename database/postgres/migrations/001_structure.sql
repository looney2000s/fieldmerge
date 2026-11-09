\set ON_ERROR_STOP on
BEGIN;
CREATE SCHEMA fieldmerge;
SET search_path = fieldmerge, public;

CREATE FUNCTION valid_scalar(field_name text, value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE n numeric; s text;
BEGIN
  IF field_name NOT IN ('species','health','diameter_cm','guard_damage') THEN RETURN false; END IF;
  IF value = 'null'::jsonb THEN RETURN true; END IF;
  CASE field_name
    WHEN 'species' THEN
      IF jsonb_typeof(value) <> 'string' THEN RETURN false; END IF;
      s := value #>> '{}';
      RETURN length(s) BETWEEN 1 AND 120 AND s = btrim(s)
        AND s !~ '[[:cntrl:]]' AND s !~ '[[:space:]]{2,}';
    WHEN 'health' THEN RETURN jsonb_typeof(value) = 'string' AND (value #>> '{}') IN ('Good','Fair','Poor');
    WHEN 'guard_damage' THEN RETURN jsonb_typeof(value) = 'boolean';
    WHEN 'diameter_cm' THEN
      IF jsonb_typeof(value) <> 'number' THEN RETURN false; END IF;
      n := (value #>> '{}')::numeric;
      RETURN n BETWEEN 0 AND 999999.99 AND n = trunc(n,2);
    ELSE RETURN false;
  END CASE;
END $$;

CREATE TABLE app_users (
 user_id uuid PRIMARY KEY,
 email text NOT NULL UNIQUE CHECK(email = lower(btrim(email)) AND email <> ''),
 password_hash text NOT NULL CHECK(length(btrim(password_hash)) > 0),
 display_name varchar(120) NOT NULL CHECK(display_name = btrim(display_name) AND display_name <> ''),
 role text NOT NULL CHECK(role IN ('surveyor','reviewer')),
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE survey_campaigns (
 campaign_id uuid PRIMARY KEY, name varchar(160) NOT NULL CHECK(length(btrim(name)) > 0),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at >= starts_at),
 source_dataset_id text NOT NULL, source_url text NOT NULL,
 import_mapping_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tree_records (
 record_id uuid PRIMARY KEY, campaign_id uuid NOT NULL REFERENCES survey_campaigns,
 source_record_id text NOT NULL CHECK(length(btrim(source_record_id)) > 0),
 imported_at timestamptz NOT NULL DEFAULT now(), is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(campaign_id,source_record_id)
);
CREATE TABLE accepted_versions (
 record_id uuid NOT NULL REFERENCES tree_records, version_no integer NOT NULL CHECK(version_no > 0),
 parent_version_no integer,
 species varchar(120) CHECK(species IS NULL OR valid_scalar('species',to_jsonb(species))),
 health text CHECK(health IS NULL OR health IN ('Good','Fair','Poor')),
 -- Unconstrained numeric avoids silently rounding an invalid incoming value before CHECK.
 diameter_cm numeric CHECK(diameter_cm IS NULL OR
   (diameter_cm BETWEEN 0 AND 999999.99 AND diameter_cm = trunc(diameter_cm,2))),
 guard_damage boolean, origin_submission_id uuid,
 published_by uuid NOT NULL REFERENCES app_users,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(record_id,version_no),
 FOREIGN KEY(record_id,parent_version_no) REFERENCES accepted_versions(record_id,version_no),
 CHECK((version_no = 1 AND parent_version_no IS NULL AND origin_submission_id IS NULL)
    OR (version_no > 1 AND parent_version_no IS NOT NULL AND parent_version_no = version_no-1
        AND origin_submission_id IS NOT NULL))
);
CREATE TABLE form_versions (
 form_version text PRIMARY KEY, definition_id uuid NOT NULL UNIQUE,
 schema_hash text NOT NULL CHECK(schema_hash ~ '^[a-f0-9]{64}$'),
 is_supported boolean NOT NULL DEFAULT true, published_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE submissions (
 submission_id uuid PRIMARY KEY, author_id uuid NOT NULL REFERENCES app_users,
 client_submission_id uuid NOT NULL, record_id uuid NOT NULL REFERENCES tree_records,
 base_version_no integer NOT NULL, form_version text NOT NULL REFERENCES form_versions,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'), batch_id uuid,
 observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'awaiting_document' CHECK(state IN
 ('awaiting_document','ready','processing','needs_review','partially_applied','applied','no_change','resolved','rejected')),
 source_verified_at timestamptz, requires_review boolean NOT NULL DEFAULT false,
 warnings jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(warnings) = 'array'),
 rejection_reason text, lease_token uuid, lease_expires_at timestamptz,
 last_error varchar(2000), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(author_id,client_submission_id), UNIQUE(submission_id,record_id),
 FOREIGN KEY(record_id,base_version_no) REFERENCES accepted_versions(record_id,version_no),
 CHECK(state IN ('awaiting_document','rejected') OR source_verified_at IS NOT NULL),
 CHECK((lease_token IS NULL) = (lease_expires_at IS NULL)),
 CHECK((state = 'processing') = (lease_token IS NOT NULL)),
 CHECK(state <> 'rejected' OR length(btrim(rejection_reason)) > 0 AND rejection_reason IS NOT NULL)
);
ALTER TABLE accepted_versions ADD CONSTRAINT version_origin_same_record
 FOREIGN KEY(origin_submission_id,record_id) REFERENCES submissions(submission_id,record_id);

CREATE TABLE field_changes (
 change_id uuid PRIMARY KEY, submission_id uuid NOT NULL, record_id uuid NOT NULL,
 field_name text NOT NULL CHECK(field_name IN ('species','health','diameter_cm','guard_damage')),
 base_value jsonb NOT NULL, proposed_value jsonb NOT NULL, compared_value jsonb NOT NULL,
 compared_version_no integer NOT NULL,
 classification text NOT NULL CHECK(classification IN ('no_change','compatible','already_represented','conflict')),
 state text NOT NULL CHECK(state IN ('pending','applied','rejected','no_change','already_represented')),
 pending_reason text CHECK(pending_reason IN ('value_conflict','intervening_edit','clock_warning','campaign_warning')),
 revision_no integer NOT NULL DEFAULT 1 CHECK(revision_no > 0), applied_version_no integer,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(submission_id,field_name), UNIQUE(change_id,record_id),
 UNIQUE(record_id,applied_version_no,field_name),
 FOREIGN KEY(submission_id,record_id) REFERENCES submissions(submission_id,record_id),
 FOREIGN KEY(record_id,compared_version_no) REFERENCES accepted_versions(record_id,version_no),
 FOREIGN KEY(record_id,applied_version_no) REFERENCES accepted_versions(record_id,version_no),
 CHECK((state = 'applied') = (applied_version_no IS NOT NULL)),
 CHECK((state = 'pending') = (pending_reason IS NOT NULL)),
 CHECK(valid_scalar(field_name,base_value) AND valid_scalar(field_name,proposed_value)
       AND valid_scalar(field_name,compared_value))
);
CREATE TABLE review_decisions (
 decision_id uuid PRIMARY KEY, change_id uuid NOT NULL UNIQUE, record_id uuid NOT NULL,
 reviewer_id uuid NOT NULL REFERENCES app_users, client_decision_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 expected_version_no integer NOT NULL, expected_change_revision integer NOT NULL CHECK(expected_change_revision > 0),
 action text NOT NULL CHECK(action IN ('accept_proposal','keep_current','replace')),
 chosen_value jsonb NOT NULL, reason varchar(2000) NOT NULL CHECK(length(btrim(reason)) > 0),
 result_version_no integer, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(reviewer_id,client_decision_id), UNIQUE(record_id,result_version_no),
 FOREIGN KEY(change_id,record_id) REFERENCES field_changes(change_id,record_id),
 FOREIGN KEY(record_id,expected_version_no) REFERENCES accepted_versions(record_id,version_no),
 FOREIGN KEY(record_id,result_version_no) REFERENCES accepted_versions(record_id,version_no),
 CHECK(action <> 'keep_current' OR result_version_no IS NULL),
 CHECK(result_version_no IS NULL OR result_version_no = expected_version_no+1)
);
CREATE TABLE audit_events (
 event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid REFERENCES app_users, record_id uuid REFERENCES tree_records,
 submission_id uuid REFERENCES submissions,
 event_type text NOT NULL CHECK(length(btrim(event_type)) > 0),
 event_data jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(event_data) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION block_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable history: %', TG_TABLE_NAME USING ERRCODE='42501'; END $$;
CREATE TRIGGER immutable_versions BEFORE UPDATE OR DELETE ON accepted_versions
 FOR EACH ROW EXECUTE FUNCTION block_history_mutation();
CREATE TRIGGER immutable_decisions BEFORE UPDATE OR DELETE ON review_decisions
 FOR EACH ROW EXECUTE FUNCTION block_history_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events
 FOR EACH ROW EXECUTE FUNCTION block_history_mutation();

CREATE FUNCTION require_initial_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT FROM fieldmerge.tree_records WHERE record_id=NEW.record_id)
 AND NOT EXISTS(SELECT FROM fieldmerge.accepted_versions WHERE record_id=NEW.record_id AND version_no=1)
 THEN RAISE EXCEPTION 'tree requires version 1' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER tree_initial_version AFTER INSERT ON tree_records
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_initial_version();

CREATE FUNCTION check_audit_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.submission_id IS NOT NULL AND NEW.record_id IS NOT NULL AND NOT EXISTS
 (SELECT FROM fieldmerge.submissions WHERE submission_id=NEW.submission_id AND record_id=NEW.record_id)
 THEN RAISE EXCEPTION 'audit references different trees' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER audit_same_record BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION check_audit_record();

CREATE FUNCTION validate_review_actor_and_value() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f text;
BEGIN
 IF NOT EXISTS(SELECT FROM fieldmerge.app_users WHERE user_id=NEW.reviewer_id AND role='reviewer' AND is_active)
 THEN RAISE EXCEPTION 'active reviewer required' USING ERRCODE='42501'; END IF;
 SELECT field_name INTO f FROM fieldmerge.field_changes WHERE change_id=NEW.change_id AND record_id=NEW.record_id;
 IF f IS NOT NULL AND NOT fieldmerge.valid_scalar(f,NEW.chosen_value)
 THEN RAISE EXCEPTION 'invalid chosen field value' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER decision_actor_value BEFORE INSERT ON review_decisions
 FOR EACH ROW EXECUTE FUNCTION validate_review_actor_and_value();

CREATE INDEX submissions_record_received ON submissions(record_id,received_at);
CREATE INDEX submissions_author_received ON submissions(author_id,received_at);
CREATE INDEX submissions_processing ON submissions(state,lease_expires_at);
CREATE INDEX pending_changes ON field_changes(record_id,updated_at) WHERE state='pending';
CREATE INDEX decisions_reviewer_created ON review_decisions(reviewer_id,created_at);
CREATE INDEX audit_record_created ON audit_events(record_id,created_at);
CREATE INDEX audit_submission_created ON audit_events(submission_id,created_at);

CREATE VIEW latest_accepted_records AS
 SELECT DISTINCT ON(v.record_id) r.campaign_id,r.source_record_id,r.is_active,v.*
 FROM accepted_versions v JOIN tree_records r USING(record_id)
 ORDER BY v.record_id,v.version_no DESC;
CREATE VIEW pending_field_reviews AS
 SELECT c.*,s.author_id,s.observed_at,s.received_at,
 v.version_no AS current_version_no,
 CASE c.field_name WHEN 'species' THEN coalesce(to_jsonb(v.species),'null'::jsonb)
 WHEN 'health' THEN coalesce(to_jsonb(v.health),'null'::jsonb)
 WHEN 'diameter_cm' THEN coalesce(to_jsonb(v.diameter_cm),'null'::jsonb)
 ELSE coalesce(to_jsonb(v.guard_damage),'null'::jsonb) END AS current_value
 FROM field_changes c JOIN submissions s USING(submission_id)
 JOIN latest_accepted_records v ON v.record_id=c.record_id WHERE c.state='pending';
CREATE VIEW submission_outcomes AS
 SELECT s.submission_id,s.author_id,s.record_id,s.state,
 count(c.change_id) AS proposed_fields,
 count(c.change_id) FILTER(WHERE c.state='pending') AS pending_fields,
 count(c.change_id) FILTER(WHERE c.state='applied') AS applied_fields
 FROM submissions s LEFT JOIN field_changes c USING(submission_id) GROUP BY s.submission_id;

-- Reserve an unprivileged group now. The API publication functions and row access policies
-- are a later migration; this role intentionally has no table access yet.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='fieldmerge_app') THEN CREATE ROLE fieldmerge_app NOLOGIN; END IF;
END $$;
REVOKE ALL ON SCHEMA fieldmerge FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA fieldmerge FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fieldmerge FROM PUBLIC;
GRANT USAGE ON SCHEMA fieldmerge TO fieldmerge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA fieldmerge REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS fieldmerge_meta;
CREATE TABLE IF NOT EXISTS fieldmerge_meta.migrations (
 version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fieldmerge_meta.migrations(version,checksum) VALUES ('001', :'migration_hash');
COMMIT;

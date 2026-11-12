# FieldMerge implementation data dictionary

Captured 2026-11-12T12:26:24.591Z from the development catalogs after migrations 001–010. Implementation baseline: 758877305245420092ec24b10be6f23b55bc2bcd. This is metadata, not an export of application records. Generate with `node scripts/export-design.mjs` then `node scripts/render-design.mjs`.

There are **17 SQL tables, 146 columns, 29 foreign keys, four views, 43 indexes (including constraint indexes), 26 explicit noninternal triggers, 60 functions and three MongoDB collections**. Counts describe physical objects, not independent business features or Chen relationships. Nine SQL tables form the business model; the others provide authentication, recovery, transport, safe failure events and migration tracking.

The conceptual ER diagram is maintained separately by the project author. [Relational design](FieldMerge_Relational_Schema.md) explains its mapping and normalization. Composite key membership below does not imply that one component alone is unique. A nullable FK and a JSON null scalar have different meanings. Exact executable definitions remain in ordered migrations and the MongoDB model.

## fieldmerge.accepted_versions

Immutable accepted snapshots. The composite key identifies a version within one tree; version 1 is the imported baseline. Current values are derived from the latest committed version.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| record_id | uuid | No | PK: accepted_versions_pkey; FK: accepted_versions_record_id_fkey; FK: accepted_versions_record_id_parent_version_no_fkey; FK: version_origin_same_record | — | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| version_no | integer | No | PK: accepted_versions_pkey; FK: accepted_versions_record_id_parent_version_no_fkey | — | Accepted version number within the tree. |
| parent_version_no | integer | Yes | FK: accepted_versions_record_id_parent_version_no_fkey | — | Previous version of this same tree; null only for baseline. |
| species | character varying(120) | Yes | — | — | Normalized accepted species label, or unknown. |
| health | text | Yes | — | — | Good, Fair, Poor, or unknown. |
| diameter_cm | numeric | Yes | — | — | Exact centimeters; 0–999999.99, at most two meaningful decimal places, or unknown. |
| guard_damage | boolean | Yes | — | — | True, false, or unknown; omission is not a stored scalar. |
| origin_submission_id | uuid | Yes | FK: version_origin_same_record | — | Verified submission responsible for a nonbaseline snapshot. |
| published_by | uuid | No | FK: accepted_versions_published_by_fkey | — | Responsible authenticated publisher identity. |
| created_at | timestamp with time zone | No | — | now() | Server creation time. |

Constraints (including complete composite keys and null-sensitive rules):

- **accepted_versions_check**: `CHECK (version_no = 1 AND parent_version_no IS NULL AND origin_submission_id IS NULL OR version_no > 1 AND parent_version_no IS NOT NULL AND parent_version_no = (version_no - 1) AND origin_submission_id IS NOT NULL)`.
- **accepted_versions_created_at_not_null**: `NOT NULL created_at`.
- **accepted_versions_diameter_cm_check**: `CHECK (diameter_cm IS NULL OR diameter_cm >= 0::numeric AND diameter_cm <= 999999.99 AND diameter_cm = trunc(diameter_cm, 2))`.
- **accepted_versions_health_check**: `CHECK (health IS NULL OR (health = ANY (ARRAY['Good'::text, 'Fair'::text, 'Poor'::text])))`.
- **accepted_versions_pkey**: `PRIMARY KEY (record_id, version_no)`.
- **accepted_versions_published_by_fkey**: `FOREIGN KEY (published_by) REFERENCES fieldmerge.app_users(user_id)`.
- **accepted_versions_published_by_not_null**: `NOT NULL published_by`.
- **accepted_versions_record_id_fkey**: `FOREIGN KEY (record_id) REFERENCES fieldmerge.tree_records(record_id)`.
- **accepted_versions_record_id_not_null**: `NOT NULL record_id`.
- **accepted_versions_record_id_parent_version_no_fkey**: `FOREIGN KEY (record_id, parent_version_no) REFERENCES fieldmerge.accepted_versions(record_id, version_no)`.
- **accepted_versions_species_check**: `CHECK (species IS NULL OR fieldmerge.valid_scalar('species'::text, to_jsonb(species)))`.
- **accepted_versions_version_no_check**: `CHECK (version_no > 0)`.
- **accepted_versions_version_no_not_null**: `NOT NULL version_no`.
- **consistent_version**: `TRIGGER DEFERRABLE INITIALLY DEFERRED` — DEFERRABLE, INITIALLY DEFERRED.
- **version_origin_same_record**: `FOREIGN KEY (origin_submission_id, record_id) REFERENCES fieldmerge.submissions(submission_id, record_id)`.

Indexes:

```sql
CREATE UNIQUE INDEX accepted_versions_pkey ON fieldmerge.accepted_versions USING btree (record_id, version_no);
```

## fieldmerge.app_users

Seeded surveyor/reviewer identities, active status and salted password hashes. Referenced accounts are deactivated rather than deleted.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| user_id | uuid | No | PK: app_users_pkey | — | Application user identity. |
| email | text | No | UQ: app_users_email_key | — | Normalized login address. |
| password_hash | text | No | — | — | Salted scrypt password hash, never a plaintext application password. |
| display_name | character varying(120) | No | — | — | Display label. |
| role | text | No | — | — | Application role: surveyor or reviewer. |
| is_active | boolean | No | — | true | Whether new guarded use of this identity is allowed. |
| created_at | timestamp with time zone | No | — | now() | Server creation time. |

Constraints (including complete composite keys and null-sensitive rules):

- **app_users_created_at_not_null**: `NOT NULL created_at`.
- **app_users_display_name_check**: `CHECK (display_name::text = btrim(display_name::text) AND display_name::text <> ''::text)`.
- **app_users_display_name_not_null**: `NOT NULL display_name`.
- **app_users_email_check**: `CHECK (email = lower(btrim(email)) AND email <> ''::text)`.
- **app_users_email_key**: `UNIQUE (email)`.
- **app_users_email_not_null**: `NOT NULL email`.
- **app_users_is_active_not_null**: `NOT NULL is_active`.
- **app_users_password_hash_check**: `CHECK (length(btrim(password_hash)) > 0)`.
- **app_users_password_hash_not_null**: `NOT NULL password_hash`.
- **app_users_pkey**: `PRIMARY KEY (user_id)`.
- **app_users_role_check**: `CHECK (role = ANY (ARRAY['surveyor'::text, 'reviewer'::text]))`.
- **app_users_role_not_null**: `NOT NULL role`.
- **app_users_user_id_not_null**: `NOT NULL user_id`.

Indexes:

```sql
CREATE UNIQUE INDEX app_users_email_key ON fieldmerge.app_users USING btree (email);
CREATE UNIQUE INDEX app_users_pkey ON fieldmerge.app_users USING btree (user_id);
```

## fieldmerge.audit_events

Immutable successful business-workflow evidence. Failed HTTP attempts use the separate security_events relation so rollback cannot erase them.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| event_id | bigint | No | PK: audit_events_pkey | GENERATED ALWAYS AS IDENTITY | Event identity. |
| actor_id | uuid | Yes | FK: audit_events_actor_id_fkey | — | Responsible or identifiable actor when available. |
| record_id | uuid | Yes | FK: audit_events_record_id_fkey | — | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| submission_id | uuid | Yes | FK: audit_events_submission_id_fkey | — | Source submission identity; logical MongoDB source _id. |
| event_type | text | No | — | — | Controlled activity kind. |
| event_data | jsonb | No | — | '{}'::jsonb | Structured event details governed by the write function. |
| created_at | timestamp with time zone | No | — | now() | Server creation time. |

Constraints (including complete composite keys and null-sensitive rules):

- **audit_events_actor_id_fkey**: `FOREIGN KEY (actor_id) REFERENCES fieldmerge.app_users(user_id)`.
- **audit_events_created_at_not_null**: `NOT NULL created_at`.
- **audit_events_event_data_check**: `CHECK (jsonb_typeof(event_data) = 'object'::text)`.
- **audit_events_event_data_not_null**: `NOT NULL event_data`.
- **audit_events_event_id_not_null**: `NOT NULL event_id`.
- **audit_events_event_type_check**: `CHECK (length(btrim(event_type)) > 0)`.
- **audit_events_event_type_not_null**: `NOT NULL event_type`.
- **audit_events_pkey**: `PRIMARY KEY (event_id)`.
- **audit_events_record_id_fkey**: `FOREIGN KEY (record_id) REFERENCES fieldmerge.tree_records(record_id)`.
- **audit_events_submission_id_fkey**: `FOREIGN KEY (submission_id) REFERENCES fieldmerge.submissions(submission_id)`.
- **consistent_workflow_audit**: `TRIGGER DEFERRABLE INITIALLY DEFERRED` — DEFERRABLE, INITIALLY DEFERRED.

Indexes:

```sql
CREATE UNIQUE INDEX audit_events_pkey ON fieldmerge.audit_events USING btree (event_id);
CREATE INDEX audit_record_created ON fieldmerge.audit_events USING btree (record_id, created_at);
CREATE INDEX audit_submission_created ON fieldmerge.audit_events USING btree (submission_id, created_at);
```

## fieldmerge.field_changes

One typed scalar proposal per supplied patch field, with classification, current disposition, compared version and revision for stale-review checks.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| change_id | uuid | No | UQ: field_changes_change_id_record_id_key; PK: field_changes_pkey | — | Proposed scalar change identity. |
| submission_id | uuid | No | UQ: field_changes_submission_id_field_name_key; FK: field_changes_submission_id_record_id_fkey | — | Source submission identity; logical MongoDB source _id. |
| record_id | uuid | No | UQ: field_changes_change_id_record_id_key; UQ: field_changes_record_id_applied_version_no_field_name_key; FK: field_changes_record_id_applied_version_no_fkey; FK: field_changes_record_id_compared_version_no_fkey; FK: field_changes_submission_id_record_id_fkey | — | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| field_name | text | No | UQ: field_changes_record_id_applied_version_no_field_name_key; UQ: field_changes_submission_id_field_name_key | — | One of the four canonical editable fields. |
| base_value | jsonb | No | — | — | Typed normalized scalar in the base snapshot; JSON null means unknown. |
| proposed_value | jsonb | No | — | — | Typed normalized proposed scalar. |
| compared_value | jsonb | No | — | — | Typed scalar when the change was classified. |
| compared_version_no | integer | No | FK: field_changes_record_id_compared_version_no_fkey | — | Accepted snapshot used in classification. |
| classification | text | No | — | — | Reconciliation category; not the same as final disposition. |
| state | text | No | — | — | Current workflow disposition; allowed values are in CHECK constraints below. |
| pending_reason | text | Yes | — | — | Reason a field is awaiting review; null after disposition. |
| revision_no | integer | No | — | 1 | Review-context revision used to reject stale actions. |
| applied_version_no | integer | Yes | UQ: field_changes_record_id_applied_version_no_field_name_key; FK: field_changes_record_id_applied_version_no_fkey | — | Snapshot that actually applied this field; absent for unapplied changes. |
| updated_at | timestamp with time zone | No | — | now() | Server time of the last allowed workflow update. |

Constraints (including complete composite keys and null-sensitive rules):

- **consistent_change**: `TRIGGER DEFERRABLE INITIALLY DEFERRED` — DEFERRABLE, INITIALLY DEFERRED.
- **field_changes_base_value_not_null**: `NOT NULL base_value`.
- **field_changes_change_id_not_null**: `NOT NULL change_id`.
- **field_changes_change_id_record_id_key**: `UNIQUE (change_id, record_id)`.
- **field_changes_check**: `CHECK ((state = 'applied'::text) = (applied_version_no IS NOT NULL))`.
- **field_changes_check1**: `CHECK ((state = 'pending'::text) = (pending_reason IS NOT NULL))`.
- **field_changes_check2**: `CHECK (fieldmerge.valid_scalar(field_name, base_value) AND fieldmerge.valid_scalar(field_name, proposed_value) AND fieldmerge.valid_scalar(field_name, compared_value))`.
- **field_changes_classification_check**: `CHECK (classification = ANY (ARRAY['no_change'::text, 'compatible'::text, 'already_represented'::text, 'conflict'::text]))`.
- **field_changes_classification_not_null**: `NOT NULL classification`.
- **field_changes_compared_value_not_null**: `NOT NULL compared_value`.
- **field_changes_compared_version_no_not_null**: `NOT NULL compared_version_no`.
- **field_changes_field_name_check**: `CHECK (field_name = ANY (ARRAY['species'::text, 'health'::text, 'diameter_cm'::text, 'guard_damage'::text]))`.
- **field_changes_field_name_not_null**: `NOT NULL field_name`.
- **field_changes_pending_reason_check**: `CHECK (pending_reason = ANY (ARRAY['value_conflict'::text, 'intervening_edit'::text, 'clock_warning'::text, 'campaign_warning'::text]))`.
- **field_changes_pkey**: `PRIMARY KEY (change_id)`.
- **field_changes_proposed_value_not_null**: `NOT NULL proposed_value`.
- **field_changes_record_id_applied_version_no_field_name_key**: `UNIQUE (record_id, applied_version_no, field_name)`.
- **field_changes_record_id_applied_version_no_fkey**: `FOREIGN KEY (record_id, applied_version_no) REFERENCES fieldmerge.accepted_versions(record_id, version_no)`.
- **field_changes_record_id_compared_version_no_fkey**: `FOREIGN KEY (record_id, compared_version_no) REFERENCES fieldmerge.accepted_versions(record_id, version_no)`.
- **field_changes_record_id_not_null**: `NOT NULL record_id`.
- **field_changes_revision_no_check**: `CHECK (revision_no > 0)`.
- **field_changes_revision_no_not_null**: `NOT NULL revision_no`.
- **field_changes_state_check**: `CHECK (state = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text, 'no_change'::text, 'already_represented'::text]))`.
- **field_changes_state_not_null**: `NOT NULL state`.
- **field_changes_submission_id_field_name_key**: `UNIQUE (submission_id, field_name)`.
- **field_changes_submission_id_not_null**: `NOT NULL submission_id`.
- **field_changes_submission_id_record_id_fkey**: `FOREIGN KEY (submission_id, record_id) REFERENCES fieldmerge.submissions(submission_id, record_id)`.
- **field_changes_updated_at_not_null**: `NOT NULL updated_at`.

Indexes:

```sql
CREATE UNIQUE INDEX field_changes_change_id_record_id_key ON fieldmerge.field_changes USING btree (change_id, record_id);
CREATE UNIQUE INDEX field_changes_pkey ON fieldmerge.field_changes USING btree (change_id);
CREATE UNIQUE INDEX field_changes_record_id_applied_version_no_field_name_key ON fieldmerge.field_changes USING btree (record_id, applied_version_no, field_name);
CREATE UNIQUE INDEX field_changes_submission_id_field_name_key ON fieldmerge.field_changes USING btree (submission_id, field_name);
CREATE INDEX pending_changes ON fieldmerge.field_changes USING btree (record_id, updated_at) WHERE (state = 'pending'::text);
```

## fieldmerge.form_versions

SQL registry of supported immutable MongoDB form definitions and their agreed identity/hash.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| form_version | text | No | PK: form_versions_pkey | — | Controlled form version identifier. |
| definition_id | uuid | No | UQ: form_versions_definition_id_key | — | Logical identifier of the MongoDB form definition. |
| schema_hash | text | No | — | — | SHA-256 fingerprint of the canonical published definition. |
| is_supported | boolean | No | — | true | Whether this immutable form version permits new intake. |
| published_at | timestamp with time zone | No | — | now() | Server publication time. |

Constraints (including complete composite keys and null-sensitive rules):

- **form_versions_definition_id_key**: `UNIQUE (definition_id)`.
- **form_versions_definition_id_not_null**: `NOT NULL definition_id`.
- **form_versions_form_version_not_null**: `NOT NULL form_version`.
- **form_versions_is_supported_not_null**: `NOT NULL is_supported`.
- **form_versions_pkey**: `PRIMARY KEY (form_version)`.
- **form_versions_published_at_not_null**: `NOT NULL published_at`.
- **form_versions_schema_hash_check**: `CHECK (schema_hash ~ '^[a-f0-9]{64}$'::text)`.
- **form_versions_schema_hash_not_null**: `NOT NULL schema_hash`.

Indexes:

```sql
CREATE UNIQUE INDEX form_versions_definition_id_key ON fieldmerge.form_versions USING btree (definition_id);
CREATE UNIQUE INDEX form_versions_pkey ON fieldmerge.form_versions USING btree (form_version);
```

## fieldmerge.review_decisions

One immutable terminal disposition per proposed field, with reviewer intent, expected tokens, reason and replayable receipt.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| decision_id | uuid | No | PK: review_decisions_pkey; UQ: review_decisions_reviewer_id_client_decision_id_key | — | Immutable reviewer decision identity. |
| change_id | uuid | No | UQ: review_decisions_change_id_key; FK: review_decisions_change_id_record_id_fkey | — | Proposed scalar change identity. |
| record_id | uuid | No | FK: review_decisions_change_id_record_id_fkey; FK: review_decisions_record_id_expected_version_no_fkey; FK: review_decisions_record_id_result_version_no_fkey; UQ: review_decisions_record_id_result_version_no_key | — | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| reviewer_id | uuid | No | UQ: review_decisions_reviewer_id_client_decision_id_key; FK: review_decisions_reviewer_id_fkey | — | Authenticated reviewer responsible for the decision. |
| client_decision_id | uuid | No | UQ: review_decisions_reviewer_id_client_decision_id_key | — | Reviewer-scoped retry identity. |
| request_hash | text | No | — | — | Fingerprint of validated reviewer intent. |
| expected_version_no | integer | No | FK: review_decisions_record_id_expected_version_no_fkey | — | Accepted version the reviewer saw. |
| expected_change_revision | integer | No | — | — | Pending change revision the reviewer saw. |
| action | text | No | — | — | accept_proposal, keep_current, or replace. |
| chosen_value | jsonb | No | — | — | Typed terminal scalar, including JSON null. |
| reason | character varying(2000) | No | — | — | Trimmed nonempty reviewer explanation. |
| result_version_no | integer | Yes | FK: review_decisions_record_id_result_version_no_fkey; UQ: review_decisions_record_id_result_version_no_key | — | New accepted version if the decision changes an accepted value. |
| created_at | timestamp with time zone | No | — | now() | Server creation time. |
| decision_result | jsonb | Yes | — | — | Original immutable decision receipt for unchanged retries. |

Constraints (including complete composite keys and null-sensitive rules):

- **consistent_decision**: `TRIGGER DEFERRABLE INITIALLY DEFERRED` — DEFERRABLE, INITIALLY DEFERRED.
- **review_decisions_action_check**: `CHECK (action = ANY (ARRAY['accept_proposal'::text, 'keep_current'::text, 'replace'::text]))`.
- **review_decisions_action_not_null**: `NOT NULL action`.
- **review_decisions_change_id_key**: `UNIQUE (change_id)`.
- **review_decisions_change_id_not_null**: `NOT NULL change_id`.
- **review_decisions_change_id_record_id_fkey**: `FOREIGN KEY (change_id, record_id) REFERENCES fieldmerge.field_changes(change_id, record_id)`.
- **review_decisions_check**: `CHECK (action <> 'keep_current'::text OR result_version_no IS NULL)`.
- **review_decisions_check1**: `CHECK (result_version_no IS NULL OR result_version_no = (expected_version_no + 1))`.
- **review_decisions_chosen_value_not_null**: `NOT NULL chosen_value`.
- **review_decisions_client_decision_id_not_null**: `NOT NULL client_decision_id`.
- **review_decisions_created_at_not_null**: `NOT NULL created_at`.
- **review_decisions_decision_id_not_null**: `NOT NULL decision_id`.
- **review_decisions_expected_change_revision_check**: `CHECK (expected_change_revision > 0)`.
- **review_decisions_expected_change_revision_not_null**: `NOT NULL expected_change_revision`.
- **review_decisions_expected_version_no_not_null**: `NOT NULL expected_version_no`.
- **review_decisions_pkey**: `PRIMARY KEY (decision_id)`.
- **review_decisions_reason_check**: `CHECK (length(btrim(reason::text)) > 0)`.
- **review_decisions_reason_not_null**: `NOT NULL reason`.
- **review_decisions_record_id_expected_version_no_fkey**: `FOREIGN KEY (record_id, expected_version_no) REFERENCES fieldmerge.accepted_versions(record_id, version_no)`.
- **review_decisions_record_id_not_null**: `NOT NULL record_id`.
- **review_decisions_record_id_result_version_no_fkey**: `FOREIGN KEY (record_id, result_version_no) REFERENCES fieldmerge.accepted_versions(record_id, version_no)`.
- **review_decisions_record_id_result_version_no_key**: `UNIQUE (record_id, result_version_no)`.
- **review_decisions_request_hash_check**: `CHECK (request_hash ~ '^[a-f0-9]{64}$'::text)`.
- **review_decisions_request_hash_not_null**: `NOT NULL request_hash`.
- **review_decisions_reviewer_id_client_decision_id_key**: `UNIQUE (reviewer_id, client_decision_id)`.
- **review_decisions_reviewer_id_fkey**: `FOREIGN KEY (reviewer_id) REFERENCES fieldmerge.app_users(user_id)`.
- **review_decisions_reviewer_id_not_null**: `NOT NULL reviewer_id`.

Indexes:

```sql
CREATE INDEX decisions_reviewer_created ON fieldmerge.review_decisions USING btree (reviewer_id, created_at);
CREATE UNIQUE INDEX review_decisions_change_id_key ON fieldmerge.review_decisions USING btree (change_id);
CREATE UNIQUE INDEX review_decisions_pkey ON fieldmerge.review_decisions USING btree (decision_id);
CREATE UNIQUE INDEX review_decisions_record_id_result_version_no_key ON fieldmerge.review_decisions USING btree (record_id, result_version_no);
CREATE UNIQUE INDEX review_decisions_reviewer_id_client_decision_id_key ON fieldmerge.review_decisions USING btree (reviewer_id, client_decision_id);
```

## fieldmerge.submissions

Author-scoped request identity, source fingerprint, verified SQL patch projection, reconciliation receipt and current workflow state.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| submission_id | uuid | No | UQ: submissions_author_id_client_submission_id_key; PK: submissions_pkey; UQ: submissions_submission_id_record_id_key | — | Source submission identity; logical MongoDB source _id. |
| author_id | uuid | No | UQ: submissions_author_id_client_submission_id_key; FK: submissions_author_id_fkey | — | Authenticated author; never taken from client metadata. |
| client_submission_id | uuid | No | UQ: submissions_author_id_client_submission_id_key | — | Author-scoped retry identity. |
| record_id | uuid | No | FK: submissions_record_id_base_version_no_fkey; FK: submissions_record_id_fkey; UQ: submissions_submission_id_record_id_key | — | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| base_version_no | integer | No | FK: submissions_record_id_base_version_no_fkey | — | Existing accepted version used to prepare the proposal. |
| form_version | text | No | FK: submissions_form_version_fkey | — | Controlled form version identifier. |
| payload_hash | text | No | — | — | Canonical source-content SHA-256. |
| batch_id | uuid | Yes | FK: submission_first_batch_fk | — | Server transport batch identity; not logical source identity. |
| observed_at | timestamp with time zone | No | — | — | Claimed observation time; does not select accepted truth. |
| received_at | timestamp with time zone | No | — | now() | Server receipt time. |
| state | text | No | — | 'awaiting_document'::text | Current workflow disposition; allowed values are in CHECK constraints below. |
| source_verified_at | timestamp with time zone | Yes | — | — | Time source identity, form and fingerprint were verified. |
| requires_review | boolean | No | — | false | Clock/campaign warning holds changed values for review. |
| warnings | jsonb | No | — | '[]'::jsonb | Structured warning-code array. |
| rejection_reason | text | Yes | — | — | Terminal validation explanation when applicable. |
| lease_token | uuid | Yes | — | — | Current bounded processing/recovery claim identity. |
| lease_expires_at | timestamp with time zone | Yes | — | — | Claim expiry used with fencing checks. |
| last_error | character varying(2000) | Yes | — | — | Bounded operational diagnostic. |
| updated_at | timestamp with time zone | No | — | now() | Server time of the last allowed workflow update. |
| verified_patch | jsonb | Yes | — | — | Verified typed SQL projection; not a replacement for sealed evidence. |
| reconciliation_result | jsonb | Yes | — | — | Original immutable reconciliation receipt. |

Constraints (including complete composite keys and null-sensitive rules):

- **consistent_submission**: `TRIGGER DEFERRABLE INITIALLY DEFERRED` — DEFERRABLE, INITIALLY DEFERRED.
- **consistent_submission_batch**: `TRIGGER DEFERRABLE INITIALLY DEFERRED` — DEFERRABLE, INITIALLY DEFERRED.
- **submission_first_batch_fk**: `FOREIGN KEY (batch_id) REFERENCES fieldmerge_ops.intake_batches(batch_id)`.
- **submissions_author_id_client_submission_id_key**: `UNIQUE (author_id, client_submission_id)`.
- **submissions_author_id_fkey**: `FOREIGN KEY (author_id) REFERENCES fieldmerge.app_users(user_id)`.
- **submissions_author_id_not_null**: `NOT NULL author_id`.
- **submissions_base_version_no_not_null**: `NOT NULL base_version_no`.
- **submissions_check**: `CHECK ((state = ANY (ARRAY['awaiting_document'::text, 'rejected'::text])) OR source_verified_at IS NOT NULL)`.
- **submissions_check1**: `CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))`.
- **submissions_check2**: `CHECK ((state = 'processing'::text) = (lease_token IS NOT NULL))`.
- **submissions_check3**: `CHECK (state <> 'rejected'::text OR length(btrim(rejection_reason)) > 0 AND rejection_reason IS NOT NULL)`.
- **submissions_client_submission_id_not_null**: `NOT NULL client_submission_id`.
- **submissions_form_version_fkey**: `FOREIGN KEY (form_version) REFERENCES fieldmerge.form_versions(form_version)`.
- **submissions_form_version_not_null**: `NOT NULL form_version`.
- **submissions_observed_at_not_null**: `NOT NULL observed_at`.
- **submissions_payload_hash_check**: `CHECK (payload_hash ~ '^[a-f0-9]{64}$'::text)`.
- **submissions_payload_hash_not_null**: `NOT NULL payload_hash`.
- **submissions_pkey**: `PRIMARY KEY (submission_id)`.
- **submissions_received_at_not_null**: `NOT NULL received_at`.
- **submissions_record_id_base_version_no_fkey**: `FOREIGN KEY (record_id, base_version_no) REFERENCES fieldmerge.accepted_versions(record_id, version_no)`.
- **submissions_record_id_fkey**: `FOREIGN KEY (record_id) REFERENCES fieldmerge.tree_records(record_id)`.
- **submissions_record_id_not_null**: `NOT NULL record_id`.
- **submissions_requires_review_not_null**: `NOT NULL requires_review`.
- **submissions_state_check**: `CHECK (state = ANY (ARRAY['awaiting_document'::text, 'ready'::text, 'processing'::text, 'needs_review'::text, 'partially_applied'::text, 'applied'::text, 'no_change'::text, 'resolved'::text, 'rejected'::text]))`.
- **submissions_state_not_null**: `NOT NULL state`.
- **submissions_submission_id_not_null**: `NOT NULL submission_id`.
- **submissions_submission_id_record_id_key**: `UNIQUE (submission_id, record_id)`.
- **submissions_updated_at_not_null**: `NOT NULL updated_at`.
- **submissions_warnings_check**: `CHECK (jsonb_typeof(warnings) = 'array'::text)`.
- **submissions_warnings_not_null**: `NOT NULL warnings`.

Indexes:

```sql
CREATE UNIQUE INDEX submissions_author_id_client_submission_id_key ON fieldmerge.submissions USING btree (author_id, client_submission_id);
CREATE INDEX submissions_author_received ON fieldmerge.submissions USING btree (author_id, received_at);
CREATE INDEX submissions_first_batch ON fieldmerge.submissions USING btree (batch_id) WHERE (batch_id IS NOT NULL);
CREATE UNIQUE INDEX submissions_pkey ON fieldmerge.submissions USING btree (submission_id);
CREATE INDEX submissions_processing ON fieldmerge.submissions USING btree (state, lease_expires_at);
CREATE INDEX submissions_record_received ON fieldmerge.submissions USING btree (record_id, received_at);
CREATE UNIQUE INDEX submissions_submission_id_record_id_key ON fieldmerge.submissions USING btree (submission_id, record_id);
```

## fieldmerge.survey_campaigns

Campaign identity, observation window and dataset/import attribution. The MVP uses one campaign.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| campaign_id | uuid | No | PK: survey_campaigns_pkey | — | Campaign identity. |
| name | character varying(160) | No | — | — | Campaign display name. |
| starts_at | timestamp with time zone | No | — | — | Campaign reference-window start. |
| ends_at | timestamp with time zone | No | — | — | Campaign reference-window end. |
| source_dataset_id | text | No | — | — | Attributed source dataset identifier. |
| source_url | text | No | — | — | Source attribution URL. |
| import_mapping_version | text | No | — | — | Version of deterministic baseline source mapping. |
| created_at | timestamp with time zone | No | — | now() | Server creation time. |

Constraints (including complete composite keys and null-sensitive rules):

- **survey_campaigns_campaign_id_not_null**: `NOT NULL campaign_id`.
- **survey_campaigns_check**: `CHECK (ends_at >= starts_at)`.
- **survey_campaigns_created_at_not_null**: `NOT NULL created_at`.
- **survey_campaigns_ends_at_not_null**: `NOT NULL ends_at`.
- **survey_campaigns_import_mapping_version_not_null**: `NOT NULL import_mapping_version`.
- **survey_campaigns_name_check**: `CHECK (length(btrim(name::text)) > 0)`.
- **survey_campaigns_name_not_null**: `NOT NULL name`.
- **survey_campaigns_pkey**: `PRIMARY KEY (campaign_id)`.
- **survey_campaigns_source_dataset_id_not_null**: `NOT NULL source_dataset_id`.
- **survey_campaigns_source_url_not_null**: `NOT NULL source_url`.
- **survey_campaigns_starts_at_not_null**: `NOT NULL starts_at`.

Indexes:

```sql
CREATE UNIQUE INDEX survey_campaigns_pkey ON fieldmerge.survey_campaigns USING btree (campaign_id);
```

## fieldmerge.tree_records

Stable campaign-scoped tree identity. Accepted values live in accepted_versions rather than mutable duplicate columns here.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| record_id | uuid | No | UQ: tree_records_campaign_id_source_record_id_key; PK: tree_records_pkey | — | Stable tree identity; composite guard columns keep linked rows on the same tree. |
| campaign_id | uuid | No | FK: tree_records_campaign_id_fkey; UQ: tree_records_campaign_id_source_record_id_key | — | Campaign identity. |
| source_record_id | text | No | UQ: tree_records_campaign_id_source_record_id_key | — | External source identity, unique within campaign. |
| imported_at | timestamp with time zone | No | — | now() | Baseline import time. |
| is_active | boolean | No | — | true | Whether new guarded use of this identity is allowed. |
| created_at | timestamp with time zone | No | — | now() | Server creation time. |

Constraints (including complete composite keys and null-sensitive rules):

- **tree_initial_version**: `TRIGGER DEFERRABLE INITIALLY DEFERRED` — DEFERRABLE, INITIALLY DEFERRED.
- **tree_records_campaign_id_fkey**: `FOREIGN KEY (campaign_id) REFERENCES fieldmerge.survey_campaigns(campaign_id)`.
- **tree_records_campaign_id_not_null**: `NOT NULL campaign_id`.
- **tree_records_campaign_id_source_record_id_key**: `UNIQUE (campaign_id, source_record_id)`.
- **tree_records_created_at_not_null**: `NOT NULL created_at`.
- **tree_records_imported_at_not_null**: `NOT NULL imported_at`.
- **tree_records_is_active_not_null**: `NOT NULL is_active`.
- **tree_records_pkey**: `PRIMARY KEY (record_id)`.
- **tree_records_record_id_not_null**: `NOT NULL record_id`.
- **tree_records_source_record_id_check**: `CHECK (length(btrim(source_record_id)) > 0)`.
- **tree_records_source_record_id_not_null**: `NOT NULL source_record_id`.

Indexes:

```sql
CREATE UNIQUE INDEX tree_records_campaign_id_source_record_id_key ON fieldmerge.tree_records USING btree (campaign_id, source_record_id);
CREATE UNIQUE INDEX tree_records_pkey ON fieldmerge.tree_records USING btree (record_id);
```

## fieldmerge_auth.login_attempts

Hashed login-attempt keys and counters used to bound repeated authentication failures.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| attempt_key | text | No | PK: login_attempts_pkey | — | Hashed login-attempt key. |
| window_start | timestamp with time zone | No | — | — | Login-attempt window start. |
| attempts | integer | No | — | — | Attempt counter. |

Constraints (including complete composite keys and null-sensitive rules):

- **login_attempts_attempt_key_not_null**: `NOT NULL attempt_key`.
- **login_attempts_attempts_not_null**: `NOT NULL attempts`.
- **login_attempts_pkey**: `PRIMARY KEY (attempt_key)`.
- **login_attempts_window_start_not_null**: `NOT NULL window_start`.

Indexes:

```sql
CREATE UNIQUE INDEX login_attempts_pkey ON fieldmerge_auth.login_attempts USING btree (attempt_key);
```

## fieldmerge_auth.sessions

Revocable eight-hour sessions. Only the token hash is stored; the opaque browser token is server-only cookie material.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| token_hash | text | No | PK: sessions_pkey | — | SHA-256 session-token hash; secret session identifiers are not exported as data. |
| user_id | uuid | No | FK: sessions_user_id_fkey | — | Application user identity. |
| expires_at | timestamp with time zone | No | — | — | Session expiry. |
| created_at | timestamp with time zone | No | — | clock_timestamp() | Server creation time. |

Constraints (including complete composite keys and null-sensitive rules):

- **sessions_created_at_not_null**: `NOT NULL created_at`.
- **sessions_expires_at_not_null**: `NOT NULL expires_at`.
- **sessions_pkey**: `PRIMARY KEY (token_hash)`.
- **sessions_token_hash_check**: `CHECK (token_hash ~ '^[a-f0-9]{64}$'::text)`.
- **sessions_token_hash_not_null**: `NOT NULL token_hash`.
- **sessions_user_id_fkey**: `FOREIGN KEY (user_id) REFERENCES fieldmerge.app_users(user_id)`.
- **sessions_user_id_not_null**: `NOT NULL user_id`.

Indexes:

```sql
CREATE UNIQUE INDEX sessions_pkey ON fieldmerge_auth.sessions USING btree (token_hash);
CREATE INDEX sessions_user ON fieldmerge_auth.sessions USING btree (user_id);
```

## fieldmerge_meta.migrations

Applied ordered migration versions and SHA-256 checksums. The registry is implementation metadata, not a business entity.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| version | text | No | PK: migrations_pkey | — | Applied ordered migration number. |
| checksum | text | No | — | — | SHA-256 of applied migration file. |
| applied_at | timestamp with time zone | No | — | now() | Migration application time. |

Constraints (including complete composite keys and null-sensitive rules):

- **migrations_applied_at_not_null**: `NOT NULL applied_at`.
- **migrations_checksum_not_null**: `NOT NULL checksum`.
- **migrations_pkey**: `PRIMARY KEY (version)`.
- **migrations_version_not_null**: `NOT NULL version`.

Indexes:

```sql
CREATE UNIQUE INDEX migrations_pkey ON fieldmerge_meta.migrations USING btree (version);
```

## fieldmerge_ops.batch_items

Independent batch position, canonical content hash, source reference or safe item error. Positions may reference an existing submission across retries/batches.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| batch_id | uuid | No | FK: batch_items_batch_id_fkey; PK: batch_items_pkey | — | Server transport batch identity; not logical source identity. |
| item_index | integer | No | PK: batch_items_pkey | — | Original zero-based batch position. |
| content_hash | text | No | — | — | Canonical item fingerprint used for unchanged manifest replay. |
| submission_id | uuid | Yes | FK: batch_items_submission_id_fkey | — | Source submission identity; logical MongoDB source _id. |
| error_code | character varying(80) | Yes | — | — | Bounded safe failure code. |
| updated_at | timestamp with time zone | No | — | clock_timestamp() | Server time of the last allowed workflow update. |

Constraints (including complete composite keys and null-sensitive rules):

- **batch_items_batch_id_fkey**: `FOREIGN KEY (batch_id) REFERENCES fieldmerge_ops.intake_batches(batch_id)`.
- **batch_items_batch_id_not_null**: `NOT NULL batch_id`.
- **batch_items_content_hash_check**: `CHECK (content_hash ~ '^[a-f0-9]{64}$'::text)`.
- **batch_items_content_hash_not_null**: `NOT NULL content_hash`.
- **batch_items_error_code_check**: `CHECK (error_code IS NULL OR error_code::text ~ '^[a-z_]{1,80}$'::text)`.
- **batch_items_item_index_check**: `CHECK (item_index >= 0 AND item_index <= 99)`.
- **batch_items_item_index_not_null**: `NOT NULL item_index`.
- **batch_items_pkey**: `PRIMARY KEY (batch_id, item_index)`.
- **batch_items_submission_id_fkey**: `FOREIGN KEY (submission_id) REFERENCES fieldmerge.submissions(submission_id)`.
- **batch_items_updated_at_not_null**: `NOT NULL updated_at`.
- **consistent_batch_item**: `TRIGGER DEFERRABLE INITIALLY DEFERRED` — DEFERRABLE, INITIALLY DEFERRED.

Indexes:

```sql
CREATE UNIQUE INDEX batch_items_pkey ON fieldmerge_ops.batch_items USING btree (batch_id, item_index);
CREATE INDEX batch_items_submission ON fieldmerge_ops.batch_items USING btree (submission_id) WHERE (submission_id IS NOT NULL);
```

## fieldmerge_ops.intake_batches

Owner-scoped stable batch request identity and manifest fingerprint. A batch is transport grouping, not one atomic publication.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| batch_id | uuid | No | UQ: intake_batches_owner_id_client_batch_id_key; PK: intake_batches_pkey | gen_random_uuid() | Server transport batch identity; not logical source identity. |
| owner_id | uuid | No | UQ: intake_batches_owner_id_client_batch_id_key; FK: intake_batches_owner_id_fkey | — | Authenticated owner of a batch or recovery target. |
| client_batch_id | uuid | No | UQ: intake_batches_owner_id_client_batch_id_key | — | Owner-scoped retry identity for a batch. |
| manifest_hash | text | No | — | — | Fingerprint of ordered batch content. |
| item_count | integer | No | — | — | Number of manifest positions. |
| created_at | timestamp with time zone | No | — | clock_timestamp() | Server creation time. |

Constraints (including complete composite keys and null-sensitive rules):

- **consistent_intake_batch**: `TRIGGER DEFERRABLE INITIALLY DEFERRED` — DEFERRABLE, INITIALLY DEFERRED.
- **intake_batches_batch_id_not_null**: `NOT NULL batch_id`.
- **intake_batches_client_batch_id_not_null**: `NOT NULL client_batch_id`.
- **intake_batches_created_at_not_null**: `NOT NULL created_at`.
- **intake_batches_item_count_check**: `CHECK (item_count >= 1 AND item_count <= 100)`.
- **intake_batches_item_count_not_null**: `NOT NULL item_count`.
- **intake_batches_manifest_hash_check**: `CHECK (manifest_hash ~ '^[a-f0-9]{64}$'::text)`.
- **intake_batches_manifest_hash_not_null**: `NOT NULL manifest_hash`.
- **intake_batches_owner_id_client_batch_id_key**: `UNIQUE (owner_id, client_batch_id)`.
- **intake_batches_owner_id_fkey**: `FOREIGN KEY (owner_id) REFERENCES fieldmerge.app_users(user_id)`.
- **intake_batches_owner_id_not_null**: `NOT NULL owner_id`.
- **intake_batches_pkey**: `PRIMARY KEY (batch_id)`.

Indexes:

```sql
CREATE UNIQUE INDEX intake_batches_owner_id_client_batch_id_key ON fieldmerge_ops.intake_batches USING btree (owner_id, client_batch_id);
CREATE UNIQUE INDEX intake_batches_pkey ON fieldmerge_ops.intake_batches USING btree (batch_id);
```

## fieldmerge_ops.recovery_events

Append-only recovery activity associated with a job and optional responsible actor.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| event_id | bigint | No | PK: recovery_events_pkey | GENERATED ALWAYS AS IDENTITY | Event identity. |
| job_id | uuid | No | FK: recovery_events_job_id_fkey | — | Recovery job identity. |
| event_type | text | No | — | — | Controlled activity kind. |
| actor_id | uuid | Yes | FK: recovery_events_actor_id_fkey | — | Responsible or identifiable actor when available. |
| event_data | jsonb | No | — | '{}'::jsonb | Structured event details governed by the write function. |
| created_at | timestamp with time zone | No | — | clock_timestamp() | Server creation time. |

Constraints (including complete composite keys and null-sensitive rules):

- **recovery_events_actor_id_fkey**: `FOREIGN KEY (actor_id) REFERENCES fieldmerge.app_users(user_id)`.
- **recovery_events_created_at_not_null**: `NOT NULL created_at`.
- **recovery_events_event_data_check**: `CHECK (jsonb_typeof(event_data) = 'object'::text)`.
- **recovery_events_event_data_not_null**: `NOT NULL event_data`.
- **recovery_events_event_id_not_null**: `NOT NULL event_id`.
- **recovery_events_event_type_check**: `CHECK (event_type = ANY (ARRAY['queued'::text, 'claimed'::text, 'failure'::text, 'retry_requested'::text, 'completed'::text]))`.
- **recovery_events_event_type_not_null**: `NOT NULL event_type`.
- **recovery_events_job_id_fkey**: `FOREIGN KEY (job_id) REFERENCES fieldmerge_ops.recovery_jobs(job_id)`.
- **recovery_events_job_id_not_null**: `NOT NULL job_id`.
- **recovery_events_pkey**: `PRIMARY KEY (event_id)`.

Indexes:

```sql
CREATE INDEX recovery_event_job ON fieldmerge_ops.recovery_events USING btree (job_id, event_id);
CREATE UNIQUE INDEX recovery_events_pkey ON fieldmerge_ops.recovery_events USING btree (event_id);
```

## fieldmerge_ops.recovery_jobs

Persistent bounded recovery scheduling, attempts, backoff, claims and fencing tokens for submission/draft recovery.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| job_id | uuid | No | PK: recovery_jobs_pkey | gen_random_uuid() | Recovery job identity. |
| job_kind | text | No | UQ: recovery_jobs_job_kind_target_id_key | — | Submission or sealed-draft recovery work kind. |
| target_id | uuid | No | UQ: recovery_jobs_job_kind_target_id_key | — | Target UUID; polymorphic/possibly nonexistent targets have no general entity FK. |
| owner_id | uuid | No | FK: recovery_jobs_owner_id_fkey | — | Authenticated owner of a batch or recovery target. |
| submission_id | uuid | Yes | FK: recovery_jobs_submission_id_fkey | — | Source submission identity; logical MongoDB source _id. |
| status | text | No | — | 'queued'::text | Recovery lifecycle status. |
| attempts | integer | No | — | 0 | Attempt counter. |
| failure_count | integer | No | — | 0 | Bounded recovery failure counter. |
| next_attempt_at | timestamp with time zone | No | — | clock_timestamp() | Earliest next eligible recovery time. |
| lease_token | uuid | Yes | — | — | Current bounded processing/recovery claim identity. |
| lease_expires_at | timestamp with time zone | Yes | — | — | Claim expiry used with fencing checks. |
| claimed_by | uuid | Yes | — | — | Worker claim identifier. |
| last_error_code | character varying(80) | Yes | — | — | Safe most recent recovery error. |
| created_at | timestamp with time zone | No | — | clock_timestamp() | Server creation time. |
| updated_at | timestamp with time zone | No | — | clock_timestamp() | Server time of the last allowed workflow update. |
| completed_at | timestamp with time zone | Yes | — | — | Recovery completion time when applicable. |

Constraints (including complete composite keys and null-sensitive rules):

- **recovery_jobs_attempts_check**: `CHECK (attempts >= 0)`.
- **recovery_jobs_attempts_not_null**: `NOT NULL attempts`.
- **recovery_jobs_check**: `CHECK (job_kind <> 'submission'::text OR submission_id IS NOT NULL AND submission_id = target_id)`.
- **recovery_jobs_check1**: `CHECK ((status = 'leased'::text) = (lease_token IS NOT NULL))`.
- **recovery_jobs_check2**: `CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))`.
- **recovery_jobs_check3**: `CHECK ((status = 'completed'::text) = (completed_at IS NOT NULL))`.
- **recovery_jobs_created_at_not_null**: `NOT NULL created_at`.
- **recovery_jobs_failure_count_check**: `CHECK (failure_count >= 0)`.
- **recovery_jobs_failure_count_not_null**: `NOT NULL failure_count`.
- **recovery_jobs_job_id_not_null**: `NOT NULL job_id`.
- **recovery_jobs_job_kind_check**: `CHECK (job_kind = ANY (ARRAY['submission'::text, 'draft'::text]))`.
- **recovery_jobs_job_kind_not_null**: `NOT NULL job_kind`.
- **recovery_jobs_job_kind_target_id_key**: `UNIQUE (job_kind, target_id)`.
- **recovery_jobs_next_attempt_at_not_null**: `NOT NULL next_attempt_at`.
- **recovery_jobs_owner_id_fkey**: `FOREIGN KEY (owner_id) REFERENCES fieldmerge.app_users(user_id)`.
- **recovery_jobs_owner_id_not_null**: `NOT NULL owner_id`.
- **recovery_jobs_pkey**: `PRIMARY KEY (job_id)`.
- **recovery_jobs_status_check**: `CHECK (status = ANY (ARRAY['queued'::text, 'leased'::text, 'retry'::text, 'waiting_source'::text, 'blocked'::text, 'quarantined'::text, 'completed'::text]))`.
- **recovery_jobs_status_not_null**: `NOT NULL status`.
- **recovery_jobs_submission_id_fkey**: `FOREIGN KEY (submission_id) REFERENCES fieldmerge.submissions(submission_id)`.
- **recovery_jobs_target_id_not_null**: `NOT NULL target_id`.
- **recovery_jobs_updated_at_not_null**: `NOT NULL updated_at`.

Indexes:

```sql
CREATE INDEX recovery_due ON fieldmerge_ops.recovery_jobs USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'retry'::text, 'waiting_source'::text, 'leased'::text]));
CREATE UNIQUE INDEX recovery_jobs_job_kind_target_id_key ON fieldmerge_ops.recovery_jobs USING btree (job_kind, target_id);
CREATE UNIQUE INDEX recovery_jobs_pkey ON fieldmerge_ops.recovery_jobs USING btree (job_id);
```

## fieldmerge_ops.security_events

Safe failure context persisted independently of rejected/rolled-back business requests. No request body, credential, token or session hash is stored here.

| Column | PostgreSQL type | Nullable | Key membership | Default | Meaning |
|---|---|---|---|---|---|
| request_id | uuid | No | PK: security_events_pkey | — | Server-generated HTTP correlation UUID. |
| occurred_at | timestamp with time zone | No | — | clock_timestamp() | Server time of failure-event insertion. |
| actor_id | uuid | Yes | FK: security_events_actor_id_fkey | — | Responsible or identifiable actor when available. |
| actor_role | text | Yes | — | — | Role of an identifiable actor; not proof authorization succeeded. |
| method | text | No | — | — | Bounded HTTP method enumeration. |
| route_template | character varying(100) | No | — | — | Allowlisted route template; excludes raw URL and query. |
| target_id | uuid | Yes | — | — | Target UUID; polymorphic/possibly nonexistent targets have no general entity FK. |
| http_status | smallint | No | — | — | Mapped HTTP failure status 400–599. |
| error_code | character varying(80) | No | — | — | Bounded safe failure code. |
| sqlstate | character varying(5) | Yes | — | — | Optional five-character SQLSTATE, excluding raw exception text. |

Constraints (including complete composite keys and null-sensitive rules):

- **security_events_actor_id_fkey**: `FOREIGN KEY (actor_id) REFERENCES fieldmerge.app_users(user_id)`.
- **security_events_actor_role_check**: `CHECK (actor_role = ANY (ARRAY['surveyor'::text, 'reviewer'::text]))`.
- **security_events_check**: `CHECK ((actor_id IS NULL) = (actor_role IS NULL))`.
- **security_events_error_code_check**: `CHECK (error_code::text ~ '^[a-z][a-z0-9_]{0,79}$'::text)`.
- **security_events_error_code_not_null**: `NOT NULL error_code`.
- **security_events_http_status_check**: `CHECK (http_status >= 400 AND http_status <= 599)`.
- **security_events_http_status_not_null**: `NOT NULL http_status`.
- **security_events_method_check**: `CHECK (method = ANY (ARRAY['GET'::text, 'POST'::text, 'PUT'::text, 'DELETE'::text, 'HEAD'::text, 'OPTIONS'::text, 'OTHER'::text]))`.
- **security_events_method_not_null**: `NOT NULL method`.
- **security_events_occurred_at_not_null**: `NOT NULL occurred_at`.
- **security_events_pkey**: `PRIMARY KEY (request_id)`.
- **security_events_request_id_not_null**: `NOT NULL request_id`.
- **security_events_route_template_check**: `CHECK (route_template::text ~ '^/api/[a-z/:._-]+$'::text)`.
- **security_events_route_template_not_null**: `NOT NULL route_template`.
- **security_events_sqlstate_check**: `CHECK (sqlstate::text ~ '^[A-Z0-9]{5}$'::text)`.

Indexes:

```sql
CREATE UNIQUE INDEX security_events_pkey ON fieldmerge_ops.security_events USING btree (request_id);
CREATE INDEX security_events_recent ON fieldmerge_ops.security_events USING btree (occurred_at DESC, request_id DESC);
```

## Views

- **fieldmerge.field_value_provenance**. SQL definition is in the schema catalog.
- **fieldmerge.latest_accepted_records**. SQL definition is in the schema catalog.
- **fieldmerge.pending_field_reviews**. SQL definition is in the schema catalog.
- **fieldmerge.submission_outcomes**. SQL definition is in the schema catalog.

## Explicit triggers

| Table | Trigger | Deferred |
|---|---|---|
| fieldmerge.accepted_versions | consistent_version | Initially deferred |
| fieldmerge.accepted_versions | immutable_versions | No |
| fieldmerge.accepted_versions | zz_workflow_versions | No |
| fieldmerge.audit_events | audit_same_record | No |
| fieldmerge.audit_events | consistent_workflow_audit | Initially deferred |
| fieldmerge.audit_events | immutable_audit | No |
| fieldmerge.audit_events | zz_workflow_audit | No |
| fieldmerge.field_changes | consistent_change | Initially deferred |
| fieldmerge.field_changes | zz_workflow_changes | No |
| fieldmerge.review_decisions | consistent_decision | Initially deferred |
| fieldmerge.review_decisions | decision_actor_value | No |
| fieldmerge.review_decisions | immutable_decisions | No |
| fieldmerge.review_decisions | zz_workflow_decisions | No |
| fieldmerge.submissions | consistent_submission | Initially deferred |
| fieldmerge.submissions | consistent_submission_batch | Initially deferred |
| fieldmerge.submissions | immutable_first_batch | No |
| fieldmerge.submissions | immutable_verified_submission | No |
| fieldmerge.submissions | zz_workflow_submissions | No |
| fieldmerge.submissions | zzz_submission_recovery | No |
| fieldmerge.tree_records | tree_initial_version | Initially deferred |
| fieldmerge_ops.batch_items | consistent_batch_item | Initially deferred |
| fieldmerge_ops.batch_items | immutable_batch_item | No |
| fieldmerge_ops.intake_batches | consistent_intake_batch | Initially deferred |
| fieldmerge_ops.intake_batches | immutable_intake_batches | No |
| fieldmerge_ops.recovery_events | immutable_recovery_events | No |
| fieldmerge_ops.security_events | immutable_security_events | No |

## MongoDB collections

Canonical lowercase UUID strings are logical cross-store references, not foreign keys. Source dates are BSON dates and diameter bounds/values are Decimal128. Canonical source JSON preserves original timestamp spelling and exact numeric content for fingerprinting. SQL owns accepted truth; MongoDB stores source envelopes, versioned form definitions and owner-scoped drafts. See [the document model](FieldMerge_MongoDB_Model.md) for field semantics, state transitions and examples. Complete executable validators are preserved in output/design/schema-catalog.json.

### form_definitions

Validation: strict / error. Required top-level fields: _id, form_version, schema_hash, published_at, canonical_fields, optional_sections.

| Index | Keys | Unique |
|---|---|---|
| _id_ | {"_id":1} | Yes |
| form_version_1 | {"form_version":1} | Yes |

### submission_documents

Validation: strict / error. Required top-level fields: .

| Index | Keys | Unique |
|---|---|---|
| _id_ | {"_id":1} | Yes |
| author_id_1_client_submission_id_1 | {"author_id":1,"client_submission_id":1} | Yes |
| record_id_1_received_at_1 | {"record_id":1,"received_at":1} | No |
| form_version_1_received_at_1 | {"form_version":1,"received_at":1} | No |
| batch_id_1_received_at_1 | {"batch_id":1,"received_at":1} | No |

### submission_drafts

Validation: strict / error. Required top-level fields: .

| Index | Keys | Unique |
|---|---|---|
| _id_ | {"_id":1} | Yes |
| owner_id_1_client_submission_id_1 | {"owner_id":1,"client_submission_id":1} | Yes |
| owner_id_1_state_1_updated_at_1 | {"owner_id":1,"state":1,"updated_at":1} | No |
| state_1__id_1 | {"state":1,"_id":1} | No |

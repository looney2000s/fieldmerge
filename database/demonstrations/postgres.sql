-- Read-only assessment queries. $1 is a record UUID supplied by the runner.
-- Run individual queries using a privileged inspection connection, not the API login.

-- @query Q01 Latest accepted records and campaign context: JOIN + ORDER BY.
SELECT r.source_record_id, c.name AS campaign, r.version_no,
       r.species, r.health, r.diameter_cm, r.guard_damage
FROM fieldmerge.latest_accepted_records r
JOIN fieldmerge.survey_campaigns c USING(campaign_id)
ORDER BY r.record_id LIMIT 20;

-- @query Q02 Pending proposals with author and current comparison: multi-table view JOIN.
SELECT p.change_id,p.field_name,p.base_value,p.current_value,p.proposed_value,
       p.current_version_no,u.display_name AS surveyor
FROM fieldmerge.pending_field_reviews p
JOIN fieldmerge.app_users u ON u.user_id=p.author_id
WHERE p.record_id=$1 ORDER BY p.change_id;

-- @query Q03 Submission history for one record: indexed filter and ordered retrieval.
SELECT submission_id,form_version,base_version_no,state,received_at
FROM fieldmerge.submissions WHERE record_id=$1
ORDER BY received_at,submission_id;

-- @query Q04 Records with multiple pending fields: CTE + aggregation + GROUP BY + HAVING.
WITH workload AS (
  SELECT record_id,count(*) AS pending_fields
  FROM fieldmerge.field_changes WHERE state='pending'
  GROUP BY record_id HAVING count(*)>1
)
SELECT r.source_record_id,w.pending_fields
FROM workload w JOIN fieldmerge.tree_records r USING(record_id)
ORDER BY w.pending_fields DESC,r.record_id LIMIT 20;

-- @query Q05 Records with an unresolved species proposal: correlated EXISTS.
SELECT r.source_record_id,r.version_no,r.species
FROM fieldmerge.latest_accepted_records r
WHERE EXISTS (
  SELECT 1 FROM fieldmerge.field_changes c
  WHERE c.record_id=r.record_id AND c.field_name='species' AND c.state='pending'
)
ORDER BY r.record_id LIMIT 20;

-- @query Q06 Follow one latest snapshot to its baseline: bounded recursive parent chain.
WITH RECURSIVE lineage AS (
  SELECT v.record_id,v.version_no,v.parent_version_no,v.health,0 AS depth
  FROM fieldmerge.accepted_versions v
  WHERE v.record_id=$1 AND v.version_no=(
    SELECT max(a.version_no) FROM fieldmerge.accepted_versions a WHERE a.record_id=$1
  )
  UNION ALL
  SELECT p.record_id,p.version_no,p.parent_version_no,p.health,l.depth+1
  FROM lineage l JOIN fieldmerge.accepted_versions p
    ON p.record_id=l.record_id AND p.version_no=l.parent_version_no
  WHERE l.depth<100
)
SELECT version_no,parent_version_no,health,depth FROM lineage ORDER BY depth;

-- @query Q07 Latest per-field provenance using the implemented view.
SELECT field_name,value,origin_version_no,origin_submission_id,decision_id,reviewer_id,reason
FROM fieldmerge.field_value_provenance
WHERE record_id=$1 AND version_no=(
  SELECT max(version_no) FROM fieldmerge.accepted_versions WHERE record_id=$1
)
ORDER BY field_name;

-- @query Q08 Equivalent provenance computation with the record restriction inside the CTE.
WITH actual_changes AS (
  SELECT v.record_id,v.version_no,v.origin_submission_id,v.published_by,
         f.field_name,coalesce(to_jsonb(v)->f.field_name,'null'::jsonb) AS value
  FROM fieldmerge.accepted_versions v
  LEFT JOIN fieldmerge.accepted_versions prev
    ON prev.record_id=v.record_id AND prev.version_no=v.parent_version_no
  CROSS JOIN (VALUES('species'),('health'),('diameter_cm'),('guard_damage')) f(field_name)
  WHERE v.record_id=$1 AND (
    v.version_no=1 OR coalesce(to_jsonb(v)->f.field_name,'null'::jsonb)
      IS DISTINCT FROM coalesce(to_jsonb(prev)->f.field_name,'null'::jsonb)
  )
)
SELECT f.field_name,o.value,o.version_no AS origin_version_no,o.origin_submission_id,
       d.decision_id,d.reviewer_id,d.reason
FROM (VALUES('species'),('health'),('diameter_cm'),('guard_damage')) f(field_name)
JOIN LATERAL (
  SELECT * FROM actual_changes a WHERE a.field_name=f.field_name
  ORDER BY a.version_no DESC LIMIT 1
) o ON true
LEFT JOIN fieldmerge.field_changes c
  ON c.record_id=o.record_id AND c.applied_version_no=o.version_no AND c.field_name=f.field_name
LEFT JOIN fieldmerge.review_decisions d ON d.change_id=c.change_id
ORDER BY f.field_name;

-- @query Q09 Intervening edits including reversals: window LAG + null-aware comparison.
WITH revisions AS (
  SELECT version_no,health,
         lag(health) OVER(ORDER BY version_no) AS previous_health
  FROM fieldmerge.accepted_versions WHERE record_id=$1
)
SELECT version_no,health,previous_health,
       version_no>1 AND health IS DISTINCT FROM previous_health AS actually_changed
FROM revisions ORDER BY version_no;

-- @query Q10 Latest accepted completeness: conditional aggregates preserve null/false/zero.
SELECT count(*) AS accepted_records,
       count(*) FILTER(WHERE health IS NULL) AS health_unknown,
       count(*) FILTER(WHERE diameter_cm=0) AS known_zero_diameter,
       count(*) FILTER(WHERE guard_damage=false) AS known_no_guard_damage
FROM fieldmerge.latest_accepted_records;

-- @query Q11 Accepted health distribution: aggregate + GROUP BY + ORDER BY.
SELECT health,count(*) AS records,round(avg(diameter_cm),2) AS mean_diameter_cm
FROM fieldmerge.latest_accepted_records GROUP BY health
ORDER BY records DESC,health NULLS LAST;

-- @query Q12 SQL validation function: numeric zero and boolean false are typed values.
SELECT fieldmerge.valid_scalar('diameter_cm','0'::jsonb) AS zero_valid,
       fieldmerge.valid_scalar('guard_damage','false'::jsonb) AS false_valid,
       fieldmerge.valid_scalar('guard_damage','"false"'::jsonb) AS string_boolean_valid;

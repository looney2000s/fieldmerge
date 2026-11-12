\set ON_ERROR_STOP on
BEGIN;
-- Disposable staging data only. Never DELETE accepted history to demonstrate DML.
CREATE TEMP TABLE fm_import_staging (
  source_record_id text PRIMARY KEY,
  health text CHECK(health IN ('Good','Fair','Poor')),
  diameter_cm numeric CHECK(diameter_cm>=0),
  guard_damage boolean
);
ALTER TABLE fm_import_staging ADD COLUMN import_note text;
INSERT INTO fm_import_staging VALUES
 ('STAGING-1','Good',0,false,'Synthetic staging row'),
 ('STAGING-2','Fair',30,NULL,'Synthetic staging row');
UPDATE fm_import_staging SET health='Poor' WHERE source_record_id='STAGING-2';
CREATE INDEX fm_staging_health ON fm_import_staging(health);
CREATE TEMP VIEW fm_staging_known_guard AS
 SELECT * FROM fm_import_staging WHERE guard_damage IS NOT NULL;
SELECT json_build_object('demo','DDL_DML','inserted',count(*),
 'zero_false_rows',count(*) FILTER(WHERE diameter_cm=0 AND guard_damage=false),
 'updated_rows',count(*) FILTER(WHERE health='Poor')) FROM fm_import_staging;
DO $$ BEGIN
 BEGIN
  INSERT INTO fm_import_staging VALUES('INVALID','Good',-1,true,'Must fail');
  RAISE EXCEPTION 'Negative diameter constraint failed';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
DELETE FROM fm_import_staging WHERE source_record_id='STAGING-2';
SELECT json_build_object('demo','DELETE_STAGING','remaining',count(*)) FROM fm_import_staging;
DROP VIEW fm_staging_known_guard;
DROP INDEX fm_staging_health;
DROP TABLE fm_import_staging;
ROLLBACK;

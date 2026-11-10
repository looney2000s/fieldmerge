\set ON_ERROR_STOP on
\o /dev/null
BEGIN;
SET search_path=fieldmerge,public;
CREATE TEMP TABLE query_results(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.ok(label text,condition boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label;END IF;INSERT INTO query_results VALUES(label);
END $$;
CREATE FUNCTION pg_temp.error(label text,command text,expected text) RETURNS void LANGUAGE plpgsql AS $$ DECLARE code text;BEGIN
 BEGIN EXECUTE command;EXCEPTION WHEN OTHERS THEN code:=SQLSTATE;END;
 IF code IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL %, expected %, got %',label,expected,code;END IF;INSERT INTO query_results VALUES(label);
END $$;
DO $$ DECLARE surveyor text=repeat('e',64);reviewer text=repeat('f',64);other text=repeat('c',64);b jsonb;s jsonb;client uuid=gen_random_uuid();item uuid=gen_random_uuid();h text=repeat('a',64);t uuid='30000000-0000-4000-8000-000000000001';other_user uuid=gen_random_uuid();BEGIN
 PERFORM api_create_session('10000000-0000-4000-8000-000000000001',surveyor);PERFORM api_create_session('10000000-0000-4000-8000-000000000002',reviewer);
 PERFORM pg_temp.ok('record cursor fetch is bounded',jsonb_array_length(api_records_page(surveyor,NULL,NULL,NULL,NULL,NULL,1))=2);
 PERFORM pg_temp.ok('literal percent filter is not a wildcard',api_records_page(surveyor,'%',NULL,NULL,NULL,NULL,10)='[]');
 PERFORM pg_temp.error('SQL page limits are guarded',format('SELECT api_records_page(%L,NULL,NULL,NULL,NULL,NULL,101)',surveyor),'22023');
 PERFORM pg_temp.ok('historical baseline snapshot downloads',api_snapshot_download(surveyor,t,1)->'record'->>'version_no'='1');
 PERFORM pg_temp.ok('unknown snapshot is not fabricated',api_snapshot_download(surveyor,t,999999) IS NULL);
 PERFORM pg_temp.error('surveyor cannot export all records',format('SELECT api_accepted_export(%L,NULL,NULL,NULL,NULL)',surveyor),'42501');
 PERFORM pg_temp.error('surveyor cannot read aggregate workflow totals',format('SELECT api_sql_summary(%L)',surveyor),'42501');
 PERFORM pg_temp.ok('SQL aggregate totals match independent records',(api_sql_summary(reviewer)->>'accepted_records')::int=(SELECT count(*) FROM tree_records));
 b:=api_register_batch(surveyor,client,jsonb_build_array(h));
 PERFORM pg_temp.ok('batch registration replay is stable',api_register_batch(surveyor,client,jsonb_build_array(h))=b);
 PERFORM pg_temp.error('changed manifest conflicts',format('SELECT api_register_batch(%L,%L,jsonb_build_array(repeat(''b'',64)))',surveyor,client),'22023');
 s:=api_reserve_batch_item(surveyor,(b->>'batch_id')::uuid,0,item,t,1,'tree-v1',h,'2026-06-01');
 PERFORM pg_temp.ok('new source captures first intake batch',s->>'batch_id'=b->>'batch_id');
 PERFORM pg_temp.ok('membership is linked to reserved source',api_batch_detail(surveyor,(b->>'batch_id')::uuid)->'items'->0->>'submission_id'=s->>'submission_id');
 PERFORM pg_temp.ok('reviewer can inspect transport outcome',api_batch_detail(reviewer,(b->>'batch_id')::uuid) IS NOT NULL);
 b:=api_register_batch(surveyor,gen_random_uuid(),jsonb_build_array(h));
 s:=api_reserve_batch_item(surveyor,(b->>'batch_id')::uuid,0,item,t,1,'tree-v1',h,'2026-06-01');
 PERFORM pg_temp.ok('later batch does not rewrite first attribution',s->>'batch_id'<>b->>'batch_id');
 PERFORM api_batch_error(surveyor,(b->>'batch_id')::uuid,0,'source_missing');
 PERFORM pg_temp.ok('item failure is durable',api_batch_detail(surveyor,(b->>'batch_id')::uuid)->'items'->0->>'error'='source_missing');
 PERFORM pg_temp.error('first batch is immutable',format('UPDATE submissions SET batch_id=%L WHERE submission_id=%L',b->>'batch_id',s->>'submission_id'),'42501');
 PERFORM pg_temp.error('batch manifests are immutable',format('UPDATE fieldmerge_ops.intake_batches SET item_count=2 WHERE batch_id=%L',b->>'batch_id'),'42501');
 PERFORM pg_temp.ok('API has no direct transport table privileges',NOT has_table_privilege('fieldmerge_api','fieldmerge_ops.batch_items','UPDATE'));
 PERFORM pg_temp.ok('worker cannot register arbitrary batches',NOT has_function_privilege('fieldmerge_worker','fieldmerge.api_register_batch(text,uuid,jsonb)','EXECUTE'));
 INSERT INTO app_users(user_id,email,password_hash,display_name,role) VALUES(other_user,other_user::text||'@test.invalid','non-login-fixture','Other batch owner','surveyor');
 PERFORM api_create_session(other_user,other);
 b:=api_register_batch(other,gen_random_uuid(),jsonb_build_array(h));
 PERFORM pg_temp.error('cross-author membership fails at transaction completion',format($q$DO $x$ BEGIN
  UPDATE fieldmerge_ops.batch_items SET submission_id=%L WHERE batch_id=%L;
  SET CONSTRAINTS ALL IMMEDIATE;END $x$; $q$,s->>'submission_id',b->>'batch_id'),'23514');
 b:=api_register_batch(surveyor,gen_random_uuid(),jsonb_build_array(repeat('b',64)));
 PERFORM pg_temp.error('mismatched source fingerprint fails at transaction completion',format($q$DO $x$ BEGIN
  UPDATE fieldmerge_ops.batch_items SET submission_id=%L WHERE batch_id=%L;
  SET CONSTRAINTS ALL IMMEDIATE;END $x$; $q$,s->>'submission_id',b->>'batch_id'),'23514');
 s:=api_reserve_submission(surveyor,gen_random_uuid(),t,1,'tree-v1',h,'2026-06-01');
 b:=api_register_batch(surveyor,gen_random_uuid(),jsonb_build_array(h));
 PERFORM pg_temp.error('first intake attribution requires a membership link',format($q$DO $x$ BEGIN
  SET LOCAL ROLE fieldmerge_workflow;UPDATE fieldmerge.submissions SET batch_id=%L WHERE submission_id=%L;
  RESET ROLE;SET CONSTRAINTS ALL IMMEDIATE;END $x$; $q$,b->>'batch_id',s->>'submission_id'),'23514');
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
\o
\pset format unaligned
\pset tuples_only on
SELECT 'Query/export/batch checks passed: '||count(*) FROM query_results;
ROLLBACK;

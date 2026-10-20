-- Read-only activation verification. Fail closed on a stale trigger function.
-- Execute with psql -v ON_ERROR_STOP=1 against the intended Tower database.
BEGIN READ ONLY;
DO $$ DECLARE expected RECORD; installed TEXT; BEGIN
 FOR expected IN SELECT * FROM (VALUES
   ('flightdeck_pg_record_access','87dec756599e5b96ed4e9e9fa2fa36da'), -- gitleaks:allow public SQL function body fingerprint
   -- The priority-sync supplement extends emit with a compact record-head
   -- projection while retaining the additive journal/current semantics.
   ('flightdeck_pg_record_emit','b1c8b6ea1fcbb012df9a7fb0c590d007'), -- gitleaks:allow public SQL function body fingerprint
   ('flightdeck_pg_record_capture','06a60ee67226508f5f5843c903081c5a'), -- gitleaks:allow public SQL function body fingerprint
   ('flightdeck_pg_record_reset','c7c6b5dfec142a35d47696b454cdeaf4') -- gitleaks:allow public SQL function body fingerprint
 ) AS functions(name,digest) LOOP
   SELECT md5(p.prosrc) INTO installed FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=expected.name;
   IF installed IS DISTINCT FROM expected.digest THEN
     RAISE EXCEPTION 'Missing or stale additive sync function: %',expected.name;
   END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
   AND table_name='flightdeck_pg_record_clock' AND column_name='access_revision' AND data_type='bigint')
 OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
   AND table_name='flightdeck_pg_record_current' AND column_name='position' AND data_type='bigint') THEN
   RAISE EXCEPTION 'Additive sync columns are missing';
 END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname='fd_record_reset' AND NOT tgisinternal
   AND tgfoid='flightdeck_pg_record_reset()'::regprocedure AND (tgtype & 28)=28
   AND tgrelid IN ('flightdeck_pg_permission_grants'::regclass,'flightdeck_pg_group_memberships'::regclass,
     'flightdeck_pg_group_edges'::regclass,'flightdeck_pg_workspace_memberships'::regclass,
     'flightdeck_pg_scopes'::regclass,'flightdeck_pg_channels'::regclass)) <> 6 THEN
   RAISE EXCEPTION 'Additive sync authority trigger bindings are missing';
 END IF;
 IF EXISTS(SELECT 1 FROM flightdeck_pg_record_cursors WHERE NOT state ? 'access')
 OR EXISTS(SELECT 1 FROM flightdeck_pg_record_clients WHERE NOT initial_state ? 'access'
   OR (checkpoint_state IS NOT NULL AND NOT checkpoint_state ? 'access'))
 OR EXISTS(SELECT 1 FROM flightdeck_pg_record_page_tokens WHERE NOT state ? 'access') THEN
   RAISE EXCEPTION 'Pre-extension continuation baselines remain';
 END IF;
END $$;
SELECT 'additive-record-access-v1 schema verified' AS result;
COMMIT;

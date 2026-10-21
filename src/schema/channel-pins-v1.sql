-- Add channel selections without rewriting historical pin rows or receipts.
ALTER TABLE flightdeck_pg_thread_pins ADD COLUMN IF NOT EXISTS scope_id UUID;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='flightdeck_pg_thread_pins'::regclass AND conname='fd_personal_pin_type' AND pg_get_constraintdef(oid) LIKE '%channel%') THEN
  ALTER TABLE flightdeck_pg_thread_pins DROP CONSTRAINT IF EXISTS fd_personal_pin_type;
  ALTER TABLE flightdeck_pg_thread_pins ADD CONSTRAINT fd_personal_pin_type CHECK(resource_type IN ('thread','task','document','channel') AND
    ((resource_type='thread' AND thread_id IS NOT NULL AND thread_id=resource_id) OR (resource_type<>'thread' AND thread_id IS NULL)));
 END IF;
END $$;

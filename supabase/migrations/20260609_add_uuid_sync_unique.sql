-- UNIQUE index on uuid_sync to prevent duplicate movements when offline retry happens
-- This is the critical fix: when a movement is sent online but the response is lost
-- (network drop), and then retried from the offline queue with the same UUID,
-- this constraint ensures the server rejects the duplicate.

CREATE UNIQUE INDEX IF NOT EXISTS idx_movimientos_uuid_sync_unique 
  ON public.movimientos (uuid_sync) 
  WHERE uuid_sync IS NOT NULL;

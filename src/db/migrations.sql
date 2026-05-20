-- Safe migrations — each statement wrapped to tolerate "already exists" errors
-- D1 executes these as individual statements; duplicates fail silently in batch mode

-- v0.3: add persona column to profiles
ALTER TABLE profiles ADD COLUMN persona TEXT;

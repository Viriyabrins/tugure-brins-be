-- Enable UUID generation (PostgreSQL)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Stores records for every entity the frontend cares about without a dedicated table per resource
CREATE TABLE IF NOT EXISTS entity_records (
  id UUID PRIMARY KEY,
  entity_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Table for building notifications/activities independently from entity tables
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'INFO',
  module TEXT,
  reference_id UUID,
  target_role TEXT DEFAULT 'ALL',
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

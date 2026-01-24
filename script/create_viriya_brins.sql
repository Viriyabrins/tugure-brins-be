-- create_viriya_brins.sql
-- Creates role `brins` with password, sets search_path and creates database `viriya` owned by brins

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'brins') THEN
    CREATE ROLE brins LOGIN PASSWORD 'V1R1y4#123';
  ELSE
    ALTER ROLE brins WITH PASSWORD 'V1R1y4#123';
  END IF;
  ALTER ROLE brins SET search_path = 'brins', public;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'viriya') THEN
    CREATE DATABASE viriya OWNER brins;
  END IF;
END
$$;

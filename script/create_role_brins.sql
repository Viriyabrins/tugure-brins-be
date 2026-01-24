-- create_role_brins.sql
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

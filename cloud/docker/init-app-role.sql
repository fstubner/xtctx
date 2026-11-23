-- Bootstrap a non-owner, NOBYPASSRLS role so SET LOCAL ROLE enforces RLS on tenant queries.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xtctx_app') THEN
    CREATE ROLE xtctx_app NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  EXECUTE format('GRANT xtctx_app TO %I', current_user);
END
$$;

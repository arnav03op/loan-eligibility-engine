-- Runs once when the dev-db volume is first created.
-- loan_engine (n8n dev data) is created by POSTGRES_DB; this adds the test database.
CREATE DATABASE loan_engine_test;

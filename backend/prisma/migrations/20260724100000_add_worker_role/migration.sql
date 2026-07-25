-- v3.5.9: WORKER role (VIEWER + Horarios de Personal access only). Added in
-- its own migration because PG forbids using a newly added enum value inside
-- the same transaction that adds it (v3.4.4 INSTALLED_IN precedent).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'WORKER';

-- Favourite exercises (issue #404): additive only. A constant default on a new
-- column is a metadata-only change in PostgreSQL 11+, so existing rows read
-- false without a table rewrite.
-- Rollback: ALTER TABLE "Exercise" DROP COLUMN "isFavorite";

-- AlterTable
ALTER TABLE "Exercise" ADD COLUMN "isFavorite" BOOLEAN NOT NULL DEFAULT false;

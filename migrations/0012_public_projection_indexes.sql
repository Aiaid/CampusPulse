-- Apply after the Worker has switched public reads to the incremental tables.
-- These old canonical-table indexes were explicitly named by the prior Worker.
DROP INDEX ingestion_items_v2_public_time;
DROP INDEX ingestion_items_v2_public_receipt;

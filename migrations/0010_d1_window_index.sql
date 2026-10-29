-- Apply after the Worker no longer uses INDEXED BY ingestion_items_v2_window.
-- Immutable identity uniqueness already covers node/boot/stream/window probes.
DROP INDEX ingestion_items_v2_window;

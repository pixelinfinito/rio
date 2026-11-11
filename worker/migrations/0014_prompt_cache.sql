ALTER TABLE usage ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE usage ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE usage ADD COLUMN usage_convention TEXT CHECK(usage_convention IS NULL OR usage_convention IN ('verified','unverified','invalid'));
ALTER TABLE usage ADD COLUMN cost_source TEXT CHECK(cost_source IS NULL OR cost_source IN ('provider','estimate','self-hosted','unknown'));
CREATE TABLE IF NOT EXISTS prompt_partitions (tenant TEXT PRIMARY KEY, secret TEXT NOT NULL)

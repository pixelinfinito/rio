ALTER TABLE qa_model_usage ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE qa_model_usage ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE qa_model_usage ADD COLUMN usage_convention TEXT CHECK(usage_convention IS NULL OR usage_convention IN ('verified','unverified','invalid'));
ALTER TABLE qa_model_usage ADD COLUMN cost_source TEXT CHECK(cost_source IS NULL OR cost_source IN ('provider','estimate','unknown'));
ALTER TABLE qa_runs ADD COLUMN prompt_cache TEXT

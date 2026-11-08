ALTER TABLE finding_history ADD COLUMN seen_code_hash TEXT;
ALTER TABLE finding_history ADD COLUMN first_seen_at INTEGER;
ALTER TABLE finding_history ADD COLUMN last_seen_at INTEGER;
ALTER TABLE finding_history ADD COLUMN status_at INTEGER;
CREATE TABLE IF NOT EXISTS finding_sightings (tenant TEXT NOT NULL, repository TEXT NOT NULL, identity TEXT NOT NULL, review_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(tenant,repository,identity,review_id));
ALTER TABLE feedback ADD COLUMN repository TEXT;
CREATE INDEX IF NOT EXISTS feedback_repository ON feedback(tenant,repository,created_at)

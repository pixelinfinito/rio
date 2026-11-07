CREATE TABLE IF NOT EXISTS lineages (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, repository TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('pr','branch')), ref TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1), round INTEGER NOT NULL DEFAULT 0 CHECK(round >= 0), previous_head TEXT, previous_review TEXT, posted_json TEXT NOT NULL DEFAULT '{}', rounds_to_pass INTEGER, intent TEXT, updated_at INTEGER NOT NULL, UNIQUE(tenant,repository,kind,ref));
CREATE TABLE IF NOT EXISTS lineage_reviews (seq INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL UNIQUE, tenant TEXT NOT NULL, lineage_id TEXT NOT NULL, generation INTEGER NOT NULL, snapshot_id TEXT NOT NULL, round INTEGER, reviewed INTEGER NOT NULL DEFAULT 0, posted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS lineage_reviews_generation ON lineage_reviews(lineage_id,generation,seq);
CREATE TABLE IF NOT EXISTS findings (tenant TEXT NOT NULL, lineage_id TEXT NOT NULL, generation INTEGER NOT NULL, identity TEXT NOT NULL, review_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, repository TEXT NOT NULL, rule_id TEXT NOT NULL, category TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('agent','tool')), state TEXT NOT NULL CHECK(state IN ('new','worsened','pre-existing','fixed','unclassified')), status TEXT NOT NULL CHECK(status IN ('open','fixed','dismissed')), round INTEGER NOT NULL CHECK(round >= 1), first_posted_in TEXT, author_response_json TEXT, resolution_json TEXT, location_json TEXT NOT NULL, finding_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(tenant,lineage_id,generation,identity));
CREATE INDEX IF NOT EXISTS findings_identity ON findings(tenant,identity,updated_at);
CREATE INDEX IF NOT EXISTS findings_repository ON findings(tenant,repository);
CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, finding_id TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT, note TEXT, created_at INTEGER NOT NULL);
UPDATE feedback SET reason = CASE reason WHEN 'false_positive' THEN 'wrong' WHEN 'known' THEN 'intentional' ELSE reason END WHERE reason IN ('false_positive','known');
DROP TABLE IF EXISTS feedback_next;
CREATE TABLE feedback_next (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, finding_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('fixed','wrong','intentional','irrelevant','style')), actor TEXT, note TEXT, created_at INTEGER NOT NULL);
INSERT INTO feedback_next(id,tenant,finding_id,reason,actor,note,created_at) SELECT id,tenant,finding_id,reason,actor,note,created_at FROM feedback;
DROP TABLE feedback;
ALTER TABLE feedback_next RENAME TO feedback;
CREATE INDEX IF NOT EXISTS feedback_finding ON feedback(tenant,finding_id)

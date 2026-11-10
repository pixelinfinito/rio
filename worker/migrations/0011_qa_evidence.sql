ALTER TABLE qa_runs ADD COLUMN evidence_pruned INTEGER NOT NULL DEFAULT 0;
CREATE TABLE qa_evidence (run_id TEXT NOT NULL REFERENCES qa_runs(id), id TEXT NOT NULL, tenant TEXT NOT NULL, review_id TEXT NOT NULL, generation TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, descriptor TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','stored')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(run_id,id));
CREATE INDEX qa_evidence_expiry ON qa_evidence(expires_at);
CREATE TABLE qa_evidence_manifests (run_id TEXT PRIMARY KEY REFERENCES qa_runs(id), notes TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE qa_evidence_garbage (object_key TEXT PRIMARY KEY, tenant TEXT NOT NULL, review_id TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0);

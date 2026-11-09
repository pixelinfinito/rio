-- Rotate retries so a stalled upload or transient deletion failure cannot
-- starve newer expired objects in the bounded scheduled sweep.
ALTER TABLE qa_evidence_garbage ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX qa_evidence_garbage_retry ON qa_evidence_garbage(next_attempt_at,object_key);

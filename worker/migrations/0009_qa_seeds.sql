-- Versioned physical objects let pruning delete an old upload without racing a
-- concurrent writer of the same content hash. Heads are the only commit point.
CREATE TABLE qa_seed_parts (tenant TEXT NOT NULL, hash TEXT NOT NULL, object_key TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0), created_at INTEGER NOT NULL, PRIMARY KEY(tenant,hash));
CREATE TABLE qa_seed_leases (tenant TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, max_size INTEGER NOT NULL CHECK(max_size > 0), expires_at INTEGER NOT NULL, PRIMARY KEY(tenant,id));
CREATE INDEX qa_seed_lease_fingerprint ON qa_seed_leases(tenant,fingerprint,expires_at);
CREATE TABLE qa_seed_lease_parts (tenant TEXT NOT NULL, lease_id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(tenant,lease_id,hash), FOREIGN KEY(tenant,lease_id) REFERENCES qa_seed_leases(tenant,id) ON DELETE CASCADE);
CREATE TABLE qa_seed_versions (tenant TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, object_key TEXT NOT NULL, lease_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,id));
CREATE INDEX qa_seed_version_fingerprint ON qa_seed_versions(tenant,fingerprint);
CREATE TABLE qa_seed_version_parts (tenant TEXT NOT NULL, version_id TEXT NOT NULL, hash TEXT NOT NULL, object_key TEXT NOT NULL, PRIMARY KEY(tenant,version_id,hash), FOREIGN KEY(tenant,version_id) REFERENCES qa_seed_versions(tenant,id) ON DELETE CASCADE);
CREATE TABLE qa_seed_heads (tenant TEXT NOT NULL, fingerprint TEXT NOT NULL, version_id TEXT NOT NULL, created_at INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(tenant,fingerprint), FOREIGN KEY(tenant,version_id) REFERENCES qa_seed_versions(tenant,id));
CREATE TABLE qa_seed_garbage (tenant TEXT NOT NULL, object_key TEXT NOT NULL, PRIMARY KEY(tenant,object_key));
CREATE INDEX qa_seed_part_object ON qa_seed_parts(tenant,object_key);
CREATE INDEX qa_seed_pending_part ON qa_seed_lease_parts(tenant,hash,lease_id);
CREATE INDEX qa_seed_version_part_hash ON qa_seed_version_parts(tenant,hash);
CREATE INDEX qa_seed_version_part_object ON qa_seed_version_parts(tenant,object_key);

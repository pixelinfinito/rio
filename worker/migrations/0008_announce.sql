ALTER TABLE pull_requests ADD COLUMN publish_policy TEXT CHECK(publish_policy IS NULL OR publish_policy IN ('never','ask','auto'));
ALTER TABLE pull_requests ADD COLUMN announced_check INTEGER

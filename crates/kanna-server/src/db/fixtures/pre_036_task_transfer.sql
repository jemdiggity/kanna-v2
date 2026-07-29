ALTER TABLE pipeline_item ADD COLUMN activity_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pipeline_item ADD COLUMN cloud_task_id TEXT;
UPDATE pipeline_item SET cloud_task_id = id WHERE cloud_task_id IS NULL;
CREATE UNIQUE INDEX idx_pipeline_item_open_cloud_task_id
    ON pipeline_item(cloud_task_id)
    WHERE closed_at IS NULL;

ALTER TABLE task_transfer ADD COLUMN source_desktop_id TEXT;
ALTER TABLE task_transfer ADD COLUMN target_desktop_id TEXT;
ALTER TABLE task_transfer ADD COLUMN sidecar_cleanup_completed_at TEXT;

CREATE TABLE create_task_intent (
    task_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES pipeline_item(id) ON DELETE CASCADE
);

ALTER TABLE pipeline_item ADD COLUMN revision_rounds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pipeline_item ADD COLUMN blocker_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER task_blocker_insert_revision
AFTER INSERT ON task_blocker
BEGIN
  UPDATE pipeline_item
  SET blocker_revision = blocker_revision + 1
  WHERE id = NEW.blocked_item_id;
END;

CREATE TRIGGER task_blocker_delete_revision
AFTER DELETE ON task_blocker
BEGIN
  UPDATE pipeline_item
  SET blocker_revision = blocker_revision + 1
  WHERE id = OLD.blocked_item_id;
END;

CREATE TRIGGER task_blocker_resolution_revision
AFTER UPDATE OF stage, pr_url, closed_at ON pipeline_item
WHEN
  CASE
    WHEN OLD.closed_at IS NOT NULL
      OR (OLD.stage = 'pr' AND OLD.pr_url IS NOT NULL)
    THEN 1 ELSE 0
  END
  <>
  CASE
    WHEN NEW.closed_at IS NOT NULL
      OR (NEW.stage = 'pr' AND NEW.pr_url IS NOT NULL)
    THEN 1 ELSE 0
  END
BEGIN
  UPDATE pipeline_item
  SET blocker_revision = blocker_revision + 1
  WHERE id IN (
    SELECT blocked_item_id
    FROM task_blocker
    WHERE blocker_item_id = NEW.id
  );
END;

INSERT INTO task_transfer (
    id, direction, status, source_peer_id, source_task_id, local_task_id, payload_json
) VALUES
    ('legacy-stream-before-task', 'incoming', 'streaming', 'peer-source', 'source-before', NULL, '{}'),
    ('legacy-stream-after-task', 'incoming', 'streaming', 'peer-source', 'source-after', 'origin-main-task', '{}');

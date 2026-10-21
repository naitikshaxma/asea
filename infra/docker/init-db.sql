-- Autonomous AI Software Engineering Platform - Initial Development Schema
-- Phase 1: Baseline system tables

CREATE TABLE IF NOT EXISTS system_metadata (
    key VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO system_metadata (key, value)
VALUES
    ('platform_phase', '1'),
    ('schema_version', '0.1.0'),
    ('environment', 'development')
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS task_intake_records (
    id VARCHAR(128) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    task_type VARCHAR(64) NOT NULL,
    priority VARCHAR(32) NOT NULL,
    status VARCHAR(64) NOT NULL,
    repository_url VARCHAR(512),
    target_branch VARCHAR(128) DEFAULT 'main',
    execution_metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON task_intake_records(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON task_intake_records(created_at DESC);

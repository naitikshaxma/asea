ALTER TYPE "WorkflowStepType" ADD VALUE 'INDEPENDENT_REVIEW';

ALTER TABLE "TaskPatch"
  ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN "evidence" JSONB,
  ADD COLUMN "testResults" JSONB,
  ADD COLUMN "securityResults" JSONB,
  ADD COLUMN "reviewResults" JSONB,
  ADD COLUMN "sandboxDiagnostics" JSONB;

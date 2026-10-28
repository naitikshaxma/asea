ALTER TYPE "WorkflowStepType" ADD VALUE 'GENERATE_PATCH';
ALTER TYPE "WorkflowStepType" ADD VALUE 'APPLY_PATCH';
ALTER TYPE "WorkflowStepType" ADD VALUE 'EXECUTE_TESTS';
ALTER TYPE "WorkflowStepType" ADD VALUE 'REQUEST_APPROVAL';

CREATE TYPE "TaskPatchStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'INVALIDATED');

CREATE TABLE "TaskPatch" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "patchHash" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "contextFiles" JSONB NOT NULL,
    "changedFiles" JSONB NOT NULL,
    "unifiedDiff" TEXT NOT NULL,
    "testStatus" TEXT NOT NULL DEFAULT 'NOT_RUN',
    "securityStatus" TEXT NOT NULL DEFAULT 'NOT_RUN',
    "workspaceCleanupStatus" TEXT NOT NULL DEFAULT 'CLEANED',
    "status" "TaskPatchStatus" NOT NULL DEFAULT 'PROPOSED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskPatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskPatch_taskId_patchHash_key" ON "TaskPatch"("taskId", "patchHash");
CREATE UNIQUE INDEX "TaskPatch_workflowRunId_key" ON "TaskPatch"("workflowRunId");
CREATE INDEX "TaskPatch_taskId_idx" ON "TaskPatch"("taskId");
CREATE INDEX "TaskPatch_status_idx" ON "TaskPatch"("status");

ALTER TABLE "TaskPatch" ADD CONSTRAINT "TaskPatch_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskPatch" ADD CONSTRAINT "TaskPatch_workflowRunId_fkey"
  FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Idempotency keys are unique per workspace (B10). Fails if a workspace
-- already holds duplicate keys; resolve those rows before migrating.
DROP INDEX "Task_idempotencyKey_idx";
CREATE UNIQUE INDEX "Task_workspaceId_idempotencyKey_key" ON "Task"("workspaceId", "idempotencyKey");

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "githubFullName" TEXT,
ADD COLUMN     "githubWebhookSecret" TEXT;

-- AlterTable
ALTER TABLE "VerificationRun" ADD COLUMN     "github" JSONB;

-- CreateIndex
CREATE INDEX "Repository_githubFullName_idx" ON "Repository"("githubFullName");

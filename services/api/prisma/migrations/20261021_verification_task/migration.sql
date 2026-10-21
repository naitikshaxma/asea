-- AlterEnum
ALTER TYPE "TaskType" ADD VALUE 'VERIFICATION';

-- AlterEnum
ALTER TYPE "WorkflowStepType" ADD VALUE 'STATIC_ANALYSIS';

-- AlterTable
ALTER TABLE "VerificationRun" ADD COLUMN     "taskId" TEXT;

-- CreateIndex
CREATE INDEX "VerificationRun_taskId_idx" ON "VerificationRun"("taskId");

-- AddForeignKey
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;


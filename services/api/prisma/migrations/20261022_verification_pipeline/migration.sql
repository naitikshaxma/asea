-- AlterEnum (PostgreSQL 12+ allows several ADD VALUE statements in one migration)
ALTER TYPE "WorkflowStepType" ADD VALUE 'INDEX_REPOSITORY';
ALTER TYPE "WorkflowStepType" ADD VALUE 'VERIFICATION_PIPELINE';

-- AlterTable
ALTER TABLE "VerificationRun" ADD COLUMN     "agentTimeline" JSONB,
ADD COLUMN     "engineInfo" JSONB,
ADD COLUMN     "report" JSONB;

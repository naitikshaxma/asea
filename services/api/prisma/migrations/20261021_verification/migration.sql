-- CreateEnum
CREATE TYPE "VerificationRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AuthorType" AS ENUM ('AI', 'HUMAN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('STATIC', 'NEGATIVE_SPACE', 'ARCHITECTURE', 'TEST_GAP');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "FindingSource" AS ENUM ('DETERMINISTIC', 'LLM');

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "hash" TEXT,
ADD COLUMN     "prevHash" TEXT;

-- CreateTable
CREATE TABLE "VerificationRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "authorType" "AuthorType" NOT NULL,
    "status" "VerificationRunStatus" NOT NULL DEFAULT 'QUEUED',
    "score" DOUBLE PRECISION,
    "verdict" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationFinding" (
    "id" TEXT NOT NULL,
    "verificationRunId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "category" "FindingCategory" NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "evidence" TEXT[],
    "source" "FindingSource" NOT NULL,
    "ruleId" TEXT NOT NULL,
    "remediation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationRun_workspaceId_idx" ON "VerificationRun"("workspaceId");

-- CreateIndex
CREATE INDEX "VerificationRun_repositoryId_idx" ON "VerificationRun"("repositoryId");

-- CreateIndex
CREATE INDEX "VerificationRun_status_idx" ON "VerificationRun"("status");

-- CreateIndex
CREATE INDEX "VerificationFinding_severity_idx" ON "VerificationFinding"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationFinding_verificationRunId_findingId_key" ON "VerificationFinding"("verificationRunId", "findingId");

-- CreateIndex
CREATE INDEX "AuditEvent_resourceType_resourceId_idx" ON "AuditEvent"("resourceType", "resourceId");

-- AddForeignKey
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationFinding" ADD CONSTRAINT "VerificationFinding_verificationRunId_fkey" FOREIGN KEY ("verificationRunId") REFERENCES "VerificationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


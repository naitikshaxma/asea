-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "RepositoryAnalysis" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "analyzerVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "summary" JSONB,
    "technologies" JSONB,
    "inventory" JSONB,
    "statistics" JSONB,
    "errorSummary" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepositoryAnalysis_repositoryId_idx" ON "RepositoryAnalysis"("repositoryId");

-- CreateIndex
CREATE INDEX "RepositoryAnalysis_workspaceId_idx" ON "RepositoryAnalysis"("workspaceId");

-- CreateIndex
CREATE INDEX "RepositoryAnalysis_status_idx" ON "RepositoryAnalysis"("status");

-- CreateIndex
CREATE INDEX "RepositoryAnalysis_createdAt_idx" ON "RepositoryAnalysis"("createdAt");

-- AddForeignKey
ALTER TABLE "RepositoryAnalysis" ADD CONSTRAINT "RepositoryAnalysis_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryAnalysis" ADD CONSTRAINT "RepositoryAnalysis_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

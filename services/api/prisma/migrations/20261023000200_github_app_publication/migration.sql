CREATE TYPE "PatchPublicationStatus" AS ENUM ('NOT_PUBLISHED', 'PUBLISHING', 'PR_OPEN', 'FAILED');
CREATE TYPE "PatchCiStatus" AS ENUM ('NOT_CONFIGURED', 'PENDING', 'SUCCESS', 'FAILURE', 'ERROR');

CREATE TABLE "GithubAppInstallation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GithubAppInstallation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GithubAppInstallation_workspaceId_installationId_key" ON "GithubAppInstallation"("workspaceId", "installationId");
CREATE INDEX "GithubAppInstallation_workspaceId_idx" ON "GithubAppInstallation"("workspaceId");
ALTER TABLE "GithubAppInstallation" ADD CONSTRAINT "GithubAppInstallation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Repository" ADD COLUMN "githubAppInstallationId" TEXT;
CREATE INDEX "Repository_githubAppInstallationId_idx" ON "Repository"("githubAppInstallationId");
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_githubAppInstallationId_fkey"
  FOREIGN KEY ("githubAppInstallationId") REFERENCES "GithubAppInstallation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TaskPatch"
  ADD COLUMN "sourceRevision" TEXT,
  ADD COLUMN "baseFiles" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "publicationStatus" "PatchPublicationStatus" NOT NULL DEFAULT 'NOT_PUBLISHED',
  ADD COLUMN "publicationError" TEXT,
  ADD COLUMN "publishedBranch" TEXT,
  ADD COLUMN "githubCommitSha" TEXT,
  ADD COLUMN "pullRequestNumber" INTEGER,
  ADD COLUMN "pullRequestUrl" TEXT,
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "ciStatus" "PatchCiStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  ADD COLUMN "ciChecks" JSONB,
  ADD COLUMN "ciSyncedAt" TIMESTAMP(3);

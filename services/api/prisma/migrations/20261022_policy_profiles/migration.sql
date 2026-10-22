-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('ALLOW', 'REVIEW', 'HIGH_RISK', 'BLOCK');

-- AlterTable: verdict was an unused free-text column (always NULL); convert it in place
ALTER TABLE "VerificationRun" ALTER COLUMN "verdict" TYPE "Verdict" USING ("verdict"::"Verdict");
ALTER TABLE "VerificationRun" ADD COLUMN     "policyHash" TEXT,
ADD COLUMN     "policyProfileId" TEXT,
ADD COLUMN     "policySnapshot" JSONB,
ADD COLUMN     "scoreBreakdown" JSONB;

-- CreateTable
CREATE TABLE "PolicyProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PolicyProfile_workspaceId_idx" ON "PolicyProfile"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyProfile_workspaceId_name_key" ON "PolicyProfile"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "VerificationRun_policyProfileId_idx" ON "VerificationRun"("policyProfileId");

-- AddForeignKey
ALTER TABLE "PolicyProfile" ADD CONSTRAINT "PolicyProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_policyProfileId_fkey" FOREIGN KEY ("policyProfileId") REFERENCES "PolicyProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

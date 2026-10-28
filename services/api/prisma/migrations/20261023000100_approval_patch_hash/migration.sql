-- Bind an approval to the exact patch it reviewed. The column is nullable so
-- existing approval rows (if any) remain readable and are not dropped.
ALTER TABLE "Approval" ADD COLUMN "patchHash" TEXT;

CREATE UNIQUE INDEX "Approval_taskId_patchHash_key" ON "Approval"("taskId", "patchHash");

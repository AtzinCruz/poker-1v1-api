-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "rematchMatchId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Match_rematchMatchId_key" ON "Match"("rematchMatchId");

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_rematchMatchId_fkey" FOREIGN KEY ("rematchMatchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;


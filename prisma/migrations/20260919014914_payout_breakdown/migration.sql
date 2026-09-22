/*
  Warnings:

  - You are about to drop the column `payout` on the `Hand` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Hand" DROP COLUMN "payout",
ADD COLUMN     "payoutPlayer1" INTEGER,
ADD COLUMN     "payoutPlayer2" INTEGER;

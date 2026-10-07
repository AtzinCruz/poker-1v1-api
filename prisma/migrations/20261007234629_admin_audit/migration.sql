-- CreateTable
CREATE TABLE "AdminAction" (
    "id" TEXT NOT NULL,
    "adminName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceBefore" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAction_playerId_idx" ON "AdminAction"("playerId");

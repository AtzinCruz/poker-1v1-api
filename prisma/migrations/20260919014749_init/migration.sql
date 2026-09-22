-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('WAITING_FOR_OPPONENT', 'IN_PROGRESS', 'MATCH_FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HandPhase" AS ENUM ('HAND_SETUP', 'BETTING_PRE_DRAW', 'DRAW', 'BETTING_POST_DRAW', 'SHOWDOWN', 'HAND_FINISHED');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('DRAW', 'BET', 'ALL_IN', 'FOLD');

-- CreateEnum
CREATE TYPE "FinishReason" AS ENUM ('RESIGN', 'INSUFFICIENT_STACK', 'DISCONNECT_TIMEOUT');

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "fictionalBalance" INTEGER NOT NULL DEFAULT 1000,
    "blockedBalance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'WAITING_FOR_OPPONENT',
    "startingStack" INTEGER NOT NULL,
    "smallBlind" INTEGER NOT NULL,
    "bigBlind" INTEGER NOT NULL,
    "turnTimeoutSeconds" INTEGER NOT NULL DEFAULT 60,
    "maxDiscard" INTEGER NOT NULL DEFAULT 5,
    "player1Id" TEXT NOT NULL,
    "player2Id" TEXT,
    "dealerPlayerId" TEXT,
    "handNumber" INTEGER NOT NULL DEFAULT 0,
    "stateVersion" INTEGER NOT NULL DEFAULT 1,
    "joinToken" TEXT NOT NULL,
    "player1Stack" INTEGER,
    "player2Stack" INTEGER,
    "finishReason" "FinishReason",
    "winnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hand" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "phase" "HandPhase" NOT NULL DEFAULT 'HAND_SETUP',
    "dealerPlayerId" TEXT NOT NULL,
    "deckCommitment" TEXT NOT NULL,
    "deckSeed" TEXT NOT NULL,
    "deckSeedRevealedAt" TIMESTAMP(3),
    "pot" INTEGER NOT NULL DEFAULT 0,
    "currentBet" INTEGER NOT NULL DEFAULT 0,
    "lastFullRaise" INTEGER NOT NULL DEFAULT 0,
    "player1Cards" JSONB NOT NULL,
    "player2Cards" JSONB NOT NULL,
    "player1Contribution" INTEGER NOT NULL DEFAULT 0,
    "player2Contribution" INTEGER NOT NULL DEFAULT 0,
    "player1RoundStartContribution" INTEGER NOT NULL DEFAULT 0,
    "player2RoundStartContribution" INTEGER NOT NULL DEFAULT 0,
    "player1Discarded" BOOLEAN NOT NULL DEFAULT false,
    "player2Discarded" BOOLEAN NOT NULL DEFAULT false,
    "player1Folded" BOOLEAN NOT NULL DEFAULT false,
    "player2Folded" BOOLEAN NOT NULL DEFAULT false,
    "player1AllIn" BOOLEAN NOT NULL DEFAULT false,
    "player2AllIn" BOOLEAN NOT NULL DEFAULT false,
    "player1ActedInRound" BOOLEAN NOT NULL DEFAULT false,
    "player2ActedInRound" BOOLEAN NOT NULL DEFAULT false,
    "toActPlayerId" TEXT,
    "turnExpiresAt" TIMESTAMP(3),
    "winnerId" TEXT,
    "winReason" TEXT,
    "payout" INTEGER,
    "revealedCards" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Action" (
    "id" TEXT NOT NULL,
    "handId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "type" "ActionType" NOT NULL,
    "amount" INTEGER,
    "discardedIndexes" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "actionVersion" INTEGER NOT NULL,
    "isAuto" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameEvent" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "handId" TEXT,
    "type" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publicPayload" JSONB NOT NULL,
    "player1Payload" JSONB,
    "player2Payload" JSONB,

    CONSTRAINT "GameEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_displayName_key" ON "Player"("displayName");

-- CreateIndex
CREATE UNIQUE INDEX "Match_joinToken_key" ON "Match"("joinToken");

-- CreateIndex
CREATE INDEX "Match_player1Id_idx" ON "Match"("player1Id");

-- CreateIndex
CREATE INDEX "Match_player2Id_idx" ON "Match"("player2Id");

-- CreateIndex
CREATE UNIQUE INDEX "Hand_matchId_number_key" ON "Hand"("matchId", "number");

-- CreateIndex
CREATE INDEX "Action_handId_idx" ON "Action"("handId");

-- CreateIndex
CREATE INDEX "Action_matchId_idx" ON "Action"("matchId");

-- CreateIndex
CREATE INDEX "GameEvent_matchId_idx" ON "GameEvent"("matchId");

-- CreateIndex
CREATE INDEX "GameEvent_handId_idx" ON "GameEvent"("handId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_playerId_key_key" ON "IdempotencyRecord"("playerId", "key");

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_player1Id_fkey" FOREIGN KEY ("player1Id") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_player2Id_fkey" FOREIGN KEY ("player2Id") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hand" ADD CONSTRAINT "Hand_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_handId_fkey" FOREIGN KEY ("handId") REFERENCES "Hand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Action" ADD CONSTRAINT "Action_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_handId_fkey" FOREIGN KEY ("handId") REFERENCES "Hand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

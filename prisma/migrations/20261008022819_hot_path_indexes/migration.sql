-- CreateIndex
CREATE INDEX "Hand_turnExpiresAt_idx" ON "Hand"("turnExpiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- CreateIndex
CREATE INDEX "Match_inviteeId_status_idx" ON "Match"("inviteeId", "status");

-- CreateIndex
CREATE INDEX "Match_status_createdAt_idx" ON "Match"("status", "createdAt");

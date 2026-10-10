-- Ciegas incrementales (opcional al crear la partida): cada `blindLevelHands` manos, las dos ciegas
-- suben `blindIncrement` fichas. 0 = ciegas fijas (todas las partidas anteriores).
ALTER TABLE "Match" ADD COLUMN "blindIncrement" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "blindLevelHands" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Match" ADD CONSTRAINT "Match_blind_schedule_valid" CHECK ("blindIncrement" >= 0 AND "blindLevelHands" >= 1);

-- AUD-08: cuántas cartas cambió cada jugador en el draw (dato público, §7 draw.completed.discardedCount).
-- NULL hasta que ese jugador hace su draw.
ALTER TABLE "Hand" ADD COLUMN "player1DiscardedCount" INTEGER,
ADD COLUMN "player2DiscardedCount" INTEGER;

-- AUD-13: la mano terminó por un fold automático (turno vencido), no por uno voluntario.
ALTER TABLE "Hand" ADD COLUMN "foldedByTimeout" BOOLEAN NOT NULL DEFAULT false;

-- AUD-10: estado de la partida justo después de cada acción (§8.1 "estado anterior/posterior").
ALTER TABLE "Action" ADD COLUMN "stateAfter" JSONB;

-- AUD-18: un desajuste de saldos debe fallar, no quedar escondido. NULL (stacks antes de unirse) pasa.
ALTER TABLE "Player" ADD CONSTRAINT "Player_fictionalBalance_nonnegative" CHECK ("fictionalBalance" >= 0),
ADD CONSTRAINT "Player_blockedBalance_nonnegative" CHECK ("blockedBalance" >= 0);
ALTER TABLE "Match" ADD CONSTRAINT "Match_stacks_nonnegative" CHECK ("player1Stack" >= 0 AND "player2Stack" >= 0);

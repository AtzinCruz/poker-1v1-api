-- Invitación por enlace: la partida se crea sin jugador invitado y se une quien abra el enlace (que
-- lleva el joinToken secreto). Las invitaciones a un jugador concreto siguen guardando su id.
ALTER TABLE "Match" ALTER COLUMN "inviteeId" DROP NOT NULL;

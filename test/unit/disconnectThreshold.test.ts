import { describe, expect, it } from "vitest";
import { disconnectThreshold } from "../../src/application/timeouts.js";

describe("disconnectThreshold", () => {
  it("equivale a ~3 minutos de silencio sea cual sea el tiempo por turno, con un mínimo de 3 acciones", () => {
    expect(disconnectThreshold(60)).toBe(3);
    expect(disconnectThreshold(120)).toBe(3);
    expect(disconnectThreshold(45)).toBe(4);
    expect(disconnectThreshold(30)).toBe(6);
    expect(disconnectThreshold(15)).toBe(12); // 12 × 15 s = 3 min (antes bastaban 3 acciones = 45 s)
  });
});

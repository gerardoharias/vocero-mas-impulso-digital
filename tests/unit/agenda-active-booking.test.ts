import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * El sandbox del Laboratorio, en la capa donde de verdad se decide: el SQL.
 *
 * `listActiveBookings` nació para contarle al agente qué citas tiene el
 * contacto (incidente 2026-09-19). Que mire el sandbox o el mundo real es un
 * `boolean` que viaja desde `conversation.isTest`, y un boolean es
 * exactamente el tipo de cosa que se invierte sin que nadie lo note. Aquí se
 * renderiza la condición con el dialecto real de Drizzle y se afirma el SQL
 * emitido — no el tipo.
 *
 * Por eso este archivo NO mockea `schema`: necesita las columnas de verdad.
 */

const captured: SQL[] = [];

function chain() {
  const c: Record<string, unknown> = {};
  c.from = () => c;
  c.where = (cond: SQL) => {
    captured.push(cond);
    return c;
  };
  c.orderBy = () => c;
  c.limit = () => Promise.resolve([]);
  return c;
}

vi.mock("@/lib/db", async () => {
  const real = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return { ...real, getDb: () => ({ select: () => chain() }) };
});

function sqlOf(cond: SQL): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(cond);
  return { sql: query.sql, params: query.params };
}

describe("el filtro is_test de las citas se emite DE VERDAD", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("el Laboratorio pide is_test = true", async () => {
    const { listActiveBookings } = await import("@/server/agenda/service");
    await listActiveBookings("org_1", "ct_1", { isTest: true });

    const { sql, params } = sqlOf(captured[0]!);
    expect(sql).toContain("is_test");
    expect(params).toContain(true);
    expect(params).not.toContain(false);
  });

  it("una conversación real pide is_test = false", async () => {
    const { listActiveBookings } = await import("@/server/agenda/service");
    await listActiveBookings("org_1", "ct_1", { isTest: false });

    const { params } = sqlOf(captured[0]!);
    expect(params).toContain(false);
    expect(params).not.toContain(true);
  });

  it("excluye las citas canceladas: ese es el filtro del incidente", async () => {
    const { listActiveBookings } = await import("@/server/agenda/service");
    await listActiveBookings("org_1", "ct_1", { isTest: false });

    const { params } = sqlOf(captured[0]!);
    expect(params).toContain("agendada");
    expect(params).toContain("realizada");
    expect(params).not.toContain("cancelada");
  });

  it("findActiveBooking SIGUE clavada en is_test = false tras el refactor", async () => {
    // Es el blindaje que se apoya en `booking_org_contact_single_active_uq`,
    // un índice parcial que solo cubre las citas reales. Si alguien la
    // parametrizara, la garantía se volvería mentira.
    const { findActiveBooking } = await import("@/server/agenda/service");
    await findActiveBooking("org_1", "ct_1");

    const { params } = sqlOf(captured[0]!);
    expect(params).toContain(false);
    expect(params).not.toContain(true);
  });
});

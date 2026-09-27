import { randomBytes } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Base de datos DESECHABLE para pruebas de integración: se crea `vocero_it_*`
 * en el servidor que apunta `DATABASE_URL`, se le aplican las migraciones
 * reales de `drizzle/` y se borra al terminar. La base de desarrollo no se toca.
 */

export type TestDatabase = { url: string; drop: () => Promise<void> };

function adminUrl(baseUrl: string): { admin: string; make: (db: string) => string } {
  const u = new URL(baseUrl);
  const make = (db: string) => {
    const c = new URL(baseUrl);
    c.pathname = `/${db}`;
    return c.toString();
  };
  u.pathname = "/postgres";
  return { admin: u.toString(), make };
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const base =
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/vocero";
  const { admin, make } = adminUrl(base);
  const name = `vocero_it_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const url = make(name);

  const adminSql = postgres(admin, { max: 1, onnotice: () => {} });
  try {
    await adminSql.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await adminSql.end();
  }

  const migSql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(migSql), {
      migrationsFolder: path.join(process.cwd(), "drizzle"),
    });
  } finally {
    await migSql.end();
  }

  return {
    url,
    drop: async () => {
      const sql = postgres(admin, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await sql.end();
      }
    },
  };
}

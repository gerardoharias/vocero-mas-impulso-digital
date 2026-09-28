/**
 * Valida LOCALMENTE (sin red, sin base, sin llamadas de IA) el JSON que se pasará
 * a `AI_LIVE_PROFILE_JSON`:
 *
 *   pnpm test:ai-live-profile-check <ruta.json>
 *
 * Sale con código 1 si falta un campo, hay claves de más, el perfil está vacío,
 * es idéntico a la semilla o contiene una credencial. Jamás imprime el contenido
 * del perfil: sólo longitudes, huellas y conteos.
 */
import { readFileSync } from "node:fs";
import { validateLiveProfile } from "./profile-json";

const path = process.argv[2];
if (!path) {
  console.error("uso: pnpm test:ai-live-profile-check <ruta.json>");
  process.exit(2);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`✗ no se pudo leer/parsear el JSON (${(err as Error).message.slice(0, 120)})`);
  process.exit(1);
}

const r = validateLiveProfile(raw);
if (!r.ok) {
  console.error("✗ perfil RECHAZADO:");
  for (const e of r.errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("✓ perfil válido");
console.log(
  `  instruccionesChars=${r.info.instructionsChars} instruccionesSha=${r.info.instructionsSha} ` +
    `kbEntradas=${r.info.kbEntries} kbChars=${r.info.kbChars} camposNull=[${r.info.nullFields.join(",")}]`
);
console.log(`  mencionaOfferSlots=${r.info.mentionsOfferSlots} (la regla heredada se conserva tal cual)`);
for (const w of r.warnings) console.log(`  ⚠ ${w}`);

import { describe, expect, it } from "vitest";
import { salvageProse } from "@/server/ai/salvage";
import { PROMPT_LEAK_MARKERS } from "@/server/ai/prompts";

/**
 * La red que impide que un hipo de FORMATO del proveedor deje a un prospecto
 * colgado. Función pura: sin mocks, sin red, sin BD.
 */

/** Tal cual salió del log de producción el 2026-09-19. */
const PROSA_DEL_INCIDENTE =
  "Eso no te lo puedo decir, soy Tobias, el asistente de Tobaxis, y solo me enfoco en temas de CRM y automatización comercial 🙂 \n\n¿Seguimos con tu posible demostración o hay algo más en lo que te pueda apoyar?";

describe("salvageProse — lo que SÍ se entrega", () => {
  it("la prosa del incidente real se entrega tal cual", () => {
    // EL test de este arreglo: esta respuesta era perfectamente buena y el CRM
    // la tiró a la basura por no venir envuelta en JSON.
    expect(salvageProse(PROSA_DEL_INCIDENTE)).toBe(PROSA_DEL_INCIDENTE.trim());
  });

  it("una respuesta corta y normal pasa", () => {
    expect(salvageProse("Claro, con gusto. ¿Para cuándo lo necesitas?")).toBe(
      "Claro, con gusto. ¿Para cuándo lo necesitas?"
    );
  });

  it("de un modelo de razonamiento se entrega SOLO lo que sigue al </think>", () => {
    // El razonamiento interno jamás puede llegarle al cliente.
    expect(
      salvageProse("<think>El usuario pregunta X, debo…</think>Claro, te explico.")
    ).toBe("Claro, te explico.");
  });

  it("desenvuelve un bloque de fences que no era JSON", () => {
    expect(salvageProse("```\nBuenas tardes, ya lo reviso.\n```")).toBe(
      "Buenas tardes, ya lo reviso."
    );
  });

  it("mide en BYTES, no en caracteres: 700 caracteres con acentos pasan", () => {
    const texto = "á".repeat(400); // 800 bytes en UTF-8, 400 caracteres
    expect(salvageProse(texto)).toBe(texto);
  });
});

describe("salvageProse — lo que NO se entrega (ante la duda, escalar)", () => {
  it("sin raw: el proveedor nunca habló, no hay nada que rescatar", () => {
    expect(salvageProse(undefined)).toBeNull();
  });

  it("vacío o solo espacios", () => {
    expect(salvageProse("")).toBeNull();
    expect(salvageProse("   \n  ")).toBeNull();
  });

  it("JSON truncado: mandarle eso a un prospecto es peor que escalar", () => {
    expect(salvageProse('{"action":"reply","text":"hol')).toBeNull();
  });

  it("JSON válido pero con una acción que no existe", () => {
    // extractJson ya lo parseó y Zod lo rechazó: no es prosa, es una salida mala.
    expect(salvageProse('{"action":"otra_cosa"}')).toBeNull();
  });

  it("prosa que termina en llave de cierre", () => {
    expect(salvageProse('te paso el detalle: "algo" }')).toBeNull();
  });

  it("por encima del tope se descarta, NUNCA se trunca", () => {
    const largo = "a".repeat(950);
    expect(salvageProse(largo)).toBeNull();
  });

  it("un eco de error del proveedor", () => {
    expect(salvageProse("Internal Server Error")).toBeNull();
    expect(salvageProse('{"error":{"code":500}}')).toBeNull();
  });

  it.each(PROMPT_LEAK_MARKERS)(
    "el prompt regurgitado no se filtra al cliente (%s)",
    (marker) => {
      expect(salvageProse(`Claro: ${marker} dice lo siguiente…`)).toBeNull();
    }
  );
});

import { describe, expect, it } from "vitest";
import {
  countVariables,
  renderBody,
  validateBodyVariables,
} from "@/server/whatsapp/templates";
import { canBeWindowFallback, sanitizeTemplateParam } from "@/lib/templates";

describe("countVariables / validateBodyVariables (FR-050)", () => {
  it("sin variables → 0, válido", () => {
    expect(countVariables("Hola, seguimos disponibles.")).toBe(0);
    expect(validateBodyVariables("Hola, seguimos disponibles.")).toBeNull();
  });

  it("una variable {{1}} → 1, válido (con y sin espacios)", () => {
    expect(countVariables("Hola {{1}}, ¿retomamos?")).toBe(1);
    expect(countVariables("Hola {{ 1 }}, ¿retomamos?")).toBe(1);
    expect(validateBodyVariables("Hola {{1}}, ¿retomamos?")).toBeNull();
  });

  it("varias variables numeradas en orden → válido", () => {
    const body = "Hola {{1}}, te confirmo el {{2}} a las {{3}}.";
    expect(countVariables(body)).toBe(3);
    expect(validateBodyVariables(body)).toBeNull();
  });

  it("la variable repetida cuenta una sola vez", () => {
    expect(countVariables("Hola {{1}}, ¿confirmas, {{1}}?")).toBe(1);
    expect(validateBodyVariables("Hola {{1}}, ¿confirmas, {{1}}?")).toBeNull();
  });

  it("numeración con salto → inválida", () => {
    expect(validateBodyVariables("Hola {{1}}, tu pedido {{3}} llegó")).toMatch(
      /sin saltos/
    );
  });

  it("variable {{2}} sola → inválida (debe empezar en {{1}})", () => {
    expect(validateBodyVariables("Tu pedido {{2}} llegó")).toMatch(/\{\{1\}\}/);
  });

  it("más de 10 variables → inválida", () => {
    const body = Array.from({ length: 11 }, (_, i) => `x {{${i + 1}}}`).join(" ");
    expect(validateBodyVariables(body)).toMatch(/hasta 10/);
  });
});

describe("renderBody", () => {
  it("sustituye la variable por el valor", () => {
    expect(renderBody("Hola {{1}}, ¿retomamos?", ["María"])).toBe(
      "Hola María, ¿retomamos?"
    );
  });

  it("sustituye cada variable por su posición", () => {
    expect(
      renderBody("Hola {{1}}, te espero el {{2}} a las {{3}}.", [
        "María",
        "12 de agosto",
        "5 pm",
      ])
    ).toBe("Hola María, te espero el 12 de agosto a las 5 pm.");
  });

  it("sin valores → variables vacías", () => {
    expect(renderBody("Hola {{1}}!")).toBe("Hola !");
    expect(renderBody("Hola {{1}} el {{2}}", ["María"])).toBe("Hola María el ");
  });
});

describe("validateBodyVariables — posición de la variable", () => {
  it("variable al inicio → inválida (Meta la rechaza)", () => {
    expect(validateBodyVariables("{{1}}, te esperamos mañana.")).toMatch(
      /empezar con una variable/
    );
  });

  it("variable al final → inválida, aunque haya espacios o saltos detrás", () => {
    expect(validateBodyVariables("Hola, te esperamos a las {{1}}")).toMatch(
      /terminar con una variable/
    );
    expect(validateBodyVariables("Hola {{1}}\n\n")).toMatch(
      /terminar con una variable/
    );
  });

  it("la genérica de la captura (texto antes y después) → válida", () => {
    const body = "Dando seguimiento a la cita agendada.\n{{1}}\n\nSaludos!";
    expect(validateBodyVariables(body)).toBeNull();
  });
});

describe("sanitizeTemplateParam (Meta 132018)", () => {
  it("aplana saltos de línea y tabuladores a un espacio", () => {
    expect(
      sanitizeTemplateParam("Le recuerdo su cita\npara mañana\r\n\ta las 10 am")
    ).toBe("Le recuerdo su cita para mañana a las 10 am");
  });

  it("junta espacios repetidos (Meta no acepta más de 4 seguidos) y recorta", () => {
    expect(sanitizeTemplateParam("  hola      mundo  ")).toBe("hola mundo");
  });

  it("no toca emojis ni acentos", () => {
    expect(sanitizeTemplateParam("¡Nos vemos! 😊 Señor Núñez")).toBe(
      "¡Nos vemos! 😊 Señor Núñez"
    );
  });

  it("solo espacios → vacío (el envío lo trata como valor faltante)", () => {
    expect(sanitizeTemplateParam(" \n\t ")).toBe("");
  });
});

describe("canBeWindowFallback", () => {
  it("exactamente una variable → puede ser la genérica", () => {
    expect(canBeWindowFallback("Seguimiento.\n{{1}}\nSaludos!")).toBe(true);
    expect(canBeWindowFallback("Hola {{1}}, ¿confirmas, {{1}}?")).toBe(true);
  });

  it("cero o varias variables → no", () => {
    expect(canBeWindowFallback("Seguimos disponibles.")).toBe(false);
    expect(canBeWindowFallback("Hola {{1}}, el {{2}}.")).toBe(false);
  });
});

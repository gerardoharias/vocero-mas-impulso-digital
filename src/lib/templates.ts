/**
 * Variables posicionales {{n}} del cuerpo de una plantilla de WhatsApp.
 * Puro y sin dependencias: lo usan tanto el servicio de servidor como la UI
 * (que necesita saber cuántos campos pintar antes de enviar).
 */

const VARIABLE_REGEX = /\{\{\s*(\d+)\s*\}\}/g;

/** Máximo de parámetros posicionales por cuerpo que acepta Meta. */
export const MAX_TEMPLATE_VARIABLES = 10;

/** Largo máximo del cuerpo YA renderizado que acepta Meta. */
export const MAX_TEMPLATE_BODY_CHARS = 1024;

/** Índices distintos de {{n}} presentes en el cuerpo, ordenados. */
function variableIndexes(body: string): number[] {
  const found = new Set<number>();
  for (const m of body.matchAll(VARIABLE_REGEX)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/**
 * Cuántos parámetros exige el cuerpo = el índice más alto. Con la numeración
 * validada (1..N sin saltos) equivale al número de variables distintas.
 */
export function countVariables(body: string): number {
  const indexes = variableIndexes(body);
  return indexes.length ? indexes[indexes.length - 1]! : 0;
}

/**
 * Meta acepta varias variables por cuerpo, pero exige numeración posicional
 * contigua desde {{1}}: un salto ({{1}} y {{3}}) es rechazo seguro.
 */
export function validateBodyVariables(body: string): string | null {
  const indexes = variableIndexes(body);
  if (indexes.length === 0) return null;
  if (indexes.length > MAX_TEMPLATE_VARIABLES) {
    return `El cuerpo admite hasta ${MAX_TEMPLATE_VARIABLES} variables`;
  }
  for (let i = 0; i < indexes.length; i++) {
    if (indexes[i] !== i + 1) {
      return `Las variables deben ir numeradas {{1}}, {{2}}, … sin saltos (falta {{${i + 1}}})`;
    }
  }
  // Meta rechaza el cuerpo que abre o cierra con un parámetro: necesita texto
  // fijo alrededor para entender de qué trata la plantilla.
  const trimmed = body.trim();
  if (/^\{\{\s*\d+\s*\}\}/.test(trimmed)) {
    return "El cuerpo no puede empezar con una variable: pon texto antes";
  }
  if (/\{\{\s*\d+\s*\}\}$/.test(trimmed)) {
    return "El cuerpo no puede terminar con una variable: pon texto después (basta un punto)";
  }
  return null;
}

/**
 * Deja un valor listo para ir como parámetro de plantilla. Meta rechaza
 * (132018) el parámetro con saltos de línea, tabuladores o más de 4 espacios
 * seguidos, así que lo escrito en varios renglones se aplana a uno solo.
 */
export function sanitizeTemplateParam(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Plantilla genérica (fuera de ventana): la única que puede envolver lo que
 * el operador escribe es la de exactamente una variable.
 */
export function canBeWindowFallback(body: string): boolean {
  return countVariables(body) === 1;
}

/** Sustituye {{n}} por `variables[n-1]` (vacío si no hay valor). */
export function renderBody(body: string, variables: string[] = []): string {
  return body.replace(VARIABLE_REGEX, (_match, index: string) => {
    return variables[Number(index) - 1] ?? "";
  });
}

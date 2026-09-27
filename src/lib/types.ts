/** DTOs que viajan por la API interna (lado cliente). */

import type { Channel } from "@/lib/channels";

export type ConversationDto = {
  id: string;
  /** 014: canal de la conversacion, para el distintivo de la bandeja. */
  channel: Channel;
  contact: {
    id: string;
    name: string;
    phone: string | null;
    /** Auditoría 2026-09-17: archivado explícito del contacto — ver ContactDto. */
    archivedAt: string | null;
  };
  stageName: string | null;
  aiEnabled: boolean;
  handoffAt: string | null;
  handoffReason: string | null;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  /** Distinto de "sin leer": el último mensaje es del prospecto y nadie (ni
   *  el agente ni un humano) le ha respondido todavía. */
  pendingReply: boolean;
  windowOpen: boolean;
  windowRemainingMs: number;
  preview: string | null;
};

/** 008 — Adjunto de un mensaje, para previsualización en el hilo. */
export type MessageMediaDto = {
  assetId: string;
  kind:
    | "image"
    | "video"
    | "audio"
    | "document"
    | "sticker"
    | "location"
    | "contacts";
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  caption: string | null;
  fetchStatus: "available" | "pending" | "failed";
  /** Motivo cuando `fetchStatus === "failed"` (Meta ya no tiene el archivo,
   *  excedió el límite, etc.). */
  fetchError: string | null;
  /** Solo audio: motivo si la transcripción se intentó y no dio resultado.
   *  Distinto de `fetchStatus: "failed"` (eso es NO DESCARGAR el archivo;
   *  esto es descargarlo bien y no poder entenderlo). */
  transcribeError: string | null;
  /** location {latitude, longitude, name?, address?} / contacts (subset). */
  payload: unknown;
};

export type MessageDto = {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  type: string;
  text: string | null;
  status: "pending" | "sent" | "delivered" | "read" | "failed";
  /** Motivo del fallo en lenguaje llano cuando status = "failed". */
  error: string | null;
  aiGenerated: boolean;
  /** 008 — Origen del saliente (en entrantes viene 'operator' y se ignora). */
  origin: "ai" | "operator" | "manual" | "template";
  media: MessageMediaDto | null;
  createdAt: string;
};

export type TemplateDto = {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  status: "draft" | "pending" | "approved" | "rejected";
  rejectionReason: string | null;
  /** La genérica: envuelve lo que se escribe con la ventana cerrada. */
  isWindowFallback: boolean;
};

export type StageDto = {
  id: string;
  name: string;
  position: number;
  kind: "open" | "won" | "lost";
};

/** Un dato de la ficha. Escalar a propósito: ver `server/bot/ficha`. */
export type FichaValue = string | number | boolean;

/**
 * Ficha de calificación del lead. Claves libres: cada negocio califica
 * distinto, así que las define quien pregunta —el agente o el dueño— y el CRM
 * no las cablea.
 */
export type FichaDto = Record<string, FichaValue>;

export type ContactDto = {
  id: string;
  name: string;
  /** null en contactos que llegaron solo con BSUID (003). */
  phone: string | null;
  notes: string | null;
  /** Etapa del embudo del lead asociado; null si el contacto no tiene lead. */
  stageName: string | null;
  archivedAt: string | null;
  /** De dónde salió el prospecto, capturada o deducida. */
  source?: SourceDto;
  /** Prioridad del lead asociado; null si nadie la fijó. */
  priority?: PriorityValue | null;
  /** Lo que se sabe del lead. `{}` mientras nadie haya calificado. */
  ficha?: FichaDto;
  /**
   * Fase 4 (auditoría 2026-09) — marca MANUAL de dato de prueba/sistema:
   * `demo` (seedDemo) o `system` (contacto que crea Meta al probar el
   * webhook, número propio, etc.). NULL = prospecto real (todo contacto
   * existente y nuevo, salvo que el operador lo marque a mano). Excluido de
   * Resultados/Pipeline/Bandeja cuando no es null.
   */
  sampleType?: "demo" | "system" | null;
};

/**
 * Auditoría 2026-09-17 (incidente GRojas/Más Impulso) — un hecho atómico que
 * el agente de IA registró de una conversación real. Ver
 * `server/contacts/notes.ts`: nunca se mezcla con `ContactDto.notes` (eso es
 * 100% del dueño).
 */
export type AiNoteDto = {
  id: string;
  text: string;
  /** confirmed = hecho real; test = conversación del Laboratorio; conflict =
   *  giro distinto al ya establecido para este contacto — revisar a mano. */
  status: "confirmed" | "test" | "conflict";
  scenario: string | null;
  createdAt: string;
};

/* ============================================================
 * Bitácora de etapas
 * ============================================================ */

/** Por qué se perdió un trato. Lista corta a propósito: una taxonomía larga
 *  se responde "otro" y deja de informar. */
export type LossReason =
  | "precio"
  | "no_es_perfil"
  | "sin_presupuesto"
  | "eligio_otro"
  | "nunca_contesto"
  | "otro";

export const LOSS_REASON_LABEL: Record<LossReason, string> = {
  precio: "Le pareció caro",
  no_es_perfil: "No era el perfil",
  sin_presupuesto: "Sin presupuesto ahora",
  eligio_otro: "Se fue con otro",
  nunca_contesto: "Nunca contestó",
  otro: "Otro",
};

/** Quién provocó un movimiento de etapa. */
export type StageChangeSource = "dueno" | "bot" | "sistema" | "migracion";

/* ============================================================
 * Fuente del prospecto
 * ============================================================ */

export type SourceValue =
  | "anuncio"
  | "organico"
  | "referido"
  | "conocido"
  | "otro";

export type SourceDto = {
  /** "desconocida" cuando nadie la capturó y no se pudo deducir. */
  value: SourceValue | "desconocida";
  /** `deducida` = la infirió el sistema; `capturada` = la puso el dueño. */
  source: "capturada" | "deducida";
};

/* ============================================================
 * Prioridad del lead
 * ============================================================ */

/** La fija el dueño; NULL = nadie la ha decidido (no es "media"). */
export type PriorityValue = "alta" | "media" | "baja";

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import {
  graphRequest,
  MetaApiError,
  normalizeRecipient,
  type NetworkPhase,
} from "@/lib/meta/client";
import { describeSendError } from "@/lib/meta/send-errors";
import { publish } from "@/server/events/bus";
import {
  getCredentialsByOrg,
  markReconnectRequired,
  type Credentials,
} from "@/server/whatsapp/credentials";
import { isWindowOpen } from "@/server/inbox/window";
import { IG_PREFIX } from "@/server/inbox/identity";
import {
  getInstagramCredentialsByOrg,
  markInstagramReconnectRequired,
  type InstagramCredentials,
} from "@/server/instagram/credentials";
import { sendInstagramText } from "@/server/instagram/send";
import { FB_PREFIX } from "@/server/inbox/identity";
import {
  getMessengerCredentialsByOrg,
  markMessengerReconnectRequired,
  type MessengerCredentials,
} from "@/server/messenger/credentials";
import { sendMessengerText } from "@/server/messenger/send";
import {
  capabilitiesFor,
  textFits,
  windowClosedMessage,
} from "@/server/channels/capabilities";
import { isChannelEnabled } from "@/server/channels/enabled";
import { serializeMessage } from "@/server/inbox/ingest";
import {
  saveMediaFile,
  uploadGraphMedia,
  validateOutgoing,
} from "@/server/whatsapp/media";
import { ATTEMPT_TIMEOUT_MS } from "@/server/outbox/policy";
import {
  attemptDelivery,
  enqueueText,
  type DeliveryOutcome,
} from "@/server/outbox";
import type { OfferedSlot } from "@/server/agenda/offers";
import { blockReasonForManualResend } from "@/server/agenda/offer-resend-guard";
import { staleMessage } from "@/server/agenda/offer-freshness";

/**
 * 024 — Lo que se sabe del fallo de transporte, saneado (sin cuerpos de Meta,
 * sin destinatario). Es la entrada de la política de reintentos
 * (`server/outbox/policy.ts`), que decide por código + etapa, no por texto.
 */
export type TransportFailure = {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  network: NetworkPhase | null;
  /** 200 sin `messages[0].id`: Meta pudo haber aceptado el mensaje. */
  noMessageId?: boolean;
};

/** Error tipado del envío; `code` mapea a HTTP en la capa de API. */
export class SendError extends Error {
  code:
    | "sandbox_violation"
    | "not_connected"
    | "reconnect_required"
    | "window_closed"
    | "meta_error"
    | "meta_unavailable"
    | "upload_failed"
    /** 024: la oferta de horarios ya no es vigente; no se envía. */
    | "offer_stale"
    /** 024: otro operador/trabajador ya reenvió o está reenviando este mensaje. */
    | "resend_conflict";
  /** 008: presente cuando el fallo ocurrió TRAS persistir el mensaje (failed). */
  messageId?: string;
  /** 024: detalle saneado del fallo de transporte (sólo canal WhatsApp). */
  transport?: TransportFailure;

  constructor(code: SendError["code"], message: string) {
    super(message);
    this.name = "SendError";
    this.code = code;
  }
}

type SendResult = {
  messageId: string;
  /**
   * 024: estado del mensaje al volver. Un fallo recuperable NO lanza: el
   * mensaje ya existe (`retrying`) y el outbox lo reintenta íntegro.
   */
  status?: string;
};

export type SendTarget = {
  conversation: typeof schema.conversation.$inferSelect;
  /** null cuando el destino no es WhatsApp (014). */
  credentials: Credentials | null;
  recipient: string;
  /** 014: presente solo en conversaciones de Instagram. */
  instagram?: InstagramCredentials;
  /** 017: presente solo en conversaciones de Messenger. */
  messenger?: MessengerCredentials;
};

/**
 * Pre-flight común de todo envío por la conversación (008): existencia +
 * tenant, sandbox del Laboratorio (ASERCIÓN DURA, FR-031: jamás toca la API
 * real), ventana de 24 h, credenciales y destinatario.
 */
export async function prepareSend(
  conversationId: string,
  organizationId: string
): Promise<SendTarget> {
  const db = getDb();
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const row = rows[0];
  if (!row || row.conversation.organizationId !== organizationId) {
    throw new SendError("meta_error", "Conversación no encontrada");
  }

  if (row.conversation.isTest) {
    throw new SendError(
      "sandbox_violation",
      "Conversación de prueba del Laboratorio: el envío real está prohibido"
    );
  }

  // 014: Instagram tiene su propio transporte, su propia ventana y NO tiene
  // plantillas. Se resuelve antes que las credenciales de WhatsApp para no
  // exigirle a una instancia de solo-Instagram un numero conectado.
  if (row.conversation.channel === "instagram") {
    // Una conversacion de un canal apagado puede existir (se apago despues de
    // recibirla): falla claro en vez de intentar un transporte que no aplica.
    if (!isChannelEnabled("instagram")) {
      throw new SendError(
        "not_connected",
        "El canal de Instagram está desactivado en esta instancia"
      );
    }
    const igCreds = await getInstagramCredentialsByOrg(organizationId);
    if (!igCreds) {
      throw new SendError(
        "not_connected",
        "No hay cuenta de Instagram conectada"
      );
    }
    if (igCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "El token de Instagram expiró: reconecta la cuenta en Configuración"
      );
    }
    const igRecipient = row.contact.waIdentity.startsWith(IG_PREFIX)
      ? row.contact.waIdentity.slice(IG_PREFIX.length)
      : row.contact.waIdentity;
    return {
      conversation: row.conversation,
      credentials: null,
      recipient: igRecipient,
      instagram: igCreds,
    };
  }

  // 017: Messenger, mismo trato que Instagram: transporte propio, ventana
  // propia (con etiqueta fuera de ella) y sin plantillas.
  if (row.conversation.channel === "messenger") {
    if (!isChannelEnabled("messenger")) {
      throw new SendError(
        "not_connected",
        "El canal de Messenger está desactivado en esta instancia"
      );
    }
    const fbCreds = await getMessengerCredentialsByOrg(organizationId);
    if (!fbCreds) {
      throw new SendError(
        "not_connected",
        "No hay página de Facebook conectada"
      );
    }
    if (fbCreds.status === "reconnect_required") {
      throw new SendError(
        "reconnect_required",
        "El token de la página expiró: reconecta Messenger en Configuración"
      );
    }
    const fbRecipient = row.contact.waIdentity.startsWith(FB_PREFIX)
      ? row.contact.waIdentity.slice(FB_PREFIX.length)
      : row.contact.waIdentity;
    return {
      conversation: row.conversation,
      credentials: null,
      recipient: fbRecipient,
      messenger: fbCreds,
    };
  }

  // El nucleo no decide la politica: la consulta. WhatsApp exige plantilla
  // fuera de ventana; Instagram etiqueta y sigue; otro canal podria no tener
  // ventana en absoluto.
  const caps = capabilitiesFor(row.conversation.channel);
  if (
    caps.windowMs !== null &&
    caps.outsideWindow === "template" &&
    !isWindowOpen(row.conversation.lastInboundAt)
  ) {
    throw new SendError(
      "window_closed",
      windowClosedMessage(row.conversation.channel)
    );
  }

  const credentials = await getCredentialsByOrg(organizationId);
  if (!credentials) {
    throw new SendError("not_connected", "No hay número de WhatsApp conectado");
  }
  if (credentials.status === "reconnect_required") {
    throw new SendError(
      "reconnect_required",
      "El token de WhatsApp expiró: reconecta el número en Configuración"
    );
  }

  // 003: el destinatario es el teléfono normalizado o, si el contacto llegó
  // por BSUID sin teléfono, su Business-Scoped User ID.
  const recipient = row.contact.phone
    ? normalizeRecipient(row.contact.phone)
    : row.contact.waUserId;
  if (!recipient) {
    throw new SendError(
      "meta_error",
      "El contacto no tiene teléfono ni identidad de WhatsApp utilizable"
    );
  }

  return { conversation: row.conversation, credentials, recipient };
}

async function persistOutbound(input: {
  organizationId: string;
  conversationId: string;
  waMessageId: string | null;
  type: string;
  text: string | null;
  /**
   * 014: 'sent' existe porque no todos los canales confirman por webhook.
   * WhatsApp entra como 'pending' y avanza con los `statuses` de Meta;
   * Instagram no manda ese evento salvo que se suscriba aparte, asi que la
   * aceptacion de la plataforma ES la confirmacion. Sin esto el mensaje se
   * queda con el reloj puesto para siempre aunque ya se haya entregado.
   */
  status: "pending" | "sent" | "failed";
  error?: string | null;
  aiGenerated?: boolean;
  origin: "ai" | "operator";
  mediaAssetId?: string | null;
  media?: typeof schema.mediaAsset.$inferSelect | null;
}): Promise<string> {
  const db = getDb();
  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId: input.waMessageId,
      direction: "out",
      type: input.type,
      text: input.text,
      status: input.status,
      error: input.error ?? null,
      aiGenerated: input.aiGenerated ?? false,
      origin: input.origin,
      mediaAssetId: input.mediaAssetId ?? null,
    })
    .returning();
  const message = inserted[0]!;

  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, input.conversationId));

  publish(input.organizationId, {
    type: "message.new",
    data: {
      conversationId: input.conversationId,
      message: serializeMessage(message, input.media ?? null),
    },
  });

  return message.id;
}

/**
 * Códigos de `SendError` que YA tienen su propia UX y no deben duplicarse
 * como una burbuja "failed" más en el hilo: `window_closed` se convierte en
 * traspaso (pipeline.ts), `not_connected`/`reconnect_required` son un
 * problema de la CONEXIÓN completa (banner en Ajustes, no de este mensaje
 * puntual) y `sandbox_violation` es un guardrail que nunca debería disparar
 * en un flujo real (FR-031).
 */
const SILENT_FAILURE_CODES = new Set<SendError["code"]>([
  "sandbox_violation",
  "not_connected",
  "reconnect_required",
  "window_closed",
]);

/**
 * 024 — Entrega UN texto por el transporte del canal de la conversación. Es lo
 * único que un intento del outbox ejecuta: recibe el texto YA persistido, no
 * decide nada ni reconstruye nada.
 */
export async function deliverText(
  target: SendTarget,
  text: string
): Promise<string> {
  if (target.instagram) return callInstagramSend(target, text);
  if (target.messenger) return callMessengerSend(target, text);
  return callGraphSend(target.credentials!, {
    messaging_product: "whatsapp",
    to: target.recipient,
    type: "text",
    text: { body: text },
  });
}

/** Traduce el desenlace de un intento al contrato histórico de `sendText`. */
function resultOf(outcome: DeliveryOutcome): SendResult {
  if (!outcome.claimed) {
    throw new SendError("resend_conflict", "El mensaje ya se está reenviando");
  }
  if (outcome.outcome === "failed") {
    const err = outcome.sendError;
    err.messageId = outcome.messageId;
    throw err;
  }
  return { messageId: outcome.messageId, status: outcome.outcome };
}

/**
 * Envía un mensaje de texto libre.
 *
 * 024 — El payload final se PERSISTE antes del primer intento (`queued`) y cada
 * intento —éste y los reintentos del trabajador— lee ese texto de la base:
 * nadie lo reconstruye. Un fallo recuperable no lanza (queda `retrying`); uno
 * ambiguo tampoco (`delivery_unknown`); uno definitivo sí lanza `SendError`, con
 * `messageId`, como siempre.
 */
export async function sendText(input: {
  conversationId: string;
  organizationId: string;
  text: string;
  aiGenerated?: boolean;
  /** 024: una respuesta lógica por clave (p. ej. `agent-turn:<inbound>`). */
  dedupeKey?: string;
  /** 024: horarios que este mensaje muestra; se activan cuando Meta lo acepta. */
  offers?: OfferedSlot[];
}): Promise<SendResult> {
  let target: SendTarget;
  try {
    target = await prepareSend(input.conversationId, input.organizationId);
  } catch (err) {
    if (err instanceof SendError && SILENT_FAILURE_CODES.has(err.code)) {
      throw err;
    }
    // Bug reportado: un rechazo previo al envío (destinatario sin teléfono ni
    // identidad utilizable, etc.) nunca llegaba a persistirse — a diferencia de
    // sendMediaMessage, que sí deja un mensaje "failed" visible. El agente
    // respondía en apariencia y el prospecto no recibía nada, sin ningún rastro
    // en el hilo ni en el panel.
    const sendErr =
      err instanceof SendError
        ? err
        : new SendError(
            "meta_error",
            err instanceof Error ? err.message : "No se pudo enviar el mensaje"
          );
    try {
      sendErr.messageId = await persistOutbound({
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        waMessageId: null,
        type: "text",
        text: input.text,
        status: "failed",
        error: sendErr.message,
        aiGenerated: input.aiGenerated,
        origin: input.aiGenerated ? "ai" : "operator",
      });
    } catch (persistErr) {
      // No dejar que un fallo AL REGISTRAR el fallo oculte el original.
      console.error(
        `[send] no se pudo dejar rastro del envío de texto fallido: ${persistErr}`
      );
    }
    throw sendErr;
  }

  const { message, created } = await enqueueText({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    text: input.text,
    origin: input.aiGenerated ? "ai" : "operator",
    aiGenerated: input.aiGenerated ?? false,
    dedupeKey: input.dedupeKey,
    offers: input.offers,
  });
  // La misma respuesta lógica ya existe: no se vuelve a enviar (G5).
  if (!created) return { messageId: message.id, status: message.status };

  const outcome = await attemptDelivery(message.id, { target });
  return resultOf(outcome);
}

/**
 * 024 — Reenvío MANUAL de un mensaje `failed` o `delivery_unknown`: mismo
 * payload, misma burbuja, UN intento. La decisión de asumir el riesgo de
 * duplicado (si el original sí había llegado) es del operador.
 */
export async function resendText(input: {
  messageId: string;
  organizationId: string;
  /** Si viene, el mensaje debe pertenecer a esta conversación. */
  conversationId?: string;
}): Promise<SendResult> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.message.id,
      conversationId: schema.message.conversationId,
      direction: schema.message.direction,
      type: schema.message.type,
      status: schema.message.status,
      text: schema.message.text,
    })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.id, input.messageId),
        eq(schema.message.organizationId, input.organizationId)
      )
    )
    .limit(1);
  const m = rows[0];
  if (
    !m ||
    m.direction !== "out" ||
    (input.conversationId && m.conversationId !== input.conversationId)
  ) {
    throw new SendError("meta_error", "Mensaje no encontrado");
  }
  if (m.type !== "text" || !m.text) {
    throw new SendError(
      "meta_error",
      "Sólo se pueden reenviar mensajes de texto; vuelve a enviar el adjunto"
    );
  }
  if (m.status !== "failed" && m.status !== "delivery_unknown") {
    // Otro operador ya lo reenvió (o va en camino): no se duplica.
    throw new SendError("resend_conflict", "Este mensaje no necesita reenvío");
  }
  // Una oferta de horarios sólo se reenvía si sigue siendo la vigente y sus
  // horarios siguen libres. Si no, NO sale nada (ni parcial): hay que generar
  // una ronda nueva con disponibilidad actualizada.
  const blocked = await blockReasonForManualResend(m.id);
  if (blocked) throw new SendError("offer_stale", staleMessage(blocked));

  const target = await prepareSend(m.conversationId, input.organizationId);
  const outcome = await attemptDelivery(m.id, { target, manual: true });
  return resultOf(outcome);
}

/**
 * 008 — Envía un adjunto de archivo (imagen/video/audio/documento).
 * El archivo queda ANTES en el volumen local (fuente durable de la preview);
 * si Graph falla tras eso, el mensaje se persiste `failed` (visible en el
 * hilo, nunca se pierde en silencio) y el SendError lleva `messageId`.
 */
export async function sendMediaMessage(input: {
  conversationId: string;
  organizationId: string;
  file: { data: Buffer; mimeType: string; fileName?: string };
  caption?: string;
}): Promise<SendResult> {
  // Validación previa (FR-007): tipo y tamaño antes de tocar disco o red.
  const kind = validateOutgoing(input.file.mimeType, input.file.data.byteLength);

  const target = await prepareSend(input.conversationId, input.organizationId);
  const { credentials, recipient } = target;
  const sendCaps = capabilitiesFor(target.conversation.channel);
  if (!sendCaps.outboundMedia) {
    throw new SendError(
      "meta_error",
      `Todavía no se pueden enviar adjuntos por ${sendCaps.label}; manda el texto`
    );
  }

  const db = getDb();
  const assetId = newId("mediaAsset");
  const storagePath = await saveMediaFile(
    input.organizationId,
    assetId,
    input.file.data
  );
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: assetId,
      organizationId: input.organizationId,
      kind,
      mimeType: input.file.mimeType,
      fileName: input.file.fileName ?? null,
      fileSize: input.file.data.byteLength,
      caption: input.caption ?? null,
      storagePath,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  try {
    const waMediaId = await uploadGraphMedia(credentials!, input.file);
    await db
      .update(schema.mediaAsset)
      .set({ waMediaId, updatedAt: new Date() })
      .where(eq(schema.mediaAsset.id, assetId));

    const mediaPayload: Record<string, unknown> = { id: waMediaId };
    if (input.caption && kind !== "audio") mediaPayload.caption = input.caption;
    if (kind === "document" && input.file.fileName) {
      mediaPayload.filename = input.file.fileName;
    }
    const waMessageId = await callGraphSend(credentials!, {
      messaging_product: "whatsapp",
      to: recipient,
      type: kind,
      [kind]: mediaPayload,
    });

    const messageId = await persistOutbound({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId,
      type: kind,
      text: null,
      status: "pending",
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
    });
    return { messageId };
  } catch (err) {
    let sendErr: SendError;
    if (err instanceof SendError) {
      sendErr = err;
    } else if (err instanceof MetaApiError && err.isAuthError) {
      // Mismo criterio que el texto: SOLO 401/código 190 (fix 2026-08-04).
      await markReconnectRequired(input.organizationId);
      sendErr = new SendError(
        "reconnect_required",
        "El token de WhatsApp expiró: reconecta el número en Configuración"
      );
    } else {
      sendErr = new SendError(
        "upload_failed",
        "No se pudo subir el adjunto a WhatsApp"
      );
    }
    // El contenido NO se pierde: mensaje failed con el asset ya en disco.
    sendErr.messageId = await persistOutbound({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId: null,
      type: kind,
      text: null,
      status: "failed",
      error: sendErr.message,
      origin: "operator",
      mediaAssetId: assetId,
      media: asset,
    });
    throw sendErr;
  }
}

export type LocationInput = {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
};

export type ContactInput = { name: string; phone: string };

/** 008 — Envía una ubicación o contactos (payload estructurado, sin archivo). */
export async function sendStructured(
  input: {
    conversationId: string;
    organizationId: string;
  } & (
    | { kind: "location"; location: LocationInput }
    | { kind: "contacts"; contacts: ContactInput[] }
  )
): Promise<SendResult> {
  const { credentials, recipient } = await prepareSend(
    input.conversationId,
    input.organizationId
  );
  // Ubicaciones y contactos son mensajes de WhatsApp: en los demás canales no
  // hay credenciales de WhatsApp que usar y Graph los rechazaría.
  if (!credentials) {
    throw new SendError(
      "meta_error",
      "Este canal no admite ubicaciones ni contactos; manda el texto"
    );
  }

  const payload =
    input.kind === "location"
      ? { type: "location", location: input.location }
      : {
          type: "contacts",
          contacts: input.contacts.map((c) => ({
            name: { formatted_name: c.name, first_name: c.name },
            phones: [{ phone: c.phone, type: "CELL" }],
          })),
        };

  const waMessageId = await callGraphSend(credentials, {
    messaging_product: "whatsapp",
    to: recipient,
    ...payload,
  });

  const db = getDb();
  const assetRows = await db
    .insert(schema.mediaAsset)
    .values({
      id: newId("mediaAsset"),
      organizationId: input.organizationId,
      kind: input.kind,
      payload: input.kind === "location" ? input.location : input.contacts,
      fetchStatus: "available",
    })
    .returning();
  const asset = assetRows[0]!;

  const messageId = await persistOutbound({
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    waMessageId,
    type: input.kind,
    text: null,
    status: "pending",
    origin: "operator",
    mediaAssetId: asset.id,
    media: asset,
  });
  return { messageId };
}

/** Llama a Graph /messages y traduce errores de Meta a SendError. */
export async function callGraphSend(
  credentials: Credentials,
  payload: unknown
): Promise<string> {
  try {
    const res = await graphRequest<{ messages?: { id: string }[] }>(
      `${credentials.phoneNumberId}/messages`,
      {
        method: "POST",
        token: credentials.token,
        body: payload,
        // 024: sin tope, un Meta colgado bloqueaba el turno. Vencido = ambiguo.
        timeoutMs: ATTEMPT_TIMEOUT_MS,
      }
    );
    const id = res.messages?.[0]?.id;
    if (!id) {
      // 200 sin id: Meta pudo haberlo aceptado. La política lo trata como
      // ambiguo (jamás como rechazo seguro).
      const missing = new SendError("meta_error", "Meta no devolvió ID de mensaje");
      missing.transport = {
        httpStatus: 200,
        code: null,
        subcode: null,
        network: null,
        noMessageId: true,
      };
      throw missing;
    }
    return id;
  } catch (err) {
    if (err instanceof MetaApiError) {
      const transport: TransportFailure = {
        httpStatus: err.status,
        code: err.code,
        subcode: err.subcode,
        network: err.network,
      };
      let sendErr: SendError;
      if (err.isAuthError) {
        await markReconnectRequired(credentials.organizationId);
        sendErr = new SendError(
          "reconnect_required",
          "El token de WhatsApp expiró: reconecta el número en Configuración"
        );
      } else if (err.status === 0 || err.status >= 500) {
        sendErr = new SendError("meta_unavailable", "Meta no está disponible ahora");
      } else {
        // Mismo traductor que ya usa el fallo ASÍNCRONO (status.ts): un rechazo
        // síncrono con el mismo código (p. ej. 131026) debe leerse igual de
        // claro, no como la jerga cruda de Meta.
        sendErr = new SendError("meta_error", describeSendError(err.code, err.message));
      }
      sendErr.transport = transport;
      throw sendErr;
    }
    throw err;
  }
}


/**
 * 014 — Envío por el canal de Instagram. Traduce los fallos al mismo
 * vocabulario de SendError que ya usa WhatsApp, para que la bandeja no tenga
 * que aprender un idioma por plataforma.
 */
async function callInstagramSend(
  target: SendTarget,
  text: string
): Promise<string> {
  const creds = target.instagram!;

  const caps = capabilitiesFor("instagram");
  if (!textFits("instagram", text)) {
    throw new SendError(
      "meta_error",
      `${caps.label} no acepta mensajes de más de ${caps.maxTextBytes} bytes: acorta el texto`
    );
  }

  // Instagram no tiene plantillas: fuera de la ventana de 24 h la única vía
  // es la etiqueta de agente humano (hasta 7 días).
  const humanAgentTag = !isWindowOpen(target.conversation.lastInboundAt);

  try {
    const res = await sendInstagramText({
      credentials: creds,
      recipient: target.recipient,
      threadRef: target.conversation.channelThreadRef,
      text,
      humanAgentTag,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markInstagramReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de Instagram expiró o fue revocado: reconecta la cuenta"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          "Instagram no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}

/**
 * 017 — Envío por el canal de Messenger. Mismo vocabulario de SendError que
 * WhatsApp e Instagram: la bandeja no aprende un idioma por plataforma.
 */
async function callMessengerSend(
  target: SendTarget,
  text: string
): Promise<string> {
  const creds = target.messenger!;

  const caps = capabilitiesFor("messenger");
  if (!textFits("messenger", text)) {
    throw new SendError(
      "meta_error",
      `${caps.label} no acepta mensajes de más de ${caps.maxTextBytes} bytes: acorta el texto`
    );
  }

  // Messenger no tiene plantillas: fuera de la ventana de 24 h la única vía
  // es la etiqueta de agente humano (hasta 7 días).
  const humanAgentTag = !isWindowOpen(target.conversation.lastInboundAt);

  try {
    const res = await sendMessengerText({
      credentials: creds,
      recipient: target.recipient,
      // Zernio responde dentro de SU conversación, no al PSID: sin esta
      // referencia el envío no tiene a dónde ir.
      threadRef: target.conversation.channelThreadRef,
      text,
      humanAgentTag,
    });
    return res.platformMessageId;
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        await markMessengerReconnectRequired(creds.organizationId);
        throw new SendError(
          "reconnect_required",
          "El token de la página expiró o fue revocado: reconecta Messenger"
        );
      }
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          "Messenger no está disponible en este momento; intenta de nuevo"
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}

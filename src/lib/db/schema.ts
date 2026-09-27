import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* ============================================================
 * Auth (Better Auth + plugin organization)
 * ============================================================ */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  metadata: text("metadata"),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

/* ============================================================
 * Dominio (toda tabla lleva organization_id NOT NULL + índice org-first)
 * ============================================================ */

export const contact = pgTable(
  "contact",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Llave de resolución WhatsApp (003): teléfono normalizado (521→52) o
     * `bsuid:<id>` cuando Meta no manda wa_id. Estable de por vida.
     */
    /**
     * 014: canal por el que vive este contacto. Aditivo y con default: toda
     * fila existente sigue significando exactamente lo mismo.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger"] })
      .notNull()
      .default("whatsapp"),
    /**
     * Llave de resolucion. WhatsApp: telefono normalizado (521 a 52) o
     * `bsuid:<id>`. Instagram (014): `ig:<IGSID>`. Estable de por vida.
     * El nombre `wa_identity` se conserva porque es contrato publicado:
     * `/api/bot/context?waIdentity=...` lo recibe y lo devuelve, y hay
     * cerebros externos que dependen de el.
     */
    waIdentity: text("wa_identity").notNull(),
    /** Teléfono como ATRIBUTO opcional (003): falta en contactos BSUID. */
    phone: text("phone"),
    /** Business-Scoped User ID si se conoce (003). */
    waUserId: text("wa_user_id"),
    name: text("name").notNull(),
    notes: text("notes"),
    /**
     * Ficha de calificación que levanta un cerebro externo por
     * `PUT /api/bot/ficha`. Es un objeto libre a propósito: los datos que
     * importan de un lead los define cada negocio (una clínica querrá
     * "tratamiento", una constructora "metros"), y cablearlos como columnas
     * obligaría a migrar el CRM cada vez que alguien cambia su cuestionario.
     * Merge campo a campo; `null` explícito borra la clave.
     */
    ficha: jsonb("ficha").$type<Record<string, unknown>>(),
    /**
     * De dónde salió el prospecto. NULL = nadie la capturó, y entonces la API
     * la deduce. Así no hace falta backfill ni marcar en falso los contactos
     * que ya existían.
     */
    source: text("source", {
      enum: ["anuncio", "organico", "referido", "conocido", "otro"],
    }),
    /**
     * Fase 4 (auditoría 2026-09) — marca EXPLÍCITA y manual de que este
     * contacto no es un prospecto real: `demo` (datos de demostración, p. ej.
     * `seedDemo`/"Ferretería El Martillo") o `system` (ping de prueba de
     * Meta, número propio del negocio, etc. — p. ej. el contacto
     * "WhatsApp Business" que crea el botón "Enviar mensaje" del panel de
     * developers.facebook.com). NULL en TODA fila existente y en todo
     * contacto nuevo real: nadie lo pone salvo que el operador lo marque a
     * mano desde la ficha del contacto — nunca se infiere ni se reclasifica
     * solo. `seedDemo` sí lo fija en sus propias filas nuevas.
     */
    sampleType: text("sample_type", { enum: ["demo", "system"] }),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // 014: el canal entra en la llave. Sin el, un IGSID que coincidiera con
    // un telefono normalizado mezclaria dos personas en silencio.
    uniqueIndex("contact_org_channel_identity_uq").on(
      t.organizationId,
      t.channel,
      t.waIdentity
    ),
    index("contact_org_wa_user_id_idx").on(t.organizationId, t.waUserId),
    index("contact_org_name_idx").on(t.organizationId, t.name),
  ]
);

export const pipelineStage = pgTable(
  "pipeline_stage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    /** open = etapa normal · won / lost = anclas no borrables */
    kind: text("kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("stage_org_pos_idx").on(t.organizationId, t.position)]
);

export const lead = pgTable(
  "lead",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    stageId: text("stage_id")
      .notNull()
      .references(() => pipelineStage.id),
    position: integer("position").notNull().default(0),
    /**
     * Monto de la negociación en CENTAVOS ENTEROS. NULL = nadie lo capturó, que
     * no es lo mismo que cero: un trato sin monto no vale $0, simplemente no se
     * sabe, y el tablero lo dice con palabras en vez de sumar un cero.
     */
    amountCents: integer("amount_cents"),
    /** Moneda del monto; la del negocio al capturarlo (Ajustes → Marca). */
    currency: text("currency"),
    /**
     * Prioridad de cierre. NULL = nadie la ha decidido, que NO es lo mismo que
     * "media": nada la escribe automáticamente, así que el dueño puede confiar
     * en que lo que ve es lo que él puso.
     */
    priority: text("priority", { enum: ["alta", "media", "baja"] }),
    priorityUpdatedAt: timestamp("priority_updated_at"),
    lastActivityAt: timestamp("last_activity_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lead_contact_uq").on(t.contactId),
    index("lead_org_stage_idx").on(t.organizationId, t.stageId, t.position),
  ]
);

/**
 * Bitácora de movimientos de etapa: append-only. Nada se actualiza ni se borra;
 * corregir un dato es agregar un movimiento nuevo.
 *
 * Es el cimiento de todo lo histórico: sin ella el CRM solo sabe dónde está
 * cada lead HOY, y "¿cuánto cerré en julio?" no tiene respuesta.
 *
 * Regla dura: la ÚNICA puerta que escribe aquí —y que escribe `lead.stage_id`—
 * es `src/server/leads/stage-history.ts`. Un unit test de vigilancia falla si
 * aparece otra escritura, porque un camino que mueva el lead sin registrar el
 * evento no truena: solo hace que las gráficas mientan meses después.
 */
export const leadStageEvent = pgTable(
  "lead_stage_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "cascade" }),
    /** Denormalizado a propósito: casi toda agregación cruza con el contacto,
     *  y el join extra se pagaría en cada consulta. */
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** NULL = el lead nació en `toStage` (evento de creación). */
    fromStageId: text("from_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    fromStageName: text("from_stage_name"),
    toStageId: text("to_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    /** Snapshots: sobreviven al renombre y al borrado de la etapa, para que
     *  reorganizar el tablero de hoy no reescriba el embudo del pasado. */
    toStageName: text("to_stage_name").notNull(),
    toStageKind: text("to_stage_kind", { enum: ["open", "won", "lost"] })
      .notNull()
      .default("open"),
    /** Cuándo PASÓ (no cuándo se registró). */
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    /** NULL = no lo movió una persona (bot, sistema, migración). */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    source: text("source", {
      enum: ["dueno", "bot", "sistema", "migracion"],
    })
      .notNull()
      .default("dueno"),
    /** true = fecha SEMBRADA en la migración, no observada. Cuenta para los
     *  totales pero jamás para promedios de tiempo. */
    approximate: boolean("approximate").notNull().default(false),
    lossReason: text("loss_reason", {
      enum: [
        "precio",
        "no_es_perfil",
        "sin_presupuesto",
        "eligio_otro",
        "nunca_contesto",
        "otro",
      ],
    }),
    lossNote: text("loss_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("lse_org_occurred_idx").on(t.organizationId, t.occurredAt),
    index("lse_lead_occurred_idx").on(t.leadId, t.occurredAt),
    index("lse_org_kind_occurred_idx").on(
      t.organizationId,
      t.toStageKind,
      t.occurredAt
    ),
    // Perder un trato sin motivo es imposible a nivel de BASE, no por
    // disciplina de cada ruta. La excepción es la siembra de la migración: no
    // puede inventar un motivo que nadie capturó.
    check(
      "lse_loss_reason_ck",
      sql`${t.toStageKind} <> 'lost' OR ${t.approximate} = true OR ${t.lossReason} IS NOT NULL`
    ),
  ]
);

export const conversation = pgTable(
  "conversation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Conversación del Laboratorio: jamás toca la API de WhatsApp. */
    isTest: boolean("is_test").notNull().default(false),
    /**
     * 014: canal de la conversacion. Denormalizado del contacto a proposito:
     * el ruteo de salida y el filtro de la bandeja lo leen en cada mensaje.
     */
    channel: text("channel", { enum: ["whatsapp", "instagram", "messenger"] })
      .notNull()
      .default("whatsapp"),
    /**
     * 014: identificador del hilo en la plataforma de origen. Zernio entrega
     * un conversationId opaco ("no asumas su formato") que hace falta para
     * responder; WhatsApp no lo necesita y queda null.
     */
    channelThreadRef: text("channel_thread_ref"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    handoffAt: timestamp("handoff_at"),
    handoffReason: text("handoff_reason", {
      // 008: manual_reply = el dueño respondió desde la app del teléfono.
      // hostilidad = el lead se puso agresivo y el agente se retiró.
      // reprogramacion (auditoría 2026-09-17): el cliente pidió mover una cita
      // y no hay una herramienta de reprogramación segura para el agente
      // incluido — se deriva y se bloquea una cita sustitutiva.
      // agenda_ambigua (026): 3 aclaraciones de disponibilidad consecutivas
      // sin resolver (regla 15) — sin migración, el `enum` es sólo de TS.
      enum: [
        "cliente",
        "modelo",
        "error",
        "ventana",
        "hostilidad",
        "manual_reply",
        "reprogramacion",
        "agenda_ambigua",
      ],
    }),
    lastInboundAt: timestamp("last_inbound_at"),
    lastMessageAt: timestamp("last_message_at"),
    unreadCount: integer("unread_count").notNull().default(0),
    /**
     * 023 — Estado TÉCNICO de los fallos de IA de esta conversación, aislado
     * del texto que ve el cliente (antes se deducía comparando el último
     * mensaje saliente con el texto de degradación: frágil ante un cambio de
     * `AI_FALLBACK_MESSAGE`, un mensaje editado o un operador que escribe lo
     * mismo). `ai_fail_count` = fallos de formato CONSECUTIVOS; se incrementa
     * de forma atómica en SQL (varias instancias/reinicios sin carreras) y
     * vuelve a 0 con el siguiente turno exitoso o al reactivar la IA.
     * `ai_fail_kind` = código del último fallo (o `circuit_open` si el
     * circuito de protección avisó al cliente); `ai_fail_at` = cuándo.
     */
    aiFailCount: integer("ai_fail_count").notNull().default(0),
    aiFailKind: text("ai_fail_kind"),
    aiFailAt: timestamp("ai_fail_at"),
    /**
     * 026 — Memoria de aclaración de disponibilidad, CONSECUTIVA por
     * conversación (mismo patrón que `ai_fail_*` de 023, migración 0024).
     * `agenda_clarify_count`: cuántas aclaraciones seguidas sin resolver
     * (≥ 3 ⇒ handoff `agenda_ambigua`, regla 15). `agenda_clarify_kind`: la
     * última razón (`unresolved_day` · `already_passed_this_week` ·
     * `too_many_days` · `unresolved_time` · `unresolved_range`) — el `enum`
     * es sólo de TypeScript, agregar razones no exige migración.
     * `agenda_clarify_context`: JSON acotado (≤ 300 car.) con SÓLO lo ya
     * entendido (calificador de semana, palabras de día) — nunca el mensaje
     * completo del cliente ni ningún dato personal (`agenda-clarify-context.ts`
     * sanea antes de escribir). Se resetea a 0/null/null cuando el turno
     * resuelve, se crea una cita, cambia de forma inequívoca el tema, o
     * interviene un humano (cualquier handoff, `applyHandoff`).
     */
    agendaClarifyCount: integer("agenda_clarify_count").notNull().default(0),
    agendaClarifyKind: text("agenda_clarify_kind"),
    agendaClarifyContext: text("agenda_clarify_context"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Una conversación real por contacto; las de prueba no compiten.
    uniqueIndex("conversation_org_contact_real_uq")
      .on(t.organizationId, t.contactId)
      .where(sql`${t.isTest} = false`),
    index("conversation_org_last_idx").on(t.organizationId, t.lastMessageAt),
  ]
);

export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /** ID de WhatsApp — UNIQUE (idempotencia). Nullable en salientes de prueba. */
    waMessageId: text("wa_message_id").unique(),
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    type: text("type").notNull().default("text"),
    text: text("text"),
    /**
     * 024 — Ciclo de vida del saliente (ver specs/024 §3.1). `queued` →
     * `sending` → `pending` (Meta aceptó; hay `wamid`) → `sent` → `delivered` →
     * `read`. Un fallo recuperable pasa por `retrying`; un resultado ambiguo se
     * queda en `delivery_unknown` (nunca se reenvía solo); `failed` es terminal
     * (failed_final) y conserva el payload. `status` es `text`: el `enum` es
     * sólo de TypeScript, agregar estados no exige migración de tipo.
     */
    status: text("status", {
      enum: [
        "queued",
        "sending",
        "pending",
        "sent",
        "delivered",
        "read",
        "retrying",
        "delivery_unknown",
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    error: text("error"),
    /** 024 — Intentos de transporte reclamados (incluye el que está en vuelo). */
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    /** 024 — Cuándo se puede reclamar el siguiente intento (`retrying`). */
    nextAttemptAt: timestamp("next_attempt_at"),
    /** 024 — Arrendamiento del intento en vuelo; vencido ⇒ intento huérfano. */
    lockedUntil: timestamp("locked_until"),
    /** 024 — Código/subcódigo de Meta y clase del último fallo (saneados). */
    errorCode: integer("error_code"),
    errorSubcode: integer("error_subcode"),
    errorClass: text("error_class"),
    /** 024 — Correlación interna (`trc_…`); jamás derivada de datos del cliente. */
    traceId: text("trace_id"),
    /**
     * 024 — Un turno del agente, una respuesta lógica: `agent-turn:<id del
     * inbound>`. UNIQUE: la segunda inserción del mismo turno no crea otro mensaje.
     */
    dedupeKey: text("dedupe_key").unique(),
    /**
     * 024 — Estado de la RONDA DE HORARIOS que este mensaje muestra (nulo = no
     * es una oferta). `pending`: aún no aceptado por Meta, no seleccionable.
     * `active`: aceptado, seleccionable. `superseded`: una ronda posterior, una
     * reserva o una revalidación la volvieron obsoleta. `consumed`: el
     * prospecto reservó. Sólo `pending`/`active` admiten reenviar el mismo texto.
     */
    offerState: text("offer_state", {
      enum: ["pending", "active", "superseded", "consumed"],
    }),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    /**
     * 008 — Origen del saliente: IA (bot), operador del CRM, manual desde la
     * app de WhatsApp Business del teléfono (echo), o plantilla. En entrantes
     * queda el default y la UI lo ignora.
     */
    origin: text("origin", {
      enum: ["ai", "operator", "manual", "template"],
    })
      .notNull()
      .default("operator"),
    /** 008 — Adjunto del mensaje (imagen, doc, ubicación…), si lo hay. */
    mediaAssetId: text("media_asset_id").references(() => mediaAsset.id, {
      onDelete: "set null",
    }),
    waTimestamp: timestamp("wa_timestamp"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("message_org_conv_idx").on(
      t.organizationId,
      t.conversationId,
      t.createdAt
    ),
    // 024: el barrido del outbox sólo mira lo que está en vuelo.
    index("message_outbox_due_idx")
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} in ('queued','retrying','sending')`),
  ]
);

/**
 * 024 — Un INTENTO de transporte de un mensaje lógico. El mensaje (`message`)
 * es la única representación visible; sus intentos viven aquí. Nunca guarda el
 * JSON de error de Meta, el cuerpo enviado (es `message.text`, inmutable) ni el
 * destinatario: sólo código, subcódigo, clase, HTTP status y `wamid`.
 */
export const messageDeliveryAttempt = pgTable(
  "message_delivery_attempt",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    stage: text("stage", { enum: ["sync", "async"] }).notNull(),
    outcome: text("outcome", {
      enum: [
        "started",
        "accepted",
        "transient_failure",
        "rate_limited",
        "ambiguous",
        "permanent_failure",
        "async_failed",
        "abandoned",
      ],
    }).notNull(),
    errorClass: text("error_class"),
    metaCode: integer("meta_code"),
    metaSubcode: integer("meta_subcode"),
    httpStatus: integer("http_status"),
    wamid: text("wamid"),
    traceId: text("trace_id"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    uniqueIndex("message_delivery_attempt_msg_no_uq").on(t.messageId, t.attemptNo),
    index("message_delivery_attempt_org_idx").on(t.organizationId),
  ]
);

/**
 * Auditoría 2026-09-17 (incidente GRojas/Más Impulso) — hechos ATÓMICOS que el
 * agente de IA levanta de una conversación real, con origen y estado de
 * confirmación. Reemplaza el viejo patrón de `appendLeadNote` (concatenar
 * `[IA] ...` sin fin al `contact.notes` de texto libre): aquella fila única
 * mezclaba diez resúmenes acumulativos, giros de negocio incompatibles e
 * inferencias presentadas como hechos, todo en el mismo campo que el dueño
 * edita a mano.
 *
 * `contact.notes` sigue existiendo pero pasa a ser 100% del dueño: el agente
 * YA NO escribe ahí. Sus hallazgos viven aquí, uno por fila, nunca reescritos
 * ni fusionados — corregir es agregar una fila nueva, igual que
 * `lead_stage_event`.
 */
export const contactNote = pgTable(
  "contact_note",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    /** Por ahora siempre 'ai': puerta abierta para anotar origen humano
     *  estructurado más adelante sin migrar de nuevo. */
    source: text("source", { enum: ["ai", "human"] })
      .notNull()
      .default("ai"),
    /**
     * confirmed = el cliente lo dijo en una conversación real y el giro
     * coincide con lo ya establecido para este contacto. test = la
     * conversación es del Laboratorio (`conversation.is_test`). conflict =
     * el giro/escenario mencionado NO coincide con el ya confirmado para este
     * contacto (alguien probando otro negocio con el mismo teléfono): se
     * guarda para auditoría pero NUNCA alimenta ficha, etapa ni métricas.
     * Ninguna fila cambia de estado después de creada — corregirla es dejar
     * que un mensaje posterior escriba una fila nueva, no reinterpretar esta.
     */
    status: text("status", { enum: ["confirmed", "test", "conflict"] })
      .notNull()
      .default("confirmed"),
    /** Giro/tema breve que el propio turno declaró (p. ej. "plomería"); NULL
     *  si el turno no lo precisó. Es lo que permite detectar el choque de
     *  arriba sin adivinar a partir del texto libre de `text`. */
    scenario: text("scenario"),
    /** El hecho atómico tal cual, acotado (ver MAX_NOTE_LEN en
     *  server/contacts/notes.ts) — nunca un resumen acumulado de todo lo
     *  dicho hasta ahora. */
    text: text("text").notNull(),
    /** Hash del texto normalizado: la llave de deduplicación de abajo. */
    contentHash: text("content_hash").notNull(),
    /** Mensaje entrante que originó esta nota, si se conoce. */
    sourceMessageId: text("source_message_id").references(() => message.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("contact_note_org_contact_idx").on(
      t.organizationId,
      t.contactId,
      t.createdAt
    ),
    // Reintentos y ráfagas de mensajes agrupadas por el coalesce no duplican:
    // el mismo hecho para el mismo contacto se inserta una sola vez.
    uniqueIndex("contact_note_contact_hash_uq").on(t.contactId, t.contentHash),
  ]
);

/**
 * 008 — Adjuntos: archivo (imagen/video/audio/documento/sticker) copiado al
 * volumen local (`MEDIA_DIR`) o contenido estructurado (location/contacts) en
 * `payload`. Meta expira sus archivos (~30 días): el disco propio es la
 * fuente durable (constitución II: sin S3/R2).
 */
export const mediaAsset = pgTable(
  "media_asset",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "image",
        "video",
        "audio",
        "document",
        "sticker",
        "location",
        "contacts",
      ],
    }).notNull(),
    /** media id de Graph (entrantes/salientes subidos); NULL en location/contacts. */
    waMediaId: text("wa_media_id"),
    mimeType: text("mime_type"),
    fileName: text("file_name"),
    fileSize: integer("file_size"),
    caption: text("caption"),
    /** location {latitude, longitude, name?, address?} o contacts (subset). */
    payload: jsonb("payload"),
    /** Ruta relativa dentro de MEDIA_DIR; NULL si aún no descargado o no aplica. */
    storagePath: text("storage_path"),
    fetchStatus: text("fetch_status", {
      enum: ["available", "pending", "failed"],
    })
      .notNull()
      .default("pending"),
    fetchError: text("fetch_error"),
    /**
     * 018 (fix 2026-09-16) — Motivo de un intento de transcripción de audio
     * que terminó sin `caption` (proveedor sin soporte de audio, sin voz
     * entendible, error del proveedor…). Antes esto se perdía en silencio: el
     * turno del agente no tenía forma de distinguir "todavía transcribiendo"
     * de "ya falló", así que respondía con el marcador genérico antes de
     * tiempo. NULL mientras no se haya intentado o si `caption` ya tiene el
     * resultado.
     */
    transcribeError: text("transcribe_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("media_asset_org_idx").on(t.organizationId, t.createdAt),
    index("media_asset_wa_media_idx").on(t.waMediaId),
  ]
);

export const metaCredentials = pgTable(
  "meta_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    wabaId: text("waba_id").notNull(),
    phoneNumberId: text("phone_number_id").notNull(),
    displayPhoneNumber: text("display_phone_number"),
    verifiedName: text("verified_name"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("meta_credentials_org_uq").on(t.organizationId),
    // El webhook enruta por phone_number_id: debe ser único en la instancia.
    uniqueIndex("meta_credentials_phone_uq").on(t.phoneNumberId),
  ]
);

/**
 * 014 - Credenciales del canal de Instagram. Tabla explicita (no un jsonb
 * generico) porque unas credenciales tienen forma fija y conocida: asi
 * conservan tipado e indices. El token se cifra con los mismos helpers que el
 * de WhatsApp; un segundo mecanismo de cifrado seria un segundo mecanismo que
 * auditar.
 */
export const instagramCredentials = pgTable(
  "instagram_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** De donde vienen los mensajes: API unificada o app propia de Meta. */
    source: text("source", { enum: ["zernio", "meta"] }).notNull(),
    /** IG_ID del perfil profesional: por el enruta el webhook. */
    igUserId: text("ig_user_id").notNull(),
    /** Zernio: accountId de la cuenta conectada. Meta directo: null. */
    accountRef: text("account_ref"),
    username: text("username"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /** Secreto HMAC de las entregas (Zernio); null en modo Meta. */
    webhookSecret: text("webhook_secret"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("instagram_credentials_org_uq").on(t.organizationId),
    uniqueIndex("instagram_credentials_ig_user_uq").on(t.igUserId),
    index("instagram_credentials_account_ref_idx").on(t.accountRef),
  ]
);

/**
 * 017 — Credenciales del canal de Messenger: la página de Facebook y su token
 * de acceso, cifrado con el mismo AES-256-GCM que los demás. Tabla propia y
 * explícita, como la de Instagram: unas credenciales tienen forma fija y
 * conocida, y esconderlas en un jsonb perdería el tipado y los índices.
 */
export const messengerCredentials = pgTable(
  "messenger_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** De donde vienen los mensajes: API unificada o app propia de Meta. */
    source: text("source", { enum: ["zernio", "meta"] })
      .notNull()
      .default("meta"),
    /**
     * ID de la página de Facebook: por él enruta el webhook de Meta
     * (`entry[].id`). En modo Zernio puede no conocerse — ahí enruta
     * `account_ref` — así que es opcional.
     */
    pageId: text("page_id"),
    pageName: text("page_name"),
    /** Zernio: accountId de la cuenta conectada. Meta directo: null. */
    accountRef: text("account_ref"),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /** Secreto HMAC de las entregas (Zernio); null en modo Meta. */
    webhookSecret: text("webhook_secret"),
    status: text("status", { enum: ["connected", "reconnect_required"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messenger_credentials_org_uq").on(t.organizationId),
    uniqueIndex("messenger_credentials_page_uq").on(t.pageId),
    index("messenger_credentials_account_ref_idx").on(t.accountRef),
  ]
);

export const agentProfile = pgTable(
  "agent_profile",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    name: text("name").notNull().default("Asistente"),
    tone: text("tone"),
    instructions: text("instructions"),
    escalationRules: text("escalation_rules"),
    greeting: text("greeting"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_profile_org_uq").on(t.organizationId)]
);

/**
 * Fase 6 (auditoría 2026-09) — historial de comportamiento del agente:
 * publicar instrucciones defectuosas directamente (sin vista previa, sin
 * poder volver atrás) era el riesgo reportado. Cada PATCH real a
 * `agent_profile` (los campos de "Comportamiento", NUNCA el toggle
 * `enabled`) guarda AQUÍ el estado que estaba a punto de reemplazarse —
 * nunca el estado nuevo, que ya vive en `agent_profile` — así que esta tabla
 * es, en efecto, una pila de deshacer: revertir copia una fila de vuelta a
 * `agent_profile` y ANTES de hacerlo guarda el estado actual aquí también,
 * de forma que revertir nunca pierde lo que había.
 */
export const agentProfileVersion = pgTable(
  "agent_profile_version",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tone: text("tone"),
    instructions: text("instructions"),
    escalationRules: text("escalation_rules"),
    greeting: text("greeting"),
    /** Quién causó que ESTE estado dejara de ser el vigente. NULL = se perdió
     *  la sesión (usuario borrado) o vino de un seed/migración. */
    changedByUserId: text("changed_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("agent_profile_version_org_idx").on(t.organizationId, t.createdAt),
  ]
);

/**
 * 022 — Credenciales del proveedor LLM (OpenRouter-compatible) por
 * organización: token + modelo, cifrados igual que WhatsApp/Zoom/Google. Sin
 * fila, el runtime cae a las variables de entorno (`OPENROUTER_*`) — así una
 * instancia recién desplegada sigue funcionando exactamente como hoy.
 */
export const aiCredentials = pgTable(
  "ai_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    model: text("model").notNull(),
    /** Modelo del juez del Laboratorio; null ⇒ reusa `model`. */
    judgeModel: text("judge_model"),
    /** `error` SE ESCRIBE cuando el proveedor rechaza el token. */
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_credentials_org_uq").on(t.organizationId)]
);

export const kbEntry = pgTable(
  "kb_entry",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["qa", "block"] }).notNull(),
    question: text("question"),
    answer: text("answer"),
    content: text("content"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("kb_org_idx").on(t.organizationId)]
);

export const template = pgTable(
  "template",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    category: text("category").notNull(),
    body: text("body").notNull(),
    status: text("status", {
      enum: ["draft", "pending", "approved", "rejected"],
    })
      .notNull()
      .default("draft"),
    rejectionReason: text("rejection_reason"),
    waTemplateId: text("wa_template_id"),
    /**
     * Plantilla genérica: con la ventana de 24 h cerrada, lo que el operador
     * escribe en el chat sale envuelto en ésta como su única variable `{{1}}`.
     * Es una marca LOCAL — Meta no la ve, así que cambiarla no pide volver a
     * aprobar nada.
     */
    isWindowFallback: boolean("is_window_fallback").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("template_org_name_lang_uq").on(
      t.organizationId,
      t.name,
      t.language
    ),
    // A lo más UNA genérica por organización, garantizado por la base: dos
    // pestañas marcando plantillas distintas a la vez no pueden ganar las dos.
    uniqueIndex("template_org_window_fallback_uq")
      .on(t.organizationId)
      .where(sql`${t.isWindowFallback} = true`),
  ]
);

export const agentTestRun = pgTable(
  "agent_test_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "done", "failed"] })
      .notNull()
      .default("running"),
    score: integer("score"),
    error: text("error"),
    /**
     * Fase 6 — true cuando la corrida probó un CAMBIO SIN GUARDAR
     * (`POST /api/lab/runs` con `profileOverride`, desde la vista previa de
     * Ajustes → Agente), no el comportamiento vigente. El historial del
     * Laboratorio necesita distinguirlo: un score bajo aquí es sobre
     * instrucciones que todavía no publicaste, no sobre las que sí están
     * en producción.
     */
    isDraftPreview: boolean("is_draft_preview").notNull().default(false),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    // Lock de concurrencia en BD: máximo 1 corrida activa por organización.
    uniqueIndex("test_run_org_running_uq")
      .on(t.organizationId)
      .where(sql`${t.status} = 'running'`),
    index("test_run_org_idx").on(t.organizationId, t.startedAt),
  ]
);

/* ============================================================
 * 015 — Motor de agenda (detrás de la bandera AGENDA)
 *
 * Las tablas se crean SIEMPRE, encendida o apagada la bandera: una tabla
 * vacía es inerte, y a cambio todas las instancias del mundo comparten la
 * misma estructura y la misma cadena de migraciones (ADR-001).
 * ============================================================ */

/** Configuración de la agenda del negocio: una fila por organización. */
export const calendarSettings = pgTable(
  "calendar_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** `{"mon":[{"start":"09:00","end":"18:00"}]}` — hora de PARED, no UTC. */
    weeklyHours: jsonb("weekly_hours").notNull(),
    slotMinutes: integer("slot_minutes").notNull().default(30),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    minNoticeHours: integer("min_notice_hours").notNull().default(2),
    maxDaysAhead: integer("max_days_ahead").notNull().default(7),
    timezone: text("timezone").notNull().default("America/Mexico_City"),
    /**
     * Cómo se entrega la reunión. `enlace-fijo` no habla con nadie: es el
     * default y la razón de que encender la agenda no exija terceros.
     * Un fork agrega el suyo al catálogo del código sin tocar esta columna.
     */
    connector: text("connector").notNull().default("enlace-fijo"),
    /** Sala fija del conector `enlace-fijo`; null ⇒ citas sin link. */
    meetingLink: text("meeting_link"),
    /**
     * Título de la invitación (SUMMARY del .ics, enlaces de Google/Outlook y
     * el evento real si el conector crea uno). Separado A PROPÓSITO del
     * nombre de marca del CRM (`organization.name`, white-label) — ese puede
     * ser un placeholder de setup; este es lo que ve un prospecto ajeno al
     * CRM. `null` ⇒ usa `DEFAULT_APPOINTMENT_TITLE`.
     */
    appointmentTitle: text("appointment_title"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendar_settings_org_uq").on(t.organizationId)]
);

/**
 * La cita. Una sola tabla para sesiones y bloqueos manuales: un bloqueo es
 * una cita sin contacto que ocupa agenda igual.
 */
export const booking = pgTable(
  "booking",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["session", "block"] })
      .notNull()
      .default("session"),
    status: text("status", {
      enum: ["agendada", "realizada", "no_show", "cancelada"],
    })
      .notNull()
      .default("agendada"),
    source: text("source", { enum: ["manual", "ai"] })
      .notNull()
      .default("manual"),
    contactId: text("contact_id").references(() => contact.id, {
      onDelete: "cascade",
    }),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    leadId: text("lead_id").references(() => lead.id, { onDelete: "set null" }),
    /** Instante UTC. El horario semanal es de pared; esto ya está resuelto. */
    scheduledAt: timestamp("scheduled_at").notNull(),
    /** Capturada al crear: cambiar la configuración no reescribe el pasado. */
    durationMinutes: integer("duration_minutes").notNull(),
    /**
     * Con qué conector nació la ENTREGA. Reprogramar y cancelar hablan con
     * ESTE, no con el activo: si el negocio cambia de proveedor, las citas ya
     * confirmadas siguen viviendo donde se crearon.
     */
    connector: text("connector"),
    /** Id de la reunión/evento en el proveedor; null en `enlace-fijo`. */
    externalRef: text("external_ref"),
    /**
     * El link que se le dio al cliente. Se COPIA, no se lee de la
     * configuración: la cita es un hecho histórico, no una vista del presente.
     */
    meetingLink: text("meeting_link"),
    /**
     * El proveedor falló al crear la reunión. La cita existe igual —un tercero
     * caído no cuesta la conversión— y el operador reintenta desde "Citas".
     */
    linkPending: boolean("link_pending").notNull().default(false),
    /** Conversación del Laboratorio: jamás llama a un conector real. */
    isTest: boolean("is_test").notNull().default(false),
    /**
     * Auditoría 2026-09-17 — el cliente/modelo confirmó EXPLÍCITAMENTE que
     * esta es una reunión aparte, no un duplicado de una cita activa que ya
     * tenía el contacto. Sin esta marca, `booking_org_contact_single_active_uq`
     * rechaza la segunda cita: el blindaje es que el default sea "no", nunca
     * "sí" por inferencia del modelo.
     */
    additionalConfirmed: boolean("additional_confirmed").notNull().default(false),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("booking_org_when_idx").on(t.organizationId, t.scheduledAt),
    index("booking_org_status_idx").on(t.organizationId, t.status),
    /**
     * Anti doble-booking ATÓMICO. La re-validación al confirmar deja una
     * ventana entre leer y escribir; esto la cierra en la BASE: dos
     * confirmaciones simultáneas del mismo instante no pueden ganar las dos, y
     * la perdedora recibe un 23505 que el servicio traduce a `slot_taken` con
     * alternativas frescas. Las citas de prueba quedan fuera: no consumen la
     * agenda real.
     */
    uniqueIndex("booking_org_active_slot_uq")
      .on(t.organizationId, t.scheduledAt)
      .where(
        sql`${t.status} in ('agendada','realizada') and ${t.isTest} = false`
      ),
    /**
     * Auditoría 2026-09-17 — el mismo cierre atómico, pero por CONTACTO en vez
     * de por instante: a lo más una cita activa "normal" (sin
     * `additional_confirmed`) por contacto. Sin esto, la validación en
     * `createSessionBooking` deja una ventana entre leer y escribir igual que
     * el hueco: dos `book_slot` casi simultáneos para el mismo contacto (o un
     * reintento) podían colar una segunda cita en horarios DISTINTOS, que es
     * justo el bug reportado (Max agendó jueves 09:00 y luego jueves 10:00
     * para el mismo prospecto). Una cita adicional legítima existe: se marca
     * `additional_confirmed = true` y queda FUERA de este índice a propósito.
     */
    uniqueIndex("booking_org_contact_single_active_uq")
      .on(t.organizationId, t.contactId)
      .where(
        sql`${t.status} in ('agendada','realizada') and ${t.isTest} = false and ${t.additionalConfirmed} = false and ${t.contactId} is not null`
      ),
  ]
);

/**
 * Auditoría 2026-09-17 — la solicitud de mover una cita, como estado
 * PERSISTENTE ligado al contacto (y, cuando se conoce, a la cita original).
 *
 * Existe porque las instrucciones de prompt ("conserva la solicitud de
 * cambio...") son una capa de comportamiento, no un control transaccional: el
 * modelo puede cambiar de tema, alucinar que ya resolvió el pedido, o el
 * traspaso a un humano puede fallar a medias. Esta fila sobrevive a todo eso —
 * un cambio de tema, un handoff, un reinicio del turno — hasta que alguien
 * (un reprogramar real o el operador) la resuelve explícitamente.
 *
 * Un índice único PARCIAL por (org, contacto) con status='pending' hace que
 * registrar la MISMA solicitud dos veces sea idempotente: la segunda llamada
 * no crea una fila nueva, encuentra la que ya existía.
 */
export const bookingChangeRequest = pgTable(
  "booking_change_request",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    /** La cita que se quiere mover, cuando se pudo identificar con certeza. */
    originalBookingId: text("original_booking_id").references(() => booking.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: ["pending", "resolved", "cancelled"] })
      .notNull()
      .default("pending"),
    /** Resumen breve, tomado literalmente de lo que pidió el cliente. */
    note: text("note"),
    requestedAt: timestamp("requested_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => [
    index("booking_change_request_contact_idx").on(t.organizationId, t.contactId),
    uniqueIndex("booking_change_request_pending_uq")
      .on(t.organizationId, t.contactId)
      .where(sql`${t.status} = 'pending'`),
  ]
);

/**
 * La memoria de lo ofrecido. Es lo que hace verificable el requisito
 * innegociable: sin fila aquí, no hay reserva.
 *
 * Vive en el CRM y no en quien conduce la conversación porque Vocero promete
 * "conecta TU propio cerebro": con la garantía del lado del cliente, cualquier
 * cerebro podría reservar un instante que jamás se ofreció y el CRM lo
 * aceptaría.
 */
export const offeredSlot = pgTable(
  "offered_slot",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    startUtc: timestamp("start_utc").notNull(),
    /** La etiqueta EXACTA que se le mostró al cliente. */
    label: text("label").notNull(),
    offeredAt: timestamp("offered_at").notNull().defaultNow(),
    /**
     * 024 — El mensaje lógico que mostró estos horarios. Nulo = oferta sin
     * mensaje propio (API del cerebro externo; la re-oferta del agente sí lleva mensaje, spec 024 §5.7).
     */
    messageId: text("message_id").references(() => message.id, {
      onDelete: "cascade",
    }),
    /**
     * 024 — `pending`: el mensaje que los muestra aún no fue aceptado por Meta,
     * así que el prospecto no los ha visto y NO son seleccionables. `active`:
     * seleccionables (todo lo anterior a 024 lo es).
     */
    state: text("state", { enum: ["pending", "active"] })
      .notNull()
      .default("active"),
    /**
     * 024 — El horario aparece en el TEXTO del mensaje (el catálogo registrado
     * es más ancho que el menú que se muestra). Sólo estos se revalidan antes
     * de reenviar: lo que el prospecto no ve no puede dejar obsoleta la oferta.
     * Las filas anteriores a 024 quedan `true` (comportamiento idéntico).
     */
    shown: boolean("shown").notNull().default(true),
  },
  (t) => [
    index("offered_slot_conv_idx").on(t.conversationId, t.startUtc),
    index("offered_slot_message_idx").on(t.messageId),
  ]
);

/**
 * Credenciales del conector Zoom (app Server-to-Server del propio negocio).
 * Tabla explícita como las de WhatsApp e Instagram: unas credenciales tienen
 * forma fija y conocida, y así conservan tipado e índices. El secreto se cifra
 * con los mismos helpers; un segundo mecanismo sería otro que auditar.
 */
export const zoomCredentials = pgTable(
  "zoom_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    clientId: text("client_id").notNull(),
    secretCipher: text("secret_cipher").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretTag: text("secret_tag").notNull(),
    /** `error` SE ESCRIBE cuando el proveedor rechaza la autenticación. */
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("zoom_credentials_org_uq").on(t.organizationId)]
);

/**
 * Credenciales del conector Google (Calendar + Meet), de la app de Google
 * Cloud del propio negocio. DOS secretos cifrados: el client secret y el
 * refresh token pegado una sola vez.
 */
export const googleCredentials = pgTable(
  "google_credentials",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientSecretCipher: text("client_secret_cipher").notNull(),
    clientSecretIv: text("client_secret_iv").notNull(),
    clientSecretTag: text("client_secret_tag").notNull(),
    refreshTokenCipher: text("refresh_token_cipher").notNull(),
    refreshTokenIv: text("refresh_token_iv").notNull(),
    refreshTokenTag: text("refresh_token_tag").notNull(),
    calendarId: text("calendar_id").notNull().default("primary"),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("google_credentials_org_uq").on(t.organizationId)]
);

export const agentTestCase = pgTable(
  "agent_test_case",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentTestRun.id, { onDelete: "cascade" }),
    persona: text("persona").notNull(),
    conversationId: text("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    transcript: jsonb("transcript"),
    veredicto: text("veredicto", { enum: ["verde", "amarillo", "rojo"] }),
    hallazgos: jsonb("hallazgos"),
    status: text("status", {
      enum: ["pending", "running", "done", "judge_failed"],
    })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("test_case_run_idx").on(t.runId)]
);

/* ============================================================
 * 016 — Atribución de anuncios y Conversions API
 * (detrás de la bandera ATRIBUCION)
 * ============================================================ */

/**
 * De qué anuncio vino una conversación. El primer referral gana: el UNIQUE de
 * abajo es lo que vuelve idempotente la captura ante los reintentos de Meta,
 * en vez de un "consulta y luego inserta" que dos webhooks simultáneos
 * ganarían los dos.
 */
export const adAttribution = pgTable(
  "ad_attribution",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    /**
     * El identificador del clic en el anuncio. Es la llave de TODO: sin él no
     * hay nada que reportarle a Meta. Nullable porque hay referrals sin clid.
     */
    ctwaClid: text("ctwa_clid"),
    sourceId: text("source_id"),
    sourceType: text("source_type"),
    sourceUrl: text("source_url"),
    headline: text("headline"),
    body: text("body"),
    mediaType: text("media_type"),
    /**
     * Payload íntegro del referral. Es la póliza contra "Meta agregó un campo":
     * nada se pierde y un fork puede pintar el creativo sin migrar nada.
     */
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ad_attribution_org_conversation_uq").on(
      t.organizationId,
      t.conversationId
    ),
    index("ad_attribution_org_contact_idx").on(t.organizationId, t.contactId),
  ]
);

/**
 * Cada intento de reportarle un desenlace a Meta. Las filas `skipped` no son
 * basura: son la respuesta a "¿por qué este lead no aparece en Meta?", que sin
 * ellas se contesta adivinando.
 */
export const conversionEvent = pgTable(
  "conversion_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    attributionId: text("attribution_id").references(() => adAttribution.id, {
      onDelete: "set null",
    }),
    /** Nombre del catálogo de Meta tal cual (`QualifiedLead`, `Purchase`). */
    eventName: text("event_name").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    /** Motivo legible: por qué se omitió, o qué contestó Meta. */
    error: text("error"),
    /**
     * Acuse del envío. Es la única referencia que Meta pide para rastrear un
     * evento de su lado; sin persistirla, un `sent` no se puede reclamar.
     */
    fbTraceId: text("fb_trace_id"),
    sentAt: timestamp("sent_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // El dedup ES este índice: la fila se inserta ANTES de hablar con Meta y
    // con ON CONFLICT DO NOTHING. Dos movimientos simultáneos del mismo lead
    // no pueden mandar dos compras.
    uniqueIndex("conversion_event_org_conv_name_uq").on(
      t.organizationId,
      t.conversationId,
      t.eventName
    ),
    index("conversion_event_org_created_idx").on(
      t.organizationId,
      t.createdAt
    ),
  ]
);

/** Conexión del negocio con su dataset de Meta (token cifrado en reposo). */
export const capiSettings = pgTable(
  "capi_settings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    datasetId: text("dataset_id").notNull(),
    tokenCipher: text("token_cipher").notNull(),
    tokenIv: text("token_iv").notNull(),
    tokenTag: text("token_tag").notNull(),
    /**
     * Qué etapa significa "lead calificado" PARA ESTE NEGOCIO. Las etapas
     * sembradas de Vocero no incluyen ninguna con ese nombre y cada quien
     * renombra las suyas, así que se elige en vez de adivinarse. NULL = ese
     * evento no se emite. `set null` a propósito: borrar la etapa apaga el
     * evento, no rompe la configuración.
     */
    qualifiedStageId: text("qualified_stage_id").references(
      () => pipelineStage.id,
      { onDelete: "set null" }
    ),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("capi_settings_org_uq").on(t.organizationId)]
);

/* ============================================================
 * 019 — Cotizaciones (detrás de la bandera QUOTES)
 * ============================================================ */

/**
 * La cotización de un trato. `subtotalCents`/`totalCents` son DENORMALIZADOS
 * a propósito: se recalculan en el servidor cada vez que cambia un renglón
 * (`src/server/quotes/service.ts` es la única puerta que escribe aquí), y así
 * la lista no necesita sumar los `quote_item` de cada fila para pintarse.
 *
 * `vencida` NO es un estado que se guarde: es `enviada` con `validUntil` en
 * el pasado. Guardarlo exigiría un cron que hoy no existe en esta app
 * in-process: se deriva al leer (`src/server/quotes/queries.ts`).
 */
export const quote = pgTable(
  "quote",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "cascade" }),
    /** Denormalizado como en `lead_stage_event`: casi toda lectura lo quiere
     *  sin el join extra hasta `lead`. */
    contactId: text("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["borrador", "enviada", "aceptada", "rechazada"],
    })
      .notNull()
      .default("borrador"),
    currency: text("currency").notNull(),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    notes: text("notes"),
    /** Hasta cuándo vale la cotización. NULL = sin vencimiento. */
    validUntil: timestamp("valid_until"),
    sentAt: timestamp("sent_at"),
    /** Cuándo respondió el cliente (aceptada o rechazada). */
    respondedAt: timestamp("responded_at"),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    /**
     * Último intento de avisar al webhook saliente (n8n). Best-effort: un
     * fallo aquí JAMÁS deshace la transición de estado — la cotización ya
     * cambió, y esto es solo para que el operador vea que nadie se enteró del
     * lado de afuera. No es una bitácora completa (un solo renglón, se
     * sobreescribe en cada intento): para eso sería una tabla aparte, y esta
     * feature no la necesita todavía.
     */
    webhookStatus: text("webhook_status", {
      enum: ["pending", "sent", "failed", "skipped"],
    })
      .notNull()
      .default("skipped"),
    webhookError: text("webhook_error"),
    webhookAttemptedAt: timestamp("webhook_attempted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("quote_org_lead_idx").on(t.organizationId, t.leadId),
    index("quote_org_status_idx").on(t.organizationId, t.status),
  ]
);

/** Un renglón de la cotización. `totalCents` = `quantity * unitPriceCents`,
 *  recalculado en el servidor — nunca confiado del cliente. */
export const quoteItem = pgTable(
  "quote_item",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    quoteId: text("quote_id")
      .notNull()
      .references(() => quote.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPriceCents: integer("unit_price_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("quote_item_org_quote_idx").on(
      t.organizationId,
      t.quoteId,
      t.position
    ),
  ]
);

/* ============================================================
 * 020 — Activos de cliente (detrás de la bandera ASSETS)
 * ============================================================ */

/**
 * Infraestructura y credenciales del cliente (dominio, VPS, WordPress,
 * GitHub, Cloudflare…), colgadas del trato. `secretCipher`/`secretIv`/
 * `secretTag` son el MISMO mecanismo AES-256-GCM que el token de WhatsApp
 * (`lib/crypto`, ver `src/server/whatsapp/credentials.ts`) — dos formas de
 * guardar un secreto es una de más que auditar. Los tres viajan juntos: un
 * activo puede no tener secreto (un dominio solo necesita URL), pero si lo
 * tiene, los tres campos existen.
 */
export const clientAsset = pgTable(
  "client_asset",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "cascade" }),
    type: text("type", {
      enum: ["domain", "vps", "wordpress", "github", "cloudflare", "other"],
    }).notNull(),
    name: text("name").notNull(),
    url: text("url"),
    username: text("username"),
    secretCipher: text("secret_cipher"),
    secretIv: text("secret_iv"),
    secretTag: text("secret_tag"),
    /** Vencimiento del activo (dominio, certificado…). NULL = no aplica. */
    expiresAt: timestamp("expires_at"),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("client_asset_org_lead_idx").on(t.organizationId, t.leadId),
    check(
      "client_asset_secret_ck",
      sql`(${t.secretCipher} IS NULL AND ${t.secretIv} IS NULL AND ${t.secretTag} IS NULL) OR (${t.secretCipher} IS NOT NULL AND ${t.secretIv} IS NOT NULL AND ${t.secretTag} IS NOT NULL)`
    ),
  ]
);

/* ============================================================
 * 021 — Proyectos e hitos (detrás de la bandera PROJECTS)
 * ============================================================ */

/**
 * El proyecto de entrega de un trato. Casi siempre nace SOLO —automático,
 * dentro de la misma transacción que acepta una cotización
 * (`src/server/quotes/service.ts`)—, pero `quoteId` es opcional porque un
 * proyecto también puede abrirse a mano sin que haya cotización de por medio.
 */
export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    leadId: text("lead_id")
      .notNull()
      .references(() => lead.id, { onDelete: "cascade" }),
    quoteId: text("quote_id").references(() => quote.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    status: text("status", {
      enum: ["planning", "in_progress", "review", "completed", "paused"],
    })
      .notNull()
      .default("planning"),
    /** En CENTAVOS ENTEROS, igual que `lead.amountCents` — nunca un float. */
    budgetCents: integer("budget_cents"),
    /** Moneda de `budgetCents`; heredada de la cotización que lo creó. NULL
     *  si el proyecto no tiene presupuesto todavía. */
    currency: text("currency"),
    targetDate: timestamp("target_date"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("project_org_lead_idx").on(t.organizationId, t.leadId),
    index("project_org_status_idx").on(t.organizationId, t.status),
  ]
);

/**
 * Un hito del proyecto. `position` (no `order`, palabra reservada de SQL)
 * fija el orden de despliegue, igual que `quote_item.position`.
 */
export const projectMilestone = pgTable(
  "project_milestone",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["pending", "in_progress", "completed"],
    })
      .notNull()
      .default("pending"),
    position: integer("position").notNull().default(0),
    dueDate: timestamp("due_date"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("project_milestone_org_project_idx").on(
      t.organizationId,
      t.projectId,
      t.position
    ),
  ]
);

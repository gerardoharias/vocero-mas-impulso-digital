# Vocero CRM

[![CI](https://github.com/kevinrivm/vocero-crm/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinrivm/vocero-crm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**El CRM de WhatsApp open source con un agente de IA que se pone a prueba solo.**

Vocero es un CRM self-hosted y gratuito para negocios que venden por WhatsApp:
bandeja en tiempo real, pipeline de ventas, un agente de IA con el conocimiento
de tu negocio y un **Laboratorio** donde clientes simulados lo evalúan antes de
que hable con clientes reales. Una instancia = un negocio, en tu propio
servidor, con tus datos.

¿Ya tienes tu propio agente? Puedes apagar el de Vocero y conectar el tuyo por
la [API de servicio `/api/bot/*`](#-trae-tu-propio-agente): el token de WhatsApp
nunca sale del CRM.

![Bandeja de Vocero CRM](docs/screenshots/bandeja.png)

<p align="center">
  <img src="docs/screenshots/laboratorio.png" width="49%" alt="Laboratorio: reporte con score y hallazgos" />
  <img src="docs/screenshots/pipeline.png" width="49%" alt="Pipeline kanban" />
</p>

> 🎬 **Video-instalador oficial**: próximamente en
> [el canal de Kevin Belier](https://www.youtube.com/@KevinBelier)

## ¿Para quién es?

- **Agencias de IA/automatización** que implementan CRM + agente para sus
  clientes: despliegas una instancia por cliente en su VPS, la configuras y la
  entregas con evidencia de calidad (el reporte del Laboratorio).
- **Negocios** que quieren atender WhatsApp con IA sin regalar sus datos a un
  SaaS: todo corre en tu servidor.

## Features

### 🧪 Laboratorio: el agente se prueba solo

La pieza estelar. Seis clientes simulados —el comprador decidido, el preguntón
de precios, el cliente enojado, el que pregunta lo que no sabes, el que exige
un humano y el que escribe "ke onda si benden pintura"— conversan contra tu
agente REAL en un **sandbox interno que jamás envía mensajes reales**. Un juez
LLM independiente evalúa cada conversación y te entrega:

- un **score 0–100** de qué tan listo está el agente,
- **hallazgos con evidencia** (alucinaciones, huecos del conocimiento, fallas
  de escalado, tono),
- **sugerencias aplicables con un click** al knowledge base,
- e **historial con delta**: re-corre después de cada cambio y mira si mejoraste.

Deja de "esperar que el bot funcione": mídelo.

### 💬 Bandeja de WhatsApp en tiempo real

Tres columnas (conversaciones / hilo / contacto), mensajes entrantes en ≤2
segundos sin recargar, estados enviado/entregado/leído, ventana de 24 horas
visible y bloqueada correctamente (con envío de plantilla aprobada cuando está
cerrada), respuestas del agente marcadas como IA y handoff a humano con un
click.

### 📊 Contactos y pipeline kanban

Cada persona que escribe queda registrada sola y entra al pipeline
(Nuevo → En conversación → Interesado → Cliente → Perdido, editable). Arrastra
tarjetas, busca, agrega notas, archiva. El agente puede mover leads de etapa
cuando detecta intención de compra.

### 🤖 Agente de IA con TU conocimiento

Configura nombre, tono, instrucciones y reglas de escalado; dale conocimiento
en pares pregunta/respuesta y bloques libres. Responde SOLO con lo que sabe,
agrupa ráfagas de mensajes en una respuesta, escala a humano cuando el cliente
lo pide (con detección de respaldo), cuando él lo decide o cuando algo falla.
Proveedor LLM por adaptador OpenRouter-compatible: usa el modelo que quieras.

### 🔌 Trae tu propio agente

Si prefieres conducir la conversación con tu propio cerebro —un microservicio
tuyo, en tu mismo servidor— apaga el agente de Vocero y habilita la API de
servicio con una `BOT_API_KEY`. Tu bot conversa a través del CRM, así que **el
token de WhatsApp nunca sale de aquí** y todo queda en la bandeja como
cualquier otra conversación.

| Endpoint | Para qué |
|---|---|
| `GET /api/bot/availability` | Horarios para ofrecer. Además de la lista por defecto (**parcial**: mira `hasMore`), acepta `day`/`from`/`to` para la disponibilidad **completa** de un día o rango. Ver [cambios](docs/bot-availability-contrato.md) |
| `GET /api/bot/context` | Quién es la persona, su etapa, si un humano tomó la conversación y si la ventana de 24 h sigue abierta |
| `POST /api/bot/messages` | Responder. Sale por el mismo camino que el composer y queda marcado como IA. **Un `200` es «el mensaje existe», no «ya llegó»**: `status` puede ser `retrying` (el CRM reintenta solo) o `delivery_unknown` — no lo reenvíes. Ver [contrato v2](docs/bot-messages-contrato.md) |
| `GET /api/bot/profile` | El perfil del agente y el knowledge base que editaste en la app |
| `PUT /api/bot/ficha` | Guardar lo que tu bot descubre del lead (claves libres: cada negocio califica distinto) |
| `POST /api/bot/handoff` | Devolver la conversación a un humano |
| `POST /api/bot/typing` | Marcar leído y mostrar "escribiendo…" |
| `GET /api/bot/media/{id}` | Descargar un adjunto entrante sin tocar Meta |
| `POST /api/bot/reset` | Reiniciar una conversación de pruebas |

Los 409 vienen tipados (`ai_paused`, `window_closed`, `sandbox_violation`) para
que tu bot sepa si callarse, mandar plantilla o rendirse. El guion de pruebas
está en [`tests/e2e/us-bot-api.md`](tests/e2e/us-bot-api.md).

Agente de referencia: [nea-agent](https://github.com/kevinrivm/nea-agent), MIT.

### 📅 Agenda con huecos reales (opcional, apagada por defecto)

Enciéndela con `AGENDA=on` y el CRM sabe cuándo estás libre: defines tu horario
en Ajustes → Agenda y tu agente ofrece huecos concretos, reserva el que el
cliente elige y lo deja registrado junto a su conversación. Dos garantías que
no se negocian: **solo se reserva un horario que se ofreció** (nada de que el
modelo invente un martes a las 10) y **nunca se confirma una cita que no se
creó** — si el hueco se ocupó a media conversación, la respuesta trae
alternativas frescas en vez de una promesa falsa.

Cómo se entrega la reunión lo eliges tú, con un **conector**:

| Conector | Qué hace | Necesita |
|---|---|---|
| **Enlace fijo** (default) | Reparte tu sala de siempre | Nada |
| **Zoom** | Una reunión por cita; mover la mueve, cancelar la borra | Tu app Server-to-Server |
| **Google Calendar + Meet** | Un evento en tu calendario con su enlace de Meet | Tu app de Google Cloud |

¿Usas otra cosa? El contrato son cuatro operaciones y está publicado: escribe
tu conector en tu fork siguiendo
[`docs/agenda-conectores.md`](docs/agenda-conectores.md). Y si tu proveedor se
cae, la cita **se agenda igual** con el enlace pendiente de reintentar: un
tercero caído no te cuesta la conversión.

### 📈 Conversiones de anuncios (opcional, apagada por defecto)

Si anuncias con **Click-to-WhatsApp**, Meta sabe qué conversaciones empezaron
desde un anuncio, pero no cuáles sirvieron: sin nadie que se lo diga, optimiza
hacia el público más barato de hacer escribir, que rara vez es el que compra.

Enciéndela con `ATRIBUCION=on`, pega tu dataset en Ajustes → Anuncios (el token
lo reusa de tu conexión de WhatsApp) y di qué etapa de TU pipeline significa
"lead calificado". A partir de ahí el CRM le reporta a Meta el lead calificado y
la venta cerrada —con su importe— por la **Conversions API**, y una tabla de
actividad te dice qué se envió, con qué acuse y, cuando no salió, por qué.

No se le pide nada al usuario que el CRM ya sepa: la venta cuelga de la etapa
ganada que ya tienes, y todo se dispara desde la misma puerta que mueve leads,
así que reporta igual si arrastras la tarjeta tú, el agente incluido o tu propio
bot. Si Meta se cae, el lead se mueve igual: una conversión jamás vale un
movimiento bloqueado. Los gotchas de Meta que cuesta descubrir solo están en
[`docs/atribucion-capi.md`](docs/atribucion-capi.md).

### 📄 Plantillas · 👥 Multi-usuario · 🔐 Self-hosted

Plantillas con varias variables `{{1}}…{{n}}` y aprobación de Meta
sincronizada; cuentas de equipo creadas por el propietario (el registro público
se cierra tras la primera organización); token de WhatsApp cifrado en reposo
(AES-256-GCM),
webhook autenticado en dos capas y cero dependencias de runtime más allá de
Meta y tu proveedor LLM opcional.

## Requisitos

- Un VPS con Docker (2 GB de RAM bastan) — con o sin [Coolify](https://coolify.io).
- Un dominio apuntando al VPS (Meta exige **https** para webhooks).
- Un número de WhatsApp en la Cloud API de Meta (ver [Conexión](#conexión-del-número-de-whatsapp)).
- Opcional: una API key de [OpenRouter](https://openrouter.ai) (o cualquier
  proveedor compatible) para el agente y el Laboratorio.

## Instalación (~15 minutos)

### 0. Apunta tu dominio

Crea un registro **A** de `crm.tudominio.com` hacia la IP del VPS y espera a
que resuelva.

### Ruta A — Coolify guiado por IA (recomendada)

Abre tu asistente de IA (p. ej. Claude Code con el MCP de Coolify), pásale el
archivo [`INSTALL-IA.md`](INSTALL-IA.md) y responde 3 preguntas (dominio, token
de OpenRouter opcional, ruta). El asistente crea la base de datos y la app,
genera los secretos y verifica el healthcheck.

### Ruta B — docker compose

```bash
git clone https://github.com/kevinrivm/vocero-crm.git vocero && cd vocero
cp .env.example .env    # rellena: dominio + secretos (cada uno trae su comando openssl)
docker compose up -d --build
```

Caddy emite el certificado HTTPS solo. Verifica con
`https://crm.tudominio.com/api/health` → `{"ok":true}`.

### Primer arranque

1. Entra y **regístrate**: el primer registro crea tu organización y cierra el
   registro público.
2. Opcional: pulsa **"Cargar datos de demostración"** para explorar con la
   **Ferretería El Martillo** (contactos, conversaciones, pipeline, un
   knowledge base con huecos a propósito y una corrida de Laboratorio de
   ejemplo — corre el Laboratorio y mira cómo los encuentra).
3. La conexión de WhatsApp se hace después, en **Configuración → WhatsApp**.

## Conexión del número de WhatsApp

Vocero **consume** un token de la WhatsApp Cloud API — no implementa el
Embedded Signup. Hay dos formas de obtenerlo:

### Modo directo (el negocio tiene su propia app de Meta)

1. Crea una app en [developers.facebook.com](https://developers.facebook.com)
   con el producto WhatsApp y vincula tu número.
2. Crea un **usuario del sistema** (Business Settings → System users) con
   acceso a la WABA y genera un token permanente con permisos
   `whatsapp_business_messaging` y `whatsapp_business_management`.
3. En Vocero: **Configuración → WhatsApp** → pega WABA ID + Phone Number ID +
   token → **Probar conexión** → Guardar.
4. En el panel de Meta (WhatsApp → Configuration → Webhook) pega la **URL del
   webhook** y el **verify token** que Vocero te muestra, y suscribe el campo
   `messages` (y `message_template_status_update` si usarás plantillas).
5. Recomendado: agrega `META_APP_SECRET` (App Secret de tu app) a las
   variables de la instancia para la verificación de firma de cada evento.

### Modo agencia (Tech Provider) — para agencias

Tu plataforma de agencia ya hace el Embedded Signup y guarda los tokens de tus
clientes; la instancia de Vocero del cliente solo recibe su token. El webhook
del cliente se conecta con el **override de callback por WABA**:

```text
   Meta (WABA del cliente)
        │  webhooks (override_callback_uri)
        ▼
   ┌────────────────────────────┐      ┌─────────────────────────────┐
   │  Instancia Vocero          │      │  Backend de TU agencia      │
   │  (VPS del cliente)         │      │  (Embedded Signup + tokens) │
   │  /api/webhooks/wa/<token>  │      └──────────────┬──────────────┘
   └────────────▲───────────────┘                     │
                └────── token del cliente ────────────┘
                        (pegado en el wizard)
```

**Checklist de 5 pasos (el orden importa):**

1. **Despliega la instancia primero** (Ruta A o B) — el webhook debe estar en
   línea para el paso 4.
2. **Embedded Signup en TU plataforma**: el cliente conecta su número en tu
   onboarding y tu backend guarda su token (intercambio de código → token).
3. **Pega las credenciales en el wizard** de la instancia (WABA ID, Phone
   Number ID, token) → **Probar conexión** → **GUARDAR**. Este paso va ANTES
   del override: el webhook enruta cada mensaje por el Phone Number ID
   **guardado** — sin conexión guardada, el handshake del paso 4 pasa igual,
   pero los mensajes que lleguen se descartan en silencio.
4. **Configura el override del callback a nivel WABA** hacia la instancia:

   ```http
   POST https://graph.facebook.com/v25.0/{WABA_ID_DEL_CLIENTE}/subscribed_apps
   Authorization: Bearer {TOKEN_DEL_CLIENTE}
   Content-Type: application/json

   {
     "override_callback_uri": "https://crm.cliente.com/api/webhooks/wa/{VERIFY_TOKEN}",
     "verify_token": "{VERIFY_TOKEN}"
   }
   ```

   La URL y el verify token exactos están en **Configuración → WhatsApp** de la
   instancia. Meta hace el handshake en ese momento (la URI debe responder, si
   no devuelve 422).
5. **Registra el número** en la Cloud API si aún no lo está
   (`POST /{PHONE_NUMBER_ID}/register`) y manda un mensaje de prueba al número:
   debe aparecer en la bandeja en uno o dos segundos. Los mensajes del cliente
   llegan directo a SU instancia, no a tu backend.

> ⚠️ **Seguridad**: la URL del webhook contiene el verify token como segmento
> secreto — trátala como una contraseña (no la publiques ni la mandes por
> canales inseguros). En modo directo puedes añadir la capa extra de firma con
> `META_APP_SECRET`.
>
> ℹ️ **Limitación conocida de Meta**: los eventos de estado de PLANTILLAS
> (`message_template_status_update`) no siguen el override de callback — van a
> la app dueña. Por eso Vocero también **sincroniza plantillas por la API de
> Graph** (botón "Sincronizar" en Configuración → Plantillas), así el modo
> agencia ve las aprobaciones igual.

## Canales opcionales: Instagram y Messenger

WhatsApp es el canal por el que existe Vocero y siempre está encendido. Los
demás viajan en el mismo código, **apagados por defecto** ([ADR-001](docs/adr-001-canales-opcionales.md)):
una instancia que no los usa no ve pantallas, webhooks ni variables suyas.
Se encienden con una variable de despliegue:

```bash
CHANNELS=whatsapp,instagram,messenger   # los que quieras; whatsapp siempre va
```

Con más de un canal encendido, la Bandeja enseña el distintivo de cada
conversación y permite filtrar por canal. El contacto, el pipeline, la ficha
y el agente son los mismos: un lead es un lead, escriba por donde escriba.

### Messenger (página de Facebook)

Dos formas de traer los mensajes; se elige en **Configuración → Messenger**.

**Con Zernio** (API unificada, la misma que puede servir Instagram):

1. Vincula la página de Facebook en el panel de [Zernio](https://zernio.com) y
   copia el `accountId` de esa cuenta. Crea una API key (Settings → API Keys;
   se muestra una sola vez).
2. En Vocero, **Configuración → Messenger**: elige *Zernio*, pega el
   `accountId`, la API key y —recomendado— un secreto de webhook. Pulsa
   *Probar y guardar*: la llave se valida contra Zernio antes de guardarse
   cifrada, y la pantalla te enseña la URL de callback.
3. En Zernio, da de alta ese endpoint con el evento `message.received` y el
   mismo secreto. El webhook de Zernio entrega todas tus plataformas por la
   misma URL; Vocero solo ingiere aquí lo de Facebook.

**Con una app propia de Meta**:

1. En [developers.facebook.com](https://developers.facebook.com) crea (o usa)
   una app con el producto **Messenger** y genera el **token de acceso de la
   página** con el permiso `pages_messaging`. Anota el **ID de la página**.
2. En Vocero, **Configuración → Messenger**: elige *App propia de Meta*, pega
   el ID y el token y pulsa *Probar y guardar*.
3. En la app de Meta, **Messenger → Webhooks**: objeto `page`, campo
   `messages`, esa URL de callback y el token de verificación que enseña la
   pantalla. Suscribe la página a la app.

Desde ese momento, lo que la gente le escribe a la página entra a la bandeja
como `Messenger`, con el nombre de su perfil, y lo que respondas desde Vocero
(tú o el agente) llega a su chat. Fuera de la ventana de 24 h la respuesta sale
con la etiqueta `HUMAN_AGENT` de Meta (hasta 7 días); no hay plantillas.
Hoy el canal es de texto: los adjuntos que te manden se ven como
«📎 Imagen» para que sepas que llegaron, y los adjuntos salientes no están.

Con app propia y sin App Review, la página solo recibe mensajes de cuentas con
un rol en la app; para atender al público hay que aprobar `pages_messaging`.
Por Zernio ese trámite ya está resuelto del lado de ellos.

### Instagram (DMs del perfil profesional)

Mismo modelo, con dos fuentes posibles: una app propia de Meta (perfil del
negocio como tester) o [Zernio](https://zernio.com) como API unificada. La
conexión se guarda por la API de ajustes (`PUT /api/settings/instagram`) y el
webhook vive en `/api/webhooks/ig/<token>`. El detalle está en
[`specs/014-canal-instagram`](specs/014-canal-instagram/spec.md).

## Configuración de la IA

En las variables de la instancia:

```bash
OPENROUTER_API_TOKEN=sk-or-...        # tu key
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
OPENROUTER_JUDGE_MODEL=               # opcional: modelo distinto para el juez del Laboratorio
OPENROUTER_BASE_URL=https://openrouter.ai/api   # o tu proveedor OpenAI-compatible
```

Sin token, todo lo demás funciona; Agente y Laboratorio muestran cómo
activarlos. Después configura el comportamiento y el conocimiento en la
pestaña **Agente** y corre el **Laboratorio** antes de encender el agente con
clientes reales.

## Cumplimiento con las políticas de Meta

1. **Opt-in**: escribe solo a personas que iniciaron la conversación o
   aceptaron recibir mensajes; Vocero respeta la ventana de 24 h y bloquea el
   texto libre fuera de ella.
2. **Plantillas aprobadas** para reabrir conversaciones: nada de trucos para
   saltarse la aprobación de Meta.
3. **El Laboratorio es 100 % interno**: los clientes simulados jamás tocan la
   API de WhatsApp (bloqueado por diseño y verificado con tests).
4. **Sin spam ni broadcast**: Vocero no incluye envíos masivos; úsalo para
   conversaciones reales de venta y soporte.
5. **Datos del cliente en su servidor**: cada negocio aloja su instancia; el
   token va cifrado en reposo y los webhooks se validan por URL secreta y
   firma opcional.

## FAQ de errores comunes

**El webhook no se verifica en Meta** — El dominio aún no resuelve, no es
https, o pegaste mal la URL/verify token. Cópialos exactos de Configuración →
WhatsApp.

**El webhook verificó bien pero no llegan mensajes** — Casi siempre: la
conexión no está GUARDADA en el wizard (el handshake no la necesita, la
ingesta sí — enruta por el Phone Number ID guardado). Entra a Configuración →
WhatsApp, guarda la conexión y reenvía un mensaje. Los logs de la instancia
muestran una advertencia con el Phone Number ID desconocido.

**Llegan mensajes pero no salen** — Revisa el estado de la conexión en
Configuración → WhatsApp. Si dice "reconectar", el token expiró: pega uno
nuevo. En modo directo usa un token de usuario del sistema (no expira).

**Error 131030 al enviar** — El número destino no está en la lista de
permitidos (números de prueba de Meta) o el formato es inválido. Vocero ya
normaliza los números de México (521 → 52).

**El agente no responde** — ¿Token de IA configurado? ¿Toggle global
encendido? ¿La conversación tiene la IA activa y sin handoff? ¿Ventana de 24 h
abierta? Revisa también los logs de la instancia.

**`ENCRYPTION_KEY` inválida al arrancar** — Debe ser exactamente 32 bytes en
base64 (44 caracteres): `openssl rand -base64 32`.

**La app arranca pero /api/health falla** — La base de datos no está lista o
`DATABASE_URL` apunta mal; revisa los logs (`docker compose logs app`).

**Olvidé mi contraseña y no puedo entrar** — Vocero no manda correos (sería una
dependencia externa) y el registro público se cierra con la primera
organización, así que no hay flujo de "olvidé mi contraseña". La salida es
reescribir el hash en la base:

```bash
NEW_PASSWORD='tu-contraseña-nueva' node scripts/reset-password.mjs tu@correo.com
```

El script **no toca la base**: te imprime el `UPDATE` para que lo pegues tú en
la consola de Postgres. Corre desde tu máquina, con el repo clonado y
`pnpm install` hecho — la contraseña nueva nunca sale de ahí. Va por variable de
entorno y no por argumento porque un argumento queda en el historial del shell
y se ve en `ps`.

Debe responder `UPDATE 1`. Si responde `UPDATE 0`, el correo no coincide;
míralos con `SELECT email FROM "user";`.

## Versiones

La versión que está corriendo se ve **abajo en la barra lateral** (`v1.1.0 ·
8e62d0b`) y en el healthcheck, para poder confirmar un despliegue con un
`curl` sin abrir la app:

```bash
curl -s https://crm.tudominio.com/api/health
# {"ok":true,"version":"1.1.0","commit":"8e62d0b"}
```

Los dos valores se congelan al **construir**, así que no pueden mentir en
tiempo de ejecución. El commit lo inyecta Coolify solo; con docker compose se
pasa con `--build-arg SOURCE_COMMIT=$(git rev-parse HEAD)`, y si falta se ve
solo la versión.

SemVer sobre lo que le importa a quien opera una instancia:

| | Cuándo sube |
|---|---|
| **Mayor** (`2.0.0`) | Hay que hacer algo a mano para actualizar: cambiar una variable de entorno, migrar datos, reconectar algo. |
| **Menor** (`1.2.0`) | Funciones nuevas. Actualizar es redesplegar. |
| **Parche** (`1.1.1`) | Arreglos y ajustes. Actualizar es redesplegar. |

La versión vive en `package.json` y se sube en el PR que publica el cambio.

## Roadmap

- Multimedia completa en la bandeja (hoy: indicador de tipo).
- RAG para knowledge bases grandes (hoy: se inyecta completo con aviso de tamaño).
- Personas configurables del Laboratorio y comparativas entre corridas.
- Borrado de plantillas desde la app.
- Analytics de conversación y plantillas.
- Broadcast con opt-in verificado.

### Antes fuera de alcance, ahora detrás de una bandera

**El motor de agendamiento ya está en el core**, apagado por defecto. Aquí
decía que quedaba fuera a propósito, con dos razones. Las dos eran buenas y
las dos cambiaron; se dejan escritas porque el porqué importa más que la
conclusión:

- *"Son mil líneas y una dependencia de fechas en un proyecto cuyo argumento es
  ser ligero."* — Cierto, y por eso vive detrás de `AGENDA`: una instancia que
  no agenda no ve pantallas, ni rutas, ni una instrucción de agendar en el
  prompt de su agente, ni se le pide una sola credencial. El peso lo paga quien
  la enciende. Lo de la dependencia de fechas ya no aplica: el motor no agregó
  ninguna (la aritmética de zonas usa `Intl` de la plataforma).
- *"El estado de qué huecos se ofrecieron pertenece a la conversación, o sea al
  agente, no al CRM."* — Pertenecía al agente mientras el CRM no ofreciera la
  garantía. Al ofrecerla, es el CRM quien tiene que poder probarla: con la
  memoria del lado del cliente, cualquier cerebro conectado por `/api/bot/*`
  podría reservar un horario que jamás se ofreció y el CRM lo aceptaría. Ahora
  la regla es inviolable por construcción y vale igual para el agente incluido,
  para tu bot y para el que venga.

Lo que sigue fuera, y a propósito: **leer calendarios externos** para descontar
disponibilidad. El motor calcula con lo suyo y los compromisos de fuera se
reflejan con bloqueos manuales; meter al proveedor en ese camino acoplaría su
latencia y sus caídas a la pantalla que más se usa.

## Stack

Next.js 15 (App Router) + React 19 · TypeScript estricto · PostgreSQL +
Drizzle ORM · Better Auth · Tailwind CSS · SSE (sin WebSockets) · Docker
multi-stage con migraciones al arranque. Diseñado para que una agencia lo
modifique con un asistente de IA: specs y decisiones de diseño en
[`specs/`](specs/), guía de modificación en [`CLAUDE.md`](CLAUDE.md).

## Licencia

[MIT](LICENSE) — úsalo, véndelo instalado, modifícalo. Si te sirve, una ⭐ al
repo ayuda a que más gente lo encuentre.

## Créditos

Creado por [Kevin Belier](https://www.youtube.com/@KevinBelier). ¿Quieres
aprender a convertirte en Meta Tech Provider y monetizar con tu agencia de IA?
Únete a la [VIBE Community](https://www.skool.com/vibe-community-vip). Los patrones
de producción (webhook firmado, ingesta idempotente, cifrado de tokens) vienen
de un proyecto de referencia privado en producción, portados y simplificados
para este repo.

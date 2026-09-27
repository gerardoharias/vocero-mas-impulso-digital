# `POST /api/bot/messages` — contrato v2 (spec 024)

> **Si tu cerebro externo llama a este endpoint, lee esto antes de actualizar.**
> Cambia qué significa un `200`.

## Qué cambió

| | v1 (hasta la 023) | **v2 (024)** |
|---|---|---|
| Meta rechaza de forma **temporal** (5xx, límite de frecuencia) | `502` / `503` | **`200` `{ "status": "retrying" }`** |
| Resultado **ambiguo** (timeout, 5xx sin cuerpo de Meta) | `502` / `503` | **`200` `{ "status": "delivery_unknown" }`** |
| Meta rechaza de forma **definitiva** (p. ej. `131026`) | `502` | `502` (sin cambio) |
| Ventana de 24 h cerrada · IA en pausa · sandbox | `409` | `409` (sin cambio) |
| Meta aceptó | `200` `{ messageId }` | `200` `{ messageId, status: "pending" }` |

Toda respuesta `200` trae ahora `"contract": 2` y el header `X-Vocero-Send-Contract: 2`.
Si tu código no ve ese header, está hablando con una instancia anterior a la 024.

## La advertencia

**Un `200` significa «el mensaje existe y el CRM se encarga», no «ya llegó».**

Antes, un fallo temporal te devolvía un error y era natural que tu bot lo
reintentara. **Ya no lo hagas**: el CRM guarda el texto, lo reintenta él mismo
(hasta 3 intentos, con espera creciente) y siempre manda **exactamente el mismo
texto**. Si además lo reenvías tú, el prospecto recibe el mensaje dos veces.

## Qué hacer con cada `status`

| `status` | Significa | Tu bot |
|---|---|---|
| `pending` · `sent` | Meta lo aceptó | Seguir. |
| `retrying` | Falló algo pasajero; el CRM lo reenvía **solo**, en segundos | **No reenviar.** Seguir; si tu lógica necesita la entrega confirmada, consulta la conversación más tarde. |
| `delivery_unknown` | No se sabe si Meta lo recibió. El CRM **no** lo reenvía solo (podría duplicarse) | **No reenviar.** Avisa a una persona: aparece en la bandeja como «Sin confirmar» con un botón **Reenviar**. |
| *(error 502, `code: "meta_error"`)* | Rechazo definitivo (número inexistente, política, calidad…) | No reintentes igual. Replantea (otra plantilla, otro canal) o deriva a una persona. El texto queda guardado para reenviar a mano. |
| *(error 409 `window_closed`)* | Pasaron más de 24 h del último mensaje del cliente | Sólo una plantilla aprobada reabre la conversación. |
| *(error 409 `ai_paused`)* | Una persona tomó la conversación | Calla. |

## Ejemplo de manejo correcto

```js
// Devuelve qué debe hacer TU bot. Nunca reenvía por su cuenta un 200.
async function sendViaVocero(conversationId, text) {
  const res = await fetch(`${VOCERO_URL}/api/bot/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.VOCERO_BOT_KEY },
    body: JSON.stringify({ conversationId, text }),
  });
  const body = await res.json();

  if (res.ok) {
    switch (body.status) {
      case "retrying":          // el CRM reintenta solo
        return { action: "wait" };
      case "delivery_unknown":  // no se sabe: lo resuelve una persona
        return { action: "ask_human", messageId: body.messageId };
      default:                  // "pending" | "sent"
        return { action: "done", messageId: body.messageId };
    }
  }
  if (res.status === 409 && body.error?.code === "ai_paused") return { action: "pause" };
  return { action: "stop", reason: body.error?.code }; // rechazo definitivo: no reintentar igual
}
```

Este mismo manejador está probado contra el endpoint real en
`tests/integration/bot-send-contract.test.ts`, así que esta guía no puede
desactualizarse sin que una prueba se ponga roja.

## Garantías (probadas)

- Un fallo recuperable **no** dispara al agente integrado, aunque esté encendido: cero
  llamadas de IA, cero ejecuciones del pipeline, cero mensajes adicionales.
- Todos los intentos mandan el mismo cuerpo, byte a byte, y hay **una sola** burbuja.
- Un `delivery_unknown` nunca se reenvía sin una acción humana explícita.

## Compatibilidad

- El cambio es **aditivo** en la forma (`status` y `contract` son campos nuevos) pero
  **cambia el significado** de las respuestas que antes eran `502`/`503`.
- Un cliente que trate «cualquier `2xx`» como éxito y no reintente sigue funcionando.
- Un cliente que reintentaba ante `5xx` **deja de recibir esos `5xx`** por fallos
  temporales; no hay nada que reintentar.
- Para comprobar la versión: `X-Vocero-Send-Contract` (ausente = contrato v1).

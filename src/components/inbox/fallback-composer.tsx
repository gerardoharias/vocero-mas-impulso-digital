"use client";

import { useRef, useState } from "react";
import { Clock3, Send } from "lucide-react";
import type { TemplateDto } from "@/lib/types";
import {
  MAX_TEMPLATE_BODY_CHARS,
  renderBody,
  sanitizeTemplateParam,
} from "@/lib/templates";
import { cn } from "@/lib/utils";
import { TemplateSender } from "./template-sender";

/**
 * Composer con la ventana de 24 h cerrada y una plantilla genérica aprobada:
 * el operador escribe como siempre y lo escrito viaja como `{{1}}` de esa
 * plantilla. El texto libre fuera de ventana sigue prohibido en el núcleo
 * (`send.ts`); esto es un envío de plantilla explícito, con vista previa de
 * lo que realmente recibirá el contacto.
 */
export function FallbackComposer({
  conversationId,
  template,
  onSent,
}: {
  conversationId: string;
  template: TemplateDto;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherTemplate, setOtherTemplate] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Lo que Meta recibirá de verdad: un parámetro no admite saltos de línea,
  // así que lo escrito en varios renglones se aplana antes de enviarlo.
  const param = sanitizeTemplateParam(text);
  const preview = renderBody(template.body, [param]);
  const remaining = MAX_TEMPLATE_BODY_CHARS - preview.length;
  const canSubmit = param.length > 0 && remaining >= 0 && !sending;

  function autogrow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  async function submit() {
    if (!canSubmit) return;
    setSending(true);
    setError(null);
    const res = await fetch(
      `/api/conversations/${conversationId}/messages/template`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: template.id, variables: [param] }),
      }
    ).catch(() => null);
    setSending(false);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(
        res
          ? (data?.error?.message ?? "No se pudo enviar el mensaje")
          : "Sin conexión con el servidor"
      );
      taRef.current?.focus();
      return;
    }
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    onSent();
  }

  return (
    <div className="border-t bg-background px-[18px] pb-3.5 pt-3">
      <div className="mb-2.5 flex items-start gap-2 rounded-md border border-warning-soft bg-warning-tint px-3 py-2 text-xs text-warning-text">
        <Clock3 className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
        <p>
          <span className="font-medium">Ventana de 24 h cerrada.</span>{" "}
          Tu mensaje se enviará dentro de la plantilla{" "}
          <span className="font-mono">{template.name}</span>. Solo texto: sin
          adjuntos, ubicación ni contactos hasta que el cliente responda.
        </p>
      </div>

      {otherTemplate ? (
        <div className="space-y-2">
          <TemplateSender conversationId={conversationId} onSent={onSent} />
          <button
            onClick={() => setOtherTemplate(false)}
            className="text-xs text-primary hover:underline"
          >
            Volver a escribir con la plantilla genérica
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-end gap-2 rounded-[23px] border border-border-strong bg-background py-1.5 pl-4 pr-1.5 shadow-sm transition-[border-color,box-shadow] focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand-soft">
            <textarea
              ref={taRef}
              aria-label="Mensaje dentro de la plantilla genérica"
              placeholder="Escribe tu mensaje…"
              value={text}
              rows={1}
              readOnly={sending}
              onChange={(e) => {
                setText(e.target.value);
                autogrow();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="max-h-[120px] w-full resize-none self-center bg-transparent py-1 text-sm leading-relaxed outline-none placeholder:text-text-3"
            />
            <button
              onClick={() => void submit()}
              disabled={!canSubmit}
              aria-label="Enviar con la plantilla genérica"
              className={cn(
                "flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg transition-[opacity,background-color] hover:bg-brand-hover",
                !canSubmit && "opacity-40"
              )}
            >
              <Send className="h-4 w-4" strokeWidth={1.7} />
            </button>
          </div>

          {param && (
            <div className="mt-2 rounded-md border bg-subtle p-2.5">
              <p className="kicker mb-1">Así lo recibirá</p>
              <p className="whitespace-pre-line text-xs text-text-2">
                {preview}
              </p>
              {param !== text.trim() && (
                <p className="mt-1.5 text-[11px] text-text-3">
                  WhatsApp no admite saltos de línea dentro de la variable: tu
                  texto se envía en un solo renglón.
                </p>
              )}
            </div>
          )}

          <div className="mt-1.5 flex items-center justify-between gap-3">
            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : (
              <button
                onClick={() => setOtherTemplate(true)}
                className="text-xs text-primary hover:underline"
              >
                Usar otra plantilla
              </button>
            )}
            <p
              className={cn(
                "shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-text-3",
                remaining < 0 && "text-destructive"
              )}
            >
              {sending
                ? "Enviando…"
                : remaining < 0
                  ? `Sobran ${-remaining} caracteres`
                  : `Quedan ${remaining} caracteres`}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { TemplateDto } from "@/lib/types";
import {
  canBeWindowFallback,
  countVariables,
  validateBodyVariables,
} from "@/lib/templates";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const STATUS_BADGE: Record<
  TemplateDto["status"],
  { label: string; variant: "secondary" | "warning" | "success" | "destructive" }
> = {
  draft: { label: "Borrador", variant: "secondary" },
  pending: { label: "Pendiente de Meta", variant: "warning" },
  approved: { label: "Aprobada", variant: "success" },
  rejected: { label: "Rechazada", variant: "destructive" },
};

export function TemplatesClient() {
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [fallbackBusy, setFallbackBusy] = useState<string | null>(null);
  const [fallbackError, setFallbackError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const res = await fetch("/api/templates").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { templates: TemplateDto[] };
    setTemplates(data.templates);
  }, []);

  /**
   * `silent`: sincronización automática al abrir la pantalla. Meta entrega
   * `message_template_status_update` al callback A NIVEL APP, que en modo
   * agencia no es el de esta instancia — sin este pull la plantilla se queda
   * "Pendiente de Meta" para siempre aunque ya esté aprobada.
   */
  const sync = useCallback(
    async ({ silent = false } = {}) => {
      if (!silent) {
        setSyncing(true);
        setSyncMsg(null);
      }
      const res = await fetch("/api/templates/sync", { method: "POST" }).catch(
        () => null
      );
      if (!silent) setSyncing(false);
      if (res?.ok) {
        const data = (await res.json()) as { updated: number };
        if (!silent) {
          setSyncMsg(
            data.updated > 0
              ? `${data.updated} plantilla(s) actualizada(s)`
              : "Todo al día"
          );
        }
        if (!silent || data.updated > 0) void refetch();
      } else if (!silent) {
        // El auto-sync falla en silencio: la lista local ya se pintó.
        const data = (await res?.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setSyncMsg(data?.error?.message ?? "No se pudo sincronizar");
      }
    },
    [refetch]
  );

  useEffect(() => {
    void refetch().then(() => sync({ silent: true }));
  }, [refetch, sync]);

  async function toggleFallback(t: TemplateDto, enabled: boolean) {
    setFallbackBusy(t.id);
    setFallbackError(null);
    const res = await fetch(`/api/templates/${t.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isWindowFallback: enabled }),
    }).catch(() => null);
    setFallbackBusy(null);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setFallbackError(data?.error?.message ?? "No se pudo cambiar la plantilla genérica");
      return;
    }
    void refetch();
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Las plantillas permiten reabrir conversaciones con la ventana de 24 h
          cerrada. Meta las aprueba en horas o días y puede reclasificar la
          categoría (lo que cambia el costo por conversación). Esta pantalla
          consulta el estado a Meta cada vez que la abres; Sincronizar fuerza
          la consulta sin recargar.
        </p>
        <Button variant="outline" size="sm" disabled={syncing} onClick={() => void sync()}>
          <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
          Sincronizar
        </Button>
      </div>
      {syncMsg && <p className="text-xs text-muted-foreground">{syncMsg}</p>}

      <CreateForm onCreated={() => void refetch()} />

      <div className="space-y-2">
        {fallbackError && (
          <p className="text-xs text-destructive">{fallbackError}</p>
        )}
        {templates.map((t) => (
          <div key={t.id} className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-sm font-medium">
                {t.name}{" "}
                <span className="text-muted-foreground">
                  ({t.language} · {t.category})
                </span>
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                {t.isWindowFallback && (
                  <Badge variant="default">Genérica</Badge>
                )}
                <Badge variant={STATUS_BADGE[t.status].variant}>
                  {STATUS_BADGE[t.status].label}
                </Badge>
              </div>
            </div>
            <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">
              {t.body}
            </p>
            {t.status === "rejected" && t.rejectionReason && (
              <p className="mt-2 text-xs text-destructive">
                Razón del rechazo: {t.rejectionReason}
              </p>
            )}
            {canBeWindowFallback(t.body) && (
              <div className="mt-3 space-y-1">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={t.isWindowFallback}
                    disabled={fallbackBusy !== null}
                    onChange={(e) => void toggleFallback(t, e.target.checked)}
                    className="accent-primary"
                  />
                  Usar para mensajes fuera de 24 h: lo que escribas en el chat
                  con la ventana cerrada se envía como {"{{1}}"} de esta
                  plantilla.
                </label>
                {t.isWindowFallback && t.status !== "approved" && (
                  <p className="text-xs text-warning-text">
                    Se usará en cuanto Meta la apruebe.
                  </p>
                )}
                {t.isWindowFallback && t.category === "MARKETING" && (
                  <p className="text-xs text-warning-text">
                    Meta la clasificó como MARKETING: cada conversación que
                    reabra se cobra a tarifa de marketing.
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
        {templates.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Sin plantillas todavía. Crea la primera arriba — por ejemplo un
            «seguimos disponibles, ¿retomamos tu cotización?» para
            conversaciones frías.
          </p>
        )}
      </div>
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("es_MX");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Misma validación que el servidor: avisa antes de gastar una llamada a Meta.
  const bodyError = body.trim() ? validateBodyVariables(body) : null;
  const variableCount = countVariables(body);

  async function create() {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, language, category, body }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo crear la plantilla");
      return;
    }
    setName("");
    setBody("");
    onCreated();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Nueva plantilla</CardTitle>
        <CardDescription>
          Cuerpo con las variables que necesites: numéralas{" "}
          <code>{"{{1}}"}</code>, <code>{"{{2}}"}</code>, <code>{"{{3}}"}</code>
          … en orden y sin saltos. Se envía a aprobación de Meta al crearla.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">Nombre</Label>
            <Input
              id="tpl-name"
              placeholder="seguimiento_cotizacion"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-lang">Idioma</Label>
            <select
              id="tpl-lang"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
            >
              <option value="es_MX">es_MX</option>
              <option value="es">es</option>
              <option value="es_AR">es_AR</option>
              <option value="en_US">en_US</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-cat">Categoría</Label>
            <select
              id="tpl-cat"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as "UTILITY" | "MARKETING")
              }
              className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
            >
              <option value="UTILITY">UTILITY (seguimiento)</option>
              <option value="MARKETING">MARKETING</option>
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-body">Cuerpo</Label>
          <Textarea
            id="tpl-body"
            rows={3}
            placeholder="Hola {{1}}, te confirmo tu sesión el {{2}} a las {{3}}."
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {bodyError ? (
            <p className="text-xs text-destructive">{bodyError}</p>
          ) : (
            variableCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {variableCount === 1
                  ? "1 variable: al enviar pedirá su valor. Puedes marcarla como genérica para escribir libremente en chats con la ventana cerrada."
                  : `${variableCount} variables: al enviar pedirá los ${variableCount} valores.`}
              </p>
            )
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          disabled={saving || !name.trim() || !body.trim() || bodyError !== null}
          onClick={() => void create()}
        >
          {saving ? "Enviando a Meta…" : "Crear y enviar a aprobación"}
        </Button>
      </CardContent>
    </Card>
  );
}

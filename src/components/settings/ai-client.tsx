"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 022 — Token + modelo del proveedor LLM (OpenRouter-compatible), cifrados
 * por organización. Sin conexión guardada aquí, el agente sigue usando las
 * variables de entorno del servidor — esta pantalla es una anulación
 * opcional, no un requisito para que la IA funcione.
 */

type Connection = {
  status: "connected" | "error";
  tokenLast4: string;
  model: string;
  judgeModel: string | null;
  transcribeModel: string | null;
};

export function AiClient() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [token, setToken] = useState("");
  const [model, setModel] = useState("");
  const [judgeModel, setJudgeModel] = useState("");
  const [transcribeModel, setTranscribeModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/settings/ai").catch(() => null);
      if (res?.ok) {
        const data = (await res.json()) as { connection: Connection | null };
        setConnection(data.connection);
        if (data.connection) {
          setModel(data.connection.model);
          setJudgeModel(data.connection.judgeModel ?? "");
          setTranscribeModel(data.connection.transcribeModel ?? "");
        }
      }
      setLoaded(true);
    })();
  }, []);

  async function submit(mode: "test" | "save") {
    setBusy(true);
    setMessage(null);
    const body = {
      token,
      model,
      judgeModel: judgeModel.trim() || undefined,
      transcribeModel: transcribeModel.trim() || undefined,
    };
    const res = await fetch(mode === "test" ? "/api/settings/ai/test" : "/api/settings/ai", {
      method: mode === "test" ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);

    if (!res?.ok) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setMessage({
        kind: "error",
        text: data?.error?.message ?? "No se pudo validar el token. Revísalo.",
      });
      return;
    }
    if (mode === "test") {
      setMessage({ kind: "ok", text: "Conexión correcta" });
      return;
    }
    const data = (await res.json()) as { connection: Connection };
    setConnection(data.connection);
    setToken("");
    setMessage({ kind: "ok", text: "Configuración de IA guardada" });
  }

  async function disconnect() {
    setBusy(true);
    await fetch("/api/settings/ai", { method: "DELETE" }).catch(() => null);
    setBusy(false);
    setConnection(null);
    setToken("");
    setModel("");
    setJudgeModel("");
    setMessage(null);
  }

  if (!loaded) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Proveedor de IA (OpenRouter)</CardTitle>
        <CardDescription>
          Token y modelo que usa el agente para responder. Si no configuras
          nada aquí, la instancia sigue usando las variables de entorno del
          servidor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connection?.status === "error" && (
          <p className="rounded-sm border border-danger-soft bg-danger-tint px-3 py-2 text-sm text-danger-text">
            El proveedor rechazó el último token. El agente dejó de responder
            hasta que vuelvas a conectarlo.
          </p>
        )}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ai-token">Token de OpenRouter</Label>
            <Input
              id="ai-token"
              type="password"
              value={token}
              placeholder={
                connection ? `•••• ${connection.tokenLast4}` : "sk-or-..."
              }
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-model">Modelo</Label>
            <Input
              id="ai-model"
              value={model}
              placeholder="anthropic/claude-sonnet-4.5"
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-judge-model">Modelo del juez (opcional)</Label>
            <Input
              id="ai-judge-model"
              value={judgeModel}
              placeholder="Si lo dejas vacío, usa el modelo de arriba"
              onChange={(e) => setJudgeModel(e.target.value)}
            />
            <p className="text-xs text-text-3">
              Solo lo usa el Laboratorio al calificar las conversaciones de
              prueba.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ai-transcribe-model">
              Modelo para notas de voz (opcional)
            </Label>
            <Input
              id="ai-transcribe-model"
              value={transcribeModel}
              placeholder="Si lo dejas vacío, usa el modelo de arriba"
              onChange={(e) => setTranscribeModel(e.target.value)}
            />
            <p className="text-xs text-text-3">
              Transcribe los audios que manda el cliente. El modelo de arriba
              casi nunca acepta audio: si no pones uno que sí (por ejemplo{" "}
              <code className="rounded bg-secondary px-1">
                google/gemini-2.5-flash-lite
              </code>
              ), el agente tendrá que pedirle al cliente que escriba su mensaje.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            onClick={() => submit("test")}
            disabled={busy || !model || (!token && !connection)}
          >
            Probar
          </Button>
          <Button onClick={() => submit("save")} disabled={busy || !token || !model}>
            {connection ? "Actualizar" : "Conectar"}
          </Button>
          {connection && (
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="text-sm text-text-3 hover:text-foreground"
            >
              Quitar (volver a las variables de entorno)
            </button>
          )}
          {message && (
            <span
              className={
                message.kind === "ok"
                  ? "text-sm text-brand-text"
                  : "text-sm text-destructive"
              }
            >
              {message.text}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

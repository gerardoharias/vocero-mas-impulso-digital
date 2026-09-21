import { notFound } from "next/navigation";
import { appBaseUrl } from "@/lib/env";
import { googleCalendarUrl, outlookCalendarUrl } from "@/lib/calendar-links";
import { partsInTz, timezoneLabel } from "@/lib/time/slots";
import { DEFAULT_BRANDING } from "@/lib/branding";
import { getBranding } from "@/server/branding";
import { agendaEnabled } from "@/server/agenda/flag";
import { bookingCopy, getPublicBooking } from "@/server/agenda/public-view";
import { BrandLogo } from "@/components/brand-mark";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * 015 — Página pública de confirmación de UNA cita: lo que el prospecto abre
 * desde el enlace que le manda Max en vez del .ics a secas.
 *
 * Sin sesión, misma "credencial" que el .ics (`public-view.ts`): el id de la
 * cita. Se lee SIEMPRE en vivo (`force-dynamic`, sin caché) y usa el MISMO
 * título/descripción que el .ics (`bookingCopy`) — si la cita cambia de hora
 * o se cancela, no hay una copia vieja en ningún lado que pueda contradecirla.
 *
 * Los botones de Google/Outlook abren un evento YA LLENO, pero ninguno de los
 * dos agenda solo: el proveedor exige que la persona pulse Guardar en su
 * propia pantalla — este texto lo dice explícito para no prometer de más.
 */
export default async function BookingConfirmationPage(ctx: Params) {
  if (!agendaEnabled()) notFound();
  const { id } = await ctx.params;

  const booking = await getPublicBooking(id);
  if (!booking) notFound();

  const branding = await getBranding().catch(() => DEFAULT_BRANDING);
  const { title, description } = bookingCopy(booking);

  const startIso = booking.scheduledAt.toISOString();
  const endIso = new Date(
    booking.scheduledAt.getTime() + booking.durationMinutes * 60_000
  ).toISOString();
  // Esta página la abre el prospecto: mismo reloj que el mensaje de WhatsApp
  // que le mandó el enlace.
  const start = partsInTz(startIso, booking.timezone, { hour12: true });
  const end = partsInTz(endIso, booking.timezone, { hour12: true });
  const tzLabel = timezoneLabel(booking.timezone, booking.scheduledAt);

  const activa = booking.status === "agendada";
  const cancelada = booking.status === "cancelada";
  const icsUrl = `${appBaseUrl()}/api/agenda/bookings/${booking.id}/ics`;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col gap-6 px-4 py-10">
      <div className="flex justify-center">
        <BrandLogo branding={branding} size="md" />
      </div>

      <Card>
        <CardHeader>
          <p
            className={cn(
              "text-xs font-semibold uppercase tracking-wide",
              cancelada
                ? "text-destructive"
                : activa
                  ? "text-brand"
                  : "text-muted-foreground"
            )}
          >
            {cancelada
              ? "Cita cancelada"
              : booking.status === "realizada"
                ? "Cita realizada"
                : booking.status === "no_show"
                  ? "Cita no asistida"
                  : "Cita confirmada"}
          </p>
          <CardTitle className="text-xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Fecha</dt>
            <dd className="font-medium capitalize">
              {start.weekday}, {start.date}
            </dd>
            <dt className="text-muted-foreground">Hora</dt>
            <dd className="font-medium">
              {start.time} – {end.time}
            </dd>
            <dt className="text-muted-foreground">Zona horaria</dt>
            <dd className="font-medium">{tzLabel}</dd>
            {booking.meetingLink && (
              <>
                <dt className="text-muted-foreground">Enlace</dt>
                <dd className="break-all font-medium">
                  <a
                    href={booking.meetingLink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand hover:underline"
                  >
                    {booking.meetingLink}
                  </a>
                </dd>
              </>
            )}
          </dl>

          {description && (
            <p className="whitespace-pre-line text-sm text-muted-foreground">
              {description}
            </p>
          )}

          {cancelada && (
            <p className="text-sm text-muted-foreground">
              Esta cita ya no está en pie. Si la habías guardado en tu
              calendario, descarga la actualización de abajo para quitarla —
              no agregues los botones de Google u Outlook, son para citas
              vigentes.
            </p>
          )}

          {booking.linkPending && !cancelada && (
            <p className="text-sm text-muted-foreground">
              El enlace de la reunión todavía no está listo — te lo
              compartimos por WhatsApp en cuanto lo tengamos.
            </p>
          )}

          {(booking.status === "realizada" || booking.status === "no_show") && (
            <p className="text-sm text-muted-foreground">
              Esta cita ya pasó, así que no hay nada que agregar a tu
              calendario.
            </p>
          )}

          {activa && (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <p className="text-sm font-medium">
                Guarda la cita en tu calendario
              </p>
              <p className="text-xs text-muted-foreground">
                Al elegir una opción se abre tu calendario con estos datos ya
                llenos — la cita se agrega solo cuando TÚ confirmes{" "}
                <strong>Guardar</strong> ahí. Nada se agenda automáticamente.
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={googleCalendarUrl({
                    title,
                    startUtc: startIso,
                    durationMinutes: booking.durationMinutes,
                    description: description || undefined,
                    location: booking.meetingLink || booking.connectorLabel,
                    timezone: booking.timezone,
                  })}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(buttonVariants({ variant: "default" }))}
                >
                  Google Calendar
                </a>
                <a
                  href={outlookCalendarUrl({
                    title,
                    startUtc: startIso,
                    durationMinutes: booking.durationMinutes,
                    description: description || undefined,
                    location: booking.meetingLink || booking.connectorLabel,
                    timezone: booking.timezone,
                  })}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(buttonVariants({ variant: "outline" }))}
                >
                  Outlook
                </a>
                <a
                  href={icsUrl}
                  className={cn(buttonVariants({ variant: "ghost" }))}
                >
                  Descargar .ics (Apple y otros)
                </a>
              </div>
            </div>
          )}

          {cancelada && (
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <a href={icsUrl} className={cn(buttonVariants({ variant: "outline" }))}>
                Descargar .ics actualizado
              </a>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

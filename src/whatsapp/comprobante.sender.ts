import fs from "node:fs/promises";
import { getNombreTipoComprobante } from "../services/arca-billing.service.js";
import { ArcaBaseError, ArcaBusinessError, ArcaValidationError } from "../errors/arca-errors.js";
import type { ComprobanteEmitidoResultado } from "../types/billing.types.js";
import { formatearPesos } from "./fiscal-engine.js";
import { SessionStore } from "./session.store.js";
import type { WhatsAppClient } from "./whatsapp.client.js";

type ClienteWa = Pick<WhatsAppClient, "sendText" | "sendDocument">;

function formatearFecha(yyyymmdd: string): string {
  const s = String(yyyymmdd).replace(/-/g, "");
  return s.length === 8 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : s;
}

/** Manda el PDF del comprobante (o un texto si falla) y lo vincula para poder anularlo citándolo. */
export async function enviarComprobante(
  wa: ClienteWa,
  telefono: string,
  r: ComprobanteEmitidoResultado & { registroId?: string }
): Promise<void> {
  const { nombre, letra } = getNombreTipoComprobante(r.tipoComprobante);
  const numero = `${String(r.puntoVenta).padStart(5, "0")}-${String(r.numeroComprobante).padStart(8, "0")}`;
  const caption = [
    `✅ *${nombre} ${letra} ${numero}* emitida`,
    `Total: ${formatearPesos(r.importeTotal)}`,
    `CAE: ${r.cae} (vence ${formatearFecha(r.caeVencimiento)})`,
  ].join("\n");

  let messageId: string | undefined;
  if (r.pdf?.filePath) {
    try {
      const buffer = await fs.readFile(r.pdf.filePath);
      const filename = `${nombre.replace(/\s+/g, "_")}_${letra}_${numero}.pdf`;
      messageId = await wa.sendDocument(telefono, buffer, filename, caption);
    } catch (error: any) {
      console.error("[WhatsApp Bot] No se pudo enviar el PDF:", error);
    }
  }
  if (!messageId) {
    messageId = await wa.sendText(telefono, `${caption}\n\n(No pude adjuntar el PDF, pedilo por la API.)`);
  }
  if (messageId && r.registroId) {
    await SessionStore.vincularMensajeFactura(messageId, r.registroId, telefono);
  }
}

/** ARCA rechazó o no pasó la validación: seguro que NO se emitió nada y se puede corregir. */
export function esRechazoSeguro(error: unknown): error is ArcaBusinessError | ArcaValidationError {
  return error instanceof ArcaBusinessError || error instanceof ArcaValidationError;
}

/** "❌ ARCA no aceptó...: [10069] Campo DocNro..." con todos los motivos que informó ARCA. */
export function describirRechazo(error: ArcaBaseError): string {
  const motivos = Array.isArray(error.details)
    ? error.details.map((o: any) => `• ${o.code ? `[${o.code}] ` : ""}${o.msg ?? JSON.stringify(o)}`).join("\n")
    : "";
  return `❌ ARCA no aceptó el comprobante: ${error.message}${motivos ? `\n${motivos}` : ""}`;
}

/** Error de red o desconocido: puede que ARCA lo haya autorizado igual, no reintentar a ciegas. */
export function describirErrorIncierto(error: any): string {
  const detalle = error instanceof ArcaBaseError ? error.message : String(error?.message ?? error);
  return `⚠️ Hubo un problema al emitir: ${detalle}\n\nAntes de reintentar, escribí _últimas_ para verificar si se registró, así no se duplica.`;
}

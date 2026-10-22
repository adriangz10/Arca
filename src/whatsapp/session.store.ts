import crypto from "node:crypto";
import { execute, queryOne } from "../db/database.js";
import type { BorradorVenta, FacturaResuelta, PasoVenta } from "./fiscal-engine.js";
import type { BorradorRegistro } from "./registro-empresa.flow.js";

export type EstadoSesion =
  | "IDLE"
  | "REGISTRO_EMPRESA" // alta (o primera configuración) de una empresa, paso a paso
  | "VENTA" // armando una factura: `venta.paso` dice qué dato se pidió
  | "ANULACION" // se pidió confirmar una Nota de Crédito
  | "ESPERANDO_LOGO"; // cambio del logo de la empresa activa

export interface SesionVenta {
  paso: PasoVenta;
  borrador: BorradorVenta;
  /** Factura calculada que se mostró en el resumen (paso "confirmar"). */
  factura?: FacturaResuelta;
  /** Se está eligiendo qué dato corregir. */
  corrigiendo?: boolean;
}

export interface SesionBot {
  telefono: string;
  estado: EstadoSesion;
  /** Id de los botones vigentes: descarta toques viejos o repetidos. */
  borradorId?: string;
  venta?: SesionVenta;
  anulacionFacturaId?: string;
  registro?: BorradorRegistro;
}

export function nuevaSesion(telefono: string): SesionBot {
  return { telefono, estado: "IDLE" };
}

export function nuevoBorradorId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/** El alta de empresa puede llevar varios minutos (buscar el logo, el certificado...). */
const TTL_REGISTRO_MINUTOS = 60;

export class SessionStore {
  public static async get(telefono: string, ttlMinutes: number): Promise<SesionBot> {
    const row = await queryOne<{ data_json: string; updated_at: string }>(
      `SELECT data_json, updated_at FROM whatsapp_sessions WHERE telefono = ?`,
      [telefono]
    );
    if (!row) return nuevaSesion(telefono);

    let sesion: SesionBot;
    try {
      sesion = { ...nuevaSesion(telefono), ...JSON.parse(row.data_json) };
    } catch {
      return nuevaSesion(telefono);
    }

    const ttl = sesion.estado === "REGISTRO_EMPRESA" ? Math.max(ttlMinutes, TTL_REGISTRO_MINUTOS) : ttlMinutes;
    if (Date.now() - new Date(row.updated_at).getTime() > ttl * 60_000) {
      await this.clear(telefono);
      return nuevaSesion(telefono);
    }
    return sesion;
  }

  public static async save(sesion: SesionBot): Promise<void> {
    await execute(
      `INSERT INTO whatsapp_sessions (telefono, data_json, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), updated_at = VALUES(updated_at)`,
      [sesion.telefono, JSON.stringify(sesion), new Date().toISOString()]
    );
  }

  public static async clear(telefono: string): Promise<void> {
    await execute(`DELETE FROM whatsapp_sessions WHERE telefono = ?`, [telefono]);
  }

  /** Devuelve true si el mensaje es nuevo (y lo marca como procesado). */
  public static async marcarProcesado(messageId: string): Promise<boolean> {
    const result = await execute(
      `INSERT IGNORE INTO whatsapp_processed_messages (message_id, created_at) VALUES (?, ?)`,
      [messageId, new Date().toISOString()]
    );

    // Limpieza ocasional de registros viejos (> 7 días)
    if (Math.random() < 0.01) {
      const limite = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      await execute(`DELETE FROM whatsapp_processed_messages WHERE created_at < ?`, [limite]);
    }
    return result.affectedRows > 0;
  }

  public static async vincularMensajeFactura(waMessageId: string, invoiceId: string, telefono: string): Promise<void> {
    await execute(
      `INSERT INTO whatsapp_invoice_messages (wa_message_id, invoice_id, telefono, created_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE invoice_id = VALUES(invoice_id), telefono = VALUES(telefono)`,
      [waMessageId, invoiceId, telefono, new Date().toISOString()]
    );
  }

  public static async facturaPorMensaje(waMessageId: string): Promise<string | null> {
    const row = await queryOne<{ invoice_id: string }>(
      `SELECT invoice_id FROM whatsapp_invoice_messages WHERE wa_message_id = ?`,
      [waMessageId]
    );
    return row?.invoice_id ?? null;
  }
}

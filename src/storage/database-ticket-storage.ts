import { AccessTicket, type ITicketStoragePort, type ArcaServiceName } from "@arcasdk/core";
import { execute, queryOne } from "../db/database.js";
import { huellaCertificado } from "../utils/crypto.utils.js";

export interface TicketRecord {
  cuit: number;
  serviceName: string;
  production: boolean;
  token: string;
  sign: string;
  generationTime: string;
  expirationTime: string;
  header: unknown;
  credentials: unknown;
  updatedAt: string;
}

/**
 * Guarda los tickets WSAA (Token y Sign, 12 h) en MySQL.
 *
 * La clave es por CERTIFICADO + servicio + ambiente: ARCA entrega un solo ticket vigente
 * por certificado, así que varias empresas que facturan con el mismo certificado
 * (delegación) comparten el ticket en vez de pedir uno nuevo y ser rechazadas.
 */
export class DatabaseTicketStorage implements ITicketStoragePort {
  private cuit: number;
  private production: boolean;
  public readonly certId: string;

  constructor(options: { cuit: number; production?: boolean; certPem?: string }) {
    this.cuit = options.cuit;
    this.production = options.production ?? false;
    this.certId = options.certPem ? huellaCertificado(options.certPem) : `cuit${options.cuit}`;
  }

  private getKey(serviceName: ArcaServiceName): string {
    return `${this.certId}_${serviceName}_${this.production ? "prod" : "homo"}`;
  }

  async save(ticket: AccessTicket, serviceName: ArcaServiceName): Promise<void> {
    const headers = ticket.getHeaders();
    const nowIso = new Date().toISOString();
    await execute(
      `INSERT INTO arca_tickets (id, cuit, service_name, production, token, sign,
         generation_time, expiration_time, header_json, credentials_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cuit = VALUES(cuit), token = VALUES(token), sign = VALUES(sign),
         generation_time = VALUES(generation_time), expiration_time = VALUES(expiration_time),
         header_json = VALUES(header_json), credentials_json = VALUES(credentials_json), updated_at = VALUES(updated_at)`,
      [
        this.getKey(serviceName),
        this.cuit,
        serviceName,
        this.production ? 1 : 0,
        ticket.getToken(),
        ticket.getSign(),
        (headers as any)[1]?.generationtime ?? nowIso,
        ticket.getExpiration().toISOString(),
        JSON.stringify(headers),
        JSON.stringify(ticket.getCredentials()),
        nowIso,
      ]
    );
  }

  async get(serviceName: ArcaServiceName): Promise<AccessTicket | null> {
    const row: any = await queryOne(`SELECT * FROM arca_tickets WHERE id = ?`, [this.getKey(serviceName)]);
    if (!row) return null;

    try {
      const header = row.header_json ? JSON.parse(row.header_json) : undefined;
      const credentials = row.credentials_json ? JSON.parse(row.credentials_json) : undefined;
      const ticket = AccessTicket.create({
        header: header ?? [{}, { generationtime: row.generation_time, expirationtime: row.expiration_time }],
        credentials: credentials ?? { token: row.token, sign: row.sign },
      } as any);

      if (ticket.isExpired()) {
        await this.delete(serviceName);
        return null;
      }
      return ticket;
    } catch {
      return null;
    }
  }

  async delete(serviceName: ArcaServiceName): Promise<void> {
    await execute(`DELETE FROM arca_tickets WHERE id = ?`, [this.getKey(serviceName)]);
  }

  async getTicketInfo(serviceName: ArcaServiceName): Promise<{
    hasValidTicket: boolean;
    expiresInMinutes: number;
    expirationTime?: string;
  }> {
    const ticket = await this.get(serviceName);
    if (!ticket || ticket.isExpired()) {
      return { hasValidTicket: false, expiresInMinutes: 0 };
    }
    return {
      hasValidTicket: true,
      expiresInMinutes: Math.round(ticket.getTimeUntilExpiration() / 60_000),
      expirationTime: ticket.getExpiration().toISOString(),
    };
  }
}

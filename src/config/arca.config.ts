import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { cuitDelCertificado } from "../utils/crypto.utils.js";

/**
 * Credenciales del certificado "del sistema" (las únicas que siguen en el .env).
 * El CUIT sale del propio certificado; los datos de cada empresa (CUIT emisor,
 * punto de venta, ambiente) están en la base de datos.
 */
export interface ArcaConfig {
  cuit: number;
  cert: string;
  key: string;
  ptoVta: number;
  production: boolean;
  ticketPath: string;
  useHttpsAgent?: boolean;
}

function getCertOrKey(pathEnv: string, contentEnv: string): string {
  const content = process.env[contentEnv];
  if (content && content.trim().length > 0) return content.trim();

  const certPath = process.env[pathEnv];
  if (certPath && certPath.trim().length > 0) {
    const resolvedPath = path.resolve(process.cwd(), certPath.trim());
    if (fs.existsSync(resolvedPath)) return fs.readFileSync(resolvedPath, "utf-8");
  }
  return "";
}

export function loadArcaConfig(): ArcaConfig {
  const cert = getCertOrKey("ARCA_CERT_PATH", "ARCA_CERT_CONTENT");
  const key = getCertOrKey("ARCA_KEY_PATH", "ARCA_KEY_CONTENT");

  return {
    cuit: cert ? Number(cuitDelCertificado(cert) ?? 0) : 0,
    cert,
    key,
    ptoVta: 1,
    production: false,
    ticketPath: process.env.ARCA_TICKETS_PATH || path.resolve(process.cwd(), "tickets"),
    useHttpsAgent: process.env.ARCA_USE_HTTPS_AGENT === "true",
  };
}

/** CUIT del certificado del sistema (el que reciben las delegaciones), o undefined. */
export function cuitDelSistema(): number | undefined {
  return loadArcaConfig().cuit || undefined;
}

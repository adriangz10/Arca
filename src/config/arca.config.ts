import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

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
  if (content && content.trim().length > 0) {
    return content.trim();
  }

  const certPath = process.env[pathEnv];
  if (certPath && certPath.trim().length > 0) {
    const resolvedPath = path.resolve(process.cwd(), certPath.trim());
    if (fs.existsSync(resolvedPath)) {
      return fs.readFileSync(resolvedPath, "utf-8");
    }
    // Si aún no existe el archivo físico en desarrollo, devolvemos string informativo para no romper en build
    return "";
  }

  return "";
}

export function loadArcaConfig(): ArcaConfig {
  const rawCuit = process.env.ARCA_CUIT || "20111111112";
  const cuit = Number(rawCuit.replace(/[^0-9]/g, ""));
  const ptoVta = Number(process.env.ARCA_PTO_VTA || 1);
  const production = process.env.ARCA_PRODUCTION === "true";
  const ticketPath = process.env.ARCA_TICKETS_PATH || path.resolve(process.cwd(), "tickets");

  const cert = getCertOrKey("ARCA_CERT_PATH", "ARCA_CERT_CONTENT");
  const key = getCertOrKey("ARCA_KEY_PATH", "ARCA_KEY_CONTENT");

  return {
    cuit,
    cert,
    key,
    ptoVta,
    production,
    ticketPath,
    useHttpsAgent: process.env.ARCA_USE_HTTPS_AGENT === "true",
  };
}

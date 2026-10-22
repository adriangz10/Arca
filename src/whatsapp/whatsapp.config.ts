import "dotenv/config";

export type CondicionEmisor = "MONOTRIBUTO" | "RESPONSABLE_INSCRIPTO" | "EXENTO";

export interface WhatsAppBotConfig {
  // WhatsApp Cloud API (Meta)
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret?: string;
  apiVersion: string;
  allowedNumbers: string[];
  fixArgentinaNumbers: boolean;

  // IA (Gemini)
  geminiApiKey?: string;
  geminiModel: string;

  // Emisor
  emisorCondicion: CondicionEmisor;
  emisorRazonSocial?: string;
  emisorDomicilio?: string;

  // Reglas de negocio
  topeConsumidorFinal: number;
  conceptoDefault: 1 | 2 | 3;
  sessionTtlMinutes: number;
  monotributoTopeAnual?: number;
  monotributoCategoria?: string;
  consultarPadron: boolean;
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") return undefined;
  const n = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Deja solo dígitos: "+54 9 11 1234-5678" -> "5491112345678" */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

/** Compara ignorando el "9" de celulares argentinos (549XXXXXXXXXX == 54XXXXXXXXXX). */
export function numeroAutorizado(from: string, allowed: string[]): boolean {
  const variantes = (n: string) => {
    if (/^549\d{10}$/.test(n)) return [n, `54${n.slice(3)}`];
    if (/^54\d{10}$/.test(n)) return [n, `549${n.slice(2)}`];
    return [n];
  };
  const candidatos = variantes(normalizePhone(from));
  return allowed.some((a) => candidatos.includes(a));
}

export function loadWhatsAppConfig(): WhatsAppBotConfig {
  const condicion = (process.env.ARCA_EMISOR_CONDICION_IVA || "MONOTRIBUTO").toUpperCase();
  const emisorCondicion: CondicionEmisor =
    condicion === "RESPONSABLE_INSCRIPTO" || condicion === "RI"
      ? "RESPONSABLE_INSCRIPTO"
      : condicion === "EXENTO"
        ? "EXENTO"
        : "MONOTRIBUTO";

  const concepto = Number(process.env.BOT_CONCEPTO_DEFAULT || 2);

  return {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
    appSecret: process.env.WHATSAPP_APP_SECRET || undefined,
    apiVersion: process.env.WHATSAPP_API_VERSION || "v22.0",
    allowedNumbers: (process.env.WHATSAPP_ALLOWED_NUMBERS || "")
      .split(",")
      .map((n) => normalizePhone(n))
      .filter(Boolean),
    fixArgentinaNumbers: process.env.WHATSAPP_FIX_AR_NUMBERS !== "false",

    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",

    emisorCondicion,
    emisorRazonSocial: process.env.ARCA_EMISOR_RAZON_SOCIAL || undefined,
    emisorDomicilio: process.env.ARCA_EMISOR_DOMICILIO || undefined,

    topeConsumidorFinal: toNumber(process.env.CONSUMIDOR_FINAL_TOPE) ?? 10_000_000,
    conceptoDefault: concepto === 1 || concepto === 3 ? concepto : 2,
    sessionTtlMinutes: toNumber(process.env.BOT_SESSION_TTL_MINUTES) ?? 15,
    monotributoTopeAnual: toNumber(process.env.MONOTRIBUTO_TOPE_ANUAL),
    monotributoCategoria: process.env.MONOTRIBUTO_CATEGORIA || undefined,
    consultarPadron: process.env.BOT_CONSULTAR_PADRON !== "false",
  };
}

export function isWhatsAppConfigured(config = loadWhatsAppConfig()): boolean {
  return Boolean(config.accessToken && config.phoneNumberId && config.verifyToken);
}

import "dotenv/config";

/**
 * Credenciales del bot (lo único del bot que sigue en el .env: son secretos).
 * Los datos fiscales están en la tabla `empresas` y las reglas en `configuracion`.
 */
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
  };
}

export function isWhatsAppConfigured(config = loadWhatsAppConfig()): boolean {
  return Boolean(config.accessToken && config.phoneNumberId && config.verifyToken);
}

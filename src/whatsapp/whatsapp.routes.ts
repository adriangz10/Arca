import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { loadWhatsAppConfig, isWhatsAppConfigured, normalizePhone, numeroAutorizado } from "./whatsapp.config.js";
import { verifyWebhookSignature } from "./whatsapp.client.js";
import { WhatsAppBotService, type MensajeEntrante } from "./bot.service.js";
import { SessionStore } from "./session.store.js";

const router = Router();
const config = loadWhatsAppConfig();
let bot: WhatsAppBotService | null = null;

function getBot(): WhatsAppBotService {
  if (!bot) bot = new WhatsAppBotService(config);
  return bot;
}

/** Convierte el mensaje crudo de Meta a nuestro formato. */
function normalizarMensaje(m: any): MensajeEntrante {
  const base: MensajeEntrante = {
    id: m.id,
    from: normalizePhone(String(m.from)),
    type: m.type,
    contextMessageId: m.context?.id,
  };

  switch (m.type) {
    case "text":
      return { ...base, text: m.text?.body };
    case "audio":
      return { ...base, mediaId: m.audio?.id, mimeType: m.audio?.mime_type };
    case "image":
      return { ...base, mediaId: m.image?.id, mimeType: m.image?.mime_type, text: m.image?.caption };
    case "document":
      return { ...base, mediaId: m.document?.id, mimeType: m.document?.mime_type, text: m.document?.caption };
    case "interactive":
      return { ...base, buttonId: m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id };
    case "button":
      return { ...base, buttonId: m.button?.payload, text: m.button?.text };
    default:
      return base;
  }
}

function tokenValido(recibido: string, esperado: string): boolean {
  const a = crypto.createHash("sha256").update(recibido).digest();
  const b = crypto.createHash("sha256").update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * GET /webhooks/whatsapp
 * Verificación del webhook que hace Meta al configurarlo en el panel de la app.
 */
router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && config.verifyToken && typeof token === "string" && tokenValido(token, config.verifyToken)) {
    console.log("[WhatsApp] Webhook verificado por Meta.");
    res.status(200).send(String(challenge));
    return;
  }
  res.sendStatus(403);
});

/**
 * POST /webhooks/whatsapp
 * Recibe mensajes. Responde 200 de inmediato y procesa en segundo plano
 * (Meta reintenta si no respondemos en pocos segundos).
 */
router.post("/", (req: Request, res: Response) => {
  if (config.appSecret) {
    const ok = verifyWebhookSignature((req as any).rawBody, req.get("x-hub-signature-256"), config.appSecret);
    if (!ok) {
      console.warn("[WhatsApp] Firma de webhook inválida. Request descartado.");
      res.sendStatus(401);
      return;
    }
  }

  res.sendStatus(200);

  if (!isWhatsAppConfigured(config)) {
    console.warn("[WhatsApp] Llegó un webhook pero faltan WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_VERIFY_TOKEN.");
    return;
  }

  const body = req.body;
  if (body?.object !== "whatsapp_business_account") return;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      // Solo mensajes dirigidos a nuestro número
      if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== config.phoneNumberId) continue;

      for (const raw of value.messages ?? []) {
        const msg = normalizarMensaje(raw);

        if (!numeroAutorizado(msg.from, config.allowedNumbers)) {
          console.warn(
            `[WhatsApp] Mensaje ignorado de ${msg.from}: no está en WHATSAPP_ALLOWED_NUMBERS. ` +
              "Agregalo al .env si es un número autorizado a facturar."
          );
          continue;
        }

        // Duplicados (reintentos de Meta) se descartan antes de procesar.
        SessionStore.marcarProcesado(msg.id)
          .then((nuevo) => (nuevo ? getBot().procesar(msg) : undefined))
          .catch((err) => console.error("[WhatsApp] Error no controlado:", err));
      }
    }
  }
});

export const whatsappRoutes = router;

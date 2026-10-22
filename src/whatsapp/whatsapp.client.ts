import crypto from "node:crypto";
import { loadWhatsAppConfig, type WhatsAppBotConfig } from "./whatsapp.config.js";

export interface ReplyButton {
  id: string;
  title: string; // máx. 20 caracteres (límite de WhatsApp)
}

export interface ListRow {
  id: string;
  title: string; // máx. 24 caracteres
  description?: string; // máx. 72 caracteres
}

/**
 * Cliente mínimo de la WhatsApp Cloud API (Meta Graph API).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
export class WhatsAppClient {
  private config: WhatsAppBotConfig;

  constructor(config: WhatsAppBotConfig = loadWhatsAppConfig()) {
    this.config = config;
  }

  private get baseUrl(): string {
    return `https://graph.facebook.com/${this.config.apiVersion}`;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.accessToken}` };
  }

  /**
   * Argentina: el webhook trae los celulares como 549 + área + número, pero la API
   * suele rechazar el envío a ese formato (error 131030) y espera 54 + área + número.
   */
  private formatearDestino(to: string): string {
    if (this.config.fixArgentinaNumbers && /^549\d{10}$/.test(to)) {
      return `54${to.slice(3)}`;
    }
    return to;
  }

  private async sendMessage(payload: Record<string, unknown>): Promise<string | undefined> {
    if (typeof payload.to === "string") {
      payload = { ...payload, to: this.formatearDestino(payload.to) };
    }
    const res = await fetch(`${this.baseUrl}/${this.config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
    });

    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`WhatsApp API ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
    }
    return body?.messages?.[0]?.id;
  }

  public sendText(to: string, text: string, replyToMessageId?: string) {
    return this.sendMessage({
      to,
      type: "text",
      ...(replyToMessageId ? { context: { message_id: replyToMessageId } } : {}),
      text: { body: text.slice(0, 4096), preview_url: false },
    });
  }

  /** Mensaje con hasta 3 botones de respuesta rápida. */
  public sendButtons(to: string, body: string, buttons: ReplyButton[], footer?: string) {
    return this.sendMessage({
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  /** Mensaje con lista desplegable (para más de 3 opciones). */
  public sendList(to: string, body: string, buttonLabel: string, rows: ListRow[], sectionTitle = "Opciones") {
    return this.sendMessage({
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body.slice(0, 1024) },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: [
            {
              title: sectionTitle.slice(0, 24),
              rows: rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: r.title.slice(0, 24),
                ...(r.description ? { description: r.description.slice(0, 72) } : {}),
              })),
            },
          ],
        },
      },
    });
  }

  /** Sube un archivo a WhatsApp y devuelve el media_id. */
  public async uploadMedia(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

    const res = await fetch(`${this.baseUrl}/${this.config.phoneNumberId}/media`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body?.id) {
      throw new Error(`Error subiendo media a WhatsApp (${res.status}): ${body?.error?.message ?? JSON.stringify(body)}`);
    }
    return body.id;
  }

  /** Envía un PDF como documento adjunto. Devuelve el id del mensaje enviado. */
  public async sendDocument(to: string, buffer: Buffer, filename: string, caption?: string) {
    const mediaId = await this.uploadMedia(buffer, "application/pdf", filename);
    return this.sendMessage({
      to,
      type: "document",
      document: { id: mediaId, filename, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
    });
  }

  /**
   * Descarga un archivo recibido (audio, imagen, documento).
   * `maxBytes` corta la descarga de archivos más grandes de lo esperado (por defecto 20 MB).
   */
  public async downloadMedia(
    mediaId: string,
    opciones: { maxBytes?: number } = {}
  ): Promise<{ data: Buffer; mimeType: string }> {
    const maxBytes = opciones.maxBytes ?? 20 * 1024 * 1024;
    const metaRes = await fetch(`${this.baseUrl}/${encodeURIComponent(mediaId)}`, { headers: this.authHeaders() });
    const meta: any = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta?.url) {
      throw new Error(`No se pudo obtener la URL del media ${mediaId}: ${meta?.error?.message ?? metaRes.status}`);
    }
    if (Number(meta.file_size) > maxBytes) {
      throw new Error(`el archivo pesa ${(Number(meta.file_size) / 1024 / 1024).toFixed(1)} MB y el máximo es ${(maxBytes / 1024 / 1024).toFixed(1)} MB`);
    }
    // El token de Meta solo se manda a dominios de Meta.
    if (!/^https:\/\/([a-z0-9-]+\.)*(fbsbx|facebook|whatsapp)\.(com|net)\//i.test(String(meta.url))) {
      throw new Error("URL de descarga inesperada");
    }

    const fileRes = await fetch(meta.url, { headers: this.authHeaders() });
    if (!fileRes.ok) {
      throw new Error(`No se pudo descargar el media ${mediaId}: HTTP ${fileRes.status}`);
    }
    const data = Buffer.from(await fileRes.arrayBuffer());
    if (data.length > maxBytes) {
      throw new Error(`el archivo supera el máximo de ${(maxBytes / 1024 / 1024).toFixed(1)} MB`);
    }
    return { data, mimeType: String(meta.mime_type || fileRes.headers.get("content-type") || "application/octet-stream") };
  }

  /**
   * Verifica que el token sirva para el número configurado. Devuelve null si está todo bien,
   * o un texto explicando el problema (token vencido, sin permisos, número equivocado).
   */
  public async verificarToken(): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/${this.config.phoneNumberId}?fields=id`, { headers: this.authHeaders() });
      if (res.ok) return null;
      const body: any = await res.json().catch(() => ({}));
      const e = body?.error ?? {};
      if (e.code === 190) {
        return `el token de WhatsApp no es válido o venció (${e.message ?? "OAuthException"}). Generá un token permanente de System User en Business Settings > System Users.`;
      }
      return `Meta respondió ${res.status}: ${e.message ?? "error desconocido"}`;
    } catch (err: any) {
      return `no se pudo contactar a Meta: ${err?.message ?? err}`;
    }
  }

  /** Marca un mensaje como leído (los dos tildes azules). */
  public async markAsRead(messageId: string): Promise<void> {
    try {
      await this.sendMessage({ status: "read", message_id: messageId });
    } catch {
      // No es crítico.
    }
  }
}

/**
 * Valida la firma X-Hub-Signature-256 que Meta agrega a cada webhook.
 * Si no hay WHATSAPP_APP_SECRET configurado, no se puede validar.
 */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!rawBody || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

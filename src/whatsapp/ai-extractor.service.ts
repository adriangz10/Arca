import { loadWhatsAppConfig } from "./whatsapp.config.js";

export type AccionBot = "EMITIR_FACTURA" | "ANULAR" | "CANCELAR" | "AYUDA" | "OTRO";

/**
 * Lo que la IA extrae de un mensaje. Nunca contiene cálculos: solo lo que dijo el usuario.
 * Los campos en null significan "el usuario no lo dijo".
 */
export interface ExtraccionMensaje {
  accion: AccionBot;
  montoTotal: number | null;
  ivaIncluido: boolean | null;
  alicuotaIva: number | null; // 21, 10.5, 27, 5, 2.5, 0
  receptorDocumento: string | null; // CUIT/CUIL/DNI solo dígitos
  receptorNombre: string | null;
  consumidorFinal: boolean | null;
  conceptoDescripcion: string | null;
  tipoConcepto: 1 | 2 | 3 | null;
  comprobanteReferencia: string | null; // para anular: "00001-00000005" o "5"
}

export interface MediaAdjunta {
  data: Buffer;
  mimeType: string;
}

const SYSTEM_PROMPT = `Sos el extractor de datos de un bot de facturación electrónica argentina (ARCA/AFIP) que funciona por WhatsApp.
Tu ÚNICA tarea es leer el mensaje del usuario (texto, audio transcripto, foto de un comprobante de transferencia o PDF) y devolver un JSON con los datos que el usuario dio. NO calcules IVA, NO inventes datos, NO decidas el tipo de factura.

Reglas:
- accion:
  * "EMITIR_FACTURA": quiere facturar, o aporta/corrige datos de una factura en curso (ej: "el CUIT es 20-...", "poné 50 mil", "es por diseño web").
  * "ANULAR": quiere anular / dar de baja / hacer nota de crédito de una factura ya emitida.
  * "CANCELAR": quiere abandonar la operación en curso ("cancelá", "dejá", "nada").
  * "AYUDA": saluda o pregunta qué puede hacer el bot.
  * "OTRO": cualquier otra cosa.
- montoTotal: número en pesos tal cual lo dijo el usuario. "45 mil" = 45000, "1,5 palos"/"1.5 millones" = 1500000, "$120.000,50" = 120000.5. Si es una imagen de transferencia, usá el importe transferido. null si no lo dijo.
- ivaIncluido: false si dice "más IVA", "+IVA", "neto"; true si dice "IVA incluido", "final", o no menciona el IVA y hay monto; null si no hay monto.
- alicuotaIva: solo si menciona explícitamente una alícuota (10.5, 21, 27). Si no, null.
- receptorDocumento: CUIT, CUIL o DNI del cliente, SOLO dígitos (sin guiones ni puntos). En una transferencia es el CUIT/CUIL de quien ENVIÓ el dinero (el pagador), no el del receptor. null si no aparece.
- receptorNombre: nombre o razón social del cliente si lo menciona. null si no.
- consumidorFinal: true si dice "consumidor final" o "sin datos"; null si no lo menciona.
- conceptoDescripcion: descripción breve y prolija del producto/servicio facturado (ej: "Servicio de diseño gráfico"). null si no la dijo.
- tipoConcepto: 1 = productos, 2 = servicios, 3 = ambos. Inferilo de la descripción. null si no hay descripción.
- comprobanteReferencia: si quiere anular y menciona un número de factura, ponelo tal cual (ej "00001-00000005" o "5"). null si no.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    accion: { type: "STRING", enum: ["EMITIR_FACTURA", "ANULAR", "CANCELAR", "AYUDA", "OTRO"] },
    montoTotal: { type: "NUMBER", nullable: true },
    ivaIncluido: { type: "BOOLEAN", nullable: true },
    alicuotaIva: { type: "NUMBER", nullable: true },
    receptorDocumento: { type: "STRING", nullable: true },
    receptorNombre: { type: "STRING", nullable: true },
    consumidorFinal: { type: "BOOLEAN", nullable: true },
    conceptoDescripcion: { type: "STRING", nullable: true },
    tipoConcepto: { type: "INTEGER", nullable: true },
    comprobanteReferencia: { type: "STRING", nullable: true },
  },
  required: ["accion"],
};

const VACIO: Omit<ExtraccionMensaje, "accion"> = {
  montoTotal: null,
  ivaIncluido: null,
  alicuotaIva: null,
  receptorDocumento: null,
  receptorNombre: null,
  consumidorFinal: null,
  conceptoDescripcion: null,
  tipoConcepto: null,
  comprobanteReferencia: null,
};

function sanitize(raw: any): ExtraccionMensaje {
  const acciones: AccionBot[] = ["EMITIR_FACTURA", "ANULAR", "CANCELAR", "AYUDA", "OTRO"];
  const accion: AccionBot = acciones.includes(raw?.accion) ? raw.accion : "OTRO";

  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);

  const doc = str(raw?.receptorDocumento)?.replace(/[^0-9]/g, "") || null;
  const tipoConcepto = [1, 2, 3].includes(raw?.tipoConcepto) ? (raw.tipoConcepto as 1 | 2 | 3) : null;
  const alicuota = typeof raw?.alicuotaIva === "number" && raw.alicuotaIva >= 0 ? raw.alicuotaIva : null;

  return {
    accion,
    montoTotal: num(raw?.montoTotal),
    ivaIncluido: bool(raw?.ivaIncluido),
    alicuotaIva: alicuota,
    receptorDocumento: doc,
    receptorNombre: str(raw?.receptorNombre),
    consumidorFinal: bool(raw?.consumidorFinal),
    conceptoDescripcion: str(raw?.conceptoDescripcion),
    tipoConcepto,
    comprobanteReferencia: str(raw?.comprobanteReferencia),
  };
}

export class AiExtractorService {
  /**
   * Extrae la intención y parámetros de un mensaje.
   * @param texto Texto del mensaje (o caption de la imagen).
   * @param media Audio/imagen/PDF adjunto (opcional).
   * @param contexto Descripción del estado actual de la conversación (borrador, dato que se pidió).
   */
  public static async extraer(texto: string, media?: MediaAdjunta, contexto?: string): Promise<ExtraccionMensaje> {
    const config = loadWhatsAppConfig();

    if (!config.geminiApiKey) {
      if (media) {
        throw new Error("Para procesar audios o imágenes hay que configurar GEMINI_API_KEY.");
      }
      return this.extraerSinIa(texto);
    }

    const parts: any[] = [];
    if (contexto) {
      parts.push({ text: `Contexto de la conversación (no es del usuario):\n${contexto}` });
    }
    if (media) {
      parts.push({ inline_data: { mime_type: media.mimeType.split(";")[0], data: media.data.toString("base64") } });
    }
    parts.push({ text: `Mensaje del usuario:\n${texto || "(sin texto, ver adjunto)"}` });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiApiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });

    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Gemini ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
    }

    const text = body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    try {
      return sanitize(JSON.parse(text));
    } catch {
      throw new Error(`Gemini devolvió una respuesta no válida: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Parser básico por reglas, usado cuando no hay GEMINI_API_KEY.
   * Sirve para probar el flujo; para uso real conviene la IA.
   */
  public static extraerSinIa(texto: string): ExtraccionMensaje {
    const t = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

    if (/^\s*(cancel|deja|nada|no importa)/.test(t)) return { accion: "CANCELAR", ...VACIO };
    if (/^\s*(hola|ayuda|help|menu|\?)/.test(t)) return { accion: "AYUDA", ...VACIO };

    const result: ExtraccionMensaje = { accion: "EMITIR_FACTURA", ...VACIO };

    if (/anul|nota de credito|dar de baja/.test(t)) {
      result.accion = "ANULAR";
      const ref = t.match(/(\d{1,5}-\d{1,8})|(?:factura|nro|numero|n°)\s*(\d+)/);
      result.comprobanteReferencia = ref ? (ref[1] ?? ref[2]) : null;
      return result;
    }

    // CUIT/CUIL (con o sin guiones) o DNI
    const cuit = texto.match(/\b(\d{2})[-\s.]?(\d{8})[-\s.]?(\d)\b/);
    const dni = texto.match(/\bdni\s*:?\s*([\d.]{7,10})/i);
    if (cuit) result.receptorDocumento = `${cuit[1]}${cuit[2]}${cuit[3]}`;
    else if (dni) result.receptorDocumento = dni[1].replace(/\D/g, "");

    // Monto: "$45.000", "45 mil", "1,5 millones", "120000"
    const textoSinDoc = cuit ? texto.replace(cuit[0], " ") : texto;
    const monto = textoSinDoc
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .match(/\$?\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d+)?)\s*(mil\b|k\b|millon(?:es)?\b|palos?\b)?/);
    if (monto) {
      let raw = monto[1];
      raw = /\.\d{3}/.test(raw) ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(",", ".");
      let value = Number(raw);
      const mult = monto[2] ?? "";
      if (mult === "mil" || mult === "k") value *= 1_000;
      if (/^(millon|palo)/.test(mult)) value *= 1_000_000;
      if (Number.isFinite(value) && value > 0) result.montoTotal = value;
    }

    if (result.montoTotal) {
      result.ivaIncluido = !/(mas|\+)\s*iva|neto/.test(t);
    }
    if (/consumidor final|sin datos/.test(t)) result.consumidorFinal = true;

    const concepto =
      texto.match(/\b(?:por|de|en concepto de)\s+((?:servicio|honorario|venta|mantenimiento|dise|desarrollo|consultor|producto|clase|trabajo)[^,.\n]*)/i)?.[1] ??
      this.conceptoPorDescarte(texto, cuit?.[0], monto?.[0]);
    if (concepto) {
      const desc = concepto.trim();
      result.conceptoDescripcion = desc.charAt(0).toUpperCase() + desc.slice(1);
      result.tipoConcepto = /servicio|honorario|mantenimiento|dise|desarrollo|consultor|clase|trabajo|reparaci|instalaci/i.test(desc) ? 2 : 1;
    }

    return result;
  }

  /**
   * Concepto = lo que queda del mensaje después de sacar el monto, el documento y las
   * palabras de relleno. "nueva venta de pintura por 130.000" -> "venta de pintura".
   */
  private static conceptoPorDescarte(texto: string, docRaw?: string, montoRaw?: string): string | null {
    let s = texto.toLowerCase();
    if (docRaw) s = s.replace(docRaw.toLowerCase(), " ");
    s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (montoRaw) s = s.replace(montoRaw.trim(), " ");
    s = s
      .replace(/\b(cuit|cuil|dni)\b\s*:?/g, " ")
      .replace(/\b(mas|\+)\s*iva\b|\biva incluido\b|\bfinal\b|\bneto\b/g, " ")
      .replace(/\b(a |al )?consumidor final\b/g, " ")
      .replace(/^\s*(nueva|nuevo|haceme|hace|emiti|emitime|facturale|facturame|factura|facturar|una|un|la|el)\b/g, " ")
      .replace(/^\s*(nueva|nuevo|una|un|factura|facturale)\b/g, " ")
      .replace(/[$:,]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+(por|de|a|al|en|con|para)$/g, "")
      .replace(/^(por|de|a|al|en|con|para)\s+/g, "")
      .trim();
    return /[a-z]{3,}/.test(s) ? s : null;
  }
}

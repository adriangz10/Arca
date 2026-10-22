import QRCode from "qrcode";

export interface AfipQrPayload {
  ver: number;
  fecha: string; // YYYY-MM-DD
  cuit: number;
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: number;
  moneda: string;
  ctz: number;
  tipoDocRec?: number;
  nroDocRec?: number;
  tipoCodAut: "E" | "A"; // "E" para CAE, "A" para CAEA
  codAut: number;
}

export class ArcaQrService {
  /**
   * Genera el payload JSON oficial, el string codificado en Base64
   * y la URL para renderizar el código QR reglamentario de ARCA/AFIP.
   */
  static generateQrData(params: {
    cuitEmisor: number;
    puntoVenta: number;
    tipoComprobante: number;
    numeroComprobante: number;
    fechaComprobante: string; // YYYYMMDD o YYYY-MM-DD
    importeTotal: number;
    moneda?: string;
    cotizacion?: number;
    tipoDocReceptor?: number;
    nroDocReceptor?: number | string;
    cae: string | number;
    esCaea?: boolean;
  }): { rawJson: string; base64Json: string; url: string } {
    let formattedDate = params.fechaComprobante;
    if (/^\d{8}$/.test(formattedDate)) {
      formattedDate = `${formattedDate.slice(0, 4)}-${formattedDate.slice(4, 6)}-${formattedDate.slice(6, 8)}`;
    }

    const nroDoc = params.nroDocReceptor
      ? Number(String(params.nroDocReceptor).replace(/[^0-9]/g, ""))
      : undefined;

    const payload: AfipQrPayload = {
      ver: 1,
      fecha: formattedDate,
      cuit: params.cuitEmisor,
      ptoVta: params.puntoVenta,
      tipoCmp: params.tipoComprobante,
      nroCmp: params.numeroComprobante,
      importe: params.importeTotal,
      moneda: params.moneda ?? "PES",
      ctz: params.cotizacion ?? 1,
      tipoDocRec: params.tipoDocReceptor,
      nroDocRec: nroDoc,
      tipoCodAut: params.esCaea ? "A" : "E",
      codAut: Number(params.cae),
    };

    const rawJson = JSON.stringify(payload);
    const base64Json = Buffer.from(rawJson).toString("base64");
    const url = `https://www.afip.gob.ar/fe/qr/?p=${base64Json}`;

    return {
      rawJson,
      base64Json,
      url,
    };
  }

  /**
   * Genera el buffer de la imagen PNG del código QR reglamentario.
   */
  static async generateQrImageBuffer(qrUrl: string): Promise<Buffer> {
    return await QRCode.toBuffer(qrUrl, {
      type: "png",
      width: 160,
      margin: 1,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });
  }

  /**
   * Genera el Data URL (base64 PNG) del código QR para incrustar en HTML o frontend.
   */
  static async generateQrDataUrl(qrUrl: string): Promise<string> {
    return await QRCode.toDataURL(qrUrl, {
      width: 160,
      margin: 1,
    });
  }
}

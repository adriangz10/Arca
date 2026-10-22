import type {
  TipoComprobante,
  TipoDocumento,
  TipoConcepto,
  TipoAlicuotaIva,
  TipoCondicionIvaReceptor,
} from "../constants/arca.constants.js";
import type { ItemFacturaPdf } from "../services/pdf.service.js";

export interface ItemIva {
  id: TipoAlicuotaIva;
  baseImponible: number;
  importe: number;
}

export interface ComprobanteAsociado {
  tipo: TipoComprobante;
  puntoVenta: number;
  numero: number;
  cuitEmisor?: string | number;
}

export interface TributoOpcional {
  id: number;
  desc?: string;
  baseImp: number;
  alic: number;
  importe: number;
}

export interface DatoOpcional {
  id: number; // Ej: 2101 para CBU de Factura de Crédito Electrónica
  valor: string;
}

export interface EmitirComprobanteInput {
  puntoVenta?: number;
  tipoComprobante: TipoComprobante;
  concepto?: TipoConcepto;
  tipoDocumento: TipoDocumento;
  numeroDocumento: number | string;
  condicionIvaReceptor: TipoCondicionIvaReceptor;
  
  // Datos opcionales para membrete y PDF
  emisorRazonSocial?: string;
  emisorDomicilio?: string;
  receptorRazonSocial?: string;
  receptorDomicilio?: string;
  items?: ItemFacturaPdf[];
  generarPdf?: boolean;

  // Fechas (formato YYYYMMDD opcional)
  fechaComprobante?: string;
  fechaServicioDesde?: string;
  fechaServicioHasta?: string;
  fechaVencimientoPago?: string;

  // Importes
  importeNeto: number;
  importeIva?: number;
  importeTotal: number;
  importeNoGravado?: number;
  importeExento?: number;
  importeTributos?: number;

  // Desglose de IVA
  alicuotasIva?: ItemIva[];

  // Desglose de Tributos / Percepciones
  tributos?: TributoOpcional[];

  // Opcionales (CBU para MiPyMEs, etc.)
  opcionales?: DatoOpcional[];

  // Moneda
  monedaId?: string;
  monedaCotizacion?: number;

  // Comprobantes asociados (obligatorio para Notas de Crédito / Débito)
  comprobantesAsociados?: ComprobanteAsociado[];
}

export interface EmitirFacturaBInput {
  puntoVenta?: number;
  dniOCuit?: number | string;
  receptorRazonSocial?: string;
  receptorDomicilio?: string;
  condicionIva?: TipoCondicionIvaReceptor;
  importeNeto: number;
  alicuotaIva?: TipoAlicuotaIva;
  concepto?: TipoConcepto;
  fechaComprobante?: string;
  fechaServicioDesde?: string;
  fechaServicioHasta?: string;
  fechaVencimientoPago?: string;
  items?: ItemFacturaPdf[];
  generarPdf?: boolean;
}

export interface EmitirFacturaAInput {
  puntoVenta?: number;
  cuitReceptor: number | string;
  receptorRazonSocial?: string;
  receptorDomicilio?: string;
  importeNeto: number;
  alicuotasIva: ItemIva[];
  concepto?: TipoConcepto;
  fechaComprobante?: string;
  fechaServicioDesde?: string;
  fechaServicioHasta?: string;
  fechaVencimientoPago?: string;
  tributos?: TributoOpcional[];
  items?: ItemFacturaPdf[];
  generarPdf?: boolean;
}

export interface EmitirFacturaCInput {
  puntoVenta?: number;
  docTipo?: TipoDocumento;
  docNro?: number | string;
  receptorRazonSocial?: string;
  receptorDomicilio?: string;
  condicionIvaReceptor?: TipoCondicionIvaReceptor;
  importeTotal: number;
  concepto?: TipoConcepto;
  fechaComprobante?: string;
  fechaServicioDesde?: string;
  fechaServicioHasta?: string;
  fechaVencimientoPago?: string;
  tributos?: TributoOpcional[];
  items?: ItemFacturaPdf[];
  generarPdf?: boolean;
}

export interface EmitirFacturaMInput {
  puntoVenta?: number;
  cuitReceptor: number | string;
  receptorRazonSocial?: string;
  receptorDomicilio?: string;
  importeNeto: number;
  alicuotasIva: ItemIva[];
  concepto?: TipoConcepto;
  fechaComprobante?: string;
  tributos?: TributoOpcional[];
  items?: ItemFacturaPdf[];
  generarPdf?: boolean;
}

export interface EmitirNotaDebitoInput {
  puntoVenta?: number;
  tipoNotaDebito: TipoComprobante; // NOTA_DEBITO_A, NOTA_DEBITO_B, NOTA_DEBITO_C
  tipoDocumento: TipoDocumento;
  numeroDocumento: number | string;
  receptorRazonSocial?: string;
  condicionIvaReceptor: TipoCondicionIvaReceptor;
  importeNeto: number;
  importeIva?: number;
  alicuotasIva?: ItemIva[];
  comprobanteAsociado: ComprobanteAsociado;
  concepto?: TipoConcepto;
  fechaComprobante?: string;
  items?: ItemFacturaPdf[];
  generarPdf?: boolean;
}

export interface EmitirNotaCreditoInput {
  puntoVenta?: number;
  tipoNotaCredito: TipoComprobante; // NOTA_CREDITO_A, NOTA_CREDITO_B, NOTA_CREDITO_C
  tipoDocumento: TipoDocumento;
  numeroDocumento: number | string;
  receptorRazonSocial?: string;
  condicionIvaReceptor: TipoCondicionIvaReceptor;
  importeNeto: number;
  importeIva?: number;
  alicuotasIva?: ItemIva[];
  comprobanteAsociado: ComprobanteAsociado;
  concepto?: TipoConcepto;
  fechaComprobante?: string;
  items?: ItemFacturaPdf[];
  generarPdf?: boolean;
}

export interface EmitirReciboInput {
  puntoVenta?: number;
  tipoRecibo: TipoComprobante; // RECIBO_A, RECIBO_B, RECIBO_C
  tipoDocumento: TipoDocumento;
  numeroDocumento: number | string;
  receptorRazonSocial?: string;
  condicionIvaReceptor: TipoCondicionIvaReceptor;
  importeTotal: number;
  importeNeto?: number;
  alicuotasIva?: ItemIva[];
  fechaComprobante?: string;
  items?: ItemFacturaPdf[];
  generarPdf?: boolean;
}

export interface EmitirFceInput {
  puntoVenta?: number;
  tipoFce: typeof import("../constants/arca.constants.js").CbteTipo.FCE_A | typeof import("../constants/arca.constants.js").CbteTipo.FCE_B | typeof import("../constants/arca.constants.js").CbteTipo.FCE_C;
  cuitReceptor: number | string;
  cbuEmisor: string; // 22 dígitos obligatorio para MiPyMEs
  cbuAlias?: string;
  receptorRazonSocial?: string;
  importeNeto: number;
  alicuotasIva?: ItemIva[];
  fechaComprobante?: string;
  fechaVencimientoPago: string; // Obligatorio para FCE
  items?: ItemFacturaPdf[];
  generarPdf?: boolean;
}

export interface ComprobanteEmitidoResultado {
  exito: boolean;
  cae: string;
  caeVencimiento: string;
  numeroComprobante: number;
  puntoVenta: number;
  tipoComprobante: TipoComprobante;
  fechaEmision: string;
  importeTotal: number;
  resultadoCabecera?: string;
  observaciones?: Array<{ code: number; msg: string }>;
  qrData?: {
    rawJson: string;
    base64Json: string;
    url: string;
  };
  pdf?: {
    filePath: string;
    fileName: string;
  };
  rawResponse: unknown;
}

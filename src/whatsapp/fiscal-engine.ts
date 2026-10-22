import {
  CbteTipo,
  Concepto,
  CondicionIVAReceptor,
  DocTipo,
  IvaAlicuota,
  type TipoAlicuotaIva,
  type TipoComprobante,
  type TipoCondicionIvaReceptor,
  type TipoConcepto,
  type TipoDocumento,
} from "../constants/arca.constants.js";
import type { EmitirComprobanteInput } from "../types/billing.types.js";
import type { FacturaRegistro } from "../storage/invoice-history.storage.js";
import { validarCuit } from "../utils/validation.utils.js";
import { NOMBRE_CONDICION_IVA } from "../constants/condicion-iva.js";
import type { WhatsAppBotConfig } from "./whatsapp.config.js";

/**
 * Motor fiscal 100% determinístico: la IA solo aporta datos sueltos (monto, CUIT,
 * descripción). Acá se decide el tipo de comprobante, se calculan Neto/IVA/Total al
 * centavo y se aplican las reglas de ARCA. Nada de esto depende del LLM.
 */

/** Datos que se van juntando durante la conversación. */
export interface BorradorFactura {
  montoTotal?: number;
  ivaIncluido?: boolean;
  alicuotaIva?: number; // porcentaje: 21, 10.5, 27...
  receptorDocumento?: string;
  receptorNombre?: string;
  receptorDomicilio?: string;
  receptorCondicionIva?: TipoCondicionIvaReceptor;
  consumidorFinal?: boolean;
  conceptoDescripcion?: string;
  tipoConcepto?: 1 | 2 | 3;
  /** Documento para el que ya se consultó el padrón (para no repetir la consulta). */
  padronConsultadoPara?: string;
}

export type CampoFaltante = "monto" | "concepto" | "documento" | "condicion_iva";

export interface FacturaResuelta {
  cbteTipo: TipoComprobante;
  letra: "A" | "B" | "C";
  concepto: TipoConcepto;
  docTipo: TipoDocumento;
  docNro: number;
  condicionIvaReceptor: TipoCondicionIvaReceptor;
  receptorNombre: string;
  receptorDomicilio?: string;
  descripcion: string;
  neto: number;
  iva: number;
  total: number;
  alicuotaPct: number;
  alicuotaId?: TipoAlicuotaIva;
}

export type ResultadoResolucion =
  | { tipo: "FALTA_DATO"; campo: CampoFaltante; faltantes?: CampoFaltante[]; mensaje: string }
  | { tipo: "INVALIDO"; campo: CampoFaltante; mensaje: string }
  | { tipo: "LISTO"; factura: FacturaResuelta };

const ALICUOTAS: Record<string, TipoAlicuotaIva> = {
  "0": IvaAlicuota.IVA_0,
  "2.5": IvaAlicuota.IVA_2_5,
  "5": IvaAlicuota.IVA_5,
  "10.5": IvaAlicuota.IVA_10_5,
  "21": IvaAlicuota.IVA_21,
  "27": IvaAlicuota.IVA_27,
};

export { NOMBRE_CONDICION_IVA };

const NOMBRE_CONCEPTO: Record<number, string> = { 1: "Productos", 2: "Servicios", 3: "Productos y Servicios" };

export function redondear(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatearPesos(n: number): string {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(n);
}

export function formatearCuit(doc: string | number): string {
  const s = String(doc);
  return s.length === 11 ? `${s.slice(0, 2)}-${s.slice(2, 10)}-${s.slice(10)}` : s;
}

export function clasificarDocumento(doc: string): { docTipo: TipoDocumento; valido: boolean } {
  const digits = doc.replace(/\D/g, "");
  if (digits.length === 11) return { docTipo: DocTipo.CUIT, valido: validarCuit(digits) };
  if (digits.length >= 7 && digits.length <= 8) return { docTipo: DocTipo.DNI, valido: true };
  return { docTipo: DocTipo.DNI, valido: false };
}

export function resolverFactura(b: BorradorFactura, config: WhatsAppBotConfig): ResultadoResolucion {
  // 1-2-3. Datos básicos: se informan TODOS los que falten en un solo mensaje.
  const faltantes: CampoFaltante[] = [];
  const lineas: string[] = [];
  if (!b.montoTotal || b.montoTotal <= 0) {
    faltantes.push("monto");
    lineas.push("• *El monto* (ej: _130.000_)");
  }
  if (!b.conceptoDescripcion) {
    faltantes.push("concepto");
    lineas.push("• *Qué vendiste* (ej: _venta de pintura_)");
  }
  if (!b.receptorDocumento && !b.consumidorFinal) {
    faltantes.push("documento");
    lineas.push("• *El cliente*: pasame su CUIT o DNI, o tocá _Consumidor Final_");
  }

  if (faltantes.length > 0) {
    const tengo = [
      b.conceptoDescripcion,
      b.montoTotal ? formatearPesos(b.montoTotal) : undefined,
      b.receptorNombre,
    ].filter(Boolean);
    const encabezado = tengo.length > 0 ? `📝 Anoté: ${tengo.join(" – ")}\n\n` : "";
    return {
      tipo: "FALTA_DATO",
      campo: faltantes[0],
      faltantes,
      mensaje: `${encabezado}Para emitir la factura me falta:\n${lineas.join("\n")}`,
    };
  }
  // A partir de acá monto y concepto están definidos.
  const montoTotal = b.montoTotal!;
  const conceptoDescripcion = b.conceptoDescripcion!;

  // 3. Receptor
  let docTipo: TipoDocumento = DocTipo.CONSUMIDOR_FINAL;
  let docNro = 0;
  let condicion: TipoCondicionIvaReceptor | undefined = b.receptorCondicionIva;

  if (b.receptorDocumento) {
    const clasif = clasificarDocumento(b.receptorDocumento);
    if (!clasif.valido) {
      return {
        tipo: "INVALIDO",
        campo: "documento",
        mensaje: `El documento *${b.receptorDocumento}* no es válido (revisá los dígitos). Pasame el CUIT (11 dígitos) o DNI correcto, o escribí _consumidor final_.`,
      };
    }
    docTipo = clasif.docTipo;
    docNro = Number(b.receptorDocumento.replace(/\D/g, ""));
    if (docTipo === DocTipo.DNI) condicion = CondicionIVAReceptor.CONSUMIDOR_FINAL;
  } else {
    condicion = CondicionIVAReceptor.CONSUMIDOR_FINAL;
  }

  if (docTipo === DocTipo.CUIT && !condicion) {
    return {
      tipo: "FALTA_DATO",
      campo: "condicion_iva",
      mensaje: `No pude consultar la condición frente al IVA del CUIT ${formatearCuit(docNro)}. ¿Qué es el cliente?`,
    };
  }
  const condicionFinal = condicion ?? CondicionIVAReceptor.CONSUMIDOR_FINAL;

  // 4. Tipo de comprobante (el usuario nunca lo elige)
  let cbteTipo: TipoComprobante;
  let letra: "A" | "B" | "C";
  if (config.emisorCondicion === "RESPONSABLE_INSCRIPTO") {
    const recibeA =
      docTipo === DocTipo.CUIT &&
      (condicionFinal === CondicionIVAReceptor.RESPONSABLE_INSCRIPTO ||
        condicionFinal === CondicionIVAReceptor.RESPONSABLE_MONOTRIBUTO ||
        condicionFinal === CondicionIVAReceptor.MONOTRIBUTISTA_SOCIAL);
    cbteTipo = recibeA ? CbteTipo.FACTURA_A : CbteTipo.FACTURA_B;
    letra = recibeA ? "A" : "B";
  } else {
    cbteTipo = CbteTipo.FACTURA_C;
    letra = "C";
  }

  // 5. Importes (al centavo)
  let neto: number;
  let iva: number;
  let total: number;
  let alicuotaPct = 0;
  let alicuotaId: TipoAlicuotaIva | undefined;

  if (letra === "C") {
    total = redondear(montoTotal);
    neto = total;
    iva = 0;
  } else {
    alicuotaPct = b.alicuotaIva ?? 21;
    alicuotaId = ALICUOTAS[String(alicuotaPct)];
    if (alicuotaId === undefined) {
      return {
        tipo: "INVALIDO",
        campo: "monto",
        mensaje: `La alícuota de IVA ${alicuotaPct}% no es válida. Usá 21, 10.5, 27, 5, 2.5 o 0.`,
      };
    }
    const tasa = alicuotaPct / 100;
    if (b.ivaIncluido === false) {
      neto = redondear(montoTotal);
      iva = redondear(neto * tasa);
      total = redondear(neto + iva);
    } else {
      total = redondear(montoTotal);
      neto = redondear(total / (1 + tasa));
      iva = redondear(total - neto);
    }
  }

  // 6. Tope de Consumidor Final anónimo
  if (docTipo === DocTipo.CONSUMIDOR_FINAL && total >= config.topeConsumidorFinal) {
    return {
      tipo: "FALTA_DATO",
      campo: "documento",
      mensaje: `Por el monto (${formatearPesos(total)}), ARCA exige identificar al comprador. Pasame su DNI o CUIT/CUIL.`,
    };
  }

  const receptorNombre =
    b.receptorNombre ??
    (docTipo === DocTipo.CUIT ? `Cliente CUIT ${formatearCuit(docNro)}` : "Consumidor Final");

  return {
    tipo: "LISTO",
    factura: {
      cbteTipo,
      letra,
      concepto: (b.tipoConcepto ?? config.conceptoDefault) as TipoConcepto,
      docTipo,
      docNro,
      condicionIvaReceptor: condicionFinal,
      receptorNombre,
      receptorDomicilio: b.receptorDomicilio,
      descripcion: conceptoDescripcion,
      neto,
      iva,
      total,
      alicuotaPct,
      alicuotaId,
    },
  };
}

export function armarResumen(f: FacturaResuelta): string {
  const doc =
    f.docTipo === DocTipo.CONSUMIDOR_FINAL
      ? ""
      : f.docTipo === DocTipo.CUIT
        ? ` (CUIT ${formatearCuit(f.docNro)})`
        : ` (DNI ${f.docNro})`;

  const lineas = [
    "📄 *Resumen para emitir:*",
    `• Tipo: Factura ${f.letra} (${NOMBRE_CONCEPTO[f.concepto]})`,
    `• Cliente: ${f.receptorNombre}${doc}`,
    `• Condición IVA: ${NOMBRE_CONDICION_IVA[f.condicionIvaReceptor] ?? f.condicionIvaReceptor}`,
    `• Concepto: ${f.descripcion}`,
  ];
  if (f.letra !== "C") {
    lineas.push(`• Neto: ${formatearPesos(f.neto)}`);
    lineas.push(`• IVA ${f.alicuotaPct}%: ${formatearPesos(f.iva)}`);
  }
  lineas.push(`• *Total: ${formatearPesos(f.total)}*`);
  return lineas.join("\n");
}

export function armarInputEmision(f: FacturaResuelta, config: WhatsAppBotConfig): EmitirComprobanteInput {
  const precioItem = f.letra === "A" ? f.neto : f.total;
  return {
    tipoComprobante: f.cbteTipo,
    concepto: f.concepto,
    tipoDocumento: f.docTipo,
    numeroDocumento: f.docNro,
    condicionIvaReceptor: f.condicionIvaReceptor,
    emisorRazonSocial: config.emisorRazonSocial,
    emisorDomicilio: config.emisorDomicilio,
    receptorRazonSocial: f.receptorNombre,
    receptorDomicilio: f.receptorDomicilio,
    importeNeto: f.neto,
    importeIva: f.iva,
    importeTotal: f.total,
    alicuotasIva:
      f.letra !== "C" && f.alicuotaId !== undefined && f.alicuotaId !== IvaAlicuota.IVA_0
        ? [{ id: f.alicuotaId, baseImponible: f.neto, importe: f.iva }]
        : f.letra !== "C" && f.alicuotaId === IvaAlicuota.IVA_0
          ? [{ id: IvaAlicuota.IVA_0, baseImponible: f.neto, importe: 0 }]
          : [],
    items: [
      {
        descripcion: f.descripcion,
        cantidad: 1,
        precioUnitario: precioItem,
        alicuotaIva: f.letra === "A" ? f.alicuotaPct : undefined,
        subtotal: precioItem,
      },
    ],
    generarPdf: true,
  };
}

// ---------------------------------------------------------------------------
// Anulación (Nota de Crédito vinculada)
// ---------------------------------------------------------------------------

const NOTA_CREDITO_PARA: Partial<Record<number, TipoComprobante>> = {
  [CbteTipo.FACTURA_A]: CbteTipo.NOTA_CREDITO_A,
  [CbteTipo.FACTURA_B]: CbteTipo.NOTA_CREDITO_B,
  [CbteTipo.FACTURA_C]: CbteTipo.NOTA_CREDITO_C,
  [CbteTipo.FACTURA_M]: CbteTipo.NOTA_CREDITO_M,
};

export function esFacturaAnulable(tipo: number): boolean {
  return NOTA_CREDITO_PARA[tipo] !== undefined;
}

function docTipoDesdeRegistro(f: FacturaRegistro): TipoDocumento {
  const nro = Number(String(f.receptorDocNro).replace(/\D/g, ""));
  if (!nro) return DocTipo.CONSUMIDOR_FINAL;
  if (f.receptorDocTipo === "CUIT") return DocTipo.CUIT;
  if (f.receptorDocTipo === "DNI") return DocTipo.DNI;
  return String(nro).length === 11 ? DocTipo.CUIT : DocTipo.DNI;
}

/** Arma una Nota de Crédito por el total de la factura original, vinculada a ella. */
export function armarNotaCredito(original: FacturaRegistro, config: WhatsAppBotConfig): EmitirComprobanteInput {
  const tipoNc = NOTA_CREDITO_PARA[original.tipoComprobante];
  if (!tipoNc) {
    throw new Error(`El comprobante ${original.tipoComprobanteNombre} no se puede anular con Nota de Crédito.`);
  }

  const condicion = Number(original.receptorCondicionIva);
  const docTipo = docTipoDesdeRegistro(original);

  return {
    puntoVenta: original.puntoVenta,
    tipoComprobante: tipoNc,
    concepto: (original.concepto as TipoConcepto) ?? Concepto.PRODUCTOS,
    tipoDocumento: docTipo,
    numeroDocumento: docTipo === DocTipo.CONSUMIDOR_FINAL ? 0 : String(original.receptorDocNro),
    condicionIvaReceptor: (Number.isFinite(condicion) && condicion > 0
      ? condicion
      : CondicionIVAReceptor.CONSUMIDOR_FINAL) as TipoCondicionIvaReceptor,
    emisorRazonSocial: config.emisorRazonSocial ?? original.emisorRazonSocial,
    emisorDomicilio: config.emisorDomicilio,
    receptorRazonSocial: original.receptorRazonSocial,
    receptorDomicilio: original.receptorDomicilio,
    fechaServicioDesde: original.fechaServicioDesde,
    fechaServicioHasta: original.fechaServicioHasta,
    importeNeto: original.importeNeto,
    importeIva: original.importeIva,
    importeTributos: original.importeTributos,
    importeTotal: original.importeTotal,
    alicuotasIva: original.alicuotasIva,
    tributos: original.tributos,
    items: (original.items ?? []).map((i) => ({ ...i, descripcion: `Anulación: ${i.descripcion}` })),
    comprobantesAsociados: [
      {
        tipo: original.tipoComprobante,
        puntoVenta: original.puntoVenta,
        numero: original.numeroComprobante,
      },
    ],
    generarPdf: true,
  };
}

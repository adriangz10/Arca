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
import type { CondicionIvaEmisor } from "../empresas/empresa.types.js";
import { validarCuit } from "../utils/validation.utils.js";

/** Código de opcional de ARCA: CBU del emisor (FCE). */
export const OPCIONAL_CBU = 2101;
/** Código de opcional de ARCA: opción de transferencia de la FCE (SCA / ADC). */
export const OPCIONAL_TRANSFERENCIA = 27;
import { NOMBRE_CONDICION_IVA } from "../constants/condicion-iva.js";

export { NOMBRE_CONDICION_IVA };

/**
 * Motor fiscal 100% determinístico. La IA solo aporta datos sueltos del primer mensaje
 * (monto, descripción); acá se decide el documento, la condición frente al IVA, la letra
 * de la factura y los importes al centavo, siguiendo las reglas de ARCA (WSFEv1).
 *
 *  Cliente informa          DocTipo  Condición IVA       Emisor RI   Emisor Mono/Exento
 *  Nada (< tope)             99       5 Cons. Final       B           C
 *  DNI (7-8 dígitos)         96       5 Cons. Final       B           C
 *  11 díg. sin alta (CUIL)   86       5 Cons. Final       B           C
 *  11 díg. IVA Exento        80       4 Exento            B           C
 *  11 díg. Monotributo       80       6 Monotributista    A           C
 *  11 díg. Resp. Inscripto   80       1 Resp. Inscripto   A           C
 */

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type TipoCliente = "CONSUMIDOR_FINAL" | "DNI" | "CUIT";
export type CondicionReceptor = "RESPONSABLE_INSCRIPTO" | "MONOTRIBUTO" | "EXENTO" | "CONSUMIDOR_FINAL";

/** Lo que se sabe del emisor (empresa activa) y de las reglas, para decidir. */
export interface ContextoEmisor {
  cuit: number;
  condicion: CondicionIvaEmisor;
  conceptoDefault: 1 | 2 | 3;
  consumidorFinalTope: number;
  /** CBU del emisor (para Factura de Crédito MiPyME). */
  cbu?: string;
}

/** Venta que se va armando paso a paso. `null` = el usuario salteó ese dato. */
export interface BorradorVenta {
  montoTotal?: number;
  ivaIncluido?: boolean;
  alicuotaIva?: number;
  descripcion?: string;
  tipoConcepto?: 1 | 2 | 3;

  tipoCliente?: TipoCliente;
  /** Solo dígitos. */
  documento?: string;
  /** Si el documento de 11 dígitos se trata como CUIT (80) o CUIL (86). */
  docTipo?: TipoDocumento;
  condicion?: CondicionReceptor;
  /** Condición que dijo el usuario ("es responsable inscripto"), se usa si el padrón no responde. */
  condicionDeclarada?: CondicionReceptor;
  nombre?: string | null;
  domicilio?: string | null;

  /** Documento para el que ya se consultó el padrón. */
  padronConsultadoPara?: string;
  /** Resultado de wsfecred para `documento`: si el cliente está obligado a recibir FCE. */
  fce?: { para: string; estado: "OBLIGADO" | "NO_OBLIGADO" | "NO_VERIFICADO"; montoDesde?: number };
  /** Días hasta el vencimiento del pago (solo FCE). */
  vencimientoDias?: number;
  /** Con un DNI se encontró un CUIT con impuestos activos: se pregunta a cuál facturar. */
  sugerenciaCuit?: { cuit: string; nombre?: string; domicilio?: string; condicion: CondicionReceptor };
}

export type PasoVenta =
  | "monto"
  | "descripcion"
  | "tipo_cliente"
  | "documento"
  | "elegir_cuit_o_dni"
  | "condicion"
  | "nombre"
  | "domicilio"
  | "cbu"
  | "vencimiento_pago"
  | "confirmar";

export interface Comprobante {
  cbteTipo: TipoComprobante;
  letra: "A" | "B" | "C";
  /** Factura de Crédito Electrónica MiPyME. */
  fce: boolean;
  /** Por qué sale esta letra, en una línea para el usuario. */
  motivo: string;
}

export interface FacturaResuelta {
  cbteTipo: TipoComprobante;
  letra: "A" | "B" | "C";
  motivo: string;
  /** Datos de la Factura de Crédito MiPyME (si corresponde). */
  fce?: { cbu: string; vencimientoPago: string; transferencia: "SCA" | "ADC" };
  /** Aviso para el resumen (ej: no se pudo verificar si correspondía FCE). */
  aviso?: string;
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

// ---------------------------------------------------------------------------
// Utilidades de formato
// ---------------------------------------------------------------------------

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

export function formatearDni(doc: string | number): string {
  return String(doc).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const NOMBRE_CONCEPTO: Record<number, string> = { 1: "Productos", 2: "Servicios", 3: "Productos y Servicios" };

export const NOMBRE_CONDICION_RECEPTOR: Record<CondicionReceptor, string> = {
  RESPONSABLE_INSCRIPTO: "Responsable Inscripto",
  MONOTRIBUTO: "Monotributista",
  EXENTO: "IVA Exento",
  CONSUMIDOR_FINAL: "Consumidor Final",
};

/**
 * Deja solo la descripción de lo vendido: saca montos, CUIT/DNI y muletillas que a veces
 * quedan pegados ("Nueva venta de pintura por 123.450" -> "Venta de pintura").
 */
export function limpiarConcepto(desc: string): string {
  let d = desc
    .replace(/\s+(?:al|a|para)\s+(?:cuit|cuil|dni)\b.*$/i, "")
    .replace(/\s+(?:por|de|x|en)\s+\$?\s*\d[\d.,]*.*$/i, "")
    .replace(/\s+\$\s*\d[\d.,]*.*$/, "")
    .replace(/^(?:una?|nuev[oa]s?|otra?)\s+/i, "")
    .replace(/[\s,.;:-]+$/, "")
    .trim();
  if (!d) d = desc.trim();
  return d.charAt(0).toUpperCase() + d.slice(1);
}

/** 1 productos, 2 servicios, 3 ambos (null si la descripción no lo deja claro). */
export function inferirTipoConcepto(desc: string): 1 | 2 | null {
  if (/servicio|honorario|mantenimiento|dise[ñn]o|desarrollo|consultor|clase|trabajo|reparaci|instalaci|asesor|alquiler/i.test(desc)) {
    return 2;
  }
  if (/venta|producto|articulo|artículo|mercader|insumo|papel|pintura|repuesto|unidad|kg|caja/i.test(desc)) return 1;
  return null;
}

// ---------------------------------------------------------------------------
// Reglas fiscales
// ---------------------------------------------------------------------------

/** Código de condición frente al IVA del receptor para ARCA (CondicionIVAReceptorId). */
export function codigoCondicion(c: CondicionReceptor): TipoCondicionIvaReceptor {
  switch (c) {
    case "RESPONSABLE_INSCRIPTO":
      return CondicionIVAReceptor.RESPONSABLE_INSCRIPTO;
    case "MONOTRIBUTO":
      return CondicionIVAReceptor.RESPONSABLE_MONOTRIBUTO;
    case "EXENTO":
      return CondicionIVAReceptor.IVA_SUJETO_EXENTO;
    default:
      return CondicionIVAReceptor.CONSUMIDOR_FINAL;
  }
}

export function condicionDesdeCodigo(code: number | undefined): CondicionReceptor | undefined {
  if (code === CondicionIVAReceptor.RESPONSABLE_INSCRIPTO) return "RESPONSABLE_INSCRIPTO";
  if (code === CondicionIVAReceptor.RESPONSABLE_MONOTRIBUTO || code === CondicionIVAReceptor.MONOTRIBUTISTA_SOCIAL) {
    return "MONOTRIBUTO";
  }
  if (code === CondicionIVAReceptor.IVA_SUJETO_EXENTO) return "EXENTO";
  if (code === CondicionIVAReceptor.CONSUMIDOR_FINAL) return "CONSUMIDOR_FINAL";
  return undefined;
}

const CODIGO_FCE: Record<"A" | "B" | "C", TipoComprobante> = { A: CbteTipo.FCE_A, B: CbteTipo.FCE_B, C: CbteTipo.FCE_C };

/**
 * La letra depende de la condición del EMISOR, cruzada con la del receptor.
 * Con `fce` (cliente obligado a recibir Factura de Crédito MiPyME y monto mayor al mínimo)
 * la misma letra pasa a FCE: A -> 201, B -> 206, C -> 211.
 */
export function determinarComprobante(emisor: CondicionIvaEmisor, receptor: CondicionReceptor, fce = false): Comprobante {
  let base: Omit<Comprobante, "fce">;
  if (emisor === "MONOTRIBUTO" || emisor === "EXENTO") {
    base = {
      cbteTipo: CbteTipo.FACTURA_C,
      letra: "C",
      motivo: `Sos ${emisor === "MONOTRIBUTO" ? "monotributista" : "exento en IVA"}: siempre se emite Factura C, sin discriminar IVA.`,
    };
  } else if (receptor === "RESPONSABLE_INSCRIPTO" || receptor === "MONOTRIBUTO") {
    base = {
      cbteTipo: CbteTipo.FACTURA_A,
      letra: "A",
      motivo: `Sos Responsable Inscripto y el cliente es ${NOMBRE_CONDICION_RECEPTOR[receptor]}: Factura A con IVA discriminado.`,
    };
  } else {
    base = {
      cbteTipo: CbteTipo.FACTURA_B,
      letra: "B",
      motivo: `Sos Responsable Inscripto y el cliente es ${NOMBRE_CONDICION_RECEPTOR[receptor]}: Factura B (IVA incluido).`,
    };
  }
  if (!fce) return { ...base, fce: false };
  return {
    cbteTipo: CODIGO_FCE[base.letra],
    letra: base.letra,
    fce: true,
    motivo: `El cliente está obligado a recibir Factura de Crédito Electrónica MiPyME por este monto: va *FCE ${base.letra}* en lugar de Factura ${base.letra}.`,
  };
}

/** ¿Corresponde Factura de Crédito MiPyME? Cliente CUIT obligado y total ≥ monto mínimo. */
export function correspondeFce(b: BorradorVenta, total: number): boolean {
  return (
    b.docTipo === DocTipo.CUIT &&
    b.fce?.para === b.documento &&
    b.fce?.estado === "OBLIGADO" &&
    total >= (b.fce?.montoDesde ?? 0)
  );
}

/** Total con la letra que le corresponde a la venta (para comparar con topes y mínimos). */
export function totalVenta(b: BorradorVenta, ctx: ContextoEmisor): number {
  const letra = determinarComprobante(ctx.condicion, b.condicion ?? "CONSUMIDOR_FINAL").letra;
  const r = calcularImportes(b, letra);
  return "error" in r ? b.montoTotal ?? 0 : r.total;
}

/** "20261121" = hoy + días. */
export function fechaMasDias(dias: number, desde = new Date()): string {
  const d = new Date(desde.getTime() + dias * 24 * 3600_000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Clasifica lo que escribió el usuario como documento. */
export function clasificarDocumento(texto: string): { tipo: "DNI" | "CUIT"; digitos: string; valido: boolean } | null {
  const digitos = texto.replace(/\D/g, "");
  if (digitos.length === 11) return { tipo: "CUIT", digitos, valido: validarCuit(digitos) };
  if (digitos.length >= 7 && digitos.length <= 8) return { tipo: "DNI", digitos, valido: Number(digitos) > 0 };
  return null;
}

/** CUIT/CUIL posibles para un DNI (prefijos 20, 27, 23, 24), con su dígito verificador. */
export function cuitsPosiblesDesdeDni(dni: string): string[] {
  const base = dni.replace(/\D/g, "").padStart(8, "0");
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const resultado: string[] = [];
  for (const prefijo of ["20", "27", "23", "24"]) {
    const sin = `${prefijo}${base}`;
    const suma = sin.split("").reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const resto = 11 - (suma % 11);
    const dv = resto === 11 ? 0 : resto;
    if (dv === 10) continue; // ese prefijo no es válido para este DNI
    resultado.push(`${sin}${dv}`);
  }
  return resultado;
}

/** ¿Qué datos del cliente hacen falta para el tipo de documento? */
export function requiereDomicilio(b: BorradorVenta): boolean {
  return b.docTipo === DocTipo.CUIT;
}

/** Siguiente dato a pedir. El orden es fijo: así la conversación siempre es la misma. */
export function siguientePasoVenta(b: BorradorVenta, ctx: ContextoEmisor): PasoVenta {
  if (!b.montoTotal || b.montoTotal <= 0) return "monto";
  if (!b.descripcion) return "descripcion";
  if (!b.tipoCliente) return "tipo_cliente";
  if (b.tipoCliente === "CONSUMIDOR_FINAL") {
    // Desde el tope, ARCA exige identificar al comprador.
    return calcularTotal(b, ctx) >= ctx.consumidorFinalTope ? "tipo_cliente" : "confirmar";
  }
  if (!b.documento) return "documento";
  if (b.sugerenciaCuit) return "elegir_cuit_o_dni";
  if (b.tipoCliente === "CUIT" && !b.condicion) return "condicion";
  if (b.nombre === undefined) return "nombre";
  if (requiereDomicilio(b) && b.domicilio === undefined) return "domicilio";
  if (correspondeFce(b, totalVenta(b, ctx))) {
    if (!ctx.cbu) return "cbu";
    if (!b.vencimientoDias) return "vencimiento_pago";
  }
  return "confirmar";
}

function calcularTotal(b: BorradorVenta, ctx: ContextoEmisor): number {
  return totalVenta(b, ctx);
}

const ALICUOTAS: Record<string, TipoAlicuotaIva> = {
  "0": IvaAlicuota.IVA_0,
  "2.5": IvaAlicuota.IVA_2_5,
  "5": IvaAlicuota.IVA_5,
  "10.5": IvaAlicuota.IVA_10_5,
  "21": IvaAlicuota.IVA_21,
  "27": IvaAlicuota.IVA_27,
};

export function calcularImportes(
  b: BorradorVenta,
  letra: "A" | "B" | "C"
): { neto: number; iva: number; total: number; alicuotaPct: number; alicuotaId?: TipoAlicuotaIva } | { error: string } {
  const monto = b.montoTotal ?? 0;
  if (letra === "C") {
    const total = redondear(monto);
    return { neto: total, iva: 0, total, alicuotaPct: 0 };
  }
  const alicuotaPct = b.alicuotaIva ?? 21;
  const alicuotaId = ALICUOTAS[String(alicuotaPct)];
  if (alicuotaId === undefined) return { error: `La alícuota de IVA ${alicuotaPct}% no es válida. Usá 21, 10.5, 27, 5, 2.5 o 0.` };
  const tasa = alicuotaPct / 100;
  if (b.ivaIncluido === false) {
    const neto = redondear(monto);
    const iva = redondear(neto * tasa);
    return { neto, iva, total: redondear(neto + iva), alicuotaPct, alicuotaId };
  }
  const total = redondear(monto);
  const neto = redondear(total / (1 + tasa));
  return { neto, iva: redondear(total - neto), total, alicuotaPct, alicuotaId };
}

/** Con el borrador completo, arma la factura final (o explica por qué no se puede). */
export function resolverVenta(b: BorradorVenta, ctx: ContextoEmisor): { factura: FacturaResuelta } | { error: string } {
  const condicion: CondicionReceptor =
    b.tipoCliente === "CUIT" ? b.condicion ?? "CONSUMIDOR_FINAL" : "CONSUMIDOR_FINAL";
  const docTipo: TipoDocumento =
    b.tipoCliente === "CONSUMIDOR_FINAL" ? DocTipo.CONSUMIDOR_FINAL : b.tipoCliente === "DNI" ? DocTipo.DNI : b.docTipo ?? DocTipo.CUIT;
  const docNro = docTipo === DocTipo.CONSUMIDOR_FINAL ? 0 : Number(b.documento ?? 0);

  if (docNro && docNro === ctx.cuit) {
    return { error: `El CUIT ${formatearCuit(docNro)} es el de tu propia empresa: ARCA no permite facturarse a uno mismo.` };
  }

  const comun = determinarComprobante(ctx.condicion, condicion);
  const imp = calcularImportes(b, comun.letra);
  if ("error" in imp) return imp;
  const esFce = correspondeFce(b, imp.total);
  const comp = esFce ? determinarComprobante(ctx.condicion, condicion, true) : comun;
  if (esFce && (!ctx.cbu || !b.vencimientoDias)) {
    return { error: "Para la Factura de Crédito MiPyME faltan el CBU de la empresa o el vencimiento del pago." };
  }
  const aviso =
    docTipo === DocTipo.CUIT && b.fce?.para === b.documento && b.fce?.estado === "NO_VERIFICADO"
      ? "No pude verificar con ARCA si el cliente está obligado a recibir Factura de Crédito MiPyME (servicio wsfecred). Si es una gran empresa, revisalo antes de emitir."
      : undefined;

  const etiquetaDoc = docTipo === DocTipo.DNI ? `DNI ${formatearDni(docNro)}` : `CUIT ${formatearCuit(docNro)}`;
  return {
    factura: {
      cbteTipo: comp.cbteTipo,
      letra: comp.letra,
      motivo: comp.motivo,
      fce: esFce ? { cbu: ctx.cbu!, vencimientoPago: fechaMasDias(b.vencimientoDias!), transferencia: "SCA" } : undefined,
      aviso,
      concepto: (b.tipoConcepto ?? ctx.conceptoDefault) as TipoConcepto,
      docTipo,
      docNro,
      condicionIvaReceptor: codigoCondicion(condicion),
      receptorNombre: docTipo === DocTipo.CONSUMIDOR_FINAL ? "Consumidor Final" : b.nombre || `Cliente ${etiquetaDoc}`,
      receptorDomicilio: b.domicilio ?? undefined,
      descripcion: b.descripcion!,
      ...imp,
    },
  };
}

export function etiquetaDocumento(f: { docTipo: TipoDocumento; docNro: number }): string {
  if (f.docTipo === DocTipo.CONSUMIDOR_FINAL) return "sin identificar";
  if (f.docTipo === DocTipo.DNI) return `DNI ${formatearDni(f.docNro)}`;
  if (f.docTipo === DocTipo.CUIL) return `CUIL ${formatearCuit(f.docNro)}`;
  return `CUIT ${formatearCuit(f.docNro)}`;
}

export function armarResumen(f: FacturaResuelta): string {
  const venceFce = f.fce?.vencimientoPago.replace(/^(\d{4})(\d{2})(\d{2})$/, "$3/$2/$1");
  const lineas = [
    `📄 *${f.fce ? `Factura de Crédito Electrónica MiPyME ${f.letra}` : `Factura ${f.letra}`}* — ${NOMBRE_CONCEPTO[f.concepto]}`,
    `_${f.motivo}_`,
    "",
    `• Cliente: ${f.receptorNombre}${f.docTipo === DocTipo.CONSUMIDOR_FINAL ? "" : ` (${etiquetaDocumento(f)})`}`,
    `• Condición IVA: ${NOMBRE_CONDICION_IVA[f.condicionIvaReceptor] ?? f.condicionIvaReceptor}`,
    f.receptorDomicilio ? `• Domicilio: ${f.receptorDomicilio}` : null,
    `• Concepto: ${f.descripcion}`,
  ];
  if (f.letra === "A") {
    lineas.push(`• Neto gravado: ${formatearPesos(f.neto)}`);
    lineas.push(`• IVA ${f.alicuotaPct}%: ${formatearPesos(f.iva)}`);
  }
  lineas.push(`• *Total: ${formatearPesos(f.total)}*`);
  if (f.fce) {
    lineas.push(`• CBU para el pago: ${f.fce.cbu}`);
    lineas.push(`• Vencimiento del pago: ${venceFce}`);
    lineas.push("• Transferencia: Sistema de Circulación Abierta (SCA)");
  }
  if (f.aviso) lineas.push("", `⚠️ ${f.aviso}`);
  return lineas.filter((l) => l !== null).join("\n");
}

export function armarInputEmision(f: FacturaResuelta): EmitirComprobanteInput {
  // En la A el precio unitario va neto; en B y C, final.
  const precioItem = f.letra === "A" ? f.neto : f.total;
  return {
    tipoComprobante: f.cbteTipo,
    concepto: f.concepto,
    tipoDocumento: f.docTipo,
    numeroDocumento: f.docNro,
    condicionIvaReceptor: f.condicionIvaReceptor,
    receptorRazonSocial: f.receptorNombre,
    receptorDomicilio: f.receptorDomicilio,
    importeNeto: f.neto,
    importeIva: f.iva,
    importeTotal: f.total,
    alicuotasIva:
      f.letra !== "C" && f.alicuotaId !== undefined
        ? [{ id: f.alicuotaId, baseImponible: f.neto, importe: f.alicuotaId === IvaAlicuota.IVA_0 ? 0 : f.iva }]
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
    ...(f.fce
      ? {
          fechaVencimientoPago: f.fce.vencimientoPago,
          opcionales: [
            { id: OPCIONAL_CBU, valor: f.fce.cbu },
            { id: OPCIONAL_TRANSFERENCIA, valor: f.fce.transferencia },
          ],
        }
      : {}),
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
  if (f.receptorDocTipo === "CUIL") return DocTipo.CUIL;
  if (f.receptorDocTipo === "DNI") return DocTipo.DNI;
  return String(nro).length === 11 ? DocTipo.CUIT : DocTipo.DNI;
}

/** Nota de Crédito por el total de la factura original, vinculada a ella. */
export function armarNotaCredito(original: FacturaRegistro): EmitirComprobanteInput {
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
      { tipo: original.tipoComprobante, puntoVenta: original.puntoVenta, numero: original.numeroComprobante },
    ],
    generarPdf: true,
  };
}

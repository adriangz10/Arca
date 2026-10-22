import type { TipoComprobante } from "../constants/arca.constants.js";
import type { ItemFacturaPdf } from "../services/pdf.service.js";
import { execute, query, queryOne } from "../db/database.js";
import { empresaActual } from "../empresas/empresa.context.js";

export interface FacturaRegistro {
  id: string; // ej: UUID o "1-6-15" (ptoVta-tipo-numero)
  puntoVenta: number;
  tipoComprobante: TipoComprobante;
  tipoComprobanteNombre: string; // Factura B, Factura A, etc.
  tipoComprobanteLetra: "A" | "B" | "C" | "M";
  numeroComprobante: number;
  numeroFormateado: string; // "00001-00000015"
  fechaEmision: string; // YYYYMMDD
  fechaEmisionFormateada: string; // DD/MM/YYYY
  
  // Cliente / Receptor
  receptorRazonSocial: string;
  receptorDocTipo: string; // CUIT, DNI, Consumidor Final
  receptorDocNro: string | number;
  receptorCondicionIva: string;
  receptorDomicilio?: string;

  // Importes
  importeNeto: number;
  importeIva: number;
  importeTributos: number;
  importeTotal: number;
  
  // Items detallados
  items?: ItemFacturaPdf[];

  // Datos ARCA
  cae: string;
  caeVencimiento: string;
  qrUrl: string;
  pdfPath?: string;
  pdfFileName?: string;

  createdAt: string;

  // Nuevos campos agregados
  concepto?: number;
  fechaServicioDesde?: string;
  fechaServicioHasta?: string;
  fechaVencimientoPago?: string;
  monedaId?: string;
  monedaCotizacion?: number;
  alicuotasIva?: any[];
  tributos?: any[];
  comprobantesAsociados?: any[];
  opcionales?: any[];
  arcaResultado?: string;
  arcaObservaciones?: any[];
  emisorCuit?: number | string;
  emisorRazonSocial?: string;
  empresaId?: number;
}

interface InvoiceDbRow {
  id: string;
  punto_venta: number;
  tipo_comprobante: number;
  tipo_comprobante_nombre: string;
  tipo_comprobante_letra: "A" | "B" | "C" | "M";
  numero_comprobante: number;
  numero_formateado: string;
  fecha_emision: string;
  fecha_emision_formateada: string;
  receptor_razon_social: string;
  receptor_doc_tipo: string;
  receptor_doc_nro: string;
  receptor_condicion_iva: string;
  receptor_domicilio: string | null;
  importe_neto: number;
  importe_iva: number;
  importe_tributos: number;
  importe_total: number;
  items_json: string | null;
  cae: string;
  cae_vencimiento: string;
  qr_url: string;
  pdf_path: string | null;
  pdf_file_name: string | null;
  created_at: string;
  
  concepto: number | null;
  fecha_servicio_desde: string | null;
  fecha_servicio_hasta: string | null;
  fecha_vencimiento_pago: string | null;
  moneda_id: string | null;
  moneda_cotizacion: number | null;
  alicuotas_iva_json: string | null;
  tributos_json: string | null;
  comprobantes_asociados_json: string | null;
  opcionales_json: string | null;
  arca_resultado: string | null;
  arca_observaciones_json: string | null;
  emisor_cuit: number | null;
  emisor_razon_social: string | null;
  empresa_id: number | null;
}

function safeParseJSON(json: string | null) {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function mapRowToRecord(row: InvoiceDbRow): FacturaRegistro {
  return {
    id: row.id,
    puntoVenta: row.punto_venta,
    tipoComprobante: row.tipo_comprobante as TipoComprobante,
    tipoComprobanteNombre: row.tipo_comprobante_nombre,
    tipoComprobanteLetra: row.tipo_comprobante_letra,
    numeroComprobante: row.numero_comprobante,
    numeroFormateado: row.numero_formateado,
    fechaEmision: row.fecha_emision,
    fechaEmisionFormateada: row.fecha_emision_formateada,
    receptorRazonSocial: row.receptor_razon_social,
    receptorDocTipo: row.receptor_doc_tipo,
    receptorDocNro: isNaN(Number(row.receptor_doc_nro)) ? row.receptor_doc_nro : Number(row.receptor_doc_nro),
    receptorCondicionIva: row.receptor_condicion_iva,
    receptorDomicilio: row.receptor_domicilio ?? undefined,
    importeNeto: row.importe_neto,
    importeIva: row.importe_iva,
    importeTributos: row.importe_tributos,
    importeTotal: row.importe_total,
    items: safeParseJSON(row.items_json),
    cae: row.cae,
    caeVencimiento: row.cae_vencimiento,
    qrUrl: row.qr_url,
    pdfPath: row.pdf_path ?? undefined,
    pdfFileName: row.pdf_file_name ?? undefined,
    createdAt: row.created_at,
    
    concepto: row.concepto ?? undefined,
    fechaServicioDesde: row.fecha_servicio_desde ?? undefined,
    fechaServicioHasta: row.fecha_servicio_hasta ?? undefined,
    fechaVencimientoPago: row.fecha_vencimiento_pago ?? undefined,
    monedaId: row.moneda_id ?? undefined,
    monedaCotizacion: row.moneda_cotizacion ?? undefined,
    alicuotasIva: safeParseJSON(row.alicuotas_iva_json),
    tributos: safeParseJSON(row.tributos_json),
    comprobantesAsociados: safeParseJSON(row.comprobantes_asociados_json),
    opcionales: safeParseJSON(row.opcionales_json),
    arcaResultado: row.arca_resultado ?? undefined,
    arcaObservaciones: safeParseJSON(row.arca_observaciones_json),
    emisorCuit: row.emisor_cuit != null ? Number(row.emisor_cuit) : undefined,
    emisorRazonSocial: row.emisor_razon_social ?? undefined,
    empresaId: row.empresa_id ?? undefined,
  };
}

const COLUMNAS_INSERT = [
  "id", "empresa_id", "emisor_cuit", "emisor_razon_social", "punto_venta", "tipo_comprobante",
  "tipo_comprobante_nombre", "tipo_comprobante_letra", "numero_comprobante", "numero_formateado",
  "fecha_emision", "fecha_emision_formateada", "receptor_razon_social", "receptor_doc_tipo",
  "receptor_doc_nro", "receptor_condicion_iva", "receptor_domicilio", "importe_neto", "importe_iva",
  "importe_tributos", "importe_total", "items_json", "cae", "cae_vencimiento", "qr_url", "pdf_path",
  "pdf_file_name", "concepto", "fecha_servicio_desde", "fecha_servicio_hasta", "fecha_vencimiento_pago",
  "moneda_id", "moneda_cotizacion", "alicuotas_iva_json", "tributos_json", "comprobantes_asociados_json",
  "opcionales_json", "arca_resultado", "arca_observaciones_json", "created_at",
];

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/** CUIT del emisor por el que se filtra: el explícito, o el de la empresa del contexto. */
function cuitFiltro(explicito?: number): number | undefined {
  return explicito ?? empresaActual()?.cuit;
}

export class InvoiceHistoryStorage {
  /** Guarda (o actualiza, si ya existía ese número fiscal) un comprobante emitido. */
  public static async save(
    factura: Omit<FacturaRegistro, "id" | "createdAt"> & { id?: string }
  ): Promise<FacturaRegistro> {
    const empresa = empresaActual();
    const emisorCuit = Number(factura.emisorCuit ?? empresa?.cuit ?? 0);
    const empresaId = factura.empresaId ?? empresa?.id ?? null;
    const id =
      factura.id ?? `${emisorCuit}-${factura.puntoVenta}-${factura.tipoComprobante}-${factura.numeroComprobante}`;
    const createdAt = new Date().toISOString();

    const valores = [
      id, empresaId, emisorCuit, factura.emisorRazonSocial ?? empresa?.razonSocial ?? null, factura.puntoVenta,
      factura.tipoComprobante, factura.tipoComprobanteNombre, factura.tipoComprobanteLetra,
      factura.numeroComprobante, factura.numeroFormateado, factura.fechaEmision, factura.fechaEmisionFormateada,
      factura.receptorRazonSocial, factura.receptorDocTipo, String(factura.receptorDocNro),
      String(factura.receptorCondicionIva), factura.receptorDomicilio ?? null, factura.importeNeto,
      factura.importeIva, factura.importeTributos, factura.importeTotal, json(factura.items), factura.cae,
      factura.caeVencimiento, factura.qrUrl, factura.pdfPath ?? null, factura.pdfFileName ?? null,
      factura.concepto ?? null, factura.fechaServicioDesde ?? null, factura.fechaServicioHasta ?? null,
      factura.fechaVencimientoPago ?? null, factura.monedaId ?? "PES", factura.monedaCotizacion ?? 1,
      json(factura.alicuotasIva), json(factura.tributos), json(factura.comprobantesAsociados),
      json(factura.opcionales), factura.arcaResultado ?? null, json(factura.arcaObservaciones), createdAt,
    ];

    // Ante el mismo número fiscal se actualizan los datos, pero se conservan id y fecha de alta.
    const actualizables = COLUMNAS_INSERT.filter((c) => !["id", "created_at", "emisor_cuit", "punto_venta",
      "tipo_comprobante", "numero_comprobante"].includes(c));
    await execute(
      `INSERT INTO invoices (${COLUMNAS_INSERT.join(", ")})
       VALUES (${COLUMNAS_INSERT.map(() => "?").join(", ")})
       ON DUPLICATE KEY UPDATE ${actualizables.map((c) => `${c} = VALUES(${c})`).join(", ")}`,
      valores
    );

    const guardada = await queryOne<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM invoices
       WHERE emisor_cuit = ? AND punto_venta = ? AND tipo_comprobante = ? AND numero_comprobante = ?`,
      [emisorCuit, factura.puntoVenta, factura.tipoComprobante, factura.numeroComprobante]
    );

    return {
      ...factura,
      emisorCuit,
      empresaId: empresaId ?? undefined,
      id: guardada?.id ?? id,
      createdAt: guardada?.created_at ?? createdAt,
    };
  }

  /** Lista comprobantes (de la empresa del contexto, si hay una) con filtros y paginación. */
  public static async getAll(filtros?: {
    tipoComprobante?: number;
    puntoVenta?: number;
    search?: string; // cliente, CUIT/DNI, CAE o número
    emisorCuit?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ total: number; facturas: FacturaRegistro[] }> {
    const where: string[] = [];
    const params: unknown[] = [];

    const cuit = cuitFiltro(filtros?.emisorCuit);
    if (cuit) {
      where.push("emisor_cuit = ?");
      params.push(cuit);
    }
    if (filtros?.tipoComprobante) {
      where.push("tipo_comprobante = ?");
      params.push(Number(filtros.tipoComprobante));
    }
    if (filtros?.puntoVenta) {
      where.push("punto_venta = ?");
      params.push(Number(filtros.puntoVenta));
    }
    if (filtros?.search?.trim()) {
      const like = `%${filtros.search.trim()}%`;
      where.push(`(receptor_razon_social LIKE ? OR receptor_doc_nro LIKE ? OR numero_formateado LIKE ?
        OR cae LIKE ? OR CAST(numero_comprobante AS CHAR) LIKE ?)`);
      params.push(like, like, like, like, like);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const totalRow = await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM invoices ${whereSql}`, params);

    const limit = Math.min(Math.max(Number(filtros?.limit ?? 50) || 50, 1), 500);
    const offset = Math.max(Number(filtros?.offset ?? 0) || 0, 0);
    const rows = await query<InvoiceDbRow>(
      `SELECT * FROM invoices ${whereSql}
       ORDER BY created_at DESC, numero_comprobante DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return { total: Number(totalRow?.total ?? 0), facturas: rows.map(mapRowToRecord) };
  }

  /**
   * Busca por id interno, número formateado ("00001-00000015") o número entero,
   * siempre dentro de la empresa del contexto (si hay una).
   */
  public static async getById(idOrNumber: string | number, emisorCuit?: number): Promise<FacturaRegistro | null> {
    const q = String(idOrNumber).trim();
    const cuit = cuitFiltro(emisorCuit);
    const filtroCuit = cuit ? "AND emisor_cuit = ?" : "";
    const pCuit = cuit ? [cuit] : [];

    let row = await queryOne<InvoiceDbRow>(
      `SELECT * FROM invoices WHERE (id = ? OR numero_formateado = ?) ${filtroCuit}
       ORDER BY created_at DESC LIMIT 1`,
      [q, q, ...pCuit]
    );
    if (!row && /^\d+$/.test(q)) {
      row = await queryOne<InvoiceDbRow>(
        `SELECT * FROM invoices WHERE numero_comprobante = ? ${filtroCuit} ORDER BY created_at DESC LIMIT 1`,
        [Number(q), ...pCuit]
      );
    }
    return row ? mapRowToRecord(row) : null;
  }
}

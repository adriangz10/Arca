import { CbteTipo } from "../constants/arca.constants.js";
import { query, queryOne } from "../db/database.js";
import type { FacturaRegistro } from "../storage/invoice-history.storage.js";
import { formatearPesos } from "./fiscal-engine.js";
import type { Empresa } from "../empresas/empresa.types.js";

function fechaYYYYMMDD(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

const SUMAN = [
  CbteTipo.FACTURA_C, CbteTipo.NOTA_DEBITO_C, CbteTipo.RECIBO_C, CbteTipo.FCE_C, CbteTipo.ND_FCE_C,
  CbteTipo.FACTURA_A, CbteTipo.NOTA_DEBITO_A, CbteTipo.FACTURA_B, CbteTipo.NOTA_DEBITO_B,
];
const RESTAN = [CbteTipo.NOTA_CREDITO_C, CbteTipo.NC_FCE_C, CbteTipo.NOTA_CREDITO_A, CbteTipo.NOTA_CREDITO_B];

/** Facturación neta (facturas + ND - NC) de los últimos 365 días de un emisor. */
export async function facturacionUltimoAnio(emisorCuit: number): Promise<number> {
  const desde = fechaYYYYMMDD(new Date(Date.now() - 365 * 24 * 3600_000));
  const row: any = await queryOne(
    `SELECT
       COALESCE(SUM(CASE WHEN tipo_comprobante IN (${SUMAN.join(",")}) THEN importe_total ELSE 0 END), 0) AS suma,
       COALESCE(SUM(CASE WHEN tipo_comprobante IN (${RESTAN.join(",")}) THEN importe_total ELSE 0 END), 0) AS resta
     FROM invoices
     WHERE emisor_cuit = ? AND fecha_emision >= ?`,
    [emisorCuit, desde]
  );
  return Number(row?.suma ?? 0) - Number(row?.resta ?? 0);
}

/** Mensaje de alerta de tope de Monotributo, o null si no aplica. */
export async function alertaTopeMonotributo(empresa: Empresa): Promise<string | null> {
  if (empresa.condicionIva !== "MONOTRIBUTO" || !empresa.monotributoTopeAnual) return null;

  const facturado = await facturacionUltimoAnio(empresa.cuit);
  const tope = empresa.monotributoTopeAnual;
  const pct = (facturado / tope) * 100;
  const categoria = empresa.monotributoCategoria ? ` de tu Categoría ${empresa.monotributoCategoria}` : "";

  if (pct >= 100) {
    return `🚨 Superaste el tope${categoria}: llevás ${formatearPesos(facturado)} facturados en los últimos 12 meses (tope ${formatearPesos(tope)}). Hablá con tu contador para recategorizarte.`;
  }
  if (pct >= 75) {
    return `⚠️ Estás al ${pct.toFixed(0)}% del tope${categoria} (${formatearPesos(tope - facturado)} disponibles en los últimos 12 meses).`;
  }
  return null;
}

/** Devuelve el número de la Nota de Crédito que ya anuló esta factura, si existe. */
export async function notaCreditoExistente(factura: FacturaRegistro): Promise<string | null> {
  const rows: any[] = await query(
    `SELECT numero_formateado, tipo_comprobante_nombre, comprobantes_asociados_json
     FROM invoices
     WHERE emisor_cuit = ? AND comprobantes_asociados_json IS NOT NULL
       AND tipo_comprobante IN (${RESTAN.join(",")}, ${CbteTipo.NOTA_CREDITO_M})`,
    [Number(factura.emisorCuit ?? 0)]
  );

  for (const row of rows) {
    try {
      const asociados: any[] = JSON.parse(row.comprobantes_asociados_json) ?? [];
      const coincide = asociados.some(
        (a) =>
          Number(a.tipo) === factura.tipoComprobante &&
          Number(a.puntoVenta) === factura.puntoVenta &&
          Number(a.numero) === factura.numeroComprobante
      );
      if (coincide) return `${row.tipo_comprobante_nombre} ${row.numero_formateado}`;
    } catch {
      // ignorar filas con JSON inválido
    }
  }
  return null;
}

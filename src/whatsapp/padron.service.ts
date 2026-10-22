import { ArcaClientFactory } from "../services/arca-client.factory.js";
import { ConfiguracionRepository } from "../config/configuracion.repository.js";
import { queryOne } from "../db/database.js";
import { condicionDesdeCodigo, cuitsPosiblesDesdeDni, type CondicionReceptor } from "./fiscal-engine.js";

/**
 * Resultado de consultar un CUIT/CUIL en el padrón de ARCA (ws_sr_constancia_inscripcion):
 *  - OK: tiene alta en IVA o Monotributo (o es exento) -> se factura a su CUIT (DocTipo 80).
 *  - SIN_ALTA: no existe constancia o no tiene impuestos activos -> es un CUIL de un
 *    consumidor final (DocTipo 86, condición 5).
 *  - NO_DISPONIBLE: el servicio no respondió o no está habilitado -> hay que preguntarle al usuario.
 */
export type ResultadoPadron =
  | { estado: "OK"; condicion: Exclude<CondicionReceptor, "CONSUMIDOR_FINAL">; razonSocial?: string; domicilio?: string; fuente: "PADRON" | "CLIENTES" }
  | { estado: "SIN_ALTA"; razonSocial?: string; domicilio?: string }
  | { estado: "NO_DISPONIBLE"; motivo: string };

// Códigos de impuesto en el padrón de ARCA
const IMPUESTO_IVA = 30;
const IMPUESTO_IVA_EXENTO = 32;
const IMPUESTO_MONOTRIBUTO = 20;

const TIMEOUT_MS = 15_000;

function armarDomicilio(dom: any): string | undefined {
  if (!dom) return undefined;
  const d = Array.isArray(dom) ? dom[0] : dom;
  const partes = [d?.direccion, d?.localidad, d?.descripcionProvincia].filter(Boolean);
  return partes.length > 0 ? partes.join(", ") : undefined;
}

function aArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function conTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("el padrón de ARCA no respondió a tiempo")), TIMEOUT_MS)),
  ]);
}

export class PadronService {
  public static async consultar(cuit: string): Promise<ResultadoPadron> {
    const { consultarPadron } = await ConfiguracionRepository.obtener();
    if (!consultarPadron) return this.desdeClientes(cuit, "la consulta al padrón está desactivada");

    let details: any;
    try {
      // Se consulta con el certificado del sistema: el padrón es público para cualquier CUIT autorizado.
      const { arca } = await ArcaClientFactory.obtener(undefined);
      details = await conTimeout(arca.registerInscriptionProofService.getTaxpayerDetails(Number(cuit)));
    } catch (error: any) {
      const msg = String(error?.message ?? error);
      if (/no existe|inexistente|no se encontr|no encontrad|sin constancia/i.test(msg)) return { estado: "SIN_ALTA" };
      console.warn(`[Padrón] No se pudo consultar el CUIT ${cuit}: ${msg}`);
      return this.desdeClientes(cuit, msg);
    }

    if (!details) return { estado: "SIN_ALTA" };

    const generales = details.datosGenerales ?? {};
    const razonSocial: string | undefined =
      generales.razonSocial ?? ([generales.apellido, generales.nombre].filter(Boolean).join(" ") || undefined);
    const domicilio = armarDomicilio(generales.domicilioFiscal);

    const condicion = this.inferirCondicion(details);
    if (condicion) return { estado: "OK", condicion, razonSocial, domicilio, fuente: "PADRON" };
    return { estado: "SIN_ALTA", razonSocial, domicilio };
  }

  /**
   * Con un DNI, prueba los CUIT posibles (20, 27, 23, 24) y devuelve el primero que tenga
   * impuestos activos. null si no hay ninguno o el padrón no está disponible.
   */
  public static async buscarCuitPorDni(
    dni: string
  ): Promise<{ cuit: string; resultado: Extract<ResultadoPadron, { estado: "OK" }> } | { soloNombre: string } | null> {
    let nombre: string | undefined;
    for (const cuit of cuitsPosiblesDesdeDni(dni)) {
      const r = await this.consultar(cuit);
      if (r.estado === "NO_DISPONIBLE") return null;
      if (r.estado === "OK" && r.fuente === "PADRON") return { cuit, resultado: r };
      if (r.estado === "SIN_ALTA" && r.razonSocial) nombre ??= r.razonSocial;
    }
    return nombre ? { soloNombre: nombre } : null;
  }

  private static inferirCondicion(details: any): Exclude<CondicionReceptor, "CONSUMIDOR_FINAL"> | undefined {
    const impuestosMono = aArray(details.datosMonotributo?.impuesto);
    if (details.datosMonotributo && (impuestosMono.length > 0 || details.datosMonotributo.categoriaMonotributo)) {
      return "MONOTRIBUTO";
    }
    const impuestos = aArray<any>(details.datosRegimenGeneral?.impuesto).map((i) => Number(i?.idImpuesto));
    if (impuestos.includes(IMPUESTO_MONOTRIBUTO)) return "MONOTRIBUTO";
    if (impuestos.includes(IMPUESTO_IVA)) return "RESPONSABLE_INSCRIPTO";
    if (impuestos.includes(IMPUESTO_IVA_EXENTO)) return "EXENTO";
    return undefined;
  }

  /** Si el padrón no responde, se usa lo que ya se sabía de un cliente facturado antes. */
  private static async desdeClientes(cuit: string, motivo: string): Promise<ResultadoPadron> {
    const row: any = await queryOne(`SELECT * FROM clientes WHERE doc_nro = ? ORDER BY updated_at DESC LIMIT 1`, [cuit]);
    const condicion = condicionDesdeCodigo(Number(row?.condicion_iva));
    if (row && condicion && condicion !== "CONSUMIDOR_FINAL") {
      return { estado: "OK", condicion, razonSocial: row.razon_social, domicilio: row.domicilio ?? undefined, fuente: "CLIENTES" };
    }
    return { estado: "NO_DISPONIBLE", motivo };
  }
}

import { ArcaClientFactory } from "../services/arca-client.factory.js";
import { CondicionIVAReceptor, type TipoCondicionIvaReceptor } from "../constants/arca.constants.js";
import { queryOne } from "../db/database.js";

export interface DatosContribuyente {
  cuit: string;
  razonSocial?: string;
  domicilio?: string;
  condicionIva?: TipoCondicionIvaReceptor;
  fuente: "PADRON" | "CACHE_CLIENTES";
}

// Códigos de impuesto en el padrón de ARCA
const IMPUESTO_IVA = 30;
const IMPUESTO_IVA_EXENTO = 32;
const IMPUESTO_MONOTRIBUTO = 20;

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

/**
 * Consulta el padrón de ARCA (ws_sr_constancia_inscripcion) para obtener el nombre
 * y la condición frente al IVA de un CUIT. Si el servicio no está habilitado para el
 * certificado o falla, devuelve lo que haya en la tabla local de clientes, o null.
 */
export class PadronService {
  public static async consultar(cuit: string): Promise<DatosContribuyente | null> {
    try {
      const { arca } = await ArcaClientFactory.obtener();
      const details: any = await arca.registerInscriptionProofService.getTaxpayerDetails(Number(cuit));

      if (details && !details.errorConstancia?.error) {
        const generales = details.datosGenerales ?? {};
        const razonSocial: string | undefined =
          generales.razonSocial ??
          ([generales.apellido, generales.nombre].filter(Boolean).join(" ") || undefined);

        return {
          cuit,
          razonSocial,
          domicilio: armarDomicilio(generales.domicilioFiscal),
          condicionIva: this.inferirCondicion(details),
          fuente: "PADRON",
        };
      }
    } catch (error: any) {
      console.warn(`[Padrón] No se pudo consultar el CUIT ${cuit}: ${error?.message ?? error}`);
    }

    return this.buscarEnClientes(cuit);
  }

  private static inferirCondicion(details: any): TipoCondicionIvaReceptor | undefined {
    const impuestosMono = aArray(details.datosMonotributo?.impuesto);
    if (details.datosMonotributo && (impuestosMono.length > 0 || details.datosMonotributo.categoriaMonotributo)) {
      return CondicionIVAReceptor.RESPONSABLE_MONOTRIBUTO;
    }

    const impuestos = aArray<any>(details.datosRegimenGeneral?.impuesto).map((i) => Number(i?.idImpuesto));
    if (impuestos.includes(IMPUESTO_MONOTRIBUTO)) return CondicionIVAReceptor.RESPONSABLE_MONOTRIBUTO;
    if (impuestos.includes(IMPUESTO_IVA)) return CondicionIVAReceptor.RESPONSABLE_INSCRIPTO;
    if (impuestos.includes(IMPUESTO_IVA_EXENTO)) return CondicionIVAReceptor.IVA_SUJETO_EXENTO;

    // Tiene CUIT pero no está inscripto en IVA ni monotributo: se lo trata como Consumidor Final.
    if (details.datosGenerales) return CondicionIVAReceptor.CONSUMIDOR_FINAL;
    return undefined;
  }

  /** Busca un cliente ya facturado antes (tabla `clientes`). */
  public static async buscarEnClientes(docNro: string): Promise<DatosContribuyente | null> {
    const row: any = await queryOne(`SELECT * FROM clientes WHERE doc_nro = ? ORDER BY updated_at DESC LIMIT 1`, [docNro]);
    if (!row) return null;

    const condicion = Number(row.condicion_iva);
    return {
      cuit: docNro,
      razonSocial: row.razon_social,
      domicilio: row.domicilio ?? undefined,
      condicionIva: Number.isFinite(condicion) && condicion > 0 ? (condicion as TipoCondicionIvaReceptor) : undefined,
      fuente: "CACHE_CLIENTES",
    };
  }
}

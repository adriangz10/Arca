import { ConfiguracionRepository } from "../config/configuracion.repository.js";
import { ArcaClientFactory } from "../services/arca-client.factory.js";

/**
 * Factura de Crédito Electrónica MiPyME (Ley 27.440).
 *
 * Si el cliente figura en el registro de "Grandes Empresas" obligadas a recibir FCE y el
 * total supera el monto mínimo vigente, en lugar de una factura común hay que emitir
 * FCE A (201), B (206) o C (211). ARCA lo informa con el web service `wsfecred`,
 * método consultarMontoObligadoRecepcion (devuelve obligado S/N y el monto desde).
 *
 *  - OBLIGADO: el cliente está obligado desde `montoDesde`.
 *  - NO_OBLIGADO: factura común.
 *  - NO_VERIFICADO: el servicio no respondió o no está autorizado para el certificado.
 */
export type ResultadoFce =
  | { estado: "OBLIGADO"; montoDesde: number }
  | { estado: "NO_OBLIGADO" }
  | { estado: "NO_VERIFICADO"; motivo: string };

const TIMEOUT_MS = 15_000;
const CACHE_MS = 6 * 3600_000;
const cache = new Map<string, { valor: ResultadoFce; hasta: number }>();

function hoyIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function aArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export class FceService {
  /** Consulta (con caché de 6 h) si el CUIT está obligado a recibir FCE. Usa el cliente de la empresa activa. */
  public static async consultar(cuit: string): Promise<ResultadoFce> {
    const { verificarFce } = await ConfiguracionRepository.obtener();
    // Desactivada a propósito en `configuracion`: se factura común sin avisar en cada venta.
    if (!verificarFce) return { estado: "NO_OBLIGADO" };

    const fecha = hoyIso();
    const clave = `${cuit}_${fecha}`;
    const enCache = cache.get(clave);
    if (enCache && enCache.hasta > Date.now()) return enCache.valor;

    let valor: ResultadoFce;
    try {
      const { arca } = await ArcaClientFactory.obtener();
      const r: any = await Promise.race([
        arca.wsfecredService.consultarMontoObligadoRecepcion({ cuitConsultada: Number(cuit) as any, fechaEmision: fecha }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("wsfecred no respondió a tiempo")), TIMEOUT_MS)),
      ]);
      const ret = r?.consultarMontoObligadoRecepcionReturn ?? r;
      const errores = aArray(ret?.arrayErrores?.codigoDescripcion);
      if (errores.length > 0 && !ret?.obligado) {
        const e: any = errores[0];
        valor = { estado: "NO_VERIFICADO", motivo: `${e?.codigo ?? ""} ${e?.descripcion ?? "error de wsfecred"}`.trim() };
      } else if (String(ret?.obligado).toUpperCase() === "S") {
        valor = { estado: "OBLIGADO", montoDesde: Number(ret?.montoDesde) || 0 };
      } else {
        valor = { estado: "NO_OBLIGADO" };
      }
    } catch (error: any) {
      const motivo = String(error?.message ?? error);
      console.warn(`[FCE] No se pudo verificar el CUIT ${cuit}: ${motivo}`);
      // Los errores no se cachean: puede ser algo pasajero.
      return { estado: "NO_VERIFICADO", motivo: /notAuthorized|no autorizado/i.test(motivo) ? "el certificado no tiene autorizado wsfecred" : motivo };
    }

    cache.set(clave, { valor, hasta: Date.now() + CACHE_MS });
    return valor;
  }

  /** Para tests. */
  public static limpiarCache(): void {
    cache.clear();
  }
}

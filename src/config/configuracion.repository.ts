import { CONFIGURACION_INICIAL, execute, query } from "../db/database.js";

/** Reglas generales del bot, guardadas en la tabla `configuracion`. */
export interface ConfiguracionBot {
  /** Monto desde el cual ARCA exige identificar al consumidor final. */
  consumidorFinalTope: number;
  /** Minutos que se guarda una venta a medio armar. */
  sesionTtlMinutos: number;
  /** Consultar el padrón de ARCA con cada CUIT. */
  consultarPadron: boolean;
  /** Verificar con wsfecred si el cliente está obligado a recibir Factura de Crédito MiPyME. */
  verificarFce: boolean;
  /** Ambiente de ARCA para las empresas nuevas. */
  arcaProduccion: boolean;
}

const CACHE_MS = 30_000;
let cache: { valor: ConfiguracionBot; hasta: number } | null = null;

function aNumero(v: string | undefined, porDefecto: number): number {
  const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
}

export class ConfiguracionRepository {
  public static async obtener(): Promise<ConfiguracionBot> {
    if (cache && cache.hasta > Date.now()) return cache.valor;

    const filas = await query<{ clave: string; valor: string }>(`SELECT clave, valor FROM configuracion`);
    const mapa = new Map(filas.map((f) => [f.clave, f.valor]));
    const def = new Map(CONFIGURACION_INICIAL.map((c) => [c.clave, c.valor]));
    const v = (clave: string) => mapa.get(clave) ?? def.get(clave);

    const valor: ConfiguracionBot = {
      consumidorFinalTope: aNumero(v("consumidor_final_tope"), 10_000_000),
      sesionTtlMinutos: aNumero(v("sesion_ttl_minutos"), 15),
      consultarPadron: v("consultar_padron") !== "false",
      verificarFce: v("verificar_fce") !== "false",
      arcaProduccion: v("arca_produccion") === "true",
    };
    cache = { valor, hasta: Date.now() + CACHE_MS };
    return valor;
  }

  public static async actualizar(clave: string, valor: string): Promise<void> {
    await execute(
      `INSERT INTO configuracion (clave, valor, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE valor = VALUES(valor), updated_at = VALUES(updated_at)`,
      [clave, valor, new Date().toISOString()]
    );
    cache = null;
  }

  /** Para tests. */
  public static limpiarCache(): void {
    cache = null;
  }
}

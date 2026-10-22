import { Arca } from "@arcasdk/core";
import { loadArcaConfig, type ArcaConfig } from "../config/arca.config.js";
import { DatabaseTicketStorage } from "../storage/database-ticket-storage.js";
import { empresaActual } from "../empresas/empresa.context.js";
import { EmpresaRepository } from "../empresas/empresa.repository.js";
import type { Empresa } from "../empresas/empresa.types.js";
import { ConfiguracionRepository } from "../config/configuracion.repository.js";

export interface ArcaClient {
  arca: Arca;
  config: ArcaConfig;
  ticketStorage: DatabaseTicketStorage;
}

/**
 * Crea y cachea un cliente de ARCA por empresa emisora.
 *
 * - Empresa con certificado PROPIO: usa su .crt/.key (la clave se guarda cifrada).
 * - Empresa en modo SISTEMA: usa el certificado del .env y factura "en representación"
 *   del CUIT de la empresa (requiere que la empresa delegue el servicio en ARCA).
 * - Sin empresa en contexto (ej: consultar el padrón durante el alta): el certificado del
 *   sistema con su propio CUIT y el ambiente de la tabla `configuracion`.
 */
export class ArcaClientFactory {
  private static clientes = new Map<string, ArcaClient>();

  /** Cliente para la empresa del contexto actual (o la del .env si no hay ninguna). */
  public static async obtener(empresa: Empresa | undefined = empresaActual()): Promise<ArcaClient> {
    const base = loadArcaConfig();
    if (!empresa) {
      return this.desdeConfig({ ...base, production: (await ConfiguracionRepository.obtener()).arcaProduccion });
    }

    let cert = base.cert;
    let key = base.key;
    if (empresa.certModo === "PROPIO") {
      const cred = await EmpresaRepository.credenciales(empresa.id);
      if (!cred) throw new Error(`La empresa ${empresa.razonSocial} no tiene certificado cargado.`);
      cert = cred.cert;
      key = cred.key;
    }
    return this.desdeConfig({
      ...base,
      cuit: empresa.cuit,
      ptoVta: empresa.puntoVenta,
      production: empresa.produccion,
      cert,
      key,
    });
  }

  private static desdeConfig(config: ArcaConfig): ArcaClient {
    if (!config.cert || !config.key) {
      throw new Error(
        "No se encontraron los certificados (ARCA_CERT_PATH / ARCA_KEY_PATH o ARCA_CERT_CONTENT / ARCA_KEY_CONTENT). Verifique su archivo .env"
      );
    }
    const ticketStorage = new DatabaseTicketStorage({ cuit: config.cuit, production: config.production, certPem: config.cert });
    const clave = `${config.cuit}_${config.production ? "prod" : "homo"}_${ticketStorage.certId}`;

    let cliente = this.clientes.get(clave);
    if (!cliente) {
      cliente = {
        arca: new Arca({
          cuit: config.cuit,
          cert: config.cert,
          key: config.key,
          production: config.production,
          ticketStorage,
          useHttpsAgent: config.useHttpsAgent,
        }),
        config,
        ticketStorage,
      };
      this.clientes.set(clave, cliente);
    }
    // El punto de venta puede cambiar sin cambiar credenciales.
    return { ...cliente, config };
  }

  /** Descarta los clientes cacheados (tests o cambio de credenciales). */
  public static resetInstance(): void {
    this.clientes.clear();
  }
}

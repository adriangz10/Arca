import { AsyncLocalStorage } from "node:async_hooks";
import type { Empresa } from "./empresa.types.js";

/**
 * Empresa emisora del pedido en curso (API REST o mensaje de WhatsApp).
 * Los servicios (cliente de ARCA, historial, PDF) la leen de acá, así nunca se
 * mezclan comprobantes de dos empresas aunque se atiendan en paralelo.
 */
const storage = new AsyncLocalStorage<Empresa>();

export function conEmpresa<T>(empresa: Empresa, fn: () => Promise<T>): Promise<T> {
  return storage.run(empresa, fn);
}

export function empresaActual(): Empresa | undefined {
  return storage.getStore();
}

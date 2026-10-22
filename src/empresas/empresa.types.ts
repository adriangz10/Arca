export type CondicionIvaEmisor = "MONOTRIBUTO" | "RESPONSABLE_INSCRIPTO" | "EXENTO";
export type ModoCertificado = "SISTEMA" | "PROPIO";

/** Empresa emisora: todos los datos fiscales que van en la factura. */
export interface Empresa {
  id: number;
  cuit: number;
  razonSocial: string;
  nombreFantasia?: string;
  domicilioComercial: string;
  condicionIva: CondicionIvaEmisor;
  ingresosBrutos?: string;
  /** YYYY-MM-DD */
  inicioActividades?: string;
  puntoVenta: number;
  email?: string;
  monotributoCategoria?: string;
  monotributoTopeAnual?: number;
  /** Concepto por defecto de las ventas: 1 productos, 2 servicios, 3 ambos. */
  conceptoDefault: 1 | 2 | 3;
  /** CBU del emisor (22 dígitos), para Factura de Crédito Electrónica MiPyME. */
  cbu?: string;
  logoPath?: string;
  certModo: ModoCertificado;
  produccion: boolean;
  activa: boolean;
}

/** Datos para dar de alta una empresa (el certificado propio va aparte, en texto plano). */
export interface EmpresaNueva extends Omit<Empresa, "id" | "activa"> {
  certPem?: string;
  keyPem?: string;
}

export const NOMBRE_CONDICION_EMISOR: Record<CondicionIvaEmisor, string> = {
  MONOTRIBUTO: "Responsable Monotributo",
  RESPONSABLE_INSCRIPTO: "IVA Responsable Inscripto",
  EXENTO: "IVA Sujeto Exento",
};

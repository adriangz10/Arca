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

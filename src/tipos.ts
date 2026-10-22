/**
 * Tablas de códigos de ARCA/AFIP (WSFE) para facturación electrónica.
 * Fuente: https://www.afipts.com/services/facturacion_electronica.html
 * (también se pueden pedir en vivo con los métodos getVoucherTypes(),
 * getDocumentTypes(), getAliquotTypes(), getIvaReceptorTypes(), etc.)
 */

export const CbteTipo = {
  FACTURA_A: 1,
  NOTA_DEBITO_A: 2,
  NOTA_CREDITO_A: 3,
  FACTURA_B: 6,
  RECIBO_B: 7,
  NOTA_DEBITO_B: 8,
  NOTA_CREDITO_B: 9,
  FACTURA_C: 11,
  RECIBO_C: 12,
  NOTA_DEBITO_C: 13,
  NOTA_CREDITO_C: 14,
  FACTURA_M: 51,
  TIQUE_FACTURA_A: 81,
  TIQUE_FACTURA_B: 82,
  TIQUE: 83,
  REMITO_R: 91,
  TIQUE_FACTURA_T: 118,
  FCE_A: 201, // Factura de Crédito MiPyMEs A
  FCE_B: 206, // Factura de Crédito MiPyMEs B
  FCE_C: 211, // Factura de Crédito MiPyMEs C
} as const;

export const DocTipo = {
  CUIT: 80,
  CUIL: 86,
  DNI: 87,
  LIBRETA_CIVICA: 89,
  EXTRANJEROS: 90,
  PASAPORTE: 91,
  DOC_MERCOSUR: 92,
  CONSUMIDOR_FINAL: 99,
} as const;

export const Concepto = {
  PRODUCTOS: 1,
  SERVICIOS: 2,
  PRODUCTOS_Y_SERVICIOS: 3,
} as const;

export const IvaId = {
  IVA_0: 3,
  IVA_10_5: 4,
  IVA_21: 5,
  IVA_27: 6,
  IVA_5: 7,
  IVA_2_5: 8,
} as const;

/**
 * CondicionIVAReceptorId: requerido por la versión actual del SDK
 * (no aparece en el ejemplo de la doc, pero el paquete instalado lo exige).
 * Códigos habituales — para la lista completa y actualizada, usar
 * getIvaReceptorTypes() en tiempo real.
 */
export const CondicionIVAReceptorId = {
  RESPONSABLE_INSCRIPTO: 1,
  MONOTRIBUTISTA_SOCIAL: 13,
  IVA_SUJETO_EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  RESPONSABLE_MONOTRIBUTO: 6,
  IVA_NO_ALCANZADO: 15,
} as const;

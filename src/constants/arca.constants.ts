/**
 * Códigos oficiales de ARCA/AFIP (WSFE) para Facturación Electrónica en Argentina.
 * Documentación oficial: https://www.afipts.com/services/facturacion_electronica.html
 */

export const CbteTipo = {
  // Facturas y comprobantes A (Emisor Responsable Inscripto a Receptor Responsable Inscripto)
  FACTURA_A: 1,
  NOTA_DEBITO_A: 2,
  NOTA_CREDITO_A: 3,
  RECIBO_A: 4,
  NOTA_VENTA_CONTADO_A: 5,

  // Facturas y comprobantes B (Emisor Responsable Inscripto a Consumidor Final, Exento o Monotributista)
  FACTURA_B: 6,
  NOTA_DEBITO_B: 7,
  NOTA_CREDITO_B: 8,
  RECIBO_B: 9,
  NOTA_VENTA_CONTADO_B: 10,

  // Facturas y comprobantes C (Emisor Monotributista o Exento a cualquier receptor)
  // Verificado contra FEParamGetTiposCbte de ARCA: no existe el código 14.
  FACTURA_C: 11,
  NOTA_DEBITO_C: 12,
  NOTA_CREDITO_C: 13,
  RECIBO_C: 15,

  // Facturas y comprobantes M (Responsable Inscripto con régimen especial de retención)
  FACTURA_M: 51,
  NOTA_DEBITO_M: 52,
  NOTA_CREDITO_M: 53,
  RECIBO_M: 54,

  // Tiques
  TIQUE_FACTURA_A: 81,
  TIQUE_FACTURA_B: 82,
  TIQUE: 83,
  REMITO_R: 91,
  TIQUE_FACTURA_T: 118,

  // Facturas T (Turismo extranjero - reintegro IVA hoteles)
  FACTURA_T: 111,
  NOTA_DEBITO_T: 112,
  NOTA_CREDITO_T: 113,

  // Facturas de Crédito Electrónica MiPyMEs (FCE)
  FCE_A: 201, // Factura de Crédito Electrónica MiPyMEs A
  ND_FCE_A: 202, // Nota de Débito FCE A
  NC_FCE_A: 203, // Nota de Crédito FCE A
  
  FCE_B: 206, // Factura de Crédito Electrónica MiPyMEs B
  ND_FCE_B: 207, // Nota de Débito FCE B
  NC_FCE_B: 208, // Nota de Crédito FCE B

  FCE_C: 211, // Factura de Crédito Electrónica MiPyMEs C
  ND_FCE_C: 212, // Nota de Débito FCE C
  NC_FCE_C: 213, // Nota de Crédito FCE C
} as const;

export type TipoComprobante = (typeof CbteTipo)[keyof typeof CbteTipo];

export const DocTipo = {
  CUIT: 80,
  CUIL: 86,
  CDI: 87,
  DNI: 96, // En tablas oficiales AFIP: 96 = DNI, 87 = CDI / DNI antiguo
  DNI_GENERICO: 87,
  LIBRETA_CIVICA: 89,
  LIBRETA_ENROLAMIENTO: 90,
  PASAPORTE: 94,
  DOC_MERCOSUR: 92,
  CONSUMIDOR_FINAL: 99,
} as const;

export type TipoDocumento = (typeof DocTipo)[keyof typeof DocTipo];

export const Concepto = {
  PRODUCTOS: 1,
  SERVICIOS: 2,
  PRODUCTOS_Y_SERVICIOS: 3,
} as const;

export type TipoConcepto = (typeof Concepto)[keyof typeof Concepto];

export const IvaAlicuota = {
  IVA_0: 3,     // 0%
  IVA_10_5: 4,  // 10.5%
  IVA_21: 5,    // 21%
  IVA_27: 6,    // 27%
  IVA_5: 7,     // 5%
  IVA_2_5: 8,   // 2.5%
} as const;

export type TipoAlicuotaIva = (typeof IvaAlicuota)[keyof typeof IvaAlicuota];

export const CondicionIVAReceptor = {
  RESPONSABLE_INSCRIPTO: 1,
  IVA_SUJETO_EXENTO: 4,
  CONSUMIDOR_FINAL: 5,
  RESPONSABLE_MONOTRIBUTO: 6,
  SUJETO_NO_CATEGORIZADO: 7,
  PROVEEDOR_DEL_EXTERIOR: 8,
  CLIENTE_DEL_EXTERIOR: 9,
  IVA_LIBERADO: 10,
  MONOTRIBUTISTA_SOCIAL: 13,
  IVA_NO_ALCANZADO: 15,
} as const;

export type TipoCondicionIvaReceptor =
  (typeof CondicionIVAReceptor)[keyof typeof CondicionIVAReceptor];

export const TipoTributo = {
  IMPUESTOS_NACIONALES: 1,
  IMPUESTOS_PROVINCIALES: 2,
  IMPUESTOS_MUNICIPALES: 3,
  IMPUESTOS_INTERNOS: 4,
  INGRESOS_BRUTOS: 2,
  PERCEPCION_IVA: 1,
  OTROS_TRIBUTOS: 99,
} as const;

export const Moneda = {
  PESOS_ARGENTINOS: "PES",
  DOLAR_ESTADOUNIDENSE: "DOL",
  EURO: "060",
  REAL: "012",
} as const;

export type TipoMoneda = (typeof Moneda)[keyof typeof Moneda];

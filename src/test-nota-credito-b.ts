import {
  ArcaBillingService,
  CbteTipo,
  DocTipo,
  CondicionIVAReceptor,
  IvaAlicuota,
} from "./index.js";

// Número de la Factura B que se anula o corrige
const FACTURA_B_A_ANULAR = 1;

async function main() {
  console.log("=== Creando Nota de Crédito B en Homologación ===");

  const neto = 100;
  const iva21 = 21;

  const resultado = await ArcaBillingService.emitirNotaCredito({
    tipoNotaCredito: CbteTipo.NOTA_CREDITO_B,
    tipoDocumento: DocTipo.CONSUMIDOR_FINAL,
    numeroDocumento: 0,
    condicionIvaReceptor: CondicionIVAReceptor.CONSUMIDOR_FINAL,
    importeNeto: neto,
    alicuotasIva: [
      {
        id: IvaAlicuota.IVA_21,
        baseImponible: neto,
        importe: iva21,
      },
    ],
    comprobanteAsociado: {
      tipo: CbteTipo.FACTURA_B,
      puntoVenta: 1,
      numero: FACTURA_B_A_ANULAR,
    },
  });

  console.log("\n Nota de Crédito B autorizada con éxito:");
  console.log(`- Comprobante Nro: ${resultado.puntoVenta}-${resultado.numeroComprobante}`);
  console.log(`- CAE: ${resultado.cae}`);
  console.log(`- Vencimiento CAE: ${resultado.caeVencimiento}`);
  console.log(`- Importe Total: $${resultado.importeTotal}`);
  console.log(`- Vinculada a Factura B Nro: ${FACTURA_B_A_ANULAR}`);
  console.log(`- URL QR Reglamentario AFIP/ARCA:`);
  console.log(`  ${resultado.qrData?.url}`);
}

main().catch((error) => {
  console.error("\nError al emitir Nota de Crédito:", error.message);
  process.exit(1);
});

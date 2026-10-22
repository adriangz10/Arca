import { ArcaBillingService, IvaAlicuota, CondicionIVAReceptor } from "./index.js";

async function main() {
  console.log("=== Creando Factura B (Consumidor Final) en Homologación ===");

  const resultado = await ArcaBillingService.emitirFacturaB({
    importeNeto: 100,
    alicuotaIva: IvaAlicuota.IVA_21,
    condicionIva: CondicionIVAReceptor.CONSUMIDOR_FINAL,
  });

  console.log("\n Factura B autorizada con éxito:");
  console.log(`- Comprobante Nro: ${resultado.puntoVenta}-${resultado.numeroComprobante}`);
  console.log(`- CAE: ${resultado.cae}`);
  console.log(`- Vencimiento CAE: ${resultado.caeVencimiento}`);
  console.log(`- Importe Total: $${resultado.importeTotal}`);
  console.log(`- URL QR Reglamentario AFIP/ARCA:`);
  console.log(`  ${resultado.qrData?.url}`);

  if (resultado.observaciones && resultado.observaciones.length > 0) {
    console.log("\nObservaciones informadas por ARCA:", resultado.observaciones);
  }
}

main().catch((error) => {
  console.error("\nError al facturar:", error.message);
  process.exit(1);
});

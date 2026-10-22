import { ArcaBillingService, IvaAlicuota } from "./index.js";

// CUIT de prueba de receptor (Responsable Inscripto) en homologación
const CUIT_RECEPTOR = 20111111112;

async function main() {
  console.log("=== Creando Factura A (Responsable Inscripto) en Homologación ===");

  const neto = 1000;
  const iva21 = Number((neto * 0.21).toFixed(2));

  const resultado = await ArcaBillingService.emitirFacturaA({
    cuitReceptor: CUIT_RECEPTOR,
    importeNeto: neto,
    alicuotasIva: [
      {
        id: IvaAlicuota.IVA_21,
        baseImponible: neto,
        importe: iva21,
      },
    ],
  });

  console.log("\n Factura A autorizada con éxito:");
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
  console.error("\nError al facturar Factura A:", error.message);
  process.exit(1);
});

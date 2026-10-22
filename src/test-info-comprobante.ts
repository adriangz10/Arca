import { ArcaBillingService, CbteTipo } from "./index.js";

// Número y tipo del comprobante a consultar
const NRO_COMPROBANTE = 1;
const TIPO_COMPROBANTE = CbteTipo.FACTURA_B;

async function main() {
  console.log(`=== Consultando Comprobante Nro ${NRO_COMPROBANTE} ===`);

  const comprobante = await ArcaBillingService.consultarComprobante(
    NRO_COMPROBANTE,
    undefined,
    TIPO_COMPROBANTE
  );

  if (comprobante) {
    console.log("\nDetalle del comprobante registrado en ARCA:");
    console.log(JSON.stringify(comprobante, null, 2));
  } else {
    console.log(`\nEl comprobante ${NRO_COMPROBANTE} no fue encontrado.`);
  }
}

main().catch((error) => {
  console.error("\nError al consultar comprobante:", error.message);
  process.exit(1);
});

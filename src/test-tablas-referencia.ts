import { ArcaBillingService } from "./index.js";

async function main() {
  console.log("=== Consultando tablas maestras oficiales de ARCA (Homologación) ===\n");

  const tablas = await ArcaBillingService.obtenerTablasReferencia();

  console.log("1. Puntos de Venta habilitados:");
  console.log(JSON.stringify(tablas.puntosVenta, null, 2));

  console.log("\n2. Tipos de Comprobante disponibles:");
  console.log(JSON.stringify(tablas.tiposComprobante, null, 2));

  console.log("\n3. Tipos de Documento:");
  console.log(JSON.stringify(tablas.tiposDocumento, null, 2));

  console.log("\n4. Alícuotas de IVA:");
  console.log(JSON.stringify(tablas.alicuotasIva, null, 2));

  console.log("\n5. Condiciones de IVA del Receptor:");
  console.log(JSON.stringify(tablas.condicionesIva, null, 2));

  console.log("\n6. Monedas y cotizaciones:");
  console.log(JSON.stringify(tablas.monedas, null, 2));
}

main().catch((error) => {
  console.error("\nError al consultar tablas maestras:", error.message);
  process.exit(1);
});

import { ArcaBillingService, CbteTipo } from "./index.js";

async function main() {
  console.log("=== Consultando Último Comprobante Autorizado ===");

  const ultimo = await ArcaBillingService.obtenerUltimoComprobante(
    undefined,
    CbteTipo.FACTURA_B
  );

  console.log(`- Punto de Venta: ${ultimo.puntoVenta}`);
  console.log(`- Tipo de Comprobante: Factura B (${ultimo.tipoComprobante})`);
  console.log(`- Último número emitido: ${ultimo.ultimoNumero}`);
  console.log(`- Próximo número a emitir: ${ultimo.ultimoNumero + 1}`);
}

main().catch((error) => {
  console.error("\nError al consultar último comprobante:", error.message);
  process.exit(1);
});

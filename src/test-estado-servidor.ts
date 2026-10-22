import { ArcaBillingService } from "./services/arca-billing.service.js";

async function main() {
  console.log("=== Verificando estado de los servidores de ARCA ===");
  const status = await ArcaBillingService.verificarEstadoServidores();
  console.log("Estado de servidores:", JSON.stringify(status, null, 2));

  console.log("\n=== Verificando estado del Ticket de Acceso (WSAA) ===");
  const ticketStatus = await ArcaBillingService.consultarEstadoTicket();
  if (ticketStatus.hasValidTicket) {
    console.log(`Ticket activo en base de datos. Expira en: ${ticketStatus.expiresInMinutes} minutos`);
    console.log(`Fecha de vencimiento: ${ticketStatus.expirationTime}`);
  } else {
    console.log("No hay ticket activo en base de datos. Se solicitará uno automáticamente en la próxima operación.");
  }
}

main().catch((error) => {
  console.error("Error al consultar estado:", error.message);
  process.exit(1);
});

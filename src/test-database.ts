import { DatabaseTicketStorage, EmpresaRepository, InvoiceHistoryStorage, closeDatabase, getDatabaseName, query } from "./index.js";
import { loadArcaConfig } from "./config/arca.config.js";

async function testDatabase() {
  console.log(`=== Verificación de la base MySQL (${getDatabaseName()}) ===`);

  const tablas = await query<{ t: string }>(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [getDatabaseName()]
  );
  console.log("Tablas:", tablas.map((r) => r.t).join(", "));

  const [tickets] = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM arca_tickets`);
  console.log(`- Tickets WSAA almacenados: ${tickets.n}`);
  console.log(`- Empresas registradas: ${await EmpresaRepository.contar()}`);

  const history = await InvoiceHistoryStorage.getAll();
  console.log(`- Comprobantes en el historial: ${history.total}`);
  for (const f of history.facturas) {
    console.log(`  * [${f.id}] ${f.tipoComprobanteNombre} ${f.numeroFormateado} - $${f.importeTotal} - CAE ${f.cae} - ${f.receptorRazonSocial}`);
  }
  if (history.facturas.length > 0) {
    const found = await InvoiceHistoryStorage.getById(history.facturas[0].id);
    console.log(`- Búsqueda por ID '${history.facturas[0].id}':`, found ? `encontrada (CAE ${found.cae})` : "no encontrada");
  }

  const cfg = loadArcaConfig();
  const info = await new DatabaseTicketStorage({ cuit: cfg.cuit, production: cfg.production, certPem: cfg.cert }).getTicketInfo("wsfe");
  console.log("- Ticket 'wsfe' del certificado del .env:", info);
  console.log("\n✔ Base de datos MySQL operativa.");
}

testDatabase()
  .catch((err) => {
    console.error("Error en test de base de datos:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());

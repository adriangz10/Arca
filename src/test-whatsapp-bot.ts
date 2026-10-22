/**
 * Prueba offline del bot de WhatsApp: no llama a ARCA ni a WhatsApp ni a Gemini.
 * Usa una base MySQL temporal (<MYSQL_DATABASE>_test, se borra al terminar), un cliente
 * de WhatsApp falso y una emisión simulada.
 *
 *   npm run test:whatsapp
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import "dotenv/config";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arca-bot-"));
const DB_TEST = `${process.env.MYSQL_DATABASE || "arca_facturacion"}_test`;
process.env.MYSQL_DATABASE = DB_TEST;
process.env.SKIP_SQLITE_IMPORT = "true";
process.env.GEMINI_API_KEY = ""; // fuerza el parser sin IA
process.env.BOT_CONSULTAR_PADRON = "false";
process.env.APP_ENCRYPTION_KEY ||= "clave-de-prueba";
process.chdir(tmpDir); // los logos y PDFs del test van a la carpeta temporal

const { resolverFactura } = await import("./whatsapp/fiscal-engine.js");
const { AiExtractorService } = await import("./whatsapp/ai-extractor.service.js");
const { WhatsAppBotService } = await import("./whatsapp/bot.service.js");
const { ArcaBillingService } = await import("./services/arca-billing.service.js");
const { InvoiceHistoryStorage } = await import("./storage/invoice-history.storage.js");
const { loadWhatsAppConfig } = await import("./whatsapp/whatsapp.config.js");
const { closeDatabase, execute } = await import("./db/database.js");
const { EmpresaRepository } = await import("./empresas/empresa.repository.js");
const { PadronService } = await import("./whatsapp/padron.service.js");
const reg = await import("./whatsapp/registro-empresa.flow.js");

// Base de prueba limpia
await execute(`DROP TABLE IF EXISTS whatsapp_invoice_messages, whatsapp_processed_messages, whatsapp_sessions,
  audit_logs, clientes, invoices, arca_tickets, usuarios_whatsapp, empresa_usuarios, empresas, schema_migrations`);
await closeDatabase();

// ---------------------------------------------------------------- motor fiscal
const ri = { ...loadWhatsAppConfig(), emisorCondicion: "RESPONSABLE_INSCRIPTO" as const };
const mono = { ...loadWhatsAppConfig(), emisorCondicion: "MONOTRIBUTO" as const };

let r = resolverFactura({ montoTotal: 121000, ivaIncluido: true, conceptoDescripcion: "X", consumidorFinal: true }, ri);
assert.equal(r.tipo, "LISTO");
if (r.tipo === "LISTO") {
  assert.equal(r.factura.letra, "B");
  assert.equal(r.factura.neto, 100000);
  assert.equal(r.factura.iva, 21000);
}

r = resolverFactura(
  { montoTotal: 120000, ivaIncluido: false, conceptoDescripcion: "X", receptorDocumento: "30712345671", receptorCondicionIva: 1 },
  ri
);
assert.equal(r.tipo, "LISTO");
if (r.tipo === "LISTO") {
  assert.equal(r.factura.letra, "A");
  assert.equal(r.factura.total, 145200);
}

r = resolverFactura({ montoTotal: 45000, conceptoDescripcion: "X", consumidorFinal: true }, mono);
assert.ok(r.tipo === "LISTO" && r.factura.letra === "C" && r.factura.total === 45000);

r = resolverFactura({ montoTotal: 15_000_000, conceptoDescripcion: "X", consumidorFinal: true }, mono);
assert.ok(r.tipo === "FALTA_DATO" && r.campo === "documento", "tope consumidor final");

r = resolverFactura({ montoTotal: 1000, conceptoDescripcion: "X", receptorDocumento: "30712345678" }, mono);
assert.ok(r.tipo === "INVALIDO", "CUIT con dígito verificador incorrecto");

// Neto + IVA siempre suman exacto el total
for (const total of [99.99, 1234.57, 45000, 33333.33]) {
  const x = resolverFactura({ montoTotal: total, ivaIncluido: true, conceptoDescripcion: "X", consumidorFinal: true }, ri);
  assert.ok(x.tipo === "LISTO" && Math.round((x.factura.neto + x.factura.iva) * 100) === Math.round(total * 100));
}
console.log("✔ Motor fiscal");

// ---------------------------------------------------------------- parser sin IA
const p = AiExtractorService.extraerSinIa("Haceme una factura al CUIT 30-71234567-9 por $120.000 más IVA de mantenimiento");
assert.equal(p.receptorDocumento, "30712345679");
assert.equal(p.montoTotal, 120000);
assert.equal(p.ivaIncluido, false);
assert.equal(AiExtractorService.extraerSinIa("Facturale 45 mil a consumidor final por servicio de diseño").montoTotal, 45000);
const pintura = AiExtractorService.extraerSinIa("nueva venta de pintura por 130.000");
assert.equal(pintura.montoTotal, 130000);
assert.equal(pintura.conceptoDescripcion, "Venta de pintura");
assert.equal(pintura.tipoConcepto, 1);
assert.equal(pintura.receptorDocumento, null);
console.log("✔ Parser sin IA");

// ---------------------------------------------------------------- conversación simulada
const enviados: Array<{ tipo: string; body: string; buttons?: string[] }> = [];
let msgSeq = 0;
let lastPdfId = "";
const fakeWa: any = {
  markAsRead: async () => {},
  sendText: async (_to: string, body: string) => (enviados.push({ tipo: "text", body }), `wamid.out${++msgSeq}`),
  sendButtons: async (_to: string, body: string, buttons: any[]) => (
    enviados.push({ tipo: "buttons", body, buttons: buttons.map((b) => b.id) }), `wamid.out${++msgSeq}`
  ),
  sendList: async (_to: string, body: string, _l: string, rows: any[]) => (
    enviados.push({ tipo: "list", body, buttons: rows.map((r) => r.id) }), `wamid.out${++msgSeq}`
  ),
  sendDocument: async (_to: string, buf: Buffer, filename: string, caption: string) => {
    assert.equal(buf.subarray(0, 4).toString(), "%PDF", "el adjunto debe ser un PDF");
    enviados.push({ tipo: "document", body: `${filename}
${caption}` });
    lastPdfId = `wamid.pdf${++msgSeq}`;
    return lastPdfId;
  },
  downloadMedia: async (id: string) => {
    if (id === "logo-png") return { data: PNG_1x1, mimeType: "image/png" };
    if (id === "no-imagen") return { data: Buffer.from("hola"), mimeType: "image/png" };
    throw new Error("no media en test");
  },
};
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

// Emisión simulada (no llama a ARCA): guarda en historial y genera un PDF real, como el servicio.
const { ArcaPdfService } = await import("./services/pdf.service.js");
let nro = 0;
let emisiones = 0;
(ArcaBillingService as any).emitirComprobante = async (input: any) => {
  emisiones++;
  nro++;
  const esNc = input.tipoComprobante === 14;
  const pdfPath = await ArcaPdfService.guardarPdfEnDisco(
    {
      emisorRazonSocial: "Pinturería Test", emisorCuit: 20111111112, tipoComprobanteLetra: "C",
      tipoComprobanteNombre: esNc ? "Nota de Crédito" : "Factura", tipoComprobanteCodigo: input.tipoComprobante,
      puntoVenta: 1, numeroComprobante: nro, fechaEmision: "20261021", receptorRazonSocial: input.receptorRazonSocial,
      items: input.items, importeNeto: input.importeNeto, importeIva: 0, importeTotal: input.importeTotal,
      cae: "75000000000000", caeVencimiento: "20261031", qrUrl: "https://www.arca.gob.ar/fe/qr/?p=test",
    },
    tmpDir
  );
  const reg = await InvoiceHistoryStorage.save({
    puntoVenta: 1,
    tipoComprobante: input.tipoComprobante,
    tipoComprobanteNombre: esNc ? "Nota de Crédito C" : "Factura C",
    tipoComprobanteLetra: "C",
    numeroComprobante: nro,
    numeroFormateado: `00001-${String(nro).padStart(8, "0")}`,
    fechaEmision: "20261021",
    fechaEmisionFormateada: "21/10/2026",
    receptorRazonSocial: input.receptorRazonSocial ?? "Consumidor Final",
    receptorDocTipo: "Consumidor Final",
    receptorDocNro: input.numeroDocumento,
    receptorCondicionIva: String(input.condicionIvaReceptor),
    importeNeto: input.importeNeto,
    importeIva: input.importeIva ?? 0,
    importeTributos: 0,
    importeTotal: input.importeTotal,
    cae: "75000000000000",
    caeVencimiento: "20261031",
    qrUrl: "https://www.arca.gob.ar/fe/qr/?p=test",
    pdfPath,
    comprobantesAsociados: input.comprobantesAsociados,
    concepto: input.concepto,
  });
  return {
    exito: true, registroId: reg.id, cae: "75000000000000", caeVencimiento: "20261031",
    numeroComprobante: nro, puntoVenta: 1, tipoComprobante: input.tipoComprobante,
    fechaEmision: "20261021", importeTotal: input.importeTotal, rawResponse: {},
    pdf: { filePath: pdfPath, fileName: path.basename(pdfPath) },
  };
};

// ---------------------------------------------------------------- validaciones del registro
assert.equal(reg.parsearFechaInicio("15/03/2020"), "2020-03-15");
assert.equal(reg.parsearFechaInicio("31/02/2020"), null, "fecha inexistente");
assert.equal(reg.parsearFechaInicio("01/01/2999"), null, "fecha futura");
assert.equal(reg.parsearIngresosBrutos("igual al cuit", 20111111112), "20-11111111-2");
assert.equal(reg.parsearIngresosBrutos("901-123456-7"), "901-123456-7");
assert.equal(reg.parsearIngresosBrutos("$$"), null);
assert.equal(reg.parsearPuntoVenta("0"), null);
assert.equal(reg.parsearPuntoVenta("12"), 12);
assert.equal(reg.parsearEmail("Hola@Empresa.com.ar"), "hola@empresa.com.ar");
assert.equal(reg.tipoImagen(PNG_1x1), "png");
assert.equal(reg.tipoImagen(Buffer.from("GIF89a")), null);
console.log("✔ Validaciones del registro");

const from = "5491100000000";
const bot = new WhatsAppBotService({ ...mono, allowedNumbers: [from] }, fakeWa);
let inId = 0;
const enviar = (m: Partial<import("./whatsapp/bot.service.js").MensajeEntrante>) =>
  bot.procesar({ id: `wamid.in${++inId}`, from, type: m.buttonId ? "interactive" : "text", ...m });
const ultimo = () => enviados[enviados.length - 1];

// 0) Sin empresa registrada no se puede facturar
await enviar({ text: "nueva venta de pintura por 130.000" });
assert.match(ultimo().body, /nueva empresa/);
assert.equal(emisiones, 0);

// 0b) Registro completo de una empresa por WhatsApp
(PadronService as any).consultar = async () => null; // sin ARCA en el test
let consultasUltimo = 0;
(ArcaBillingService as any).obtenerUltimoComprobante = async (pto: number) => {
  consultasUltimo++;
  return { puntoVenta: pto, tipoComprobante: 11, ultimoNumero: 0 };
};
await enviar({ text: "nueva empresa" });
assert.match(ultimo().body, /CUIT/);
await enviar({ text: "20-11111111-3" });
assert.match(ultimo().body, /no es válido/);
await enviar({ text: "20-11111111-2" });
assert.match(ultimo().body, /razón social/);
await enviar({ text: "Pinturería Test SRL" });
assert.match(ultimo().body, /nombre de fantasía/);
await enviar({ buttonId: ultimo().buttons![0] }); // Saltar
assert.match(ultimo().body, /domicilio comercial/);
await enviar({ text: "Av. Siempreviva 742, Springfield" });
assert.equal(ultimo().tipo, "buttons");
assert.match(ultimo().body, /condición frente al IVA/);
await enviar({ buttonId: ultimo().buttons!.find((b) => b.endsWith("cond_MONOTRIBUTO"))! });
assert.match(ultimo().body, /Ingresos Brutos/);
await enviar({ buttonId: ultimo().buttons![0] }); // Igual al CUIT
assert.match(ultimo().body, /inicio de actividades/);
await enviar({ text: "32/01/2020" });
assert.match(ultimo().body, /fecha válida/);
await enviar({ text: "15/03/2020" });
assert.match(ultimo().body, /punto de venta/);
await enviar({ text: "3" });
assert.match(ultimo().body, /categoría de Monotributo/);
await enviar({ text: "logo" }); // en pleno registro no es un comando
assert.match(ultimo().body, /letra de la A a la K/);
await enviar({ text: "c" });
assert.match(ultimo().body, /email/);
await enviar({ text: "ventas@pintureria.com" });
assert.match(ultimo().body, /logo/);
await enviar({ mediaId: "no-imagen", type: "image" } as any);
assert.match(ultimo().body, /JPG o PNG/);
await enviar({ mediaId: "logo-png", type: "image" } as any);
assert.match(ultimo().body, /conecta la empresa con ARCA/);
await enviar({ buttonId: ultimo().buttons![0] }); // Delegación
assert.match(ultimo().body, /Revisá los datos/);
assert.match(ultimo().body, /Cat\. C/);
assert.match(ultimo().body, /Logo: cargado/);
// Corregir el punto de venta antes de guardar
await enviar({ buttonId: ultimo().buttons![1] });
assert.equal(ultimo().tipo, "list");
await enviar({ buttonId: ultimo().buttons!.find((b) => b.endsWith("fix_punto_venta"))! });
assert.match(ultimo().body, /punto de venta/);
await enviar({ text: "1" });
assert.match(ultimo().body, /Punto de venta: 1/);
await enviar({ buttonId: ultimo().buttons![0] }); // Guardar
assert.match(ultimo().body, /Conexión con ARCA OK/);
assert.equal(consultasUltimo, 1);
const empresaTest = (await EmpresaRepository.listarPorTelefono(from))[0];
assert.equal(empresaTest.razonSocial, "Pinturería Test SRL");
assert.equal(empresaTest.ingresosBrutos, "20-11111111-2");
assert.equal(empresaTest.inicioActividades, "2020-03-15");
assert.equal(empresaTest.monotributoCategoria, "C");
assert.ok(empresaTest.logoPath && fs.existsSync(empresaTest.logoPath), "el logo se guardó");
assert.equal((await EmpresaRepository.activaDe(from))?.id, empresaTest.id);
// Registrar otra vez el mismo CUIT no duplica
await enviar({ text: "nueva empresa" });
await enviar({ text: "20111111112" });
assert.match(ultimo().body, /ya está registrada/);
console.log("✔ Registro de empresa");

// 1) El ejemplo pedido: falta el cliente -> lo dice y ofrece botón Consumidor Final
await enviar({ text: "nueva venta de pintura por 130.000" });
assert.equal(ultimo().tipo, "buttons");
assert.match(ultimo().body, /Venta de pintura/);
assert.match(ultimo().body, /130\.000,00/);
assert.match(ultimo().body, /me falta/);
assert.match(ultimo().body, /cliente/i);
assert.doesNotMatch(ultimo().body, /monto\*|Qué vendiste/);

// 2) Toca "Consumidor Final" -> resumen con botones
await enviar({ buttonId: ultimo().buttons![0] });
assert.equal(ultimo().tipo, "buttons");
assert.match(ultimo().body, /Factura C/);
assert.match(ultimo().body, /Venta de pintura/);
const botonEmitir = ultimo().buttons![0];

// 3) Confirma -> emite y manda el PDF al chat
await enviar({ buttonId: botonEmitir });
assert.equal(emisiones, 1);
const pdfEnviado = enviados.find((e) => e.tipo === "document");
assert.ok(pdfEnviado, "debe mandar el PDF como documento");
assert.match(pdfEnviado!.body, /^Factura_C_00001-00000001\.pdf/);
const guardada = await InvoiceHistoryStorage.getById("00001-00000001", empresaTest.cuit);
assert.equal(guardada?.empresaId, empresaTest.id, "la factura queda asociada a la empresa");

// 4) Doble toque del mismo botón -> no emite de nuevo
await enviar({ buttonId: botonEmitir });
assert.equal(emisiones, 1);
assert.match(ultimo().body, /ya no está vigente/);

// 5) Falta todo menos el concepto; responde con un DNI suelto
await enviar({ text: "venta de rodillos" });
assert.match(ultimo().body, /El monto/);
assert.match(ultimo().body, /El cliente/);
await enviar({ text: "25 mil" });
assert.match(ultimo().body, /El cliente/);
await enviar({ text: "30.123.456" });
assert.equal(ultimo().tipo, "buttons");
assert.match(ultimo().body, /DNI 30123456/);
assert.match(ultimo().body, /25\.000,00/);
await enviar({ text: "cancelar" });
assert.match(ultimo().body, /cancelado/i);

// 6) Anular respondiendo al PDF
await enviar({ text: "anulala", contextMessageId: lastPdfId });
assert.match(ultimo().body, /Nota de Crédito/);
await enviar({ buttonId: ultimo().buttons![0] });
assert.equal(emisiones, 2);
await enviar({ text: "anulá la 00001-00000001" });
assert.match(ultimo().body, /ya fue anulada/);

console.log("✔ Conversación simulada");
console.log("\nMensajes que mandó el bot:\n");
for (const e of enviados) console.log(`[${e.tipo}] ${e.body}\n`);

await execute(`DROP DATABASE IF EXISTS \`${DB_TEST}\``);
await closeDatabase();
process.chdir(os.tmpdir());
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("Todas las pruebas pasaron ✅");

/**
 * Prueba offline del bot de WhatsApp: no llama a ARCA ni a WhatsApp ni a Gemini.
 * Usa una base MySQL temporal (<MYSQL_DATABASE>_test, se borra al terminar), un cliente
 * de WhatsApp falso, un padrón simulado y una emisión simulada.
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
process.env.GEMINI_API_KEY = ""; // fuerza el parser sin IA
process.env.APP_ENCRYPTION_KEY ||= "clave-de-prueba";
const certPath = path.resolve(process.env.ARCA_CERT_PATH || "certs/testing.crt");
const keyPath = path.resolve(process.env.ARCA_KEY_PATH || "certs/testing.key");
process.env.ARCA_CERT_PATH = certPath;
process.env.ARCA_KEY_PATH = keyPath;
process.chdir(tmpDir); // logos y PDFs del test van a la carpeta temporal

const fe = await import("./whatsapp/fiscal-engine.js");
const { AiExtractorService } = await import("./whatsapp/ai-extractor.service.js");
const { WhatsAppBotService } = await import("./whatsapp/bot.service.js");
const { ArcaBillingService, getNombreTipoComprobante } = await import("./services/arca-billing.service.js");
const { InvoiceHistoryStorage } = await import("./storage/invoice-history.storage.js");
const { ArcaPdfService } = await import("./services/pdf.service.js");
const { closeDatabase, execute } = await import("./db/database.js");
const { EmpresaRepository } = await import("./empresas/empresa.repository.js");
const { ConfiguracionRepository } = await import("./config/configuracion.repository.js");
const { PadronService } = await import("./whatsapp/padron.service.js");
const { ArcaBusinessError } = await import("./errors/arca-errors.js");
const reg = await import("./whatsapp/registro-empresa.flow.js");
const { FceService } = await import("./whatsapp/fce.service.js");
const { validarCbu } = await import("./utils/validation.utils.js");
const { empresaActual } = await import("./empresas/empresa.context.js");

// Base de prueba limpia
await execute(`DROP TABLE IF EXISTS whatsapp_invoice_messages, whatsapp_processed_messages, whatsapp_sessions,
  audit_logs, clientes, invoices, arca_tickets, usuarios_whatsapp, empresa_usuarios, empresas, configuracion, schema_migrations`);
await closeDatabase();
ConfiguracionRepository.limpiarCache();

// ------------------------------------------------------------------ reglas fiscales
const { determinarComprobante: tipo } = fe;
assert.equal(tipo("MONOTRIBUTO", "RESPONSABLE_INSCRIPTO").letra, "C");
assert.equal(tipo("EXENTO", "CONSUMIDOR_FINAL").letra, "C");
assert.equal(tipo("RESPONSABLE_INSCRIPTO", "RESPONSABLE_INSCRIPTO").letra, "A");
assert.equal(tipo("RESPONSABLE_INSCRIPTO", "MONOTRIBUTO").letra, "A");
assert.equal(tipo("RESPONSABLE_INSCRIPTO", "EXENTO").letra, "B");
assert.equal(tipo("RESPONSABLE_INSCRIPTO", "CONSUMIDOR_FINAL").letra, "B");
assert.ok(fe.cuitsPosiblesDesdeDni("38545266").includes("20385452668"), "DNI -> CUIT con prefijo 20");
const imp = fe.calcularImportes({ montoTotal: 121000 }, "A");
assert.ok(!("error" in imp) && imp.neto === 100000 && imp.iva === 21000);
const impMas = fe.calcularImportes({ montoTotal: 100000, ivaIncluido: false }, "B");
assert.ok(!("error" in impMas) && impMas.total === 121000);
for (const total of [99.99, 1234.57, 12000, 33333.33]) {
  const x = fe.calcularImportes({ montoTotal: total }, "A");
  assert.ok(!("error" in x) && Math.round((x.neto + x.iva) * 100) === Math.round(total * 100), "neto + IVA = total");
}
assert.equal(tipo("RESPONSABLE_INSCRIPTO", "RESPONSABLE_INSCRIPTO", true).cbteTipo, 201, "FCE A");
assert.equal(tipo("RESPONSABLE_INSCRIPTO", "EXENTO", true).cbteTipo, 206, "FCE B");
assert.equal(tipo("MONOTRIBUTO", "RESPONSABLE_INSCRIPTO", true).cbteTipo, 211, "FCE C");
assert.equal(fe.limpiarConcepto("Nueva venta de pintura por 123.450"), "Venta de pintura");
assert.equal(fe.limpiarConcepto("servicio de diseño por $45 mil al cuit 20-12345678-9"), "Servicio de diseño");
console.log("✔ Reglas fiscales");

// ------------------------------------------------------------------ parser sin IA
const p = AiExtractorService.extraerSinIa("nueva venta de papel por 12000");
assert.equal(p.montoTotal, 12000);
assert.match(p.conceptoDescripcion ?? "", /papel/i);
assert.equal(AiExtractorService.extraerSinIa("Facturale 45 mil a consumidor final por servicio de diseño").montoTotal, 45000);
assert.equal(AiExtractorService.extraerSinIa("120.000 más IVA").ivaIncluido, false);
console.log("✔ Parser sin IA");

// CBU válido de prueba: se calculan los dos dígitos verificadores
function cbuValido(banco7: string, cuenta13: string): string {
  const dv = (d: string, w: number[]) => (10 - (d.split("").reduce((a, x, i) => a + Number(x) * w[i], 0) % 10)) % 10;
  return `${banco7}${dv(banco7, [7, 1, 3, 9, 7, 1, 3])}${cuenta13}${dv(cuenta13, [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3])}`;
}
const CBU_OK = cbuValido("0110599", "5200000000001");
assert.ok(validarCbu(CBU_OK));
assert.ok(!validarCbu(CBU_OK.slice(0, 21) + ((Number(CBU_OK[21]) + 1) % 10)), "dígito verificador incorrecto");
console.log("✔ Validación de CBU");

// ------------------------------------------------------------------ validaciones del registro
assert.equal(reg.parsearFechaInicio("15/03/2020"), "2020-03-15");
assert.equal(reg.parsearFechaInicio("31/02/2020"), null);
assert.equal(reg.parsearFechaInicio("01/01/2999"), null);
assert.equal(reg.parsearIngresosBrutos("igual al cuit", 20111111112), "20-11111111-2");
assert.equal(reg.parsearPuntoVenta("0"), null);
console.log("✔ Validaciones del registro");

// ------------------------------------------------------------------ dobles de prueba
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
type Enviado = { tipo: string; body: string; buttons?: string[] };
const enviados: Enviado[] = [];
let msgSeq = 0;
const pdfIds: string[] = [];
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
    assert.equal(buf.subarray(0, 4).toString(), "%PDF");
    enviados.push({ tipo: "document", body: `${filename}\n${caption}` });
    const id = `wamid.pdf${++msgSeq}`;
    pdfIds.push(id);
    return id;
  },
  downloadMedia: async (id: string) => {
    if (id === "logo-png") return { data: PNG_1x1, mimeType: "image/png" };
    throw new Error("no media en test");
  },
};

// CUITs de clientes de prueba (válidos)
const CUIT_EMISOR = "20385452668";
const [CUIT_RI] = fe.cuitsPosiblesDesdeDni("71234567").filter((c) => c.startsWith("20"));
const [CUIL_EMPLEADO] = fe.cuitsPosiblesDesdeDni("33444555").filter((c) => c.startsWith("27"));
const [CUIT_SIN_PADRON] = fe.cuitsPosiblesDesdeDni("22333444").filter((c) => c.startsWith("20"));
const [CUIT_DEL_DNI] = fe.cuitsPosiblesDesdeDni("30123456").filter((c) => c.startsWith("20"));
const [CUIT_GRANDE] = fe.cuitsPosiblesDesdeDni("50100200").filter((c) => c.startsWith("20"));

const padron = new Map<string, any>([
  [CUIT_RI, { estado: "OK", condicion: "RESPONSABLE_INSCRIPTO", razonSocial: "PAPELERA SUR SA", domicilio: "Av. Mitre 100, Avellaneda", fuente: "PADRON" }],
  [CUIL_EMPLEADO, { estado: "SIN_ALTA", razonSocial: "PEREZ ANA" }],
  [CUIT_DEL_DNI, { estado: "OK", condicion: "MONOTRIBUTO", razonSocial: "GOMEZ JUAN", fuente: "PADRON" }],
  [CUIT_GRANDE, { estado: "OK", condicion: "RESPONSABLE_INSCRIPTO", razonSocial: "GRAN EMPRESA SA", domicilio: "Av. Corrientes 1, CABA", fuente: "PADRON" }],
]);
// wsfecred simulado: solo la "gran empresa" está obligada a recibir FCE, desde $ 3.958.316
(FceService as any).consultar = async (cuit: string) =>
  cuit === CUIT_GRANDE ? { estado: "OBLIGADO", montoDesde: 3958316 } : cuit === CUIT_SIN_PADRON ? { estado: "NO_VERIFICADO", motivo: "test" } : { estado: "NO_OBLIGADO" };
(PadronService as any).consultar = async (cuit: string) =>
  padron.get(cuit) ?? (cuit === CUIT_SIN_PADRON || cuit === CUIT_EMISOR ? { estado: "NO_DISPONIBLE", motivo: "test" } : { estado: "SIN_ALTA" });

(ArcaBillingService as any).obtenerUltimoComprobante = async (pto: number) => ({ puntoVenta: pto, tipoComprobante: 6, ultimoNumero: 0 });

// Emisión simulada: guarda en el historial y genera el PDF real, como el servicio.
const emitidos: any[] = [];
const numeros = new Map<number, number>();
let rechazarProxima = false;
(ArcaBillingService as any).emitirComprobante = async (input: any) => {
  if (rechazarProxima) {
    rechazarProxima = false;
    throw new ArcaBusinessError("El comprobante fue rechazado por ARCA.", [{ code: 10015, msg: "Error de prueba" }]);
  }
  emitidos.push(input);
  const empresa = empresaActual()!;
  const nro = (numeros.get(input.tipoComprobante) ?? 0) + 1;
  numeros.set(input.tipoComprobante, nro);
  const { nombre, letra } = getNombreTipoComprobante(input.tipoComprobante);
  const pdfPath = await ArcaPdfService.guardarPdfEnDisco({
    emisorRazonSocial: empresa.razonSocial, emisorCuit: empresa.cuit, emisorLogoPath: empresa.logoPath,
    tipoComprobanteLetra: letra, tipoComprobanteNombre: nombre, tipoComprobanteCodigo: input.tipoComprobante,
    puntoVenta: 1, numeroComprobante: nro, fechaEmision: "20261021", receptorRazonSocial: input.receptorRazonSocial,
    items: input.items, importeNeto: input.importeNeto, importeIva: input.importeIva, importeTotal: input.importeTotal,
    cae: "75000000000000", caeVencimiento: "20261031", qrUrl: "https://www.arca.gob.ar/fe/qr/?p=test",
  });
  const r = await InvoiceHistoryStorage.save({
    puntoVenta: 1, tipoComprobante: input.tipoComprobante, tipoComprobanteNombre: `${nombre} ${letra}`,
    tipoComprobanteLetra: letra, numeroComprobante: nro, numeroFormateado: `00001-${String(nro).padStart(8, "0")}`,
    fechaEmision: "20261021", fechaEmisionFormateada: "21/10/2026", receptorRazonSocial: input.receptorRazonSocial ?? "Consumidor Final",
    receptorDocTipo: input.tipoDocumento === 80 ? "CUIT" : input.tipoDocumento === 96 ? "DNI" : "Consumidor Final",
    receptorDocNro: input.numeroDocumento, receptorCondicionIva: String(input.condicionIvaReceptor),
    importeNeto: input.importeNeto, importeIva: input.importeIva ?? 0, importeTributos: 0, importeTotal: input.importeTotal,
    cae: "75000000000000", caeVencimiento: "20261031", qrUrl: "https://www.arca.gob.ar/fe/qr/?p=test", pdfPath,
    comprobantesAsociados: input.comprobantesAsociados, concepto: input.concepto, alicuotasIva: input.alicuotasIva, items: input.items,
  });
  return {
    exito: true, registroId: r.id, cae: "75000000000000", caeVencimiento: "20261031", numeroComprobante: nro, puntoVenta: 1,
    tipoComprobante: input.tipoComprobante, fechaEmision: "20261021", importeTotal: input.importeTotal, rawResponse: {},
    pdf: { filePath: pdfPath, fileName: path.basename(pdfPath) },
  };
};

const from = "5491100000000";
const bot = new WhatsAppBotService(undefined, fakeWa);
let inId = 0;
const enviar = (m: Record<string, any>) =>
  bot.procesar({ id: `wamid.in${++inId}`, from, type: m.buttonId ? "interactive" : m.mediaId ? "image" : "text", ...m });
const ultimo = () => enviados[enviados.length - 1];
const boton = (sufijo: string) => {
  const b = [...enviados].reverse().find((e) => e.buttons)?.buttons?.find((id) => id.includes(sufijo));
  assert.ok(b, `no encontré el botón ${sufijo} en: ${JSON.stringify(ultimo())}`);
  return enviar({ buttonId: b });
};
const desde = (n: number) => enviados.slice(n).map((e) => e.body).join("\n---\n");

// ------------------------------------------------------------------ 1) Primer mensaje: configuración inicial
await enviar({ text: "hola" });
assert.match(desde(0), /configurar tu empresa/);
assert.match(ultimo().body, /CUIT/);
await enviar({ text: CUIT_EMISOR });
assert.match(ultimo().body, /razón social/);
await enviar({ text: "Facturita Bot S.A." });
await boton(":saltar"); // nombre de fantasía
await enviar({ text: "Av. Siempreviva 742, CABA" });
await boton("cond_RESPONSABLE_INSCRIPTO");
await boton("iibb_cuit");
await enviar({ text: "19/04/2026" });
await enviar({ text: "1" });
assert.match(ultimo().body, /Qué vende/);
await boton("concepto_1");
await boton(":saltar"); // email
assert.match(ultimo().body, /conecta la empresa con ARCA/);
await boton("cert_sistema");
assert.match(ultimo().body, /logo/, "el logo es el último dato");
await enviar({ text: "hola" }); // un texto no reemplaza al logo
assert.match(ultimo().body, /imagen/);
await enviar({ mediaId: "logo-png" });
assert.match(ultimo().body, /Revisá los datos/);
assert.match(ultimo().body, /IVA Responsable Inscripto/);
assert.match(ultimo().body, /Vende: productos/);
let n = enviados.length;
await boton("guardar");
assert.match(desde(n), /Configuración lista/);
assert.match(desde(n), /nueva venta de papel por 12000/);
const empresa = (await EmpresaRepository.listarPorTelefono(from))[0];
assert.equal(empresa.condicionIva, "RESPONSABLE_INSCRIPTO");
assert.equal(empresa.ingresosBrutos, "20-38545266-8");
assert.equal(empresa.inicioActividades, "2026-04-19");
assert.equal(empresa.conceptoDefault, 1);
assert.ok(empresa.logoPath && fs.existsSync(empresa.logoPath));
assert.equal(empresa.produccion, false, "el ambiente sale de la tabla configuracion");
console.log("✔ Configuración inicial");

// ------------------------------------------------------------------ 2) Consumidor final -> Factura B
await enviar({ text: "nueva venta de papel por 12000" });
assert.equal(ultimo().tipo, "buttons");
assert.match(ultimo().body, /A quién le facturás/);
assert.match(ultimo().body, /papel/i);
assert.equal(ultimo().buttons!.length, 3);
await boton("cli_CONSUMIDOR_FINAL");
assert.match(ultimo().body, /Factura B/);
assert.match(ultimo().body, /12\.000,00/);
await boton("emitir");
assert.equal(emitidos.length, 1);
assert.equal(emitidos[0].tipoComprobante, 6);
assert.equal(emitidos[0].tipoDocumento, 99);
assert.equal(emitidos[0].condicionIvaReceptor, 5);
assert.match(ultimo().body, /^Factura_B_00001-00000001\.pdf/);
await boton("emitir").catch(() => undefined); // doble toque
assert.equal(emitidos.length, 1, "el doble toque no emite dos veces");
console.log("✔ Venta a consumidor final (Factura B)");

// ------------------------------------------------------------------ 3) CUIT Responsable Inscripto -> Factura A
n = enviados.length;
await enviar({ text: "nueva venta de papel por 12000" });
await boton("cli_CUIT");
assert.match(ultimo().body, /CUIT o CUIL/);
await enviar({ text: fe.formatearCuit(CUIT_RI) });
assert.match(desde(n), /PAPELERA SUR SA/);
assert.match(desde(n), /Le corresponde \*Factura A\*/);
assert.match(ultimo().body, /Factura A/);
assert.match(ultimo().body, /Av\. Mitre 100/);
assert.match(ultimo().body, /Neto gravado: \$\s?9\.917,36/);
assert.match(ultimo().body, /IVA 21%: \$\s?2\.082,64/);
await boton("emitir");
assert.equal(emitidos[1].tipoComprobante, 1);
assert.equal(emitidos[1].tipoDocumento, 80);
assert.equal(emitidos[1].condicionIvaReceptor, 1);
assert.equal(emitidos[1].receptorRazonSocial, "PAPELERA SUR SA");
console.log("✔ Venta a Responsable Inscripto (Factura A)");

// ------------------------------------------------------------------ 3b) Gran empresa por encima del mínimo -> Factura de Crédito MiPyME A
n = enviados.length;
await enviar({ text: "nueva venta de papel por 5 millones" });
await boton("cli_CUIT");
await enviar({ text: CUIT_GRANDE });
assert.match(desde(n), /Factura de Crédito Electrónica MiPyME A/);
assert.match(ultimo().body, /CBU de la empresa/);
await enviar({ text: "123" });
assert.match(ultimo().body, /CBU no es válido/);
await enviar({ text: CBU_OK });
assert.match(desde(n), /CBU guardado/);
assert.match(ultimo().body, /vence el pago/);
await boton("vto_30");
assert.match(ultimo().body, /Factura de Crédito Electrónica MiPyME A/);
assert.match(ultimo().body, new RegExp(CBU_OK));
assert.match(ultimo().body, /Vencimiento del pago: \d{2}\/\d{2}\/\d{4}/);
await boton("emitir");
const fceEmitida = emitidos[emitidos.length - 1];
assert.equal(fceEmitida.tipoComprobante, 201);
assert.deepEqual(fceEmitida.opcionales, [{ id: 2101, valor: CBU_OK }, { id: 27, valor: "SCA" }]);
assert.match(fceEmitida.fechaVencimientoPago, /^\d{8}$/);
assert.equal((await EmpresaRepository.porId(empresa.id))?.cbu, CBU_OK, "el CBU queda guardado en la empresa");
// Misma gran empresa por debajo del mínimo: factura común y no pide CBU
await enviar({ text: "nueva venta de papel por 12000" });
await boton("cli_CUIT");
await enviar({ text: CUIT_GRANDE });
assert.match(ultimo().body, /📄 \*Factura A\*/);
await boton("emitir");
assert.equal(emitidos[emitidos.length - 1].tipoComprobante, 1);
assert.equal(emitidos[emitidos.length - 1].opcionales, undefined);
console.log("✔ Factura de Crédito Electrónica MiPyME");

// ------------------------------------------------------------------ 4) CUIL sin alta en ARCA -> consumidor final, DocTipo 86
n = enviados.length;
await enviar({ text: "nueva venta de papel por 5000" });
await boton("cli_CUIT");
await enviar({ text: CUIL_EMPLEADO });
assert.match(desde(n), /CUIL/);
assert.match(ultimo().body, /Factura B/);
assert.match(ultimo().body, /PEREZ ANA/);
await boton("emitir");
assert.equal(emitidos[emitidos.length - 1].tipoDocumento, 86);
assert.equal(emitidos[emitidos.length - 1].condicionIvaReceptor, 5);
console.log("✔ CUIL sin impuestos (DocTipo 86)");

// ------------------------------------------------------------------ 5) Padrón no disponible -> pregunta la condición y los datos de la A
await enviar({ text: "nueva venta de papel por 12000" });
await boton("cli_CUIT");
await enviar({ text: CUIT_SIN_PADRON });
assert.equal(ultimo().tipo, "list");
assert.match(ultimo().body, /condición frente al IVA/);
await boton("cond_MONOTRIBUTO");
assert.match(ultimo().body, /razón social/);
await enviar({ text: "Kiosco El Sol" });
assert.match(ultimo().body, /domicilio comercial/);
await enviar({ text: "saltar" });
assert.match(ultimo().body, /exige el domicilio/);
await enviar({ text: "Belgrano 55, Quilmes" });
assert.match(ultimo().body, /Factura A/);
assert.match(ultimo().body, /Kiosco El Sol/);
assert.match(ultimo().body, /No pude verificar con ARCA si el cliente está obligado/);
// Corregir el monto desde el resumen
await boton("corregir");
assert.equal(ultimo().tipo, "list");
await boton("fix_monto");
assert.match(ultimo().body, /Por cuánto/);
await enviar({ text: "24.200" });
assert.match(ultimo().body, /24\.200,00/);
assert.match(ultimo().body, /Kiosco El Sol/, "corregir el monto no pierde el cliente");
// ARCA rechaza: no se emite y vuelve a ofrecer corregir
rechazarProxima = true;
n = enviados.length;
await boton("emitir");
assert.match(desde(n), /\[10015\] Error de prueba/);
assert.equal(ultimo().tipo, "list", "después de un rechazo ofrece corregir");
await boton("fix_descripcion");
await enviar({ text: "resmas A4" });
await boton("emitir");
assert.equal(emitidos[emitidos.length - 1].tipoComprobante, 1);
assert.equal(emitidos[emitidos.length - 1].condicionIvaReceptor, 6);
assert.equal(emitidos[emitidos.length - 1].receptorDomicilio, "Belgrano 55, Quilmes");
console.log("✔ Padrón no disponible, corrección y rechazo de ARCA");

// ------------------------------------------------------------------ 6) DNI que tiene CUIT activo -> pregunta a cuál facturar
await enviar({ text: "nueva venta de papel por 3000" });
await boton("cli_DNI");
assert.match(ultimo().body, /DNI/);
await enviar({ text: "30.123.456" });
assert.match(ultimo().body, /GOMEZ JUAN/);
assert.match(ultimo().body, /A su CUIT|CUIT o como consumidor final/);
await boton("usar_dni");
assert.match(ultimo().body, /Factura B/);
assert.match(ultimo().body, /DNI 30\.123\.456/);
await boton("emitir");
assert.equal(emitidos[emitidos.length - 1].tipoDocumento, 96);
console.log("✔ DNI con CUIT encontrado en el padrón");

// ------------------------------------------------------------------ 7) Propio CUIT y tope de consumidor final
n = enviados.length;
await enviar({ text: "nueva venta de papel por 1000" });
await boton("cli_CUIT");
await enviar({ text: CUIT_EMISOR });
await boton("cond_RESPONSABLE_INSCRIPTO");
await enviar({ text: "Yo mismo" });
await enviar({ text: "Av. Siempreviva 742, CABA" });
assert.match(desde(n), /propia empresa/);
assert.match(ultimo().body, /A quién le facturás/);
await enviar({ text: "cancelar" });
await enviar({ text: "nueva venta de maquinaria por 15 millones" });
assert.equal(ultimo().buttons!.length, 2, "sin opción consumidor final por encima del tope");
await enviar({ text: "cancelar" });
console.log("✔ Auto-factura bloqueada y tope de consumidor final");

// ------------------------------------------------------------------ 8) Anular citando el PDF
await enviar({ text: "anulala", contextMessageId: pdfIds[0] });
assert.match(ultimo().body, /Nota de Crédito/);
await boton("anular_si");
assert.equal(emitidos[emitidos.length - 1].tipoComprobante, 8, "NC B");
await enviar({ text: "anulá la 00001-00000001" });
console.log("✔ Anulación");

console.log("\nTodas las pruebas pasaron ✅");

await execute(`DROP DATABASE IF EXISTS \`${DB_TEST}\``);
await closeDatabase();
process.chdir(os.tmpdir());
fs.rmSync(tmpDir, { recursive: true, force: true });

import PDFDocument from "pdfkit";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ArcaQrService } from "./qr.service.js";

export interface ItemFacturaPdf {
  codigo?: string;
  descripcion: string;
  cantidad: number;
  unidadMedida?: string;
  precioUnitario: number;
  alicuotaIva?: number; // Ej: 21
  subtotal: number;
}

export interface DatosFacturaPdf {
  // Emisor
  emisorRazonSocial: string;
  emisorCuit: number | string;
  emisorCondicionIva?: string;
  emisorDomicilio?: string;
  emisorIngresosBrutos?: string;
  emisorInicioActividades?: string; // YYYY-MM-DD o DD/MM/YYYY
  emisorNombreFantasia?: string;
  /** Leyendas extra arriba de los totales (ej: datos de la Factura de Crédito MiPyME). */
  notas?: string[];
  /** Ruta a un PNG o JPG que se dibuja arriba a la izquierda. */
  emisorLogoPath?: string;

  // Comprobante
  tipoComprobanteLetra: "A" | "B" | "C" | "M";
  tipoComprobanteNombre: string; // ej: FACTURA, NOTA DE CRÉDITO
  tipoComprobanteCodigo: number; // ej: 1, 6, 11
  puntoVenta: number;
  numeroComprobante: number;
  fechaEmision: string; // YYYY-MM-DD o YYYYMMDD
  concepto?: string;

  // Receptor
  receptorRazonSocial?: string;
  receptorDocTipo?: string; // CUIT, DNI
  receptorDocNro?: string | number;
  receptorCondicionIva?: string;
  receptorDomicilio?: string;
  condicionVenta?: string;

  // Items
  items?: ItemFacturaPdf[];

  // Totales
  importeNeto: number;
  importeIva?: number;
  importeTributos?: number;
  importeTotal: number;

  // CAE y QR
  cae: string;
  caeVencimiento: string; // YYYYMMDD o YYYY-MM-DD
  qrUrl: string;
}

const formatoPesos = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 45000 -> "$ 45.000,00" */
function pesos(n: number): string {
  return `$ ${formatoPesos.format(n)}`;
}

/** "2020-03-15" -> "15/03/2020"; deja tal cual otros formatos. */
function formatearFechaIso(fecha?: string): string | undefined {
  if (!fecha) return undefined;
  const m = fecha.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : fecha;
}

export class ArcaPdfService {
  /**
   * Genera el archivo PDF oficial de la factura electrónica en un Buffer de memoria.
   */
  public static async generarPdfBuffer(datos: DatosFacturaPdf): Promise<Buffer> {
    const qrBuffer = await ArcaQrService.generateQrImageBuffer(datos.qrUrl);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: "A4",
        margin: 30,
        bufferPages: true,
      });

      const buffers: Buffer[] = [];
      doc.on("data", (chunk) => buffers.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", (err) => reject(err));

      const ptoVtaFormatted = String(datos.puntoVenta).padStart(5, "0");
      const nroFormatted = String(datos.numeroComprobante).padStart(8, "0");
      const fechaFormatted = datos.fechaEmision.length === 8
        ? `${datos.fechaEmision.slice(6, 8)}/${datos.fechaEmision.slice(4, 6)}/${datos.fechaEmision.slice(0, 4)}`
        : datos.fechaEmision;
      const inicioAct = formatearFechaIso(datos.emisorInicioActividades);
      const vtoCaeFormatted = datos.caeVencimiento.length === 8
        ? `${datos.caeVencimiento.slice(6, 8)}/${datos.caeVencimiento.slice(4, 6)}/${datos.caeVencimiento.slice(0, 4)}`
        : datos.caeVencimiento;

      // --- MARCO EXTERIOR ---
      doc.rect(30, 30, 535, 780).lineWidth(1).stroke("#333333");

      // --- CABECERA: CUADRO DE LETRA CENTRAL ---
      const centerX = 277;
      doc.rect(centerX, 30, 40, 42).lineWidth(1).fillAndStroke("#ffffff", "#333333");
      doc.fillColor("#000000").fontSize(22).font("Helvetica-Bold").text(datos.tipoComprobanteLetra, centerX + 12, 36);
      doc.fontSize(7).font("Helvetica").text(`COD. ${String(datos.tipoComprobanteCodigo).padStart(3, "0")}`, centerX + 3, 62);

      // --- LÍNEA DIVISORIA VERTICAL DE CABECERA ---
      doc.moveTo(297, 72).lineTo(297, 160).lineWidth(0.5).stroke("#999999");

      // --- CABECERA IZQUIERDA: EMISOR (con logo opcional) ---
      let conLogo = false;
      if (datos.emisorLogoPath && existsSync(datos.emisorLogoPath)) {
        try {
          doc.image(datos.emisorLogoPath, 45, 36, { fit: [80, 50], align: "center", valign: "center" });
          conLogo = true;
        } catch (err: any) {
          // Un logo corrupto nunca debe impedir entregar una factura ya autorizada.
          console.warn(`[PDF] No se pudo dibujar el logo (${datos.emisorLogoPath}): ${err?.message ?? err}`);
        }
      }
      const nombreX = conLogo ? 132 : 45;
      const nombreW = conLogo ? 138 : 225;
      doc.fillColor("#111111").fontSize(conLogo ? 11 : 14).font("Helvetica-Bold")
        .text(datos.emisorNombreFantasia ?? datos.emisorRazonSocial, nombreX, 42, { width: nombreW, height: 44, ellipsis: true });
      doc.fontSize(8).font("Helvetica").fillColor("#444444");
      if (datos.emisorNombreFantasia) {
        doc.text(`Razón Social: ${datos.emisorRazonSocial}`, 45, 92, { width: 225, height: 10, ellipsis: true });
      }
      doc.text(`Domicilio Comercial: ${datos.emisorDomicilio ?? "-"}`, 45, 105, { width: 225, height: 22, ellipsis: true });
      doc.text(`Condición frente al IVA: ${datos.emisorCondicionIva ?? "-"}`, 45, 132, { width: 225 });

      // --- CABECERA DERECHA: DATOS DEL COMPROBANTE ---
      // Títulos largos (ej: Factura de Crédito Electrónica MiPyMEs) van más chicos para entrar en una línea.
      const titulo = datos.tipoComprobanteNombre.toUpperCase();
      doc.fillColor("#111111").fontSize(titulo.length > 22 ? 9.5 : 14).font("Helvetica-Bold").text(titulo, 320, titulo.length > 22 ? 49 : 45, { width: 240, lineBreak: false });
      doc.fontSize(9).font("Helvetica-Bold").text(`Punto de Venta: ${ptoVtaFormatted}   Comp. Nro: ${nroFormatted}`, 320, 65);
      doc.font("Helvetica").fontSize(8).fillColor("#444444");
      doc.text(`Fecha de Emisión: ${fechaFormatted}`, 320, 80);
      doc.text(`CUIT: ${datos.emisorCuit}`, 320, 95);
      doc.text(`Ingresos Brutos: ${datos.emisorIngresosBrutos ?? "-"}`, 320, 110);
      doc.text(`Fecha de Inicio de Actividades: ${inicioAct ?? "-"}`, 320, 125);

      // --- LÍNEA SEPARADORA CABECERA / RECEPTOR ---
      doc.moveTo(30, 160).lineTo(565, 160).lineWidth(1).stroke("#333333");

      // --- SECCIÓN: RECEPTOR / CLIENTE ---
      doc.fillColor("#000000").fontSize(8).font("Helvetica");
      const docReceptor = datos.receptorDocNro ? `${datos.receptorDocTipo ?? "Doc"}: ${datos.receptorDocNro}` : "Consumidor Final";
      doc.text(`${docReceptor}`, 45, 170);
      doc.text(`Razón Social / Nombre: ${datos.receptorRazonSocial ?? "Consumidor Final"}`, 220, 170);
      doc.text(`Condición IVA: ${datos.receptorCondicionIva ?? "Consumidor Final"}`, 45, 185);
      doc.text(`Domicilio: ${datos.receptorDomicilio ?? "-"}`, 220, 185);
      doc.text(`Condición de Venta: ${datos.condicionVenta ?? "Contado"}`, 450, 185);

      // --- LÍNEA SEPARADORA RECEPTOR / TABLA ---
      doc.moveTo(30, 205).lineTo(565, 205).lineWidth(1).stroke("#333333");

      // --- TABLA DE ITEMS: ENCABEZADOS ---
      doc.rect(30, 205, 535, 20).fill("#eeeeee");
      doc.fillColor("#000000").fontSize(8).font("Helvetica-Bold");
      doc.text("Descripción", 45, 211, { width: 250 });
      doc.text("Cantidad", 310, 211, { width: 50, align: "right" });
      doc.text("Precio Unit.", 380, 211, { width: 70, align: "right" });
      doc.text("Subtotal", 475, 211, { width: 70, align: "right" });

      // --- ITEMS ---
      let y = 232;
      doc.font("Helvetica").fontSize(8).fillColor("#222222");

      const items = datos.items && datos.items.length > 0
        ? datos.items
        : [
          {
            descripcion: "Servicio / Producto General",
            cantidad: 1,
            precioUnitario: datos.importeNeto,
            subtotal: datos.importeNeto,
          },
        ];

      for (const item of items) {
        doc.text(item.descripcion, 45, y, { width: 250 });
        doc.text(item.cantidad.toString(), 310, y, { width: 50, align: "right" });
        doc.text(pesos(item.precioUnitario), 380, y, { width: 70, align: "right" });
        doc.text(pesos(item.subtotal), 475, y, { width: 70, align: "right" });
        y += 18;
      }

      // --- RESUMEN DE TOTALES (Pie de tabla) ---
      const totalesY = 660;
      if (datos.notas && datos.notas.length > 0) {
        doc.fontSize(8).font("Helvetica").fillColor("#222222");
        datos.notas.forEach((nota, i) => {
          doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").text(nota, 45, totalesY - 12 * (datos.notas!.length - i) - 4, { width: 300 });
        });
      }
      doc.moveTo(30, totalesY).lineTo(565, totalesY).lineWidth(0.5).stroke("#999999");

      doc.fontSize(9).font("Helvetica");
      doc.text(`${datos.tipoComprobanteLetra === "C" ? "Subtotal" : "Importe Neto Gravado"}: ${pesos(datos.importeNeto)}`, 350, totalesY + 10, { width: 200, align: "right" });
      if (datos.importeIva && datos.importeIva > 0) {
        doc.text(`Importe IVA: ${pesos(datos.importeIva)}`, 350, totalesY + 24, { width: 200, align: "right" });
      }
      if (datos.importeTributos && datos.importeTributos > 0) {
        doc.text(`Tributos: ${pesos(datos.importeTributos)}`, 350, totalesY + 38, { width: 200, align: "right" });
      }

      doc.fontSize(12).font("Helvetica-Bold").fillColor("#000000");
      doc.text(`IMPORTE TOTAL: ${pesos(datos.importeTotal)}`, 320, totalesY + 54, { width: 230, align: "right" });

      // --- PIE DE PÁGINA OFICIAL REGLAMENTARIO (AFIP / ARCA) ---
      const pieY = 730;
      doc.moveTo(30, pieY).lineTo(565, pieY).lineWidth(1).stroke("#333333");

      // Imagen del QR oficial
      doc.image(qrBuffer, 40, pieY + 6, { width: 68, height: 68 });

      // Leyendas y CAE
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#111111");
      doc.text("ARCA / AFIP — Comprobante Autorizado", 120, pieY + 12);
      doc.fontSize(8).font("Helvetica").fillColor("#444444");
      doc.text("Esta factura fue autorizada mediante el Web Service oficial de Facturación Electrónica.", 120, pieY + 26);

      doc.fontSize(9).font("Helvetica-Bold").fillColor("#000000");
      doc.text(`CAE N°: ${datos.cae}`, 360, pieY + 45, { width: 190, align: "right" });
      doc.text(`Fecha de Vto. de CAE: ${vtoCaeFormatted}`, 360, pieY + 60, { width: 190, align: "right" });

      doc.end();
    });
  }

  /**
   * Genera y guarda físicamente el PDF de la factura en el disco (carpeta `invoices/`).
   */
  public static async guardarPdfEnDisco(datos: DatosFacturaPdf, carpetaSalida?: string): Promise<string> {
    // Una carpeta por CUIT emisor: dos empresas pueden tener el mismo número de comprobante.
    const dir = carpetaSalida ?? path.resolve(process.cwd(), "invoices", String(datos.emisorCuit).replace(/\D/g, ""));
    await fs.mkdir(dir, { recursive: true });

    const ptoVtaFormatted = String(datos.puntoVenta).padStart(5, "0");
    const nroFormatted = String(datos.numeroComprobante).padStart(8, "0");
    // Se incluye la letra: la Factura A 1 y la Factura B 1 son comprobantes distintos.
    const fileName = `${datos.tipoComprobanteNombre.replace(/\s+/g, "_")}_${datos.tipoComprobanteLetra}_${ptoVtaFormatted}-${nroFormatted}.pdf`;
    const filePath = path.resolve(dir, fileName);

    const pdfBuffer = await this.generarPdfBuffer(datos);
    await fs.writeFile(filePath, pdfBuffer);

    return filePath;
  }
}

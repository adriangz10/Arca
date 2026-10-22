import path from "node:path";
import {
  CbteTipo,
  DocTipo,
  Concepto,
  IvaAlicuota,
  CondicionIVAReceptor,
  TipoComprobante,
} from "../constants/arca.constants.js";
import type {
  EmitirComprobanteInput,
  EmitirFacturaAInput,
  EmitirFacturaBInput,
  EmitirFacturaCInput,
  EmitirFacturaMInput,
  EmitirNotaCreditoInput,
  EmitirNotaDebitoInput,
  EmitirReciboInput,
  EmitirFceInput,
  ComprobanteEmitidoResultado,
} from "../types/billing.types.js";
import { ArcaClientFactory } from "./arca-client.factory.js";
import { ArcaQrService } from "./qr.service.js";
import { ArcaPdfService, type DatosFacturaPdf } from "./pdf.service.js";
import { InvoiceHistoryStorage, type FacturaRegistro } from "../storage/invoice-history.storage.js";
import { AuditStorage, execute } from "../db/database.js";
import { empresaActual } from "../empresas/empresa.context.js";
import { NOMBRE_CONDICION_EMISOR } from "../empresas/empresa.types.js";
import { NOMBRE_CONDICION_IVA } from "../constants/condicion-iva.js";
import { parseArcaError, ArcaBusinessError, ArcaValidationError } from "../errors/arca-errors.js";
import { validarCuit, validarCbu, validarEcuacionFiscal, validarCoherenciaFechas } from "../utils/validation.utils.js";
import { emissionMutex } from "../utils/keyed-mutex.js";
function getFormattedDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function getNombreTipoComprobante(tipo: TipoComprobante): {
  nombre: string;
  letra: "A" | "B" | "C" | "M";
} {
  switch (tipo) {
    case CbteTipo.FACTURA_A:
      return { nombre: "Factura", letra: "A" };
    case CbteTipo.NOTA_DEBITO_A:
      return { nombre: "Nota de Débito", letra: "A" };
    case CbteTipo.NOTA_CREDITO_A:
      return { nombre: "Nota de Crédito", letra: "A" };
    case CbteTipo.RECIBO_A:
      return { nombre: "Recibo", letra: "A" };
    case CbteTipo.FACTURA_B:
      return { nombre: "Factura", letra: "B" };
    case CbteTipo.NOTA_DEBITO_B:
      return { nombre: "Nota de Débito", letra: "B" };
    case CbteTipo.NOTA_CREDITO_B:
      return { nombre: "Nota de Crédito", letra: "B" };
    case CbteTipo.RECIBO_B:
      return { nombre: "Recibo", letra: "B" };
    case CbteTipo.FACTURA_C:
      return { nombre: "Factura", letra: "C" };
    case CbteTipo.NOTA_DEBITO_C:
      return { nombre: "Nota de Débito", letra: "C" };
    case CbteTipo.NOTA_CREDITO_C:
      return { nombre: "Nota de Crédito", letra: "C" };
    case CbteTipo.RECIBO_C:
      return { nombre: "Recibo", letra: "C" };
    case CbteTipo.FACTURA_M:
      return { nombre: "Factura", letra: "M" };
    case CbteTipo.NOTA_DEBITO_M:
      return { nombre: "Nota de Débito", letra: "M" };
    case CbteTipo.NOTA_CREDITO_M:
      return { nombre: "Nota de Crédito", letra: "M" };
    case CbteTipo.FCE_A:
      return { nombre: "Factura de Crédito MiPyMEs", letra: "A" };
    case CbteTipo.FCE_B:
      return { nombre: "Factura de Crédito MiPyMEs", letra: "B" };
    case CbteTipo.FCE_C:
      return { nombre: "Factura de Crédito MiPyMEs", letra: "C" };
    default:
      return { nombre: "Comprobante", letra: "B" };
  }
}

export class ArcaBillingService {
  /** Cliente de ARCA de la empresa del contexto (o la del .env). */
  private static getClient() {
    return ArcaClientFactory.obtener();
  }

  /**
   * Chequea la disponibilidad de los servidores de ARCA (AppServer, DbServer, AuthServer).
   */
  public static async verificarEstadoServidores() {
    const { arca } = await this.getClient();
    try {
      const result = await arca.electronicBillingService.getServerStatus();
      await AuditStorage.save({
        event_type: "getServerStatus",
        response_json: JSON.stringify(result),
        status: "SUCCESS"
      });
      return result;
    } catch (error: any) {
      await AuditStorage.save({
        event_type: "getServerStatus",
        response_json: JSON.stringify({ error: error.message }),
        status: "ERROR"
      });
      throw parseArcaError(error);
    }
  }

  /**
   * Consulta el estado del ticket de acceso WSAA almacenado en base de datos.
   */
  public static async consultarEstadoTicket() {
    const { ticketStorage } = await this.getClient();
    return await ticketStorage.getTicketInfo("wsfe");
  }

  /**
   * Trae en tiempo real las tablas maestras de ARCA.
   */
  public static async obtenerTablasReferencia() {
    const { arca } = await this.getClient();
    const [
      puntosVenta,
      tiposComprobante,
      tiposDocumento,
      alicuotasIva,
      condicionesIva,
      monedas,
    ] = await Promise.all([
      arca.electronicBillingService.getSalesPoints(),
      arca.electronicBillingService.getVoucherTypes(),
      arca.electronicBillingService.getDocumentTypes(),
      arca.electronicBillingService.getAliquotTypes(),
      arca.electronicBillingService.getIvaReceptorTypes(),
      arca.electronicBillingService.getCurrencyTypes(),
    ]);

    return {
      puntosVenta,
      tiposComprobante,
      tiposDocumento,
      alicuotasIva,
      condicionesIva,
      monedas,
    };
  }

  /**
   * Consulta el último número autorizado para un punto de venta y tipo de comprobante.
   */
  public static async obtenerUltimoComprobante(
    puntoVenta?: number,
    tipoComprobante: TipoComprobante = CbteTipo.FACTURA_B
  ) {
    const { arca, config } = await this.getClient();
    const ptoVta = puntoVenta ?? config.ptoVta;
    const result = await arca.electronicBillingService.getLastVoucher(
      ptoVta,
      tipoComprobante
    );
    return {
      puntoVenta: ptoVta,
      tipoComprobante,
      ultimoNumero: result.cbteNro ?? 0,
    };
  }

  /**
   * Consulta los datos y CAE de un comprobante emitido previamente a ARCA.
   */
  public static async consultarComprobante(
    numeroComprobante: number,
    puntoVenta?: number,
    tipoComprobante: TipoComprobante = CbteTipo.FACTURA_B
  ) {
    const { arca, config } = await this.getClient();
    const ptoVta = puntoVenta ?? config.ptoVta;
    return await arca.electronicBillingService.getVoucherInfo(
      numeroComprobante,
      ptoVta,
      tipoComprobante
    );
  }

  /**
   * Lista todas las facturas emitidas históricamente guardadas en el historial local.
   */
  public static async listarFacturas(filtros?: {
    tipoComprobante?: number;
    puntoVenta?: number;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    return await InvoiceHistoryStorage.getAll(filtros);
  }

  /**
   * Obtiene el detalle de una factura específica por su ID ("1-6-15") o número.
   */
  public static async obtenerFacturaPorId(idOrNumber: string | number) {
    return await InvoiceHistoryStorage.getById(idOrNumber);
  }

  /**
   * Método general de emisión de comprobantes electrónicos con validación previa,
   * cálculo de QR reglamentario, guardado en historial y generación opcional de PDF oficial.
   */
  public static async emitirComprobante(
    input: EmitirComprobanteInput
  ): Promise<ComprobanteEmitidoResultado & { registroId?: string }> {
    const { arca, config } = await this.getClient();
    const empresa = empresaActual();
    const ptoVta = input.puntoVenta ?? config.ptoVta;
    const fecha = input.fechaComprobante ?? getFormattedDate();
    const emisorRazonSocial = empresa?.razonSocial ?? input.emisorRazonSocial ?? `Empresa CUIT ${config.cuit}`;

    // Validaciones de importes
    const impNeto = Number(input.importeNeto.toFixed(2));
    const impIVA = Number((input.importeIva ?? 0).toFixed(2));
    const impTotal = Number(input.importeTotal.toFixed(2));
    const impTotConc = Number((input.importeNoGravado ?? 0).toFixed(2));
    const impOpEx = Number((input.importeExento ?? 0).toFixed(2));
    const impTrib = Number((input.importeTributos ?? 0).toFixed(2));

    const sumaCalculada = Number(
      (impNeto + impIVA + impTotConc + impOpEx + impTrib).toFixed(2)
    );
    if (!validarEcuacionFiscal(impNeto, impIVA, impTrib, impOpEx, impTotConc, impTotal)) {
      throw new ArcaValidationError(
        `Inconsistencia en importes: ImpTotal (${impTotal}) no coincide con la suma de componentes (${sumaCalculada})`
      );
    }

    if (input.tipoDocumento === DocTipo.CUIT && input.numeroDocumento) {
      if (!validarCuit(input.numeroDocumento)) {
        throw new ArcaValidationError(`El CUIT del receptor (${input.numeroDocumento}) no es válido.`);
      }
    }

    if (
      input.concepto === Concepto.SERVICIOS ||
      input.concepto === Concepto.PRODUCTOS_Y_SERVICIOS
    ) {
      if (!validarCoherenciaFechas(input.fechaServicioDesde, input.fechaServicioHasta)) {
        throw new ArcaValidationError("La fecha de servicio 'desde' no puede ser mayor a la 'hasta'.");
      }
    }

    const payload: any = {
      CantReg: 1,
      PtoVta: ptoVta,
      CbteTipo: input.tipoComprobante,
      Concepto: input.concepto ?? Concepto.PRODUCTOS,
      DocTipo: input.tipoDocumento,
      DocNro: Number(String(input.numeroDocumento).replace(/[^0-9]/g, "")),
      CbteFch: fecha,
      ImpTotal: impTotal,
      ImpTotConc: impTotConc,
      ImpNeto: impNeto,
      ImpOpEx: impOpEx,
      ImpIVA: impIVA,
      ImpTrib: impTrib,
      MonId: input.monedaId ?? "PES",
      MonCotiz: input.monedaCotizacion ?? 1,
      CondicionIVAReceptorId: input.condicionIvaReceptor,
    };

    // Fechas de servicio si concepto es Servicios o Productos y Servicios
    if (
      input.concepto === Concepto.SERVICIOS ||
      input.concepto === Concepto.PRODUCTOS_Y_SERVICIOS
    ) {
      payload.FchServDesde = input.fechaServicioDesde ?? fecha;
      payload.FchServHasta = input.fechaServicioHasta ?? fecha;
      payload.FchVtoPago = input.fechaVencimientoPago ?? fecha;
    }

    // Desglose de IVA
    if (input.alicuotasIva && input.alicuotasIva.length > 0) {
      payload.Iva = input.alicuotasIva.map((item) => ({
        Id: item.id,
        BaseImp: Number(item.baseImponible.toFixed(2)),
        Importe: Number(item.importe.toFixed(2)),
      }));
    }

    // Tributos / Percepciones
    if (input.tributos && input.tributos.length > 0) {
      payload.Tributos = input.tributos.map((t) => ({
        Id: t.id,
        Desc: t.desc ?? "Tributo",
        BaseImp: Number(t.baseImp.toFixed(2)),
        Alic: Number(t.alic.toFixed(2)),
        Importe: Number(t.importe.toFixed(2)),
      }));
    }

    // Comprobantes Asociados (para Notas de Crédito / Débito)
    if (input.comprobantesAsociados && input.comprobantesAsociados.length > 0) {
      payload.CbtesAsoc = input.comprobantesAsociados.map((c) => ({
        Tipo: c.tipo,
        PtoVta: c.puntoVenta,
        Nro: c.numero,
        Cuit: c.cuitEmisor ? String(c.cuitEmisor) : String(config.cuit),
      }));
    }

    // Opcionales (CBU para FCE, etc.)
    if (input.opcionales && input.opcionales.length > 0) {
      payload.Opcionales = input.opcionales.map((o) => ({
        Id: o.id,
        Valor: o.valor,
      }));
    }

    // Llamada al SDK para crear el comprobante
    let invoiceResponse;
    try {
      // createNextVoucher consulta FECompUltimoAutorizado y suma +1: se serializa por
      // Punto de Venta para que dos emisiones simultáneas no pidan el mismo número.
      invoiceResponse = await emissionMutex.run(`${config.cuit}:ptoVta:${ptoVta}`, () =>
        arca.electronicBillingService.createNextVoucher(payload)
      );
      await AuditStorage.save({
        event_type: "createNextVoucher",
        emisor_cuit: config.cuit,
        payload_json: JSON.stringify(payload),
        response_json: JSON.stringify(invoiceResponse),
        status: invoiceResponse.cae ? "SUCCESS" : "ERROR"
      });
    } catch (error: any) {
      await AuditStorage.save({
        event_type: "createNextVoucher",
        emisor_cuit: config.cuit,
        payload_json: JSON.stringify(payload),
        response_json: JSON.stringify({ error: error.message }),
        status: "ERROR"
      });
      throw parseArcaError(error);
    }

    const arcaResultado = invoiceResponse.response?.FeCabResp?.Resultado;
    const detResp = invoiceResponse.response?.FeDetResp?.FECAEDetResponse;
    const primerDetalle = Array.isArray(detResp) ? detResp[0] : detResp;
    const arcaObservaciones = primerDetalle?.Observaciones?.Obs?.map((o: any) => ({
      code: o.Code,
      msg: o.Msg,
    }));

    if (arcaResultado === 'R') {
      throw new ArcaBusinessError(`El comprobante fue rechazado por ARCA.`, arcaObservaciones);
    }

    const cae = invoiceResponse.cae;
    const caeVencimiento = invoiceResponse.caeFchVto ?? "";
    const numeroComprobante = primerDetalle?.CbteDesde ?? 0;

    let qrData;
    let pdfInfo;
    let registroGuardado: FacturaRegistro | undefined;

    if (cae) {
      qrData = ArcaQrService.generateQrData({
        cuitEmisor: config.cuit,
        puntoVenta: ptoVta,
        tipoComprobante: input.tipoComprobante,
        numeroComprobante,
        fechaComprobante: fecha,
        importeTotal: impTotal,
        moneda: input.monedaId ?? "PES",
        cotizacion: input.monedaCotizacion ?? 1,
        tipoDocReceptor: input.tipoDocumento,
        nroDocReceptor: input.numeroDocumento,
        cae,
      });

      const { nombre, letra } = getNombreTipoComprobante(input.tipoComprobante);
      const ptoVtaFormatted = String(ptoVta).padStart(5, "0");
      const nroFormatted = String(numeroComprobante).padStart(8, "0");
      const numeroFormateado = `${ptoVtaFormatted}-${nroFormatted}`;
      const fechaEmisionFormateada = `${fecha.slice(6, 8)}/${fecha.slice(4, 6)}/${fecha.slice(0, 4)}`;

      // Generación automática del PDF oficial
      if (input.generarPdf !== false) {
        const pdfData: DatosFacturaPdf = {
          emisorRazonSocial,
          emisorCuit: config.cuit,
          emisorDomicilio: empresa?.domicilioComercial ?? input.emisorDomicilio,
          emisorNombreFantasia: empresa?.nombreFantasia,
          emisorCondicionIva: empresa ? NOMBRE_CONDICION_EMISOR[empresa.condicionIva] : undefined,
          emisorIngresosBrutos: empresa?.ingresosBrutos,
          emisorInicioActividades: empresa?.inicioActividades,
          emisorLogoPath: empresa?.logoPath,
          receptorCondicionIva: NOMBRE_CONDICION_IVA[input.condicionIvaReceptor] ?? undefined,
          tipoComprobanteLetra: letra,
          tipoComprobanteNombre: nombre,
          tipoComprobanteCodigo: input.tipoComprobante,
          puntoVenta: ptoVta,
          numeroComprobante,
          fechaEmision: fecha,
          receptorRazonSocial: input.receptorRazonSocial,
          receptorDocTipo: input.tipoDocumento === DocTipo.CUIT ? "CUIT" : (input.tipoDocumento === DocTipo.DNI ? "DNI" : "Doc"),
          receptorDocNro: input.numeroDocumento,
          receptorDomicilio: input.receptorDomicilio,
          items: input.items,
          importeNeto: impNeto,
          importeIva: impIVA,
          importeTributos: impTrib,
          importeTotal: impTotal,
          cae,
          caeVencimiento,
          qrUrl: qrData.url,
        };

        // Ya hay CAE: si el PDF falla, la factura igual existe y no hay que perder el resultado.
        try {
          const pdfPath = await ArcaPdfService.guardarPdfEnDisco(pdfData);
          pdfInfo = { filePath: pdfPath, fileName: path.basename(pdfPath) };
        } catch (err: any) {
          console.error(`[Emisión] CAE ${cae} obtenido pero falló el PDF:`, err);
        }
      }

      // Guardar en Historial Persistente
      try {
      registroGuardado = await InvoiceHistoryStorage.save({
        puntoVenta: ptoVta,
        tipoComprobante: input.tipoComprobante,
        tipoComprobanteNombre: `${nombre} ${letra}`,
        tipoComprobanteLetra: letra,
        numeroComprobante,
        numeroFormateado,
        fechaEmision: fecha,
        fechaEmisionFormateada,
        receptorRazonSocial: input.receptorRazonSocial ?? "Consumidor Final",
        receptorDocTipo: input.tipoDocumento === DocTipo.CUIT ? "CUIT" : (input.tipoDocumento === DocTipo.DNI ? "DNI" : "Consumidor Final"),
        receptorDocNro: input.numeroDocumento,
        receptorCondicionIva: String(input.condicionIvaReceptor),
        receptorDomicilio: input.receptorDomicilio,
        importeNeto: impNeto,
        importeIva: impIVA,
        importeTributos: impTrib,
        importeTotal: impTotal,
        items: input.items,
        cae,
        caeVencimiento,
        qrUrl: qrData.url,
        pdfPath: pdfInfo?.filePath,
        pdfFileName: pdfInfo?.fileName,
        concepto: input.concepto,
        fechaServicioDesde: input.fechaServicioDesde,
        fechaServicioHasta: input.fechaServicioHasta,
        fechaVencimientoPago: input.fechaVencimientoPago,
        monedaId: input.monedaId,
        monedaCotizacion: input.monedaCotizacion,
        alicuotasIva: input.alicuotasIva,
        tributos: input.tributos,
        comprobantesAsociados: input.comprobantesAsociados,
        opcionales: input.opcionales,
        arcaResultado,
        arcaObservaciones,
        emisorCuit: config.cuit,
        emisorRazonSocial,
        empresaId: empresa?.id,
      });
      } catch (err: any) {
        // El comprobante está autorizado en ARCA aunque no se haya podido guardar localmente.
        console.error(`[Emisión] CAE ${cae} obtenido pero no se pudo guardar en el historial:`, err);
        await AuditStorage.save({
          event_type: "historialNoGuardado",
          emisor_cuit: config.cuit,
          payload_json: JSON.stringify({ ptoVta, tipo: input.tipoComprobante, numeroComprobante, cae }),
          status: "ERROR",
        });
      }

      // Guardar/Actualizar Cliente (cache para el próximo comprobante)
      if (input.receptorRazonSocial && input.numeroDocumento && input.numeroDocumento !== 0) {
        await execute(
          `INSERT INTO clientes (id, doc_tipo, doc_nro, razon_social, condicion_iva, domicilio, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE razon_social = VALUES(razon_social), condicion_iva = VALUES(condicion_iva),
             domicilio = VALUES(domicilio), updated_at = VALUES(updated_at)`,
          [
            `${input.tipoDocumento}-${input.numeroDocumento}`,
            String(input.tipoDocumento),
            String(input.numeroDocumento),
            input.receptorRazonSocial,
            String(input.condicionIvaReceptor),
            input.receptorDomicilio ?? null,
            new Date().toISOString(),
          ]
        ).catch((err) => console.warn("[Clientes] No se pudo guardar el cliente:", err?.message ?? err));
      }
    }

    return {
      exito: Boolean(cae),
      registroId: registroGuardado?.id,
      cae: cae ?? "",
      caeVencimiento,
      numeroComprobante,
      puntoVenta: ptoVta,
      tipoComprobante: input.tipoComprobante,
      fechaEmision: fecha,
      importeTotal: impTotal,
      resultadoCabecera: arcaResultado,
      observaciones: arcaObservaciones,
      qrData,
      pdf: pdfInfo,
      rawResponse: invoiceResponse,
    };
  }

  /**
   * Helper para emitir Factura B (Consumidor Final, DNI, Monotributista o Exento receptor).
   */
  public static async emitirFacturaB(input: EmitirFacturaBInput) {
    const alicuota = input.alicuotaIva ?? IvaAlicuota.IVA_21;
    let porcentaje = 0.21;
    if (alicuota === IvaAlicuota.IVA_10_5) porcentaje = 0.105;
    if (alicuota === IvaAlicuota.IVA_27) porcentaje = 0.27;
    if (alicuota === IvaAlicuota.IVA_0) porcentaje = 0;

    const neto = input.importeNeto;
    const iva = Number((neto * porcentaje).toFixed(2));
    const total = Number((neto + iva).toFixed(2));

    const docNro = input.dniOCuit ? Number(input.dniOCuit) : 0;
    const docTipo = docNro === 0 ? DocTipo.CONSUMIDOR_FINAL : DocTipo.DNI;

    return await this.emitirComprobante({
      puntoVenta: input.puntoVenta,
      tipoComprobante: CbteTipo.FACTURA_B,
      concepto: input.concepto ?? Concepto.PRODUCTOS,
      tipoDocumento: docTipo,
      numeroDocumento: docNro,
      condicionIvaReceptor:
        input.condicionIva ?? CondicionIVAReceptor.CONSUMIDOR_FINAL,
      receptorRazonSocial: input.receptorRazonSocial ?? (docNro === 0 ? "Consumidor Final" : `Cliente DNI ${docNro}`),
      receptorDomicilio: input.receptorDomicilio,
      fechaComprobante: input.fechaComprobante,
      fechaServicioDesde: input.fechaServicioDesde,
      fechaServicioHasta: input.fechaServicioHasta,
      fechaVencimientoPago: input.fechaVencimientoPago,
      items: input.items,
      generarPdf: input.generarPdf,
      importeNeto: neto,
      importeIva: iva,
      importeTotal: total,
      alicuotasIva:
        alicuota !== IvaAlicuota.IVA_0
          ? [{ id: alicuota, baseImponible: neto, importe: iva }]
          : [],
    });
  }

  /**
   * Helper para emitir Factura A (Responsable Inscripto).
   */
  public static async emitirFacturaA(input: EmitirFacturaAInput) {
    const totalIva = input.alicuotasIva.reduce(
      (sum, item) => sum + item.importe,
      0
    );
    const totalTributos = (input.tributos ?? []).reduce(
      (sum, item) => sum + item.importe,
      0
    );
    const total = Number(
      (input.importeNeto + totalIva + totalTributos).toFixed(2)
    );

    return await this.emitirComprobante({
      puntoVenta: input.puntoVenta,
      tipoComprobante: CbteTipo.FACTURA_A,
      concepto: input.concepto ?? Concepto.PRODUCTOS,
      tipoDocumento: DocTipo.CUIT,
      numeroDocumento: input.cuitReceptor,
      receptorRazonSocial: input.receptorRazonSocial ?? `Empresa CUIT ${input.cuitReceptor}`,
      receptorDomicilio: input.receptorDomicilio,
      condicionIvaReceptor: CondicionIVAReceptor.RESPONSABLE_INSCRIPTO,
      fechaComprobante: input.fechaComprobante,
      fechaServicioDesde: input.fechaServicioDesde,
      fechaServicioHasta: input.fechaServicioHasta,
      fechaVencimientoPago: input.fechaVencimientoPago,
      items: input.items,
      generarPdf: input.generarPdf,
      importeNeto: input.importeNeto,
      importeIva: totalIva,
      importeTributos: totalTributos,
      importeTotal: total,
      alicuotasIva: input.alicuotasIva,
      tributos: input.tributos,
    });
  }

  /**
   * Helper para emitir Factura C (Monotributo / Exento: NO discrimina IVA, ImpNeto = ImpTotal).
   */
  public static async emitirFacturaC(input: EmitirFacturaCInput) {
    const totalTributos = (input.tributos ?? []).reduce(
      (sum, item) => sum + item.importe,
      0
    );
    const total = Number(input.importeTotal.toFixed(2));
    const neto = Number((total - totalTributos).toFixed(2));

    const docTipo = input.docTipo ?? (input.docNro ? DocTipo.DNI : DocTipo.CONSUMIDOR_FINAL);
    const docNro = input.docNro ?? 0;

    return await this.emitirComprobante({
      puntoVenta: input.puntoVenta,
      tipoComprobante: CbteTipo.FACTURA_C,
      concepto: input.concepto ?? Concepto.PRODUCTOS,
      tipoDocumento: docTipo,
      numeroDocumento: docNro,
      condicionIvaReceptor: input.condicionIvaReceptor ?? CondicionIVAReceptor.CONSUMIDOR_FINAL,
      receptorRazonSocial: input.receptorRazonSocial ?? "Consumidor Final",
      receptorDomicilio: input.receptorDomicilio,
      fechaComprobante: input.fechaComprobante,
      fechaServicioDesde: input.fechaServicioDesde,
      fechaServicioHasta: input.fechaServicioHasta,
      fechaVencimientoPago: input.fechaVencimientoPago,
      items: input.items,
      generarPdf: input.generarPdf,
      importeNeto: neto,
      importeIva: 0,
      importeTributos: totalTributos,
      importeTotal: total,
      alicuotasIva: [],
      tributos: input.tributos,
    });
  }

  /**
   * Helper para emitir Factura M (Responsable Inscripto con régimen especial de retención).
   */
  public static async emitirFacturaM(input: EmitirFacturaMInput) {
    const totalIva = input.alicuotasIva.reduce(
      (sum, item) => sum + item.importe,
      0
    );
    const totalTributos = (input.tributos ?? []).reduce(
      (sum, item) => sum + item.importe,
      0
    );
    const total = Number((input.importeNeto + totalIva + totalTributos).toFixed(2));

    return await this.emitirComprobante({
      puntoVenta: input.puntoVenta,
      tipoComprobante: CbteTipo.FACTURA_M,
      concepto: input.concepto ?? Concepto.PRODUCTOS,
      tipoDocumento: DocTipo.CUIT,
      numeroDocumento: input.cuitReceptor,
      receptorRazonSocial: input.receptorRazonSocial ?? `Empresa CUIT ${input.cuitReceptor}`,
      receptorDomicilio: input.receptorDomicilio,
      condicionIvaReceptor: CondicionIVAReceptor.RESPONSABLE_INSCRIPTO,
      fechaComprobante: input.fechaComprobante,
      items: input.items,
      generarPdf: input.generarPdf,
      importeNeto: input.importeNeto,
      importeIva: totalIva,
      importeTributos: totalTributos,
      importeTotal: total,
      alicuotasIva: input.alicuotasIva,
      tributos: input.tributos,
    });
  }

  /**
   * Helper para emitir Nota de Débito (A, B o C) vinculada a factura.
   */
  public static async emitirNotaDebito(input: EmitirNotaDebitoInput) {
    const totalIva = (input.alicuotasIva ?? []).reduce(
      (sum, item) => sum + item.importe,
      0
    );
    const total = Number((input.importeNeto + totalIva).toFixed(2));

    return await this.emitirComprobante({
      puntoVenta: input.puntoVenta,
      tipoComprobante: input.tipoNotaDebito,
      concepto: input.concepto ?? Concepto.PRODUCTOS,
      tipoDocumento: input.tipoDocumento,
      numeroDocumento: input.numeroDocumento,
      receptorRazonSocial: input.receptorRazonSocial,
      condicionIvaReceptor: input.condicionIvaReceptor,
      fechaComprobante: input.fechaComprobante,
      items: input.items,
      generarPdf: input.generarPdf,
      importeNeto: input.importeNeto,
      importeIva: totalIva,
      importeTotal: total,
      alicuotasIva: input.alicuotasIva,
      comprobantesAsociados: [input.comprobanteAsociado],
    });
  }

  /**
   * Helper para emitir Nota de Crédito (A, B o C) vinculada a factura.
   */
  public static async emitirNotaCredito(input: EmitirNotaCreditoInput) {
    const totalIva = (input.alicuotasIva ?? []).reduce(
      (sum, item) => sum + item.importe,
      0
    );
    const total = Number((input.importeNeto + totalIva).toFixed(2));

    return await this.emitirComprobante({
      puntoVenta: input.puntoVenta,
      tipoComprobante: input.tipoNotaCredito,
      concepto: input.concepto ?? Concepto.PRODUCTOS,
      tipoDocumento: input.tipoDocumento,
      numeroDocumento: input.numeroDocumento,
      receptorRazonSocial: input.receptorRazonSocial,
      condicionIvaReceptor: input.condicionIvaReceptor,
      fechaComprobante: input.fechaComprobante,
      items: input.items,
      generarPdf: input.generarPdf,
      importeNeto: input.importeNeto,
      importeIva: totalIva,
      importeTotal: total,
      alicuotasIva: input.alicuotasIva,
      comprobantesAsociados: [input.comprobanteAsociado],
    });
  }

  /**
   * Helper para emitir Recibos oficiales (A, B o C).
   */
  public static async emitirRecibo(input: EmitirReciboInput) {
    const totalIva = (input.alicuotasIva ?? []).reduce(
      (sum, item) => sum + item.importe,
      0
    );
    const neto = input.importeNeto ?? Number((input.importeTotal - totalIva).toFixed(2));

    return await this.emitirComprobante({
      puntoVenta: input.puntoVenta,
      tipoComprobante: input.tipoRecibo,
      concepto: Concepto.PRODUCTOS,
      tipoDocumento: input.tipoDocumento,
      numeroDocumento: input.numeroDocumento,
      receptorRazonSocial: input.receptorRazonSocial,
      condicionIvaReceptor: input.condicionIvaReceptor,
      fechaComprobante: input.fechaComprobante,
      items: input.items,
      generarPdf: input.generarPdf,
      importeNeto: neto,
      importeIva: totalIva,
      importeTotal: input.importeTotal,
      alicuotasIva: input.alicuotasIva,
    });
  }

  /**
   * Helper para emitir Factura de Crédito Electrónica MiPyMEs (FCE A, B o C con CBU).
   */
  public static async emitirFce(input: EmitirFceInput) {
    const totalIva = (input.alicuotasIva ?? []).reduce(
      (sum, item) => sum + item.importe,
      0
    );
    const total = Number((input.importeNeto + totalIva).toFixed(2));
    const fecha = input.fechaComprobante ?? getFormattedDate();

    if (input.cbuEmisor && !validarCbu(String(input.cbuEmisor))) {
      throw new ArcaValidationError(`El CBU del emisor (${input.cbuEmisor}) no es válido.`);
    }

    // Código Opcional 2101 = CBU del emisor
    const opcionales = [
      { id: 2101, valor: input.cbuEmisor },
    ];
    if (input.cbuAlias) {
      opcionales.push({ id: 2102, valor: input.cbuAlias });
    }

    return await this.emitirComprobante({
      puntoVenta: input.puntoVenta,
      tipoComprobante: input.tipoFce,
      concepto: Concepto.SERVICIOS,
      tipoDocumento: DocTipo.CUIT,
      numeroDocumento: input.cuitReceptor,
      receptorRazonSocial: input.receptorRazonSocial ?? `Empresa MiPyME CUIT ${input.cuitReceptor}`,
      condicionIvaReceptor: CondicionIVAReceptor.RESPONSABLE_INSCRIPTO,
      fechaComprobante: fecha,
      fechaServicioDesde: fecha,
      fechaServicioHasta: fecha,
      fechaVencimientoPago: input.fechaVencimientoPago,
      items: input.items,
      generarPdf: input.generarPdf,
      importeNeto: input.importeNeto,
      importeIva: totalIva,
      importeTotal: total,
      alicuotasIva: input.alicuotasIva,
      opcionales,
    });
  }
}

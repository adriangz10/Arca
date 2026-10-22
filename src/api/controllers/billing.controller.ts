import type { Request, Response, NextFunction } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { ArcaBillingService } from "../../services/arca-billing.service.js";
import { ArcaPdfService, type DatosFacturaPdf } from "../../services/pdf.service.js";
import { ArcaQrService } from "../../services/qr.service.js";
import { loadArcaConfig } from "../../config/arca.config.js";
import { empresaActual } from "../../empresas/empresa.context.js";
import { NOMBRE_CONDICION_EMISOR } from "../../empresas/empresa.types.js";
import { NOMBRE_CONDICION_IVA } from "../../constants/condicion-iva.js";

/** Datos del emisor para el PDF: los de la empresa del pedido (o el CUIT del .env). */
function datosEmisorPdf() {
  const e = empresaActual();
  const cuit = e?.cuit ?? loadArcaConfig().cuit;
  return {
    cuit,
    datos: {
      emisorRazonSocial: e?.razonSocial ?? `Empresa CUIT ${cuit}`,
      emisorCuit: cuit,
      emisorDomicilio: e?.domicilioComercial,
      emisorNombreFantasia: e?.nombreFantasia,
      emisorCondicionIva: e ? NOMBRE_CONDICION_EMISOR[e.condicionIva] : undefined,
      emisorIngresosBrutos: e?.ingresosBrutos,
      emisorInicioActividades: e?.inicioActividades,
      emisorLogoPath: e?.logoPath,
    },
  };
}
import { CbteTipo, DocTipo, CondicionIVAReceptor, IvaAlicuota } from "../../constants/arca.constants.js";
import type {
  EmitirFacturaBInput,
  EmitirFacturaAInput,
  EmitirFacturaCInput,
  EmitirFacturaMInput,
  EmitirNotaCreditoInput,
  EmitirNotaDebitoInput,
  EmitirReciboInput,
  EmitirFceInput,
  EmitirComprobanteInput,
} from "../../types/billing.types.js";

export class BillingController {
  /**
   * GET /api/status
   */
  public static async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const [serverStatus, ticketStatus] = await Promise.all([
        ArcaBillingService.verificarEstadoServidores(),
        ArcaBillingService.consultarEstadoTicket(),
      ]);

      res.json({
        success: true,
        data: {
          arcaServers: serverStatus,
          ticketAccessWsaa: ticketStatus,
        },
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * GET /api/tables
   */
  public static async getTables(req: Request, res: Response, next: NextFunction) {
    try {
      const tables = await ArcaBillingService.obtenerTablasReferencia();
      res.json({
        success: true,
        data: tables,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * GET /api/vouchers
   */
  public static async listVouchers(req: Request, res: Response, next: NextFunction) {
    try {
      const search = req.query.search as string | undefined;
      const tipoComprobante = req.query.tipoComprobante ? Number(req.query.tipoComprobante) : undefined;
      const puntoVenta = req.query.puntoVenta ? Number(req.query.puntoVenta) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      const result = await ArcaBillingService.listarFacturas({
        search,
        tipoComprobante,
        puntoVenta,
        limit,
        offset,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * GET /api/vouchers/last
   */
  public static async getLastVoucher(req: Request, res: Response, next: NextFunction) {
    try {
      const ptoVta = req.query.ptoVta ? Number(req.query.ptoVta) : undefined;
      const tipo = req.query.tipo ? Number(req.query.tipo) : CbteTipo.FACTURA_B;

      const result = await ArcaBillingService.obtenerUltimoComprobante(ptoVta, tipo as any);
      res.json({
        success: true,
        data: {
          ...result,
          proximoNumero: result.ultimoNumero + 1,
        },
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * GET /api/vouchers/:id
   */
  public static async getVoucherById(req: Request, res: Response, next: NextFunction) {
    try {
      const idOrNumber = String(req.params.id);

      const facturaLocal = await ArcaBillingService.obtenerFacturaPorId(idOrNumber);
      if (facturaLocal) {
        return res.json({
          success: true,
          data: facturaLocal,
        });
      }

      if (!isNaN(Number(idOrNumber))) {
        const numero = Number(idOrNumber);
        const ptoVta = req.query.ptoVta ? Number(req.query.ptoVta) : undefined;
        const tipo = req.query.tipo ? Number(req.query.tipo) : CbteTipo.FACTURA_B;

        const voucher = await ArcaBillingService.consultarComprobante(numero, ptoVta, tipo as any);
        if (voucher) {
          return res.json({
            success: true,
            data: voucher,
          });
        }
      }

      return res.status(404).json({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: `La factura con identificador '${idOrNumber}' no fue encontrada.`,
        },
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * GET /api/vouchers/:id/pdf
   */
  public static async getVoucherPdf(req: Request, res: Response, next: NextFunction) {
    try {
      const idOrNumber = String(req.params.id);

      const facturaLocal = await ArcaBillingService.obtenerFacturaPorId(idOrNumber);
      if (facturaLocal && facturaLocal.pdfPath) {
        try {
          const pdfBuffer = await fs.readFile(facturaLocal.pdfPath);
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader(
            "Content-Disposition",
            `inline; filename=${facturaLocal.pdfFileName ?? "Factura.pdf"}`
          );
          return res.send(pdfBuffer);
        } catch {}
      }

      if (facturaLocal) {
        const emisor = datosEmisorPdf();
        const pdfData: DatosFacturaPdf = {
          ...emisor.datos,
          receptorCondicionIva: NOMBRE_CONDICION_IVA[Number(facturaLocal.receptorCondicionIva)],
          tipoComprobanteLetra: facturaLocal.tipoComprobanteLetra,
          tipoComprobanteNombre: facturaLocal.tipoComprobanteNombre.split(" ")[0] ?? "Factura",
          tipoComprobanteCodigo: facturaLocal.tipoComprobante,
          puntoVenta: facturaLocal.puntoVenta,
          numeroComprobante: facturaLocal.numeroComprobante,
          fechaEmision: facturaLocal.fechaEmision,
          receptorDocTipo: facturaLocal.receptorDocTipo,
          receptorDocNro: facturaLocal.receptorDocNro,
          receptorRazonSocial: facturaLocal.receptorRazonSocial,
          receptorDomicilio: facturaLocal.receptorDomicilio,
          items: facturaLocal.items,
          importeNeto: facturaLocal.importeNeto,
          importeIva: facturaLocal.importeIva,
          importeTributos: facturaLocal.importeTributos,
          importeTotal: facturaLocal.importeTotal,
          cae: facturaLocal.cae,
          caeVencimiento: facturaLocal.caeVencimiento,
          qrUrl: facturaLocal.qrUrl,
        };

        const pdfBuffer = await ArcaPdfService.generarPdfBuffer(pdfData);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `inline; filename=${facturaLocal.pdfFileName ?? "Factura.pdf"}`
        );
        return res.send(pdfBuffer);
      }

      if (!isNaN(Number(idOrNumber))) {
        const numero = Number(idOrNumber);
        const ptoVta = req.query.ptoVta ? Number(req.query.ptoVta) : 1;
        const tipo = req.query.tipo ? Number(req.query.tipo) : CbteTipo.FACTURA_B;

        const voucher = await ArcaBillingService.consultarComprobante(numero, ptoVta, tipo as any);
        if (voucher) {
          const emisor = datosEmisorPdf();
          const qrData = ArcaQrService.generateQrData({
            cuitEmisor: emisor.cuit,
            puntoVenta: ptoVta,
            tipoComprobante: tipo,
            numeroComprobante: numero,
            fechaComprobante: voucher.cbteFch ?? "",
            importeTotal: voucher.impTotal ?? 0,
            tipoDocReceptor: voucher.docTipo,
            nroDocReceptor: voucher.docNro,
            cae: voucher.codAutorizacion ?? "",
          });

          const letra: "A" | "B" | "C" | "M" =
            tipo === CbteTipo.FACTURA_A ? "A" : (tipo === CbteTipo.FACTURA_C ? "C" : "B");

          const pdfData: DatosFacturaPdf = {
            ...emisor.datos,
            tipoComprobanteLetra: letra,
            tipoComprobanteNombre: "FACTURA",
            tipoComprobanteCodigo: tipo,
            puntoVenta: ptoVta,
            numeroComprobante: numero,
            fechaEmision: voucher.cbteFch ?? "",
            receptorDocTipo: voucher.docTipo === DocTipo.CUIT ? "CUIT" : "DNI",
            receptorDocNro: voucher.docNro,
            receptorRazonSocial: (req.query.receptorRazonSocial as string) ?? "Cliente",
            importeNeto: voucher.impNeto ?? voucher.impTotal ?? 0,
            importeIva: voucher.impIVA ?? 0,
            importeTributos: voucher.impTrib ?? 0,
            importeTotal: voucher.impTotal ?? 0,
            cae: voucher.codAutorizacion ?? "",
            caeVencimiento: voucher.fchVto ?? "",
            qrUrl: qrData.url,
          };

          const pdfBuffer = await ArcaPdfService.generarPdfBuffer(pdfData);
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader(
            "Content-Disposition",
            `inline; filename=Factura_${String(ptoVta).padStart(5, "0")}-${String(numero).padStart(8, "0")}.pdf`
          );
          return res.send(pdfBuffer);
        }
      }

      return res.status(404).json({
        success: false,
        error: {
          code: "NOT_FOUND",
          message: `No se pudo generar el PDF para el identificador '${idOrNumber}'.`,
        },
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * POST /api/vouchers/factura-b
   */
  public static async createFacturaB(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        importeNeto,
        alicuotaIva,
        dniOCuit,
        condicionIva,
        puntoVenta,
        concepto,
        fechaComprobante,
        fechaServicioDesde,
        fechaServicioHasta,
        fechaVencimientoPago,
        receptorRazonSocial,
        receptorDomicilio,
        items,
        generarPdf,
      } = req.body;

      if (importeNeto === undefined || isNaN(Number(importeNeto)) || Number(importeNeto) <= 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "El campo 'importeNeto' es requerido y debe ser mayor a 0.",
          },
        });
      }

      const input: EmitirFacturaBInput = {
        importeNeto: Number(importeNeto),
        alicuotaIva: alicuotaIva ? Number(alicuotaIva) as any : IvaAlicuota.IVA_21,
        dniOCuit: dniOCuit ? String(dniOCuit) : undefined,
        condicionIva: condicionIva ? Number(condicionIva) as any : CondicionIVAReceptor.CONSUMIDOR_FINAL,
        puntoVenta: puntoVenta ? Number(puntoVenta) : undefined,
        concepto: concepto ? Number(concepto) as any : undefined,
        fechaComprobante,
        fechaServicioDesde,
        fechaServicioHasta,
        fechaVencimientoPago,
        receptorRazonSocial,
        receptorDomicilio,
        items,
        generarPdf: generarPdf !== false,
      };

      const resultado = await ArcaBillingService.emitirFacturaB(input);

      res.status(201).json({
        success: true,
        data: resultado,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * POST /api/vouchers/factura-a
   */
  public static async createFacturaA(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        cuitReceptor,
        importeNeto,
        alicuotasIva,
        puntoVenta,
        concepto,
        fechaComprobante,
        fechaServicioDesde,
        fechaServicioHasta,
        fechaVencimientoPago,
        receptorRazonSocial,
        receptorDomicilio,
        tributos,
        items,
        generarPdf,
      } = req.body;

      if (!cuitReceptor) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "El campo 'cuitReceptor' es obligatorio para Factura A.",
          },
        });
      }

      if (importeNeto === undefined || isNaN(Number(importeNeto)) || Number(importeNeto) <= 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "El campo 'importeNeto' es requerido y debe ser mayor a 0.",
          },
        });
      }

      const input: EmitirFacturaAInput = {
        cuitReceptor: String(cuitReceptor),
        importeNeto: Number(importeNeto),
        alicuotasIva: Array.isArray(alicuotasIva) && alicuotasIva.length > 0
          ? alicuotasIva
          : [
              {
                id: IvaAlicuota.IVA_21,
                baseImponible: Number(importeNeto),
                importe: Number((Number(importeNeto) * 0.21).toFixed(2)),
              },
            ],
        puntoVenta: puntoVenta ? Number(puntoVenta) : undefined,
        concepto: concepto ? Number(concepto) as any : undefined,
        fechaComprobante,
        fechaServicioDesde,
        fechaServicioHasta,
        fechaVencimientoPago,
        receptorRazonSocial,
        receptorDomicilio,
        tributos,
        items,
        generarPdf: generarPdf !== false,
      };

      const resultado = await ArcaBillingService.emitirFacturaA(input);

      res.status(201).json({
        success: true,
        data: resultado,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * POST /api/vouchers/factura-c
   * Emisión para Monotributistas / Exentos (sin discriminación de IVA).
   */
  public static async createFacturaC(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        importeTotal,
        docTipo,
        docNro,
        condicionIvaReceptor,
        puntoVenta,
        concepto,
        fechaComprobante,
        fechaServicioDesde,
        fechaServicioHasta,
        fechaVencimientoPago,
        receptorRazonSocial,
        receptorDomicilio,
        tributos,
        items,
        generarPdf,
      } = req.body;

      if (importeTotal === undefined || isNaN(Number(importeTotal)) || Number(importeTotal) <= 0) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "El campo 'importeTotal' es requerido y debe ser mayor a 0 para Factura C.",
          },
        });
      }

      const input: EmitirFacturaCInput = {
        importeTotal: Number(importeTotal),
        docTipo: docTipo ? Number(docTipo) as any : undefined,
        docNro,
        condicionIvaReceptor: condicionIvaReceptor ? Number(condicionIvaReceptor) as any : undefined,
        puntoVenta: puntoVenta ? Number(puntoVenta) : undefined,
        concepto: concepto ? Number(concepto) as any : undefined,
        fechaComprobante,
        fechaServicioDesde,
        fechaServicioHasta,
        fechaVencimientoPago,
        receptorRazonSocial,
        receptorDomicilio,
        tributos,
        items,
        generarPdf: generarPdf !== false,
      };

      const resultado = await ArcaBillingService.emitirFacturaC(input);

      res.status(201).json({
        success: true,
        data: resultado,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * POST /api/vouchers/factura-m
   */
  public static async createFacturaM(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        cuitReceptor,
        importeNeto,
        alicuotasIva,
        puntoVenta,
        concepto,
        fechaComprobante,
        receptorRazonSocial,
        receptorDomicilio,
        tributos,
        items,
        generarPdf,
      } = req.body;

      if (!cuitReceptor) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "El campo 'cuitReceptor' es obligatorio para Factura M.",
          },
        });
      }

      const input: EmitirFacturaMInput = {
        cuitReceptor: String(cuitReceptor),
        importeNeto: Number(importeNeto),
        alicuotasIva: alicuotasIva ?? [
          {
            id: IvaAlicuota.IVA_21,
            baseImponible: Number(importeNeto),
            importe: Number((Number(importeNeto) * 0.21).toFixed(2)),
          },
        ],
        puntoVenta: puntoVenta ? Number(puntoVenta) : undefined,
        concepto: concepto ? Number(concepto) as any : undefined,
        fechaComprobante,
        receptorRazonSocial,
        receptorDomicilio,
        tributos,
        items,
        generarPdf: generarPdf !== false,
      };

      const resultado = await ArcaBillingService.emitirFacturaM(input);

      res.status(201).json({
        success: true,
        data: resultado,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * POST /api/vouchers/nota-debito
   */
  public static async createNotaDebito(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        tipoNotaDebito,
        tipoDocumento,
        numeroDocumento,
        condicionIvaReceptor,
        importeNeto,
        alicuotasIva,
        comprobanteAsociado,
        puntoVenta,
        concepto,
        fechaComprobante,
        receptorRazonSocial,
        items,
        generarPdf,
      } = req.body;

      if (!comprobanteAsociado || !comprobanteAsociado.tipo || !comprobanteAsociado.numero) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "El objeto 'comprobanteAsociado' (tipo, puntoVenta, numero) es obligatorio para Notas de Débito.",
          },
        });
      }

      const input: EmitirNotaDebitoInput = {
        tipoNotaDebito: tipoNotaDebito ?? CbteTipo.NOTA_DEBITO_B,
        tipoDocumento: tipoDocumento ?? DocTipo.CONSUMIDOR_FINAL,
        numeroDocumento: numeroDocumento ?? 0,
        condicionIvaReceptor: condicionIvaReceptor ?? CondicionIVAReceptor.CONSUMIDOR_FINAL,
        importeNeto: Number(importeNeto),
        alicuotasIva,
        comprobanteAsociado,
        puntoVenta: puntoVenta ? Number(puntoVenta) : undefined,
        concepto: concepto ? Number(concepto) as any : undefined,
        fechaComprobante,
        receptorRazonSocial,
        items,
        generarPdf: generarPdf !== false,
      };

      const resultado = await ArcaBillingService.emitirNotaDebito(input);

      res.status(201).json({
        success: true,
        data: resultado,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * POST /api/vouchers/nota-credito
   */
  public static async createNotaCredito(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        tipoNotaCredito,
        tipoDocumento,
        numeroDocumento,
        condicionIvaReceptor,
        importeNeto,
        alicuotasIva,
        comprobanteAsociado,
        puntoVenta,
        concepto,
        fechaComprobante,
        receptorRazonSocial,
        items,
        generarPdf,
      } = req.body;

      if (!comprobanteAsociado || !comprobanteAsociado.tipo || !comprobanteAsociado.numero) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "El objeto 'comprobanteAsociado' (tipo, puntoVenta, numero) es obligatorio.",
          },
        });
      }

      const input: EmitirNotaCreditoInput = {
        tipoNotaCredito: tipoNotaCredito ?? CbteTipo.NOTA_CREDITO_B,
        tipoDocumento: tipoDocumento ?? DocTipo.CONSUMIDOR_FINAL,
        numeroDocumento: numeroDocumento ?? 0,
        condicionIvaReceptor: condicionIvaReceptor ?? CondicionIVAReceptor.CONSUMIDOR_FINAL,
        importeNeto: Number(importeNeto),
        alicuotasIva,
        comprobanteAsociado,
        puntoVenta: puntoVenta ? Number(puntoVenta) : undefined,
        concepto: concepto ? Number(concepto) as any : undefined,
        fechaComprobante,
        receptorRazonSocial,
        items,
        generarPdf: generarPdf !== false,
      };

      const resultado = await ArcaBillingService.emitirNotaCredito(input);

      res.status(201).json({
        success: true,
        data: resultado,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * POST /api/vouchers/recibo
   */
  public static async createRecibo(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        tipoRecibo,
        tipoDocumento,
        numeroDocumento,
        receptorRazonSocial,
        condicionIvaReceptor,
        importeTotal,
        importeNeto,
        alicuotasIva,
        puntoVenta,
        fechaComprobante,
        items,
        generarPdf,
      } = req.body;

      const input: EmitirReciboInput = {
        tipoRecibo: tipoRecibo ?? CbteTipo.RECIBO_B,
        tipoDocumento: tipoDocumento ?? DocTipo.CONSUMIDOR_FINAL,
        numeroDocumento: numeroDocumento ?? 0,
        receptorRazonSocial,
        condicionIvaReceptor: condicionIvaReceptor ?? CondicionIVAReceptor.CONSUMIDOR_FINAL,
        importeTotal: Number(importeTotal),
        importeNeto,
        alicuotasIva,
        puntoVenta: puntoVenta ? Number(puntoVenta) : undefined,
        fechaComprobante,
        items,
        generarPdf: generarPdf !== false,
      };

      const resultado = await ArcaBillingService.emitirRecibo(input);

      res.status(201).json({
        success: true,
        data: resultado,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * POST /api/vouchers/fce
   * Factura de Crédito Electrónica MiPyMEs (con CBU obligatorio).
   */
  public static async createFce(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        tipoFce,
        cuitReceptor,
        cbuEmisor,
        cbuAlias,
        receptorRazonSocial,
        importeNeto,
        alicuotasIva,
        fechaVencimientoPago,
        puntoVenta,
        fechaComprobante,
        items,
        generarPdf,
      } = req.body;

      if (!cbuEmisor || cbuEmisor.length !== 22) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "El campo 'cbuEmisor' es obligatorio y debe tener 22 dígitos para Factura de Crédito MiPyMEs.",
          },
        });
      }

      if (!fechaVencimientoPago) {
        return res.status(400).json({
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "El campo 'fechaVencimientoPago' (YYYYMMDD) es obligatorio para FCE.",
          },
        });
      }

      const input: EmitirFceInput = {
        tipoFce: tipoFce ?? CbteTipo.FCE_A,
        cuitReceptor: String(cuitReceptor),
        cbuEmisor: String(cbuEmisor),
        cbuAlias,
        receptorRazonSocial,
        importeNeto: Number(importeNeto),
        alicuotasIva: alicuotasIva ?? [
          {
            id: IvaAlicuota.IVA_21,
            baseImponible: Number(importeNeto),
            importe: Number((Number(importeNeto) * 0.21).toFixed(2)),
          },
        ],
        fechaVencimientoPago,
        puntoVenta: puntoVenta ? Number(puntoVenta) : undefined,
        fechaComprobante,
        items,
        generarPdf: generarPdf !== false,
      };

      const resultado = await ArcaBillingService.emitirFce(input);

      res.status(201).json({
        success: true,
        data: resultado,
      });
    } catch (error: any) {
      next(error);
    }
  }

  /**
   * POST /api/vouchers/emitir
   */
  public static async emitirComprobanteGenerico(req: Request, res: Response, next: NextFunction) {
    try {
      const input: EmitirComprobanteInput = req.body;
      const resultado = await ArcaBillingService.emitirComprobante(input);

      res.status(201).json({
        success: true,
        data: resultado,
      });
    } catch (error: any) {
      next(error);
    }
  }
}

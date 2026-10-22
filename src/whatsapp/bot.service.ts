import fs from "node:fs/promises";
import { ArcaBillingService, getNombreTipoComprobante } from "../services/arca-billing.service.js";
import { InvoiceHistoryStorage, type FacturaRegistro } from "../storage/invoice-history.storage.js";
import { ArcaBaseError, ArcaBusinessError, ArcaValidationError } from "../errors/arca-errors.js";
import { CondicionIVAReceptor, DocTipo, type TipoCondicionIvaReceptor } from "../constants/arca.constants.js";
import { KeyedMutex } from "../utils/keyed-mutex.js";
import { AiExtractorService, type ExtraccionMensaje, type MediaAdjunta } from "./ai-extractor.service.js";
import { PadronService } from "./padron.service.js";
import {
  armarInputEmision,
  armarNotaCredito,
  armarResumen,
  clasificarDocumento,
  esFacturaAnulable,
  formatearCuit,
  formatearPesos,
  resolverFactura,
  type BorradorFactura,
} from "./fiscal-engine.js";
import { alertaTopeMonotributo, notaCreditoExistente } from "./invoice-stats.js";
import { SessionStore, nuevoBorradorId, type SesionBot } from "./session.store.js";
import { WhatsAppClient } from "./whatsapp.client.js";
import { loadWhatsAppConfig, type WhatsAppBotConfig } from "./whatsapp.config.js";
import type { ComprobanteEmitidoResultado } from "../types/billing.types.js";
import { conEmpresa, empresaActual } from "../empresas/empresa.context.js";
import { EmpresaRepository } from "../empresas/empresa.repository.js";
import { NOMBRE_CONDICION_EMISOR, type Empresa } from "../empresas/empresa.types.js";
import { RegistroEmpresaFlow } from "./registro-empresa.flow.js";

/** Mensaje entrante ya normalizado desde el webhook de Meta. */
export interface MensajeEntrante {
  id: string;
  from: string;
  type: string;
  text?: string;
  mediaId?: string;
  mimeType?: string;
  buttonId?: string;
  contextMessageId?: string;
}

const AYUDA = [
  "👋 Soy tu bot de facturación electrónica (ARCA).",
  "",
  "Mandame un mensaje o un audio como:",
  "• _Facturale $45.000 a consumidor final por servicio de diseño_",
  "• _Factura al CUIT 30-71234567-9 por 120 mil más IVA de mantenimiento_",
  "• Una captura de una transferencia que recibiste",
  "",
  "Otros comandos:",
  "• Respondé (citá) el PDF de una factura y escribí _anulala_ para hacer la Nota de Crédito",
  "• _últimas_: ver las últimas facturas emitidas",
  "• _cancelar_: descartar lo que estemos armando",
  "",
  "Empresas:",
  "• _nueva empresa_: registrar otra empresa que factura",
  "• _empresas_: ver tus empresas y cambiar con cuál trabajás",
  "• _mi empresa_: ver los datos fiscales de la empresa activa",
  "• _cambiar logo_: subir el logo que va en el PDF",
].join("\n");

const OPCIONES_CONDICION: Array<{ code: TipoCondicionIvaReceptor; title: string; description: string }> = [
  { code: CondicionIVAReceptor.RESPONSABLE_INSCRIPTO, title: "Resp. Inscripto", description: "Inscripto en IVA" },
  { code: CondicionIVAReceptor.RESPONSABLE_MONOTRIBUTO, title: "Monotributista", description: "Adherido al Monotributo" },
  { code: CondicionIVAReceptor.IVA_SUJETO_EXENTO, title: "IVA Exento", description: "Sujeto exento de IVA" },
  { code: CondicionIVAReceptor.CONSUMIDOR_FINAL, title: "Consumidor Final", description: "Persona sin inscripción en IVA" },
];

function capitalizar(s: string): string {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function normalizarTexto(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function formatearFecha(yyyymmdd: string): string {
  const s = String(yyyymmdd).replace(/-/g, "");
  return s.length === 8 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : s;
}

export class WhatsAppBotService {
  private config: WhatsAppBotConfig;
  private wa: WhatsAppClient;
  private porTelefono = new KeyedMutex();
  private registro: RegistroEmpresaFlow;

  constructor(config: WhatsAppBotConfig = loadWhatsAppConfig(), client?: WhatsAppClient) {
    this.config = config;
    this.wa = client ?? new WhatsAppClient(config);
    const cuitSistema = Number(String(process.env.ARCA_CUIT || "").replace(/\D/g, "")) || undefined;
    this.registro = new RegistroEmpresaFlow(this.wa, {
      produccion: process.env.ARCA_PRODUCTION === "true",
      cuitSistema,
    });
  }

  /** Configuración del bot ajustada a la empresa activa (condición IVA, topes, etc.). */
  private cfg(): WhatsAppBotConfig {
    const e = empresaActual();
    if (!e) return this.config;
    return {
      ...this.config,
      emisorCondicion: e.condicionIva,
      emisorRazonSocial: e.razonSocial,
      emisorDomicilio: e.domicilioComercial,
      monotributoTopeAnual: e.monotributoTopeAnual,
      monotributoCategoria: e.monotributoCategoria,
    };
  }

  /** Punto de entrada: procesa los mensajes de un mismo teléfono de a uno. */
  public procesar(msg: MensajeEntrante): Promise<void> {
    return this.porTelefono.run(msg.from, async () => {
      try {
        await this.wa.markAsRead(msg.id);
        await this.manejarMensaje(msg);
      } catch (error: any) {
        console.error(`[WhatsApp Bot] Error procesando mensaje ${msg.id} de ${msg.from}:`, error);
        // No se muestran detalles internos (rutas, SQL, tokens) en el chat.
        await this.wa
          .sendText(msg.from, "⚠️ Ocurrió un error procesando tu mensaje. Probá de nuevo en un momento.")
          .catch(() => undefined);
      }
    });
  }

  private async manejarMensaje(msg: MensajeEntrante): Promise<void> {
    const sesion = await SessionStore.get(msg.from, this.config.sessionTtlMinutes);
    const texto = (msg.text ?? "").trim();
    const t = normalizarTexto(texto);

    // 1. Comandos globales (funcionan en cualquier estado y no gastan IA)
    if (!msg.buttonId) {
      if (/^(cancelar|cancela|cancelalo|salir)$/.test(t)) {
        const enRegistro = sesion.estado === "REGISTRO_EMPRESA";
        await this.registro.descartar(sesion);
        await SessionStore.clear(msg.from);
        await this.wa.sendText(msg.from, enRegistro ? "❌ Registro cancelado. No se guardó nada." : "❌ Listo, cancelado. No se emitió nada.");
        return;
      }
      if (/^(nueva empresa|registrar empresa|registrar una empresa|alta empresa|alta de empresa|agregar empresa)$/.test(t)) {
        await this.registro.descartar(sesion);
        return this.registro.iniciar(sesion);
      }
      // Durante el alta, una respuesta como "logo" o "empresa" es un dato, no un comando.
      const enRegistro = sesion.estado === "REGISTRO_EMPRESA";
      if (!enRegistro && /^(empresas|mis empresas|cambiar empresa|cambiar de empresa)$/.test(t)) {
        return this.listarEmpresas(sesion);
      }
      if (!enRegistro && /^(empresa|mi empresa|datos empresa|datos de la empresa|datos de mi empresa)$/.test(t)) {
        return this.mostrarEmpresa(sesion);
      }
      if (!enRegistro && /^(cambiar logo|subir logo|logo)$/.test(t)) {
        return this.pedirLogo(sesion);
      }
      if (/^(ayuda|help|menu|hola|buenas)$/.test(t)) {
        if (sesion.estado === "REGISTRO_EMPRESA") return this.registro.preguntar(sesion);
        await this.wa.sendText(msg.from, AYUDA);
        return;
      }
    }

    // 2. Botones interactivos
    if (msg.buttonId) {
      return this.manejarBoton(sesion, msg.buttonId);
    }

    // 3. Flujos de empresa
    if (sesion.estado === "REGISTRO_EMPRESA") {
      return this.registro.manejarMensaje(sesion, { texto, mediaId: msg.mediaId, mimeType: msg.mimeType });
    }
    if (sesion.estado === "ESPERANDO_LOGO") {
      return this.recibirLogoEmpresa(sesion, msg);
    }

    // 4. Facturación: siempre dentro de la empresa activa del teléfono
    const empresa = await this.empresaPara(sesion);
    if (!empresa) return;
    return conEmpresa(empresa, () => this.manejarFacturacion(sesion, msg, texto, t));
  }

  private async manejarFacturacion(sesion: SesionBot, msg: MensajeEntrante, texto: string, t: string): Promise<void> {
    if (/^(ultimas|ultimas facturas|historial)$/.test(t)) {
      return this.enviarUltimas(msg.from);
    }

    // Respuesta textual a la pregunta de condición frente al IVA
    if (sesion.estado === "ESPERANDO_DATO" && sesion.campoPendiente === "condicion_iva" && !msg.mediaId) {
      const cond = this.parsearCondicion(t);
      if (cond) {
        sesion.borrador.receptorCondicionIva = cond;
        return this.avanzar(sesion);
      }
    }

    // Respuesta con solo un número de documento cuando falta el cliente (ej: "20-12345678-9" o "30.123.456")
    if (sesion.estado === "ESPERANDO_DATO" && !msg.mediaId && /^[\d\s.\-]+$/.test(texto)) {
      const b = sesion.borrador;
      const digitos = texto.replace(/\D/g, "");
      const faltaCliente = sesion.campoPendiente === "documento" || (!b.receptorDocumento && !b.consumidorFinal);
      if (faltaCliente && (digitos.length === 11 || (b.montoTotal && digitos.length >= 7 && digitos.length <= 8))) {
        b.receptorDocumento = digitos;
        b.consumidorFinal = false;
        return this.avanzar(sesion);
      }
    }

    if (!texto && !msg.mediaId) {
      await this.wa.sendText(msg.from, "Por ahora entiendo texto, audios, imágenes y PDFs. " + "Escribí _ayuda_ para ver ejemplos.");
      return;
    }

    // 3. Extracción con IA (texto / audio / imagen / PDF)
    let media: MediaAdjunta | undefined;
    if (msg.mediaId) {
      media = await this.wa.downloadMedia(msg.mediaId);
    }
    const extraccion = await AiExtractorService.extraer(texto, media, this.describirContexto(sesion));

    if (extraccion.accion === "CANCELAR") {
      await SessionStore.clear(msg.from);
      await this.wa.sendText(msg.from, "❌ Listo, cancelado. No se emitió nada.");
      return;
    }

    // 4. Anulación: pedido explícito, o cita del PDF de una factura con intención de anular
    const facturaCitadaId = msg.contextMessageId ? await SessionStore.facturaPorMensaje(msg.contextMessageId) : null;
    if (extraccion.accion === "ANULAR") {
      return this.iniciarAnulacion(sesion, extraccion, facturaCitadaId);
    }

    const aportaDatos = this.aportaDatos(extraccion);
    if (sesion.estado === "IDLE" && (!aportaDatos || extraccion.accion === "AYUDA")) {
      await this.wa.sendText(msg.from, AYUDA);
      return;
    }

    // 5. Emisión: arrancar o completar el borrador
    if (sesion.estado === "IDLE" || sesion.estado === "ESPERANDO_CONFIRMACION_ANULACION") {
      sesion.borrador = {};
      sesion.anulacionFacturaId = undefined;
    }
    // Mientras se espera un dato puntual, no se pisa el concepto ya anotado
    // (ej: si responde con el nombre del cliente, que no se tome como concepto).
    if (sesion.estado === "ESPERANDO_DATO" && sesion.borrador.conceptoDescripcion) {
      extraccion.conceptoDescripcion = null;
      extraccion.tipoConcepto = null;
    }
    this.fusionar(sesion.borrador, extraccion);

    // Si se pidió el concepto y la IA no lo encontró, el texto mismo es el concepto.
    if (
      sesion.estado === "ESPERANDO_DATO" &&
      sesion.campoPendiente === "concepto" &&
      !sesion.borrador.conceptoDescripcion &&
      texto &&
      !msg.mediaId
    ) {
      sesion.borrador.conceptoDescripcion = capitalizar(texto);
    }

    return this.avanzar(sesion);
  }

  // ---------------------------------------------------------------------------
  // Flujo de emisión
  // ---------------------------------------------------------------------------

  private aportaDatos(e: ExtraccionMensaje): boolean {
    return Boolean(
      e.montoTotal || e.receptorDocumento || e.receptorNombre || e.conceptoDescripcion || e.consumidorFinal || e.alicuotaIva !== null
    );
  }

  private fusionar(b: BorradorFactura, e: ExtraccionMensaje): void {
    if (e.montoTotal) b.montoTotal = e.montoTotal;
    if (e.ivaIncluido !== null) b.ivaIncluido = e.ivaIncluido;
    if (e.alicuotaIva !== null) b.alicuotaIva = e.alicuotaIva;
    if (e.conceptoDescripcion) b.conceptoDescripcion = capitalizar(e.conceptoDescripcion);
    if (e.tipoConcepto) b.tipoConcepto = e.tipoConcepto;

    if (e.consumidorFinal && !e.receptorDocumento) {
      b.consumidorFinal = true;
      b.receptorDocumento = undefined;
      b.receptorNombre = undefined;
      b.receptorDomicilio = undefined;
      b.receptorCondicionIva = undefined;
      b.padronConsultadoPara = undefined;
    }

    if (e.receptorDocumento && e.receptorDocumento !== b.receptorDocumento) {
      b.consumidorFinal = false;
      b.receptorDocumento = e.receptorDocumento;
      b.receptorNombre = undefined;
      b.receptorDomicilio = undefined;
      b.receptorCondicionIva = undefined;
      b.padronConsultadoPara = undefined;
    }
    if (e.receptorNombre) b.receptorNombre = e.receptorNombre;
  }

  /** Completa nombre/condición IVA con el padrón de ARCA (una vez por documento). */
  private async enriquecer(b: BorradorFactura): Promise<void> {
    if (!b.receptorDocumento || b.padronConsultadoPara === b.receptorDocumento) return;

    const { docTipo, valido } = clasificarDocumento(b.receptorDocumento);
    b.padronConsultadoPara = b.receptorDocumento;
    if (!valido) return;

    const datos =
      docTipo === DocTipo.CUIT && this.config.consultarPadron
        ? await PadronService.consultar(b.receptorDocumento)
        : await PadronService.buscarEnClientes(b.receptorDocumento);

    if (datos) {
      if (datos.razonSocial) b.receptorNombre = datos.razonSocial;
      if (datos.domicilio) b.receptorDomicilio = datos.domicilio;
      if (datos.condicionIva && !b.receptorCondicionIva) b.receptorCondicionIva = datos.condicionIva;
    }
  }

  private async avanzar(sesion: SesionBot): Promise<void> {
    await this.enriquecer(sesion.borrador);
    const resultado = resolverFactura(sesion.borrador, this.cfg());

    if (resultado.tipo !== "LISTO") {
      sesion.estado = "ESPERANDO_DATO";
      sesion.campoPendiente = resultado.campo;
      sesion.borradorId = nuevoBorradorId();
      await SessionStore.save(sesion);

      if (resultado.campo === "condicion_iva") {
        await this.wa.sendList(
          sesion.telefono,
          resultado.mensaje,
          "Elegir condición",
          OPCIONES_CONDICION.map((o) => ({
            id: `cond:${sesion.borradorId}:${o.code}`,
            title: o.title,
            description: o.description,
          })),
          "Condición frente al IVA"
        );
      } else if (resultado.tipo === "FALTA_DATO" && resultado.faltantes?.includes("documento")) {
        // Falta el cliente: botón de un toque para Consumidor Final
        await this.wa.sendButtons(sesion.telefono, resultado.mensaje, [
          { id: `cf:${sesion.borradorId}`, title: "Consumidor Final" },
          { id: `cancelar:${sesion.borradorId}`, title: "❌ Cancelar" },
        ]);
      } else {
        if (resultado.tipo === "INVALIDO" && resultado.campo === "documento") {
          sesion.borrador.receptorDocumento = undefined;
          sesion.borrador.padronConsultadoPara = undefined;
          await SessionStore.save(sesion);
        }
        await this.wa.sendText(sesion.telefono, resultado.mensaje);
      }
      return;
    }

    sesion.estado = "ESPERANDO_CONFIRMACION";
    sesion.campoPendiente = undefined;
    sesion.facturaResuelta = resultado.factura;
    sesion.borradorId = nuevoBorradorId();
    await SessionStore.save(sesion);

    await this.wa.sendButtons(
      sesion.telefono,
      armarResumen(resultado.factura),
      [
        { id: `emitir:${sesion.borradorId}`, title: "✅ Emitir ahora" },
        { id: `corregir:${sesion.borradorId}`, title: "✏️ Corregir" },
        { id: `cancelar:${sesion.borradorId}`, title: "❌ Cancelar" },
      ],
      "Una factura emitida no se puede borrar"
    );
  }

  private async manejarBoton(sesion: SesionBot, buttonId: string): Promise<void> {
    const [accion, borradorId, ...resto] = buttonId.split(":");
    const extra = resto.join(":");

    if (!borradorId || borradorId !== sesion.borradorId) {
      await this.wa.sendText(
        sesion.telefono,
        "Ese botón ya no está vigente (la operación se completó, se canceló o expiró). Mandame un mensaje nuevo para empezar."
      );
      return;
    }

    // Botones que no dependen de la empresa activa
    switch (accion) {
      case "reg":
        return this.registro.boton(sesion, extra);
      case "emp":
        return this.elegirEmpresa(sesion, Number(extra));
      case "logo_quitar":
        return this.quitarLogo(sesion);
      case "cancelar":
      case "anular_no": {
        const enRegistro = sesion.estado === "REGISTRO_EMPRESA";
        await this.registro.descartar(sesion);
        await SessionStore.clear(sesion.telefono);
        await this.wa.sendText(sesion.telefono, enRegistro ? "❌ Registro cancelado. No se guardó nada." : "❌ Cancelado. No se emitió nada.");
        return;
      }
    }

    const empresa = await this.empresaPara(sesion);
    if (!empresa) return;
    return conEmpresa(empresa, () => this.botonFacturacion(sesion, accion, extra));
  }

  private async botonFacturacion(sesion: SesionBot, accion: string, extra: string): Promise<void> {
    switch (accion) {
      case "emitir":
        return this.emitir(sesion);

      case "corregir":
        sesion.estado = "ESPERANDO_CORRECCION";
        sesion.borradorId = nuevoBorradorId();
        await SessionStore.save(sesion);
        await this.wa.sendText(
          sesion.telefono,
          "✏️ Decime qué cambio (ej: _el monto es 50 mil_, _el CUIT es 20-12345678-9_, _el concepto es mantenimiento_)."
        );
        return;

      case "cf":
        sesion.borrador.consumidorFinal = true;
        sesion.borrador.receptorDocumento = undefined;
        sesion.borrador.receptorNombre = undefined;
        sesion.borrador.receptorCondicionIva = undefined;
        return this.avanzar(sesion);

      case "cond": {
        const code = Number(extra) as TipoCondicionIvaReceptor;
        if (!OPCIONES_CONDICION.some((o) => o.code === code)) return;
        sesion.borrador.receptorCondicionIva = code;
        return this.avanzar(sesion);
      }

      case "anular_si":
        return this.emitirAnulacion(sesion);
    }
  }

  private async emitir(sesion: SesionBot): Promise<void> {
    if (sesion.estado !== "ESPERANDO_CONFIRMACION" || !sesion.facturaResuelta) {
      await this.wa.sendText(sesion.telefono, "No hay ninguna factura lista para emitir.");
      return;
    }

    const factura = sesion.facturaResuelta;
    // Se invalida el borrador ANTES de llamar a ARCA: un segundo toque de "Emitir" no emite dos veces.
    sesion.estado = "IDLE";
    sesion.borradorId = undefined;
    await SessionStore.save(sesion);

    await this.wa.sendText(sesion.telefono, "⏳ Emitiendo en ARCA...");

    let resultado: ComprobanteEmitidoResultado & { registroId?: string };
    try {
      resultado = await ArcaBillingService.emitirComprobante(armarInputEmision(factura, this.cfg()));
    } catch (error: any) {
      return this.informarErrorEmision(sesion, error, true);
    }

    if (!resultado.exito || !resultado.cae) {
      return this.informarErrorEmision(sesion, new Error("ARCA no devolvió CAE."), false);
    }

    await SessionStore.clear(sesion.telefono);
    await this.enviarComprobante(sesion.telefono, resultado);

    const alerta = await alertaTopeMonotributo(this.cfg(), empresaActual()?.cuit ?? 0);
    if (alerta) await this.wa.sendText(sesion.telefono, alerta);
  }

  private async informarErrorEmision(sesion: SesionBot, error: any, permitirCorregir: boolean): Promise<void> {
    const rechazoSeguro = error instanceof ArcaBusinessError || error instanceof ArcaValidationError;

    if (rechazoSeguro && permitirCorregir) {
      // ARCA rechazó o no pasó la validación: no se emitió nada, se puede corregir y reintentar.
      const obs = Array.isArray(error.details)
        ? error.details.map((o: any) => `• ${o.code ? `[${o.code}] ` : ""}${o.msg ?? JSON.stringify(o)}`).join("\n")
        : "";
      sesion.estado = "ESPERANDO_CORRECCION";
      sesion.borradorId = nuevoBorradorId();
      await SessionStore.save(sesion);
      await this.wa.sendText(
        sesion.telefono,
        `❌ ARCA no aceptó el comprobante: ${error.message}${obs ? `\n${obs}` : ""}\n\nNo se emitió nada. Decime qué corregir o escribí _cancelar_.`
      );
      return;
    }

    // Error de red / desconocido: puede que ARCA lo haya autorizado igual. No reintentar a ciegas.
    await SessionStore.clear(sesion.telefono);
    const detalle = error instanceof ArcaBaseError ? `${error.message}` : String(error?.message ?? error);
    await this.wa.sendText(
      sesion.telefono,
      `⚠️ Hubo un problema al emitir: ${detalle}\n\nAntes de reintentar, escribí _últimas_ para verificar si la factura se registró, así no se duplica.`
    );
  }

  private async enviarComprobante(telefono: string, r: ComprobanteEmitidoResultado & { registroId?: string }) {
    const { nombre, letra } = getNombreTipoComprobante(r.tipoComprobante);
    const numero = `${String(r.puntoVenta).padStart(5, "0")}-${String(r.numeroComprobante).padStart(8, "0")}`;
    const caption = [
      `✅ *${nombre} ${letra} ${numero}* emitida`,
      `Total: ${formatearPesos(r.importeTotal)}`,
      `CAE: ${r.cae} (vence ${formatearFecha(r.caeVencimiento)})`,
    ].join("\n");

    let messageId: string | undefined;
    if (r.pdf?.filePath) {
      try {
        const buffer = await fs.readFile(r.pdf.filePath);
        const filename = `${nombre.replace(/\s+/g, "_")}_${letra}_${numero}.pdf`;
        messageId = await this.wa.sendDocument(telefono, buffer, filename, caption);
      } catch (error: any) {
        console.error("[WhatsApp Bot] No se pudo enviar el PDF:", error);
      }
    }
    if (!messageId) {
      messageId = await this.wa.sendText(telefono, `${caption}\n\n(No pude adjuntar el PDF, pedilo por la API.)`);
    }

    if (messageId && r.registroId) {
      await SessionStore.vincularMensajeFactura(messageId, r.registroId, telefono);
    }
  }

  // ---------------------------------------------------------------------------
  // Anulación
  // ---------------------------------------------------------------------------

  private async buscarFactura(referencia: string | null, facturaCitadaId: string | null): Promise<FacturaRegistro | null> {
    if (facturaCitadaId) {
      const f = await InvoiceHistoryStorage.getById(facturaCitadaId);
      if (f) return f;
    }
    if (!referencia) return null;

    const ref = referencia.trim();
    const conGuion = ref.match(/^(\d{1,5})-(\d{1,8})$/);
    if (conGuion) {
      return InvoiceHistoryStorage.getById(`${conGuion[1].padStart(5, "0")}-${conGuion[2].padStart(8, "0")}`);
    }
    return InvoiceHistoryStorage.getById(ref.replace(/\D/g, ""));
  }

  private async iniciarAnulacion(sesion: SesionBot, e: ExtraccionMensaje, facturaCitadaId: string | null): Promise<void> {
    const factura = await this.buscarFactura(e.comprobanteReferencia, facturaCitadaId);

    if (!factura) {
      await this.wa.sendText(
        sesion.telefono,
        "¿Cuál querés anular? Respondé (citá) el PDF de la factura que te mandé y escribí _anulala_, o decime su número (ej: _anulá la 00001-00000101_)."
      );
      return;
    }

    if (!esFacturaAnulable(factura.tipoComprobante)) {
      await this.wa.sendText(sesion.telefono, `El comprobante ${factura.tipoComprobanteNombre} ${factura.numeroFormateado} no se anula con Nota de Crédito.`);
      return;
    }

    const existente = await notaCreditoExistente(factura);
    if (existente) {
      await this.wa.sendText(sesion.telefono, `Esa factura ya fue anulada con la ${existente}.`);
      return;
    }

    sesion.estado = "ESPERANDO_CONFIRMACION_ANULACION";
    sesion.anulacionFacturaId = factura.id;
    sesion.borradorId = nuevoBorradorId();
    await SessionStore.save(sesion);

    const doc =
      factura.receptorDocTipo === "CUIT" ? ` (CUIT ${formatearCuit(factura.receptorDocNro)})` : "";
    await this.wa.sendButtons(
      sesion.telefono,
      [
        "🧾 *Anular con Nota de Crédito:*",
        `• Factura: ${factura.tipoComprobanteNombre} ${factura.numeroFormateado} del ${factura.fechaEmisionFormateada}`,
        `• Cliente: ${factura.receptorRazonSocial}${doc}`,
        `• Total: ${formatearPesos(factura.importeTotal)}`,
        "",
        "Se va a emitir una Nota de Crédito por el total, vinculada a esa factura.",
      ].join("\n"),
      [
        { id: `anular_si:${sesion.borradorId}`, title: "✅ Sí, anular" },
        { id: `anular_no:${sesion.borradorId}`, title: "❌ No" },
      ]
    );
  }

  private async emitirAnulacion(sesion: SesionBot): Promise<void> {
    const facturaId = sesion.anulacionFacturaId;
    if (sesion.estado !== "ESPERANDO_CONFIRMACION_ANULACION" || !facturaId) {
      await this.wa.sendText(sesion.telefono, "No hay ninguna anulación pendiente.");
      return;
    }

    sesion.estado = "IDLE";
    sesion.borradorId = undefined;
    await SessionStore.save(sesion);

    const original = await InvoiceHistoryStorage.getById(facturaId);
    if (!original) {
      await SessionStore.clear(sesion.telefono);
      await this.wa.sendText(sesion.telefono, "No encontré la factura original en el historial.");
      return;
    }
    const existente = await notaCreditoExistente(original);
    if (existente) {
      await SessionStore.clear(sesion.telefono);
      await this.wa.sendText(sesion.telefono, `Esa factura ya fue anulada con la ${existente}.`);
      return;
    }

    await this.wa.sendText(sesion.telefono, "⏳ Emitiendo Nota de Crédito en ARCA...");

    try {
      const resultado = await ArcaBillingService.emitirComprobante(armarNotaCredito(original, this.cfg()));
      await SessionStore.clear(sesion.telefono);
      if (!resultado.exito || !resultado.cae) {
        await this.wa.sendText(sesion.telefono, "⚠️ ARCA no devolvió CAE para la Nota de Crédito. Escribí _últimas_ para verificar.");
        return;
      }
      await this.enviarComprobante(sesion.telefono, resultado);
    } catch (error: any) {
      return this.informarErrorEmision(sesion, error, false);
    }
  }

  // ---------------------------------------------------------------------------
  // Empresas
  // ---------------------------------------------------------------------------

  /** Empresa activa del teléfono. Si no hay, le explica qué hacer y devuelve null. */
  private async empresaPara(sesion: SesionBot): Promise<Empresa | null> {
    const empresa = await EmpresaRepository.activaDe(sesion.telefono);
    if (empresa) return empresa;

    const propias = await EmpresaRepository.listarPorTelefono(sesion.telefono);
    if (propias.length === 0) {
      await this.wa.sendText(
        sesion.telefono,
        "Todavía no tenés ninguna empresa registrada para facturar. Escribí *nueva empresa* y te pido los datos."
      );
    } else {
      await this.listarEmpresas(sesion, "Tenés varias empresas. ¿Con cuál querés trabajar?");
    }
    return null;
  }

  private async listarEmpresas(sesion: SesionBot, titulo?: string): Promise<void> {
    const propias = await EmpresaRepository.listarPorTelefono(sesion.telefono);
    if (propias.length === 0) {
      await this.wa.sendText(sesion.telefono, "No tenés empresas registradas. Escribí *nueva empresa* para dar de alta la primera.");
      return;
    }
    const activa = await EmpresaRepository.activaDe(sesion.telefono);
    if (propias.length === 1) {
      await this.wa.sendText(
        sesion.telefono,
        `Trabajás con *${propias[0].razonSocial}* (CUIT ${formatearCuit(propias[0].cuit)}).\nPara agregar otra, escribí _nueva empresa_.`
      );
      return;
    }

    // Elegir empresa descarta cualquier factura a medio armar (era de otra empresa).
    sesion.borradorId = nuevoBorradorId();
    await SessionStore.save(sesion);
    await this.wa.sendList(
      sesion.telefono,
      `${titulo ?? "🏢 Tus empresas"}${activa ? `\n\nActiva: *${activa.razonSocial}*` : ""}\n\nPara agregar otra, escribí _nueva empresa_.`,
      "Elegir empresa",
      propias.slice(0, 10).map((e) => ({
        id: `emp:${sesion.borradorId}:${e.id}`,
        title: `${e.id === activa?.id ? "✓ " : ""}${e.nombreFantasia ?? e.razonSocial}`,
        description: `CUIT ${formatearCuit(e.cuit)} · ${NOMBRE_CONDICION_EMISOR[e.condicionIva]}`,
      })),
      "Empresas"
    );
  }

  private async elegirEmpresa(sesion: SesionBot, empresaId: number): Promise<void> {
    if (!Number.isInteger(empresaId) || !(await EmpresaRepository.tieneAcceso(empresaId, sesion.telefono))) {
      await this.wa.sendText(sesion.telefono, "No tenés acceso a esa empresa.");
      return;
    }
    await EmpresaRepository.elegirActiva(sesion.telefono, empresaId);
    await SessionStore.clear(sesion.telefono);
    const e = await EmpresaRepository.porId(empresaId);
    await this.wa.sendText(sesion.telefono, `✅ Ahora facturás como *${e?.razonSocial}* (CUIT ${formatearCuit(e?.cuit ?? "")}).`);
  }

  private async mostrarEmpresa(sesion: SesionBot): Promise<void> {
    const e = await this.empresaPara(sesion);
    if (!e) return;
    const inicio = e.inicioActividades?.split("-").reverse().join("/");
    await this.wa.sendText(
      sesion.telefono,
      [
        `🏢 *${e.razonSocial}*`,
        e.nombreFantasia ? `• Nombre de fantasía: ${e.nombreFantasia}` : null,
        `• CUIT: ${formatearCuit(e.cuit)}`,
        `• Domicilio comercial: ${e.domicilioComercial}`,
        `• Condición IVA: ${NOMBRE_CONDICION_EMISOR[e.condicionIva]}${e.monotributoCategoria ? ` (Cat. ${e.monotributoCategoria})` : ""}`,
        `• Ingresos Brutos: ${e.ingresosBrutos ?? "⚠️ sin cargar"}`,
        `• Inicio de actividades: ${inicio ?? "⚠️ sin cargar"}`,
        `• Punto de venta: ${e.puntoVenta}`,
        e.email ? `• Email: ${e.email}` : null,
        `• Logo: ${e.logoPath ? "cargado" : "sin logo (escribí _cambiar logo_)"}`,
        `• Conexión ARCA: ${e.certModo === "PROPIO" ? "certificado propio" : "delegación"}${e.produccion ? "" : " · homologación"}`,
      ]
        .filter((l) => l !== null)
        .join("\n")
    );
  }

  private async pedirLogo(sesion: SesionBot): Promise<void> {
    const e = await this.empresaPara(sesion);
    if (!e) return;
    await this.registro.descartar(sesion);
    sesion.estado = "ESPERANDO_LOGO";
    sesion.borradorId = nuevoBorradorId();
    await SessionStore.save(sesion);
    const botones = [{ id: `cancelar:${sesion.borradorId}`, title: "❌ Cancelar" }];
    if (e.logoPath) botones.unshift({ id: `logo_quitar:${sesion.borradorId}`, title: "🗑️ Quitar logo" });
    await this.wa.sendButtons(
      sesion.telefono,
      `Mandame el nuevo logo de *${e.razonSocial}* como imagen (JPG o PNG, hasta 2 MB). Se usa en las próximas facturas.`,
      botones
    );
  }

  private async recibirLogoEmpresa(sesion: SesionBot, msg: MensajeEntrante): Promise<void> {
    const e = await EmpresaRepository.activaDe(sesion.telefono);
    if (!e) {
      await SessionStore.clear(sesion.telefono);
      return;
    }
    if (!msg.mediaId) {
      await this.wa.sendText(sesion.telefono, "Mandame el logo como imagen, o escribí _cancelar_.");
      return;
    }
    const ruta = await this.registro.descargarLogo(sesion, { texto: "", mediaId: msg.mediaId, mimeType: msg.mimeType }, String(e.cuit));
    if (!ruta) return;
    await EmpresaRepository.actualizarLogo(e.id, ruta);
    if (e.logoPath && e.logoPath !== ruta) await fs.unlink(e.logoPath).catch(() => undefined);
    await SessionStore.clear(sesion.telefono);
    await this.wa.sendText(sesion.telefono, `🖼️ Listo, el logo de *${e.razonSocial}* quedó actualizado.`);
  }

  private async quitarLogo(sesion: SesionBot): Promise<void> {
    const e = await EmpresaRepository.activaDe(sesion.telefono);
    await SessionStore.clear(sesion.telefono);
    if (!e?.logoPath) return;
    await EmpresaRepository.actualizarLogo(e.id, null);
    await fs.unlink(e.logoPath).catch(() => undefined);
    await this.wa.sendText(sesion.telefono, "🗑️ Logo quitado. Las próximas facturas salen sin logo.");
  }

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------

  private async enviarUltimas(telefono: string): Promise<void> {
    const { facturas } = await InvoiceHistoryStorage.getAll({ limit: 5 });
    if (facturas.length === 0) {
      await this.wa.sendText(telefono, "Todavía no hay comprobantes emitidos.");
      return;
    }
    const lineas = facturas.map(
      (f) => `• ${f.tipoComprobanteNombre} ${f.numeroFormateado} – ${f.fechaEmisionFormateada} – ${f.receptorRazonSocial} – ${formatearPesos(f.importeTotal)}`
    );
    await this.wa.sendText(telefono, `🧾 *Últimos comprobantes:*\n${lineas.join("\n")}`);
  }

  private parsearCondicion(t: string): TipoCondicionIvaReceptor | null {
    if (/inscript|^ri$|responsable/.test(t)) return CondicionIVAReceptor.RESPONSABLE_INSCRIPTO;
    if (/monotrib/.test(t)) return CondicionIVAReceptor.RESPONSABLE_MONOTRIBUTO;
    if (/exent/.test(t)) return CondicionIVAReceptor.IVA_SUJETO_EXENTO;
    if (/consumidor|final/.test(t)) return CondicionIVAReceptor.CONSUMIDOR_FINAL;
    return null;
  }

  private describirContexto(sesion: SesionBot): string | undefined {
    if (sesion.estado === "IDLE") return undefined;

    const b = sesion.borrador;
    const partes = [
      `Estado: ${sesion.estado}`,
      sesion.campoPendiente ? `Dato que se le pidió al usuario: ${sesion.campoPendiente}` : null,
      `Borrador actual: ${JSON.stringify({
        montoTotal: b.montoTotal,
        ivaIncluido: b.ivaIncluido,
        receptorDocumento: b.receptorDocumento,
        receptorNombre: b.receptorNombre,
        conceptoDescripcion: b.conceptoDescripcion,
      })}`,
      "Si el usuario responde solo el dato pedido o corrige algo, la acción es EMITIR_FACTURA y devolvé solo los campos que mencionó.",
    ];
    return partes.filter(Boolean).join("\n");
  }
}

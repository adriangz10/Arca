import fs from "node:fs/promises";
import { ArcaBillingService } from "../services/arca-billing.service.js";
import { InvoiceHistoryStorage, type FacturaRegistro } from "../storage/invoice-history.storage.js";
import { ConfiguracionRepository } from "../config/configuracion.repository.js";
import { conEmpresa } from "../empresas/empresa.context.js";
import { EmpresaRepository } from "../empresas/empresa.repository.js";
import { NOMBRE_CONDICION_EMISOR, type Empresa } from "../empresas/empresa.types.js";
import { KeyedMutex } from "../utils/keyed-mutex.js";
import { AiExtractorService, type ExtraccionMensaje, type MediaAdjunta } from "./ai-extractor.service.js";
import { describirErrorIncierto, describirRechazo, enviarComprobante, esRechazoSeguro } from "./comprobante.sender.js";
import { armarNotaCredito, esFacturaAnulable, formatearCuit, formatearPesos } from "./fiscal-engine.js";
import { notaCreditoExistente } from "./invoice-stats.js";
import { RegistroEmpresaFlow } from "./registro-empresa.flow.js";
import { SessionStore, nuevoBorradorId, type SesionBot } from "./session.store.js";
import { VentaFlow } from "./venta.flow.js";
import { WhatsAppClient } from "./whatsapp.client.js";
import { loadWhatsAppConfig, type WhatsAppBotConfig } from "./whatsapp.config.js";

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
  "Para facturar mandame un mensaje o un audio como:",
  "• _Nueva venta de papel por 12000_",
  "• _Venta de mantenimiento por 120 mil más IVA al CUIT 30-71234567-1_",
  "• Una captura de una transferencia que recibiste",
  "",
  "Otros comandos:",
  "• Citá el PDF de una factura y escribí _anulala_ para hacer la Nota de Crédito",
  "• _últimas_: ver las últimas facturas emitidas",
  "• _cancelar_: descartar lo que estemos armando",
  "",
  "Empresas:",
  "• _mi empresa_: ver los datos fiscales de la empresa activa",
  "• _empresas_: cambiar de empresa · _nueva empresa_: registrar otra",
  "• _cambiar logo_: cambiar el logo del PDF",
].join("\n");

function normalizarTexto(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

/** "nueva venta de...", "facturale...", "haceme una factura...": arranca una venta nueva. */
function pareceNuevaVenta(t: string): boolean {
  return /^(nueva venta|nuevo|nueva factura|otra venta|factur|haceme|hace una factura|emiti|vend[ií])/.test(t);
}

/**
 * Enruta cada mensaje de WhatsApp:
 *  1. Comandos globales (cancelar, ayuda, empresas, logo...).
 *  2. Botones (cada uno lleva el id del paso vigente: los viejos se descartan).
 *  3. Si el número no tiene empresa: configuración inicial (registro).
 *  4. Si tiene: venta (VentaFlow) o anulación, siempre dentro de la empresa activa.
 */
export class WhatsAppBotService {
  private wa: WhatsAppClient;
  private porTelefono = new KeyedMutex();
  private registro: RegistroEmpresaFlow;
  private venta: VentaFlow;

  constructor(config: WhatsAppBotConfig = loadWhatsAppConfig(), client?: WhatsAppClient) {
    this.wa = client ?? new WhatsAppClient(config);
    this.registro = new RegistroEmpresaFlow(this.wa);
    this.venta = new VentaFlow(this.wa);
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
    const conf = await ConfiguracionRepository.obtener();
    const sesion = await SessionStore.get(msg.from, conf.sesionTtlMinutos);
    const texto = (msg.text ?? "").trim();
    const t = normalizarTexto(texto);
    const enRegistro = sesion.estado === "REGISTRO_EMPRESA";

    // 1. Comandos globales
    if (!msg.buttonId) {
      if (/^(cancelar|cancela|cancelalo|salir)$/.test(t)) return this.cancelar(sesion);
      if (/^(nueva empresa|registrar empresa|registrar una empresa|alta empresa|alta de empresa|agregar empresa)$/.test(t)) {
        await this.registro.descartar(sesion);
        return this.registro.iniciar(sesion);
      }
      if (/^(ayuda|help|menu)$/.test(t)) {
        if (enRegistro) return this.registro.preguntar(sesion);
        await this.wa.sendText(msg.from, AYUDA);
        return;
      }
      // Durante el alta, una respuesta como "logo" o "empresa" es un dato, no un comando.
      if (!enRegistro) {
        if (/^(empresas|mis empresas|cambiar empresa|cambiar de empresa)$/.test(t)) return this.listarEmpresas(sesion);
        if (/^(empresa|mi empresa|datos empresa|datos de la empresa|datos de mi empresa)$/.test(t)) return this.mostrarEmpresa(sesion);
        if (/^(cambiar logo|subir logo|logo)$/.test(t)) return this.pedirLogo(sesion);
      }
    }

    // 2. Botones
    if (msg.buttonId) return this.manejarBoton(sesion, msg.buttonId);

    // 3. Configuración de empresa
    if (enRegistro) return this.registro.manejarMensaje(sesion, { texto, mediaId: msg.mediaId, mimeType: msg.mimeType });
    if (sesion.estado === "ESPERANDO_LOGO") return this.recibirLogoEmpresa(sesion, msg);

    const empresa = await this.empresaPara(sesion);
    if (!empresa) return;

    // 4. Facturación dentro de la empresa activa
    return conEmpresa(empresa, () => this.facturacion(sesion, msg, texto, t));
  }

  private async cancelar(sesion: SesionBot): Promise<void> {
    const enRegistro = sesion.estado === "REGISTRO_EMPRESA";
    await this.registro.descartar(sesion);
    await SessionStore.clear(sesion.telefono);
    await this.wa.sendText(
      sesion.telefono,
      enRegistro
        ? "❌ Configuración cancelada. No se guardó nada. Cuando quieras retomarla, mandame cualquier mensaje."
        : "❌ Listo, cancelado. No se emitió nada."
    );
  }

  // ---------------------------------------------------------------------------
  // Facturación
  // ---------------------------------------------------------------------------

  private async facturacion(sesion: SesionBot, msg: MensajeEntrante, texto: string, t: string): Promise<void> {
    if (/^(ultimas|ultimas facturas|historial)$/.test(t)) return this.enviarUltimas(msg.from);

    // Venta en curso: el texto es la respuesta al dato que se pidió.
    if (sesion.estado === "VENTA" && sesion.venta && !msg.mediaId && !pareceNuevaVenta(t)) {
      return this.venta.responder(sesion, texto);
    }

    if (!texto && !msg.mediaId) {
      await this.wa.sendText(msg.from, "Por ahora entiendo texto, audios, imágenes y PDFs. Escribí _ayuda_ para ver ejemplos.");
      return;
    }

    // Mensaje nuevo (o un audio / foto): se interpreta con IA (o el parser sin IA).
    let media: MediaAdjunta | undefined;
    if (msg.mediaId) media = await this.wa.downloadMedia(msg.mediaId);
    const extraccion = await AiExtractorService.extraer(texto, media);

    if (extraccion.accion === "CANCELAR") return this.cancelar(sesion);

    if (extraccion.accion === "ANULAR") {
      const citada = msg.contextMessageId ? await SessionStore.facturaPorMensaje(msg.contextMessageId) : null;
      return this.iniciarAnulacion(sesion, extraccion, citada);
    }

    if (!this.aportaDatos(extraccion)) {
      if (sesion.estado === "VENTA" && sesion.venta) return this.venta.preguntar(sesion);
      await this.wa.sendText(msg.from, AYUDA);
      return;
    }

    // Un audio/foto en medio de una venta completa los datos que falten; cualquier otro caso arranca una venta nueva.
    if (sesion.estado === "VENTA" && sesion.venta && media && !pareceNuevaVenta(t)) {
      this.venta.aplicarExtraccion(sesion.venta.borrador, extraccion);
      return this.venta.avanzar(sesion);
    }
    return this.venta.iniciar(sesion, extraccion);
  }

  private aportaDatos(e: ExtraccionMensaje): boolean {
    return Boolean(e.montoTotal || e.receptorDocumento || e.conceptoDescripcion || e.consumidorFinal);
  }

  private async manejarBoton(sesion: SesionBot, buttonId: string): Promise<void> {
    const [accion, borradorId, ...resto] = buttonId.split(":");
    const valor = resto.join(":");

    if (!borradorId || borradorId !== sesion.borradorId) {
      await this.wa.sendText(
        sesion.telefono,
        "Ese botón ya no está vigente (la operación se completó, se canceló o expiró). Mandame un mensaje nuevo para empezar."
      );
      return;
    }

    switch (accion) {
      case "reg":
        return this.registro.boton(sesion, valor);
      case "emp":
        return this.elegirEmpresa(sesion, Number(valor));
      case "logo_quitar":
        return this.quitarLogo(sesion);
      case "cancelar":
      case "anular_no":
        return this.cancelar(sesion);
    }

    const empresa = await this.empresaPara(sesion);
    if (!empresa) return;
    return conEmpresa(empresa, async () => {
      if (accion === "venta") return this.venta.boton(sesion, valor);
      if (accion === "anular_si") return this.emitirAnulacion(sesion);
    });
  }

  // ---------------------------------------------------------------------------
  // Anulación (Nota de Crédito)
  // ---------------------------------------------------------------------------

  private async buscarFactura(referencia: string | null, facturaCitadaId: string | null): Promise<FacturaRegistro | null> {
    if (facturaCitadaId) {
      const f = await InvoiceHistoryStorage.getById(facturaCitadaId);
      if (f) return f;
    }
    if (!referencia) return null;
    const ref = referencia.trim();
    const conGuion = ref.match(/^(\d{1,5})-(\d{1,8})$/);
    if (conGuion) return InvoiceHistoryStorage.getById(`${conGuion[1].padStart(5, "0")}-${conGuion[2].padStart(8, "0")}`);
    return InvoiceHistoryStorage.getById(ref.replace(/\D/g, ""));
  }

  private async iniciarAnulacion(sesion: SesionBot, e: ExtraccionMensaje, facturaCitadaId: string | null): Promise<void> {
    const factura = await this.buscarFactura(e.comprobanteReferencia, facturaCitadaId);
    if (!factura) {
      await this.wa.sendText(
        sesion.telefono,
        "¿Cuál querés anular? Citá el PDF de la factura que te mandé y escribí _anulala_, o decime su número (ej: _anulá la 00001-00000101_)."
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

    sesion.estado = "ANULACION";
    sesion.venta = undefined;
    sesion.anulacionFacturaId = factura.id;
    sesion.borradorId = nuevoBorradorId();
    await SessionStore.save(sesion);

    const doc = factura.receptorDocTipo === "CUIT" ? ` (CUIT ${formatearCuit(factura.receptorDocNro)})` : "";
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
    if (sesion.estado !== "ANULACION" || !facturaId) {
      await this.wa.sendText(sesion.telefono, "No hay ninguna anulación pendiente.");
      return;
    }
    await SessionStore.clear(sesion.telefono);

    const original = await InvoiceHistoryStorage.getById(facturaId);
    if (!original) {
      await this.wa.sendText(sesion.telefono, "No encontré la factura original en el historial.");
      return;
    }
    const existente = await notaCreditoExistente(original);
    if (existente) {
      await this.wa.sendText(sesion.telefono, `Esa factura ya fue anulada con la ${existente}.`);
      return;
    }

    await this.wa.sendText(sesion.telefono, "⏳ Emitiendo Nota de Crédito en ARCA...");
    try {
      const resultado = await ArcaBillingService.emitirComprobante(armarNotaCredito(original));
      if (!resultado.exito || !resultado.cae) {
        await this.wa.sendText(sesion.telefono, describirErrorIncierto(new Error("ARCA no devolvió CAE para la Nota de Crédito.")));
        return;
      }
      await enviarComprobante(this.wa, sesion.telefono, resultado);
    } catch (error: any) {
      await this.wa.sendText(sesion.telefono, esRechazoSeguro(error) ? describirRechazo(error) : describirErrorIncierto(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Empresas
  // ---------------------------------------------------------------------------

  /**
   * Empresa activa del teléfono. Si todavía no tiene ninguna, arranca la configuración
   * inicial (el primer mensaje de un número nuevo, sea cual sea, cae acá).
   */
  private async empresaPara(sesion: SesionBot): Promise<Empresa | null> {
    const empresa = await EmpresaRepository.activaDe(sesion.telefono);
    if (empresa) return empresa;

    const propias = await EmpresaRepository.listarPorTelefono(sesion.telefono);
    if (propias.length === 0) {
      await this.registro.iniciar(sesion, true);
    } else {
      await this.listarEmpresas(sesion, "Tenés varias empresas. ¿Con cuál querés trabajar?");
    }
    return null;
  }

  private async listarEmpresas(sesion: SesionBot, titulo?: string): Promise<void> {
    const propias = await EmpresaRepository.listarPorTelefono(sesion.telefono);
    if (propias.length === 0) {
      await this.registro.iniciar(sesion, true);
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
    // Cambiar de empresa descarta cualquier venta a medio armar (era de la otra).
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
        `• Ingresos Brutos: ${e.ingresosBrutos ?? "-"}`,
        `• Inicio de actividades: ${inicio ?? "-"}`,
        `• Punto de venta: ${e.puntoVenta}`,
        e.email ? `• Email: ${e.email}` : null,
        `• Logo: ${e.logoPath ? "cargado" : "sin logo (escribí _cambiar logo_)"}`,
        `• Conexión ARCA: ${e.certModo === "PROPIO" ? "certificado propio" : "delegación"} · ${e.produccion ? "producción" : "homologación"}`,
      ]
        .filter((l) => l !== null)
        .join("\n")
    );
  }

  private async pedirLogo(sesion: SesionBot): Promise<void> {
    const e = await this.empresaPara(sesion);
    if (!e) return;
    sesion.estado = "ESPERANDO_LOGO";
    sesion.venta = undefined;
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
}

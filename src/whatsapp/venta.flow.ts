import { DocTipo } from "../constants/arca.constants.js";
import { ConfiguracionRepository } from "../config/configuracion.repository.js";
import { empresaActual } from "../empresas/empresa.context.js";
import { ArcaBillingService } from "../services/arca-billing.service.js";
import type { ExtraccionMensaje } from "./ai-extractor.service.js";
import { AiExtractorService } from "./ai-extractor.service.js";
import {
  describirErrorIncierto,
  describirRechazo,
  enviarComprobante,
  esRechazoSeguro,
} from "./comprobante.sender.js";
import {
  armarInputEmision,
  armarResumen,
  clasificarDocumento,
  determinarComprobante,
  formatearCuit,
  formatearDni,
  formatearPesos,
  inferirTipoConcepto,
  limpiarConcepto,
  NOMBRE_CONDICION_RECEPTOR,
  requiereDomicilio,
  resolverVenta,
  siguientePasoVenta,
  totalVenta,
  type BorradorVenta,
  type CondicionReceptor,
  type ContextoEmisor,
  type TipoCliente,
} from "./fiscal-engine.js";
import { alertaTopeMonotributo } from "./invoice-stats.js";
import { FceService } from "./fce.service.js";
import { EmpresaRepository } from "../empresas/empresa.repository.js";
import { validarCbu } from "../utils/validation.utils.js";
import { PadronService } from "./padron.service.js";
import { nuevoBorradorId, SessionStore, type SesionBot } from "./session.store.js";
import type { WhatsAppClient } from "./whatsapp.client.js";

/**
 * Flujo de una venta, siempre en el mismo orden:
 *
 *   monto → descripción → ¿a quién? (consumidor final / DNI / CUIT-CUIL) → documento
 *   → padrón de ARCA (decide CUIT o CUIL y la condición IVA) → tipo de factura
 *   → datos que exige esa factura (nombre, domicilio) → si el cliente está obligado a
 *   recibir Factura de Crédito MiPyME: CBU y vencimiento del pago → resumen → emitir.
 *
 * Cada paso valida su respuesta antes de avanzar. Los datos que ya vinieron en el primer
 * mensaje ("nueva venta de papel por 12000") no se vuelven a preguntar.
 */

type ClienteWa = Pick<WhatsAppClient, "sendText" | "sendButtons" | "sendList" | "sendDocument">;

const CONDICIONES: Array<{ code: CondicionReceptor; title: string; description: string }> = [
  { code: "RESPONSABLE_INSCRIPTO", title: "Resp. Inscripto", description: "Inscripto en IVA" },
  { code: "MONOTRIBUTO", title: "Monotributista", description: "Adherido al Monotributo" },
  { code: "EXENTO", title: "IVA Exento", description: "Fundación, mutual, estado, etc." },
  { code: "CONSUMIDOR_FINAL", title: "Consumidor Final", description: "Es un CUIL, sin impuestos activos" },
];

export function parsearCondicionReceptor(texto: string): CondicionReceptor | null {
  const t = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/inscript|^ri$|responsable/.test(t)) return "RESPONSABLE_INSCRIPTO";
  if (/monotrib/.test(t)) return "MONOTRIBUTO";
  if (/exent/.test(t)) return "EXENTO";
  if (/consumidor|final|cuil/.test(t)) return "CONSUMIDOR_FINAL";
  return null;
}

function esSaltar(t: string): boolean {
  return /^(saltar|omitir|no|no se|no sé|sin dato|sin datos|-)$/i.test(t.trim());
}

function limpiarTexto(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export class VentaFlow {
  constructor(private wa: ClienteWa) {}

  /** Datos del emisor (empresa activa) y reglas vigentes. */
  private async contexto(): Promise<ContextoEmisor> {
    const e = empresaActual();
    if (!e) throw new Error("No hay empresa activa.");
    const conf = await ConfiguracionRepository.obtener();
    return {
      cuit: e.cuit,
      condicion: e.condicionIva,
      conceptoDefault: e.conceptoDefault,
      consumidorFinalTope: conf.consumidorFinalTope,
      cbu: e.cbu,
    };
  }

  // ------------------------------------------------------------------ entrada

  /** Arranca una venta con lo que se entendió del primer mensaje. */
  public async iniciar(sesion: SesionBot, e: ExtraccionMensaje): Promise<void> {
    const borrador: BorradorVenta = {};
    this.aplicarExtraccion(borrador, e);
    sesion.estado = "VENTA";
    sesion.venta = { paso: "monto", borrador };
    sesion.anulacionFacturaId = undefined;
    return this.avanzar(sesion);
  }

  /** Mezcla datos extraídos por la IA (o el parser) en el borrador. */
  public aplicarExtraccion(b: BorradorVenta, e: ExtraccionMensaje): void {
    if (e.montoTotal) b.montoTotal = e.montoTotal;
    if (e.ivaIncluido !== null) b.ivaIncluido = e.ivaIncluido;
    if (e.alicuotaIva !== null) b.alicuotaIva = e.alicuotaIva;
    if (e.conceptoDescripcion) {
      b.descripcion = limpiarConcepto(e.conceptoDescripcion);
      b.tipoConcepto = e.tipoConcepto ?? inferirTipoConcepto(b.descripcion) ?? undefined;
    }
    if (e.receptorDocumento) {
      const c = clasificarDocumento(e.receptorDocumento);
      if (c?.valido) this.fijarDocumento(b, c.tipo, c.digitos);
    } else if (e.consumidorFinal) {
      b.tipoCliente = "CONSUMIDOR_FINAL";
    }
    if (e.receptorNombre && b.tipoCliente && b.tipoCliente !== "CONSUMIDOR_FINAL") b.nombre = limpiarTexto(e.receptorNombre);
  }

  /** Respuesta de texto al dato que se pidió. */
  public async responder(sesion: SesionBot, textoCrudo: string): Promise<void> {
    const venta = sesion.venta!;
    const b = venta.borrador;
    const texto = limpiarTexto(textoCrudo);
    if (!texto) return this.preguntar(sesion);

    if (venta.corrigiendo) return this.preguntar(sesion);

    switch (venta.paso) {
      case "monto": {
        const p = AiExtractorService.extraerSinIa(texto);
        if (!p.montoTotal) return this.reintentar(sesion, "No entendí el monto. Escribilo con números (ej: _12.000_ o _12.000 más IVA_).");
        b.montoTotal = p.montoTotal;
        if (p.ivaIncluido !== null) b.ivaIncluido = p.ivaIncluido;
        break;
      }

      case "descripcion":
        if (texto.length < 2 || texto.length > 200) return this.reintentar(sesion, "Contame en pocas palabras qué vendiste (ej: _resmas de papel A4_).");
        b.descripcion = limpiarConcepto(texto);
        b.tipoConcepto = inferirTipoConcepto(b.descripcion) ?? undefined;
        break;

      case "tipo_cliente": {
        const t = texto.toLowerCase();
        const doc = clasificarDocumento(texto);
        if (doc) {
          if (!doc.valido) return this.reintentar(sesion, "Ese CUIT/CUIL no es válido (revisá el dígito verificador).");
          this.fijarDocumento(b, doc.tipo, doc.digitos);
        } else if (/consumidor|final|^cf$|sin datos/.test(t)) {
          b.tipoCliente = "CONSUMIDOR_FINAL";
        } else if (/\bdni\b/.test(t)) {
          b.tipoCliente = "DNI";
        } else if (/cuit|cuil/.test(t)) {
          b.tipoCliente = "CUIT";
        } else {
          const cond = parsearCondicionReceptor(t);
          if (!cond || cond === "CONSUMIDOR_FINAL") return this.preguntar(sesion);
          // "es responsable inscripto": hace falta su CUIT; la condición se confirma con el padrón.
          b.tipoCliente = "CUIT";
          b.condicionDeclarada = cond;
        }
        break;
      }

      case "documento": {
        const doc = clasificarDocumento(texto);
        if (!doc) {
          return this.reintentar(
            sesion,
            b.tipoCliente === "DNI" ? "El DNI tiene 7 u 8 dígitos (ej: _30123456_)." : "El CUIT/CUIL tiene 11 dígitos (ej: _20-12345678-9_)."
          );
        }
        if (!doc.valido) return this.reintentar(sesion, `El ${doc.tipo === "CUIT" ? "CUIT/CUIL" : "DNI"} *${texto}* no es válido. Revisá los dígitos.`);
        this.fijarDocumento(b, doc.tipo, doc.digitos);
        break;
      }

      case "elegir_cuit_o_dni":
        if (/cuit/i.test(texto)) return this.boton(sesion, "usar_cuit");
        if (/dni|consumidor/i.test(texto)) return this.boton(sesion, "usar_dni");
        return this.preguntar(sesion);

      case "condicion": {
        const cond = parsearCondicionReceptor(texto);
        if (!cond) return this.preguntar(sesion);
        await this.fijarCondicion(sesion, cond);
        break;
      }

      case "nombre": {
        if (esSaltar(texto)) {
          if (b.docTipo === DocTipo.CUIT) return this.reintentar(sesion, "Para facturar a un CUIT necesito la razón social.");
          b.nombre = null;
          break;
        }
        if (texto.length < 2 || texto.length > 150) return this.reintentar(sesion, "El nombre tiene que tener entre 2 y 150 caracteres.");
        b.nombre = texto;
        break;
      }

      case "domicilio": {
        const letra = determinarComprobante((await this.contexto()).condicion, b.condicion ?? "CONSUMIDOR_FINAL").letra;
        if (esSaltar(texto)) {
          if (letra === "A") return this.reintentar(sesion, "La Factura A exige el domicilio del cliente.");
          b.domicilio = null;
          break;
        }
        if (texto.length < 5 || texto.length > 255) return this.reintentar(sesion, "Pasame el domicilio completo: calle, número y localidad.");
        b.domicilio = texto;
        break;
      }

      case "cbu": {
        const cbu = texto.replace(/\D/g, "");
        if (!validarCbu(cbu)) return this.reintentar(sesion, "Ese CBU no es válido: son 22 dígitos y se controlan los dígitos verificadores.");
        const empresa = empresaActual()!;
        await EmpresaRepository.actualizarCbu(empresa.id, cbu);
        empresa.cbu = cbu; // la empresa del contexto queda actualizada para esta venta
        await this.wa.sendText(sesion.telefono, "🏦 CBU guardado en los datos de la empresa: no te lo vuelvo a pedir.");
        break;
      }

      case "vencimiento_pago": {
        const dias = this.parsearVencimiento(texto);
        if (!dias) return this.reintentar(sesion, "Decime en cuántos días vence el pago (ej: _30_) o la fecha (_dd/mm/aaaa_).");
        b.vencimientoDias = dias;
        break;
      }

      case "confirmar":
        if (/^(si|sí|emitir|emitila|dale|ok|confirmar)$/i.test(texto)) return this.emitir(sesion);
        return this.preguntar(sesion);
    }

    return this.avanzar(sesion);
  }

  /** Botones y listas: `valor` es lo que va después de `venta:<borradorId>:`. */
  public async boton(sesion: SesionBot, valor: string): Promise<void> {
    const venta = sesion.venta;
    if (!venta) return;
    const b = venta.borrador;

    if (valor.startsWith("cli_")) {
      const tipo = valor.slice(4) as TipoCliente;
      if (!["CONSUMIDOR_FINAL", "DNI", "CUIT"].includes(tipo)) return;
      b.tipoCliente = tipo;
    } else if (valor.startsWith("cond_")) {
      const cond = valor.slice(5) as CondicionReceptor;
      if (!CONDICIONES.some((c) => c.code === cond)) return;
      await this.fijarCondicion(sesion, cond);
    } else if (valor === "usar_cuit" && b.sugerenciaCuit) {
      const s = b.sugerenciaCuit;
      b.tipoCliente = "CUIT";
      b.documento = s.cuit;
      b.docTipo = DocTipo.CUIT;
      b.condicion = s.condicion;
      b.nombre = s.nombre ?? b.nombre;
      b.domicilio = s.domicilio ?? b.domicilio;
      b.padronConsultadoPara = s.cuit;
      b.sugerenciaCuit = undefined;
      await this.anunciarFactura(sesion);
    } else if (valor === "usar_dni" && b.sugerenciaCuit) {
      b.nombre ??= b.sugerenciaCuit.nombre;
      b.sugerenciaCuit = undefined;
    } else if (valor === "saltar") {
      if (venta.paso === "nombre" && b.docTipo !== DocTipo.CUIT) b.nombre = null;
      if (venta.paso === "domicilio") b.domicilio = null;
    } else if (valor.startsWith("vto_")) {
      const dias = Number(valor.slice(4));
      if (Number.isInteger(dias) && dias > 0 && dias <= 365) b.vencimientoDias = dias;
    } else if (valor === "emitir") {
      return this.emitir(sesion);
    } else if (valor === "corregir") {
      venta.corrigiendo = true;
      return this.preguntar(sesion);
    } else if (valor.startsWith("fix_")) {
      venta.corrigiendo = false;
      this.limpiarCampo(b, valor.slice(4));
    }

    return this.avanzar(sesion);
  }

  // ------------------------------------------------------------------ lógica

  private fijarDocumento(b: BorradorVenta, tipo: "DNI" | "CUIT", digitos: string): void {
    if (b.documento === digitos && b.tipoCliente === tipo) return;
    b.tipoCliente = tipo;
    b.documento = digitos;
    b.docTipo = tipo === "DNI" ? DocTipo.DNI : undefined;
    b.condicion = tipo === "DNI" ? "CONSUMIDOR_FINAL" : undefined;
    b.nombre = undefined;
    b.domicilio = undefined;
    b.padronConsultadoPara = undefined;
    b.sugerenciaCuit = undefined;
    b.fce = undefined;
    b.vencimientoDias = undefined;
  }

  /** Condición elegida a mano (padrón no disponible): define si va como CUIT (80) o CUIL (86). */
  private async fijarCondicion(sesion: SesionBot, cond: CondicionReceptor): Promise<void> {
    const b = sesion.venta!.borrador;
    b.condicion = cond;
    b.docTipo = cond === "CONSUMIDOR_FINAL" ? DocTipo.CUIL : DocTipo.CUIT;
    await this.anunciarFactura(sesion);
  }

  /** "30", "30 días" o "21/11/2026" -> días desde hoy (1 a 365). */
  private parsearVencimiento(texto: string): number | null {
    const fecha = texto.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (fecha) {
      const destino = new Date(Number(fecha[3]), Number(fecha[2]) - 1, Number(fecha[1]));
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);
      const dias = Math.round((destino.getTime() - hoy.getTime()) / (24 * 3600_000));
      return dias >= 1 && dias <= 365 ? dias : null;
    }
    const n = Number(texto.match(/^(\d{1,3})\s*(d[ií]as?)?$/i)?.[1]);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
  }

  private limpiarCampo(b: BorradorVenta, campo: string): void {
    switch (campo) {
      case "monto":
        b.montoTotal = undefined;
        b.ivaIncluido = undefined;
        break;
      case "descripcion":
        b.descripcion = undefined;
        b.tipoConcepto = undefined;
        break;
      case "cliente":
        for (const k of ["tipoCliente", "documento", "docTipo", "condicion", "condicionDeclarada", "nombre", "domicilio", "padronConsultadoPara", "sugerenciaCuit", "fce", "vencimientoDias"] as const) {
          delete b[k];
        }
        break;
      case "nombre":
        b.nombre = undefined;
        break;
      case "domicilio":
        b.domicilio = undefined;
        break;
      case "vencimiento":
        b.vencimientoDias = undefined;
        break;
    }
  }

  /** Con el documento cargado, consulta el padrón una sola vez por documento. */
  private async consultarPadron(sesion: SesionBot): Promise<void> {
    const b = sesion.venta!.borrador;
    if (!b.documento || b.padronConsultadoPara === b.documento) return;
    b.padronConsultadoPara = b.documento;
    const tel = sesion.telefono;

    if (b.tipoCliente === "DNI") {
      // Truco: un DNI puede tener un CUIT con impuestos activos (se olvidó de pasar el CUIT).
      const encontrado = await PadronService.buscarCuitPorDni(b.documento);
      if (encontrado && "cuit" in encontrado) {
        b.sugerenciaCuit = {
          cuit: encontrado.cuit,
          nombre: encontrado.resultado.razonSocial,
          domicilio: encontrado.resultado.domicilio,
          condicion: encontrado.resultado.condicion,
        };
      } else if (encontrado && "soloNombre" in encontrado) {
        b.nombre ??= encontrado.soloNombre;
      }
      return;
    }

    await this.wa.sendText(tel, `🔎 Consultando el CUIT ${formatearCuit(b.documento)} en el padrón de ARCA...`);
    const r = await PadronService.consultar(b.documento);

    if (r.estado === "OK") {
      b.docTipo = DocTipo.CUIT;
      b.condicion = r.condicion;
      if (r.razonSocial) b.nombre ??= r.razonSocial;
      if (r.domicilio) b.domicilio ??= r.domicilio;
      await this.wa.sendText(tel, `✅ *${r.razonSocial ?? "Contribuyente"}* — ${NOMBRE_CONDICION_RECEPTOR[r.condicion]}.`);
      await this.anunciarFactura(sesion);
    } else if (r.estado === "SIN_ALTA") {
      // Sin impuestos activos: es un CUIL de un consumidor final.
      b.docTipo = DocTipo.CUIL;
      b.condicion = "CONSUMIDOR_FINAL";
      if (r.razonSocial) b.nombre ??= r.razonSocial;
      await this.wa.sendText(
        tel,
        `ℹ️ ${r.razonSocial ? `*${r.razonSocial}*: ` : ""}ese número no tiene impuestos activos en ARCA, así que es un *CUIL* de consumidor final.`
      );
      await this.anunciarFactura(sesion);
    } else if (b.condicionDeclarada) {
      await this.fijarCondicion(sesion, b.condicionDeclarada);
    }
    // NO_DISPONIBLE sin condición declarada: el paso "condicion" se la pregunta al usuario.
  }

  /** "Le corresponde Factura A: ..." apenas se conoce la condición del cliente. */
  private async anunciarFactura(sesion: SesionBot): Promise<void> {
    const b = sesion.venta!.borrador;
    const ctx = await this.contexto();
    await this.verificarFce(sesion);
    const total = totalVenta(b, ctx);
    const fce = b.fce?.estado === "OBLIGADO" && b.docTipo === DocTipo.CUIT && total >= (b.fce.montoDesde ?? 0);
    const comp = determinarComprobante(ctx.condicion, b.condicion ?? "CONSUMIDOR_FINAL", fce);
    const titulo = comp.fce ? `Factura de Crédito Electrónica MiPyME ${comp.letra}` : `Factura ${comp.letra}`;
    await this.wa.sendText(sesion.telefono, `🧾 Le corresponde *${titulo}*. ${comp.motivo}`);
  }

  /**
   * Si el cliente es un CUIT, le pregunta a ARCA (wsfecred) si está obligado a recibir
   * Factura de Crédito MiPyME. Una vez por documento.
   */
  private async verificarFce(sesion: SesionBot): Promise<void> {
    const b = sesion.venta!.borrador;
    if (b.docTipo !== DocTipo.CUIT || !b.documento || b.fce?.para === b.documento) return;
    const r = await FceService.consultar(b.documento);
    b.fce = { para: b.documento, estado: r.estado, montoDesde: r.estado === "OBLIGADO" ? r.montoDesde : undefined };
  }

  public async avanzar(sesion: SesionBot): Promise<void> {
    const venta = sesion.venta!;
    const ctx = await this.contexto();
    await this.consultarPadron(sesion);

    let paso = siguientePasoVenta(venta.borrador, ctx);

    // Consumidor final anónimo por encima del tope: hay que identificarlo.
    if (paso === "tipo_cliente" && venta.borrador.tipoCliente === "CONSUMIDOR_FINAL") {
      venta.borrador.tipoCliente = undefined;
      await this.wa.sendText(
        sesion.telefono,
        `⚠️ Desde ${formatearPesos(ctx.consumidorFinalTope)} ARCA exige identificar al comprador: necesito su DNI o CUIT/CUIL.`
      );
    }

    if (paso === "confirmar") {
      const r = resolverVenta(venta.borrador, ctx);
      if ("error" in r) {
        this.limpiarCampo(venta.borrador, "cliente");
        await this.wa.sendText(sesion.telefono, `⚠️ ${r.error}`);
        paso = siguientePasoVenta(venta.borrador, ctx);
      } else {
        venta.factura = r.factura;
      }
    }
    venta.paso = paso;
    return this.preguntar(sesion);
  }

  // ------------------------------------------------------------------ preguntas

  private async reintentar(sesion: SesionBot, motivo: string): Promise<void> {
    await SessionStore.save(sesion);
    await this.wa.sendText(sesion.telefono, `⚠️ ${motivo}`);
  }

  public async preguntar(sesion: SesionBot): Promise<void> {
    const venta = sesion.venta!;
    const b = venta.borrador;
    sesion.borradorId = nuevoBorradorId();
    await SessionStore.save(sesion);

    const tel = sesion.telefono;
    const id = (v: string) => `venta:${sesion.borradorId}:${v}`;
    const cancelar = { id: `cancelar:${sesion.borradorId}`, title: "❌ Cancelar" };
    const anotado = [b.descripcion, b.montoTotal ? `${formatearPesos(b.montoTotal)}${b.ivaIncluido === false ? " + IVA" : ""}` : null]
      .filter(Boolean)
      .join(" – ");
    const encabezado = anotado ? `📝 ${anotado}\n\n` : "";

    if (venta.corrigiendo) {
      const opciones = [
        { id: id("fix_monto"), title: "Monto" },
        { id: id("fix_descripcion"), title: "Qué vendiste" },
        { id: id("fix_cliente"), title: "Cliente / documento" },
      ];
      if (b.tipoCliente && b.tipoCliente !== "CONSUMIDOR_FINAL") opciones.push({ id: id("fix_nombre"), title: "Nombre / razón social" });
      if (requiereDomicilio(b)) opciones.push({ id: id("fix_domicilio"), title: "Domicilio" });
      if (venta.factura?.fce) opciones.push({ id: id("fix_vencimiento"), title: "Vencimiento del pago" });
      await this.wa.sendList(tel, "✏️ ¿Qué dato querés corregir?", "Elegir dato", opciones, "Datos de la venta");
      return;
    }

    switch (venta.paso) {
      case "monto":
        await this.wa.sendText(tel, `${encabezado}¿Por cuánto es la venta? (ej: _12.000_ o _12.000 más IVA_)`);
        return;

      case "descripcion":
        await this.wa.sendText(tel, `${encabezado}¿Qué vendiste? (ej: _resmas de papel A4_)`);
        return;

      case "tipo_cliente": {
        const ctx = await this.contexto();
        const total = b.montoTotal ?? 0;
        const botones = [
          { id: id("cli_DNI"), title: "Con DNI" },
          { id: id("cli_CUIT"), title: "Con CUIT / CUIL" },
        ];
        if (total < ctx.consumidorFinalTope) botones.unshift({ id: id("cli_CONSUMIDOR_FINAL"), title: "Consumidor final" });
        await this.wa.sendButtons(
          tel,
          [
            `${encabezado}¿A quién le facturás?`,
            "",
            "• *Consumidor final*: sin datos del comprador",
            "• *DNI*: persona identificada",
            "• *CUIT / CUIL*: responsable inscripto, monotributista, exento o persona con CUIL",
          ].join("\n"),
          botones
        );
        return;
      }

      case "documento":
        await this.wa.sendText(
          tel,
          b.tipoCliente === "DNI"
            ? "Pasame el *DNI* del cliente (7 u 8 dígitos)."
            : "Pasame el *CUIT o CUIL* del cliente (11 dígitos, ej: _30-71234567-1_). Con eso consulto su condición en ARCA."
        );
        return;

      case "elegir_cuit_o_dni": {
        const s = b.sugerenciaCuit!;
        await this.wa.sendButtons(
          tel,
          `Con el DNI ${formatearDni(b.documento ?? "")} encontré a *${s.nombre ?? "un contribuyente"}* (CUIT ${formatearCuit(s.cuit)} – ${NOMBRE_CONDICION_RECEPTOR[s.condicion]}).\n\n¿Le facturamos a su CUIT o como consumidor final con DNI?`,
          [
            { id: id("usar_cuit"), title: "A su CUIT" },
            { id: id("usar_dni"), title: "Con DNI" },
          ]
        );
        return;
      }

      case "condicion": {
        const ctx = await this.contexto();
        const regla =
          ctx.condicion === "RESPONSABLE_INSCRIPTO"
            ? "Define la factura: Resp. Inscripto o Monotributista → *A*; Exento o Consumidor Final → *B*."
            : "Como sos monotributista la factura es *C* igual, pero ARCA exige informar la condición del cliente.";
        await this.wa.sendList(
          tel,
          `No pude consultar el padrón de ARCA. ¿Qué condición frente al IVA tiene el CUIT ${formatearCuit(b.documento ?? "")}?\n\n${regla}`,
          "Elegir condición",
          CONDICIONES.map((c) => ({ id: id(`cond_${c.code}`), title: c.title, description: c.description })),
          "Condición frente al IVA"
        );
        return;
      }

      case "nombre":
        if (b.docTipo === DocTipo.CUIT) {
          await this.wa.sendText(tel, "¿Cuál es la *razón social* del cliente? (va en la factura)");
        } else {
          await this.wa.sendButtons(tel, "¿*Nombre y apellido* del cliente?", [{ id: id("saltar"), title: "Saltar" }]);
        }
        return;

      case "domicilio": {
        const letra = determinarComprobante((await this.contexto()).condicion, b.condicion ?? "CONSUMIDOR_FINAL").letra;
        if (letra === "A") {
          await this.wa.sendText(tel, "¿Cuál es el *domicilio comercial* del cliente? (la Factura A lo exige: calle, número y localidad)");
        } else {
          await this.wa.sendButtons(tel, "¿*Domicilio* del cliente? (calle, número y localidad)", [{ id: id("saltar"), title: "Saltar" }]);
        }
        return;
      }

      case "cbu":
        await this.wa.sendText(
          tel,
          "🏦 Para la Factura de Crédito MiPyME necesito el *CBU de la empresa* (22 dígitos), donde el cliente va a pagar. Lo guardo para las próximas."
        );
        return;

      case "vencimiento_pago":
        await this.wa.sendButtons(
          tel,
          "📅 ¿En cuántos días *vence el pago*? (la Factura de Crédito lo exige). También podés escribir la fecha (_dd/mm/aaaa_).",
          [
            { id: id("vto_30"), title: "30 días" },
            { id: id("vto_60"), title: "60 días" },
            { id: id("vto_90"), title: "90 días" },
          ]
        );
        return;

      case "confirmar":
        await this.wa.sendButtons(
          tel,
          armarResumen(venta.factura!),
          [{ id: id("emitir"), title: "✅ Emitir" }, { id: id("corregir"), title: "✏️ Corregir" }, cancelar],
          "Una factura emitida no se puede borrar"
        );
        return;
    }
  }

  // ------------------------------------------------------------------ emisión

  private async emitir(sesion: SesionBot): Promise<void> {
    const venta = sesion.venta;
    if (sesion.estado !== "VENTA" || venta?.paso !== "confirmar" || !venta.factura) {
      await this.wa.sendText(sesion.telefono, "No hay ninguna factura lista para emitir.");
      return;
    }
    const factura = venta.factura;

    // Se invalida ANTES de llamar a ARCA: un segundo toque de "Emitir" no emite dos veces.
    sesion.estado = "IDLE";
    sesion.borradorId = undefined;
    await SessionStore.save(sesion);
    await this.wa.sendText(sesion.telefono, "⏳ Emitiendo en ARCA...");

    let resultado;
    try {
      resultado = await ArcaBillingService.emitirComprobante(armarInputEmision(factura));
    } catch (error: any) {
      if (esRechazoSeguro(error)) {
        // No se emitió nada: se vuelve al resumen para corregir.
        sesion.estado = "VENTA";
        venta.corrigiendo = true;
        await this.wa.sendText(sesion.telefono, `${describirRechazo(error)}\n\nNo se emitió nada.`);
        return this.preguntar(sesion);
      }
      await SessionStore.clear(sesion.telefono);
      await this.wa.sendText(sesion.telefono, describirErrorIncierto(error));
      return;
    }

    await SessionStore.clear(sesion.telefono);
    if (!resultado.exito || !resultado.cae) {
      await this.wa.sendText(sesion.telefono, describirErrorIncierto(new Error("ARCA no devolvió CAE.")));
      return;
    }
    await enviarComprobante(this.wa, sesion.telefono, resultado);

    const empresa = empresaActual();
    const alerta = empresa ? await alertaTopeMonotributo(empresa) : null;
    if (alerta) await this.wa.sendText(sesion.telefono, alerta);
  }
}

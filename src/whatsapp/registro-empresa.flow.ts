import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { CbteTipo, CondicionIVAReceptor } from "../constants/arca.constants.js";
import { conEmpresa } from "../empresas/empresa.context.js";
import { EmpresaRepository } from "../empresas/empresa.repository.js";
import { NOMBRE_CONDICION_EMISOR, type CondicionIvaEmisor, type Empresa } from "../empresas/empresa.types.js";
import { ArcaBillingService } from "../services/arca-billing.service.js";
import { cifrar, descifrar, validarParCertificado } from "../utils/crypto.utils.js";
import { validarCuit } from "../utils/validation.utils.js";
import { formatearCuit } from "./fiscal-engine.js";
import { PadronService } from "./padron.service.js";
import { nuevoBorradorId, SessionStore, type SesionBot } from "./session.store.js";
import type { WhatsAppClient } from "./whatsapp.client.js";

/**
 * Alta de una empresa emisora por WhatsApp, paso a paso.
 *
 * Pide todos los datos fiscales que exige la factura (RG 1415: razón social, domicilio
 * comercial, condición frente al IVA, CUIT, Ingresos Brutos e inicio de actividades),
 * el punto de venta, un logo opcional para el PDF y cómo se va a autenticar ante ARCA.
 *
 * Cada respuesta se valida antes de avanzar. Los campos opcionales se guardan como
 * `null` cuando el usuario los saltea, así se distinguen de los que todavía no se pidieron.
 */

export type PasoRegistro =
  | "cuit"
  | "confirmar_padron"
  | "razon_social"
  | "nombre_fantasia"
  | "domicilio"
  | "condicion_iva"
  | "iibb"
  | "inicio_actividades"
  | "punto_venta"
  | "monotributo_categoria"
  | "email"
  | "logo"
  | "certificado_modo"
  | "certificado_crt"
  | "certificado_key"
  | "elegir_correccion"
  | "confirmar";

export interface DatosRegistro {
  cuit?: number;
  razonSocial?: string;
  nombreFantasia?: string | null;
  domicilioComercial?: string;
  condicionIva?: CondicionIvaEmisor;
  ingresosBrutos?: string;
  inicioActividades?: string; // YYYY-MM-DD
  puntoVenta?: number;
  monotributoCategoria?: string | null;
  email?: string | null;
  logoPath?: string | null;
  certModo?: "SISTEMA" | "PROPIO";
  certPem?: string;
  /** La clave privada viaja cifrada también dentro de la sesión. */
  keyCifrada?: string;
}

export interface BorradorRegistro {
  paso: PasoRegistro;
  datos: DatosRegistro;
  padron?: { razonSocial?: string; domicilio?: string; condicionIva?: CondicionIvaEmisor };
}

export interface EntradaRegistro {
  texto: string;
  mediaId?: string;
  mimeType?: string;
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_CERT_BYTES = 32 * 1024;
const DIR_LOGOS = () => path.resolve(process.cwd(), "data", "logos");

/** Pasos que se cuentan en "Paso X de N" (los de certificado cuentan como uno). */
const PASOS_VISIBLES: PasoRegistro[] = [
  "cuit", "razon_social", "nombre_fantasia", "domicilio", "condicion_iva", "iibb",
  "inicio_actividades", "punto_venta", "monotributo_categoria", "email", "logo", "certificado_modo",
];

const CONDICIONES: Array<{ code: CondicionIvaEmisor; title: string }> = [
  { code: "MONOTRIBUTO", title: "Monotributo" },
  { code: "RESPONSABLE_INSCRIPTO", title: "Resp. Inscripto" },
  { code: "EXENTO", title: "IVA Exento" },
];

const CORREGIBLES: Array<{ id: string; title: string; limpiar: (d: DatosRegistro) => void }> = [
  { id: "razon_social", title: "Razón social", limpiar: (d) => (d.razonSocial = undefined) },
  { id: "nombre_fantasia", title: "Nombre de fantasía", limpiar: (d) => (d.nombreFantasia = undefined) },
  { id: "domicilio", title: "Domicilio comercial", limpiar: (d) => (d.domicilioComercial = undefined) },
  {
    id: "condicion_iva",
    title: "Condición frente al IVA",
    limpiar: (d) => {
      d.condicionIva = undefined;
      d.monotributoCategoria = undefined;
    },
  },
  { id: "iibb", title: "Ingresos Brutos", limpiar: (d) => (d.ingresosBrutos = undefined) },
  { id: "inicio_actividades", title: "Inicio de actividades", limpiar: (d) => (d.inicioActividades = undefined) },
  { id: "punto_venta", title: "Punto de venta", limpiar: (d) => (d.puntoVenta = undefined) },
  { id: "email", title: "Email", limpiar: (d) => (d.email = undefined) },
  { id: "logo", title: "Logo", limpiar: (d) => (d.logoPath = undefined) },
  {
    id: "certificado",
    title: "Certificado ARCA",
    limpiar: (d) => {
      d.certModo = undefined;
      d.certPem = undefined;
      d.keyCifrada = undefined;
    },
  },
];

// ---------------------------------------------------------------------------
// Validaciones puras (exportadas para los tests)
// ---------------------------------------------------------------------------

/** Quita caracteres de control y espacios repetidos. */
export function limpiarTexto(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export function esSaltar(t: string): boolean {
  return /^(saltar|salta|omitir|no|no tengo|ninguno|ninguna|sin|-)$/i.test(t.trim());
}

/** "15/03/2020" o "15-3-2020" -> "2020-03-15". null si no es una fecha válida del pasado. */
export function parsearFechaInicio(texto: string): string | null {
  const m = texto.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!m) return null;
  const [d, mes, a] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const fecha = new Date(Date.UTC(a, mes - 1, d));
  if (fecha.getUTCFullYear() !== a || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== d) return null;
  if (a < 1900 || fecha.getTime() > Date.now()) return null;
  return `${a}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parsearIngresosBrutos(texto: string, cuit?: number): string | null {
  const t = limpiarTexto(texto);
  if (/^igual( al)? cuit$|^el (mismo )?cuit$|^cuit$/i.test(t)) return cuit ? formatearCuit(cuit) : null;
  if (/^exent[oa]$/i.test(t)) return "Exento";
  if (/^(no inscripto|no inscripta)$/i.test(t)) return "No inscripto";
  if (/^[0-9A-Za-z][0-9A-Za-z .\-\/]{2,39}$/.test(t)) return t;
  return null;
}

export function parsearPuntoVenta(texto: string): number | null {
  const t = texto.trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= 99998 ? n : null;
}

export function parsearEmail(texto: string): string | null {
  const t = texto.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/.test(t) ? t : null;
}

export function parsearCondicionEmisor(texto: string): CondicionIvaEmisor | null {
  const t = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/monotrib/.test(t)) return "MONOTRIBUTO";
  if (/inscript|^ri$|responsable/.test(t)) return "RESPONSABLE_INSCRIPTO";
  if (/exent/.test(t)) return "EXENTO";
  return null;
}

/** Detecta PNG / JPG por sus primeros bytes (no se confía en el mime que manda el cliente). */
export function tipoImagen(buf: Buffer): "png" | "jpg" | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  return null;
}

function condicionDesdePadron(code?: number): CondicionIvaEmisor | undefined {
  if (code === CondicionIVAReceptor.RESPONSABLE_INSCRIPTO) return "RESPONSABLE_INSCRIPTO";
  if (code === CondicionIVAReceptor.RESPONSABLE_MONOTRIBUTO || code === CondicionIVAReceptor.MONOTRIBUTISTA_SOCIAL) {
    return "MONOTRIBUTO";
  }
  if (code === CondicionIVAReceptor.IVA_SUJETO_EXENTO) return "EXENTO";
  return undefined;
}

/** Siguiente dato que falta pedir. */
export function siguientePaso(d: DatosRegistro): PasoRegistro {
  if (d.cuit === undefined) return "cuit";
  if (d.razonSocial === undefined) return "razon_social";
  if (d.nombreFantasia === undefined) return "nombre_fantasia";
  if (d.domicilioComercial === undefined) return "domicilio";
  if (d.condicionIva === undefined) return "condicion_iva";
  if (d.ingresosBrutos === undefined) return "iibb";
  if (d.inicioActividades === undefined) return "inicio_actividades";
  if (d.puntoVenta === undefined) return "punto_venta";
  if (d.condicionIva === "MONOTRIBUTO" && d.monotributoCategoria === undefined) return "monotributo_categoria";
  if (d.email === undefined) return "email";
  if (d.logoPath === undefined) return "logo";
  if (d.certModo === undefined) return "certificado_modo";
  if (d.certModo === "PROPIO" && !d.certPem) return "certificado_crt";
  if (d.certModo === "PROPIO" && !d.keyCifrada) return "certificado_key";
  return "confirmar";
}

// ---------------------------------------------------------------------------
// Flujo conversacional
// ---------------------------------------------------------------------------

type ClienteWa = Pick<WhatsAppClient, "sendText" | "sendButtons" | "sendList" | "downloadMedia">;

export class RegistroEmpresaFlow {
  constructor(
    private wa: ClienteWa,
    private opciones: { produccion: boolean; cuitSistema?: number }
  ) {}

  public async iniciar(sesion: SesionBot): Promise<void> {
    sesion.estado = "REGISTRO_EMPRESA";
    sesion.registro = { paso: "cuit", datos: {} };
    sesion.borrador = {};
    sesion.facturaResuelta = undefined;
    await this.wa.sendText(
      sesion.telefono,
      [
        "🏢 *Registro de una empresa nueva*",
        "",
        "Te voy a pedir los datos fiscales que van en la factura. Tarda unos 3 minutos.",
        "Podés escribir _cancelar_ en cualquier momento.",
      ].join("\n")
    );
    await this.preguntar(sesion);
  }

  /** Descarta el registro en curso (y el logo que se haya subido). */
  public async descartar(sesion: SesionBot): Promise<void> {
    const logo = sesion.registro?.datos.logoPath;
    if (logo) await fs.unlink(logo).catch(() => undefined);
    sesion.registro = undefined;
  }

  // -------------------------------------------------------------- entrada

  public async manejarMensaje(sesion: SesionBot, entrada: EntradaRegistro): Promise<void> {
    const reg = sesion.registro;
    if (!reg) return;
    const texto = limpiarTexto(entrada.texto);
    const d = reg.datos;

    // Archivos: solo se aceptan en los pasos que los piden.
    if (entrada.mediaId) {
      if (reg.paso === "logo") return this.recibirLogo(sesion, entrada);
      if (reg.paso === "certificado_crt" || reg.paso === "certificado_key") return this.recibirCertificado(sesion, entrada);
      await this.wa.sendText(sesion.telefono, "Ahora no necesito un archivo. Respondé con texto, por favor.");
      return this.preguntar(sesion);
    }
    if (!texto) return this.preguntar(sesion);

    switch (reg.paso) {
      case "cuit":
        return this.recibirCuit(sesion, texto);

      case "confirmar_padron":
        if (/^(si|sí|ok|dale|correcto|son correctos)$/i.test(texto)) return this.boton(sesion, "padron_ok");
        if (/^(no|a mano|cargar a mano)$/i.test(texto)) return this.boton(sesion, "padron_manual");
        return this.preguntar(sesion);

      case "razon_social":
        if (texto.length < 2 || texto.length > 150) {
          return this.reintentar(sesion, "La razón social tiene que tener entre 2 y 150 caracteres.");
        }
        d.razonSocial = texto;
        break;

      case "nombre_fantasia":
        if (!esSaltar(texto) && texto.length > 150) {
          return this.reintentar(sesion, "El nombre de fantasía puede tener hasta 150 caracteres.");
        }
        d.nombreFantasia = esSaltar(texto) ? null : texto;
        break;

      case "domicilio":
        if (texto.length < 5 || texto.length > 255) {
          return this.reintentar(sesion, "Pasame el domicilio completo: calle, número y localidad (ej: _Av. Corrientes 1234, CABA_).");
        }
        d.domicilioComercial = texto;
        break;

      case "condicion_iva": {
        const c = parsearCondicionEmisor(texto);
        if (!c) return this.reintentar(sesion, "No entendí. Elegí una opción: Monotributo, Responsable Inscripto o Exento.");
        d.condicionIva = c;
        if (c !== "MONOTRIBUTO") d.monotributoCategoria = null;
        break;
      }

      case "iibb": {
        const iibb = parsearIngresosBrutos(texto, d.cuit);
        if (!iibb) {
          return this.reintentar(sesion, "Pasame el número de Ingresos Brutos (ej: _901-123456-7_), _exento_, o tocá _Igual al CUIT_.");
        }
        d.ingresosBrutos = iibb;
        break;
      }

      case "inicio_actividades": {
        const f = parsearFechaInicio(texto);
        if (!f) return this.reintentar(sesion, "Pasame una fecha válida y pasada con el formato _dd/mm/aaaa_ (ej: _15/03/2020_).");
        d.inicioActividades = f;
        break;
      }

      case "punto_venta": {
        const n = parsearPuntoVenta(texto);
        if (n === null) return this.reintentar(sesion, "El punto de venta es un número entre 1 y 99998 (ej: _2_).");
        d.puntoVenta = n;
        break;
      }

      case "monotributo_categoria": {
        if (esSaltar(texto)) {
          d.monotributoCategoria = null;
          break;
        }
        const cat = texto.toUpperCase().replace(/^CATEGOR[IÍ]A\s*/, "");
        if (!/^[A-K]$/.test(cat)) return this.reintentar(sesion, "La categoría es una letra de la A a la K, o tocá _Saltar_.");
        d.monotributoCategoria = cat;
        break;
      }

      case "email": {
        if (esSaltar(texto)) {
          d.email = null;
          break;
        }
        const email = parsearEmail(texto);
        if (!email) return this.reintentar(sesion, "Ese email no parece válido. Probá de nuevo o tocá _Saltar_.");
        d.email = email;
        break;
      }

      case "logo":
        if (esSaltar(texto) || /^sin logo$/i.test(texto)) {
          d.logoPath = null;
          break;
        }
        return this.reintentar(sesion, "Mandame el logo como *imagen* (JPG o PNG), o tocá _Sin logo_.");

      case "certificado_modo":
        if (/delega|sistema/i.test(texto)) return this.boton(sesion, "cert_sistema");
        if (/propio|subir|certificado/i.test(texto)) return this.boton(sesion, "cert_propio");
        break;

      case "certificado_crt":
      case "certificado_key":
        return this.reintentar(sesion, "Mandame el archivo como *documento* (clip 📎 > Documento).");

      case "confirmar":
        if (/^(guardar|si|sí|confirmar|ok)$/i.test(texto)) return this.boton(sesion, "guardar");
        break;

      case "elegir_correccion":
        break;
    }

    reg.paso = siguientePaso(d);
    return this.preguntar(sesion);
  }

  /** Botones y listas. `valor` es lo que viene después de `reg:<borradorId>:`. */
  public async boton(sesion: SesionBot, valor: string): Promise<void> {
    const reg = sesion.registro;
    if (!reg) return;
    const d = reg.datos;

    if (valor === "padron_ok" && reg.padron) {
      d.razonSocial = reg.padron.razonSocial ?? d.razonSocial;
      if (reg.padron.domicilio) d.domicilioComercial = reg.padron.domicilio;
      if (reg.padron.condicionIva) {
        d.condicionIva = reg.padron.condicionIva;
        if (d.condicionIva !== "MONOTRIBUTO") d.monotributoCategoria = null;
      }
    } else if (valor === "padron_manual") {
      reg.padron = undefined;
    } else if (valor.startsWith("cond_")) {
      const c = valor.slice(5) as CondicionIvaEmisor;
      if (!CONDICIONES.some((o) => o.code === c)) return;
      d.condicionIva = c;
      d.monotributoCategoria = c === "MONOTRIBUTO" ? undefined : null;
    } else if (valor === "iibb_cuit") {
      d.ingresosBrutos = d.cuit ? formatearCuit(d.cuit) : undefined;
    } else if (valor === "saltar") {
      if (reg.paso === "nombre_fantasia") d.nombreFantasia = null;
      else if (reg.paso === "monotributo_categoria") d.monotributoCategoria = null;
      else if (reg.paso === "email") d.email = null;
      else if (reg.paso === "logo") d.logoPath = null;
    } else if (valor === "cert_sistema") {
      d.certModo = "SISTEMA";
      d.certPem = undefined;
      d.keyCifrada = undefined;
    } else if (valor === "cert_propio") {
      d.certModo = "PROPIO";
    } else if (valor === "guardar") {
      return this.guardar(sesion);
    } else if (valor === "corregir") {
      reg.paso = "elegir_correccion";
      return this.preguntar(sesion);
    } else if (valor.startsWith("fix_")) {
      const campo = CORREGIBLES.find((c) => c.id === valor.slice(4));
      if (!campo) return;
      if (campo.id === "logo" && d.logoPath) await fs.unlink(d.logoPath).catch(() => undefined);
      campo.limpiar(d);
    }

    reg.paso = siguientePaso(d);
    return this.preguntar(sesion);
  }

  // -------------------------------------------------------------- pasos con lógica propia

  private async recibirCuit(sesion: SesionBot, texto: string): Promise<void> {
    const reg = sesion.registro!;
    const digitos = texto.replace(/\D/g, "");
    if (digitos.length !== 11 || !validarCuit(digitos)) {
      return this.reintentar(sesion, "Ese CUIT no es válido (revisá los 11 dígitos). Ej: _20-12345678-9_.");
    }
    const cuit = Number(digitos);

    const existente = await EmpresaRepository.porCuit(cuit, this.opciones.produccion);
    if (existente) {
      const propia = await EmpresaRepository.tieneAcceso(existente.id, sesion.telefono);
      await this.descartar(sesion);
      sesion.estado = "IDLE";
      await SessionStore.save(sesion);
      await this.wa.sendText(
        sesion.telefono,
        propia
          ? `La empresa con CUIT ${formatearCuit(cuit)} ya está registrada. Escribí _empresas_ para elegirla.`
          : `El CUIT ${formatearCuit(cuit)} ya está registrado por otro usuario. Pedile al administrador de esa empresa que te dé acceso.`
      );
      return;
    }

    reg.datos.cuit = cuit;

    // Se intenta completar con el padrón de ARCA (si el servicio está habilitado para el certificado).
    await this.wa.sendText(sesion.telefono, "🔎 Buscando el CUIT en el padrón de ARCA...");
    const padron = await PadronService.consultar(digitos).catch(() => null);
    if (padron?.razonSocial && padron.fuente === "PADRON") {
      reg.padron = {
        razonSocial: limpiarTexto(padron.razonSocial).slice(0, 150),
        domicilio: padron.domicilio ? limpiarTexto(padron.domicilio).slice(0, 255) : undefined,
        condicionIva: condicionDesdePadron(padron.condicionIva),
      };
      reg.paso = "confirmar_padron";
    } else {
      reg.paso = siguientePaso(reg.datos);
    }
    return this.preguntar(sesion);
  }

  private async recibirLogo(sesion: SesionBot, entrada: EntradaRegistro): Promise<void> {
    const reg = sesion.registro!;
    const guardado = await this.descargarLogo(sesion, entrada, `${reg.datos.cuit ?? "tmp"}`);
    if (!guardado) return;
    if (reg.datos.logoPath) await fs.unlink(reg.datos.logoPath).catch(() => undefined);
    reg.datos.logoPath = guardado;
    await this.wa.sendText(sesion.telefono, "🖼️ Logo recibido.");
    reg.paso = siguientePaso(reg.datos);
    return this.preguntar(sesion);
  }

  /** Descarga, valida (PNG/JPG, ≤ 2 MB) y guarda un logo. Devuelve la ruta o null si no sirve. */
  public async descargarLogo(sesion: SesionBot, entrada: EntradaRegistro, prefijo: string): Promise<string | null> {
    let archivo: { data: Buffer; mimeType: string };
    try {
      archivo = await this.wa.downloadMedia(entrada.mediaId!, { maxBytes: MAX_LOGO_BYTES });
    } catch (err: any) {
      await this.wa.sendText(sesion.telefono, `No pude usar ese archivo: ${err?.message ?? "error al descargarlo"}. Probá con otro (JPG o PNG, hasta 2 MB).`);
      return null;
    }
    const ext = tipoImagen(archivo.data);
    if (!ext) {
      await this.wa.sendText(sesion.telefono, "El logo tiene que ser una imagen JPG o PNG. Probá con otro archivo.");
      return null;
    }
    const dir = DIR_LOGOS();
    await fs.mkdir(dir, { recursive: true });
    const destino = path.join(dir, `${prefijo.replace(/\D/g, "") || "tmp"}-${crypto.randomBytes(4).toString("hex")}.${ext}`);
    await fs.writeFile(destino, archivo.data);
    return destino;
  }

  private async recibirCertificado(sesion: SesionBot, entrada: EntradaRegistro): Promise<void> {
    const reg = sesion.registro!;
    let texto: string;
    try {
      const archivo = await this.wa.downloadMedia(entrada.mediaId!, { maxBytes: MAX_CERT_BYTES });
      texto = archivo.data.toString("utf8");
    } catch (err: any) {
      return this.reintentar(sesion, `No pude leer ese archivo: ${err?.message ?? "error al descargarlo"}.`);
    }

    if (reg.paso === "certificado_crt") {
      if (!/-----BEGIN CERTIFICATE-----/.test(texto)) {
        return this.reintentar(sesion, "Ese archivo no es un certificado (.crt en formato PEM). Mandame el .crt que te dio ARCA.");
      }
      reg.datos.certPem = texto.trim();
    } else {
      if (!/-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(texto)) {
        return this.reintentar(sesion, "Ese archivo no es una clave privada (.key en formato PEM).");
      }
      const v = validarParCertificado(reg.datos.certPem ?? "", texto);
      if (!v.ok) {
        reg.datos.certPem = undefined;
        reg.datos.keyCifrada = undefined;
        reg.paso = "certificado_crt";
        await this.wa.sendText(sesion.telefono, `❌ ${v.error}\n\nEmpecemos de nuevo con el certificado.`);
        return this.preguntar(sesion);
      }
      reg.datos.keyCifrada = cifrar(texto.trim());
      const avisoCuit =
        v.cuitEnCertificado && Number(v.cuitEnCertificado) !== reg.datos.cuit
          ? `\n⚠️ El certificado es del CUIT ${formatearCuit(v.cuitEnCertificado)}: para facturar como ${formatearCuit(reg.datos.cuit!)} esa empresa tiene que delegarle el servicio en ARCA.`
          : "";
      await this.wa.sendText(
        sesion.telefono,
        `🔐 Certificado válido (vence el ${v.venceEl}). La clave quedó guardada cifrada.${avisoCuit}\n\nPor seguridad, borrá del chat el mensaje con el archivo .key.`
      );
    }
    reg.paso = siguientePaso(reg.datos);
    return this.preguntar(sesion);
  }

  private async guardar(sesion: SesionBot): Promise<void> {
    const reg = sesion.registro!;
    const d = reg.datos;
    if (siguientePaso(d) !== "confirmar") {
      reg.paso = siguientePaso(d);
      return this.preguntar(sesion);
    }

    let empresa: Empresa;
    try {
      empresa = await EmpresaRepository.crear(
        {
          cuit: d.cuit!,
          razonSocial: d.razonSocial!,
          nombreFantasia: d.nombreFantasia ?? undefined,
          domicilioComercial: d.domicilioComercial!,
          condicionIva: d.condicionIva!,
          ingresosBrutos: d.ingresosBrutos!,
          inicioActividades: d.inicioActividades!,
          puntoVenta: d.puntoVenta!,
          email: d.email ?? undefined,
          monotributoCategoria: d.monotributoCategoria ?? undefined,
          logoPath: d.logoPath ?? undefined,
          certModo: d.certModo!,
          certPem: d.certPem,
          keyPem: d.keyCifrada ? descifrar(d.keyCifrada) : undefined,
          produccion: this.opciones.produccion,
        },
        sesion.telefono
      );
    } catch (err: any) {
      if (err?.code === "ER_DUP_ENTRY") {
        await this.descartar(sesion);
        sesion.estado = "IDLE";
        await SessionStore.save(sesion);
        await this.wa.sendText(sesion.telefono, "Esa empresa ya fue registrada mientras cargabas los datos. Escribí _empresas_ para verla.");
        return;
      }
      throw err;
    }

    // El logo ya quedó vinculado: no hay que borrarlo al limpiar la sesión.
    sesion.registro = undefined;
    sesion.estado = "IDLE";
    sesion.borradorId = undefined;
    await SessionStore.save(sesion);

    await this.wa.sendText(
      sesion.telefono,
      `✅ *${empresa.razonSocial}* quedó registrada y es tu empresa activa.\n\n⏳ Probando la conexión con ARCA...`
    );
    await this.wa.sendText(sesion.telefono, await this.probarConexion(empresa));
  }

  /** Consulta el último comprobante para confirmar que el certificado y el punto de venta funcionan. */
  private async probarConexion(empresa: Empresa): Promise<string> {
    const tipo = empresa.condicionIva === "RESPONSABLE_INSCRIPTO" ? CbteTipo.FACTURA_B : CbteTipo.FACTURA_C;
    try {
      const r = await conEmpresa(empresa, () =>
        Promise.race([
          ArcaBillingService.obtenerUltimoComprobante(empresa.puntoVenta, tipo),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ARCA no respondió a tiempo")), 25_000)),
        ])
      );
      return `🟢 Conexión con ARCA OK. Punto de venta ${empresa.puntoVenta}: último comprobante N° ${r.ultimoNumero}.\n\nYa podés facturar: mandame por ejemplo _Facturale 10 mil a consumidor final por servicio técnico_.`;
    } catch (err: any) {
      const delegacion =
        empresa.certModo === "SISTEMA" && this.opciones.cuitSistema
          ? `\n• Que la empresa haya delegado el servicio *Facturación Electrónica* al CUIT ${formatearCuit(this.opciones.cuitSistema)} (ARCA > Administrador de Relaciones de Clave Fiscal).`
          : "";
      return [
        `🟠 La empresa quedó guardada, pero ARCA respondió: _${String(err?.message ?? err).slice(0, 200)}_`,
        "",
        "Revisá:",
        `• Que el punto de venta ${empresa.puntoVenta} esté dado de alta para *Web Services* en ARCA.${delegacion}`,
        "",
        "Cuando esté resuelto ya vas a poder facturar; no hace falta registrarla de nuevo.",
      ].join("\n");
    }
  }

  // -------------------------------------------------------------- preguntas

  private async reintentar(sesion: SesionBot, motivo: string): Promise<void> {
    await SessionStore.save(sesion);
    await this.wa.sendText(sesion.telefono, `⚠️ ${motivo}`);
  }

  private progreso(paso: PasoRegistro): string {
    const visible = paso.startsWith("certificado") ? "certificado_modo" : paso;
    const i = PASOS_VISIBLES.indexOf(visible);
    return i >= 0 ? `_Paso ${i + 1} de ${PASOS_VISIBLES.length}_\n` : "";
  }

  /** Envía la pregunta del paso actual (y guarda la sesión con un borradorId nuevo para los botones). */
  public async preguntar(sesion: SesionBot): Promise<void> {
    const reg = sesion.registro!;
    const d = reg.datos;
    sesion.borradorId = nuevoBorradorId();
    await SessionStore.save(sesion);

    const tel = sesion.telefono;
    const id = (v: string) => `reg:${sesion.borradorId}:${v}`;
    const p = this.progreso(reg.paso);
    const saltar = { id: id("saltar"), title: "Saltar" };

    switch (reg.paso) {
      case "cuit":
        await this.wa.sendText(tel, `${p}¿Cuál es el *CUIT* de la empresa? (ej: _20-12345678-9_)`);
        return;

      case "confirmar_padron": {
        const pd = reg.padron!;
        await this.wa.sendButtons(
          tel,
          [
            "Encontré estos datos en ARCA:",
            `• Razón social: *${pd.razonSocial}*`,
            pd.domicilio ? `• Domicilio fiscal: ${pd.domicilio}` : null,
            pd.condicionIva ? `• Condición IVA: ${NOMBRE_CONDICION_EMISOR[pd.condicionIva]}` : null,
            "",
            "¿Los uso?",
          ]
            .filter((l) => l !== null)
            .join("\n"),
          [
            { id: id("padron_ok"), title: "✅ Sí, usarlos" },
            { id: id("padron_manual"), title: "✏️ Cargar a mano" },
          ]
        );
        return;
      }

      case "razon_social":
        await this.wa.sendText(tel, `${p}¿Cuál es la *razón social*? (tal como figura en ARCA)`);
        return;

      case "nombre_fantasia":
        await this.wa.sendButtons(tel, `${p}¿Tiene *nombre de fantasía*? (es el nombre comercial que se destaca en la factura)`, [saltar]);
        return;

      case "domicilio":
        await this.wa.sendText(tel, `${p}¿Cuál es el *domicilio comercial*? (calle, número y localidad)`);
        return;

      case "condicion_iva":
        await this.wa.sendButtons(
          tel,
          `${p}¿Cuál es la *condición frente al IVA* de la empresa?\n\nDefine el tipo de factura: Monotributo y Exento emiten *C*; Responsable Inscripto emite *A* o *B*.`,
          CONDICIONES.map((c) => ({ id: id(`cond_${c.code}`), title: c.title }))
        );
        return;

      case "iibb":
        await this.wa.sendButtons(
          tel,
          `${p}¿Cuál es el número de *Ingresos Brutos*?\n\nSi es el mismo que el CUIT (CABA y otras provincias), tocá el botón. También podés escribir _exento_.`,
          [{ id: id("iibb_cuit"), title: "Igual al CUIT" }]
        );
        return;

      case "inicio_actividades":
        await this.wa.sendText(tel, `${p}¿Cuál es la fecha de *inicio de actividades*? (formato _dd/mm/aaaa_, figura en tu constancia de ARCA)`);
        return;

      case "punto_venta":
        await this.wa.sendText(
          tel,
          `${p}¿Qué *punto de venta* uso? Tiene que estar dado de alta en ARCA como _Factura Electrónica - Web Services_ (ej: _2_).`
        );
        return;

      case "monotributo_categoria":
        await this.wa.sendButtons(tel, `${p}¿En qué *categoría de Monotributo* está? (letra A a K) — la uso para avisarte si te acercás al tope.`, [saltar]);
        return;

      case "email":
        await this.wa.sendButtons(tel, `${p}¿Un *email* de contacto de la empresa? (opcional)`, [saltar]);
        return;

      case "logo":
        await this.wa.sendButtons(
          tel,
          `${p}Mandame el *logo* para el PDF como imagen (JPG o PNG, hasta 2 MB). Queda mejor con fondo blanco.`,
          [{ id: id("saltar"), title: "Sin logo" }]
        );
        return;

      case "certificado_modo":
        await this.wa.sendButtons(
          tel,
          [
            `${p}¿Cómo se conecta la empresa con ARCA?`,
            "",
            this.opciones.cuitSistema
              ? `• *Delegación* (recomendado): la empresa delega en ARCA el servicio _Facturación Electrónica_ al CUIT ${formatearCuit(this.opciones.cuitSistema)}. No hace falta mandar archivos.`
              : "• *Delegación*: se usa el certificado del sistema.",
            "• *Certificado propio*: me mandás el .crt y el .key de la empresa (la clave se guarda cifrada).",
          ].join("\n"),
          [
            { id: id("cert_sistema"), title: "Delegación" },
            { id: id("cert_propio"), title: "Certificado propio" },
          ]
        );
        return;

      case "certificado_crt":
        await this.wa.sendText(tel, "Mandame el archivo del *certificado* (.crt) como documento 📎.");
        return;

      case "certificado_key":
        await this.wa.sendText(tel, "Ahora mandame la *clave privada* (.key) como documento 📎.");
        return;

      case "elegir_correccion":
        await this.wa.sendList(
          tel,
          "¿Qué dato querés corregir?",
          "Elegir dato",
          CORREGIBLES.map((c) => ({ id: id(`fix_${c.id}`), title: c.title })),
          "Datos de la empresa"
        );
        return;

      case "confirmar":
        await this.wa.sendButtons(tel, this.resumen(d), [
          { id: id("guardar"), title: "✅ Guardar" },
          { id: id("corregir"), title: "✏️ Corregir" },
          { id: `cancelar:${sesion.borradorId}`, title: "❌ Cancelar" },
        ]);
        return;
    }
  }

  private resumen(d: DatosRegistro): string {
    const fecha = d.inicioActividades?.split("-").reverse().join("/");
    return [
      "🏢 *Revisá los datos de la empresa:*",
      `• CUIT: ${formatearCuit(d.cuit!)}`,
      `• Razón social: ${d.razonSocial}`,
      d.nombreFantasia ? `• Nombre de fantasía: ${d.nombreFantasia}` : null,
      `• Domicilio comercial: ${d.domicilioComercial}`,
      `• Condición IVA: ${NOMBRE_CONDICION_EMISOR[d.condicionIva!]}${d.monotributoCategoria ? ` (Cat. ${d.monotributoCategoria})` : ""}`,
      `• Ingresos Brutos: ${d.ingresosBrutos}`,
      `• Inicio de actividades: ${fecha}`,
      `• Punto de venta: ${d.puntoVenta}`,
      d.email ? `• Email: ${d.email}` : null,
      `• Logo: ${d.logoPath ? "cargado" : "sin logo"}`,
      `• Conexión ARCA: ${d.certModo === "PROPIO" ? "certificado propio" : "delegación"}`,
    ]
      .filter((l) => l !== null)
      .join("\n");
  }
}

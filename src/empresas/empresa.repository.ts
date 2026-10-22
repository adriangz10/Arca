import { execute, query, queryOne, transaction } from "../db/database.js";
import { cifrar, descifrar } from "../utils/crypto.utils.js";
import type { CondicionIvaEmisor, Empresa, EmpresaNueva } from "./empresa.types.js";

interface EmpresaRow {
  id: number;
  cuit: number;
  razon_social: string;
  nombre_fantasia: string | null;
  domicilio_comercial: string;
  condicion_iva: CondicionIvaEmisor;
  ingresos_brutos: string | null;
  inicio_actividades: string | null;
  punto_venta: number;
  email: string | null;
  monotributo_categoria: string | null;
  monotributo_tope_anual: number | null;
  logo_path: string | null;
  cert_modo: "SISTEMA" | "PROPIO";
  produccion: number;
  activa: number;
}

/** Columnas públicas: nunca se trae el certificado ni la clave salvo en `credenciales()`. */
const COLUMNAS = `id, cuit, razon_social, nombre_fantasia, domicilio_comercial, condicion_iva, ingresos_brutos,
  inicio_actividades, punto_venta, email, monotributo_categoria, monotributo_tope_anual, logo_path,
  cert_modo, produccion, activa`;

function mapRow(r: EmpresaRow): Empresa {
  return {
    id: r.id,
    cuit: Number(r.cuit),
    razonSocial: r.razon_social,
    nombreFantasia: r.nombre_fantasia ?? undefined,
    domicilioComercial: r.domicilio_comercial,
    condicionIva: r.condicion_iva,
    ingresosBrutos: r.ingresos_brutos ?? undefined,
    inicioActividades: r.inicio_actividades ?? undefined,
    puntoVenta: r.punto_venta,
    email: r.email ?? undefined,
    monotributoCategoria: r.monotributo_categoria ?? undefined,
    monotributoTopeAnual: r.monotributo_tope_anual ?? undefined,
    logoPath: r.logo_path ?? undefined,
    certModo: r.cert_modo,
    produccion: Boolean(r.produccion),
    activa: Boolean(r.activa),
  };
}

const ahora = () => new Date().toISOString();

export class EmpresaRepository {
  public static async porId(id: number): Promise<Empresa | null> {
    const row = await queryOne<EmpresaRow>(`SELECT ${COLUMNAS} FROM empresas WHERE id = ?`, [id]);
    return row ? mapRow(row) : null;
  }

  public static async porCuit(cuit: number, produccion: boolean): Promise<Empresa | null> {
    const row = await queryOne<EmpresaRow>(`SELECT ${COLUMNAS} FROM empresas WHERE cuit = ? AND produccion = ?`, [
      cuit,
      produccion ? 1 : 0,
    ]);
    return row ? mapRow(row) : null;
  }

  public static async listarPorTelefono(telefono: string): Promise<Empresa[]> {
    const rows = await query<EmpresaRow>(
      `SELECT ${COLUMNAS.replace(/(^|,\s*)(\w)/g, "$1e.$2")}
       FROM empresas e JOIN empresa_usuarios u ON u.empresa_id = e.id
       WHERE u.telefono = ? AND e.activa = 1
       ORDER BY e.razon_social`,
      [telefono]
    );
    return rows.map(mapRow);
  }

  public static async tieneAcceso(empresaId: number, telefono: string): Promise<boolean> {
    const row = await queryOne(`SELECT 1 AS ok FROM empresa_usuarios WHERE empresa_id = ? AND telefono = ?`, [
      empresaId,
      telefono,
    ]);
    return Boolean(row);
  }

  /** Empresa con la que trabaja el teléfono. Si no eligió ninguna y tiene una sola, usa esa. */
  public static async activaDe(telefono: string): Promise<Empresa | null> {
    const row = await queryOne<{ empresa_activa_id: number | null }>(
      `SELECT empresa_activa_id FROM usuarios_whatsapp WHERE telefono = ?`,
      [telefono]
    );
    if (row?.empresa_activa_id && (await this.tieneAcceso(row.empresa_activa_id, telefono))) {
      const e = await this.porId(row.empresa_activa_id);
      if (e?.activa) return e;
    }
    const propias = await this.listarPorTelefono(telefono);
    if (propias.length === 1) {
      await this.elegirActiva(telefono, propias[0].id);
      return propias[0];
    }
    return null;
  }

  public static async elegirActiva(telefono: string, empresaId: number): Promise<void> {
    await execute(
      `INSERT INTO usuarios_whatsapp (telefono, empresa_activa_id, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE empresa_activa_id = VALUES(empresa_activa_id), updated_at = VALUES(updated_at)`,
      [telefono, empresaId, ahora()]
    );
  }

  /** Alta de empresa + vínculo del teléfono como ADMIN + la deja activa, todo en una transacción. */
  public static async crear(datos: EmpresaNueva, telefonoAdmin?: string): Promise<Empresa> {
    const keyCifrada = datos.certModo === "PROPIO" && datos.keyPem ? cifrar(datos.keyPem) : null;
    const id = await transaction(async (conn) => {
      const [res]: any = await conn.execute(
        `INSERT INTO empresas (cuit, razon_social, nombre_fantasia, domicilio_comercial, condicion_iva,
           ingresos_brutos, inicio_actividades, punto_venta, email, monotributo_categoria, monotributo_tope_anual,
           logo_path, cert_modo, cert_pem, key_cifrada, produccion, activa, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          datos.cuit,
          datos.razonSocial,
          datos.nombreFantasia ?? null,
          datos.domicilioComercial,
          datos.condicionIva,
          datos.ingresosBrutos ?? null,
          datos.inicioActividades ?? null,
          datos.puntoVenta,
          datos.email ?? null,
          datos.monotributoCategoria ?? null,
          datos.monotributoTopeAnual ?? null,
          datos.logoPath ?? null,
          datos.certModo,
          datos.certModo === "PROPIO" ? datos.certPem ?? null : null,
          keyCifrada,
          datos.produccion ? 1 : 0,
          ahora(),
          ahora(),
        ]
      );
      const nuevoId = Number(res.insertId);
      if (telefonoAdmin) {
        await conn.execute(
          `INSERT IGNORE INTO empresa_usuarios (empresa_id, telefono, rol, created_at) VALUES (?, ?, 'ADMIN', ?)`,
          [nuevoId, telefonoAdmin, ahora()]
        );
        await conn.execute(
          `INSERT INTO usuarios_whatsapp (telefono, empresa_activa_id, updated_at) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE empresa_activa_id = VALUES(empresa_activa_id), updated_at = VALUES(updated_at)`,
          [telefonoAdmin, nuevoId, ahora()]
        );
      }
      return nuevoId;
    });
    return (await this.porId(id))!;
  }

  public static async vincularTelefono(empresaId: number, telefono: string, rol: "ADMIN" | "OPERADOR" = "ADMIN") {
    await execute(
      `INSERT IGNORE INTO empresa_usuarios (empresa_id, telefono, rol, created_at) VALUES (?, ?, ?, ?)`,
      [empresaId, telefono, rol, ahora()]
    );
  }

  public static async actualizarLogo(empresaId: number, logoPath: string | null): Promise<void> {
    await execute(`UPDATE empresas SET logo_path = ?, updated_at = ? WHERE id = ?`, [logoPath, ahora(), empresaId]);
  }

  /** Certificado y clave (descifrada) de una empresa con certificado propio. */
  public static async credenciales(empresaId: number): Promise<{ cert: string; key: string } | null> {
    const row = await queryOne<{ cert_pem: string | null; key_cifrada: string | null }>(
      `SELECT cert_pem, key_cifrada FROM empresas WHERE id = ? AND cert_modo = 'PROPIO'`,
      [empresaId]
    );
    if (!row?.cert_pem || !row.key_cifrada) return null;
    return { cert: row.cert_pem, key: descifrar(row.key_cifrada) };
  }

  public static async contar(): Promise<number> {
    const row = await queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM empresas`);
    return Number(row?.n ?? 0);
  }

  /** Empresa usada por la API REST cuando no se indica otra: la del CUIT del .env, o la primera. */
  public static async porDefecto(): Promise<Empresa | null> {
    const cuit = Number(String(process.env.ARCA_CUIT || "").replace(/\D/g, ""));
    const produccion = process.env.ARCA_PRODUCTION === "true";
    if (cuit) {
      const e = await this.porCuit(cuit, produccion);
      if (e) return e;
    }
    const row = await queryOne<EmpresaRow>(`SELECT ${COLUMNAS} FROM empresas WHERE activa = 1 ORDER BY id LIMIT 1`);
    return row ? mapRow(row) : null;
  }

  /**
   * Primer arranque: si la empresa del .env (ARCA_CUIT) no existe, la crea con los datos
   * ARCA_EMISOR_* y le da acceso a los números de WHATSAPP_ALLOWED_NUMBERS.
   */
  public static async sembrarDesdeEnv(telefonosAutorizados: string[]): Promise<Empresa | null> {
    const cuit = Number(String(process.env.ARCA_CUIT || "").replace(/\D/g, ""));
    if (!cuit) return null;
    const produccion = process.env.ARCA_PRODUCTION === "true";

    let empresa = await this.porCuit(cuit, produccion);
    if (!empresa) {
      const cond = (process.env.ARCA_EMISOR_CONDICION_IVA || "MONOTRIBUTO").toUpperCase();
      const condicionIva: CondicionIvaEmisor =
        cond === "RESPONSABLE_INSCRIPTO" || cond === "RI" ? "RESPONSABLE_INSCRIPTO" : cond === "EXENTO" ? "EXENTO" : "MONOTRIBUTO";
      const tope = Number(String(process.env.MONOTRIBUTO_TOPE_ANUAL || "").replace(/[^0-9.]/g, ""));
      empresa = await this.crear({
        cuit,
        razonSocial: process.env.ARCA_EMISOR_RAZON_SOCIAL || `Empresa CUIT ${cuit}`,
        domicilioComercial: process.env.ARCA_EMISOR_DOMICILIO || "-",
        condicionIva,
        ingresosBrutos: process.env.ARCA_EMISOR_IIBB || undefined,
        inicioActividades: process.env.ARCA_EMISOR_INICIO_ACTIVIDADES || undefined,
        puntoVenta: Number(process.env.ARCA_PTO_VTA || 1),
        monotributoCategoria: process.env.MONOTRIBUTO_CATEGORIA || undefined,
        monotributoTopeAnual: tope > 0 ? tope : undefined,
        certModo: "SISTEMA",
        produccion,
      });
      console.log(`[Empresas] Creada la empresa del .env: ${empresa.razonSocial} (CUIT ${cuit}).`);
    } else {
      // Completa datos fiscales que falten si se agregaron después al .env.
      const iibb = process.env.ARCA_EMISOR_IIBB?.trim();
      const inicio = process.env.ARCA_EMISOR_INICIO_ACTIVIDADES?.trim();
      if ((iibb && !empresa.ingresosBrutos) || (inicio && /^\d{4}-\d{2}-\d{2}$/.test(inicio) && !empresa.inicioActividades)) {
        await execute(
          `UPDATE empresas SET ingresos_brutos = COALESCE(ingresos_brutos, ?), inicio_actividades = COALESCE(inicio_actividades, ?), updated_at = ? WHERE id = ?`,
          [iibb || null, inicio && /^\d{4}-\d{2}-\d{2}$/.test(inicio) ? inicio : null, ahora(), empresa.id]
        );
        empresa = (await this.porId(empresa.id))!;
      }
    }
    for (const tel of telefonosAutorizados) {
      await this.vincularTelefono(empresa.id, tel, "ADMIN");
    }
    return empresa;
  }
}

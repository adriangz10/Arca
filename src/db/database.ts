import "dotenv/config";
import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";

/**
 * Capa de acceso a MySQL.
 *
 * - `initDatabase()` crea la base si no existe, aplica el esquema y (una sola vez)
 *   carga los valores por defecto de la configuración del bot.
 * - `query` / `queryOne` / `execute` usan siempre parámetros (`?`), nunca SQL armado
 *   con strings del usuario.
 */

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;

export function getDatabaseName(): string {
  return process.env.MYSQL_DATABASE || "arca_facturacion";
}

function baseConfig() {
  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    // DECIMAL como number (importes) y fechas como string (no se usan DATETIME de JS).
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    charset: "utf8mb4",
  };
}

function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      ...baseConfig(),
      database: getDatabaseName(),
      waitForConnections: true,
      connectionLimit: 10,
      namedPlaceholders: false,
    });
  }
  return pool;
}

/** Crea la base, el esquema y migra datos legacy. Idempotente: se puede llamar muchas veces. */
export function initDatabase(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const dbName = getDatabaseName();
      if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
        throw new Error(`MYSQL_DATABASE inválido: "${dbName}" (solo letras, números y _).`);
      }
      const admin = await mysql.createConnection(baseConfig());
      try {
        await admin.query(
          `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
        );
      } finally {
        await admin.end();
      }
      await applySchema();
      await migrarColumnas();
      await sembrarConfiguracion();
    })().catch((err) => {
      initPromise = null; // permite reintentar
      throw err;
    });
  }
  return initPromise;
}

async function ready(): Promise<Pool> {
  await initDatabase();
  return getPool();
}

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const p = await ready();
  const [rows] = await p.query(sql, params);
  return rows as T[];
}

export async function queryOne<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const p = await ready();
  const [result] = await p.execute(sql, params as any[]);
  return result as ResultSetHeader;
}

/** Ejecuta `fn` dentro de una transacción (commit si termina bien, rollback si falla). */
export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const p = await ready();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  initPromise = null;
}

// ---------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(100) PRIMARY KEY,
    applied_at VARCHAR(30) NOT NULL
  )`,

  // Configuración general del bot (antes estaba en el .env)
  `CREATE TABLE IF NOT EXISTS configuracion (
    clave VARCHAR(60) PRIMARY KEY,
    valor VARCHAR(255) NOT NULL,
    descripcion VARCHAR(255) NULL,
    updated_at VARCHAR(30) NOT NULL
  ) ENGINE=InnoDB`,

  // Empresas emisoras (cada una factura con su CUIT)
  `CREATE TABLE IF NOT EXISTS empresas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cuit BIGINT NOT NULL,
    razon_social VARCHAR(150) NOT NULL,
    nombre_fantasia VARCHAR(150) NULL,
    domicilio_comercial VARCHAR(255) NOT NULL,
    condicion_iva ENUM('MONOTRIBUTO','RESPONSABLE_INSCRIPTO','EXENTO') NOT NULL,
    ingresos_brutos VARCHAR(40) NULL,
    inicio_actividades VARCHAR(10) NULL COMMENT 'YYYY-MM-DD',
    punto_venta INT NOT NULL,
    email VARCHAR(150) NULL,
    monotributo_categoria VARCHAR(2) NULL,
    monotributo_tope_anual DECIMAL(15,2) NULL,
    concepto_default TINYINT NOT NULL DEFAULT 2 COMMENT '1 productos, 2 servicios, 3 ambos',
    cbu VARCHAR(22) NULL COMMENT 'CBU del emisor: obligatorio para Factura de Crédito Electrónica MiPyME',
    logo_path VARCHAR(255) NULL,
    cert_modo ENUM('SISTEMA','PROPIO') NOT NULL DEFAULT 'SISTEMA'
      COMMENT 'SISTEMA = usa el certificado del .env por delegación; PROPIO = certificado de la empresa',
    cert_pem TEXT NULL,
    key_cifrada TEXT NULL COMMENT 'Clave privada cifrada con AES-256-GCM (APP_ENCRYPTION_KEY)',
    produccion TINYINT(1) NOT NULL DEFAULT 0,
    activa TINYINT(1) NOT NULL DEFAULT 1,
    created_at VARCHAR(30) NOT NULL,
    updated_at VARCHAR(30) NOT NULL,
    UNIQUE KEY uq_empresa_cuit (cuit, produccion)
  ) ENGINE=InnoDB`,

  // Qué teléfonos de WhatsApp pueden facturar por cada empresa
  `CREATE TABLE IF NOT EXISTS empresa_usuarios (
    empresa_id INT NOT NULL,
    telefono VARCHAR(20) NOT NULL,
    rol ENUM('ADMIN','OPERADOR') NOT NULL DEFAULT 'ADMIN',
    created_at VARCHAR(30) NOT NULL,
    PRIMARY KEY (empresa_id, telefono),
    KEY idx_eu_telefono (telefono),
    CONSTRAINT fk_eu_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  // Empresa con la que está trabajando cada teléfono
  `CREATE TABLE IF NOT EXISTS usuarios_whatsapp (
    telefono VARCHAR(20) PRIMARY KEY,
    empresa_activa_id INT NULL,
    updated_at VARCHAR(30) NOT NULL,
    CONSTRAINT fk_uw_empresa FOREIGN KEY (empresa_activa_id) REFERENCES empresas(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,

  // Tickets WSAA (12 h). La clave es por CERTIFICADO: ARCA da un solo ticket por certificado y servicio.
  `CREATE TABLE IF NOT EXISTS arca_tickets (
    id VARCHAR(120) PRIMARY KEY,
    cuit BIGINT NOT NULL,
    service_name VARCHAR(60) NOT NULL,
    production TINYINT(1) NOT NULL DEFAULT 0,
    token TEXT NOT NULL,
    sign TEXT NOT NULL,
    generation_time VARCHAR(40) NOT NULL,
    expiration_time VARCHAR(40) NOT NULL,
    header_json TEXT NULL,
    credentials_json MEDIUMTEXT NULL,
    updated_at VARCHAR(30) NOT NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS invoices (
    id VARCHAR(80) PRIMARY KEY,
    empresa_id INT NULL,
    emisor_cuit BIGINT NOT NULL,
    emisor_razon_social VARCHAR(150) NULL,
    punto_venta INT NOT NULL,
    tipo_comprobante INT NOT NULL,
    tipo_comprobante_nombre VARCHAR(60) NOT NULL,
    tipo_comprobante_letra CHAR(1) NOT NULL,
    numero_comprobante INT NOT NULL,
    numero_formateado VARCHAR(20) NOT NULL,
    fecha_emision VARCHAR(8) NOT NULL,
    fecha_emision_formateada VARCHAR(10) NOT NULL,
    receptor_razon_social VARCHAR(200) NOT NULL,
    receptor_doc_tipo VARCHAR(30) NOT NULL,
    receptor_doc_nro VARCHAR(20) NOT NULL,
    receptor_condicion_iva VARCHAR(10) NOT NULL,
    receptor_domicilio VARCHAR(255) NULL,
    importe_neto DECIMAL(15,2) NOT NULL,
    importe_iva DECIMAL(15,2) NOT NULL,
    importe_tributos DECIMAL(15,2) NOT NULL,
    importe_total DECIMAL(15,2) NOT NULL,
    items_json MEDIUMTEXT NULL,
    cae VARCHAR(20) NOT NULL,
    cae_vencimiento VARCHAR(10) NOT NULL,
    qr_url TEXT NOT NULL,
    pdf_path VARCHAR(255) NULL,
    pdf_file_name VARCHAR(150) NULL,
    concepto INT NULL,
    fecha_servicio_desde VARCHAR(8) NULL,
    fecha_servicio_hasta VARCHAR(8) NULL,
    fecha_vencimiento_pago VARCHAR(8) NULL,
    moneda_id VARCHAR(5) NULL DEFAULT 'PES',
    moneda_cotizacion DECIMAL(15,6) NULL DEFAULT 1,
    alicuotas_iva_json TEXT NULL,
    tributos_json TEXT NULL,
    comprobantes_asociados_json TEXT NULL,
    opcionales_json TEXT NULL,
    arca_resultado VARCHAR(5) NULL,
    arca_observaciones_json TEXT NULL,
    created_at VARCHAR(30) NOT NULL,
    UNIQUE KEY uq_invoice_fiscal (emisor_cuit, punto_venta, tipo_comprobante, numero_comprobante),
    KEY idx_invoices_cae (cae),
    KEY idx_invoices_doc (receptor_doc_nro),
    KEY idx_invoices_fecha (emisor_cuit, fecha_emision),
    KEY idx_invoices_created (emisor_cuit, created_at),
    CONSTRAINT fk_inv_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS clientes (
    id VARCHAR(40) PRIMARY KEY,
    doc_tipo VARCHAR(10) NOT NULL,
    doc_nro VARCHAR(20) NOT NULL,
    razon_social VARCHAR(200) NOT NULL,
    condicion_iva VARCHAR(10) NOT NULL,
    domicilio VARCHAR(255) NULL,
    updated_at VARCHAR(30) NOT NULL,
    KEY idx_clientes_doc (doc_nro)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_type VARCHAR(60) NOT NULL,
    entity_id VARCHAR(80) NULL,
    emisor_cuit BIGINT NULL,
    payload_json MEDIUMTEXT NULL,
    response_json MEDIUMTEXT NULL,
    status VARCHAR(20) NOT NULL,
    created_at VARCHAR(30) NOT NULL,
    KEY idx_audit_event (event_type, created_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    telefono VARCHAR(20) PRIMARY KEY,
    data_json MEDIUMTEXT NOT NULL,
    updated_at VARCHAR(30) NOT NULL
  ) ENGINE=InnoDB`,

  // Deduplicación: Meta reintenta webhooks si no respondemos a tiempo.
  `CREATE TABLE IF NOT EXISTS whatsapp_processed_messages (
    message_id VARCHAR(128) PRIMARY KEY,
    created_at VARCHAR(30) NOT NULL,
    KEY idx_wpm_created (created_at)
  ) ENGINE=InnoDB`,

  // Mensaje de WhatsApp (PDF enviado) -> factura, para "anular" respondiendo al PDF.
  `CREATE TABLE IF NOT EXISTS whatsapp_invoice_messages (
    wa_message_id VARCHAR(128) PRIMARY KEY,
    invoice_id VARCHAR(80) NOT NULL,
    telefono VARCHAR(20) NOT NULL,
    created_at VARCHAR(30) NOT NULL,
    KEY idx_wa_invoice (invoice_id)
  ) ENGINE=InnoDB`,
];

/** Valores iniciales de la configuración (no pisa los que ya se cambiaron). */
export const CONFIGURACION_INICIAL: Array<{ clave: string; valor: string; descripcion: string }> = [
  { clave: "consumidor_final_tope", valor: "10000000", descripcion: "Monto desde el cual ARCA exige identificar al consumidor final" },
  { clave: "sesion_ttl_minutos", valor: "15", descripcion: "Minutos que se guarda una venta a medio armar sin actividad" },
  { clave: "consultar_padron", valor: "true", descripcion: "Consultar el padrón de ARCA (ws_sr_constancia_inscripcion) con cada CUIT" },
  { clave: "verificar_fce", valor: "true", descripcion: "Verificar con ARCA (wsfecred) si el cliente está obligado a recibir Factura de Crédito MiPyME" },
  { clave: "arca_produccion", valor: "false", descripcion: "false = homologación (pruebas), true = producción. Se aplica a las empresas nuevas" },
];

/** Columnas agregadas después de crear la tabla (para bases ya existentes). */
async function migrarColumnas(): Promise<void> {
  const p = getPool();
  const [cols]: any = await p.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'empresas'`,
    [getDatabaseName()]
  );
  const existentes = new Set(cols.map((c: any) => c.COLUMN_NAME));
  if (!existentes.has("cbu")) await p.query(`ALTER TABLE empresas ADD COLUMN cbu VARCHAR(22) NULL AFTER concepto_default`);
}

async function sembrarConfiguracion(): Promise<void> {
  const p = getPool();
  for (const c of CONFIGURACION_INICIAL) {
    await p.query(
      `INSERT IGNORE INTO configuracion (clave, valor, descripcion, updated_at) VALUES (?, ?, ?, ?)`,
      [c.clave, c.valor, c.descripcion, new Date().toISOString()]
    );
  }
}

async function applySchema(): Promise<void> {
  const p = getPool();
  for (const stmt of SCHEMA) {
    await p.query(stmt);
  }
}

// ---------------------------------------------------------------------------
// Auditoría
// ---------------------------------------------------------------------------

export class AuditStorage {
  /** Nunca rompe el flujo principal: si falla, solo lo registra en consola. */
  public static async save(event: {
    event_type: string;
    entity_id?: string;
    emisor_cuit?: number;
    payload_json?: string;
    response_json?: string;
    status: string;
  }): Promise<void> {
    try {
      await execute(
        `INSERT INTO audit_logs (event_type, entity_id, emisor_cuit, payload_json, response_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          event.event_type,
          event.entity_id ?? null,
          event.emisor_cuit ?? null,
          event.payload_json ?? null,
          event.response_json ?? null,
          event.status,
          new Date().toISOString(),
        ]
      );
    } catch (err: any) {
      console.warn("[Audit] No se pudo guardar el evento:", err?.message ?? err);
    }
  }
}

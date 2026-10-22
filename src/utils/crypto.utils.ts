import crypto from "node:crypto";

/**
 * Cifrado simétrico AES-256-GCM para secretos guardados en la base (claves privadas
 * de los certificados de ARCA). La clave sale de APP_ENCRYPTION_KEY.
 * Formato guardado: v1:<iv base64>:<authTag base64>:<datos base64>
 */

function obtenerClave(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error("Falta APP_ENCRYPTION_KEY en el .env: es necesaria para guardar certificados de empresas.");
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  // Cualquier otro texto: se deriva una clave de 32 bytes.
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function cifrar(textoPlano: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", obtenerClave(), iv);
  const datos = Buffer.concat([cipher.update(textoPlano, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${datos.toString("base64")}`;
}

export function descifrar(cifrado: string): string {
  const [version, ivB64, tagB64, datosB64] = cifrado.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !datosB64) {
    throw new Error("Formato de dato cifrado desconocido.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", obtenerClave(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(datosB64, "base64")), decipher.final()]).toString("utf8");
}

/** Huella corta y estable de un certificado (para indexar tickets WSAA por certificado). */
export function huellaCertificado(certPem: string): string {
  return crypto.createHash("sha256").update(certPem.trim()).digest("hex").slice(0, 16);
}

export interface ResultadoValidacionCert {
  ok: boolean;
  error?: string;
  cuitEnCertificado?: string;
  venceEl?: string;
}

/**
 * Valida que el certificado y la clave sean PEM válidos, que se correspondan entre sí
 * y que el certificado no esté vencido.
 */
export function validarParCertificado(certPem: string, keyPem: string): ResultadoValidacionCert {
  let cert: crypto.X509Certificate;
  try {
    cert = new crypto.X509Certificate(certPem);
  } catch {
    return { ok: false, error: "El archivo del certificado (.crt) no es un certificado PEM válido." };
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(keyPem);
  } catch {
    return { ok: false, error: "El archivo de la clave (.key) no es una clave privada PEM válida (o tiene contraseña)." };
  }
  if (!cert.checkPrivateKey(key)) {
    return { ok: false, error: "La clave privada no corresponde a ese certificado." };
  }
  const vence = new Date(cert.validTo);
  if (vence.getTime() < Date.now()) {
    return { ok: false, error: `El certificado venció el ${vence.toLocaleDateString("es-AR")}.` };
  }
  const cuit = cert.subject.match(/CUIT\s*(\d{11})/i)?.[1];
  return { ok: true, cuitEnCertificado: cuit, venceEl: vence.toISOString().slice(0, 10) };
}

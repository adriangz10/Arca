export class ArcaBaseError extends Error {
  public statusCode: number;
  public code: string;
  public details?: any;
  public suggestion?: string;

  constructor(message: string, statusCode = 500, code = "ARCA_ERROR", details?: any, suggestion?: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.suggestion = suggestion;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ArcaValidationError extends ArcaBaseError {
  constructor(message: string, details?: any) {
    super(message, 400, "VALIDATION_ERROR", details, "Verifique los datos enviados en la petición e intente nuevamente.");
  }
}

export class ArcaAuthError extends ArcaBaseError {
  constructor(message: string, details?: any) {
    super(message, 401, "AUTH_ERROR", details, "Verifique que el certificado y key sean válidos y correspondan al CUIT configurado.");
  }
}

export class ArcaBusinessError extends ArcaBaseError {
  constructor(message: string, details?: any) {
    super(message, 422, "BUSINESS_ERROR", details, "ARCA rechazó el comprobante. Verifique las observaciones.");
  }
}

export class ArcaNetworkError extends ArcaBaseError {
  constructor(message: string, details?: any) {
    super(message, 502, "NETWORK_ERROR", details, "Problema de red al comunicarse con ARCA. Reintente en unos momentos.");
  }
}

export class ArcaServiceUnavailableError extends ArcaBaseError {
  constructor(message: string, details?: any) {
    super(message, 503, "SERVICE_UNAVAILABLE", details, "Los servidores de ARCA están caídos o en mantenimiento.");
  }
}

export function parseArcaError(error: any): ArcaBaseError {
  if (error instanceof ArcaBaseError) return error;

  const msg = error?.message?.toLowerCase() || String(error).toLowerCase();

  if (msg.includes("wsaa") || msg.includes("certificado") || msg.includes("auth") || msg.includes("token")) {
    return new ArcaAuthError(`Error de autenticación con ARCA (WSAA): ${error.message}`, error);
  }

  if (msg.includes("econnrefused") || msg.includes("etimedout") || msg.includes("ssl") || msg.includes("tls")) {
    return new ArcaNetworkError(`Error de conexión con los servidores de ARCA: ${error.message}`, error);
  }

  if (msg.includes("servidor") || msg.includes("unavailable") || msg.includes("503") || msg.includes("mantenimiento")) {
    return new ArcaServiceUnavailableError(`Servicio de ARCA no disponible: ${error.message}`, error);
  }

  return new ArcaBaseError(`Error inesperado de ARCA: ${error.message || "Unknown error"}`, 500, "INTERNAL_ERROR", error);
}

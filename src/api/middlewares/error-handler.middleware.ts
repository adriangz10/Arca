import type { Request, Response, NextFunction } from "express";
import { ArcaBaseError } from "../../errors/arca-errors.js";

/** Solo en desarrollo explícito se devuelven stack traces (la API puede estar expuesta por un túnel). */
const mostrarDetalles = () => process.env.NODE_ENV === "development";

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[Error] ${req.method} ${req.path}:`, err?.message || err);

  // JSON mal formado en el body
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ success: false, error: { code: "INVALID_JSON", message: "El body no es un JSON válido." } });
    return;
  }

  if (err instanceof ArcaBaseError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        suggestion: err.suggestion,
      },
      stack: mostrarDetalles() ? err.stack : undefined,
    });
    return;
  }

  const status = Number(err?.statusCode || err?.status) || 500;
  res.status(status).json({
    success: false,
    error: {
      code: status >= 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST",
      // Los errores internos (SQL, rutas de archivos) no se muestran fuera de desarrollo.
      message:
        status < 500 || mostrarDetalles()
          ? err?.message || "Pedido inválido."
          : "Ocurrió un error interno en el servidor de facturación.",
    },
    stack: mostrarDetalles() ? err?.stack : undefined,
  });
};

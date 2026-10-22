import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { conEmpresa } from "../../empresas/empresa.context.js";
import { EmpresaRepository } from "../../empresas/empresa.repository.js";

function esLoopback(ip: string | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function igualSeguro(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Protege la API REST (emite comprobantes y entrega PDFs con datos de clientes).
 *
 * - Con API_KEY configurada: exige el header `X-API-Key` (o `Authorization: Bearer ...`).
 * - Sin API_KEY: solo acepta pedidos hechos desde la misma máquina y que no vengan
 *   por un túnel/proxy (devtunnels, ngrok), que agregan X-Forwarded-For.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.API_KEY?.trim();

  if (!apiKey) {
    const directo = esLoopback(req.socket.remoteAddress) && !req.headers["x-forwarded-for"];
    if (directo) return next();
    res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "API sin API_KEY configurada: solo se puede usar desde localhost." },
    });
    return;
  }

  const bearer = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const recibida = req.get("x-api-key") ?? bearer ?? "";
  if (recibida && igualSeguro(recibida, apiKey)) return next();

  res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Falta o es inválido el header X-API-Key." } });
}

/**
 * Elige la empresa emisora del pedido: header `X-Empresa-Cuit` (o `X-Empresa-Id`);
 * si no viene ninguno, la empresa del .env. Todo lo que pase después (ARCA, historial,
 * PDF) corre dentro de esa empresa.
 */
export async function resolverEmpresa(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const produccion = process.env.ARCA_PRODUCTION === "true";
    const cuitHeader = req.get("x-empresa-cuit")?.replace(/\D/g, "");
    const idHeader = req.get("x-empresa-id");

    const empresa = cuitHeader
      ? await EmpresaRepository.porCuit(Number(cuitHeader), produccion)
      : idHeader && /^\d+$/.test(idHeader)
        ? await EmpresaRepository.porId(Number(idHeader))
        : await EmpresaRepository.porDefecto();

    if ((cuitHeader || idHeader) && !empresa) {
      res.status(404).json({ success: false, error: { code: "EMPRESA_NOT_FOUND", message: "No existe esa empresa." } });
      return;
    }
    if (empresa && !empresa.activa) {
      res.status(403).json({ success: false, error: { code: "EMPRESA_INACTIVA", message: "La empresa está desactivada." } });
      return;
    }
    if (!empresa) return next();

    // `next` se llama dentro del contexto: los handlers async heredan la empresa.
    await conEmpresa(empresa, async () => next());
  } catch (err) {
    next(err);
  }
}

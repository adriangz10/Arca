import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { billingRoutes } from "./routes/billing.routes.js";
import { closeDatabase, getDatabaseName, initDatabase } from "../db/database.js";
import { errorHandler } from "./middlewares/error-handler.middleware.js";
import { requireApiKey, resolverEmpresa } from "./middlewares/auth.middleware.js";
import { whatsappRoutes } from "../whatsapp/whatsapp.routes.js";
import { isWhatsAppConfigured, loadWhatsAppConfig } from "../whatsapp/whatsapp.config.js";
import { EmpresaRepository } from "../empresas/empresa.repository.js";
import { cuitDelSistema } from "../config/arca.config.js";
import { WhatsAppClient } from "../whatsapp/whatsapp.client.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Detrás de un túnel/proxy (devtunnels, ngrok, etc.): confiar en el primer salto para X-Forwarded-For
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Logger simple (va primero para registrar también el webhook). Se loguea solo el path:
// la query puede traer secretos (ej: hub.verify_token en la verificación de Meta).
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const ruta = req.path; // se toma antes de que los routers montados la recorten
  res.on("finish", () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${ruta} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use(helmet());

// CORS: solo los orígenes listados en CORS_ORIGIN (vacío = ninguno; la API se usa de servidor a servidor).
const origenes = (process.env.CORS_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: origenes.includes("*") ? "*" : origenes.length > 0 ? origenes : false }));

// Se guarda el body crudo para validar la firma X-Hub-Signature-256 de los webhooks de WhatsApp
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

// Webhook de WhatsApp: va antes del rate limiter (todo el tráfico viene de las IPs de Meta)
app.use("/webhooks/whatsapp", whatsappRoutes);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  })
);

// Ruta base informativa (sin datos internos como rutas de archivos)
app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "ARCA Facturación Electrónica API",
    version: "2.0.0",
    auth: "Header X-API-Key en /api/*. Empresa emisora opcional: header X-Empresa-Cuit.",
    endpoints: {
      status: "GET /api/status",
      tables: "GET /api/tables",
      vouchers: "GET /api/vouchers",
      lastVoucher: "GET /api/vouchers/last?ptoVta=1&tipo=6",
      getVoucher: "GET /api/vouchers/:id",
      getVoucherPdf: "GET /api/vouchers/:id/pdf",
      emitir: "POST /api/vouchers/{factura-a|factura-b|factura-c|factura-m|nota-credito|nota-debito|recibo|fce|emitir}",
      whatsappWebhook: "GET|POST /webhooks/whatsapp",
    },
  });
});

// API REST protegida: API key + empresa emisora del pedido
app.use("/api", requireApiKey, resolverEmpresa, billingRoutes);

app.use(errorHandler);

async function arrancar(): Promise<void> {
  await initDatabase();

  const wa = loadWhatsAppConfig();
  const totalEmpresas = await EmpresaRepository.contar();
  const cuitSistema = cuitDelSistema();

  const server = app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(` Servidor ARCA Facturación API iniciado`);
    console.log(` Base de datos: MySQL (${getDatabaseName()}) · ${totalEmpresas} empresa(s)`);
    console.log(` Certificado ARCA del sistema: ${cuitSistema ? `CUIT ${cuitSistema}` : "⚠ no encontrado (ARCA_CERT_PATH / ARCA_KEY_PATH)"}`);
    if (totalEmpresas === 0) console.log(` Sin empresas: el primer mensaje de WhatsApp arranca la configuración inicial.`);
    console.log(` Escuchando en: http://localhost:${PORT}`);
    console.log(` API REST: ${process.env.API_KEY ? "protegida con X-API-Key" : "⚠ sin API_KEY: solo responde a localhost"}`);
    if (isWhatsAppConfigured(wa)) {
      console.log(` Bot WhatsApp: activo en /webhooks/whatsapp (IA ${wa.geminiApiKey ? wa.geminiModel : "desactivada: parser básico"})`);
      if (wa.allowedNumbers.length === 0) console.log(` ⚠ WHATSAPP_ALLOWED_NUMBERS vacío: el bot ignorará todos los mensajes.`);
      if (!wa.appSecret) console.log(` ⚠ WHATSAPP_APP_SECRET vacío: no se valida la firma de los webhooks.`);
    } else {
      console.log(` Bot WhatsApp: desactivado (faltan variables WHATSAPP_* en .env)`);
    }
    console.log(`======================================================\n`);

    // El token de Meta se verifica al arrancar: si venció, se avisa acá y no con el primer mensaje.
    if (isWhatsAppConfigured(wa)) {
      new WhatsAppClient(wa).verificarToken().then((problema) => {
        if (problema) console.error(`\n⚠ WhatsApp: ${problema}\n  El bot va a recibir mensajes pero no va a poder responder.\n`);
        else console.log(" ✔ Token de WhatsApp válido.");
      });
    }
  });

  // Cierre ordenado: termina los pedidos en curso y libera las conexiones a MySQL.
  const cerrar = (senal: string) => {
    console.log(`\n[Servidor] ${senal} recibido, cerrando...`);
    server.close(() => {
      closeDatabase().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => cerrar("SIGINT"));
  process.on("SIGTERM", () => cerrar("SIGTERM"));
}

arrancar().catch((err) => {
  console.error("[Servidor] No se pudo iniciar:", err?.message ?? err);
  if (err?.code === "ECONNREFUSED") console.error("  → ¿Está corriendo MySQL en MYSQL_HOST:MYSQL_PORT?");
  if (err?.code === "ER_ACCESS_DENIED_ERROR") console.error("  → Revisá MYSQL_USER / MYSQL_PASSWORD en el .env.");
  process.exit(1);
});

export default app;

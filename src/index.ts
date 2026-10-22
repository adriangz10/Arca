/**
 * Módulo principal de Facturación Electrónica ARCA (AFIP) en TypeScript.
 * Soporta persistencia de tickets de acceso WSAA de 12 horas,
 * emisión de comprobantes, consultas maestras, generación de QR oficial (RG 4291)
 * y renderizado de comprobantes oficiales en PDF con base de datos SQLite WAL.
 */

export * from "./constants/arca.constants.js";
export * from "./types/billing.types.js";
export * from "./config/arca.config.js";
export * from "./db/database.js";
export * from "./storage/database-ticket-storage.js";
export * from "./storage/invoice-history.storage.js";
export * from "./services/qr.service.js";
export * from "./services/pdf.service.js";
export * from "./services/arca-client.factory.js";
export * from "./services/arca-billing.service.js";
export * from "./empresas/empresa.types.js";
export * from "./empresas/empresa.repository.js";
export * from "./empresas/empresa.context.js";

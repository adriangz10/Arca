import { Router } from "express";
import { BillingController } from "../controllers/billing.controller.js";

const router = Router();

// Estado y diagnóstico
router.get("/status", BillingController.getStatus);

// Tablas maestras oficiales
router.get("/tables", BillingController.getTables);

// Listar todas las facturas y consultas
router.get("/vouchers", BillingController.listVouchers);
router.get("/vouchers/last", BillingController.getLastVoucher);
router.get("/vouchers/:id/pdf", BillingController.getVoucherPdf);
router.get("/vouchers/:id", BillingController.getVoucherById);

// Emisión de comprobantes por tipo oficial (CbteTipo)
router.post("/vouchers/factura-b", BillingController.createFacturaB);
router.post("/vouchers/factura-a", BillingController.createFacturaA);
router.post("/vouchers/factura-c", BillingController.createFacturaC);
router.post("/vouchers/factura-m", BillingController.createFacturaM);
router.post("/vouchers/nota-credito", BillingController.createNotaCredito);
router.post("/vouchers/nota-debito", BillingController.createNotaDebito);
router.post("/vouchers/recibo", BillingController.createRecibo);
router.post("/vouchers/fce", BillingController.createFce);
router.post("/vouchers/emitir", BillingController.emitirComprobanteGenerico);

export const billingRoutes = router;

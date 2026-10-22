# API REST de Facturación Electrónica ARCA/AFIP

## Visión General y Arquitectura del Proyecto

Este proyecto es una API REST robusta para la emisión, gestión y consulta de comprobantes electrónicos a través de los web services de ARCA/AFIP en Argentina. Está diseñada para ser consumida de forma sencilla por aplicaciones Frontend (como paneles de administración, puntos de venta o e-commerce).

### Arquitectura
- **Backend:** Desarrollado en Node.js para la emisión y consulta de comprobantes (WSFE), gestión de tickets de acceso (WSAA) con validez automática de 12hs, base de datos relacional para almacenamiento y renderizado interno de PDF y códigos QR compatibles con la RG 4291.
- **Stack Tecnológico:**
  - **Framework:** Express 5.
  - **Base de Datos:** better-sqlite3 operando en modo WAL (Write-Ahead Logging) para máxima concurrencia y velocidad.
  - **Librería Core ARCA/AFIP:** `@arcasdk/core`
  - **Lenguaje:** TypeScript usando módulos ESM.

### Configuración Rápida
1. Crear un archivo `.env` en la raíz (basado en un `.env.example`).
2. Configurar la ruta de los certificados y claves (nunca comitear certificados o CUITs reales al repositorio).
3. Seleccionar el entorno mediante la variable `NODE_ENV` (usar `development` para Homologación / testing y `production` para Producción).

---

## Bot de WhatsApp

Permite facturar mandando un mensaje, un audio o la captura de una transferencia:
_"Facturale $45.000 a consumidor final por servicio de diseño"_ o _"Factura al CUIT 30-71234567-1 por 120 mil más IVA de mantenimiento"_.

**Regla de diseño:** la IA (Gemini) solo extrae datos del mensaje. El tipo de factura, el cálculo de Neto/IVA/Total, las validaciones y la llamada a ARCA son 100% determinísticos (`src/whatsapp/fiscal-engine.ts`).

### Flujo
1. Meta envía el mensaje a `POST /webhooks/whatsapp` (se valida la firma y que el número esté autorizado).
2. Gemini extrae monto, CUIT/DNI, concepto, etc. Si falta algo, el bot repregunta solo ese dato (borrador guardado 15 min en SQLite).
3. Si hay CUIT, se consulta el padrón de ARCA para obtener nombre y condición IVA. Si falla, el bot pregunta la condición con una lista.
4. Se decide el comprobante: emisor Monotributo/Exento → **C**; emisor RI → **A** si el cliente es RI/Monotributista, **B** si no.
5. Si es Consumidor Final anónimo y el total supera `CONSUMIDOR_FINAL_TOPE`, se pide DNI/CUIT.
6. Se muestra el resumen con botones **[Emitir ahora] [Corregir] [Cancelar]**. Nada se emite sin confirmar.
7. La emisión se serializa por Punto de Venta (evita choques de numeración) y el PDF se manda por WhatsApp.
8. Respondiendo (citando) el PDF con _"anulala"_ se emite la Nota de Crédito vinculada, previa confirmación.
9. Si sos Monotributista y configurás `MONOTRIBUTO_TOPE_ANUAL`, avisa cuando pasás el 75% del tope.

Comandos: `ayuda`, `últimas`, `cancelar`.

### Configuración
1. Crear una app en [developers.facebook.com](https://developers.facebook.com) con el producto **WhatsApp** y copiar `WHATSAPP_ACCESS_TOKEN` (usar un token permanente de System User para producción) y `WHATSAPP_PHONE_NUMBER_ID`.
2. Completar las variables `WHATSAPP_*`, `GEMINI_API_KEY` y `ARCA_EMISOR_*` (ver `.env.example`).
3. Exponer el servidor con HTTPS (ej. `ngrok http 3000` en desarrollo).
4. En Meta → WhatsApp → Configuration → Webhook: URL `https://TU-DOMINIO/webhooks/whatsapp`, Verify token = `WHATSAPP_VERIFY_TOKEN`, y suscribirse al campo **messages**.
5. `npm run dev` y escribirle al número del bot desde un número incluido en `WHATSAPP_ALLOWED_NUMBERS`.

Para la consulta de padrón el certificado tiene que tener autorizado el servicio `ws_sr_constancia_inscripcion` (en homologación, desde WSASS). Si no, el bot funciona igual pero pregunta la condición IVA.

Prueba offline (sin ARCA, WhatsApp ni Gemini): `npm run test:whatsapp`.

### Limitaciones
- El lock de emisión y la deduplicación son en memoria/SQLite: pensado para **una sola instancia** del servidor. Para varias instancias, reemplazar `src/utils/keyed-mutex.ts` por un lock en Redis/BullMQ.
- Single-tenant: factura siempre con el CUIT y certificado del `.env`.

---

## Guía de Integración (Contratos API)

Todas las rutas relativas a la facturación comienzan en `/api/` y producen respuestas estandarizadas.

### Formato Estándar de Respuestas

Las respuestas de la API siguen una estructura predecible:

**Success (HTTP 200/201):**
```json
{
  "success": true,
  "data": { ... }
}
```

**Error (HTTP 4xx / 5xx):**
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Descripción amigable del error",
    "details": [ ... ],
    "suggestion": "Acción sugerida para resolver el problema"
  }
}
```

### Endpoints de Consulta

- **`GET /`**
  Ruta raíz para comprobar que el servicio está levantado.

- **`GET /api/status`**
  Retorna el estado de los servidores de AFIP (AppServer, DbServer, AuthServer) y estado local de la base de datos y certificados.

- **`GET /api/tables`**
  Obtiene las tablas maestras oficiales (tipos de comprobante, conceptos, alícuotas de IVA, tipos de documento, monedas, etc.).

- **`GET /api/vouchers`**
  Listado histórico de comprobantes emitidos y almacenados localmente. Soporta paginación y filtros (ej. `?page=1&limit=50&ptoVta=1&tipo=6`).

- **`GET /api/vouchers/last?ptoVta=1&tipo=6`**
  Retorna el número de comprobante máximo (último) registrado en AFIP para un punto de venta y tipo de comprobante.

- **`GET /api/vouchers/:id`**
  Obtiene el detalle completo de un comprobante específico mediante su ID interno.

- **`GET /api/vouchers/:id/pdf`**
  Devuelve el PDF generado del comprobante (Content-Type: application/pdf) incluyendo el código QR y logo, listo para imprimir o descargar.

### Endpoints de Emisión

Todos los endpoints de emisión usan el método `POST` y devuelven la información del comprobante emitido junto con su `CAE` y fecha de vencimiento.

- **`POST /api/vouchers/factura-b`** (A Consumidor Final / Monotributista)
**Nota:** El campo `condicionIvaReceptor` (o `condicionIva` dependiendo del caso) es **OBLIGATORIO** en todos los payloads de emisión.
```json
{
  "ptoVta": 1,
  "concepto": 1,
  "docTipo": 99,
  "docNro": 0,
  "condicionIvaReceptor": 5,
  "impTotal": 1210.00,
  "impNeto": 1000.00,
  "impIVA": 210.00,
  "items": [
    { "descripcion": "Producto B", "precioUnitario": 1000, "cantidad": 1, "alicuotaIva": 5 }
  ]
}
```

- **`POST /api/vouchers/factura-a`** (Entre Responsables Inscriptos)
```json
{
  "ptoVta": 1,
  "concepto": 2,
  "docTipo": 80,
  "docNro": 30111111118,
  "condicionIvaReceptor": 1,
  "impTotal": 12100.00,
  "impNeto": 10000.00,
  "impIVA": 2100.00,
  "fechaServicioDesde": "20231001",
  "fechaServicioHasta": "20231031",
  "fechaVencimientoPago": "20231110",
  "items": [ ... ]
}
```

- **`POST /api/vouchers/factura-c`** (Emisor Monotributista o Exento)
```json
{
  "ptoVta": 1,
  "concepto": 1,
  "docTipo": 96,
  "docNro": 20111111112,
  "condicionIvaReceptor": 5,
  "impTotal": 1500.00,
  "items": [ ... ]
}
```

- **`POST /api/vouchers/factura-m`** (Emisor con régimen especial)
*(Mismo payload base que Factura A)*

- **`POST /api/vouchers/nota-credito`** y **`POST /api/vouchers/nota-debito`**
*(Requiere array de comprobantes asociados `cbtesAsoc` para referenciar la factura original)*
```json
{
  "ptoVta": 1,
  "concepto": 1,
  "docTipo": 80,
  "docNro": 30111111118,
  "condicionIvaReceptor": 1,
  "impTotal": 12100.00,
  "impNeto": 10000.00,
  "impIVA": 2100.00,
  "cbtesAsoc": [
    {
      "tipo": 1,
      "ptoVta": 1,
      "nro": 1234
    }
  ]
}
```

- **`POST /api/vouchers/recibo`**
*(Payload similar a factura o nota pero usando el CbteTipo correspondiente)*

- **`POST /api/vouchers/fce`** (Factura de Crédito Electrónica MiPyMEs)
*(Requiere datos adicionales de CBU/Alias y opcionales según normativa MiPyME)*

- **`POST /api/vouchers/emitir`**
Endpoint genérico donde se debe enviar el payload completo especificando manualmente el campo `cbteTipo`.

---

## Códigos de Constantes Principales

Estos códigos son utilizados como parámetros en los endpoints. Referencia extraída de `src/constants/arca.constants.ts`.

### Tipos de Comprobante (CbteTipo)
- `1`: FACTURA A
- `2`: NOTA DEBITO A
- `3`: NOTA CREDITO A
- `6`: FACTURA B
- `8`: NOTA DEBITO B
- `9`: NOTA CREDITO B
- `11`: FACTURA C
- `13`: NOTA DEBITO C
- `14`: NOTA CREDITO C
- `51`: FACTURA M
- `201`: FCE A (Factura Crédito MiPyME)
- `211`: FCE C (Factura Crédito MiPyME)

### Tipos de Documento (DocTipo)
- `80`: CUIT
- `86`: CUIL
- `87`: CDI / DNI GENERICO
- `96`: DNI
- `99`: CONSUMIDOR FINAL
- `94`: PASAPORTE

### Tipos de Concepto
- `1`: PRODUCTOS
- `2`: SERVICIOS
- `3`: PRODUCTOS Y SERVICIOS

### Alícuotas de IVA
- `3`: 0%
- `4`: 10.5%
- `5`: 21%
- `6`: 27%
- `7`: 5%
- `8`: 2.5%

### Condiciones de IVA Receptor
- `1`: RESPONSABLE INSCRIPTO
- `4`: IVA SUJETO EXENTO
- `5`: CONSUMIDOR FINAL
- `6`: RESPONSABLE MONOTRIBUTO
- `7`: SUJETO NO CATEGORIZADO
- `8`: PROVEEDOR DEL EXTERIOR
- `9`: CLIENTE DEL EXTERIOR
- `10`: IVA LIBERADO
- `13`: MONOTRIBUTISTA SOCIAL
- `15`: IVA NO ALCANZADO

## Empresas (multi-emisor) y MySQL

Desde la v2 los datos viven en **MySQL** (`MYSQL_*` en `.env`). Al arrancar se crea la base `arca_facturacion`,
el esquema, y se importan una sola vez los datos de la base SQLite anterior (`data/arca.db`).
La empresa del `.env` (`ARCA_CUIT`) se crea sola y queda vinculada a `WHATSAPP_ALLOWED_NUMBERS`.

**Por WhatsApp:**
- `nueva empresa`: alta guiada (CUIT, razón social, nombre de fantasía, domicilio comercial, condición IVA,
  Ingresos Brutos, inicio de actividades, punto de venta, categoría de Monotributo, email, logo y conexión con ARCA).
- `empresas`: ver y elegir con cuál facturás · `mi empresa`: ver sus datos · `cambiar logo`: subir/quitar el logo del PDF.

**Conexión con ARCA de cada empresa:**
- *Delegación* (recomendado): la empresa delega en ARCA el servicio "Facturación Electrónica" al CUIT del certificado del `.env`.
- *Certificado propio*: se mandan el `.crt` y el `.key` por el chat; la clave se guarda cifrada (AES-256-GCM con `APP_ENCRYPTION_KEY`).

**API REST:** todas las rutas `/api/*` exigen el header `X-API-Key` (valor de `API_KEY`). Para elegir la empresa emisora
se usa el header `X-Empresa-Cuit`; sin él se usa la empresa del `.env`.

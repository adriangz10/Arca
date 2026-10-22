# API REST de Facturación Electrónica ARCA/AFIP

## Visión General y Arquitectura del Proyecto

Este proyecto es una API REST robusta para la emisión, gestión y consulta de comprobantes electrónicos a través de los web services de ARCA/AFIP en Argentina. Está diseñada para ser consumida de forma sencilla por aplicaciones Frontend (como paneles de administración, puntos de venta o e-commerce).

### Arquitectura
- **Backend:** Node.js + TypeScript (ESM), Express 5, `@arcasdk/core` (WSAA/WSFE), PDF con logo y QR (RG 4291).
- **Base de datos:** MySQL (`mysql2`). El esquema se crea solo al arrancar.
- **Multi-empresa:** cada empresa emisora (CUIT, datos fiscales, logo, punto de venta) vive en la tabla `empresas`.

### Qué va en el `.env` y qué en la base
| `.env` (solo secretos e infraestructura) | MySQL |
|---|---|
| Certificado del sistema (`ARCA_CERT_PATH` / `ARCA_KEY_PATH`; el CUIT sale del certificado) | `empresas`: CUIT, razón social, domicilio, condición IVA, IIBB, inicio de actividades, punto de venta, categoría y tope de Monotributo, qué vende, logo, ambiente |
| Meta (`WHATSAPP_*`), Gemini, MySQL, `APP_ENCRYPTION_KEY`, `API_KEY` | `configuracion`: tope de consumidor final, minutos de sesión, consultar padrón, ambiente de ARCA para empresas nuevas |

---

## Bot de WhatsApp

**Regla de diseño:** la IA (Gemini) solo extrae datos del primer mensaje (monto, qué se vendió). El documento, la condición IVA, la letra de la factura, los importes y la llamada a ARCA son 100% determinísticos (`src/whatsapp/fiscal-engine.ts`).

### 1. Configuración inicial (primer mensaje)
Si un número autorizado sin empresas escribe cualquier cosa (ej. _hola_), el bot arranca solo la configuración:
CUIT → razón social → nombre de fantasía → domicilio comercial → condición IVA → Ingresos Brutos → inicio de actividades →
punto de venta → (categoría y tope de Monotributo) → qué vende → email → conexión con ARCA (delegación o certificado propio) → **logo** → resumen → guardar.
Recién ahí se puede facturar. Código: `src/whatsapp/registro-empresa.flow.ts`.

### 2. Venta (`src/whatsapp/venta.flow.ts`)
Ejemplo: _"nueva venta de papel por 12000"_. Los datos que ya vinieron no se vuelven a preguntar; el orden es siempre el mismo:

1. **Monto** y **qué se vendió**.
2. **¿A quién le facturás?** → Consumidor final · DNI · CUIT/CUIL.
3. **Documento** y consulta al **padrón de ARCA**:

| El cliente pasa | Lo que detecta el bot | DocTipo | Condición IVA | Emisor RI | Emisor Mono/Exento |
|---|---|---|---|---|---|
| Nada (< tope) | Anónimo | 99 | 5 Cons. Final | B | C |
| DNI | 7-8 dígitos | 96 | 5 Cons. Final | B | C |
| 11 dígitos sin alta | Padrón vacío = CUIL | 86 | 5 Cons. Final | B | C |
| 11 dígitos Exento | Padrón | 80 | 4 Exento | B | C |
| 11 dígitos Monotributo | Padrón | 80 | 6 Monotributista | A | C |
| 11 dígitos Resp. Inscripto | Padrón | 80 | 1 Resp. Inscripto | A | C |

   - Si el padrón no responde, el bot pregunta la condición del cliente con una lista.
   - Con un DNI, el bot busca si tiene un CUIT activo (prefijos 20/27/23/24) y pregunta: _¿a su CUIT o como consumidor final con DNI?_
4. El bot **anuncia la letra** (_"Le corresponde Factura A: ..."_) y pide lo que exige: razón social y domicilio para CUIT (domicilio obligatorio en la A), nombre para DNI/CUIL (opcional).
5. **Resumen** con botones [Emitir] [Corregir] [Cancelar]. Corregir abre una lista (monto, qué vendiste, cliente, nombre, domicilio).
6. Si ARCA rechaza, se muestran los códigos de error y se vuelve a la lista de corrección. Nada se emite sin confirmar.

Otros comandos: `ayuda`, `últimas`, `cancelar`, `mi empresa`, `empresas`, `nueva empresa`, `cambiar logo`. Citando el PDF con _"anulala"_ se emite la Nota de Crédito.

**Factura de Crédito Electrónica MiPyME:** con cada cliente CUIT el bot consulta `wsfecred.consultarMontoObligadoRecepcion`. Si está obligado y el total supera el mínimo, emite FCE A/B/C (201/206/211) con el CBU de la empresa (opcional 2101, se pide una vez y se guarda), la opción de transferencia SCA (opcional 27) y el vencimiento del pago. Si el servicio no responde, se emite la factura común con un aviso en el resumen. Las FCE no se anulan automáticamente con Nota de Crédito.

### Servicios que hay que autorizar al certificado (WSASS en homologación / Administrador de Relaciones en producción)
| Servicio | Para qué | Sin él |
|---|---|---|
| `wsfe` | Emitir comprobantes | No se puede facturar |
| `ws_sr_constancia_inscripcion` | Padrón: condición IVA, nombre y domicilio del CUIT; CUIT de un DNI | El bot pregunta la condición (solo la primera vez por cliente) |
| `wsfecred` | Saber si corresponde Factura de Crédito MiPyME | Factura común + aviso en el resumen |

### Puesta en marcha
1. App de WhatsApp en [developers.facebook.com](https://developers.facebook.com): `WHATSAPP_ACCESS_TOKEN` (token permanente de System User) y `WHATSAPP_PHONE_NUMBER_ID`.
2. Completar el `.env` (ver `.env.example`). MySQL tiene que estar corriendo.
3. Exponer el puerto con HTTPS (devtunnels / ngrok) y configurar el webhook en Meta: `https://TU-DOMINIO/webhooks/whatsapp`, campo **messages**.
4. `npm run dev` y escribirle al bot desde un número de `WHATSAPP_ALLOWED_NUMBERS`.

Para el padrón, el certificado necesita el servicio `ws_sr_constancia_inscripcion` (en homologación, desde WSASS). Sin él el bot funciona igual: pregunta la condición IVA.

Prueba offline (usa una base MySQL temporal, sin ARCA/WhatsApp/Gemini): `npm run test:whatsapp`.

### Limitaciones
- El lock de emisión es en memoria: pensado para **una sola instancia**. Para varias, reemplazar `src/utils/keyed-mutex.ts` por un lock en Redis.

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

## API REST

Todas las rutas `/api/*` exigen el header `X-API-Key` (valor de `API_KEY`). Para elegir la empresa emisora
se usa el header `X-Empresa-Cuit`; sin él se usa la primera empresa registrada.

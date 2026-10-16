'use client'

/**
 * RACKLY — Impresión de rótulos en impresora ZEBRA (ZT411 y compatibles).
 *
 * CONEXIÓN (Zebra Browser Print, middleware oficial gratuito):
 *   El navegador NO puede hablar USB directo con la impresora (en Windows el
 *   driver se apropia del dispositivo). La vía soportada es "Zebra Browser
 *   Print": un pequeño programa que corre en la PC donde está conectada la
 *   ZT411 (USB) y expone un servidor local:
 *
 *     · GET  http://localhost:9100/available  → impresoras visibles
 *     · GET  http://localhost:9100/default    → impresora por defecto
 *     · POST http://localhost:9100/write      → envía ZPL crudo
 *
 *   SEGURIDAD DEL NAVEGADOR (importante): desde un sitio HTTPS público
 *   (rackly.pages.dev) Chrome/Edge aplican la política "Private/Local
 *   Network Access" sobre las peticiones a loopback (localhost/127.0.0.1).
 *   Para que la conexión pase hacen falta DOS cosas:
 *
 *     1. Browser Print ACTUALIZADO: el middleware debe responder el
 *        preflight (OPTIONS) con la cabecera
 *        `Access-Control-Allow-Private-Network: true`. Las versiones
 *        antiguas no lo hacen y Chrome bloquea el fetch con:
 *        "Permission was denied for this request to access the `loopback`
 *        address space".
 *     2. PERMISO del usuario: Chrome 142+ pide permiso de "Dispositivos de
 *        red local" para el sitio (prompt, o
 *        chrome://settings/content/localNetworkAccess). Si se deniega,
 *        TODOS los fetch a loopback fallan con el mismo error.
 *
 *   El app no puede saltarse esa política (es seguridad del navegador, no
 *   es un bug). Por eso la detección reporta el MOTIVO de la falla y la UI
 *   guía al usuario; el Plan B (.zpl con Zebra Setup Utilities) siempre
 *   queda disponible sin permisos.
 *
 * LENGUAJE: ZPL II con ^CI28 (UTF-8) para tildes/ñ. Etiqueta APaisada
 * 15 × 10 cm (formato PERECIBLE de la empresa, plantilla
 * "ETIQUETA ALMACEN insumos.xlsm") impresa GIRADA 90° horario sobre la
 * tira física 10 × 15 cm (800 × 1200 dots @203 dpi): la ZT411 tiene
 * cabezal de 4" (104 mm), así que 15 cm de ancho solo se logran girando
 * el diseño; al despegar el rótulo se lee horizontal.
 *
 * FALLBACK: sin el middleware, el app genera un archivo .zpl descargable
 * que se imprime con Zebra Setup Utilities (arrastrar y enviar).
 *
 * QR DE GUÍA (pedido 2026-10): cada rótulo lleva un QR (ZPL nativo ^BQ —
 * la impresora lo dibuja, sin librerías) en la ESQUINA IZQUIERDA de la
 * banda del código, separado por una línea límite. Codifica la identidad
 * de la guía + el artículo (ver qr-rotulo.ts) para que el módulo TRÁNSITO
 * escanee el rótulo y abra la transferencia a Rack/Piso. Con el QR a la
 * izquierda, el código del artículo se imprime MÁS GRANDE (tope 215 dots
 * vs 190 anterior) centrado a la derecha del límite.
 */

import { construirPayloadQR } from '@/lib/rackly/qr-rotulo'

// ═══════════════════════════════════════════════════════════════════
// 1. TIPOS
// ═══════════════════════════════════════════════════════════════════

/** Dispositivo que devuelve Zebra Browser Print. */
export type ImpresoraZebra = {
  name: string
  deviceType: string
  connection: string
  uid: string
  provider?: string
  manufacturer?: string
  version?: number
}

/**
 * Por qué no se pudo contactar al servicio local. Sirve para que la UI
 * muestre la guía correcta en lugar de un genérico "instala el programa".
 */
export type MotivoFallaZebra =
  | 'ok'
  | 'permiso-bloqueado' // Chrome/Edge denegó el acceso del sitio a la red local (PNA/LNA)
  | 'sin-servicio' // Browser Print no está instalado, no corre, o es una versión vieja sin soporte PNA

/** Resultado de la detección del middleware local. */
export type ResultadoDeteccionZebra = {
  /** Base que respondió (p. ej. http://localhost:9100); null si ninguna. */
  base: string | null
  /** Causa del resultado, para la guía de la UI. */
  motivo: MotivoFallaZebra
}

/** Datos que porta un rótulo (1 artículo de la recepción). */
export type DatosRotulo = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  /** Marca "Paleta i/N" cuando el artículo se DIVIDIÓ (opcional). */
  paleta?: string
}

/** Encabezado compartido por los rótulos de una recepción.
 *  El formato PERECIBLE de la empresa no lo imprime; se conserva en la
 *  firma de las funciones por compatibilidad con las 2 vías de registro.
 *  `guiaId` (opcional, 2026-10): identidad EXACTA de la guía — alimenta el
 *  QR del rótulo cuando llega vía `qr` (ver construirZPLRotulos). */
export type EncabezadoRotulo = {
  fecha: string
  numeroDocumento: string
  proveedor: string
  placa: string
  registradoPor?: string
  guiaId?: string | null
}

// ═══════════════════════════════════════════════════════════════════
// 2. CLIENTE ZEBRA BROWSER PRINT
// ═══════════════════════════════════════════════════════════════════

/** Bases locales a sondear, en orden de preferencia. */
const BASES_ZEBRA = ['http://localhost:9100', 'http://127.0.0.1:9100', 'https://localhost:9101']

const TIMEOUT_MS = 2500

let baseActiva: string | null = null

function abortar(ms: number): { signal: AbortSignal; limpiar: () => void } {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, limpiar: () => clearTimeout(t) }
}

/**
 * Estado del permiso de "Dispositivos de red local" (Chrome 142+/Edge) para
 * el sitio actual. Devuelve null si el navegador no lo expone: en ese caso
 * la UI muestra ambas causas posibles sin afirmar cuál es.
 */
async function estadoPermisoRedLocal(): Promise<PermissionState | null> {
  try {
    const perms = navigator.permissions
    if (!perms?.query) return null
    const st = await perms.query({ name: 'local-network-access' as PermissionName })
    return st.state
  } catch {
    // Nombre de permiso desconocido en este navegador → sin señal.
    return null
  }
}

/**
 * Prueba las bases locales y devuelve la primera que responde. Si ninguna
 * responde, clasifica el motivo: permiso de red local denegado (Chrome lo
 * indica en su API de permisos) o servicio ausente/viejo.
 */
export async function detectarServicioZebra(): Promise<ResultadoDeteccionZebra> {
  for (const base of BASES_ZEBRA) {
    try {
      const { signal, limpiar } = abortar(TIMEOUT_MS)
      try {
        const res = await fetch(`${base}/available`, { signal })
        if (res.ok) {
          baseActiva = base
          return { base, motivo: 'ok' }
        }
      } finally {
        limpiar()
      }
    } catch {
      // Esta base no responde o fue bloqueada por el navegador; seguir.
    }
  }
  baseActiva = null
  const permiso = await estadoPermisoRedLocal()
  return {
    base: null,
    motivo: permiso === 'denied' ? 'permiso-bloqueado' : 'sin-servicio',
  }
}

/**
 * Lista las impresoras visibles por Browser Print. La respuesta del servicio
 * es un objeto con UNA propiedad cuyo valor es el array de dispositivos
 * (p. ej. {"printer":[…]}); se aplana sin depender del nombre de la clave.
 */
export async function descubrirImpresorasZebra(): Promise<ImpresoraZebra[]> {
  const base = baseActiva ?? (await detectarServicioZebra()).base
  if (!base) return []
  try {
    // FIX auditoría 2026-10-16: timeout de 5 s — si Browser Print acepta la
    // conexión pero no responde, el fetch quedaba colgado para siempre y el
    // modal se clavaba en "Buscando…" sin recuperación (ni Reintentar).
    const res = await fetch(`${base}/available`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return []
    const data: unknown = await res.json()
    const dispositivos: ImpresoraZebra[] = []
    if (data && typeof data === 'object') {
      for (const valor of Object.values(data as Record<string, unknown>)) {
        if (Array.isArray(valor)) {
          for (const d of valor) {
            if (d && typeof d === 'object' && 'uid' in d && 'name' in d) {
              dispositivos.push(d as ImpresoraZebra)
            }
          }
        }
      }
    }
    return dispositivos.filter((d) => (d.deviceType || 'printer').toLowerCase().includes('printer'))
  } catch {
    return []
  }
}

/** Impresora marcada como por defecto en Browser Print (o null). */
export async function obtenerImpresoraDefaultZebra(): Promise<ImpresoraZebra | null> {
  const base = baseActiva ?? (await detectarServicioZebra()).base
  if (!base) return null
  try {
    // FIX auditoría 2026-10-16: mismo timeout de 5 s que descubrirImpresorasZebra.
    const res = await fetch(`${base}/default?type=printer`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const texto = await res.text()
    if (!texto.trim()) return null
    const d = JSON.parse(texto) as ImpresoraZebra
    return d && d.uid ? d : null
  } catch {
    return null
  }
}

/**
 * Envía ZPL crudo a la impresora (POST /write con {device, data}).
 * `device` va TAL CUAL lo entregó el discovery (el servicio reconoce sus
 * propios campos); solo completa `version` si falta.
 */
export async function enviarZPL(impresora: ImpresoraZebra, zpl: string): Promise<void> {
  const base = baseActiva ?? (await detectarServicioZebra()).base
  if (!base) {
    throw new Error(
      'Zebra Browser Print no responde. Si el programa está instalado: actualízalo a la última versión ' +
        '(zebra.com/browserprint) y concede a este sitio el permiso de "Dispositivos de red local" ' +
        '(ícono junto a la dirección en Chrome). Plan B: descarga el .zpl.'
    )
  }
  const device: ImpresoraZebra = { ...impresora, version: impresora.version ?? 2 }
  // Timeout: sin signal, un Browser Print que acepta la conexión y no responde
  // dejaba `imprimiendo=true` indefinidamente (botón bloqueado, sin feedback).
  // 15s: la impresión local tarda ms; si no responde en 15s, no va a responder.
  const { signal, limpiar } = abortar(15000)
  try {
    const res = await fetch(`${base}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ device, data: zpl }),
      signal,
    })
    if (!res.ok) {
      throw new Error(`La impresora rechazó la impresión (HTTP ${res.status}).`)
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        'La impresión no respondió en 15 segundos. Verifica que la impresora esté encendida y conectada, y vuelve a intentar.'
      )
    }
    throw err
  } finally {
    limpiar()
  }
}

// ═══════════════════════════════════════════════════════════════════
// 3. GENERADOR DE ZPL (rótulo de recepción)
// ═══════════════════════════════════════════════════════════════════

/**
 * Limpia datos del usuario para ZPL: ^ y ~ son prefijos de comando y un
 * backslash puede escapar el siguiente byte. Se reemplazan por espacio.
 */
export function sanearZPL(texto: string): string {
  return texto
    .replace(/[\^\~\\]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
}

/** Fecha ISO (yyyy-mm-dd) → dd/mm/yyyy, formato compacto para la etiqueta. */
function fechaCorta(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : sanearZPL(iso)
}

/** Ancho FÍSICO del rollo (10 cm @203 dpi). Eje que no puede crecer. */
const ANCHO_FISICO = 800

/**
 * Ancho VISUAL de la zona QR en la banda del código (esquina izquierda):
 * 240 dots (2.98 cm) con el QR centrado y su zona de silencio (quiet zone
 * ≥ 4 módulos) holgada, separada del texto por una línea límite.
 */
const ZONA_QR_ANCHO = 240

/** Contexto de guía para el QR del rótulo (identidad de la guía impresa). */
export type ContextoQR = { guiaId?: string | null; numeroDocumento?: string }

/**
 * Payload del QR del rótulo. Null si la guía no tiene NINGUNA identidad
 * (sin guia_id y sin Nº de documento): el rótulo sale SIN QR (degradación
 * graceful — un QR que no resuelve a nada no debe imprimirse jamás).
 */
export function payloadQRRotulo(datos: DatosRotulo, ctx: ContextoQR): string | null {
  const guiaId = (ctx.guiaId ?? '').trim()
  const numeroDocumento = (ctx.numeroDocumento ?? '').trim()
  if (!guiaId && !numeroDocumento) return null
  // "Paleta i/N" → nº de paleta para el QR (P<i>): Tránsito preselecciona
  // la paleta exacta al escanear.
  const mPaleta = datos.paleta ? /Paleta\s+(\d+)/i.exec(datos.paleta) : null
  const nPaleta = mPaleta ? Number(mPaleta[1]) : null
  return construirPayloadQR({
    guiaId,
    numeroDocumento,
    codigo: sanearZPL(datos.codigo),
    paleta: nPaleta != null && Number.isFinite(nPaleta) ? nPaleta : null,
  })
}

/**
 * Módulos (versión) del QR según el largo del payload — tabla de capacidad
 * BYTE con EC 'Q' CONSERVADORA (el encoder real puede elegir una versión
 * MENOR — caben más bytes — nunca una mayor que esta tabla + 4 módulos).
 * CALIBRADO con render Labelary (2026-10-17): el campo ^BQ renderiza el
 * símbolo SIN quiet zone interna — el lado real es módulos × mag; el
 * margen alrededor lo da el espacio en blanco de la etiqueta.
 */
function modulosQR(len: number): number {
  if (len <= 32) return 29 // versión 3
  if (len <= 46) return 33 // versión 4
  if (len <= 60) return 37 // versión 5
  if (len <= 72) return 41 // versión 6
  if (len <= 84) return 45 // versión 7
  return 49 // versión 8 (tope práctico del payload)
}

/**
 * ZPL del QR centrado en la esquina izquierda de la banda del código.
 * EC 'Q' (25% de recuperación): rótulos que pasan por manos y polvo.
 * `^FDQA,` = EC Q + modo A (automático): el dato va codificado tal cual.
 *
 * POSICIÓN (lección calibrada con render — bug 2026-10-17): la caja del
 * QR en VISUAL es (m..m+lado) × (m..m+lado) con m = (240−lado)/2. Como el
 * campo NO rota (el QR es simétrico), en FÍSICO:
 *   · y físico  = X_vis izquierdo            = m
 *   · x físico  = 800 − Y_vis superior       = 800 − (m + lado)
 * (usar `800 − ZONA + m` dejaba el símbolo pegado a la línea inferior de
 * la banda en el espacio físico — quiet zone destruida, QR ilegible).
 */
function campoQR(payload: string): string {
  const mods = modulosQR(payload.length)
  // Peor caso: el encoder puede elegir UNA versión más (+4 módulos).
  // Con ese peor caso garantiza ≥ 24 dots de margen por lado (la quiet
  // zone de 4 módulos a mag ≤ 6 son ≤ 24 dots).
  const mag = Math.max(3, Math.min(6, Math.floor((ZONA_QR_ANCHO - 48) / (mods + 4))))
  const ladoEsp = mods * mag
  const margen = Math.floor((ZONA_QR_ALTO_BANDA - ladoEsp) / 2)
  const xFis = ANCHO_FISICO - margen - ladoEsp
  return `^FO${xFis},${margen}^BQN,2,${mag}^FDQA,${payload}^FS`
}

/** Alto visual de la banda del código (el QR se centra en él). */
const ZONA_QR_ALTO_BANDA = 240

/**
 * Caja de borde en coordenadas VISUALES apaisadas (x0,y0)-(x1,y1) sobre el
 * lienzo 1200 × 800 → comando ^GB en coordenadas físicas. Los ^GB no se
 * giran con el texto: se transforman aquí, en un solo lugar.
 */
function cajaApaisada(x0: number, y0: number, x1: number, y1: number, grosor = 3): string {
  return `^FO${ANCHO_FISICO - y1},${x0}^GB${y1 - y0},${x1 - x0},${grosor}^FS`
}

type OpcionesCampoApaisado = {
  /** Si se define, envuelve el texto en ^FB centrado de ese ancho visual. */
  fbAncho?: number
  /** Líneas del ^FB (default 1). */
  fbLineas?: number
  /** Espaciado entre líneas del ^FB (default 0). */
  fbEspacio?: number
  /** "Negrita" simulada: 2ª pasada a 2 dots en el flujo del texto. */
  negrita?: boolean
}

/**
 * Campo de texto ROTADO 90° horario (^A0R). `x0,y0` = esquina superior
 * izquierda VISUAL de la CELDA del glifo en el lienzo apaisado; el texto
 * fluye hacia la derecha visual (+Y físico) y la celda crece hacia abajo
 * visual (−X físico). CALIBRADO con render Labelary: en ZPL, el ^FO de un
 * campo girado es la esquina superior-izquierda en el marco FÍSICO, o sea
 * la esquina inferior-izquierda VISUAL de la celda → para que la celda
 * ocupe y_v ∈ [y0, y0+alto] hay que restar `alto`:
 *   ^FO(800 − y0 − alto, x0)
 * Devuelve 1 línea (o 2 si `negrita`).
 */
function campoApaisado(
  x0: number,
  y0: number,
  alto: number,
  anchoGlifo: number,
  texto: string,
  ops: OpcionesCampoApaisado = {}
): string[] {
  const fb = ops.fbAncho
    ? `^FB${ops.fbAncho},${ops.fbLineas ?? 1},${ops.fbEspacio ?? 0},C`
    : ''
  const pasadas = ops.negrita ? [0, 2] : [0]
  const xFis = ANCHO_FISICO - y0 - alto
  return pasadas.map(
    (dx) => `^FO${xFis},${x0 + dx}^A0R,${alto},${anchoGlifo}${fb}^FD${texto}^FS`
  )
}

/**
 * Rótulo de RECEPCIÓN en ZPL II — FORMATO PERECIBLE de la empresa,
 * replicado desde "ETIQUETA ALMACEN insumos.xlsm" (hoja PERECIBLE),
 * en orientación HORIZONTAL (apaisada 15 × 10 cm).
 *
 * La tira física sigue siendo 10 × 15 cm (800 × 1200 dots @203 dpi) — la
 * ZT411 no puede imprimir más de 104 mm de ancho — así que el diseño se
 * dibuja en un LIENZO APAISADO de 1200 (ancho visual) × 800 (alto visual)
 * dots y se imprime GIRADO 90° HORARIO dentro de la tira:
 *
 *   · flujo del texto (visual → derecha)  ⇒ avance del rollo (+Y físico)
 *   · altura del glifo (visual ↓ abajo)   ⇒ hacia el borde izquierdo (−X físico)
 *   · origen ^FO del campo = (800 − y_visual_sup, x_visual_izq)
 *
 * Al despegar el rótulo y girarlo 90° ANTIHORARIO se lee horizontal:
 *
 *   ┌──────────┬───────────────────────────────────────────────┐ Y 0
 *   │ ▓▓ QR ▓▓ │                    49310                      │  código 0..240
 *   ├──────────┴───────────────────────────────────────────────┤
 *   │   LAMINA TERMOCONTRABLE 380 MM X 50 µ  (1-2 líneas)        │  desc 240..400
 *   ├────────────┬───────────────────────────────────────────────┤
 *   │   LOTE:    │                0869051017                     │  lote 400..545
 *   ├─────┬──────┴────────┬───────┬────────────────────┬─────────┤ 545
 *   │ F.P │  23/07/2026   │ CANT: │       193320       │   UN    │
 *   │ F.V │  22/07/2027   │       │                    │         │
 *   └─────┴───────────────┴───────┴────────────────────┴─────────┘ 792
 *     X: 0  170            420     540                1060    1200
 *
 * FIDELIDAD al formato de la empresa:
 *   · SIN código de barras (el original es solo texto) — PERO con QR de
 *     guía a la izquierda (2026-10, para el lector de Tránsito) y el
 *     código de artículo agrandado a la derecha del límite.
 *   · SIN guía/placa/proveedor/fecha de recepción (no están en la plantilla;
 *     `encabezado` queda en la firma por compatibilidad, no se imprime).
 *   · Todas las cajas con borde, textos centrados, "negrita" simulada
 *     (doble pasada a 2 dots en el flujo) en código, lote y cantidad.
 *   · Campos vacíos (lote/fechas) salen en blanco, como en la plantilla.
 *
 * DPI: la ZT411 estándar es 203 dpi (8 dots/mm). Si la suya fuera 300 dpi,
 * la etiqueta sale al ~68% del tamaño (avisar para reescalar).
 */
export function construirZPLRotulo(
  datos: DatosRotulo,
  encabezado: EncabezadoRotulo,
  opciones?: { copias?: number; /** Contexto del QR de guía (opcional). */ qr?: ContextoQR }
): string {
  const copias = Math.max(1, Math.min(999, Math.round(opciones?.copias ?? 1)))

  const codigo = sanearZPL(datos.codigo)
  const descripcion = sanearZPL(datos.descripcion)
  const cantidad = sanearZPL(datos.cantidad)
  const unidad = sanearZPL(datos.unidad)
  const lote = sanearZPL(datos.lote)
  const paleta = datos.paleta ? sanearZPL(datos.paleta) : ''
  const fProd = datos.fechaProduccion ? fechaCorta(datos.fechaProduccion) : ''
  const fVenc = datos.fechaVencimiento ? fechaCorta(datos.fechaVencimiento) : ''

  // ── Geometría ──
  // Tira física: 800 (ancho, 10 cm) × 1200 (avance, 15 cm) dots @203dpi.
  // Diseño APaisado 1200 × 800 girado 90° horario (ver diagrama arriba).
  // Bandas visuales (Y): código 0-240 · descripción 240-400 ·
  //   lote 400-545 · inferior 545-792 (fechas 2 filas de 123).
  // Columnas visuales del bloque inferior (X): F.P/F.V 0-170 ·
  //   fechas 170-420 · CANT: 420-540 · cantidad 540-1060 · UM 1060-1200.
  // SIN ^LH: el label home por defecto es (0,0) (un ^LH desplaza TODOS los
  // ^FO y saca los bordes del área imprimible — verificado con render).

  const lineas: string[] = []
  lineas.push('^XA')
  lineas.push('^CI28') // UTF-8: tildes y ñ (p. ej. "DISEÑO")
  lineas.push('^PW800')
  lineas.push('^LL1200')

  // Marco exterior (físicamente idéntico al formato vertical anterior)
  lineas.push(cajaApaisada(0, 0, 1200, 800, 3))

  // ── 1) BANDA CÓDIGO (Y 0..240): QR de guía a la IZQUIERDA + código ──
  // Cuando hay identidad de guía el QR ocupa la esquina izquierda (zona
  // 0..280 cerrada con línea separadora — el "límite" del formato) y el
  // código, MÁS GRANDE que antes (tope 215 vs 190 dots), se centra en el
  // resto. Sin identidad (rótulo sin QR) el código usa el ancho completo.
  // El alto se AUTO-AJUSTA a la longitud: el catálogo hoy usa 3-5 dígitos
  // (cabe a 215 dots); con códigos largos se reduce proporcionalmente
  // (holgura 0.62: margen del avance real 0.6 × alto) y queda centrado.
  const payloadQR = payloadQRRotulo(datos, {
    guiaId: opciones?.qr?.guiaId ?? encabezado.guiaId,
    numeroDocumento: opciones?.qr?.numeroDocumento ?? encabezado.numeroDocumento,
  })
  lineas.push(cajaApaisada(0, 0, 1200, 240, 3))
  if (payloadQR) {
    // Línea separadora: límite derecho de la zona QR (borde del boceto).
    lineas.push(cajaApaisada(ZONA_QR_ANCHO - 3, 0, ZONA_QR_ANCHO, 240, 2))
    lineas.push(campoQR(payloadQR))
  }
  if (codigo) {
    const anchoTexto = payloadQR ? 926 : 1152
    const xTexto = payloadQR ? 250 : 24
    const alto = altoParaCaja(codigo, anchoTexto, 215, 90, 0.62)
    const y = Math.floor((240 - alto) / 2) - 10
    lineas.push(...campoApaisado(xTexto, y, alto, Math.round(alto * 0.6), codigo, { fbAncho: anchoTexto, negrita: true }))
  }

  // ── 2) DESCRIPCIÓN — banda visual Y 240..400 (1-2 líneas, centrada) ──
  lineas.push(cajaApaisada(0, 240, 1200, 400, 3))
  if (descripcion) {
    // En apaisado el renglón es ancho (1152 dots). Cadena de decisión con
    // avance conservador (0.5 × ancho de glifo, calibrado con Labelary):
    //   1) fuente 58 si cabe en 1 renglón (≤ ~54 chars)
    //   2) fuente 48 si cabe en 1 renglón (≤ ~65 chars)
    //   3) fuente 48 en 2 renglones (el ^FB trunca si > ~130 chars)
    const anchoLinea = 1152
    const cabe58 = descripcion.length * 0.5 * 42 <= anchoLinea
    const cabe48 = descripcion.length * 0.5 * 35 <= anchoLinea
    const dosLineas = !cabe58 && !cabe48
    const alto = cabe58 ? 58 : 48
    const anchoGlifo = cabe58 ? 42 : 35
    const altoBloque = dosLineas ? 2 * Math.round(alto * 1.15) + 10 : Math.round(alto * 1.15)
    const y = 240 + Math.floor((160 - altoBloque) / 2)
    lineas.push(
      ...campoApaisado(24, y, alto, anchoGlifo, descripcion, {
        fbAncho: anchoLinea,
        fbLineas: dosLineas ? 2 : 1,
        fbEspacio: 10,
      })
    )
  }

  // ── 3) LOTE — banda visual Y 400..545 ──
  // Si el rótulo es de UNA PALETA (artículo dividido), el extremo derecho
  // de la banda lleva la marca "Paleta i/N" (caja propia 950..1200) y el
  // valor del lote se acorta a 700 dots — el operario ve de un vistazo
  // qué paleta es sin leer observaciones.
  lineas.push(cajaApaisada(0, 400, 250, 545, 3)) // caja "LOTE:"
  lineas.push(cajaApaisada(250, 400, paleta ? 950 : 1200, 545, 3)) // caja valor
  if (paleta) lineas.push(cajaApaisada(950, 400, 1200, 545, 2)) // caja paleta
  lineas.push(...campoApaisado(0, 400 + Math.floor((145 - 66) / 2), 66, 50, 'LOTE:', { fbAncho: 250 }))
  if (lote) {
    const anchoValor = paleta ? 700 : 950
    const alto = altoParaCaja(lote, anchoValor, 92)
    const y = 400 + Math.floor((145 - alto) / 2)
    lineas.push(...campoApaisado(250, y, alto, Math.round(alto * 0.6), lote, { fbAncho: anchoValor, negrita: true }))
  }
  if (paleta) {
    const altoP = altoParaCaja(paleta, 250, 56, 28)
    const yP = 400 + Math.floor((145 - altoP) / 2)
    lineas.push(...campoApaisado(950, yP, altoP, Math.round(altoP * 0.6), paleta, { fbAncho: 250 }))
  }

  // ── 4) Bloque inferior: F.P / F.V · CANT · UM — banda visual Y 545..792 ──
  // Cajas: fechas (2 filas apiladas) · cantidad (alta) · UM (alta).
  lineas.push(cajaApaisada(170, 545, 420, 668, 2)) // fecha F.P
  lineas.push(cajaApaisada(170, 668, 420, 792, 2)) // fecha F.V
  lineas.push(cajaApaisada(540, 545, 1060, 792, 2)) // cantidad
  lineas.push(cajaApaisada(1060, 545, 1200, 792, 2)) // UM

  // Etiquetas F.P / F.V (sin caja, como la plantilla)
  lineas.push(...campoApaisado(14, 545 + Math.floor((123 - 56) / 2), 56, 44, 'F.P'))
  lineas.push(...campoApaisado(14, 668 + Math.floor((124 - 56) / 2), 56, 44, 'F.V'))

  // Fechas (centradas en su caja; 10 caracteres a ancho 30 ≈ 165 dots < 226)
  lineas.push(...campoApaisado(170, 545 + Math.floor((123 - 42) / 2), 42, 30, fProd, { fbAncho: 250 }))
  lineas.push(...campoApaisado(170, 668 + Math.floor((124 - 42) / 2), 42, 30, fVenc, { fbAncho: 250 }))

  // CANT: (centrado vertical del bloque inferior; 5 glifos a ancho 34 ≈ 94 < 120)
  lineas.push(...campoApaisado(420, 545 + Math.floor((247 - 42) / 2), 42, 34, 'CANT:', { fbAncho: 120 }))

  // Cantidad (grande, "demi", auto-ajustada a su caja)
  if (cantidad) {
    const alto = altoParaCaja(cantidad, 520, 110)
    const y = 545 + Math.floor((247 - alto) / 2)
    lineas.push(...campoApaisado(540, y, alto, Math.round(alto * 0.6), cantidad, { fbAncho: 520, negrita: true }))
  }

  // Unidad de medida (grande, centrada)
  if (unidad) {
    const alto = altoParaCaja(unidad, 140, 80)
    const y = 545 + Math.floor((247 - alto) / 2)
    lineas.push(...campoApaisado(1060, y, alto, Math.round(alto * 0.6), unidad, { fbAncho: 140 }))
  }

  lineas.push(`^PQ${copias},0,0,N`)
  lineas.push('^XZ')
  return lineas.join('\n')
}

/**
 * Alto de fuente (font 0) para que `texto` quepa en una caja de `anchoCaja`
 * dots. `holgura` (dots de avance por unidad de alto, ~0.58-0.62) permite
 * endurecer el margen para textos largos.
 */
function altoParaCaja(texto: string, anchoCaja: number, max: number, min = 34, holgura = 0.58): number {
  const len = Math.max(1, texto.length)
  return Math.max(min, Math.min(max, Math.floor((anchoCaja - 24) / (holgura * len))))
}

/**
 * Construye el ZPL de VARIOS rótulos (uno por artículo), cada uno con su
 * cantidad de copias. `rotulos[i]` se empareja con `copias[i]`.
 * REIMPRESIÓN PARCIAL (pedido 2026-10): copias 0 = ESE rótulo no se imprime
 * (se omite el bloque completo — nunca sale un ^PQ0). Los que quedan en 0
 * no afectan a los demás: "quiero solo algunos artículos" se resuelve
 * poniendo 0 en el resto.
 * `qr` (opcional): identidad de la guía para el QR de cada rótulo —
 * ImprimirRotulosDialog la toma de `refDocumento`; si falta, el rótulo
 * sale sin QR (nunca un QR que no resuelve).
 */
export function construirZPLRotulos(
  rotulos: DatosRotulo[],
  copias: number[],
  encabezado: EncabezadoRotulo,
  qr?: ContextoQR
): string {
  return rotulos
    .map((r, i) => ({ r, copias: copias[i] ?? 1 }))
    .filter(({ copias }) => Number.isFinite(copias) && copias > 0)
    .map(({ r, copias }) => construirZPLRotulo(r, encabezado, { copias, qr }))
    .join('\n')
}

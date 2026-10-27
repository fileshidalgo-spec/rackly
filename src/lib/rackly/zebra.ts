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
 * la impresora lo dibuja, sin librerías) en la ESQUINA DERECHA de la
 * banda del código, separado por una línea límite — POSICIÓN según la
 * foto real de la etiqueta anotada a lapicero por el usuario (2026-10-16):
 * "AQUÍ VA QR" a la DERECHA del límite, el código del artículo a la
 * IZQUIERDA. Codifica la identidad de la guía + el artículo (ver
 * qr-rotulo.ts) para que el módulo TRÁNSITO escanee el rótulo y abra la
 * transferencia a Rack/Piso. Con el QR a la derecha, el código del
 * artículo se imprime MÁS GRANDE (tope 215 dots vs 190 anterior)
 * centrado a la izquierda del límite.
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
  /** Empresa que envía la guía (contexto del documento en la ficha). */
  empresaOrigen: string
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
 * DESPLAZAMIENTO DE LA VENTANA DE IMPRESIÓN (pedido 2026-10-28 con foto
 * del sticker real): la tira queda montada ~3 mm corrida respecto al
 * origen del cabezal (juego de la guía de medios) — el borde inferior del
 * diseño (marco y base de la cantidad) caía FUERA del sticker mientras el
 * lado opuesto mostraba ~3 mm de papel en blanco.
 *
 * Equivalente exacto a "correr el espacio de impresión 3 mm a la
 * izquierda": se desplaza el ORIGEN de TODOS los campos (^LH) +24 dots
 * (3 mm @ 8 dots/mm) en el eje del ancho de tira y ^PW se amplía a
 * ANCHO_FISICO + 24 para que el marco reubicado (borde derecho en
 * X 821..823) siga siendo imprimible. El corrimiento es relativo
 * contenido↔sticker: idéntico resultado a mover el papel 3 mm hacia el
 * contenido. Si la impresora se recalibra, basta con volver este valor a 0.
 */
const DESPLAZ_IMPRESION = 24

/**
 * ZONA QR 4 × 4 cm (Task 28, pedido del usuario: "el QR sale borroso,
 * que sea de 4 cm × 4 cm").
 *
 * El QR necesita un CUADRADO de ~320 dots (4 cm @203dpi) + su quiet zone;
 * la banda vieja de 300×240 no alcanza ni de cerca (el símbolo máximo era
 * mag 6 → 2.6 cm). La zona pasa a ser el CUADRANTE superior derecho del
 * lienzo apaisado: X 800..1200 × Y 0..400 (400×400 dots = 5×5 cm), que
 * abarca la banda del código Y la banda de descripción:
 *
 *   ┌───────────────────────────────┬─────────┐ Y 0
 *   │         49310                 │ ▓▓▓▓▓▓▓ │  código 0..240 (texto 0..800)
 *   │                               │ ▓ QR ▓  │
 *   ├───────────────────────────────┤ ▓▓▓▓▓▓▓ │
 *   │  LAMINA TERMOCONTRABLE…       │ ▓ 4cm ▓ │  desc 240..400 (texto 0..800)
 *   └───────────────────────────────┴─────────┘ Y 400 ← lote/fechas IGUAL
 *
 * Consecuencias aceptadas (todo lo demás del rótulo NO cambia):
 *   · La banda del código se acorta a 0..800 → el código gigante baja de
 *     em 286 a em 234 para 5 dígitos (sigue siendo la fuente dominante).
 *   · La descripción se centra en 0..800: hasta ~42 chars en 1 renglón y
 *     ~85 en 2 (antes 65/130) — con degradación a fuente 38 si excede.
 *   · Lote, paleta, F.P/F.V, CANT y UM no se tocan (empiezan en Y ≥ 400).
 */
const ZONA_QR_LADO = 400

/**
 * X visual del LÍMITE (= línea separadora). El código y la descripción
 * quedan 0..800 y el QR 800..1200.
 */
const X_ZONA_QR = 1200 - ZONA_QR_LADO

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
 * Módulos (versión) del QR según el largo del payload — capacidades BYTE
 * para EC 'Q' (modo byte) con frontera CONSERVADORA: caps ISO/IEC 18004
 * (v3=32 · v4=46 · v5=62 · v6=76 · v7=88 · v8=100) MENOS 1 byte.
 *
 * POR QUÉ −1 (lección del Task 10): el encoder REAL (Labelary y firmware)
 * mandó un payload de 62 bytes a v6 aunque la ISO declara cap 62 para v5-Q
 * (verificado en render: 61 bytes → v5, 62 bytes → v6). Si la tabla creyera
 * 62→v5 y el encoder eligiera v6, la magnificación quedaría calculada para
 * un símbolo de 37 módulos y el real saldría de 41 — se come la quiet zone.
 * Con la frontera −1, el mods de la tabla SIEMPRE ≥ el del encoder: el
 * símbolo real nunca excede el planeado (crece hacia adentro, jamás hacia
 * las líneas) y en el caso dominante (61 bytes: uuid+doc+código) sigue
 * clasificando v5 → mag 5, lado 185.
 */
function modulosQR(len: number): number {
  if (len <= 31) return 29 // versión 3
  if (len <= 45) return 33 // versión 4
  if (len <= 61) return 37 // versión 5
  if (len <= 75) return 41 // versión 6
  if (len <= 87) return 45 // versión 7
  return 49 // versión 8 (tope práctico del payload)
}

/**
 * Interior utilizable de la zona QR: la caja exterior de 400 se come 3
 * dots de línea por lado (marco del rótulo y separadora).
 */
const INTERIOR_QR = ZONA_QR_LADO - 2 * 3

/**
 * ZPL del QR 4 × 4 cm centrado en el CUADRANTE superior derecho
 * (X_ZONA_QR..1200 × Y 0..400 visual).
 * EC 'Q' (25% de recuperación): rótulos que pasan por manos y polvo.
 * `^FDQA,` = EC Q + modo A (automático): el dato va codificado tal cual.
 *
 * TAMAÑO (Task 28): la magnificación apunta a un SÍMBOLO de ~320 dots
 * (4 cm @203 dpi) — mag = ⌊394/(mods+6)⌋, recortada a 3..10. La cota
 * garantiza quiet zone ≥ 3 módulos por lado dentro del interior:
 *   margen = (394 − mods×mag)/2 ≥ 3×mag  ⟺  mag ≤ 394/(mods+6)
 * Resultado por versión (lado del símbolo en cm):
 *   v3 29→mag10 (3.6) · v4 33→mag10 (4.1) · v5 37→mag9 (4.1 — DOMINANTE:
 *   uuid+guía+código) · v6 41→mag8 (4.0) · v7 45→mag7 (3.9) · v8 49→mag7
 *   (4.2). Todos ≥ 3.5 cm y el dominante clava el "4 × 4 cm" pedido.
 *
 * POSICIÓN (mapeo apaisado — el campo NO rota, el QR es simétrico):
 *   · y físico = X_vis izquierdo     = X_ZONA_QR + 3 + margen
 *   · x físico = 800 − Y_vis superior = 800 − (3 + margen + lado)
 * (lección 2026-10-17: usar `800 − ZONA + m` pegaba el símbolo a la línea
 * y destruía la quiet zone — mantener siempre el mapeo por esquinas).
 */
function campoQR(payload: string): string {
  const mods = modulosQR(payload.length)
  const mag = Math.max(3, Math.min(10, Math.floor(INTERIOR_QR / (mods + 6))))
  const ladoEsp = mods * mag
  const margen = Math.floor((INTERIOR_QR - ladoEsp) / 2)
  const yVisSup = 3 + margen // desde el borde superior visual (Y 0)
  const xVisIzq = X_ZONA_QR + 3 + margen // desde el límite (línea en X_ZONA_QR)
  const xFis = ANCHO_FISICO - yVisSup - ladoEsp
  const yFis = xVisIzq
  return `^FO${xFis},${yFis}^BQN,2,${mag}^FDQA,${payload}^FS`
}

/** Centro visual de la banda del código (Y 0..240). */
const CENTRO_BANDA_CODIGO = 120

/**
 * Centrado de la TINTA del código en su banda — CALIBRADO con render
 * Labelary + medición OpenCV (2026-10-17, ^A0R dígitos con negrita):
 * la tinta de los dígitos ocupa de −0.0102×em (los capcales llegan casi
 * AL TOPE de la celda, ±3 dots de AA) hasta 0.7611×em (la baseline deja
 * el resto de aire abajo). Centrar la CAJA
 * (fórmula vieja (240−alto)/2 − 10) dejaba la tinta 33 dots ALTA.
 * El origen de celda para centrar la tinta es y0 = 120 − 0.3755×em.
 * La CAJA puede colgar bajo la banda (es invisible): la tinta de códigos
 * NUMÉRICOS (el catálogo usa dígitos) termina en la baseline. Un código
 * con descendentes (Q, J, coma) podría rozar la línea inferior: hoy no
 * existen en el catálogo.
 */
const TINTA_CENTRO_EM = 0.3755

/**
 * Tope del em del código: la tinta ([y0−0.0102×em, y0+0.7611×em] con
 * y0 = 120 − 0.3755×em) debe quedar ENTRE las líneas de borde de la
 * banda con ≥ 5 dots libres: y0 − 0.0102×em ≥ 8 → em ≤ 286.0 y
 * tinta_inf = 120 + 0.3856×em ≤ 230.3 ≤ 234 ✓. Con QR el ancho (852)
 * limita antes a los códigos de 5+ dígitos: 5 dígitos → em 267 (tinta
 * con 14/14 dots de margen a las líneas, centrada ±0.3).
 */
const TOPE_ALTO_CODIGO = 286

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
  /** "Negrita" simulada: 2ª pasada a 2 dots en el flujo del texto. */
  negrita?: boolean
  /**
   * Ancla por BASELINE (^FT) en vez de por celda (^FO): el valor es la Y
   * visual de la baseline del renglón. Necesario cuando la CELDA es más
   * alta que el espacio disponible bajo el texto: la celda lleva ~24% de
   * zona descendente (vacía en dígitos) que con ^FO obliga a reducir la
   * fuente (y0+alto ≤ 800); con ^FT esa zona vacía cuelga del lienzo y el
   * firmware la recorta sin tinta. Calibrado en render (2026-10-17):
   * baseline B → tinta de dígitos [B−0.7713em, B], centro B−0.3857em (+5
   * de sesgo del motor: B = 663.5 + 0.3857×em centra la tinta a ±4).
   */
  baselineVisual?: number
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
  // ^FB de UNA sola línea: el centrado horizontal del firmware es fiable
  // (código/lote/fechas lo usan); el MULTILÍNEA en texto rotado NO (Task 30:
  // apila hacia arriba y cruzaba las líneas del recuadro) — la descripción
  // nunca debe usarlo: cada renglón es su propio campo (ver layoutDescripcion).
  const fb = ops.fbAncho ? `^FB${ops.fbAncho},1,0,C` : ''
  const pasadas = ops.negrita ? [0, 2] : [0]
  const porBaseline = ops.baselineVisual != null
  const xFis = porBaseline
    ? ANCHO_FISICO - (ops.baselineVisual as number)
    : ANCHO_FISICO - y0 - alto
  const cmd = porBaseline ? 'FT' : 'FO'
  return pasadas.map(
    (dx) => `^${cmd}${xFis},${x0 + dx}^A0R,${alto},${anchoGlifo}${fb}^FD${texto}^FS`
  )
}

// ═══ Descripción: motor de layout DETERMINISTA (Task 30) ═══
// Síntomas que reemplaza (foto del sticker 2026-10-28): descripción en una
// sola línea diminuta (fuente 38 comprimida a celda 28), pegada al separador
// del código y — en la impresora real — CRUZADA por la línea del recuadro.
// Causas: (1) el degradado 48→38 nunca recalculaba el salto de líneas (con
// celda 28 el texto ya cabía en 1 renglón) y la posición y=271 era la de un
// bloque de 2; (2) ^FB multilínea + ^A0R apila el bloque hacia ARRIBA desde
// el ancla (verificado en sondas: la 1ª línea del dato cae en visY 128..240,
// fuera del recuadro) → colisión con la línea límite.
// Solución: partir el texto AQUÍ (1 ó 2 líneas balanceadas), emitir un campo
// por renglón con ^FB de 1 línea y maximizar el tamaño con el modelo de
// tinta calibrado con render (fuente 0, letras, sin negrita):
//   cap-top y0+0.017em · baseline y0+0.763em · descendentes y0+0.933em ·
//   avance 0.504×w medido → 0.55×w de diseño (holgura 9% de firmware).
const DESC_CENTRO_BANDA = 320 // (240 + 400) / 2 — centro visual de la banda
const DESC_ZONA_SUP = 249 // línea superior 240..243 + 6 dots de aire
const DESC_ZONA_INF = 391 // línea inferior 397..400 − 6 dots de aire
const DESC_MARGEN_X = 12 // aire lateral mínimo dentro del bloque ^FB
const DESC_AVANCE = 0.55 // dots de avance por char y por dot de celda
const DESC_RATIO_W = 0.85 // celda ancha = glifo natural legible (no comprimido)
const DESC_CAP = 0.017
const DESC_BASE = 0.763
const DESC_FONDO = 0.933 // con descendentes (µ, minúsculas, Q de cola)
const DESC_PASO_EM = 1.12 // separación entre renglones (×em)
const DESC_EM_MIN = 20

/**
 * Parte `texto` en `n` renglones balanceados por palabras (minimiza el
 * renglón más largo). Devuelve null si no hay palabras suficientes.
 */
function repartirEnLineas(texto: string, n: 1 | 2): string[] | null {
  const palabras = texto.split(' ').filter(Boolean)
  if (!palabras.length) return null
  if (n === 1) return [palabras.join(' ')]
  if (palabras.length < 2) return null
  let mejor: { lineas: string[]; maximo: number } | null = null
  for (let k = 1; k < palabras.length; k++) {
    const a = palabras.slice(0, k).join(' ')
    const b = palabras.slice(k).join(' ')
    const maximo = Math.max(a.length, b.length)
    if (!mejor || maximo < mejor.maximo) mejor = { lineas: [a, b], maximo }
  }
  return mejor ? mejor.lineas : null
}

/**
 * Layout de la banda de descripción (Y 240..400): elige 1 ó 2 renglones —
 * el que permita la fuente MÁS GRANDE — y centra la TINTA del bloque en la
 * banda con ≥ 6 dots de aire de las líneas ("sin tocar los límites").
 * Cada renglón se imprime como campo propio centrado por ^FB de 1 línea.
 * Devuelve null solo si `texto` es vacío.
 */
export function layoutDescripcion(
  texto: string,
  anchoLinea: number
): { lineas: string[]; em: number; w: number; paso: number; y1: number } | null {
  if (!texto.trim()) return null
  const fondo = /[a-zµ,;Q]/.test(texto) ? DESC_FONDO : DESC_BASE
  const utilAncho = anchoLinea - 2 * DESC_MARGEN_X
  const utilAlto = DESC_ZONA_INF - DESC_ZONA_SUP
  let mejor: { lineas: string[]; em: number; w: number; paso: number; y1: number } | null = null
  for (const n of [1, 2] as const) {
    const lineas = repartirEnLineas(texto, n)
    if (!lineas) continue
    const maxChars = Math.max(...lineas.map((l) => l.length))
    const emAncho = Math.floor(utilAncho / (DESC_AVANCE * DESC_RATIO_W * maxChars))
    const emAlto = Math.floor(utilAlto / ((n - 1) * DESC_PASO_EM + DESC_CAP + fondo))
    const em = Math.min(emAncho, emAlto)
    if (em < DESC_EM_MIN) continue
    let w = Math.round(em * DESC_RATIO_W)
    if (maxChars * DESC_AVANCE * w > utilAncho) w -= 1 // celda −1 dot antes de descartar
    if (maxChars * DESC_AVANCE * w > utilAncho) continue
    const paso = Math.round(em * DESC_PASO_EM)
    const altoTinta = (n - 1) * paso + (DESC_CAP + fondo) * em
    const y1 = Math.round(DESC_CENTRO_BANDA - altoTinta / 2)
    if (!mejor || em > mejor.em) mejor = { lineas, em, w, paso, y1 }
  }
  if (mejor) return mejor
  // Red de seguridad (no ocurre con el catálogo real, máx 63 chars): una
  // línea chica truncada, siempre dentro del recuadro.
  const em = DESC_EM_MIN
  const w = Math.max(10, Math.round(em * DESC_RATIO_W))
  const maxChars = Math.floor(utilAncho / (DESC_AVANCE * w))
  return {
    lineas: [texto.slice(0, maxChars)],
    em,
    w,
    paso: 0,
    y1: Math.round(DESC_CENTRO_BANDA - ((DESC_CAP + fondo) * em) / 2),
  }
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
 *   ┌───────────────────────────────────────────────┬──────────┐ Y 0
 *   │                    49310                      │ ▓▓ QR ▓▓ │  código 0..240
 *   ├───────────────────────────────────────────────┤ ▓ 4×4 ▓  │
 *   │   LAMINA TERMOCONTRABLE 380 MM X 50 µ         │ ▓ (cm) ▓ │  desc 240..400
 *   ├────────────┬───────────────────────────────────────────────┤
 *   │   LOTE:    │              0 8 6 9 0 5 1 0 1 7              │  lote 400..545
 *   ├─────┬──────┴────────┬───────┬────────────────────┬─────────┤ 545
 *   │ F.P │  23/07/2026   │ CANT: │       193320       │   UN    │
 *   │ F.V │  22/07/2027   │       │                    │         │
 *   └─────┴───────────────┴───────┴────────────────────┴─────────┘ 792
 *     X: 0  170            420     540                1060    1200
 *
 * (Task 28: con QR de guía el símbolo ocupa el cuadrante 800..1200 ×
 * 0..400 — 4 × 4 cm — y las bandas de código/descripción se acortan a
 * 0..800; el diagrama muestra el caso CON QR. Sin QR todo vuelve a los
 * 1200 de ancho.)
 *
 * FIDELIDAD al formato de la empresa:
 *   · SIN código de barras (el original es solo texto) — PERO con QR de
 *     guía a la DERECHA del límite (2026-10, foto del usuario "AQUÍ VA
 *     QR", para el lector de Tránsito) y el código de artículo agrandado
 *     a la izquierda del límite.
 *   · SIN guía/placa/proveedor/fecha de recepción (no están en la plantilla;
 *     `encabezado` queda en la firma por compatibilidad, no se imprime).
 *   · Todas las cajas con borde, textos centrados, "negrita" simulada
 *     (doble pasada a 2 dots en el flujo) en código, lote y cantidad.
 *   · Campos vacíos (lote/fechas) salen en blanco, como en la plantilla.
 *   · La descripción usa layout DETERMINISTA por renglón (Task 30): el texto
 *     se parte en 1-2 líneas EN EL CÓDIGO (split balanceado) y cada línea es
 *     su propio campo centrado — el ^FB multilínea sobre texto rotado apila
 *     hacia arriba y cruzaba la línea del recuadro ("tachado" en el sticker).
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
  // CON ^LH24,0: origen de impresión corrido 3 mm (ver DESPLAZ_IMPRESION).

  const lineas: string[] = []
  lineas.push('^XA')
  lineas.push('^CI28') // UTF-8: tildes y ñ (p. ej. "DISEÑO")
  // Ancho imprimible = diseño + corrimiento (el marco queda en X 0+24..800+24)
  lineas.push(`^PW${ANCHO_FISICO + DESPLAZ_IMPRESION}`)
  lineas.push('^LL1200')
  // Origen de impresión corrido 3 mm en el ancho de tira (ver DESPLAZ_IMPRESION):
  // TODO el rótulo (marco, cajas, textos y QR) sale desplazado en bloque.
  lineas.push(`^LH${DESPLAZ_IMPRESION},0`)

  // Marco exterior (físicamente idéntico al formato vertical anterior)
  lineas.push(cajaApaisada(0, 0, 1200, 800, 3))

  // ── 1) BANDA CÓDIGO (Y 0..240): código a la IZQUIERDA + QR de guía a la DERECHA ──
  // Con identidad de guía el QR ocupa el cuadrante 800..1200 (Task 28,
  // 4 × 4 cm) cerrado por la línea límite en X 800 — el "límite" de la
  // foto del usuario — y el código usa 0..800 con la fuente MÁS GRANDE
  // que quepa (tinta centrada en la banda, sin pisar líneas). Sin
  // identidad (rótulo sin QR) el código usa el ancho completo y la
  // descripción también (bandas a 1200 como el formato original).
  // El alto se AUTO-AJUSTA a la longitud: códigos largos se reducen para
  // no invadir el límite (holgura 0.62 ≥ avance real 0.6 × alto + negrita).
  const payloadQR = payloadQRRotulo(datos, {
    guiaId: opciones?.qr?.guiaId ?? encabezado.guiaId,
    numeroDocumento: opciones?.qr?.numeroDocumento ?? encabezado.numeroDocumento,
  })
  lineas.push(cajaApaisada(0, 0, payloadQR ? X_ZONA_QR : 1200, 240, 3))
  if (payloadQR) {
    // Línea separadora: límite IZQUIERDO de la zona QR, de arriba (Y 0)
    // hasta el fin de la zona (Y 400) — cruza código Y descripción.
    lineas.push(cajaApaisada(X_ZONA_QR, 0, X_ZONA_QR + 3, ZONA_QR_LADO, 2))
    lineas.push(campoQR(payloadQR))
  }
  if (codigo) {
    // Campo centrado SIMÉTRICO en su zona: márgenes 24 a cada lado
    // (24..776 dentro de 0..800 con QR; 24..1176 sin QR).
    const anchoTexto = payloadQR ? X_ZONA_QR - 48 : 1152
    const xTexto = 24
    const alto = altoParaCaja(codigo, anchoTexto, TOPE_ALTO_CODIGO, 90, 0.62)
    // Centrado de la TINTA (no de la caja): ver TINTA_CENTRO_EM.
    const y = Math.max(0, Math.round(CENTRO_BANDA_CODIGO - TINTA_CENTRO_EM * alto))
    lineas.push(...campoApaisado(xTexto, y, alto, Math.round(alto * 0.6), codigo, { fbAncho: anchoTexto, negrita: true }))
  }

  // ── 2) DESCRIPCIÓN — banda visual Y 240..400 (layout determinista, Task 30) ──
  // Centrada en su recuadro (debajo del código), tipografía natural legible
  // y LO MÁS GRANDE posible sin tocar las líneas: 1 ó 2 renglones (el que
  // dé fuente mayor), cada renglón como campo propio con ^FB de UNA línea
  // (el multilínea rotado apila hacia arriba y cruzaba el recuadro) y la
  // TINTA centrada con el modelo calibrado de layoutDescripcion.
  lineas.push(cajaApaisada(0, 240, payloadQR ? X_ZONA_QR : 1200, 400, 3))
  if (descripcion) {
    const anchoLinea = payloadQR ? X_ZONA_QR - 48 : 1152
    const layout = layoutDescripcion(descripcion, anchoLinea)
    if (layout) {
      layout.lineas.forEach((linea, k) => {
        const yk = layout.y1 + k * layout.paso
        lineas.push(...campoApaisado(24, yk, layout.em, layout.w, linea, { fbAncho: anchoLinea }))
      })
    }
  }

  // ── 3) LOTE — banda visual Y 400..545 ──
  // Si el rótulo es de UNA PALETA (artículo dividido), el extremo derecho
  // de la banda lleva la marca "Paleta i/N" (caja propia 950..1200) y el
  // valor del lote se acorta a 700 dots — el operario ve de un vistazo
  // qué paleta es sin leer observaciones.
  lineas.push(cajaApaisada(0, 400, 250, 545, 3)) // caja "LOTE:"
  lineas.push(cajaApaisada(250, 400, paleta ? 950 : 1200, 545, 3)) // caja valor
  if (paleta) lineas.push(cajaApaisada(950, 400, 1200, 545, 2)) // caja paleta
  // Etiqueta "LOTE:" un poco más grande (pedido 2026-10-28) sin salir de
  // su caja de 145 de alto: em 76 → tinta ~59, sobra margen.
  lineas.push(...campoApaisado(0, 400 + Math.floor((145 - 76) / 2), 76, 58, 'LOTE:', { fbAncho: 250 }))
  if (lote) {
    const anchoValor = paleta ? 700 : 950
    // Dígitos MÁS SEPARADOS (pedido 2026-10-28: "muy pegados, no se
    // aprecian"). AGRANDAR LA CELDA NO SEPARA — verificado con sondas
    // Labelary: el glifo se estira con la celda (tinta ≈ 0.44×w, advance
    // ≈ 0.53×w → gap clavado en ~9% de w sea cual sea w). La separación
    // REAL se logra insertando un ESPACIO entre dígitos contiguos:
    //   "0869051017" → "0 8 6 9 0 5 1 0 1 7"
    // con celda 0.65×em (tinta ~30 dots) el avance propio del espacio deja
    // gap ≈ 23 dots (≈ 2.9 mm) — dígitos claramente individuales. El texto
    // del QR NO cambia (el espaciado es solo el rótulo legible).
    // Lotes largos (> 14 chars) o sin pares de dígitos: compactos como
    // siempre (celda 0.6×em, auto-ajuste probado).
    const espaciado = lote.replace(/(\d)(?=\d)/g, '$1 ')
    const usarEspacios = espaciado !== lote && lote.length <= 14
    const texto = usarEspacios ? espaciado : lote
    const alto = altoParaCaja(lote, anchoValor, 104)
    // Guard del ancho: span ≈ 0.55×w×celdas (coeficiente conservador medido)
    const wMax = Math.floor((anchoValor - 24) / (0.55 * texto.length))
    const w = usarEspacios
      ? Math.max(24, Math.min(Math.round(alto * 0.65), wMax))
      : Math.round(alto * 0.6)
    const y = 400 + Math.floor((145 - alto) / 2)
    lineas.push(...campoApaisado(250, y, alto, w, texto, { fbAncho: anchoValor, negrita: true }))
  }
  if (paleta) {
    const altoP = altoParaCaja(paleta, 250, 56, 28)
    const yP = 400 + Math.floor((145 - altoP) / 2)
    lineas.push(...campoApaisado(950, yP, altoP, Math.round(altoP * 0.8), paleta, { fbAncho: 250 }))
  }

  // ── 4) Bloque inferior: F.P / F.V · CANT · UM — banda visual Y 545..792 ──
  // Cajas: fechas (2 filas apiladas) · cantidad (alta) · UM (alta).
  lineas.push(cajaApaisada(170, 545, 420, 668, 2)) // fecha F.P
  lineas.push(cajaApaisada(170, 668, 420, 792, 2)) // fecha F.V
  lineas.push(cajaApaisada(540, 545, 1060, 792, 2)) // cantidad
  lineas.push(cajaApaisada(1060, 545, 1200, 792, 2)) // UM

  // Etiquetas F.P / F.V (sin caja, como la plantilla) — más grandes
  // (pedido 2026-10-28) sin invadir las cajas de fechas (empiezan en X 170)
  lineas.push(...campoApaisado(14, 545 + Math.floor((123 - 64) / 2), 64, 50, 'F.P'))
  lineas.push(...campoApaisado(14, 668 + Math.floor((124 - 64) / 2), 64, 50, 'F.V'))

  // Fechas MÁS GRANDES dentro de su caja (pedido 2026-10-28: la tinta usaba
  // 33 de ~117 dots de alto — 28% de la caja, medido en render). em 60 →
  // tinta ~46 (39% de la caja) y span 10 chars ≈ 0.48×41×9 + 46 ≈ 223 dots,
  // bajo el umbral de salto de línea del ^FB 250 (~92-97% de 250) y del
  // interior real (~236).
  lineas.push(...campoApaisado(170, 545 + Math.floor((123 - 60) / 2), 60, 41, fProd, { fbAncho: 250 }))
  lineas.push(...campoApaisado(170, 668 + Math.floor((124 - 60) / 2), 60, 41, fVenc, { fbAncho: 250 }))

  // CANT: más grande (pedido 2026-10-28); 5 glifos a celda 38 ≈ 0.48×38×4 +
  // tinta ≈ 100 dots < 114 — margen ante el salto de línea del ^FB 120.
  lineas.push(...campoApaisado(420, 545 + Math.floor((247 - 52) / 2), 52, 38, 'CANT:', { fbAncho: 120 }))

  // Cantidad — LLENA su caja (pedido 2026-10-17 con la zona pintada en
  // verde sobre la etiqueta: "abarcar todo el espacio sin salirse del
  // rectángulo"). Antes: em limitado a 110 → la tinta usaba 35% del alto
  // y 35% del ancho de una caja de 516×240 interiores.
  // Diseño CALIBRADO con render (5 rondas Labelary + medición OpenCV):
  //  · LEY DE AVANCE de la fuente 0: un dígito avanza 0.462×w dots,
  //    INDEPENDIENTE del em (verificado w 83..172, em 110..294; el span
  //    real de "193320" en la referencia del usuario, 374 dots para el
  //    código a em 267/w 160, confirma la misma ley).
  //  · ALTO: em 294 → tinta 226/240 (94%) — posible SOLO con ^FT (la celda
  //    de 294 no cabe bajo la caja por ^FO: y0+alto ≤ 800 la capaba a 210;
  //    la zona descendente vacía cuelga del lienzo sin tinta).
  //  · ANCHO: span = 0.462×w×len con meta 460 (89% del interior). NO subir
  //    de ahí: el ^FB 520 salta el último dígito a una 2ª línea cuando el
  //    renglón pasa ~477-502 dots (verificado: w 181/186 rompen, 172 no).
  //  · Baseline B = 663.5 + 0.3857×em centra la TINTA en la caja (±4).
  // Degrada a auto-ajuste clásico si la cantidad fuera absurda (>20 chars:
  // los dígitos quedarían más finos que legibles).
  if (cantidad) {
    const len = cantidad.length
    if (len > 20) {
      const alto = altoParaCaja(cantidad, 520, 110)
      const y = 545 + Math.floor((247 - alto) / 2)
      lineas.push(...campoApaisado(540, y, alto, Math.round(alto * 0.6), cantidad, { fbAncho: 520, negrita: true }))
    } else {
      const em = 294
      const w = Math.max(48, Math.min(320, Math.floor(996 / Math.max(1, len))))
      const baseline = Math.round(663.5 + 0.3857 * em)
      lineas.push(...campoApaisado(540, 0, em, w, cantidad, { fbAncho: 520, negrita: true, baselineVisual: baseline }))
    }
  }

  // Unidad de medida (grande, centrada) — un poco más grande (pedido 2026-10-28)
  if (unidad) {
    const alto = altoParaCaja(unidad, 140, 96)
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

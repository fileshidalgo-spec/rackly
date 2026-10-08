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
 *   Desde una página HTTPS los navegadores modernos (Chrome/Edge/Firefox)
 *   tratan localhost como origen seguro, así que http://localhost:9100
 *   funciona sin warnings. Si el servicio corre en modo HTTPS usa
 *   https://localhost:9101 (requiere aceptar su certificado una vez).
 *
 * LENGUAJE: ZPL II con ^CI28 (UTF-8) para tildes/ñ. Etiqueta 10 × 15 cm
 * (800 × 1200 dots @203 dpi) con el FORMATO PERECIBLE de la empresa,
 * replicado de "ETIQUETA ALMACEN insumos.xlsm" (hoja PERECIBLE).
 *
 * FALLBACK: sin el middleware, el app genera un archivo .zpl descargable
 * que se imprime con Zebra Setup Utilities (arrastrar y enviar).
 */

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

/** Datos que porta un rótulo (1 artículo de la recepción). */
export type DatosRotulo = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
}

/** Encabezado compartido por los rótulos de una recepción.
 *  El formato PERECIBLE de la empresa no lo imprime; se conserva en la
 *  firma de las funciones por compatibilidad con las 2 vías de registro. */
export type EncabezadoRotulo = {
  fecha: string
  numeroDocumento: string
  proveedor: string
  placa: string
  registradoPor?: string
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

/** Prueba las bases locales y devuelve la primera que responde. */
export async function detectarServicioZebra(): Promise<string | null> {
  for (const base of BASES_ZEBRA) {
    try {
      const { signal, limpiar } = abortar(TIMEOUT_MS)
      try {
        const res = await fetch(`${base}/available`, { signal })
        if (res.ok) {
          baseActiva = base
          return base
        }
      } finally {
        limpiar()
      }
    } catch {
      // esta base no responde; probar la siguiente
    }
  }
  baseActiva = null
  return null
}

/**
 * Lista las impresoras visibles por Browser Print. La respuesta del servicio
 * es un objeto con UNA propiedad cuyo valor es el array de dispositivos
 * (p. ej. {"printer":[…]}); se aplana sin depender del nombre de la clave.
 */
export async function descubrirImpresorasZebra(): Promise<ImpresoraZebra[]> {
  const base = baseActiva ?? (await detectarServicioZebra())
  if (!base) return []
  try {
    const res = await fetch(`${base}/available`)
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
  const base = baseActiva ?? (await detectarServicioZebra())
  if (!base) return null
  try {
    const res = await fetch(`${base}/default?type=printer`)
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
  const base = baseActiva ?? (await detectarServicioZebra())
  if (!base) {
    throw new Error('Zebra Browser Print no está disponible en esta computadora.')
  }
  const device: ImpresoraZebra = { ...impresora, version: impresora.version ?? 2 }
  const res = await fetch(`${base}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ device, data: zpl }),
  })
  if (!res.ok) {
    throw new Error(`La impresora rechazó la impresión (HTTP ${res.status}).`)
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
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
}

/** Fecha ISO (yyyy-mm-dd) → dd/mm/yyyy, formato compacto para la etiqueta. */
function fechaCorta(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : sanearZPL(iso)
}

/**
 * Rótulo de RECEPCIÓN en ZPL II — FORMATO PERECIBLE de la empresa,
 * replicado 1:1 desde "ETIQUETA ALMACEN insumos.xlsm" (hoja PERECIBLE).
 * Etiqueta física: 10 × 15 cm (100 × 150 mm) = 800 × 1200 dots @203 dpi.
 *
 *   ┌────────────────────────────┐
 *   │         56119              │  ← código, fuente gigante centrada
 *   ├────────────────────────────┤
 *   │  ENVASE TETRA PACK PULP…   │  ← descripción centrada (hasta 3 líneas)
 *   ├──────────┬─────────────────┤
 *   │  LOTE:   │   0869051017    │
 *   ├──────┬───┴─────┬─────┬────┴────┬──────┐
 *   │ F.P  │ 23/07/… │CANT:│ 193320  │  UN  │
 *   │ F.V  │ 22/07/… │     │         │      │
 *   └──────┴─────────┴─────┴─────────┴──────┘
 *
 * FIDELIDAD al formato de la empresa:
 *   · SIN código de barras (el original es solo texto).
 *   · SIN guía/placa/proveedor/fecha de recepción (no están en la plantilla;
 *     `encabezado` queda en la firma por compatibilidad, no se imprime).
 *   · Todas las cajas con borde, textos centrados, "negrita" simulada
 *     (doble pasada con 3 dots de offset) en código, lote, cantidad y UM.
 *   · Campos vacíos (lote/fechas) salen en blanco, como en la plantilla.
 *
 * DPI: la ZT411 estándar es 203 dpi (8 dots/mm). Si la suya fuera 300 dpi,
 * la etiqueta sale al ~68% del tamaño (avisar para reescalar).
 */
export function construirZPLRotulo(
  datos: DatosRotulo,
  _encabezado: EncabezadoRotulo,
  opciones?: { copias?: number }
): string {
  const copias = Math.max(1, Math.min(999, Math.round(opciones?.copias ?? 1)))

  const codigo = sanearZPL(datos.codigo)
  const descripcion = sanearZPL(datos.descripcion)
  const cantidad = sanearZPL(datos.cantidad)
  const unidad = sanearZPL(datos.unidad)
  const lote = sanearZPL(datos.lote)
  const fProd = datos.fechaProduccion ? fechaCorta(datos.fechaProduccion) : ''
  const fVenc = datos.fechaVencimiento ? fechaCorta(datos.fechaVencimiento) : ''

  // ── Geometría (dots @203dpi; 1 dot = 0.125 mm) ──
  // Ancho total 800, alto 1200; marco interior x 8..792, y 8..1192.
  // Bandas: código 8-318 · descripción 318-578 · lote 578-728 ·
  //         inferior 728-1192 (fechas 2 filas de 232; cantidad/UM 464).

  const lineas: string[] = []
  lineas.push('^XA')
  lineas.push('^CI28') // UTF-8: tildes y ñ (p. ej. "DISEÑO")
  lineas.push('^PW800')
  lineas.push('^LL1200')
  lineas.push('^LH8,8')

  // Marco exterior
  lineas.push('^FO0,0^GB800,1200,3^FS')

  // ── 1) CÓDIGO (gigante, centrado, "demi") ──
  // El alto se AUTO-AJUSTA a la longitud: hoy el catálogo usa 3-5 dígitos
  // (cabe a 200 dots), pero con códigos de 6+ el texto se saldría de la
  // etiqueta — se reduce proporcionalmente y siempre queda centrado.
  lineas.push('^FO0,0^GB800,310,3^FS')
  if (codigo) {
    const alto = altoParaCaja(codigo, 768, 200, 90)
    const y = Math.floor((310 - alto) / 2) - 10
    for (const dx of [0, 2]) {
      lineas.push(`^FO${dx},${y}^A0N,${alto},${Math.round(alto * 0.6)}^FB800,1,0,C^FD${codigo}^FS`)
    }
  }

  // ── 2) DESCRIPCIÓN (centrada, hasta 3 líneas, bloque centrado vertical) ──
  lineas.push('^FO0,310^GB800,268,3^FS')
  if (descripcion) {
    // Estimación de líneas con métricas de font 0 (avance ≈ 0.55 × ancho 42)
    const anchoLinea = 752
    const avanceDesc = Math.round(0.55 * 42)
    const nLineas = Math.min(3, Math.max(1, Math.ceil((descripcion.length * avanceDesc) / anchoLinea)))
    const altoBloque = nLineas * Math.round(58 * 1.15)
    const yDesc = 310 + Math.floor((268 - altoBloque) / 2)
    lineas.push(`^FO24,${yDesc}^A0N,58,42^FB752,3,10,C^FD${descripcion}^FS`)
  }

  // ── 3) LOTE ──
  lineas.push('^FO0,578^GB212,150,3^FS')
  lineas.push('^FO212,578^GB588,150,3^FS')
  lineas.push(`^FO0,612^A0N,66,50^FB212,1,0,C^FDLOTE:^FS`)
  if (lote) {
    const alto = altoParaCaja(lote, 588, 92)
    for (const dx of [0, 2]) {
      lineas.push(`^FO${212 + dx},608^A0N,${alto},${Math.round(alto * 0.6)}^FB588,1,0,C^FD${lote}^FS`)
    }
  }

  // ── 4) Bloque inferior: F.P / F.V · CANT · UM ──
  // Columnas (métrica font 0: avance dígito ≈ 0.55 × ancho de glifo):
  //   etiquetas 0-112 | fechas 112-332 | CANT: 332-452 |
  //   cantidad 452-688 | UM 688-800
  // Cajas de fechas (2 filas) y cajas de cantidad + UM (1 sola alta).
  lineas.push('^FO112,728^GB220,232,2^FS')
  lineas.push('^FO112,960^GB220,232,2^FS')
  lineas.push('^FO452,728^GB236,464,2^FS')
  lineas.push('^FO688,728^GB112,464,2^FS')

  // Etiquetas F.P / F.V (sin caja, como la plantilla)
  lineas.push('^FO14,808^A0N,56,44^FDF.P^FS')
  lineas.push('^FO14,1040^A0N,56,44^FDF.V^FS')

  // Fechas (centradas en su caja; 10 caracteres a ancho 30 ≈ 165 dots < 220)
  lineas.push(`^FO112,823^A0N,42,30^FB220,1,0,C^FD${fProd}^FS`)
  lineas.push(`^FO112,1055^A0N,42,30^FB220,1,0,C^FD${fVenc}^FS`)

  // CANT: (centrado vertical del bloque inferior; 5 glifos a ancho 34 ≈ 94 < 120)
  lineas.push('^FO332,939^A0N,42,34^FB120,1,0,C^FDCANT:^FS')

  // Cantidad (grande, "demi", auto-ajustada a su caja)
  if (cantidad) {
    const alto = altoParaCaja(cantidad, 236, 110)
    const y = 728 + Math.floor((464 - alto) / 2)
    for (const dx of [0, 2]) {
      lineas.push(`^FO${452 + dx},${y}^A0N,${alto},${Math.round(alto * 0.6)}^FB236,1,0,C^FD${cantidad}^FS`)
    }
  }

  // Unidad de medida (grande, centrada)
  if (unidad) {
    const alto = altoParaCaja(unidad, 112, 80)
    const y = 728 + Math.floor((464 - alto) / 2)
    lineas.push(`^FO688,${y}^A0N,${alto},${Math.round(alto * 0.6)}^FB112,1,0,C^FD${unidad}^FS`)
  }

  lineas.push(`^PQ${copias},0,0,N`)
  lineas.push('^XZ')
  return lineas.join('\n')
}

/** Alto de fuente (font 0) para que `texto` quepa en una caja de `anchoCaja` dots. */
function altoParaCaja(texto: string, anchoCaja: number, max: number, min = 34): number {
  const len = Math.max(1, texto.length)
  return Math.max(min, Math.min(max, Math.floor((anchoCaja - 24) / (0.58 * len))))
}

/**
 * Construye el ZPL de VARIOS rótulos (uno por artículo), cada uno con su
 * cantidad de copias. `rotulos[i]` se empareja con `copias[i]`.
 */
export function construirZPLRotulos(
  rotulos: DatosRotulo[],
  copias: number[],
  encabezado: EncabezadoRotulo
): string {
  return rotulos
    .map((r, i) => construirZPLRotulo(r, encabezado, { copias: copias[i] ?? 1 }))
    .join('\n')
}

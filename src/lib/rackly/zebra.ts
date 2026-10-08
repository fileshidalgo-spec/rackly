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
 * LENGUAJE: ZPL II con ^CI28 (UTF-8) para tildes/ñ. Diseñado a 203 dpi
 * (resolución estándar de la ZT411): 4" = 812 dots, 6" = 1218 dots.
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

/** Encabezado compartido por los rótulos de una recepción. */
export type EncabezadoRotulo = {
  fecha: string
  numeroDocumento: string
  proveedor: string
  placa: string
  registradoPor?: string
}

export type TamanoRotulo = '4x6' | '4x2'

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

/** Línea de texto con fuente A0 (ancho, alto). */
function fd(x: number, y: number, ancho: number, alto: number, texto: string): string {
  return `^FO${x},${y}^A0N,${alto},${ancho}^FD${texto}^FS`
}

/** Bloque de texto envuelto (^FB) para descripciones largas. */
function fdEnvuelto(
  x: number,
  y: number,
  anchoCaja: number,
  lineas: number,
  alto: number,
  texto: string
): string {
  return `^FO${x},${y}^A0N,${alto},${alto}^FB${anchoCaja},${lineas},0,L,0^FD${texto}^FS`
}

/**
 * Rótulo de RECEPCIÓN en ZPL II, a 203 dpi (ZT411 estándar).
 *
 *   · Código grande + Code128 (scannable desde Racks/Piso).
 *   · Descripción envuelta hasta 3 líneas.
 *   · Cantidad + unidad destacadas.
 *   · Lote, fecha de producción y vencimiento.
 *   · Guía, placa, proveedor y fecha de recepción.
 *
 * Tamaños: 4x6 (100×150 mm, default) y 4x2 (100×50 mm, compacto).
 */
export function construirZPLRotulo(
  datos: DatosRotulo,
  encabezado: EncabezadoRotulo,
  opciones?: { tamano?: TamanoRotulo; copias?: number }
): string {
  const tamano = opciones?.tamano ?? '4x6'
  const copias = Math.max(1, Math.min(999, Math.round(opciones?.copias ?? 1)))

  const codigo = sanearZPL(datos.codigo)
  const descripcion = sanearZPL(datos.descripcion)
  const cantidad = sanearZPL(datos.cantidad) || '0'
  const unidad = sanearZPL(datos.unidad)
  const lote = sanearZPL(datos.lote)
  const fProd = datos.fechaProduccion ? fechaCorta(datos.fechaProduccion) : ''
  const fVenc = datos.fechaVencimiento ? fechaCorta(datos.fechaVencimiento) : ''
  const guia = sanearZPL(encabezado.numeroDocumento)
  const placa = sanearZPL(encabezado.placa)
  const proveedor = sanearZPL(encabezado.proveedor)
  const fecha = fechaCorta(encabezado.fecha)
  const quien = sanearZPL(encabezado.registradoPor || '')

  const lineas: string[] = []
  lineas.push('^XA')
  lineas.push('^CI28') // UTF-8: tildes y ñ

  if (tamano === '4x6') {
    // ── 4×6 pulgadas · 812 × 1218 dots @203dpi ──
    lineas.push('^PW812')
    lineas.push('^LL1218')
    lineas.push('^LH10,10')

    // Encabezado de la etiqueta
    lineas.push('^FO0,0^GB812,86,2,B,0^FS')
    lineas.push(fd(24, 14, 34, 34, 'RACKLY'))
    lineas.push(fd(24, 52, 22, 22, 'RECEPCION DE MERCADERIA'))
    lineas.push(fd(548, 14, 22, 22, 'FECHA DE RECEPCION'))
    lineas.push(fd(548, 40, 30, 30, fecha))

    // Código (grande) + código de barras Code128
    lineas.push(fd(24, 104, 24, 24, 'CODIGO DE ARTICULO'))
    lineas.push(fd(24, 130, 64, 64, codigo))
    lineas.push(`^FO24,208^BY3,3,110^BCN,110,Y,N,N^FD${codigo}^FS`)

    // Descripción (envuelta)
    lineas.push(fd(24, 348, 24, 24, 'DESCRIPCION'))
    lineas.push(fdEnvuelto(24, 376, 760, 3, 30, descripcion))

    // Cantidad + unidad (destacadas)
    lineas.push(fd(24, 500, 24, 24, 'CANTIDAD'))
    lineas.push(fd(24, 528, 54, 54, `${cantidad}${unidad ? ' ' + unidad : ''}`))

    // Lote / producción / vencimiento
    lineas.push(fd(24, 610, 26, 26, `LOTE: ${lote || '—'}`))
    lineas.push(fd(24, 644, 26, 26, `F. PRODUCCION: ${fProd || '—'}`))
    lineas.push(fd(24, 678, 26, 26, `F. VENCIMIENTO: ${fVenc || '—'}`))

    // Caja de documento: guía / placa / proveedor
    lineas.push('^FO24,730^GB760,116,2^FS')
    lineas.push(fd(44, 748, 24, 24, `GUIA: ${guia || '—'}`))
    lineas.push(fd(44, 780, 24, 24, `PLACA: ${placa || '—'}${proveedor ? `   PROVEEDOR: ${proveedor}` : ''}`))
    if (quien) lineas.push(fd(44, 812, 22, 22, `REGISTRO: ${quien}`))

    // Pie: fecha de impresión
    lineas.push(fd(24, 1150, 20, 20, `Rótulo generado por Rackly · ${new Date().toISOString().slice(0, 10)}`))
  } else {
    // ── 4×2 pulgadas · 812 × 406 dots @203dpi (compacto) ──
    lineas.push('^PW812')
    lineas.push('^LL406')
    lineas.push('^LH8,8')

    lineas.push(fd(20, 8, 40, 40, `${codigo}${unidad ? ' · ' + unidad : ''}`))
    lineas.push(`^FO20,54^BY2,2,72^BCN,72,Y,N,N^FD${codigo}^FS`)
    lineas.push(fdEnvuelto(330, 12, 460, 2, 26, descripcion))
    lineas.push(fd(330, 108, 34, 34, `CANT: ${cantidad}${unidad ? ' ' + unidad : ''}`))
    lineas.push(fd(330, 148, 22, 22, `LOTE: ${lote || '—'}  VENC: ${fVenc || '—'}`))
    lineas.push(fd(330, 176, 20, 20, `GUIA: ${guia || '—'}${placa ? '  PLACA: ' + placa : ''}`))
    lineas.push(fd(330, 200, 20, 20, `${proveedor}${fecha ? (proveedor ? ' · ' : '') + fecha : ''}`))
  }

  lineas.push(`^PQ${copias},0,0,N`)
  lineas.push('^XZ')
  return lineas.join('\n')
}

/**
 * Construye el ZPL de VARIOS rótulos (uno por artículo), cada uno con su
 * cantidad de copias. `rotulos[i]` se empareja con `copias[i]`.
 */
export function construirZPLRotulos(
  rotulos: DatosRotulo[],
  copias: number[],
  encabezado: EncabezadoRotulo,
  tamano: TamanoRotulo
): string {
  return rotulos
    .map((r, i) => construirZPLRotulo(r, encabezado, { tamano, copias: copias[i] ?? 1 }))
    .join('\n')
}

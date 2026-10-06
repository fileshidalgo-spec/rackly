'use client'

/**
 * RACKLY — Extracción de datos desde una foto de Guía de Remisión.
 *
 * Capa PURA (sin DOM salvo `reducirImagen`): dada la salida de texto de un
 * OCR (tesseract.js, idioma spa), recopila los datos clave de la guía:
 *
 *   · Número de guía      → patrón T###-######  (T005-0034403, T173-00004076)
 *   · Placa del vehículo  → línea con etiqueta "PLACA (TRACTO|CARRETA)"
 *   · Proveedor           → "Señores:" / "RAZÓN SOCIAL:"
 *   · Códigos de artículo → todo token del texto que coincida con el
 *                           CATÁLOGO cargado en la app (1063 códigos);
 *                           descripción y unidad se sacan del catálogo.
 *   · Cantidad            → primer número con separador de miles/decimales
 *                           en la misma línea del código (editable luego).
 *
 * La extracción es una AYUDA: el usuario confirma y corrige todo en el
 * formulario de confirmación antes de registrar.
 */

import type { CatalogoItem } from '@/lib/rackly/catalogo'
import { findCatalogoByCodigo } from '@/lib/rackly/catalogo'

export type ItemGuia = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  enCatalogo: boolean
}

export type DatosGuia = {
  numeroGuia: string
  placa: string
  proveedor: string
  items: ItemGuia[]
}

// ═══════════════════════════════════════════════════════════════════
// PARSER
// ═══════════════════════════════════════════════════════════════════

/** Nº de guía: T seguido de 3 dígitos, guion, 5-8 dígitos (tolera espacios OCR). */
const RE_GUIA = /\bT\s?\d{3}\s?-\s?\d{5,8}\b/

/** Etiquetas de proveedor en los 2 formatos conocidos (AJEPER / SAN MIGUEL). */
const RE_PROVEEDOR = /(?:RAZ[OÓ]N\s+SOCIAL|SE[ÑN]ORES|PROVEEDOR)\s*:?\s*(.+)/i

/** Cantidad con separador de miles y/o decimales: 2,884 · 9,400.00 · 340.340 */
const RE_CANTIDAD = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,3})?|\d+[.,]\d{1,3}/

/** Unidades de medida habituales en las guías. */
const UNIDADES = new Set([
  'KGM', 'KG', 'KGS', 'MILL', 'MIL', 'UND', 'UNIDAD', 'UNIDADES', 'UN',
  'CJA', 'CAJA', 'Cajas', 'BOL', 'BOLSA', 'GL', 'GALON', 'LTR', 'LT',
  'MTR', 'MT', 'PAR', 'JGO', 'SET', 'PQT', 'TON',
])

function limpiarLineas(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.replace(/[|]+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((l) => l.length > 0)
}

function normalizarGuia(m: string): string {
  return m.replace(/\s+/g, '')
}

/** Busca la placa en la primera línea que tenga etiqueta PLACA. */
function extraerPlaca(lineas: string[]): string {
  const reEtiqueta = /PLACA[S]?\s*(?:TRACTO|TRACTOR|CARRETA|REMOLQUE)?\s*(?:N[º°.]?)?\s*:?\s*(.+)$/i
  for (const linea of lineas) {
    const m = linea.match(reEtiqueta)
    if (!m) continue
    // Token con formato de placa peruana: 3-4 alfanuméricos + guion/espacio opcional + 3 alfanuméricos
    const mp = m[1].match(/\b([A-Z0-9]{2,4})[-\s]?([A-Z0-9]{3})\b/i)
    if (mp) {
      const cand = (mp[1] + '-' + mp[2]).toUpperCase()
      // Descarta números de documento largos (RUC, DNI, licencias)
      if (!/^\d{6,}/.test(cand.replace('-', ''))) return cand
    }
  }
  return ''
}

function extraerProveedor(lineas: string[]): string {
  for (const linea of lineas) {
    const m = linea.match(RE_PROVEEDOR)
    if (m) {
      const val = m[1].replace(/\s{2,}.*$/, '').trim() // corta en columnas contiguas del OCR
      if (val.length >= 3 && val.length <= 80) return val
    }
  }
  return ''
}

/** Regla de negocio histórica del app: '09' == '9' al comparar códigos. */
function mismaClave(a: string, b: string): boolean {
  const na = a.trim().toUpperCase()
  const nb = b.trim().toUpperCase()
  if (na === nb) return true
  return na.replace(/^0+/, '') === nb.replace(/^0+/, '')
}

/** Extrae tokens-candidato del texto y los cruza contra el catálogo. */
function extraerItems(texto: string, catalogo: CatalogoItem[]): ItemGuia[] {
  if (catalogo.length === 0) return []
  const textoUp = texto.toUpperCase()
  const encontrados: { pos: number; codigo: string; linea: string }[] = []

  for (const item of catalogo) {
    const codigo = item.codigo.trim().toUpperCase()
    if (codigo.length < 3) continue
    const re = new RegExp('(^|[^0-9A-Z])(' + codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')($|[^0-9A-Z])')
    const m = re.exec(textoUp)
    if (m) {
      const pos = m.index + m[1].length
      // línea donde aparece el código
      const linea = textoUp.slice(Math.max(0, pos - 120), pos + 160).split('\n')[0] ?? ''
      const previa = encontrados.find((e) => mismaClave(e.codigo, codigo))
      if (previa && previa.pos <= pos) continue
      if (previa) encontrados.splice(encontrados.indexOf(previa), 1)
      encontrados.push({ pos, codigo, linea })
    }
  }
  encontrados.sort((a, b) => a.pos - b.pos)

  return encontrados.map(({ codigo, linea }) => {
    const cat = findCatalogoByCodigo(codigo)
    // Cantidad: primer número con formato numérico de guía en la línea,
    // ignorando los tokens que forman parte del propio código.
    let cantidad = ''
    const reNum = new RegExp(RE_CANTIDAD.source, 'g')
    let mm: RegExpExecArray | null
    while ((mm = reNum.exec(linea)) !== null) {
      const tok = mm[0]
      if (mismaClave(tok.replace(/[.,]/g, ''), codigo)) continue
      // Descarta fechas (02.10.26 / 05/10) y series largas de caja
      if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(tok)) continue
      if (tok.replace(/[.,]/g, '').length >= 9) continue
      cantidad = tok
      break
    }
    // Unidad: token de unidad en la línea; si no, la del catálogo
    let unidad = cat?.un ?? ''
    if (!unidad) {
      for (const tok of linea.split(/\s+/)) {
        const t = tok.replace(/[^A-ZÑ]/g, '')
        if (t.length >= 2 && UNIDADES.has(t)) {
          unidad = t
          break
        }
      }
    }
    return {
      codigo,
      descripcion: cat?.descripcion ?? '',
      cantidad,
      unidad: unidad ?? '',
      enCatalogo: Boolean(cat),
    }
  })
}

/**
 * Punto de entrada: texto OCR → datos estructurados de la guía.
 * `catalogo` debe venir cargado (fetchCatalogo) para reconocer códigos.
 */
export function extraerDatosGuia(textoOcr: string, catalogo: CatalogoItem[]): DatosGuia {
  const lineas = limpiarLineas(textoOcr)
  const texto = lineas.join('\n')
  const guia = textoOcr.match(RE_GUIA)
  return {
    numeroGuia: guia ? normalizarGuia(guia[0]) : '',
    placa: extraerPlaca(lineas),
    proveedor: extraerProveedor(lineas),
    items: extraerItems(texto, catalogo),
  }
}

// ═══════════════════════════════════════════════════════════════════
// IMAGEN
// ═══════════════════════════════════════════════════════════════════

/**
 * Reduce/normaliza una foto (JPEG) con canvas: lado mayor = `maxLado`.
 * Se usa para: (a) alimentar el OCR con una imagen razonable y
 * (b) subir una foto liviana a Storage en lugar de la original de 5-10MB.
 */
export async function reducirImagen(archivo: File, maxLado = 1600, calidad = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(archivo)
  const escala = Math.min(1, maxLado / Math.max(bitmap.width, bitmap.height))
  const ancho = Math.round(bitmap.width * escala)
  const alto = Math.round(bitmap.height * escala)
  const canvas = document.createElement('canvas')
  canvas.width = ancho
  canvas.height = alto
  const ctx = canvas.getContext('2d')
  if (!ctx) return archivo
  ctx.drawImage(bitmap, 0, 0, ancho, alto)
  bitmap.close?.()
  return await new Promise<Blob>((resolve) => {
    canvas.toBlob(
      (b) => resolve(b && b.size > 0 ? b : archivo),
      'image/jpeg',
      calidad
    )
  })
}

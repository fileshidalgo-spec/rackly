'use client'

/**
 * RACKLY — Extracción de datos desde una foto de Guía de Remisión.
 *
 * Estrategia en 3 capas (calibrada con la guía real AJER S.A. T173-00004090):
 *
 *   1. OCR DE PÁGINA COMPLETA (el componente corre tesseract.js, idioma spa)
 *      → encabezado: nº de guía (T###-######), placa, proveedor.
 *   2. ZOOM DE LA TABLA DE ARTÍCULOS POR TRAMOS ("cuadro por cuadro"):
 *      localizando las anclas "…TRANSPORTADOS" y "NOTAS…" con las cajas de
 *      palabras del OCR, el componente RECORTA esa franja y la vuelve a leer
 *      escalada ×3 — dividida en TRAMOS de ~900 px con solape (una tabla
 *      larga a ×3 entera era una imagen enorme y el OCR perdía filas).
 *      Este módulo entrega las utilidades puras: extraerPalabras,
 *      extraerAnclasTabla, dividirFranjaEnBandas y recortarFranjaTabla.
 *   3. FUSIÓN EXHAUSTIVA: se parsean la lectura del zoom Y la de la página
 *      completa; `fusionarDatos` une los artículos de ambos pases sin
 *      duplicados (antes el zoom ganaba todo y se perdían filas leídas solo
 *      por la página completa) y un 2º pase de página completa (PSM AUTO)
 *      se fusiona igual. Filas sin cantidad quedan marcadas "revisar".
 *   4. RESOLUCIÓN INTELIGENTE de cada fila de la tabla:
 *        a. código exacto en catálogo + descripción coherente  → artículo OK
 *        b. código exacto con descripción INCOHERENTE          → se re-busca
 *           por descripción (evita códigos "cambiados" por el OCR)
 *        c. código no catalogado → vecino a 1 dígito validado por descripción
 *           → si no, coincidencia por DESCRIPCIÓN contra el catálogo
 *           (los números pesan 3×: "145 ML" discrimina mejor que las palabras)
 *        d. sin código legible → la descripción manda; la fila queda editable
 *      Toda fila con matchPorDescripcion/revision queda marcada para que el
 *      usuario la confirme en el formulario (la extracción es una AYUDA).
 */

import type { CatalogoItem } from '@/lib/rackly/catalogo'

export type ItemGuia = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  enCatalogo: boolean
  /** El código se recuperó por coincidencia de descripción (o vecino validado). */
  matchPorDescripcion?: boolean
  /** Requiere revisión humana (match débil, código incoherente o sin catálogo). */
  revision?: boolean
}

export type DatosGuia = {
  numeroGuia: string
  placa: string
  proveedor: string
  items: ItemGuia[]
  /** Cantidad de respaldo cuando el OCR no asoció ninguna a un código. */
  cantidadSugerida: string
  /**
   * Rigor numérico (Task 23): discrepancias detectadas entre lecturas/pases
   * y números leídos con baja confianza — el usuario DEBE verificarlos antes
   * de guardar (las cantidades mal leídas llegan a las paletas y a los
   * rótulos QR). Vacío = lectura sin señales de error.
   */
  avisos?: string[]
  /**
   * DEVOLUCIONES DE LÍNEA (formato "REQUISICION DE DEVOLUCION DE MATERIAL
   * DISPONIBLE", AJEPER): notas del encabezado de la requisición — orden de
   * producción y solicitante — que el formulario guarda en observaciones
   * ("OP 2026008387 · Solicita: …"). '' si el documento no es una requisición.
   */
  notasDevolucion?: string
  /** TRUE si el texto es una REQUISICIÓN DE DEVOLUCIÓN (no una guía de
   *  remisión): el formulario ajusta el tipo de documento solo. */
  esRequisicionDevolucion?: boolean
}

/** Una fila cruda de la tabla de artículos, tal como salió del OCR. */
export type FilaTabla = {
  linea: string
  itemNum: string
  codigoOCR: string
  descripcionOCR: string
  cantidad: string
  unidad: string
}

/**
 * Palabra del OCR con su caja (para localizar la tabla en la página).
 * `conf` es la confianza de Tesseract (0-100) — antes se DESCARTABA y es
 * justo la señal que delata las confusiones 4↔9/1↔7 en números (Task 23).
 */
export type PalabraOCR = { t: string; x0: number; y0: number; x1: number; y1: number; conf?: number }

// ═══════════════════════════════════════════════════════════════════
// 1. CONSTANTES
// ═══════════════════════════════════════════════════════════════════

/** Nº de guía: T seguido de 3 dígitos, guion, 5-8 dígitos (tolera espacios OCR). */
const RE_GUIA = /\bT\s?\d{3}\s?-\s?\d{5,8}\b/

/**
 * Serie sin T visible: el OCR confunde la T inicial con 7/1 y puede
 * pegarla al número (T173 → "7173", T005 → "7005" o perderla: "005").
 */
const RE_GUIA_SIN_T = /\b\d{3,4}\s?-\s?\d{5,8}\b/

/** Cantidad con separador de miles y/o decimales: 2,884 · 9,400.00 · 340.340
 *  REQUISICIÓN DE DEVOLUCIÓN (AJEPER): 4 decimales — 15,040.0000 · 3,456.0000 */
const RE_CANTIDAD = /\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,4})?\b|\b\d+[.,]\d{1,4}\b/

/** El token COMPLETO es una cantidad (anclas sobre TODO el patrón, no por alternativa). */
const RE_CANTIDAD_EXACTA = new RegExp('^(?:' + RE_CANTIDAD.source + ')$')

/**
 * Unidades de medida habituales en las guías. Se incluyen lecturas OCR
 * frecuentes de "GLL" (galón): GL, GLL y CLL.
 */
const UNIDADES = new Set([
  'KGM', 'KG', 'KGS', 'MILL', 'MIL', 'UND', 'UNIDAD', 'UNIDADES', 'UN',
  'CJA', 'CAJA', 'BOL', 'BOLSA', 'GL', 'GLL', 'CLL', 'GALON', 'LTR', 'LT',
  'MTR', 'MT', 'PAR', 'JGO', 'SET', 'PQT', 'TON',
])

/** Regex de unidades dentro de una línea (para detectar filas de la tabla). */
const RE_UNIDAD_LINEA = new RegExp(
  '\\b(' + [...UNIDADES].map((u) => u.toUpperCase()).sort((a, b) => b.length - a.length).join('|') + ')\\b'
)

/**
 * Líneas que JAMÁS son filas de artículos (etiquetas del encabezado,
 * transportista, notas y sellos). Evita falsos positivos fuera de la tabla.
 */
const RE_SKIP_LINEA =
  /(PESO\s+KILOGRAMOS|PUNTO\s+DE|DIRECCI|BREVETE|REGISTRO|MOTIVO|ORDEN\s+DE|FECHA|TELE|FAX|PLACA|CONDUCTOR|TRANSPORTISTA|NOTAS?|GU[IÍ]A\s+DE|REMISI|DESTINATARIO|RAZ[OÓ]N|NOMBRE\s+COMERCIAL|SERIE|COMPROBANTE|ENTREGA|REPRESENTACI|CONSULTE|ALMAC[EÉ]N|DESPACHADO|VIGILANCIA|CONFIRMIDAD|SE[ÑN]AL|R\.U\.C|DNI|LICENCIA|VEH[IÍ]CULO|PRECINTO|CONTENEDOR|OBSERVACI|CONSTE|CONDICIONES|SUB\s?TOTAL|IMPUESTO|I\.G\.V|SON\s*:|PAGAR[ÉE]|TUCE|CHV|N[ÚU]MERO|BULTOS|ORDEN\s+DE\s+CARGA|C[ÓO]DIGO|DESCRIPCI|CANTIDAD|UNIDAD\s+DE\s+MEDIDA|^\s*ITEM\s|ORDEN\/PRODUCCI|LOTE\s+DEL\s+SISTEMA|SOLICITANTE|TURNO\s+Y\s+FECH|INSUMOS\s+EN\s+PROVEEDORES|NUMERO\s+REQUISICI|^ARTICULO\s*:|^LINEA\s*:|P[EÁ]GINA\s*:)/i

/**
 * REQUISICIÓN DE DEVOLUCIÓN DE MATERIAL (AJEPER, 2026-10-31): el documento
 * que acompaña a las devoluciones de línea NO es una guía de remisión —
 * el Nº viaja en "NUMERO REQUISICION : 0000192967" (dígitos, sin serie T).
 */
const RE_DOC_DEVOLUCION =
  /REQUISICI[OÓ]N\s+DE\s+DEVOLUCI[OÓ]N|DEVOLUCI[OÓ]N\s+DE\s+MATERIAL/i
const RE_NUM_REQUISICION = /NUMERO\s+REQUISICI[OÓ]N\s*:?\s*(\d{6,12})/
/** Orden de producción + solicitante (contexto de la devolución). */
const RE_ORDEN_PROD = /ORDEN\/PRODUCCI[OÓ]N\s*:?\s*(\d{4,12})/
const RE_SOLICITANTE = /SOLICITANTE\s*:?\s*(?:\d{0,8}\s*)?([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ,.\-]{4,60})/i

/** Tope de artículos reconocidos por guía (el usuario pidió soportar 20+). */
const MAX_ITEMS = 30

/** Umbrales del matching por descripción (calibrados con la guía real).
 *  Exportados: el OCR de RQ (rq-ocr.ts) reutiliza el MISMO criterio. */
export const UMBRAL_AUTO = 0.82 // ≥ auto: código del catálogo, chip azul de confirmación
export const UMBRAL_MIN = 0.62 // ≥ débil: código sugerido + revisión
export const COHERENCIA_CODIGO = 0.45 // código exacto cuya descripción debe coincidir

// ═══════════════════════════════════════════════════════════════════
// 2. UTILIDADES DE TEXTO
// ═══════════════════════════════════════════════════════════════════

function limpiarLineas(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.replace(/[|]+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((l) => l.length > 0)
}

/** Mayúsculas sin acentos (Ñ→N, ¥→N) para comparar descripciones. */
function quitarAcentos(s: string): string {
  return s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/¥/g, 'N')
}

/** Tokens de una descripción: palabras (peso 1) y números (peso 3). */
type TokenDesc = { tok: string; num: boolean; peso: number }

function tokensDe(s: string): TokenDesc[] {
  return quitarAcentos(s)
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => ({ tok: t, num: /^\d+$/.test(t), peso: /^\d+$/.test(t) ? 3 : 1 }))
}

/** Crédito de coincidencia entre dos palabras (1 total, 0.5 parcial, 0). */
function creditoToken(a: string, b: string): number {
  if (a === b) return 1
  const min = Math.min(a.length, b.length)
  let com = 0
  while (com < min && a[com] === b[com]) com++
  if (com >= 5) return 1 // separador/separadora, termocontra…/termocontra…
  if (com >= 4 && a.length >= 6 && b.length >= 6) return 0.5 // alconol≈alcohol
  return 0
}

/** Crédito entre NÚMEROS: exacto (1), casi (0.5: prefijo o 1 dígito lejano), distinto (0). */
function creditoNum(a: string, b: string): number {
  if (a === b) return 1
  if (Math.abs(a.length - b.length) <= 1 && (a.startsWith(b) || b.startsWith(a))) return 0.5
  const min = Math.min(a.length, b.length)
  let com = 0
  while (com < min && a[com] === b[com]) com++
  if (com >= 2 && min >= 3) return 0.5 // 155≈156 (OCR), 100≠145 (medida distinta)
  return 0
}

/** Regla de negocio histórica del app: '09' == '9' al comparar códigos. */
function mismaClave(a: string, b: string): boolean {
  const na = a.trim().toUpperCase()
  const nb = b.trim().toUpperCase()
  if (na === nb) return true
  return na.replace(/^0+/, '') === nb.replace(/^0+/, '')
}

/**
 * Esqueleto anti-confusión OCR: los caracteres 0/O/D/Q se leen
 * indistintamente ("0090000H0AD" ≈ "0090000HOAO"). Se quitan para
 * comparar códigos alfanuméricos largos.
 */
function esqueleto(token: string): string {
  return token.replace(/[0ODQ]/g, '')
}

/**
 * true si a y b difieren en EXACTAMENTE 1 sustitución de un carácter
 * (misma longitud, 1 desigualdad). Para códigos numéricos mal leídos.
 */
function levenshtein1(a: string, b: string): boolean {
  if (a === b) return false
  if (a.length !== b.length) return false
  let dif = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && ++dif > 1) return false
  }
  return dif === 1
}

// ═══════════════════════════════════════════════════════════════════
// 3. SIMILITUD DE DESCRIPCIONES (el corazón del matching)
// ═══════════════════════════════════════════════════════════════════

/**
 * Similitud 0..1 entre una descripción leída por OCR y una del catálogo.
 *   · Los NÚMEROS pesan 3× ("145 ML" vs "100 ML" decide el match).
 *   · Un número del OCR que no aparece en el catálogo penaliza fuerte.
 *   · Palabras: igualdad o prefijo común (≥5 total; ≥4 si ambas ≥6 letras).
 */
export function similitudDescripcion(descOCR: string, descCatalogo: string): number {
  const A = tokensDe(descOCR)
  const B = tokensDe(descCatalogo)
  if (A.length === 0 || B.length === 0) return 0

  const mejor = (t: TokenDesc, otros: TokenDesc[]): number => {
    let m = 0
    for (const y of otros) {
      const c = t.num ? creditoNum(t.tok, y.tok) : creditoToken(t.tok, y.tok)
      if (c > m) m = c
      if (m === 1) break
    }
    return m
  }

  let covA = 0
  let penalNumA = 0
  for (const x of A) {
    const c = mejor(x, B)
    covA += x.peso * c
    if (x.num && c === 0) penalNumA += 3
  }
  let covB = 0
  for (const y of B) covB += y.peso * mejor(y, A)

  const sA = A.reduce((s, x) => s + x.peso, 0)
  const sB = B.reduce((s, y) => s + y.peso, 0)
  // Dos perspectivas: simetría (65/35) y contención (el catálogo dentro del
  // OCR, robusto cuando el OCR añade ruido a la descripción). La contención
  // SOLO alcanza la banda de revisión: un match por contención nunca es
  // "auto" (el usuario pidió extracción estricta y verificable).
  const simetrica = 0.65 * (covA / sA) + 0.35 * (covB / sB)
  const contencion = Math.min(0.45 * (covA / sA) + 0.55 * (covB / sB), UMBRAL_AUTO - 0.01)
  const base = Math.max(simetrica, contencion)
  const penal = 0.15 * (penalNumA / sA)
  return Math.max(0, Math.min(1, base - penal))
}

export type MatchDescripcion = { item: CatalogoItem; score: number }

/** Mejor coincidencia por descripción del OCR contra todo el catálogo. */
export function buscarPorDescripcion(
  descripcionOCR: string,
  catalogo: CatalogoItem[]
): MatchDescripcion | null {
  if (!descripcionOCR.trim() || catalogo.length === 0) return null
  let mejor: MatchDescripcion | null = null
  for (const item of catalogo) {
    const score = similitudDescripcion(descripcionOCR, item.descripcion || '')
    if (score > 0 && (!mejor || score > mejor.score)) mejor = { item, score }
    if (mejor && mejor.score >= 0.995) break
  }
  return mejor && mejor.score >= UMBRAL_MIN ? mejor : null
}

// ═══════════════════════════════════════════════════════════════════
// 4. ENCABEZADO (nº de guía / placa / proveedor)
// ═══════════════════════════════════════════════════════════════════

function extraerPlaca(lineas: string[]): string {
  // Acepta la etiqueta con o sin paréntesis: "PLACA (TRACTO): X" / "PLACA TRACTO: X".
  const reEtiqueta = /PLACA[S]?\s*\(?\s*(?:TRACTO|TRACTOR|CARRETA|REMOLQUE)?\s*\)?\s*(?:N[º°.]?)?\s*:?\s*(.+)$/i
  const RE_NO_PLACA = /^(?:TRACTO|TRACTOR|CARRETA|REMOLQUE|REMOLCADOR|PLACA|LICENCIA|CODIGO)$/i
  for (const linea of lineas) {
    const m = linea.match(reEtiqueta)
    if (!m) continue
    const mp = m[1].match(/\b([A-Z0-9]{2,4})[-\s]?([A-Z0-9]{3})\b/i)
    if (mp) {
      const bruto = mp[0].replace(/\s+/g, '').toUpperCase()
      if (RE_NO_PLACA.test(bruto)) continue
      if (/^\d{6,}$/.test(bruto.replace('-', ''))) continue
      if (/^[A-Z]{3}\d{3}$/.test(bruto) || /^\d{3}[A-Z]{3}$/.test(bruto)) {
        return `${bruto.slice(0, 3)}-${bruto.slice(3)}`
      }
      return bruto
    }
  }
  return ''
}

function extraerProveedor(lineas: string[]): string {
  const RE_CORTE =
    /\s+(?:FEC\.?\s*EMIS|FECHA|FACTURA|ORDEN|RUC|NUMERO|N[º°]|DIRECCI[ÓO]N|NOMBRE\s+COMERCIAL|OTRO\s+SUSTENTO|TELEFONO|TEL\.|SERIE)/i
  const etiquetas = [/RAZ[OÓ]N\s+SOCIAL/i, /PROVEEDOR/i, /SE[ÑN]ORES/i]
  for (const re of etiquetas) {
    for (const linea of lineas) {
      const m = linea.match(re)
      if (!m) continue
      const resto = linea.slice((m.index ?? 0) + m[0].length).replace(/^\s*:?\s*/, '')
      if (!resto) continue
      const val = resto
        .split(RE_CORTE)[0]
        .replace(/\s{2,}.*$/, '')
        .replace(/[,;:.]+$/, '')
        .trim()
      if (val.length >= 3 && val.length <= 80) return val
    }
  }
  // REQUISICIÓN DE DEVOLUCIÓN: la empresa va SUELTA en el encabezado (esquina
  // superior izquierda, "AJEPER S.A.") — sin etiqueta. Respaldo: la primera
  // línea corta con forma de razón social (…S.A./S.A.C.). limpiarLineas ya
  // colapsó los espacios, así que el límite es UN espacio o fin de línea.
  for (const linea of lineas.slice(0, 6)) {
    const m = linea.match(
      /^[^A-Za-z]*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .,&\-]{0,25}?(?:S\.?\s?A\.?C?\.?|E\.?\s?I\.?\s?R\.?\s?L\.?))(?:\s|$)/
    )
    if (m && !/REQUISICI|DEVOLUCI|MATERIAL|GU[IÍ]A|FACTURA|ORDEN|PAGINA|INSUMOS/i.test(m[1])) {
      const val = m[1].trim()
      if (val.length >= 3) return val
    }
  }
  return ''
}

/** Corrige la T perdida por el OCR en el número de guía (7173→T173, 005→T005). */
function normalizarSerieGuia(candidato: string, textoUpper: string): string {
  const limpio = candidato.replace(/\s+/g, '')
  if (/^T\d{3}-\d{5,8}$/.test(limpio)) return limpio
  if (!/GU[IÍ]A/.test(textoUpper)) return limpio
  const m = limpio.match(/^(\d{3,4})-(\d{5,8})$/)
  if (m) {
    if (m[1].length === 4 && m[1][0] === '7') return `T${m[1].slice(1)}-${m[2]}`
    if (m[1].length === 3) return `T${m[1]}-${m[2]}`
  }
  return limpio
}

// ═══════════════════════════════════════════════════════════════════
// 5. FILAS DE TABLA (parser de líneas "ITEM CÓDIGO DESCRIPCIÓN CANT UND PESO")
// ═══════════════════════════════════════════════════════════════════

/** Cantidad válida: no es el propio código, ni fecha, ni serie larga.
 *  REQUISICIÓN (4 decimales): 15,040.0000 → 9 dígitos — el tope pasa de 9 a
 *  10 para no rechazarla; series/fechas siguen fuera (separadores distintos). */
function esCantidadValida(tok: string, codigo: string): boolean {
  if (mismaClave(tok.replace(/[.,]/g, ''), codigo)) return false
  if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(tok)) return false
  if (tok.replace(/[.,]/g, '').length >= 10) return false
  return true
}

/**
 * Los OCR "pegan" cantidades grandes sin separadores: "77327000" ≈ 773,270.00
 * (la guía impresa SIEMPRE trae 2 decimales). Si el número plano tiene ≥5
 * dígitos, termina en "00" y la línea trae OTRO número con separadores
 * (el peso, señal del formato 9,999.99), se reconstituye:
 *   77327000 → 773,270.00 · 128000 → 1,280.00 · 54600000 → 546,000.00
 */
function rescatarCantidadPlana(tok: string, linea: string): string {
  if (!/^\d{3,}00$/.test(tok)) return tok
  const idx = linea.indexOf(tok)
  if (idx < 0) return tok
  const sinTok = linea.slice(0, idx) + ' ' + linea.slice(idx + tok.length)
  if (!RE_CANTIDAD.test(sinTok)) return tok
  const entero = tok.slice(0, -2).replace(/^0+/, '') || '0'
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${conMiles}.00`
}

/**
 * Parsea las filas de la tabla de artículos desde un texto OCR.
 * Pensado para el ZOOM de la franja de tabla (texto limpio), pero también
 * se usa sobre la página completa (modo respaldo).
 */
export function extraerFilasDeTabla(texto: string): FilaTabla[] {
  const filas: FilaTabla[] = []
  for (const linea of limpiarLineas(texto)) {
    if (linea.length < 5) continue
    if (RE_SKIP_LINEA.test(linea)) continue
    if (!/[A-Za-z]{3}/.test(linea) || !/\d/.test(linea)) continue

    let toks = linea.split(/\s+/)
    let itemNum = ''
    if (toks.length > 1 && /^\d{1,2}$/.test(toks[0])) {
      itemNum = toks[0]
      toks = toks.slice(1)
    }

    // Código: el token con dígitos de las 2 PRIMERAS posiciones tras el nº de
    // item (la columna CÓDIGO es adyacente). Los OCR dejan basura pegada
    // ("|es", "E") antes del código; una línea con SOLO el código es fila.
    let codigoOCR = ''
    for (let i = 0; i < Math.min(2, toks.length); i++) {
      if (/^[A-Z0-9]{1,12}$/i.test(toks[i]) && /\d/.test(toks[i])) {
        codigoOCR = toks[i].toUpperCase()
        toks = toks.slice(i + 1)
        break
      }
      if (/[A-Za-z]{3,}/.test(toks[i])) break // ya empezó la descripción
    }

    // Última unidad reconocible de la línea (la de la columna UNIDAD;
    // unidades dentro de la descripción como "…X 28 KG)" quedan antes).
    let ui = -1
    for (let i = 0; i < toks.length; i++) {
      if (UNIDADES.has(toks[i].replace(/[^A-ZÑ]/gi, '').toUpperCase())) ui = i
    }

    let cantidad = ''
    let descripcion: string[]
    if (ui >= 1) {
      // Cantidad = primer número válido a la IZQUIERDA de la unidad.
      for (let i = ui - 1; i >= 0; i--) {
        const tokLimpio = toks[i].replace(/^[.:;]+|[.:;]+$/g, '')
        if (RE_CANTIDAD_EXACTA.test(tokLimpio)) {
          if (esCantidadValida(tokLimpio, codigoOCR)) cantidad = rescatarCantidadPlana(tokLimpio, linea)
          break
        }
        // Número plano grande pegado por el OCR: "77327000" ≈ 773,270.00
        // (la guía siempre imprime 2 decimales; el peso de la línea los trae).
        if (/^\d{3,}00$/.test(tokLimpio) && esCantidadValida(tokLimpio, codigoOCR)) {
          const rescate = rescatarCantidadPlana(tokLimpio, linea)
          if (rescate !== tokLimpio) {
            cantidad = rescate
            break
          }
        }
        // OCR con basura pegada al número: "4,000:09" → aceptar "4,000".
        const m2 = new RegExp(RE_CANTIDAD.source).exec(tokLimpio)
        if (m2 && m2[0].length >= tokLimpio.length - 3 && esCantidadValida(m2[0], codigoOCR)) {
          cantidad = m2[0]
          break
        }
      }
      // REQUISICIÓN DE DEVOLUCIÓN (columnas UNID. → CANTIDAD, al revés que la
      // guía): si a la IZQUIERDA de la unidad no hay número, se busca el
      // PRIMERO válido a la DERECHA ("KG 15,040.0000"). Solo cuando el lado
      // izquierdo falló: una fila de guía bien formada jamás llega aquí.
      if (!cantidad) {
        for (let i = ui + 1; i < toks.length; i++) {
          const tokLimpio = toks[i].replace(/^[.:;]+|[.:;]+$/g, '')
          if (RE_CANTIDAD_EXACTA.test(tokLimpio)) {
            if (esCantidadValida(tokLimpio, codigoOCR)) cantidad = tokLimpio
            break
          }
          // "Pendiente"/texto: la columna terminó.
          if (/[A-Za-z]{3,}/.test(toks[i])) break
        }
      }
      // Descripción = hasta la última palabra con letras; los números
      // sueltos que quedan justo antes de la unidad (cantidad/peso sin
      // reconocer) NO son parte de la descripción.
      let fin = ui - 1
      while (fin >= 0 && !/[A-Za-z]/.test(toks[fin])) fin--
      descripcion = toks.slice(0, fin + 1)
    } else {
      // Sin unidad: descripción = tokens con letras (los números sueltos
      // se dejan: "470 CM X 50" y "145 ML" aportan al matching).
      descripcion = toks
      if (descripcion.length > 0 && /\d/.test(descripcion[descripcion.length - 1]) && !/[A-Za-z]/.test(descripcion[descripcion.length - 1])) {
        descripcion = descripcion.slice(0, -1)
      }
      // Si la línea trae UN SOLO número válido aparte del código, ese es
      // la cantidad (filas cuya unidad el OCR no logró leer).
      const numeros = toks
        .map((t) => t.replace(/^[.:;]+|[.:;]+$/g, ''))
        .filter((t) => RE_CANTIDAD_EXACTA.test(t) && esCantidadValida(t, codigoOCR))
      if (numeros.length === 1) cantidad = rescatarCantidadPlana(numeros[0], linea)
    }

    const descripcionOCR = descripcion.join(' ').replace(/^[^\w]+/, '').trim()
    // Guardias: una fila necesita código, o descripción real (≥3 letras).
    if (!codigoOCR && !/[A-ZÑÁÉÍÓÚÜa-zñ]{3,}/.test(descripcionOCR)) continue
    if (codigoOCR && mismaClave(codigoOCR, itemNum) && !descripcionOCR) continue

    filas.push({
      linea,
      itemNum,
      codigoOCR,
      descripcionOCR,
      cantidad,
      unidad: ui >= 0 ? toks[ui].replace(/[^A-ZÑ]/gi, '').toUpperCase() : '',
    })
    if (filas.length >= MAX_ITEMS + 10) break
  }
  return filas
}

// ═══════════════════════════════════════════════════════════════════
// 6. RESOLUCIÓN DE FILAS → ARTÍCULOS
// ═══════════════════════════════════════════════════════════════════

type IndicesCatalogo = {
  porCodigo: Map<string, CatalogoItem>
  porEsqueleto: Map<string, CatalogoItem>
}

function indicesDeCatalogo(catalogo: CatalogoItem[]): IndicesCatalogo {
  const porCodigo = new Map<string, CatalogoItem>()
  const porEsqueleto = new Map<string, CatalogoItem>()
  for (const item of catalogo) {
    const codigo = item.codigo.trim().toUpperCase()
    porCodigo.set(codigo, item)
    if (codigo.length >= 5 && /[A-Z]/.test(codigo) && esqueleto(codigo).length >= 3) {
      const sk = esqueleto(codigo)
      if (!porEsqueleto.has(sk)) porEsqueleto.set(sk, item)
    }
  }
  return { porCodigo, porEsqueleto }
}

/** Unidad de la fila; si el catálogo la trae, manda el catálogo. */
function unidadDeFila(fila: FilaTabla, cat?: CatalogoItem): string {
  if (cat?.un) return cat.un
  return fila.unidad
}

/**
 * Convierte filas crudas en artículos. `modoEstricto` (página completa)
 * descarta filas sin nada útil; en modo franja todo queda editable.
 */
function resolverFilas(
  filas: FilaTabla[],
  catalogo: CatalogoItem[],
  indices: IndicesCatalogo,
  modoEstricto: boolean
): ItemGuia[] {
  const items: ItemGuia[] = []
  const vistos = new Set<string>()

  function push(it: ItemGuia) {
    if (!it.codigo && !it.descripcion) return
    const descClave = quitarAcentos(it.descripcion).replace(/[^A-Z0-9 ]/g, '').trim()
    // La clave incluye cantidad y descripción: una guía puede traer EL MISMO
    // código en 2 filas (mismo artículo, 2 lotes/cantidades) y esas filas son
    // legítimas — antes la 2ª se descartaba en silencio. Solo colapsa el
    // "tartamudeo" del OCR (misma línea leída 2 veces idéntica).
    const clave = it.codigo
      ? `C:${it.codigo.toUpperCase().replace(/^0+/, '')}|${it.cantidad.trim()}|${descClave}`
      : `D:${descClave}|${it.cantidad.trim()}`
    if (vistos.has(clave)) return
    vistos.add(clave)
    items.push(it)
  }

  for (const fila of filas) {
    const desc = fila.descripcionOCR
    let item: ItemGuia | null = null

    if (fila.codigoOCR) {
      const cat =
        indices.porCodigo.get(fila.codigoOCR) ??
        [...indices.porCodigo.entries()].find(([c]) => mismaClave(c, fila.codigoOCR))?.[1]

      if (cat) {
        // a) exacto + coherente → OK | b) exacto + incoherente → re-buscar
        const coher = desc ? similitudDescripcion(desc, cat.descripcion || '') : 1
        if (coher >= COHERENCIA_CODIGO) {
          item = {
            codigo: cat.codigo.trim().toUpperCase(),
            descripcion: cat.descripcion || desc,
            cantidad: fila.cantidad,
            unidad: unidadDeFila(fila, cat),
            enCatalogo: true,
          }
        } else {
          const alt = buscarPorDescripcion(desc, catalogo)
          if (alt && !mismaClave(alt.item.codigo, cat.codigo)) {
            item = {
              codigo: alt.item.codigo.trim().toUpperCase(),
              descripcion: alt.item.descripcion || desc,
              cantidad: fila.cantidad,
              unidad: unidadDeFila(fila, alt.item),
              enCatalogo: true,
              matchPorDescripcion: true,
              revision: alt.score < UMBRAL_AUTO,
            }
          } else {
            item = {
              codigo: cat.codigo.trim().toUpperCase(),
              descripcion: cat.descripcion || desc,
              cantidad: fila.cantidad,
              unidad: unidadDeFila(fila, cat),
              enCatalogo: true,
              revision: true,
            }
          }
        }
      } else {
        // c) no catalogado: vecino a 1 dígito validado por descripción,
        //    luego matching por descripción, luego fila editable.
        const esqueletoFila = esqueleto(fila.codigoOCR)
        const vecino =
          fila.codigoOCR.length >= 5
            ? indices.porEsqueleto.get(esqueletoFila)
            : undefined
        let vecinoOk: CatalogoItem | undefined
        if (vecino && (desc ? similitudDescripcion(desc, vecino.descripcion || '') : 0) >= UMBRAL_MIN) {
          vecinoOk = vecino
        } else if (fila.codigoOCR.length >= 3 && catalogo.length > 0) {
          let hit: CatalogoItem | undefined
          let duplicado = false
          for (const c of catalogo) {
            const codigo = c.codigo.trim().toUpperCase()
            if (Math.abs(codigo.length - fila.codigoOCR.length) > 1) continue
            if (levenshtein1(fila.codigoOCR, codigo)) {
              if (hit) {
                duplicado = true
                break
              }
              hit = c
            }
          }
          if (hit && !duplicado && (desc ? similitudDescripcion(desc, hit.descripcion || '') : 0) >= UMBRAL_MIN) {
            vecinoOk = hit
          }
        }
        if (vecinoOk) {
          item = {
            codigo: vecinoOk.codigo.trim().toUpperCase(),
            descripcion: vecinoOk.descripcion || desc,
            cantidad: fila.cantidad,
            unidad: unidadDeFila(fila, vecinoOk),
            enCatalogo: true,
            matchPorDescripcion: true,
          }
        } else {
          const alt = buscarPorDescripcion(desc, catalogo)
          if (alt) {
            item = {
              codigo: alt.item.codigo.trim().toUpperCase(),
              descripcion: alt.item.descripcion || desc,
              cantidad: fila.cantidad,
              unidad: unidadDeFila(fila, alt.item),
              enCatalogo: true,
              matchPorDescripcion: true,
              revision: alt.score < UMBRAL_AUTO,
            }
          } else if (!modoEstricto || !desc) {
            item = {
              codigo: fila.codigoOCR,
              descripcion: desc,
              cantidad: fila.cantidad,
              unidad: fila.unidad,
              enCatalogo: false,
              revision: true,
            }
          }
        }
      }
    } else {
      // d) sin código legible: la descripción manda.
      const alt = buscarPorDescripcion(desc, catalogo)
      if (alt) {
        item = {
          codigo: alt.item.codigo.trim().toUpperCase(),
          descripcion: alt.item.descripcion || desc,
          cantidad: fila.cantidad,
          unidad: unidadDeFila(fila, alt.item),
          enCatalogo: true,
          matchPorDescripcion: true,
          revision: alt.score < UMBRAL_AUTO,
        }
      } else if (!modoEstricto && desc && (fila.unidad || fila.cantidad)) {
        // Fila sin código pero con estructura real (unidad o cantidad).
        // Sin ellos es ruido del OCR (líneas cortadas del encabezado).
        item = {
          codigo: '',
          descripcion: desc,
          cantidad: fila.cantidad,
          unidad: fila.unidad,
          enCatalogo: false,
          revision: true,
        }
      }
    }

    if (item) push(item)
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

// ═══════════════════════════════════════════════════════════════════
// 7. API PRINCIPAL
// ═══════════════════════════════════════════════════════════════════

/**
 * Cantidad de respaldo cuando ningún código coincidió con el catálogo:
 * la tabla de ítems va SIEMPRE después de la sección transportista.
 */
function extraerCantidadFallback(lineas: string[]): string {
  let desde = 0
  for (let i = 0; i < lineas.length; i++) {
    if (/TRANSPORTISTA|BIENES\s+TRANSPORTADOS/i.test(lineas[i])) desde = i + 1
  }
  for (const linea of lineas.slice(desde)) {
    const limpia = linea.replace(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, '')
    const m = new RegExp(RE_CANTIDAD.source).exec(limpia)
    if (m && m[0].replace(/[.,]/g, '').length < 9) return m[0]
  }
  return ''
}

/**
 * Punto de entrada COMPLETO: texto OCR de la página + (opcional) texto OCR
 * del zoom de la franja de tabla. El zoom tiene PRIORIDAD para los
 * artículos (se lee entero y sin ruido del encabezado).
 */
export function extraerDatosGuiaDeTextos(
  textoCompleto: string,
  textoTabla: string | null,
  catalogo: CatalogoItem[]
): DatosGuia {
  const lineas = limpiarLineas(textoCompleto)
  const texto = lineas.join('\n')
  const textoUp = texto.toUpperCase()

  const conT = textoCompleto.match(RE_GUIA)
  const sinT = conT ? null : textoCompleto.match(RE_GUIA_SIN_T)
  const crudo = conT ? conT[0] : sinT ? sinT[0] : ''
  // REQUISICIÓN DE DEVOLUCIÓN: sin Nº de guía (T###-######), el Nº propio
  // viaja en "NUMERO REQUISICION : 0000192967" (puro dígito — sin la
  // normalización de serie T que solo aplica a guías).
  const mRequisicion = crudo ? null : textoCompleto.match(RE_NUM_REQUISICION)
  const esRequisicion = RE_DOC_DEVOLUCION.test(textoUp) || Boolean(mRequisicion)

  const indices = indicesDeCatalogo(catalogo)
  // EXHAUSTIVO: se parsean AMBAS lecturas (zoom de la tabla y página
  // completa) y se FUSIONAN con dedupe. Antes el zoom GANABA todo y las
  // filas que solo la página completa había leído se perdían en silencio;
  // ahora cada pase rescata filas que el otro perdió (la clave de dedupe
  // elimina las que ambos leyeron idénticas).
  const itemsZoom =
    textoTabla && textoTabla.trim()
      ? resolverFilas(extraerFilasDeTabla(textoTabla), catalogo, indices, false)
      : []
  const itemsPagina = resolverFilas(extraerFilasDeTabla(texto), catalogo, indices, true)
  let items: ItemGuia[] = []
  const avisos: string[] = []
  // Fusión zoom + página por IDENTIDAD con votación de cantidades (Task 23):
  // el mismo artículo leído distinto en los 2 recorridos se unifica con
  // revisión + aviso — antes quedaba DUPLICADO (claveItem incluía cantidad).
  items = unirItemsGuia(itemsZoom, itemsPagina, avisos)
  if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS)
  // EXHAUSTIVIDAD visible: una fila leída SIN cantidad es una lectura
  // incompleta (el OCR se comió el número) → queda marcada "revisar con la
  // guía" en el formulario en vez de pasar desapercibida hasta el guardado.
  items = items.map((it) => (it.cantidad.trim() ? it : { ...it, revision: true }))

  const cantidadSugerida = (items.length > 0 && items[0].cantidad) || extraerCantidadFallback(lineas)
  // Contexto de la requisición de devolución → observaciones del registro
  // ("OP 2026008387 · Solicita: CANALES MORI, ROBERTO SERGIO").
  let notasDevolucion = ''
  if (esRequisicion) {
    const op = textoUp.match(RE_ORDEN_PROD)?.[1] ?? ''
    const sol = (textoCompleto.match(RE_SOLICITANTE)?.[1] ?? '').trim()
    notasDevolucion = [
      op ? `OP ${op}` : '',
      sol ? `Solicita: ${sol.replace(/\s{2,}/g, ' ').replace(/[,;:]+$/, '')}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return {
    numeroGuia: crudo
      ? normalizarSerieGuia(crudo, textoUp)
      : mRequisicion
        ? mRequisicion[1]
        : '',
    placa: extraerPlaca(lineas),
    proveedor: extraerProveedor(lineas),
    items,
    cantidadSugerida,
    ...(esRequisicion ? { esRequisicionDevolucion: true } : {}),
    ...(notasDevolucion ? { notasDevolucion } : {}),
    ...(avisos.length > 0 ? { avisos } : {}),
  }
}

/**
 * Punto de entrada clásico (solo página completa). Mantiene la firma que
 * usan los tests y cualquier flujo sin zoom de tabla.
 */
export function extraerDatosGuia(textoOcr: string, catalogo: CatalogoItem[]): DatosGuia {
  return extraerDatosGuiaDeTextos(textoOcr, null, catalogo)
}

// ═══════════════════════════════════════════════════════════════════
// 7bis. FUSIÓN Y TRAMOS (extracción EXHAUSTIVA)
// ═══════════════════════════════════════════════════════════════════

/**
 * Divide una franja vertical [y0, y1] (px de la foto original) en tramos
 * de `altoMax` con `solape` px de superposición. El zoom de la tabla COMPLETA
 * a ×3 produce imágenes enormes en guías de 15-30 artículos (el OCR pierde
 * filas enteras al final); con tramos cada lectura queda en tamaño manejable
 * y el solape garantiza que ninguna fila caiga exactamente en un corte.
 */
export function dividirFranjaEnBandas(
  y0: number,
  y1: number,
  altoMax = 900,
  solape = 60
): Array<{ y0: number; y1: number }> {
  const alto = y1 - y0
  if (alto <= 0) return []
  if (alto <= altoMax) return [{ y0, y1 }]
  const bandas: Array<{ y0: number; y1: number }> = []
  let inicio = y0
  while (inicio < y1) {
    const fin = Math.min(y1, inicio + altoMax)
    bandas.push({ y0: inicio, y1: fin })
    if (fin >= y1) break
    inicio = fin - solape
  }
  return bandas
}

/**
 * IDENTIDAD de un artículo SIN la cantidad (Task 23 — bug raíz del QR con
 * "información incorrecta"): la clave anterior incluía la cantidad, así que
 * dos pases que leían distinto el MISMO artículo ("2,884" vs "2,889" —
 * confusión 4↔9) NO se deduplicaban: el artículo entraba DOS veces con
 * cifras contradictorias y ambas llegaban a las paletas y a los rótulos.
 * La identidad de un artículo es su código + descripción — NUNCA su cantidad.
 */
function claveIdentidad(it: ItemGuia): string {
  const descClave = quitarAcentos(it.descripcion)
    .replace(/[^A-Z0-9 ]/g, '')
    .trim()
  return it.codigo
    ? `C:${it.codigo.toUpperCase().replace(/^0+/, '')}|${descClave}`
    : `D:${descClave}`
}

/**
 * Convierte una cantidad leída a número (mismo criterio que rq-ocr.aNumero:
 * coma = miles, punto = decimales; "50,400.0000" → 50400; "2,884" → 2884).
 * Copia local PURA: rq-ocr importa de este módulo (no hay que crear ciclo).
 */
function aNumeroGuia(lectura: string): number {
  let s = (lectura ?? '').trim().replace(/[^\d.,]/g, '')
  if (!s) return 0
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/,/g, '')
  } else if (s.includes(',')) {
    const partes = s.split(',')
    s = partes.slice(1).every((p) => p.length === 3) ? partes.join('') : s.replace(',', '.')
  }
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

/** Tolerancia para considerar dos cantidades la misma lectura. */
const EPS_CANTIDAD = 0.0005

/**
 * Une dos listas de items SIN duplicados por IDENTIDAD (código + descripción
 * — la cantidad NO es identidad, ver claveIdentidad). Reglas por artículo:
 *   · lectura idéntica → se queda la primera (dedupe de pases);
 *   · cifras que difieren en UN dígito confuso (4↔9…) → VOTACIÓN (mismo
 *     criterio que rq-ocr.fusionarDatosRq): gana la lectura en catálogo (o
 *     la primera), la fila queda a revisión y se emite aviso — jamás se
 *     adivina el dígito;
 *   · cifras MUY distintas (2+ dígitos) → filas legítimas de 2 lotes: se
 *     conservan ambas (regresión: el mismo código en 2 filas es válido).
 */
function unirItemsGuia(base: ItemGuia[], extra: ItemGuia[], avisos: string[]): ItemGuia[] {
  const out: ItemGuia[] = []
  const indice = new Map<string, number[]>()
  for (const it of [...base, ...extra]) {
    const clave = claveIdentidad(it)
    const posiciones = indice.get(clave) ?? []
    let fusionada = false
    for (const i of posiciones) {
      const previo = out[i]
      const ca = aNumeroGuia(previo.cantidad)
      const cb = aNumeroGuia(it.cantidad)
      if (Math.abs(ca - cb) <= EPS_CANTIDAD) {
        fusionada = true // lectura idéntica: dedupe de pases
        break
      }
      if (sonVarianteOCRdeCantidad(previo.cantidad, it.cantidad)) {
        const ganador = !previo.enCatalogo && it.enCatalogo ? it : previo
        const aviso = `Cantidad de ${previo.codigo || previo.descripcion.slice(0, 24)} difiere entre lecturas (${previo.cantidad.trim()} / ${it.cantidad.trim()}) — revisa`
        if (!avisos.includes(aviso)) avisos.push(aviso)
        out[i] = { ...ganador, revision: true }
        fusionada = true
        break
      }
    }
    if (!fusionada) {
      indice.set(clave, [...posiciones, out.length])
      out.push(it)
    }
  }
  return out
}

/**
 * PARES DE DÍGITOS que el OCR confunde con más frecuencia (pedido explícito
 * del usuario 2026-10-24: "confunde el 4 con el 9"). Compartido por la guía
 * (votación de cantidades y vecinos de código) y la RQ (vecinos de código):
 * una sustitución de un par confuso gana desempates (+0.02 — determinista,
 * por debajo de cualquier diferencia real de similitud de descripción).
 */
export const PARES_CONFUSOS = new Set([
  '49', '94', // 4↔9 — el par reportado por el usuario
  '09', '90', // el 9 pierde la cola y parece 0
  '17', '71', '19', '91', // 1 se difumina en 7/9
  '06', '60', '08', '80', // contornos redondos
  '56', '65', '38', '83', '27', '72',
])

/** +0.02 si la variante sustituye un dígito por su par confuso; 0 si no. */
export function bonusConfusion(original: string, variante: string): number {
  const o = original.replace(/\D/g, '')
  const v = variante.replace(/\D/g, '')
  if (o.length !== v.length) return 0
  for (let i = 0; i < o.length; i++) {
    if (o[i] !== v[i]) return PARES_CONFUSOS.has(o[i] + v[i]) ? 0.02 : 0
  }
  return 0
}

/**
 * ¿Dos lecturas de cantidad son la MISMA cifra con UN dígito confundido?
 * ("2,884" vs "2,889" → sí; "1,000" vs "2,500" → no: difieren en 2 dígitos
 * — son filas legítimas de 2 lotes y se conservan ambas). Discrimina el
 * ruido OCR de los lotes reales de un mismo artículo.
 */
export function sonVarianteOCRdeCantidad(x: string, y: string): boolean {
  const dx = (x ?? '').replace(/\D/g, '')
  const dy = (y ?? '').replace(/\D/g, '')
  if (!dx || !dy || dx.length !== dy.length) return false
  let pos = -1
  for (let i = 0; i < dx.length; i++) {
    if (dx[i] !== dy[i]) {
      if (pos >= 0) return false // difieren en ≥2 dígitos: filas distintas
      pos = i
    }
  }
  return pos >= 0 && PARES_CONFUSOS.has(dx[pos] + dy[pos])
}

/**
 * UMBRAL de confianza por palabra para números (0-100). Tesseract puntúa
 * bajo (60-80) justo cuando confunde dígitos parecidos (4↔9, 1↔7, 0↔6):
 * por debajo del umbral el número se reporta para verificación humana.
 */
export const UMBRAL_CONFIANZA_NUMERO = 75

/**
 * AVISOS por números leídos con baja confianza (Task 23 — "tienes que ser
 * muy riguroso al momento de leer los números"). PURA y compartida por la
 * RQ (rq-ocr) y la guía (GuiaFotoForm): tesseract entrega la confianza por
 * palabra y antes se descartaba — un «4» leído como «9» con 61% de
 * confianza pasaba sin advertencia salvo que 2 pases discreparan.
 * Deduplica por texto y se acota a 6 para no inundar la UI.
 */
export function avisoNumerosDebiles(palabras: PalabraOCR[]): string[] {
  const avisos: string[] = []
  const vistos = new Set<string>()
  for (const p of palabras) {
    const t = (p.t ?? '').trim()
    if (!/\d{2,}/.test(t)) continue // solo tokens con ≥2 dígitos seguidos
    if (p.conf === undefined || p.conf >= UMBRAL_CONFIANZA_NUMERO) continue
    if (vistos.has(t)) continue
    vistos.add(t)
    avisos.push(`Número «${t}» leído con ${Math.round(p.conf)}% de confianza — verifícalo`)
    if (avisos.length >= 6) break
  }
  return avisos
}

/**
 * FUSIÓN de 2 extracciones (pase principal vs 2º pase): toma los ARTÍCULOS
 * DE AMBAS (unión sin duplicados — antes el "ganador por puntos" descartaba
 * filas que el otro pase SÍ había leído) y completa el encabezado con el
 * primer valor no vacío. Para el nº de guía, si difieren gana el formato
 * canónico T###-###### (el OCR confunde la T inicial con 7/1).
 */
export function fusionarDatos(a: DatosGuia, b: DatosGuia): DatosGuia {
  const avisos: string[] = [...(a.avisos ?? []), ...(b.avisos ?? [])]
  // Fusión de los 2 pases por IDENTIDAD con votación de cantidades (Task 23):
  // el mismo artículo con cifras distintas queda 1 vez, a revisión, con aviso
  // — antes la clave con cantidad DUPLICABA el artículo y ambas filas llegaban
  // a las paletas/rótulos ("información incorrecta" reportada en Recepción).
  const items = unirItemsGuia(a.items, b.items, avisos)
  const eligeGuia = (x: string, y: string): string => {
    if (!x) return y
    if (!y) return x
    if (x === y) return x
    if (/^T\d{3}-\d{5,8}$/.test(x)) return x
    if (/^T\d{3}-\d{5,8}$/.test(y)) return y
    return x
  }
  return {
    numeroGuia: eligeGuia(a.numeroGuia, b.numeroGuia),
    placa: a.placa || b.placa,
    proveedor: a.proveedor || b.proveedor,
    items,
    cantidadSugerida: a.cantidadSugerida || b.cantidadSugerida,
    // Devoluciones: el contexto de la requisición viaja si ALGÚN pase lo leyó.
    esRequisicionDevolucion: a.esRequisicionDevolucion || b.esRequisicionDevolucion,
    notasDevolucion: a.notasDevolucion || b.notasDevolucion,
    ...(avisos.length > 0 ? { avisos } : {}),
  }
}

/**
 * PUNTUACIÓN de una extracción: sirve para elegir el mejor de varios
 * intentos de OCR (más estricto = revisar y quedarse con la mejor lectura).
 *   · artículo en catálogo +5 · no catalogado +2
 *   · nº de guía +4 · placa +4 · proveedor +2
 */
export function puntuarExtraccion(datos: DatosGuia): number {
  const items = datos.items.reduce((s, i) => s + (i.enCatalogo ? 5 : 2), 0)
  return (
    items +
    (datos.numeroGuia ? 4 : 0) +
    (datos.placa ? 4 : 0) +
    (datos.proveedor ? 2 : 0)
  )
}

// ═══════════════════════════════════════════════════════════════════
// 8. PALABRAS Y ANCLAS DE TABLA (word-boxes del OCR)
// ═══════════════════════════════════════════════════════════════════

/**
 * Extrae las palabras con sus cajas del resultado de tesseract.js v7
 * (data.blocks → paragraphs → lines → words). Tolerante a nulls.
 */
export function extraerPalabras(data: unknown): PalabraOCR[] {
  const out: PalabraOCR[] = []
  try {
    const blocks = (data as { blocks?: unknown[] | null })?.blocks
    if (!Array.isArray(blocks)) return out
    for (const b of blocks) {
      const paragraphs = (b as { paragraphs?: unknown[] })?.paragraphs ?? []
      for (const p of paragraphs) {
        const lines = (p as { lines?: unknown[] })?.lines ?? []
        for (const l of lines) {
          const words = (l as {
            words?: Array<{ text?: string; confidence?: unknown; bbox?: Partial<PalabraOCR> }>
          })?.words ?? []
          for (const w of words) {
            if (!w?.bbox) continue
            out.push({
              t: (w.text ?? '').toUpperCase(),
              x0: w.bbox.x0 ?? 0,
              y0: w.bbox.y0 ?? 0,
              x1: w.bbox.x1 ?? 0,
              y1: w.bbox.y1 ?? 0,
              // Tesseract v5+ entrega `confidence` por palabra (0-100).
              // Opcional: los tests y las lecturas sin bloques no la traen.
              conf: typeof w.confidence === 'number' ? w.confidence : undefined,
            })
          }
        }
      }
    }
  } catch {
    return out
  }
  return out
}

/**
 * Localiza la franja de la tabla de artículos usando las anclas del formato
 * estándar de guías: "BIENES TRANSPORTADOS" (inicio) y "NOTAS" (fin).
 * Devuelve coordenadas en el MISMO espacio de la imagen que se leyó.
 */
export function extraerAnclasTabla(
  palabras: PalabraOCR[]
): { yTop: number; yBot: number } | null {
  const top = palabras.find((p) => quitarAcentos(p.t).includes('TRANSPORTADOS'))
  if (!top) return null
  const bot = palabras
    .filter((p) => quitarAcentos(p.t).startsWith('NOTA') && p.y0 > top.y1)
    .sort((a, b) => a.y0 - b.y0)[0]
  if (!bot) return null
  const yTop = top.y1 + 2
  const yBot = bot.y0 - 2
  if (yBot - yTop < 40) return null
  return { yTop, yBot }
}

// ═══════════════════════════════════════════════════════════════════
// 9. IMAGEN
// ═══════════════════════════════════════════════════════════════════

/**
 * Reduce/normaliza una foto (JPEG) con canvas: lado mayor = `maxLado`.
 * Se usa para subir una foto liviana a Storage en lugar de la original.
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

/** Gris + realce de contraste pixel a pixel sobre el ImageData de un canvas. */
function aplicarGrisYContraste(ctx: CanvasRenderingContext2D, ancho: number, alto: number, contraste: number) {
  const img = ctx.getImageData(0, 0, ancho, alto)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const gris = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const v = Math.max(0, Math.min(255, Math.round((gris - 128) * contraste + 128)))
    d[i] = v
    d[i + 1] = v
    d[i + 2] = v
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * DESRUIDO post-contraste: el realce amplifica motas JPEG y bordes de tabla
 * que Tesseract detecta como "regiones de texto" degeneradas (p. ej. 2×36 px)
 * y llena la consola con "Image too small to scale!!" / "Line cannot be
 * recognized!!". Dos pasadas ligeras:
 *   1. Estirar extremos: casi-blanco → blanco puro, casi-negro → negro puro.
 *   2. Speckles: píxel oscuro con ≤1 vecino oscuro en 3×3 → blanco (el trazo
 *      real de letra siempre tiene vecinos oscuros y sobrevive).
 */
function desruidoImagen(ctx: CanvasRenderingContext2D, ancho: number, alto: number) {
  const img = ctx.getImageData(0, 0, ancho, alto)
  const d = img.data
  const n = ancho * alto
  for (let i = 0; i < n; i++) {
    const p = i * 4
    const v = d[p]
    if (v >= 210) {
      d[p] = d[p + 1] = d[p + 2] = 255
    } else if (v <= 60) {
      d[p] = d[p + 1] = d[p + 2] = 0
    }
  }
  const gris = new Uint8Array(n)
  for (let i = 0; i < n; i++) gris[i] = d[i * 4]
  for (let y = 1; y < alto - 1; y++) {
    for (let x = 1; x < ancho - 1; x++) {
      const i = y * ancho + x
      if (gris[i] >= 128) continue
      let oscuros = 0
      for (let dy = -1; dy <= 1; dy++) {
        const fila = (y + dy) * ancho
        for (let dx = -1; dx <= 1; dx++) {
          if (gris[fila + (x + dx)] < 128) oscuros++
        }
      }
      if (oscuros <= 1) {
        const p = i * 4
        d[p] = d[p + 1] = d[p + 2] = 255
      }
    }
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * MARGEN blanco alrededor del contenido (en px de la imagen preprocesada):
 * el análisis de layout de Tesseract falla (o genera regiones degeneradas)
 * cuando líneas/bordes de la tabla tocan el borde exacto de la imagen.
 * EXPORTADO: quien convierta coordenadas del OCR de vuelta a píxeles de la
 * foto original debe restarlo (ver GuiaFotoForm, zoom de tabla).
 */
export const MARGEN_OCR = 24

function prepararCanvasOCR(ancho: number, alto: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = ancho + MARGEN_OCR * 2
  canvas.height = alto + MARGEN_OCR * 2
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
  }
  return canvas
}

/**
 * PREPROCESADO para el OCR: escala a `maxLado`, pasa a GRIS y aplica
 * realce de contraste pixel a pixel. A diferencia de antes, TAMBIÉN
 * AMPLÍA fotos pequeñas (WhatsApp 960px): los códigos de la tabla son
 * letra pequeña y a 960px el OCR no los lee.
 */
export async function mejorarImagenOCR(archivo: File | Blob, maxLado = 2800): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(archivo)
    const escala = maxLado / Math.max(bitmap.width, bitmap.height)
    const ancho = Math.round(bitmap.width * escala)
    const alto = Math.round(bitmap.height * escala)
    const canvas = prepararCanvasOCR(ancho, alto)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      bitmap.close?.()
      return archivo
    }
    ctx.drawImage(bitmap, MARGEN_OCR, MARGEN_OCR, ancho, alto)
    bitmap.close?.()
    aplicarGrisYContraste(ctx, canvas.width, canvas.height, 1.45)
    desruidoImagen(ctx, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob(
        (b) => resolve(b && b.size > 0 ? b : archivo),
        'image/jpeg',
        0.92
      )
    })
  } catch {
    return archivo
  }
}

/**
 * ZOOM "cuadro por cuadro": recorta la franja [y0Px, y1Px] (en píxeles de la
 * foto ORIGINAL) y la escala `escalaExtra`× para releer la tabla de artículos
 * con detalle. Es la clave para que los códigos de letra pequeña se lean.
 */
export async function recortarFranjaTabla(
  archivo: File | Blob,
  y0Px: number,
  y1Px: number,
  escalaExtra = 3,
  maxAncho = 4600
): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(archivo)
    const y0 = Math.max(0, Math.round(y0Px))
    const y1 = Math.min(bitmap.height, Math.round(y1Px))
    const hF = y1 - y0
    if (hF < 30) {
      bitmap.close?.()
      return archivo
    }
    const esc = Math.min(escalaExtra, maxAncho / bitmap.width)
    const ancho = Math.round(bitmap.width * esc)
    const alto = Math.round(hF * esc)
    const canvas = prepararCanvasOCR(ancho, alto)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      bitmap.close?.()
      return archivo
    }
    ctx.drawImage(bitmap, 0, y0, bitmap.width, hF, MARGEN_OCR, MARGEN_OCR, ancho, alto)
    bitmap.close?.()
    aplicarGrisYContraste(ctx, canvas.width, canvas.height, 1.5)
    desruidoImagen(ctx, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob(
        (b) => resolve(b && b.size > 0 ? b : archivo),
        'image/jpeg',
        0.92
      )
    })
  } catch {
    return archivo
  }
}

/**
 * RACKLY — Atención a Línea · OCR del formato RAL (Requerimiento al Almacén).
 *
 * Parser HERMANO de rq-ocr.ts, calibrado a la PANTALLA ERP «Consulta
 * Requerimiento al Almacén» (RAL) — un FORMULARIO DE CAJILLAS SIN dos
 * puntos en el que el OCR fusiona columnas en un solo renglón:
 *   "AREA SOLICITANTE CADENA DE SUMINISTRO SOLICITANTE 138712 ENRIQUEZ…"
 * Encabezado: TOKENIZADOR DE ETIQUETAS — el renglón se parte en cada
 * etiqueta (con o sin ":") y cada campo toma el tramo hasta la siguiente
 * etiqueta REAL, con validadores en cascada (un falso positivo dentro de
 * un valor —p. ej. «…AL ALMACEN»— se descarta y NO corta).
 *   · Filas de material: [código] [descripción] [UND] [CEDIS] [CENTRO DE
 *     COSTOS] [pedida] [aprobada] [cancelada] [saldo] [parcial] [item].
 *     La PEDIDA es la PRIMERA cifra decimal de la corrida; CEDIS/Parcial/
 *     Item (enteros cortos) y la casilla ☑ (leída como V/X) son basura que
 *     se retira; la UNIDAD se busca desde la derecha (ya no está pegada a
 *     la cifra). Filas PARTIDAS por el OCR (código y descripción en
 *     renglones propios) se FUSIONAN con el fragmento pendiente.
 *   · ANTI-RUIDO: sin cifra la fila no es material; sin palabra real
 *     (≥3 letras) tampoco; fragmentos de fecha jamás.
 *   · Catálogo: match exacto por código; si el código falla, la
 *     descripción puede adoptar el código catalogado (queda a revisión).
 *
 * Campos que pidió el usuario (Task 36): AREA SOLICITANTE, DOCUMENTO,
 * SOLICITANTE, APROBADO POR, ALMACEN, TRANSACCIÓN, LINEA, CODIGO,
 * ARTICULO O DESCRIPCIÓN, UND, CENTRO DE COSTOS, CANTIDAD PEDIDA.
 *
 * Módulo PURO (sin red, sin DOM): testeable con esbuild+node.
 */

import type { CatalogoItem } from '@/lib/rackly/catalogo'
import { aNumero } from '@/lib/rackly/formato'

// ═══════════════════════════════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════════════════════════════

/** Material (línea) de un RAL. */
export type ItemRal = {
  codigo: string
  descripcion: string
  unidad: string
  centroCostos: string
  cantidad: number
  enCatalogo: boolean
  revision: boolean
  /** El OCR adoptó el código por similitud de descripción (chip azul). */
  matchPorDescripcion?: boolean
}

/** Datos extraídos de UN texto OCR del RAL. */
export type DatosRal = {
  documento: string
  transaccion: string
  /** 'YYYY-MM-DD' validada; '' si no se leyó. */
  fecha: string
  areaSolicitante: string
  solicitante: string
  aprobadoPor: string
  almacen: string
  linea: string
  items: ItemRal[]
  /** Rigor numérico: discrepancias que el usuario debe verificar. */
  avisos?: string[]
}

// ═══════════════════════════════════════════════════════════════════
// ANCLAS DEL ENCABEZADO — TOKENIZADOR DE ETIQUETAS
// ═══════════════════════════════════════════════════════════════════

/** Fecha estilo ERP (2026/10/27) y estilo clásico (27/10/2026). */
const RE_FECHA_YMD = /\b(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\b/
const RE_FECHA_DMY = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/

/**
 * Etiquetas que cortan el VALOR capturado cuando el OCR fusiona dos
 * renglones ("… CADENA DE SUMINISTRO SOLICITANTE : 7126 …"). EXIGE los dos
 * puntos: valores legítimos como «RAL Requerimiento al Almacén» o
 * «05 Almacén de Materia Prima» contienen palabras de etiqueta SIN serlo.
 * Tolerante a tildes del OCR en las propias etiquetas. (Respaldo del
 * tokenizador: los valores que él reparte ya no traen etiquetas con ":").
 */
const RE_CORTE_VALOR =
  /\s+(?:DOCUMENTO|FECHA|TRANSACC[IÍ1]?[OÓ]N|[AÁ]REA|SOLICITANTE|APROBAD\w*|ALMAC[EÉ]N|L[IÍ]NEA|MONEDA|OBSERVACI\w*|CONSULTA|CENTRO|CODIGO|ARTICULO|CANTIDAD|PEDIDA|APROBADA|SALDO)\s*[:：].*$/

/** Primera fecha válida dentro de un valor ('' si no hay). */
function fechaDeValor(valor: string): string {
  const mY = valor.match(RE_FECHA_YMD)
  if (mY) return normalizarFechaYMD(mY[1], mY[2], mY[3])
  const mD = valor.match(RE_FECHA_DMY)
  if (mD) return normalizarFechaDMY(mD[1], mD[2], mD[3])
  return ''
}

/**
 * Campo destino de cada etiqueta; null = etiqueta SOLO DE CORTE (su valor
 * se descarta, pero delimita al anterior: «FECHA ATENCION 00/00/0000»).
 */
type CampoRal =
  | 'documento'
  | 'fecha'
  | 'transaccion'
  | 'areaSolicitante'
  | 'solicitante'
  | 'aprobadoPor'
  | 'almacen'
  | 'linea'
  | null

type EtiquetaRal = {
  /** STICKY (/y): se prueba anclada en cada posición del renglón. */
  re: RegExp
  campo: CampoRal
  /** ¿Es una etiqueta REAL aquí? (valor + si traía ":") — en cascada. */
  valida: (valor: string, sep: boolean) => boolean
}

const ETIQUETAS: EtiquetaRal[] = [
  // ── Compuestas PRIMERO (comparten palabras con las simples) ──
  {
    re: /[AÁ]REA\s+SOLICITANT[EÉ]?\b\s*([:\-])?\s*/y,
    campo: 'areaSolicitante',
    valida: (v) => v.trim().length >= 2 && tienePalabraReal(v),
  },
  {
    re: /FECHA\s+(?:DE\s+)?ATENC[IÍ1][OÓ]N\b\s*([:\-])?\s*/y,
    campo: null,
    valida: () => true,
  },
  {
    re: /APROBAD[OA]S?\s+POR\b\s*([:\-])?\s*/y,
    campo: 'aprobadoPor',
    valida: (v) => limpiarPersona(v).length >= 4,
  },
  // Aprobado sin POR: solo se acepta con dos puntos (evita la columna
  // «Cant. Aprobada» de la tabla).
  {
    re: /APROBAD[OA]S?\b\s*([:])\s*/y,
    campo: 'aprobadoPor',
    valida: (v) => limpiarPersona(v).length >= 4,
  },
  {
    re: /FECHA\b\s*([:\-])?\s*/y,
    campo: 'fecha',
    valida: (v) => fechaDeValor(v) !== '',
  },
  {
    re: /TRANSACC[IÍ1]?[OÓ]N\b\s*([:\-])?\s*/y,
    campo: 'transaccion',
    valida: (v) => v.trim().length >= 2 && tienePalabraReal(v),
  },
  {
    re: /DOCUMENTO\b\s*([.:º°\-])?\s*/y,
    campo: 'documento',
    valida: (v) => /^\d{1,10}\b/.test(v.trim()),
  },
  {
    re: /ALMAC[EÉ]N\b\s*([:\-])?\s*/y,
    campo: 'almacen',
    // SIN ":" exige dígito inicial («05 MATERIAS…») — así la palabra
    // ALMACÉN dentro de «…AL ALMACEN DOCUMENTO…» o del título NO corta.
    valida: (v, sep) => (sep ? v.trim().length >= 1 : /^\d/.test(v.trim())),
  },
  {
    re: /L[IÍ]NEA\b\s*([:\-])?\s*/y,
    campo: 'linea',
    valida: (v) => v.trim().length >= 2,
  },
  {
    re: /SOLICITANT[EÉ]\b\s*([:\-])?\s*/y,
    campo: 'solicitante',
    valida: (v) => limpiarPersona(v).length >= 4,
  },
  // ── Etiquetas de CORTE (valor descartado) ──
  { re: /MONEDA\b\s*([:\-])?\s*/y, campo: null, valida: () => true },
  { re: /ESTADO\b\s*([:\-])?\s*/y, campo: null, valida: () => true },
  { re: /OBSERVAC\w*\b\s*([:\-])?\s*/y, campo: null, valida: () => true },
  { re: /SUCURSAL\b\s*([:]?)\s*/y, campo: null, valida: () => true },
]

/** Prueba todas las etiquetas ancladas en `pos` (orden = prioridad). */
function etiquetaEn(
  linea: string,
  pos: number
): { etq: EtiquetaRal; start: number; end: number; sep: boolean } | null {
  for (const etq of ETIQUETAS) {
    etq.re.lastIndex = pos
    const m = etq.re.exec(linea)
    if (m && m.index === pos) {
      return { etq, start: m.index, end: m.index + m[0].length, sep: Boolean(m[1]) }
    }
  }
  return null
}

type CandidatoEtiqueta = {
  campo: CampoRal
  valor: string
  sep: boolean
  end: number
  valida: (valor: string, sep: boolean) => boolean
}

/**
 * Parte el renglón en etiquetas y reparte los tramos. Cada etiqueta toma
 * como valor el texto hasta la SIGUIENTE etiqueta; en CASCADA, si el tramo
 * no pasa el validador, la etiqueta se descarta y su tramo se suma al
 * candidato anterior (falso positivo dentro de un valor). Asigna cada
 * campo la PRIMERA vez que aparece. Devuelve ¿hay etiqueta de campo real?
 */
function tokenizarEncabezado(linea: string, res: DatosRal): boolean {
  const hits: { etq: EtiquetaRal; start: number; end: number; sep: boolean }[] = []
  let i = 0
  while (i < linea.length) {
    const hit = etiquetaEn(linea, i)
    if (hit) {
      hits.push(hit)
      i = hit.end
    } else {
      i++
    }
  }
  if (hits.length === 0) return false

  const out: CandidatoEtiqueta[] = []
  for (let j = 0; j < hits.length; j++) {
    // CASCADA: el tramo del previo corre hasta DONDE EMPIEZA esta etiqueta;
    // si su validador falla, el previo era falso positivo y se descarta.
    while (out.length > 0) {
      const prev = out[out.length - 1]
      const tramo = linea.slice(prev.end, hits[j].start)
      if (prev.valida(tramo, prev.sep)) {
        prev.valor = tramo
        break
      }
      out.pop()
    }
    const h = hits[j]
    out.push({ campo: h.etq.campo, valor: '', sep: h.sep, end: h.end, valida: h.etq.valida })
  }
  // Último candidato: su tramo corre hasta el fin del renglón (misma cascada).
  while (out.length > 0) {
    const prev = out[out.length - 1]
    const tramo = linea.slice(prev.end)
    if (prev.valida(tramo, prev.sep)) {
      prev.valor = tramo
      break
    }
    out.pop()
  }

  let conCampoReal = false
  for (const c of out) {
    if (!c.campo) continue
    conCampoReal = true
    const v = c.valor
    switch (c.campo) {
      case 'documento':
        if (!res.documento) res.documento = v.trim().match(/^\d{1,10}\b/)?.[0] ?? ''
        break
      case 'fecha':
        if (!res.fecha) res.fecha = fechaDeValor(v)
        break
      case 'transaccion':
        if (!res.transaccion) {
          const limpio = limpiarValor(v)
          if (limpio.length >= 2 && tienePalabraReal(limpio)) res.transaccion = limpio
        }
        break
      case 'areaSolicitante':
        if (!res.areaSolicitante) {
          const limpio = limpiarValor(v)
          if (limpio.length >= 2) res.areaSolicitante = limpio
        }
        break
      case 'solicitante':
        if (!res.solicitante) {
          const limpio = limpiarPersona(limpiarValor(v, 120))
          if (limpio.length >= 4) res.solicitante = limpio
        }
        break
      case 'aprobadoPor':
        if (!res.aprobadoPor) {
          const limpio = limpiarPersona(limpiarValor(v, 120))
          if (limpio.length >= 4) res.aprobadoPor = limpio
        }
        break
      case 'almacen':
        if (!res.almacen) {
          const limpio = limpiarValor(v)
          if (limpio.length >= 1) res.almacen = limpio
        }
        break
      case 'linea':
        if (!res.linea) {
          const limpio = limpiarValor(v)
          if (limpio.length >= 2) res.linea = limpio
        }
        break
    }
  }
  return conCampoReal
}

/** Unidades habituales del ERP (misma familia que rq-ocr). */
const UNIDADES = new Set([
  'KGM', 'KG', 'KGS', 'UND', 'UNIDAD', 'UNIDADES', 'UN', 'U',
  'CJA', 'CAJA', 'BOL', 'GL', 'GLL', 'LTR', 'LT', 'L', 'ML',
  'MTR', 'MT', 'PAR', 'JGO', 'SET', 'PQT', 'TON', 'GR', 'G',
])

/** Cantidad con separador decimal explícito ("2000.0000", "2,000.0000"). */
const RE_NUM_DEC = /^(?:\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{1,4}$/

/** Entero tipo cantidad ("2000", "2,000" — respaldo si el OCR pierde el punto). */
const RE_NUM_INT = /^(?:\d{1,3}(?:,\d{3})+|\d{1,6})$/

/** Centro de costos: puro dígitos sin separadores (14040101). */
const RE_CENTRO = /^\d{5,12}$/

/** Filas de material reconocidas como máximo por RAL. */
const MAX_ITEMS = 40

/** Tope de tokens acumulables en un FRAGMENTO de fila partida por el OCR. */
const LIM_TOKS_FRAGMENTO = 14

/** Longitud mínima de descripción aceptable. */
const DESC_MIN = 2

// ═══════════════════════════════════════════════════════════════════
// UTILIDADES DE TEXTO
// ═══════════════════════════════════════════════════════════════════

function limpiarLineas(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.replace(/[|_]+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((l) => l.length > 0)
}

/** ¿Hay al menos UNA palabra real (≥3 letras)? (espejo de rq-ocr) */
function tienePalabraReal(desc: string): boolean {
  return /[A-ZÁÉÍÓÚÑÜ]{3,}/.test(desc.toUpperCase())
}

/** FECHA disfrazada de descripción ("004 21/10/2026"). */
const RE_SOLO_DIGITOS_FECHA = /^[\d\s./\-]+$/
const RE_PAR_FECHA = /\d{1,2}[/.-]\d{1,2}/

function esFragmentoFecha(desc: string): boolean {
  const d = desc.trim()
  return d.length > 0 && RE_SOLO_DIGITOS_FECHA.test(d) && RE_PAR_FECHA.test(d)
}

/** Limpia el valor de una etiqueta: corta la etiqueta siguiente y colas. */
function limpiarValor(texto: string, max = 80): string {
  return texto
    .replace(RE_CORTE_VALOR, '')
    .replace(/[\s.:;—–\-]+$/, '')
    .trim()
    .slice(0, max)
    .trim()
}

/**
 * SOLICITANTE / APROBADO POR = nombres y apellidos (pedido del usuario en
 * la RQ: solo personas). Quita dígitos (DNI/códigos de empleado) y
 * símbolos, sin tocar partículas legítimas (DE, LA) ni la coma.
 */
function limpiarPersona(texto: string): string {
  const limpio = texto
    .replace(/\b\d{1,12}\b/g, ' ')
    .replace(/[^A-ZÁÉÍÓÚÑÜa-záéíóúñü ,'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const PARTICULAS = new Set(['DE', 'LA', 'EL', 'Y', 'LO', 'MA'])
  const toks = limpio.split(' ').filter(Boolean)
  while (toks.length > 1) {
    const t = toks[0].toUpperCase()
    if (PARTICULAS.has(t) || /^[A-ZÁÉÍÓÚÑÜ]{3,}$/.test(t)) break
    toks.shift()
  }
  return toks.join(' ').replace(/[\s.:\-–—]+$/, '').trim()
}

/** aaaa-mm-dd validado (ERP: "2026/10/27"); '' si es inválida. */
function normalizarFechaYMD(y: string, m: string, d: string): string {
  const anio = parseInt(y, 10)
  const mes = parseInt(m, 10)
  const dia = parseInt(d, 10)
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || anio < 2020 || anio > 2100) return ''
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

/** dd/mm/aaaa (o aa) → 'YYYY-MM-DD' validado; '' si es inválida. */
function normalizarFechaDMY(d: string, m: string, y: string): string {
  const anioRaw = parseInt(y, 10)
  const mes = parseInt(m, 10)
  const dia = parseInt(d, 10)
  const anio = anioRaw < 100 ? anioRaw + 2000 : anioRaw
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || anio < 2020 || anio > 2100) return ''
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

// ═══════════════════════════════════════════════════════════════════
// CATÁLOGO
// ═══════════════════════════════════════════════════════════════════

/** Match exacto por código (tolerante a ceros a la izquierda). */
function enCatalogoPorCodigo(codigo: string, catalogo: CatalogoItem[]): CatalogoItem | null {
  const c = codigo.trim()
  if (!c) return null
  const num = c.replace(/^0+/, '')
  return (
    catalogo.find(
      (k) => k.codigo === c || (num !== '' && k.codigo.replace(/^0+/, '') === num)
    ) ?? null
  )
}

/** Palabras significativas (≥4 chars) de una descripción, en mayúsculas. */
function palabrasDesc(desc: string): Set<string> {
  return new Set(
    (desc.toUpperCase().match(/[A-ZÁÉÍÓÚÑÜ]{4,}/g) ?? []).filter(
      (p) => !['PARA', 'CON', 'DESDE', 'TIPO'].includes(p)
    )
  )
}

/**
 * Match por DESCRIPCIÓN: el código salió ilegible, pero la descripción
 * leída comparte palabras con un artículo del catálogo. Conservador:
 * cualquier adopción queda marcada a revisión (matchPorDescripcion).
 */
function buscarPorDescripcion(
  desc: string,
  catalogo: CatalogoItem[]
): CatalogoItem | null {
  const leidas = palabrasDesc(desc)
  if (leidas.size === 0) return null
  let mejor: { item: CatalogoItem; score: number } | null = null
  for (const cat of catalogo) {
    const comunes = [...palabrasDesc(cat.descripcion)].filter((p) => leidas.has(p)).length
    if (comunes > 0 && (!mejor || comunes > mejor.score)) mejor = { item: cat, score: comunes }
  }
  return mejor?.item ?? null
}

// ═══════════════════════════════════════════════════════════════════
// EXTRACCIÓN PRINCIPAL
// ═══════════════════════════════════════════════════════════════════

/** Basura corta del lado derecho de la fila: enteros ≤3 dígitos (CEDIS,
 *  Parcial, Item, Lin. Man) o restos de 1-2 letras (la casilla ☑ de NOTA
 *  leída como "V"/"X"/"SI"). Las UNIDADES jamás son basura (KG, UN…). */
function esJunkCorto(tok: string): boolean {
  if (/^\d{1,3}$/.test(tok)) return true
  return /^[A-ZÁÉÍÓÚÑÜ]{1,2}$/.test(tok) && !UNIDADES.has(tok)
}

/** Renglones que SON cabecera de tabla / títulos, nunca materiales. */
function esCabeceraDeTabla(linea: string): boolean {
  return (
    /^(CODIGO|ARTICULO|DESCRIPCI|CENTRO|CANTIDAD|CANT\b|UM|UND|CEDIS|SALDO|PARCIAL|ITEM|NOTA|EQUIPO|LIN\b|LIN\.)\b/.test(
      linea
    ) ||
    (linea.includes('CODIGO') && linea.includes('ARTICULO')) ||
    linea.includes('CANTIDAD PEDIDA') ||
    linea.includes('CANT. PEDIDA') ||
    linea.includes('CANT. APROBADA') ||
    linea.includes('CENTRO COSTO') ||
    linea.includes('CONSULTA REQUERIMIENTO')
  )
}

/**
 * Extrae los datos del RAL desde UN texto OCR. `catalogo` puede venir
 * vacío (sin conexión): los códigos quedan marcados fuera de catálogo.
 */
export function extraerDatosRalDeTexto(texto: string, catalogo: CatalogoItem[]): DatosRal {
  const vacio: DatosRal = {
    documento: '',
    transaccion: '',
    fecha: '',
    areaSolicitante: '',
    solicitante: '',
    aprobadoPor: '',
    almacen: '',
    linea: '',
    items: [],
  }
  if (!texto.trim()) return vacio

  const lineas = limpiarLineas(texto.toUpperCase())
  const res: DatosRal = { ...vacio, items: [] }
  const codigosVistos = new Set<string>()

  /**
   * Fila PARTIDA por el OCR (código y/o descripción en renglones propios):
   * "126" / "SAL INDUSTRIAL KG" / "44040101 2000.0000 …". Se acumula el
   * fragmento y se FUSIONA cuando aparece el renglón con las cantidades.
   */
  let pendiente: { codigo: string; toks: string[] } | null = null

  for (const linea of lineas) {
    // Cabecera de tabla / títulos del ERP: JAMÁS encabezado ni material.
    // Va PRIMERO — «Consulta Requerimiento al Almacén 65 …» contiene la
    // palabra ALMACÉN y el título no debe alimentar ninguna etiqueta.
    if (esCabeceraDeTabla(linea)) continue

    // ── Encabezado: tokenizador de etiquetas (con o sin ":") ──
    // La pantalla ERP es un formulario de cajillas SIN dos puntos y el OCR
    // fusiona sus columnas: "AREA SOLICITANTE CADENA DE SUMINISTRO
    // SOLICITANTE 138712 ENRIQUEZ…". Cada etiqueta toma el tramo hasta la
    // siguiente etiqueta REAL — el solicitante ya NO se queda dentro del
    // área solicitante (reporte del usuario).
    const conEtiquetaReal = tokenizarEncabezado(linea, res)

    // ── Filas de la tabla de materiales ──
    // El guion separador de la tabla pegado al inicio de la fila se retira.
    // El resto puede venir VACÍO: "126" solo en su renglón es un fragmento.
    const mFila = linea.replace(/^[-—–_=|\s]+/, '').match(/^([A-Z0-9][A-Z0-9./-]{0,15})\s*(.*)$/)
    if (!mFila) continue
    const codigoBruto = mFila[1]
    // Un código de material SIEMPRE lleva al menos un dígito (12E, M25, 126).
    const conDigito = /\d/.test(codigoBruto)
    let codigo = codigoBruto
    let resto = mFila[2].trim()

    // COLUMNA DE SECUENCIA ("001 12E SAL …"): nº de fila con ceros o ≤2
    // dígitos puros → el código va después. Espejo de rq-ocr.
    if (conDigito && (/^0\d+$/.test(codigo) || /^\d{1,2}$/.test(codigo))) {
      const mSeq = resto.match(/^([A-Z0-9][A-Z0-9./-]{1,15})\s+(.+)$/)
      if (mSeq && /\d/.test(mSeq[1])) {
        codigo = mSeq[1]
        resto = mSeq[2]
      }
    }

    const toks = resto ? resto.split(/\s+/) : []

    // ── CANTIDAD PEDIDA: la cifra con DECIMALES manda ────────────────
    // El ERP imprime «… 44040101 2000.0000 2000.0000 0.0000 2000.0000 0 0»
    // (centro + pedida + aprobada + cancelada + saldo + parcial + item).
    // La PEDIDA es la PRIMERA cifra de la corrida (columna izquierda).
    // Las columnas Parcial/Item (enteros "0 0") van DESPUÉS del SALDO: si
    // hay una cifra DECIMAL más adentro, todo lo posterior es basura — sin
    // este corte la corrida decimal no arranca y la fila se pierde.
    let ultDecimal = -1
    for (let i = toks.length - 1; i >= 0 && toks.length - i <= 8; i--) {
      if (RE_NUM_DEC.test(toks[i])) {
        ultDecimal = i
        break
      }
    }
    if (ultDecimal >= 0 && ultDecimal < toks.length - 1) toks.splice(ultDecimal + 1)
    const cantidades: string[] = []
    while (toks.length > 0 && RE_NUM_DEC.test(toks[toks.length - 1])) {
      cantidades.unshift(toks.pop() as string)
    }
    // Respaldo SIN decimales (el OCR perdió el punto): enteros al final.
    if (cantidades.length === 0) {
      while (toks.length > 0 && RE_NUM_INT.test(toks[toks.length - 1])) {
        cantidades.unshift(toks.pop() as string)
      }
    }

    // ── SIN cifras → FRAGMENTO de una fila partida (o ruido) ──────────
    if (cantidades.length === 0) {
      if (conEtiquetaReal) continue // renglón de encabezado: nunca es material
      if (conDigito) {
        // código solo en su renglón ("126"): REINICIA el fragmento previo
        pendiente = { codigo, toks: toks.slice(0, LIM_TOKS_FRAGMENTO) }
      } else {
        const fragToks = [codigoBruto, ...toks]
        const textoFrag = fragToks.join(' ')
        if (!tienePalabraReal(textoFrag) || esFragmentoFecha(textoFrag)) continue
        pendiente = pendiente
          ? {
              codigo: pendiente.codigo,
              toks: [...pendiente.toks, ...fragToks].slice(0, LIM_TOKS_FRAGMENTO),
            }
          : { codigo: '', toks: fragToks.slice(0, LIM_TOKS_FRAGMENTO) }
      }
      continue
    }

    const cantidad = aNumero(cantidades[0])
    if (cantidad <= 0) continue

    // ── DERECHA ESTRUCTURAL de la fila ───────────────────────────────
    // Columnas REALES del ERP: Artículo | Und | Cedis | Lin.Man | Centro
    // Costo | Cant. Pedida | … — la UND ya NO está pegada a las cifras.
    // (a) Parcial / Item / enteros sueltos tras la corrida de cantidades.
    for (let n = 0; n < 5 && toks.length > 0 && esJunkCorto(toks[toks.length - 1]); n++) toks.pop()
    // (b) Centro de costos: puro dígitos (5-12) junto a las cantidades.
    let centroCostos = ''
    if (toks.length > 0 && RE_CENTRO.test(toks[toks.length - 1])) {
      centroCostos = toks.pop() as string
    }
    // (c) Cedis / Lin. Man (enteros cortos a la izquierda del centro).
    for (let n = 0; n < 3 && toks.length > 0 && esJunkCorto(toks[toks.length - 1]); n++) toks.pop()
    // (d) UNIDAD: buscada desde la DERECHA en todo el rabo (entre ella y
    //     la cifra ahora viven CEDIS y el CENTRO DE COSTOS).
    let unidad = ''
    for (let i = toks.length - 1; i >= Math.max(0, toks.length - 8); i--) {
      const t = toks[i].replace(/[^A-ZÁÉÍÓÚÑÜ]/g, '')
      if (t && UNIDADES.has(t)) {
        unidad = t
        toks.splice(i, 1)
        break
      }
    }

    // ── Descripción = lo que queda ───────────────────────────────────
    let descripcion = toks.join(' ').replace(/[\s.:;—–\-]+$/, '').trim()
    if (esFragmentoFecha(descripcion)) continue

    // ── FUSIÓN con el fragmento pendiente (fila partida por el OCR) ──
    // "44040101 2000.0000 …" tras "126" + "SAL INDUSTRIAL KG": el token
    // líder ERA el centro de costos y la descripción vive en el fragmento.
    const descTienePalabra = tienePalabraReal(descripcion)
    if (!descTienePalabra && pendiente) {
      if (!conDigito) {
        // el líder no era código: la descripción viene del fragmento
        codigo = pendiente.codigo
        if (!descripcion) descripcion = pendiente.toks.join(' ').trim()
        pendiente = null
      } else if (!centroCostos && (RE_CENTRO.test(codigo) || RE_NUM_DEC.test(codigo))) {
        // el líder era el CENTRO (o una cifra) de la fila partida
        if (RE_CENTRO.test(codigo)) centroCostos = codigo
        codigo = pendiente.codigo
        if (!descripcion) descripcion = pendiente.toks.join(' ').trim()
        pendiente = null
      }
    } else if (descTienePalabra && !conDigito && pendiente?.codigo) {
      // el código vino en su propio renglón ("126" + "SAL INDUSTRIAL …")
      codigo = pendiente.codigo
      pendiente = null
    } else if (descTienePalabra && conDigito) {
      pendiente = null // fila completa: el fragmento viejo caduca
    }

    // (d2) segunda pasada de UNIDAD tras la fusión del fragmento
    if (!unidad && descripcion) {
      const dtoks = descripcion.split(/\s+/)
      for (let i = dtoks.length - 1; i >= Math.max(0, dtoks.length - 4); i--) {
        const t = dtoks[i].replace(/[^A-ZÁÉÍÓÚÑÜ]/g, '')
        if (t && UNIDADES.has(t)) {
          unidad = t
          dtoks.splice(i, 1)
          break
        }
      }
      while (dtoks.length > 1 && /^\d{1,3}$/.test(dtoks[dtoks.length - 1])) dtoks.pop()
      descripcion = dtoks.join(' ').replace(/[\s.:;—–\-]+$/, '').trim()
    }

    // Catálogo: match exacto; si falla, la descripción puede adoptar.
    let cat = codigo ? enCatalogoPorCodigo(codigo, catalogo) : null
    let porDescripcion = false
    if (!cat && descripcion.length >= DESC_MIN && catalogo.length > 0) {
      const alt = buscarPorDescripcion(descripcion, catalogo)
      if (alt) {
        cat = alt
        porDescripcion = true
      }
    }
    if (cat) {
      if (descripcion.length < DESC_MIN) descripcion = cat.descripcion
    } else if (descripcion.length < DESC_MIN || !tienePalabraReal(descripcion) || !codigo) {
      continue // anti-ruido: solo cifras/símbolos, o sin código ni catálogo
    }

    const codigoFinal = cat ? cat.codigo : (codigo as string)
    if (codigosVistos.has(codigoFinal)) continue
    codigosVistos.add(codigoFinal)
    if (res.items.length >= MAX_ITEMS) break

    res.items.push({
      codigo: codigoFinal,
      // El catálogo es la fuente de verdad (como en la RQ): la descripción
      // oficial reemplaza a la leída; sin catálogo queda la lectura.
      descripcion: cat ? cat.descripcion : descripcion,
      cantidad,
      unidad: unidad || cat?.un || '',
      centroCostos,
      enCatalogo: Boolean(cat),
      revision: !cat || porDescripcion,
      matchPorDescripcion: porDescripcion,
    })
  }

  // Fecha de respaldo: la primera fecha válida de TODO el texto.
  if (!res.fecha) {
    for (const linea of lineas) {
      const mY = linea.match(RE_FECHA_YMD)
      if (mY) {
        const iso = normalizarFechaYMD(mY[1], mY[2], mY[3])
        if (iso) {
          res.fecha = iso
          break
        }
      }
      const mD = linea.match(RE_FECHA_DMY)
      if (mD) {
        const iso = normalizarFechaDMY(mD[1], mD[2], mD[3])
        if (iso) {
          res.fecha = iso
          break
        }
      }
    }
  }

  return res
}

// ═══════════════════════════════════════════════════════════════════
// FUSIÓN (2 pases OCR) Y PUNTUACIÓN
// ═══════════════════════════════════════════════════════════════════

/**
 * Une dos lecturas SIN duplicados (clave: código). Encabezado: primera
 * lectura no vacía. Mismo material con cifras distintas entre pases =
 * dígito dudoso: manda la lectura con catálogo (o la primera) y la fila
 * queda a revisión con aviso visible (rigor numérico, igual que la RQ).
 */
export function fusionarDatosRal(a: DatosRal, b: DatosRal): DatosRal {
  const items: ItemRal[] = []
  const avisos: string[] = [...(a.avisos ?? []), ...(b.avisos ?? [])]
  const vistas = new Set<string>()
  for (const it of [...a.items, ...b.items]) {
    const previo = items.find((x) => x.codigo === it.codigo)
    if (previo) {
      if (!previo.enCatalogo && it.enCatalogo) {
        previo.enCatalogo = true
        previo.revision = it.revision
        if (it.descripcion.length > previo.descripcion.length) previo.descripcion = it.descripcion
        if (!previo.unidad && it.unidad) previo.unidad = it.unidad
        if (!previo.centroCostos && it.centroCostos) previo.centroCostos = it.centroCostos
      } else if (!previo.centroCostos && it.centroCostos) {
        previo.centroCostos = it.centroCostos
      }
      if (
        Math.abs(previo.cantidad - it.cantidad) > 0.0005 &&
        it.cantidad > 0
      ) {
        if (!previo.enCatalogo && it.enCatalogo) previo.cantidad = it.cantidad
        previo.revision = true
        avisos.push(
          `Cantidad de ${previo.codigo} difiere entre lecturas (${previo.cantidad} / ${it.cantidad}) — revisa`
        )
      }
      continue
    }
    items.push({ ...it })
  }
  return {
    documento: a.documento || b.documento,
    transaccion: a.transaccion || b.transaccion,
    fecha: a.fecha || b.fecha,
    areaSolicitante: a.areaSolicitante || b.areaSolicitante,
    solicitante: a.solicitante || b.solicitante,
    aprobadoPor: a.aprobadoPor || b.aprobadoPor,
    almacen: a.almacen || b.almacen,
    linea: a.linea || b.linea,
    items,
    ...(avisos.length > 0 ? { avisos } : {}),
  }
}

/** Puntaje de calidad de la extracción (mayor = mejor lectura). */
export function puntuarExtraccionRal(d: DatosRal): number {
  let p = d.items.length * 2
  if (d.documento) p += 2
  if (d.fecha) p += 1
  if (d.areaSolicitante) p += 1
  if (d.solicitante) p += 1
  if (d.aprobadoPor) p += 1
  if (d.almacen) p += 1
  if (d.linea) p += 1
  if (d.transaccion) p += 1
  p += d.items.filter((i) => i.enCatalogo).length
  return p
}

/** ¿La lectura alcanza para no re-procesar? (pilares: items + documento + fecha) */
export function extraccionSuficienteRal(d: DatosRal): boolean {
  return d.items.length > 0 && Boolean(d.documento) && Boolean(d.fecha)
}

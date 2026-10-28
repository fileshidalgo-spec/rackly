/**
 * RACKLY — Atención a Línea · OCR del formato RAL (Requerimiento al Almacén).
 *
 * Parser HERMANO de rq-ocr.ts, calibrado al formato ERP «Consulta
 * Requerimiento al Almacén» (RAL). Mismas convenciones de rigor:
 *   · Texto en MAYÚSCULAS, línea por línea, anclas por ETIQUETA del
 *     encabezado (Documento / Fecha / Área Solicitante / Solicitante /
 *     Aprobado Por / Almacén / Transacción / Línea).
 *   · Filas de material: [código] [descripción] [UND] [centro de costos]
 *     [cantidad pedida] … (la cantidad con decimales manda; los números
 *     extra de las columnas «Aprobada»/«Saldo» se ignoran).
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
// ANCLAS DEL ENCABEZADO
// ═══════════════════════════════════════════════════════════════════

/** Documento: etiqueta + 1-10 dígitos ("Documento : 8378"). */
const RE_DOCUMENTO = /DOCUMENTO\s*[.:º°-]?\s*(\d{1,10})\b/

/** Fecha estilo ERP (2026/10/27) y estilo clásico (27/10/2026). */
const RE_FECHA_YMD = /\b(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\b/
const RE_FECHA_DMY = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/

/** Transacción ("RAL Requerimiento al Almacén") — tolera OCR sin acentos
 *  o con acentos en la I u en la O (TransacciÓN). */
const RE_TRANSACCION = /TRANSACC[IÍ1]?[OÓ]N\s*[:\-]?\s*(.*)$/

/** Área Solicitante ANTES de Solicitante: comparte la palabra SOLICITANTE. */
const RE_AREA = /[AÁ]REA\s+SOLICITANTE\s*[:\-]?\s*(.*)$/
const RE_SOLICITANTE = /SOLICITANTE\s*[:\-]?\s*(.*)$/

/** "Aprobado Por: …" / "Aprobada Por: …" (género OCR). */
const RE_APROBADO = /APROBAD[OA]S?\s*(?:POR\s*)?[:\-]?\s*(.*)$/

/**
 * Almacén con DOS PUNTOS obligatorio: el título del ERP («Consulta
 * Requerimiento al Almacén 65 …») contiene la palabra ALMACÉN sin ser
 * etiqueta — sin este requisito el título contaminaba el campo.
 */
const RE_ALMACEN = /ALMAC[EÉ]N\s*[:]\s*(.*)$/
const RE_LINEA = /\bL[IÍ]NEA\b\s*[:\-]?\s*(.*)$/

/**
 * Etiquetas que cortan el VALOR capturado cuando el OCR fusiona dos
 * renglones ("… CADENA DE SUMINISTRO SOLICITANTE : 7126 …"). EXIGE los dos
 * puntos: valores legítimos como «RAL Requerimiento al Almacén» o
 * «05 Almacén de Materia Prima» contienen palabras de etiqueta SIN serlo.
 * Tolerante a tildes del OCR en las propias etiquetas.
 */
const RE_CORTE_VALOR =
  /\s+(?:DOCUMENTO|FECHA|TRANSACC[IÍ1]?[OÓ]N|[AÁ]REA|SOLICITANTE|APROBAD\w*|ALMAC[EÉ]N|L[IÍ]NEA|MONEDA|OBSERVACI\w*|CONSULTA|CENTRO|CODIGO|ARTICULO|CANTIDAD|PEDIDA|APROBADA|SALDO)\s*[:：].*$/

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

/** Renglones que SON cabecera de tabla / títulos, nunca materiales. */
function esCabeceraDeTabla(linea: string): boolean {
  return (
    /^(CODIGO|ARTICULO|DESCRIPCI|CENTRO|CANTIDAD|UM|UND)\b/.test(linea) ||
    (linea.includes('CODIGO') && linea.includes('ARTICULO')) ||
    linea.includes('CANTIDAD PEDIDA') ||
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

  for (const linea of lineas) {
    // Cabecera de tabla / títulos del ERP: JAMÁS encabezado ni material.
    // Va PRIMERO — «Consulta Requerimiento al Almacén 65 …» contiene la
    // palabra ALMACÉN y el título no debe alimentar ninguna etiqueta.
    if (esCabeceraDeTabla(linea)) continue

    // ── Encabezado ──
    if (!res.documento) {
      const mDoc = linea.match(RE_DOCUMENTO)
      if (mDoc) res.documento = mDoc[1]
    }
    if (!res.fecha && /FECHA/.test(linea)) {
      // ERP moderno primero (2026/10/27); clásico después (27/10/2026).
      const mY = linea.match(RE_FECHA_YMD)
      if (mY) res.fecha = normalizarFechaYMD(mY[1], mY[2], mY[3])
      if (!res.fecha) {
        const mD = linea.match(RE_FECHA_DMY)
        if (mD) res.fecha = normalizarFechaDMY(mD[1], mD[2], mD[3])
      }
    }
    if (!res.transaccion) {
      const mTr = linea.match(RE_TRANSACCION)
      if (mTr) {
        const limpio = limpiarValor(mTr[1])
        if (limpio.length >= 2) res.transaccion = limpio
      }
    }
    // Área Solicitante ANTES que Solicitante (comparten la palabra).
    const mArea = linea.match(RE_AREA)
    if (mArea) {
      const limpio = limpiarValor(mArea[1])
      if (limpio.length >= 2 && !res.areaSolicitante) res.areaSolicitante = limpio
    } else if (!res.solicitante) {
      const mSol = linea.match(RE_SOLICITANTE)
      if (mSol) {
        const limpio = limpiarPersona(limpiarValor(mSol[1], 120))
        if (limpio.length >= 4) res.solicitante = limpio
      }
    }
    if (!res.aprobadoPor) {
      const mAp = linea.match(RE_APROBADO)
      if (mAp) {
        const limpio = limpiarPersona(limpiarValor(mAp[1], 120))
        if (limpio.length >= 4) res.aprobadoPor = limpio
      }
    }
    if (!res.almacen) {
      const mAl = linea.match(RE_ALMACEN)
      if (mAl) {
        const limpio = limpiarValor(mAl[1])
        if (limpio.length >= 1) res.almacen = limpio
      }
    }
    if (!res.linea) {
      const mLi = linea.match(RE_LINEA)
      if (mLi) {
        const limpio = limpiarValor(mLi[1])
        if (limpio.length >= 2) res.linea = limpio
      }
    }

    // ── Filas de la tabla de materiales ──
    // El guion separador de la tabla pegado al inicio de la fila se retira.
    const mFila = linea.replace(/^[-—–_=|\s]+/, '').match(/^([A-Z0-9][A-Z0-9./-]{0,15})\s+(.{2,})$/)
    if (!mFila) continue
    const codigoBruto = mFila[1]
    // Un código de material SIEMPRE lleva al menos un dígito (12E, M25, 118).
    // Sin dígito es una palabra suelta del encabezado ("RAL", "CONSULTA").
    if (!/\d/.test(codigoBruto)) continue
    let codigo = codigoBruto
    let resto = mFila[2]

    // COLUMNA DE SECUENCIA ("001 12E SAL …"): nº de fila con ceros o ≤2
    // dígitos puros → el código va después. Espejo de rq-ocr.
    if (/^0\d+$/.test(codigo) || /^\d{1,2}$/.test(codigo)) {
      const mSeq = resto.match(/^([A-Z0-9][A-Z0-9./-]{1,15})\s+(.+)$/)
      if (mSeq && /\d/.test(mSeq[1])) {
        codigo = mSeq[1]
        resto = mSeq[2]
      }
    }

    // ── CANTIDAD PEDIDA: la cifra con DECIMALES manda ────────────────
    // El ERP imprime «… 14040101 2000.0000 2000.0000 2000.0000»
    // (centro de costos + pedida + aprobada + saldo). Se toman desde el
    // final los tokens numéricos con decimal (la corrida de cantidades)
    // y la PEDIDA es la PRIMERA de esa corrida (columna izquierda).
    const toks = resto.split(/\s+/)
    const cantidades: string[] = []
    while (toks.length > 0 && RE_NUM_DEC.test(toks[toks.length - 1])) {
      cantidades.unshift(toks.pop() as string)
    }
    // Centro de costos: puro dígitos pegado a la corrida de cantidades.
    let centroCostos = ''
    if (cantidades.length > 0 && toks.length > 0 && RE_CENTRO.test(toks[toks.length - 1])) {
      centroCostos = toks.pop() as string
    }
    // Respaldo SIN decimales (el OCR perdió el punto): enteros al final.
    if (cantidades.length === 0) {
      while (toks.length > 0 && RE_NUM_INT.test(toks[toks.length - 1])) {
        cantidades.unshift(toks.pop() as string)
      }
      if (cantidades.length > 0 && !centroCostos && toks.length > 0 && RE_CENTRO.test(toks[toks.length - 1])) {
        centroCostos = toks.pop() as string
      }
    }
    if (cantidades.length === 0) continue // sin cifra NO hay material
    const cantidad = aNumero(cantidades[0])
    if (cantidad <= 0) continue

    // ── UNIDAD: junto a las cantidades (últimos 3 tokens) ────────────
    let unidad = ''
    for (let i = toks.length - 1; i >= Math.max(0, toks.length - 3); i--) {
      const t = toks[i].replace(/[^A-ZÁÉÍÓÚÑÜ]/g, '')
      if (t && UNIDADES.has(t)) {
        unidad = t
        toks.splice(i, 1)
        break
      }
    }
    // Centro de costos alternativo: si sigue vacío, en los últimos tokens.
    if (!centroCostos) {
      for (let i = toks.length - 1; i >= Math.max(0, toks.length - 3); i--) {
        if (RE_CENTRO.test(toks[i])) {
          centroCostos = toks[i]
          toks.splice(i, 1)
          break
        }
      }
    }

    // ── Descripción = lo que queda ───────────────────────────────────
    let descripcion = toks.join(' ').replace(/[\s.:;—–\-]+$/, '').trim()
    if (esFragmentoFecha(descripcion)) continue

    // Catálogo: match exacto; si falla, la descripción puede adoptar.
    let cat = enCatalogoPorCodigo(codigo, catalogo)
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
    } else if (descripcion.length < DESC_MIN || !tienePalabraReal(descripcion)) {
      continue // anti-ruido: solo cifras/símbolos no es un material
    }

    const codigoFinal = cat ? cat.codigo : codigo
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

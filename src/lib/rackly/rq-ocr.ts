'use client'

/**
 * RACKLY — Extracción de datos desde una foto de RQ
 * (Requisición de Despacho de Materiales — Atención a Línea).
 *
 * Calibrado con la RQ real AJEPER Nº 0000191373: impresión monoespaciada,
 * encabezado con etiquetas (Nº, Orden de Producción, Producto, Fecha,
 * Solicitante, Almacén, Lote de Sistema, Cantidad…) y una tabla de
 * materiales «CÓDIGO · DESCRIPCIÓN · U/M · CANTIDAD».
 *
 * Reglas del negocio (pedido del usuario 2026-10-22):
 *   · Del ENCABEZADO se ignoran "Lote de Sistema" y "Cantidad" — no se extraen.
 *   · El TURNO del sistema NO se lee de la RQ: la app lo calcula sola con la
 *     regla T1/T2 existente (turno.ts — 07:20→19:20:59 = T1) y queda editable.
 *
 * El OCR lo corre el componente (tesseract.js, spa, igual que la guía);
 * este módulo entrega SOLO utilidades puras y testables:
 *   extraerDatosRqDeTexto · fusionarDatosRq · puntuarExtraccionRq.
 *
 * Aislamiento: NO toca guia-ocr.ts (otro formato de documento) ni catálogo
 * (solo LO LEE para validar códigos y completar descripción/unidad).
 */

import type { CatalogoItem } from '@/lib/rackly/catalogo'

// ═══════════════════════════════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════════════════════════════

export type ItemRq = {
  codigo: string
  descripcion: string
  cantidad: number
  unidad: string
  /** El código existe en el catálogo. */
  enCatalogo: boolean
  /** Requiere revisión humana (fuera de catálogo o sin cantidad legible). */
  revision: boolean
}

export type DatosRq = {
  numeroRq: string
  ordenProduccion: string
  productoCodigo: string
  productoDescripcion: string
  /** 'YYYY-MM-DD' o '' si no se leyó. */
  fecha: string
  solicitante: string
  items: ItemRq[]
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════

/** Nº de RQ: etiqueta "Nº/Nro/NUMERO/№" + 6-12 dígitos (tolera ":" y "."). */
const RE_NUM_RQ = /(?:N[º°⁰O]|NRO|NUMERO|NUM)\s*[.:]?\s*(\d{6,12})\b/

/** Respaldo: cualquier 7-10 dígitos en una línea que mencione "REQUISIC". */
const RE_NUM_RQ_SUELTO = /\b(\d{7,10})\b/

/**
 * Orden de Producción: "ORDEN DE PRODUCCIÓN: 2026008121" y variantes OCR del
 * documento real: "ORDEN/PRODUCCION +: 2026008121" (barra, "+:" pegado, sin
 * tildes). [A-ZÁÉÍÓÚÑ] y NO \w*: \w no abarca Ó.
 */
const RE_ORDEN =
  /ORDEN\s*[/\\\-]?\s*PRODUCC[A-ZÁÉÍÓÚÑ]*\s*[+.:=]*\s*(\d{6,12})\b/

/** Fecha dd/mm/aaaa (tolera - y . y año de 2 dígitos → 20xx). */
const RE_FECHA = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/

/**
 * Solicitante: texto tras la etiqueta (corta en la siguiente etiqueta).
 * El documento real trae artefactos: "Solicitante —: 7126 CHINCHAY…" — el
 * 7126… es el DNI del empleado y se limpia del nombre.
 */
const RE_SOLICITANTE =
  /(?:SOLICITANTE|SOLICITADO\s*POR|SOLICITA)\s*[-—–+:.\s]*([A-ZÁÉÍÓÚÑ0-9 .,'\-()]{4,90})/

/** Producto terminado: "PRODUCTO: 3000047 SYRUP …" y variantes OCR del
 *  documento real: "articulo + 3000047 — JARABE TERMINADO …". */
const RE_PRODUCTO =
  /(?:PRODUCTO(?:\s*TERMINADO)?|I[TÍ]EM|ART[IÍ]CULO)\s*[+.:=]*\s*(\d{2,8})\b\s*([A-ZÁÉÍÓÚÑ0-9 .,%()\-\—\/]{0,90})/

/** Cantidad con separador de miles y/o decimales: 24 · 322 · 50,400.0000 · 1,065.5 */
const RE_CANTIDAD = /\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,4})?\b|\b\d+(?:[.,]\d{1,4})?\b/

/** Unidades habituales (misma familia que la guía + lecturas OCR). */
const UNIDADES = new Set([
  'KGM', 'KG', 'KGS', 'UND', 'UNIDAD', 'UNIDADES', 'UN', 'U',
  'CJA', 'CAJA', 'BOL', 'GL', 'GLL', 'LTR', 'LT', 'L', 'ML',
  'MTR', 'MT', 'PAR', 'JGO', 'SET', 'PQT', 'TON', 'GR', 'G',
])

/**
 * Líneas que JAMÁS son filas de materiales: etiquetas del encabezado,
 * pies, firmas y encabezados de columna de la tabla.
 */
const RE_SKIP_LINEA =
  /(REQUISICI|ALMAC[EÉ]N|ORDEN|FECHA|TURNO|SOLICIT|PRODUCTO|LOTE|MONEDA|OBSERVACI|SUPERVIS|APROB|RECIBI|V[º°]?B|VO\.?BO|NOTA|P[ÁA]GINA|PAG|HORA|IMPRIMI|DESCRIPCI|CANTIDAD|UNIDAD\s+DE\s+MEDIDA|U\/M|^\s*I[TÍ]EM\s*$|C[ÓO]DIGO|SUB\s?TOTAL|TOTAL|FIRMA|NOMBRE|AREA|GU[IÍ]A|SALIDA\s+DE|DESPACHO\s+DE)/i

/** Filas de material reconocidas como máximo por RQ. */
const MAX_ITEMS = 40

/** Longitud mínima de descripción aceptable de un material. */
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

/**
 * Convierte una cantidad leída a número. Formato AJEPER: coma = miles,
 * punto = decimales ("50,400.0000" → 50400; "322" → 322; "1,065.5" → 1065.5).
 * Tolerante a OCR: si solo hay comas en grupos de 3 actúan de miles.
 */
export function aNumero(lectura: string): number {
  let s = lectura.trim().replace(/[^\d.,]/g, '')
  if (!s) return 0
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/,/g, '') // coma = miles
  } else if (s.includes(',')) {
    // Solo comas: miles si todos los grupos tras la coma tienen 3 dígitos
    const partes = s.split(',')
    const todasDe3 = partes.slice(1).every((p) => p.length === 3)
    s = todasDe3 ? partes.join('') : s.replace(',', '.')
  }
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

/** dd/mm/aaaa (o aa) → 'YYYY-MM-DD' validado; '' si es inválida. */
function normalizarFecha(d: string, m: string, y: string): string {
  let dia = parseInt(d, 10)
  let mes = parseInt(m, 10)
  let anio = parseInt(y, 10)
  if (anio < 100) anio += 2000
  if (anio < 2020 || anio > 2100 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return ''
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

/** Busca índice de catálogo por código exacto (comparación numérica-tolerante). */
function enCatalogoPorCodigo(codigo: string, catalogo: CatalogoItem[]): CatalogoItem | null {
  const c = codigo.replace(/\D/g, '')
  if (!c) return null
  return catalogo.find((it) => it.codigo.replace(/\D/g, '') === c) ?? null
}

/** Palabras significativas (≥4 chars) de una descripción, en mayúsculas. */
function palabrasDesc(desc: string): Set<string> {
  return new Set(
    (desc.toUpperCase().match(/[A-ZÁÉÍÓÚÑÑÜ0-9]{4,}/g) ?? []).filter(
      (p) => !/^\d+$/.test(p)
    )
  )
}

/**
 * ¿La descripción leída es coherente con la del catálogo? (≥1 palabra
 * significativa compartida — igual criterio de familias que la guía).
 */
function descripcionCoherente(leida: string, catalogada: string): boolean {
  const a = palabrasDesc(leida)
  const b = palabrasDesc(catalogada)
  for (const p of a) if (b.has(p)) return true
  return false
}

/**
 * VECINO A 1 DÍGITO (calibrado con la RQ real: "115" era "118"): el OCR
 * confunde un dígito del código. Genera las variantes a distancia 1 y
 * valida contra el catálogo SOLO si la descripción leída es coherente con
 * la del vecino — así no se "corrige" hacia un material distinto.
 */
function vecinoUnDigito(
  codigo: string,
  descripcionLeida: string,
  catalogo: CatalogoItem[]
): CatalogoItem | null {
  const c = codigo.replace(/\D/g, '')
  if (!c || c.length < 2 || c.length > 8) return null
  for (let pos = 0; pos < c.length; pos++) {
    for (let d = 0; d <= 9; d++) {
      if (d === parseInt(c[pos], 10)) continue
      const variante = c.slice(0, pos) + d + c.slice(pos + 1)
      const cat = enCatalogoPorCodigo(variante, catalogo)
      if (cat && descripcionCoherente(descripcionLeida, cat.descripcion)) return cat
    }
  }
  return null
}

/** Quita colas que el OCR pega al solicitante + el DNI de empleado delante. */
function limpiarSolicitante(texto: string): string {
  return texto
    .replace(/^[\s\d]{2,12}/, (m) => (m.trim() ? '' : m)) // "7126 CHINCHAY" → "CHINCHAY"
    .replace(
      /\s+(ALMAC[EÉ]N|ORDEN|FECHA|TURNO|PRODUCTO|LOTE|MONEDA|OBSERVACI|SUPERVIS|I[TÍ]EM|CANTIDAD|DESCRIPCI).*/i,
      ''
    )
    .replace(/[\s.:]+$/, '')
    .trim()
}

// ═══════════════════════════════════════════════════════════════════
// EXTRACCIÓN PRINCIPAL
// ═══════════════════════════════════════════════════════════════════

/**
 * Extrae los datos de la RQ desde UN texto OCR. `catalogo` puede venir
 * vacío (sin conexión): los códigos quedan marcados fuera de catálogo.
 */
export function extraerDatosRqDeTexto(texto: string, catalogo: CatalogoItem[]): DatosRq {
  const vacio: DatosRq = {
    numeroRq: '',
    ordenProduccion: '',
    productoCodigo: '',
    productoDescripcion: '',
    fecha: '',
    solicitante: '',
    items: [],
  }
  if (!texto.trim()) return vacio

  const lineas = limpiarLineas(texto.toUpperCase())
  const res: DatosRq = { ...vacio, items: [] }
  const codigosVistos = new Set<string>() // códigos ya capturados (dedupe)

  for (const linea of lineas) {
    // ── Encabezado ──
    if (!res.numeroRq) {
      const mRq = linea.match(RE_NUM_RQ)
      if (mRq) {
        res.numeroRq = mRq[1]
      } else if (/REQUISICI/.test(linea)) {
        const mSuelto = linea.match(RE_NUM_RQ_SUELTO)
        if (mSuelto) res.numeroRq = mSuelto[1]
      }
    }
    if (!res.ordenProduccion) {
      const mOrden = linea.match(RE_ORDEN)
      if (mOrden) res.ordenProduccion = mOrden[1]
    }
    if (!res.fecha) {
      if (/FECHA/.test(linea)) {
        const mF = linea.match(RE_FECHA)
        if (mF) {
          const iso = normalizarFecha(mF[1], mF[2], mF[3])
          if (iso) res.fecha = iso
        }
      }
    }
    if (!res.solicitante) {
      const mSol = linea.match(RE_SOLICITANTE)
      if (mSol) {
        const limpio = limpiarSolicitante(mSol[1])
        if (limpio.length >= 4) res.solicitante = limpio
      }
    }
    if (!res.productoCodigo) {
      const mProd = linea.match(RE_PRODUCTO)
      if (mProd) {
        res.productoCodigo = mProd[1]
        res.productoDescripcion = (mProd[2] ?? '').trim()
      }
    }

    // ── Filas de la tabla de materiales ──
    // PRIMERO se intenta leer la fila (código + cantidad final): un material
    // cuya descripción menciona "CANTIDAD"/"FECHA" no debe perderse por el
    // filtro de etiquetas. El filtro SOLO descarta lo que NO es fila válida.
    const mFila = linea.match(/^(\d{1,8})\s+(.{3,})$/)
    if (!mFila) {
      if (RE_SKIP_LINEA.test(linea)) continue
      continue
    }
    const codigoBruto = mFila[1]
    // La línea del PRODUCTO TERMINADO del encabezado no es un material
    if (codigoBruto === res.productoCodigo) continue
    let resto = mFila[2]

    // COLUMNA DE SECUENCIA (documento real: "001  55487 BASE …"): el primer
    // token es el nº de fila (con ceros a la izquierda o ≤2 dígitos) y el
    // CÓDIGO del material va después. Se descarta la secuencia.
    let codigo = codigoBruto
    if (/^0\d+$/.test(codigo) || codigo.length <= 2) {
      const mSeq = resto.match(/^(\d{2,8})\s+(.+)$/)
      if (mSeq) {
        codigo = mSeq[1]
        resto = mSeq[2]
      }
    }

    // Cantidad + unidad al FINAL de la línea (ancla fuerte: sin cantidad
    // final la línea NO es un material — evita capturar datos sueltos)
    const mCant = resto.match(new RegExp('(' + RE_CANTIDAD.source + ')\\s*(' + [...UNIDADES].join('|') + ')?\\s*$'))
    if (!mCant) {
      if (RE_SKIP_LINEA.test(linea)) continue
      continue
    }
    const cantidad = aNumero(mCant[1])
    if (cantidad <= 0) continue
    let descripcion = resto.slice(0, mCant.index).replace(/[\s.\-–—:]+$/, '').trim()
    const unidad = (mCant[2] ?? '').trim()

    // Descripción demasiado corta → tratar de completarla con el catálogo
    let cat = enCatalogoPorCodigo(codigo, catalogo)
    if (cat) {
      if (descripcion.length < DESC_MIN) descripcion = cat.descripcion
    } else if (descripcion.length >= DESC_MIN) {
      // VECINO A 1 DÍGITO validado por descripción ("115"→"118" en la RQ real)
      const vecino = vecinoUnDigito(codigo, descripcion, catalogo)
      if (vecino) cat = vecino
    }
    if (descripcion.length < DESC_MIN) continue

    // El vecino validado REEMPLAZA al código leído (115 → 118)
    const codigoFinal = cat && cat.codigo.replace(/\D/g, '') !== codigo ? cat.codigo : codigo

    // Dedupe por CÓDIGO (una requisición no repite un material; el OCR sí
    // repite filas al releer la misma tabla en 2 pases con cantidad distinta)
    if (codigosVistos.has(codigoFinal)) continue
    codigosVistos.add(codigoFinal)

    if (res.items.length >= MAX_ITEMS) break
    res.items.push({
      codigo: codigoFinal,
      descripcion,
      cantidad,
      unidad: unidad || cat?.un || '',
      enCatalogo: Boolean(cat),
      revision: !cat || cantidad <= 0,
    })
  }

  // Fecha de respaldo: la primera fecha válida de TODO el texto
  if (!res.fecha) {
    for (const linea of lineas) {
      const mF = linea.match(RE_FECHA)
      if (mF) {
        const iso = normalizarFecha(mF[1], mF[2], mF[3])
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
 * Une dos lecturas SIN duplicados (clave: código del material — una RQ no
 * repite materiales; los 2 pases OCR sí repiten filas). Los campos del
 * encabezado se rellenan con la primera lectura no vacía; los items ganan
 * la lectura con catálogo sobre la que no.
 */
export function fusionarDatosRq(a: DatosRq, b: DatosRq): DatosRq {
  const items: ItemRq[] = []
  const vistas = new Set<string>()
  for (const it of [...a.items, ...b.items]) {
    if (vistas.has(it.codigo)) {
      const previo = items.find((x) => x.codigo === it.codigo)
      if (previo && !previo.enCatalogo && it.enCatalogo) {
        previo.enCatalogo = true
        previo.revision = false
        if (it.descripcion.length > previo.descripcion.length) previo.descripcion = it.descripcion
        if (!previo.unidad && it.unidad) previo.unidad = it.unidad
      }
      continue
    }
    vistas.add(it.codigo)
    items.push({ ...it })
  }
  return {
    numeroRq: a.numeroRq || b.numeroRq,
    ordenProduccion: a.ordenProduccion || b.ordenProduccion,
    productoCodigo: a.productoCodigo || b.productoCodigo,
    productoDescripcion: a.productoDescripcion || b.productoDescripcion,
    fecha: a.fecha || b.fecha,
    solicitante: a.solicitante || b.solicitante,
    items,
  }
}

/** Puntaje de calidad de la extracción (mayor = mejor lectura). */
export function puntuarExtraccionRq(d: DatosRq): number {
  let p = d.items.length * 2
  if (d.numeroRq) p += 2
  if (d.ordenProduccion) p += 1
  if (d.fecha) p += 1
  if (d.solicitante) p += 1
  if (d.productoCodigo) p += 1
  p += d.items.filter((i) => i.enCatalogo).length
  return p
}

/** ¿La lectura alcanza para no re-procesar? (3 pilares: items + RQ + fecha) */
export function extraccionSuficienteRq(d: DatosRq): boolean {
  return d.items.length > 0 && Boolean(d.numeroRq) && Boolean(d.fecha)
}

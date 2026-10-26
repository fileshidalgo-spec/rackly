'use client'

/**
 * RACKLY — Extracción de datos desde una foto de RQ
 * (Requisición de Despacho de Materiales — Atención a Línea).
 *
 * Calibrado con la RQ real AJEPER Nº 0000191373: impresión monoespaciada,
 * encabezado con etiquetas (Nº, Orden de Producción, Producto, Fecha,
 * Solicitante, Almacén, Lote de Sistema, Cantidad, Línea…) y una tabla de
 * materiales «CÓDIGO · DESCRIPCIÓN · U/M · CANTIDAD».
 *
 * Reglas del negocio (pedido del usuario 2026-10-22):
 *   · Del ENCABEZADO se ignoran "Lote de Sistema" y "Cantidad" — no se extraen.
 *   · El TURNO del sistema NO se lee de la RQ: la app lo calcula sola con la
 *     regla T1/T2 existente (turno.ts — 07:20→19:20:59 = T1) y queda editable.
 *   · La LÍNEA de producción SÍ se lee del campo «Línea:» del documento
 *     (pedido del usuario 2026-10-23): valores tipo L1, L2, L3, JARABES… y
 *     queda editable en el formulario.
 *
 * El OCR lo corre el componente (tesseract.js, spa, igual que la guía);
 * este módulo entrega SOLO utilidades puras y testables:
 *   extraerDatosRqDeTexto · fusionarDatosRq · puntuarExtraccionRq.
 *
 * Aislamiento: NO toca guia-ocr.ts (otro formato de documento) ni catálogo
 * (solo LO LEE para validar códigos y completar descripción/unidad).
 * Reutiliza 2 utilidades PURAS de guia-ocr (buscarPorDescripcion + umbrales)
 * para que una RQ y una guía juzguen la similitud EXACTAMENTE igual.
 */

import type { CatalogoItem } from '@/lib/rackly/catalogo'
import {
  bonusConfusion,
  buscarPorDescripcion,
  COHERENCIA_CODIGO,
  similitudDescripcion,
  UMBRAL_AUTO,
  UMBRAL_MIN,
  type PalabraOCR,
} from '@/lib/rackly/guia-ocr'

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
  /** El código se adoptó por similitud de descripción — el usuario lo confirma. */
  matchPorDescripcion?: boolean
}

export type DatosRq = {
  numeroRq: string
  ordenProduccion: string
  productoCodigo: string
  productoDescripcion: string
  /** 'YYYY-MM-DD' o '' si no se leyó. */
  fecha: string
  /** Campo «Línea:» del documento (L1, L2, JARABES…) o '' si no se leyó. */
  linea: string
  solicitante: string
  items: ItemRq[]
  /**
   * Rigor numérico (Task 23): discrepancias detectadas entre lecturas/pases
   * que el usuario DEBE verificar antes de registrar (Nº RQ, producto,
   * cantidades). Vacío = lectura sin señales de error.
   */
  avisos?: string[]
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
 * Línea de producción: campo «Línea : 0 TANQUES DE JARABE GASEOSA» del
 * documento real. EXIGE separador ([+.:=] o raya) tras la etiqueta: así un
 * material cuya descripción menciona "LINEA 3" (sin dos puntos) nunca se
 * confunde con el encabezado. Si el OCR pierde el «:», el campo queda
 * vacío y se completa a mano (editable en el formulario).
 */
const RE_LINEA = /(?:^|\s)L[IÍ]NEA\s*[-—–+.:=]\s*(\S.*)$/

/** Etiquetas que cortan el valor de Línea si el OCR fusiona dos renglones. */
const RE_CORTE_LINEA =
  /\s+(SOLICITANT?E|TURNO|FECHA|ORDEN|ALMAC[EÉ]N|PRODUCTO|ART[IÍ]CULO|LOTE|MONEDA|CANTIDAD|OBSERVACI|I[TÍ]EM)\b.*/i

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
 * FECHA disfrazada de material: si el OCR parte el renglón "TURNO Y FECH :
 * 004  21/10/2026" en dos líneas, "004  21/10/2026" cumple el patrón de fila
 * (código + cantidad al final: cantidad=2026) y nacía un material fantasma.
 * Descripción hecha SOLO de dígitos/fecha → JAMÁS es un material.
 */
const RE_SOLO_DIGITOS_FECHA = /^[\d\s./\-]+$/
const RE_PAR_FECHA = /\d{1,2}[/.-]\d{1,2}/

/** ¿La descripción capturada es en realidad un fragmento de fecha? */
function esFragmentoFecha(desc: string): boolean {
  const d = desc.trim()
  return d.length > 0 && RE_SOLO_DIGITOS_FECHA.test(d) && RE_PAR_FECHA.test(d)
}

/** Filas de material reconocidas como máximo por RQ. */
const MAX_ITEMS = 40

/** Longitud mínima de descripción aceptable de un material. */
const DESC_MIN = 2

/**
 * ¿Hay al menos UNA palabra REAL (≥3 letras) en la descripción? Todo
 * material tiene nombre; una "descripción" hecha solo de cifras/símbolos
 * es ruido numérico del OCR (secuencias, saldos, DNI) — otra variante del
 * fantasma de fecha. Con catálogo no aplica: la descripción oficial ya
 * reemplazó a la leída.
 */
function tienePalabraReal(desc: string): boolean {
  return /[A-ZÁÉÍÓÚÑÜ]{3,}/.test(desc.toUpperCase())
}

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
 * confunde un dígito del código. Genera TODAS las variantes a distancia 1,
 * valida contra el catálogo SOLO si la descripción leída es coherente con
 * la del vecino, y de entre los coherentes devuelve el que MEJOR explica la
 * descripción (antes ganaba el PRIMERO probado — con familias de nombres
 * parecidos podía adoptar el vecino equivocado: falso positivo).
 */
function vecinoUnDigito(
  codigo: string,
  descripcionLeida: string,
  catalogo: CatalogoItem[]
): CatalogoItem | null {
  const c = codigo.replace(/\D/g, '')
  if (!c || c.length < 2 || c.length > 8) return null
  let mejor: { item: CatalogoItem; score: number } | null = null
  for (let pos = 0; pos < c.length; pos++) {
    for (let d = 0; d <= 9; d++) {
      if (d === parseInt(c[pos], 10)) continue
      const variante = c.slice(0, pos) + d + c.slice(pos + 1)
      const cat = enCatalogoPorCodigo(variante, catalogo)
      if (!cat || !descripcionCoherente(descripcionLeida, cat.descripcion)) continue
      const score =
        similitudDescripcion(descripcionLeida, cat.descripcion) + bonusConfusion(c, variante)
      if (!mejor || score > mejor.score) mejor = { item: cat, score }
    }
  }
  return mejor?.item ?? null
}

/**
 * MEJOR VECINO A 1 DÍGITO por similitud de descripción (Task 23 — rigor
 * numérico). A diferencia de `vecinoUnDigito` (criterio débil de familia,
 * usado cuando el código NO está en catálogo), esta versión devuelve la
 * variante que MEJOR explica la descripción leída con umbral estricto
 * (UMBRAL_MIN) — la usa la compuerta de coherencia del match directo.
 */
function mejorVecinoUnDigito(
  codigo: string,
  descripcionLeida: string,
  catalogo: CatalogoItem[]
): { item: CatalogoItem; score: number } | null {
  const c = codigo.replace(/\D/g, '')
  if (!c || c.length < 2 || c.length > 8) return null
  let mejor: { item: CatalogoItem; score: number } | null = null
  for (let pos = 0; pos < c.length; pos++) {
    for (let d = 0; d <= 9; d++) {
      if (d === parseInt(c[pos], 10)) continue
      const variante = c.slice(0, pos) + d + c.slice(pos + 1)
      const cat = enCatalogoPorCodigo(variante, catalogo)
      if (!cat) continue
      const score =
        similitudDescripcion(descripcionLeida, cat.descripcion) + bonusConfusion(c, variante)
      if (score >= UMBRAL_MIN && (!mejor || score > mejor.score)) mejor = { item: cat, score }
    }
  }
  return mejor
}

/**
 * Limpia el valor del campo «Línea:»: corta en la siguiente etiqueta si el
 * OCR fusionó renglones, quita colas de separadores y limita a 80 caracteres
 * (el valor real es una línea corta del encabezado).
 */
function limpiarValorLinea(texto: string): string {
  return texto
    .replace(RE_CORTE_LINEA, '')
    .replace(/[\s.:;\-–—]+$/, '')
    .trim()
    .slice(0, 80)
    .trim()
}

/**
 * SOLICITANTE = SOLO nombre y apellidos (pedido del usuario 2026-10-24).
 * El documento imprime el DNI delante ("7126 CHINCHAY…") y el OCR añade
 * ruido suelto ("H", rayas, dos puntos). Se limpia TODO lo que no es
 * nombre: dígitos en cualquier posición, símbolos, y los tokens basura
 * previos al primer apellido — sin tocar partículas legítimas (DE, LA).
 */
function limpiarSolicitante(texto: string): string {
  const sinEtiquetas = texto
    .replace(
      /\s+(ALMAC[EÉ]N|ORDEN|FECHA|TURNO|PRODUCTO|LOTE|MONEDA|OBSERVACI|SUPERVIS|I[TÍ]EM|CANTIDAD|DESCRIPCI).*/i,
      ''
    )
    // DNI / códigos de empleado en CUALQUIER posición ("H 7126 CHINCHAY")
    .replace(/\b\d{1,12}\b/g, ' ')
    // Símbolos que el OCR pega al nombre (—, :, (, ), etc.)
    .replace(/[^A-ZÁÉÍÓÚÑÜa-záéíóúñü ,'\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Empieza en el PRIMER apellido: descarta tokens iniciales de 1-2 letras
  // que no sean partículas de apellido reales ("H CHINCHAY…" → "CHINCHAY…")
  const PARTICULAS = new Set(['DE', 'LA', 'EL', 'Y', 'LO', 'MA'])
  const toks = sinEtiquetas.split(' ').filter(Boolean)
  while (toks.length > 1) {
    const t = toks[0].toUpperCase()
    const esParticula = PARTICULAS.has(t)
    const esApellido = /^[A-ZÁÉÍÓÚÑÜ]{3,}$/.test(t)
    if (esParticula || esApellido) break
    toks.shift()
  }
  return toks.join(' ').replace(/[\s.:\-–—]+$/, '').trim()
}

/**
 * Quita el ESTADO por fila que el formato AJEPER 2026 (RQ 0000191740) imprime
 * al final de cada material: «… UN 165,000.0000 120,000.0000 Pendiente».
 * Un token sin dígitos tras la última cifra NO es parte del material (el
 * estado puede salir con ruido OCR: "Pendiante", "Pend iente"…), así que se
 * retiran hasta 3 tokens finales sin dígitos y se detiene en la primera cifra.
 */
function quitarEstadoFinal(texto: string): string {
  let t = texto
  for (let i = 0; i < 3; i++) {
    const recortada = t.replace(/\s+[^\d\s]+$/i, '')
    if (recortada === t) break
    t = recortada
  }
  return t.trimEnd()
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
    linea: '',
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
    if (!res.linea) {
      const mLinea = linea.match(RE_LINEA)
      if (mLinea) {
        const limpio = limpiarValorLinea(mLinea[1])
        if (limpio.length >= 2) res.linea = limpio
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
    // PRIMERO se intenta leer la fila (código + cantidad): un material cuya
    // descripción menciona "CANTIDAD"/"FECHA" no debe perderse. El guion
    // separador de la tabla que el OCR pega al inicio de la fila se retira
    // antes ("---- 001 57268 …", típico en el pase zoom).
    const mFila = linea.replace(/^[-—–_\s]+/, '').match(/^(\d{1,8})\s+(.{3,})$/)
    if (!mFila) continue
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

    // ── CANTIDAD: ancla doble (2 formatos AJEPER) ────────────────────
    //
    // ANCLA A · formato clásico (RQ 0000191373): cantidad [+ unidad] al
    // FINAL de la línea — sin cantidad final la línea NO es un material.
    //   «001 55487 BASE PARA BEBIDA … PIVA 5   24.0000»
    //
    // ANCLA B · formato con ESTADO y SALDO por fila (RQ 0000191740,
    // 2026-10-24): la unidad PRECEDE a la cantidad (UNID. → CANTIDAD) y
    // tras ella pueden venir el saldo y el estado:
    //   «001 57268 ETIQUETA … DIS.25 UN 165,000.0000 120,000.0000 Pendiente»
    // La columna de estado ("Pendiente") y el saldo rompían el ancla
    // clásica y NINGÚN material entraba ("no jala los items", error
    // reportado 24-10-2026). Selección:
    //   · Si tras la «unidad cantidad» quedan cifras (columna de saldo) o
    //     el ancla clásica no cuadra → manda la cantidad marcada por la
    //     ÚLTIMA unidad con número detrás (la cifra sobrante es el saldo).
    //   · Si no, manda el ancla clásica (compatibilidad total: cero cambio
    //     para las RQ que ya funcionaban).
    //   · Último recurso: ancla clásica tras quitar el estado
    //     («24.0000 Pendiente» / «24.0000 UN Pendiente»).
    const reCantFinal = new RegExp(
      '(' + RE_CANTIDAD.source + ')\\s*(' + [...UNIDADES].join('|') + ')?\\s*$'
    )
    let cantidad = 0
    let unidad = ''
    let descripcion = ''
    const cerrarFinal = (fuente: string, m: RegExpMatchArray) => {
      cantidad = aNumero(m[1])
      unidad = (m[2] ?? '').trim()
      descripcion = fuente.slice(0, m.index ?? 0).replace(/[\s.\-–—:]+$/, '').trim()
    }
    const cerrarUnidad = (fuente: string, m: RegExpExecArray) => {
      cantidad = aNumero(m[2])
      unidad = m[1]
      descripcion = fuente.slice(0, m.index).replace(/[\s.\-–—:]+$/, '').trim()
    }

    const mFinal = resto.match(reCantFinal)
    const cola = quitarEstadoFinal(resto)
    const reUnidadCant = new RegExp(
      '\\b(' + [...UNIDADES].join('|') + ')\\b\\s*[-—–+.:]?\\s*(' + RE_CANTIDAD.source + ')',
      'g'
    )
    let mU: RegExpExecArray | null
    let ultima: RegExpExecArray | null = null
    while ((mU = reUnidadCant.exec(cola))) {
      if (aNumero(mU[2]) > 0) ultima = mU
    }
    // ¿Quedan cifras DESPUÉS de la «unidad cantidad»? → columna de saldo
    const haySaldo = ultima ? /\d/.test(cola.slice(ultima.index + ultima[0].length)) : false

    if (ultima && (haySaldo || !mFinal)) {
      cerrarUnidad(cola, ultima)
    } else if (mFinal) {
      cerrarFinal(resto, mFinal)
    } else {
      const mCola = cola.match(reCantFinal)
      if (mCola) {
        cerrarFinal(cola, mCola)
      } else {
        continue
      }
    }
    if (cantidad <= 0) continue

    // Descripción demasiado corta → tratar de completarla con el catálogo
    // ANTI-FECHAS (pedido del usuario 2026-10-23): un fragmento de fecha
    // jamás se registra como material.
    if (esFragmentoFecha(descripcion)) continue
    let cat = enCatalogoPorCodigo(codigo, catalogo)
    // ── COMPUERTA DE COHERENCIA (Task 23 — igual que la guía, guia-ocr) ──
    // El OCR confundió un dígito del código y aterrizó en OTRO producto real
    // del catálogo (caso real 24-10: 57268 leído 57265 = ETIQUETA AGUA
    // CIELO): el match directo "existe" y la descripción OFICIAL enmascaraba
    // el error → fila fantasma con check verde. Ahora el match directo
    // DEBE explicar la descripción leída; si no:
    //   a) un vecino a 1 dígito que la explique MUCHO mejor reemplaza al
    //      código (57265 → 57268), y la fila queda a revisión de todos modos;
    //   b) sin vecino convincente, el match queda marcado a revisión
    //      (descripción con ruido OCR — el usuario la confirma a mano).
    let revisionPorIncoherencia = false
    if (cat && descripcion.length >= DESC_MIN) {
      const sDirecto = similitudDescripcion(descripcion, cat.descripcion)
      const vecino = mejorVecinoUnDigito(codigo, descripcion, catalogo)
      if (sDirecto < COHERENCIA_CODIGO) {
        if (vecino && vecino.item.codigo !== cat.codigo && vecino.score >= sDirecto) {
          cat = vecino.item
        }
        revisionPorIncoherencia = true
      } else if (
        vecino &&
        vecino.item.codigo !== cat.codigo &&
        vecino.score >= UMBRAL_MIN &&
        vecino.score >= sDirecto + 0.15
      ) {
        // Familia con nombres casi idénticos: el vecino explica la lectura
        // mucho mejor que el match directo → el dígito confundido manda.
        cat = vecino.item
        revisionPorIncoherencia = true
      }
    }
    if (cat) {
      if (descripcion.length < DESC_MIN) descripcion = cat.descripcion
    } else if (descripcion.length >= DESC_MIN) {
      // VECINO A 1 DÍGITO validado por descripción ("115"→"118" en la RQ real)
      const vecino = vecinoUnDigito(codigo, descripcion, catalogo)
      if (vecino) cat = vecino
    }
    // MATCH POR DESCRIPCIÓN (igual que la guía): el código salió ilegible o
    // errado pero la descripción coincide con el catálogo → se adopta el
    // código catalogado. score < UMBRAL_AUTO queda marcado para revisión.
    let porDescripcion = false
    let revisionPorScore = false
    if (!cat && descripcion.length >= DESC_MIN && catalogo.length > 0) {
      const alt = buscarPorDescripcion(descripcion, catalogo)
      if (alt) {
        cat = alt.item
        porDescripcion = true
        revisionPorScore = alt.score < UMBRAL_AUTO
      }
    }
    if (descripcion.length < DESC_MIN) continue
    // ANTI-RUIDO NUMÉRICO (Task 23): sin respaldo de catálogo, una
    // descripción sin NI UNA palabra real no es un material — es ruido del
    // OCR (cifras pegadas, saldo de la columna, secuencia). Con catálogo la
    // descripción oficial ya reemplazó a la leída, así que este filtro no
    // afecta materiales reales.
    if (!cat && !tienePalabraReal(descripcion)) continue

    // El vecino validado REEMPLAZA al código leído (115 → 118)
    const codigoFinal = cat && cat.codigo.replace(/\D/g, '') !== codigo ? cat.codigo : codigo
    const codigoCambioPorRigor = codigoFinal !== codigo

    // Dedupe por CÓDIGO (una requisición no repite un material; el OCR sí
    // repite filas al releer la misma tabla en 2 pases con cantidad distinta)
    if (codigosVistos.has(codigoFinal)) continue
    codigosVistos.add(codigoFinal)

    if (res.items.length >= MAX_ITEMS) break
    res.items.push({
      codigo: codigoFinal,
      // El catálogo es la fuente de verdad: si el código existe, la
      // descripción OFICIAL reemplaza a la leída por OCR (corrige de paso
      // las lecturas con ruido: "36.1"→"38.1", "MÍ"→"ML"). Sin catálogo
      // se conserva la lectura y la fila queda marcada para revisión.
      descripcion: cat ? cat.descripcion : descripcion,
      cantidad,
      unidad: unidad || cat?.un || '',
      enCatalogo: Boolean(cat),
      revision: !cat || revisionPorScore || revisionPorIncoherencia,
      matchPorDescripcion: porDescripcion,
      // Rigor: el código cambió por la compuerta de coherencia (no por
      // matchPorDescripcion, que ya marca su propio chip).
      ...(codigoCambioPorRigor && !porDescripcion
        ? { matchPorDescripcion: true, revision: true }
        : {}),
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
  const avisos: string[] = [...(a.avisos ?? []), ...(b.avisos ?? [])]
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
      // ── VOTACIÓN DE CANTIDAD (Task 23 — rigor numérico) ──
      // El mismo material leído con cifras DISTINTAS en 2 pases = dígito
      // dudoso (4↔9). No se adivina cuál es: manda la lectura con catálogo
      // (o la primera) y la fila queda marcada a revisión con aviso visible.
      if (
        previo &&
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
    vistas.add(it.codigo)
    items.push({ ...it })
  }
  return {
    numeroRq: a.numeroRq || b.numeroRq,
    ordenProduccion: a.ordenProduccion || b.ordenProduccion,
    productoCodigo: a.productoCodigo || b.productoCodigo,
    productoDescripcion: a.productoDescripcion || b.productoDescripcion,
    fecha: a.fecha || b.fecha,
    linea: a.linea || b.linea,
    solicitante: a.solicitante || b.solicitante,
    items,
    ...(avisos.length > 0 ? { avisos } : {}),
  }
}

/** Puntaje de calidad de la extracción (mayor = mejor lectura). */
export function puntuarExtraccionRq(d: DatosRq): number {
  let p = d.items.length * 2
  if (d.numeroRq) p += 2
  if (d.ordenProduccion) p += 1
  if (d.fecha) p += 1
  if (d.linea) p += 1
  if (d.solicitante) p += 1
  if (d.productoCodigo) p += 1
  p += d.items.filter((i) => i.enCatalogo).length
  return p
}

/** ¿La lectura alcanza para no re-procesar? (3 pilares: items + RQ + fecha) */
export function extraccionSuficienteRq(d: DatosRq): boolean {
  return d.items.length > 0 && Boolean(d.numeroRq) && Boolean(d.fecha)
}

// ═══════════════════════════════════════════════════════════════════
// FRANJA DE LA TABLA (zoom "cuadro por cuadro" — igual que la guía)
// ═══════════════════════════════════════════════════════════════════

/**
 * Localiza la franja de la tabla de materiales de la RQ usando las palabras
 * del OCR: la tabla vive SIEMPRE después del bloque de etiquetas del
 * encabezado (Solicitante / TURNO Y FECH / Línea). Devuelve coordenadas en
 * el MISMO espacio de la imagen que se leyó; yBot = alto de la imagen porque
 * la tabla corre hasta el final del documento.
 * Si no hay anclas (OCR del encabezado falló) usa el 30% como inicio seguro.
 */
export function anclasTablaRq(
  palabras: PalabraOCR[],
  altoImagen: number
): { yTop: number; yBot: number } {
  const yEtiquetas = palabras
    .filter((p) => /^(SOLICITANT?E?|TURNO|L[IÍ]NEA|FECHA)/.test(p.t))
    .reduce((m, p) => Math.max(m, p.y1), 0)
  const yTop = yEtiquetas > 0 ? yEtiquetas + 4 : Math.round(altoImagen * 0.3)
  if (yTop >= altoImagen - 40) return { yTop: Math.round(altoImagen * 0.3), yBot: altoImagen }
  return { yTop, yBot: altoImagen }
}

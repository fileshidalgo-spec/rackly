/**
 * RACKLY · ALMACÉN REPUESTOS — Mapeo Excel → catálogo (lógica PURA).
 *
 * Separado a propósito del componente: los tests lo ejercitan sin red ni
 * xlsx (el componente solo hace `await import('xlsx')` + sheet_to_json y
 * delega AQUÍ). Acordado con el usuario: 4 columnas —
 *   CODIGO · DESCRIPCIÓN · UND · CANTIDAD
 * CANTIDAD es SOLO REFERENCIA (cantidad_ref): no es stock ni interfiere.
 *
 * Tolerancia de encabezados (misma filosofía de DescargaTab de Insumos):
 * mayúsculas/minúsculas, acentos y sinónimos se detectan automáticamente.
 */

import type { RepFilaExcel } from './rep-client'
import { aNumero } from '../formato'

/** Columnas detectadas de la hoja (índices por nombre real del archivo). */
export type RepColumnasExcel = {
  codigo: string
  descripcion: string | null
  und: string | null
  cantidad: string | null
}

const NORMALIZAR = (h: string) =>
  h
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos: DESCRIPCIÓN → DESCRIPCION
    .trim()
    .toLowerCase()

/**
 * Detecta las 4 columnas por sinónimos. CODIGO es obligatorio (si no hay
 * candidato claro, cae a la PRIMERA columna — convención de los reportes
 * de BIG MAGIC). DESCRIPCIÓN cae a la segunda si existe.
 */
export function repDetectarColumnas(headers: string[]): RepColumnasExcel | null {
  if (headers.length === 0) return null
  const norm = headers.map((h) => ({ original: h, n: NORMALIZAR(h) }))

  const codigo =
    norm.find((h) => /^(codigo|cod|code|sku|item|part|parte|numero de parte)$/.test(h.n))?.original ??
    norm.find((h) => /(codigo|code|sku|item)/.test(h.n))?.original ??
    headers[0]

  const descripcion =
    norm.find((h) => /(descripcion|description|nombre|name|producto|product|detalle)/.test(h.n))
      ?.original ?? headers[1] ??
    null

  const und =
    norm.find((h) => /^(und|u m|unidad|unidades|unit|um|medida)$/.test(h.n))?.original ??
    norm.find((h) => /^(und|unidad|unit|um|medida)/.test(h.n))?.original ??
    null

  const cantidad =
    norm.find((h) => /(cantidad_ref|cant ref|cantidad de referencia|stock ref)/.test(h.n))?.original ??
    norm.find((h) => /(cantidad|cant|quantity|qty|stock|ref)/.test(h.n))?.original ??
    null

  return { codigo, descripcion, und, cantidad }
}

/**
 * Convierte una celda de cantidad a número. REUSA `aNumero` de formato.ts
 * (el parser probado del repo: "1,500.50" US, "1.500,50" EU, "2,884" miles
 * por grupos de 3, "12,5" decimal). NUNCA lanza y vacío/basura → 0:
 * cantidad_ref es solo referencia, una celda sucia no tumbará la carga.
 */
export function repNumeroDeCelda(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  // Quita texto pegado ("12 und", "n/d") y delega al parser probado.
  const limpio = String(v ?? '').trim().replace(/[^\d.,-]/g, '')
  if (!limpio || limpio === '-') return 0
  const n = aNumero(limpio)
  return Number.isFinite(n) ? n : 0
}

export type RepResultadoMapeo = {
  filas: RepFilaExcel[]
  /** Filas descartadas con motivo (para el reporte de errores de carga) */
  descartes: string[]
  /** Códigos repetidos DENTRO del archivo (se queda la última aparición) */
  duplicadosArchivo: string[]
}

/**
 * Mapea las filas de la hoja (sheet_to_json con defval:'') a filas de
 * carga. Deduplica por código (última aparición gana — re-subir un Excel
 * corregido no debe dejar dos versiones del mismo código en el lote).
 */
export function repMapearFilas(
  data: Array<Record<string, unknown>>,
  col: RepColumnasExcel
): RepResultadoMapeo {
  const descartes: string[] = []
  const porCodigo = new Map<string, RepFilaExcel>()
  const repetidos = new Set<string>()

  data.forEach((row, i) => {
    const nFila = i + 2 // +2: hoja 1-indexed + fila de encabezados
    const codigo = String(row[col.codigo] ?? '').trim().toUpperCase()
    if (!codigo || codigo === NORMALIZAR(col.codigo).toUpperCase() || codigo === col.codigo.toUpperCase()) {
      // Celda vacía o fila de encabezado repetida
      if (codigo === col.codigo.toUpperCase()) return // encabezado duplicado: silencioso
      descartes.push(`Fila ${nFila}: código vacío`)
      return
    }
    const descripcion = col.descripcion ? String(row[col.descripcion] ?? '').trim() : ''
    if (!descripcion) {
      descartes.push(`Fila ${nFila} (${codigo}): descripción vacía`)
      return
    }
    const und = col.und ? String(row[col.und] ?? '').trim() : ''
    const cantidad_ref = col.cantidad ? repNumeroDeCelda(row[col.cantidad]) : 0

    if (porCodigo.has(codigo)) {
      repetidos.add(codigo)
      descartes.push(`Fila ${nFila} (${codigo}): duplicado en el archivo — se usa la última`)
    }
    porCodigo.set(codigo, { fila: nFila, codigo, descripcion, und, cantidad_ref })
  })

  return {
    filas: Array.from(porCodigo.values()),
    descartes,
    duplicadosArchivo: Array.from(repetidos).sort(),
  }
}

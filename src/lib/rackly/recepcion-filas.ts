'use client'

/**
 * RACKLY — Recepción · Expansión de artículos a filas de registro (paletas).
 *
 * Regla de negocio "DIVIDIR": una guía trae la SUMA de la mercadería, pero
 * llega en varias PALETAS con cantidades distintas y cada paleta se rotula
 * con SU cantidad. El editor permite dividir un artículo en N paletas; al
 * registrar, cada paleta se guarda como SU PROPIA fila (mismo código,
 * descripción, lote y fechas; cantidad propia; "Paleta i/N" en
 * observaciones) — así la reimpresión agrupada por guía y el modal de
 * rótulos ya salen paleta por paleta, sin tocar el generador ZPL.
 *
 * Este módulo es PURA (sin UI): testeable con esbuild+node.
 */

import { aNumero } from '@/lib/rackly/formato'

/**
 * Entrada: un artículo del editor (ItemRecepcion satisface esta forma;
 * se declara estructural para no acoplar la lib a la UI).
 * `paletas` = cantidades digitadas por paleta (vacío = artículo sin dividir).
 */
export type ItemConPaletas = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  paletas?: string[]
}

/** Fila concreta a registrar en la BD / a rotular. */
export type FilaRecepcion = {
  codigo: string
  descripcion: string
  cantidad: string // texto tal cual digitado (para el rótulo)
  cantidadNum: number
  unidad: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  /** "Paleta i/N" cuando la fila viene de un artículo dividido. */
  paleta: string
}

/** Límite de paletas por artículo (la operación real reporta hasta 5). */
export const MAX_PALETAS = 10

/** Suma de las cantidades válidas (> 0) digitadas en las paletas. */
export function sumaPaletas(paletas: string[] | undefined): number {
  if (!paletas) return 0
  return paletas.reduce((s, p) => {
    const n = aNumero(p ?? '')
    return s + (isNaN(n) ? 0 : n)
  }, 0)
}

/** Cantidad total digitada del artículo (NaN si está vacía). */
export function totalArticulo(item: ItemConPaletas): number {
  return aNumero(item.cantidad ?? '')
}

/**
 * Expande los artículos a filas concretas:
 *   · SIN dividir → 1 fila con la cantidad total.
 *   · DIVIDIDO    → 1 fila por paleta con cantidad > 0 (las vacías se
 *                   descartan); si NINGUNA tiene cantidad, cae a la fila
 *                   única con el total (nunca se pierde el artículo).
 * El orden interno se conserva (artículo 1 con sus paletas, artículo 2…).
 */
export function expandirEnFilas(items: ItemConPaletas[]): FilaRecepcion[] {
  const filas: FilaRecepcion[] = []
  for (const it of items) {
    const base = {
      codigo: (it.codigo ?? '').trim(),
      descripcion: (it.descripcion ?? '').trim(),
      unidad: (it.unidad ?? '').trim(),
      lote: (it.lote ?? '').trim(),
      fechaProduccion: (it.fechaProduccion ?? '').trim(),
      fechaVencimiento: (it.fechaVencimiento ?? '').trim(),
    }
    const paletasValidas = (it.paletas ?? [])
      .map((p) => aNumero(p ?? ''))
      .filter((n) => !isNaN(n) && n > 0)
    if (paletasValidas.length > 1) {
      const n = paletasValidas.length
      paletasValidas.forEach((cantidadNum, i) => {
        filas.push({
          ...base,
          cantidad: formatearCantidad(cantidadNum),
          cantidadNum,
          paleta: `Paleta ${i + 1}/${n}`,
        })
      })
    } else {
      const cantidadNum = totalArticulo(it)
      filas.push({
        ...base,
        cantidad: (it.cantidad ?? '').trim(),
        cantidadNum: isNaN(cantidadNum) ? 0 : cantidadNum,
        paleta: '',
      })
    }
  }
  return filas
}

/** 193320 → "193320" · 12.5 → "12.5" (sin ceros de más, punto decimal). */
export function formatearCantidad(n: number): string {
  const redondeado = Math.round(n * 1000) / 1000
  return String(redondeado)
}

/**
 * Reparte `total` en `n` partes iguales (la última absorbe el residuo) para
 * pre-llenar las paletas al dividir; con total inválido devuelve n vacíos.
 */
export function distribuirEquitativo(total: string, n: number): string[] {
  const t = aNumero(total ?? '')
  if (isNaN(t) || t <= 0 || n < 2) return Array.from({ length: n }, () => '')
  const parte = Math.floor((t / n) * 1000) / 1000
  const partes = Array.from({ length: n }, () => formatearCantidad(parte))
  const suma = parte * (n - 1)
  partes[n - 1] = formatearCantidad(Math.round((t - suma) * 1000) / 1000)
  return partes
}

/**
 * AVISOS de coherencia por artículo dividido: la suma de sus paletas debería
 * cuadrar con el total digitado de la guía. Devuelve mensajes legibles
 * (vacío = todo cuadra); la UI decide cómo mostrarlos. Se permite guardar
 * igual (mermas/parciales), pero nunca en silencio.
 */
export function avisosDePaletas(items: ItemConPaletas[]): string[] {
  const avisos: string[] = []
  for (const it of items) {
    if (!it.paletas || it.paletas.length === 0) continue
    const suma = sumaPaletas(it.paletas)
    const total = totalArticulo(it)
    if (suma > 0 && !isNaN(total) && total > 0 && Math.abs(suma - total) > 0.001) {
      avisos.push(
        `${it.codigo || it.descripcion || 'artículo'}: paletas ${formatearCantidad(suma)} ≠ total ${formatearCantidad(total)}`
      )
    }
  }
  return avisos
}

// ═══════════════════════════════════════════════════════════════════
// EDICIÓN DE UNA GUÍA REGISTRADA: re-ensamblar filas → items
// ═══════════════════════════════════════════════════════════════════

/**
 * Extrae la marca "Paleta i/N" de las observaciones de una fila registrada
 * (la deja expandirEnFilas al guardar un artículo dividido). null si la
 * fila no viene de una paleta.
 */
export function marcaPaletaDe(observaciones: string): { i: number; n: number } | null {
  const m = (observaciones ?? '').match(/Paleta (\d+)\/(\d+)/)
  if (!m) return null
  const i = Number(m[1])
  const n = Number(m[2])
  return i >= 1 && n >= 2 && i <= n ? { i, n } : null
}

/** Observaciones SIN la marca "Paleta i/N" (texto que el usuario digitó). */
export function obsSinMarcaPaleta(observaciones: string): string {
  return (observaciones ?? '')
    .replace(/\s*·?\s*Paleta \d+\/\d+/g, '')
    .replace(/\s*·\s*$/, '')
    .trim()
}

/**
 * Operación INVERSA de expandirEnFilas sobre filas YA registradas: reconstruye
 * los items del editor a partir de las filas de UNA guía en la BD. Las filas
 * marcadas "Paleta i/N" del mismo artículo (consecutivas, orden created_at)
 * vuelven a ser UN item con `paletas`; el resto son items de fila única.
 * Así "Editar guía" reabre el documento tal cual se guardó (incluida la
 * división en paletas) y el usuario puede revisar/ajustar y volver a guardar.
 */
export function filasAItems(filas: FilaRegistrada[]): ItemConPaletas[] {
  const items: ItemConPaletas[] = []
  for (const f of filas) {
    const marca = marcaPaletaDe(f.observaciones)
    const prev = items[items.length - 1]
    if (marca && prev && prev.codigo === f.codigo && prev.paletas && prev.paletas.length < marca.n) {
      // Siguiente paleta del mismo artículo dividido.
      prev.paletas.push(formatearCantidad(f.cantidad))
      continue
    }
    if (marca) {
      // Inicio de un grupo de paletas (nuevo o huérfano: la fila participa).
      items.push({
        codigo: f.codigo,
        descripcion: f.descripcion,
        cantidad: formatearCantidad(f.cantidad),
        unidad: f.unidadMedida,
        lote: f.lote,
        fechaProduccion: f.fechaProduccion,
        fechaVencimiento: f.fechaVencimiento,
        paletas: [formatearCantidad(f.cantidad)],
      })
    } else {
      items.push({
        codigo: f.codigo,
        descripcion: f.descripcion,
        cantidad: formatearCantidad(f.cantidad),
        unidad: f.unidadMedida,
        lote: f.lote,
        fechaProduccion: f.fechaProduccion,
        fechaVencimiento: f.fechaVencimiento,
      })
    }
  }
  // El total del item dividido = suma de sus paletas (lo registrado manda).
  for (const it of items) {
    if (it.paletas && it.paletas.length > 0) {
      it.cantidad = formatearCantidad(sumaPaletas(it.paletas))
    }
  }
  return items
}

// ═══════════════════════════════════════════════════════════════════
// AGRUPADO DEL REGISTRO: UNA FILA POR GUÍA
// ═══════════════════════════════════════════════════════════════════

/**
 * Fila YA registrada (estructural: RegistroRecepcion de modulos.ts satisface
 * esta forma; se declara suelto para que esta lib no dependa de Supabase).
 */
export type FilaRegistrada = {
  id: string
  createdAt: string
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  proveedor: string
  placa: string
  fotoUrl: string
  estado: string
  usuarioId: string
  usuarioNombre: string
  usuarioCorreo: string
  codigo: string
  descripcion: string
  cantidad: number
  unidadMedida: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  /** Observaciones (trae "Paleta i/N" cuando la fila viene de un dividido). */
  observaciones: string
}

/** Una guía completa del registro: encabezado compartido + sus filas. */
export type GuiaAgrupada = {
  /** Clave de identidad (igual que usa la impresión agrupada). */
  clave: string
  ref: { tipoDocumento: string; numeroDocumento: string; fecha: string; proveedor: string }
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  proveedor: string
  placa: string
  fotoUrl: string
  usuarioNombre: string
  usuarioCorreo: string
  usuarioId: string
  filas: FilaRegistrada[]
  cantidadTotal: number
  /** Estado del documento si TODAS sus filas coinciden; '' si difieren. */
  estado: string
}

/**
 * Identidad de la guía (MISMA regla que listarRecepcionesPorDocumento):
 * con Nº de documento → tipo+número; sin Nº → fecha+tipo+proveedor.
 */
export function claveGuiaDe(f: {
  tipoDocumento: string
  numeroDocumento: string
  fecha: string
  proveedor: string
}): string {
  const num = (f.numeroDocumento ?? '').trim()
  if (num) return `D:${(f.tipoDocumento ?? '').trim().toUpperCase()}|${num.toUpperCase()}`
  return `S:${(f.fecha ?? '').trim()}|${(f.tipoDocumento ?? '').trim().toUpperCase()}|${(f.proveedor ?? '').trim().toUpperCase()}`
}

/**
 * Agrupa las filas del registro por documento: el listado muestra UNA fila
 * por guía con TODOS sus artículos dentro (el usuario pidió que "todo debe
 * quedar contenido en el número de guía correspondiente"). Conserva el
 * orden de primera aparición (la lista llega ordenada fecha/created_at).
 */
export function agruparGuias(filas: FilaRegistrada[]): GuiaAgrupada[] {
  const porClave = new Map<string, GuiaAgrupada>()
  const orden: string[] = []
  for (const f of filas) {
    const clave = claveGuiaDe(f)
    let g = porClave.get(clave)
    if (!g) {
      g = {
        clave,
        ref: {
          tipoDocumento: f.tipoDocumento,
          numeroDocumento: f.numeroDocumento,
          fecha: f.fecha,
          proveedor: f.proveedor,
        },
        fecha: f.fecha,
        tipoDocumento: f.tipoDocumento,
        numeroDocumento: f.numeroDocumento,
        proveedor: f.proveedor,
        placa: f.placa,
        fotoUrl: f.fotoUrl,
        usuarioNombre: f.usuarioNombre,
        usuarioCorreo: f.usuarioCorreo,
        usuarioId: f.usuarioId,
        filas: [],
        cantidadTotal: 0,
        estado: f.estado,
      }
      porClave.set(clave, g)
      orden.push(clave)
    }
    g.filas.push(f)
    g.cantidadTotal += f.cantidad
    if (g.estado !== f.estado) g.estado = ''
    // Encabezado: rellenar huecos con la primera fila que traiga el dato.
    if (!g.placa && f.placa) g.placa = f.placa
    if (!g.fotoUrl && f.fotoUrl) g.fotoUrl = f.fotoUrl
    if (!g.usuarioNombre && f.usuarioNombre) g.usuarioNombre = f.usuarioNombre
  }
  return orden.map((c) => porClave.get(c) as GuiaAgrupada)
}

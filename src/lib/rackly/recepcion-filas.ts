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
import { requiereProveedor } from '@/lib/utils'

/**
 * Una PALETA del editor de división: SU cantidad y OPCIONALMENTE sus datos
 * propios de lote/fechas/proveedor (pedido del usuario: poder corregir el
 * vencimiento/producción/lote de UNA paleta específica — o aplicar el mismo
 * a todas — sin cambiar código, descripción ni la cantidad total que ya
 * jaló la guía; y 2026-10-22: elegir OTRO proveedor en UNA paleta — una
 * guía de una empresa puede traer paletas de proveedores distintos).
 * Un campo vacío = esa paleta USA el dato del artículo.
 */
export type PaletaDividir = {
  cantidad: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  /** Proveedor PROPIO de la paleta ('' = usa el del artículo). */
  proveedor: string
  /**
   * Id de la fila YA registrada de la que nació esta paleta (solo edición
   * de guía: `filasAItems` lo adjunta). undefined/null = paleta NUEVA →
   * al guardar se INSERTA; ausente en el plan = fila sobrante → DELETE.
   */
  filaId?: string | null
}

/** Paleta vacía (hereda lote/fechas/proveedor del artículo; sin cantidad; NUEVA). */
export function paletaVacia(): PaletaDividir {
  return {
    cantidad: '',
    lote: '',
    fechaProduccion: '',
    fechaVencimiento: '',
    proveedor: '',
    filaId: null,
  }
}

/**
 * Normaliza una paleta: acepta el formato antiguo (string = solo cantidad)
 * por compatibilidad con datos ya construidos en memoria — nunca lanza.
 */
export function aPaleta(valor: string | PaletaDividir): PaletaDividir {
  if (typeof valor === 'string') return { ...paletaVacia(), cantidad: valor }
  return {
    cantidad: valor.cantidad ?? '',
    lote: valor.lote ?? '',
    fechaProduccion: valor.fechaProduccion ?? '',
    fechaVencimiento: valor.fechaVencimiento ?? '',
    proveedor: valor.proveedor ?? '',
    // Identidad de edición: PRESERVAR (agregar/quitar/repartir paletas no
    // debe perder de qué fila de la BD nació cada paleta).
    filaId: valor.filaId ?? null,
  }
}

/**
 * Entrada: un artículo del editor (ItemRecepcion satisface esta forma;
 * se declara estructural para no acoplar la lib a la UI).
 * `paletas` = paletas digitadas (vacío/ausente = artículo sin dividir);
 * cada una lleva su cantidad y opcionalmente su lote/fechas propios.
 */
export type ItemConPaletas = {
  codigo: string
  descripcion: string
  cantidad: string
  unidad: string
  lote: string
  fechaProduccion: string
  fechaVencimiento: string
  /** Proveedor del ARTÍCULO (film: INCOMIN/DAMAR/… — igual que Racks).
   *  '' cuando el producto no lo requiere (no-lámina/no-stretch). */
  proveedor?: string
  paletas?: PaletaDividir[]
  /**
   * Id de la fila de la BD de la que nació este artículo (solo edición de
   * guía). En artículos SIN dividir es la fila única; en divididos es la
   * fila "cabecera" (paleta 1) — usada si la división cae a fila única.
   */
  filaId?: string | null
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
  /** Proveedor del ARTÍCULO de esta fila (o el de SU paleta si trajo uno
   *  propio). '' cuando el producto no lo requiere. */
  proveedor: string
  /** "Paleta i/N" cuando la fila viene de un artículo dividido. */
  paleta: string
  /** Id de la fila ya registrada que esta fila ACTUALIZA (edición; null = nueva). */
  filaId?: string | null
}

/**
 * Límite de paletas por artículo (pedido del usuario 2026-10: hasta 44 —
 * guías que llegan en camiones completos paleta por paleta).
 */
export const MAX_PALETAS = 44

/** Suma de las cantidades válidas (> 0) digitadas en las paletas. */
export function sumaPaletas(paletas: (string | PaletaDividir)[] | undefined): number {
  if (!paletas) return 0
  return paletas.reduce((s, p) => {
    const n = aNumero(aPaleta(p).cantidad)
    return s + (isNaN(n) ? 0 : n)
  }, 0)
}

/**
 * Junta las cantidades del REPARTO con las paletas previas: conserva el
 * lote/fechas/proveedor PROPIO de cada posición existente (agregar/quitar NO
 * borra lo digitado por paleta) y las paletas nuevas nacen heredando del
 * artículo (override ''). Si no llega reparto (null) conserva las cantidades
 * tal cual.
 */
export function combinarPaletas(
  prev: (string | PaletaDividir)[],
  cantidades: string[] | null
): PaletaDividir[] {
  const prevN = (prev ?? []).map(aPaleta)
  const n = cantidades ? cantidades.length : prevN.length
  return Array.from({ length: n }, (_, i) => ({
    cantidad: cantidades?.[i] ?? prevN[i]?.cantidad ?? '',
    lote: prevN[i]?.lote ?? '',
    fechaProduccion: prevN[i]?.fechaProduccion ?? '',
    fechaVencimiento: prevN[i]?.fechaVencimiento ?? '',
    proveedor: prevN[i]?.proveedor ?? '',
    // Identidad de edición: cada posición conserva la fila de la BD de la
    // que nació (agregar/quitar/repartir NO re-asigna identidades: la
    // paleta nueva nace sin id → INSERT; la quitada desaparece → DELETE).
    filaId: prevN[i]?.filaId ?? null,
  }))
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
      proveedor: (it.proveedor ?? '').trim(),
    }
    // Datos propios POR PALETA: un campo lleno gana; vacío = hereda el del
    // artículo (así editar el lote/fechas del artículo sigue moviendo a las
    // paletas que no tengan dato propio — sin sorpresas).
    const validas = (it.paletas ?? [])
      .map(aPaleta)
      .filter((p) => {
        const n = aNumero(p.cantidad)
        return !isNaN(n) && n > 0
      })
    if (validas.length > 1) {
      const n = validas.length
      validas.forEach((p, i) => {
        const cantidadNum = aNumero(p.cantidad)
        filas.push({
          ...base,
          cantidad: formatearCantidad(cantidadNum),
          cantidadNum,
          lote: (p.lote || base.lote).trim(),
          fechaProduccion: (p.fechaProduccion || base.fechaProduccion).trim(),
          fechaVencimiento: (p.fechaVencimiento || base.fechaVencimiento).trim(),
          proveedor: (p.proveedor || base.proveedor).trim(),
          paleta: `Paleta ${i + 1}/${n}`,
          filaId: p.filaId ?? null,
        })
      })
    } else {
      // Fila única. Si el total quedó VACÍO (NaN) — o el usuario digitó un
      // literal "0" (FIX auditoría 2026-10-30, R3: antes la fila salía con
      // cantidad 0 aunque la única paleta con cantidad tuviera el valor real,
      // volviendo falso el aviso «se registra el total del artículo») — pero
      // hay UNA paleta válida, esa paleta es la única verdad disponible: usar
      // SU cantidad (y sus overrides de lote/fechas) en vez de un 0 silencioso.
      // Con total digitado > 0 manda el total (comportamiento fijado por tests).
      const totalNum = totalArticulo(it)
      const unica =
        validas.length === 1 && (isNaN(totalNum) || totalNum === 0) ? validas[0] : null
      const cantidadNum = unica ? aNumero(unica.cantidad) : totalNum
      filas.push({
        ...base,
        cantidad: unica ? unica.cantidad : (it.cantidad ?? '').trim(),
        cantidadNum: isNaN(cantidadNum) ? 0 : cantidadNum,
        lote: unica ? ((unica.lote || base.lote) as string).trim() : base.lote,
        fechaProduccion: unica
          ? ((unica.fechaProduccion || base.fechaProduccion) as string).trim()
          : base.fechaProduccion,
        fechaVencimiento: unica
          ? ((unica.fechaVencimiento || base.fechaVencimiento) as string).trim()
          : base.fechaVencimiento,
        proveedor: unica
          ? ((unica.proveedor || base.proveedor) as string).trim()
          : base.proveedor,
        paleta: '',
        filaId: unica ? (unica.filaId ?? null) : ((it.filaId ?? null) as string | null | undefined),
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
 * Total a usar al REDISTRIBUIR paletas: manda el total digitado del
 * artículo (100 → 4 paletas = 25 c/u); si el total está vacío o en 0
 * (artículo dividido sin total), usa la suma ACTUAL de las paletas.
 * Devuelve NaN si no hay base para repartir.
 */
export function totalParaRedistribuir(item: ItemConPaletas): number {
  const t = aNumero(item.cantidad ?? '')
  if (!isNaN(t) && t > 0) return t
  const s = sumaPaletas(item.paletas)
  return s > 0 ? s : NaN
}

/**
 * REPARTO AUTOMÁTICO al cambiar el Nº de paletas (pedido explícito:
 * "si aumento la cantidad de paletas se vaya dividiendo a cada que
 * aumente — 100 en 4 paletas → 25 por paleta"). Recalcula TODAS las
 * paletas en partes iguales con el total del artículo; la última absorbe
 * el residuo. Devuelve null si no hay base para repartir (sin total ni
 * suma) — en ese caso la UI conserva los valores tal cual.
 */
export function repartirEquitativo(item: ItemConPaletas, n: number): string[] | null {
  if (n < 2) return null
  const total = totalParaRedistribuir(item)
  if (isNaN(total)) return null
  return distribuirEquitativo(formatearCantidad(total), n)
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

/**
 * Artículos que EXIGEN proveedor (lámina/stretch — MISMA regla que Racks:
 * requiereProveedor(descripcion)) y no lo traen: devuelve identificadores
 * legibles para BLOQUEAR el registro (en Racks el ingreso de film sin
 * proveedor tampoco pasa). Las paletas NO rescantan: el proveedor vive en
 * el artículo; una paleta puede traer uno distinto (override), pero nunca
 * suplir al del artículo.
 */
export function faltanProveedor(items: ItemConPaletas[]): string[] {
  return items
    .filter((it) => requiereProveedor(it.descripcion ?? '') && !(it.proveedor ?? '').trim())
    .map((it) => it.codigo?.trim() || it.descripcion?.trim() || 'artículo sin código')
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
    // FIX auditoría 2026-10-30 (R5): un «Paleta 1/N» SIEMPRE abre SU propio
    // grupo (i === 1). Antes solo se miraba length < marca.n: un grupo
    // completo «Paleta 1/2, 2/2» seguido de OTRO grupo del mismo código
    // «Paleta 1/3» se fusionaba en un solo item de 3 paletas y la
    // renumeración impresa dejaba de coincidir con la física.
    // Los grupos INCOMPLETOS siguen uniendo como en el legado (2/2, 3/3 sin
    // la 1ª — filas perdidas se re-ensamblan; behavior cubierto por tests).
    const continuaGrupo = !!marca && marca.i > 1
    if (
      marca &&
      continuaGrupo &&
      prev &&
      prev.codigo === f.codigo &&
      prev.paletas &&
      prev.paletas.length < marca.n
    ) {
      // Siguiente paleta del mismo artículo dividido: SU cantidad y sus
      // datos PROPIOS solo si difieren de los del artículo (1ª fila del
      // grupo = valores del artículo; igual → '' = hereda). Cada paleta
      // conserva la IDENTIDAD de su fila (filaId) para la edición.
      prev.paletas.push({
        cantidad: formatearCantidad(f.cantidad),
        lote: f.lote !== prev.lote ? f.lote : '',
        fechaProduccion: f.fechaProduccion !== prev.fechaProduccion ? f.fechaProduccion : '',
        fechaVencimiento: f.fechaVencimiento !== prev.fechaVencimiento ? f.fechaVencimiento : '',
        proveedor: f.proveedor !== prev.proveedor ? f.proveedor : '',
        filaId: f.id,
      })
      continue
    }
    if (marca) {
      // Inicio de un grupo de paletas (nuevo o huérfano: la fila participa).
      // El item hereda el id de la fila cabecera (paleta 1): si la división
      // cae a fila única al re-guardar, esa fila sigue siendo la anfitriona.
      items.push({
        codigo: f.codigo,
        descripcion: f.descripcion,
        cantidad: formatearCantidad(f.cantidad),
        unidad: f.unidadMedida,
        lote: f.lote,
        fechaProduccion: f.fechaProduccion,
        fechaVencimiento: f.fechaVencimiento,
        proveedor: f.proveedor,
        paletas: [{ ...paletaVacia(), cantidad: formatearCantidad(f.cantidad), filaId: f.id }],
        filaId: f.id,
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
        proveedor: f.proveedor,
        filaId: f.id,
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

// NOTA DE DISEÑO (lote/fechas por paleta): expandirEnFilas y filasAItems son
// inversos — una guía guardada con lote/fechas distintos por paleta se
// re-ensambla con esos overrides y al volver a expandir reproduce EXACTAMENTE
// las mismas filas.

// ═══════════════════════════════════════════════════════════════════
// SINCRONIZACIÓN DE EDICIÓN POR IDENTIDAD (no posicional)
// ═══════════════════════════════════════════════════════════════════

/** Resultado del plan de sincronización de una edición de guía. */
export type PlanSyncEdicion<T> = {
  /** Filas que persisten: UPDATE por SU PROPIO id (contenido de su fila). */
  actualizar: Array<{ id: string; fila: T }>
  /** Filas nuevas o sin identidad válida: INSERT. */
  insertar: T[]
  /** Ids originales que ninguna fila reclama ya (artículo/paleta quitada): DELETE. */
  eliminar: string[]
}

/**
 * Planifica la sincronización de UNA guía editada por IDENTIDAD, nunca por
 * posición: cada fila expandida lleva el `filaId` de la fila de la BD de la
 * que nació (adjuntado por `filasAItems`), así quitar/dividir/agregar
 * artículos o paletas NUNCA cruza contenido entre filas (bug P0 corregido:
 * el sincronizado posicional escribía el artículo N sobre la fila M al
 * desplazarse la lista).
 *
 * Reglas:
 *   · filaId presente Y perteneciente a la guía → UPDATE de esa fila.
 *   · dos filas reclamando el mismo id → la primera lo conserva (la otra
 *     INSERTA — nunca doble escritura sobre una misma fila).
 *   · filaId apuntando a un id ajeno a la guía (residuo raro) → INSERT
 *     seguro (jamás escribe sobre una fila que no es suya).
 *   · ids originales no reclamados → DELETE (filas quitadas por el usuario).
 */
export function planSyncEdicionPorId<T extends { filaId?: string | null }>(
  idsOriginales: string[],
  filas: T[]
): PlanSyncEdicion<T> {
  const originales = new Set(idsOriginales)
  const usados = new Set<string>()
  const actualizar: Array<{ id: string; fila: T }> = []
  const insertar: T[] = []
  for (const f of filas) {
    const id = (f.filaId ?? '').trim()
    if (id && originales.has(id) && !usados.has(id)) {
      usados.add(id)
      actualizar.push({ id, fila: f })
    } else {
      insertar.push(f)
    }
  }
  const eliminar = idsOriginales.filter((id) => !usados.has(id))
  return { actualizar, insertar, eliminar }
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
  /** Identidad de la guía (M-2): todas las filas de una recepción la
   *  comparten. null/ausente solo en residuos pre-migración. */
  guiaId?: string | null
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  /** Empresa que envía (nivel documento). SIEMPRE presente en datos que
   *  vienen de la BD (backfill + respaldo del proveedor legacy en mapRecepcion). */
  empresaOrigen: string
  /** Proveedor del ARTÍCULO (film por fila; en filas legacy trae la empresa
   *  que envía — así se registraban antes de la separación 2026-10-22). */
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
  /** Nº de envíos de Tránsito sobre la fila (0/ausente = sin transferir).
   *  Estructural: RegistroRecepcion (modulos.ts) lo satisface. */
  enviosTransito?: number
}

/** Una guía completa del registro: encabezado compartido + sus filas. */
export type GuiaAgrupada = {
  /** Clave de identidad (igual que usa la impresión agrupada). */
  clave: string
  /** Referencia para operar la guía COMPLETA en la BD (imprimir, editar,
   *  estado, borrar, Excel). M-2: incluye guiaId — la identidad exacta. */
  ref: {
    guiaId?: string | null
    tipoDocumento: string
    numeroDocumento: string
    fecha: string
    proveedor: string
  }
  fecha: string
  tipoDocumento: string
  numeroDocumento: string
  /** Empresa que envía (nueva semántica 2026-10-22; '' = fila legacy sin dato). */
  empresaOrigen: string
  /** Proveedor (LEGADO: empresa que envía; nuevo: film del 1er artículo —
   *  se mantiene por compatibilidad de tipos; la UI muestra empresaOrigen). */
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
 * Identidad de la guía (M-2):
 *   · CON guia_id → `G:<uuid>`: identidad EXACTA de la recepción. Dos
 *     guías que compartan Nº de documento (re-registro, OCR, número
 *     reutilizado en otra fecha) quedan SEPARADAS — ni la lista, ni la
 *     impresión, ni el estado/borrado cruzan contenido entre ellas
 *     (corrección: "al imprimir solo salga lo de la guía").
 *   · Respaldo heredado (fila sin guia_id): con Nº → tipo+número;
 *     sin Nº → fecha+tipo+proveedor.
 */
export function claveGuiaDe(f: {
  guiaId?: string | null
  tipoDocumento: string
  numeroDocumento: string
  fecha: string
  proveedor: string
}): string {
  const gid = (f.guiaId ?? '').trim()
  if (gid) return `G:${gid}`
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
          guiaId: f.guiaId ?? null,
          tipoDocumento: f.tipoDocumento,
          numeroDocumento: f.numeroDocumento,
          fecha: f.fecha,
          proveedor: f.proveedor,
        },
        fecha: f.fecha,
        tipoDocumento: f.tipoDocumento,
        numeroDocumento: f.numeroDocumento,
        empresaOrigen: f.empresaOrigen,
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
    if (!g.empresaOrigen && f.empresaOrigen) g.empresaOrigen = f.empresaOrigen
  }
  return orden.map((c) => porClave.get(c) as GuiaAgrupada)
}

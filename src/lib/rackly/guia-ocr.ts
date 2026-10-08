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
  /** Cantidad de respaldo cuando el OCR no asoció ninguna a un código. */
  cantidadSugerida: string
}

// ═══════════════════════════════════════════════════════════════════
// PARSER
// ═══════════════════════════════════════════════════════════════════

/** Nº de guía: T seguido de 3 dígitos, guion, 5-8 dígitos (tolera espacios OCR). */
const RE_GUIA = /\bT\s?\d{3}\s?-\s?\d{5,8}\b/

/**
 * Serie sin T visible: el OCR confunde la T inicial con 7/1 y puede
 * pegarla al número (T173 → "7173", T005 → "7005" o perderla: "005").
 */
const RE_GUIA_SIN_T = /\b\d{3,4}\s?-\s?\d{5,8}\b/

/** Cantidad con separador de miles y/o decimales: 2,884 · 9,400.00 · 340.340
 *  Con fronteras de palabra para no picar "BT48.3H" como 48.3. */
const RE_CANTIDAD = /\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,3})?\b|\b\d+[.,]\d{1,3}\b/

/** Unidades de medida habituales en las guías. */
const UNIDADES = new Set([
  'KGM', 'KG', 'KGS', 'MILL', 'MIL', 'UND', 'UNIDAD', 'UNIDADES', 'UN',
  'CJA', 'CAJA', 'Cajas', 'BOL', 'BOLSA', 'GL', 'GALON', 'LTR', 'LT',
  'MTR', 'MT', 'PAR', 'JGO', 'SET', 'PQT', 'TON',
])

/** Regex de unidades dentro de una línea (para detectar filas de la tabla). */
const RE_UNIDAD_LINEA = new RegExp(
  '\\b(' + [...UNIDADES].map((u) => u.toUpperCase()).sort((a, b) => b.length - a.length).join('|') + ')\\b'
)

/** Etiquetas de cabecera que NO son descripción de artículo. */
const RE_ETIQUETA = /^(?:GUIA|REMISION|REMITENTE|ELECTRONICA|NUMERO|FECHA|EMISION|PLACA|TRACTO|CARRETA|LICENCIA|CONDUCTOR|TRANSPORTISTA|RUC|DNI|DESTINATARIO|PUNTO|PARTIDA|LLEGADA|DIRECCION|MOTRIZ|SERIE|AUTORIZ|CODIGO|DESCRIPCION|CANTIDAD|UNIDAD|OBSERVACION|BIENES|TRANSPORTADOS|MARCA|LIC)$/i

function limpiarLineas(texto: string): string[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.replace(/[|]+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((l) => l.length > 0)
}

function extraerPlaca(lineas: string[]): string {
  // Acepta la etiqueta con o sin paréntesis: "PLACA (TRACTO): X" / "PLACA TRACTO: X".
  const reEtiqueta = /PLACA[S]?\s*\(?\s*(?:TRACTO|TRACTOR|CARRETA|REMOLQUE)?\s*\)?\s*(?:N[º°.]?)?\s*:?\s*(.+)$/i
  // Palabras de etiqueta que el OCR puede confundir con la placa.
  const RE_NO_PLACA = /^(?:TRACTO|TRACTOR|CARRETA|REMOLQUE|REMOLCADOR|PLACA|LICENCIA|CODIGO)$/i
  for (const linea of lineas) {
    const m = linea.match(reEtiqueta)
    if (!m) continue
    // Token con formato de placa peruana: 3-4 alfanuméricos + guion/espacio opcional + 3 alfanuméricos.
    // Se preserva el token ORIGINAL (sin inventar guiones): el OCR confunde 8↔B etc. y el
    // usuario corrige en el formulario de confirmación.
    const mp = m[1].match(/\b([A-Z0-9]{2,4})[-\s]?([A-Z0-9]{3})\b/i)
    if (mp) {
      // Preserva el separador original del OCR (A10-927 queda igual;
      // D9SB18 o D9SA18 se mantienen tal cual para corrección manual).
      const bruto = mp[0].replace(/\s+/g, '').toUpperCase()
      // Descarta palabras de etiqueta y números de documento largos (RUC, DNI, licencias)
      if (RE_NO_PLACA.test(bruto)) continue
      if (/^\d{6,}$/.test(bruto.replace('-', ''))) continue
      // Guion solo si el formato clásico llegó sin él (AAA000 / 000AAA)
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
  // Prioridad: RAZÓN SOCIAL / PROVEEDOR (el emisor = proveedor real). La
  // etiqueta SEÑORES es el DESTINATARIO en el formato estándar de guías
  // (p. ej. el propio cliente), así que solo se usa de respaldo.
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
  return ''
}

/** Corrige la T perdida por el OCR en el número de guía (7173→T173, 005→T005). */
function normalizarSerieGuia(candidato: string, textoUpper: string): string {
  const limpio = candidato.replace(/\s+/g, '')
  if (/^T\d{3}-\d{5,8}$/.test(limpio)) return limpio
  // Sin T: solo si el documento es claramente una guía de remisión.
  if (!/GU[IÍ]A/.test(textoUpper)) return limpio
  const m = limpio.match(/^(\d{3,4})-(\d{5,8})$/)
  if (m) {
    // "7173" = T malleyada como 7 pegada a la serie 173.
    if (m[1].length === 4 && m[1][0] === '7') return `T${m[1].slice(1)}-${m[2]}`
    // "005" = la T se perdió completa.
    if (m[1].length === 3) return `T${m[1]}-${m[2]}`
  }
  return limpio
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

/** Tope de artículos reconocidos por guía (el usuario pidió soportar 20+). */
const MAX_ITEMS = 30

/**
 * true si a y b difieren en EXACTAMENTE 1 sustitución de un carácter
 * (misma longitud, 1 desigualdad). Para códigos numéricos mal leídos.
 */
function levenshtein1(a: string, b: string): boolean {
  if (a === b) return false // idéntico ya lo cubre la estrategia 1
  if (a.length !== b.length) return false
  let dif = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && ++dif > 1) return false
  }
  return dif === 1
}

/**
 * ¿Lo que sigue al código en su línea parece una FILA DE TABLA de ítems?
 *
 * Es el filtro anti-falsos-positivos del OCR estricto. Una ocurrencia de un
 * código del catálogo solo se acepta como artículo si su contexto es de fila:
 *   · código solo en su línea                                        → sí
 *   · seguido de una DESCRIPCIÓN (≥3 letras que no sean unidad)      → sí
 *   · seguido de número + unidad en la línea ("5653 2.884 KGM")      → sí
 *   · "118.00 KGM" (cantidad que choca con un código)                → NO
 *   · fragmento de documento "T005-0034403", fechas "05/10/26"       → NO
 */
function pareceFilaDeItem(resto: string): boolean {
  if (!resto) return true // código solo en su línea
  const ch = resto[0]
  if (/[.,]/.test(ch)) return false // "118.00" → es un número decimal, no un código
  const limpio = resto.replace(/^[\s:]+/, '')
  if (!limpio) return true
  if (/[0-9]/.test(limpio[0])) {
    // Código seguido de número: fila válida solo si la línea trae unidad
    return RE_UNIDAD_LINEA.test(limpio)
  }
  const letras = limpio.match(/[A-ZÑÁÉÍÓÚÜ]{3,}/)
  if (letras && !UNIDADES.has(letras[0]) && !RE_ETIQUETA.test(letras[0])) return true
  // Solo unidades tras el código: exigir también un número ("5653 KGM 2.884")
  return /\d/.test(limpio) && RE_UNIDAD_LINEA.test(limpio)
}

/** Contexto de una ocurrencia de código dentro del texto (para el filtro). */
function contextoDePos(texto: string, inicio: number, largo: number): { linea: string; resto: string; antes: string } {
  const iniLinea = texto.lastIndexOf('\n', inicio) + 1
  const finLineaRaw = texto.indexOf('\n', inicio)
  const linea = texto.slice(iniLinea, finLineaRaw === -1 ? undefined : finLineaRaw)
  const offset = inicio - iniLinea
  return {
    linea,
    resto: linea.slice(offset + largo),
    antes: offset > 0 ? linea[offset - 1] : '',
  }
}

function extraerItems(texto: string, catalogo: CatalogoItem[]): ItemGuia[] {
  if (catalogo.length === 0) return []
  const textoUp = texto.toUpperCase()
  const porCodigo = new Map<string, CatalogoItem>()
  const porEsqueleto = new Map<string, CatalogoItem>()
  for (const item of catalogo) {
    const codigo = item.codigo.trim().toUpperCase()
    porCodigo.set(codigo, item)
    // Solo códigos alfanuméricos largos entran al índice de esqueletos
    // (evita falsos positivos entre códigos numéricos cortos).
    if (codigo.length >= 5 && /[A-Z]/.test(codigo) && esqueleto(codigo).length >= 3) {
      const sk = esqueleto(codigo)
      if (!porEsqueleto.has(sk)) porEsqueleto.set(sk, item)
    }
  }

  const encontrados: { pos: number; codigo: string; linea: string; cat?: CatalogoItem }[] = []
  const yaVisto = new Set<string>()

  function aceptar(pos: number, item: CatalogoItem, linea: string) {
    const codigo = item.codigo.trim().toUpperCase()
    if (yaVisto.has(codigo)) return
    yaVisto.add(codigo)
    encontrados.push({ pos, codigo, linea, cat: item })
  }

  // 1) OCR ESTRICTO: cada código del catálogo se busca en el texto y se
  //    acepta SOLO si su contexto es una fila de la tabla de ítems
  //    (pareceFilaDeItem). Antes se aceptaba CUALQUIER ocurrencia y las
  //    cantidades ("118.00") o trozos de documentos creaban artículos falsos.
  for (const item of catalogo) {
    const codigo = item.codigo.trim().toUpperCase()
    if (codigo.length < 3) continue
    const re = new RegExp('(^|[^0-9A-Z])(' + codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')($|[^0-9A-Z])', 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(textoUp)) !== null) {
      const pos = m.index + m[1].length
      const { linea, resto, antes } = contextoDePos(textoUp, pos, codigo.length)
      // Parte de un documento compuesto (T005-0034403) o fecha (05/10/26)
      if (antes === '-' || antes === '/') continue
      if (!pareceFilaDeItem(resto)) continue
      aceptar(pos, item, linea)
      break
    }
  }

  // 2) Fallback: tokens alfanuméricos largos comparados por esqueleto (0/O/D/Q).
  //    Mismo filtro estricto de contexto que la estrategia 1.
  if (encontrados.length === 0) {
    const reTok = /\b[A-Z0-9][A-Z0-9-]{2,15}\b/g
    let t: RegExpExecArray | null
    while ((t = reTok.exec(textoUp)) !== null) {
      const token = t[0]
      if (!/\d/.test(token)) continue
      if (/^\d{1,3}([.,]\d{3})+$/.test(token)) continue // cantidades
      const hit =
        porCodigo.get(token) ??
        (token.length >= 5 && esqueleto(token).length >= 3
          ? porEsqueleto.get(esqueleto(token))
          : undefined)
      if (hit) {
        const { linea, resto, antes } = contextoDePos(textoUp, t.index, token.length)
        if (antes === '-' || antes === '/') continue
        if (pareceFilaDeItem(resto)) {
          aceptar(t.index, hit, linea)
        }
      }
      if (encontrados.length >= MAX_ITEMS) break
    }
  }

  // 3) Rescate fuzzy: si NADA coincidió (p. ej. tabla larga con letra pequeña
  //    donde el OCR malla 1 dígito por código), se busca cada token numérico
  //    contra el catálogo aceptando 1 sustitución, SOLO si el match es único.
  //    Todo queda editable en la confirmación, así que un falso positivo es
  //    visible y borrable; el beneficio (rescatar los códigos) lo compensa.
  if (encontrados.length === 0 && porCodigo.size > 0) {
    const reNum = /\b\d{3,8}\b/g
    let t: RegExpExecArray | null
    while ((t = reNum.exec(textoUp)) !== null) {
      const token = t[0]
      // Excluye fragmentos de números con separadores ("200" de "1,200.00",
      // "123"/"0000777" de "T123-0000777", "05" de fechas): el token debe
      // estar rodeado de algo que no sea dígito/separador de documento.
      const antes = t.index > 0 ? textoUp[t.index - 1] : ' '
      const despues = t.index + token.length < textoUp.length ? textoUp[t.index + token.length] : ' '
      if (/[0-9.,/-]/.test(antes) || /[0-9.,/-]/.test(despues)) continue
      if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(token)) continue // fechas
      const linea = lineaDePos(textoUp, t.index)
      // Solo tokens que parecen códigos de tabla: su línea debe tener
      // letras (descripción) o más de un número separado (cant./unidad).
      const conTexto = /[A-ZÑ]{3,}/.test(linea)
      if (!conTexto) continue
      let hit: CatalogoItem | undefined
      let duplicado = false
      for (const item of catalogo) {
        const codigo = item.codigo.trim().toUpperCase()
        if (Math.abs(codigo.length - token.length) > 1) continue
        if (levenshtein1(token, codigo)) {
          if (hit) { duplicado = true; break }
          hit = item
        }
      }
      if (hit && !duplicado) {
        encontrados.push({
          pos: t.index,
          codigo: hit.codigo.trim().toUpperCase(),
          linea,
          cat: hit,
        })
      }
      if (encontrados.length >= MAX_ITEMS) break
    }
  }
  encontrados.sort((a, b) => a.pos - b.pos)

  return encontrados.map(({ codigo, linea, cat }) => {
    return {
      codigo,
      descripcion: cat?.descripcion ?? '',
      cantidad: cantidadDeLinea(linea, codigo),
      unidad: unidadDeLineaOCatalogo(linea, cat),
      enCatalogo: Boolean(cat),
    }
  })
}

/**
 * CANTIDAD estricta: el número válido más CERCANO (por la izquierda) a la
 * unidad de medida de la línea ("… 2.884 KGM" → 2.884). Antes se tomaba el
 * PRIMER número y descripciones tipo "LÁMINA 2.0 MM … 450.5 KGM" metían 2.0.
 * Sin unidad en la línea: primer número válido (comportamiento previo).
 */
function cantidadDeLinea(linea: string, codigo: string): string {
  const esValida = (tok: string): boolean => {
    if (mismaClave(tok.replace(/[.,]/g, ''), codigo)) return false
    // Descarta fechas (02.10.26 / 05/10) y series largas de caja
    if (/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(tok)) return false
    if (tok.replace(/[.,]/g, '').length >= 9) return false
    return true
  }
  const numerosDe = (trozo: string): string[] => {
    const out: string[] = []
    const re = new RegExp(RE_CANTIDAD.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(trozo)) !== null) out.push(m[0])
    return out
  }

  const mu = RE_UNIDAD_LINEA.exec(linea)
  if (mu && mu.index > 0) {
    const previos = numerosDe(linea.slice(0, mu.index)).filter(esValida)
    if (previos.length > 0) return previos[previos.length - 1]
  }
  const todos = numerosDe(linea).filter(esValida)
  return todos.length > 0 ? todos[0] : ''
}

/** Unidad: token de unidad en la línea; si no, la del catálogo. */
function unidadDeLineaOCatalogo(linea: string, cat?: CatalogoItem): string {
  if (cat?.un) return cat.un
  for (const tok of linea.split(/\s+/)) {
    const t = tok.replace(/[^A-ZÑ]/g, '')
    if (t.length >= 2 && UNIDADES.has(t)) return t
  }
  return ''
}

/** Devuelve la línea completa que contiene la posición dada. */
function lineaDePos(texto: string, pos: number): string {
  const ini = texto.lastIndexOf('\n', pos) + 1
  const fin = texto.indexOf('\n', pos)
  return texto.slice(ini, fin === -1 ? undefined : fin)
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

/**
 * Cantidad de respaldo cuando ningún código coincidió con el catálogo:
 * la tabla de ítems va SIEMPRE después de la sección transportista,
 * así no se confunde con pesos/sumarios del encabezado.
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
 * Punto de entrada: texto OCR → datos estructurados de la guía.
 * `catalogo` debe venir cargado (fetchCatalogo) para reconocer códigos.
 */
export function extraerDatosGuia(textoOcr: string, catalogo: CatalogoItem[]): DatosGuia {
  const lineas = limpiarLineas(textoOcr)
  const texto = lineas.join('\n')
  const textoUp = texto.toUpperCase()

  // Nº de guía: preferir la forma T###-######; si el OCR perdió la T
  // (la malleyó como 7), rescatarla de la forma sin T.
  const conT = textoOcr.match(RE_GUIA)
  const sinT = conT ? null : textoOcr.match(RE_GUIA_SIN_T)
  const crudo = conT ? conT[0] : sinT ? sinT[0] : ''

  const items = extraerItems(texto, catalogo)
  const cantidadSugerida =
    (items.length > 0 && items[0].cantidad) || extraerCantidadFallback(lineas)
  return {
    numeroGuia: crudo ? normalizarSerieGuia(crudo, textoUp) : '',
    placa: extraerPlaca(lineas),
    proveedor: extraerProveedor(lineas),
    items,
    cantidadSugerida,
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

/**
 * PREPROCESADO para el OCR: escala a `maxLado`, pasa a GRIS y aplica
 * realce de contraste pixel a pixel. Las fotos a guías impresas traen
 * sombras/reflejos; a tesseract le cuesta con el papel grisáceo y esto
 * mejora notablemente la lectura de los dígitos de la tabla de códigos.
 * (Se hace a mano por pixel y no con ctx.filter para soportar todos los
 * navegadores, incluidos los que ignoran canvas filter.)
 */
export async function mejorarImagenOCR(archivo: File | Blob, maxLado = 2800): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(archivo)
    const escala = Math.min(1, maxLado / Math.max(bitmap.width, bitmap.height))
    const ancho = Math.round(bitmap.width * escala)
    const alto = Math.round(bitmap.height * escala)
    const canvas = document.createElement('canvas')
    canvas.width = ancho
    canvas.height = alto
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      bitmap.close?.()
      return archivo
    }
    ctx.drawImage(bitmap, 0, 0, ancho, alto)
    bitmap.close?.()

    const img = ctx.getImageData(0, 0, ancho, alto)
    const d = img.data
    const CONTRASTE = 1.45
    for (let i = 0; i < d.length; i += 4) {
      // Luminancia + contraste centrado en 128 (papel → casi blanco, tinta → casi negro)
      const gris = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      const v = Math.max(0, Math.min(255, Math.round((gris - 128) * CONTRASTE + 128)))
      d[i] = v
      d[i + 1] = v
      d[i + 2] = v
    }
    ctx.putImageData(img, 0, 0)

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

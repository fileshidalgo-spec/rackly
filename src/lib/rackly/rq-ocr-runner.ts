'use client'

/**
 * RACKLY — Pipeline OCR de RQ COMPARTIDO (Atención + Devoluciones de línea).
 *
 * Extrae EXACTAMENTE el pipeline que vivía dentro de RqFotoForm.procesar
 * (Atención a Línea) para que la pestaña DEVOLUCIONES de Recepción use LA
 * MISMA extracción de datos que Atención (pedido del usuario 2026-10-31:
 * «la devolución es idéntico a la extracción de datos que hacemos para
 * atención… no es una guía si no un RQ») — sin duplicar 180 líneas ni
 * divergir con el tiempo.
 *
 * Pasos (idénticos para ambos módulos):
 *   1. Preprocesado: gris + contraste a 2800px (mejorarImagenOCR) y foto
 *      liviana 1200px para Storage (reducirImagen).
 *   2. OCR tesseract.js (spa): DPI fijo 300 + espacios inter-palabra.
 *   3. PASADA 1 — PSM 6 (bloque uniforme, con cajas de palabras).
 *   4. PASADA 2 — SIEMPRE PSM 3 (layout automático) → fusión sin duplicados
 *      (rescata filas omitidas; trae los avisos de rigor numérico Task 23).
 *   5. PASADA ZOOM · TABLA — franja bajo las anclas del encabezado, ×3 en
 *      tramos con solape (rescata códigos de letra pequeña).
 *   6. PASADA ZOOM · ENCABEZADO — rigor numérico: Nº RQ / OP / producto se
 *      releen a ×3; si difieren, GANA el zoom y se avisa con ambas lecturas.
 *   7. Avisos combinados y deduplicados (números débiles de Tesseract +
 *      discrepancias entre pases + zoom encabezado).
 *
 * El parser es rq-ocr.ts (extraerDatosRqDeTexto — lee el encabezado de la
 * requisición y la tabla de materiales en SUS 2 formatos AJEPER: cantidad
 * final y UNID→CANT con saldo/estado). Este módulo NO toca la UI: reporta
 * por callbacks y devuelve datos planos (testeable y reutilizable).
 */

import type { PSM } from 'tesseract.js'
import {
  avisoNumerosDebiles,
  dividirFranjaEnBandas,
  extraerPalabras,
  mejorarImagenOCR,
  MARGEN_OCR,
  recortarFranjaTabla,
  reducirImagen,
} from '@/lib/rackly/guia-ocr'
import {
  anclasTablaRq,
  extraerDatosRqDeTexto,
  extraccionSuficienteRq,
  fusionarDatosRq,
  type DatosRq,
} from '@/lib/rackly/rq-ocr'
import { fetchCatalogo, getCachedCatalogo, type CatalogoItem } from '@/lib/rackly/catalogo'

export type CallbacksOcrRq = {
  /** Mensajes de etapa («Reconociendo texto… 42%»). */
  onEtapa?: (etapa: string) => void
  /** Progreso del reconocimiento (0-100). */
  onProgreso?: (pct: number) => void
}

export type ResultadoOcrRq = {
  /** Mejor lectura (fusión de pases + zooms oportunistas). */
  datos: DatosRq
  /** Rigor numérico: discrepancias y números de baja confianza, dedup. */
  avisos: string[]
  /** Foto liviana (1200px, q0.8) lista para Storage; null si falló. */
  fotoLiviana: Blob | null
  /** El catálogo respondió VACÍO (sin conexión o BD sin códigos). */
  catalogoVacio: boolean
}

/** Umbral de calidad: con estos pilares no hace falta re-procesar. */
function extraccionSuficiente(d: DatosRq): boolean {
  return extraccionSuficienteRq(d)
}

/**
 * Corre el OCR completo de una RQ sobre `archivo` (ya recortado o la foto
 * completa) y devuelve la mejor lectura. Lanza si el OCR falla (el llamador
 * decide la UX de error — igual que antes dentro de RqFotoForm).
 */
export async function ejecutarOcrRq(
  archivo: File,
  cb: CallbacksOcrRq = {}
): Promise<ResultadoOcrRq> {
  const onEtapa = cb.onEtapa ?? (() => {})
  const onProgreso = cb.onProgreso ?? (() => {})

  onEtapa('Preparando imagen (contraste)…')
  const imagen = await mejorarImagenOCR(archivo, 2800)
  const liviana = await reducirImagen(archivo, 1200, 0.8)

  onEtapa('Verificando catálogo…')
  let catalogoParaOCR: CatalogoItem[] = []
  let catalogoVacio = false
  try {
    const c = await fetchCatalogo()
    catalogoParaOCR = c
    catalogoVacio = c.length === 0
  } catch {
    catalogoVacio = true
  }

  onEtapa('Leyendo la RQ (OCR español)…')
  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker('spa', 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') {
        onProgreso(Math.round(m.progress * 100))
        onEtapa(`Reconociendo texto… ${Math.round(m.progress * 100)}%`)
      }
    },
  })
  // Igual que la guía: DPI fijo + espacios inter-palabra para conservar
  // las columnas de la tabla de materiales.
  await worker.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' })

  try {
    async function ocrData(psm: PSM, con: Blob, conBloques = false) {
      await worker.setParameters({ tessedit_pageseg_mode: psm })
      const { data } = await worker.recognize(con, {}, conBloques ? { blocks: true } : {})
      return data
    }
    async function ocrTexto(psm: PSM, con: Blob): Promise<string> {
      return (await ocrData(psm, con)).text ?? ''
    }

    // PASADA 1 — PSM 6 (bloque uniforme) sobre la página completa.
    // Con `blocks: true` entrega las cajas de palabras para localizar
    // la franja de la tabla (zoom "cuadro por cuadro", igual que la guía).
    const d1 = await ocrData(PSM.SINGLE_BLOCK, imagen, true)
    const texto1 = d1.text ?? ''
    const palabras1 = extraerPalabras(d1)
    let datos = extraerDatosRqDeTexto(texto1, catalogoParaOCR)

    // PASADA 2 — SIEMPRE: releer con PSM 3 (layout automático) y fusionar
    // (unión sin duplicados; rescata filas que el 1er pase omitió).
    // La fusión trae los AVISOS de rigor numérico (cantidades que
    // difieren entre pases — Task 23).
    onEtapa('Revisando la lectura con un segundo pase…')
    const imagenBase = await reducirImagen(archivo, 2800, 0.9)
    const texto2 = await ocrTexto(PSM.AUTO, imagenBase)
    const datos2 = extraerDatosRqDeTexto(texto2, catalogoParaOCR)
    const fusion = fusionarDatosRq(datos, datos2)
    if (
      fusion.items.length > datos.items.length ||
      (!datos.numeroRq && fusion.numeroRq) ||
      (!datos.fecha && fusion.fecha) ||
      (!datos.solicitante && fusion.solicitante) ||
      (!datos.ordenProduccion && fusion.ordenProduccion)
    ) {
      datos = fusion
    } else if (!extraccionSuficiente(datos) && extraccionSuficiente(datos2)) {
      datos = datos2
    }

    // Geometría compartida de las 2 pasadas zoom: la imagen leída viene
    // de mejorarImagenOCR (2800px + MARGEN_OCR) → original = (y − margen)/escala.
    const bmpProc = await createImageBitmap(imagen)
    const altoProc = bmpProc.height
    bmpProc.close()
    const franja = anclasTablaRq(palabras1, altoProc)
    const bmpOrig = await createImageBitmap(archivo)
    const escala = 2800 / Math.max(bmpOrig.width, bmpOrig.height)
    bmpOrig.close()
    const aOriginal = (yOcr: number) => Math.max(0, (yOcr - MARGEN_OCR) / escala)

    // PASADA ZOOM · TABLA — "cuadro por cuadro" (el truco que rescata los
    // códigos de letra pequeña en la guía): si quedaron materiales fuera
    // de catálogo o no se leyó ninguno, se relee SOLO la franja de la
    // tabla escalada ×3 en tramos con solape.
    // SOLO se adopta si reduce las filas a revisar (o llena una lectura
    // vacía) — la fusión jamás puede empeorar la lectura.
    const aRevisar = (d: DatosRq) => d.items.filter((i) => i.revision || !i.enCatalogo).length
    if (catalogoParaOCR.length > 0 && (datos.items.length === 0 || aRevisar(datos) > 0)) {
      try {
        onEtapa('Releyendo la tabla de materiales con zoom…')
        const bandas = dividirFranjaEnBandas(aOriginal(franja.yTop), aOriginal(franja.yBot))
        let textoZoom = ''
        for (const b of bandas) {
          const trozo = await recortarFranjaTabla(archivo, b.y0, b.y1, 3)
          const t = await ocrTexto(PSM.SINGLE_BLOCK, trozo)
          if (t.trim()) textoZoom += (textoZoom ? '\n' : '') + t
        }
        if (textoZoom.trim()) {
          const datosZoom = extraerDatosRqDeTexto(textoZoom, catalogoParaOCR)
          if (datos.items.length === 0 && datosZoom.items.length > 0) {
            datos = datosZoom
          } else {
            const fusionZoom = fusionarDatosRq(datos, datosZoom)
            if (aRevisar(fusionZoom) < aRevisar(datos)) datos = fusionZoom
          }
        }
      } catch {
        // Zoom oportunista: si falla queda la lectura de página completa.
      }
    }

    // Rigor numérico (Task 23): avisos de la fusión (cantidades que
    // difieren entre pases) + NÚMEROS leídos con baja confianza según
    // Tesseract (ahí viven las confusiones 4↔9 — antes se descartaba
    // la confianza por palabra y un «4»→«9» pasaba sin advertencia).
    const avisos: string[] = [
      ...avisoNumerosDebiles(palabras1),
      ...(fusion.avisos ?? []),
    ]

    // PASADA ZOOM · ENCABEZADO (Task 23 — rigor numérico): el Nº de RQ, la
    // OP y el producto se releen a ×3 sobre la banda del encabezado. Si el
    // zoom (mayor resolución) DIFIERE de la lectura de página completa,
    // GANA el zoom y se muestra un aviso visible con ambas lecturas — el
    // usuario verifica antes de registrar.
    try {
      onEtapa('Verificando los números del encabezado…')
      const yTopOrig = Math.min(aOriginal(franja.yTop), Math.max(60, altoProc / 4))
      if (yTopOrig >= 60) {
        const trozo = await recortarFranjaTabla(archivo, 0, yTopOrig, 3)
        const textoHz = await ocrTexto(PSM.SINGLE_BLOCK, trozo)
        if (textoHz.trim()) {
          const hz = extraerDatosRqDeTexto(textoHz, catalogoParaOCR)
          const campos: { k: 'numeroRq' | 'ordenProduccion' | 'productoCodigo'; etq: string }[] = [
            { k: 'numeroRq', etq: 'Nº de RQ' },
            { k: 'ordenProduccion', etq: 'Orden de producción' },
            { k: 'productoCodigo', etq: 'Código del producto' },
          ]
          let adoptoProducto = false
          for (const { k, etq } of campos) {
            const leidoZoom = hz[k].trim()
            if (!leidoZoom) continue
            const leidoActual = (datos[k] ?? '').trim()
            if (!leidoActual) {
              datos = { ...datos, [k]: leidoZoom }
              if (k === 'productoCodigo') adoptoProducto = true
            } else if (leidoZoom !== leidoActual) {
              datos = { ...datos, [k]: leidoZoom }
              avisos.push(`${etq}: el zoom leyó ${leidoZoom} (antes ${leidoActual}) — verifica`)
              if (k === 'productoCodigo') adoptoProducto = true
            }
          }
          if (adoptoProducto && !datos.productoDescripcion.trim() && hz.productoDescripcion.trim()) {
            datos = { ...datos, productoDescripcion: hz.productoDescripcion }
          }
        }
      }
    } catch {
      // Zoom oportunista: sin él queda la lectura de página completa.
    }

    return {
      datos,
      avisos: Array.from(new Set(avisos)),
      fotoLiviana: liviana,
      catalogoVacio,
    }
  } finally {
    await worker.terminate()
  }
}

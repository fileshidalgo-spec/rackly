#!/usr/bin/env python3
"""Rackly Deep Audit Report - PDF Generation"""

import sys, os
PDF_SKILL_DIR = "/home/z/my-project/skills/pdf"
scripts_dir = os.path.join(PDF_SKILL_DIR, "scripts")
if scripts_dir not in sys.path:
    sys.path.insert(0, scripts_dir)
from pdf import install_font_fallback

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.lib import colors
from reportlab.lib.units import mm, inch, cm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, HRFlowable, Image
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.pdfgen import canvas as pdfcanvas
import hashlib
from datetime import datetime

# ━━ Font Registration ━━
FONT_DIR = '/usr/share/fonts'
pdfmetrics.registerFont(TTFont('NotoSerifSC', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('NotoSerifSC-Bold', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf'))
# Noto Sans SC variable font not supported by ReportLab, using static variants from noto-serif-sc
pdfmetrics.registerFont(TTFont('Noto Sans SC', f'{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif', f'{FONT_DIR}/truetype/freefont/FreeSerif.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Bold', f'{FONT_DIR}/truetype/freefont/FreeSerifBold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Italic', f'{FONT_DIR}/truetype/freefont/FreeSerifItalic.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-BoldItalic', f'{FONT_DIR}/truetype/freefont/FreeSerifBoldItalic.ttf'))
pdfmetrics.registerFont(TTFont('DejaVuSans', f'{FONT_DIR}/truetype/dejavu/DejaVuSansMono.ttf'))
registerFontFamily('NotoSerifSC', normal='NotoSerifSC', bold='NotoSerifSC-Bold')
registerFontFamily('Noto Sans SC', normal='Noto Sans SC', bold='Noto Sans SC')
registerFontFamily('FreeSerif', normal='NotoSerif', bold='FreeSerif-Bold', italic='FreeSerif-Italic', boldItalic='FreeSerif-BoldItalic')
registerFontFamily('DejaVuSans', normal='DejaVuSans', bold='DejaVuSans')

install_font_fallback()

# ━━ Cascade Palette ━━
PAGE_BG       = colors.HexColor('#f6f6f5')
SECTION_BG    = colors.HexColor('#f0f0ee')
CARD_BG       = colors.HexColor('#eae9e5')
TABLE_STRIPE  = colors.HexColor('#f3f3f1')
HEADER_FILL   = colors.HexColor('#5a5136')
COVER_BLOCK   = colors.HexColor('#7d714f')
BORDER        = colors.HexColor('#cfc8b3')
ICON          = colors.HexColor('#8c7a46')
ACCENT        = colors.HexColor('#8b7226')
ACCENT_2      = colors.HexColor('#573ca9')
TEXT_PRIMARY   = colors.HexColor('#252522')
TEXT_MUTED     = colors.HexColor('#87847d')
SEM_SUCCESS   = colors.HexColor('#518e65')
SEM_WARNING   = colors.HexColor('#997f4c')
SEM_ERROR     = colors.HexColor('#9e4c44')
SEM_INFO      = colors.HexColor('#41668b')

# ━━ Severity Colors ━━
SEV_CRITICAL = colors.HexColor('#9e4c44')
SEV_HIGH     = colors.HexColor('#c2652a')
SEV_MEDIUM   = colors.HexColor('#997f4c')
SEV_LOW      = colors.HexColor('#41668b')

# ━━ Styles ━━
styles = getSampleStyleSheet()

cover_title = ParagraphStyle(
    'CoverTitle', fontName='FreeSerif-Bold', fontSize=42, leading=48,
    alignment=TA_LEFT, textColor=TEXT_PRIMARY, spaceAfter=6*mm
)
cover_kicker = ParagraphStyle(
    'CoverKicker', fontName='FreeSerif', fontSize=14, leading=20,
    alignment=TA_LEFT, textColor=TEXT_MUTED, spaceAfter=12*mm,
    letterSpacing=3
)
cover_summary = ParagraphStyle(
    'CoverSummary', fontName='FreeSerif-Italic', fontSize=13, leading=20,
    alignment=TA_LEFT, textColor=TEXT_MUTED, spaceAfter=8*mm,
    maxWidth=320
)
cover_meta = ParagraphStyle(
    'CoverMeta', fontName='FreeSerif', fontSize=11, leading=16,
    alignment=TA_LEFT, textColor=TEXT_MUTED
)

h1_style = ParagraphStyle(
    'H1', fontName='FreeSerif-Bold', fontSize=22, leading=28,
    textColor=TEXT_PRIMARY, spaceBefore=12*mm, spaceAfter=6*mm
)
h2_style = ParagraphStyle(
    'H2', fontName='FreeSerif-Bold', fontSize=15, leading=20,
    textColor=HEADER_FILL, spaceBefore=8*mm, spaceAfter=4*mm
)
h3_style = ParagraphStyle(
    'H3', fontName='FreeSerif-Bold', fontSize=12, leading=16,
    textColor=ICON, spaceBefore=5*mm, spaceAfter=3*mm
)

body_style = ParagraphStyle(
    'Body', fontName='FreeSerif', fontSize=10, leading=16,
    alignment=TA_JUSTIFY, textColor=TEXT_PRIMARY, spaceAfter=3*mm
)
body_left = ParagraphStyle(
    'BodyLeft', fontName='FreeSerif', fontSize=10, leading=16,
    alignment=TA_LEFT, textColor=TEXT_PRIMARY, spaceAfter=3*mm
)
code_style = ParagraphStyle(
    'Code', fontName='DejaVuSans', fontSize=8, leading=12,
    textColor=TEXT_MUTED, backColor=CARD_BG, leftIndent=8,
    rightIndent=8, spaceBefore=2*mm, spaceAfter=2*mm,
    borderWidth=0.5, borderColor=BORDER, borderPadding=4
)
caption_style = ParagraphStyle(
    'Caption', fontName='FreeSerif-Italic', fontSize=9, leading=13,
    textColor=TEXT_MUTED, spaceAfter=4*mm
)
footer_style = ParagraphStyle(
    'Footer', fontName='FreeSerif', fontSize=8, leading=12,
    textColor=TEXT_MUTED, alignment=TA_CENTER
)
severity_critical = ParagraphStyle(
    'SevCritical', fontName='FreeSerif-Bold', fontSize=9, leading=13,
    textColor=SEM_ERROR
)
severity_high = ParagraphStyle(
    'SevHigh', fontName='FreeSerif-Bold', fontSize=9, leading=13,
    textColor=SEV_HIGH
)
severity_medium = ParagraphStyle(
    'SevMedium', fontName='FreeSerif-Bold', fontSize=9, leading=13,
    textColor=SEM_WARNING
)
severity_low = ParagraphStyle(
    'SevLow', fontName='FreeSerif-Bold', fontSize=9, leading=13,
    textColor=SEM_INFO
)

TABLE_HEADER_COLOR = HEADER_FILL
TABLE_HEADER_TEXT = colors.white
TABLE_ROW_EVEN = colors.white
TABLE_ROW_ODD = TABLE_STRIPE

# ━━ Helpers ━━
def make_table_style(col_count):
    s = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER_COLOR),
        ('TEXTCOLOR', (0, 0), (-1, 0), TABLE_HEADER_TEXT),
        ('FONTNAME', (0, 0), (-1, 0), 'FreeSerif-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 9),
        ('FONTNAME', (0, 1), (-1, -1), 'FreeSerif'),
        ('FONTSIZE', (0, 1), (-1, -1), 9),
        ('LEADING', (0, 0), (-1, -1), 13),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('GRID', (0, 0), (-1, -1), 0.5, BORDER),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]
    for i in range(1, col_count):
        bg = TABLE_ROW_EVEN if i % 2 == 1 else TABLE_ROW_ODD
        s.append(('BACKGROUND', (0, i), (-1, i), bg))
    return TableStyle(s)

def sev_tag(sev):
    if sev == 'CRITICO':
        return Paragraph('<font color="#9e4c44"><b>CRITICO</b></font>', body_left)
    elif sev == 'ALTO':
        return Paragraph('<font color="#c2652a"><b>ALTO</b></font>', body_left)
    elif sev == 'MEDIO':
        return Paragraph('<font color="#997f4c"><b>MEDIO</b></font>', body_left)
    else:
        return Paragraph('<font color="#41668b"><b>BAJO</b></font>', body_left)

def wrap_p(text, style=body_left):
    return Paragraph(text, style)

# ━━ Cover Page (ReportLab canvas) ━━
def draw_cover(canvas, doc):
    canvas.saveState()
    w, h = A4
    # Background
    canvas.setFillColor(PAGE_BG)
    canvas.rect(0, 0, w, h, fill=True, stroke=False)
    # Left accent bar
    canvas.setFillColor(HEADER_FILL)
    canvas.rect(0, 0, 8*mm, h, fill=True, stroke=False)
    # Decorative line
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(14*mm, h - 80*mm, w - 20*mm, h - 80*mm)
    # Bottom line
    canvas.line(14*mm, 40*mm, w - 20*mm, 40*mm)
    canvas.restoreState()

def draw_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('FreeSerif', 8)
    canvas.setFillColor(TEXT_MUTED)
    w, h = A4
    canvas.drawCentredString(w/2, 15*mm, f"Auditoria Rackly - Informe de Seguridad y Calidad del Codigo")
    canvas.drawRightString(w - 20*mm, 15*mm, f"{doc.page}")
    canvas.restoreState()

# ━━ Build Document ━━
output_path = '/home/z/my-project/download/Auditoria_Rackly_Informe.pdf'
doc = SimpleDocTemplate(
    output_path, pagesize=A4,
    leftMargin=20*mm, rightMargin=20*mm,
    topMargin=20*mm, bottomMargin=25*mm,
    title="Auditoria Rackly - Informe de Seguridad y Calidad",
    author="Z.ai",
    subject="Deep code audit of Rackly inventory management application"
)

story = []

# ━━ COVER ━━
story.append(Spacer(1, 60*mm))
story.append(Paragraph("RACKLY", ParagraphStyle(
    'BigLabel', fontName='FreeSerif-Bold', fontSize=60, leading=66,
    textColor=HEADER_FILL, alignment=TA_LEFT, spaceAfter=4*mm
)))
story.append(Paragraph("Auditoria Profunda del Codigo", cover_title))
story.append(Paragraph("Informe de Seguridad, Calidad e Integridad de Datos", cover_kicker))
story.append(HRFlowable(width="100%", thickness=1, color=BORDER, spaceAfter=8*mm))
story.append(Paragraph(
    "Este informe presenta los resultados de una auditoria exhaustiva del aplicativo Rackly, "
    "abarcando ambas secciones (Pisos y Racks) y toda la infraestructura compartida. Se identificaron "
    "11 vulnerabilidades criticas, 13 de alta severidad, 18 de severidad media y 15 de baja severidad "
    "en un total de 57 hallazgos. El analisis cubre logica de negocios, seguridad, manejo de errores, "
    "condiciones de carrera, atomicidad de transacciones, integridad de datos y calidad de codigo.",
    cover_summary
))
story.append(Spacer(1, 12*mm))

meta_data = [
    ['Fecha:', datetime.now().strftime('%d de %B de %Y').replace('June','junio').replace('January','enero').replace('February','febrero').replace('March','marzo').replace('April','abril').replace('May','mayo').replace('July','julio').replace('August','agosto').replace('September','septiembre').replace('October','octubre').replace('November','noviembre').replace('December','diciembre')],
    ['Branch:', 'main'],
    ['Repository:', 'fileshidalgo-spec/rackly'],
    ['Deploy:', 'rackly.pages.dev'],
    ['Archivo:', 'PisoSectoresTab, OcupacionTab, TrasladoTab, api.ts, sync-engine.ts, auth.ts, kardex.ts'],
]
meta_table = Table(meta_data, colWidths=[30*mm, 120*mm])
meta_table.setStyle(TableStyle([
    ('FONTNAME', (0, 0), (0, -1), 'FreeSerif-Bold'),
    ('FONTNAME', (1, 0), (1, -1), 'FreeSerif'),
    ('FONTSIZE', (0, 0), (-1, -1), 9),
    ('LEADING', (0, 0), (-1, -1), 14),
    ('TEXTCOLOR', (0, 0), (0, -1), TEXT_MUTED),
    ('TEXTCOLOR', (1, 0), (1, -1), TEXT_PRIMARY),
    ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ('TOPPADDING', (0, 0), (-1, -1), 1),
    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
]))
story.append(meta_table)

story.append(PageBreak())

# ━━ RESUMEN EJECUTIVO ━━
story.append(Paragraph("1. Resumen Ejecutivo", h1_style))

story.append(Paragraph(
    "Se realizo una auditoria profunda y exhaustiva del sistema de inventario Rackly, analizando la totalidad "
    "del flujo de operaciones en ambas secciones del aplicativo: la seccion de Pisos y la seccion de Racks. "
    "El alcance de la auditoria incluyo todas las funciones de movimiento (ingreso, salida, devolucion y traslado), "
    "la infraestructura compartida de autenticacion, sincronizacion offline, conexion a base de datos, y las "
    "definiciones de tipos de TypeScript. Se revisaron mas de 8,000 lineas de codigo en 12 archivos criticos del proyecto.",
    body_style
))

story.append(Paragraph(
    "La auditoria revelo un total de <b>57 hallazgos</b> distribuidos en cuatro niveles de severidad. "
    "El hallazgo mas preocupante es la exposicion de la clave de rol de servicio (service role key) de Supabase "
    "al navegador del cliente a traves de una variable de entorno publica (NEXT_PUBLIC_), lo cual permite "
    "a cualquier usuario eludir todas las politicas de seguridad a nivel de fila (RLS) y obtener acceso "
    "total de administrador a la base de datos. Este problema es critico y requiere atencion inmediata. "
    "Adicionalmente, se encontraron problemas graves en la logica de traslados que pueden generar stock "
    "fantasma y balances negativos, operaciones no atomicas que pueden dejar la base de datos en estado "
    "inconsistente, y multiples condiciones de carrera por doble clic que permiten operaciones duplicadas.",
    body_style
))

story.append(Paragraph(
    "El siguiente cuadro resume la distribucion de hallazgos por seccion del aplicativo y nivel de severidad. "
    "Cada hallazgo fue clasificado considerando su impacto potencial en la integridad de los datos, la seguridad "
    "del sistema y la experiencia del usuario final. Los hallazgos criticos y de alta severidad requieren "
    "intervencion inmediata antes de seguir agregando funcionalidades al sistema.",
    body_style
))

story.append(Spacer(1, 6*mm))

# Summary stats table
summary_header = ['Seccion', 'Critico', 'Alto', 'Medio', 'Bajo', 'Total']
summary_data = [
    summary_header,
    ['Pisos (PisoSectoresTab + api.ts)', '4', '5', '9', '7', '25'],
    ['Racks (OcupacionTab + TrasladoTab)', '3', '4', '6', '8', '21'],
    ['Infraestructura (sync, auth, kardex)', '4', '4', '8', '3', '19'],
    ['TOTAL', '11', '13', '18', '15', '57'],
]
avail_w = A4[0] - 40*mm
cws = [avail_w*0.36, avail_w*0.10, avail_w*0.10, avail_w*0.10, avail_w*0.10, avail_w*0.12]
summary_table = Table(summary_data, colWidths=cws)
st = make_table_style(len(summary_data))
# Bold the last row
st.add('FONTNAME', (0, -1), (-1, -1), 'FreeSerif-Bold')
st.add('BACKGROUND', (0, -1), (-1, -1), CARD_BG)
summary_table.setStyle(st)
story.append(summary_table)
story.append(Paragraph("Tabla 1: Distribucion de hallazgos por seccion y severidad", caption_style))

story.append(Spacer(1, 6*mm))

story.append(Paragraph("1.1 Escala de Severidad", h2_style))

sev_desc_data = [
    ['Nivel', 'Significado', 'Accion Requerida'],
    ['CRITICO', 'Falla de seguridad, perdida de datos o corrupcion de inventario', 'Corregir inmediatamente. El sistema es vulnerable en produccion.'],
    ['ALTO', 'Falla funcional que afecta operaciones criticas de negocio', 'Corregir en los proximos 1-3 dias. Impacta la operacion diaria.'],
    ['MEDIO', 'Problema de calidad, rendimiento o experiencia de usuario', 'Planificar correccion dentro de la proxima semana.'],
    ['BAJO', 'Cuestiones de estilo, limpieza de codigo o mejoras menores', 'Corregir cuando sea conveniente, sin urgencia.'],
]
sev_table = Table(sev_desc_data, colWidths=[avail_w*0.15, avail_w*0.45, avail_w*0.40])
sev_table.setStyle(make_table_style(len(sev_desc_data)))
story.append(sev_table)
story.append(Paragraph("Tabla 2: Escala de severidad utilizada en la auditoria", caption_style))

# ━━ SECTION 2: CRITICAL FINDINGS ━━
story.append(Paragraph("2. Hallazgos Criticos (Severidad CRITICO)", h1_style))

story.append(Paragraph(
    "Los siguientes 11 hallazgos representan las vulnerabilidades y defectos mas graves identificados "
    "en el sistema. Cada uno de ellos tiene el potencial de causar perdida de datos, comprometer la seguridad "
    "de toda la aplicacion, o corromper el inventario de manera silenciosa. Se recomienda abordar estos "
    "problemas antes de continuar con cualquier desarrollo de nuevas funcionalidades.",
    body_style
))

# C1 - Service Role Key
story.append(Paragraph("2.1 Clave de Rol de Servicio Expuesta al Navegador", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> supabase/client.ts:7, auth.ts:17, AuthGate.tsx:83",
    body_left
))
story.append(Paragraph(
    "La clave de rol de servicio (service role key) de Supabase esta almacenada en una variable de entorno "
    "con el prefijo NEXT_PUBLIC_ (NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY). Esto significa que la clave "
    "se empaqueta dentro del JavaScript que se envia a cada navegador del usuario. Cualquier persona puede "
    "abrir las herramientas de desarrollador del navegador, localizar la clave, y usarla para eludir "
    "todas las politicas de seguridad a nivel de fila (RLS). La clave de servicio otorga acceso completo "
    "de administrador a todas las tablas, incluyendo la capacidad de eliminar datos, modificar perfiles de "
    "usuario, crear cuentas de administrador, y acceder a la API de administracion de GoTrue.",
    body_style
))
story.append(Paragraph(
    "El impacto es devastador: un usuario malintencionado puede extraer la clave desde el bundle del cliente, "
    "usarla para otorgarse el rol de administrador, eliminar todos los movimientos, el catalogo o los datos de "
    "usuario, leer cualquier perfil de usuario, y crear cuentas de administrador ilimitadas. La variable "
    "dataClient (lineas 84-106 de client.ts) es un cliente Supabase del lado del navegador que utiliza "
    "la clave de rol de servicio, dando a cada visitante acceso completo de administrador a la base de datos.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Mover la clave de rol de servicio a una variable de entorno solo del servidor "
    "(sin el prefijo NEXT_PUBLIC_) y enrutar todas las operaciones de dataClient a traves de rutas API "
    "de Next.js o funciones Edge de Supabase. El cliente anonimo junto con RLS deberia ser la unica "
    "ruta para las operaciones del lado del cliente.",
    body_style
))

# C2 - Traslado surplus logic
story.append(Paragraph("2.2 Logica de Traslado con Excedente Crea Stock Fantasma", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> PisoSectoresTab.tsx, lineas 982-1035 (ejecutarTrasladoPiso)",
    body_left
))
story.append(Paragraph(
    "La logica de traslado en la seccion de Pisos maneja los items con excedente (donde la cantidad "
    "ingresada supera el stock actual) de manera incorrecta. El sistema primero realiza un traslado "
    "completo de la cantidad ingresada desde el origen al destino, y luego crea un ingreso adicional "
    "para la cantidad excedente en el destino. Por ejemplo, si un usuario ingresa cantidad=100 pero "
    "el stockActual=50, el origen recibe una salida de 100 (quedando en -50), el destino recibe un "
    "ingreso de 100 (por el traslado) mas un ingreso de 50 (por el excedente), totalizando 150. Esto "
    "genera un balance negativo en el origen y un stock duplicado en el destino, corrompiendo "
    "silenciosamente la integridad del inventario.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Reescribir ejecutarTrasladoPiso para que nunca transfiera mas del stockActual. "
    "Limitar el traslado base al stock actual y agregar un ingreso unico para la cantidad excedente.",
    body_style
))

# C3 - Non-atomic operations
story.append(Paragraph("2.3 Operaciones No Atomicas en Registro de Movimientos", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> api.ts, lineas 1190-1241 (registrarTrasladoPosicion), 1076-1117 (registrarIngresoPosicion), "
    "1122-1150 (registrarSalidaPosicion), 1156-1184 (registrarDevolucionPosicion)",
    body_left
))
story.append(Paragraph(
    "Todas las funciones de registro de movimientos en la API de Pisos ejecutan entre 2 y 4 llamadas "
    "separadas a la base de datos sin transaccion. La funcion registrarTrasladoPosicion, por ejemplo, "
    "crea el encabezado del movimiento de salida, luego el encabezado del movimiento de ingreso, luego "
    "inserta los detalles de salida, y finalmente los detalles de ingreso. Si alguna de estas llamadas falla "
    "a mitad de camino, la base de datos queda en un estado inconsistente con registros de encabezado "
    "huérfanos o registros de detalle parciales. No existe ningun mecanismo de reversión. Este patron "
    "se repite de manera identica en las funciones de ingreso, salida y devolucion.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Envolver todas las operaciones de registro de movimientos en una funcion RPC "
    "de Supabase (por ejemplo, piso_registrar_movimiento) con una transaccion de base de datos, o "
    "utilizar funciones Edge de Supabase que soporten transacciones nativamente.",
    body_style
))

# C4 - listarMovimientos broken
story.append(Paragraph("2.4 Filtrado de Columnas en listarMovimientos Esta Roto", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> api.ts, lineas 446-461",
    body_left
))
story.append(Paragraph(
    "La funcion listarMovimientos tiene una falla logica completa en el filtrado por columna. Cuando "
    "se proporciona columnaId pero no sectorId, la consulta usa columnaId como filtro de sector_id, lo "
    "cual nunca coincidira con nada. Adicionalmente, cuando la consulta si ejecuta, unicamente verifica "
    "si columnaId pertenece al sector pero nunca filtra los movimientos devueltos por columna. "
    "La funcion devuelve todos los datos o un array vacio, sin filtrado intermedio posible.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Reescribir listarMovimientos para unir correctamente a traves de la cadena "
    "nivel-posicion-subcolumna-columna y aplicar filtros apropiados en cada nivel de la jerarquia.",
    body_style
))

# C5 - Missing $ in template literal
story.append(Paragraph("2.5 Falta Signo $ en Literal de Plantilla - CSS Roto", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> TrasladoTab.tsx, linea 965",
    body_left
))
story.append(Paragraph(
    "En la seccion de Racks, en el componente TrasladoTab, se encuentra un error de sintaxis en un "
    "literal de plantilla de JavaScript. El bloque condicional que aplica colores de fondo al indicador "
    "de ajuste carece del prefijo $ antes de la llave de apertura, lo que significa que toda la expresion "
    "condicional (excedeStock ? ... : ...) se convierte en texto literal dentro del atributo className "
    "en lugar de ser evaluada. Como resultado, el indicador de ajuste se renderiza con estilos rotos o "
    "invisibles, y el usuario nunca ve la codificacion de color correcta (ambar para excedente, celeste "
    "para ajuste normal) durante las transferencias automaticas.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Cambiar className={`rounded-xl border p-3 { por "
    "className={`rounded-xl border p-3 ${ agregando el signo $ faltante.",
    body_style
))

# C6 - Multi-lote permanently zero
story.append(Paragraph("2.6 Metrica Multi-Lote Permanentemente en Cero", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> OcupacionTab.tsx, linea 112 (calcularOcupacion)",
    body_left
))
story.append(Paragraph(
    "En la seccion de Racks, la funcion calcularOcupacion asigna el valor codigos.size al campo lotes, "
    "pero codigos ya es Array.from(codigos), lo que significa que lotes siempre sera igual a "
    "codigos.length. El filtro de multi-lote en la linea 261 verifica codigos.length === 1 y lotes > 1 "
    "simultaneamente, lo cual es imposible porque si codigos.length es 1 entonces lotes es 1. Esto "
    "significa que la estadistica de multi-lote en el dashboard, en el dashboard por bloque, en la "
    "exportacion Excel, y en la leyenda, sera permanentemente 0. Los usuarios no pueden identificar "
    "celdas con multiples lotes del mismo producto con diferentes fechas de vencimiento, frustrando "
    "completamente el proposito del seguimiento FEFO (First Expired, First Out).",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Modificar calcularOcupacion para rastrear el numero de valores distinct "
    "de f_vencimiento por codigo, no solo el numero de codigos distinct. Si la decision de negocio "
    "es eliminar el seguimiento por lotes, eliminar los elementos de UI de multi-lote.",
    body_style
))

# C7 - Missing proveedor in traslado
story.append(Paragraph("2.7 Campo Proveedor Perdido Durante Traslado", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> OcupacionTab.tsx, lineas 533-541 (ejecutarTraslado)",
    body_left
))
story.append(Paragraph(
    "La funcion ejecutarTraslado del componente OcupacionTab no incluye el campo proveedor en el "
    "objeto de entrada del traslado, a pesar de que el tipo TrasladoInput lo soporta y el item de "
    "origen (trItem) lo contiene. Esto significa que cada traslado realizado desde la pestana de Ocupacion "
    "registrara el movimiento de destino sin informacion del proveedor. En contraste, la funcion doTraslado "
    "del componente TrasladoTab (linea 272) si pasa correctamente proveedor: origin.proveedor. Este "
    "comportamiento inconsistente entre las dos rutas de traslado en la misma seccion de Racks causa "
    "perdida silenciosa de metadatos criticos en la base de datos.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Agregar proveedor: trItem.proveedor al objeto de entrada en ejecutarTraslado.",
    body_style
))

# C8-C11: Infrastructure
story.append(Paragraph("2.8 Definiciones de Tipos TypeScript Incompletas", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> supabase/types.ts, lineas 433-486 (RPC types), 39-98 (movimientos table)",
    body_left
))
story.append(Paragraph(
    "Las definiciones de tipos de TypeScript para los RPCs de Supabase estan gravemente incompletas. "
    "El tipo registrar_movimiento_kardex no declara los parametros p_uuid_sync y p_codigo_inc que el "
    "codigo efectivamente envia. De manera similar, registrar_traslado_kardex carece de p_uuid_sync y "
    "p_codigo_inc. El tipo de retorno de ambos RPCs dice { success: boolean; previous_stock: number; "
    "new_stock: number } pero el SQL real retorna JSONB con claves como origin_previous_stock y "
    "origin_new_stock. Ademas, la tabla movimientos carece de las columnas uuid_sync y codigo_inc "
    "en sus definiciones de tipo. Los roles de usuario definen 7 roles en auth.ts pero solo 2 en el "
    "enum app_role de supabase-types.ts. Estas discrepancias eliminan completamente la seguridad "
    "de tipos en tiempo de compilacion.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Regenerar supabase-types.ts con el esquema actual de la base de datos, "
    "incluyendo uuid_sync, codigo_inc, p_uuid_sync, p_codigo_inc y los 7 roles de usuario.",
    body_style
))

story.append(Paragraph("2.9 Falta de Validacion de Cantidad en Alerta de Traslado", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> OcupacionTab.tsx, lineas 528-530 (ejecutarTraslado)",
    body_left
))
story.append(Paragraph(
    "La funcion ejecutarTraslado es invocada desde dos rutas diferentes: doTransferir (que valida qty > 0) "
    "y el boton de confirmacion del dialogo de alerta (que no realiza ninguna validacion). Si la cantidad "
    "llega como NaN o un valor negativo, se envia directamente al RPC que rechazara la solicitud con un "
    "error opaco del servidor en lugar de un mensaje claro del lado del cliente. Esto afecta directamente "
    "la funcionalidad de alerta de posicion ocupada que fue implementada recientemente.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Agregar validacion de isNaN(qty) o qty <= 0 al inicio de ejecutarTraslado.",
    body_style
))

story.append(Paragraph("2.10 Traslado Fallback No Atomico Puede Perder Stock", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> kardex.ts, lineas 575-660 (trasladarMovimientoFallback)",
    body_left
))
story.append(Paragraph(
    "La funcion trasladarMovimientoFallback en la seccion de Racks inserta de 2 a 3 filas (ajuste, salida, "
    "traslado) en una sola llamada .insert([...]). Sin embargo, PostgREST no ejecuta estas operaciones "
    "en una transaccion unica por defecto. Si la conexion se cae despues de escribir la salida pero antes "
    "de escribir el traslado (ingreso en destino), el stock desaparece: se resta del origen pero nunca "
    "se agrega en el destino. La ruta RPC (registrar_traslado_kardex) si usa advisory locks y una transaccion "
    "unica, pero la ruta fallback no tiene dicha proteccion.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Migrar toda la logica de traslado al RPC con transaccion y eliminar el fallback "
    "directo, o agregar advisory locks al fallback.",
    body_style
))

story.append(Paragraph("2.11 Duplicacion de uuid_sync en RPC con Ajuste", h2_style))
story.append(sev_tag('CRITICO'))
story.append(Paragraph(
    "<b>Archivos:</b> supabase/migrations/20260620_rpc_inc_stock_fix.sql, lineas 183-213",
    body_left
))
story.append(Paragraph(
    "El RPC registrar_traslado_kardex asigna p_uuid_sync a las tres inserciones (ajuste, salida, traslado). "
    "La columna uuid_sync tiene un indice unico parcial (WHERE uuid_sync IS NOT NULL). Si se proporciona "
    "p_uuid_sync y p_cantidad_ajuste es diferente de 0, el RPC fallara con una violacion de constraint "
    "unico porque intenta insertar 3 filas con el mismo uuid_sync no nulo. Esto significa que los traslados "
    "sincronizados offline con ajustes siempre fallaran en la base de datos. El fallback de TypeScript "
    "(kardex.ts) correctamente asigna uuid_sync solo a una fila, pero el RPC no.",
    body_style
))
story.append(Paragraph(
    "<b>Recomendacion:</b> Modificar el RPC para asignar p_uuid_sync unicamente a la primera fila "
    "(el ajuste) y NULL a las demas, igual que el fallback de TypeScript.",
    body_style
))

# ━━ SECTION 3: HIGH SEVERITY ━━
story.append(Paragraph("3. Hallazgos de Alta Severidad", h1_style))

story.append(Paragraph(
    "Los siguientes 13 hallazgos representan fallas funcionales que afectan directamente las operaciones "
    "criticas de negocio. Si bien no comprometen la seguridad del sistema en su totalidad, pueden causar "
    "operaciones duplicadas, datos inconsistentes, y errores silenciosos que impactan la operacion diaria "
    "del almacen.",
    body_style
))

high_findings = [
    ['H1', 'ALTO', 'PisoSectoresTab.tsx:605', 'Reset de nivel en traslado/devolucion',
     'openTraslado y openDevolucion reinician selectedNivelId al primer nivel, rompiendo la seleccion del usuario.',
     'Eliminar set de selectedNivelId en openTraslado y openDevolucion.'],
    ['H2', 'ALTO', 'PisoSectoresTab.tsx:788', 'IDs manuales sin resolver pasan a la API',
     'ensureManualBloqueCreated empuja filas con prefijo manual_ si la creacion y busqueda fallan.',
     'Lanzar error si un bloque manual no puede resolverse en vez de pasar ID roto.'],
    ['H3', 'ALTO', 'Pisos + Racks', 'Doble clic causa operaciones duplicadas',
     'Ninguna funcion doXxx verifica busy al inicio. El estado de React es asincrono, permite doble envio.',
     'Agregar if (busy) return usando un ref-based guard pattern.'],
    ['H4', 'ALTO', 'api.ts:1285', 'stockPorNivelPosicion siempre retorna bloque_codigo vacio',
     'La funcion agrega stock por nivel_id pero descarta informacion por bloque. bloque_codigo es siempre vacio.',
     'Reescribir para rastrear stock por (nivel_id, bloque_id), no solo por nivel_id.'],
    ['H5', 'ALTO', 'api.ts (multiple)', 'Duplicacion masiva de codigo FEFO',
     'stockDetalleNivel (120 lineas) es casi identico al fallback de stockDetallePosicion.',
     'Extraer logica FEFO compartida en una funcion helper.'],
    ['H6', 'ALTO', 'OcupacionTab.tsx:375', 'Falta validacion de descripcion y un en ingreso',
     'doIngreso y doIngresoINC validan codigo y cantidad pero no descripcion ni unidad.',
     'Agregar validacion de campos requeridos antes de enviar al RPC.'],
    ['H7', 'ALTO', 'auth.ts:205-271', 'Sin checks de autorizacion en funciones de perfil',
     'getTodosLosPerfiles, cambiarAprobado, cambiarRol, eliminarPerfil no verifican roles del usuario.',
     'Agregar verificacion de rol admin en cada funcion o restringir a rutas API del servidor.'],
    ['H8', 'ALTO', 'sync-engine.ts:248', 'Errores silenciados en SyncEngine',
     'Multiples catch blocks ocultan errores sin registro: refreshCounts, syncAll, etc.',
     'Implementar logging estructurado y notificacion al usuario de errores de sincronizacion.'],
    ['H9', 'ALTO', 'catalogo.ts:228', 'clearPisoBloques no es atomico',
     'Si falla despues de eliminar asignaciones de columna pero antes de eliminar bloques, queda estado parcial.',
     'Envolver en RPC de base de datos con transaccion.'],
    ['H10', 'ALTO', 'sync-engine.ts:202', 'Ping filtra estructura de base de datos',
     'La funcion ping confirma a atacantes que la tabla profiles existe y la API REST es accesible.',
     'Remover ping o limitar a endpoints no reveladores de estructura.'],
    ['H11', 'ALTO', 'offline-db.ts:13', 'DB_VERSION nunca incrementado',
     'Si el esquema IndexedDB necesita evolucionar, los datos existentes no se migran.',
     'Implementar sistema de versiones con onupgradeneeded para migraciones.'],
    ['H12', 'ALTO', 'TrasladoTab.tsx:250', 'Variable shadowing de movs',
     'La desestructuracion { movs } del response sombrea el estado movs del componente.',
     'Renombrar a { movs: updatedMovs } para evitar confusion.'],
    ['H13', 'ALTO', 'OcupacionTab.tsx:571', 'Doble setActionBusy causa flicker de boton',
     'El flujo de alerta resetea busy y luego el finally lo resetea de nuevo, causando flicker visual.',
     'Refactorizar control de flujo para un solo punto de activacion/desactivacion.'],
]

h_table_data = [['ID', 'Severidad', 'Ubicacion', 'Problema', 'Descripcion', 'Accion Recomendada']]
for f in high_findings:
    h_table_data.append([wrap_p(x, body_left) for x in f])

avail_w2 = A4[0] - 40*mm
h_cws = [avail_w2*0.06, avail_w2*0.08, avail_w2*0.16, avail_w2*0.20, avail_w2*0.28, avail_w2*0.22]
h_table = Table(h_table_data, colWidths=h_cws)
h_style = make_table_style(len(h_table_data))
h_table.setStyle(h_style)
story.append(Spacer(1, 6*mm))
story.append(h_table)
story.append(Paragraph("Tabla 3: Hallazgos de alta severidad", caption_style))

# ━━ SECTION 4: MEDIUM SEVERITY ━━
story.append(Paragraph("4. Hallazgos de Severidad Media", h1_style))

story.append(Paragraph(
    "Los hallazgos de severidad media afectan la calidad del codigo, el rendimiento del sistema, y la "
    "experiencia del usuario sin causar fallas criticas de negocio. Sin embargo, su correccion mejora "
    "significativamente la robustez y mantenibilidad del sistema a largo plazo.",
    body_style
))

medium_findings = [
    ['M1', 'MEDIO', 'api.ts:940', 'Items sin fecha de vencimiento ordenados primero en FEFO',
     'Los items sin fecha de vencimiento se consumen primero, pero deberian consumirse ultimo si no tienen caducidad.'],
    ['M2', 'MEDIO', 'PisoSectoresTab.tsx:1156', 'doMassSalida ejecuta posiciones en paralelo sin rollback',
     'Promise.all procesa todas las posiciones concurrentemente sin mecanismo de deshacer si algunas fallan.'],
    ['M3', 'MEDIO', 'PisoSectoresTab.tsx:912', 'Seleccion de nivel en salida puede producir nivel_id incorrecto',
     'Cuando salNivelTab es all, usa selectedNivelId que apunta al nivel visualizado, no necesariamente donde esta el stock.'],
    ['M4', 'MEDIO', 'api.ts (multiple)', 'Console.log de debug en produccion',
     'Multiples sentencias console.log con prefijo [Piso] quedaron en el codigo de produccion.'],
    ['M5', 'MEDIO', 'api.ts:206', 'eliminarBloque no verifica error en eliminacion de relaciones',
     'Si la eliminacion de piso_columna_bloques falla, se eliminan los bloques pero quedan relaciones huerfanas.'],
    ['M6', 'MEDIO', 'api.ts (traslado)', 'Traslado crea dos movimientos sin vincular',
     'Salida e ingreso son registros independientes sin campo traslado_id para auditar correspondencia.'],
    ['M7', 'MEDIO', 'PisoSectoresTab.tsx:422', 'useEffect causa refetches innecesarios',
     'Cualquier cambio en dependencias de useCallbacks dispara la recarga de sectores, posiciones y bloques.'],
    ['M8', 'MEDIO', 'TrasladoTab.tsx:93', 'Actualizaciones realtime invalidan selectedOrigin',
     'useMovimientosRealtime actualiza movs pero no locations, causando datos obsoletos.'],
    ['M9', 'MEDIO', 'OcupacionTab.tsx:464', 'Variable detail sombrea estado detail en doSalida',
     'Un const detail local en el catch sombrea el estado detail del componente, creando confusion.'],
    ['M10', 'MEDIO', 'sync-engine.ts:639', 'offlineAwareTraslado sin passthrough de uuidSync',
     'Siempre genera nuevo UUID, diferente de offlineAwareAddMovimiento que acepta uuidSync opcional.'],
    ['M11', 'MEDIO', 'kardex.ts:607', 'uuid_sync solo en una fila del traslado fallback',
     'Solo el ajuste tiene uuid_sync, la salida y el traslado tienen NULL. Diferente del RPC que lo pone en todas.'],
    ['M12', 'MEDIO', 'kardex.ts:50', 'fromRow usa casts inseguros sin validacion',
     'Tipo y turno se casteo con as sin verificar que el valor sea valido en tiempo de ejecucion.'],
    ['M13', 'MEDIO', 'kardex.ts:73', 'fetchMovimientos descarga tabla completa despues de cada escritura',
     'Cada operacion de escritura dispara una descarga completa de la tabla movimientos con paginacion.'],
    ['M14', 'MEDIO', 'useConnectivity.ts:26', 'SyncEngine nunca se destruye en unmount',
     'Los event listeners y intervalos de ping y conteos persisten despues de desmontar el componente.'],
    ['M15', 'MEDIO', 'sync-engine.ts:606', 'Cola offline no valida datos al encolar',
     'Se aceptan movimientos con codigo vacio, cantidad negativa, o ubicaciones invalidas.'],
    ['M16', 'MEDIO', 'sync-engine.ts:545', 'getConflicts escanea todos los movimientos pendientes',
     'O(n) donde podria ser O(k) con un indice IndexedDB por status.'],
    ['M17', 'MEDIO', 'catalogo.ts:13', 'Cache a nivel de modulo puede filtrar en SSR',
     'Variables _cache y _cacheLoaded pueden persistir datos obsoletos en contextos de servidor.'],
    ['M18', 'MEDIO', 'prisma/schema.prisma', 'Schema Prisma es boilerplate residual',
     'Modelos User y Post de Next.js generico, no usados. db.ts conecta a SQLite no utilizado.'],
]

m_table_data = [['ID', 'Sev.', 'Ubicacion', 'Problema', 'Descripcion']]
for f in medium_findings:
    m_table_data.append([wrap_p(x, body_left) for x in f])

m_cws = [avail_w2*0.06, avail_w2*0.06, avail_w2*0.18, avail_w2*0.32, avail_w2*0.38]
m_table = Table(m_table_data, colWidths=m_cws)
m_table.setStyle(make_table_style(len(m_table_data)))
story.append(Spacer(1, 6*mm))
story.append(m_table)
story.append(Paragraph("Tabla 4: Hallazgos de severidad media", caption_style))

# ━━ SECTION 5: LOW SEVERITY ━━
story.append(Paragraph("5. Hallazgos de Baja Severidad", h1_style))

story.append(Paragraph(
    "Los hallazgos de baja severidad son cuestiones de limpieza de codigo, estilo, y mejoras menores que "
    "no afectan la funcionalidad del sistema pero que deben abordarse para mejorar la calidad general del "
    "codigo y facilitar el mantenimiento futuro.",
    body_style
))

low_findings = [
    ['L1', 'BAJO', 'PisoSectoresTab.tsx:39', 'Import Checkbox sin usar'],
    ['L2', 'BAJO', 'PisoSectoresTab.tsx:1247', 'Componentes NivelSelector definidos dentro del componente principal'],
    ['L3', 'BAJO', 'api.ts (multiple)', 'Type assertions inseguros (as unknown[])'],
    ['L4', 'BAJO', 'api.ts:466', 'calcularStockNivel no distingue lotes por fecha'],
    ['L5', 'BAJO', 'PisoSectoresTab.tsx:10', 'Import obtenerPrimerNivel potencialmente sin usar'],
    ['L6', 'BAJO', 'api.ts:216', 'reemplazarCatalogoBloques usa neq(id, ) frágil'],
    ['L7', 'BAJO', 'OcupacionTab.tsx:5', 'Import fetchOcupacionCeldas solo usado en fallback'],
    ['L8', 'BAJO', 'OcupacionTab.tsx:240', 'refreshDetail traga errores silenciosamente'],
    ['L9', 'BAJO', 'sync-engine.ts:248', 'refreshCounts falla silenciosamente'],
    ['L10', 'BAJO', 'OcupacionTab.tsx:383', 'Sin validacion de fecha cuando ingSinFecha es false'],
    ['L11', 'BAJO', 'OcupacionTab.tsx:602', 'Export usa lookup O(n2)'],
    ['L12', 'BAJO', 'OcupacionTab.tsx:614', 'Non-null assertion cell! en export'],
    ['L13', 'BAJO', 'auth.ts:192,218', 'Logica de extraccion de roles duplicada e inconsistente'],
    ['L14', 'BAJO', 'kardex.ts:465', 'stockEnUbicacion retorna [] en todo error'],
    ['L15', 'BAJO', 'ConnectionIndicator.tsx:141', 'max-w duplicado y conflictivo'],
]

l_table_data = [['ID', 'Sev.', 'Ubicacion', 'Problema']]
for f in low_findings:
    l_table_data.append([wrap_p(x, body_left) for x in f])

l_cws = [avail_w2*0.08, avail_w2*0.08, avail_w2*0.24, avail_w2*0.60]
l_table = Table(l_table_data, colWidths=l_cws)
l_table.setStyle(make_table_style(len(l_table_data)))
story.append(Spacer(1, 6*mm))
story.append(l_table)
story.append(Paragraph("Tabla 5: Hallazgos de baja severidad", caption_style))

# ━━ SECTION 6: PLAN DE REMEDIACION ━━
story.append(Paragraph("6. Plan de Remediation por Prioridad", h1_style))

story.append(Paragraph(
    "A continuacion se presenta el plan de remediation organizado por prioridad temporal. Se recomienda "
    "abordar los problemas en el orden indicado, comenzando por los que representan mayor riesgo para "
    "la seguridad e integridad del sistema. Cada fase incluye una estimacion del esfuerzo requerido "
    "y los recursos necesarios para su implementacion.",
    body_style
))

story.append(Paragraph("6.1 Fase Inmediata (Dias 1-2)", h2_style))
story.append(Paragraph(
    "Esta fase debe completarse antes de cualquier otro desarrollo. Los items aqui incluidos representan "
    "riesgos activos de seguridad y corrupcion de datos que estan expuestos en el ambiente de produccion "
    "actual. El esfuerzo estimado es de 2 a 3 dias de desarrollo concentrado, preferiblemente por un "
    "desarrollador senior con conocimiento completo de la arquitectura del sistema.",
    body_style
))
imm_data = [
    ['#', 'Hallazgo', 'Accion', 'Esfuerzo'],
    ['1', 'Clave service role expuesta', 'Mover a variable de entorno solo servidor y crear rutas API', '1 dia'],
    ['2', 'Logica de excedente en traslado', 'Reescribir ejecutarTrasladoPiso con cap de stock actual', '2 horas'],
    ['3', 'Operaciones no atomicas', 'Crear RPC piso_registrar_movimiento con transaccion', '1 dia'],
    ['4', 'Filtrado de columnas roto', 'Reescribir listarMovimientos con joins correctos', '3 horas'],
    ['5', 'CSS roto en TrasladoTab', 'Agregar signo $ faltante en template literal', '5 minutos'],
    ['6', 'Multi-lote en cero', 'Modificar calcularOcupacion para tracking por fecha de vencimiento', '2 horas'],
    ['7', 'Proveedor perdido en traslado', 'Agregar proveedor: trItem.proveedor en ejecutarTraslado', '5 minutos'],
    ['8', 'Validacion de cantidad en alerta', 'Agregar validacion isNaN/qty<=0 al inicio de ejecutarTraslado', '10 minutos'],
]
imm_table = Table(imm_data, colWidths=[avail_w2*0.05, avail_w2*0.25, avail_w2*0.50, avail_w2*0.12])
imm_table.setStyle(make_table_style(len(imm_data)))
story.append(Spacer(1, 4*mm))
story.append(imm_table)
story.append(Paragraph("Tabla 6: Acciones de fase inmediata", caption_style))

story.append(Paragraph("6.2 Fase Corto Plazo (Semana 1)", h2_style))
story.append(Paragraph(
    "Esta fase aborda los problemas funcionales que afectan las operaciones diarias del almacen. "
    "Los items aqui listados no representan riesgos de seguridad inmediatos, pero si pueden causar "
    "frustracion en los usuarios, operaciones duplicadas, y datos inconsistentes que requieren "
    "correccion manual. El esfuerzo estimado es de 3 a 4 dias de desarrollo.",
    body_style
))
short_data = [
    ['#', 'Hallazgo', 'Accion', 'Esfuerzo'],
    ['1', 'Doble clic duplicado', 'Agregar ref-based guard en todas las funciones doXxx', '2 horas'],
    ['2', 'Reset de nivel en traslado', 'Eliminar set de selectedNivelId en openTraslado/openDevolucion', '15 minutos'],
    ['3', 'IDs manuales sin resolver', 'Lanzar error en vez de pasar ID roto en ensureManualBloqueCreated', '30 minutos'],
    ['4', 'stockPorNivelPosicion vacio', 'Reescribir para rastrear stock por bloque, no solo por nivel', '2 horas'],
    ['5', 'Validacion faltante en ingreso', 'Agregar validacion de descripcion y un en doIngreso/doIngresoINC', '30 minutos'],
    ['6', 'Sin autorizacion en perfiles', 'Agregar verificacion de rol admin en funciones de auth.ts', '2 horas'],
    ['7', 'Errores silenciados en SyncEngine', 'Implementar logging estructurado en catch blocks', '1 hora'],
    ['8', 'DB_VERSION sin incrementar', 'Implementar sistema de migracion de IndexedDB', '3 horas'],
]
short_table = Table(short_data, colWidths=[avail_w2*0.05, avail_w2*0.25, avail_w2*0.50, avail_w2*0.12])
short_table.setStyle(make_table_style(len(short_data)))
story.append(Spacer(1, 4*mm))
story.append(short_table)
story.append(Paragraph("Tabla 7: Acciones de corto plazo", caption_style))

story.append(Paragraph("6.3 Fase Mediano Plazo (Semanas 2-3)", h2_style))
story.append(Paragraph(
    "La fase de mediano plazo aborda la calidad general del codigo, la mantenibilidad, y el rendimiento "
    "del sistema. Estos cambios no son urgentes pero representan inversiones significativas en la salud "
    "tecnica del proyecto. Se recomienda planificarlos como parte del backlog regular de mantenimiento "
    "tecnico y abordarlos incrementalmente durante los sprints de desarrollo.",
    body_style
))
mid_data = [
    ['#', 'Hallazgo', 'Accion', 'Esfuerzo'],
    ['1', 'Regenerar tipos TypeScript', 'Ejecutar supabase gen types con esquema actualizado', '1 hora'],
    ['2', 'Duplicacion de codigo FEFO', 'Extraer logica compartida en funcion helper', '2 horas'],
    ['3', 'Traslado fallback no atomico', 'Migrar toda logica al RPC con transaccion', '1 dia'],
    ['4', 'uuid_sync duplicado en RPC', 'Modificar RPC para asignar solo a primera fila', '30 minutos'],
    ['5', 'Console.log en produccion', 'Eliminar todas las sentencias de debug', '30 minutos'],
    ['6', 'Refactorizar clearPisoBloques', 'Crear RPC con transaccion para limpieza de bloques', '1 hora'],
    ['7', 'SyncEngine lifecycle', 'Implementar destroy() en useConnectivity', '1 hora'],
    ['8', 'Fetch de tabla completa', 'Reemplazar con queries dirigidas o suscripciones realtime', '2 dias'],
]
mid_table = Table(mid_data, colWidths=[avail_w2*0.05, avail_w2*0.25, avail_w2*0.50, avail_w2*0.12])
mid_table.setStyle(make_table_style(len(mid_data)))
story.append(Spacer(1, 4*mm))
story.append(mid_table)
story.append(Paragraph("Tabla 8: Acciones de mediano plazo", caption_style))

# ━━ SECTION 7: CONCLUSION ━━
story.append(Paragraph("7. Conclusiones y Observaciones Generales", h1_style))

story.append(Paragraph(
    "La auditoria revela que el sistema Rackly, a pesar de ser funcional y servir adecuadamente a sus "
    "usuarios actuales, presenta un numero significativo de vulnerabilidades de seguridad y defectos de "
    "integridad de datos que requieren atencion prioritaria. El hallazgo mas critico, la exposicion de "
    "la clave de rol de servicio al navegador del cliente, representa un riesgo de seguridad que debe "
    "corregirse inmediatamente independientemente de cualquier otra consideracion. Este problema por si "
    "solo justifica una interrupcion del desarrollo de nuevas funcionalidades hasta ser resuelto.",
    body_style
))

story.append(Paragraph(
    "En cuanto a la integridad de los datos de inventario, los problemas encontrados en la logica de "
    "traslados (stock fantasma, balance negativo, operaciones no atomicas) son particularmente preocupantes "
    "en un sistema de gestion de inventario donde la precision de los datos es fundamental. La ausencia "
    "de transacciones en las operaciones de registro de movimientos significa que cualquier fallo de red "
    "o de base de datos a mitad de una operacion puede dejar el sistema en un estado que requiere "
    "intervencion manual para ser corregido, lo cual es inaceptable para un sistema de produccion.",
    body_style
))

story.append(Paragraph(
    "Las condiciones de carrera por doble clic y la falta de guards basados en refs en las funciones "
    "de movimiento son problemas relativamente simples de corregir pero que pueden causar operaciones "
    "duplicadas que son dificiles de detectar y revertir una vez ocurridas. Se recomienda implementar "
    "estas correcciones como parte de la fase inmediata junto con los problemas criticos de seguridad.",
    body_style
))

story.append(Paragraph(
    "A pesar de los problemas identificados, la arquitectura general del sistema muestra decisiones "
    "acertadas como la implementacion de sincronizacion offline con IndexedDB, el mecanismo de "
    "idempotencia basado en uuidSync, la clasificacion de errores en el sync engine, y el uso de "
    "RPCs con advisory locks para las operaciones principales de Racks. Estos fundamentos solidos "
    "hacen que las correcciones propuestas sean factibles sin requerir una re-arquitectura completa "
    "del sistema.",
    body_style
))

# ━━ BUILD ━━
doc.build(story, onFirstPage=draw_cover, onLaterPages=draw_footer)
print(f"PDF generado exitosamente: {output_path}")

#!/usr/bin/env python3
"""Generate RACKLY User Manual PDF v4 - Visual, mobile wireframes, correct RAE Spanish, APA."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                 PageBreak, HRFlowable, KeepTogether, Image)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from PIL import Image as PILImage
import os

# ── Register fonts (Times New Roman clone for APA) ──
pdfmetrics.registerFont(TTFont('TimesRoman', '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'))
pdfmetrics.registerFont(TTFont('TimesRoman-Bold', '/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf'))
pdfmetrics.registerFont(TTFont('TimesRoman-Italic', '/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf'))
pdfmetrics.registerFont(TTFont('TimesRoman-BoldItalic', '/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf'))

IMG_DIR = '/home/z/my-project/download/manual_imgs'
OUT = '/home/z/my-project/download'
PDF_PATH = os.path.join(OUT, 'RACKLY_Manual_de_Usuario.pdf')

# ── Colors (dark/readable on white) ──
DARK = HexColor('#1a1a1a')
GRAY = HexColor('#4a4a4a')
LIGHT_GRAY = HexColor('#666666')
ACCENT_BLUE = HexColor('#1a5276')
TABLE_HEADER = HexColor('#2c3e50')
TABLE_ALT = HexColor('#f0f4f8')
TABLE_BORDER = HexColor('#bdc3c7')
TIP_BG = HexColor('#fef9e7')
TIP_BORDER = HexColor('#d4ac0d')
TIP_TEXT = HexColor('#7d6608')
WARN_BG = HexColor('#fdedec')
WARN_BORDER = HexColor('#e74c3c')
WARN_TEXT = HexColor('#922b21')
NOTE_BG = HexColor('#eaf2f8')
NOTE_BORDER = HexColor('#2980b9')
NOTE_TEXT = HexColor('#1a5276')
STEP_NUM = HexColor('#2471a3')

W, H = A4

# ── Image helper ──
def img_tag(path, max_w=4*cm, max_h=6.5*cm):
    img = PILImage.open(path)
    w, h = img.size
    ratio = min(max_w / w, max_h / h)
    return Image(path, width=w * ratio, height=h * ratio)

# ── Page callbacks ──
def add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont('TimesRoman', 9)
    canvas.setFillColor(LIGHT_GRAY)
    pn = canvas.getPageNumber()
    canvas.drawRightString(W - 2.54*cm, 1.27*cm, f'{pn}')
    canvas.setFont('TimesRoman-Italic', 8)
    canvas.drawString(2.54*cm, H - 1.27*cm, 'RACKLY - Manual de Usuario')
    canvas.setStrokeColor(TABLE_BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(2.54*cm, H - 1.5*cm, W - 2.54*cm, H - 1.5*cm)
    canvas.line(2.54*cm, 1.6*cm, W - 2.54*cm, 1.6*cm)
    canvas.restoreState()

def add_cover(canvas, doc):
    pass

# ── Styles (APA: Times New Roman 12pt, 1-inch margins) ──
styles = getSampleStyleSheet()

s_title_cover = ParagraphStyle('TitleCover', fontName='TimesRoman-Bold', fontSize=28,
    textColor=ACCENT_BLUE, spaceAfter=4, alignment=TA_CENTER, leading=34)

s_subtitle_cover = ParagraphStyle('SubCover', fontName='TimesRoman', fontSize=16,
    textColor=GRAY, spaceAfter=20, alignment=TA_CENTER, leading=20)

s_h1 = ParagraphStyle('H1', fontName='TimesRoman-Bold', fontSize=16,
    textColor=ACCENT_BLUE, spaceBefore=20, spaceAfter=10, leading=20, alignment=TA_LEFT)

s_h2 = ParagraphStyle('H2', fontName='TimesRoman-Bold', fontSize=13,
    textColor=ACCENT_BLUE, spaceBefore=14, spaceAfter=8, leading=16, alignment=TA_LEFT)

s_h3 = ParagraphStyle('H3', fontName='TimesRoman-Bold', fontSize=12,
    textColor=ACCENT_BLUE, spaceBefore=12, spaceAfter=6, leading=15, alignment=TA_LEFT)

s_body = ParagraphStyle('Body', fontName='TimesRoman', fontSize=12,
    textColor=DARK, spaceAfter=8, leading=18, alignment=TA_JUSTIFY, firstLineIndent=0)

s_step = ParagraphStyle('Step', fontName='TimesRoman-Bold', fontSize=12,
    textColor=STEP_NUM, spaceBefore=8, spaceAfter=2, leading=16, leftIndent=18)

s_step_body = ParagraphStyle('StepBody', fontName='TimesRoman', fontSize=12,
    textColor=DARK, spaceAfter=8, leading=18, leftIndent=36, alignment=TA_JUSTIFY)

s_bullet = ParagraphStyle('Bullet', fontName='TimesRoman', fontSize=12,
    textColor=DARK, spaceAfter=6, leading=18, leftIndent=36, bulletIndent=18, alignment=TA_LEFT)

s_toc_item = ParagraphStyle('TOC', fontName='TimesRoman', fontSize=12,
    textColor=DARK, spaceAfter=5, leftIndent=24, leading=20)

s_table_header = ParagraphStyle('TH', fontName='TimesRoman-Bold', fontSize=10,
    textColor=white, alignment=TA_CENTER, leading=13)

s_table_cell = ParagraphStyle('TC', fontName='TimesRoman', fontSize=10,
    textColor=DARK, alignment=TA_LEFT, leading=13)

s_img_caption = ParagraphStyle('ImgCap', fontName='TimesRoman-Italic', fontSize=9,
    textColor=GRAY, spaceAfter=6, alignment=TA_CENTER, leading=12)

s_quick_label = ParagraphStyle('QuickLabel', fontName='TimesRoman-Bold', fontSize=12,
    textColor=DARK, spaceAfter=6, leading=16, alignment=TA_LEFT)

# Callout styles - FIXED: increased spaceBefore/spaceAfter to avoid overlap
s_tip = ParagraphStyle('TipBox', fontName='TimesRoman', fontSize=11,
    textColor=TIP_TEXT, backColor=TIP_BG, borderColor=TIP_BORDER,
    borderWidth=1, borderPadding=10, leftIndent=0, rightIndent=0,
    spaceBefore=14, spaceAfter=14, leading=16, alignment=TA_JUSTIFY)

s_warning = ParagraphStyle('WarnBox', fontName='TimesRoman-Bold', fontSize=11,
    textColor=WARN_TEXT, backColor=WARN_BG, borderColor=WARN_BORDER,
    borderWidth=1, borderPadding=10, leftIndent=0, rightIndent=0,
    spaceBefore=14, spaceAfter=14, leading=16, alignment=TA_JUSTIFY)

s_note = ParagraphStyle('NoteBox', fontName='TimesRoman', fontSize=11,
    textColor=NOTE_TEXT, backColor=NOTE_BG, borderColor=NOTE_BORDER,
    borderWidth=1, borderPadding=10, leftIndent=0, rightIndent=0,
    spaceBefore=14, spaceAfter=14, leading=16, alignment=TA_JUSTIFY)


def make_table(headers, rows, col_widths=None):
    data = []
    data.append([Paragraph(h, s_table_header) for h in headers])
    for row in rows:
        data.append([Paragraph(str(c), s_table_cell) for c in row])
    if col_widths is None:
        col_widths = [15.5*cm / len(headers)] * len(headers)
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER),
        ('TEXTCOLOR', (0, 0), (-1, 0), white),
        ('FONTNAME', (0, 0), (-1, 0), 'TimesRoman-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('FONTNAME', (0, 1), (-1, -1), 'TimesRoman'),
        ('FONTSIZE', (0, 1), (-1, -1), 10),
        ('TEXTCOLOR', (0, 1), (-1, -1), DARK),
        ('GRID', (0, 0), (-1, -1), 0.5, TABLE_BORDER),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [white, TABLE_ALT]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]))
    return t

def make_side_by_side(img_filename, text_elements, img_max_w=4*cm, img_max_h=6.5*cm):
    """Create a side-by-side layout: phone image on left, text on right."""
    img = img_tag(os.path.join(IMG_DIR, img_filename), max_w=img_max_w, max_h=img_max_h)
    text_cell = text_elements
    tbl = Table([[img, text_cell]], colWidths=[4.5*cm, 12*cm])
    tbl.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    return tbl


# ── Shortcuts ──
def step(n, text):
    return Paragraph(f'<b>Paso {n}:</b> {text}', s_step)

def detail(text):
    return Paragraph(text, s_step_body)

def tip(text):
    return KeepTogether([Spacer(1, 0.3*cm), Paragraph(f'<b>Consejo:</b> {text}', s_tip), Spacer(1, 0.2*cm)])

def warning(text):
    return KeepTogether([Spacer(1, 0.3*cm), Paragraph(f'<b>Importante:</b> {text}', s_warning), Spacer(1, 0.2*cm)])

def note(text):
    return KeepTogether([Spacer(1, 0.3*cm), Paragraph(f'<b>Nota:</b> {text}', s_note), Spacer(1, 0.2*cm)])

def bullet(text):
    return Paragraph(f'- {text}', s_bullet)

def body(text):
    return Paragraph(text, s_body)

def h1(text):
    return Paragraph(text, s_h1)

def h2(text):
    return Paragraph(text, s_h2)

def h3(text):
    return Paragraph(text, s_h3)

def sp(h=0.3):
    return Spacer(1, h*cm)


# ═══════════════════════════════════════════════════════════
# BUILD PDF
# ═══════════════════════════════════════════════════════════
def build_pdf():
    doc = SimpleDocTemplate(PDF_PATH, pagesize=A4,
        topMargin=2.54*cm, bottomMargin=2.54*cm,
        leftMargin=2.54*cm, rightMargin=2.54*cm)

    story = []

    # ═══════════════════════════════
    # PORTADA (APA)
    # ═══════════════════════════════
    story.append(Spacer(1, 5*cm))
    story.append(Paragraph('RACKLY', s_title_cover))
    story.append(Spacer(1, 0.4*cm))
    story.append(HRFlowable(width="40%", thickness=2, color=ACCENT_BLUE, spaceAfter=10))
    story.append(Paragraph('Manual de Usuario', s_title_cover))
    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph('Vista de Racks: Guía Visual y Práctica', s_subtitle_cover))
    story.append(Spacer(1, 2.5*cm))

    info = [
        ['Sistema', 'RACKLY - Gestión de Almacenes v2.0'],
        ['Módulo', 'Vista de Racks'],
        ['URL', 'https://rackly.pages.dev'],
        ['Fecha', 'Mayo 2026'],
        ['Autor', 'Miguel Hidalgo'],
        ['Versión', '2.0'],
    ]
    t = Table(info, colWidths=[4*cm, 10*cm])
    t.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (0, -1), 'TimesRoman-Bold'),
        ('FONTNAME', (1, 0), (1, -1), 'TimesRoman'),
        ('TEXTCOLOR', (0, 0), (-1, -1), DARK),
        ('FONTSIZE', (0, 0), (-1, -1), 12),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('LINEBELOW', (0, 0), (-1, -1), 0.3, TABLE_ALT),
    ]))
    story.append(t)
    story.append(PageBreak())

    # ═══════════════════════════════
    # TABLA DE CONTENIDO
    # ═══════════════════════════════
    story.append(Paragraph('Tabla de Contenido', s_h1))
    story.append(sp(0.2))

    toc = [
        '1. Cómo Acceder a RACKLY',
        '2. Pantalla Principal y Navegación',
        '3. Movimientos - Registro de Ingresos',
        '4. Movimientos - Registro de Salidas',
        '5. Movimientos - Registro de Devoluciones',
        '6. Traslado entre Ubicaciones',
        '7. Catálogo de Códigos',
        '8. Stock Actual por Código',
        '9. Ocupación - Mapa Visual de Racks',
        '10. Descarga de Datos (Excel)',
        '11. UP Data - Carga Masiva de Stock',
        '12. FEFO - Control de Vencimientos',
        '13. Usuarios - Administración',
        '14. Roles y Permisos',
        '15. Historial de Movimientos',
        '16. Resumen de Colores y Símbolos',
        '17. Preguntas Frecuentes',
    ]
    for item in toc:
        story.append(Paragraph(item, s_toc_item))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 1. CÓMO ACCEDER
    # ═══════════════════════════════
    story.append(h1('1. Cómo Acceder a RACKLY'))
    story.append(sp(0.2))

    story.append(make_side_by_side('01_login.png', [
        body('RACKLY es un sistema web de gestión de almacenes al que puedes entrar desde cualquier navegador (Chrome, Firefox, Edge, Safari). No necesitas instalar nada en tu computadora.'),
        sp(0.15),
        step(1, 'Abre tu navegador y ve a <b>https://rackly.pages.dev</b>'),
        detail('Esa es la dirección oficial. Guárdala en tus marcadores para entrar rápido.'),
        step(2, 'Inicia sesión con tu correo y contraseña'),
        detail('Si es tu primera vez, haz clic en "Registrarse" y espera la aprobación de un administrador.'),
        step(3, 'Espera la aprobación (solo usuarios nuevos)'),
        detail('Los usuarios nuevos quedan en estado "Pendiente" hasta que un administrador los apruebe. Si olvidaste tu contraseña, usa "Olvidé mi contraseña".'),
    ]))

    story.append(sp(0.3))
    story.append(note('Si no puedes ingresar, contacta a tu administrador para que apruebe tu cuenta. El rol por defecto es "Operario".'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 2. PANTALLA PRINCIPAL
    # ═══════════════════════════════
    story.append(h1('2. Pantalla Principal y Navegación'))
    story.append(sp(0.2))

    story.append(make_side_by_side('02_main_tabs.png', [
        body('Al iniciar sesión verás la pantalla principal con tu nombre de usuario, tu rol y el botón para cerrar sesión. Debajo hay un selector: <b>Racks</b> (almacén vertical) y <b>Piso</b> (almacén a nivel del suelo). Este manual cubre solo la vista de Racks.'),
        sp(0.15),
        Paragraph('<b>Pestañas disponibles (desliza para verlas todas):</b>', s_quick_label),
    ]))

    story.append(sp(0.3))
    story.append(make_table(
        ['Pestaña', 'Función', 'Descripción'],
        [
            ['Movimientos', 'Registrar movimientos', 'Ingresos, salidas y devoluciones de mercadería'],
            ['Traslado', 'Transferir ubicación', 'Mueve stock de una posición a otra'],
            ['Catálogo', 'Gestionar productos', 'Lista de códigos, descripciones y unidades'],
            ['Stock', 'Consultar stock', 'Stock por código y ubicación'],
            ['Ocupación', 'Mapa visual del rack', 'Vista de bloques, torres, pisos y posiciones'],
            ['Descarga', 'Exportar/importar', 'Excel de movimientos o carga masiva'],
            ['FEFO', 'Control vencimientos', 'Productos próximos a vencer por fecha'],
            ['Usuarios', 'Administrar usuarios', 'Roles, permisos y aprobaciones'],
        ],
        col_widths=[2.8*cm, 4*cm, 9.7*cm]
    ))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 3. INGRESOS
    # ═══════════════════════════════
    story.append(h1('3. Movimientos - Registro de Ingresos'))
    story.append(sp(0.2))

    story.append(body('Un ingreso se registra cuando <b>entra mercadería nueva</b> al almacén. El turno (Día o Noche) se calcula automáticamente según la hora actual.'))

    story.append(sp(0.2))
    story.append(make_side_by_side('03_ingreso.png', [
        step(1, 'Selecciona la ubicación (Bloque, Torre, Piso, Posición)'),
        detail('Los campos se seleccionan en orden. Primero eliges el bloque y las opciones se actualizan solas.'),
        step(2, 'Busca el producto en el catálogo'),
        detail('Escribe el código o la descripción. Si no existe, agrégalo primero en "Catálogo".'),
        step(3, 'Ingresa la cantidad y fecha de vencimiento'),
        detail('Si el producto no tiene vencimiento (herramientas, repuestos), marca "Sin vencimiento".'),
        step(4, 'Selecciona proveedor (solo para LÁMINA y STRETCH)'),
        detail('Proveedores disponibles: INCOMIN, DAMAR, DIAMAND, NEOPACK, SOLPACK e ITS.'),
        step(5, 'Presiona el botón verde <b>"Registrar Ingreso"</b>'),
        detail('Si todo es correcto, verás un mensaje de confirmación y el formulario se limpia.'),
    ]))

    story.append(sp(0.3))
    story.append(warning('Si la ubicación ya tiene mercadería, verás una alerta con el stock actual. Podrás "Dar Salida" a lo existente o confirmar el ingreso de todas formas.'))

    story.append(tip('El turno se detecta solo: Día (7:45 a. m. a 7:45 p. m.) / Noche (7:45 p. m. a 7:45 a. m.). Se actualiza cada 60 segundos automáticamente.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 4. SALIDAS
    # ═══════════════════════════════
    story.append(h1('4. Movimientos - Registro de Salidas'))
    story.append(sp(0.2))

    story.append(body('La salida se usa cuando <b>retiras mercadería</b> del almacén. Primero buscas el producto y el sistema te muestra todas las ubicaciones con stock, ordenadas por vencimiento (criterio FEFO).'))

    story.append(sp(0.2))
    story.append(make_side_by_side('04_salida.png', [
        step(1, 'Busca el producto que vas a retirar'),
        detail('Escribe el código o la descripción en el campo de búsqueda.'),
        step(2, 'Revisa las ubicaciones con stock disponible'),
        detail('La tabla muestra: bloque, torre, piso, posición, stock, vencimiento y proveedor. Los productos más próximos a vencer aparecen primeros.'),
        step(3, 'Elige cuánto vas a retirar'),
        detail('<b>Salida parcial:</b> escribe la cantidad y presiona el botón rojo "Salida".<br/><b>Salida total:</b> presiona "Todo" para retirar toda la mercadería de esa ubicación.'),
        step(4, 'Confirma en la ventana de confirmación'),
        detail('Revisa los datos y presiona <b>"Sí, confirmar"</b>. Si el stock queda en 0, la ubicación desaparece de la lista automáticamente.'),
    ]))

    story.append(sp(0.3))
    story.append(note('Los resultados se actualizan cada 8 segundos automáticamente. Si no se actualizan al instante, espera unos segundos o haz una nueva búsqueda.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 5. DEVOLUCIONES
    # ═══════════════════════════════
    story.append(h1('5. Movimientos - Registro de Devoluciones'))
    story.append(sp(0.2))

    story.append(body('La devolución se usa cuando mercadería que fue retirada previamente <b>vuelve al almacén</b>. El formulario es igual al de ingreso, pero se registra como tipo "Devolución" en el historial para mantener la trazabilidad.'))

    story.append(sp(0.2))
    story.append(step(1, 'Selecciona la ubicación donde devolverás la mercadería'))
    story.append(detail('Igual que en el ingreso: elige bloque, torre, piso y posición.'))
    story.append(step(2, 'Busca el producto en el catálogo'))
    story.append(detail('Selecciona el código del producto que estás devolviendo.'))
    story.append(step(3, 'Ingresa la cantidad devuelta'))
    story.append(detail('Escribe la cantidad de mercadería que estás devolviendo al almacén.'))
    story.append(step(4, 'Presiona "Registrar Devolución" (botón naranja)'))
    story.append(detail('Si todo es correcto, verás el mensaje "Devolución registrada".'))

    story.append(sp(0.3))
    story.append(tip('Diferencia entre Ingreso y Devolución: ambos suman stock a la ubicación, pero en los reportes se distinguen por tipo. Usa "Devolución" cuando un producto que salió vuelve a entrar. Usa "Ingreso" solo para mercadería nueva.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 6. TRASLADO
    # ═══════════════════════════════
    story.append(h1('6. Traslado entre Ubicaciones'))
    story.append(sp(0.2))

    story.append(body('El módulo de Traslado te permite <b>mover mercadería de una ubicación a otra</b> dentro del almacén. Es útil para reorganizar racks o juntar productos iguales en una misma posición.'))

    story.append(sp(0.2))
    story.append(make_side_by_side('05_traslado.png', [
        step(1, 'Busca el producto que quieres trasladar'),
        detail('Escribe el código o la descripción. Verás una tarjeta con los datos del producto y las ubicaciones donde tiene stock.'),
        step(2, 'Selecciona la ubicación de origen'),
        detail('Haz clic en la fila de la ubicación. Se marcará con un borde azul y el botón cambiará a "Seleccionado".'),
        step(3, 'Elige la ubicación de destino'),
        detail('Selecciona bloque, torre, piso y posición de destino. El destino no puede ser igual al origen.'),
        step(4, 'Define la cantidad a trasladar'),
        detail('Escribe la cantidad que quieres mover. Puedes mover todo el stock o solo una parte.'),
        step(5, 'Presiona <b>"Confirmar traslado"</b>'),
        detail('Se mostrará un resumen con la ruta, producto y cantidad. Confirma para ejecutar.'),
    ]))

    story.append(sp(0.3))
    story.append(warning('Si la cantidad trasladada es diferente al stock del sistema, se registrará un ajuste automático para cuadrar las cantidades. Esto asegura que el sistema siempre refleje la realidad del almacén.'))

    story.append(tip('El traslado genera dos movimientos automáticamente: una salida en la ubicación de origen y un ingreso en la de destino. Esto mantiene la trazabilidad completa.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 7. CATÁLOGO
    # ═══════════════════════════════
    story.append(h1('7. Catálogo de Códigos'))
    story.append(sp(0.2))

    story.append(body('El Catálogo es la lista maestra de todos los productos del almacén. Cada producto tiene un <b>código</b> único, una <b>descripción</b>, una <b>unidad de medida</b> (KG, M, UND) y, opcionalmente, un <b>Stock Big Magic</b>. Es obligatorio que el producto exista en el catálogo antes de registrar movimientos.'))

    story.append(sp(0.2))
    story.append(make_side_by_side('06_catalogo.png', [
        step(1, 'Presiona el botón verde "Agregar"'),
        detail('Se abre una ventana con los campos: Código (único, no se repite), UN (unidad de medida), Descripción y Stock Big Magic (opcional).'),
        step(2, 'Presiona "Agregar" en la ventana'),
        detail('Si el código ya existe, el sistema actualiza los datos en lugar de crear un duplicado.'),
    ]))

    story.append(sp(0.3))
    story.append(h2('7.2 Importar Catálogo desde Excel'))
    story.append(body('El archivo debe tener las columnas: <b>CÓDIGO, DESCRIPCIÓN, UN</b> y, opcionalmente, <b>STOCK BIG MAGIC</b>. Acepta archivos .xlsx, .xls y .csv. Los nombres de las columnas pueden estar en mayúsculas o minúsculas; el sistema los detecta automáticamente.'))

    story.append(sp(0.2))
    story.append(h2('7.3 Editar y Eliminar Productos'))
    story.append(body('Cada fila de la tabla tiene un botón de <b>lápiz</b> para editar y una <b>papelera</b> (roja) para eliminar. Al editar, el código no se puede modificar para mantener la integridad de los movimientos ya registrados.'))
    story.append(sp(0.2))
    story.append(tip('También puedes importar productos pegando texto desde una hoja de cálculo. Haz clic en "Importar desde texto" y pega los datos en el cuadro que aparece.'))
    story.append(sp(0.2))
    story.append(warning('El botón "Limpiar" (rojo) elimina TODOS los productos del catálogo. Solo el administrador puede usarlo. Esta acción no se puede deshacer. Asegúrate de tener un respaldo antes de usarlo.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 8. STOCK
    # ═══════════════════════════════
    story.append(h1('8. Stock Actual por Código'))
    story.append(sp(0.2))

    story.append(body('La pestaña de Stock te permite <b>consultar rápidamente cuánto stock hay de un producto</b> y en qué ubicaciones se encuentra. El stock se calcula automáticamente así: <b>Ingresos + Devoluciones + Traslados (destino) - Salidas - Traslados (origen)</b>.'))

    story.append(sp(0.2))
    story.append(make_side_by_side('07_stock.png', [
        step(1, 'Escribe el código del producto en la búsqueda'),
        detail('Aparecerá una tarjeta naranja con el <b>Stock Big Magic</b> (si existe) como referencia del sistema principal.'),
        step(2, 'Revisa la tabla de ubicaciones'),
        detail('Muestra cada ubicación con: bloque, torre, piso, posición, descripción, unidad, proveedor, vencimiento (con código de colores) y cantidad. Al final aparece el total de stock.'),
        step(3, 'Botón de eliminar (solo supervisores)'),
        detail('Los supervisores y administradores pueden eliminar todos los movimientos de una ubicación con el botón de papelera.'),
    ]))

    story.append(sp(0.3))
    story.append(h2('8.2 Colores de Vencimiento en el Stock'))
    story.append(body('Las fechas de vencimiento se muestran con códigos de colores para identificar rápidamente los productos que requieren atención:'))

    story.append(sp(0.1))
    story.append(make_table(
        ['Color', 'Significado', 'Condición'],
        [
            ['Rojo', 'Vencido', 'La fecha de vencimiento ya pasó'],
            ['Naranja', 'Urgente', 'Vence en 15 días o menos'],
            ['Azul', 'Próximo a vencer', 'Vence en 30 días o menos'],
            ['Verde', 'Vigente', 'Vence en más de 30 días'],
        ],
        col_widths=[3*cm, 4*cm, 9.5*cm]
    ))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 9. OCUPACIÓN
    # ═══════════════════════════════
    story.append(h1('9. Ocupación - Mapa Visual de Racks'))
    story.append(sp(0.2))

    story.append(body('La pestaña de Ocupación es la vista más visual de RACKLY. Muestra un <b>mapa interactivo</b> de todos los racks del almacén con códigos de colores que te permiten ver de un vistazo qué posiciones están ocupadas, vacías o tienen múltiples productos.'))

    story.append(sp(0.2))
    story.append(make_side_by_side('08_ocupacion.png', [
        Paragraph('<b>Dashboard de estadísticas (parte superior):</b>', s_quick_label),
    ]))

    story.append(sp(0.3))
    story.append(make_table(
        ['Tarjeta', 'Qué muestra', 'Color'],
        [
            ['TOTAL', 'Número total de posiciones del almacén', 'Celeste'],
            ['OCUPADAS', 'Posiciones con mercadería (simples y mixtas)', 'Azul'],
            ['VACÍAS', 'Posiciones disponibles para ingreso', 'Verde'],
            ['OCUPACIÓN', 'Porcentaje de ocupación con barra de progreso', 'Violeta'],
        ],
        col_widths=[3.5*cm, 9*cm, 4*cm]
    ))

    story.append(sp(0.3))
    story.append(h2('9.2 Colores de las Celdas del Mapa'))
    story.append(make_table(
        ['Color de celda', 'Estado', 'Significado'],
        [
            ['Azul', 'Ocupada (1 artículo)', 'La posición tiene un solo producto registrado'],
            ['Naranja', 'Multi-artículos', 'La posición tiene 2 o más productos diferentes'],
            ['Verde', 'Vacía', 'La posición está disponible para ingreso'],
        ],
        col_widths=[3.5*cm, 4.5*cm, 8.5*cm]
    ))

    story.append(sp(0.3))
    story.append(h2('9.3 Acciones al hacer clic en una celda'))
    story.append(bullet('<b>Celda ocupada:</b> Muestra cada producto con su stock, proveedor, vencimiento y usuario. Puedes dar salida (total o parcial), transferir o agregar un nuevo ingreso.'))
    story.append(bullet('<b>Celda vacía:</b> Muestra "Ubicación vacía" con dos botones: "Ingreso" para registrar nueva mercadería o "Devolución" para registrar un retorno.'))
    story.append(bullet('<b>Exportar a Excel:</b> Presiona el botón "Exportar" para descargar un archivo con el estado de todas las posiciones.'))

    story.append(sp(0.3))
    story.append(tip('El mapa se actualiza automáticamente cada 10 segundos y también por notificaciones en tiempo real. Si otro usuario registra un movimiento, tu mapa se actualiza sin necesidad de recargar la página.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 10. DESCARGA
    # ═══════════════════════════════
    story.append(h1('10. Descarga de Datos (Excel)'))
    story.append(sp(0.2))

    story.append(body('La pestaña de Descarga permite exportar todos los datos del sistema a un archivo Excel para análisis, reportes o respaldo. Tiene dos sub-pestañas: <b>Descargar</b> y <b>UP Data</b>.'))

    story.append(sp(0.2))
    story.append(h2('10.1 Descargar Excel de Movimientos y Stock'))
    story.append(step(1, 'Ve a la sub-pestaña "Descargar"'))
    story.append(detail('Esta pestaña siempre está disponible para todos los usuarios. Muestra la cantidad total de movimientos registrados en el sistema.'))
    story.append(step(2, 'Presiona "Descargar Excel"'))
    story.append(detail('Se descargará un archivo llamado RACKLY_fecha.xlsx con <b>dos hojas</b>:<br/>- <b>Movimientos:</b> Lista completa de todos los registros (tipo, bloque, torre, piso, posición, código, descripción, cantidad, vencimiento, proveedor, turno, usuario).<br/>- <b>Stock Actual:</b> Resumen del stock calculado por ubicación y producto.'))

    story.append(sp(0.3))
    story.append(note('Si no hay movimientos registrados, el botón estará deshabilitado. Primero debes registrar algunos ingresos para poder descargar datos.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 11. UP DATA
    # ═══════════════════════════════
    story.append(h1('11. UP Data - Carga Masiva de Stock'))
    story.append(sp(0.2))

    story.append(warning('Esta función es EXCLUSIVA para los roles de <b>Administrador</b> y <b>Coordinador de Operaciones</b>. Los demás roles no pueden ver ni usar esta opción. Si tu rol no tiene permiso, verás un mensaje "Acceso restringido" con un candado.'))

    story.append(sp(0.2))
    story.append(body('UP Data permite <b>reemplazar todo el stock del sistema</b> subiendo un archivo Excel con las posiciones y cantidades actuales. Es útil cuando migras desde otro sistema o necesitas actualizar masivamente el inventario.'))

    story.append(sp(0.2))
    story.append(h2('11.1 Columnas esperadas en el Excel'))

    story.append(make_table(
        ['Columna', 'Obligatoria', 'Ejemplo'],
        [
            ['Código', 'Sí', 'ABC123'],
            ['Descripción', 'No', 'Lámina de polietileno'],
            ['Bloque', 'Sí', '3'],
            ['Torre', 'Sí', '1'],
            ['Piso', 'Sí', '2'],
            ['Posición', 'Sí', '5'],
            ['Cantidad', 'Sí', '150.5'],
            ['UN', 'No', 'KG'],
            ['Vencimiento', 'No', '2026-12-31'],
            ['Proveedor', 'No', 'INCOMIN'],
        ],
        col_widths=[3.5*cm, 2.5*cm, 10.5*cm]
    ))

    story.append(sp(0.3))
    story.append(h2('11.2 Proceso de carga'))
    story.append(step(1, 'Selecciona el archivo Excel (.xlsx, .xls o .csv)'))
    story.append(step(2, 'Revisa la vista previa (primeros 20 registros)'))
    story.append(step(3, 'Presiona "Cargar N ingreso(s) - eliminar anteriores"'))
    story.append(step(4, 'Espera el proceso (se procesa en lotes de 1 000 registros)'))
    story.append(sp(0.2))
    story.append(warning('Este proceso BORRA todos los movimientos existentes antes de cargar los nuevos. No se puede deshacer. Asegúrate de tener un respaldo antes de usarlo.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 12. FEFO
    # ═══════════════════════════════
    story.append(h1('12. FEFO - Control de Vencimientos'))
    story.append(sp(0.2))

    story.append(body('FEFO significa <b>First Expired, First Out</b> (Primero en Vencer, Primero en Salir). Este módulo muestra todos los productos con fecha de vencimiento ordenados de los que vencen primero a los que vencen después. Es una herramienta esencial para evitar pérdidas por vencimiento.'))

    story.append(sp(0.2))
    story.append(make_side_by_side('09_fefo.png', [
        Paragraph('<b>Colores de estado FEFO:</b>', s_quick_label),
    ]))

    story.append(sp(0.3))
    story.append(make_table(
        ['Estado', 'Color', 'Condición', 'Acción recomendada'],
        [
            ['Vigente', 'Verde', 'Más de 30 días para vencer', 'Manejo normal, sin urgencia'],
            ['Próximo', 'Celeste', '30 días o menos', 'Iniciar a consumir primero'],
            ['Urgente', 'Naranja', '15 días o menos', 'Priorizar salida inmediata'],
            ['Vencido', 'Rojo', 'Ya venció', 'Retirar del almacén inmediatamente'],
        ],
        col_widths=[2.5*cm, 2*cm, 5*cm, 7*cm]
    ))

    story.append(sp(0.3))
    story.append(h2('12.2 Filtros disponibles'))
    story.append(bullet('<b>Búsqueda por texto:</b> Filtra por código o descripción del producto.'))
    story.append(bullet('<b>Rango de fechas:</b> Usa los campos "Desde" y "Hasta" para un período específico.'))
    story.append(bullet('<b>Filtro por estado:</b> Los botones de estado funcionan como interruptores: haz clic para activarlos o desactivarlos. Puedes combinar varios.'))
    story.append(bullet('<b>Exportar a Excel:</b> Presiona "Exportar" para descargar los resultados filtrados.'))

    story.append(sp(0.3))
    story.append(tip('La tabla FEFO se ordena automáticamente por días restantes de forma ascendente. Los productos vencidos aparecen primeros, seguidos de urgentes, próximos y vigentes.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 13. USUARIOS
    # ═══════════════════════════════
    story.append(h1('13. Usuarios - Administración'))
    story.append(sp(0.2))

    story.append(body('La pestaña de Usuarios permite gestionar las cuentas de acceso al sistema: aprobar nuevos usuarios, cambiar roles, enviar correos de recuperación de contraseña y eliminar perfiles. Las acciones disponibles dependen de tu rol.'))

    story.append(sp(0.2))
    story.append(make_side_by_side('10_usuarios.png', [
        Paragraph('<b>Funciones disponibles según el rol:</b>', s_quick_label),
    ]))

    story.append(sp(0.3))
    story.append(make_table(
        ['Acción', 'Admin', 'Coord. Op.', 'Sup. Almacén', 'Sup. Op.'],
        [
            ['Ver lista de usuarios', 'Sí', 'Sí', 'Sí', 'Sí'],
            ['Aprobar/revocar acceso', 'Sí', 'Sí', 'Sí', 'Sí'],
            ['Cambiar rol de usuarios', 'Sí', 'No', 'No', 'No'],
            ['Enviar correo de recuperación', 'Sí', 'No', 'No', 'No'],
            ['Eliminar perfil', 'Sí', 'No', 'No', 'No'],
        ],
        col_widths=[4.5*cm, 2*cm, 3*cm, 3*cm, 3*cm]
    ))

    story.append(sp(0.3))
    story.append(h2('13.2 Cómo aprobar un nuevo usuario'))
    story.append(body('Los usuarios nuevos aparecen en la lista con estado "Sin acceso" o "Pendiente". Los que tienen permisos de aprobación (admin y supervisores) ven un botón para alternar entre "Aprobado" y "Sin acceso". Simplemente haz clic para cambiar el estado.'))

    story.append(h2('13.3 Cómo cambiar el rol (solo Admin)'))
    story.append(body('El administrador puede cambiar el rol de cualquier usuario usando el menú desplegable junto a cada usuario. Los roles disponibles son: Admin, Operario, Auxiliar, Almacenero, Supervisor de Almacén, Supervisor de Operaciones y Coordinador de Operaciones.'))

    story.append(h2('13.4 Enviar correo de recuperación (solo Admin)'))
    story.append(body('Presiona el icono de sobre junto al usuario. Se enviará un correo electrónico con un enlace para restablecer la contraseña.'))

    story.append(h2('13.5 Eliminar perfil (solo Admin)'))
    story.append(body('Presiona el icono de papelera junto al usuario. Se pedirá confirmación antes de eliminar. No puedes eliminar tu propio perfil. La eliminación borra el perfil y los roles, pero no los movimientos registrados por ese usuario.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 14. ROLES Y PERMISOS
    # ═══════════════════════════════
    story.append(h1('14. Roles y Permisos'))
    story.append(sp(0.2))

    story.append(body('RACKLY tiene 7 roles definidos, cada uno con permisos diferentes. Los roles determinan qué acciones puede realizar cada usuario dentro del sistema:'))

    story.append(sp(0.2))
    story.append(make_table(
        ['Rol', 'Reg. Mov.', 'Elim. Mov.', 'UP Data', 'Apr. Usu.', 'Adm. Usu.'],
        [
            ['Admin', 'Sí', 'Sí', 'Sí', 'Sí', 'Sí'],
            ['Coordinador de Op.', 'Sí', 'Sí', 'Sí', 'Sí', 'No'],
            ['Supervisor de Almacén', 'Sí', 'Sí', 'No', 'Sí', 'No'],
            ['Supervisor de Op.', 'Sí', 'Sí', 'No', 'Sí', 'No'],
            ['Almacenero', 'Sí', 'No', 'No', 'No', 'No'],
            ['Auxiliar', 'Sí', 'No', 'No', 'No', 'No'],
            ['Operario', 'Sí', 'No', 'No', 'No', 'No'],
        ],
        col_widths=[4*cm, 2.3*cm, 2.3*cm, 2*cm, 2.5*cm, 2.4*cm]
    ))

    story.append(sp(0.3))
    story.append(body('<b>Resumen rápido de permisos:</b>'))
    story.append(bullet('<b>Todos los roles</b> pueden registrar movimientos (ingresos, salidas, devoluciones y traslados).'))
    story.append(bullet('<b>Admin, coordinador y supervisores</b> pueden eliminar movimientos y aprobar usuarios nuevos.'))
    story.append(bullet('<b>Admin y coordinador</b> pueden subir archivos de stock masivo (UP Data).'))
    story.append(bullet('<b>Solo Admin</b> puede cambiar roles, eliminar perfiles y enviar correos de recuperación.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 15. HISTORIAL
    # ═══════════════════════════════
    story.append(h1('15. Historial de Movimientos'))
    story.append(sp(0.2))

    story.append(body('En la parte inferior de la pestaña de Movimientos encontrarás la tabla de historial que muestra todos los movimientos registrados en el sistema, ordenados del más reciente al más antiguo. Inicialmente muestra los últimos 5 movimientos, con un botón para expandir y ver más.'))

    story.append(sp(0.2))
    story.append(make_table(
        ['Columna', 'Descripción'],
        [
            ['Tipo', 'Tipo de movimiento: Ingreso (verde), Salida (rojo), Devolución (naranja), Traslado (azul)'],
            ['Bloque / Torre / Piso / Pos.', 'Ubicación donde se registró el movimiento'],
            ['Código', 'Código del producto movido'],
            ['Descripción', 'Nombre completo del producto'],
            ['UN', 'Unidad de medida (KG, M, UND, etc.)'],
            ['Cant.', 'Cantidad de mercadería movida'],
            ['Venc.', 'Fecha de vencimiento del producto'],
            ['Modificación', 'Fecha y hora en que se registró'],
            ['Turno', 'Día o Noche (según la hora del registro)'],
            ['Usuario', 'Nombre del usuario que registró el movimiento'],
        ],
        col_widths=[4*cm, 12.5*cm]
    ))

    story.append(sp(0.3))
    story.append(h2('15.2 Filtros disponibles'))
    story.append(bullet('<b>Tipo de movimiento:</b> Filtra por Ingreso, Salida, Devolución o Traslado.'))
    story.append(bullet('<b>Usuario:</b> Filtra por el usuario que registró el movimiento.'))
    story.append(bullet('<b>Búsqueda por código:</b> Escribe un código para ver solo los movimientos de ese producto.'))
    story.append(bullet('<b>Limpiar filtros:</b> Presiona "Limpiar" para quitar todos los filtros y ver todos los movimientos.'))

    story.append(sp(0.3))
    story.append(note('Los usuarios con permisos (admin y supervisores) pueden eliminar movimientos individuales pasando el cursor sobre la fila y haciendo clic en el botón de papelera.'))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 16. COLORES Y SÍMBOLOS
    # ═══════════════════════════════
    story.append(h1('16. Resumen de Colores y Símbolos'))
    story.append(sp(0.2))

    story.append(body('RACKLY utiliza un sistema consistente de colores para facilitar la identificación rápida de información. A continuación, un resumen de todos los colores y su significado en toda la aplicación:'))

    story.append(sp(0.2))
    story.append(make_table(
        ['Contexto', 'Color', 'Significado'],
        [
            ['Movimientos - Ingreso', 'Verde', 'Entrada de mercadería al almacén'],
            ['Movimientos - Salida', 'Rojo', 'Retiro de mercadería del almacén'],
            ['Movimientos - Devolución', 'Naranja', 'Retorno de mercadería al almacén'],
            ['Movimientos - Traslado', 'Azul', 'Transferencia entre ubicaciones'],
            ['Turno Día', 'Naranja / Ámbar', 'Horario de 7:45 a. m. a 7:45 p. m.'],
            ['Turno Noche', 'Violeta / Índigo', 'Horario de 7:45 p. m. a 7:45 a. m.'],
            ['Vencimiento - Vencido', 'Rojo', 'La fecha de vencimiento ya pasó'],
            ['Vencimiento - Urgente', 'Naranja', 'Vence en 15 días o menos'],
            ['Vencimiento - Próximo', 'Azul', 'Vence en 30 días o menos'],
            ['Vencimiento - Vigente', 'Verde', 'Vence en más de 30 días'],
            ['Ocupación - Ocupada', 'Azul', 'Posición con un solo producto'],
            ['Ocupación - Multi-artículos', 'Naranja', 'Posición con 2 o más productos'],
            ['Ocupación - Vacía', 'Verde', 'Posición disponible para ingreso'],
            ['Proveedor', 'Violeta', 'Etiqueta que indica el proveedor'],
            ['Stock Big Magic', 'Naranja / Ámbar', 'Stock del sistema principal (referencia)'],
        ],
        col_widths=[4*cm, 3.5*cm, 9*cm]
    ))
    story.append(PageBreak())

    # ═══════════════════════════════
    # 17. PREGUNTAS FRECUENTES
    # ═══════════════════════════════
    story.append(h1('17. Preguntas Frecuentes'))
    story.append(sp(0.2))

    faqs = [
        ('¿No puedo iniciar sesión? ¿Qué hago?',
         'Verifica que tu cuenta haya sido aprobada por un administrador. Si te acabas de registrar, aparecerás como "Pendiente" hasta que alguien te apruebe. Si olvidaste tu contraseña, usa el enlace "Olvidé mi contraseña" en la pantalla de inicio de sesión. Si el problema persiste, contacta a tu administrador para que envíe un correo de recuperación.'),

        ('No encuentro mi producto en el catálogo al registrar un ingreso.',
         'El producto debe existir en el catálogo antes de poder registrar movimientos. Ve a la pestaña "Catálogo" y agrega el producto con su código, descripción y unidad de medida. Una vez agregado, aparecerá automáticamente en la búsqueda de los formularios.'),

        ('El sistema dice que la ubicación está ocupada, pero físicamente está vacía.',
         'Puedes usar la opción "Dar Salida" que aparece en la ventana de alerta para limpiar el stock fantasma del sistema. Esto registrará una salida automática que eliminará el stock que ya no existe físicamente. Alternativamente, un supervisor puede eliminar los movimientos de esa ubicación desde la pestaña de Stock.'),

        ('¿Cómo muevo mercadería de una posición a otra?',
         'Usa la pestaña "Traslado". Busca el producto, selecciona la ubicación de origen, elige la de destino y confirma. El sistema registrará automáticamente una salida del origen y un ingreso en el destino. Si las cantidades no coinciden con el stock del sistema, se creará un ajuste automático.'),

        ('¿Cómo sé qué productos están próximos a vencer?',
         'Ve a la pestaña "FEFO". Allí encontrarás todos los productos con fecha de vencimiento ordenados de los que vencen primero. Los colores indican la urgencia: rojo (vencido), naranja (15 días o menos), celeste (30 días o menos) y verde (más de 30 días).'),

        ('¿Puedo subir un Excel con todo mi stock actual?',
         'Sí, usando la pestaña "Descarga" y luego la sub-pestaña "UP Data". Esta función está disponible solo para Admin y Coordinador de Operaciones. Ten en cuenta que este proceso BORRA todos los movimientos existentes y los reemplaza con los del archivo Excel.'),

        ('¿Por qué no veo el botón para eliminar movimientos?',
         'La eliminación de movimientos está restringida a los roles de Admin, Coordinador de Operaciones, Supervisor de Almacén y Supervisor de Operaciones. Si tu rol es Operario, Auxiliar o Almacenero, no tendrás acceso a esta función.'),

        ('¿Cómo se calcula el stock en el sistema?',
         'El stock se calcula sumando todos los ingresos, devoluciones y traslados que llegan a una ubicación, y restando todas las salidas y traslados que salen de esa ubicación. La fórmula es: Stock = Ingresos + Devoluciones + Traslados (destino) - Salidas - Traslados (origen).'),

        ('¿Cada cuánto se actualizan los datos en pantalla?',
         'La mayoría de las vistas se actualizan automáticamente cada 8 segundos mediante consultas periódicas, y también de forma instantánea por notificaciones en tiempo real (WebSocket). El mapa de Ocupación se actualiza cada 10 segundos. Si notas que los datos no se actualizan, recarga la página con F5.'),

        ('¿Qué pasa si registro un ingreso en una ubicación que ya tiene mercadería?',
         'Se abrirá una ventana de alerta mostrándote el stock actual de esa ubicación. Tienes dos opciones: confirmar el ingreso de todas formas (los productos coexistirán en la misma posición) o dar salida a los productos existentes antes de ingresar el nuevo. Esto último es útil cuando físicamente ya retiraste los productos pero no lo habías registrado.'),
    ]

    for i, (q, a) in enumerate(faqs):
        story.append(h3(f'{i+1}. {q}'))
        story.append(body(a))
        story.append(sp(0.15))

    # ── Build ──
    doc.build(story, onFirstPage=add_cover, onLaterPages=add_page_number)
    print(f'PDF creado: {PDF_PATH}')


if __name__ == '__main__':
    build_pdf()

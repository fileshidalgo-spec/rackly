#!/usr/bin/env python3
"""Generate RACKLY 5S Document (PDF)."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                 PageBreak, Image, KeepTogether, HRFlowable)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
import os

# ── Register fonts ──
pdfmetrics.registerFont(TTFont('NotoSans', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
pdfmetrics.registerFont(TTFont('NotoSans-Bold', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))

OUT = '/home/z/my-project/download'
PDF_PATH = os.path.join(OUT, 'RACKLY_Documento_5S.pdf')

# ── Colors ──
BG_DARK = HexColor('#0F172A')
BG_CARD = HexColor('#1E293B')
ACCENT_BLUE = HexColor('#3B82F6')
ACCENT_GREEN = HexColor('#22C55E')
ACCENT_ORANGE = HexColor('#F59E0B')
ACCENT_RED = HexColor('#EF4444')
ACCENT_PURPLE = HexColor('#8B5CF6')
ACCENT_CYAN = HexColor('#06B6D4')
ACCENT_PINK = HexColor('#EC4899')
TEXT_LIGHT = HexColor('#E2E8F0')
TEXT_MUTED = HexColor('#94A3B8')
BORDER_SUBTLE = HexColor('#334155')

# ── Styles ──
styles = getSampleStyleSheet()

title_style = ParagraphStyle('Title', parent=styles['Title'],
    fontName='NotoSans-Bold', fontSize=28, textColor=ACCENT_BLUE,
    spaceAfter=6, alignment=TA_CENTER)

subtitle_style = ParagraphStyle('Subtitle', parent=styles['Normal'],
    fontName='NotoSans', fontSize=13, textColor=TEXT_MUTED,
    spaceAfter=20, alignment=TA_CENTER)

h1_style = ParagraphStyle('H1', parent=styles['Heading1'],
    fontName='NotoSans-Bold', fontSize=20, textColor=ACCENT_BLUE,
    spaceBefore=20, spaceAfter=12, borderWidth=0, borderPadding=0)

h2_style = ParagraphStyle('H2', parent=styles['Heading2'],
    fontName='NotoSans-Bold', fontSize=15, textColor=ACCENT_CYAN,
    spaceBefore=16, spaceAfter=8)

h3_style = ParagraphStyle('H3', parent=styles['Heading3'],
    fontName='NotoSans-Bold', fontSize=12, textColor=ACCENT_GREEN,
    spaceBefore=12, spaceAfter=6)

body_style = ParagraphStyle('Body', parent=styles['Normal'],
    fontName='NotoSans', fontSize=10, textColor=TEXT_LIGHT,
    spaceAfter=8, leading=15, alignment=TA_JUSTIFY)

bullet_style = ParagraphStyle('Bullet', parent=body_style,
    leftIndent=20, bulletIndent=10, spaceAfter=4)

code_style = ParagraphStyle('Code', parent=styles['Code'],
    fontName='NotoSans', fontSize=8, textColor=HexColor('#A78BFA'),
    backColor=HexColor('#1E1B4B'), borderWidth=1, borderColor=BORDER_SUBTLE,
    borderPadding=6, spaceAfter=8, leftIndent=10)

caption_style = ParagraphStyle('Caption', parent=styles['Normal'],
    fontName='NotoSans', fontSize=8, textColor=TEXT_MUTED,
    spaceAfter=12, alignment=TA_CENTER, italic=True)


def create_table_data(headers, rows, col_widths=None):
    """Create a styled table."""
    data = [headers] + rows
    if col_widths is None:
        col_widths = [16*cm / len(headers)] * len(headers)
    
    t = Table(data, colWidths=col_widths, repeatRows=1)
    style = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), HexColor('#1E3A5F')),
        ('TEXTCOLOR', (0, 0), (-1, 0), ACCENT_BLUE),
        ('FONTNAME', (0, 0), (-1, 0), 'NotoSans-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 9),
        ('FONTNAME', (0, 1), (-1, -1), 'NotoSans'),
        ('FONTSIZE', (0, 1), (-1, -1), 8),
        ('TEXTCOLOR', (0, 1), (-1, -1), TEXT_LIGHT),
        ('BACKGROUND', (0, 1), (-1, -1), BG_CARD),
        ('GRID', (0, 0), (-1, -1), 0.5, BORDER_SUBTLE),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [BG_CARD, HexColor('#0F2440')]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ])
    t.setStyle(style)
    return t


def add_image_centered(path, width=16*cm):
    """Add an image centered."""
    if os.path.exists(path):
        img = Image(path, width=width, height=width * 0.65)
        img.hAlign = 'CENTER'
        return [img, Paragraph(path.split('/')[-1], caption_style)]
    return [Paragraph(f'[Imagen no encontrada: {path}]', body_style)]


def build_pdf():
    doc = SimpleDocTemplate(PDF_PATH, pagesize=A4,
        topMargin=1.5*cm, bottomMargin=1.5*cm,
        leftMargin=2*cm, rightMargin=2*cm)

    story = []

    # ═══════════════════════════════════════════════════════
    # COVER PAGE
    # ═══════════════════════════════════════════════════════
    story.append(Spacer(1, 4*cm))
    story.append(Paragraph('RACKLY', title_style))
    story.append(Paragraph('Metodologia 5S Aplicada al Proyecto', subtitle_style))
    story.append(Spacer(1, 0.5*cm))

    # 5S visual
    img_path = os.path.join(OUT, 'RACKLY_Mapa_5S_Resumen.png')
    story.extend(add_image_centered(img_path, width=16*cm))

    story.append(Spacer(1, 1*cm))
    story.append(HRFlowable(width="80%", thickness=1, color=ACCENT_BLUE, spaceAfter=12))

    info_data = [
        ['Proyecto:', 'RACKLY - Gestion de Almacen'],
        ['Version:', '2.0'],
        ['Fecha:', '25 de Mayo, 2026'],
        ['Tecnologia:', 'Next.js 16 + Supabase + Cloudflare Pages'],
        ['URL Produccion:', 'https://rackly.pages.dev'],
        ['Metodologia:', '5S (Seiri, Seiton, Seiso, Seiketsu, Shitsuke)'],
    ]
    t = Table(info_data, colWidths=[4*cm, 12*cm])
    t.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (0, -1), 'NotoSans-Bold'),
        ('FONTNAME', (1, 0), (1, -1), 'NotoSans'),
        ('TEXTCOLOR', (0, 0), (0, -1), ACCENT_CYAN),
        ('TEXTCOLOR', (1, 0), (1, -1), TEXT_LIGHT),
        ('FONTSIZE', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    story.append(t)

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # TABLE OF CONTENTS
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('Contenido', h1_style))
    story.append(Spacer(1, 0.3*cm))

    toc_items = [
        '1. Introduccion a la Metodologia 5S',
        '2. Estado Actual del Proyecto',
        '3. S1 - CLASIFICAR (Seiri)',
        '4. S2 - ORDENAR (Seiton)',
        '5. S3 - LIMPIAR (Seiso)',
        '6. S4 - ESTANDARIZAR (Seiketsu)',
        '7. S5 - MANTENER (Shitsuke)',
        '8. Mapa de Arquitectura del Sistema',
        '9. Mapa de Flujo de Datos',
        '10. Mapa de Integracion de Modulos',
        '11. Plan de Accion y Prioridades',
        '12. Conclusiones',
    ]
    for item in toc_items:
        story.append(Paragraph(item, ParagraphStyle('TOC', parent=body_style,
            leftIndent=20, spaceAfter=4, textColor=ACCENT_CYAN)))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 1. INTRODUCTION
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('1. Introduccion a la Metodologia 5S', h1_style))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph(
        'La metodologia 5S es una tecnica japonesa de gestion de calidad desarrollada por Toyota como parte del '
        'Sistema de Produccion Toyota (TPS). Su objetivo es crear y mantener un entorno de trabajo organizado, '
        'limpio y eficiente que permita maximizar la productividad y minimizar los desperdicios. Las cinco "S" '
        'provienen de terminos japoneses que representan cinco pasos fundamentales para la mejora continua.',
        body_style))

    story.append(Paragraph(
        'En el contexto de desarrollo de software, la metodologia 5S se adapta para organizar el codigo fuente, '
        'la estructura de archivos, las dependencias, la documentacion y los procesos de despliegue. Un proyecto '
        'de software "limpio" segun 5S es aquel donde cada archivo tiene un proposito claro, no existe codigo '
        'muerto o redundante, las convenciones son consistentes, y el equipo puede mantener y escalar el sistema '
        'sin fricciones innecesarias.',
        body_style))

    # 5S table
    s5_table = create_table_data(
        ['Paso', 'Termino Japones', 'Significado en Espanol', 'Aplicacion en Software'],
        [
            ['S1', 'Seiri', 'Clasificar', 'Eliminar codigo muerto, dependencias obsoletas, archivos no utilizados'],
            ['S2', 'Seiton', 'Ordenar', 'Organizar estructura de carpetas, naming conventions, modulo cohesion'],
            ['S3', 'Seiso', 'Limpiar', 'Corregir bugs, vulnerabilidades, inconsistencias en los tipos'],
            ['S4', 'Seiketsu', 'Estandarizar', 'Crear patrones reutilizables, actualizar documentacion, convenciones unicas'],
            ['S5', 'Shitsuke', 'Mantener', 'Disciplina en el equipo, code review, save points, documentacion viva'],
        ],
        col_widths=[1.5*cm, 2.5*cm, 4*cm, 8*cm]
    )
    story.append(s5_table)
    story.append(Spacer(1, 0.5*cm))

    story.append(Paragraph(
        'Este documento aplica la metodologia 5S al proyecto RACKLY, un sistema de gestion de almacen desarrollado '
        'con Next.js 16, Supabase y desplegado en Cloudflare Pages. El analisis abarca tanto la estructura del '
        'codigo como la arquitectura de datos, los flujos de informacion y los mapas de integracion entre modulos. '
        'El objetivo final es que RACKLY funcione de la mejor manera posible, con un codigo limpio, organizado y '
        'facil de mantener y escalar.',
        body_style))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 2. CURRENT STATE
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('2. Estado Actual del Proyecto', h1_style))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph(
        'RACKLY es un sistema completo de gestion de almacen que actualmente cuenta con mas de 7,000 lineas de '
        'codigo distribuidas en 39 archivos fuente. La aplicacion se divide en dos vistas principales: la vista de '
        'Racks (con 8 modulos funcionales) y la vista de Piso (con 4 modulos). Utiliza Supabase como backend, '
        'con 13 tablas de base de datos y 5 funciones RPC (Remote Procedure Call) para operaciones complejas.',
        body_style))

    story.append(Paragraph('2.1 Estructura Tecnica General', h2_style))

    tech_table = create_table_data(
        ['Componente', 'Tecnologia', 'Version', 'Proposito'],
        [
            ['Frontend', 'Next.js', '16.1.3', 'Framework React con exportacion estatica'],
            ['Estilos', 'Tailwind CSS', '4.x', 'Framework de utilidades CSS'],
            ['UI Components', 'shadcn/ui', '-', 'Componentes pre-construidos'],
            ['Backend', 'Supabase', 'Cloud', 'Base de datos + Auth + Realtime'],
            ['Base de Datos', 'PostgreSQL', '15.x', '13 tablas, 5 funciones RPC'],
            ['Hosting', 'Cloudflare Pages', '-', 'CDN global, deploy desde Git'],
            ['Lenguaje', 'TypeScript', '5.x', 'Tipado estatico'],
            ['Control de Versiones', 'Git + GitHub', '-', '14 save points (JHIA1-JHIA11.14)'],
        ],
        col_widths=[3.5*cm, 3.5*cm, 2.5*cm, 7*cm]
    )
    story.append(tech_table)
    story.append(Spacer(1, 0.5*cm))

    story.append(Paragraph('2.2 Modulos Implementados', h2_style))

    story.append(Paragraph(
        'La aplicacion cuenta con 12 modulos funcionales divididos en dos vistas. La vista de Racks gestiona '
        'las operaciones de almacenaje vertical (bloques con torres, pisos y posiciones), mientras que la vista '
        'de Piso gestiona las operaciones a nivel de suelo (sectores con columnas, subcolumnas y niveles). Cada '
        'modulo tiene responsabilidades especificas y se conecta con las tablas de base de datos correspondientes.',
        body_style))

    mod_table = create_table_data(
        ['Vista', 'Modulo', 'Componente', 'Tablas Usadas', 'Lineas'],
        [
            ['Racks', 'Movimientos', 'MovimientoForm.tsx', 'movimientos, catalogo', '902'],
            ['Racks', 'Traslado', 'TrasladoTab.tsx', 'movimientos, catalogo', '720'],
            ['Racks', 'Catalogo', 'CatalogoTab.tsx', 'catalogo', '429'],
            ['Racks', 'Stock', 'StockTab.tsx', 'movimientos, catalogo', '282'],
            ['Racks', 'Ocupacion', 'OcupacionTab.tsx', 'movimientos, catalogo', '~700'],
            ['Racks', 'Descarga', 'DescargaTab.tsx', 'movimientos', '599'],
            ['Racks', 'FEFO', 'FefoTab.tsx', 'movimientos', '312'],
            ['Racks', 'Usuarios', 'UsuariosTab.tsx', 'profiles, user_roles', '247'],
            ['Piso', 'Movimientos', 'MovimientosTab.tsx', 'piso_movimientos, piso_mov_detalles', '624'],
            ['Piso', 'UP Kardex', 'UpKardexTab.tsx', 'piso_bloques', '163'],
            ['Piso', 'Sectores', 'SectoresTab.tsx', 'piso_sectores', '151'],
            ['Piso', 'Config Columnas', 'ConfiguracionColumnasTab.tsx', 'piso_sectores, piso_columnas, piso_bloques', '245'],
        ],
        col_widths=[1.8*cm, 2.5*cm, 4.5*cm, 4.5*cm, 1.5*cm]
    )
    story.append(mod_table)

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 3. S1 - CLASIFICAR (Seiri)
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('3. S1 - CLASIFICAR (Seiri)', h1_style))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph(
        'El primer paso de la metodologia 5S consiste en identificar y clasificar todos los elementos del proyecto, '
        'diferenciando entre lo que es necesario y lo que es innecesario. En un proyecto de software, esto significa '
        'identificar codigo muerto, funciones duplicadas, dependencias no utilizadas, archivos huérfanos y cualquier '
        'elemento que no aporte valor funcional al sistema. El objetivo es mantener solo lo que es esencial para el '
        'funcionamiento correcto de la aplicacion.',
        body_style))

    story.append(Paragraph('3.1 Codigo Duplicado Identificado', h2_style))

    story.append(Paragraph(
        'Durante el analisis exhaustivo del codebase, se identificaron multiples instancias de logica duplicada que '
        'aumentan la complejidad del mantenimiento y crean riesgo de inconsistencias. A continuacion se detallan las '
        'principales duplicaciones encontradas:',
        body_style))

    story.append(Paragraph('<b>Calculo de Stock:</b> La logica de agregar movimientos para calcular stock por '
        'ubicacion esta re-implementada de forma independiente en al menos 5 componentes diferentes: StockTab.tsx, '
        'TrasladoTab.tsx, FefoTab.tsx, DescargaTab.tsx (incompleto) y OcupacionTab.tsx. Cada componente tiene su '
        'propia version del calculo, lo que significa que un cambio en la logica de stock requiere actualizar 5 '
        'archivos diferentes. Ademas, DescargaTab.tsx ignora los tipos devolucion y traslado en su calculo, lo '
        'cual genera exportaciones de Excel con datos incorrectos.',
        body_style))

    story.append(Paragraph('<b>Funciones de Utilidad:</b> Las funciones fmtCantidad() y formatDateTime() estan '
        'definidas tanto en utils.ts como en page.tsx (lineas 71-79). Esto crea confusion sobre cual version '
        'debe usarse y puede llevar a comportamientos inconsistentes si alguna version se modifica sin actualizar la otra.',
        body_style))

    story.append(Paragraph('<b>Alerta de Ubicacion Ocupada:</b> Tanto MovimientoForm.tsx (IngresoForm) como '
        'TrasladoTab.tsx tienen implementaciones casi identicas del dialogo "ubicacion ocupada" con el boton '
        '"Dar Salida". Este patron repetido deberia extraerse en un componente compartido reutilizable.',
        body_style))

    story.append(Paragraph('<b>Parseo de Excel:</b> La logica de auto-deteccion de columnas en archivos Excel '
        'esta duplicada en DescargaTab.tsx (lineas 178-207) y UpKardexTab.tsx (lineas 48-56), con la misma '
        'logica basada en expresiones regulares. Una funcion compartida eliminaria esta redundancia.',
        body_style))

    story.append(Paragraph('3.2 Elementos Obsoletos o No Utilizados', h2_style))

    story.append(Paragraph(
        'Se identificaron los siguientes elementos que no aportan valor funcional o que estan desactualizados '
        'respecto al estado actual del sistema:',
        body_style))

    obs_table = create_table_data(
        ['Elemento', 'Ubicacion', 'Estado', 'Accion Recomendada'],
        [
            ['has_role()', 'types.ts (declarado)', 'Declarado pero nunca llamado en la app', 'Eliminar de types.ts'],
            ['primer_nombre_usuario()', 'types.ts (declarado)', 'Declarado pero nunca llamado en la app', 'Eliminar de types.ts'],
            ['Enum app_role', 'types.ts (linea 408)', 'Solo permite admin/operario, la app usa 7 roles', 'Actualizar enum en Supabase'],
            ['Tipos catalogo', 'types.ts', 'No incluye stock_big_magic', 'Regenerar tipos con supabase gen'],
            ['Error Boundaries', 'Toda la app', 'No existen React Error Boundaries', 'Agregar en page.tsx'],
        ],
        col_widths=[3.5*cm, 3.5*cm, 4.5*cm, 4.5*cm]
    )
    story.append(obs_table)
    story.append(Spacer(1, 0.5*cm))

    story.append(Paragraph('3.3 Resultado de la Clasificacion', h2_style))
    story.append(Paragraph(
        'Tras aplicar Seiri, se identificaron 8 areas de codigo duplicado, 5 elementos obsoletos y 1 vulnerabilidad '
        'critica de seguridad. La siguiente tabla resume el inventario completo de elementos clasificados:',
        body_style))

    class_table = create_table_data(
        ['Categoria', 'Necesario', 'Duplicado', 'Obsoleto', 'Vulnerable'],
        [
            ['Funciones de negocio', '25 funciones', '5 duplicadas', '2 no usadas', '1 critica'],
            ['Componentes UI', '12 tabs + auth', '2 patrones duplicados', '0', '0'],
            ['Constantes', '30 definidas', '0', '1 (POLLING sin uso)', '0'],
            ['Tipos TypeScript', '14 interfaces', '0', '3 desactualizados', '1 mismatch'],
            ['Librerias', '7 archivos .ts', '0', '0', '1 service_role expuesto'],
        ],
        col_widths=[3.5*cm, 3*cm, 3*cm, 3*cm, 3.5*cm]
    )
    story.append(class_table)

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 4. S2 - ORDENAR (Seiton)
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('4. S2 - ORDENAR (Seiton)', h1_style))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph(
        'Seiton consiste en organizar los elementos necesarios de manera que cada uno tenga un lugar definido y sea '
        'facil de encontrar y usar. En desarrollo de software, esto se traduce en mantener una estructura de carpetas '
        'coherente, seguir convenciones de nomenclatura consistentes, y asegurar que cada modulo tenga una '
        'responsabilidad unica y bien definida (principio de cohesion). La estructura actual de RACKLY sigue '
        'buenas practicas en su organizacion general, pero hay areas especificas que pueden mejorarse.',
        body_style))

    story.append(Paragraph('4.1 Estructura de Carpetas Actual', h2_style))

    story.append(Paragraph(
        'RACKLY utiliza una estructura basada en el patron de Next.js App Router, con los componentes organizados '
        'por dominio funcional (kardex, piso, auth, ui). Las librerias de logica de negocio estan separadas de los '
        'componentes de presentacion, lo cual facilita el mantenimiento y las pruebas. La estructura actual es '
        'la siguiente:',
        body_style))

    struct_table = create_table_data(
        ['Directorio', 'Contenido', 'Archivos', 'Evaluacion'],
        [
            ['src/app/', 'Paginas de la app', 'page.tsx, layout.tsx', 'Buena - minimo de archivos'],
            ['src/components/rackly/kardex/', 'Vista Racks (8 tabs)', '10 archivos .tsx', 'Buena - 1 archivo por modulo'],
            ['src/components/rackly/piso/', 'Vista Piso (4 tabs)', '4 archivos .tsx', 'Buena - 1 archivo por modulo'],
            ['src/components/rackly/auth/', 'Autenticacion', 'AuthGate.tsx', 'Aceptable - archivo grande (667 lineas)'],
            ['src/components/ui/', 'shadcn/ui base', '13 archivos', 'Buena - sin modificaciones'],
            ['src/lib/rackly/', 'Logica Racks', '6 archivos .ts', 'Buena - separacion por dominio'],
            ['src/lib/piso/', 'Logica Piso', '1 archivo .ts', 'Aceptable - podria separarse'],
            ['src/lib/supabase/', 'Cliente y tipos', '2 archivos', 'Buena - estandar de Supabase'],
            ['src/hooks/', 'Hooks personalizados', '2 archivos', 'Buena - auth + realtime'],
        ],
        col_widths=[4*cm, 3.5*cm, 3*cm, 5.5*cm]
    )
    story.append(struct_table)
    story.append(Spacer(1, 0.5*cm))

    story.append(Paragraph('4.2 Nomenclatura y Convenciones', h2_style))

    story.append(Paragraph(
        'El proyecto mantiene convenciones de nomenclatura consistentes en la mayoria de los archivos. Los '
        'componentes React usan PascalCase (MovimientoForm, StockTab), las funciones usan camelCase (fetchMovimientos, '
        'addMovimiento), y las constantes usan UPPER_SNAKE_CASE (BLOQUES, PISOS, ROL_ADMIN). Sin embargo, se '
        'identificaron algunas inconsistencias menores que podrian mejorarse para mantener un estandar perfecto.',
        body_style))

    story.append(Paragraph('4.3 Organizacion de Responsabilidades', h2_style))

    story.append(Paragraph(
        'Cada componente tiene una responsabilidad principal bien definida. Sin embargo, algunos archivos son '
        'demasiado grandes y contienen multiples sub-componentes internos que podrian extraerse como archivos '
        'independientes. Los archivos mas grandes son: OcupacionTab.tsx (~700 lineas), MovimientoForm.tsx (902 '
        'lineas) y AuthGate.tsx (667 lineas). Extraer sub-componentes mejoraria la legibilidad y facilitaria '
        'las pruebas unitarias.',
        body_style))

    story.append(Paragraph('4.4 Propuesta de Mejoras en Orden', h2_style))

    orden_items = [
        'Extraer LocationOccupiedDialog como componente compartido (usado en MovimientoForm y TrasladoTab)',
        'Dividir AuthGate.tsx en archivos separados por cada screen (Login, Signup, Recovery, etc.)',
        'Extraer IngresoForm y SalidaForm desde MovimientoForm.tsx a archivos propios',
        'Separar piso/api.ts en archivos modulares (sectores.ts, columnas.ts, movimientos.ts)',
        'Crear un directorio src/lib/rackly/stock/ para centralizar toda la logica de calculo de stock',
        'Unificar la cache de catalogo en un hook dedicado useCatalogo() en lugar de variables a nivel de modulo',
    ]
    for item in orden_items:
        story.append(Paragraph(item, ParagraphStyle('BulletItem', parent=bullet_style,
            bulletText='\u2022', textColor=ACCENT_ORANGE)))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 5. S3 - LIMPIAR (Seiso)
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('5. S3 - LIMPIAR (Seiso)', h1_style))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph(
        'Seiso significa limpiar y mantener el entorno de trabajo libre de errores, bugs, vulnerabilidades y '
        'cualquier tipo de suciedad que afecte el rendimiento del sistema. En el contexto de desarrollo de '
        'software, "limpiar" implica corregir bugs, parchear vulnerabilidades de seguridad, actualizar '
        'dependencias obsoletas, eliminar warnings del compilador y asegurar que el codigo compile sin errores.',
        body_style))

    story.append(Paragraph('5.1 Vulnerabilidades Criticas', h2_style))

    story.append(Paragraph(
        '<b>VULNERABILIDAD CRITICA - Service Role Key Expuesto:</b> Se ha detectado que la clave de servicio '
        '(service_role) de Supabase esta codificada directamente en el archivo kardex.ts (lineas 263-264 y 324-325), '
        'el cual se ejecuta en el navegador del cliente. Esta clave tiene acceso total a la base de datos, '
        'ignorando todas las politicas de Row Level Security (RLS). Cualquier persona que inspeccione el codigo '
        'del navegador puede extraer esta clave y obtener acceso completo a la base de datos, incluyendo la '
        'posibilidad de eliminar todos los datos, modificar perfiles de usuario y crear cuentas administrativas.',
        body_style))

    story.append(Paragraph(
        'La solucion recomendada es mover estas operaciones a un Supabase Edge Function o a una API Route '
        'del lado del servidor, donde la clave service_role este protegida como variable de entorno y nunca '
        'sea expuesta al navegador del cliente. Alternativamente, se puede crear una funcion RPC en PostgreSQL '
        'con SECURITY DEFINER que ejecute las operaciones con privilegios elevados sin exponer la clave.',
        body_style))

    story.append(Paragraph('5.2 Errores Funcionales', h2_style))

    story.append(Paragraph(
        '<b>Exportacion de Stock Incompleta:</b> El modulo DescargaTab.tsx, en su funcion de descarga de Excel, '
        'calcula el stock considerando unicamente los tipos "ingreso" y "salida", ignorando "devolucion" y '
        '"traslado". Esto genera que los reportes exportados muestren cantidades de stock incorrectas. Otros '
        'modulos como StockTab y FefoTab si incluyen todos los tipos de movimiento correctamente, lo cual '
        'crea una inconsistencia entre los datos mostrados en pantalla y los datos exportados.',
        body_style))

    story.append(Paragraph(
        '<b>Mismatch de Roles en Base de Datos:</b> El enum app_role en la base de datos solo permite los valores '
        '"admin" y "operario", pero la aplicacion define 7 roles diferentes (admin, operario, auxiliar, almacenero, '
        'supervisor_almacen, supervisor_operaciones, coordinador_operaciones). Cuando se intenta asignar un rol que '
        'no existe en el enum, la operacion falla silenciosamente. Esto significa que las funciones de cambio de rol '
        'en UsuariosTab.tsx pueden no funcionar correctamente para la mayoria de los roles.',
        body_style))

    story.append(Paragraph('5.3 Tipos TypeScript Desactualizados', h2_style))

    story.append(Paragraph(
        'El archivo types.ts generado por Supabase presenta varias discrepancias con el esquema real de la base '
        'de datos. La columna stock_big_magic de la tabla catalogo no esta reflejada en los tipos generados, '
        'a pesar de que la aplicacion la lee y escribe activamente. El enum de roles (app_role) solo contempla '
        'dos valores cuando la aplicacion requiere siete. Es necesario regenerar los tipos ejecutando el comando '
        'de generacion de Supabase y luego actualizar manualmente las discrepancias que no se resuelven '
        'automaticamente.',
        body_style))

    story.append(Paragraph('5.4 Ausencia de Manejo de Errores', h2_style))

    story.append(Paragraph(
        'La aplicacion no cuenta con React Error Boundaries, lo que significa que un error no manejado en '
        'cualquier componente puede provocar que toda la aplicacion se bloquee mostrando una pantalla blanca. '
        'Se recomienda agregar Error Boundaries al menos en los siguientes puntos criticos: el nivel principal '
        'de page.tsx (para capturar errores globales), alrededor de cada tab de vista (para que un error en un '
        'modulo no afecte a los demas), y alrededor de las operaciones de red (fetch, insert, delete) para '
        'mostrar mensajes de error amigables al usuario.',
        body_style))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 6. S4 - ESTANDARIZAR (Seiketsu)
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('6. S4 - ESTANDARIZAR (Seiketsu)', h1_style))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph(
        'Seiketsu implica crear estandares y normas que mantengan los logros obtenidos en las tres primeras "S". '
        'En desarrollo de software, esto significa documentar las convenciones del proyecto, crear patrones '
        'reutilizables, establecer guias de estilo de codigo y automatizar las verificaciones de calidad. Los '
        'estandares deben ser claros, accesibles y faciles de seguir por cualquier desarrollador que se incorpore '
        'al proyecto.',
        body_style))

    story.append(Paragraph('6.1 Patron Unificado de Calculo de Stock', h2_style))

    story.append(Paragraph(
        'El problema mas urgente a estandarizar es el calculo de stock. Actualmente, cada componente que necesita '
        'calcular stock implementa su propia version, con variaciones sutiles que producen inconsistencias. Se '
        'propone crear una funcion centralizada calcularStockGeneral(movimientos) en utils.ts que reciba la lista '
        'completa de movimientos y retorne un mapa de ubicaciones con su stock calculado. Esta funcion deberia '
        'incluir correctamente todos los tipos de movimiento: ingreso (+), salida (-), devolucion (+) y traslado '
        '(+ en destino, - en origen). Todos los componentes existentes deberian migrar a usar esta funcion unica.',
        body_style))

    story.append(Paragraph('6.2 Patron de Componentes Compartidos', h2_style))

    story.append(Paragraph(
        'Se recomienda extraer los patrones repetidos en componentes compartidos reutilizables. Esto incluye: '
        'LocationOccupiedDialog (dialogo de ubicacion ocupada con opcion de salida), ExcelUploadPanel (panel de '
        'subida de archivos Excel con preview), StockCard (tarjeta de resumen de stock por ubicacion), y '
        'MovementHistoryTable (tabla de historial de movimientos con filtros). Estos componentes compartidos '
        'reducen la duplicacion de codigo y aseguran consistencia visual y funcional en toda la aplicacion.',
        body_style))

    story.append(Paragraph('6.3 Convenciones de Comunicacion con Supabase', h2_style))

    story.append(Paragraph(
        'Se recomienda estandarizar la forma en que los componentes interactuan con Supabase. Actualmente, '
        'algunos componentes llaman directamente a supabase.from().select() mientras que otros usan funciones '
        'de la capa de librerias (kardex.ts, auth.ts, etc.). La regla deberia ser: los componentes NUNCA '
        'deberian importar o usar directamente el cliente de Supabase; toda comunicacion con la base de datos '
        'deberia pasar por las funciones de las librerias correspondientes. Esto facilita el testing, permite '
        'cambiar la implementacion sin afectar los componentes, y centraliza el manejo de errores.',
        body_style))

    story.append(Paragraph('6.4 Guia de Roles y Permisos', h2_style))

    roles_table = create_table_data(
        ['Rol', 'Acceso UP Data', 'Eliminar Mov.', 'Aprobar Usuarios', 'Cambiar Roles', 'Eliminar Perfil'],
        [
            ['admin', 'Si', 'Si', 'Si', 'Si', 'Si'],
            ['coordinador_operaciones', 'Si', 'Si', 'Si', 'No', 'No'],
            ['supervisor_almacen', 'No', 'Si', 'Si', 'No', 'No'],
            ['supervisor_operaciones', 'No', 'Si', 'Si', 'No', 'No'],
            ['almacenero', 'No', 'No', 'No', 'No', 'No'],
            ['auxiliar', 'No', 'No', 'No', 'No', 'No'],
            ['operario', 'No', 'No', 'No', 'No', 'No'],
        ],
        col_widths=[4*cm, 2*cm, 2*cm, 2*cm, 2*cm, 2*cm]
    )
    story.append(roles_table)

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 7. S5 - MANTENER (Shitsuke)
    # ═════════════════════════════════════════════════════════════════════════════════
    story.append(Paragraph('7. S5 - MANTENER (Shitsuke)', h1_style))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph(
        'Shitsuke es la disciplina de mantener los logros obtenidos con las cuatro "S" anteriores y convertirlos '
        'en habitos permanentes. En desarrollo de software, esto se traduce en mantener la disciplina de code '
        'review, seguir las convenciones establecidas, documentar los cambios, mantener los save points y '
        'asegurar que cada despliegue sea un proceso controlado y verificable. Sin disciplina, las mejoras '
        'obtenidas se deterioran con el tiempo y el proyecto vuelve a acumular deuda tecnica.',
        body_style))

    story.append(Paragraph('7.1 Sistema de Save Points (JHIA)', h2_style))

    story.append(Paragraph(
        'RACKLY utiliza un sistema de save points basados en Git que permite rastrear la evolucion del proyecto '
        'y revertir cambios si es necesario. Cada save point corresponde a un commit en Git con un prefijo JHIA '
        'seguido de un numero secuencial. Este sistema ha demostrado ser efectivo para mantener un historial '
        'claro de los cambios y facilitar la colaboracion.',
        body_style))

    save_table = create_table_data(
        ['Save Point', 'Descripcion', 'Elementos Clave'],
        [
            ['JHIA1-JHIA7', 'Fundacion del proyecto', 'Auth, DB, Estructura base, Tema oscuro'],
            ['JHIA8-JHIA9', 'Modulos avanzados', 'Ocupacion 3D, FEFO, Filtros, Tema oscuro completo'],
            ['JHIA10-JHIA11', 'Integracion de datos', 'UP Data Excel, Batch 1000, Service role, Permisos'],
            ['JHIA11.12-JHIA11.13', 'Seguridad y permisos', 'Restriccion UP Data, Roles granulares'],
            ['JHIA11.14', 'Mejoras visuales', 'Colores Ocupacion: azul/verde/naranja'],
        ],
        col_widths=[3.5*cm, 4*cm, 8.5*cm]
    )
    story.append(save_table)
    story.append(Spacer(1, 0.5*cm))

    story.append(Paragraph('7.2 Proceso de Despliegue', h2_style))

    story.append(Paragraph(
        'El flujo de despliegue actual sigue el patron: desarrollo local con npm run dev, verificacion con '
        'npm run build, commit con save point, push a GitHub, y deploy manual via Wrangler CLI a Cloudflare Pages. '
        'Este proceso ha funcionado de manera confiable y deberia mantenerse como estandar. Se recomienda '
        'documentar este proceso en un archivo README dedicado y considerar la automatizacion del deploy '
        'mediante GitHub Actions para eliminar la necesidad de deploy manual.',
        body_style))

    story.append(Paragraph('7.3 Worklog de Cambios', h2_style))

    story.append(Paragraph(
        'Se ha implementado un sistema de worklog en /home/z/my-project/worklog.md donde cada agente que trabaja '
        'en el proyecto registra las acciones realizadas, los resultados obtenidos y las decisiones tomadas. '
        'Este registro permite reconstruir el historial de decisiones y facilita la transferencia de conocimiento '
        'entre sesiones de desarrollo. El formato estandarizado del worklog incluye: Task ID, Agent, Task, Work '
        'Log y Stage Summary.',
        body_style))

    story.append(Paragraph('7.4 Checklist de Mantenimiento Periodico', h2_style))

    checklist = [
        'Verificar que npm run build compile sin errores ni warnings',
        'Confirmar que el deploy en Cloudflare Pages se completo exitosamente',
        'Revisar que los tipos TypeScript estan sincronizados con el esquema de Supabase',
        'Verificar que no hay nuevas funciones duplicadas o codigo muerto',
        'Confirmar que las politicas RLS en Supabase siguen siendo efectivas',
        'Revisar el uso de la clave service_role y asegurar que no se exponga en nuevos archivos',
        'Actualizar el worklog con los cambios realizados en la sesion',
        'Crear un nuevo save point (JHIA) para cada conjunto de cambios significativos',
    ]
    for item in checklist:
        story.append(Paragraph(item, ParagraphStyle('CheckItem', parent=bullet_style,
            bulletText='\u2610', textColor=ACCENT_PURPLE)))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 8-10. MAPS
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('8. Mapa de Arquitectura del Sistema', h1_style))
    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph(
        'El siguiente mapa muestra la arquitectura completa de RACKLY, organizada en cuatro capas: Frontend '
        '(Next.js 16), Logica de Negocio (librerias TypeScript), Base de Datos (Supabase con PostgreSQL) e '
        'Infraestructura de Despliegue (Cloudflare Pages). Cada capa esta representada con sus componentes '
        'principales y las relaciones entre ellos.',
        body_style))

    img_path = os.path.join(OUT, 'RACKLY_Mapa_Arquitectura.png')
    story.extend(add_image_centered(img_path, width=17*cm))
    story.append(PageBreak())

    story.append(Paragraph('9. Mapa de Flujo de Datos', h1_style))
    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph(
        'Este mapa ilustra como fluye la informacion desde las acciones del usuario, pasando por la capa de '
        'procesamiento (validaciones, funciones RPC, logica de stock), hasta la base de datos y finalmente '
        'a las vistas que se actualizan. Las flechas muestran las operaciones SQL realizadas (INSERT, SELECT, '
        'RPC, BATCH) y la sincronizacion en tiempo real via WebSockets.',
        body_style))

    img_path = os.path.join(OUT, 'RACKLY_Mapa_FlujoDatos.png')
    story.extend(add_image_centered(img_path, width=17*cm))
    story.append(PageBreak())

    story.append(Paragraph('10. Mapa de Integracion de Modulos', h1_style))
    story.append(Spacer(1, 0.3*cm))
    story.append(Paragraph(
        'El mapa de integracion muestra las dependencias de datos entre los 10 modulos principales de RACKLY. '
        'Cada modulo se conecta con las tablas y funciones RPC que utiliza. Las flechas indican la direccion '
        'de la dependencia y las etiquetas describen que tipo de datos se comparten. Este mapa es esencial '
        'para entender el impacto de cambios en un modulo sobre los demas.',
        body_style))

    img_path = os.path.join(OUT, 'RACKLY_Mapa_Integracion.png')
    story.extend(add_image_centered(img_path, width=17*cm))

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 11. ACTION PLAN
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('11. Plan de Accion y Prioridades', h1_style))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph(
        'A continuacion se presenta el plan de accion priorizado para aplicar las 5S al proyecto RACKLY. '
        'Las acciones se organizan por prioridad: critica (debe hacerse inmediatamente), alta (proxima sesion), '
        'media (a mediano plazo) y baja (mejora continua). Cada accion incluye el paso 5S al que pertenece, '
        'una descripcion breve y los archivos afectados.',
        body_style))

    plan_table = create_table_data(
        ['Prioridad', 'Accion', 'Paso 5S', 'Archivos Afectados'],
        [
            ['CRITICA', 'Mover service_role a Edge Function o RPC', 'S3', 'kardex.ts'],
            ['CRITICA', 'Actualizar enum app_role en Supabase', 'S3', 'types.ts, auth.ts, Supabase DB'],
            ['CRITICA', 'Corregir calculo de stock en DescargaTab', 'S1', 'DescargaTab.tsx'],
            ['ALTA', 'Crear calcularStockGeneral() centralizado', 'S4', 'utils.ts, 5 componentes'],
            ['ALTA', 'Extraer LocationOccupiedDialog compartido', 'S2', 'MovimientoForm, TrasladoTab'],
            ['ALTA', 'Agregar Error Boundaries', 'S3', 'page.tsx'],
            ['ALTA', 'Regenerar tipos Supabase', 'S3', 'types.ts'],
            ['ALTA', 'Eliminar funciones no usadas (has_role, etc.)', 'S1', 'types.ts'],
            ['MEDIA', 'Dividir AuthGate.tsx en sub-componentes', 'S2', 'AuthGate.tsx'],
            ['MEDIA', 'Dividir piso/api.ts en modulos', 'S2', 'piso/api.ts'],
            ['MEDIA', 'Eliminar duplicacion fmtCantidad/formatDateTime', 'S1', 'page.tsx, utils.ts'],
            ['MEDIA', 'Extraer IngresoForm y SalidaForm', 'S2', 'MovimientoForm.tsx'],
            ['MEDIA', 'Unificar cache de catalogo en hook', 'S4', 'catalogo.ts, nuevo hook'],
            ['BAJA', 'Automatizar deploy con GitHub Actions', 'S5', 'CI/CD config'],
            ['BAJA', 'Crear README con guias de desarrollo', 'S5', 'README.md'],
            ['BAJA', 'Agregar tests unitarios para utils', 'S4', 'tests/'],
            ['BAJA', 'Extraer ExcelUploadPanel compartido', 'S2', 'DescargaTab, UpKardexTab'],
        ],
        col_widths=[2*cm, 5.5*cm, 1.5*cm, 7*cm]
    )
    story.append(plan_table)

    story.append(PageBreak())

    # ═══════════════════════════════════════════════════════
    # 12. CONCLUSIONS
    # ═══════════════════════════════════════════════════════
    story.append(Paragraph('12. Conclusiones', h1_style))
    story.append(Spacer(1, 0.3*cm))

    story.append(Paragraph(
        'La aplicacion de la metodologia 5S al proyecto RACKLY ha revelado un sistema robusto y funcional con '
        'mas de 7,000 lineas de codigo, 12 modulos activos y 13 tablas de base de datos. La aplicacion cumple '
        'su objetivo principal de gestionar almacenes de manera eficiente, con funcionalidades que cubren desde '
        'el registro de movimientos basicos hasta el control FEFO, la visualizacion 3D de ocupacion y la carga '
        'masiva de datos via Excel.',
        body_style))

    story.append(Paragraph(
        'Sin embargo, el analisis tambien ha identificado areas significativas de mejora. La vulnerabilidad '
        'critica del service role expuesto en el frontend requiere atencion inmediata, al igual que la '
        'inconsistencia en el calculo de stock en el modulo de descarga. Las duplicaciones de codigo, aunque '
        'funcionales, aumentan el riesgo de errores futuros y dificultan el mantenimiento. Los tipos TypeScript '
        'desactualizados pueden causar bugs sutiles que son dificiles de detectar.',
        body_style))

    story.append(Paragraph(
        'Los mapas de arquitectura, flujo de datos e integracion generados como parte de este analisis '
        'constituyen una herramienta valiosa para el equipo. Proporcionan una vision completa de como estan '
        'conectados los diferentes modulos, que tablas de la base de datos utiliza cada componente y como '
        'fluye la informacion a traves del sistema. Estos mapas deberian mantenerse actualizados a medida '
        'que el proyecto evoluciona.',
        body_style))

    story.append(Paragraph(
        'La implementacion del plan de accion priorizado, comenzando por las acciones criticas y avanzando '
        'progresivamente hacia las mejoras a mediano y largo plazo, permitira que RACKLY alcance su maximo '
        'potencial como herramienta de gestion de almacen. La disciplina de mantener las 5S como practica '
        'permanente asegurara que el sistema continue siendo limpio, organizado y eficiente a medida que crece '
        'en funcionalidades y usuarios.',
        body_style))

    # Build
    doc.build(story)
    print(f'PDF created: {PDF_PATH}')


if __name__ == '__main__':
    build_pdf()

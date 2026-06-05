#!/usr/bin/env python3
"""
Manual de Usuario Rackly - Generador PDF v2
Orientacion horizontal, formato APA 7th Edition, figuras a pagina completa.
Ortografia revisada segun la RAE.
"""

import os
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (
    Paragraph, Spacer, Table, TableStyle,
    PageBreak, Frame, PageTemplate, BaseDocTemplate, NextPageTemplate
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus.flowables import Flowable
from PIL import Image as PILImage

# ═══════════════════════════════════════════════════════════
# CONFIGURACION
# ═══════════════════════════════════════════════════════════

SCREENSHOT_DIR = "/home/z/my-project/download/screenshots_web"
OUTPUT_PDF = "/home/z/my-project/download/Manual_de_Usuario_Rackly_v2.pdf"

PAGE_W, PAGE_H = landscape(A4)
MARGIN = 1 * inch

COLOR_PRIMARY = HexColor("#1E293B")
COLOR_SECONDARY = HexColor("#3B82F6")
COLOR_ACCENT = HexColor("#0F172A")
COLOR_TABLE_HEADER = HexColor("#1E3A5F")
COLOR_TABLE_ALT = HexColor("#E8F0FE")
COLOR_WHITE = HexColor("#FFFFFF")
COLOR_BORDER = HexColor("#CBD5E1")

# ═══════════════════════════════════════════════════════════
# REGISTER FONTS (Liberation Serif = metric-compatible with Times New Roman)
# ═══════════════════════════════════════════════════════════

FD = '/usr/share/fonts/truetype/liberation'
pdfmetrics.registerFont(TTFont('LSerif', f'{FD}/LiberationSerif-Regular.ttf'))
pdfmetrics.registerFont(TTFont('LSerifB', f'{FD}/LiberationSerif-Bold.ttf'))
pdfmetrics.registerFont(TTFont('LSerifI', f'{FD}/LiberationSerif-Italic.ttf'))
pdfmetrics.registerFont(TTFont('LSerifBI', f'{FD}/LiberationSerif-BoldItalic.ttf'))
pdfmetrics.registerFont(TTFont('LSans', f'{FD}/LiberationSans-Regular.ttf'))
pdfmetrics.registerFont(TTFont('LSansB', f'{FD}/LiberationSans-Bold.ttf'))
pdfmetrics.registerFont(TTFont('LSansI', f'{FD}/LiberationSans-Italic.ttf'))
pdfmetrics.registerFont(TTFont('LSansBI', f'{FD}/LiberationSans-BoldItalic.ttf'))

from reportlab.pdfbase.pdfmetrics import registerFontFamily
registerFontFamily('LSerif', normal='LSerif', bold='LSerifB', italic='LSerifI', boldItalic='LSerifBI')
registerFontFamily('LSans', normal='LSans', bold='LSansB', italic='LSansI', boldItalic='LSansBI')

# ═══════════════════════════════════════════════════════════
# STYLES (APA 7th Edition)
# ═══════════════════════════════════════════════════════════

style_title_cover = ParagraphStyle(
    'TitleCover', fontName='LSerifB', fontSize=28, leading=34,
    textColor=COLOR_PRIMARY, alignment=TA_CENTER, spaceAfter=12
)
style_subtitle_cover = ParagraphStyle(
    'SubtitleCover', fontName='LSerif', fontSize=16, leading=22,
    textColor=HexColor("#64748B"), alignment=TA_CENTER, spaceAfter=8
)
style_h1 = ParagraphStyle(
    'H1', fontName='LSerifB', fontSize=16, leading=22,
    textColor=COLOR_ACCENT, alignment=TA_LEFT, spaceBefore=18, spaceAfter=10
)
style_h2 = ParagraphStyle(
    'H2', fontName='LSerifB', fontSize=13, leading=18,
    textColor=COLOR_PRIMARY, alignment=TA_LEFT, spaceBefore=14, spaceAfter=8
)
style_body = ParagraphStyle(
    'Body', fontName='LSerif', fontSize=11, leading=16,
    textColor=HexColor("#1E293B"), alignment=TA_JUSTIFY,
    spaceBefore=4, spaceAfter=6
)
style_toc_h1 = ParagraphStyle(
    'TOCH1', fontName='LSerifB', fontSize=12, leading=22,
    textColor=COLOR_ACCENT, alignment=TA_LEFT, leftIndent=0
)
style_toc_h2 = ParagraphStyle(
    'TOCH2', fontName='LSerif', fontSize=11, leading=20,
    textColor=HexColor("#475569"), alignment=TA_LEFT, leftIndent=24
)
style_info_cover = ParagraphStyle(
    'CoverInfo', fontName='LSerif', fontSize=12, leading=18,
    textColor=HexColor("#475569"), alignment=TA_CENTER, spaceAfter=8
)

# ═══════════════════════════════════════════════════════════
# DATA: Descripciones de cada pantalla
# ═══════════════════════════════════════════════════════════

FIGURES = [
    {
        "num": 1, "file": "01-login.jpg",
        "caption": "Pantalla de inicio de sesion del sistema Rackly",
        "elements": [
            ("1", "Campo de correo electronico", "Campo de texto donde el usuario ingresa su direccion de correo electronico institucional para autenticarse en el sistema."),
            ("2", "Campo de contrasena", "Campo protegido donde se introduce la contrasena asociada a la cuenta de usuario. Los caracteres se ocultan por razones de seguridad."),
            ("3", "Boton de inicio de sesion", "Boton de accion principal que ejecuta el proceso de autenticacion validando las credenciales ingresadas contra la base de datos."),
            ("4", "Logotipo institucional", "Identificador visual de ECARAL que se muestra en la parte superior de la interfaz, reforzando la identidad corporativa de la aplicacion."),
        ]
    },
    {
        "num": 2, "file": "02-main-racks.jpg",
        "caption": "Vista principal del modulo Kardex Racks con panel de navegacion",
        "elements": [
            ("1", "Barra de navegacion principal", "Barra horizontal superior que contiene las pestañas de los dos modulos principales: Kardex Racks y Kardex Piso."),
            ("2", "Pestana Kardex Racks (activa)", "Pestana resaltada que indica el modulo activo. Permite acceder a todas las funcionalidades de gestion de racks."),
            ("3", "Pestana Kardex Piso", "Pestana que permite navegar al modulo de gestion de piso, alternando entre ambos modulos de forma rapida."),
            ("4", "Submenu de secciones", "Menu lateral con las secciones disponibles: Movimientos, Traslado, Catalogo, Stock, Ocupacion, Descarga, FEFO y Usuarios."),
            ("5", "Panel de contenido principal", "Area central donde se despliega la informacion y los formularios de la seccion seleccionada."),
            ("6", "Indicador de sesion", "Muestra el usuario autenticado y las opciones de perfil o cierre de sesion."),
        ]
    },
    {
        "num": 3, "file": "03-movimientos-ingreso.jpg",
        "caption": "Formulario de registro de ingreso de mercaderia en el modulo Movimientos",
        "elements": [
            ("1", "Pestanas de tipo de movimiento", "Permiten alternar entre Ingreso, Salida y Devolucion dentro del submodulo de Movimientos."),
            ("2", "Selector de rack de destino", "Lista desplegable donde se selecciona el rack especifico para el ingreso de mercaderia."),
            ("3", "Selector de nivel", "Lista desplegable para elegir el nivel dentro del rack donde se almacenara el producto."),
            ("4", "Selector de posicion", "Lista desplegable para elegir la posicion exacta dentro del nivel seleccionado."),
            ("5", "Campo de codigo de producto", "Campo de texto para ingresar el identificador del producto que se va a almacenar."),
            ("6", "Campo de cantidad", "Campo numerico donde se especifica la cantidad de unidades del producto a ingresar."),
            ("7", "Campos de lote y vencimiento", "Campos para registrar el numero de lote y la fecha de vencimiento del producto."),
            ("8", "Boton de registrar ingreso", "Boton que ejecuta el registro del movimiento de ingreso en la base de datos del sistema."),
            ("9", "Tabla de movimientos recientes", "Listado de los ultimos ingresos registrados con datos de fecha, producto, cantidad y ubicacion."),
        ]
    },
    {
        "num": 4, "file": "04-movimientos-salida.jpg",
        "caption": "Formulario de registro de salida de mercaderia del modulo Movimientos",
        "elements": [
            ("1", "Pestana Salida (activa)", "Indica que la operacion activa es la salida de mercaderia, resaltada visualmente."),
            ("2", "Selector de rack de origen", "Lista desplegable donde se selecciona el rack del cual se retirara mercaderia."),
            ("3", "Selector de nivel y posicion", "Combos dependientes para ubicar la posicion exacta de donde se extraera el producto."),
            ("4", "Campo de codigo de producto", "Campo para ingresar o seleccionar el codigo del producto a retirar del rack."),
            ("5", "Campo de cantidad a retirar", "Campo numerico que indica la cantidad de unidades a extraer del stock del rack."),
            ("6", "Boton de registrar salida", "Boton que ejecuta la operacion de salida y actualiza el inventario en la base de datos."),
            ("7", "Tabla historica de salidas", "Registro de las operaciones de salida con detalles de fecha, producto, cantidad y ubicacion."),
        ]
    },
    {
        "num": 5, "file": "05-movimientos-devolucion.jpg",
        "caption": "Formulario de registro de devolucion de mercaderia en el modulo Movimientos",
        "elements": [
            ("1", "Pestana Devolucion (activa)", "Indica que la operacion seleccionada es la devolucion de productos previamente retirados."),
            ("2", "Selector de rack", "Lista desplegable para seleccionar el rack al que se devolvera la mercaderia."),
            ("3", "Selector de nivel y posicion", "Combos que permiten ubicar el nivel y la posicion exacta para la devolucion."),
            ("4", "Campo de codigo de producto", "Campo para especificar el producto que se va a devolver al sistema de almacenamiento."),
            ("5", "Campo de cantidad a devolver", "Campo numerico para indicar las unidades que se reintegran al inventario del rack."),
            ("6", "Boton de registrar devolucion", "Boton de accion que ejecuta la devolucion y restaura las unidades al stock."),
            ("7", "Registro de devoluciones", "Tabla que muestra el historial de devoluciones con sus datos asociados."),
        ]
    },
    {
        "num": 6, "file": "06-traslado.jpg",
        "caption": "Interfaz de gestion de traslados entre racks del sistema Rackly",
        "elements": [
            ("1", "Selector de rack de origen", "Lista desplegable para seleccionar el rack desde donde se trasladara la mercaderia."),
            ("2", "Selector de rack de destino", "Lista desplegable donde se indica el rack al que se moveran los productos."),
            ("3", "Selector de nivel de origen", "Combo que especifica el nivel dentro del rack de origen donde se encuentra el producto."),
            ("4", "Selector de nivel de destino", "Combo que indica el nivel dentro del rack de destino para colocar el producto."),
            ("5", "Campos de producto y cantidad", "Campos para identificar el codigo del producto y la cantidad a trasladar."),
            ("6", "Boton de ejecutar traslado", "Boton que procesa la operacion, actualizando el stock en ambos racks simultaneamente."),
            ("7", "Historial de traslados", "Tabla con el registro de todos los traslados ejecutados con fechas, origenes y destinos."),
        ]
    },
    {
        "num": 7, "file": "07-catalogo.jpg",
        "caption": "Panel de administracion del catalogo de productos del sistema",
        "elements": [
            ("1", "Barra de busqueda", "Campo de texto con busqueda en tiempo real para filtrar productos por codigo, nombre o descripcion."),
            ("2", "Tabla del catalogo", "Listado de los productos registrados mostrando codigo, descripcion, unidad de medida y estado."),
            ("3", "Boton de agregar producto", "Control que abre el formulario de alta de un nuevo producto en el catalogo del sistema."),
            ("4", "Controles de edicion y eliminacion", "Iconos de accion en cada fila para modificar o eliminar productos del catalogo."),
        ]
    },
    {
        "num": 8, "file": "08-stock.jpg",
        "caption": "Vista consolidada del stock actual de mercaderia en racks",
        "elements": [
            ("1", "Filtros de busqueda", "Controles para filtrar el stock por rack, producto, rango de fechas u otros criterios."),
            ("2", "Tabla de stock consolidado", "Listado detallado de productos almacenados con rack, nivel, posicion, cantidad, lote y vencimiento."),
            ("3", "Indicadores de resumen", "Metricas superiores con total de productos almacenados, racks activos y otros datos relevantes."),
            ("4", "Controles de exportacion", "Botones para descargar el reporte de stock en Excel o PDF."),
        ]
    },
    {
        "num": 9, "file": "09-ocupacion.jpg",
        "caption": "Panel de visualizacion de la ocupacion de racks con mapa de colores",
        "elements": [
            ("1", "Mapa visual de racks", "Representacion grafica de los racks donde cada celda indica el estado de ocupacion mediante colores."),
            ("2", "Leyenda de colores de ocupacion", "Referencia visual: verde (libre), amarillo (parcial), rojo (lleno), gris (fuera de servicio)."),
            ("3", "Indicador de porcentaje global", "Metrica numerica que muestra el porcentaje total de ocupacion del almacen."),
            ("4", "Detalle de rack seleccionado", "Panel informativo al seleccionar un rack, mostrando estado detallado y contenido."),
            ("5", "Filtros por sector o zona", "Controles para filtrar la visualizacion por areas o sectores del almacen."),
        ]
    },
    {
        "num": 10, "file": "10-descarga.jpg",
        "caption": "Interfaz de descarga de reportes y exportacion de datos",
        "elements": [
            ("1", "Selector de tipo de reporte", "Lista para elegir el tipo: movimientos, stock, ocupacion, FEFO o traslados."),
            ("2", "Selector de rango de fechas", "Controles de fecha inicio y fin para delimitar el periodo del reporte."),
            ("3", "Selector de rack (opcional)", "Filtro para restringir el reporte a un rack especifico o incluir todos."),
            ("4", "Formato de exportacion", "Opciones para elegir el formato de salida: Excel (.xlsx) o PDF."),
            ("5", "Boton de descarga", "Boton que genera y descarga el archivo del reporte con los parametros seleccionados."),
        ]
    },
    {
        "num": 11, "file": "11-fefo.jpg",
        "caption": "Panel de control FEFO (First Expired, First Out) para gestion de vencimientos",
        "elements": [
            ("1", "Lista de productos por vencimiento", "Listado ordenado por fecha de vencimiento que muestra los productos proximos a caducar."),
            ("2", "Indicadores de urgencia por color", "Codigo de colores: rojo (vencido), naranja (proximo a vencer), amarillo (alerta), verde (sin riesgo)."),
            ("3", "Campo de fecha de referencia", "Selector para consultar el estado de vencimientos en una fecha especifica."),
            ("4", "Datos de producto y ubicacion", "Informacion detallada con ubicacion actual (rack, nivel, posicion) para facilitar el retiro."),
            ("5", "Boton de generar alerta", "Control para generar notificaciones para los productos que requieren atencion inmediata."),
        ]
    },
    {
        "num": 12, "file": "12-usuarios.jpg",
        "caption": "Panel de administracion de usuarios y permisos del sistema",
        "elements": [
            ("1", "Tabla de usuarios registrados", "Listado de cuentas de usuario con nombre, correo, rol asignado y estado (activo/inactivo)."),
            ("2", "Campo de rol de usuario", "Selector para asignar roles: Administrador (acceso total), Operador (movimientos) o Lector (lectura)."),
            ("3", "Boton de agregar usuario", "Control que abre el formulario de registro de un nuevo usuario en el sistema."),
            ("4", "Controles de edicion y permisos", "Acciones por fila para modificar datos del usuario o ajustar permisos individuales."),
            ("5", "Indicador de estado", "Columna que muestra si el usuario esta activo (con acceso) o inactivo (sin acceso temporal)."),
        ]
    },
    {
        "num": 13, "file": "13-piso-main.jpg",
        "caption": "Vista principal del modulo Kardex Piso con opciones de navegacion",
        "elements": [
            ("1", "Pestana Kardex Piso (activa)", "Indica que el usuario se encuentra en el modulo de gestion de piso, resaltada visualmente."),
            ("2", "Submenu de secciones de Piso", "Menu de navegacion lateral: Movimientos, Sectores, Stock y Configuracion."),
            ("3", "Panel de contenido principal", "Area central donde se despliega la informacion de la seccion seleccionada del modulo Piso."),
            ("4", "Indicador de sesion activa", "Muestra el nombre del usuario autenticado y opciones de gestion de sesion."),
        ]
    },
    {
        "num": 14, "file": "14-piso-movimientos.jpg",
        "caption": "Formulario de registro de movimientos de mercaderia en piso",
        "elements": [
            ("1", "Selector de sector", "Lista desplegable donde se elige el sector del piso al que pertenece el movimiento."),
            ("2", "Campo de codigo de producto", "Campo de texto para ingresar el identificador del producto involucrado en el movimiento."),
            ("3", "Campo de cantidad", "Campo numerico para especificar la cantidad de unidades del movimiento."),
            ("4", "Tipo de movimiento", "Selector para elegir entre Ingreso (entrada al sector) o Salida (retiro del sector)."),
            ("5", "Campos de lote y vencimiento", "Campos opcionales para informacion de trazabilidad del producto."),
            ("6", "Boton de registrar movimiento", "Boton que ejecuta el registro del movimiento en la base de datos del modulo Piso."),
            ("7", "Tabla de movimientos recientes", "Listado de los ultimos movimientos con datos de fecha, tipo, producto y sector."),
        ]
    },
    {
        "num": 15, "file": "15-piso-sectores.jpg",
        "caption": "Panel de administracion de sectores del modulo Kardex Piso",
        "elements": [
            ("1", "Lista de sectores configurados", "Relacion de todos los sectores definidos con nombre, descripcion y capacidad asignada."),
            ("2", "Boton de agregar sector", "Control que abre el formulario para crear un nuevo sector en el layout del piso."),
            ("3", "Campo de nombre de sector", "Campo de texto para definir el nombre identificador del nuevo sector."),
            ("4", "Campo de descripcion", "Area de texto para agregar una descripcion detallada del sector y su ubicacion fisica."),
            ("5", "Indicador de capacidad", "Campo numerico que establece la capacidad maxima del sector."),
            ("6", "Controles de edicion", "Botones para modificar o eliminar sectores existentes del sistema."),
        ]
    },
    {
        "num": 16, "file": "16-piso-stock.jpg",
        "caption": "Vista consolidada del stock de mercaderia por sector del piso",
        "elements": [
            ("1", "Selector de sector", "Lista desplegable para filtrar la vista de stock por sector o mostrar todos."),
            ("2", "Tabla de stock por sector", "Listado detallado con sector, producto, cantidad, lote y fecha de vencimiento."),
            ("3", "Indicadores de resumen", "Metricas con total de unidades, sectores activos y alertas de vencimiento."),
            ("4", "Controles de busqueda", "Campo de texto para buscar productos dentro del stock de piso."),
            ("5", "Boton de exportar", "Control para descargar el reporte de stock de piso en Excel o PDF."),
        ]
    },
    {
        "num": 17, "file": "17-piso-configuracion.jpg",
        "caption": "Panel de configuracion general del modulo Kardex Piso",
        "elements": [
            ("1", "Configuracion de sectores predeterminados", "Seccion para definir los sectores que se crean al inicializar el modulo Piso."),
            ("2", "Configuracion de alertas de stock", "Controles para establecer umbrales de alerta de stock minimo y maximo por sector."),
            ("3", "Configuracion de notificaciones", "Opciones para habilitar notificaciones automaticas (correos, alertas de vencimiento)."),
            ("4", "Boton de guardar configuracion", "Boton que almacena los cambios realizados en la configuracion del modulo Piso."),
            ("5", "Panel de informacion del sistema", "Seccion con datos tecnicos: version, ultima sincronizacion y estado de la conexion."),
        ]
    },
]

# ═══════════════════════════════════════════════════════════
# CUSTOM FLOWABLES
# ═══════════════════════════════════════════════════════════

class FigurePage(Flowable):
    """Full-page landscape figure with legend table below."""
    
    def __init__(self, image_path, figure_num, caption, elements, page_width, page_height, margin):
        Flowable.__init__(self)
        self.image_path = image_path
        self.figure_num = figure_num
        self.caption_text = caption
        self.elements = elements
        self.page_width = page_width
        self.page_height = page_height
        self.margin = margin
        # Frame has 6pt padding on each side
        self.width = page_width - 2 * margin - 12
        self.height = page_height - 2 * margin - 12
        
    def draw(self):
        c = self.canv
        avail_w = self.width
        avail_h = self.height
        
        # White background for entire page
        c.setFillColor(white)
        c.rect(0, 0, self.page_width, self.page_height, fill=1, stroke=0)
        
        # Layout calculation
        n_elements = len(self.elements)
        table_h = min(n_elements * 28 + 34, avail_h * 0.42)  # Cap table at 42%
        caption_h = 28
        header_h = 22
        image_h = avail_h - caption_h - header_h - table_h - 24
        
        if image_h < 150:
            image_h = avail_h * 0.48
            table_h = avail_h - caption_h - header_h - image_h - 24
        
        y = self.margin + avail_h
        
        # Figure number header
        y -= header_h
        c.setFont('LSerifB', 11)
        c.setFillColor(COLOR_ACCENT)
        c.drawString(self.margin, y + 4, f"Figura {self.figure_num}")
        
        y -= caption_h
        
        # Draw image scaled to fit
        img = PILImage.open(self.image_path)
        img_w, img_h = img.size
        scale = min(avail_w / img_w, image_h / img_h)
        draw_w = img_w * scale
        draw_h = img_h * scale
        
        x_off = self.margin + (avail_w - draw_w) / 2
        y_off = y - draw_h
        
        # Shadow
        c.setFillColor(HexColor("#E2E8F0"))
        c.roundRect(x_off + 3, y_off - 3, draw_w, draw_h, 4, fill=1, stroke=0)
        
        # Image
        c.drawImage(self.image_path, x_off, y_off, draw_w, draw_h, preserveAspectRatio=True, mask='auto')
        
        # Border
        c.setStrokeColor(COLOR_BORDER)
        c.setLineWidth(1.5)
        c.roundRect(x_off, y_off, draw_w, draw_h, 2, fill=0, stroke=1)
        
        y = y_off - 8
        
        # Caption (APA style italic)
        c.setFont('LSerifI', 9.5)
        c.setFillColor(HexColor("#64748B"))
        caption_full = f"Figura {self.figure_num}. {self.caption_text}."
        max_tw = avail_w
        words = caption_full.split()
        lines, cur = [], ""
        for w in words:
            test = cur + (" " if cur else "") + w
            if c.stringWidth(test, 'LSerifI', 9.5) > max_tw:
                lines.append(cur)
                cur = w
            else:
                cur = test
        if cur:
            lines.append(cur)
        for ln in lines:
            y -= 13
            c.drawString(self.margin, y, ln)
        
        y -= 10
        
        # Legend table
        self._draw_legend(c, y, avail_w, self.elements)
    
    def _draw_legend(self, c, y_start, avail_w, elements):
        x = self.margin
        row_h = 28
        header_h = 26
        
        # Header
        y = y_start
        c.setFillColor(COLOR_TABLE_HEADER)
        c.roundRect(x, y - header_h, avail_w, header_h, 0, fill=1, stroke=0)
        
        c.setFont('LSansB', 9)
        c.setFillColor(white)
        c.drawString(x + 15, y - header_h + 8, "N.")
        c.drawString(x + 45, y - header_h + 8, "Elemento de la interfaz")
        c.drawString(x + 45 + 160, y - header_h + 8, "Descripcion y funcion")
        
        y -= header_h
        
        for i, (num, elem_name, desc) in enumerate(elements):
            bg = COLOR_TABLE_ALT if i % 2 == 0 else COLOR_WHITE
            c.setFillColor(bg)
            c.rect(x, y - row_h, avail_w, row_h, fill=1, stroke=0)
            c.setStrokeColor(COLOR_BORDER)
            c.setLineWidth(0.5)
            c.line(x, y - row_h, x + avail_w, y - row_h)
            
            # Number circle
            cx, cy = x + 18, y - row_h / 2
            c.setFillColor(COLOR_SECONDARY)
            c.circle(cx, cy, 9, fill=1, stroke=0)
            c.setFont('LSansB', 9)
            c.setFillColor(white)
            nw = c.stringWidth(num, 'LSansB', 9)
            c.drawString(cx - nw / 2, cy - 3, num)
            
            # Element name
            c.setFont('LSansB', 9)
            c.setFillColor(COLOR_ACCENT)
            c.drawString(x + 35, y - row_h + 8, elem_name)
            
            # Description (with word wrap)
            c.setFont('LSerif', 8.5)
            c.setFillColor(HexColor("#475569"))
            desc_x = x + 35 + 160
            max_dw = avail_w - 35 - 160 - 15
            words = desc.split()
            l1, l2, cur = "", "", ""
            for w in words:
                test = cur + (" " if cur else "") + w
                if c.stringWidth(test, 'LSerif', 8.5) > max_dw:
                    if not l1:
                        l1 = cur
                    elif not l2:
                        l2 = cur
                        break
                    cur = w
                else:
                    cur = test
            if cur:
                if not l1:
                    l1 = cur
                elif not l2:
                    l2 = cur
            c.drawString(desc_x, y - row_h + 8, l1)
            if l2:
                c.drawString(desc_x, y - row_h - 3, l2)
            
            y -= row_h
        
        # Bottom border
        c.setStrokeColor(COLOR_TABLE_HEADER)
        c.setLineWidth(1.5)
        c.line(x, y, x + avail_w, y)


class SectionHeader(Flowable):
    """Section header with left accent bar."""
    
    def __init__(self, number, title, width, height=36):
        Flowable.__init__(self)
        self.number = number
        self.title = title
        self.width = width
        self.height = height
    
    def draw(self):
        c = self.canv
        c.setFillColor(COLOR_SECONDARY)
        c.rect(0, 0, 5, self.height, fill=1, stroke=0)
        c.setFont('LSerifB', 14)
        c.setFillColor(COLOR_ACCENT)
        c.drawString(14, self.height - 22, f"{self.number}. {self.title}")


def hr_line(color, width, thickness=0.5):
    """Create a horizontal rule."""
    t = Table([['']], colWidths=[width], rowHeights=[thickness])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, 0), color),
        ('LINEBELOW', (0, 0), (0, 0), thickness, color),
        ('TOPPADDING', (0, 0), (0, 0), 0),
        ('BOTTOMPADDING', (0, 0), (0, 0), 0),
        ('LEFTPADDING', (0, 0), (0, 0), 0),
        ('RIGHTPADDING', (0, 0), (0, 0), 0),
    ]))
    return t


# ═══════════════════════════════════════════════════════════
# PDF DOCUMENT BUILDER
# ═══════════════════════════════════════════════════════════

def build_pdf():
    doc = BaseDocTemplate(
        OUTPUT_PDF,
        pagesize=landscape(A4),
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=MARGIN,
        title="Manual de Usuario del Sistema Rackly",
        author="ECARAL",
        subject="Guia de usuario - Kardex Racks y Kardex Piso",
    )
    
    cw = PAGE_W - 2 * MARGIN
    ch = PAGE_H - 2 * MARGIN
    
    frame_cover = Frame(MARGIN, MARGIN, cw, ch, id='cover', leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    frame_content = Frame(MARGIN, MARGIN, cw, ch, id='content', leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    frame_figure = Frame(MARGIN, MARGIN, cw, ch, id='figure', leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    
    def on_cover(canvas_obj, doc_obj):
        canvas_obj.saveState()
        canvas_obj.setFont('LSerif', 8)
        canvas_obj.setFillColor(HexColor("#94A3B8"))
        canvas_obj.drawRightString(PAGE_W - MARGIN, MARGIN - 20, f"{doc_obj.page}")
        canvas_obj.restoreState()
    
    def on_content(canvas_obj, doc_obj):
        canvas_obj.saveState()
        canvas_obj.setFont('LSerifI', 8)
        canvas_obj.setFillColor(HexColor("#94A3B8"))
        canvas_obj.drawString(MARGIN, PAGE_H - MARGIN + 15, "Manual de Usuario - Sistema Rackly")
        canvas_obj.drawRightString(PAGE_W - MARGIN, PAGE_H - MARGIN + 15, "ECARAL")
        canvas_obj.setStrokeColor(COLOR_BORDER)
        canvas_obj.setLineWidth(0.5)
        canvas_obj.line(MARGIN, PAGE_H - MARGIN + 10, PAGE_W - MARGIN, PAGE_H - MARGIN + 10)
        canvas_obj.setFont('LSerif', 8)
        canvas_obj.drawRightString(PAGE_W - MARGIN, MARGIN - 20, f"{doc_obj.page}")
        canvas_obj.restoreState()
    
    doc.addPageTemplates([
        PageTemplate(id='Cover', frames=[frame_cover], onPage=on_cover),
        PageTemplate(id='Content', frames=[frame_content], onPage=on_content),
        PageTemplate(id='Figure', frames=[frame_figure], onPage=on_content),
    ])
    
    story = []
    
    # ═══════════════════════════════════════════════
    # COVER PAGE
    # ═══════════════════════════════════════════════
    story.append(Spacer(1, 80))
    story.append(hr_line(COLOR_SECONDARY, cw, 3))
    story.append(Spacer(1, 30))
    story.append(Paragraph("Manual de Usuario", style_title_cover))
    story.append(Paragraph("Sistema Rackly", ParagraphStyle(
        'TC2', fontName='LSerifB', fontSize=36, leading=44,
        textColor=COLOR_SECONDARY, alignment=TA_CENTER, spaceAfter=16
    )))
    story.append(Spacer(1, 16))
    story.append(Paragraph("Guia Visual para la Gestion de Almacen", style_subtitle_cover))
    story.append(Paragraph("Modulos: Kardex Racks y Kardex Piso", style_subtitle_cover))
    story.append(Spacer(1, 30))
    story.append(hr_line(COLOR_SECONDARY, cw, 3))
    story.append(Spacer(1, 40))
    
    story.append(Paragraph("Organizacion: ECARAL", style_info_cover))
    story.append(Paragraph("Departamento: Logistica y Almacen", style_info_cover))
    story.append(Paragraph("Documento: Manual de Referencia del Usuario", style_info_cover))
    story.append(Paragraph("Formato: APA 7.a edicion - Orientacion horizontal", style_info_cover))
    
    import datetime
    today = datetime.date.today()
    months = {1:'enero',2:'febrero',3:'marzo',4:'abril',5:'mayo',6:'junio',
              7:'julio',8:'agosto',9:'septiembre',10:'octubre',11:'noviembre',12:'diciembre'}
    story.append(Paragraph(f"Fecha: {today.day} de {months[today.month]} de {today.year}", style_info_cover))
    
    story.append(NextPageTemplate('Content'))
    story.append(PageBreak())
    
    # ═══════════════════════════════════════════════
    # TABLE OF CONTENTS
    # ═══════════════════════════════════════════════
    story.append(Paragraph("Indice de Contenidos", style_h1))
    story.append(hr_line(COLOR_BORDER, cw, 0.5))
    story.append(Spacer(1, 12))
    
    toc = [
        (0, "1. Introduccion"),
        (0, "2. Acceso al Sistema"),
        (1, "2.1. Pantalla de inicio de sesion"),
        (0, "3. Modulo Kardex Racks"),
        (1, "3.1. Vista principal"),
        (1, "3.2. Movimientos - Ingreso"),
        (1, "3.3. Movimientos - Salida"),
        (1, "3.4. Movimientos - Devolucion"),
        (1, "3.5. Traslado"),
        (1, "3.6. Catalogo"),
        (1, "3.7. Stock"),
        (1, "3.8. Ocupacion"),
        (1, "3.9. Descarga"),
        (1, "3.10. Control FEFO"),
        (1, "3.11. Usuarios y permisos"),
        (0, "4. Modulo Kardex Piso"),
        (1, "4.1. Vista principal"),
        (1, "4.2. Movimientos"),
        (1, "4.3. Sectores"),
        (1, "4.4. Stock"),
        (1, "4.5. Configuracion"),
        (0, "5. Glosario de terminos"),
    ]
    for level, text in toc:
        story.append(Paragraph(text, style_toc_h1 if level == 0 else style_toc_h2))
    
    story.append(Spacer(1, 20))
    story.append(Paragraph(
        "<b>Nota:</b> Este manual utiliza la convencion de figuras de la APA 7.a edicion. "
        "Cada figura se presenta en una pagina horizontal completa para garantizar la maxima visibilidad. "
        "Las tablas de leyenda que acompanan a cada figura describen los elementos de la interfaz "
        "numerados de forma secuencial.",
        style_body
    ))
    
    story.append(NextPageTemplate('Content'))
    story.append(PageBreak())
    
    # ═══════════════════════════════════════════════
    # SECTION 1: INTRODUCTION
    # ═══════════════════════════════════════════════
    story.append(SectionHeader("1", "Introduccion", cw))
    story.append(Spacer(1, 8))
    story.append(hr_line(COLOR_BORDER, cw, 0.5))
    story.append(Spacer(1, 8))
    
    story.append(Paragraph(
        "El sistema Rackly es una plataforma integral de gestion de almacen disenada para optimizar "
        "el control de mercaderia en entornos logisticos y de distribucion. Desarrollada con tecnologia web moderna, "
        "la aplicacion permite la administracion eficiente de dos areas fundamentales: los racks de almacenamiento vertical "
        "y las zonas de piso, proporcionando herramientas robustas para el registro, seguimiento y control de inventario "
        "en tiempo real.",
        style_body
    ))
    story.append(Paragraph(
        "El presente manual tiene como objetivo servir como guia de referencia visual para los usuarios del sistema Rackly. "
        "A traves de capturas de pantalla de alta resolucion acompanadas de tablas descriptivas, se documentan todas las "
        "funcionalidades disponibles en los modulos de Kardex Racks y Kardex Piso. Cada seccion incluye una explicacion "
        "detallada de los elementos de la interfaz grafica, los campos de los formularios y las acciones disponibles "
        "para el usuario.",
        style_body
    ))
    story.append(Paragraph(
        "La estructura del manual sigue el formato APA 7.a edicion, con paginas en orientacion horizontal para "
        "maximizar la visibilidad de las figuras. Cada figura se presenta en su propia pagina con una tabla de leyenda "
        "que describe los elementos numerados de la interfaz. Se recomienda utilizar este documento junto con el sistema "
        "para familiarizarse con las funcionalidades y consultarlo como referencia durante la operacion diaria.",
        style_body
    ))
    
    story.append(Spacer(1, 12))
    story.append(Paragraph("<b>Modulos del sistema:</b>", style_body))
    story.append(Spacer(1, 6))
    
    module_data = [
        ["Kardex Racks", "Gestion de almacenamiento vertical con control de stock por rack, nivel y posicion. "
         "Incluye movimientos de ingreso, salida y devolucion, traslados entre racks, control FEFO, gestion de "
         "usuarios y visualizacion de ocupacion."],
        ["Kardex Piso", "Gestion de mercaderia almacenada a nivel de piso, organizada por sectores. Permite "
         "registrar movimientos de entrada y salida por sector, consultar stock consolidado, administrar la "
         "configuracion de sectores y definir alertas de inventario."],
    ]
    
    mt = Table(module_data, colWidths=[140, cw - 160])
    mt.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (0, -1), COLOR_SECONDARY),
        ('TEXTCOLOR', (0, 0), (0, -1), white),
        ('FONTNAME', (0, 0), (0, -1), 'LSansB'),
        ('FONTSIZE', (0, 0), (0, -1), 10),
        ('FONTNAME', (1, 0), (1, -1), 'LSerif'),
        ('FONTSIZE', (1, 0), (1, -1), 10),
        ('TEXTCOLOR', (1, 0), (1, -1), HexColor("#334155")),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (0, 0), (0, -1), 'CENTER'),
        ('LEFTPADDING', (1, 0), (1, -1), 12),
        ('RIGHTPADDING', (1, 0), (1, -1), 12),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('GRID', (0, 0), (-1, -1), 0.5, COLOR_BORDER),
    ]))
    story.append(mt)
    
    story.append(NextPageTemplate('Content'))
    story.append(PageBreak())
    
    # ═══════════════════════════════════════════════
    # SECTION 2: ACCESS
    # ═══════════════════════════════════════════════
    story.append(SectionHeader("2", "Acceso al Sistema", cw))
    story.append(Spacer(1, 8))
    story.append(hr_line(COLOR_BORDER, cw, 0.5))
    story.append(Spacer(1, 6))
    
    story.append(Paragraph(
        "El acceso al sistema Rackly se realiza a traves de una interfaz web segura que requiere autenticacion "
        "con credenciales institucionales. Cada usuario debe contar con una cuenta previamente registrada por un "
        "administrador del sistema. El proceso de inicio de sesion consiste en ingresar el correo electronico "
        "asociado a la cuenta y la contrasena correspondiente en el formulario de login.",
        style_body
    ))
    story.append(Paragraph(
        "Una vez autenticado, el usuario accede al panel principal donde puede navegar entre los modulos "
        "de Kardex Racks y Kardex Piso. Los permisos de acceso a cada funcionalidad dependen del rol asignado: "
        "Administrador, Operador o Lector. A continuacion se muestra la pantalla de inicio de sesion y la vista principal "
        "del modulo Kardex Racks.",
        style_body
    ))
    
    # ═══════════════════════════════════════════════
    # FIGURE PAGES (first figure will handle the page break)
    # ═══════════════════════════════════════════════
    
    section_map = {
        1: ("2.1", "Pantalla de inicio de sesion"),
        2: ("3.1", "Vista principal del modulo Kardex Racks"),
        3: ("3.2", "Movimientos - Registro de ingreso"),
        4: ("3.3", "Movimientos - Registro de salida"),
        5: ("3.4", "Movimientos - Registro de devolucion"),
        6: ("3.5", "Traslado entre racks"),
        7: ("3.6", "Catalogo de productos"),
        8: ("3.7", "Control de stock"),
        9: ("3.8", "Ocupacion de racks"),
        10: ("3.9", "Descarga de reportes"),
        11: ("3.10", "Control FEFO (First Expired, First Out)"),
        12: ("3.11", "Administracion de usuarios y permisos"),
        13: ("4.1", "Vista principal del modulo Kardex Piso"),
        14: ("4.2", "Movimientos de piso"),
        15: ("4.3", "Administracion de sectores"),
        16: ("4.4", "Stock de piso"),
        17: ("4.5", "Configuracion del modulo Piso"),
    }
    
    section_intros = {
        3: "La seccion de Movimientos es el componente central del modulo Kardex Racks. Permite registrar tres tipos de operaciones: "
            "ingresos (entrada de nuevos productos), salidas (retiro de productos del almacen) y devoluciones (reintegro de productos previamente retirados).",
        6: "La funcionalidad de Traslado permite mover mercaderia entre diferentes racks del almacen, manteniendo trazabilidad completa. "
            "Es util para reorganizar el almacen o cambiar la ubicacion de productos por motivos logisticos.",
        7: "El Catalogo de productos es el repositorio centralizado de todos los productos registrados en el sistema. "
            "Los administradores pueden agregar, modificar y gestionar las referencias de mercaderia disponibles.",
        8: "La vista de Stock consolida la informacion de inventario de todos los racks del sistema, mostrando cantidades, "
            "posiciones, lotes y fechas de vencimiento en tiempo real.",
        9: "El panel de Ocupacion proporciona una representacion visual del estado de los racks mediante un mapa de colores "
            "que indica el nivel de ocupacion de cada posicion.",
        10: "La seccion de Descarga permite generar y exportar reportes en Excel o PDF seleccionando tipo de reporte, "
            "rango de fechas y racks especificos.",
        11: "El control FEFO (First Expired, First Out) prioriza la salida de los productos con fecha de vencimiento mas proxima, "
            "mostrando alertas por colores segun la urgencia.",
        12: "La seccion de Usuarios permite gestionar cuentas de acceso, asignar roles (Administrador, Operador, Lector) "
            "y controlar el estado de cada usuario del sistema.",
        13: "El modulo Kardex Piso gestiona la mercaderia almacenada a nivel de suelo, organizada por sectores definidos.",
        14: "Los movimientos de Piso permiten registrar entradas y salidas de mercaderia en cada sector del area de piso.",
        15: "La administracion de Sectores permite definir y configurar las zonas fisicas del area de piso del almacen.",
        16: "El stock de Piso consolida la informacion de inventario de todos los sectores del area de piso en un solo panel.",
        17: "La configuracion del modulo Piso permite personalizar sectores predeterminados, umbrales de alertas y preferencias de notificacion.",
    }
    
    for fig in FIGURES:
        img_path = os.path.join(SCREENSHOT_DIR, fig["file"])
        if not os.path.exists(img_path):
            print(f"WARNING: Missing {img_path}")
            continue
        
        sn, st = section_map.get(fig["num"], ("", ""))
        
        if sn:
            major = sn.split(".")[0]
            
            # Major section header for Kardex Racks
            if fig["num"] == 3:
                story.append(NextPageTemplate('Content'))
                story.append(PageBreak())
                story.append(SectionHeader("3", "Modulo Kardex Racks", cw))
                story.append(Spacer(1, 8))
                story.append(hr_line(COLOR_BORDER, cw, 0.5))
                story.append(Spacer(1, 6))
                story.append(Paragraph(
                    "El modulo Kardex Racks es el componente principal del sistema Rackly para la gestion de mercaderia "
                    "almacenada en racks verticales. Ofrece funcionalidades completas de registro de movimientos de entrada, "
                    "salida y devolucion, traslados entre racks, control de stock por posicion, visualizacion de ocupacion "
                    "en tiempo real, gestion de catalogos, control FEFO y administracion de usuarios y permisos.",
                    style_body
                ))
            
            # Major section header for Kardex Piso
            elif fig["num"] == 13:
                story.append(NextPageTemplate('Content'))
                story.append(PageBreak())
                story.append(SectionHeader("4", "Modulo Kardex Piso", cw))
                story.append(Spacer(1, 8))
                story.append(hr_line(COLOR_BORDER, cw, 0.5))
                story.append(Spacer(1, 6))
                story.append(Paragraph(
                    "El modulo Kardex Piso complementa al modulo de Kardex Racks proporcionando herramientas para la gestion "
                    "de mercaderia almacenada en las areas de piso del almacen. La organizacion se basa en sectores definidos "
                    "por el usuario, permitiendo control granular del inventario distribuido. Incluye funcionalidades de "
                    "movimientos por sector, stock consolidado, configuracion de sectores y alertas de inventario.",
                    style_body
                ))
            
            # Sub-section intro
            if fig["num"] in section_intros:
                story.append(NextPageTemplate('Content'))
                story.append(PageBreak())
                story.append(Paragraph(f"<b>{sn}. {st}</b>", style_h2))
                story.append(Spacer(1, 4))
                story.append(Paragraph(section_intros[fig["num"]], style_body))
        
        # Figure page
        story.append(NextPageTemplate('Figure'))
        story.append(PageBreak())
        story.append(FigurePage(
            img_path, fig["num"], fig["caption"], fig["elements"],
            PAGE_W, PAGE_H, MARGIN
        ))
    
    # ═══════════════════════════════════════════════
    # SECTION 5: GLOSSARY
    # ═══════════════════════════════════════════════
    story.append(NextPageTemplate('Content'))
    story.append(PageBreak())
    story.append(SectionHeader("5", "Glosario de Terminos", cw))
    story.append(Spacer(1, 8))
    story.append(hr_line(COLOR_BORDER, cw, 0.5))
    story.append(Spacer(1, 8))
    
    glossary = [
        ["Kardex", "Sistema de control de inventario que registra los movimientos de entrada y salida de mercaderia, manteniendo un historial actualizado del stock disponible."],
        ["Rack", "Estructura de almacenamiento vertical que organiza la mercaderia en niveles y posiciones definidas para maximizar el uso del espacio."],
        ["Sector", "Area delimitada dentro del espacio de piso del almacen, utilizada para organizar la mercaderia almacenada a nivel de suelo."],
        ["FEFO", "Acronimo de First Expired, First Out (primer vencido, primero en salir). Metodo de gestion que prioriza la salida de productos con fecha de vencimiento mas proxima."],
        ["Lote", "Identificador unico asignado a un grupo de productos fabricados o recibidos en las mismas condiciones y fecha."],
        ["Traslado", "Operacion de movimiento de mercaderia entre diferentes ubicaciones de almacenamiento (entre racks o entre posiciones)."],
        ["Devolucion", "Proceso de reintegro de mercaderia previamente retirada del almacen, restaurandola al inventario activo."],
        ["Ocupacion", "Metrica que indica el porcentaje de capacidad utilizada en un rack, nivel o sector del almacen."],
        ["Stock", "Cantidad total de unidades de un producto determinado disponibles en el almacen en un momento dado."],
        ["Catalogo", "Registro maestro de todos los productos que el sistema maneja, incluyendo codigos, descripciones y unidades de medida."],
    ]
    
    gt = Table([["Termino", "Definicion"]] + glossary, colWidths=[100, cw - 120])
    gt.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), COLOR_TABLE_HEADER),
        ('TEXTCOLOR', (0, 0), (-1, 0), white),
        ('FONTNAME', (0, 0), (-1, 0), 'LSansB'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('FONTNAME', (0, 1), (0, -1), 'LSansB'),
        ('FONTNAME', (1, 1), (1, -1), 'LSerif'),
        ('FONTSIZE', (0, 1), (-1, -1), 9.5),
        ('TEXTCOLOR', (0, 1), (0, -1), COLOR_ACCENT),
        ('TEXTCOLOR', (1, 1), (1, -1), HexColor("#334155")),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (0, 0), (0, -1), 'LEFT'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('GRID', (0, 0), (-1, -1), 0.5, COLOR_BORDER),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [COLOR_WHITE, COLOR_TABLE_ALT]),
    ]))
    story.append(gt)
    
    story.append(Spacer(1, 20))
    story.append(Paragraph("<b>Roles y permisos del sistema:</b>", style_body))
    story.append(Spacer(1, 6))
    
    roles = [
        ["Rol", "Permisos"],
        ["Administrador", "Acceso completo a todas las funcionalidades: movimientos, traslados, catalogo, stock, ocupacion, descarga, FEFO, usuarios y configuracion."],
        ["Operador", "Acceso a funciones operativas: registro de movimientos, traslados, consulta de stock, ocupacion y descarga de reportes."],
        ["Lector", "Acceso de solo lectura: consulta de stock, visualizacion de ocupacion y descarga de reportes."],
    ]
    
    rt = Table(roles, colWidths=[110, cw - 130])
    rt.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), COLOR_TABLE_HEADER),
        ('TEXTCOLOR', (0, 0), (-1, 0), white),
        ('FONTNAME', (0, 0), (-1, 0), 'LSansB'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('FONTNAME', (0, 1), (0, -1), 'LSansB'),
        ('FONTNAME', (1, 1), (1, -1), 'LSerif'),
        ('FONTSIZE', (0, 1), (-1, -1), 9.5),
        ('TEXTCOLOR', (0, 1), (0, -1), COLOR_ACCENT),
        ('TEXTCOLOR', (1, 1), (1, -1), HexColor("#334155")),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('GRID', (0, 0), (-1, -1), 0.5, COLOR_BORDER),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [COLOR_WHITE, COLOR_TABLE_ALT]),
    ]))
    story.append(rt)
    
    # BUILD
    print("Building PDF...")
    doc.build(story)
    print(f"PDF generated: {OUTPUT_PDF}")
    file_size = os.path.getsize(OUTPUT_PDF)
    print(f"File size: {file_size / (1024*1024):.2f} MB")


if __name__ == "__main__":
    build_pdf()

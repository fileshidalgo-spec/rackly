#!/usr/bin/env python3
"""Generate RACKLY integration maps and 5S document."""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import matplotlib.font_manager as fm
import numpy as np
from PIL import Image
import os

# ── Font setup ──
fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

OUT = '/home/z/my-project/download'
os.makedirs(OUT, exist_ok=True)

# ═══════════════════════════════════════════════════════════
# MAP 1: Architecture Overview (System Map)
# ═══════════════════════════════════════════════════════════
def draw_architecture_map():
    fig, ax = plt.subplots(1, 1, figsize=(22, 16))
    ax.set_xlim(0, 22)
    ax.set_ylim(0, 16)
    ax.axis('off')
    fig.patch.set_facecolor('#0F172A')

    # Title
    ax.text(11, 15.4, 'RACKLY - Mapa de Arquitectura del Sistema', fontsize=20, fontweight='bold',
            ha='center', va='center', color='#F8FAFC', fontfamily='DejaVu Sans')
    ax.text(11, 14.9, 'Gestion de Almacen v2.0 | Next.js 16 + Supabase + Cloudflare Pages',
            fontsize=11, ha='center', va='center', color='#94A3B8')

    # ── Layer 1: Frontend (Top) ──
    layer_y = 12.5
    box_h = 2.2
    # Frontend container
    rect = FancyBboxPatch((0.5, layer_y - 0.2), 21, box_h + 0.4, boxstyle="round,pad=0.2",
                          facecolor='#1E293B', edgecolor='#3B82F6', linewidth=2)
    ax.add_patch(rect)
    ax.text(1, layer_y + box_h - 0.1, 'CAPA FRONTAL (Next.js 16 - Static Export)',
            fontsize=13, fontweight='bold', color='#60A5FA')

    # Main Page
    main_x = 1.5
    main_w = 4
    r = FancyBboxPatch((main_x, layer_y + 0.1), main_w, 1.6, boxstyle="round,pad=0.15",
                       facecolor='#1E3A5F', edgecolor='#3B82F6', linewidth=1.5)
    ax.add_patch(r)
    ax.text(main_x + main_w/2, layer_y + 1.3, 'page.tsx', fontsize=11, fontweight='bold',
            ha='center', color='#93C5FD')
    ax.text(main_x + main_w/2, layer_y + 0.85, 'Vista Racks (8 tabs)', fontsize=8, ha='center', color='#CBD5E1')
    ax.text(main_x + main_w/2, layer_y + 0.5, 'Vista Piso (4 tabs)', fontsize=8, ha='center', color='#CBD5E1')

    # Auth Gate
    auth_x = 6.5
    auth_w = 3
    r = FancyBboxPatch((auth_x, layer_y + 0.1), auth_w, 1.6, boxstyle="round,pad=0.15",
                       facecolor='#1E3A5F', edgecolor='#3B82F6', linewidth=1.5)
    ax.add_patch(r)
    ax.text(auth_x + auth_w/2, layer_y + 1.3, 'AuthGate', fontsize=11, fontweight='bold',
            ha='center', color='#93C5FD')
    ax.text(auth_x + auth_w/2, layer_y + 0.85, 'Login / Registro', fontsize=8, ha='center', color='#CBD5E1')
    ax.text(auth_x + auth_w/2, layer_y + 0.5, 'Roles y Permisos', fontsize=8, ha='center', color='#CBD5E1')

    # Tabs Racks
    tabs_x = 10.2
    tabs_w = 5
    r = FancyBboxPatch((tabs_x, layer_y + 0.1), tabs_w, 1.6, boxstyle="round,pad=0.15",
                       facecolor='#1E3A5F', edgecolor='#22C55E', linewidth=1.5)
    ax.add_patch(r)
    ax.text(tabs_x + tabs_w/2, layer_y + 1.3, 'Vista Racks', fontsize=11, fontweight='bold',
            ha='center', color='#4ADE80')
    rack_tabs = ['Movimientos', 'Traslado', 'Catalogo', 'Stock', 'Ocupacion', 'Descarga', 'FEFO', 'Usuarios']
    for i, tab in enumerate(rack_tabs):
        col = i % 4
        row = i // 4
        ax.text(tabs_x + 0.4 + col * 1.2, layer_y + 0.85 - row * 0.4, tab,
                fontsize=7, color='#A7F3D0')

    # Tabs Piso
    piso_x = 15.7
    piso_w = 5.3
    r = FancyBboxPatch((piso_x, layer_y + 0.1), piso_w, 1.6, boxstyle="round,pad=0.15",
                       facecolor='#1E3A5F', edgecolor='#F59E0B', linewidth=1.5)
    ax.add_patch(r)
    ax.text(piso_x + piso_w/2, layer_y + 1.3, 'Vista Piso', fontsize=11, fontweight='bold',
            ha='center', color='#FCD34D')
    piso_tabs = ['Movimientos', 'UP Kardex', 'Sectores', 'Config Columnas']
    for i, tab in enumerate(piso_tabs):
        ax.text(piso_x + 0.4 + i * 1.3, layer_y + 0.7, tab, fontsize=7, color='#FDE68A')

    # ── Layer 2: Library / Business Logic ──
    lib_y = 9.2
    rect = FancyBboxPatch((0.5, lib_y - 0.2), 21, 2.8, boxstyle="round,pad=0.2",
                          facecolor='#1E293B', edgecolor='#8B5CF6', linewidth=2)
    ax.add_patch(rect)
    ax.text(1, lib_y + 2.4, 'CAPA LOGICA DE NEGOCIO (Librerias TypeScript)', fontsize=13,
            fontweight='bold', color='#A78BFA')

    libs = [
        ('kardex.ts', 'Movimientos CRUD\nStock / Transferencia\nBatch Upload', '#7C3AED', 1.2),
        ('auth.ts', 'Registro / Login\nPerfiles / Roles\nAprobacion', '#7C3AED', 4.8),
        ('catalogo.ts', 'CRUD Catalogo\nCache en memoria\nParseo Excel/CSV', '#7C3AED', 8.4),
        ('ubicaciones.ts', 'Config Bloques\nTorres / Posiciones\nCalculo Celdas', '#7C3AED', 12.0),
        ('piso/api.ts', 'CRUD Sectores\nColumnas / Niveles\nMovimientos Piso', '#D97706', 15.6),
    ]

    for name, desc, color, x in libs:
        w = 3.2
        r = FancyBboxPatch((x, lib_y + 0.2), w, 1.8, boxstyle="round,pad=0.12",
                           facecolor='#2D1B69' if color == '#7C3AED' else '#451A03',
                           edgecolor=color, linewidth=1.2)
        ax.add_patch(r)
        ax.text(x + w/2, lib_y + 1.7, name, fontsize=9, fontweight='bold', ha='center', color='#DDD6FE')
        for i, line in enumerate(desc.split('\n')):
            ax.text(x + w/2, lib_y + 1.2 - i * 0.35, line, fontsize=7, ha='center', color='#C4B5FD')

    # Extra boxes
    extras = [('constants.ts', 'Turnos, Roles, Bloques', 1.2, 0.4),
              ('turno.ts', 'Calculo Dia/Noche', 4.8, 0.4),
              ('utils.ts', 'Formato, Fechas, Stock', 8.4, 0.4)]
    for name, desc, x, y in extras:
        r = FancyBboxPatch((x, lib_y + y), 3.2, 1.0, boxstyle="round,pad=0.1",
                           facecolor='#1E293B', edgecolor='#475569', linewidth=1)
        ax.add_patch(r)
        ax.text(x + 1.6, lib_y + y + 0.7, name, fontsize=8, fontweight='bold', ha='center', color='#94A3B8')
        ax.text(x + 1.6, lib_y + y + 0.3, desc, fontsize=6.5, ha='center', color='#64748B')

    # ── Layer 3: Data & Auth ──
    data_y = 6.0
    # Supabase
    rect = FancyBboxPatch((0.5, data_y - 0.2), 12, 2.6, boxstyle="round,pad=0.2",
                          facecolor='#1E293B', edgecolor='#06B6D4', linewidth=2)
    ax.add_patch(rect)
    ax.text(1, data_y + 2.2, 'SUPABASE (Backend-as-a-Service)', fontsize=13,
            fontweight='bold', color='#22D3EE')

    # DB Tables
    tables = [
        ('movimientos', 'Ingresos, Salidas,\nDevoluciones, Traslados', 1.2),
        ('catalogo', 'Codigos, Descripciones,\nUnidades, Stock BM', 4.2),
        ('profiles +\nuser_roles', 'Usuarios, Roles,\nAprobaciones', 7.2),
        ('piso_*\n(6 tablas)', 'Sectores, Columnas,\nMovimientos Piso', 10.0),
    ]
    for name, desc, x in tables:
        w = 2.6
        r = FancyBboxPatch((x, data_y + 0.2), w, 1.6, boxstyle="round,pad=0.1",
                           facecolor='#083344', edgecolor='#06B6D4', linewidth=1)
        ax.add_patch(r)
        ax.text(x + w/2, data_y + 1.5, name, fontsize=8, fontweight='bold', ha='center', color='#67E8F9')
        ax.text(x + w/2, data_y + 0.8, desc, fontsize=6.5, ha='center', color='#A5F3FC')

    # RPC Functions
    rpc_x = 13.2
    rect = FancyBboxPatch((rpc_x, data_y - 0.2), 3.5, 2.6, boxstyle="round,pad=0.2",
                          facecolor='#1E293B', edgecolor='#14B8A6', linewidth=2)
    ax.add_patch(rect)
    ax.text(rpc_x + 1.75, data_y + 2.2, 'FUNCIONES RPC', fontsize=11, fontweight='bold',
            ha='center', color='#2DD4BF')
    rpcs = ['stock_en_ubicacion()', 'ocupacion_celdas()', 'piso_registrar_mov()']
    for i, rpc in enumerate(rpcs):
        ax.text(rpc_x + 0.3, data_y + 1.5 - i * 0.45, rpc, fontsize=7, color='#99F6E4')

    # Realtime + Auth
    ra_x = 17.2
    rect = FancyBboxPatch((ra_x, data_y - 0.2), 4.3, 2.6, boxstyle="round,pad=0.2",
                          facecolor='#1E293B', edgecolor='#F43F5E', linewidth=2)
    ax.add_patch(rect)
    ax.text(ra_x + 2.15, data_y + 2.2, 'SERVICIOS', fontsize=11, fontweight='bold',
            ha='center', color='#FB7185')
    services = ['Auth (JWT)', 'Realtime (WebSockets)', 'RLS (Row Level Security)', 'Storage']
    for i, svc in enumerate(services):
        ax.text(ra_x + 0.3, data_y + 1.5 - i * 0.45, svc, fontsize=7, color='#FDA4AF')

    # ── Layer 4: Deployment ──
    dep_y = 3.5
    rect = FancyBboxPatch((0.5, dep_y - 0.2), 21, 1.8, boxstyle="round,pad=0.2",
                          facecolor='#1E293B', edgecolor='#F97316', linewidth=2)
    ax.add_patch(rect)
    ax.text(1, dep_y + 1.4, 'INFRAESTRUCTURA DE DESPLIEGUE', fontsize=13,
            fontweight='bold', color='#FB923C')

    dep_items = [
        ('GitHub', 'Repositorio\ncodigo fuente', 1.5),
        ('Cloudflare Pages', 'Hosting static\nCDN global', 5.5),
        ('Supabase Cloud', 'Base de datos\nPostgreSQL', 9.5),
        ('rackly.pages.dev', 'URL produccion\nHTTPS', 13.5),
        ('Next.js 16', 'Turbopack\nStatic Export', 17.5),
    ]
    for name, desc, x in dep_items:
        w = 3.5
        r = FancyBboxPatch((x, dep_y + 0.1), w, 1.0, boxstyle="round,pad=0.1",
                           facecolor='#431407', edgecolor='#F97316', linewidth=1)
        ax.add_patch(r)
        ax.text(x + w/2, dep_y + 0.8, name, fontsize=9, fontweight='bold', ha='center', color='#FDBA74')
        ax.text(x + w/2, dep_y + 0.35, desc, fontsize=7, ha='center', color='#FED7AA')

    # ── Arrows between layers ──
    arrow_style = dict(arrowstyle='->', color='#475569', linewidth=1.5, connectionstyle='arc3,rad=0')
    # Frontend to Libraries
    ax.annotate('', xy=(6.5, lib_y + 2.6), xytext=(6.5, layer_y - 0.2), arrowprops=arrow_style)
    # Libraries to Data
    ax.annotate('', xy=(6.5, data_y + 2.6), xytext=(6.5, lib_y - 0.2), arrowprops=arrow_style)
    # Data to Deployment
    ax.annotate('', xy=(6.5, dep_y + 1.8), xytext=(6.5, data_y - 0.2), arrowprops=arrow_style)

    # ── Stats footer ──
    ax.text(11, 2.7, '13 Tablas de BD  |  5 Funciones RPC  |  12 Tabs de UI  |  ~7,000 lineas de codigo  |  7 Roles definidos',
            fontsize=10, ha='center', color='#64748B', style='italic')

    plt.tight_layout()
    path = os.path.join(OUT, 'RACKLY_Mapa_Arquitectura.png')
    fig.savefig(path, dpi=180, bbox_inches='tight', facecolor='#0F172A')
    plt.close()
    print(f'Created: {path}')
    return path


# ═══════════════════════════════════════════════════════════
# MAP 2: Data Flow Map (Flujo de Datos)
# ═══════════════════════════════════════════════════════════
def draw_dataflow_map():
    fig, ax = plt.subplots(1, 1, figsize=(24, 18))
    ax.set_xlim(0, 24)
    ax.set_ylim(0, 18)
    ax.axis('off')
    fig.patch.set_facecolor('#0F172A')

    ax.text(12, 17.4, 'RACKLY - Mapa de Flujo de Datos', fontsize=20, fontweight='bold',
            ha='center', color='#F8FAFC')
    ax.text(12, 16.9, 'Como se conectan los modulos y fluye la informacion entre ellos',
            fontsize=12, ha='center', color='#94A3B8')

    def draw_node(x, y, w, h, title, items, color, subcolor):
        r = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.15",
                           facecolor='#1E293B', edgecolor=color, linewidth=2)
        ax.add_patch(r)
        ax.text(x + w/2, y + h - 0.3, title, fontsize=11, fontweight='bold',
                ha='center', color=color)
        for i, item in enumerate(items):
            ax.text(x + 0.3, y + h - 0.7 - i * 0.3, item, fontsize=7.5, color=subcolor)

    def draw_arrow(x1, y1, x2, y2, label='', color='#475569'):
        ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                    arrowprops=dict(arrowstyle='->', color=color, linewidth=2,
                                    connectionstyle='arc3,rad=0.05'))
        if label:
            mx, my = (x1+x2)/2, (y1+y2)/2
            ax.text(mx, my + 0.15, label, fontsize=6.5, ha='center', color=color,
                    bbox=dict(boxstyle='round,pad=0.1', facecolor='#0F172A', edgecolor='none'))

    # ── User Actions (Left) ──
    uy = 13
    actions = [
        ('Registro Ingreso', 'movimientos', '#22C55E'),
        ('Registro Salida', 'movimientos', '#EF4444'),
        ('Devolucion', 'movimientos', '#3B82F6'),
        ('Traslado', 'movimientos x2', '#8B5CF6'),
        ('UP Data Excel', 'movimientos (batch)', '#F97316'),
        ('Gestion Usuarios', 'profiles + user_roles', '#EC4899'),
        ('Importar Catalogo', 'catalogo', '#06B6D4'),
    ]

    r = FancyBboxPatch((0.5, 3), 4.5, 12.5, boxstyle="round,pad=0.2",
                       facecolor='#1E293B', edgecolor='#F59E0B', linewidth=2)
    ax.add_patch(r)
    ax.text(2.75, 15.2, 'ACCIONES DEL USUARIO', fontsize=13, fontweight='bold',
            ha='center', color='#FCD34D')

    for i, (name, table, color) in enumerate(actions):
        y = uy - i * 1.6
        r = FancyBboxPatch((0.8, y), 4, 1.2, boxstyle="round,pad=0.1",
                           facecolor='#1E293B', edgecolor=color, linewidth=1.5)
        ax.add_patch(r)
        ax.text(2.8, y + 0.8, name, fontsize=9, fontweight='bold', ha='center', color=color)
        ax.text(2.8, y + 0.3, table, fontsize=7, ha='center', color='#94A3B8')

    # ── Processing Layer (Center) ──
    cx = 6.5
    rect = FancyBboxPatch((cx, 3), 5.5, 12.5, boxstyle="round,pad=0.2",
                          facecolor='#1E293B', edgecolor='#8B5CF6', linewidth=2)
    ax.add_patch(rect)
    ax.text(cx + 2.75, 15.2, 'CAPA DE PROCESAMIENTO', fontsize=13,
            fontweight='bold', ha='center', color='#A78BFA')

    procs = [
        ('Validaciones', ['Verificar ubicacion ocupada', 'Verificar stock disponible', 'Calcular turno Dia/Noche', 'Validar permisos de rol']),
        ('Funciones RPC', ['stock_en_ubicacion()', 'ocupacion_celdas()', 'piso_registrar_mov()']),
        ('Logica de Stock', ['Ingreso: +cantidad', 'Salida: -cantidad', 'Devolucion: +cantidad', 'Traslado: +dest, -orig']),
    ]

    py = 13.5
    for title, items in procs:
        h = 0.4 + len(items) * 0.35
        r = FancyBboxPatch((cx + 0.3, py - h + 0.3), 5, h, boxstyle="round,pad=0.1",
                           facecolor='#2D1B69', edgecolor='#8B5CF6', linewidth=1)
        ax.add_patch(r)
        ax.text(cx + 0.5, py, title, fontsize=9, fontweight='bold', color='#C4B5FD')
        for j, item in enumerate(items):
            ax.text(cx + 0.5, py - 0.4 - j * 0.35, item, fontsize=7.5, color='#A78BFA')
        py -= h + 0.5

    # ── Database (Right-center) ──
    dx = 13
    rect = FancyBboxPatch((dx, 3), 4.5, 12.5, boxstyle="round,pad=0.2",
                          facecolor='#1E293B', edgecolor='#06B6D4', linewidth=2)
    ax.add_patch(rect)
    ax.text(dx + 2.25, 15.2, 'BASE DE DATOS', fontsize=13,
            fontweight='bold', ha='center', color='#22D3EE')

    db_tables = [
        ('movimientos', '#22C55E'),
        ('catalogo', '#06B6D4'),
        ('profiles', '#EC4899'),
        ('user_roles', '#EC4899'),
        ('piso_sectores', '#F59E0B'),
        ('piso_columnas', '#F59E0B'),
        ('piso_bloques', '#F59E0B'),
        ('piso_movimientos', '#F59E0B'),
        ('piso_mov_detalles', '#F59E0B'),
    ]
    for i, (tname, tcolor) in enumerate(db_tables):
        ty = 14.2 - i * 1.2
        r = FancyBboxPatch((dx + 0.3, ty), 4, 0.9, boxstyle="round,pad=0.08",
                           facecolor='#083344', edgecolor=tcolor, linewidth=1)
        ax.add_patch(r)
        ax.text(dx + 2.3, ty + 0.5, tname, fontsize=9, fontweight='bold',
                ha='center', color=tcolor)

    # ── Views that consume data (Right) ──
    vx = 18.5
    rect = FancyBboxPatch((vx, 3), 5, 12.5, boxstyle="round,pad=0.2",
                          facecolor='#1E293B', edgecolor='#22C55E', linewidth=2)
    ax.add_patch(rect)
    ax.text(vx + 2.5, 15.2, 'VISTAS QUE SE ACTUALIZAN', fontsize=13,
            fontweight='bold', ha='center', color='#4ADE80')

    views = [
        ('Stock Tab', 'Stock actualizado', '#22C55E'),
        ('Ocupacion Grid', 'Mapa visual celdas', '#3B82F6'),
        ('FEFO Reporte', 'Vencimientos', '#EF4444'),
        ('Tabla Historial', 'Ultimos movimientos', '#8B5CF6'),
        ('Descarga Excel', 'Exportar datos', '#F97316'),
        ('Realtime Sync', 'WebSocket a todos', '#06B6D4'),
    ]
    for i, (vname, vdesc, vcolor) in enumerate(views):
        vy = 14 - i * 1.8
        r = FancyBboxPatch((vx + 0.3, vy), 4.4, 1.4, boxstyle="round,pad=0.1",
                           facecolor='#1E293B', edgecolor=vcolor, linewidth=1.5)
        ax.add_patch(r)
        ax.text(vx + 2.5, vy + 1.0, vname, fontsize=9, fontweight='bold',
                ha='center', color=vcolor)
        ax.text(vx + 2.5, vy + 0.5, vdesc, fontsize=7.5, ha='center', color='#94A3B8')

    # ── Flow arrows ──
    # Actions -> Processing
    draw_arrow(5.3, 14.5, cx + 0.3, 14.5, '')
    draw_arrow(5.3, 12.9, cx + 0.3, 12.5, '')
    draw_arrow(5.3, 11.3, cx + 0.3, 10.5, '')
    draw_arrow(5.3, 9.7, cx + 0.3, 9.0, '')
    draw_arrow(5.3, 8.1, cx + 0.3, 7.0, '')
    draw_arrow(5.3, 6.5, cx + 0.3, 5.5, '')
    draw_arrow(5.3, 4.9, cx + 0.3, 4.0, '')

    # Processing -> DB
    draw_arrow(cx + 5.5, 12.0, dx + 0.3, 14.0, 'INSERT')
    draw_arrow(cx + 5.5, 10.0, dx + 0.3, 11.5, 'SELECT')
    draw_arrow(cx + 5.5, 7.5, dx + 0.3, 8.0, 'RPC')
    draw_arrow(cx + 5.5, 5.0, dx + 0.3, 5.0, 'BATCH')

    # DB -> Views
    draw_arrow(dx + 4.5, 14.0, vx + 0.3, 14.0, '')
    draw_arrow(dx + 4.5, 11.5, vx + 0.3, 12.2, 'Realtime')
    draw_arrow(dx + 4.5, 8.0, vx + 0.3, 8.5, '')
    draw_arrow(dx + 4.5, 5.0, vx + 0.3, 5.7, '')

    # Legend
    ax.text(12, 2.2, 'INSERT = Crear registro  |  SELECT = Consultar  |  RPC = Funcion en BD  |  BATCH = Operacion masiva (1000 filas/lote)',
            fontsize=9, ha='center', color='#64748B')

    plt.tight_layout()
    path = os.path.join(OUT, 'RACKLY_Mapa_FlujoDatos.png')
    fig.savefig(path, dpi=180, bbox_inches='tight', facecolor='#0F172A')
    plt.close()
    print(f'Created: {path}')
    return path


# ═══════════════════════════════════════════════════════════
# MAP 3: Module Integration Map (Mapa de Integracion)
# ═══════════════════════════════════════════════════════════
def draw_integration_map():
    fig, ax = plt.subplots(1, 1, figsize=(24, 18))
    ax.set_xlim(0, 24)
    ax.set_ylim(0, 18)
    ax.axis('off')
    fig.patch.set_facecolor('#0F172A')

    ax.text(12, 17.4, 'RACKLY - Mapa de Integracion de Modulos', fontsize=20, fontweight='bold',
            ha='center', color='#F8FAFC')
    ax.text(12, 16.9, 'Relaciones entre tabs, librerias y tablas de la base de datos',
            fontsize=12, ha='center', color='#94A3B8')

    # Central modules as nodes
    modules = {
        'Movimientos': (12, 14, '#22C55E', ['movimientos', 'catalogo', 'BLOQUES/PISOS', 'TORRES/POSICIONES']),
        'Traslado': (4, 11.5, '#8B5CF6', ['movimientos', 'catalogo', 'stockEnUbicacion']),
        'Stock': (8, 8.5, '#3B82F6', ['movimientos', 'catalogo']),
        'Ocupacion': (16, 11.5, '#3B82F6', ['movimientos', 'catalogo', 'RPC:ocupacion_celdas', 'BLOQUES/PISOS']),
        'FEFO': (20, 8.5, '#EF4444', ['movimientos']),
        'Descarga': (12, 8.5, '#F97316', ['movimientos', 'catalogo', 'service_role']),
        'Catalogo': (4, 5.5, '#06B6D4', ['catalogo']),
        'Usuarios': (8, 2.5, '#EC4899', ['profiles', 'user_roles']),
        'Piso Mov': (16, 5.5, '#F59E0B', ['piso_movimientos', 'piso_mov_detalles', 'RPC:piso_registrar']),
        'Piso Config': (20, 2.5, '#F59E0B', ['piso_sectores', 'piso_columnas', 'piso_bloques']),
    }

    for name, (x, y, color, deps) in modules.items():
        w, h = 4, 2.2
        r = FancyBboxPatch((x - w/2, y - h/2), w, h, boxstyle="round,pad=0.15",
                           facecolor='#1E293B', edgecolor=color, linewidth=2.5)
        ax.add_patch(r)
        ax.text(x, y + 0.7, name, fontsize=11, fontweight='bold', ha='center', color=color)
        for i, dep in enumerate(deps):
            ax.text(x - w/2 + 0.3, y + 0.2 - i * 0.3, dep, fontsize=6.5, color='#94A3B8')

    # Connection lines
    connections = [
        ('Movimientos', 'Traslado', 'Comparte tabla movimientos'),
        ('Movimientos', 'Stock', 'Stock = calculo sobre movimientos'),
        ('Movimientos', 'Ocupacion', 'Ocupacion = estado de celdas'),
        ('Movimientos', 'FEFO', 'FEFO = movimientos con vencimiento'),
        ('Movimientos', 'Descarga', 'Descarga = exportar movimientos'),
        ('Traslado', 'Stock', 'Actualiza stock en ambas ubicaciones'),
        ('Traslado', 'Ocupacion', 'Cambia estado de 2 celdas'),
        ('Stock', 'Catalogo', 'Referencia Big Magic stock'),
        ('Stock', 'Descarga', 'Exporta stock calculado'),
        ('Ocupacion', 'Descarga', 'Exporta mapa visual'),
        ('Usuarios', 'Movimientos', 'Permisos de eliminacion'),
        ('Catalogo', 'Movimientos', 'Autocompletar codigos'),
        ('Catalogo', 'Traslado', 'Buscar articulos'),
        ('Catalogo', 'Ocupacion', 'Descripcion en celda'),
        ('Piso Mov', 'Piso Config', 'Usa sectores/columnas'),
        ('Descarga', 'Movimientos', 'UP Data reemplaza movimientos'),
    ]

    coords = {name: (x, y) for name, (x, y, _, _) in modules.items()}

    for src, dst, label in connections:
        x1, y1 = coords[src]
        x2, y2 = coords[dst]
        # Offset to not overlap box edges
        dx = x2 - x1
        dy = y2 - y1
        dist = (dx**2 + dy**2)**0.5
        ox = dx/dist * 2.2 if dist > 0 else 0
        oy = dy/dist * 1.3 if dist > 0 else 0
        ax.annotate('', xy=(x2 - ox, y2 - oy), xytext=(x1 + ox, y1 + oy),
                    arrowprops=dict(arrowstyle='->', color='#334155', linewidth=1.5,
                                    connectionstyle='arc3,rad=0.15'))
        mx = (x1 + x2) / 2
        my = (y1 + y2) / 2
        ax.text(mx, my + 0.15, label, fontsize=5.5, ha='center', color='#64748B',
                rotation=0, style='italic',
                bbox=dict(boxstyle='round,pad=0.05', facecolor='#0F172A', edgecolor='none', alpha=0.8))

    # Legend
    ax.text(12, 1.0, 'Las flechas muestran la dependencia de datos entre modulos. '
            'Cada modulo se conecta con las tablas y funciones que utiliza.',
            fontsize=9, ha='center', color='#64748B')

    plt.tight_layout()
    path = os.path.join(OUT, 'RACKLY_Mapa_Integracion.png')
    fig.savefig(path, dpi=180, bbox_inches='tight', facecolor='#0F172A')
    plt.close()
    print(f'Created: {path}')
    return path


# ═══════════════════════════════════════════════════════════
# MAP 4: 5S Summary Visual (Quick Reference)
# ═══════════════════════════════════════════════════════════
def draw_5s_visual():
    fig, ax = plt.subplots(1, 1, figsize=(20, 14))
    ax.set_xlim(0, 20)
    ax.set_ylim(0, 14)
    ax.axis('off')
    fig.patch.set_facecolor('#0F172A')

    ax.text(10, 13.3, 'RACKLY - Metodologia 5S Aplicada', fontsize=22, fontweight='bold',
            ha='center', color='#F8FAFC')
    ax.text(10, 12.7, 'Organizacion del proyecto para maxima eficiencia y calidad',
            fontsize=12, ha='center', color='#94A3B8')

    # 5S boxes
    s_data = [
        ('S1', 'CLASIFICAR', 'Seiri', '#EF4444',
         'Eliminar lo innecesario',
         ['Codigo duplicado identificado',
          'Funciones repetidas de stock',
          'Imports no utilizados',
          'Role enum desactualizado']),
        ('S2', 'ORDENAR', 'Seiton', '#F59E0B',
         'Cada cosa en su lugar',
         ['Estructura: components/lib/hooks',
          'Constants centralizadas',
          'Nomenclatura consistente',
          'Roles y permisos agrupados']),
        ('S3', 'LIMPIAR', 'Seiso', '#22C55E',
         'Mantener libre de errores',
         ['Service role en frontend',
          'Stock export incompleto',
          'Tipos de Supabase obsoletos',
          'Sin error boundaries']),
        ('S4', 'ESTANDARIZAR', 'Seiketsu', '#3B82F6',
         'Crear estandares claros',
         ['Patron unificado de stock',
          'Componentes compartidos',
          'Tipos TS actualizados',
          'Flujo de auth estandar']),
        ('S5', 'MANTENER', 'Shitsuke', '#8B5CF6',
         'Sostener las mejoras',
         ['Git save points (JHIA)',
          'Worklog de cambios',
          'Despliegue automatizado',
          'Documentacion viva']),
    ]

    for i, (snum, name, jp, color, tag, items) in enumerate(s_data):
        x = 0.5 + i * 3.8
        y = 2
        w = 3.5
        h = 9.5

        r = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.2",
                           facecolor='#1E293B', edgecolor=color, linewidth=2.5)
        ax.add_patch(r)

        # S number circle
        circle = plt.Circle((x + w/2, y + h - 0.6), 0.45, facecolor=color, edgecolor='none')
        ax.add_patch(circle)
        ax.text(x + w/2, y + h - 0.6, snum, fontsize=16, fontweight='bold',
                ha='center', va='center', color='white')

        # Name
        ax.text(x + w/2, y + h - 1.3, name, fontsize=11, fontweight='bold',
                ha='center', color=color)
        ax.text(x + w/2, y + h - 1.7, f'({jp})', fontsize=9, ha='center', color='#64748B')

        # Tagline
        ax.text(x + w/2, y + h - 2.3, tag, fontsize=8, ha='center', color='#CBD5E1',
                style='italic')

        # Divider
        ax.plot([x + 0.3, x + w - 0.3], [y + h - 2.7, y + h - 2.7], color=color,
                linewidth=0.5, alpha=0.5)

        # Items
        for j, item in enumerate(items):
            ax.text(x + 0.3, y + h - 3.3 - j * 1.0, item, fontsize=7.5,
                    color='#CBD5E1', wrap=True)
            # Bullet
            ax.plot(x + 0.2, y + h - 3.2 - j * 1.0, 'o', color=color, markersize=3)

        # Status indicator
        status = 'EN PROGRESO' if i < 3 else 'PENDIENTE'
        status_color = '#F59E0B' if i < 3 else '#64748B'
        sr = FancyBboxPatch((x + 0.3, y + 0.3), w - 0.6, 0.5, boxstyle="round,pad=0.08",
                           facecolor=status_color, edgecolor='none', alpha=0.2)
        ax.add_patch(sr)
        ax.text(x + w/2, y + 0.55, status, fontsize=7, fontweight='bold',
                ha='center', color=status_color)

    # Footer
    ax.text(10, 1.3, 'Objetivo: Aplicar las 5S a todo el codigo para lograr un sistema limpio, organizado y eficiente',
            fontsize=10, ha='center', color='#94A3B8')

    plt.tight_layout()
    path = os.path.join(OUT, 'RACKLY_Mapa_5S_Resumen.png')
    fig.savefig(path, dpi=180, bbox_inches='tight', facecolor='#0F172A')
    plt.close()
    print(f'Created: {path}')
    return path


if __name__ == '__main__':
    draw_architecture_map()
    draw_dataflow_map()
    draw_integration_map()
    draw_5s_visual()
    print('\nAll maps generated successfully!')

#!/usr/bin/env python3
"""Cirugía TransitoModule.tsx (rep): quita wrapper + bloque Despacho RAL.

Pasos con aserciones estrictas (aborta si el archivo no está exactamente
como se espera — nada silencioso):
  1. Borra la línea 477 `      )}` (cierre del wrapper {pestaña==='ubicar' && ().
  2. Borra las líneas 479-604 (comentario + bloque {pestaña==='ral' && (...)}).
  3. Dedenta en 2 espacios el panel «Por ubicar» (quedó un nivel de más).
"""
from pathlib import Path

F = Path('src/components/rackly/rep/transito/TransitoModule.tsx')
lines = F.read_text(encoding='utf-8').splitlines(keepends=True)

# ── aserciones (1-based → 0-based) ──
assert lines[476] == '      )}\n', f'L477 inesperada: {lines[476]!r}'
assert 'DESPACHO RAL' in lines[478], f'L479 inesperada: {lines[478]!r}'
assert lines[602] == '      )}\n', f'L603 inesperada: {lines[602]!r}'
assert lines[603].strip() == '', f'L604 inesperada: {lines[603]!r}'
assert 'Lector de QR' in lines[604], f'L605 inesperada: {lines[604]!r}'

# ── 1+2: borrar idx 476..603 (líneas 477-604) ──
del lines[476:604]

# ── 3: dedent del panel «Por ubicar» ──
p_comentario = next(i for i, l in enumerate(lines) if 'POR UBICAR (recepciones sin destino)' in l)
p_inicio = p_comentario + 1
assert lines[p_inicio].strip().startswith('<div className="rounded-xl border bg-white p-4 space-y-4">'), \
    f'panel no está donde se esperaba: {lines[p_inicio]!r}'
# cierre del panel: la primera línea `        </div>` tras el inicio del panel
p_cierre = next(i for i in range(p_inicio + 1, len(lines)) if lines[i] == '        </div>\n')
for i in range(p_inicio, p_cierre + 1):
    if lines[i].startswith('  ') and lines[i] != '\n':
        lines[i] = lines[i][2:]
assert lines[p_cierre] == '      </div>\n', f'cierre dedentado mal: {lines[p_cierre]!r}'

F.write_text(''.join(lines), encoding='utf-8')
print(f'OK: bloque RAL eliminado; panel «Por ubicar» dedentado (líneas {p_inicio+1}-{p_cierre+1})')

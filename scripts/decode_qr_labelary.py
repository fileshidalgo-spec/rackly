#!/usr/bin/env python3
"""Decodifica el QR de los renders de Labelary y valida el payload esperado.

Complementa scripts/test_qr_labelary.mjs: si OpenCV lee el QR del render
ZPL, la ZT411 (que imprime ese mismo ZPL con calidad superior) escaneará.
"""
import json
import sys

import cv2

ESPERADOS = [
    "RKLY|0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0|T173-00004090|49310",
    "RKLY|0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0|T173-00004090|126|P2",
]

detector = cv2.QRCodeDetector()
resultados = []
fallos = 0

QUIET_PX = 6  # quiet zone mínima exigida alrededor del símbolo (render 203dpi)

def quiet_ok(img_gris, pts) -> tuple[bool, int]:
    """Verifica anillo blanco alrededor del bbox detectado; devuelve (ok, margen_px)."""
    p = pts.reshape(-1, 2)
    x0 = int(p[:, 0].min())
    x1 = int(p[:, 0].max())
    y0 = int(p[:, 1].min())
    y1 = int(p[:, 1].max())
    h, w = img_gris.shape
    margen = min(x0, y0, w - 1 - x1, h - 1 - y1)
    r = QUIET_PX
    xa, xb = max(0, x0 - r), min(w, x1 + r + 1)
    ya, yb = max(0, y0 - r), min(h, y1 + r + 1)
    # tinta del anillo EXTERIOR (fuera del símbolo) — debe ser 0:
    oscuros_anillo = int((img_gris[ya:yb, xa:xb] < 128).sum())
    oscuros_simbolo = int((img_gris[y0:y1 + 1, x0:x1 + 1] < 128).sum())
    ok = margen >= QUIET_PX and oscuros_anillo <= oscuros_simbolo
    return ok, margen

for i, esperado in enumerate(ESPERADOS):
    ruta = f"/tmp/rotulo_qr_{i}.png"
    img = cv2.imread(ruta)
    if img is None:
        print(f"✗ etiqueta {i}: no se pudo leer {ruta}")
        fallos += 1
        continue
    # El rótulo está girado 90° en la tira física: probar los 4 giros.
    leido, girado, pts_ok = None, None, None
    for rot in range(4):
        datos, pts, _ = detector.detectAndDecode(img)
        if datos:
            leido, girado, pts_ok = datos, rot * 90, pts
            break
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    ok = leido == esperado
    quiet = "n/d"
    if ok and pts_ok is not None:
        gris = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        q_ok, m = quiet_ok(gris, pts_ok)
        quiet = f"quiet={'OK' if q_ok else 'FALLA'} (margen {m}px)"
        if not q_ok:
            ok = False
    resultados.append({
        "etiqueta": i,
        "esperado": esperado,
        "leido": leido,
        "giro_grados": girado,
        "quiet": quiet,
        "ok": ok,
    })
    if ok:
        print(f"✓ etiqueta {i}: QR decodifica EXACTO (giro {girado}°, {quiet})")
    else:
        print(f"✗ etiqueta {i}: esperado={esperado!r} leido={leido!r} {quiet}")
        fallos += 1

with open("/tmp/qr_labelary_result.json", "w") as f:
    json.dump(resultados, f, indent=2)

sys.exit(1 if fallos else 0)

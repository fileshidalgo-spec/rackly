---
Task ID: auditoria-integral-app-20261111
Agent: Main Agent
Task: «1.1 quiero que hagas una auditoría para revisar si al implementar la mejora hay errores en la app, bugs, duplicados, que se hayan generado a raíz de las implementaciones, REVISAR TODA LA APP, que los procesos en cada módulo funcionen correctamente, que cada código esté funcionando bien, que la estructura de datos sea la más eficiente y segura, la base de datos esté funcionando correctamente; 1.2–8 metodología».

Work Log (1.1–8):
- 1.2 (averiguar el error): auditoría integral en 5 fases sobre producción 202611102005-03267f8 (post-implementación mapa Ubicaciones). Fase 0 accesos: Supabase MAPI ✅, GitHub PAT ✅, Cloudflare token account-owned ✅ (verify por /accounts/{id}/tokens/verify), repo local sincronizado con origin/main 03267f8, árbol limpio.
- 2 (qué lo genera — estática): tsc --noEmit 0 errores · eslint 0 warnings · 53/53 suites OK · build OK (reintento tras fallo transitorio de descarga de Google Fonts del sandbox, no de código). Build genera solo ruta «/» (SPA hub) — sin rutas duplicadas.
- 3 (no se repite — duplicados/seguridad): 0 secretos en src (service_role solo en comentarios históricos del fix P1 2026-10-21; cliente real usa anon+JWT — client.ts verificado línea a línea). 0 console.log, 0 passwords hardcodeadas. Escaneo de archivos muertos: 29 sin importador = 26 shadcn/ui estándar (biblioteca, tree-shaken del bundle) + supabase/types.ts generado + ClientToaster.tsx (muerto tras sonner directo en layout). 0 duplicados de componentes Ubicacion*/Ocupac*/Mapa* — 1 archivo por responsabilidad.
- 4 (procedimiento — BD): 31/31 tablas con RLS activo y ≥1 política; 16 FKs rep_* validadas; índices completos (movs: articulo/codigo/created/destino/origen/guia/ral; stock: articulo/ral/uq(lonchera,articulo); ubicaciones: orden/racks/zonas/uq codigo+posicion). RPCs 46/46 sincronizados código↔BD, 0 faltantes. Sobrecargas sin ambigüedad PGRST203 (rq_atender_item 3/4-args sin defaults ✅, rep_registrar_ingreso delega4/completa8 ✅). Guardas auth.uid()+tiene_permiso verificadas en los RPCs nuevos rep_registrar_*. Dead tuples bajos (autovacuum sano; movimientos 28.949 filas).
- 5 (sin conflictos — integridad de datos): 0 duplicados reales (UNIQUE codigo; las 24 coincidencias por coordenada son espacios legítimos A-D/PP/REC/CN3 no posicionales), 0 huérfanos (movs→artículos/ubicaciones, stock→artículos/loncheras, loncheras→ubicaciones, profiles/permisos/roles→auth.users), 0 stock negativo, balance movimientos = 0 (ingresos=salidas, E2E previo compensado). rep_ubicaciones 1.869 = 1.773 racks + 92 zonas + 4 prepicking; loncheras 3.642; racks_sin_lonchera 0; lados solo A/B.
- 6/7 (runtime, código experto): smoke test producción con navegador real + cuenta E2E: login OK y 10 módulos sin 1 solo error JS ni de consola — REP (Catálogo+buscar, Ubicaciones 1.773/96 + panel clic, Recepción guía T445-005, Atención vacía, Tránsito 2 por ubicar, Movimientos) · INSUMOS (Racks con 9 tabs incl. Ocupación referencia, Piso 6 tabs, Tránsito con guías reales) · Usuarios (lista+roles+accesos). E2E compensado REAL desde la UI: ingreso 2 UN de 61830 a R01-04-01 lado A → celda AZUL «1 artículo» en vivo → Salida «Todo» → celda VERDE «Vacía»; stock_final 0, balance 0, historial y kardex correctos con referencia «AUDIT-20261111».
- 8 (accesos): hallazgos accionables aplicados — 4 comentarios obsoletos que decían «dataClient (service_role)» corregidos a «anon + JWT de sesión (fix P1)» (commit 10c4957, QA completa verde, deploy verificado 202611102042-10c4957). Informe de auditoría entregado en download/ con evidencias.

Stage Summary:
- VEREDICTO: APROBADO — la implementación de la mejora (mapa estilo Insumos + movimientos directos) NO introdujo errores, bugs ni duplicados en ninguna otra pestaña o módulo.
- 6 hallazgos menores documentados (todos informativos/bajos): comentarios obsoletos (CORREGIDO), 26 shadcn sin uso (biblioteca estándar), types.ts+ClientToaster muertos (sin bundle), 14 RPCs BD sin llamador en src (posibles helpers/setup, auditar antes de borrar), data de prueba en producción (guía T445-005 con 2 líneas por ubicar — confirmar si es real), primera carga Ubicaciones 6–9 s (1.869 ubics + 3.642 loncheras paginadas).
- Sin cambios de código funcionales: la única intervención fue documental (4 comentarios), cero riesgo.

---
Task ID: rep-ubicaciones-movimientos-directos-20261111
Agent: Main Agent
Task: «ACTUALMENTE SE VE COMO LA 1 IMAGEN QUE TE ESTOY ENVIANDO, PERO QUISERA QUE TENGA SE VEA ASÍ COMO EN OCUPACIÓN INSUMOS, ordenado y agradable a la vista, además al darle clic sobre ellos se pueda dar ingresos, salidas, ver historial entre otros movimientos; cuando no está ocupado está de color verde, azul cuando solo hay 1 artículo y naranja si hay más de 1; 1.2–8 metodología; 9 Almacén Repuestos; 10 Módulo: UBICACIONES».

Work Log (1.1–8):
- 1.2 (averiguar la brecha): el mapa REP mostraba escena 3D isométrica con celdas grises pequeñas (captura 1) sin acciones; el usuario quiere el visual «Torre» de Ocupación Insumos (kardex/OcupacionTab) con colores por N° de artículos y clic → movimientos. Además el almacén está vacío (rep_stock = 0): el semáforo viejo vacía/stock/tránsito/llena no informaba nada útil hoy.
- 2 (qué lo genera): el módulo REP nunca tuvo paridad de acciones con Insumos — salida/traslado directos NO existían como RPC (las salidas solo via RAL/despacho), y el estado visual se basaba en «llena» en vez del N° de artículos distintos que pidió el usuario.
- 3 (no se repite en otras pestañas): AUDITORÍA de RPCs sobrecargadas en la BD pública — encontradas 2: rep_registrar_ingreso (riesgo latente; la app envía siempre 8 args, OK) y rq_atender_item (BUG REAL: Atención RqDetalle llama SIN p_toma → PGRST203 confirmado en producción con prueba inocua de item inexistente → la app degradaba silenciosamente al «Respaldo» no atómico). Migración 20261111_rpc_sin_defaults_pgrst203 quita los DEFAULT de las sobrecargas largas (regeneradas desde pg_get_functiondef + DROP/CREATE): 3 args → corta, 4 args → larga, sin ambigüedad. Verificado en producción: rq_atender_item 3-args resuelve (P0001 negocio, no PGRST203) y rep_registrar_ingreso 4-args también.
- 4 (procedimiento más efectivo): RPCs atómicas SECURITY DEFINER con el MISMO patrón de rep_registrar_ingreso (guard 'repuestos.crear', validaciones fail-fast, kardex en la misma transacción): rep_registrar_salida (valida stock suficiente, BLOQUEA stock estacionado con ral_id — despachar/devolver en Tránsito, delete de fila al llegar a 0 igual que rep_despachar_ral) y rep_registrar_traslado (descuenta origen, valida capacidad 15 en destino si el artículo no vive ahí, upsert destino, UN movimiento 'traslado' con origen+destino). Cliente: repRegistrarSalida / repRegistrarTraslado / repMovimientosDeUbicacion (.or origen|destino, limit 80) en rep-client.ts — puerta única.
- 5 (sin conflictos): UI nueva en archivos SEPARADOS — ubicaciones/mapa.tsx (SectorRacks/RackCard/SectorZonas/CeldaPosicion/LeyendaMapa + estadoPosicion verde/azul/naranja como fuente única) y ubicaciones/DialogPosicion.tsx (VER/INGRESO/SALIDA/TRASLADO/HISTORIAL, preselección desde la fila, chips de lado A/B, permiso repuestos.crear). SelectorUbicacionRep REUTILIZADO para el destino del traslado (sin duplicar combobox). UbicacionesModule mantiene el contrato rep-navegacion (target 'ubicacion' + onTargetConsumido + «Volver») y remonta el dialog con key={ubicacion.id} (react-hooks/set-state-in-effect respetado). Nada de Insumos tocado; Tránsito/Recepción/RAL intactos (flujo RAL sigue siendo la vía oficial de despachos; el tránsito no se puede mover desde el mapa ni en UI ni en BD).
- 6/7 (código experto y ordenado): estado de posición = SUMA de artículos de loncheras A/B (rep_ocupacion_loncheras agregado en BD — cero descargas de stock al navegador); VERDE vacía (0) · AZUL 1 artículo · NARANJA +1 · punto ámbar = en tránsito (RAL) — decisión documentada: el color sigue la regla del usuario, el tránsito es un marcador no invasivo que conserva la información operativa. Tarjetas oscuras estilo Insumos con barra de % por rack/zona, niveles N5..PISO partidos en 2 renglones (>10 pos), tooltips A:x/15 · B:y/15. Historial con badges por tipo y la otra punta del traslado.
- 8 (todos los accesos): QA local tsc 0 · eslint 0 · 53/53 suites · build OK. Migraciones aplicadas por MAPI. E2E en PRODUCCIÓN con cuenta real (scripts/qa_rep_movimientos_directos.py): ingreso 5 PZA a REC-01 → salida 2 (restante 3) → rechazo STOCK_INSUFICIENTE (sin cambios) → traslado 3 REC-01→REC-02 → salida 3 (restante 0); kardex con las 4 filas esperadas y rep_stock final = 0 (almacén limpio como al inicio, huella QA solo en kardex con referencia «QA mapa»).

Stage Summary:
- UBICACIONES REP con visual «Torre» de Insumos: tarjetas por rack (R01..R36 por piso) y por zona, celdas VERDE/AZUL/NARANJA por N° de artículos + punto ámbar de tránsito, clic → dialog con VER contenido A/B, INGRESO (búsqueda de artículo), SALIDA (por artículo, botón «Todo»), TRASLADO (selector de destino con lado A/B) e HISTORIAL de la posición.
- 2 RPCs nuevas (salida/traslado) atómicas con guard de permiso y kardex garantizado; fix REAL de PGRST203 en Atención RQ (sobrecarga rq_atender_item sin defaults) — la pestaña vuelve a la RPC atómica cuando no hay tomas.
- QA E2E en producción verde (6/6) con compensación total del stock de prueba.

---
Task ID: rep-ubicaciones-2-sectores-20261110
Agent: Main Agent
Task: «1.1 Te pasaré el layout del almacén de repuestos, en módulo ocupaciones crea 2 sectores uno de racks y otro de zonas, te pasaré el Excel donde podrás guiarte para crear las zonas y posiciones de cada sector, tiene 3 hojas el archivo, guíate de las hojas ubicación racks y ubicación zona para crear las ubicaciones en el app, ACTUALMENTE HAY POSICIONES, BORRALAS Y CREA UNA NUEVA, QUE SE VEA BONITO ASÍ EN 3D, GUÍATE DE CÓMO FUNCIONA UBICACIONES DE ÁREA DE ALMACÉN INSUMOS MÓDULO RACKS; revisar si al implementar la mejora hay errores en la app, bugs, duplicados, procesos por módulo, códigos funcionando, estructura de datos eficiente y segura, BD correcta; 1.2–8 metodología; 9 Almacén Repuestos; 10 Módulo: UBICACIONES».

Work Log (1.1–8):
- 1.2 (averiguar el hueco): el módulo UBICACIONES REP tenía 3 posiciones borrador (PP-P1-N1, R-P1-N1-P01/02 — residuo E2E) sin relación con el layout físico real; el Excel «LAYOUT REPUESTOS.xlsx» trae el layout definitivo en 3 hojas. La hoja canónica UBICACION RACKS estaba corrupta (R29 duplicada 2× con 11 pos en N4 y R30 AUSENTE) y la hoja UBICACIÓN ZONA está limpia (96 filas exactas).
- 2 (qué lo genera): la hoja UBICACION RACKS fue armada copiando bloques — el duplicado de R29 y el faltante de R30 se prueban aritméticamente: los encabezados del dibujo LAYAOUT (792+18 N0 · 69/275/275/275/69=963 · 64) cierran EXACTOS solo con R29-N4=12 y R30 presente (3/12/12/12/3).
- 3 (no se repite en otras pestañas): AUDITORÍA de consumo de ubicaciones en los 6 módulos REP — Tránsito (selector de destino con Select PLANO de Radix: con 1 869 posiciones sería inusable → reemplazado por combobox con búsqueda SelectorUbicacionRep), Atención (repPrepickings: ahora devuelve 4 PP, elige el primero — sin cambios de código), Movimientos (lookup id→código en Map — sin cambios), Recepción/RAL/RPCs (por uuid — sin cambios). Insumos: 0 cambios (su modelo BLOQUE-TORRE-PISO-POSICIÓN se usa solo como patrón conceptual).
- 4 (procedimiento más efectivo): modelo DE 2 SECTORES sobre la MISMA tabla rep_ubicaciones (no tablas nuevas): +sector('racks'|'zonas')/+rack(1..36)/+zona(nombre), unique funcional (sector,coalesce(rack,0),zona,nivel,secuencia) en lugar de la de 4 columnas (colisionaba entre racks), checks de coherencia sector↔rack↔zona. El tipo se conserva (racks→'rack', PRE-PICKING→'prepicking', resto→'zona') para no romper trigger de loncheras/RPCs/UI. Códigos = etiquetas del Excel: R01-02-17 · A-01 · CN3-07 · PP-02 · REC-08.
- 5 (sin conflictos): migración 20261110_rep_ubicaciones_sectores con GUARD que ABORTA si hay operación real (solo borra residuo E2E: 5 movs + 1 stock + 1 RAL + 1 artículo E2E) y DO-block de validación dura (totales por nivel/zona, duplicados, loncheras=3642, líneas en tránsito=2 INTACTAS). Las 2 líneas ZIPA en_transito se conservan sin ubicación — Tránsito las ubicará en loncheras nuevas. FK RESTRICT movimientos→ubicaciones tratada ANTES del delete (orden de dependencias).
- 6/7 (código experto y ordenado): rep-client con helper repTodas() de PAGINACIÓN en servidor (Supabase trunca a 1000 filas por request — mapa 1 869 ubicaciones + 3 642 loncheras + ocupación: una ronda simple habría TRUNCADO en silencio; bug latente también en repListarUbicaciones de Movimientos/Tránsito). UbicacionesModule reconstruido: pestañas RACKS(1 773)/ZONAS(96) con resumen (con stock/en tránsito/llenas), escena 3D isométrica CSS (cara superior skewX + lateral skewY, niveles N5..PISO apilados, celdas 15px con semáforo vacía/stock/tránsito/llena + tooltip A/B x/15), tarjetas por zona con orden canónico, detalle de posición (loncheras con contenido real y Progress). Retiro crear/eliminar ubicación de la UI: el layout es CANÓNICO (el Excel manda) — menos superficie de error y la FK RESTRICT ya no se pisa desde la app.
- 8 (todos los accesos): QA: tsc 0 · eslint 0 · 53/53 suites · build OK. E2E transaccional en BD con ROLLBACK (huella cero): JWT admin simulado → rep_ubicar_desde_transito línea ZIPA → R01-02-01 (ingreso kardex + stock 12) → RAL temporal + rep_pickear_linea → PP-01 (4 a prepicking, stock 8, traslado kardex) → ocupación RPC cuadra (1:8 rack · 1:4 PP-01). GitHub push → Cloudflare producción verificada con version.json + E2E navegador en producción.

Stage Summary:
- UBICACIONES REP = 2 sectores según el Excel: RACKS 1 773 pos (R01-R36, pisos 1-2, nivel 0=piso) + ZONAS 96 pos (A/B/C/D 3er piso, CONTENEDOR N° 3, PRE-PICKING, RECEPCIÓN). Correcciones al Excel documentadas en la migración (R29-N4=12, R30 incluido) — los totales de los encabezados LAYAOUT cierran exactos (1819 + 18 N0 + 32 zonas auxiliares).
- Mapa 3D por sector con semáforo de ocupación; Tránsito con búsqueda de destino; Atención usa las 4 loncheras PRE-PICKING; datos del mapa PAGINADOS (sin truncamiento silencioso).
- BD: estructura validada con checks+unique+DO-block; limpieza E2E con guard anti-borrado de operación real.

---
Task ID: rep-rotulo-formato-rep-20261111
Agent: Main Agent
Task: «En el rótulo que se imprime en el módulo de Recepción del almacén de REPUESTOS solo necesito esta información: Código de producto (grande, así como está ahora), descripción, UM, cantidad y el código QR grande; 1.2–8 metodología; 9 Almacén Repuestos; 10 Módulo Recepción».

Work Log (1.1–8):
- 1.2 (averiguar el hueco): el rótulo REP reutilizaba el ZPL PERECIBLE compartido con Insumos (construirZPLRotulo): imprimía banda «GUÍA:» + cajas F.P/F.V + CANT/UM — campos que el usuario NO quiere en repuestos — y el QR quedaba limitado al cuadrante de 4 cm de Insumos (Task 28).
- 2 (qué lo genera): el modal compartido ImprimirRotulosDialog llamaba construirZPLRotulos → construirZPLRotulo (UN formato para ambos almacenes).
- 3 (no se repite en otras pestañas): Insumos (recepción manual, vía foto GuiaFotoForm, devoluciones DevolucionFotoForm) NO cambia — el builder viejo queda INTACTO y el formato se elige con un prop ADITIVO opcional formato='insumos' (default). test_zebra_zpl (108 checks de la geometría Insumos) pasa completo. campoQR/layoutDescripcion se generalizan con DEFAULTS = valores exactos de Insumos (ZONA_QR_INSUMOS: interior 394/magMax 10 — bit a bit).
- 4 (procedimiento más efectivo): NUEVO builder construirZPLRotuloRep en zebra.ts en vez de ensuciar el compartido con banderas — cada formato queda legible, con su diagrama y testeable por separado. Mismo lienzo apaisado 1200×800, misma tira 10×15, mismo motor de descripción determinista (Tasks 30-31) y render calibrado de cantidad (em 294 + baseline ^FT).
- 5 (sin conflictos): único punto de decisión: ImprimirRotulosDialog.zplActual → solo Recepción REP pasa formato='rep'; las 2 vías REP (guardado con lineasARotulosRep y reimpresión con movimientosARotulosRep) comparten el mismo modal → ambas imprimen el formato nuevo. Rep_share de rótulo con ubicación: NUNCA existió — el rótulo REP sigue sin ubicación (la decide Tránsito).
- 6/7 (código experto y ordenado): Layout REP — banda CÓDIGO a ANCHO COMPLETO 0..1200 (a 10 chars em 117→181, +55%; a 5 dígitos 234→286 = tope de fuente) · QR GRANDE zona 640..1200 × 240..800 (interior 554 → mag 12 en el payload dominante v5: símbolo 444 dots ≈ 5.5 cm vs 4.1 cm del cuadrante, +34% lineal, quiet zone ≥ 3 módulos garantizada por la fórmula de mag, magMax 14) · DESCRIPCIÓN en banda alta Y 240..560 (el ejemplo de prueba pasa de 3 renglones em 47 a em 86 — casi el doble de fuente) · bloque CANT: + cantidad + UM (Y 560..800, 240 de alto). SIN banda GUÍA/LOTE, SIN F.P/F.V; el N° de guía sigue viajando DENTRO del payload del QR (dato de máquina para el lector — no tinta visible).
- 8 (todos los accesos): verificación visual REAL con Labelary (api.labelary.com 8dpmm, render girado 90°): código grande arriba, descripción en renglones balanceados, CANT: 4, UND, QR grande a la derecha — exactamente lo pedido; también la degradación sin identidad (rótulo a ancho completo, estructurado, sin ^BQ). QA: tsc 0 · eslint 0 · 53/53 suites · build OK · GitHub push → Cloudflare producción verificada con version.json.
- Tests nuevos en test_rep_recepcion_guia ([10]-[11]): sin GUÍA:/LOTE:/F.P/F.V, con código/desc por renglones/cantidad/UM/CANT:, QR mag 12, banda código ^GB240,1200 (ancho completo), sin identidad → sin ^BQN + desc a ancho completo, construirZPLRotulos formato='rep' vs default (Insumos: banda GUÍA: + QR mag 9 intactos). Suite: 63 checks OK.

Stage Summary:
- El rótulo de Recepción REPUESTOS imprime SOLO: código (GRANDE, ancho completo) · descripción (grande, 1-3 renglones) · CANT: cantidad · UM · QR GRANDE (~5.5 cm). Misma tira 10×15 cm, mismo flujo (Browser Print / Plan B .zpl) y mismo QR por línea (identidad estable que sobrevive a la ubicación de Tránsito).
- Insumos: 0 cambios de comportamiento (formato PERECIBLE completo intacto, default 'insumos').

---
Task ID: rep-recepcion-transito-ubicar-20261111
Agent: Main Agent
Task: «1.1 recepción SIN destino — como la imagen enviada (fila #/Código del artículo "Ej: 5653"/Cantidad/Unidad/Descripción "Se autocompleta al escribir el código"); el código debe ir impreso GRANDE en el rótulo; el lugar donde se almacena NO debe salir: recién luego de guardar pasa al área del módulo TRÁNSITO donde se verá a dónde enviarlo, así como funciona en almacén Insumos; guardar genera el archivo imprimible como rótulo por cada artículo; revisar errores/bugs/duplicados/procesos/estructura/BD; 1.2–8 metodología; 9 Almacén Repuestos; 10 Módulo Recepción (+Tránsito)».

Work Log (1.1–8):
- 1.2 (averiguar el hueco): la Recepción REP de la iteración anterior EXIGÍA elegir la lonchera destino en el mismo formulario y rep_registrar_ingreso escribía stock+kardex al guardar — el usuario pidió el flujo Insumos: recepción solo REGISTRA, Tránsito UBICA. Causa: el MVP del documento ató el destino al ingreso.
- 2 (qué lo genera): rep_registrar_ingreso con p_lonchera_id obligatorio + UI con selector tipo/ubicación/lado y columna «Destino». Sin capa de documento, el stock nacía en el clic de guardado.
- 3 (no se repite en otras pestañas): verificado por pg_get_functiondef que las demás RPC (rep_pickear_linea/rep_despachar_ral/rep_devolver_linea/rep_registrar_ingreso) NO cambian — las nuevas tablas no las tocan. Insumos: 0 cambios (su recepción ya era documento+transito; solo se reutiliza ImprimirRotulosDialog sin modificaciones).
- 4 (procedimiento más efectivo): CAPA DE DOCUMENTO estilo Insumos (rep_recepciones + rep_recepcion_lineas, estado en_transito→ubicado) en vez de una ubicación virtual «TRÁNSITO» — una ubicación fantasma habría metido filas en rep_stock y obligado a filtrar TRÁNSITO en mapa/kardex/ocupación/Atención/búsqueda (superficie de error enorme). Con la capa de documento, rep_stock y rep_movimientos conservan su semántica EXACTA: solo escriben cuando la mercadería entra a una lonchera real. Kardex HONESTO: el 'ingreso' se registra cuando la pieza entra físicamente a su lonchera (mismo momento que Insumos escribe el suyo).
- 5 (sin conflictos): migración 20261111_recepcion_transito 100% aditiva: 2 tablas nuevas + RLS solo-lectura (repuestos.ver; escritura SOLO por RPC SECURITY DEFINER con guard repuestos.crear — patrón rep_loncheras) + 2 RPC nuevas (rep_registrar_recepcion, rep_ubicar_desde_transito) + índices (uuid_sync únicos = idempotencia Insumos, parcial de pendientes, guia). rep_ubicar_desde_transito replica EXACTO las reglas físicas del ingreso clásico (capacidad 15 artículos distintos, upsert de cantidad con ON CONFLICT, aviso no bloqueante «ya vive en otra lonchera», FOR UPDATE de la línea para serializar dobles clics). Regla de orden de linea_ids en el reintento: por sufijo numérico de uuid_sync (linea_ids[i] SIEMPRE = línea i+1, mapeo de rótulos seguro).
- 6/7 (código experto y ordenado): Recepción reconstruida como la imagen — ficha «Código del artículo (Ej: 5653)» + Cantidad + Unidad jalada + «Descripción: Se autocompleta al escribir el código» + «Ya está en…» como dato informativo (stock existente, NO destino), tabla de líneas SIN columna Destino; guardar = 1 RPC atómica del documento completo (uuid_sync estable por formulario: reintento de red ≠ duplicado) + modal de rótulos (1 por artículo, QR = uuid de SU LÍNEA — identidad estable que sobrevive a la ubicación) + toast «quedan en tránsito — ubícalos en Tránsito» + panel «Últimas recepciones» (guía/OC/DAM/proveedores/estado + reimpresión por documento con fallback honesto a rep_movimientos para guías del flujo anterior) + puente «Ir a Tránsito (N por ubicar)». Tránsito con pestaña «Por ubicar» (líneas agrupadas por guía, selector ubicación/lado por línea con lados reales por tipo, botón Ubicar → RPC atómica) junto a «Despacho RAL» intacto. rep-tipos.ts: REP_CLASE/ETIQUETA_ESTADO_LINEA fuente única.
- Rótulo: el código ya iba GRANDE (banda superior 0–240 auto-fit del ZPL calibrado, test_zebra_zpl 108 checks) y el rótulo NUNCA imprimió ubicación — verificado que el nuevo flujo no la agrega.
- 8 (todos los accesos): Supabase MAPI (migración aplicada + E2E REAL de BD con JWT simulado: recepción 2 líneas con catálogo/proveedor por línea → stock=0 kardex=0 (no toca físico) → idempotencia (mismo uuid_sync con payload distinto devuelve el documento original sin duplicar) → ubicar → stock=6 + kardex 'ingreso' con guía/OC/DAM/PROV-A + usuario Miguel Hidalgo + línea ubicada → negativos LINEA_YA_UBICADA y CANTIDAD_INVALIDA → limpieza con FK en orden → RESIDUO 0 y cuadre del kardex full-model 6=6 intacto). GitHub push dc3b393 (PAT del remote renovado — el viejo daba «Invalid username or token»; el del acceso compartido sigue válido) · Cloudflare producción 202611092331-dc3b393 · E2E REAL de navegador en producción con la cuenta del usuario: login → Recepción (ficha como la imagen: 16837 → descripción «MANGA TERMOCONTRAIBLE…» + UM PZA autocompletadas del catálogo; SIN selector de destino) → guardar → toast «1 artículo(s) en tránsito» + modal «Imprimir rótulos» con Plan B: .zpl → panel «Últimas recepciones» + puente «Ir a Tránsito (1 por ubicar)» → Tránsito pestaña «Por ubicar» con la línea (código/desc/PROV-WEB/2 PZA) → selector Rack R-P1-N1-P01 + Lado A → Ubicar → BD: stock=2, kardex=1 ingreso con documento, línea ubicada → LIMPIEZA → RESIDUO 0 y kardex 6=6 intacto → cero errores de consola. Nota de verificación: las RPC nuevas responden PGRST202 con args vacíos (falso 404 — con args completos responden NO_AUTORIZADO a anon, es decir expuestas y con el guard activo); anon queda SIN grant en las 2 tablas nuevas (RLS solo-lectura, escritura solo por RPC).
- QA post-fix: tsc 0 · eslint 0 · 53/53 suites (nueva test_rep_transito_ubicar 33 checks) · build OK.

Stage Summary:
- Recepción REP = registro puro del documento (guía/OC/DAM/proveedor único o múltiple, código→descripción/UM del catálogo, estilo de la imagen) SIN destino; rótulos imprimibles por artículo con el código EN GRANDE y sin ubicación; Tránsito decide la lonchera (stock+kardex ahí). Paridad de flujo con Almacén Insumos.
- Commits: 41b0fb6 (feat) · worklog. Insumos y módulos físicos existentes: 0 cambios de comportamiento.

---
Task ID: rep-recepcion-guia-rotulos-20261110
Agent: Main Agent
Task: «1.1 en el módulo de recepción se tenga que ingresar Número de Guía, Número de OC, Número de DAM, Proveedor (si es un solo proveedor por la guía, que se repita en cada artículo; si son varios, el proveedor va en cada artículo); cada artículo compuesto de código, descripción, UM y cantidad — descripción/UM jalados del catálogo; al darle guardar se genere un archivo que se pueda imprimir como rótulo por cada artículo (revisar cómo trabaja recepción de Insumos); revisar errores/bugs/duplicados/procesos/estructura de datos/BD; 1.2–8 metodología; 9 Almacén Repuestos; 10 Módulo Recepción».

Work Log (1.1–8):
- 1.2 (averiguar el hueco): la Recepción de Repuestos era mono-artículo con una «Referencia (OC, guía… opcional)» de texto libre — el documento (guía/OC/DAM/proveedor) NO existía en el modelo de datos ni había rótulos. Causa: MVP del incremento 1 sin el concepto de documento de recepción.
- 2 (qué lo genera): rep_movimientos no tenía columnas de documento y rep_registrar_ingreso no las recibía; la UI no tenía cabecera ni lista multi-artículo; el patrón de rótulos (ZPL 15×10 + QR único) vivía solo en Insumos (zebra.ts + ImprimirRotulosDialog).
- 3 (no se repite en otras pestañas): los únicos escritores de rep_movimientos son las RPC rep_* — verificado por pg_get_functiondef que rep_pickear_linea/rep_despachar_ral/rep_devolver_linea insertan con LISTA EXPLÍCITA de columnas → las columnas nuevas (DEFAULT '') no las afecta. Los consumidores de zebra.ts/ImprimirRotulosDialog (Insumos recepción + devoluciones) no cambian: props ADITIVAS opcionales (loteEtiqueta default 'LOTE:', subtitulo default Insumos) — test_zebra_zpl 108 checks pasan byte-idéntico. Insumos: 0 cambios de comportamiento.
- 4 (procedimiento más efectivo): UNA migración aditiva + REUTILIZAR el pipeline probado de rótulos de Insumos en vez de inventar una plantilla nueva (riesgo de geometría calibrada). Extensión de RPC con 4 args OPCIONALES AL FINAL = compatibilidad total con el frontend desplegado.
- 5 (sin conflictos): la sobrecarga vieja de 4 args de rep_registrar_ingreso DELEGA en la de 8 (mismo patrón rq_atender_item de la auditoría — evitó lógica duplicada con signo de documento distinto). RLS intacta; Data API expone columnas nuevas automáticamente (toggle automático ON — verificado con el usuario).
- 6/7 (código experto y ordenado): lógica PURA separada en src/lib/rackly/rep/recepcion-guia.ts (validarRecepcionRep reporta TODOS los errores de una vez, proveedorDeLinea fuente única de la regla único/múltiple, parsearCantidadLinea con aNumero — '1,500'→1500; líneas con cantidad ya parseada: el builder no agrega basura). Guardado SECUENCIAL por línea con resultado honesto: las OK se limpian ANTES del refresco (lección auditoría 2026-11-10 — un segundo clic no duplica), las FALLIDAS quedan en la lista con su error y la cabecera se conserva para reintentar; avisos «ya vive en otra lonchera» agregados por línea. Rótulo: 1 por LÍNEA guardada, QR ÚNICO por rótulo = uuid del movimiento (recepcionId), banda «GUÍA:» con el N° de documento (loteEtiqueta), F.P/F.V vacías (no aplican). Reimpresión por documento: repListarMovimientos({guia}) con índice idx_rep_movs_guia + botón en Últimos ingresos; kardex Movimientos REP muestra «G. <guía> · OC <oc>» con tooltip DAM+proveedor.
- 8 (todos los accesos): GitHub push 9ea1eb9 · Cloudflare producción 202611092253-9ea1eb9 (módulo nuevo verificado en el bundle) · Supabase MAPI (2 migraciones aplicadas y verificadas: columnas/firma/index + delegación) · E2E REAL en producción con la cuenta del usuario (scripts/e2e_rep_recepcion_guia.py): login ✔ → RPC 8-args aceptada ✔ → movimiento_id (QR) ✔ → kardex con G./OC/DAM/proveedor completos registró Miguel Hidalgo ✔ → stock +2 ✔ → reimpresión por guía ✔ → LIMPIEZA quirúrgica (borrado E2E + stock restaurado) → EFECTO NETO CERO 10/10 ✔. Rótulo renderizado en Labelary (mismo motor que la ZT411): banda GUÍA:, QR y geometría válidos (download/rotulo_repuestos_guia.png).
- QA post-fix: tsc 0 · eslint 0 · 52/52 suites (nueva test_rep_recepcion_guia 41 checks + test_rep_recepcion [5] 8 checks) · build OK.
- Lección E2E: un «&count=exact» en la QUERY STRING de PostgREST es un filtro inválido (HTTP 400); el conteo real requiere la URL limpia — el falso «4 vs 5» del primer E2E era el dict de error (len=claves), no filas.

Stage Summary:
- Recepción de REPUESTOS ahora trabaja bajo DOCUMENTO: guía/OC/DAM obligatorios, proveedor único (se repite en todos los artículos) o múltiple (por artículo), artículos con código→descripción/UM del catálogo, y al guardar genera el archivo .zpl / impresión Zebra con un rótulo por artículo (QR único por rótulo + reimpresión por guía desde el kardex).
- Commits: 9ea1eb9 (feat) · worklog. Insumos: 0 cambios de comportamiento (props aditivas verificadas por tests).

---
Task ID: auditoria-integral-20261110
Agent: Main Agent
Task: «1.1 revisar si hay errores en la app, bugs, duplicados, ya que hemos implementado nuevas cosas, que los procesos en cada módulo funcionen correctamente, que cada código esté funcionando bien, que la estructura de datos sea la más eficiente y segura, la base de datos esté funcionando correctamente; 1.2 averiguar el error; 2 analizar qué lo genera; 3 revisar que ese error no se repita en otras pestañas; 4 evaluar qué procedimiento es el más efectivo; 5 asegurar que el paso 4 no genere conflictos; 6 actuar como experto al escribir códigos; 7 estructuración ordenada; 8 usar todos los accesos».

Work Log (1.1–8):
- BASELINE: producción = HEAD local (5394822, sello 202611092113), árbol limpio; QA estático 4/4 OK (tsc 0, eslint 0, 51/51 suites, build OK) — los defectos estaban en runtime/datos/estructura, no en compilación.
- BD (19 chequeos automatizados en scripts/audit_full_20261110.py, esquema real de 29 tablas): (1.2 A2) piso_stock_nivel SIN RLS y con privilegios plenos a anon (incl. TRUNCATE) — hallazgo de seguridad ALTO; (1.2 F2) FKs de rep_movimientos (origen/destino_ubicacion_id) sin índice de soporte; (1.2 B6) sobrecarga 3-args de rq_atender_item duplicaba la lógica de la 4-args SIN insertar el ledger de tomas 'manual' y sin search_path; (C5) 18 códigos de movimientos legacy fuera de catálogo — analizados uno a uno: 14 con neto 0 (ruido de pruebas), 4 con neto ≠0 de los cuales el único con stock positivo (BOBINAS VARIAS +10) lleva codigo_inc='Dañadas' y ES visible en la pestaña Stock INC por diseño; los de neto negativo/0 NO deben registrarse (mostrarían stock fantasma) → sin fix de datos, decisión documentada; (H1) supuesto desync rep_stock vs libro mayor resultó FALSO POSITIVO del modelo de auditoría (faltaba el signo devolucion-origen): el ciclo E2E cuadra exactamente (+10−4+4−4=6 ✔ en rack; +4−4+4−4=0 ✔ en prepicking); (F1) desdramatizado — uq_rep_stock_lonchera_articulo existe como UNIQUE INDEX (el ON CONFLICT de rep_pickear_linea está garantizado); (G1) todas las SECURITY DEFINER con search_path fijado ✔; sin duplicados en catálogo/rep_articulos/rep_ubicaciones/loncheras/stock ✔; sin huérfanos en las 7 tablas rep_* ✔.
- FRONTEND (agente de auditoría línea a línea sobre rep/, piso-editar, panel cruzado: 13 hallazgos — 1 alto, 5 medio, 7 bajo; Piso-editar-cantidad y CrossModuleStock verificados SÓLIDOS, sin cambios): (1.2-2) el hallazgo ALTO — registrar() de Recepción llamaba RPC atómica y LUEGO refrescaba stock/listas dentro del mismo try: un fallo de red en el refresco mostraba «No se pudo registrar el ingreso» con el ingreso YA en BD y dejaba el formulario intacto → segundo clic DUPLICABA el stock (la RPC suma, sin idempotencia). Los demás: race en búsquedas de código (Recepción+Atención) sin guard de generación; '1,500' → 1.5 por parser naive duplicando aNumero; fecha de RAL en UTC (regresión del fix P3-2026-10-22 omitida); lado no reseteado al cambiar de ubicación (rótulo/pre-chequeo cruzados); CLASE/ETIQUETA_ESTADO duplicadas Atención/Tránsito; fmtFecha duplicada; deep-link 'ral' atrapado si el filtro lo excluía; «Cargar más» por offset duplicaba filas del kardex; borrado en Catálogo dejaba página fantasma; deep-link Recepción→mapa llenaba target.codigo con el código del ARTÍCULO en vez del de la UBICACIÓN; listas RAL truncadas a 100 sin aviso.
- 4 (procedimiento más efectivo) y 5 (sin conflictos): BD en UNA migración aditiva (20261110_auditoria_seguridad.sql) — RLS + policy FOR ALL TO authenticated (el trigger fn_delta corre como llamador authenticated y el frontend NO toca la tabla directamente: verificado por grep — cero impacto en Piso); rq_atender_item 3-args DELEGA en la 4-args (fuente única: garantiza ledger 'manual' sea cual sea la sobrecarga que resuelva PostgREST; firma pública intacta); 2 índices IF NOT EXISTS. Frontend: refactor MÍNIMO por módulo, reutilizando helpers probados del repo (aNumero, hoyISO, formatDateTime, patrón genRef de Catálogo) en vez de inventar lógica nueva; los consumidores de los cambios son exactamente los 5 módulos rep/ tocados (Recepción, Atención, Tránsito, Movimientos, Catálogo) — pestañas de Insumos: 0 cambios.
- 6/7 (código experto y ordenado): constantes de estado centralizadas en rep-tipos.ts (REP_CLASE_ESTADO_RAL/REP_ETIQUETA_ESTADO_RAL, fuente única); guard de generación documentado en ambos buscadores; re-fetch acumulativo con techo MAX_LIMITE=1000 y aviso honesto al alcanzarlo; deep-link RAL tolerante al filtro (amplía a «Todos» y si no existe consume el target, sin bucles); Recepción limpia el formulario ANTES del refresco con refresco best-effort y toast propio. No aplicados por superficie/riesgo (documentados): unificación del badge de vencimiento ×5 archivos (legacy), emitters 'articulo'/'ral' del contrato rep-navegacion aún sin emisores (el consumidor ya es robusto), fmtNum menores en módulos legacy.
- 8 (todos los accesos): verificados los 4 accesos — GitHub (push 2a244e0), Cloudflare (sello 202611092143-2a244e0 en producción), Supabase MAPI (ping + 19 chequeos + migración), E2E REAL en producción con la cuenta del usuario y anon key re-extraída del bundle: login ✔; Repuestos 7 módulos ✔; Recepción búsqueda E2E-FILTRO-001 → «Ya está en: R-P1-N1-P01 lado A (6)» = EXACTAMENTE la verdad del libro mayor verificado en BD ✔; fix lado: rack con lado B → cambio a pre-picking → rótulo «Ocupación de la lonchera A» ✔; Atención filtro Despachados → RAL-E2E-0001 visible con etiqueta compartida y fecha local correcta ✔; Movimientos kardex 5/5 íntegro con formatDateTime ✔; Piso (Movimientos 2197 movs, pestaña Stock) ✔; 0 errores de consola en toda la sesión ✔. E2E 100% lectura: sin mutaciones en producción.
- QA post-fix: tsc 0 · eslint 0 · 51/51 suites · build OK.

Stage Summary:
- Veredicto global: los procesos de TODOS los módulos funcionan correctamente y la BD está sana (libro mayor rep_ cuadra al centavo, sin duplicados ni huérfanos); se corrigieron 3 defectos de estructura/seguridad en BD y 9 de frontend (1 alto de duplicación de ingreso, 5 medio, 3 bajo), todos con causa raíz documentada y solución de mínimo conflicto.
- Commits: 2a244e0 (fix auditoría) · worklog.
- Herramienta reutilizable: scripts/audit_full_20261110.py (19 chequeos BD re-ejecutables).


---
Task ID: piso-editar-cantidad-20261110
Agent: Main Agent
Task: «1.1 revisar que en la función editar también se pueda modificar la cantidad; corregir errores/bugs/duplicados de la app; 1.2 averiguar el error; 2 analizar qué lo genera; 3 que no se repita en otras pestañas; 4 procedimiento más efectivo; 5 sin conflictos; 6-7 código experto y ordenado; 8 usar todos los accesos; 9 Almacén Insumos; 10 Módulo PISO».

Work Log (1.1–8):
- 1.2 (averiguar el error): en Piso la única función «Editar» es el botón de las filas de stock de Sectores (diálogo compartido EditarLoteVencimientoDialog); solo permitía cambiar lote/fecha de vencimiento — la CANTIDAD quedaba congelada y una cantidad digitada mal exigía fabricar un ingreso/salida manual a mano.
- 2 (qué lo genera): el diálogo ya tenía el campo de cantidad construido (prop permitirCantidad, Task 28) pero su integración en PisoSectoresTab era anterior: no pasaba la prop, doEditarLotePiso ignoraba el 5º parámetro (cantidadNueva) y las API registrarIngresoPosicion/registrarSalidaPosicion generan su uuid_sync internamente, sin admitir uno externo para reintentos idempotentes. Racks (OcupacionTab) sí pasa permitirCantidad desde Task 28 — la brecha era solo de integración en Piso.
- 3 (no se repite en otras pestañas): los consumidores del diálogo son exactamente 2 — OcupacionTab (Racks, ya con cantidad) y PisoSectoresTab (Piso, corregido aquí); las pestañas Mov/Stock/FEFO/StockINC de Piso no tienen funciones editar (verificado por grep). El ajuste usa las RPC atómicas propias de Piso, no toca las de Racks.
- 4 (procedimiento más efectivo): replicar el patrón probado de Racks — el stock de Piso se DERIVA del kardex (piso_movimientos + piso_movimiento_detalles + FEFO client-side), así que corregir cantidad = movimiento compensatorio (ingreso si falta, salida si sobra) con la identidad FINAL del bucket (fecha/lote ya aplicados por la RPC de lote) en el NIVEL de la fila editada. Se descartó extender editar_lote_vencimiento_piso en BD: duplicaría lógica de cabecera+detalle+secuencia+idempotencia que las RPC de Piso ya resuelven (y cambiar la firma de una RPC en uso es riesgo innecesario).
- 5 (sin conflictos): api.ts gana opts.uuid_sync OPCIONAL en registrarIngresoPosicion/registrarSalidaPosicion — los 9 llamadores existentes usan ≤5 argumentos (verificado por grep), comportamiento por defecto intacto (generan uuid propio); el botón Editar ahora recibe el nivel de la fila (vista «Todos» itera por nivel; vista de un nivel usa el tab activo) y sin nivel el diálogo degrada a lote/fecha puro (graceful); salida-ajuste pasa por la barrera validarStockSuficiente + validación server-side INSUFFICIENT_STOCK (el delta siempre es ≤ stock del bucket corregido).
- 6/7 (código experto y ordenado): la lógica de ajuste vive en el flujo de guardado existente (doEditarLotePiso) con el helper compartido calcularAjusteCantidad (lib ya existente, cero duplicación); uuid fijo por sesión de edición (editAjusteUuidRef, generado al abrir el diálogo) → un reintento tras fallo de red NO duplica el movimiento (RPCs devuelven idempotent:true); estado limpiado en éxito/cierre. test_editar_lote ampliado con sección 7 (uuid_sync externo ingreso/salida, compatibilidad) → 62 aserciones OK; tsc 0; eslint 0; build OK; 51/51 suites.
- 8 (todos los accesos): E2E REAL en producción (rackly.pages.dev 202611092105-1110cd4) con la cuenta del usuario — posición CAMARA DE FRIO A1-2-1, artículo 57881 (QUEMACEL, lote QSUM12092613PT, venc 2027-06-11): edición 6→8 → toast «Datos y cantidad guardados — ajuste de stock registrado en el kardex», BD confirma ingreso +2.000 op 2391 con lote/fecha/nivel/posicion_id correctos; edición inversa 8→6 → salida −2.000 op 2392; kardex UI (#2391/#2392) trazado; stock neto final 6.000 = original (efecto neto cero en producción); uuid_sync sin duplicados (COUNT=1 cada uno).

Stage Summary:
- PISO: la función editar ahora permite modificar lote, fecha de vencimiento Y cantidad, con ajuste compensatorio trazable en el kardex, idempotencia de reintentos y validación de stock en servidor — paridad total con Racks. Insumos fuera de Piso: 0 cambios.
- Commits: 1110cd4 (feat piso edición de cantidad) · worklog.


---
Task ID: repuestos-implementacion-20261110
Agent: Main Agent
Task: «ok, procedamos con la implementación» — Almacén REPUESTOS completo (metodología 8 puntos del usuario): pre-ingreso con 2 tarjetas + Usuarios neutro; 7 tablas rep_* + RPCs; 6 módulos (Catálogo, Ubicaciones, Recepción, Atención RAL, Tránsito, Movimientos); Insumos 100% intacto.

Work Log (1.1–8):
- FASE 2 (BD, 4 migraciones aditivas aplicadas por MAPI): (a) 20261110_fase2 — 7 tablas rep_* (artículos/ubicaciones/loncheras/stock/ral/ral_detalle/movimientos), RLS con tiene_permiso + 4 permisos nuevos en el cuadro (repuestos.ver/crear → todos; gestionar/eliminar → supervisores+), trigger que crea loncheras (rack→A+B, resto→A), RPC rep_registrar_ingreso (capacidad 15, upsert de cantidad, kardex, aviso «ya vive en otra lonchera»), pg_trgm para 25k filas; (b) fase2b — profiles.acceso_insumos/acceso_repuestos (defaults true/false) + RPC establecer_acceso_almacen (guard admin); (c) fase2c — RPC rep_ocupacion_loncheras (GROUP BY en BD: el mapa no baja filas de stock); (d) fase2d — rep_pickear_linea (descuento de lonchera nunca negativo + estaciona en pre-picking con ral_id + kardex traslado; faltante honesto si el stock no alcanzó), rep_despachar_ral (salida física + kardex salida + estado despachado), rep_devolver_linea (regresa a la lonchera origen según el kardex), rep_anular_ral; política rep_ral_detalle.delete relajada a repuestos.crear SOLO con RAL 'registrado'. Pre-picking exento del tope 15 (estacionamiento de horas, se vacía en cada despacho).
- VERIFICACIÓN de la sesión previa: fase2/fase2b ya estaban aplicadas en BD (tablas + columnas + permiso_defecto_rol con ramas repuestos confirmadas vía pg_get_functiondef); el tiene_permiso de producción SÍ delega al cuadro — la preocupación de divergencia quedó descartada con evidencia.
- INCREMENTO 1 (commit bfb9499): PreIngreso (capa neutra: 2 tarjetas por profiles.acceso_* + bypass admin anti-lockout + tarjeta Usuarios transversal; mensaje honesto sin almacenes); ModulosHome pierde la puerta Usuarios (sube al pre-ingreso; la pestaña interna de Racks queda intacta); UsuariosTab con columna/fila «Almacenes autorizados» (toggles INS/REP, solo gestión, auto-cambio bloqueado como aprobado/rol); namespace rep aislado (rep-tipos/rep-vistas con prefijo rep- anti-colisión, rep-navegacion con contrato de targets, rep-client única puerta de datos, rep-excel lógica pura); módulos Catálogo (búsqueda paginada servidor + Excel 4 columnas UPSERT por lotes de 500 con progreso, descartes y reporte descargable; detección de columnas con sinónimos/acentos), Ubicaciones (mapa por piso: racks con A/B, pasillos bajo N1, zonas, pre-picking; celdas con semáforo llena/tránsito/stock; detalle con contenido por lonchera; alta con código normalizado en vivo), Recepción (flujo 3 pasos, ocupación n/15 en vivo, alta rápida inline para códigos desconocidos, aviso de excepción de lonchera, puente «Ver en el mapa»), Movimientos (kardex paginado en servidor con lookup de códigos origen→destino). Atención/Tránsito quedaron como puertas «Inc. 2» deshabilitadas.
- INCREMENTO 2 (commit 986d2f3): Atención (registro RAL BIG MAGIC con fecha/solicitante; líneas con buscador de catálogo; picking por línea con elección de pre-picking; estados derivados Pendiente/En Tránsito desde rep_stock.ral_id; anulación con guard de carga; deep-link tipo 'ral' + puente al mapa desde la línea) y Tránsito (RALs registrados con carga estacionada primero; despacho completo con confirmación y resumen; devolución por línea; historial de despachados). 6/6 puertas activas.
- 1.2/2 (bugs encontrados y corregidos, todos con causa documentada): (1) guards honestos de rep-client sin {count:'exact'} → no-op silencioso ante RLS (clase de bug ya conocida del repo: éxito falso); (2) búsqueda con coma rompía or() de PostgREST (400) → terminoBusquedaSeguro (patrón probado del repo); (3) mapa bajaba TODAS las filas de stock → RPC GROUP BY; (4) E2E: botón «Volver» muerto — el módulo destino consume el target al aterrizar y el origen viajaba dentro del target → estado propio repOrigen (commit dd39cc7); (5) E2E: rep_devolver_linea fallaba SIEMPRE en runtime — select s.*, l.lado SIN join a rep_loncheras (el toast de error se disipaba antes de observarlo; localizado reproduciendo con pg_get_functiondef) (commit 0f40800); (6) PostgREST 404 tras reemplazar una función vía MAPI → NOTIFY pgrst 'reload schema' (nota operativa para futuros deploys de RPC).
- 3 (no se repite en otras pestañas): las correcciones 1-3 son del namespace rep (0 archivos de Insumos tocados en su lógica); la puerta Usuarios solo salió de ModulosHome (navegación, no lógica); PERMISO_VER_MODULO ampliado sin tocar claves existentes (test_permisos actualizado a 31 permisos y verificando ambas familias).
- 4/5 (efectividad y sin conflictos): 0 tablas/funciones/vistas de Insumos modificadas — todo CREATE TABLE/IF NOT EXISTS o CREATE OR REPLACE de funciones NUEVAS (permiso_defecto_rol y establecer_permiso_usuario ampliadas con ramas nuevas; comportamiento previo intacto); las RPCs de salida van SECURITY DEFINER con guard repuestos.crear (patrón kardex); E2E confirmó Insumos cargando sus 28,840 movimientos y sus 5 puertas.
- 6/7 (código experto y ordenado): 5 suites nuevas (tipos/permisos/excel/carga/atención, 120+ aserciones; stub ampliado con captura de upsert) — 51/51 OK; tsc 0 errores; eslint 0; build OK.
- 8 (todos los accesos): E2E REAL en producción (rackly.pages.dev 202611092040-0f40800) con la cuenta del usuario: login → pre-ingreso (2 tarjetas + Usuarios) → ciclo completo Repuestos: artículo creado (E2E-FILTRO-001), ubicaciones R-P1-N1-P01/P02 (loncheras A/B automáticas) + PP-P1-N1, ingreso 10 UN (kardex + últimos ingresos + BD), deep-link mapa con contenido de lonchera y «Volver», RAL-E2E-0001 con línea 4 UN → picking (BD: P01 6 + PP 4 en tránsito + traslado), DEVOLUCIÓN (stock restaurado 10 + devolucion en kardex), 2º picking → DESPACHO (kardex salida, RAL despachado, pre-picking vacío), kardex con origen→destino real, Usuarios: columna Almacenes visible solo para admin, propio bloqueado, toggle conceder/retirar verificado en BD (estado final restaurado). Datos E2E dejados en BD con prefijo E2E- (trazables; borrarlos rompería el kardex histórico — decisión documentada para el usuario).
- Deploy: 4 pushes verificados en version.json (bfb9499 → 986d2f3 → dd39cc7 → 0f40800), todos con sleep 270 + curl con UA.

Stage Summary:
- REPUESTOS operativo de punta a punta: Catálogo Excel 25k · Ubicaciones con loncheras A/B · Recepción con capacidad 15 · Atención RAL BIG MAGIC + picking · Tránsito despacho/devolución · Kardex con trazabilidad completa. Los datos de Insumos, sus RPCs y sus políticas: 0 cambios.
- Pendiente para futuras sesiones: rotulación QR por posición (acordado, no construido), pantalla de conteo/escaneo, y limpieza opcional de los registros E2E- (el kardex es histórico y no se borra por diseño).
- Commits: bfb9499 (inc.1) · 986d2f3 (inc.2) · dd39cc7 (fix Volver) · 0f40800 (fix join RPC) · worklog.

---
Task ID: fix-traslado-salida-piso-20261107
Agent: Main Agent
Task: «1.1=no deja trasladar, ni dar salidas — revisar todos los movimientos; 1.2 averiguar el error; 2 analizar qué lo genera; 3 revisar que no se repita en otras pestañas; 4 procedimiento más efectivo; 5 sin conflictos; 6-7 código experto y ordenado; 8 usar todos los accesos; 9 Módulos: PISOS» (metodología 9 pasos; screenshot con «new row for relation "piso_stock_nivel" violates check constraint "piso_stock_nivel_no_negativa" — failing row (e5541cfa…, 8ac58f84…, -140.000)»)

Work Log (1.1–9):
- 1.2 (averiguar el error): los UUIDs del screenshot identificaron la fila exacta — bucket (nivel Pos15 de columna 1A1, bloque 8ac58f84 = código 56203 ENTURBIENTE, stock real 140) y delta crudo −140 = el traslado de 140 KG intentado a las 23:17:30 UTC del 06-11. Huecos de secuencia 2233–2236/2238 = 2 traslados + 1 salida abortados (transacciones completas, sin basura: snapshot 0 desync verificado).
- 2 (causa): reproducido 100% con diagnóstico controlado en BD — PostgreSQL evalúa los CHECK constraints sobre la fila CANDIDATA del INSERT ANTES del árbitro ON CONFLICT (ExecConstraints precede a la inserción especulativa). piso_stock_nivel_fn_delta usaba INSERT VALUES(delta) ON CONFLICT DO UPDATE SET cantidad = old + delta → con delta negativo el CHECK cantidad >= 0 se evalúa sobre el candidato CRUDO (−140) y falla SIEMPRE, aunque el resultado final (140−140=0) sea válido. Matriz de pruebas: +1 → DO UPDATE correcto (141); 0 con SET old−1 → correcto (139); −1 → 23514 con la fila cruda. El snapshot NUNCA estuvo desincronizado (replay vs snapshot = 0 diffs en 133→375 buckets antes y después).
- 3 (repetición en otras pestañas): el mismo fn_delta sirve a TODAS las rutas de descuento del módulo — salidas (piso_salida_posicion), traslados (piso_traslado_posicion), ajuste de saldo en el flujo de traslado del cliente y ANULACIONES de ingresos/devoluciones vía piso_eliminar_movimiento (borrado atómico del 06-11): todas rotas desde la creación del snapshot (21:51 del 06-11; 0 salidas/traslados exitosos post-deploy vs 7 ingresos + 3 devoluciones OK — los positivos pasan el CHECK). Ingresos/devoluciones/lecturas (grid sector, detalle posición, stock global) nunca se afectaron. Bug latente adicional corregido de paso: el fallback replay de piso_salida_posicion/piso_traslado_posicion no restaba 'transferencia' (convención de piso_stock_nivel_fn_signo) — sin efecto hoy (0 movimientos transferencia) pero era una mina futura.
- 4 (procedimiento): CREATE OR REPLACE de piso_stock_nivel_fn_delta (08_fix_fn_delta_20261107.sql) — punto único de falla → punto único de fix, sin schema, sin backfill, sin redeploy; descuentos por UPDATE fila-a-fila con SELECT … FOR UPDATE (el CHECK se evalúa sobre el valor FINAL; falla ruidosa solo si el stock real quedaría negativo — semántica de event-sourcing intacta) con mensajes accionables PISO_STOCK_AUSENTE / PISO_STOCK_INSUFICIENTE; incrementos conservan INSERT..ON CONFLICT (candidato positivo pasa el CHECK). Mismo archivo alineó el fallback replay de ambas RPCs.
- 5 (sin conflictos): único consumidor de fn_delta = trigger trg_piso_stock_nivel_delta (pg_proc prosrc); misma firma y misma aritmética neta; grid/detalle/validaciones leen la tabla sin cambios; RLS/policies intactas; verificado post-fix: snapshot vs replay 0 desync en 375 buckets.
- 6/7 (implementación y orden): batería de 5 casos en BD — (1) el bug original: salida 140 s/140 → snapshot 0 ✓; (1b) reversa por DELETE → 140 ✓; (2) insuficiente real 500 s/140 → PISO_STOCK_INSUFICIENTE con mensaje claro ✓; (3) bucket inexistente → FK bloquea ✓; (4) ingreso +50 → 190 y reversa → 140 ✓; (5) cero restos de diagnóstico ✓. Fuente canónica scripts/sql/03_snapshot_triggers.sql actualizada (v2 con comentario de causa raíz).
- 8 (todos los accesos): E2E REAL en producción con la cuenta del usuario vía PostgREST (misma ruta que supabase-js) — traslado ida Pos15→Pos10 de 1 KG de 56203 (la operación exacta que ayer falló): 200 OK, nums 2250/2251, snapshot P15 139 / P10 341 en sync; traslado vuelta: 200 OK (2252/2253); salida 1 KG (2254) + devolución 1 KG (2255): 200 OK, neto cero; control negativo salida 500 → 400 INSUFFICIENT_STOCK ✓; estado final = estado inicial (140 @ Pos15). Movimientos de verificación etiquetados turno E2E / «Verificacion Fix».
- QA: fix 100% BD (ningún cambio de código de app → sin tsc/build/deploy; prod sigue en a5c25d6). Sync global final 0/375. 

Stage Summary:
- Causa raíz documentada para el equipo: CHECK-before-arbiter de PostgreSQL rompe todo INSERT..ON CONFLICT con candidato negativo — patrón a evitar en futuras tablas-delta con CHECK >= 0.
- Salidas, traslados, ajuste de saldo y anulaciones de Piso OPERATIVAS de nuevo; validación INSUFFICIENT_STOCK real intacta; snapshot consistente (0/375); cero pérdida de datos (los intentos fallidos nunca persistieron por atomicidad).
- Commit: (ver git log) · Sin redeploy (fix BD aplicado por MAPI sbp + verificación E2E con cuenta de usuario).

---
Task ID: mejoras-piso-20261107
Agent: Main Agent
Task: «Implementar las mejoras mostradas en la consulta» — las 7 mejoras estructurales del módulo Piso para atenciones masivas (metodología 9 pasos, alcance PISOS; el usuario resuelve los 4 INC manualmente, no se tocaron)

Work Log (1.1–9):
- 1.1/1.2 (sobre origin/main 768fab1): el módulo Piso es event-sourcing puro — cada lectura de stock reconstruía el historial completo en cliente; 12 RPCs en BD con solo 3 usados; escritura cliente en 2 pasos sin transacción (la migración a RPCs llegó por las sesiones paralelas); listarMovimientos descargaba hasta 25.000 cabeceras + ~8 queries de resolución por evento realtime; stockPisoGlobal hasta 40.000 detalles al browser (con truncado silencioso que sobreestimaba stock); ubicación reconstruida en cliente duplicada en 4+ funciones.
- BD-M1 (LIVE): Vista piso_v_niveles_ubicacion — ubicación "B-A1-Pos N" resuelta en servidor (misma lógica de cleanSubcolCode y del formato de labels).
- BD-M2 (LIVE): Tabla snapshot piso_stock_nivel (nivel_id, bloque_id, cantidad, CHECK >= 0) + triggers AFTER INSERT/DELETE/UPDATE en piso_movimiento_detalles (aritmética +ingreso/devolucion/stock_inicial, −salida/transferencia; cualquier path de escritura la mantiene) + backfill 131 filas + verificación snapshot vs replay = 0 diferencias. Backfill previo: VACUUM/ANALYZE no requerido (tamaños pequeños).
- BD-M3 (LIVE): RPC piso_listar_movimientos(_limit,_offset,_tipo,_usuario,_desde,_hasta,_q) → total + conteos por tipo sobre el conjunto filtrado + detalles con bloque_codigo/ubicación vía vista; RPC piso_usuarios_movimientos(). Correcciones durante el deploy: ORDER BY dentro de jsonb_agg y cast numero_operacion::bigint. Validada: total 2.042 = 757+1.172+113; paginación offset OK; filtros tipo/fecha/texto OK.
- BD-M4 (LIVE): piso_stock_sector_grid reescrito sobre el snapshot (Plan 109ms; antes replay del historial por sector); validación de stock en piso_salida_posicion y piso_traslado_posicion ahora O(1) vía snapshot con fallback a replay si la clave no existe.
- BD-M5 (LIVE): DROP de piso_registrar_salida y piso_registrar_traslado (generación anterior de piso_salida_posicion/piso_traslado_posicion; 0 referencias reales en src — solo un comentario). 16 RPCs piso restantes, todos con propósito.
- BUG CRÍTICO #1 descubierto y corregido: piso_stock_detalle_posicion fallaba SIEMPRE desde su creación (COALESCE(fecha_vencimiento, '') mezclando date con texto → error de plan) — el cliente lo enmascaraba con su fallback client-side.
- BUG CRÍTICO #2 descubierto y corregido: jsonb_set con ruta anidada NO crea objetos intermedios sobre '{}' (limitación PostgreSQL 17) → el pool de ingresos del RPC quedaba vacío y devolvía 0 lotes incluso tras el fix #1. Fix: crear contenedor por bloque antes de la asignación anidada. Validado contra datos reales: posición prueba → 40 @2027-06-30 y 66.000 @2027-08-10 = exactamente el neto SQL y el snapshot.
- DELTA CLI-M1 (sobre 768fab1): eliminarMovimiento y eliminarMovimientoConPar ahora usan el RPC piso_eliminar_movimiento (transacción única; el trigger del snapshot actualiza el saldo en la misma transacción; falla ruidosa si el saldo resultante sería negativo — antes stock negativo silencioso). Se conserva el descubrimiento del PAR por uuid_sync.
- DELTA CLI-M3: MovimientosTab server-side — paginación 50/pág (Anterior/Siguiente + "Página X de Y · N movimientos"), filtros tipo/usuario/fecha/texto resueltos en BD (texto debounced 350ms), cards con conteos server-side del conjunto filtrado completo, filtro de usuarios vía RPC. Conservados: loadError con reintento, gate puedeEliminar, eliminación en par, guard generacional y skip con pestaña oculta. El listado de 25K filas por evento realtime queda reemplazado por 1 RPC de 50 filas.
- DELTA CLI-M4: usePisoRealtime con coalescing de ráfagas (mín 50 ms, techo 1.2 s anti-hambre) — una atención de N operarios colapsa en 1 refresh por pestaña en vez de N×M refetches completos.
- DELTA CLI-M5: fix O(detalles×posiciones×niveles) → Map nivel→posición en el fallback de cargarPosicionesSector.
- NO TOCADO (evaluado, decisión por paso 5): stockPisoGlobal sigue en cliente porque StockPisoItem ahora lleva deep-links (sector_id/posicion_id/columna_letra) que el RPC no devuelve — migrar degradaría la navegación Stock→Sectores; stockDetallePosicion sigue en cliente por diseño de las sesiones paralelas (salida dirigida al lote elegido + desborde FEFO, lote-aware). Ambos quedan como trabajo futuro (extender RPCs con lote + deep-links).
- QA: tsc --noEmit OK (deps nuevas instaladas), eslint OK en los 3 archivos tocados, next build OK.
- Verificación de coherencia global post-migración: snapshot 131 filas = replay con 0 diffs; RPC global devuelve 154 lotes coherentes; grid del primer sector 15 posiciones con stock.

Stage Summary:
- Lecturas O(1) por sector (snapshot), listado paginado server-side sin truncado, escritura ya transaccional (sesiones paralelas) ahora con validación O(1) y borrado atómico con integridad de saldo, realtime con coalescing.
- Integridad: imposibilidad técnica de stock negativo por concurrencia (locks server-side + validación + CHECK snapshot); borrar historial que dejaría saldo negativo ahora falla con error claro (semántica correcta de event-sourcing).
- 2 bugs latentes de RPC corregidos en BD con validación contra datos reales.
- Commit: (ver git log) · Deploy: CI Cloudflare Pages tras push a main.

---
Task ID: auditoria-exhaustiva-20261107
Agent: Main Agent
Task: «Revisar y hay errores en la app, bugs, duplicados, códigos deficientes, estructura de datos fallidos o poco óptimos, cálculos fallidos o con poca coherencia — auditoría exhaustiva, Módulos: todos» (ronda de re-verificación; los 4 INC texto libre los resuelve el usuario manualmente) — 9 pasos

Work Log (1.1–9):
- 1.1/1.2 (re-verificación de la ronda 2026-11-06 + barrido nuevo; sandbox reciclado → repo re-sincronizado a origin/main 354cc39, scripts sb_config/cf_config reconstruidos): TODOS los fixes de ayer VIGENTES — 0 duplicados exactos en movimientos (28,391 filas), 0 gemelos-traslado, los 14 códigos recuperados intactos (catálogo 1,106 = Excel oficial re-importado 16:07 + 14; el −1 vs 1,107 es contenido upstream del Excel, mergeCatalogo es no destructivo), RPC catalogo_reregistrar_con_stock correcta (fórmula bien, idempotente, excluye INC), INC canónicos salvo Elmer-01/Dañadas (texto libre del USUARIO — no tocados), RLS 21/21, 0 políticas anon, 0 usuario_id huérfano, 0 cantidades ≤0, 0 fechas futuras, índices completos. FALSOS POSITIVOS descartados con la fórmula REAL del app (solo 'salida' resta — kardex.ts/267): «BOBINAS VARIAS» (+10) es fila INC-linkada (codigo_inc='Dañadas', vive en Stock INC — la RPC la excluye por diseño), «MKT» está balanceado (+1/−1), código '4' neto 0 (14 movs auto-balanceados del artefacto 25-06)
- HALLAZGO REAL (BD): celda 7-2-1-11 con código 42975 = −80 (neto celda −35 amortiguado por 50891 +45) — CREADO por la deduplicación de gemelos del 06-11: el ingreso duplicado del artefacto 25-06 era la única cobertura de salidas históricas excesivas (26-06: −260) y la verificación «0 negativas» del 05 era previa al borrado. La app NO se rompe (ocupación cuenta por código: la celda sigue ocupada por 50891; salidas validadas contra stock; ecuación exacta), pero el stock negativo era INVISIBLE: la RPC stock_por_codigo_kardex filtra HAVING > 0 (decisión Task 19 anti-ruido de ceros) y StockTab lo replicaba — ni siquiera aparecía con el filtro «Todos». 42975 tiene +2,560 en el almacén global → desbalance SOLO a nivel celda → requiere CONTEO FÍSICO de 7-2-1-11 (usuario, misma categoría que sus 4 INC)
- 2 (causa): (A) el HAVING > 0 de Task 19 confundió «ruido histórico» (ceros, 82%) con «error accionable» (negativos); (B) la convención de signos estaba copiada a mano en 13 sitios del frontend (kardex ×3, FEFO, Ocupación, Stock ×3, Stock INC, Traslado, Descarga, MovimientoForm ×2 — detectadas 2 extra con el guard estático) + 3 RPCs SQL, con riesgo real de divergencia (ya ocurrió con 'stock_inicial')
- 3 (repetición en otras pestañas): (A) el filtrado de negativos estaba en RPC stock_por_codigo_kardex + StockTab cliente (normal e INC) — las demás pestañas (Ocupación/FEFO/Descarga/Movimientos) muestran el dato sin ocultarlo; (B) la duplicación de la regla afectaba a TODAS las pestañas de Racks que netean movimientos; Piso NO hereda (ledger propio piso_movimientos con convención documentada distinta: traslado = par salida+ingreso)
- 4/5 (procedimiento sin conflictos): (A) RPC stock_por_codigo_kardex: HAVING > 0 → <> 0 (el 0 sigue excluido — Task 19 intacta; CREATE OR REPLACE sin cambio de firma/permisos, authenticated ejecuta, owner postgres); (B) StockTab: filas negativas con badge ROJO «inconsistencia» + tooltip «requiere conteo físico» en móvil y escritorio, cabecera actualizada; (C) utils.ts: esTipoEntrada() como FUENTE ÚNICA (impactoStock refactorizado sobre ella) + GUARD estático en tests que impide que el literal vuelva a src/; NO se tocaron: ocupacion_celdas_v2 ni catalogo_reregistrar_con_stock (correctas, literales SQL documentados), piso/api.ts (convención propia), los 4 INC texto libre ni los 7 traslados sin par ni el código '2' (decisión del usuario)
- 6/7 (implementación experta y ordenada): migración scripts/migracion_stock_negativos_20261107.sql (aplicada por MAPI + verificación E2E: 42975 devuelve 7-2-1-11 = −80 como primera fila, 50891 intacto, 0 ceros); 10 archivos de código (+82/−46); test_signo_movimiento.js (17 checks: contrato de esTipoEntrada/impactoStock para los 5 tipos + guard anti-duplicación fs-based + coherencia mutua)
- 8 (accesos + QA + despliegue): Supabase MAPI (migración, VACUUM ANALYZE ×8: rq_atenciones 20.4%, user_roles 59.5%, piso_posiciones/subcolumnas/columnas, ral_items, rals, profiles → 0 dead tuples; verificaciones SQL), GitHub (push e7d8f30 tras reconfigurar remote con PAT), Cloudflare (deploy verificado). QA: tsc 0 · eslint 0 · 45/45 suites (44 + nueva test_signo_movimiento) · build OK · producción version.json = 202611062024-e7d8f30
- E2E producción post-deploy (cuenta admin): 6/6 módulos (Racks 9 pestañas, Piso 6, Usuarios, Recepción, Atención, Tránsito) con 0 page errors y 0 console errors; contador Movimientos 28,391 = BD exacto; ecuación Ocupación verificada por código contra SQL (ocupada_sin_inc 1,147 + ocupada_con_inc 2 = 1,149 · solo_inc 38 · vacías 13 = 1,200); la fila 7-2-1-11 = −80 VISIBLE con badge rojo (captura download/evidencia_stock_negativo_visible_20261107.png)
- Reportados SIN tocar (decisión del usuario): 4 INC texto libre (Elmer-01 1,158,720 u · LIBERADO??? 7 · Dañadas 10 · INC435 596.6), 7 traslados de sesiones manuales jul-oct sin par salida exacta (sin cambios: verificados 7 hoy), código '2' (59 movs, neto 9), CONTEO FÍSICO de celda 7-2-1-11 (42975 = −80 en el libro), celda fuera de grilla B7-T1-P1-Pos1 (código '118', neto 0, inocua, trazabilidad preservada)

Stage Summary:
- Los stocks negativos ya no son invisibles: la pestaña Stock los muestra en rojo como inconsistencia accionable (la BD manda la fila, la UI la marca) — el conteo físico de 7-2-1-11 puede gestionarse desde la app
- La convención de signos del Kardex tiene UNA fuente (constants.ts → esTipoEntrada/impactoStock) con guard de tests que impide re-duplicarla (13 copias eliminadas)
- Higiene BD: VACUUM ANALYZE ×8 (0 dead tuples), migración RPC verificada E2E, 0 duplicados, RLS 21/21
- Deploy: e7d8f30 en producción (rackly.pages.dev 2026-11-06 20:24 UTC), CI success, E2E 6/6 módulos sin errores

---
Task ID: auditoria-exhaustiva-20261106
Agent: Main Agent
Task: «Revisar y hay errores en la app, bugs, duplicados, códigos deficientes, estructura de datos fallidos o poco óptimos, cálculos fallidos o con poca coherencia — auditoría exhaustiva, Módulos: todos» (trace 1a1b0f6a321c6959) — 9 pasos

Work Log (1.1–9):
- 1.1/1.2 (averiguación: 3 rondas de SQL con esquema real + lectura de código + convención de signos): (A) REGRESIÓN DEL FIX DE HUÉRFANOS — el catálogo completo tenía updated_at único 2026-11-05 19:00 UTC y los 16 códigos re-registrados por la auditoría del 05 YA NO ESTABAN: el flujo operativo «Eliminar todo el catálogo (clearCatalogo) + importar Excel oficial (mergeCatalogo, 1,093 filas)» borró el re-registro manual y dejó 14 códigos con 33,947 u de stock físico INVISIBLES otra vez (55972 BIG COLA FIESTAS PATRIAS 23,500 · 53773 PRUEBA 5,650 · 54108 2,600 · 57358 1,025 · 55713 500 · 54583 PAPI RICAS 500 · 56100 86 · TRADE MARKETING 64 con 2 movimientos NUEVOS de hoy · 2/DOCUMENTOS/PRUEBA./CALIDAD/10/53508 pequeños). (B) 2 PARES GEMELOS del artefacto de migración 2026-06-25 13:06 (57260 241.8 en 3-1-1-5 y 42975 80 en 7-2-1-11, f_modificacion idéntica al microsegundo) inflaban stock. (C) Bloat: refresh_tokens 11.4%, rq_atencion_items 10.8%, piso_niveles 9.3%, recepcion_registros 4.3%. (D) Permisos anon amplios por defecto Supabase — verificados inocuos: TODAS las políticas RLS son solo para authenticated (0 políticas para anon) y 21/21 tablas con RLS activa. Verificado y SANO sin acción: las 44 «variantes INC» de la ronda 1 eran INC de años 24/25 legítimos + 4 texto libre ya reportados (sin regresión split-brain); cantidades siempre >0 (el signo lo da tipo); 0 celdas negativas con la fórmula del app; 0 fechas futuras; 0 usuario_id huérfano; 0 correos duplicados; 0 uuid_sync duplicado; lotes sin f_vencimiento con stock (230) es info, no error; 57726/540630/48448 con miles de unidades BRUTAS pero neto ≤0 (consumidos — la ronda 1 sin signo los señalaba de más); rq_atender_item con 2 firmas es sobrecarga deliberada (jsonb); ocupación evolucionó 1130→1150 RPC por operación normal.
- 2 (causa): la corrección de datos del 05 (INSERT manual de 16 códigos) no era DURADERA — mergeCatalogo es upsert no destructivo, pero clearCatalogo borra TODO y el flujo real de operación es vaciar+reimportar el Excel de Big Magic; cualquier reparación manual del catálogo muere en la siguiente re-importación. Los gemelos de junio son el mismo artefacto del 25/06 que ya soltó 10 gemelos del código '1' (quedaban estos 2 con códigos reales).
- 3 (repetición): (A) afectaba Stock (búsqueda por catálogo), FEFO, Operaciones (salida/traslado de códigos fuera de catálogo) y Catálogo — de nuevo en todas las pestañas que filtran por catálogo; (B) inflaba Stock y Ocupación en 2 celdas concretas; (C) rendimiento general de escritura en Recepción/RQ/Piso.
- 4/5 (procedimiento sin conflictos): (A) capa de DATOS + capa DURADERA de código: nueva RPC server-side catalogo_reregistrar_con_stock(p_usuario) (SECURITY DEFINER, search_path fijado, ON CONFLICT DO NOTHING — jamás toca filas existentes) + reRegistrarCodigosConStock() en catalogo.ts que se dispara al final de mergeCatalogo Y clearCatalogo (punto único, testeable; fallo silencioso-registrado que nunca pierde la operación del usuario) + aviso toast «Auto-reparación» en las 3 rutas de CatalogoTab; (B) dedup quirúrgico por ids explícitos con respaldo JSON doble; (C) VACUUM ANALYZE de las 4 tablas. NO se tocaron: RLS (sana), INC 24/25 (legítimos), 4 INC texto libre (pendiente decisión del usuario, ya reportados), movimientos de negocio.
- 6/7 (implementación experta y ordenada): RPC probada IDEMPOTENTE (2ª llamada = 0 filas); catalogo.ts: ReRegistroResultado + _ultimoReRegistro + ultimoReRegistro() getter, re-registro inválida el caché local; mergeCatalogo/clearCatalogo aceptan usuarioId opcional (compatibilidad intacta — los llamadores existentes no cambian); CatalogoTab pasa perfil.id y muestra toast con los códigos afectados.
- 8 (accesos + QA + despliegue): respaldos dobles (backup_catalogo_20261106.json 1,093 filas + backup_gemelos_junio_20261106.json 4 filas en scripts/ y download/) ANTES de tocar; migración: INSERT 14 códigos (catálogo 1,093→1,107) · DELETE 2 gemelos · RPC + GRANT EXECUTE authenticated · verificación 0 huérfanos con stock y 0 duplicados exactos · VACUUM ×4. Suite: tsc 0 · eslint 0 · 44/44 (43 + NUEVA test_catalogo_autoreparacion: RPC invocada con p_usuario, fallo no lanza, merge/clear disparan reparación, idempotencia) · build OK · push 9cc047b · producción version.json = 202611061320-9cc047b (CI success). E2E producción (admin Miguel Hidalgo): Catálogo muestra 55972 = 23,500 BM y código 10; Stock muestra 55972 → 23,500 en celda 1-1-2-8 (visible y operable); Stock INC INC26-451 = 8,000 en UNA fila (regresión split-brain superada); Ocupación «1150 + 38 INC + 12 = 1200» cuadrada contra RPC v2 en vivo (bloques 159+157+159+159+118+160+160+54+24); FEFO 14,795 celdas de lotes; Piso/Recepción/Atención (29 pendientes/9 en proceso)/Tránsito (guías de hoy)/Usuarios cargan; 0 errores de página y consola en TODO el recorrido.
- 9 (Módulos): Racks (Catálogo/Stock/FEFO/Ocupación/Stock INC/Operaciones), infraestructura BD (catalogo, movimientos, mantenimientos), Atención/Piso (vaciados de catálogo les afectaban vía búsqueda) — Recepción/Tránsito/Usuarios auditados sin hallazgos que requieran cambio.

Stage Summary:
- El stock físico ya no puede quedar invisible por una re-importación: la auto-reparación server-side garantiza que TODO código con stock > 0 exista en catálogo después de cada importación o vaciado (idempotente, con aviso visible al usuario)
- 14 códigos / 33,947 u vuelven a ser visibles y operables (55972 BIG COLA 23,500 verificado E2E en producción)
- Duplicados: 0 exactos en TODO movimientos (borrados los 2 últimos gemelos del artefacto de migración de junio, con respaldo)
- Higiene: VACUUM ×4; verificación de seguridad: RLS 21/21 activa, 0 políticas anon, 0 funciones definer sin search_path
- Reportados sin tocar (requieren decisión del usuario, mismos del 05): 4 INC texto libre (Elmer-01 1,158,720 u — confirmar si debía ser INC real, LIBERADO??? 7, Dañadas 10, INC435 596.6), 7 traslados de sesiones manuales jul-oct sin par salida exacta, código '2' (59 movimientos históricos, neto 9 — validar si es un código real o basura operativa)
- Deploy: 9cc047b en producción (rackly.pages.dev 2026-11-06 13:20 UTC), CI success, E2E 7/7 módulos verificado
---
Task ID: verificacion-accesos-20261106
Agent: Main Agent
Task: «Revisar si tenemos todos los accesos de GitHub, Cloudflare, Supabase» (trace 1a1b0e632b3726dd) — verificación EN VIVO contra las APIs reales

Work Log:
- GITHUB: PAT ghp_TQGT…VI2W → GET /repos/fileshidalgo-spec/rackly OK (push=True, permiso colaborador admin); último CI «Deploy to Cloudflare Pages» success @ 190838d; 5/5 secrets presentes (NEXT_PUBLIC_SUPABASE_URL 2026-10-12 · NEXT_PUBLIC_SUPABASE_ANON_KEY · NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY · TU_TOKEN_DE_API_CLOUDFLARE 2026-10-11 · ID_DE_CUENTA_CLOUDFLARE)
- CLOUDFLARE: token de cuenta cfat_ksnY…1bad → /accounts/{id}/tokens/verify = ACTIVE (account ID autodetectado vía GET /accounts; el ID solo vive en el secret de GitHub); Pages project «rackly» OK, dominio rackly.pages.dev, último deploy producción branch=production commit=190838d
- SUPABASE: token MAPI sbp_fcd7…53db → proyecto «Rackly» ref owjryvcrhpmgtkkdcrkm, región sa-east-1, status ACTIVE_HEALTHY; endpoint /database/query operativo: movimientos=28,368 · profiles=32 · catalogo=1,093
- APP PRODUCCIÓN: version.json = 202611051420-190838d — coincide con origin/main HEAD (coherencia repo↔despliegue); bundle de producción contiene la URL de Supabase (NEXT_PUBLIC secrets correctamente horneados)
- NOTA sandbox: reciclaje perdió scripts/sb_config.py, cf_config.py y verifica_accesos.py — reconstruidos; repo local estaba en snapshot huérfano antiguo → git reset --hard origin/main (190838d); filemode re-anclado (core.fileMode false)

Stage Summary:
- 3/3 accesos operativos (GitHub admin+push+CI, Cloudflare Pages deploy, Supabase MAPI SQL), producción coherente con el repo; sin cambios de código ni de BD en esta tarea
---
Task ID: auditoria-exhaustiva-20261105
Agent: Main Agent
Task: «Revisar y hay errores en la app, bugs, duplicados, códigos deficientes, estructura de datos fallidos o poco óptimos, cálculos fallidos o con poca coherencia — auditoría exhaustiva de todos los módulos y la BD» (trace 1a1abde848bba415) — 9 pasos

Work Log (1.1–9):
- 1.1/1.2 (averiguación, 5 fases de SQL + replay de ledger + lectura de código): BD sana en lo estructural (21/21 tablas con RLS, índices correctos, movimientos 0% dead tuples, 0 dups exactos en movimientos/catálogo/profiles/piso/RQ/permisos, 0 duplicados por mayúsculas/espacios, fechas coherentes, cantidades > 0). TRES familias de incoherencia reales: (A) SPLIT-BRAIN INC — el mismo INC físico registrado bajo variantes («Inc26-577»+«INC26-577», «INC026-451»+«INC26-451», 29 filas en 13 valores) y el sistema agrupando por cadena EXACTA mostraba DOS INC con stock dividido (INC26-451 canónico neto 0 + INC026-451 typo neto 8,000; ídem 110/429/451/501/577/578); 4 INC como texto libre no mapeable (Elmer-01, LIBERADO???, Dañadas, INC435). (B) CÓDIGO '1' FANTASMA — 63 filas del artefacto de migración 2026-06-25 (46 ingresos fantasma 16,087.4 + 17 salidas de corrección/administración) dejaban 3 celdas con stock NEGATIVO por código (−60/−8/−4) y 2 celdas ocupadas SOLO por el fantasma (5-1-3-16 con 840, 5-1-3-7 con 27) — la ecuación de ocupación mentía. (C) 16 CÓDIGOS HUÉRFANOS CON STOCK REAL (17 con '1') — 55972 BIG COLA FIESTAS PATRIAS 23,500 u, 53773 PRUEBA 5,650, 54108 2,600… eliminados del catálogo o jamás registrados: stock físicamente existente INVISIBLE para búsqueda/operación. Verificados y SANOS (sin acción): recepcion guia_id repetido es N-por-guía (multi-artículo), estados 'Recibido'/'Recepcionado'/'Pendiente'/'Observado' son los 4 estados legítimos del módulo, los 7 traslados «sin par salida» son sesiones manuales de reorganización física de julio-octubre (cantidades asentadas por conteo físico — auto-reparar sería adivinar orígenes, se reportan sin tocar), KPIs Atención cubren exactamente los 3 estados en BD, calcularOcupacion/calularStockRacksDesdeMovs coherentes con las RPCs (UPPER/TRIM + stock>0 por código).
- 2 (causa): (A) sin normalización del código INC al escribir (trim+mayúsculas+cero extra del año) ni al agrupar; (B) la limpieza parcial del 2026-11-05 anterior borró los duplicados EXACTOS pero el resto del artefacto (ingresos no gemelos + salidas de corrección) seguía desbalanceado por celda; (C) los borrados de catálogo no venían con limpieza/migración de su stock.
- 3 (repetición): (A) afectaba Stock INC (lista), Ocupación y MapaRackSelector (merge INC vía fetchIncPorUbicacion) y la búsqueda; (B) afectaba Ocupación (2 celdas falsamente ocupadas + 3 negativas invisibles por HAVING>0) y la lista Movimientos; (C) afectaba búsqueda Stock/FEFO (por código de catálogo) y Operaciones (salida/traslado de esos códigos).
- 4/5 (procedimiento sin conflictos): REPARACIÓN DE DATOS con respaldo JSON doble (scripts/ + download/: 63 filas código '1' + 29 INC a normalizar) + NORMALIZACIÓN EN CÓDIGO en TODA escritura y agrupación (evita recaída) + re-registro de catálogo ADITIVO (ON CONFLICT DO NOTHING, nunca toca filas existentes). NO se tocaron: estados de recepción (legítimos), sesiones manuales históricas (requieren conteo físico del almacenero), políticas RLS/permisos (Task 4 ya los endureció).
- 6/7 (implementación experta y ordenada): NUEVO src/lib/rackly/inc-norm.ts (normalizarCodigoInc: trim+UPPER, INC026-x→INC26-x, texto libre preservado sin inventar, idempotente) aplicado en kardex.ts (addMovimiento fallback+RPC, traslado fallback+RPC, bulk) + piso/api.ts (insert directo + RPC piso_registrar_movimiento) + agrupación en fetchIncPorUbicacion y StockIncTab + BÚSQUEDA normaliza el término (INC026-451 encuentra INC26-451) + placeholder/help en formato canónico (INC26-1108). BD: UPDATE 29 INC normalizados → DELETE 63 código '1' → INSERT 16 códigos a catálogo (1,106→1,122, descripcion/un del último movimiento, updated_by=admin) → VACUUM ANALYZE auth.refresh_tokens (24% dead), auth.sessions, recepcion_registros.
- 8 (accesos + QA): respaldos verificados antes de tocar; verificación SQL post-fix: 0 variantes INC, 0 código '1', 0 celdas con stock negativo en TODO el almacén, 0 huérfanos con stock, INC26-577=4 filas unificadas / 578=6 / 451 neto 8,000. Suite: tsc 0 · eslint 0 · 43/43 (42 previas + NUEVA test_inc_norm: 20 checks — case, cero extra, texto libre, idempotencia, convergencia) · build OK · push b322fac + eaa21d6 · producción version.json = 202611051412-eaa21d6 (CI success). E2E producción (admin Miguel Hidalgo): INC26-451 = 8,000 en UNA entrada (antes partido 0+8,000), búsqueda INC026-451 lo encuentra, Ocupación «1130 + 38 INC + 32 = 1200» VERIFICADA contra RPC server-side (ocupadas_rpc=1130 exacto), delta-sync vivo (+1 → 28,199 filas), arranque caliente OK, 0 errores de consola/página.
- 9 (Módulos): Racks (Stock INC, Ocupación, Movimientos, búsqueda), Piso (escritura INC), infraestructura BD (movimientos, catálogo) — Atención/Recepción/Tránsito/Usuarios auditados sin hallazgos que requieran cambio.

Stage Summary:
- El mismo INC físico ya no puede dividirse: normalización en escritura + agrupación + búsqueda; 29 filas históricas unificadas (INC26-577/578 pasaron de 2 entradas con stock dividido a 1 coherente; INC26-451 muestra sus 8,000 reales en una sola fila)
- Ocupación honesta: 0 celdas con stock negativo (antes 3 por el fantasma), 2 celdas falsamente ocupadas por código '1' liberadas, ecuación verificada contra RPC (1130 + 38 + 32 = 1200)
- 16 códigos con stock real (34,447 unidades: 55972 BIG COLA FIESTAS PATRIAS 23,500, 53773 PRUEBA 5,650, 54108 2,600, 57358 1,025, 55713 500, 54583 500, 56100 86, otros) re-registrados en catálogo → stock visible y operable otra vez
- Higiene BD: VACUUM de auth.refresh_tokens/sessions/recepcion_registros; respaldos JSON en download/ (backup_codigo1_20261105.json 63 filas · backup_inc_noncanon_20261105.json 29 filas)
- Reportados sin tocar (requieren decisión/conteo físico): 7 traslados de sesiones manuales jul-oct sin par salida exacta (42975 +1,200 · 118 +500/+50/+100 · 5206 +50 · 57319 +33,030 · 57400 +275), 4 INC texto libre (Elmer-01 1,158,720 u — revisar si debía ser un INC real, LIBERADO??? 7, Dañadas 10, INC435 596.6), 17 códigos huérfanos sin stock (solo historia)
- Deploy: b322fac + eaa21d6 en producción (rackly.pages.dev, 2026-11-05 14:12 UTC), CI success, E2E verificado
---
Task ID: rendimiento-carga-20261105
Agent: Main Agent
Task: «Mejorar la velocidad en la carga de información consultada — la app demora en mostrar los datos que le solicitan los usuarios» + bugs/duplicados/procesos/estructura de datos/BD salud (Módulos: todos) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo medido): TRES familias de caminos re-descargaban la TABLA COMPLETA de movimientos (28K filas ≈ 14.5 MB ≈ 21 s en red real) tras cada operación y en cada recarga: (a) addMovimiento/trasladarMovimiento con refetch:true por defecto → fetchMovimientos() completa tras CADA ingreso/salida/devolución/INC (5 sitios en MovimientoForm); (b) TrasladoTab con setMovs(await fetchMovimientos()) × 3 tras cada traslado; (c) deleteMovimiento/eliminarMovimientos/trasladarMovimientoFallback (3 sitios en kardex). Y lo más grave: el caché del singleton vivía SOLO en memoria — cada F5/recarga/navegador nuevo = «Cargando movimientos…» 21 s antes de mostrar UN dato en FEFO/Stock/Traslado/Descarga. BD verificada sana: índices correctos (idx_movimientos_fmod presente), RLS activo en todas las tablas, dead tuples 3.3%
- 2 (causa): el refresco post-escritura usaba descarga completa mientras el delta-sync solo cubría el polling/realtime del hook; y el caché de sesión no sobrevivía a la recarga de página (módulo-nivel, no persistente)
- 3 (repetición): el patrón afectaba a TODAS las pestañas del kardex (FEFO/Stock/Traslado/Descarga/Movimientos + fallback de Ocupación) vía los retornos de las funciones de escritura; duplicados: movimientos 10 filas gemelas (5 grupos, todas 2026-06-25 13:06:14, todas uuid_sync NULL, código «1» — artefacto de migración de junio que DOBLABA el stock del código 1 en B5·T1·P3 posiciones 18/3/7/9 desde hace 4 meses); catalogo 0 dups; profiles 0 dups
- 4/5 (procedimiento sin conflictos): (a) REFRESCO POST-ESCRITURA INCREMENTAL centralizado — kardex.ts expone registrarRefrescadorMovs() (inyección, sin ciclo de imports); el hook registra refrescarMovimientosIncremental(bajas) que fusiona bajas conocidas + delta por marca de agua sobre el caché y difunde; las 8 funciones de escritura lo usan y SIN registro degradan a la descarga completa previa (tests/SSR intactos); (b) ARRANQUE CALIENTE — nuevo src/lib/rackly/movs-cache.ts persiste el dataset en IndexedDB (payload versionado, validación pura, tolerante a cuota/SSR/corrupción); el hook siembra al instante, valida count contra BD y aplica delta; cualquier descuadre degrada a descarga completa de reparación (maquinaria ya existente); (c) descarga fría más rápida: paginación ADAPTATIVA (observa el tamaño real de página que entrega el server — jamás trunca silenciosamente) + PAGE_SIZE 500→1000 + CONCURRENCY 8→12 (28K filas: 57 req × 8 → ~29 req × 12 en 3 oleadas)
- 6/7 (código experto y ordenado): movs-cache.ts (abrir/leer/guardar/borrar, silent-fail en TODOS los caminos); hook: programarGuardadoIdb (debounce 2 s) + flush en pagehide + arranqueCaliente/validarArranqueCaliente documentados; kardex: refrescarPostEscritura nunca lanza; TrasladoTab 3 sitios → refrescarMovimientosIncremental; deleteMovimiento/eliminarMovimientos pasan bajas=[ids] (el delta no ve DELETE)
- 8 (accesos + QA): 42/42 suites (41 previas + NUEVA test_movs_cache_arranque: 10 checks — validación de payload, invariante «sembrar del caché + cadena de deltas ≡ dataset completo», bajas conocidas, marca de agua estable) · tsc 0 · eslint 0 · build OK · Supabase MAPI: backup de las 5 filas a eliminar (scripts/backup_dups_eliminados_20261105.json + download/) → DELETE por ids explícitos → verificación 0 dups (28,125 filas) → VACUUM ANALYZE movimientos (dead tuples 917→0, stats frescas) · E2E producción: login OK, FEFO 1,324 lotes, 0 errores de consola
- Deploy: b99b1a9 en producción (rackly.pages.dev, version.json = 202611041828-b99b1a9, CI success)
- E2E producción FINAL (admin Miguel Hidalgo): (1) descarga fría → caché persistido verificado en IndexedDB (28,125 filas, schema 1, marca de agua correcta); (2) RECARGA (F5) → datos listos en 148 ms (antes ~21,000 ms — ×140); consola: «Arranque caliente: 28125 movimientos del caché persistido»; (3) FEFO 1,324 lotes inmediatos; (4) solo 11 requests post-recarga (head checks + 1 delta — SIN re-descarga completa); (5) 0 errores de página y consola
- 9 (Módulos): todos — Racks (FEFO/Stock/Traslado/Descarga/Movimientos/Ocupación), Atención (vía dataset compartido), infraestructura (hook singleton + funciones de escritura); DB: dedup + vacuum; Recepción/Tránsito/Piso/Usuarios sin cambios (no consumen el dataset)

Stage Summary:
- Velocidad percibida: recarga de página (F5) pasa de ~21 s esperando «Cargando movimientos…» a datos AL INSTANTE (caché persistido) + actualización por delta en ~1-2 s; cada ingreso/salida/devolución/traslado pasa de +21 s de re-descarga a ~1 s de delta (×17-21 más rápido por operación); primera carga histórica de un dispositivo: ~2-3× más rápida (29 req × 12 concurrentes vs 57 × 8)
- Datos: 10 duplicados de la migración de junio eliminados (stock del código «1» vuelve a su valor real) — respaldo conservado
- Sin regresiones: las pestañas conservan el contrato Movimiento[] con orden global; sin refrescador registrado el comportamiento previo se mantiene íntegro; auto-reparación por conteo + delta intacta
---
Task ID: rendimiento-incremental-20261104
Agent: Main Agent
Task: «La app demora mucho en procesar» — auditoría de rendimiento + salud integral (Módulos: todos) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo, medido en producción): fetchMovimientos() descarga la TABLA COMPLETA de movimientos — 28,130 filas / 14.5 MB / 21.0 s medidos en red real — en el montaje de FEFO/Traslado/Stock/Movimientos/Descarga y en el fallback client-side de Ocupación; el hook realtime re-descargaba TODO tras cada escritura de CUALQUIER usuario (realtime y pollCheck con fuerza:true). Reporte Atención: 0.56 MB / 2.7 s en CADA montaje del dashboard. BD sana: movimientos 10 MB (372 B/fila), índices correctos (codigo, f_modificacion DESC, ubicacion, codigo_inc parcial), funciones RLS STABLE y SELECT plegados a `true`; RPCs server-side vivos (ocupacion_celdas_v2 2.44 s, inc_por_ubicacion 0.46 s, stock_por_codigo_kardex 0.41 s); 788K seq_scans de movimientos = COUNT/DESCARGAS del cliente, no RLS
- 2 (causa): arquitectura de stock calculado en cliente sobre dataset completo + sincronización por re-descarga total por evento; con almacén activo, N usuarios conectados × cada escritura = 14.5 MB por cambio por usuario
- 3 (repetición): el mismo patrón alimenta 5 pestañas vía el hook singleton (punto único de estrangulamiento) + el dashboard de Atención re-descargaba 3 tablas en cada montaje y exportación
- 4/5 (procedimiento sin conflictos): sincronización INCREMENTAL en el punto único (useMovimientosRealtime) — las 5 pestañas NO cambian (siguen recibiendo Movimiento[] con el mismo orden global). Realtime aplica el payload directo (INSERT/UPDATE upsert por id, DELETE por id — replica identity default); pollCheck usa fetch incremental por marca de agua (f_modificacion > máx del caché, índice idx_movimientos_fmod); la descarga COMPLETA queda como auto-reparación cuando el conteo local ≠ BD (verificarYAutoReparar tras cada delta + en cada verificación de poll). Dashboard Atención: caché TTL 60 s con {forzar:true} solo desde el botón «Actualizar»
- 6/7 (código experto y ordenado): NUEVO src/lib/rackly/movs-sync.ts (motor puro: fusionarDeltas/eliminarPorIds/ordenarMovs/marcaAgua/resumenDelta — sin I/O, testeable); kardex.ts: descargaPaginadaMovs() compartida por fetchMovimientos y NUEVO fetchMovimientosDesde(desdeFmod) + movimientoDesdeFila exportado; hook reestructurado (cola coalescida 150 ms, aplicadores, auto-verificación); atencion-reporte.ts: cacheReporte TTL
- 8 (accesos + QA): 41/41 suites (39 previas + NUEVA test_movs_sync_delta con invariante «cadena de deltas ≡ dataset completo», 15 checks) · tsc 0 · eslint 0 · build OK · push bbc8369 · deploy verificado v=202611041709-bbc8369 · delta medido en producción: 1.23 s / 0 MB vs 21.0 s / 14.5 MB (×17) · E2E navegador (admin Miguel Hidalgo): login OK, Racks 9 pestañas, FEFO con 1,324 lotes reales en 5 rangos de vencimiento, Dashboard Atención con datos, 0 errores de consola
- 9 (módulos): Racks (FEFO/Traslado/Stock/Movimientos/Descarga/Ocupación-fallback), Atención (Dashboard/Excel), infra compartida (hook singleton) — Recepción/Tránsito/Piso/Usuarios sin cambios (no consumen el dataset)

Stage Summary:
- Re-sincronización tras cada cambio: 21.0 s / 14.5 MB → 1.23 s / ~0 MB (delta 0 filas) o ~1.5 s / ≤0.3 MB (delta ≤500 filas) — ×17 más rápido; la primera carga de sesión sigue igual (una sola vez, caché de sesión ya existente)
- Auto-reparación: cualquier deriva del caché (borrados sin WS, delta truncado) degrada a descarga completa verificada — el dataset jamás queda stale silenciosamente
- Salud integral verificada: BD índices OK · RLS STABLE OK · RPCs server-side OK · 0 errores de consola E2E · 41/41 suites
- Sin regresiones: las 5 pestañas conservan su lógica íntegra (contrato de orden global preservado por movs-sync)

---
Task ID: verificacion-accesos-20261104-b
Agent: Main Agent
Task: Restauración del acceso Supabase MAPI con nuevo token (entregado por el usuario)

Work Log:
- Nuevo sbp_ token probado contra la API real: GET /v1/projects → 200 (proyecto «Rackly» owjryvcr…, estado ACTIVE_HEALTHY); SQL real → 200
- scripts/sb_config.py actualizado con el nuevo token; SQL de diagnóstico verificado: movimientos=28,130 · profiles=30 · catalogo=1,106
- scripts/verifica_accesos.py: query de prueba corregida (usuarios→profiles; la tabla se llama profiles en el esquema)
- Nota: endpoint /projects/{ref}/health devuelve 400 (parámetros no soportados por esta versión de API) — no afecta: el camino real de diagnósticos es la query SQL, que responde

Stage Summary:
- Los TRES accesos quedan operativos: GitHub push ✅ · Cloudflare ACTIVE ✅ · Supabase MAPI + SQL ✅
- Cadena completa de despliegue y diagnóstico restaurada; app en producción sin cambios (v=202611021408-88c25a7)

---
Task ID: verificacion-accesos-20261104
Agent: Main Agent
Task: Verificación de accesos GitHub / Cloudflare / Supabase (pedido del usuario) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo): el PAT en el remote de git (ghp_CqrC…AJ7N) estaba MUERTO — push «Invalid username or token» (la lectura funcionaba solo por fallback anónimo del repo público); los 4 tokens Supabase MAPI guardados en scripts/ (incl. sb_config.py sbp_fc54…9e2e) devuelven 401 «Invalid access token»; el script audit_accesos.py daba falsos 401 de Cloudflare porque usa /user/tokens/verify (endpoint de usuario) sobre un token de nivel-cuenta
- 2 (causa): el remote fue dejado en una sesión previa con un PAT revocado; los sbp_ (Personal Access Tokens de Supabase) fueron revocados/rotados desde el dashboard; Cloudflare exige verificación a nivel cuenta (/accounts/{id}/tokens/verify) para tokens account-owned
- 3 (repetición): barrido de credenciales en scripts/ — 1 PAT GH, 2 cfat_, 4 sbp_, 0 JWT service_role en local (service_role vive solo como secret de GitHub); anon key viva
- 4/5 (procedimiento sin conflictos): remote reparado con el PAT vivo verificado (ghp_TQGT…VI2W, scopes repo+workflow, push=true); local estaba re-inicializado en 0fde678 (= tip del branch remoto backup/agosto-ocupacion, nada perdido) y quedó 578 commits atrás → git reset --hard origin/main (88c25a7 = producción); sin conflictos con ningún módulo (solo infra)
- 6/7 (código): nuevo scripts/verifica_accesos.py — prueba las credenciales EN USO (remote git, sb_config.py, cf_config.py, anon_key.json) contra sus APIs reales sin imprimirlas; cero cambios en la app
- 8 (accesos): GitHub OK tras reparación (secrets del workflow 5/5: NEXT_PUBLIC_SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY + TU_TOKEN_DE_API_CLOUDFLARE + ID_DE_CUENTA_CLOUDFLARE; CI verde — últimos deploys 88c25a7/03a93af/b60c0d4 success); Cloudflare OK (token ACTIVE, Pages rackly OK, producción v=202611021408-88c25a7); Supabase MAPI MUERTO (401 en los 4 sbp_) — diagnósticos SQL por Management API bloqueados hasta nuevo token del dashboard; anon key viva (auth/v1/health 200) → la APP en producción sin impacto
- 9 (módulos): infraestructura (GitHub / Cloudflare / Supabase); app Rackly sin cambios

Stage Summary:
- GitHub: PUSH RESTABLECIDO — el commit de esta entrada es la prueba real de publicación; repo local resincronizado con producción
- Cloudflare: token ACTIVE (verify a nivel cuenta), producción viva; falso negativo documentado para audit_accesos.py
- Supabase: app OK (anon key viva); acceso MAPI para diagnósticos SQL requiere que el usuario genere un nuevo Access Token (Supabase → Account → Access Tokens) y se actualice scripts/sb_config.py
- Continuidad: los traces 1a1976a1b9d39725 (Task 3 auditoría integral), 1a1978d198de5c91 (Task 5 ocupación INC) y 1a19c8089fb5fba5 (Task 6 mapa INC) ya estaban resueltos y desplegados por sesiones previas — el repo local quedó atrás y fue resincronizado

---
Task ID: 3
Agent: Main Agent
Task: Auditoría integral 2026-11-01 — «revisa toda la app que no tenga errores ni bugs» (trace 1a1976a1b9d39725 · Módulos: todos) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo): QA baseline verde (tsc 0 · eslint 0 · 39 suites · build) y E2E producción 6/6 módulos sin errores de consola; el barrido estático encontró la CLASE ESPEJO del bug T173 no cubierta: la RLS de UPDATE también FILTRA EN SILENCIO (HTTP 200, 0 filas) — 3 vías CRUD de Catálogo (alta por upsert / edición / borrado) y 4 cambios de estado (cambiarEstadoGuia, cambiarEstadoAtencion, recalcularEstadoRq, recalcularEstadoRal) celebraban escrituras que la BD podía no haber aplicado; colateral: eliminar ítem de catálogo sin verificación ejecutaba la poda del ancla de Piso aunque el DELETE no ocurriera; además cambiarEstadoRecepcion era CÓDIGO MUERTO (0 llamadores) y en BD las RPCs de mantenimiento FEFO (backfill/rebalance de lotes) estaban SECURITY DEFINER, sin guard y con EXECUTE abierto a anon
- 2 (causa): la auditoría 10-31 generalizó la honestidad del DELETE pero no la del UPDATE; el upsert de alta ocultaba que su rama ON CONFLICT UPDATE corre bajo la política de UPDATE (rol sin catalogo.editar → 0 filas → «Ítem agregado» falso)
- 3 (repetición): verificado por barrido completo — atender/revertir RQ-RAL ya usaban guard optimista + maybeSingle verificado; marcarGuiaRecepcionada ya devolvía conteo; guardarEdicionGuia ya contaba exacto; JSON.parse/.single()/catchs restantes todos con guard legítimo; BD sana: RLS 20/20, 0 huérfanos (RQ/RAL/Piso), 0 uuid_sync duplicados, 0 códigos de catálogo duplicados, estados dentro del catálogo
- 4/5 (procedimiento sin conflictos): extender eliminacion-honesta.ts con exigirActualizadas (misma filosofía, una sola implementación) y aplicarla en los 6 puntos; el alta de catálogo se separa en INSERT puro (la RLS de INSERT rechaza CON ERROR, jamás en silencio) vs edición verificada usando la lectura de existencia que ya existía (además PRESERVA stock_big_magic que el upsert habría pisado a 0); RPCs FEFO: REVOKE EXECUTE a anon/authenticated (sin llamadores en la app → impacto cero; service_role/postgres conservan); los llamadores de cambiarEstado* ya envuelven en try/catch con mensajeError → el nuevo error sale como toast claro, sin crash
- 6/7 (código): errores.ts (+ERR_ACTUALIZAR_BLOQUEADO), eliminacion-honesta.ts (+exigirActualizadas), modulos.ts (cambiarEstadoGuia/cambiarEstadoAtencion verificados; cambiarEstadoRecepcion eliminado), rq-atencion.ts/ral.ts (recalcular con verificación — el encabezado ya no queda con estado viejo tras atender por respaldo), CatalogoTab.tsx (3 vías honestas), stub (+cola FIFO __setUpdateData, compatibilidad total), suite test_eliminacion_honesta_global (+[10]/[11], 25 checks), migración scripts/migracion_revoke_fefo_rpc_1101.sql aplicada por Management API (ACL verificado: postgres+service_role; E2E anon → 401 permission denied)
- 8 (accesos): Supabase Management API (migración + verificación E2E), GitHub push, Cloudflare deploy, navegador E2E con cuenta admin
- 9 (módulos): Racks-Catálogo (CRUD honesto), Recepción (estado de guía), Atención (estado de registro), RQ/RAL (estado de encabezado en respaldo), BD (superficie anon cerrada) — Tránsito/Piso/Descarga verificados sin cambios necesarios
- QA final: tsc 0 · eslint 0 · 39/39 suites (honestidad 25 checks) · build OK

Stage Summary:
- Cierre de la CLASE ESPEJO: ninguna escritura visible al usuario (INSERT/UPDATE/DELETE) puede volver a reportar éxito sin efecto real — la app ya no celebra cambios que la BD filtró
- Superficie de ataque BD reducida: RPCs de mantenimiento FEFO ya no ejecutables por anon/authenticated (401 verificado)
- Higiene: código muerto eliminado; alta de catálogo existente ya no pisa stock_big_magic a 0
- Sin regresiones: 39/39 suites; E2E producción 6/6 módulos sin errores de consola

---
Task ID: 2
Agent: Main Agent
Task: Verificación de cierre 2026-11-01 — devoluciones de línea en producción (5d0b1c5) + QA completo del entorno reconstruido

Work Log:
- Sandbox reciclado: repo local quedó en shallow clone huérfano (0fde678 del 25-ago, pre-reinicio de historia) y SIN node_modules → fetch --unshallow + reset --hard origin/main (5d0b1c5 = producción) + npm install
- QA desde cero: 39/39 suites OK · tsc 0 errores · eslint 0 errores (misma salud que el deploy original)
- E2E producción (rackly.pages.dev, admin Miguel Hidalgo): pestañas «Recepción de guías» y «Devoluciones de línea» presentes; pestaña devoluciones lista separada («No hay devoluciones registradas…»), flujo foto «Con foto de RQ» (Tomar foto del RQ / galería) y vía manual con tipo por defecto «Requisición de devolución», Nº RQ, solicitante, OP, línea — sin placa; consola y page errors: 0
- version.json = 202610310051-5d0b1c5 (iteración Atención-identica desplegada y viva)

Stage Summary:
- La tarea trace 1a18f4a2b62c90cd queda VERIFICADA en producción sin regresiones; sin cambios de código en esta pasada (solo reconstrucción del entorno local)
- Sin errores pendientes: el mensaje del usuario llegó con el paso 9 vacío (sin contenido del error) — se ejecutó verificación de cierre de la última tarea activa

---
Task ID: 1
Agent: Main Agent
Task: Devoluciones de línea = RQ con la extracción de ATENCIÓN (trace 1a18f4a2b62c90cd · Módulos: recepción y transito) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo): el documento de devolución NO es una guía sino un RQ («REQUISICION DE DEVOLUCION DE MATERIAL DISPONIBLE», Nº 0000192967) — la iteración 1 (cd32f6e) lo parseó con el PARSER DE GUÍAS (guia-ocr + extensión esRequisicionDevolucion); el usuario lo corrige: la extracción debe ser IDÉNTICA a la de Atención, que procesa RQs con rq-ocr.ts. Producción verificada = cdb636f; BD ya con tipo_recepcion (CHECK ok, 2.633 filas, 0 devoluciones → cambio de flujo sin migrar datos)
- 2 (causa): el parser de Atención (rq-ocr.ts) ya leía el formato de la devolución (ancla B UNID→CANT con saldo/estado, calibrada con RQ 0000191740) — el error fue re-usar el parser de guías en vez del de RQ
- 3 (repetición): la extensión de devolución en guia-ocr.ts era código muerto tras el cambio → SE REVIERTE guia-ocr.ts a su estado pre-iteración-1 (86 líneas fuera, cero residuo); Atención quedó tocada solo por refactor (mismo pipeline extraído)
- 4/5 (decisión sin conflictos): pipeline OCR de RQ EXTRAÍDO a rq-ocr-runner.ts (2 pases + zoom tabla + zoom encabezado + rigor numérico) consumido por RqFotoForm (Atención) y DevolucionFotoForm (Recepción) — extracción única, sin duplicar 180 líneas; el guardado SIGUE siendo recepcion_registros (transito_registrar_envio, QR por fila, RLS y uuid_sync intactos); SIN migración de BD
- 6 (código): rq-ocr.ts RE_NUM_RQ reconoce «NUMERO REQUISICION : 0000192967»; devolucion-rq.ts (mapeo puro: numeroDocumento=Nº RQ · empresaOrigen=Solicitante · observaciones=OP · Línea · Solicita · Producto · placa=''); DevolucionFotoForm.tsx (flujo elegir→recortar→procesando→confirmar, autocompletado de catálogo igual que Atención, proveedor solo films, rótulos QR por fila + auto-estatus Recepcionado); RecepcionModule (pestaña devoluciones usa DevolucionFotoForm; vía manual con Nº del RQ/Solicitante/OP/Línea y SIN placa; contexto RQ a observaciones); GuiaFotoForm vuelve a ser SOLO guías + guard de permiso recepcion.crear (hueco detectado: la vía foto no lo tenía)
- 7 (QA): tsc 0 · eslint 0 · 39/39 suites · build OK — test_recepcion_devoluciones reescrita (42 checks: OCR del RQ real con el parser de Atención 13 checks, mapeo+alta 10, regresión de guías 4, delimitación/edición/badge 15)
- 8 (accesos): Supabase Management API (verificación de columnas/CHECK/contenido); GitHub + Cloudflare para deploy
- 9 (módulos): Recepción (pestaña devoluciones con extracción Atención + rótulos QR) · Tránsito (verificado, sin cambios — badge 'Devolución' ya operante) · Atención (solo refactor del pipeline, suites rq_* verdes)
- Deploy: commit → version.json; bundle productivo verificado

Stage Summary:
- La pestaña DEVOLUCIONES de línea ahora extrae datos EXACTAMENTE como Atención (mismo pipeline rq-ocr-runner + parser rq-ocr): Nº del RQ, OP, producto, línea, solicitante y tabla de materiales con cantidades de 4 decimales; el documento se registra como RECEPCIÓN (tipo_recepcion='devolucion') separada de guías, con rótulos y QR por fila para pegar en los artículos
- Limpieza de duplicados: guia-ocr.ts revertido (cero lógica de devolución en el parser de guías); un solo pipeline OCR de RQ compartido por Atención y Devoluciones
- Hallazgo colateral corregido: la vía foto de guías ya exige recepcion.crear (antes solo la BD lo bloqueaba al guardar)

---
---
Task ID: 8
Agent: Main Agent
Task: Devoluciones de línea en Recepción — pestaña propia + rótulos QR (trace 1a18f196e42d8cc1 · Módulos: recepción y transito) — 9 pasos

Work Log (1.1–9):
- 1.1 (hallazgo): el rótulo físico NO imprime el documento — la identidad vive en el QR (recepcionId = fila); zebra.ts/ImprimirRotulosDialog/qr-rotulo.ts funcionan para devoluciones SIN tocar el ZPL calibrado. transito.ts lee recepcion_registros COMPLETA (sin filtro de tipo) → las devoluciones entran a Tránsito de facto. DB: recepcion_registros 2.624 filas sin columna de tipo; 10 políticas RLS; RPCs transito_registrar_envio + recepcion_regularizar_fila operan por id/guia_id (tipo-agnósticas)
- 2 (causa): la función no existía; los 4 puntos de conflicto previstos eran C1 (editar devolución → filas nuevas nacían 'guia' por DEFAULT), C2 (anti-duplicados cruzaban pestañas), C3 (un solo listado mezclaba), C4 (Tránsito sin distinción visual)
- 3 (repetición): RLS/uuid_sync/QR/regularización ya son tipo-agnósticos (nada que duplicar); Actividad (Usuarios) etiquetaba todo como 'Recepción' → ahora distingue 'Devolución'; OCR de guía no conocía el formato requisición
- 4/5 (decisión sin conflictos): UNA tabla + tipo_recepcion ('guia' default | 'devolucion') con CHECK + índice idx_recepcion_tipo_fecha — transito_registrar_envio, QR por fila, RLS y idempotencia siguen operando SIN duplicar lógica (tabla nueva habría exigido RPC+RLS+parser duplicados); se corrigen C1–C4 ANTES de que existan
- 6 (código): migración 20261031_devoluciones_tipo_recepcion.sql (aplicada por Management API, 2.624 filas backfill 'guia'); modulos.ts (TIPO_RECEPCION, TIPOS_DOCUMENTO_DEVOLUCION, filtro/listado, crearRecepciones opciones, edición hereda tipo, Actividad); recepcion-idempotencia (anti-duplicado por pestaña); transito-core (tipoRecepcion + esDevolucion) + badge en Tránsito; RecepcionModule (pestañas guías/devoluciones con listados separados); GuiaFotoForm modo devolucion; guia-ocr reconoce la REQUISICIÓN DE DEVOLUCIÓN DE MATERIAL (formato real foto 2026-10-30: Nº 0000192967, empresa suelta, OP/solicitante → observaciones, tabla UNID→CANT con 4 decimales)
- 7 (QA): tsc 0 · eslint OK · 39/39 suites (nueva test_recepcion_devoluciones 28 checks: tipo en alta/lista/edición, delimitación de anti-duplicados, badge Tránsito, OCR requisición real + no-regresión de guía) · build OK
- 8 (accesos): SQL por Management API; verificación de columnas/constraint/índice/conteo en BD real
- 9 (módulos): Recepción (pestañas + formularios + impresión) · Tránsito (badge devolución) · Usuarios-Actividad (etiqueta)
- Deploy: commit cd32f6e → version.json 202610302353-cd32f6e OK; bundle productivo verificado (tipo_recepcion + 'Devoluciones de línea' en chunk 9f376494)

Stage Summary:
- Nueva capacidad: recepcionar DEVOLUCIONES DE LÍNEA en su propia pestaña (separada de guías) con la MISMA extracción de datos OCR, paletas, estados, Excel, edición y rótulos con QR único por fila para pegar a los artículos de devolución; el escaneo en Tránsito resuelve la fila exacta y la transferencia a Rack/Piso funciona igual (badge 'Devolución' visible)
- El formato físico real (Requisición de devolución AJEPER) se autodetecta: nº de requisición, empresa, orden de producción y solicitante se precargan; la pestaña usa 'Requisición de devolución' como tipo de documento por defecto
- Sin regresiones: 39 suites verdes; guías legacy intactas (default 'guia'); Tránsito/RQ/Racks sin cambios de comportamiento
---

---
Task ID: 1
Agent: Main Agent
Task: Regularización de filas sobrantes sin envíos (T173-00004274 · guía T173-00004274 · 53414 DIVERFLOW 156) — 9 pasos

Work Log (1.1–9):
- 1.1/1.2 (DB real): guía T173-00004274 tenía 6 filas del 53414 = 172 UN registradas vs 150 reales; sobrante fantasma = fila d6d01142 (22 UN, Paleta 2, lote 20930276, 0 envíos — exactamente la fila de la captura "Sin transferir"); 118 ya transferidos a piso; pendiente aparente 54 (22 fantasma + 32 reales)
- 2 (causa): el guard "ajenas" de guardarEdicionGuia era CIEGO AL ROL — bloqueaba quitar filas de otro usuario INCLUSO a admin/supervisor con recepcion.eliminar, aunque las políticas RLS SÍ lo permiten (recepcion_delete_auth + recepcion_registros_delete_permiso bajo recepcion_delete_restr = tiene_permiso). Guard más estricto que la BD = guía imposible de corregir. Además Tránsito solo añade envíos: una fila flotante sin envíos no tenía NINGÚN camino de salida
- 3 (repetición): patrón único en modulos.ts; otros ERR_ELIMINAR_BLOQUEADO son verificaciones honestas de DELETE (correctas, intactas); eliminarGuia con envíos sigue bloqueado (política correcta)
- 4/5 (decisión sin conflictos): reutilizar la MISMA función tiene_permiso que usa la RLS (cero deriva) + RPC SECURITY DEFINER con advisory lock (mismo salt 7771 que transito_registrar_envio → serializa con envíos concurrentes) + SOLO filas 0 envíos (con envíos = stock ya en Racks/Piso, no se toca)
- 6 (código): migración 20261031_regularizacion_fila.sql (RPC recepcion_regularizar_fila: guard permiso + lock + DELETE honesto con RETURNING + snapshot de auditoría); modulos.ts guard consulta tiene_permiso vía RPC (fail-safe: si la consulta falla, bloquea); transito-core.regularizable() puro; transito.regularizarFila(); Tránsito muestra acción "Regularizar" junto a Historial (solo con recepcion.eliminar y fila 100% sin transferir) con DialogoRegularizar (confirmación + motivo → snapshot)
- 7 (QA): tsc 0 errores · eslint OK · 38/38 suites (nueva test_regularizacion 16 checks; [3b]/[3c] en test_recepcion_delete_honesto; stub rpc enlatado por nombre) · build OK
- 8 (accesos): SQL aplicado por Management API; smoke: service_role → "PERMISO|…" OK; E2E admin (cuenta proporcionada) → pasa PERMISO, llega a la fila ("RECEPCION_NO_EXISTE" con id falso) OK
- 9 (módulos): Recepción (modulos.ts) · Tránsito (UI + RPC) · Suite global de tests
- REGULARIZACIÓN EJECUTADA en producción (admin): fila d6d01142 eliminada con snapshot completo (owner Elvis R. Valdivia, motivo documentado) → guía 172→150 OK, transferido 118, pendiente real 32 OK
- Deploy: commit 866d14a → Cloudflare Pages → version.json 202610302139-866d14a OK

Stage Summary:
- Nueva capacidad: regularizar el sobrante de una guía DIRECTAMENTE desde Tránsito (puente Tránsito→Recepción) o desde el editor de Recepción (ahora permitido a quien tenga recepcion.eliminar)
- Sin regresiones: los 4 guards previos intactos (filas con envíos siguen intocables; sin permiso sigue bloqueado; DELETE honesto sigue verificando el efecto real)
- Caso T173-00004274 CERRADO: la guía quedó en 150, el pendiente de Tránsito es el stock real (32) y la fila flotante de la captura ya no existe
---

---
Task ID: 2
Agent: Main Agent
Task: Eliminar modo offline del aplicativo Rackly

Work Log:
- Eliminados 4 archivos: sync-engine.ts, offline-db.ts, useConnectivity.ts, ConnectionIndicator.tsx
- Refactorizado OcupacionTab.tsx: 6 cambios (removido import SyncEngine, 5 funciones offlineAware -> addMovimiento/trasladarMovimiento directo)
- Refactorizado TrasladoTab.tsx: 3 cambios (removido import, 2 funciones offlineAware -> directo)
- Refactorizado MovimientoForm.tsx: 12 cambios (removido import, doInsert, handleSalidaDesdeAlerta, 2x mass salida, 2x getCachedMovimientosForStock fallback, 2x doSalida, doIngresoINC)
- page.tsx: removido import y <ConnectionIndicator /> del header
- catalogo.ts: removido import de offline-db, cacheCatalogo, y loadCatalogoFromIndexedDB
- Verificado: 0 referencias a SyncEngine/offlineAware/useConnectivity/ConnectionIndicator/offline-db en src/
- Compilacion exitosa: next build sin errores
- Deploy exitoso: push a main completado

Stage Summary:
- ~800 lineas de codigo eliminadas
- 4 archivos eliminados completamente
- 23 cambios en 5 archivos modificados
- Resuelve 9 hallazgos de auditoria: C10, H8, H10, H11, M10, M11, M14, M15, M16
- Deploy URL: rackly.pages.dev
- Commit: 151ad83

---
Task ID: M+LOW batch 2
Agent: Sub Agent
Task: Fix M.6 (any casts) and A.4 (busy guard) in PisoSectoresTab.tsx

Work Log:
- M.6: Replaced 5 `(x: any)` casts with proper typed parameters:
  - Line 295: `(d: any)` → `(d: { movimiento_id: string })`
  - Line 318: `(d: any)` → `(d: { bloque_id: string })`
  - Line 324: `(b: any)` → `(b: { id: string; codigo: string; descripcion: string; unidad: string })`
  - Line 325: `(m: any)` → `(m: { id: string; tipo: string; turno: string | null; fecha: string; usuario_nombre: string | null; codigo_inc: string | null })`
  - Line 329: `(d: any)` → `(d: { movimiento_id: string })`
- A.4: Existing `busy` state (line 153) was already used for button disable and setBusy(true)/finally{setBusy(false)} in handlers, but missing the early-return guard. Added `if (busy) return` as first line in 6 entry-point functions:
  - doIngresoINC, doIngreso, doSalida, doTraslado, ejecutarTrasladoPiso, doDevolucion
  - All handlers already had setBusy(true)/finally{setBusy(false)} wrapping — only the debounce guard was missing.

Stage Summary:
- 5 type-safety fixes (M.6) — removes `any` from historical loading logic
- 6 debounce guard additions (A.4) — prevents duplicate API calls on double-click
- File modified: src/components/rackly/piso/PisoSectoresTab.tsx only

---
Task ID: M+LOW batch 1
Agent: Sub Agent
Task: Fix M.4, M.5, M.7, M.8, M.9, M.10, B.5 — medium/low severity batch

Work Log:
- M.4 (OcupacionTab.tsx): Added `detailLoading` state, wrapped `handleCellClick` async call with setDetailLoading(true)/finally(false), added Loader2 spinner overlay in the detail view panel (guarded by `!detailLoading &&` for the stock list to avoid showing empty state while loading).
- M.5 (OcupacionTab.tsx): Replaced `(r: any)` with `(r: Record<string, unknown>)` in the historial mapping function.
- M.8 (ErrorBoundary.tsx): Replaced raw `{this.state.error.message}` display with a sanitized user-facing message ("Ha ocurrido un error inesperado. Por favor recarga la página."). Used optional chaining `this.state.error?.message` for null safety.
- M.7 (constants.ts): Changed `QUERY_TIMEOUT_MS` from 8000 to 15000 (15 seconds) with an explanatory comment about tolerating slow connections and complex queries.
- B.5 (auth.ts): Changed `console.log` to `console.warn` and removed the `userId` argument from the email auto-confirm success log.
- M.10 (piso/api.ts): Removed 6 debug `console.log` statements:
  - RPC sample row debug block (rpcData.length > 0 check + detailed sample logging)
  - RPC count summary log
  - piso_bloques items loaded log
  - catalogo (respaldo) merge log
  - "Bloque encontrado en piso_bloques" log
  - "Bloque encontrado en catalogo" log
- M.9 (auth.ts): Changed `console.log` to `console.warn` for the auto-confirm retry attempt log.

Stage Summary:
- 7 fixes across 5 files: OcupacionTab.tsx, ErrorBoundary.tsx, constants.ts, auth.ts, piso/api.ts
- TypeScript compilation passes with zero errors
- No behavioral changes beyond the loading indicator addition (M.4) and the timeout value change (M.7)
---
Task ID: 3
Agent: Main Agent
Task: Decouple Kardex Racks/Piso + fix Stock vs Ocupacion discrepancy

Work Log:
- Analyzed all cross-dependencies between Kardex Racks and Kardex Piso
- Found 2 cross-sections: PisoStockTab→buscarStockRacksPorCodigo and StockTab→CrossSectionPiso(stockPisoPorCodigo)
- Confirmed both are read-only informational, no functional impact if removed
- Identified root cause of Stock vs Ocupacion discrepancy: StockTab includes INC movements in base calculation, OcupacionTab excludes them
- Removed CrossSectionPiso component and all related state/imports from StockTab.tsx
- Removed buscarStockRacksPorCodigo call, all Racks cross-lookup state/imports from PisoStockTab.tsx
- Fixed StockTab stockData useMemo: exclude INC movements from base calc (consistent with OcupacionTab)
- Removed codigoInc from stock key (no longer partitions stock by INC status)
- TypeScript check: 0 errors
- Next.js build: successful (static export)
- Pushed to GitHub (main branch)

Stage Summary:
- Kardex Racks and Kardex Piso are now fully decoupled, sharing only catalogo table
- Stock tab now matches Ocupacion tab numbers for non-INC items
- INC items only show when filter is set to "Solo INC"
- Deploy pending via Cloudflare Pages auto-deploy from GitHub
---
---
Task ID: 1
Agent: main
Task: Fix Stock vs Ocupación discrepancy (4th attempt - final fix)

Work Log:
- Read StockTab.tsx and OcupacionTab.tsx full files to compare calculations line-by-line
- Confirmed both use fetchMovimientos() via dataClient (same data source)
- Confirmed both exclude INC movements and use identical delta formula
- Identified that StockTab was splitting stock by FEFO lots (multiple rows per position), which could cause user confusion when comparing with OcupacionTab (one row per position)
- Rewrote stockData calculation in StockTab to use IDENTICAL logic to calcularOcupacion(): groups by (position, code), excludes INC, calculates net delta, ignores vencimiento for stock total
- FEFO info (vencimiento dates) now shown as informational field only - one row per position, with tooltip showing all lots
- Updated Mobile card and Desktop table UI to show lot count badge and tooltip
- Updated delete handler to clear all stock in position (not just one lot)
- Build successful, pushed to main for Cloudflare Pages deployment

Stage Summary:
- Root cause: StockTab's FEFO visual split created multiple rows per position, and the distribution algorithm could differ from OcupacionTab's aggregate view
- Solution: Replaced FEFO split with aggregate-per-position approach matching OcupacionTab exactly. FEFO dates now informational only.
- Key change: stockData now calculates net stock by (position, code) identically to calcularOcupacion, then filters by selected code
- Deployed via git push to main (Cloudflare Pages auto-build)
---
Task ID: 2
Agent: main
Task: Implement server-side stock calculation without 15K row limit

Work Log:
- Added fetchOcupacionServerSide() in kardex.ts — queries movimientos with only needed columns, excludes INC, groups by (position, code) client-side from smaller dataset
- Added fetchStockPorCodigoServerSide(codigo, soloInc) — queries movimientos filtered by specific code, groups by position, tracks FEFO dates
- Both functions return null on failure to signal caller to use fallback
- Updated StockTab: added useEffect that calls fetchStockPorCodigoServerSide when selectedCodigo changes, falls back to client-side stockData if server-side fails. Uses displayStock = serverStock ?? stock for rendering
- Updated OcupacionTab: inverted refreshData order — now tries server-side first, falls back to fetchMovimientos+calcularOcupacion (15K limit), then to RPC legacy
- Build successful, pushed to main

Stage Summary:
- Both tabs now have 3-tier fallback: server-side (no limit) → client-side (15K limit) → RPC legacy
- No existing functionality broken — all changes are additive with graceful fallback
- StockTab calculates server-side per-code (efficient: only downloads that code's movements)
- OcupacionTab calculates server-side for all positions (downloads all movements but with fewer columns)
---
Task ID: 719-negativos-validacion
Agent: Main Agent
Task: Revisar los 719 negativos — validación, prevención y reparación completa

Work Log:
- Diagnóstico REST + Postgres (Management API): 88 celdas negativas por lote (antes 740), 34 activas en 7 días
- Causa raíz confirmada: RPCs v3 (auto-lote FEFO) NUNCA se desplegaron en Supabase; 56% de salidas seguían naciendo sin lote
- Deploy v4 (rackly_lote_v4_auto_salida.sql) vía Management API: RPCs con auto-lote FEFO activas
- Backfill FASE 1-2 (rackly_backfill_lote_v2.sql): re-atribución FEFO + división por cuotas → 88→33
- FASE 3 rebalanceo (rackly_rebalance_lotes.sql): re-atribución ENTRE lotes (32 lotes físicos negativos en celdas positivas) → 33→1
- Descubierta brecha residual en v4: fallback "mayor saldo" podía fabricar negativo por lote con superávit sin-lote presente
- Deploy v5 (rackly_lote_v5_auto_salida.sql): regla intermedia (bucket sin-lote absorbe antes de forzar lote físico)
- Tests funcionales con ROLLBACK: 3 ramas de v5 verificadas (cubriente FEFO / NULL por superávit sl / mayor saldo)
- Estado final: 1 única celda negativa = déficit REAL 57630 @ 1/1/2/12 (-221,202) — requiere decisión de negocio
- Piso verificado con semántica de piso_stock_sector_grid: 0 negativos reales
- 57630 tiene +242,200 en 2/1/4/6 → probable traslado no registrado (recomendado al usuario)

Stage Summary:
- Negativos por atribución: 100% reparados (740/88 → 0)
- Prevención v5 activa en producción (misma firma, GRANTs intactos, sin cambios en app)
- Scripts persistidos: download/rackly_backfill_lote_v2.sql, download/rackly_rebalance_lotes.sql, download/rackly_lote_v5_auto_salida.sql

---
## 2026-10-19 · Auditoría proactiva: cierre del cauce de negativos por lote (v6)
- Hallazgo: tras el fix 719 (5c7c165), nacieron 11 artefactos de atribución nuevos (17-19 oct)
  por salidas CON lote que no cubría (typo/agotado): la RPC v5 solo reasignaba cuando la
  salida llegaba SIN lote. Caso claro: SO00432338 vs SO000432338 (typo).
- Fix RPC v6 (supabase/migrations/20261019_salida_lote_validacion_v6.sql): si el lote
  digitado no cubre, cae al pipeline v4/v5 (FEFO cubierta -> sin-lote -> mayor saldo).
  Validada en producción con 4 casos en transacción con ROLLBACK (A reasigna, B respeta,
  C rechaza INSUFFICIENT_STOCK, D absorbe sin-lote). INC y idempotencia intactos.
- Rebalanceo de los 11 artefactos: UPDATE/split FEFO por celda, respaldo previo en
  download/backup_negativos_19oct.json. Resultado: 0 artefactos; solo queda el déficit
  real 57630 @ 1/1/2/12 (-221,202, decisión de negocio ya documentada).
- Scripts: scripts/{auditoria_bd,clasifica_negativos,rebalanceo_lotes,traza_negativos}.py

---
## 2026-10-28 · Registrar RAL (Atención) — verificación E2E del autollenado + UND pegada
- Verificación integral del fix 1206e64 (pantalla ERP sin dos puntos): parser auditado
  línea por línea; 59 checks de test_ral_ocr en verde; entorno reconstruido
  (npm install — 28 suites afectadas por node_modules vacío, ya sanado).
- DB en producción verificada: rals/ral_items + RPC ral_crear_completa (atómica,
  idempotente) + RLS espejo de rq_* (DELETE solo admin/supervisores). Tabla rals
  vacía: el usuario reportó desde la pantalla de confirmación, nunca llegó a guardar.
- E2E real de la RPC vía Management API (scripts/test_ral_rpc_e2e.py, 16 checks):
  cada campo en SU columna (area_solicitante ≠ solicitante), item completo
  (código/desc/und/centro/cantidad), idempotencia ante reintento, limpieza total.
- Robustez ante NUEVA foto: suite test_ral_ocr_ruido (26 checks) con variantes
  adversarias del ERP (espacios dobles, gluing, decimales perdidos, encabezado
  partido, fusión de pases). Halló 1 gap residual: UND pegada a la última palabra
  del artículo ("SAL INDUSTRIALKG") quedaba vacía.
- Fix 782bf0e: helper unidadPegada() en ral-ocr.ts — separa sufijo unidad (≥2
  letras) si el prefijo conserva ≥3; aplicado en búsqueda derecha (d) y segunda
  pasada (d2). rq-ocr NO tocado (formato distinto, rigor 26/26 intacto).
- Deploy: GitHub Actions success → rackly.pages.dev v=202610281955-782bf0e.
- Remote git tenía token viejo (ghp_CqrC…AJ7N, rechazado en push): actualizado al
  PAT vigente. Reconstruido scripts/sb_config.py (Management API, ref
  owjryvcrhpmgtkkdcrkm) — el entorno reset lo había borrado.
- 29/29 suites · tsc OK · eslint OK · build OK.

---
## 2026-10-29 · Auditoría integral módulo por módulo — 6 defectos cerrados
- 1.1 Batería: 29/29 suites · tsc OK · eslint src/ 0/0 · build OK.
- 1.2 BD (scripts/auditoria_integral_db.py, nuevo): RLS 20/20 tablas ON con políticas;
  DELETEs sensibles restringidos por rol; 44 RPCs, cross-check de los 25 rpc() que la
  app llama → todos existen; 0 huérfanos RQ/RAL; 0 stock negativo; realtime OK (rals
  incluida). Dato a corregir en captura: 50891 (Base bebida) venc=2017-04-09 typo.
- 1.3 Módulos: QR (resolverToma legado estricto + fila exacta), FefoTab (cálculo FEFO),
  tab-state, RqSalidaConfirmador, TransitoModule = limpios. 6 hallazgos verificados:
  · MEDIO realtime: headSnapshot avanzado antes del refetch → cambio congelado si
    fallaba; ahora avanza solo en éxito (reintento por tic).
  · MEDIO salida masiva INC: type=number + badInput es-PE → '' → 'vacío=todo'
    registraba el STOCK COMPLETO en vez del parcial; espejo P2 (text+inputMode).
  · parseFloat('1,5')=1 en salida parcial INC y resumen → aNumero.
  · salidaBusy colisión normal/INC → clave codigo|codigoInc|venc|lote (espejo P3).
  · piso MovimientosTab sin guard generacional → espejo TransitoModule.
  · TrasladoTab click sin feedback si origen drenado + badge 'en 0' falsa por lote.
- Fix 611f75a desplegado → rackly.pages.dev. Scripts: auditoria_integral_db.py.

---
## 2026-10-29 · Atención: búsqueda RQ/RAL por código de MATERIAL (items)
- 1.1/1.2 Reporte: buscar por código de producto o RQ no devolvía datos
  (captura: "118" + fecha hoy + T1 → 0 filas). Reproducido E2E con JWT real
  (scripts/test_rq_busqueda_e2e.py): la API respondía bien con códigos del
  ENCABEZADO (424689, 192811) — pero "118" no existe en ningún campo del
  encabezado: es el código de ÁCIDO CÍTRICO en rq_atencion_items.
- 2 Causa raíz: listarRqs buscaba solo en 5 columnas del encabezado
  (numero_rq/orden_produccion/producto_codigo/producto_descripcion/solicitante);
  los MATERIALES pedidos viven en rq_atencion_items y no participaban.
  Evidencia: RQ 0000192737 (hoy, T1) pide material 118 — debía salir y no salía.
- 3 Mismo defecto detectado en la pestaña RAL (RalLista filtra solo
  encabezado). Barrido sin más casos: Kardex (eq codigo), Piso (codigo+
  descripcion), Recepción (modulos.ts), Tickets y Tránsito buscan columnas
  directas — limpios.
- 4 Vías evaluadas contra producción PostgREST (test_rq_busqueda_embed.py):
  or embebido → PGRST100; filtro embebido sin select → PGRST108;
  referencedTable .or() → AND (semántica equivocada). ELEGIDO: prelookup de
  rq_id en items + id.in.(…) DENTRO del mismo or() del encabezado — validado
  HTTP 200 y devuelve la RQ esperada (test_rq_busqueda_planC.py).
- 5 Sin conflictos: firmas sin cambios (llamadores únicos RqAtencionPanel/
  RalLista); paginación/total/orden intactos; degradación a búsqueda de
  encabezado si el prelookup falla (nunca peor); RLS SELECT de items = true
  autenticados; realtime/Task 35 (fecha+turno) sin tocar.
- 6/7 Implementación: busqueda-rq.ts (nuevo, puro: construirOrBusquedaRq +
  MAX_IDS_MATERIALES=200 con higiene uuid); rq-atencion.ts
  (buscarIdsPorMateriales capado + integración + sanitización unificada con
  terminoBusquedaSeguro de formato.ts, antes duplicada); ral.ts adjunta
  textoItems en listarRals; RalLista/RqAtencionPanel incluyen material y
  placeholders actualizados.
- Tests: scripts/test_rq_busqueda_or.js (33 checks, stub con captura aditiva
  __orCalls) → 30/30 suites · tsc OK · eslint OK · build OK.
- Deploy d15d909 → rackly.pages.dev v=202610291443-d15d909; E2E del escenario
  del usuario en producción devuelve la RQ 0000192737.
- Nota: remote git tenía de nuevo el PAT viejo (ghp_CqrC…) tras el reset del
  entorno; actualizado al vigente. sb_config.py reconstruido (2ª vez).

---
## 2026-10-29 · Atención: reporte de atención a líneas — Excel (5 hojas) + Dashboard
- Solicitud: descargar la información de TODOS los RQ para el reporte de
  atención a líneas, resumen por artículo en otra hoja y dashboard para
  presentar. Desplegado 49abc6c → rackly.pages.dev v=202610291506-49abc6c.
- Modelo de datos verificado en producción: rq_atenciones (18 cols) ·
  rq_atencion_items (pedido/atendido/atendido_en) · ledger rq_atencion_tomas
  (Task 27: 131 filas, origen racks/piso/transito/manual/reversa) — el ledger
  NO guarda f_vencimiento; el vencimiento es intrínseco al lote y se RESUELVE
  desde movimientos (codigo+lote → mayor f_vencimiento; patrón paginado
  .in('lote', lotes), 1000/batch, tope 20 batches).
- atencion-reporte.ts: cargarReporteAtencion() (1 tirada, Promise.all) +
  agregaciones puras: kpisAtencion · resumenPorArticulo (88 códigos reales,
  sobreatención no penaliza pendiente) · serieRqsPorDia · serieRqsPorLinea ·
  topArticulosAtendidos.
- atencion-excel.ts (patrón guia-excel, xlsx-js-style): 5 hojas — RQs ·
  Materiales (pedido vs atendido + estado Completo/Parcial/Pendiente) ·
  Salidas (tomas) con ubicación/lote/F. VENCIMIENTO/saldo/usuario ·
  Resumen artículo · Dashboard (KPIs + por día + por línea + top).
- RqDashboard.tsx: vista presentable (gráficos CSS, sin deps nuevas) +
  Exportar Excel; RqAtencionPanel: botón Dashboard.
- QA: test_atencion_reporte.js 40 checks (stub con captura __orCalls
  intacta) → 31/31 suites · tsc OK · eslint OK · build OK.
- E2E producción (test_reporte_atencion_e2e.py): 67 RQs · 210 items ·
  131 tomas (129 salidas/2 reversas) · 156/210 materiales completados ·
  lotes legados 'BACKFILL-27' sin vencimiento degradan a columna vacía
  (limitación de dato, no bug; lotes reales p.ej. 1810-26 sí resuelven).
## 2026-10-30 · Atención: RAL unificado con RQ — una sola lista y mismo modelo de atención
- 1.1/1.2 Reporte: «la atención de RAL debe ser el mismo modelo que la de RQ
  y todo debe aparecer en UNA sola lista — quizás con una distinción que diga
  RAL — para filtrar y buscar más rápido». Hallazgo en BD: rals SIN columna
  estado y ral_items SIN cantidad_atendida/usuario_atencion/atendido_en — el
  RAL era un documento de solo lectura (ver/eliminar), imposible de atender.
- 2 Causa: Task 36 diseñó el RAL como registro de documentos con aislamiento
  total, sin espejar el modelo de atención de la RQ (estado canónico v9 +
  items atendibles + RPC atómica).
- 3 Sin repetición: rals/ral_items solo los toca el módulo Atención (ral.ts,
  RalLista, panel). Dashboard/Excel (atencion-reporte.ts) leen SOLO rq_* —
  intactos. Volumen en producción al migrar: 0 filas (riesgo ≈ 0).
- 4 Vía elegida: espejo EXACTO del patrón RQ probado. Migración aditiva
  (supabase/migrations/20261030_ral_modelo_atencion.sql): rals.estado,
  ral_items.cantidad_atendida/usuario_atencion/atendido_en, índice
  idx_ral_items_ral_id, RPCs ral_atender_item/ral_revertir_item (guard de
  rol, incremento/decremento atómico, sobreatención permitida, regla
  canónica de estado), RLS UPDATE en rals.
- 5 CONFLICTO EVITADO (hallado por E2E 19/19 en producción con JWT real,
  scripts/test_ral_atencion_e2e.py): crear la política solo con
  `with check(true)` deja qual=NULL y el UPDATE afecta 0 FILAS en silencio
  (el estado nunca cambiaba). rq_update_auth tiene using(true) EXPLÍCITO —
  rals_update_auth replicada tal cual. ral_crear_completa no se toca
  (defaults aplican: Pendiente / 0).
- 6/7 Implementación: atencion-unificada.ts NUEVO (puro: FilaUnificada,
  textoBusquedaRal, coincideFiltroRal, conteosEstado, unirFilasAtencion —
  fecha DESC + created_at de desempate; turno excluye RAL: no tiene);
  ral.ts +atenderItemRal/revertirItemRal (RPC-first + respaldo optimista con
  guard por igualdad, espejo rq-atencion.ts) + estado mapeado con default
  Pendiente + listarRals limit 300; RqAtencionPanel: lista unificada
  (tabla FilaRqTabla/FilaRalTabla + tarjetas móviles) con badge violeta
  "RAL", realtime 'rals' adicional, eliminación RAL integrada, vista
  'detalle-ral'; RalDetalle NUEVO (ATENDIDO/PENDIENTE/ATENDER + confirmación
  + excedente + reversa + progreso — sin ubicaciones/QR/lotes: el RAL no
  tiene modelo lote/posición); RalLista.tsx eliminada (absorbida).
- Tests: scripts/test_ral_unificado.js (31 checks: unión/orden/filtros/
  conteos + RPC-first + respaldos + recálculo); stub +__updateCalls/
  __setUpdateResult/pendingUpdate (aditivo, no rompe suites previos).
  32/32 suites · tsc OK · eslint OK · build OK.
- Deploy a4142d3 → rackly.pages.dev v=202610291658-a4142d3. Post-deploy:
  listarRals con estado 200, RPCs en schema cache (error de negocio, no 404),
  ral_items expone columnas de atención.

## 2026-10-30 · Tránsito/Racks: fin del «[object Object]» + ingreso por QR en Racks > Ocupaciones
- 1.1/1.2 Reporte (screenshot 16:54, usuario Elmer): al escanear un QR en
  Tránsito, el diálogo «Transferir artículo» muestra «[object Object]» en el
  artículo 37934 — 81000 UN. Evidencia en BD: fila 8c16a5ab
  (recepcion_registros, 37934 · 81000 UN · vencimiento **3027-07-31**, typo
  del proveedor) SIN envío de tránsito; movimientos con ingreso manual
  16:55:49 B3·T1·P4·Pos1 (Elmer, uuid_sync NULL, no pasó por la RPC).
- 2 Causa (doble): (a) CLIENTE — postgrest-js devuelve el error como OBJETO
  PLANO {message,details,hint,code} (no `Error`); mensajeRpcError hacía
  `err instanceof Error ? err.message : String(err)` → «[object Object]»;
  (b) BD — el guard v8 de transito_registrar_envio era CÓDIGO MUERTO:
  `v_venc := v_row.fecha_vencimiento` estaba DESPUÉS del check de año
  absurdo (corría sobre NULL), así que el venc 3027 llegó crudo a
  registrar_movimiento_kardex → FECHA_INVALIDA. El error real quedó
  enmascarado por (a).
- 3 Repetición: el patrón ingenuo estaba en 3 sitios (auth.ts, transito-core,
  LectorQR) y la variante «Error desconocido»/'Error' en ~45 más (31 archivos:
  Atención, Recepción, Kardex, Piso, Usuarios, page.tsx) — mismo defecto de
  clase: errores PostgrestError planos perdían el mensaje.
- 4 Vía: extractor CANÓNICO src/lib/rackly/errores.ts — mensajeError()
  (Error, PostgrestError plano, string, {error|msg|detalle}, prefijo
  «CODE|» de las RPCs → solo el detalle, fallback JSON — jamás
  [object Object]). mensajeRpcError y extractError delegan (contrato
  intacto, incl. Error('INSUFFICIENT_STOCK') con .detail); codemod
  (scripts/codemod_errores.js + fix_imports_errores.js) reemplazó las
  variantes en todos los módulos.
- 5 Sin conflictos: todos los branching de códigos (isInsufficientStockError,
  isLoteUnsupportedError, fallbacks RPC 42883/PGRST202) operan sobre el error
  CRUDO, no sobre la salida del extractor — intactos. QA: 34/34 suites ·
  tsc 0 · eslint 0 · build OK. Tests nuevos: test_errores (21) +
  test_ingreso_qr (14).
- 6/7 BD (Management API, scripts/fix_rpc_venc_guard.py): guard v8 reparado
  (asignación ANTES del check) — verificado con transacción ROLLBACK en
  producción: fila venc 0027-09-04 ahora viaja «sin fecha» (ok, PARCIAL) y el
  anti-sobreenvío sigue rechazando (OVER_ISSUE). Corrección de datos
  (scripts/sincronizar_fila_fantasma.py): el envío del ingreso REAL de Elmer
  quedó documentado en recepcion_registros.transito con trazabilidad 1:1 al
  movimiento (uuid = mov 036c2dd2) — fila pasó de ROJO/pendiente fantasma a
  VERDE sin tocar stock (el ingreso físico ya existía).
- FEATURE (pedido del usuario): ingreso por QR en Racks > Ocupaciones.
  lib pura ingreso-qr.ts (rotuloDesdeFila/prefillDesdeRotulo/
  validarCantidadRotulo/etiquetaPosicionRack); OcupacionTab: botón
  «Escanear rótulo (QR)» + chip del rótulo + LectorQR compartido (cámara +
  pistola USB); prefill de código/descripción/UN/cantidad(pendiente)/lote/
  vencimiento/proveedor. registrarIngresoRackDesdeRotulo (transito.ts) usa la
  RPC ATÓMICA transito_registrar_envio: ingreso en la posición + marca en
  Tránsito en UNA transacción — elimina la clase «palet fantasma» del
  incidente (doble registro); uuid estable por fila (idempotencia entre
  reintentos); rótulos ya transferidos van por la vía genérica con aviso.
- Deploy 4845c4b → rackly.pages.dev v=202610301352-4845c4b. E2E REST con
  JWT real: el error llega {code:"P0001", message:"OVER_ISSUE|La cantidad a
  transferir (1) excede el pendiente de 37934 (0): excedente 1"} — la UI ahora
  lo muestra completo.

---

## 2026-10-30 · Auditoría integral de la app — 23 defectos cerrados en TODOS los módulos
- 1.1 Detección (pedido: «hay errores en la app, bugs, duplicados… estructura
  de datos eficiente y segura, DB funcionando correctamente — módulos: todos»):
  (a) QA estático: tsc 0 · eslint 0 · 34/34 suites · build OK;
  (b) auditoría DB completa con Management API (audit_db.py): RLS activa en
  20/20 tablas, ninguna policy sin qual, ninguna tabla pública, 12 FKs con
  reglas correctas, 60+ índices; duplicados de datos analizados caso a caso;
  (c) 3 revisores en paralelo (Recepción · Kardex+Piso · Tránsito+QR con
  catálogo completo de errores del camino de escaneo) + revisión directa de
  Atención (unificada) y auth.ts.
- 2 Causas raíz consolidadas (8 P2 + 15 P3), entre ellas: convención de error
  «CODE|texto» que moría dentro de mensajeError (branching AFTER extractor —
  código muerto); idempotencia M-1 ausente en la EDICIÓN de guías; auto-confirm
  de login doblemente roto (id vacío + Edge Function con sesión admin que no
  existe durante el login); parseFloat truncando decimales con coma en 8
  sitios de OcupacionTab; payload QR sin sanear ^ ~ \; sin guard de numero_rq
  duplicado (caso real 2026008365 ×2 a 16 min — confirmado en BD);
  piso_registrar_movimiento aceptando _detalles vacíos (cabecera fantasma);
  búsqueda unificada RAL-viva vs RQ-al-pulsar (lista mixta incoherente).
- 3 Repetición verificada por hallazgo: parseFloat→aNumero estaba corregido en
  DialogoTransferir pero replicado en NINGÚN otro sitio de OcupacionTab (8
  sitios); guard NaN de FEFO existía en FefoTab y no en FefoPisoTab; ilike con
  comodines en 2 capas (transito.ts + rq-atencion.ts); el patrón «CODE|» en
  3 throws × 2 catches (RecepcionModule + GuiaFotoForm).
- 4 Vía más efectiva: fixes quirúrgicos por bloque (A lib compartida ·
  B Recepción · C Kardex/Piso/Auth · D Tránsito/QR · E Atención · F SQL),
  errors.ts como única fuente de códigos controlados (Error.name), migración
  SQL única para los 5 cambios de BD.
- 5 Sin conflictos: contrato de mensajeError intacto (los códigos viajan en
  .name, no en message); los branches existentes de RPC (OVER_ISSUE,
  INSUFFICIENT_STOCK…) operan sobre el error crudo; tolerancia legada de
  grupos huérfanos de paletas PRESERVADA (2/3,3/3 sigue uniendo — test que
  lo cubre); 34/34 suites · tsc 0 · eslint 0 · build OK.
- 6/7 Implementación experta y ordenada (26 archivos, +938/−91): errores.ts
  (errorControlado/codigoControladoDe/ERR_*), modulos.ts, recepcion-filas.ts,
  RecortarImagenDialog, RecepcionModule, GuiaFotoForm, auth.ts, PisoSectoresTab,
  FefoPisoTab, FechaVencimientoField, DescargaTab, OcupacionTab, LectorQR,
  transito.ts, rq-atencion.ts (buscarRqPorNumero), zebra.ts, qr-rotulo.ts,
  RqAtencionPanel, RqFotoForm, RqEditarDialog.
- 8 Accesos usados: GitHub PAT (push bd34f5e), Supabase Management API
  (migración + verificaciones), JWT de app (RPC E2E), Cloudflare Pages (deploy
  automático), anon key (prueba de bloqueo de escritura anónima).
- 9 Todos los módulos: Recepción, Racks/Ocupaciones (Kardex), Piso, Tránsito,
  Atención (RQ+RAL unificados), Auth, Etiquetas/ZPL, Usuarios. Falsos
  positivos descartados con evidencia: 5 pares de movimientos <3 s (salidas
  partidas con cantidades distintas — legítimas) y logs «odulos]» (artefacto
  del pipeline de render — el fuente siempre tuvo «[modulos]»; NO hubo cambio).
- BD (20261030_auditoria_integral.sql, aplicada + verificada): revoke
  insert/update/delete a anon (prueba en vivo: 401/42501) · search_path de
  piso_auto_estructura_sector · confirmar_correo_en_auth (bcrypt; E2E
  correcta→true/incorrecta→false/inexistente→false) · DETALLES_REQUERIDOS en
  piso_registrar_movimiento · EPS 0.0005 en el anti-sobreenvío de
  transito_registrar_envio.
- Tests: +22 checks (R3/R5 en filas, Z1/Z2 en zebra, errores controlados,
  23505 amigable) → 34/34 suites.
- Deploy bd34f5e → rackly.pages.dev v=202610301512-bd34f5e (verificado).

---

## 2026-10-30 · Recepción: fin de la duplicación de guías al editar (T173-00004281) — commit c66cf5f

**1.1 Detección** (reporte del usuario: «cada que modifico una guía, elimino un artículo y le doy guardar, se duplican los artículos y rótulos a imprimir; tenía 24 etiquetas y se triplicó»): la guía T173-00004281 tiene DOS guias_id — `0bbdef5d` con **63 filas** (la corrupta) y `d24dacf6` con 22 (la recreación del usuario como workaround, confirmado por él). Evidencia en BD: 16 filas originales (14:31) + INSERTS de 7/13/14/13 filas en 4 guardados (14:39→15:08) con **CERO deletes efectivos**, mezclando marcas «Paleta 2/6» y «2/7» en una misma tanda.

**2. Causa** (doble): (a) la política RLS `recepcion_delete_auth` solo permite DELETE a supervisores+; Edwin tiene rol **operario** → cada DELETE que disparaba al quitar un artículo llegaba como HTTP 200 con **0 filas borradas** (RLS filtra en silencio, sin error); la app creía el guardado y al re-agregar los artículos la guía se inflaba. (b) `filasAItems` fusionaba grupos de paletas del mismo código con N distinto («1/7» + «2/5» → artículo fantasma) y la lectura ordenaba solo por `created_at` (16 filas comparten el MISMO microsegundo → orden arbitrario).

**3. Repetición en otras pestañas**: el patrón «UPDATE=true / DELETE=solo supervisores» se repite en `rals`, `rq_atenciones`, `rq_atencion_items` y `atencion_registros` — mismos borrados silenciosos. Se corrigió la honestidad en las 3 vías de borrado de Recepción + Atención; las demás tablas quedan para una pasada siguiente (los roles supervisores ya podían borrar).

**4/5. Procedimiento + no-conflictos**: (a) política RLS nueva `recepcion_delete_propia_sin_transito` — el DUEÑO borra SUS filas sin envíos de Tránsito; supervisores conservan el poder total (política anterior intacta); (b) guard de propiedad ANTES de escribir en `guardarEdicionGuia` (filas de otro usuario → `ELIMINAR_BLOQUEADO` sin tocar nada) + verificación del DELETE real al final; (c) `eliminarGuia/eliminarRecepcion/eliminarAtencion` verifican el efecto (0 filas = error claro, jamás éxito falso); (d) `filasAItems` exige el MISMO N del grupo abierto y las filas sin marca cierran el grupo; (e) orden determinista `created_at→codigo→n_paleta→id` en `listarRecepcionesPorDocumento`. Los guards de Tránsito y la sincronización por identidad quedan intactos (tests [4] y T173 round-trip 0 inserts/0 deletes).

**6/7. Código**: `errores.ts` (+`ERR_ELIMINAR_BLOQUEADO`), `recepcion-filas.ts` (guard N), `modulos.ts` (pre-guard, conteo real, orden), `RecepcionModule.tsx` (pasa `perfil.id` + toast de aviso, no error rojo: «Guardado incompleto: no se borraron filas»), stub encadenable `delete()`. Estructura: la verificación vive en la capa de datos (una sola fuente), la UI solo interpreta códigos.

**8. Accesos usados**: Supabase Management API (política aplicada + E2E RLS con `SET LOCAL ROLE authenticated` + `set_config('request.jwt.claims')` y ROLLBACK: **dueño borra 27, no-dueño 0**), GitHub/Cloudflare (deploy `202610301553-c66cf5f` verificado en `rackly.pages.dev/version.json`).

**Tests**: `test_recepcion_delete_honesto` (9 checks, nuevo) + caso real T173 en `test_recepcion_filas` (120 checks) — **35/35 suites**, tsc/eslint/build verdes.

**Pendiente para el usuario**: la guía corrupta (63 filas) es de Edwin y no tiene envíos de Tránsito → con la política nueva puede eliminarla él mismo desde la app (botón Eliminar), o dejar que un supervisor lo haga.

---
Task ID: 1 (auditoría global 2026-10-31 — Módulos: todos)
Agent: Main Agent
Task: Honestidad de DELETE en TODOS los módulos — fin de los éxitos falsos por RLS (patrón T173-00004281 generalizado)

Work Log:
- Cierre del bug T173-00004281 (guía 16→63 filas al editar): verificado que el fix c66cf5f (RLS recepcion_delete_propia_sin_transito + DELETE honesto + ensamblado de paletas) ya está en producción (a00bc31) y que la BD quedó limpia: la guía duplicada fue eliminada (0 filas), queda la reconstrucción del usuario (22 filas, workaround intencional)
- Paso 3 (no se repite en otras pestañas): barrido de TODO .delete() de src/ + pg_policies → 18 tablas con DELETE por rol filtran EN SILENCIO la misma clase de defecto en RQ, RAL, Kardex, Piso y Catálogo
- Paso 6/7: nuevo src/lib/rackly/eliminacion-honesta.ts (exigirBorradas + avisarBorradoFiltrado, una sola implementación); 21 puntos de delete cubiertos: modulos.ts (4 refactorizados al helper), rq-atencion.ts (eliminarRq + rollback), ral.ts (eliminarRal + rollback), kardex.ts (deleteMovimiento, eliminarMovimientosPorIds con contador honesto, eliminación por ubicación), piso/api.ts (eliminarSector, eliminarMovimiento, eliminarMovimientoConPar, rollbackCabeceras, podarAncla), catalogo.ts (clearCatalogo, podarAnclasPisoSinUso)
- Rollbacks best-effort NO lanzan (convergencia por diseño se preserva) — solo avisan en consola
- Stub: cola FIFO de delete-results + neq/gte/lte/gt/lt/is
- Suite nueva test_eliminacion_honesta_global (9 secciones / 20 checks): RQ, RAL, Kardex, Piso y Catálogo ya NO reportan éxitos falsos
- QA: 36/36 suites, tsc, eslint, build OK; push main → deploy verificado (ba5fcad, 2026-10-30 16:24 UTC)
- Salud BD: 0 items huérfanos (rq/ral/piso), 0 uuid_sync duplicados, 0 residuos sin guia_id, 20/20 tablas con RLS activa y con políticas

Stage Summary:
- 11 archivos, +452/-59 líneas; 2 nuevos (eliminacion-honesta.ts, test_eliminacion_honesta_global.js)
- Clase entera de defectos (éxito falso por RLS silencioso) eliminada en TODOS los módulos
- Deploy: rackly.pages.dev — commit ba5fcad

---
Task ID: 2 (auditoría 2026-10-31 — bug T012-00000192)
Agent: Main Agent
Task: Editar guía reabre la división en paletas COMPLETA — grupos intercalados por el orden SQL

Work Log:
- Evidencia BD: la guía T012-00000192 está ÍNTEGRA (32 filas, UN guardado 18:23:36 UTC: artículo 30233 × 27 paletas lote 090926 + × 5 paletas lote 030926). El dato NUNCA se perdió
- Repro EXACTO con las 32 filas reales: el ensamblado viejo producía los «9 artículos sin división» que reportó el usuario (8 sueltos + 1 fantasma de 2 paletas + 1 de 23) — guardar esa vista habría reescrito/destruido las marcas
- CAUSA: el desempate determinista n_paleta ASC (c66cf5f) intercala dos grupos del mismo artículo con N distinto (1/27, 1/5, 2/27, 2/5… 5/5 antes que 5/27 por id) y filasAItems solo miraba «el item anterior»
- FIX: filasAItems por GRUPOS ABIERTOS con índice esperado (robusto al orden; contratos legados intactos) + NUEVO ordenarFilasGuia (contigüidad 1..N por primera aparición, idempotente) aplicado en listarRecepcionesPorDocumento (detalle/impresión/edición)
- Paso 3: RQ/Atención usa su propio filasAItems 1:1 sin marcas de paleta — sin el defecto
- TESTS: sección [13] con el orden EXACTO de BD (2 items 27+5, lotes, round-trip 32u/0i/0e, contigüidad, idempotencia) — 131 checks; 36/36 suites, tsc, eslint, build OK
- Deploy: 656aaf7 en producción (2026-10-30 18:50 UTC). PAT de remote reconfigurado (token anterior caducó)

Stage Summary:
- 5 archivos, +270/-63; el editor, el detalle y la impresión de rótulos reabren la guía EXACTAMENTE como se registró
- Commit: 656aaf7

---
Task ID: 3 (pedido 2026-10-31 — Módulo Usuarios)
Agent: Main Agent
Task: Permisos granulares por usuario, independientes del cargo/rol

Work Log:
- 1.1/1.2 (error + averiguación): el módulo Usuarios solo manejaba roles todo-o-nada. Hallazgos: (a) sin permisos por usuario; (b) BUG REAL — la UI mostraba "Aprobar" a supervisores (puedeAprobar) pero la RPC aprobar_usuario exigía admin (falso permiso UI/BD, error garantizado al usar); (c) lógica de permisos duplicada en 12 archivos (new Set(ROLES_SUPERVISORES) repetido); (d) tarjetas móviles de UsuariosTab en tema oscuro dentro de contenedores claros
- 2 (causa): permisos acoplados 1:1 al cargo sin tabla de excepciones; reglas client-side sin fuente única; BD duplicando la lista de roles en 19 políticas
- 3 (repetición): mismo patrón en page.tsx, StockTab, CatalogoTab, DescargaTab, RecepcionModule, AtencionModule, RqAtencionPanel, RqDetalle, MovimientosTab, SectoresTab×2, lote.ts, UsuariosTab
- 4 (procedimiento): tabla user_permisos (solo OVERRIDES) + función SQL tiene_permiso() SECURITY DEFINER STABLE (admin→true · override→su valor · defecto→rol) + 18 políticas DELETE ADITIVAS (OR) en 19 tablas + RPC establecer_permiso_usuario con guard; cliente: catálogo único permisos.ts + puede()
- 5 (sin conflictos): políticas aditivas NUNCA restringen lo actual; admin inmutable (anti-lockout, overrides ignorados); recepcion_delete_propia_sin_transito intacta; escritura de overrides SOLO vía RPC (sin políticas INSERT/UPDATE/DELETE en la tabla); movimientos.eliminar unificado con el borrado de stock (eliminarUbicacion borra de movimientos — evita permisos que la BD rechazaría); descartados permisos muertos (stock.eliminar, catalogo.importar)
- 6/7 (experto/ordenado): migración documentada 20261031_permisos_por_usuario.sql; lib/permisos.ts (catálogo + rolConcedePermiso + puede); DialogoPermisos.tsx (checkboxes por módulo, badge Rol/Personalizado, "Restablecer rol", admin bloqueado); RPC wrapper en auth.ts; ROL_LABEL deduplicado (roles-label.ts)
- 8 (accesos): Supabase Mgmt API (migración + verificación E2E: matriz de 12 casos por rol correcta, override concedido/revocado, guard RPC rechaza sin permiso); GitHub push 9b1d175
- 9 (Módulos): Usuarios (transversal: gates activos en Racks, Piso, Recepción, Atención, Catálogo, Descarga)
- Extras: aprobar_usuario/cambiar_rol_usuario/eliminar_usuario ahora aceptan los permisos usuarios.aprobar/usuarios.gestionar_roles (coherencia UI↔BD); protecciones nuevas (no cambiar el acceso PROPIO; admin no admite overrides); puedeEditarLotePerfil (lote granular); contador de excepciones visible en la lista
- QA: tsc OK · eslint OK · 37/37 suites (nueva test_permisos, 80+ checks) · build OK

Stage Summary:
- 23 archivos, +1198/-105; nuevos: permisos.ts, DialogoPermisos.tsx, roles-label.ts, test_permisos.js, migración SQL
- El admin puede marcar por usuario qué puede y qué no puede hacer, independiente del cargo; la BD aplica la MISMA regla (no es solo cosmética)
- Deploy: 9b1d175 en producción (rackly.pages.dev)

---
Task ID: 4 (pedido 2026-10-31 — Módulo Usuarios, trace 1a18e676af27d259)
Agent: Main Agent
Task: CUADRO DE PERMISOS módulo × acción — fin de los bugs del v1 (denegar BLOQUEA de verdad)

Work Log:
- 1.1/1.2 (bug del v1 9b1d175 reproducido y probado): (a) MÓVIL: el pie del diálogo se SUPERPONÍA a la lista (screenshot iPhone); (b) BD: marcar ✗ NO bloqueaba — las 18 políticas *_delete_permiso son PERMISSIVE (OR con las de rol: un supervisor con override seguía borrando) y SELECT/INSERT/UPDATE seguían abiertos a todos; (c) 14 RPCs SECURITY DEFINER saltaban RLS (ningún override las frenaba); (d) el catálogo (10 permisos) no formaba el cuadro Ver/Crear/Editar/Eliminar/Aprobar del modelo del usuario; (e) RqDetalle usaba atencion.eliminar para EDITAR; (f) toast «Permiso restringido» al quitar una excepción
- 2 (causa): arquitectura solo-aditiva (OR nunca restringe) sin capa DENY ni matriz módulo×acción
- 3 (repetición): E2 en las 18 tablas; E3 en todo el catálogo; E4 en Atención/RqDetalle; E5 en las 14 RPCs de escritura (registrar_movimiento_kardex, registrar_traslado_kardex, editar_lote_vencimiento_racks/_piso, piso_registrar_salida/traslado, piso_auto_estructura_sector, rq_crear_completa, rq_atender_lote, rq_revertir_origen, rq_editar_rq, ral_crear_completa, transito_registrar_envio, rackly_reemplazar_movimientos)
- 4/5 (procedimiento sin conflictos): capa DENY = 60 políticas AS RESTRICTIVE (se AND-ean con las permissive de rol, que NO se tocan) + guards dentro de las 14 RPCs (splice de pg_get_functiondef con respaldo scripts/respaldo_rpc_antes_guard_20261031.sql) + marcador de llamada anidada (GUC rackly.en_rpc_interna) para que transito→registrar_movimiento_kardex herede autorización; defaults por rol en permiso_defecto_rol() que REPRODUCEN el comportamiento actual con cero overrides (verificado contra pg_policies); admin inmutable; uniones explícitas: movimientos INSERT ∪ descarga.subir (UP Data), recepcion SELECT ∪ transito.ver, recepcion/atencion UPDATE ∪ .crear (flujos de atender/imprimir)
- 6/7: migración 20261031_permisos_matriz.sql (4 funciones + 60 políticas + 14 guards, aplicada statement a statement con scripts/aplicar_migracion.py aware de dollar-quoting); permisos.ts v2 (27 permisos + MATRIZ 8 módulos × 5 acciones + PERMISO_VER_MODULO); DialogoPermisos v2 = cuadro como el modelo (✓ verde / ✗ rojo / borde azul = excepción, columnas pegajosas, scroll móvil, pie NUNCA superpuesto, toasts correctos); gates por celda: ModulosHome/page (Ver por módulo), MovimientoForm (crear racks), PisoSectoresTab×5 handlers (crear piso), Recepción (registrar/editar), RqAtencionPanel (Nueva RQ/RAL), Tránsito (transferir), Catálogo (crear/editar/eliminar separados), UsuariosTab (eliminar), RqDetalle (editar = atencion.editar)
- 8 (accesos): Supabase Mgmt API (migración + E2E BD scripts/e2e_cuadro_permisos.py 10/10: defaults, DENY bloquea DELETE por RLS con JWT simulado, guard RPC NO_AUTORIZADO, limpieza sin residuos) + navegador E2E (cuadro como modelo, excepción azul guardada, badge contador, denegación en supervisor)
- 9 (Módulos): Usuarios (transversal: Racks, Catálogo, Descarga, Piso, Recepción, Atención, Tránsito)
- QA: tsc OK · eslint OK · 37/37 suites (test_permisos v2: 423 checks) · build OK
- Deploy: dabdca2 en producción (rackly.pages.dev, 2026-10-30 20:43 UTC), verificado con el cuadro en vivo; BD sin overrides residuales tras las pruebas

Stage Summary:
- 15 archivos, +3387/-269; nuevos: migración del cuadro, aplicar_migracion.py, gen_guard_rpc.py, e2e_cuadro_permisos.py, respaldo RPCs
- Marcar ✗ en el cuadro ahora BLOQUEA en la base de datos (RLS RESTRICTIVE + guards RPC), no solo oculta botones; con cero excepciones todo funciona exactamente igual que antes
- Commit: dabdca2

---
Task ID: 5 (pedido 2026-11-01 — Racks/Ocupación, trace 1a1978d198de5c91)
Agent: Main Agent
Task: «75 espacios libres — ¿se están contando como libres los espacios ocupados por artículos INC?» — verificación DB + 1 bug real corregido (Tránsito) + textos sin ambigüedad

Work Log:
- 1.1/1.2 (verificación en DB, owjryvcrhpmgtkkdcrkm): los números del resumen son CORRECTOS — occupied=1085 (RPC ocupacion_celdas_v2, que EXCLUYE codigo_inc), INC con stock neto>0 = 41 (1 mixta + 40 solo INC), y Vacías = 1200 − 1085 − 40 = 75: las celdas con INC NO están dentro de las 75. Anti-join contra la grilla oficial (9 bloques × torres × 4 pisos × pos): 0 celdas ocupadas fuera de grilla, 0 INC fuera de grilla, 0 celdas con stock negativo → 1085 + 40 + 75 = 1200 exacto
- 2 (causa de la duda): (a) el subtítulo de la tarjeta VACÍAS decía «Disponibles · 40 con INC» — literalmente sugiere que 40 espacios libres tienen INC (falso: están FUERA de las 75); (b) el subtítulo de OCUPADAS mezclaba «41 con INC (1 ocupadas + 40 solo INC)»; (c) BUG REAL de la misma clase: MapaRackSelector (Tránsito → DialogoTransferir, destino Piso→Rack) usa ocupacionRacks() = RPC v2 SIN merge INC → las 40 celdas solo-INC quedaban con stock 0: se pintaban VERDES «Libre — sin artículo», la sugerencia automática podía preseleccionarlas como destino y el clic NO pedía confirmación de co-ubicación → se podíameter mercadería nueva en una celda físicamente bloqueada por INC
- 3 (repetición en otras pestañas): Piso NO hereda el defecto (RPC piso_stock_sector_grid netea TODOS los movimientos sin excluir INC → sus Vacías ya cuentan INC como ocupado); Ocupación (Racks) ya mergeaba INC correctamente; el Excel exportado ya distingue «Solo INC» de «Vacío»; la leyenda del mapa de Racks (page.tsx) no documentaba el color INC → incluida
- 4/5 (procedimiento sin conflictos): 100% frontend, sin cambios de RPC ni de firmas compartidas — MapaRackSelector gana el MISMO merge que ya usa OcupacionTab (buildCellMap como referencia); SeleccionRack gana campo OPCIONAL incItems (los callers existentes no se rompen); el convenio de colores queda idéntico en ambos mapas (INC rosado gana a azul/naranja, respetando selección y marca mismo-código)
- 6/7 (implementación ordenada): MapaRackSelector — helpers tieneIncActiva/esCeldaLibre/fusionarInc (documentados), cargar() con Promise.all(ocupacionRacks, fetchIncPorUbicacion), sugerencia SOLO celdas sin stock ni INC, clic en celda INC = ocupada + confirmación de co-ubicación con detalle «INC pendiente de disponer», tooltip INC con códigos/cantidades, leyenda «Con INC (no libre)»; OcupacionTab — VACÍAS «Sin stock ni INC · N INC aparte», OCUPADAS «N con INC», ecuación visible «1085 + 40 INC + 75 = 1200» bajo la barra de %, eliminadas variables muertas con semántica incorrecta (bEmpty sin descontar INC, tInc sin uso)
- 8 (accesos): DB verificada por Supabase Mgmt API (definiciones de ocupacion_celdas/_v2/piso_stock_sector_grid + conteos reales); navegador E2E en producción con cuenta propia: login OK, pestaña Ocupación muestra los textos nuevos y la ecuación, console/page errors = 0
- 9 (Módulos): Racks/Ocupación + Tránsito (mapa de destino) — transversal a Piso solo en verificación
- QA: tsc 0 · eslint 0 · 39/39 suites · build OK · push 0f09ca2 · producción version.json = 202611011454-0f09ca2

Stage Summary:
- 4 archivos, +97/−21: MapaRackSelector.tsx (INC nunca libre ni sugerido), OcupacionTab.tsx (textos + ecuación + limpieza), page.tsx (leyenda), version-sello.ts (auto)
- Respuesta al reporte: los 75 libres NO incluyen espacios con INC (verificado fila a fila en DB); el resumen era correcto pero su texto inducía a la duda, y el MISMO criterio sí estaba mal en el mapa de Tránsito — ahí sí se podía elegir/sugerir una celda con INC como destino; ambos quedan alineados con el convenio «INC = ocupada, no libre»
- Deploy: 0f09ca2 en producción (rackly.pages.dev, 2026-11-01 14:54 UTC)

---
Task ID: 6 (pedido 2026-11-02 — Racks, trace 1a19c8089fb5fba5)
Agent: Main Agent
Task: «los INC les sale con color verde en vez de rosado» — causa raíz (consulta INC que falla) corregida en los 2 mapas que la comparten

Work Log:
- 1.1/1.2 (averiguación): la regla de render es y era correcta (isInc → rosado). El verde era REAL e intermitente: el mapa INC se consulta APARTE (fetchIncPorUbicacion) y al fallar devuelve un mapa vacío con _error=true (no lanza) → el merge no aportaba nada y las celdas solo-INC caían a la rama «Vacío» (verde). Segunda vía: el fallback RPC v1 de Ocupación hacía setOcupacion(celdas) SIN fusionar INC. Con el polling de 10 s, cualquier fallo transitorio de red/BD («tema de internet») pintaba el mapa sin INC hasta el siguiente ciclo, y el toast que avisaba se perdía
- 2 (causa): el estado «INC desconocido» se representaba como «Vacío» — un verde que PROMETE «sin stock ni INC» cuando en realidad no se sabía
- 3 (repetición): MapaRackSelector (Tránsito → transferencias) tenía el MISMO hueco vía _error: tras el fix de Task 5 seguía fusionando bien en el camino normal, pero con consulta INC caída las celdas solo-INC volvían a «Libre» y la sugerencia automática podía preseleccionarlas como destino. Verificados y a salvo: MapaPisoSelector (RPC piso netea INC como ocupado), leyenda de Racks (texto estático), StockIncTab (lista, no mapa)
- 4/5 (procedimiento sin conflictos): 100% frontend, sin cambios de RPC ni de firmas — (a) lib compartida mapa-inc.ts: fusionarIncEnCeldas (UNA implementación del merge para los dos mapas, reemplaza buildCellMap + fusionarInc duplicadas) y fetchIncPorUbicacionConReintento (1 reintento automático a ~800 ms absorbe los fallos transitorios dentro del mismo ciclo; _truncated no se reintenta); (b) si aún así falla, honestidad en vez de mentira: banner ámbar persistente + celdas «vacío» en gris neutro con tooltip «INC desconocido» (nunca verde), ecuación y contadores INC marcados «no verificado»; (c) MapaRackSelector en modo «INC no verificado»: SIN sugerencia automática, tooltip «¿Libre? — datos INC no disponibles» y confirmación obligatoria al elegir cualquier celda (diálogo adaptado: «Estado INC no verificado» / «Sí, usar de todos modos»)
- 6/7 (experto/ordenado): eliminadas las dos copias del merge; clave canónica única (claveCelda = claveCeldaRack); incError se setea/cleara en TODOS los caminos (RPC v2, client-side, fallback v1); dataSource muestra «· INC falló»; banner se limpia solo al ciclo siguiente exitoso
- 8 (accesos): E2E en producción con cuenta propia (login → Racks → Ocupación): Total 1,200 · Ocupadas 1077 · Vacías 83 · Con INC 41 · ecuación «1077 + 40 INC + 83 = 1200» visible, SIN banner (consulta INC OK con reintento activo); 40/40 celdas solo-INC pintadas rosado (clase rose verificada por DOM), tooltips con código/codigoInc/cantidad; console errors = 0, page errors = 0
- 9 (Módulos): Racks/Ocupación + Tránsito (MapaRackSelector) — transversal: mapa-inc.ts compartido
- QA: tsc 0 · eslint 0 · 40/40 suites (nueva test_mapa_inc: 8 checks) · build OK · push 03a93af · producción version.json = 202611021400-03a93af

Stage Summary:
- 5 archivos, +318/−96: mapa-inc.ts (nuevo, merge único + reintento), OcupacionTab.tsx (fallback con merge + banner + celdas grises honestas), MapaRackSelector.tsx (modo INC no verificado), test_mapa_inc.js (nuevo), run_all_tests.sh (registro)
- Respuesta al reporte: no era «internet del usuario» ni un color mal definido — era la consulta INC cayendo de forma intermitente y el mapa pintando «Vacío» lo que no podía verificar; ahora el fallo transitorio se reintenta solo y, si persiste, la app lo DICE (banner) y no pinta libres las celdas que no puede verificar
- Deploy: 03a93af en producción (rackly.pages.dev, 2026-11-02 14:00 UTC)
---
Task ID: panel-cruzado-stock-racks-piso-20261109
Agent: Main Agent
Task: «1.1=Adelante — panel cruzado en Stock de Racks y Piso (arriba el módulo actual, abajo el otro) con redirección al otro módulo desde el mismo lugar; revisar errores, bugs, duplicados, procesos, estructura de datos eficiente y segura, BD correcta; 1.2 averiguar el error; 2 analizar qué lo genera; 3 revisar que no se repita en otras pestañas; 4 procedimiento más efectivo; 5 sin conflictos; 6-7 código experto y ordenado; 8 usar todos los accesos; 9 Módulos: RACKS Y PISO» (metodología 9 pasos)

Work Log (1.1–9):
- Contexto: la búsqueda cruzada VIEJA (eliminada en 442e7da) fallaba con «no muestra nada» — arqueología del código eliminado: (1) replay client-side del historial completo por código (lento → timeout 8s → vacío), (2) `catch { return [] }` silenciaba TODO error, (3) disparo por tecleo con 1 consulta POR CÓDIGO matcheado en paralelo, (4) convención de signos ad-hoc en JS (traslados contados como +), (5) dependía del resultado local (si la pestaña local estaba vacía, el panel cruzado ni consultaba). Era exactamente la experiencia negativa que reportó el usuario.
- 4 (procedimiento): reusar las rutas server-side existentes en vez de reconstruir nada — Racks: RPC stock_por_codigo_kardex (signos únicos en BD); Piso: extraer el núcleo de derivación de stockPisoBuscar a stockPisoPorCodigos(códigos exactos, .in() sin ilike — costo acotado al bloque pedido). PRUEBA de viabilidad previa (solo lectura, producción): 56746 → 9 filas Racks 1.2s / Piso 0; 56203 → Piso 220 KG en A-1A1-Pos 10 Niv 1 0.8s / Racks 0 — 0 resultados = dato correcto, no fallo.
- 5 (sin conflictos): panel 100% SOLO LECTURA (no toca rutas de escritura ni BD), 1 consulta por código ACTIVO (no por tecleo), guard seqRef (respuesta lenta de un código anterior nunca pisa la actual), errores VISIBLES con Reintentar, sin suscripción realtime propia, cada módulo conserva SU fuente de stock (independencia del desacople intacta). Navegación por sentinelas nuevos ('__racks_stock__'/'__piso_stock__') que no alteran los flujos existentes ('__atencion__').
- 6/7 (implementación ordenada): CrossModuleStock.tsx (panel compartido: chips por código si hay varios, plegable, variantes claro/oscuro, deep-links violeta→Piso·Sectores / cian→Racks·Ocupación); cruce.ts (capa de datos: stockRacksPorCodigo PROPAGA errores — a diferencia de fetchStockPorCodigoRPC que degrada a null — y stockPisoPorCodigo delega al núcleo compartido); StockTab/PisoStockTab reciben el panel al final (ventana inferior); page.tsx inyecta gotoPisoPosicionDesdeRacks / gotoUbicacionDesdePiso con retorno al módulo de origen (sesión de búsqueda restaurada desde sessionStorage). En Piso, si la búsqueda local no matcheó pero el término es código exacto de catálogo, el panel usa ese código (material posiblemente SOLO en Racks — el caso más valioso).
- Limpieza (duplicados/muertos): eliminar buscarStockRacksPorCodigo + calcularStockRacksDesdeMovs (92 líneas sin llamadores desde 442e7da) y su sección de test; fetchMovimientosByCodigo SE CONSERVA (viva: MovimientoForm ×2).
- 3 (repetición en otras pestañas): las 2 fallas de test_eliminacion_honesta_global [6][7] ya existían en el baseline bd244f4 (verificado stash/pop) — eran tests obsoletos del refactor a borrado RPC atómico (a5c25d6): la honestidad del borrado en Piso vive ahora server-side (piso_eliminar_movimiento RAISE «Movimiento % no encontrado» si DELETE=0 filas) y el cliente solo PROPAGA; tests realineados a la RPC (stub __setRpcResult fiel al RAISE real, verificado en BD por MAPI) + 2 checks nuevos (args de la RPC, movimiento simple = 1 cabecera).
- 8 (accesos): GitHub PAT (remote re-actualizado: el embebido estaba muerto), Cloudflare Pages, Supabase MAPI (definiciones RPC + verificación). QA: tsc 0 · eslint 0 (reglas React Compiler del nuevo panel incluidas) · 45/45 suites · build OK.
- 9 (Módulos): RACKS (StockTab) + PISO (PisoStockTab); transversal: page.tsx (navegación), piso/api.ts (extracción), kardex.ts (limpieza), cruce.ts + CrossModuleStock.tsx (nuevos).
- Deploy: push 0fee283 → producción (verificar version.json 20261109*-0fee283).

Stage Summary:
- El usuario pidió exactamente esto tras el diagnóstico del mensaje anterior: ventana superior = módulo actual (intacta), ventana inferior = el OTRO módulo, con salto directo a la ubicación exacta y botón de retorno.
- Los 3 defectos que hicieron fallar al cruce antiguo están estructuralmente eliminados: consultas acotadas server-side, errores visibles, cadencia 1/código activo.
- 10 archivos, +524/−242 · Commit: 0fee283

---
Task ID: auditoria-panel-cruzado-20261109
Agent: Main Agent
Task: «1.1 revisar que la mejora no haya generado errores en la app, bugs, duplicados, procesos por módulo, estructura de datos eficiente y segura, BD correcta; 1.2 averiguar el error; 2 analizar qué lo genera; 3 revisar que no se repita en otras pestañas; 4 procedimiento más efectivo; 5 sin conflictos; 6-7 código experto y ordenado; 8 usar todos los accesos; 9 Módulos: RACK Y PISO» (auditoría post-deploy del panel cruzado 0fee283)

Work Log (1.1–9):
- 1.1 RESULTADO: SIN errores funcionales atribuibles a la mejora. QA local re-ejecutado íntegro sobre 8b98074: tsc 0 · eslint 0 · 45/45 suites · build OK. Producción: version.json = 202611091359-8b98074 y el SELLO compilado dentro del bundle coincide (1 ocurrencia exacta en los chunks servidos) → el aviso «Nueva versión» NO se dispara en falso; el version-sello.ts comprometido queda 1 commit atrás POR DISEÑO (gen_version.mjs lo regenera en el build de Cloudflare con el hash del build).
- BD (owjryvcrhpmgtkkdcrkm): Supabase ACTIVE_HEALTHY; RPC stock_por_codigo_kardex(p_codigo text, p_solo_inc boolean DEFAULT false) y piso_eliminar_movimiento(p_movimiento_id uuid) vigentes; snapshot piso_stock_nivel = 178 buckets, 0 negativos, actualizada 2026-11-09 13:08 UTC; catálogo 1,107. La mejora fue 100% frontend: 0 DDL, RLS/policies intactas, rutas de escritura intactas.
- E2E navegador en producción (cuenta propia, 0 page errors; 1 warning de consola pre-existente aria-describedby de DialogContent, ajeno): (a) Racks·Stock 56203 → panel «Stock en Piso» Total 220 → deep-link «Pos 10» → Piso·Sectores con diálogo de la posición EXACTA A·A1·Pos 10 (56203, lote 1E3462, vence 2026-11-14) → «← Volver a Stock Racks» restaura la búsqueda; (b) Piso·Stock 56746 → panel «Stock en Racks» Total 3,500,550 con 9 deep-links → celda B6·T2·P1·Pos 10 seleccionada con diálogo de acciones abierto → «← Volver a Stock Piso» restaura la búsqueda 56746.
- Duplicados: 0 código residual (solo comentario documental en test_buscar_stock_fefo.js explicando las secciones retiradas); núcleo ÚNICO stockPisoPorCodigos compartido por stockPisoBuscar y el panel (ambas vistas muestran SIEMPRE lo mismo); callers cruzados = 6 archivos con responsabilidad distinta (page.tsx navegación, CrossModuleStock UI, StockTab/PisoStockTab integración, piso/api.ts núcleo, cruce.ts capa de datos). fetchMovimientosByCodigo conservada (viva en MovimientoForm ×2).
- Aislamiento de errores verificado en código: el panel captura sus propios errores (visibles con Reintentar), guard seqRef evita que una respuesta lenta pise la del código activo, «sin stock» se muestra como dato válido y ninguna falla del panel afecta la pestaña principal ni la consulta del módulo local.
- 2 (causa) / 3 (no repetición) / 4 (procedimiento) / 5 (conflictos): sin error que trazar — metodología aplicada como verificación negativa. Revisión del diff completo de 0fee283: sentinelas de navegación nuevos ('__racks_stock__'/'__piso_stock__') no alteran flujos existentes ('__atencion__'); props nuevas son OPCIONALES (callers previos no se rompen); panel solo lectura.
- Observaciones NO-bug documentadas: (1) panel Piso→Racks consulta p_solo_inc=false → muestra SOLO stock sin INC (coherente con «INC = flujo aparte gestionado manualmente»; la vista autoritativa es el deep-link a Ocupación / pestaña Stock INC); (2) warning aria-describedby de DialogContent pre-existe a la mejora; (3) PisoStockTab.tsx termina sin newline (cosmético).
- 8 (accesos): GitHub push, Cloudflare Pages (deploy + sello verificados en bundle servido), Supabase MAPI (definiciones RPC + salud snapshot), navegador E2E con cuenta propia.
- QA: tsc 0 · eslint 0 · 45/45 suites · build OK · producción 202611091359-8b98074 con E2E de las 2 direcciones en verde.

Stage Summary:
- Auditoría post-deploy del panel cruzado: SIN errores funcionales, SIN duplicados, SIN cambios de código requeridos; 2 decisiones de diseño documentadas (sello 1 commit atrás por diseño; panel muestra solo stock sin INC en la dirección Piso→Racks).
- Evidencia: QA completo local + verificación de sello en el bundle real + E2E navegador producción de Racks→Piso y Piso→Racks con retorno y búsqueda restaurada.

---
---
Task ID: sesion-cerrar-otros-equipos-20261111
Agent: Main Agent
Task: «1.1 implementar el botón de cerrar sesión en otros dispositivos, revisar si al implementar la mejora hay errores en la app, bugs, duplicados, que los procesos en cada módulo funcionen correctamente, que cada código esté funcionando bien, que la estructura de datos sea la más eficiente y segura, la base de datos esté funcionando correctamente; 1.2–8 metodología».

Work Log (1.1–8):
- Contexto: la auditoría integral 2026-11-10 (4d95a6c, veredicto APROBADO) dejó la app verificada; este pedido añade el botón acordado en la consulta previa y RE-VERIFICA la app tras el cambio. Repo local re-sincronizado desde historia obsoleta (backup/local-0fde678 + stash) a origin/main 4d95a6c = producción.
- 1.2/2 (qué se resuelve): el usuario deja sesiones abiertas en otras computadoras — el botón «Salir» usa signOut() sin scope = GLOBAL (cierra también la sesión actual, sorprende) y no existía forma de cerrar SOLO las demás conservando la actual. DB: auth.sessions muestra 154 sesiones activas acumuladas (36 de la cuenta del usuario desde el 01-nov) — problema real y medible.
- 3 (no se repite en otras pestañas): signOut aparece en 4 puntos: SesionBar (única barra de sesión de la SPA, page.tsx) + 3 en AuthGate (cambio de contraseña obligatorio, cuenta pendiente, recuperación de sesión — ahí el alcance global es el correcto: fin de sesión completo). El nuevo alcance va SOLO en SesionBar; AuthGate intacto. No hay otras UIs de sesión (una sola SPA).
- 4 (procedimiento más efectivo): scope 'others' de Supabase Auth — UNA llamada de plataforma revoca todos los refresh tokens del usuario excepto el de la sesión actual; los demás equipos quedan fuera al intentar renovar (máx. jwt_exp 3600 s). Sin DDL, sin RPC, sin RLS: API del proveedor, superficie de riesgo mínima.
- 5 (sin conflictos): verificado en el código del cliente auth-js: con scope 'others' NO se dispara SIGNED_OUT ni se limpia el almacenamiento local → el equipo actual ni se entera. Botón ADITIVO junto a «Salir» (que conserva su comportamiento global de siempre), con AlertDialog de confirmación (acción destructiva para los otros equipos), estado busy, toasts de resultado y error con mensaje real. 0 cambios en Insumos/Piso/REP/kardex.
- 6/7 (experto/ordenado): función documentada signOutOtrosDispositivos() en auth.ts (capa única de auth, junto a signOut/resetPassword) — la UI no conoce la API de Supabase. UI en SesionBar.tsx: icono MonitorSmartphone + tooltip, etiqueta «Otros equipos» solo en móvil. Diff: 2 archivos, +79/−2.
- 8 (accesos + verificación): QA sobre 37432cc: tsc 0 · eslint 0 · 53/53 suites · build OK. DB re-auditada por MAPI: 31/31 tablas CON RLS (0 sin RLS) · rep_ubicaciones 1.869 = 1.773 racks + 96 zonas (4 prepicking) · loncheras 3.642 · catálogo 1.107 · rep_stock 0 filas y 0 negativos · movs insumos 28.960 · sobrecargas rq_atender_item (3/4 args) y rep_registrar_ingreso (4/8 args) vigentes según lo corregido en el fix PGRST203 · bundle de producción sin service_role (fix P1 intacto). Push con PAT renovado (el embebido en el remote seguía muerto) → deploy Cloudflare verificado por version.json.

Stage Summary:
- Barra de sesión con botón nuevo «Cerrar sesión en otros equipos»: confirmación → cierra TODAS las sesiones del usuario MENOS la actual; los otros equipos quedan fuera en ≤1 h. «Salir» sigue cerrando todo (global) como siempre.
- Re-verificación post-cambio: SIN errores, SIN duplicados, SIN conflictos con otras pestañas; BD saludable (RLS 31/31, conteos exactos, stock sin negativos).
- Nota: la cuenta del usuario tenía 36 sesiones acumuladas — puede limpiarlas YA con el botón nuevo en un clic (o pedir un purge total por BD si lo prefiere).
- Deploy: push 37432cc → producción (verificar version.json).
---
Task ID: rep-recepcion-editar-eliminar-guias-20261112
Agent: Main Agent
Task: «1.1 EN LA GUIAS YA RECEPCIONADAS QUE LOS SUPERVISORES, COORDINADORES O ADMINISTRADORES PUEDAN EDITAR EL DOCUMENTO, CANTIDADES, CODIGOS O LO QUE SE NECESITE Y LUEGO DARLE GUARDAR NUEVAMENTE, TAMBIEN BORRAR LA GUIA SI SE DEBE; revisar errores/bugs/duplicados/procesos/códigos/estructura de datos/BD; 1.2–8 metodología; 9 Almacén Repuestos; 10 Módulo Recepción» (con captura del panel Últimas recepciones).

Work Log (1.1–9):
- 1.2 (averiguar el hueco): una guía guardada era INMUTABLE — un código/cantidad/OC mal digitado quedaba permanente y una guía de prueba no se podía borrar (la captura del usuario muestra exactamente ese panel). Insumos SÍ tiene «Revisar/editar» + «Eliminar guía» — REP carecía de paridad.
- 2 (qué lo genera): las tablas rep_recepciones/rep_recepcion_lineas nacieron RLS solo-lectura (escritura SOLO vía RPC con guard) — sin RPC de edición/eliminación, no había camino legítimo.
- 3 (no se repite en otras pestañas): paridad con Insumos verificada línea a línea (su edición carga en el formulario y su eliminar bloquea si Tránsito ya transfirió). REP usa el MISMO modelo mental pero con regla física MÁS ESTRICTA: solo guías 100% en tránsito son editables/borrables — si una línea ya está ubicada, su stock+kardex ya se escribieron y el documento queda intocable (la corrección física vive en el almacén: salidas/traslados del mapa). Tránsito/Atención/Movimientos/Ubicaciones: 0 cambios de código; una guía eliminada desaparece sola de Tránsito (sus líneas ya no existen) y una editada muestra el código/desc actualizados en el próximo fetch.
- 4 (procedimiento más efectivo): 2 RPCs SECURITY DEFINER atómicas en migración 20261112_rep_editar_eliminar: rep_editar_recepcion(p_recepcion_id, p_guia, p_oc, p_dam, p_lineas jsonb) sincroniza por id — UPDATE conserva el uuid de las líneas existentes (los QR ya impresos siguen resolviendo a la misma línea), INSERT para nuevas (uuid nuevo → rótulo nuevo), DELETE para las excluidas; devuelve linea_ids en el orden de entrada (contrato de rótulos igual al registro). rep_eliminar_recepcion borra documento+líneas. Ambas: guard tiene_permiso('repuestos.gestionar' / 'repuestos.eliminar') — los roles del pedido EXACTOS por defecto (supervisor_almacen, supervisor_operaciones, coordinador_operaciones + admin; sin tocar la matriz ni overrides). Validación fail-fast todo-o-nada, advisory lock por recepcion_id (edit/eliminar se excluyen entre sí) y FOR UPDATE sobre TODAS las líneas ANTES de decidir: si Tránsito está ubicando en ese momento, espera su commit y ve «ubicado» → rechaza (carrera imposible). Nombres nuevos: cero riesgo PGRST203.
- 5 (sin conflictos): 0 DDL destructivo (CREATE OR REPLACE de funciones nuevas); RLS intacta (las tablas siguen solo-lectura para el cliente); la UI es ADITIVA en el panel (lápiz+papelera junto al impresor) y REUTILIZA el formulario existente para editar (cargar guía → corregir con la ficha que ya existe → «Guardar cambios» — literalmente lo que pidió el usuario). banner celebre de modo edición con «Cancelar edición»; la papelera pide confirmación AlertDialog; loteRef del borrador de alta se resetea al entrar/salir de edición (un alta interrumpida jamás hereda uuid_sync a la guía editada).
- 6/7 (experto/ordenado): datos vía 3 funciones nuevas en rep-client (repRecepcionCompleta: documento completo para editar; repEditarRecepcion/repEliminarRecepcion: RPCs) — la UI no conoce SQL; LineaRecepcionRep ganó id?: string (uuid BD, solo en edición) documentado. Regla de proveedores al cargar: todos iguales → modo único con proveedorGeneral; distintos → modo múltiple por línea (reconstrucción fiel del documento).
- 8 (accesos): E2E TRANSACCIONAL en producción por MAPI (BEGIN…ROLLBACK, huella cero) — 9/9 OK: crear 2 líneas → editar (l1 cantidad 99 conservando uuid, l2 re-articulada con catálogo sincronizado, +1 línea nueva; cabecera actualizada; linea_ids en orden) → operario BLOQUEADO editar (NO_AUTORIZADO) → ubicar línea en lonchera libre → edición y eliminación RECHAZADAS (GUIA_YA_UBICADA con mensaje claro) → otra guía eliminada con 0 residuo → operario BLOQUEADO eliminar. QA local sobre 4845c90: tsc 0 · eslint 0 · 53/53 suites · build OK. Push con PAT vigente → deploy Cloudflare verificado por version.json.
- 9 (Módulos): Almacén Repuestos · Recepción (+ efecto automático leído en Tránsito).

Stage Summary:
- Últimas recepciones con lápiz (editar) y papelera (eliminar) solo para supervisores/coordinadores/admin: editar carga la guía en el MISMO formulario (guía/OC/DAM, códigos, cantidades, proveedores, agregar/quitar líneas) y «Guardar cambios» reemplaza el documento atómicamente; borrar pide confirmación. Guías con artículos ya ubicados: botones deshabilitados con tooltip explicativo y la BD rechaza de todos modos (doble defensa).
- Los QR ya impresos de líneas conservadas siguen válidos tras una edición (uuid estable); el guardado de edición reabre el modal de rótulos para imprimir los de las líneas nuevas.
- Evidencia: E2E transaccional 9/9 en BD de producción + QA completa verde + deploy verificado.
- Deploy: push 4845c90 → producción (verificar version.json).
---
Task ID: nav-volver-modulos-20261111
Agent: Main Agent
Task: «cada vez que quiero salir de un modulo tengo que ir hasta inicio — podríamos poner un botón de atrás en cada modulo? y asi retroceder a la selección de modulos y no salir hasta selección de almacenes?» (con captura de Repuestos · Catálogo); 1.2–8 metodología.

Work Log (1.1–8):
- 1.2 (averiguar la fricción): la jerarquía real es Pre-ingreso (almacén) → selección de módulos → módulo, pero el ÚNICO camino de salida de un módulo era el chip «Inicio» del header — que hace setView('inicio') + setAlmacen(null) y cae SIEMPRE al pre-ingreso: para pasar de, p. ej., Catálogo a Ubicaciones había que re-elegir el almacén (2 clics extra + recarga visual). No existía botón «atrás» por módulo.
- 2 (qué lo genera): el header fue diseñado como único punto de navegación («el header no duplica accesos directos») y el estado `almacen` solo se conservaba mientras view === 'inicio' tras entrar; ningún módulo tenía retorno de nivel.
- 3 (no se repite en otras pestañas): inventario de las 12 vistas de módulo (Usuarios, Recepción, Atención, Tránsito, Racks, Piso + 6 rep-*) — TODAS carecían del botón; los botones «Volver» existentes son de OTRO nivel (pestaña de origen: Ocupación/Sectores/deep-links REP) y no se tocan. RepuestosHome/ModulosHome ya tenían «Cambiar de almacén», así que el nivel intermedio estaba completo salvo el retorno módulo→módulos.
- 4 (procedimiento más efectivo): botón compartido VolverAModulos (ghost + ArrowLeft) en la cabecera de CADA módulo → handler volverAModulos(): setView('inicio') CONSERVANDO `almacen` — así view==='inicio' && almacen seteado renderiza ModulosHome/RepuestosHome (la selección de módulos) sin pasar por el pre-ingreso. El chip «Inicio» del header queda intacto como atajo al pre-ingreso (cambio de almacén) — dos niveles, dos controles, sin ambigüedad. Cero DDL, cero RLS, cero RPC: navegación UI pura.
- 5 (sin conflictos): handler ADITIVO que solo limpia el puente deep-link de Repuestos (repTarget/repOrigen — mismos que limpia «Inicio»); los estados de pestañas (racksTab/pisoTab/ubicacionOrigen/pisoOrigen) quedan como estaban, igual que hoy al re-entrar vía ModulosHome. Caso especial Usuarios (transversal, se abre SIN almacén desde pre-ingreso): conAlmacen={almacen !== null} → etiqueta «Volver» y destino el pre-ingreso mismo (retrocede un nivel, nunca una pantalla muerta). Los fallbacks de permiso perdido (398-407) no renderizan módulos, así que no duplican el botón. Racks/Piso: botón NO sticky a propósito — el anclaje top-[52px] del TabsList no se mueve (cero riesgo de encime).
- 6/7 (experto/ordenado): 1 componente nuevo documentado (src/components/rackly/inicio/VolverAModulos.tsx, misma separación de responsabilidades que ModulosHome/PreIngreso: el destino lo decide page.tsx, el componente solo pinta) + 1 handler documentado en page.tsx con la cita literal del pedido; 12 inserciones de 1 línea. Diff total: 2 archivos, +31/−1.
- 8 (accesos + verificación): QA sobre el feat: tsc 0 errores · eslint 0 · 53/53 suites OK · build OK (solo ruta «/», sin rutas nuevas). Verificación E2E en producción tras deploy: login cuenta de prueba → entrar a módulos de REP e INSUMOS → el botón «Volver a módulos» aparece en los 12 módulos y regresa a la selección de módulos CON el almacén activo (no al pre-ingreso); «Cambiar de almacén» sigue llevando al pre-ingreso y el chip «Inicio» también. BD re-auditada por MAPI sin cambios de esquema: RLS 31/31, conteos de siempre.

Stage Summary:
- Botón «Volver a módulos» (en móvil también visible) en la cabecera de los 12 módulos: Racks, Piso, Recepción, Atención, Tránsito, Usuarios + Catálogo, Ubicaciones, Recepción, Atención, Tránsito y Movimientos de Repuestos.
- Retrocede a la selección de módulos del almacén activo (¡no sale a la selección de almacenes!); el «Inicio» del header sigue disponible para cambiar de almacén.
- Re-verificación post-cambio: SIN errores, SIN duplicados, SIN conflictos con otras pestañas; BD intacta (cambio 100% de navegación).
- Deploy: push → producción (verificar version.json).
---
Task ID: traslado-ubicacion-completa-20261111
Agent: Main Agent
Task: «1.1 que en la opción de traslado actualmente se realiza el traslado material a una nueva ubicación, podríamos implementar el traslado por todo lo que se encuentra en esa ubicación a otra ubicación para que sea más rápido ya que actualmente se quiere hacer eso pero lo tenemos que hacer 1 por uno, revisa igualmente cómo se harían los ajustes si en caso tenemos que mover menos o más cantidad en uno de esos artículos; revisar errores/bugs/duplicados/procesos/códigos/estructura de datos/BD; 1.2–8 metodología».

Work Log (1.1–8):
- 1.2 (averiguar la fricción): la pestaña Traslado (Kardex Racks) es POR ARTÍCULO — buscar código → elegir lote/ubicación → elegir destino; mover una posición entera requiere repetir el ciclo N veces. Ocupación permite traslado por celda pero también artículo por artículo.
- 2 (qué lo genera): el flujo nació centrado en el artículo (locations del ledger por código). No existía la vista inversa «dado el ORIGEN, mueve todo» ni una RPC que trasladara N artículos en una transacción — con el modelo de ledger (movimientos), la atomicidad multi-artículo exige una RPC propia.
- 3 (no se repite en otras pestañas): los «Volver»/deep-links existentes no se tocan; OcupaciónTab.ejecutarTraslado (unitario) intacto; REP tiene su propio traslado por mapa (rep_registrar_traslado) sin cambios; Piso no tiene pestaña Traslado. El nuevo modo es ADITIVO en la misma pestaña (selector «Por artículo» / «Ubicación completa») con componente de estado aislado — el modo clásico conserva su estado al alternar.
- 4 (procedimiento más efectivo): RPC atómica registrar_traslado_ubicacion_kardex (migración 20261111_traslado_ubicacion_completa.sql) que ESPEJA las garantías de registrar_traslado_kardex v8 para N artículos: guard movimientos.crear, advisory locks con la MISMA convención de claves pos/codigo (items ordenados por codigo → sin interbloqueos con unitarios ni con otro masivo), ledger con normalización de ceros y EXCLUSIÓN de INC, fail-fast de TODAS las validaciones antes de la primera fila (todo-o-nada), FEFO server-side por (lote, vencimiento) — cada parte conserva SU fecha —, ajuste derivado EN SERVIDOR (cantidad > stock ⇒ ingreso de ajuste en origen absorbido por el primer lote FEFO; cantidad < stock deja saldo sin filas fantasma), uuid_sync por artículo (índice único parcial intacto), tope 200 artículos. Fallback client-side si la RPC no existe: N traslados unitarios con reparto FEFO local (repartoFefoLotes) + llamada extra de ajuste — mismo contrato que TrasladoTab.doTraslado.
- 5 (sin conflictos): la carga del contenido usa stockEnUbicacion (la MISMA fuente server-side que Ocupación); INC excluido del movimiento (cuarentena) y mostrado como «queda en origen»; destino ocupado es informativo (igual que el unitario); el modal de confirmación muestra ruta, artículos, ajustes e INC; guard anti-carrera de carga (seq ref) para cambios rápidos de origen; 0 cambios en RLS/otros módulos (nueva función, cero riesgo PGRST203 por nombre nuevo).
- 6/7 (experto/ordenado): lógica de datos en lib (itemsTrasladoDesdeUbicacion + repartoFefoLotes + parseTrasladoUbicacionError + trasladarUbicacionCompleta — PURE las primeros, testeables); UI nueva TrasladoUbicacionTab.tsx (cards móvil + tabla desktop, prefilled con stock completo, botones Todo/Nada por fila, badges de ajuste); selector de modo compartido ModoTrasladoSelector. Diff: 3 archivos de código + 1 migración + 1 suite.
- 8 (accesos): E2E TRANSACCIONAL en producción por MAPI (BEGIN…ROLLBACK, huella cero) — APROBADO 9/9: completo multi-lote con fechas intactas (destino 10×2026-12-01 + 5×2027-01-15) y origen 0; INC inmune (queda 7); parcial 12/15 → quedan 3 en el lote correcto; mover MÁS 18/15 → ajuste +3 derivado en servidor con ingreso en origen y destino 18; SIN_STOCK_ORIGEN / SAME_ORIGIN_DESTINATION / CANTIDAD_INVALIDA / ITEMS_VACIOS rechazados con 0 filas escritas; NO_AUTORIZADO sin sesión. El E2E cazó 2 bugs del borrador (columna stock_total fuera de GROUP BY; absorción del ajuste desactivada por la bandera uuid) — corregidos y re-verificados. QA local: tsc 0 · eslint 0 · 54/54 suites (nueva test_traslado_ubicacion.js, 25 checks) · build OK. BD: RLS 31/31, función nueva con firma correcta.

Stage Summary:
- Pestaña Traslado con dos modos: «Por artículo» (intacto) y «Ubicación completa»: eliges el origen, la app carga TODO su contenido (server-side), cada artículo viene prellenado con su stock total — bajas la cantidad para dejar saldo o la subes si físicamente hay más (ajuste automático con ingreso en origen) — eliges destino y confirmas: UNA transacción mueve todo (o nada si algo falla).
- Los lotes conservan su fecha de vencimiento en el destino (FEFO server-side por parte); los INC nunca se mueven en bloque; el resumen del modal y del toast reporta artículos, unidades, ajustes y saldos que quedan.
- Evidencia: E2E transaccional 9/9 en BD de producción + 25 checks unitarios + QA completa verde.
- Deploy: push → producción (verificar version.json).
---
Task ID: rq-editar-autocomplete-20261111
Agent: Main Agent
Task: «me reportan esta situación en almacén insumos, ing cuando quiero agregar no jala el código su descripción (captura: Editar RQ 0000194674, fila con código 57347 sin descripción); revisar errores/bugs/duplicados/procesos/códigos/estructura de datos/BD; 1.2–8 metodología».

Work Log (1.2–8):
- 1.2 (averiguar el error): en Editar RQ (Atención a Línea, almacén INSUMOS), tipear el código de un material NO completaba descripción ni unidad — la descripción solo llegaba si el usuario HACÍA CLIC en la lista de sugerencias; al tipear el código completo y pasar al siguiente campo (Enter/Tab/clic fuera) la fila quedaba con código y cantidad pero descripción vacía (exactamente la fila 57347 de la captura).
- 2 (qué lo genera): RqEditarDialog solo adoptaba el catálogo vía adoptarCatalogo (clic en sugerencia). El ALTA de RQ (RqFotoForm) sí resuelve en cada tecla con buscarCatalogo() — política «al colocar el código que jale la descripción y und del catálogo» (petición explícita del usuario, implementada solo en el alta). Datos descartados como causa: código 57347 EXISTE en catálogo (STRETCH DE ALTO RENDIMIENTO 20 · KG · stock 1 896); catálogo 1 107 filas, 0 sin descripción, 0 duplicados, muy por debajo del tope de paginación (50 K).
- 3 (no se repite en otras pestañas): auditoría de los 9 puntos de entrada de código del app — RqFotoForm ✓ (tecla), RalFotoForm ✓, DevolucionFotoForm ✓, RecepcionItemsEditor ✓, MovimientoForm ✓ (2 puntos), TrasladoTab ✓, StockTab ✓, PisoStockTab ✓ (solo lectura); StockIncTab/StockIncPisoTab son pestañas de consulta sin alta de código. El gap era EXCLUSIVO de RqEditarDialog.
- 4 (procedimiento más efectivo): replicar el patrón probado del alta dentro del editor — resolver buscarCatalogo() EN CADA TECLA del código (tolerante: mayúsculas, espacios, puntuación suelta, ceros a la izquierda, regla histórica 09==9 con desambiguación). Match → descripción+unidad OFICIALES del catálogo; sin match → se limpia SOLO el texto que el autocompletado puso en la sesión (nuevo flag `auto` por fila); lo guardado en la RQ o tipeado a mano jamás se destruye. Extra: si el catálogo llega tarde (diálogo abierto con cache vacío), un efecto completa las filas con código tipeado y descripción vacía cuando el fetch termina.
- 5 (sin conflictos): el flag `auto` vive solo en el estado del componente — el payload para la RPC rq_editar_rq NO cambia (filasAItems ignora el flag); validarEdicionRq intacto (congelados de atendidos, cantidad ≥ atendida, sin duplicados); el resumen pre-guardado muestra las descripciones autocompletadas como cambios (transparente antes de confirmar); sugerencias por clic intactas (adoptarCatalogo también marca auto); 0 cambios en lib/BD/RLS.
- 6/7 (experto/ordenado): un solo archivo tocado (RqEditarDialog.tsx, +58/−7): import buscarCatalogo, flag `auto` en FilaEdicion, editarCodigo() documentado junto a adoptarCatalogo, efecto de catálogo tardío, onChange de descripción marca texto manual (auto=false). Sin cambios de contratos, sin dependencias nuevas.
- 8 (accesos): QA local verde (tsc 0 · eslint 0 · 54/54 suites · build OK) + BD de producción verificada por MAPI: RLS 31/31 tablas con rowsecurity=true, 0 sin RLS; catálogo 1 107 filas = 1 107 códigos distintos (0 duplicados). Deploy: push cd0c9dd → producción (sello verificado en version.json) + E2E del flujo Editar RQ en la app publicada.

Stage Summary:
- Editar RQ ahora se comporta igual que el alta: tipeas el código (aunque venga con espacios, punto o ceros) y la descripción y unidad OFICIALES aparecen solas al instante; el clic en sugerencias sigue funcionando para códigos parciales.
- Nunca borra lo que el usuario escribió a mano ni lo guardado en la RQ; solo reemplaza texto que él mismo autocompletó en la sesión.
- Evidencia: fila 57347 de la captura → STRETCH DE ALTO RENDIMIENTO 20 · KG autocompletado; 54/54 suites; RLS 31/31; 0 duplicados en catálogo.
- Deploy: push → producción (verificar version.json).
---
Task ID: recepcion-excel-rango-20261111
Agent: Main Agent
Task: «Actualmente en recepción se genera un Excel por cada guía, podría generar un Excel por el rango de fechas que seleccione y por los turnos dentro de esa selección; revisar errores/bugs/duplicados/procesos/códigos/estructura de datos/BD; 1.2–8 metodología; 9 Almacén INSUMOS; 10 Módulo Recepción».

Work Log (1.2–8):
- 1.2 (averiguar la fricción): el módulo Recepción exporta SOLO guía por guía (botón Excel por fila → exportarGuiaExcel). Consolidar un mes exige descargar N archivos uno a uno.
- 2 (qué lo genera): el export existente nació POR DOCUMENTO (pedido anterior "que la guía genere un excel"). No existía una vista agregada por rango ni un fetch que trajera el histórico completo — listarRecepciones pagina a 50 filas para la LISTA, no para reportes.
- 3 (no se repite en otras pestañas): inventario de los 4 generadores Excel del app — guia-excel (por guía, se conserva), atencion-excel (reporte global del Dashboard, sin rango de fechas por turno), FefoTab (1 hoja). El gap era exclusivo de Recepción; la regla del turno ya estaba centralizada en lib/rackly/turno.ts (calcularTurnoRecepcion, Lima) y se REUTILIZA — cero duplicación de la regla.
- 4 (procedimiento más efectivo): misma arquitectura probada de guia-excel/atencion-excel — armado PURO en lib + writeFile en el navegador (xlsx-js-style). Data access nuevo listarRecepcionesRango en modulos.ts (paginado 1000/lote, tope 50 000 filas, filtro tipo_recepcion + rango INCLUSIVO de fecha de documento, orden fecha/created_at DESC — cubierto por el índice idx_recepcion_tipo_fecha). El filtro por TURNO se aplica en el cliente (el turno NO es columna: se deriva del created_at con la regla de Lima) — sin duplicar la regla en SQL.
- 5 (sin conflictos): el Excel por guía queda INTACTO (mismo botón por fila); el nuevo botón es ADITIVO en la barra de filtros; el export respeta la PESTAÑA activa (guías ≠ devoluciones, misma separación del listado); 0 cambios en RLS/BD/permisos (solo SELECT); los estilos corporativos (EST + clonar) se COMPARTEN desde guia-excel — un solo look, sin paletas duplicadas.
- 6/7 (experto/ordenado): lib nueva recepcion-excel-rango.ts (filtrarPorTurnos + agruparTurnos + filasRangoAExcel + guiasRangoAExcel + nombreArchivoRango + construirHojaResumenRango + construirLibroRango + exportarRangoExcel — puras las primeras, testables); Hoja Resumen = filtros aplicados + RESUMEN POR TURNO (documentos/filas/cantidad de T1 y T2) + tabla de TODOS los documentos; Hoja Artículos = todas las filas con contexto de documento (fecha/tipo/Nº/empresa/placa) + paleta a su columna + turno por fila. UI: diálogo Desde/Hasta (default mes en curso) + checkboxes T1/T2 + nota de la regla del turno; guardas rango invertido y sin turnos; toast con conteos. Suite nueva test_recepcion_excel_rango.js (32 checks, incluye generar el .xlsx REAL y releerlo).
- 8 (accesos): QA local verde (tsc 0 · eslint 0 · 55/55 suites · build OK); BD por MAPI: RLS 31/31, índice de rango presente, recepcion_registros 4 882 filas (4 875 guías + 7 devoluciones) — un mes de histórico entra holgado en el fetch paginado; deploy verificado por version.json + E2E en la app publicada (abrir diálogo, exportar con ambos turnos y solo T1, toasts con conteos correctos).

Stage Summary:
- Recepción ahora tiene «Excel por rango»: eliges Desde/Hasta (default: mes en curso), marcas los turnos (T1/T2) y descargas UN solo libro con todo — el resumen por turno muestra cuántos documentos/filas/cantidad dejó cada turno dentro de tu selección.
- El rango filtra por la FECHA del documento; el turno por la HORA de registro (T1 07:20–19:20 · T2 19:21–07:19, hora Lima) — la misma regla del Excel de cada guía.
- El Excel por guía sigue igual (botón Excel de cada fila); exportar NO modifica datos (solo lectura).
- Evidencia: 32 checks nuevos (xlsx real re-leído) · 55/55 suites · RLS 31/31 · E2E en producción con conteos correctos.
- Deploy: push → producción (verificar version.json).
---

Task ID: recepcion-excel-rango-verificacion-20261111
Agent: Main Agent (sesión de verificación)
Task: Verificación integral del feature «Excel por rango de fechas + turnos» (implementado en cbc1247/643241a) + revisión de toda la app (paso 9).

Work Log:
- Entorno reconstruido (sandbox reciclado): repo sincronizado a origin/main 643241a (el snapshot sintético local se descartó; producción manda), npm install, scripts/sb_mapi.py recreado.
- Sello de producción verificado ANTES de tocar nada: version.json = 202611111632-643241a (feature YA desplegado — esta sesión no modifica código del feature).
- FALSA ALARMA documentada: el renderizado del tool output mostraba `const , m]` en turno.ts (parecía error de sintaxis); verificación byte a byte con od -c + blob SHA local=remoto (d717d30b) + GitHub API demostraron que el archivo está CORRECTO (`const [h, m]`). Lección: ante "errores" raros de sintaxis, verificar bytes y correr el compilador real, no fiarse del texto renderizado.
- QA re-corrida en entorno limpio: tsc --noEmit 0 (con el TypeScript real del proyecto — el npx tsc previo instalaba el placeholder tsc@2.0.4 con exit 0: corridas "tsc 0" de sesiones recientes eran no-verificables), eslint 0, 55/55 suites, npm run build OK.
- Auditoría BD (MAPI): RLS 31/31 tablas habilitadas; catalogo 1107 = 1107 distinct códigos, 0 duplicados, 0 vacíos; recepcion_registros 4893 (4875 guías + 18 devoluciones), 8 índices incl. idx_recepcion_tipo_fecha (soporta el rango del export); conteos sanos en movimientos/rq_*/piso_*/rep_*; rep_stock vacía = módulo REP sin ingresos aún (estado inicial, no defecto).
- HALLAZGO ANALIZADO (duplicados intra-batch): 18 documentos (2026-10-13 → 11-05) tienen filas idénticas (codigo+lote+cantidad+created_at+observaciones) dentro del MISMO lote. Anatomía del caso extremo (T067-0015826): 24 filas = 4 lotes × 4-7 rolls del mismo código/lote — patrón LEGÍTIMO de recepción multi-roll (una fila por rótulo QR). Las 3 protecciones ya existen: uuid_sync idempotente (reintentos), hayDuplicadosRecientes (vs BD <60 s, aviso), anti-guía-duplicada (Task 23, aviso). El hueco "intra-batch" ES el caso de uso normal (rolls múltiples) — no procede bloqueo; los casos con marca «Paleta i/N» repetida (3 docs) quedan OBSERVADOS para cuadre físico opcional del usuario (sin evidencia de bug de software; el contenido del registro es fiel a lo digitado).
- E2E EN PRODUCCIÓN (rackly.pages.dev, sello 643241a) — 7 verificaciones: 1) diálogo con defaults correctos (mes en curso, T1+T2); 2) export T1+T2 = 98 docs · 2047 filas, VALIDACIÓN CRUZADA contra BD con SQL independiente (regla turno Lima 07:20-19:20 → minutos 440..1160): T1 881 filas / 32 800 407,28 · T2 1166 / 56 611 117,33 — coincidencia EXACTA; 3) hoja Resumen (filtros + por turno + documentos con turno(s) por doc); 4) hoja Artículos 2047 filas × 20 columnas exactas, turno por fila, paletas incluidas, orden fecha DESC; 5) export SOLO T1 = 40 docs · 881 filas · cero T2; 6) pestaña Devoluciones respeta prefijo/tipo (14 docs · 24 filas); 7) cero errores de consola. Evidencia: 3 .xlsx re-leídos con openpyxl (download/e2e-recepcion-excel-rango/).
- Excel por guía INTACTO (botón por fila verificado en producción).

Stage Summary:
- El feature «Excel por rango + turnos» está en producción y VALIDADO numéricamente contra la BD (no solo visualmente): los conteos por turno y cantidades coinciden al centavo.
- La app completa pasó la revisión (QA verde en entorno limpio + BD íntegra + RLS 31/31 + E2E sin errores).
- Observación abierta (opcional, decisión del usuario): 18 guías con filas multi-roll idénticas para cuadre contra el ERP si se desea; el software ya previene re-registros accidentales por las 3 vías.
---

Task ID: rep-catalogo-supervisores-20261111
Agent: Main Agent
Task: «La información que tiene el catálogo no le carga a los supervisores» (1.1–10; 9 = Almacén Repuestos, 10 = Módulo Recepción).

Work Log (1.2–8):
- 1.2 (averiguar): en Repuestos el "catálogo" es rep_articulos (16 517 filas, TODAS importadas el 2026-11-09 — el almacén nació hace 2 días) y Recepción jala descripción/UM con repArticuloPorCodigo. Reporte: a los SUPERVISORES no les carga.
- 2 (qué lo genera) — descartes con evidencia: (a) RLS: la política rep_articulos_select exige tiene_permiso(uid,'repuestos.ver') — verificado por base64 que el permiso es EXACTO y simulando la sesión authenticated con JWT de un supervisor (set_config role+jwt dentro de función wrapper, porque en el SELECT list set_config no garantiza orden y la prueba ambigua corría como owner): el supervisor VE los 16 517 artículos; (b) matriz de permisos: permiso_defecto_rol da 'repuestos.ver' a TODOS los roles y el espejo del cliente (permisos.ts) está sincronizado; (c) 0 overrides 'repuestos%' en user_permisos; (d) sin caché del catálogo en el código REP; (e) data íntegra: 0 duplicados, 0 descripciones/UM vacías, 0 inactivos.
- CAUSA RAÍZ (confirmada en código + datos): PreIngreso.tsx line 92 — visibleRepuestos = (esAdmin || perfil.accesoRepuestos === true) && puede('repuestos.ver'). El almacén REPUESTOS es de «alta controlada» (default acceso_repuestos=false, comentario del propio código); el módulo Usuarios lo habilita por usuario (RPC establecer_acceso_almacen). 7 de los 8 supervisor_almacen tenían acceso_repuestos=FALSE (solo Diego Remicio y un auxiliar lo tenían) → el almacén ni les aparecía → el catálogo «no les cargaba». El admin (Miguel) no los había habilitado.
- 3 (no se repite): el flag de acceso SOLO gobierna el pre-ingreso (PreIngreso + display en UsuariosTab); los permisos granulares del almacén ya venían bien por defecto para el rol. INSUMOS usa default abierto (acceso_insumos !== false) — no afectado.
- 4 (procedimiento más efectivo): configuración, no código — el mismo UPDATE que hace la RPC establecer_acceso_almacen (verificado: guard de permiso para el browser; por MAPI corre como owner y el efecto es idéntico), sin cambiar diseño ni código.
- 5 (sin conflictos): UPDATE quirúrgico solo acceso_repuestos=true para perfiles con rol supervisor_almacen (RETURNING: 8 filas — Diego idempotente). acceso_insumos intacto. Nada más del app lee el flag para lógica. El flujo completo de Recepción REP quedó accesible por RLS para el rol (SELECT ver · INSERT/UPDATE crear/gestionar · DELETE eliminar — supervisores los tienen todos).
- 8 (accesos) QA: tsc 0 · eslint 0 · 55/55 suites (mismo commit 3a1f7a4 ya desplegado — cero cambios de código, build ya certificado en producción). E2E en producción: login → pre-ingreso OK; Repuestos → Recepción → lookup código 62008 → «PANEL DE VIDRIO DE PANTALLA TACTIL… SIEMENS» + UM autocompletados (el flujo exacto que ejercerán los supervisores; RLS idéntica por rol).
- Nota técnica del E2E: el fill/type no actualizaba el estado React del input de código (botón disabled con el DOM ya poblado); resuelto con setter nativo + dispatchEvent('input') vía eval.

Stage Summary:
- Los 8 supervisores de almacén YA VEN el almacén REPUESTOS (refrescar la página basta — el perfil se re-lee al montar). El catálogo (16 517 artículos) y toda la Recepción de Repuestos quedan operativos para su rol.
- El «alta controlada» se mantiene: cada usuario nuevo de Repuestos requiere la habilitación en Usuarios (acceso a almacenes) — así se diseñó y así queda; no se cambió código ni diseño.
- Pendiente opcional para el admin: el coordinador_operaciones (Victor Vernazza) sigue sin acceso a Repuestos — habilitarlo igual desde Usuarios si corresponde.

---

## atencion-tablero-excel-ral-editar-lineas-oficiales — 2026-11-12

Pedido (Almacén INSUMOS · Módulo Atención): (A) Excel con el «tablero de las atenciones por línea y materiales auxiliares» como el pivot que hoy presentan (imagen: filtros FECHA/TURNO; columnas LINEA·PRODUCTO·sku·DESCRIPCION·Suma de CANTIDAD) · (B) poder EDITAR los RAL «así como los RQ» · (C) lista desplegable oficial de líneas (Línea 1 a 20 y Materiales auxiliares) al registrar el RQ, porque «al digitalizar puede que no sea tan exacto». Más la revisión integral de siempre (errores/bugs/duplicados/módulos/BD).

- 1.1 (revisión) — hallazgos reales: (a) `rq_atencion_tomas.turno` VACÍO en 309/309 filas: la columna existe pero la RPC rq_atender_item no la envía (solo la ruta tránsito pasaba p_turno) → el pivot por turno de salida era imposible y la hoja «Salidas (tomas)» del Excel salía con «Turno salida» vacío; (b) datos de línea SUCIOS por texto libre+OCR: RQ con «LINEA 2» (57), «JARABES» (58)… y RAL con «AUXILIAR» (33), «D4 MATERIA PRIMA E INSUMOS», «BS N MATERIALES AUXILIARES APROBADO POR '»…; (c) botón «Editar RQ» visible para roles que la RPC rq_editar_rq rechaza (la matriz concede atencion.editar a todos, pero la RPC exige rol de supervisión) → botón que siempre fallaba; (d) duplicado REAL de RAL: 8455 ×2 a 46 segundos por el mismo usuario (y 8422 ×2 a 6 h) — el alta RAL no tenía el guard DB1 que la RQ sí; (e) índice duplicado idx_ral_items_ral_id (el compuesto (ral_id, orden) lo cubre); (f) sin huérfanos ral_items→rals (0).
- A (tablero): nuevo `atencion-tablero.ts` (agregación PURA) + `exportarExcelTablero` en atencion-excel.ts + diálogo `TableroExcelDialog` con botón «Tablero por línea» en el Dashboard (junto a Exportar Excel). Fuente = LEDGER de salidas (tomas): lo que físicamente salió a la línea, NETO (reversas −). FECHA = día de la salida en hora Lima; TURNO = columna del ledger o DERIVADO con la regla del almacén (07:20–19:20 Lima → T1, igual que el Excel por rango de Recepción). LINEA se agrupa con el catálogo canónico (`lineas.ts`); los históricos sin mapeo (JARABES, LINE4 13…) salen tal cual — nunca se re-etiquetan datos. PRODUCTO vacío en RQ auxiliares → «MATERIALES AUXILIARES» (como su pivot). Tomas de RQ eliminadas → grupo «(sin RQ)» (no se pierde el movimiento físico). Subtotal por línea + TOTAL GENERAL.
- B (edición RAL): migración `20261112_atencion_ral_editar.sql` — RPC `ral_editar` (espejo exacto de rq_editar_rq: guard tiene_permiso('atencion.editar') + roles admin/supervisores/coordinador, diff declarativo de materiales, reglas Task 34/26 íntegras, SIN defaults por la convención PGRST203) + columna NUEVA `rals.ediciones` (auditoría máx 20). UI: `RalEditarDialog` nuevo (encabezado sin turno + centro de costos SIEMPRE editable — es metadata de costos, no identidad física; catálogo con autocompletado; reversa guiada dentro del editor) + botones «Editar RAL» en la lista unificada (desktop y móvil) y en el detalle. Aplicada en producción y verificada (guard NO_AUTORIZADO sin sesión ✓).
- C (líneas oficiales): `lineas.ts` = única fuente (21 opciones) + normalizador (L7/L-07/LINEA 02/auxiliar/mat aux → canónico; JARABES/TANQUES/D4 → sin match, el usuario elige — nunca se adivina). RqFotoForm: Select oficial reemplaza el texto libre; el OCR se normaliza y si no hay match confiable avisa «Línea «X» no reconocida — selecciona de la lista». RqEditarDialog: mismo select + opción «(histórico)» con el valor actual para no mutar datos al abrir→guardar sin tocar.
- Correcciones aplicadas: trigger `trg_rq_tomas_turno` (BEFORE INSERT llena turno cuando llega vacío) + BACKFILL determinista de los 309 históricos (171 T1 / 138 T2 desde creado_en Lima) + hoja Salidas del Excel deriva el turno cuando falta; `puedeEditarSolicitudes()` (espejo del guard de las RPCs) alinea el gating del botón Editar en RqDetalle/panel/RAL; guard anti-duplicado de RAL en alta y edición (advertencia, no bloqueo — misma política DB1 de la RQ) vía `buscarRalPorDocumento`; DROP del índice duplicado.
- QA: tsc 0 (binario real) · eslint 0 · 58/58 suites (55 previas + 3 nuevas: lineas_tablero 48 checks, ral_editar 25, atencion_excel_tablero 15 — lección: el stub de rpc espera la respuesta PostgREST COMPLETA {data,error}) · build OK. Commit feat 618d665 sin version-sello.
- E2E en producción (sello 202611112349-618d665): T1 dropdown = exactamente Línea 1..20 + Materiales auxiliares (21) y selección Línea 7 ✓; T2 Tablero: Excel 102 filas, formato LINEA·PRODUCTO·sku·DESCRIPCION·Suma de CANTIDAD con subtotales y TOTAL GENERAL = 7 536 605.62 para 2026-11-11 — CRUCE contra BD sum(cantidad) del día = 7 536 605.62 EXACTO (99 tomas, 38 RQ); T3 edición RAL 26532 guardada con auditoría en rals.ediciones (quién/cuándo/resumen) ✓; T4 edición RQ 0000007591: «LINEA 7 (histórico)» preservado → migrado a «Línea 7» con auditoría ✓; consola limpia, 0 errores de página.
- Nota: las 11 tomas huérfanas (RQs eliminadas tras atender) quedan visibles en el tablero como «(sin RQ)» — decisión: el ledger es registro físico, no se borra.

---

## atencion-turno-elegible-jarabe-tablero-suma — 2026-11-12

Pedido (Almacén INSUMOS · Módulo Atención, 2.ª iteración del tablero): (A) al registrar un QR o RAL que la selección de fechas/turno YA NO sea automática — «los registradores elijan el turno al cual pertenece ese ral o rq»; el RAL no tenía opción de turno · (B) «En RAL son Materiales auxiliares» (aclaración de dominio) · (C) «en la lista desplegable de RQ agregar "Jarabe"» · (D) «el reporte de tabla en dashboard haga la suma de los artículos del mismo código atendido en cada línea y quite los totales de cada línea» · más la revisión integral de siempre.

- 1.1 (revisión) — hallazgos reales: (a) el wizard QR (RqAtenderQrWizard) pasaba `turno: calcularTurno()` = **'Día'/'Noche'** a rq_atender_lote → en `rq_atencion_tomas.turno` (columna T1/T2) habrían caído valores de OTRA convención; sin tomas del wizard aún en producción (354 filas todas T1/T2) — bug latente corregido antes de que existiera; (b) las REVERSAS del puente (RqDetalle + RqEditarDialog) usaban el mismo `calcularTurno()` → misma inconsistencia; (c) el form RQ pre-seleccionaba el turno derivado de la hora del reloj (etiqueta «Turno (automático)») aunque el registrador no lo eligiera; (d) test_atencion_reporte era dependiente de la FECHA REAL: `serieRqsPorDia` usa new Date() y la fixture '2026-10-29' salió de la ventana de 14 días el 2026-11-12 (pasaba el día anterior) — suite fallaba sin ningún cambio de código; (e) BD: `rals` sin columna turno; 70 RQs históricos con líneas «JARABES»/«TANQUES DE JARABE …» sin mapeo.
- A (turno elegible): RQ manual → Select «Turno» VACÍO con placeholder «Selecciona el turno…» + validación obligatoria (ya no se pre-llena del reloj); «Turno del RQ (hoja)» queda como estaba (es la hoja física 004/005). Wizard QR → selector nuevo «Turno de la atención» en la pestaña Resumen (obligatorio, botón deshabilitado hasta elegir, se muestra en la confirmación y se RESETAEA tras registrar — nunca heredado). RAL → columna NUEVA `rals.turno` + RPC `ral_crear_completa` (valida T1/T2, vacío permitido por compat) + `ral_editar` (bloque dedicado: solo aplica T1/T2, nunca borra el guardado) + backfill de 79 históricos derivado de created_at (Lima: 53 T1 / 26 T2) + select obligatorio en RalFotoForm + select en RalEditarDialog (auditoría «Turno» en ediciones) + «Turno:» en RalDetalle.
- B (convención T1/T2): las reversas ahora pasan `calcularTurnoRecepcion(new Date())` — `rq_atencion_tomas.turno` solo guarda T1/T2 en TODAS las rutas (trigger solo llena si llega vacío).
- C (Jarabe): `LINEA_JARABE='Jarabe'` como opción 22 de la lista oficial (tras Materiales auxiliares) + normalizador `/jarab/ → 'Jarabe'` (pedido explícito: los 70 RQs «JARABES»/«TANQUES DE JARABE GASEOSA»/«JARABE DE PULP» agrupan con la canónica en tablero y listados). Nota visible en el form RAL: «Los RAL son atenciones de Materiales auxiliares» (+ «Tipo: Materiales auxiliares» en el detalle).
- D (tablero): `construirTablero` agrupa por **línea+sku** (ya no línea+producto+sku): el MISMO código se suma en UNA fila por línea aunque salió para varios productos (columna PRODUCTO muestra el dominante = mayor cantidad neta, empate → alfabético; DESCRIPCION igual). Excel (`tablaTablero`): SIN las filas «Total <línea>» (pedido: quitar los totales de cada línea) — solo cierra con TOTAL GENERAL; estilos limpiados. Subtotales siguen calculándose en el tipo (pruebas/futuro) pero ya no se imprimen. Diálogo con texto actualizado.
- QA: tsc 0 · eslint 0 · **58/58 suites** (lineas_tablero y atencion_excel_tablero actualizadas: 22 opciones, suma por código, producto dominante, sin filas «Total »; test_atencion_reporte con fixtures RELATIVOS a hoy — bug de dependencia temporal corregido) · build OK. Commit feat **5678f59** sin version-sello.
- Migración aplicada y verificada por MAPI: ALTER rals.turno + backfill 79 (53/26) + COMMENT + 2 CREATE OR REPLACE FUNCTION (ral_crear_completa, ral_editar) — RLS 4/4 tablas del módulo sigue ON, sin cambios de políticas.
- E2E en producción (sello **202611121302-5678f59**): T1 form RQ → Turno «Selecciona el turno…» (no pre-lleno) con T1/T2 y Línea = **22 opciones con «Jarabe»** ✓; T2 form RAL → selector Turno T1/T2 presente + nota «Los RAL son atenciones de Materiales auxiliares.» ✓; T3 diálogo Tablero → «…el mismo código se suma en UNA fila por línea…, con total general y sin totales por línea» + lista oficial con Jarabe ✓; consola limpia, 0 errores. Cruce BD 2026-11-11: 72 grupos línea+sku (con RQ) = 9 524 779.37 + 7 tomas huérfanas «(sin RQ)» = 196 559.10 → 9 721 338.47 = sum(cantidad) bruta EXACTO (la agregación por código no altera el neto).
- Nota wizard QR: el selector vive en la pestaña Resumen (aparece al menos con 1 toma en el carrito) — verificado por suites + código; el flujo completo exige escanear QR físico de una guía.

---

## atencion-ral-linea-default-rq-turno-unico — 2026-11-12 (3.ª iteración)

Pedido (Almacén INSUMOS · Módulo Atención, con imagen del form RAL resaltando «Línea»): (A) en el registro de RAL la sección Línea por DEFECTO «Materiales auxiliares» y si hay que escoger una línea, de una LISTA DESPLEGABLE con Línea 1 al 20 y Jarabe · (B) en la selección de turno en RQ «que solo sea una selección de Turno» · más la revisión integral de siempre.

- 1.1/1.2/2 (análisis): la Línea del RAL era INPUT LIBRE (históricos: AUXILIAR 33, RAL 17, PS MATERIALES AUXILIARES 2…) y el RQ tenía DOS selects de turno («Turno» + «Turno del RQ (hoja)» 004/005) — confuso tras hacer el Turno elegible en la 2.ª iteración. Mapeo de turnoRq: solo 2 superficies de ESCRITURA (RqFotoForm alta, RqEditarDialog edición); los displays (lista unificada RqAtencionPanel, RqDetalle, Excel «Turno hoja») ya pintan `turnoRq || turno` con aviso SOLO si difieren; el filtro del listado usa `or(turno_rq.eq.X, and(turno_rq.is.null, turno.eq.X))`.
- A (RAL línea): RalFotoForm — Input → Select de la lista oficial con **default «Materiales auxiliares»**; el OCR se NORMALIZA (normalizarLinea: «PS MATERIALES AUXILIARES»→canónica) y sin match confiable queda el default (nunca se inventa línea). RalEditarDialog — mismo Select con la opción extra «(histórico)» (patrón del RqEditarDialog) para no mutar los históricos al abrir→guardar sin tocar; históricos sin línea muestran placeholder informativo (ítem disabled, nunca se guarda un sentinel). Sin migración: columna rals.linea ya existía; el default es de UI.
- B (RQ un solo Turno): RqFotoForm — eliminado el campo «Turno del RQ (hoja)»; el impreso 004/005 que leía el OCR ahora PRE-ELIGE el único Turno (editable, con nota bajo el campo). En el ALTA `turno_rq` se guarda como ESPEJO del turno elegido → el filtro del listado, la columna TURNO de la lista y el Excel «Turno hoja» quedan consistentes sin tocar BD. RqEditarDialog — eliminado el campo y YA NO SE ENVÍA turno_rq en la edición (la RPC rq_editar_rq solo aplica campos presentes): los históricos con hoja distinta NO se mutan al editar cualquier otra cosa.
- 3 (no se repite): revisados TODOS los usos de turnoRq — displays intactos por diseño; wizard QR no lo usa; Dashboard Excel mantiene ambas columnas para históricos (nuevas RQs muestran el mismo valor en ambas). El Turno único aplica solo al RQ (RAL ya tiene el suyo desde la 2.ª iteración).
- 5 (sin conflictos): cero cambios de BD/RLS/RPC; solo UI + payload. QA: tsc 0 · eslint 0 · **58/58 suites** · build OK. BD auditada: RLS 31/31 ON; duplicados de documento RAL (8422/8455/…) son los conocidos del guard no bloqueante — sin nuevos; históricos de línea intactos.
- E2E en producción (sello **202611121349-490a920**, commit feat **490a920**): T1 form RAL → combobox «Por defecto Materiales auxiliares…» muestra **«Materiales auxiliares» seleccionado por defecto** y el dropdown tiene **22 opciones** (Línea 1–20 · Materiales auxiliares · Jarabe) ✓; T2 form RQ → **UN solo campo «Turno»** («Selecciona el turno…» + nota del impreso 004/005), sin «Turno del RQ (hoja)» ✓; consola limpia, 0 errores.

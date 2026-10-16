# AlignerOS · app paralela

Prototipo local para organizar el trabajo de un laboratorio de alineadores.

## Abrir

Desde esta carpeta, ejecutá `node serve-preview.cjs` y abrí `http://127.0.0.1:4174`. No necesita paquetes ni internet.

La demo se guarda en el almacenamiento local del navegador con la clave `aligneros_next_demo_v8`. **Restablecer demo** repone los casos ficticios.

## Flujo

- **Mi clínica:** avanzar por tandas, con cantidades y piezas independientes para cada arco.
- **Fabricación completa:** desde la tarjeta de un caso, seleccionar varias piezas y dejarlas listas en una sola operación. Si una falla, se marca la etapa exacta para rehacerla; las tandas por fase siguen disponibles.
- **Otras clínicas:** completar alineadores y contenciones, registrar despacho y marcar la entrega. El caso aparece en **Archivadas** desde el despacho; queda disponible para confirmar la recepción y para abrir otra etapa después.
- **Reperfilado posterior:** buscar el caso en **Archivados** y elegir **Nueva etapa**. Conserva el código, las piezas y la actividad previa; las etapas adicionales se numeran consecutivamente y vuelven al taller como un caso activo.
- **Identificación:** cada pieza incluye etapa, arco y número (`E1-SUP-3`, `RP2-INF-2`, `RP3-SUP-1`). Los intentos quedan asociados a su pieza.
- **Alineador 0:** opcional por arco, para ataches; usa plancha de 0,5 mm.
- **Contenciones:** una por arco activo al cerrar cada etapa; usan plancha de 1 mm.
- **Materiales:** descuenta por pieza e intento y guarda movimientos locales. No deja producir si falta stock.

Las cantidades de materiales y rendimientos son de demostración; ajustar antes de usar con casos reales. La app no se conecta a Firebase, Supabase, API ni a la base de datos de la aplicación existente.


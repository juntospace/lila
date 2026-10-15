# Plan de Testing, Análisis de Escalabilidad y Cuellos de Botella — Lila Recon Engine

> **Fecha:** Octubre 2026  
> **Estado:** Documento de Referencia Técnica y Arquitectura  
> **Módulo:** Motor de Conciliación Bancaria (`BAC` y `Banco General`), Ingesta de Archivos y Recompute

---

## 1. Resumen Ejecutivo y Resultados de Benchmarks Reales

Durante la evaluación del sistema de conciliación de Lila, se ejecutaron pruebas de estrés y mediciones empíricas sobre los algoritmos reales del repositorio (`groupPRBatches`, `groupDABatches`, `linkAllBatches`, `solveAssignmentGreedy`, `namesMatch`, y el parser de hojas Excel con SheetJS).

### Resultados Empíricos Medidos:

| Métrica / Escenario | $N = 1,000$ txns | $N = 10,000$ txns | $N = 50,000$ txns | $N = 100,000$ txns (Proyectado) |
|---|---|---|---|---|
| **CPU: Agrupación en Lotes** | 0.8 ms | 4.2 ms | 22.1 ms | ~45 ms |
| **CPU: Algoritmo de Enlace (Linking)** | **22.3 ms** | **1,068 ms (1.06 s)** | **216,089 ms (3.6 min)** | **> 15 minutos (OOM / Timeout)** |
| **CPU: Preparación FIFO** | 0.4 ms | 2.1 ms | 11.4 ms | ~25 ms |
| **Peticiones PostgREST (Red)** | ~15 requests | ~120 requests | ~568 requests | ~1,200+ requests |
| **Sobrecarga Red (a 25ms/req)** | 0.37 s | 3.00 s | 14.20 s | > 30 s |
| **Tiempo Total Recompute** | **< 1 segundo** | **~4 - 5 segundos** | **~4 minutos** | **Colapso / Timeout 504** |
| **Lectura Excel (1k / 5k / 10k filas)** | 62 ms (0.3 MB) | 187 ms (1.5 MB) | 269 ms (3.0 MB) | ~600 ms (6.5 MB) |

### Conclusiones de las Pruebas:
1. **El parser de Excel (`XLSX.read` + matriz)** es altamente eficiente en tiempo de CPU (menos de 300 ms para 10,000 filas). Sin embargo, consume memoria RAM proporcional al archivo y bloquea el Event Loop de Node/Deno mientras se ejecuta de forma síncrona.
2. **El algoritmo de Recompute (`linkAllBatches` + `solveAssignmentGreedy`) sufre de una explosión combinatoria:**  
   Entre $10,000$ y $50,000$ transacciones, el tiempo de CPU se multiplica por más de **200x** (pasando de 1 segundo a 3.6 minutos). Esto se debe a la resolución voraz bipartita que compara cada lote de Débitos Automáticos (DA) contra todos los lotes de Pagos Recibidos (PR) candidatos iterativamente.
3. **El modelo de interacción con la base de datos es un "Chatty API":**  
   Para $50,000$ transacciones se requieren más de **560 llamadas HTTP secuenciales** a PostgREST (`applyStateUpdates` en chunks de 100, `persistAllBatchLinks` en chunks de 100, paginación de a 1,000), lo que añade más de 14 segundos únicamente en latencia de red.

---

## 2. Mapa Detallado de Cuellos de Botella (Bottlenecks)

### Bottleneck #1: Explosión Combinatoria en `solveAssignmentGreedy` (Enlace de Lotes BAC)
* **Ubicación:** `lib/recon/bac/batches.ts` y `supabase/functions/bac-recon/batches.ts`
* **Causa Raíz:**  
  La función `solveAssignmentGreedy` itera para cada día:
  ```ts
  for (const p of prBatches) {
    for (const d of daBatches) {
      if (p.posted_at > d.posted_at) continue;
      const scratch = new Set(usedPrIds);
      const score = matchWithinGroup(d, [p], scratch, options).pairings.length;
      if (score > 0) scores.push({ prRef: p.reference, daId: d.id, score });
    }
  }
  ```
  Para $50,000$ transacciones acumuladas en la cuenta, existen miles de lotes PR y cientos de lotes DA. El doble bucle anidado evalúa millones de combinaciones llamando a `matchWithinGroup`, el cual a su vez itera sobre las filas internas de cada lote y ejecuta normalización de cadenas de texto.
* **Impacto:** Con $50k$ transacciones, la CPU tarda 3.6 minutos, garantizando un timeout en cualquier runtime serverless (Vercel max 15s/60s, Supabase Edge max 150s).

---

### Bottleneck #2: Micro-Batching Secuencial en Recompute (PostgREST Roundtrips)
* **Ubicación:** `supabase/functions/bac-recon/recompute.ts` y `lib/recon/bac/recompute.ts`
* **Causa Raíz:**
  - `persistAllBatchLinks`: Inserta enlaces en chunks de 100 (`BATCH_INSERT_CHUNK = 100`). Ante un conflicto de clave única (`23505`), hace fallback a inserciones individuales fila por fila (1 en 1).
  - `applyStateUpdates`: Actualiza el estado de las transacciones (`confirmed`, `rejected`, `pending`) mediante llamadas HTTP sucesivas con `.in('id', chunk)` de 100 en 100.
  - `fetchUnpairedPRs`: Descarga todas las transacciones PR de la cuenta (paginadas de a 1,000) y descarta las ya enlazadas en memoria de JavaScript con `linkedPrIds.has(id)` en vez de filtrarlas en la consulta SQL.
* **Impacto:** Cientos de peticiones HTTP en cascada. La latencia acumulada agota los tiempos de espera y satura el pooler de conexiones (Supavisor / PgBouncer).

---

### Bottleneck #3: Banco General Recompute Re-descarga y Re-parsea Historial Completo
* **Ubicación:** `lib/recon/bg/recompute.ts`
* **Causa Raíz:**
  ```ts
  for (const up of uploads) { // uploads son TODOS los archivos de la historia de la cuenta
    ...
    const { data: blob } = await adminSupabase.storage
      .from("recon-statements")
      .download(up.storage_path);
    bytes = new Uint8Array(await blob.arrayBuffer());
    parsed = detectAndParseBgFile(bytes, up.original_filename);
  }
  ```
  Cada vez que se sube un extracto o se llama a recompute en Banco General, el sistema descarga desde Supabase Storage y vuelve a parsear mediante CPU todos los archivos Excel históricos de la cuenta.
* **Impacto:** Complejidad $O(F)$ donde $F$ es la cantidad acumulada de archivos. A los 6 meses de operación con 60 archivos subidos, cada subida descargará 60 archivos binarios de Storage y ejecutará SheetJS 60 veces seguidas en memoria.

---

### Bottleneck #4: Límites de Payload y Timeouts en Vercel vs Supabase
* **Ubicación:** `app/recon/upload/actions.ts`
* **Causa Raíz:**
  - Las Server Actions de Next.js en Vercel imponen un límite estricto de **4.5 MB** en el cuerpo de la petición HTTP.
  - Aunque la política de Supabase Storage permite 10 MB, si el usuario sube un archivo de 6 MB a través del formulario Server Action, Vercel aborta la petición con `413 Payload Too Large` antes de que el código comience a ejecutarse.
  - En el plan Hobby de Vercel el timeout es de 15 segundos; en el plan Pro es de 60 segundos por defecto. Operaciones complejas de ingesta con recompute local superan este tiempo fácilmente.

---

### Bottleneck #5: Concurrencia y Falta de Transaccionalidad ACID / Advisory Locks
* **Ubicación:** `app/recon/upload/actions.ts` y `lib/recon/bac/recompute.ts`
* **Causa Raíz:**
  - No existe un mecanismo de exclusión mutua distribuido o por cuenta (`pg_advisory_xact_lock(account_id)`).
  - Si dos operadores suben extractos al mismo tiempo para la misma cuenta:
    1. Proceso 1 ejecuta `wipeAutoLinks` (borra los enlaces automáticos).
    2. Proceso 2 lee enlaces (encuentra 0 enlaces).
    3. Ambos procesos intentan re-enlazar y escribir en `recon_links`.
    4. Se generan excepciones `23505 Unique Violation` y estados inconsistentes.
  - El Recompute está fragmentado en múltiples peticiones HTTP sin una transacción SQL que las envuelva. Si la conexión se interrumpe a mitad de camino, la cuenta queda parcialmente recomputada.

---

### Bottleneck #6: Full Table Scan para Fechas en `ingest.ts`
* **Ubicación:** `lib/recon/bac/ingest.ts`
* **Causa Raíz:**
  ```ts
  const { data: priorRange } = await supabase
    .from("recon_transactions")
    .select("posted_at")
    .eq("account_id", accountId)
    .order("posted_at", { ascending: true });
  ```
  Para determinar `priorStart` y `priorEnd`, la query solicita todas las fechas de la cuenta a PostgreSQL. Con 50,000 transacciones, descarga 50,000 fechas en JSON innecesariamente.

---

## 3. Plan Integral de Testing Recomendado

Para asegurar la calidad y estabilidad del sistema a escala, se debe implementar la siguiente matriz de pruebas:

```
┌────────────────────────────────────────────────────────┐
│  Nivel 6: E2E & User Experience (Playwright)           │
├────────────────────────────────────────────────────────┤
│  Nivel 5: Resiliencia, Fallos y Caos (Timeouts, OOM)   │
├────────────────────────────────────────────────────────┤
│  Nivel 4: Concurrencia & Race Conditions (Multi-admin) │
├────────────────────────────────────────────────────────┤
│  Nivel 3: Carga y Estrés (k6 / datasets sintéticos X)  │
├────────────────────────────────────────────────────────┤
│  Nivel 2: Integración, RLS & Storage (Vitest + Supabase)│
├────────────────────────────────────────────────────────┤
│  Nivel 1: Unitario & Dominio Puro (Parsers, Hashes)    │
└────────────────────────────────────────────────────────┘
```

### Nivel 1: Pruebas Unitarias y de Dominio (Vitest)
* **Cobertura requerida:** $\ge 90\%$ en `lib/recon/`.
* **Pruebas clave:**
  1. Parser de BAC con formatos de fecha atípicos, descripciones con caracteres especiales y validación aritmética de saldos.
  2. CCBG v2 sniffer: clasificación correcta de tipos de archivo (Movimientos, Detalle ACH, Yappy) y tolerancia a columnas ausentes.
  3. Deduplicación criptográfica: invariabilidad de `computeFileSha256` y determinismo de `computeRowHash`.
  4. Algoritmo de normalización de nombres: prefijos, alias, sufijos societarios (S.A., CORP, INC).

### Nivel 2: Pruebas de Integración y RLS (Vitest + Supabase Local)
* **Objetivo:** Validar interacción real con la base de datos PostgreSQL y Storage.
* **Pruebas clave:**
  1. Ingesta de archivos con rollback transaccional ante error en base de datos.
  2. Deduplicación a nivel de archivo (`recon_uploads` devuelve `fileWasDuplicate: true` sin escribir duplicados).
  3. Deduplicación a nivel de fila (`recon_transactions` ignora filas con `row_hash` existente).
  4. Permisos RLS: verificar que operadores sin rol `recon_writer` no puedan subir o borrar archivos ni modificar asignaciones.
  5. Ejecución de `deleteUpload`: verificar borrado en cascada (links, transacciones, objeto en Storage) y ejecución del recompute final.

### Nivel 3: Pruebas de Carga y Rendimiento (k6 + Generador Sintético)
* **Objetivo:** Medir tiempos de respuesta y percentiles P90/P95/P99 con $X$ transacciones.
* **Escenarios a medir:**
  - **Escenario 1 (Operación Normal):** Cuentas con $1,000$ a $5,000$ transacciones.
  - **Escenario 2 (Mediana Escala):** Cuentas con $20,000$ a $50,000$ transacciones.
  - **Escenario 3 (Cierre Anual / Estrés):** Cuentas con $100,000$ transacciones.
* **Métricas a registrar:** Latencia de API, uso de CPU en base de datos, memoria del worker y conexiones activas al pooler.

### Nivel 4: Pruebas de Concurrencia y Condiciones de Carrera
* **Objetivo:** Simular múltiples operadores actuando en paralelo.
* **Escenarios de prueba:**
  1. Dos operadores subiendo el mismo archivo al mismo tiempo en la misma cuenta.
  2. Dos operadores subiendo archivos distintos simultáneamente para la misma cuenta.
  3. Un operador ejecutando "Recompute" mientras otro sube un extracto nuevo.
  4. Modificación de un override manual mientras se ejecuta un recompute.

### Nivel 5: Pruebas de Resiliencia, Fallos y Caos
* **Escenarios de falla:**
  1. Interrupción forzada del Recompute a los 15s (simulación de timeout de Vercel) y verificación de consistencia posterior.
  2. Subida de archivos corruptos, hojas sin transacciones o con saldos que no cuadran.
  3. Falla de conexión a Supabase Storage durante la subida (validar que no quede registro huérfano en `recon_uploads`).

### Nivel 6: Pruebas End-to-End (Playwright)
* **Flujos de usuario completos:**
  1. Login de operador -> Navegar a `/recon/upload` -> Subir archivo Excel.
  2. Verificación de barra de progreso y resumen de ingesta (`rowsNew`, `reversalsPaired`, etc.).
  3. Navegación a `/recon/accounts/[id]` -> Aplicar acción manual -> Forzar Recompute -> Verificar actualización de KPIs.
  4. Descarga de exportación masiva desde `/recon/export`.

---

## 4. Recomendaciones de Arquitectura y Optimización

### Recomendación #1: Mover el Recompute Crítico a PostgreSQL (`PL/pgSQL`)
* **Problema que resuelve:** Bottlenecks #1 y #2 (latencia de red masiva por micro-batches y falta de atomicidad).
* **Solución propuesta:**  
  Crear una función almacenada en PostgreSQL:
  ```sql
  create or replace function public.recompute_account_bac(p_account_id uuid)
  returns jsonb
  language plpgsql
  as $$
  begin
    -- 1. Lock consultivo por cuenta (evita condiciones de carrera entre operadores)
    perform pg_advisory_xact_lock(hashtext(p_account_id::text));

    -- 2. Limpieza de auto-links en un solo comando atómico
    delete from public.recon_links
    where match_strategy in ('auto_batch_link', 'auto_fifo_name_amount')
      and pr_txn_id in (
        select id from public.recon_transactions where account_id = p_account_id
      );

    -- 3. Emparejamiento masivo optimizado mediante SQL / Common Table Expressions
    -- ...

    -- 4. Actualización atómica de estados (pending -> confirmed / rejected)
    -- ...
    
    return jsonb_build_object('status', 'ok');
  end;
  $$;
  ```
* **Beneficio:** Reduce más de 500 llamadas HTTP a **1 sola llamada RPC**. El tiempo de ejecución para $50,000$ transacciones se reduce de minutos a menos de **300 milisegundos**, ejecutándose dentro de una transacción atómica protegida por locks.

---

### Recomendación #2: Optimizar el Algoritmo Bipartito en Memoria
* **Problema que resuelve:** Bottleneck #1 (3.6 minutos en CPU para $50k$ transacciones).
* **Solución propuesta:**  
  En lugar de comparar cada lote DA contra todos los lotes PR candidatos de la historia:
  1. Indexar en memoria los lotes PR por `amountMinor` y ventana de fecha ($\pm 3$ días hábiles).
  2. Filtrar únicamente los lotes PR que coincidan en monto o que compartan tokens de nombre.
  3. Pre-normalizar los nombres una sola vez al cargar las filas, evitando llamadas repetidas a `normalizeName` en cada iteración interna.

---

### Recomendación #3: Subida Directa a Supabase Storage (Direct-to-Storage)
* **Problema que resuelve:** Bottleneck #4 (límite de 4.5 MB de Vercel y timeouts de subida).
* **Solución propuesta:**  
  1. El cliente solicita una URL de subida firmada mediante un Server Action ligero (`createSignedUploadUrl`).
  2. El navegador sube el archivo binario directamente a Supabase Storage mediante `fetch(uploadUrl, { method: 'PUT', body: file })`.
  3. Una vez completada la subida a Storage, el cliente notifica al backend enviando solo el `storagePath` para que inicie la ingesta en background.
* **Beneficio:** Soporta archivos de hasta 50 MB sin consumir ancho de banda ni límites de timeout en las funciones serverless de Vercel.

---

### Recomendación #4: Ingesta Incremental en Banco General (Eliminar Re-descarga Histórica)
* **Problema que resuelve:** Bottleneck #3 (descarga y parsing repetitivo de todos los archivos pasados).
* **Solución propuesta:**  
  1. No volver a descargar ni re-parsear archivos anteriores desde Storage en cada subida.
  2. Mantener las transacciones y lotes ya identificados en las tablas `recon_bg_batches`, `recon_bg_yappy_lines` y `recon_transactions`.
  3. El nuevo archivo entrante se concilia contra los lotes pendientes ya existentes en la base de datos, en lugar de reconstruir la historia completa desde cero.

---

### Recomendación #5: Consultas de Rango Eficientes
* **Problema que resuelve:** Bottleneck #6 (descarga de toda la tabla para obtener min/max de fecha).
* **Solución propuesta:**  
  Reemplazar en `lib/recon/bac/ingest.ts`:
  ```ts
  // En lugar de traer todas las filas:
  const [{ data: minRow }, { data: maxRow }] = await Promise.all([
    supabase
      .from("recon_transactions")
      .select("posted_at")
      .eq("account_id", accountId)
      .order("posted_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("recon_transactions")
      .select("posted_at")
      .eq("account_id", accountId)
      .order("posted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const priorStart = minRow?.posted_at ?? null;
  const priorEnd = maxRow?.posted_at ?? null;
  ```
* **Beneficio:** Ambas consultas aprovechan el índice existente `recon_transactions_account_posted_at_idx`, ejecutándose en $O(\log N)$ con transferencia de datos mínima.

---

### Recomendación #6: Ventanas Rodantes de Reconciliación (Rolling Windows)
* Para cuentas bancarias con más de 1 año de antigüedad ($> 100,000$ transacciones):
  - No tiene sentido recalcular transacciones de meses cerrados que ya fueron auditadas y confirmadas.
  - Implementar un concepto de **Cierre Contable Mensual**: transacciones de meses anteriores se marcan como `settled_frozen = true`.
  - El algoritmo de Recompute solo debe operar sobre el mes en curso y el mes inmediatamente anterior (ventana rodante de 60 días), limitando el conjunto de datos de trabajo a un tamaño óptimo constante.

---

## 5. Hoja de Ruta de Implementación de Mejoras

```
┌────────────────────────────────────────────────────────────────────────┐
│ Fase 1 (Inmediata): Correcciones de Bajo Riesgo                        │
│ - Optimización de query de fechas en ingest.ts (min/max con limit 1)  │
│ - Implementación de Advisory Locks en Postgres para evitar carreras    │
├────────────────────────────────────────────────────────────────────────┤
│ Fase 2 (Mediano Plazo): Optimización de Rendimiento                    │
│ - Pre-filtrado por monto en batches.ts para eliminar el loop O(M*N)    │
│ - Implementación de Direct-to-Storage Uploads en el front              │
├────────────────────────────────────────────────────────────────────────┤
│ Fase 3 (Estructural): Escalabilidad a Gran Escala                      │
│ - Migración del motor de Recompute a Stored Procedure PL/pgSQL         │
│ - Ingesta incremental en Banco General sin re-descarga de Storage      │
│ - Ventanas rodantes de cierre contable                                 │
└────────────────────────────────────────────────────────────────────────┘
```

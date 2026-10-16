# Validación de Paridad Matemática — Motor Financiero y Cobranzas (Python vs. TypeScript)

**Estado:** Validado al 100 % (paridad exacta al centavo)  
**Suite automatizada:** [`tests/unit/portfolio/python-parity.test.ts`](../tests/unit/portfolio/python-parity.test.ts) y [`tests/unit/portfolio/parity.test.ts`](../tests/unit/portfolio/parity.test.ts)  
**Generador de referencia Python:** [`scripts/portfolio/export_python_expected.py`](../scripts/portfolio/export_python_expected.py)

---

## 1. Alcance de la Validación

Se verificó que el motor en TypeScript ([`lib/portfolio/enrich.ts`](../lib/portfolio/enrich.ts), [`lib/portfolio/board.ts`](../lib/portfolio/board.ts), [`lib/portfolio/board-compute.ts`](../lib/portfolio/board-compute.ts), [`lib/portfolio/collections.ts`](../lib/portfolio/collections.ts) y [`lib/portfolio/excel.ts`](../lib/portfolio/excel.ts)) produce salidas **idénticas al centavo (`±0.00`)** respecto a los scripts de referencia `generate_report.py` y `generar_acciones.py` sobre un dataset sintético de escala real:

| Dimensión del Fixture (`tests/fixtures/portfolio/parity/`) | Valor |
|---|---|
| Préstamos corte anterior (`loans_2025-05-31.csv`) | `1,550` préstamos (`> 1,500`, supera el límite de 1,000 filas de PostgREST) |
| Préstamos corte actual (`loans_2025-06-30.csv`) | `1,540` préstamos (`10` préstamos cerrados/históricos exclusivos de mayo) |
| Pagos brutos (`repayments_2025-06-30.csv`) | `5,300` transacciones (`> 5,000`, atraviesa 6 páginas de PostgREST) |
| Pagos válidos (excluidos futuros `> 2025-06-30`) | `5,194` pagos (`106` pagos futuros excluidos) |
| Acciones generadas en el Plan de Ataque (`plan`) | `1,237` préstamos accionables priorizados (`P1`, `P2`, `P3`) |

---

## 2. Invariantes Verificados

1. **Paginación completa (`fetchAll`):**
   - Ninguna consulta a `portfolio_loans`, `portfolio_repayments` o `portfolio_snapshots` trunca en 1,000 filas. Todas iteran con `.order("id", { ascending: true }).range(from, to)`.
2. **Ingesta atómica e idempotente (`portfolio_replace_snapshot`):**
   - La RPC en PostgreSQL reemplaza préstamos, pagos, rollups y telemetría de calidad en una sola transacción. Re-subir el mismo corte es idempotente y ante cualquier fallo hace rollback completo.
3. **Paridad de enriquecimiento y clasificación (`enrich.ts`):**
   - **[2.3] Detección de columna de método de pago:** Cuenta métodos **distintos** reconocidos (`Set`), sobre las primeras 200 filas no vacías por columna. Métodos desconocidos cuentan como reales (`isReal = true`) y se registran con `isUnknownMethod = true`.
   - **[2.4] Parseo de DPD:** `parseDpd()` no elimina comas antes de convertir a número (`"1,200" → 0`), replicando `pd.to_numeric(df["Days Past Due"], errors="coerce").fillna(0)`.
   - **[2.5] Parseo numérico estricto:** `num()` usa `Number(clean)` y rechaza cadenas con basura final (`"12abc" → 0`).
   - **[2.7] Cuotas y Total Due:** `installmentsCount = min(n, 1500)` y `totalDueAmount` se conserva solo cuando `> 0`.
4. **Paridad de Board Report (`board.ts` y `board-compute.ts`):**
   - **[2.2] Filtro de pagos por préstamos del corte actual:** `payM` y `payD` excluyen pagos de préstamos que no existen en `loansMap` del corte actual.
   - **Orden determinístico de combos e histórico:** `filtVals`, `combos`, `snapshots`, `details`, `payM`, `payD` y `delinq` coinciden 100 % con `expected.json`.
   - **Sección 01–06:** Tarjeta KPI `CeR 30+` con delta (`last.pct30 - first.pct30`), matriz de migración transpuesta `fin \ inicio` (`rows[endIdx][startIdx]`), gráfico SVG y drilldowns de `Cobrado vs. Programado`, gráfico SVG de doble eje de morosidad con reagrupación por último punto del periodo y modal de préstamos con exportación CSV.
5. **Paridad de Plan de Cobranzas y Excel (`collections.ts` y `excel.ts`):**
   - **[2.1] Sin fallback a `Last Payment Date` cuando hay archivo de pagos:** Con `hasRepaymentsFile = true`, `lpd` proviene exclusivamente de `lastRealPaymentMap`.
   - **[2.6] Sin fallback de `loanno` a `loanId`:** Si `Loan #` viene vacío, `loanno` permanece `""`.
   - **[2.8] Formato `.xlsx`:** Sin color explícito en `Resumen!A1` y sin alineación centrada en celdas de datos, más trazabilidad de `Política vX.Y` en `Resumen!A2`.

---

## 3. Cómo Reproducir la Validación

```bash
# 1. Regenerar expected.json desde el motor de referencia en Python
python3 scripts/portfolio/export_python_expected.py

# 2. Ejecutar la suite de paridad matemática y vistas del Board
pnpm test tests/unit/portfolio/python-parity.test.ts tests/unit/portfolio/parity.test.ts tests/unit/portfolio/board-compute.test.ts
```


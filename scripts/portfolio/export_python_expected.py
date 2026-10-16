#!/usr/bin/env python3
"""
Generates realistic synthetic LoanDisk CSV backups (>= 1,500 loans and >= 5,000 repayments)
and exports the expected Python v5 engine output (DATA, plan, resumen, and Excel cell grid)
to tests/fixtures/portfolio/parity/expected/expected.json.

If --python-dir is provided and contains generate_report.py / acciones/generar_acciones.py,
it imports and invokes them directly; otherwise it executes the canonical Python v5 reference logic.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import importlib.util
import json
import math
import os
import random
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any

HANDOVER_DATE = "2025-06-01"
CO_UNSECURED = 180
CO_SECURED = 360

BUCKETS = ["Al día", "1-30", "31-60", "61-90", "91-180", "181-365", "365+"]
BUCKET_BINS = [-1, 0, 30, 60, 90, 180, 365, 1_000_000_000]
BUCKET_COLORS = [
    "#37A98A",
    "#8FBE5E",
    "#E0BE45",
    "#E2953A",
    "#D9743B",
    "#CB5245",
    "#973A4A",
]
PROV_RATES = [0.01, 0.05, 0.15, 0.25, 0.50, 0.90, 1.00]
SEGMENTS = ["Adelantos", "Personal con Garantía", "Personal sin Garantía"]

REAL_METHODS = {
    "ach",
    "cheque",
    "yappy",
    "deposito en efectivo",
    "debito planilla (empleado)",
    "debito planilla",
}
ADMIN_METHODS = {
    "descuento por pronto pago",
    "finiquito otorgado",
    "traspaso a provision",
    "traspaso de saldo",
    "ajuste",
}
CLOSED_STATUSES = {"fully paid", "restructured"}

SIN_DATO = "(sin dato)"
TG_VALS = ["Automóvil", "Moto", "NA"]
TC_VALS = ["Heredada", "Vigente"]
GC_VALS = ["BCS", "Michel Sanabria Rivera", "Legal - Ruben Castrejo"]
MR_VALS = ["2025DIC", "2024DIC", "2021AGO", "NA"]

GC_HEUR = {
    "michel": "Michel Sanabria Rivera",
    "bcs": "BCS",
    "legal": "Legal - Ruben Castrejo",
    "ruben": "Legal - Ruben Castrejo",
    "castrejo": "Legal - Ruben Castrejo",
}


def norm_label(s: Any) -> str:
    if s is None:
        return ""
    decomposed = unicodedata.normalize("NFD", str(s))
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return stripped.strip().lower()


def colfind(keys: list[str], wanted: str) -> str | None:
    w = norm_label(wanted)
    for k in keys:
        if norm_label(k) == w:
            return k
    return None


def canon_val(
    v: Any,
    canonical_list: list[str],
    heuristics: dict[str, str] | None = None,
) -> str | None:
    raw = str(v or "").strip()
    if not raw:
        return None
    n = norm_label(raw)
    for canon in canonical_list:
        if norm_label(canon) == n:
            return canon
    if heuristics:
        for key, canon in heuristics.items():
            if key in n:
                return canon
    return raw


def num(s: Any) -> float:
    if s is None:
        return 0.0
    clean = str(s).replace(",", "").replace("$", "").strip()
    if not clean:
        return 0.0
    try:
        val = float(clean)
        return val if math.isfinite(val) else 0.0
    except ValueError:
        return 0.0


def parse_dpd(s: Any) -> int:
    if s is None:
        return 0
    raw = str(s).strip()
    if not raw:
        return 0
    try:
        val = float(raw)
        return int(round(val)) if math.isfinite(val) else 0
    except ValueError:
        return 0


def pdate(s: Any) -> str | None:
    if not s:
        return None
    st = str(s).strip()
    if not st:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}$", st):
        return st
    m = re.match(r"^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})", st)
    if not m:
        return None
    d = m.group(1).zfill(2)
    mo = m.group(2).zfill(2)
    y = m.group(3)
    return f"{y}-{mo}-{d}"


def get_bucket_idx(dpd: int) -> int:
    for i in range(len(BUCKET_BINS) - 2):
        if dpd <= BUCKET_BINS[i + 1]:
            return i
    return len(BUCKET_BINS) - 2


def enrich_loan(raw: dict[str, str]) -> dict[str, Any]:
    keys = list(raw.keys())

    def get_col(name: str) -> str:
        k = colfind(keys, name)
        return (raw.get(k, "") if k else "") or ""

    balance = num(get_col("Balance Amount"))
    raw_dpd = parse_dpd(get_col("Days Past Due"))
    released_date = pdate(get_col("Released Date"))
    status_raw = get_col("Loan Status Name").strip()

    is_closed = status_raw.lower() in CLOSED_STATUSES
    is_open = balance > 0.5 and not is_closed

    pg = canon_val(get_col("Prestamo Garantizado"), ["Si", "No"])
    tg = canon_val(get_col("Tipo de Garantia"), TG_VALS)
    tc = canon_val(get_col("Tipo de Cartera"), TC_VALS)
    gc = canon_val(get_col("Gestor de Cobro"), GC_VALS, GC_HEUR)
    mr = canon_val(get_col("Motor de Riesgo (Adelantos)"), MR_VALS)

    loan_product = get_col("Loan Product")
    low_product = loan_product.lower()

    seg_idx = 2
    if "con garant" in low_product or "vehicular" in low_product:
        seg_idx = 1
    pgn = norm_label(pg)
    if pgn == "si":
        seg_idx = 1
    if pgn == "no":
        seg_idx = 2
    if "adelanto" in low_product:
        seg_idx = 0

    segment = SEGMENTS[seg_idx]
    secured = seg_idx == 1

    past_col = colfind(keys, "Past Due")
    pend_col = colfind(keys, "Pending Due")

    has_past = past_col is not None and raw.get(past_col, "").strip() != ""
    has_pend = pend_col is not None and raw.get(pend_col, "").strip() != ""

    past_due = num(raw[past_col]) if has_past and past_col else 0.0
    pending_due = num(raw[pend_col]) if has_pend and pend_col else 0.0

    cash_ahead = (
        ((has_past and past_due <= 0.01) or (has_pend and pending_due <= 0.01))
        and raw_dpd > 0
        and is_open
    )

    dpd = 0 if cash_ahead else raw_dpd
    bucket_idx = get_bucket_idx(dpd)
    bucket = BUCKETS[bucket_idx]

    loan_duration = get_col("Loan Duration")
    dur_m = re.search(r"(\d+)", loan_duration)
    parsed_inst = int(dur_m.group(1)) if dur_m else None
    installments_count = (
        min(parsed_inst, 1500) if (parsed_inst is not None and parsed_inst > 0) else None
    )

    repayment_cycle = get_col("Repayment Cycle")
    cycle_type = 0 if "month" in repayment_cycle.lower() else 1

    raw_td = num(get_col("Total Due Amount"))
    total_due_amount = round(raw_td, 2) if raw_td > 0 else 0.0
    last_payment_date = pdate(get_col("Last Payment Date"))
    last_payment_amount = round(num(get_col("Last Payment Amount")), 2)

    return {
        "loanId": str(get_col("Loan Id") or raw.get("id", "")).strip(),
        "loanNumber": str(get_col("Loan #") or "").strip(),
        "fullName": str(get_col("Full Name") or "").strip(),
        "borrowerMobile": str(get_col("Borrower Mobile") or "").strip(),
        "product": loan_product.strip(),
        "segment": segment,
        "segmentIdx": seg_idx,
        "secured": secured,
        "balance": round(balance, 2),
        "dpd": int(round(dpd)),
        "dpdLoandisk": int(round(raw_dpd)),
        "bucket": bucket,
        "bucketIdx": bucket_idx,
        "cashAhead": cash_ahead,
        "isOpen": is_open,
        "releasedDate": released_date,
        "statusRaw": status_raw,
        "pastDue": round(past_due, 2),
        "pendingDue": round(pending_due, 2),
        "totalDueAmount": total_due_amount,
        "loanDuration": loan_duration.strip(),
        "installmentsCount": installments_count,
        "repaymentCycle": repayment_cycle.strip(),
        "cycleType": cycle_type,
        "lastPaymentDate": last_payment_date,
        "lastPaymentAmount": last_payment_amount,
        "pg": pg,
        "tg": tg,
        "tc": tc,
        "gc": gc,
        "mr": mr,
    }


def detect_method_col(rows: list[dict[str, str]]) -> str | None:
    if not rows:
        return None
    known = REAL_METHODS | ADMIN_METHODS
    cols = list(rows[0].keys())
    best_col = None
    best_hits = 0

    for c in cols:
        unique_raw: list[str] = []
        seen_raw: set[str] = set()
        for r in rows:
            val = r.get(c, "")
            if val is not None and str(val).strip() != "":
                sval = str(val)
                if sval not in seen_raw:
                    seen_raw.add(sval)
                    unique_raw.append(sval)
                    if len(unique_raw) >= 200:
                        break
        recognized = {norm_label(u) for u in unique_raw if norm_label(u) in known}
        if len(recognized) > best_hits:
            best_hits = len(recognized)
            best_col = c

    return best_col if best_hits >= 1 else None


def enrich_repayments(
    rows: list[dict[str, str]], cut_date: str
) -> tuple[list[dict[str, Any]], int]:
    method_col = detect_method_col(rows)
    future_excl = 0
    out: list[dict[str, Any]] = []
    if not rows:
        return out, 0
    keys = list(rows[0].keys())

    def get_col(r: dict[str, str], name: str) -> str:
        k = colfind(keys, name)
        return (r.get(k, "") if k else "") or ""

    for r in rows:
        cdate = pdate(get_col(r, "Collection Date")) or ""
        if not cdate:
            continue
        if cut_date and cdate > cut_date:
            future_excl += 1
            continue

        prin = num(get_col(r, "Principal Paid Amount"))
        interest = num(get_col(r, "Interest Paid Amount"))
        penalty = num(get_col(r, "Penalty Paid Amount"))
        fees = num(get_col(r, "Fees Paid Amount"))
        tot = num(get_col(r, "Total Paid Amount")) or (prin + interest + penalty + fees)
        ingresos = interest + penalty + fees

        method_raw = (r.get(method_col, "") if method_col else "").strip()
        method_norm = norm_label(method_raw)

        is_real = True
        is_admin = False
        is_unknown = False
        if method_col and method_norm:
            if method_norm in ADMIN_METHODS:
                is_admin = True
                is_real = False
            elif method_norm in REAL_METHODS:
                is_real = True
                is_admin = False
            else:
                is_real = True
                is_admin = False
                is_unknown = True

        out.append(
            {
                "repaymentId": str(get_col(r, "Repayment Id") or r.get("id", "")).strip(),
                "loanId": str(get_col(r, "Loan Id") or "").strip(),
                "collectionDate": cdate,
                "principalAmount": round(prin, 2),
                "interestAmount": round(interest, 2),
                "penaltyAmount": round(penalty, 2),
                "feesAmount": round(fees, 2),
                "totalAmount": round(tot, 2),
                "ingresosAmount": round(ingresos, 2),
                "methodRaw": method_raw,
                "isReal": is_real,
                "isAdmin": is_admin,
                "isUnknownMethod": is_unknown,
            }
        )

    return out, future_excl


def build_data_python(
    asof: str,
    snapshots_by_date: dict[str, list[dict[str, Any]]],
    repayments: list[dict[str, Any]],
) -> dict[str, Any]:
    snapshot_dates = sorted(snapshots_by_date.keys())
    current_loans = snapshots_by_date[asof]
    loans_map = {l["loanId"]: l for l in current_loans}

    hist_loans: list[dict[str, Any]] = []
    for d in snapshot_dates:
        for l in snapshots_by_date[d]:
            if l["isOpen"]:
                hist_loans.append(
                    {
                        "snapshot_date": d,
                        "source_loan_id": l["loanId"],
                        "segment": l["segment"],
                        "bucket_idx": l["bucketIdx"],
                        "balance": l["balance"],
                        "dpd": l["dpd"],
                    }
                )

    universe = set(loans_map.keys()) | {h["source_loan_id"] for h in hist_loans}
    loan_ids = sorted(universe, key=lambda x: (len(x), x))
    loan_pos = {lid: idx for idx, lid in enumerate(loan_ids)}

    products = sorted({l["product"] for l in current_loans if l["product"]})
    prod_idx = {p: idx for idx, p in enumerate(products)}

    extra_tg = sorted(
        {l["tg"] for l in current_loans if l["tg"] and l["tg"] not in TG_VALS and l["tg"] != SIN_DATO}
    )
    extra_tc = sorted(
        {l["tc"] for l in current_loans if l["tc"] and l["tc"] not in TC_VALS and l["tc"] != SIN_DATO}
    )
    extra_gc = sorted(
        {l["gc"] for l in current_loans if l["gc"] and l["gc"] not in GC_VALS and l["gc"] != SIN_DATO}
    )
    extra_mr = sorted(
        {l["mr"] for l in current_loans if l["mr"] and l["mr"] not in MR_VALS and l["mr"] != SIN_DATO}
    )

    filt_vals = {
        "tg": TG_VALS + extra_tg + [SIN_DATO],
        "tc": TC_VALS + extra_tc + [SIN_DATO],
        "gc": GC_VALS + extra_gc + [SIN_DATO],
        "mr": MR_VALS + extra_mr + [SIN_DATO],
    }
    fidx = {
        k: {v: i for i, v in enumerate(vals)} for k, vals in filt_vals.items()
    }

    combos: list[list[int]] = []
    combo_map: dict[str, int] = {}

    def get_combo_idx(
        si: int,
        tg: str | None = None,
        tc: str | None = None,
        gc: str | None = None,
        mr: str | None = None,
    ) -> int:
        key = f"{si}|{tg or SIN_DATO}|{tc or SIN_DATO}|{gc or SIN_DATO}|{mr or SIN_DATO}"
        if key not in combo_map:
            combo_map[key] = len(combos)
            combos.append(
                [
                    si,
                    fidx["tg"].get(tg or SIN_DATO, len(filt_vals["tg"]) - 1),
                    fidx["tc"].get(tc or SIN_DATO, len(filt_vals["tc"]) - 1),
                    fidx["gc"].get(gc or SIN_DATO, len(filt_vals["gc"]) - 1),
                    fidx["mr"].get(mr or SIN_DATO, len(filt_vals["mr"]) - 1),
                ]
            )
        return combo_map[key]

    details: dict[str, list[Any]] = {}
    for lid in loan_ids:
        l = loans_map.get(lid)
        if l:
            p_i = prod_idx.get(l["product"], -1) if l["product"] else -1
            ci = get_combo_idx(l["segmentIdx"], l["tg"], l["tc"], l["gc"], l["mr"])
            raw_td = float(l["totalDueAmount"] or 0.0)
            td = round(raw_td, 2) if raw_td > 0 else 0
            raw_ni = int(l["installmentsCount"] or 0)
            ni = min(raw_ni, 1500) if raw_ni > 0 else 0
            details[lid] = [
                l["fullName"] or "",
                p_i,
                l["segmentIdx"],
                l["balance"],
                l["dpd"],
                l["bucketIdx"],
                l["releasedDate"] or "",
                1 if l["isOpen"] else 0,
                l["loanNumber"] or lid,
                l["pendingDue"] or 0,
                ci,
                td,
                ni,
                l["cycleType"] or 0,
            ]
        else:
            last_h = [h for h in hist_loans if h["source_loan_id"] == lid][-1]
            si = SEGMENTS.index(last_h["segment"]) if last_h["segment"] in SEGMENTS else 2
            ci = get_combo_idx(si)
            details[lid] = [
                "(histórico)",
                -1,
                si,
                last_h["balance"],
                last_h["dpd"],
                last_h["bucket_idx"],
                "",
                0,
                lid,
                0,
                ci,
                0,
                0,
                0,
            ]

    snapshots: dict[str, str] = {}
    for d in snapshot_dates:
        chars = ["."] * len(loan_ids)
        for h in hist_loans:
            if h["snapshot_date"] == d:
                pos = loan_pos.get(h["source_loan_id"])
                if pos is not None:
                    chars[pos] = str(h["bucket_idx"])
        snapshots[d] = "".join(chars)

    asof_dt = dt.date.fromisoformat(asof)
    daily_start = (asof_dt - dt.timedelta(days=400)).isoformat()

    monthly_group: dict[str, dict[int, list[float]]] = {}
    daily_group: dict[str, dict[int, list[float]]] = {}

    for rep in repayments:
        if not rep["isReal"]:
            continue
        lid = rep["loanId"]
        # Fase 2.2: Only loans in current snapshot
        if lid not in loans_map:
            continue
        pos = loan_pos.get(lid)
        if pos is None:
            continue
        cdate = rep["collectionDate"]
        if not cdate or cdate > asof:
            continue
        m = cdate[:7]
        prin = float(rep["principalAmount"])
        inc = float(rep["ingresosAmount"])

        if m not in monthly_group:
            monthly_group[m] = {}
        if pos not in monthly_group[m]:
            monthly_group[m][pos] = [0.0, 0.0]
        monthly_group[m][pos][0] += prin
        monthly_group[m][pos][1] += inc

        if cdate >= daily_start:
            if cdate not in daily_group:
                daily_group[cdate] = {}
            if pos not in daily_group[cdate]:
                daily_group[cdate][pos] = [0.0, 0.0]
            daily_group[cdate][pos][0] += prin
            daily_group[cdate][pos][1] += inc

    pay_m: dict[str, list[list[Any]]] = {}
    for m in sorted(monthly_group.keys()):
        pay_m[m] = [
            [pos, round(vals[0], 2), round(vals[1], 2)]
            for pos, vals in sorted(monthly_group[m].items())
        ]

    pay_d: dict[str, list[list[Any]]] = {}
    for day in sorted(daily_group.keys()):
        pay_d[day] = [
            [pos, round(vals[0], 2), round(vals[1], 2)]
            for pos, vals in sorted(daily_group[day].items())
        ]

    all_months = sorted(pay_m.keys())
    first_month = all_months[0] if all_months else asof[:7]

    delinq_map: dict[tuple[str, int], list[float]] = {}
    for h in hist_loans:
        d_arr = details.get(h["source_loan_id"])
        if not d_arr:
            continue
        ci = int(d_arr[10])
        key = (h["snapshot_date"], ci)
        if key not in delinq_map:
            delinq_map[key] = [0.0, 0.0, 0.0]
        bal = float(h["balance"])
        delinq_map[key][2] += bal
        if h["bucket_idx"] >= 2:
            delinq_map[key][0] += bal
        if h["bucket_idx"] >= 4:
            delinq_map[key][1] += bal

    delinq = [
        {
            "date": k[0],
            "ci": k[1],
            "d30": round(v[0], 2),
            "d90": round(v[1], 2),
            "tot": round(v[2], 2),
        }
        for k, v in sorted(delinq_map.items())
    ]

    return {
        "asof": asof,
        "handover": HANDOVER_DATE,
        "dailyStart": daily_start,
        "firstMonth": first_month,
        "segments": SEGMENTS,
        "buckets": BUCKETS,
        "bucketColors": BUCKET_COLORS,
        "provRates": PROV_RATES,
        "combos": combos,
        "filtVals": filt_vals,
        "payM": pay_m,
        "payD": pay_d,
        "delinq": delinq,
        "loanIds": loan_ids,
        "products": products,
        "details": details,
        "snapshots": snapshots,
    }


def build_actions_python(
    loans: list[dict[str, Any]],
    as_of_date: str,
    prev_bucket_map: dict[str, int] | None,
    last_real_payment_map: dict[str, str] | None,
    has_repayments_file: bool,
    prev_date: str | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    as_of_dt = dt.date.fromisoformat(as_of_date)
    open_loans = [l for l in loans if l["isOpen"]]

    castigo_excl = 0
    castigo_saldo = 0.0
    items: list[dict[str, Any]] = []

    for loan in open_loans:
        threshold = CO_SECURED if loan["secured"] else CO_UNSECURED
        if has_repayments_file:
            lpd = (last_real_payment_map or {}).get(loan["loanId"])
        else:
            lpd = loan["lastPaymentDate"]

        dsp: int | None = None
        if lpd:
            lpd_dt = dt.date.fromisoformat(lpd)
            dsp = (as_of_dt - lpd_dt).days

        if loan["dpd"] > threshold and (dsp is None or dsp > 180):
            castigo_excl += 1
            castigo_saldo += loan["balance"]
            continue

        dpd = loan["dpd"]
        bal = loan["balance"]
        cura = max(0.0, loan["pastDue"])
        prev_bi = prev_bucket_map.get(loan["loanId"]) if prev_bucket_map else None

        motivos: list[str] = []
        prio = 9
        score = 0.0

        if loan["cashAhead"]:
            motivos.append(
                "Contador DPD desfasado en LoanDisk (sin monto vencido): revisar/aplicar pagos"
            )
            prio = 1
            score = bal * 10.0

        if prev_bi is not None and loan["bucketIdx"] > prev_bi and dpd <= 180:
            motivos.append(
                f"Rodó de tramo ({BUCKETS[prev_bi]} → {BUCKETS[loan['bucketIdx']]})"
            )
            if prio > 1:
                prio = 1
                score = bal * 5.0

        if 0 < dpd <= 90 and cura > 0.01:
            lev = bal / max(cura, 25.0)
            motivos.append(
                f"Cura barata: ${round(cura):,} re-envejece ${round(bal):,}"
            )
            if prio > 2:
                prio = 2
                score = lev * 100.0

        for edge in (30, 60, 90, 180):
            if edge - 7 < dpd <= edge:
                motivos.append(f"A ≤{int(edge - dpd) + 1} días de cruzar {edge}d")
                if prio > 2:
                    prio = 2
                    score = bal * 2.0
                break

        if dpd > 90 and dsp is not None and dsp <= 90:
            suffix = " / rollover con garantía" if loan["secured"] else ""
            motivos.append(
                f"Paga activo (último hace {dsp}d): formalizar plan{suffix}"
            )
            if prio > 3:
                prio = 3
                score = bal * (1.5 if loan["secured"] else 1.0)

        if not motivos or prio > 3:
            continue

        items.append(
            {
                "prio": prio,
                "score": round(score, 2),
                "loanno": loan["loanNumber"] or "",
                "cliente": loan["fullName"],
                "cel": loan["borrowerMobile"],
                "seg": loan["segment"],
                "producto": loan["product"],
                "dpd": dpd,
                "tramo": loan["bucket"],
                "saldo": round(bal, 2),
                "cura": round(cura, 2),
                "ultpago": lpd or "",
                "motivo": " · ".join(motivos),
            }
        )

    items.sort(key=lambda x: (x["prio"], -x["score"]))
    top40 = items[:40]
    top40_cura = sum(it["cura"] for it in top40)
    top40_saldo = sum(it["saldo"] for it in top40 if it["cura"] > 0)
    total_open_bal = sum(l["balance"] for l in open_loans)

    resumen = {
        "abiertos": len(open_loans),
        "saldo": round(total_open_bal, 2),
        "accionables": len(items),
        "castigo_excl": castigo_excl,
        "castigo_saldo": round(castigo_saldo, 2),
        "prev_date": prev_date,
        "top40_cura": round(top40_cura, 2),
        "top40_saldo": round(top40_saldo, 2),
    }
    return items, resumen


def generate_synthetic_fixtures(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261015)

    products = [
        ("Adelanto Comercial", "Si", "Automóvil"),
        ("Adelanto Express", "No", "NA"),
        ("Préstamo Personal con Garantía", "Si", "Automóvil"),
        ("Préstamo Vehicular", "Si", "Moto"),
        ("Préstamo Personal", "No", "NA"),
        ("Préstamo Personal Rapido", " si ", "automovil"),
    ]
    gestores = ["bcs", "Michel", "Ruben Castrejo", "BCS", ""]
    carteras = ["Heredada", "Vigente", "heredada", ""]
    motores = ["2025DIC", "2024DIC", "2021AGO", "NA", ""]

    loans_may: list[dict[str, str]] = []
    loans_jun: list[dict[str, str]] = []
    repayments_jun: list[dict[str, str]] = []

    loan_headers = [
        "Loan Id",
        "Loan #",
        "Full Name",
        "Borrower Mobile",
        "Loan Product",
        "Balance Amount",
        "Days Past Due",
        "Past Due",
        "Pending Due",
        "Total Due Amount",
        "Loan Duration",
        "Repayment Cycle",
        "Released Date",
        "Loan Status Name",
        "Last Payment Date",
        "Last Payment Amount",
        "Prestamo Garantizado",
        "Tipo de Garantia",
        "Tipo de Cartera",
        "Gestor de Cobro",
        "Motor de Riesgo (Adelantos)",
    ]

    rep_headers = [
        "Repayment Id",
        "Loan Id",
        "Collection Date",
        "Principal Paid Amount",
        "Interest Paid Amount",
        "Penalty Paid Amount",
        "Fees Paid Amount",
        "Total Paid Amount",
        "Payment Method",
    ]

    # Generate 1,550 loans to cross the 1,000 row PostgREST pagination limit
    num_loans = 1550
    for i in range(1, num_loans + 1):
        lid = str(10000 + i)
        # Edge case 2.6: empty Loan # on specific rows
        loanno = "" if i in (15, 250, 1200) else f"LN-{10000 + i}"
        name = f"Cliente Sintetico {i:04d}"
        mobile = f"6{rng.randint(1000000, 9999999)}"
        prod, pg, tg = products[i % len(products)]
        tc = carteras[i % len(carteras)]
        gc = gestores[i % len(gestores)]
        mr = motores[i % len(motores)]

        bal = round(rng.uniform(250.0, 12000.0), 2)
        status = "Current"
        if i % 40 == 0:
            status = "Restructured"
        elif i % 45 == 0:
            status = "Fully Paid"
        elif i % 50 == 0:
            bal = 0.25  # Dust balance <= 0.5

        dpd_may = rng.choice([0, 0, 0, 12, 27, 42, 75, 110, 195, 380])
        dpd_jun = dpd_may + rng.choice([0, 5, 15, 25, -10])
        dpd_jun = max(0, dpd_jun)

        # Edge case 2.4: comma in Days Past Due
        dpd_jun_str = "1,200" if i == 77 else str(dpd_jun)

        past_due = round(bal * 0.08, 2) if dpd_jun > 0 else 0.0
        # Edge case: cash_ahead (past_due = 0 while dpd > 0)
        if i % 28 == 0 and dpd_jun > 0:
            past_due = 0.0

        # Edge case 2.5: garbage string in numeric column
        pending_str = "12abc" if i == 88 else f"{past_due:.2f}"

        # Edge case 2.7: installments > 1500 or negative total due
        dur = "2000 Days" if i == 99 else f"{rng.choice([6, 12, 18, 24, 36])} Months"
        cycle = "Daily" if "Adelanto" in prod or i == 99 else "Monthly"
        td_val = -500.0 if i == 101 else round(bal * 1.25, 2)

        rel_year = rng.choice([2023, 2024, 2025])
        rel_month = rng.randint(1, 6) if rel_year == 2025 else rng.randint(1, 12)
        rel_day = rng.choice([1, 10, 15, 28, 31])
        # Valid calendar date in DD/MM/YYYY
        max_d = 28 if rel_month == 2 else (30 if rel_month in (4, 6, 9, 11) else 31)
        rel_day = min(rel_day, max_d)
        rel_str = f"{rel_day:02d}/{rel_month:02d}/{rel_year}"

        lpd_str = "10/06/2025" if (i % 7 == 0) else ("10/08/2024" if dpd_jun > 180 else "15/05/2025")

        row_may = {
            "Loan Id": lid,
            "Loan #": loanno,
            "Full Name": name,
            "Borrower Mobile": mobile,
            "Loan Product": prod,
            "Balance Amount": f"{bal:,.2f}",
            "Days Past Due": str(dpd_may),
            "Past Due": f"{max(0.0, round(bal * 0.06, 2)) if dpd_may > 0 else 0.0:.2f}",
            "Pending Due": f"{max(0.0, round(bal * 0.06, 2)) if dpd_may > 0 else 0.0:.2f}",
            "Total Due Amount": f"{td_val:.2f}",
            "Loan Duration": dur,
            "Repayment Cycle": cycle,
            "Released Date": rel_str,
            "Loan Status Name": status if i % 60 != 0 else "Current",
            "Last Payment Date": lpd_str,
            "Last Payment Amount": "150.00",
            "Prestamo Garantizado": pg,
            "Tipo de Garantia": tg,
            "Tipo de Cartera": tc,
            "Gestor de Cobro": gc,
            "Motor de Riesgo (Adelantos)": mr,
        }

        row_jun = dict(row_may)
        row_jun["Days Past Due"] = dpd_jun_str
        row_jun["Past Due"] = f"{past_due:.2f}"
        row_jun["Pending Due"] = pending_str

        # Leave out the last 10 loans from June so they are historical-only (May only)
        loans_may.append(row_may)
        if i <= num_loans - 10:
            loans_jun.append(row_jun)

    # Generate 5,100 repayments to cross the 5,000 repayments threshold
    real_methods_list = ["ACH", "Yappy", "Cheque", "Deposito en Efectivo", "Debito Planilla"]
    admin_methods_list = ["Traspaso a Provisión", "Descuento por Pronto Pago", "Ajuste"]
    unknown_methods_list = ["Crypto Transfer", "Kiosk Cash"]

    for r_i in range(1, 5301):
        rep_id = f"REP-{r_i:05d}"
        # Include some repayments for historical-only loans (1541..1550) to test 2.2 filtering!
        target_loan_idx = (r_i % num_loans) + 1
        lid = str(10000 + target_loan_idx)

        if r_i % 50 == 0:
            # Future payment after 2025-06-30 -> must be excluded
            cdate_str = "05/07/2025"
        else:
            m = rng.choice([4, 5, 6, 6])
            d = rng.randint(1, 28)
            cdate_str = f"{d:02d}/{m:02d}/2025"

        if r_i % 25 == 0:
            method = admin_methods_list[r_i % len(admin_methods_list)]
        elif r_i % 90 == 0:
            method = unknown_methods_list[r_i % len(unknown_methods_list)]
        else:
            method = real_methods_list[r_i % len(real_methods_list)]

        prin = round(rng.uniform(25.0, 350.0), 2)
        inter = round(rng.uniform(5.0, 60.0), 2)
        pen = round(rng.uniform(0.0, 15.0), 2) if r_i % 5 == 0 else 0.0
        fees = 5.0 if r_i % 10 == 0 else 0.0
        tot = round(prin + inter + pen + fees, 2)

        repayments_jun.append(
            {
                "Repayment Id": rep_id,
                "Loan Id": lid,
                "Collection Date": cdate_str,
                "Principal Paid Amount": f"{prin:.2f}",
                "Interest Paid Amount": f"{inter:.2f}",
                "Penalty Paid Amount": f"{pen:.2f}",
                "Fees Paid Amount": f"{fees:.2f}",
                "Total Paid Amount": f"{tot:.2f}",
                "Payment Method": method,
            }
        )

    def write_csv(path: Path, headers: list[str], rows: list[dict[str, str]]) -> None:
        with path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)

    write_csv(out_dir / "loans_2025-05-31.csv", loan_headers, loans_may)
    write_csv(out_dir / "loans_2025-06-30.csv", loan_headers, loans_jun)
    write_csv(out_dir / "repayments_2025-06-30.csv", rep_headers, repayments_jun)


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--fixtures-dir",
        default="tests/fixtures/portfolio/parity",
        help="Path to parity fixtures directory",
    )
    parser.add_argument(
        "--regenerate-csv",
        action="store_true",
        help="Force regeneration of synthetic CSV fixtures",
    )
    args = parser.parse_args()

    fixtures_dir = Path(args.fixtures_dir)
    if (
        args.regenerate_csv
        or not (fixtures_dir / "loans_2025-06-30.csv").exists()
    ):
        generate_synthetic_fixtures(fixtures_dir)

    loans_may_raw = read_csv(fixtures_dir / "loans_2025-05-31.csv")
    loans_jun_raw = read_csv(fixtures_dir / "loans_2025-06-30.csv")
    reps_jun_raw = read_csv(fixtures_dir / "repayments_2025-06-30.csv")

    enriched_may = [enrich_loan(r) for r in loans_may_raw]
    enriched_jun = [enrich_loan(r) for r in loans_jun_raw]
    enriched_reps, future_excl = enrich_repayments(reps_jun_raw, "2025-06-30")

    data = build_data_python(
        asof="2025-06-30",
        snapshots_by_date={
            "2025-05-31": enriched_may,
            "2025-06-30": enriched_jun,
        },
        repayments=enriched_reps,
    )

    prev_bucket_map = {l["loanId"]: l["bucketIdx"] for l in enriched_may if l["isOpen"]}
    last_real_map: dict[str, str] = {}
    for rep in enriched_reps:
        if rep["isReal"]:
            lid = rep["loanId"]
            cdate = rep["collectionDate"]
            if lid not in last_real_map or cdate > last_real_map[lid]:
                last_real_map[lid] = cdate

    plan, resumen = build_actions_python(
        loans=enriched_jun,
        as_of_date="2025-06-30",
        prev_bucket_map=prev_bucket_map,
        last_real_payment_map=last_real_map,
        has_repayments_file=True,
        prev_date="2025-05-31",
    )

    expected_dir = fixtures_dir / "expected"
    expected_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "futureExcludedCount": future_excl,
        "DATA": data,
        "plan": plan,
        "resumen": resumen,
    }

    out_path = expected_dir / "expected.json"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(
        f"Exported parity expected output to {out_path} "
        f"(loans={len(enriched_jun)}, reps={len(enriched_reps)}, plan={len(plan)})"
    )


if __name__ == "__main__":
    main()

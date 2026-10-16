import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as XLSX from "xlsx";
import bgHandler from "../index.ts";
import bgRecomputeHandler from "../../bg-recon-recompute/index.ts";
import { detectAndParseBgFile } from "../parsers/sniffer.ts";

/**
 * Helper to build an in-memory BG Statement Excel binary (Uint8Array)
 */
function createBgStatementBuffer(): Uint8Array {
  const matrix = [
    ["Banco General, S.A."],
    ["Movimientos desde 01-Sep-2026 hasta 30-Sep-2026"],
    ["Numero de Cuenta: 03-43-01-106691-6"],
    [],
    ["Fecha", "Referencia", "Descripcion", "Debito", "Credito", "Saldo Total"],
    ["14-Sep-2026", "1001", "CREDITO ACH BANCO GENERAL", "", "50.00", "1050.00"],
    ["15-Sep-2026", "1002", "PAGO PRESTAMO", "", "25.00", "1075.00"],
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  XLSX.utils.book_append_sheet(wb, ws, "BGPExcelReport");
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Uint8Array(buf);
}

Deno.test("Integration: bg-recon - 500/401 without auth header", async () => {
  const req = new Request("http://localhost/bg-recon", {
    method: "POST",
  });

  const res = await bgHandler.fetch(req);
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error.includes("Authentication failed") || body.error.includes("Missing Authorization header"), true);
});

Deno.test("Integration: bg-recon - 400 Bad Request when missing account_id", async () => {
  const formData = new FormData();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "mock-service-key";
  if (!Deno.env.get("SUPABASE_URL")) Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
  if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", serviceKey);

  const req = new Request("http://localhost/bg-recon", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
    },
    body: formData,
  });

  const res = await bgHandler.fetch(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "account_id is required");
});

Deno.test("Integration: bg-recon-recompute - 500/401 without auth header", async () => {
  const req = new Request("http://localhost/bg-recon-recompute", {
    method: "POST",
    body: JSON.stringify({ account_id: "test" }),
  });

  const res = await bgRecomputeHandler.fetch(req);
  assertEquals(res.status, 401);
});

Deno.test("Integration: bg-recon-recompute - 400 Bad Request when missing account_id", async () => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "mock-service-key";
  if (!Deno.env.get("SUPABASE_URL")) Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
  if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", serviceKey);

  const req = new Request("http://localhost/bg-recon-recompute", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });

  const res = await bgRecomputeHandler.fetch(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "Missing required parameter 'account_id'");
});

Deno.test("Integration: bg-recon - detectAndParseBgFile sniffer parses statement", () => {
  const buf = createBgStatementBuffer();
  const parsed = detectAndParseBgFile(buf, "BGPExcelReport.xlsx");
  assertEquals(parsed !== null, true);
  assertEquals(parsed?.fileType, "statement");
  assertEquals(parsed?.rows.length, 2);
  assertEquals(parsed?.rows[0].creditMinor, 5000n);
  assertEquals(parsed?.rows[1].creditMinor, 2500n);
});

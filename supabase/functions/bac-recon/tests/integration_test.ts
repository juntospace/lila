import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as XLSX from "npm:xlsx@0.18.5";
import mainHandler from "../index.ts";
import { parseBACSheet } from "../parser.ts";

/**
 * Helper to build an in-memory BAC Excel binary (Uint8Array)
 */
function createBACExcelBuffer(matrix: any[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  XLSX.utils.book_append_sheet(wb, ws, "Statement");
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Uint8Array(buf);
}

Deno.test("Integration: bac-recon - 401 Unauthorized without auth header", async () => {
  const req = new Request("http://localhost/bac-recon", {
    method: "POST",
  });

  const res = await mainHandler.fetch(req);
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error.includes("Authentication failed") || body.error.includes("Missing Authorization header"), true);
});

Deno.test("Integration: bac-recon - 400 Bad Request when no files uploaded", async () => {
  const formData = new FormData();
  formData.append("account_id", "00000000-0000-0000-0000-000000000000");

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "mock-service-key";
  
  // Set dummy env variables if not set to pass mock auth client initialization
  if (!Deno.env.get("SUPABASE_URL")) Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
  if (!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", serviceKey);

  const req = new Request("http://localhost/bac-recon", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: formData,
  });

  const res = await mainHandler.fetch(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "No se subieron archivos .xls/.xlsx en el multipart/form-data");
});

Deno.test("Integration: BAC Parser unit / structure sanity check", () => {
  const sheetData = [
    ["Estado de Cuenta BAC"],
    ["No. de Cuenta:", "123456789"],
    ["Titular:", "EMPRESA PRUEBA S.A."],
    ["Moneda:", "USD"],
    ["Saldo Inicial:", "500.00"],
    ["Saldo Final:", "595.00"],
    ["Periodo:", "01/07/2026 al 31/07/2026"],
    [],
    ["Fecha", "Código", "Descripción", "Referencia", "Débitos", "Créditos", "Balance"],
    ["01/07/2026", "PR", "DEPOSITO DE VENTA TPV COMPRA: 100", "REF12345", "0.00", "100.00", "600.00"],
    ["02/07/2026", "AD", "COMISION TPV", "REF12346", "5.00", "0.00", "595.00"],
  ];

  const result = parseBACSheet(sheetData);
  assertEquals(result.header.accountNumber, "123456789");
  assertEquals(result.rows.length, 2);
  assertEquals(result.rows[0].reference, "REF12345");
  assertEquals(result.rows[0].creditMinor, 10000n);
  assertEquals(result.rows[1].debitMinor, 500n);
});

Deno.test("Integration: bac-recon - Full flow with service key and Excel upload", async () => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  // Skip full live DB test if environment variables are not set or using mock URL
  if (!serviceKey || !supabaseUrl || supabaseUrl === "http://127.0.0.1:54321") {
    console.warn("Skipping live DB test execution: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required.");
    return;
  }

  const excelRows = [
    ["Estado de Cuenta BAC"],
    ["No. de Cuenta:", "987654321"],
    ["Titular:", "EMPRESA TEST"],
    ["Moneda:", "USD"],
    ["Saldo Inicial:", "0.00"],
    ["Saldo Final:", "1000.00"],
    ["Periodo:", "01/07/2026 al 31/07/2026"],
    [],
    ["Fecha", "Código", "Descripción", "Referencia", "Débitos", "Créditos", "Balance"],
    ["15/07/2026", "PR", "DEPOSITO COMPRA: 100 RETENCION ISV: 15 RETENCION ITMS: 7.5 REF: 888", "888", "0.00", "1000.00", "1000.00"],
  ];

  const excelBuffer = createBACExcelBuffer(excelRows);
  const file = new File([excelBuffer as any], "bac_test_statement.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const formData = new FormData();
  formData.append("file", file);

  const req = new Request("http://localhost/bac-recon?format=json", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${serviceKey}`,
      "x-user-id": "00000000-0000-0000-0000-000000000000",
    },
    body: formData,
  });

  const res = await mainHandler.fetch(req);
  assertEquals(res.status, 200);
  const json = await res.json();

  assertEquals(json.success, true);
  assertEquals(json.account_number, "987654321");
  assertEquals(Array.isArray(json.recon_stream), true);
});

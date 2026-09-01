import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface UserSession {
  userId: string;
  email?: string;
}

export function getAdminClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable missing");
  }
  return createClient(supabaseUrl, serviceKey);
}

export async function requireAuth(req: Request): Promise<UserSession> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  // Check if request uses SUPABASE_SERVICE_ROLE_KEY directly or passes a service_role JWT
  let isServiceRole = Boolean(serviceKey && token === serviceKey.trim());
  if (!isServiceRole) {
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const jsonPayload = decodeURIComponent(
          atob(base64)
            .split("")
            .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
            .join(""),
        );
        const payload = JSON.parse(jsonPayload);
        if (payload.role === "service_role") {
          isServiceRole = true;
        }
      }
    } catch {
      // Non-JWT or decode error fallback
    }
  }

  if (isServiceRole) {
    const userIdHeader = req.headers.get("x-user-id");
    return {
      userId: userIdHeader || "system",
      email: "service_role@supabase",
    };
  }

  // Otherwise, verify user session JWT
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error(`Authentication failed: ${error?.message || "Invalid token"}`);
  }

  return {
    userId: user.id,
    email: user.email,
  };
}


import { createClient } from "npm:@supabase/supabase-js@2";

export interface UserSession {
  userId: string;
  email?: string;
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

  // If request uses SUPABASE_SERVICE_ROLE_KEY directly (e.g. from Server Actions)
  if (serviceKey && token === serviceKey.trim()) {
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

  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    throw new Error(`Authentication failed: ${error?.message || "Invalid token"}`);
  }

  return {
    userId: user.id,
    email: user.email,
  };
}

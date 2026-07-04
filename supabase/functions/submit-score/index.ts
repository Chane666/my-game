import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanName(value: unknown) {
  const name = String(value || "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28);

  const clean = Array.from(name).slice(0, 14).join("");
  return clean && clean.toLowerCase() !== "guest" ? clean : null;
}

function cleanNumber(value: unknown, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function cleanCountryCode(value: string | null) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "XX") return null;
  return code;
}

function normalizeCountryCode(code: string | null) {
  if (!code) return null;
  return code === "HK" || code === "MO" || code === "TW" ? "CN" : code;
}

function cleanDeviceId(value: unknown) {
  const id = String(value || "").trim().slice(0, 48);
  return /^[a-zA-Z0-9_-]{8,48}$/.test(id) ? id : null;
}

function cleanAvatar(value: unknown) {
  const avatar = String(value || "bolt").trim().slice(0, 18);
  return /^[a-z0-9_-]{2,18}$/i.test(avatar) ? avatar : "bolt";
}

function countryFromTimezone(value: unknown) {
  const timezone = String(value || "");
  const timezoneMap: Record<string, string> = {
    "Asia/Shanghai": "CN",
    "Asia/Chongqing": "CN",
    "Asia/Harbin": "CN",
    "Asia/Urumqi": "CN",
    "Asia/Hong_Kong": "CN",
    "Asia/Macau": "CN",
    "Asia/Taipei": "CN",
    "America/New_York": "US",
    "America/Chicago": "US",
    "America/Denver": "US",
    "America/Los_Angeles": "US",
    "America/Phoenix": "US",
    "America/Anchorage": "US",
    "Pacific/Honolulu": "US",
    "Europe/London": "GB",
    "Asia/Tokyo": "JP",
    "Asia/Seoul": "KR",
    "Asia/Singapore": "SG",
    "Asia/Bangkok": "TH",
    "Asia/Jakarta": "ID",
    "Asia/Manila": "PH",
    "Asia/Kuala_Lumpur": "MY",
    "Asia/Kolkata": "IN",
    "Australia/Sydney": "AU",
    "Australia/Melbourne": "AU",
    "Europe/Paris": "FR",
    "Europe/Berlin": "DE",
    "Europe/Madrid": "ES",
    "Europe/Rome": "IT",
    "America/Toronto": "CA",
    "America/Vancouver": "CA",
    "America/Sao_Paulo": "BR",
    "America/Mexico_City": "MX",
  };

  return cleanCountryCode(timezoneMap[timezone] || null);
}

function getCountry(req: Request, body: Record<string, unknown> | null) {
  const rawCode = cleanCountryCode(
    req.headers.get("cf-ipcountry") ||
      req.headers.get("x-country-code") ||
      req.headers.get("x-vercel-ip-country") ||
      String(body?.country_code || ""),
  );
  const countryCode = normalizeCountryCode(rawCode || countryFromTimezone(body?.timezone));

  return {
    country_code: countryCode,
    country_name: countryCode ? regionNames.of(countryCode) || countryCode : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const body = ((await req.json().catch(() => ({}))) || {}) as Record<string, unknown>;
    const score = cleanNumber(body.score);

    if (score <= 0) {
      return json({ error: "Invalid score" }, 400);
    }

    const name = cleanName(body.name);
    const deviceId = cleanDeviceId(body.device_id);

    if (!name || !deviceId) {
      return json({ error: "Profile required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default;

    if (!supabaseUrl || !serviceKey) {
      return json({ error: "Server config missing" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    const country = getCountry(req, body);

    const payload = {
      device_id: deviceId,
      name,
      score,
      packages: cleanNumber(body.packages),
      combo: cleanNumber(body.combo),
      accuracy: Math.max(0, Math.min(100, cleanNumber(body.accuracy))),
      avatar: cleanAvatar(body.avatar),
      country_code: country.country_code,
      country_name: country.country_name,
      updated_at: new Date().toISOString(),
    };
    const profilePayload = {
      name,
      avatar: payload.avatar,
      country_code: country.country_code,
      country_name: country.country_name,
      updated_at: payload.updated_at,
    };

    const { data: current, error: readError } = await supabase
      .from("leaderboard_scores")
      .select("id,score")
      .eq("device_id", deviceId)
      .maybeSingle();

    if (readError) {
      console.error(readError);
      return json({ error: "Database read failed" }, 500);
    }

    if (current && cleanNumber(current.score) >= score) {
      const { error: profileError } = await supabase
        .from("leaderboard_scores")
        .update(profilePayload)
        .eq("id", current.id);

      if (profileError) {
        console.error(profileError);
        return json({ error: "Database profile update failed" }, 500);
      }
      return json({ ok: true, kept: "existing_best" });
    }

    const query = current
      ? supabase.from("leaderboard_scores").update(payload).eq("id", current.id)
      : supabase.from("leaderboard_scores").insert(payload);

    const { error } = await query;

    if (error) {
      console.error(error);
      return json({ error: "Database write failed" }, 500);
    }

    return json({ ok: true, saved: true });
  } catch (error) {
    console.error(error);
    return json({ error: "Server error" }, 500);
  }
});

import { createClient } from "@libsql/client/web";
export default {
  async fetch(request, env, ctx) {
    try {
      const db = buildDb(env);
      const url = new URL(request.url);
      const path = url.pathname;

      // ===== 1️⃣ METHOD PROTECTION =====
      if (request.method !== "GET") {
        return forbidden("Method Not Allowed", 405);
      }

      // ===== 2️⃣ BASIC BOT FILTER =====
      const ua = request.headers.get("User-Agent") || "";
      if (!ua.includes("Mozilla")) {
        return forbidden("Bots Not Allowed", 403);
      }

      // ===== 3️⃣ ORIGIN CHECK =====
      const origin = request.headers.get("Origin");
      if (origin && origin !== env.ALLOWED_ORIGIN) {
        return forbidden("Invalid Origin", 403);
      }

      // ===== 4️⃣ RATE LIMIT =====
      if (!(await rateLimit(request, env))) {
        return forbidden("Too Many Requests", 429);
      }

      // ===== ROUTE: SINGLE ANIME DETAILS =====
if (path.startsWith("/api/anime/")) {

  const id = path.split("/api/anime/")[1];
  if (!id) return forbidden("Invalid ID", 400);

  const result = await db.execute({
    sql: `
      SELECT *
      FROM anime_info
      WHERE id = ?
      LIMIT 1
    `,
    args: [id]
  });

  if (!result.rows.length) {
    return forbidden("Not Found", 404);
  }

  return json(result.rows[0]);
}
      // ===== ROUTE: SEARCH =====
if (path === "/api/search") {

  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  if (!q) return json([]);

  const result = await db.execute({
    sql: `
      SELECT id, title, year, type, audio, image_url
      FROM anime_info
      WHERE LOWER(title) LIKE ?
      LIMIT 20
    `,
    args: [`%${q}%`]
  });

  return json(result.rows);
}
      // ===== ROUTE: PAGINATED LIST =====
if (path === "/api/anime") {

  const page = Math.max(parseInt(url.searchParams.get("page") || "1"), 1);

  // 🔹 Create clean cache URL (only page param allowed)
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";               // remove all query params
  cacheUrl.searchParams.set("page", page);

  const cacheKey = new Request(cacheUrl.toString(), {
    method: "GET"
  });

  const cache = caches.default;

  // 1️⃣ Try cache first
  let response = await cache.match(cacheKey);
  if (response) {
    return response;
  }

// 2️⃣ Fetch from DB
response = await getPaginatedAnime(cacheUrl, db);

// 3️⃣ Cache successful responses only
if (response.status === 200) {

  // 🔥 Update GitHub JSON in background (ONLY on cache miss)
  ctx.waitUntil(updateGitHubJSON(env, db));

  // Store response in cache
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
}

  return response;
}

      return forbidden("Not Found", 404);

    } catch (err) {
  console.error(err);
  return forbidden("Internal Error", 500);
}
  }
};

// ================= RATE LIMIT =================
async function rateLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `rl:${ip}`;

  const current = await env.RATE_LIMIT.get(key);
  const count = current ? parseInt(current) : 0;

  if (count >= 40) return false;

  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}
function buildDb(env) {
  if (!env.TURSO_DATABASE_URL) {
    throw new Error("Missing TURSO_DATABASE_URL");
  }

  if (!env.TURSO_AUTH_TOKEN) {
    throw new Error("Missing TURSO_AUTH_TOKEN");
  }

  return createClient({
    url: env.TURSO_DATABASE_URL.trim(),
    authToken: env.TURSO_AUTH_TOKEN.trim(),
  });
}
// ================= PAGINATED ANIME =================
async function getPaginatedAnime(url, db) {

  const page = Math.max(parseInt(url.searchParams.get("page") || "1"), 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  const result = await db.execute({
    sql: `
      SELECT ai.id, ai.title, ai.year, ai.type, ai.audio,
             ai.image_url, ai.duration, ai.rating
      FROM anime_info ai
      WHERE EXISTS (
        SELECT 1 FROM streaming_link sl WHERE sl.anime_id = ai.id
      )
      LIMIT ? OFFSET ?
    `,
    args: [limit, offset]
  });

  return json(result.rows);
}
async function updateGitHubJSON(env, db) {

  // 1️⃣ Get FULL dataset (not paginated)
const result = await db.execute({
  sql: `
    SELECT ai.id, ai.title, ai.year, ai.type, ai.audio,
           ai.image_url, ai.duration, ai.rating
    FROM anime_info ai
    WHERE EXISTS (
      SELECT 1 FROM streaming_link sl WHERE sl.anime_id = ai.id
    )
  `
});
const results = result.rows;

  const content = JSON.stringify(results, null, 2);
  const base64Content = btoa(
  new TextEncoder().encode(content)
    .reduce((data, byte) => data + String.fromCharCode(byte), '')
);
 const getFile = await fetch(
  `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.GITHUB_PATH}`,
  {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  }
);
  const fileData = await getFile.json();
  const sha = fileData.sha;
  // 3️⃣ Push update
  await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${env.GITHUB_PATH}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json"
      },
      body: JSON.stringify({
        message: "Auto update anime.json",
        content: base64Content,
        sha: sha
      })
    }
  );
}
// ================= JSON RESPONSE =================
function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=43200, s-maxage=43200",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer"
    }
  });
}

function forbidden(msg, code) {
  return new Response(msg, { status: code });
}
// Ranking do Spike Jump (Netlify Blobs).
// GET  /.netlify/functions/ranking?pid=XXXX  -> { top, me, total }
// POST /.netlify/functions/ranking { hash, name, score, level, ball } -> { pid, best, top, me, total }
import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";

const STORE = "ranking";   // nome do store; se o seu já usa outro nome, troque aqui
const TOP = 100;           // quantos jogadores o ranking devolve
const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: HEADERS });

const cleanName = (v) =>
  String(v || "").replace(/[^\p{L}\p{N} _.\-!]/gu, "").replace(/\s+/g, " ").trim().slice(0, 14);
const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));

async function loadAll(store) {
  const { blobs } = await store.list({ prefix: "p/" });
  const rows = await Promise.all(
    blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null))
  );
  return rows.filter((r) => r && r.pid && r.best > 0);
}

function build(all, pid) {
  all.sort((a, b) => b.best - a.best || (a.at || 0) - (b.at || 0));
  const ranked = all.map((r, i) => ({
    rank: i + 1, pid: r.pid, name: r.name, best: r.best, level: r.level || 0, ball: r.ball || "",
  }));
  return {
    top: ranked.slice(0, TOP),
    me: pid ? ranked.find((r) => r.pid === pid) || null : null,
    total: ranked.length,
  };
}

export default async (req) => {
  const store = getStore({ name: STORE, consistency: "strong" });
  try {
    if (req.method === "GET") {
      const pid = new URL(req.url).searchParams.get("pid") || "";
      return json(build(await loadAll(store), /^[0-9a-f]{16}$/.test(pid) ? pid : ""));
    }
    if (req.method !== "POST") return json({ error: "method" }, 405);

    const b = await req.json().catch(() => null);
    if (!b || !/^[0-9a-f]{64}$/.test(b.hash || "")) return json({ error: "hash" }, 400);
    const name = cleanName(b.name);
    if (name.length < 2) return json({ error: "name" }, 400);

    const pid = createHash("sha256").update(b.hash).digest("hex").slice(0, 16);
    const key = "p/" + pid;
    const score = int(b.score, 10_000_000);
    const level = int(b.level, 999);
    const ball = /^[a-z0-9-]{1,24}$/.test(b.ball || "") ? b.ball : "";

    const old = await store.get(key, { type: "json" }).catch(() => null);
    if (!old && score <= 0) return json({ pid, best: 0, ...build(await loadAll(store), pid) });

    const rec = old || { pid, best: 0, level: 0, ball: "", at: Date.now() };
    rec.name = name;
    if (score > rec.best) {      // nível e bola ficam gravados junto com o recorde
      rec.best = score; rec.level = level; rec.ball = ball; rec.at = Date.now();
    }
    await store.setJSON(key, rec);
    return json({ pid, best: rec.best, ...build(await loadAll(store), pid) });
  } catch (e) {
    return json({ error: "server" }, 500);
  }
};

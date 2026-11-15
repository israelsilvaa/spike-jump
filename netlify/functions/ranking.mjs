// Ranking do Spike Jump, guardado no Netlify Blobs.
//
//   GET  /.netlify/functions/ranking?pid=XXXXXXXXXX  -> top 100 (+ a posição de quem pediu)
//   POST /.netlify/functions/ranking                 -> { hash, name, score, level, ball }
//
// O "hash" de 64 caracteres é gerado no navegador do jogador e nunca é gravado
// aqui: guardamos só o SHA-256 dele (a chave do blob). O "pid" público é o
// começo dessa chave e serve apenas para o jogador achar a própria linha.

import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const STORE_NAME = "spike-jump-ranking";
const MAX_SCORE = 500000; // teto de sanidade contra valores absurdos
const TOP = 100;
const MAX_LEVEL = 999;
const CACHE_MS = 15000;

let cache = null; // { t, rows } — vale só enquanto esta instância da função estiver quente

const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function cleanName(v) {
  const n = String(v ?? "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} _.\-!]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 14);
  return n.length >= 2 ? n : "Jogador";
}

const sortRows = (rows) => rows.sort((a, b) => b.best - a.best || a.at - b.at);

async function loadRows(store, force = false) {
  if (!force && cache && Date.now() - cache.t < CACHE_MS) return cache.rows.slice();

  const { blobs } = await store.list();
  const keys = blobs.map((b) => b.key).slice(0, 3000);
  const rows = [];

  for (let i = 0; i < keys.length; i += 40) {
    const chunk = keys.slice(i, i + 40);
    const vals = await Promise.all(
      chunk.map((k) => store.get(k, { type: "json" }).catch(() => null))
    );
    vals.forEach((v, j) => {
      if (v && Number.isFinite(v.best) && v.best > 0) {
        rows.push({
          pid: chunk[j].slice(0, 10),
          name: String(v.name || "Jogador"),
          best: v.best,
          level: Number.isFinite(v.level) ? v.level : 0,
          ball: typeof v.ball === "string" ? v.ball : "",
          at: v.at || 0,
        });
      }
    });
  }

  sortRows(rows);
  cache = { t: Date.now(), rows };
  return rows.slice();
}

function view(rows, pid) {
  const ranked = rows.map((r, i) => ({
    pid: r.pid,
    name: r.name,
    best: r.best,
    level: r.level || 0,
    ball: r.ball || "",
    rank: i + 1,
  }));
  const me = pid ? ranked.find((r) => r.pid === pid) || null : null;
  return { top: ranked.slice(0, TOP), total: ranked.length, me };
}

export default async (req) => {
  try {
    const store = getStore({ name: STORE_NAME, consistency: "strong" });

    if (req.method === "GET") {
      const pid = new URL(req.url).searchParams.get("pid") || "";
      const rows = await loadRows(store);
      return reply(view(rows, /^[a-f0-9]{10}$/.test(pid) ? pid : ""));
    }

    if (req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return reply({ error: "JSON inválido" }, 400);
      }

      const hash = String(body?.hash || "");
      if (!/^[a-f0-9]{64}$/.test(hash)) return reply({ error: "hash inválido" }, 400);

      const score = Math.floor(Number(body?.score));
      if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
        return reply({ error: "pontuação inválida" }, 400);
      }

      const level = Math.max(0, Math.min(MAX_LEVEL, Math.floor(Number(body?.level)) || 0));
      const ball = /^[a-z0-9-]{1,24}$/.test(String(body?.ball || "")) ? String(body.ball) : "";
      const name = cleanName(body?.name);
      const key = sha256(hash);
      const pid = key.slice(0, 10);

      const cur = await store.get(key, { type: "json" });
      let rec = cur;
      let improved = false;

      if (!cur) {
        // só entra no ranking quem fez ponto
        if (score > 0) {
          rec = { name, best: score, level, ball, at: Date.now() };
          await store.setJSON(key, rec);
          improved = true;
        }
      } else {
        const next = { ...cur };
        let changed = false;
        if (score > cur.best) {
          next.best = score;
          next.level = level; // nível e bola ficam gravados junto com o recorde
          next.ball = ball;
          next.at = Date.now();
          improved = true;
          changed = true;
        }
        if (name !== cur.name) {
          next.name = name;
          changed = true;
        }
        if (changed) {
          await store.setJSON(key, next);
          rec = next;
        }
      }

      const rows = await loadRows(store, true);

      // garante que a linha recém-gravada apareça mesmo se a listagem ainda estiver atrasada
      if (rec) {
        const row = {
          pid,
          name: rec.name,
          best: rec.best,
          level: rec.level || 0,
          ball: rec.ball || "",
          at: rec.at || 0,
        };
        const i = rows.findIndex((r) => r.pid === pid);
        if (i >= 0) rows[i] = row;
        else rows.push(row);
        sortRows(rows);
        cache = { t: Date.now(), rows: rows.slice() };
      }

      return reply({
        ok: true,
        pid,
        improved,
        best: rec ? rec.best : 0,
        ...view(rows, rec ? pid : ""),
      });
    }

    return reply({ error: "método não permitido" }, 405);
  } catch (err) {
    console.error("ranking:", err);
    return reply({ error: "erro no servidor" }, 500);
  }
};

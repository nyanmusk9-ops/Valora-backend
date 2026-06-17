/* ============================================================================
   VALORA BACKEND v2 — Postgres source of truth
   - Collection, équipe, packs, dismantle, treasury, coins : 100% serveur.
   - Le client n'est plus de confiance pour les cartes possédées / l'équipe.
   - Garde le PvP en ligne existant (matchmaking + relay + presence + finish).
   ========================================================================== */
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;

/* ---- Postgres pool ---- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com"))
    ? { rejectUnauthorized: false } : false
});

/* ===========================================================================
   CONFIG ÉCONOMIE / JEU (source de vérité serveur)
   =========================================================================== */
const CHAMPIONS = {
  pyron:    { name: "Pyron",    element: "fire",     rarity: "common" },
  florabel: { name: "Florabel", element: "leaf",     rarity: "common" },
  tidus:    { name: "Tidus",    element: "water",    rarity: "rare" },
  voltik:   { name: "Voltik",   element: "electric", rarity: "rare" },
  frostle:  { name: "Frostle",  element: "ice",      rarity: "epic" },
  umbron:   { name: "Umbron",   element: "shadow",   rarity: "legendary" }
};
const CHAMP_IDS = Object.keys(CHAMPIONS);
const STARTERS = ["pyron", "florabel", "frostle"];     // offerts à la création, soulbound
// la rareté est une propriété du champion (comme dans le front) -> groupes par rareté
const BY_RARITY = { common: [], rare: [], epic: [], legendary: [] };
for (const _id of CHAMP_IDS) BY_RARITY[CHAMPIONS[_id].rarity].push(_id);

const POWER_BY_RARITY    = { common: 25, rare: 50, epic: 75, legendary: 100 };
const DISMANTLE_COINS    = { common: 50, rare: 120, epic: 300, legendary: 700 };
const PACK_COIN_PRICE    = { basic: 10, epic: 20, legendary: 30 };
const PACK_TICKET_PRICE  = { basic: 15, epic: 25, legendary: 40 };
const PACK_WEIGHTS = {
  basic:     { common: 75, rare: 25 },
  epic:      { common: 20, rare: 47, epic: 33 },
  legendary: { epic: 80, legendary: 20 }
};
const PACK_GUARANTEE = { basic: "rare", epic: "epic", legendary: "legendary" };
const PACK_SIZE = 5;
const ARENA_ENTRY = { casual: 0, bronze: 10, silver: 35, gold: 50 };

const ONLINE_WINDOW_MS = 60 * 1000;
const MATCH_TTL = 3 * 60 * 1000;
const QUEUE_TTL = 90 * 1000;

/* ===========================================================================
   SCHÉMA — créé au démarrage si absent
   =========================================================================== */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  wallet_address TEXT,
  coins BIGINT NOT NULL DEFAULT 0,
  tickets INTEGER NOT NULL DEFAULT 0,
  locked_coins BIGINT NOT NULL DEFAULT 0,
  elo INTEGER NOT NULL DEFAULT 1800,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  champion TEXT NOT NULL,
  element TEXT NOT NULL,
  rarity TEXT NOT NULL,
  power INTEGER NOT NULL DEFAULT 0,
  soulbound BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_cards_user ON user_cards(user_id);
CREATE TABLE IF NOT EXISTS user_team (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  card_ids JSONB NOT NULL DEFAULT '[]',
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS pack_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pack_type TEXT NOT NULL,
  paid_with TEXT NOT NULL,
  price INTEGER NOT NULL,
  cards JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  arena_id TEXT NOT NULL,
  player_a TEXT NOT NULL,
  player_b TEXT NOT NULL,
  player_a_nick TEXT,
  player_b_nick TEXT,
  player_a_team JSONB,
  player_b_team JSONB,
  entry_coins INTEGER NOT NULL DEFAULT 0,
  pot_coins INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  winner_id TEXT,
  loser_id TEXT,
  prize_coins INTEGER,
  created_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE TABLE IF NOT EXISTS treasury (
  id INTEGER PRIMARY KEY,
  pack_revenue BIGINT NOT NULL DEFAULT 0,
  total_revenue BIGINT NOT NULL DEFAULT 0
);
INSERT INTO treasury (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

/* ===========================================================================
   HELPERS
   =========================================================================== */
function newId(p) { return `${p}_${crypto.randomUUID()}`; }
function sanitizeName(n) { return (String(n || "Nova").replace(/[<>&"']/g, "").trim().slice(0, 14) || "Nova"); }
function randomChampOfRarity(r) { const arr = (BY_RARITY[r] && BY_RARITY[r].length) ? BY_RARITY[r] : CHAMP_IDS; return arr[Math.floor(Math.random() * arr.length)]; }
function randomRarity(w) {
  const t = Object.values(w).reduce((a, b) => a + b, 0);
  let r = Math.random() * t;
  for (const [k, v] of Object.entries(w)) { r -= v; if (r <= 0) return k; }
  return "common";
}
function newCard(champId, soulbound) {
  const c = CHAMPIONS[champId];
  return {
    id: newId("card"), champion: champId, element: c.element,
    rarity: c.rarity, power: POWER_BY_RARITY[c.rarity] || 0, soulbound: !!soulbound
  };
}
function generatePack(type) {
  const cards = [newCard(randomChampOfRarity(PACK_GUARANTEE[type]), false)];
  while (cards.length < PACK_SIZE) cards.push(newCard(randomChampOfRarity(randomRarity(PACK_WEIGHTS[type])), false));
  return cards;
}
function userJson(r) {
  return {
    id: r.id, username: r.username, walletAddress: r.wallet_address,
    coins: Number(r.coins), tickets: r.tickets, lockedCoins: Number(r.locked_coins),
    elo: r.elo, wins: r.wins, losses: r.losses,
    balanceUsd: Number(r.coins) // alias rétro-compat (ancien front)
  };
}
function cardJson(r) {
  return { id: r.id, champion: r.champion, element: r.element, rarity: r.rarity, power: r.power, soulbound: r.soulbound };
}
function matchJson(m) {
  return {
    id: m.id, arenaId: m.arena_id,
    playerA: m.player_a, playerB: m.player_b,
    playerANick: m.player_a_nick, playerBNick: m.player_b_nick,
    playerATeam: m.player_a_team, playerBTeam: m.player_b_team,
    entryUsd: m.entry_coins, entryCoins: m.entry_coins,
    potUsd: m.pot_coins, potCoins: m.pot_coins,
    status: m.status, winnerId: m.winner_id, loserId: m.loser_id,
    prizeUsd: m.prize_coins, prizeCoins: m.prize_coins,
    createdAt: Number(m.created_at)
  };
}

/* présence en mémoire (évite d'écrire en DB à chaque heartbeat) */
const lastSeen = {};
function seen(id) { if (id) lastSeen[id] = Date.now(); }

/* file d'attente en mémoire (transitoire), relay PvP en mémoire */
const queue = { casual: [], bronze: [], silver: [], gold: [] };
const battles = {};

async function getValidTeamSnapshot(userId) {
  const t = await pool.query("SELECT card_ids FROM user_team WHERE user_id=$1", [userId]);
  const ids = (t.rows[0] && t.rows[0].card_ids) || [];
  if (ids.length !== 2) return null;
  const c = await pool.query("SELECT * FROM user_cards WHERE user_id=$1 AND id = ANY($2::text[])", [userId, ids]);
  if (c.rows.length !== 2) return null;
  const byId = {}; c.rows.forEach(r => byId[r.id] = r);
  const ordered = ids.map(id => byId[id]).filter(Boolean);
  if (ordered.length !== 2) return null;
  return ordered.map(cardJson);
}
async function activeMatchFor(userId) {
  const r = await pool.query(
    "SELECT * FROM matches WHERE status='active' AND (player_a=$1 OR player_b=$1) AND created_at > $2 ORDER BY created_at DESC LIMIT 1",
    [userId, Date.now() - MATCH_TTL]);
  return r.rows[0] || null;
}
function queuedTicketFor(userId) {
  const now = Date.now();
  for (const a of Object.keys(queue)) {
    const t = queue[a].find(x => x.userId === userId && now - x.createdAt < QUEUE_TTL);
    if (t) return t;
  }
  return null;
}
async function refundTicket(x) {
  if (x.entry > 0) await pool.query("UPDATE users SET coins=coins+$1, locked_coins=GREATEST(0,locked_coins-$1) WHERE id=$2", [x.entry, x.userId]);
}
async function lockEntry(userId, entry) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ur = await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const u = ur.rows[0];
    if (!u) throw new Error("User not found");
    if (Number(u.coins) < entry) throw new Error("Not enough coins");
    if (entry > 0) await client.query("UPDATE users SET coins=coins-$1, locked_coins=locked_coins+$1 WHERE id=$2", [entry, userId]);
    await client.query("COMMIT");
    return u;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

/* ===========================================================================
   ROUTES — santé / comptes
   =========================================================================== */
app.get("/", (req, res) => res.json({ success: true, message: "Valora v2 backend (Postgres) is running" }));

app.post("/api/users", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = newId("user");
    const username = sanitizeName(req.body.username);
    const now = Date.now();
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO users(id,username,coins,tickets,locked_coins,elo,wins,losses,created_at) VALUES($1,$2,0,0,0,1800,0,0,$3)",
      [id, username, now]);
    const starterIds = [];
    for (const champ of STARTERS) {
      const c = newCard(champ, true); // soulbound (rareté = celle du champion)
      await client.query(
        "INSERT INTO user_cards(id,user_id,champion,element,rarity,power,soulbound,created_at) VALUES($1,$2,$3,$4,$5,$6,true,$7)",
        [c.id, id, c.champion, c.element, c.rarity, c.power, now]);
      starterIds.push(c.id);
    }
    await client.query("INSERT INTO user_team(user_id,card_ids,updated_at) VALUES($1,$2,$3)",
      [id, JSON.stringify(starterIds.slice(0, 2)), now]);
    await client.query("COMMIT");
    seen(id);
    const u = (await pool.query("SELECT * FROM users WHERE id=$1", [id])).rows[0];
    res.json({ success: true, user: userJson(u) });
  } catch (e) { await client.query("ROLLBACK"); res.status(400).json({ success: false, error: e.message }); }
  finally { client.release(); }
});

app.get("/api/users/:userId", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM users WHERE id=$1", [req.params.userId]);
    if (!r.rows[0]) return res.status(400).json({ success: false, error: "User not found" });
    seen(req.params.userId);
    res.json({ success: true, user: userJson(r.rows[0]) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post("/api/users/:userId/rename", async (req, res) => {
  try {
    const name = sanitizeName(req.body.username);
    const r = await pool.query("UPDATE users SET username=$1 WHERE id=$2 RETURNING *", [name, req.params.userId]);
    if (!r.rows[0]) throw new Error("User not found");
    res.json({ success: true, user: userJson(r.rows[0]) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post("/api/users/:userId/connect-wallet", async (req, res) => {
  try {
    const w = String(req.body.walletAddress || "").trim();
    if (!w) throw new Error("Wallet address required");
    const r = await pool.query("UPDATE users SET wallet_address=$1 WHERE id=$2 RETURNING *", [w, req.params.userId]);
    if (!r.rows[0]) throw new Error("User not found");
    res.json({ success: true, user: userJson(r.rows[0]) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post("/api/heartbeat", (req, res) => { seen(req.body.userId); res.json({ success: true }); });
app.get("/api/online", (req, res) => {
  const now = Date.now();
  const online = Object.values(lastSeen).filter(ts => now - ts < ONLINE_WINDOW_MS).length;
  res.json({ success: true, online });
});
app.get("/api/leaderboard", async (req, res) => {
  try {
    const r = await pool.query("SELECT id,username,elo,wins,losses FROM users ORDER BY elo DESC LIMIT 50");
    const tot = await pool.query("SELECT COUNT(*)::int AS c FROM users");
    res.json({ success: true, total: tot.rows[0].c, top: r.rows });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* ===========================================================================
   COINS (mock — supply achetée) + faucet rétro-compat
   =========================================================================== */
async function addCoins(userId, amount) {
  amount = Math.max(0, Math.floor(Number(amount || 0)));
  if (!amount) throw new Error("Invalid amount");
  const r = await pool.query("UPDATE users SET coins=coins+$1 WHERE id=$2 RETURNING *", [amount, userId]);
  if (!r.rows[0]) throw new Error("User not found");
  return r.rows[0];
}
app.post("/api/coins/add", async (req, res) => {
  try { const u = await addCoins(req.body.userId, req.body.amount); res.json({ success: true, addedCoins: Math.floor(Number(req.body.amount)), user: userJson(u) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});
app.post("/api/users/:userId/faucet", async (req, res) => {
  try { const u = await addCoins(req.params.userId, req.body.amountUsd || req.body.amount || 100); res.json({ success: true, user: userJson(u) }); }
  catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* ===========================================================================
   COLLECTION / ÉQUIPE
   =========================================================================== */
app.get("/api/users/:userId/collection", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM user_cards WHERE user_id=$1 ORDER BY created_at ASC", [req.params.userId]);
    res.json({ success: true, cards: r.rows.map(cardJson) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.get("/api/users/:userId/team", async (req, res) => {
  try {
    const t = await pool.query("SELECT card_ids FROM user_team WHERE user_id=$1", [req.params.userId]);
    const ids = (t.rows[0] && t.rows[0].card_ids) || [];
    if (!ids.length) return res.json({ success: true, team: [], cardIds: [] });
    const c = await pool.query("SELECT * FROM user_cards WHERE user_id=$1 AND id = ANY($2::text[])", [req.params.userId, ids]);
    const byId = {}; c.rows.forEach(r => byId[r.id] = r);
    const team = ids.map(id => byId[id]).filter(Boolean).map(cardJson);
    res.json({ success: true, team, cardIds: ids });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post("/api/team/save", async (req, res) => {
  try {
    const { userId, cardIds } = req.body;
    if (!Array.isArray(cardIds) || cardIds.length !== 2) throw new Error("Select exactly 2 champions");
    if (cardIds[0] === cardIds[1]) throw new Error("Duplicate card selected");
    const c = await pool.query("SELECT id FROM user_cards WHERE user_id=$1 AND id = ANY($2::text[])", [userId, cardIds]);
    const owned = new Set(c.rows.map(r => r.id));
    for (const id of cardIds) if (!owned.has(id)) throw new Error("You do not own one of these cards");
    const now = Date.now();
    await pool.query(
      "INSERT INTO user_team(user_id,card_ids,updated_at) VALUES($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET card_ids=$2, updated_at=$3",
      [userId, JSON.stringify(cardIds), now]);
    res.json({ success: true, cardIds });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* ===========================================================================
   PACKS (génération serveur) + treasury
   =========================================================================== */
app.post("/api/packs/buy", async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, packType } = req.body;
    const payWith = (req.body.payWith === "tickets") ? "tickets" : "coins";
    if (!PACK_COIN_PRICE[packType]) throw new Error("Invalid pack type");
    await client.query("BEGIN");
    const ur = await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const u = ur.rows[0];
    if (!u) throw new Error("User not found");
    const now = Date.now();
    let price;
    if (payWith === "coins") {
      price = PACK_COIN_PRICE[packType];
      if (Number(u.coins) < price) throw new Error("Not enough coins");
      await client.query("UPDATE users SET coins=coins-$1 WHERE id=$2", [price, userId]);
      await client.query("UPDATE treasury SET pack_revenue=pack_revenue+$1, total_revenue=total_revenue+$1 WHERE id=1", [price]);
    } else {
      price = PACK_TICKET_PRICE[packType];
      if (u.tickets < price) throw new Error("Not enough tickets");
      await client.query("UPDATE users SET tickets=tickets-$1 WHERE id=$2", [price, userId]);
    }
    const cards = generatePack(packType);
    for (const c of cards) {
      await client.query(
        "INSERT INTO user_cards(id,user_id,champion,element,rarity,power,soulbound,created_at) VALUES($1,$2,$3,$4,$5,$6,false,$7)",
        [c.id, userId, c.champion, c.element, c.rarity, c.power, now]);
    }
    await client.query(
      "INSERT INTO pack_purchases(id,user_id,pack_type,paid_with,price,cards,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [newId("purchase"), userId, packType, payWith, price, JSON.stringify(cards), now]);
    await client.query("COMMIT");
    const nu = (await pool.query("SELECT * FROM users WHERE id=$1", [userId])).rows[0];
    res.json({ success: true, cards, paidWith: payWith, price, user: userJson(nu) });
  } catch (e) { await client.query("ROLLBACK"); res.status(400).json({ success: false, error: e.message }); }
  finally { client.release(); }
});

/* ===========================================================================
   DISMANTLE (rend des coins ; starters non-démantelables ; pas l'équipe active)
   =========================================================================== */
app.post("/api/cards/dismantle", async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, cardIds } = req.body;
    if (!Array.isArray(cardIds) || !cardIds.length) throw new Error("No cards selected");
    const uniq = [...new Set(cardIds)];
    await client.query("BEGIN");
    const cr = await client.query("SELECT * FROM user_cards WHERE user_id=$1 AND id = ANY($2::text[])", [userId, uniq]);
    if (cr.rows.length !== uniq.length) throw new Error("You do not own one of these cards");
    if (cr.rows.some(c => c.soulbound)) throw new Error("Starter champions cannot be dismantled");
    const t = await client.query("SELECT card_ids FROM user_team WHERE user_id=$1", [userId]);
    const teamIds = new Set((t.rows[0] && t.rows[0].card_ids) || []);
    if (uniq.some(id => teamIds.has(id))) throw new Error("Cannot dismantle a champion in your active team");
    let gain = 0; cr.rows.forEach(c => { gain += DISMANTLE_COINS[c.rarity] || 0; });
    await client.query("DELETE FROM user_cards WHERE user_id=$1 AND id = ANY($2::text[])", [userId, uniq]);
    await client.query("UPDATE users SET coins=coins+$1 WHERE id=$2", [gain, userId]);
    await client.query("COMMIT");
    const nu = (await pool.query("SELECT * FROM users WHERE id=$1", [userId])).rows[0];
    res.json({ success: true, dismantled: uniq.length, coinsGained: gain, user: userJson(nu) });
  } catch (e) { await client.query("ROLLBACK"); res.status(400).json({ success: false, error: e.message }); }
  finally { client.release(); }
});

/* ===========================================================================
   ARÈNE (anti-triche : équipe figée côté serveur)
   =========================================================================== */
app.get("/api/arena/status", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) throw new Error("userId required");
    seen(userId);
    const m = await activeMatchFor(userId);
    if (m) return res.json({ success: true, state: "matched", match: matchJson(m) });
    const t = queuedTicketFor(userId);
    if (t) return res.json({ success: true, state: "queued", ticket: t });
    res.json({ success: true, state: "idle" });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post("/api/arena/join", async (req, res) => {
  try {
    const { userId, arenaId } = req.body;
    if (!(arenaId in ARENA_ENTRY)) throw new Error("Invalid arena");
    const entry = ARENA_ENTRY[arenaId];
    seen(userId);

    const existing = await activeMatchFor(userId);
    if (existing) return res.json({ success: true, status: "matched", match: matchJson(existing) });
    const qt = queuedTicketFor(userId);
    if (qt) return res.json({ success: true, status: "queued", ticket: qt });

    // Anti-triche : on prend l'équipe SAUVEGARDÉE côté serveur.
    // Fallback temporaire sur l'équipe envoyée par le client tant que le front
    // n'a pas encore été branché sur /api/team/save (à retirer après).
    let snapshot = await getValidTeamSnapshot(userId);
    if (!snapshot) {
      if (Array.isArray(req.body.team) && req.body.team.length) snapshot = req.body.team;
      else throw new Error("Save a valid team (2 champions) before joining");
    }

    const u = await lockEntry(userId, entry); // débite + verrouille les coins
    const now = Date.now();
    const ticket = { id: newId("ticket"), userId, arenaId, entry, team: snapshot, nick: u.username, createdAt: now };
    const q = queue[arenaId];

    // purge des tickets périmés (refund)
    for (let i = q.length - 1; i >= 0; i--) {
      const x = q[i];
      if (x.userId === userId) { q.splice(i, 1); continue; }
      const fresh = (now - x.createdAt < QUEUE_TTL) && (now - (lastSeen[x.userId] || 0) < ONLINE_WINDOW_MS);
      if (!fresh) { await refundTicket(x); q.splice(i, 1); }
    }

    const oi = q.findIndex(x => x.userId !== userId);
    if (oi === -1) { q.push(ticket); return res.json({ success: true, status: "queued", ticket }); }

    const ot = q.splice(oi, 1)[0];
    const matchId = newId("match");
    const pot = entry * 2;
    await pool.query(
      "INSERT INTO matches(id,arena_id,player_a,player_b,player_a_nick,player_b_nick,player_a_team,player_b_team,entry_coins,pot_coins,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)",
      [matchId, arenaId, ot.userId, userId, ot.nick || "P1", u.username, JSON.stringify(ot.team), JSON.stringify(ticket.team), entry, pot, now]);
    const m = (await pool.query("SELECT * FROM matches WHERE id=$1", [matchId])).rows[0];
    res.json({ success: true, status: "matched", match: matchJson(m) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post("/api/arena/cancel", async (req, res) => {
  try {
    const { userId } = req.body;
    let refunded = 0;
    for (const a of Object.keys(queue)) {
      for (let i = queue[a].length - 1; i >= 0; i--) {
        const t = queue[a][i];
        if (t.userId === userId) { queue[a].splice(i, 1); if (t.entry > 0) { await refundTicket(t); refunded += t.entry; } }
      }
    }
    const ms = await pool.query("SELECT * FROM matches WHERE status='active' AND (player_a=$1 OR player_b=$1)", [userId]);
    for (const m of ms.rows) {
      await pool.query("UPDATE matches SET status='abandoned', finished_at=$2 WHERE id=$1", [m.id, Date.now()]);
      if (m.entry_coins > 0) for (const pid of [m.player_a, m.player_b])
        await pool.query("UPDATE users SET coins=coins+$1, locked_coins=GREATEST(0,locked_coins-$1) WHERE id=$2", [m.entry_coins, pid]);
    }
    const u = (await pool.query("SELECT * FROM users WHERE id=$1", [userId])).rows[0];
    res.json({ success: true, refundedCoins: refunded, user: u ? userJson(u) : null });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.get("/api/matches/:matchId", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM matches WHERE id=$1", [req.params.matchId]);
    if (!r.rows[0]) throw new Error("Match not found");
    res.json({ success: true, match: matchJson(r.rows[0]) });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.get("/api/matches/:matchId/presence", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM matches WHERE id=$1", [req.params.matchId]);
    const m = r.rows[0];
    if (!m) throw new Error("Match not found");
    const now = Date.now();
    const players = [m.player_a, m.player_b].map(id => {
      const ls = lastSeen[id] || 0;
      return { id, lastSeen: ls, agoMs: now - ls, online: (now - ls) < ONLINE_WINDOW_MS };
    });
    res.json({ success: true, now, status: m.status, players });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.post("/api/matches/:matchId/finish", async (req, res) => {
  const client = await pool.connect();
  try {
    const matchId = req.params.matchId;
    const { winnerId } = req.body;
    await client.query("BEGIN");
    const mr = await client.query("SELECT * FROM matches WHERE id=$1 FOR UPDATE", [matchId]);
    const m = mr.rows[0];
    if (!m) throw new Error("Match not found");
    if (m.status !== "active") throw new Error("Match already finished");
    if (![m.player_a, m.player_b].includes(winnerId)) throw new Error("Invalid winner");
    // NOTE: le vainqueur est encore rapporté par le client (combat non vérifié serveur).
    //       L'anti-triche de CETTE étape porte sur les ÉQUIPES (snapshot serveur).
    const loserId = winnerId === m.player_a ? m.player_b : m.player_a;
    const entry = m.entry_coins, pot = m.pot_coins;
    const wr = await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [winnerId]);
    const lr = await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [loserId]);
    const winner = wr.rows[0], loser = lr.rows[0];
    if (!winner || !loser) throw new Error("Players not found");
    const ranked = m.arena_id !== "casual"; // Casual = No ELO impact
    let newWinElo = winner.elo, newLoseElo = loser.elo;
    if (ranked) {
      const ea = 1 / (1 + Math.pow(10, (loser.elo - winner.elo) / 400));
      newWinElo = Math.round(winner.elo + 32 * (1 - ea));
      newLoseElo = Math.max(100, Math.round(loser.elo + 32 * (0 - (1 - ea))));
    }
    if (entry > 0) {
      await client.query("UPDATE users SET locked_coins=GREATEST(0,locked_coins-$1), coins=coins+$2, wins=wins+1, elo=$3 WHERE id=$4", [entry, pot, newWinElo, winnerId]);
      await client.query("UPDATE users SET locked_coins=GREATEST(0,locked_coins-$1), losses=losses+1, elo=$2 WHERE id=$3", [entry, newLoseElo, loserId]);
    } else {
      await client.query("UPDATE users SET wins=wins+1, elo=$1 WHERE id=$2", [newWinElo, winnerId]);
      await client.query("UPDATE users SET losses=losses+1, elo=$1 WHERE id=$2", [newLoseElo, loserId]);
    }
    await client.query("UPDATE matches SET status='finished', winner_id=$1, loser_id=$2, prize_coins=$3, finished_at=$4 WHERE id=$5", [winnerId, loserId, pot, Date.now(), matchId]);
    await client.query("COMMIT");
    const m2 = (await pool.query("SELECT * FROM matches WHERE id=$1", [matchId])).rows[0];
    const w2 = (await pool.query("SELECT * FROM users WHERE id=$1", [winnerId])).rows[0];
    res.json({ success: true, match: matchJson(m2), winner: userJson(w2), prizeUsd: pot, prizeCoins: pot });
  } catch (e) { await client.query("ROLLBACK"); res.status(400).json({ success: false, error: e.message }); }
  finally { client.release(); }
});

app.get("/api/treasury", async (req, res) => {
  try {
    const t = (await pool.query("SELECT * FROM treasury WHERE id=1")).rows[0];
    const pc = await pool.query("SELECT COUNT(*)::int AS c FROM pack_purchases");
    res.json({ success: true, treasury: { packRevenue: Number(t.pack_revenue), totalRevenue: Number(t.total_revenue) }, purchases: pc.rows[0].c });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* ---- LIVE BATTLE relay (mémoire ; tour par tour via polling) ---- */
app.get("/api/battles/:matchId", (req, res) => { res.json({ success: true, battle: battles[req.params.matchId] || null }); });
app.post("/api/battles/:matchId/push", async (req, res) => {
  try {
    const mid = req.params.matchId;
    const mr = await pool.query("SELECT player_a,player_b FROM matches WHERE id=$1", [mid]);
    const m = mr.rows[0];
    if (!m) throw new Error("Match not found");
    const { userId, version, turn, state, log, winnerId } = req.body;
    if (![m.player_a, m.player_b].includes(userId)) throw new Error("Not a participant");
    const prev = battles[mid];
    const v = (typeof version === "number") ? version : (((prev && prev.version) || 0) + 1);
    if (prev && v <= prev.version) return res.json({ success: true, battle: prev, stale: true });
    battles[mid] = {
      version: v, turn: turn || null,
      state: (state === undefined ? (prev && prev.state) || null : state),
      log: log || null, winnerId: winnerId || null, by: userId, updatedAt: Date.now()
    };
    res.json({ success: true, battle: battles[mid] });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* ===========================================================================
   BOOT
   =========================================================================== */
async function init() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  await pool.query(SCHEMA);
  console.log("Postgres schema ready");
}
init()
  .then(() => app.listen(PORT, () => console.log(`Valora v2 backend (Postgres) running on http://localhost:${PORT}`)))
  .catch(e => { console.error("DB init failed:", e.message); process.exit(1); });

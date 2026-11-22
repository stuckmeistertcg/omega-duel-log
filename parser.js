// Omega Duel Log — replay parser (browser + Node).
// Replay .bytes = raw-deflate(BSON{GameSettings, Player0, Player1, GameMessages[], DeckN, ...}).
// GameMessages are classic YGOPro engine messages; byte 0 = message id.
(function (root) {
  "use strict";

  const LOC = { 1: "deck", 2: "hand", 4: "monster_zone", 8: "spell_trap_zone", 16: "graveyard", 32: "banished", 64: "extra_deck", 128: "overlay" };
  const WIN_REASON = { 0: "surrender", 1: "LP to 0", 2: "deck out", 3: "timeout", 4: "disconnect" };
  const EVENT = { 60: "normal_summoned", 62: "special_summoned", 64: "flip_summoned", 70: "activated" };

  // Cards tagged with an archetype in the card database but played as generic staples.
  const GENERIC_CARDS = new Set([
    'maxx "c"', "ash blossom & joyous spring", "effect veiler", "infinite impermanence", "droll & lock bird",
    "nibiru, the primal being", "ghost ogre & snow rabbit", "ghost belle & haunted mansion",
    "ghost mourner & moonlit chill", "ghost sister & spooky dogwood", "d.d. crow", "dimension shifter",
    "called by the grave", "crossout designator", "forbidden droplet", "forbidden chalice", "forbidden lance",
    "harpie's feather duster", "pot of prosperity", "pot of desires", "pot of extravagance", "pot of duality",
    "pot of greed", "book of moon", "book of eclipse", "triple tactics talent", "triple tactics thrust",
    "monster reborn", "super polymerization", "polymerization", "dark ruler no more", "lightning storm",
    "evenly matched", "cosmic cyclone", "mystical space typhoon", "twin twisters", "solemn judgment",
    "solemn strike", "solemn warning", "upstart goblin", "one for one", "foolish burial", "gold sarcophagus",
    "small world", "terraforming", "dark hole", "raigeki", "torrential tribute", "bottomless trap hole",
    "ice hand", "fire hand", "medius the pure",
  ]);
  // Whole archetypes that are almost always splashed as generic packages.
  const GENERIC_ARCHETYPES = new Set(["Mulcharmy", "Dominus", "Kaiju", "Knightmare", "Code Talker", "Borrel",
    "Gold Pride", "Medius", "Polymerization", "Forbidden", "Synchro"]);

  // ------------------------------------------------------------------ bytes
  async function inflateRaw(bytes) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { throw new Error("damaged, or not an Omega file"); }
  }
  function b64(s) {
    if (typeof atob === "function") { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const td = new TextDecoder();

  // Minimal BSON reader. int64 -> string (account ids exceed 2^53).
  function bson(b, i = 0) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const n = dv.getInt32(i, true), end = i + n; i += 4; const d = {};
    while (i < end - 1) {
      const t = b[i++]; let j = i; while (b[j] !== 0) j++;
      const k = td.decode(b.subarray(i, j)); i = j + 1; let v;
      if (t === 1) { v = dv.getFloat64(i, true); i += 8; }
      else if (t === 2) { const l = dv.getInt32(i, true); v = td.decode(b.subarray(i + 4, i + 3 + l)); i += 4 + l; }
      else if (t === 3 || t === 4) { const l = dv.getInt32(i, true); v = bson(b, i); i += l; if (t === 4) v = Object.values(v); }
      else if (t === 5) { const l = dv.getInt32(i, true); v = b.subarray(i + 5, i + 5 + l); i += 5 + l; }
      else if (t === 8) { v = !!b[i]; i += 1; }
      else if (t === 9 || t === 17 || t === 18) { v = dv.getBigInt64(i, true).toString(); i += 8; }
      else if (t === 10) v = null;
      else if (t === 16) { v = dv.getInt32(i, true); i += 4; }
      else throw new Error("unknown BSON type " + t);
      d[k] = v;
    }
    return d;
  }
  async function loadBson(bytes) { return bson(await inflateRaw(bytes)); }

  async function decodeDeckBlob(s) {
    const raw = await inflateRaw(b64(s)); const out = [];
    for (let i = 2; i + 4 <= raw.length; i += 4) out.push(u32(raw, i));
    return out;
  }

  // ------------------------------------------------------------------ decks
  const SECTIONS = [["MD", "Main"], ["ED", "Extra"], ["SD", "Side"]];
  // snapshots: [{mtime(ms), bytes}] from Player.data and Backup/Player_*.data
  async function deckHistory(snapshots, errors) {
    const snaps = [];
    for (const s of snapshots) {
      try { const d = await loadBson(s.bytes); if (!d.DeckList) throw new Error("no deck list inside"); snaps.push({ mtime: s.mtime, decks: d.DeckList }); }
      catch (e) { if (errors) errors.push(`${s.name || "deck file"}: not an Omega decklist (${e.message})`); }
    }
    snaps.sort((a, b) => a.mtime - b.mtime);
    const versions = [], last = {};
    for (const s of snaps) for (const [rawName, parts] of Object.entries(s.decks)) {
      const name = rawName.trim(); const secs = {};
      for (const [k] of SECTIONS) secs[k] = (parts && parts[k]) ? parts[k].slice() : [];
      const key = SECTIONS.map(([k]) => secs[k].slice().sort((a, b) => a - b).join(",")).join("|");
      if (last[name] === key) continue;
      const n = versions.filter(v => v.deck === name).length + 1;
      versions.push({ deck: name, version: n, label: `${name} v${n}`, sections: secs, savedOn: new Date(s.mtime) });
      last[name] = key;
    }
    return versions;
  }
  function counter(arr) { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; }
  function jaccard(a, b) {
    let inter = 0, uni = 0; const keys = new Set([...a.keys(), ...b.keys()]);
    for (const k of keys) { const x = a.get(k) || 0, y = b.get(k) || 0; inter += Math.min(x, y); uni += Math.max(x, y); }
    return uni ? inter / uni : 0;
  }
  function matchDeck(cards, versions) {
    const c = counter(cards); let best = null, score = 0;
    for (const v of versions) { const s = jaccard(c, v._all || (v._all = counter([].concat(...Object.values(v.sections))))); if (s > score) { best = v; score = s; } }
    return { version: best, score: Math.round(score * 100) / 100 };
  }
  function deckDiffRows(versions) {
    const rows = [], prev = {};
    for (const v of versions) {
      const before = prev[v.deck];
      for (const [k, label] of SECTIONS) {
        const now = counter(v.sections[k]), old = before ? counter(before[k]) : null;
        const order = [...new Set(v.sections[k])];
        if (old) for (const c of new Set(before[k])) if (!now.has(c)) order.push(c);
        for (const c of order) {
          const diff = old ? (now.get(c) || 0) - (old.get(c) || 0) : 0;
          rows.push({ deck: v.deck, version: v.version, label: v.label, savedOn: v.savedOn, section: label, card: c,
            count: now.get(c) || 0, change: diff > 0 ? "+" + diff : diff < 0 ? "-" + (-diff) : "", status: diff > 0 ? "added" : diff < 0 ? "removed" : "" });
        }
      }
      prev[v.deck] = v.sections;
    }
    return rows;
  }

  // ------------------------------------------------------------------ one replay
  async function parseReplay(name, bytes, versions) {
    const m = /^(\d\d)_(\d\d)_(\d\d)-(\d\d)_(\d\d)_(\d\d)/.exec(name);
    if (!m) throw new Error("not named like an Omega replay");
    const d = await loadBson(bytes);
    const gs = d.GameSettings || {}, msgs = d.GameMessages || [];
    if (!msgs.length || msgs[0][0] !== 4 || !d.Player0 || !d.Player1) throw new Error("not an Omega replay (missing game data)");
    const me = msgs.length && msgs[0][0] === 4 ? msgs[0][1] : 0, opp = 1 - me;
    const myCards = d["Deck" + me] ? await decodeDeckBlob(d["Deck" + me]) : [];
    const ts = new Date(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);

    let opening = [], first = null, winner = null, reason = null, turn = 0, oppDraws = 0;
    const oppOpen = [], events = [];
    // Opponent's known opening cards: cards that leave their hand before their first draw,
    // minus cards that entered their hand in the meantime (searches). An unknown card entering
    // their hand makes later plays ambiguous, so recording stops.
    const added = new Map(); let openKnown = true;
    const log = (ctrl, code, event, loc) => {
      if (!code) return;
      events.push({ player: ctrl === me ? "me" : "opponent", card: code, event, from: LOC[loc] || String(loc), turn });
      if (ctrl === opp && loc === 2 && oppDraws <= 1 && openKnown && event !== "revealed") {
        if (added.get(code)) added.set(code, added.get(code) - 1); else oppOpen.push(code);
      }
    };
    for (const g of msgs) {
      const t = g[0];
      if (t === 90) {
        const p = g[1], n = g[2], codes = [];
        for (let k = 0; k < n; k++) codes.push(u32(g, 3 + 4 * k) & 0x7fffffff);
        if (p === me && !opening.length) opening = codes;
        else if (p === me) codes.forEach(c => log(p, c, "drawn", 1));
        else oppDraws++;
      } else if (t === 40) { turn++; if (first === null) first = g[1]; }
      else if (t === 5) { winner = g[1]; reason = g[2]; }
      else if (EVENT[t]) log(g[5], u32(g, 1), EVENT[t], g[6]);
      else if (t === 50) {
        const code = u32(g, 1);
        if ((g[6] === 1 || g[6] === 2 || g[6] === 64) && code) log(g[5], code, "revealed_move", g[6]);
        if (g[9] === opp && g[10] === 2 && g[6] !== 2 && oppDraws <= 1) { if (code) added.set(code, (added.get(code) || 0) + 1); else openKnown = false; }
      }
      else if (t === 31) { for (let k = 0; k < g[3]; k++) { const o = 4 + 7 * k; log(g[o + 4], u32(g, o), "revealed", g[o + 5]); } }
    }
    const mv = myCards.length && versions.length ? matchDeck(myCards, versions) : { version: null, score: null };
    return {
      file: name, ts, myId: String(d["Player" + me]), opponentId: String(d["Player" + opp]),
      myDeck: mv.version ? mv.version.deck : "(unknown)", myVersion: mv.version ? mv.version.label : "(unknown)", deckMatch: mv.score,
      startHand: gs.StartHand, first: first === null ? null : first === me,
      result: winner === null ? null : winner === me ? "W" : "L", endReason: WIN_REASON[reason] ?? String(reason), turns: turn,
      opening, oppOpen: [...new Set(oppOpen)], events,
    };
  }

  function groupMatches(games, gapMin = 45) {
    games.sort((a, b) => a.ts - b.ts); let mid = 0, prev = null;
    for (const g of games) {
      const fresh = !prev || g.opponentId !== prev.opponentId || prev.gameInMatch >= 3 || (g.ts - prev.ts) > gapMin * 60000;
      if (fresh) mid++;
      g.matchId = mid; g.gameInMatch = fresh ? 1 : prev.gameInMatch + 1; prev = g;
    }
    const by = new Map(); for (const g of games) { if (!by.has(g.matchId)) by.set(g.matchId, []); by.get(g.matchId).push(g); }
    for (const gl of by.values()) {
      const w = gl.filter(x => x.result === "W").length, l = gl.filter(x => x.result === "L").length;
      for (const x of gl) { x.matchScore = `${w}-${l}`; x.matchResult = w > l ? "W" : l > w ? "L" : "D"; }
    }
    return by;
  }

  // ------------------------------------------------------------------ archetypes
  // db: Map id -> [name, archetype, isExtra]
  function cardArch(id, db, overrides) {
    const rec = db.get(id) || [String(id), "", false];
    let arch = rec[1]; const o = overrides ? overrides.get(rec[0].toLowerCase()) : undefined;
    if (o !== undefined) arch = o.toLowerCase() === "generic" ? "" : o;
    else if (GENERIC_CARDS.has(rec[0].toLowerCase()) || GENERIC_ARCHETYPES.has(arch)) arch = "";
    return { arch, extra: rec[2], name: rec[0] };
  }
  // Label = top archetype + any other archetype with >= 2 distinct cards seen.
  // Extra Deck archetypes only name a deck when no Main Deck archetype was seen.
  function classify(ids, db, overrides) {
    if (!ids.length) return { label: "unknown (no cards seen)", evidence: "" };
    const main = new Map(), extra = new Map();
    for (const id of new Set(ids)) {
      const a = cardArch(id, db, overrides); if (!a.arch) continue;
      const pool = a.extra ? extra : main; if (!pool.has(a.arch)) pool.set(a.arch, []); pool.get(a.arch).push(a.name);
    }
    const pool = main.size ? main : extra;
    if (!pool.size) return { label: "unknown (generics only)", evidence: "" };
    const order = [...pool.keys()].sort((a, b) => pool.get(b).length - pool.get(a).length);
    const named = order.filter((a, i) => i === 0 || pool.get(a).length >= 2);
    return { label: named.join(" "), evidence: order.map(a => `${a}: ${pool.get(a).join(", ")}`).join(" | ") };
  }

  // ------------------------------------------------------------------ whole folder
  // files: [{path, name, mtime, bytes}]; db: Map; overrides: Map|null
  async function buildDataset(files, db, overrides, onProgress) {
    const isBackup = f => /(^|\/)Backup\/Player_[^/]*\.data$/i.test(f.path);
    const errors = [];
    const snapshots = files.filter(f => /(^|\/)Player\.data$/i.test(f.path) || isBackup(f)).map(f => ({ mtime: f.mtime, bytes: f.bytes, name: f.name }));
    const versions = await deckHistory(snapshots, errors);
    const seen = new Set(), games = [];
    const replays = files.filter(f => /\.bytes$/i.test(f.name));
    let done = 0;
    for (const f of replays) {
      if (seen.has(f.name)) continue; seen.add(f.name);
      try { games.push(await parseReplay(f.name, f.bytes, versions)); } catch (e) { errors.push(f.name + ": " + e.message); }
      if (onProgress && ++done % 10 === 0) onProgress(done, replays.length);
    }
    const byMatch = groupMatches(games);
    games.forEach((g, i) => { g.id = "G" + String(i + 1).padStart(4, "0"); });
    for (const gl of byMatch.values()) {
      const ids = []; for (const g of gl) for (const e of g.events) if (e.player === "opponent") ids.push(e.card);
      const c = classify(ids, db, overrides);
      for (const g of gl) {
        const own = g.events.filter(e => e.player === "opponent").map(e => e.card);
        g.oppDeck = c.label; g.oppEvidence = c.evidence; g.oppDeckGame = classify(own, db, overrides).label;
        g.oppCards = [...new Set(own)];
        g.myDrawn = [...new Set([...g.opening, ...g.events.filter(e => e.player === "me" && e.event === "drawn").map(e => e.card)])];
        g.myPlayed = [...new Set(g.events.filter(e => e.player === "me" && e.event !== "drawn" && e.event !== "revealed_move").map(e => e.card))];
      }
    }
    const stats = { replaysFound: seen.size, replaysRead: games.length, decklist: files.some(f => /(^|\/)Player\.data$/i.test(f.path)),
      backups: files.filter(isBackup).length, deckFilesBad: errors.filter(e => /decklist/.test(e)).length };
    return { games, versions, deckRows: deckDiffRows(versions), errors, stats };
  }

  // ------------------------------------------------------------------ several players
  // files carry .group (one per contributor / folder). Each group is parsed on its own
  // (its own Player.data and deck history), then merged with a Player label.
  async function buildMulti(files, db, overrides, onProgress) {
    const groups = new Map();
    for (const f of files) { const k = f.group || ""; if (!groups.has(k)) groups.set(k, new Map()); groups.get(k).set(f.key || f.path, f); }
    const out = { games: [], versions: [], deckRows: [], errors: [], players: [] };
    let matchOffset = 0, gi = 0;
    for (const [key, fmap] of groups) {
      const fl = [...fmap.values()];
      const ds = await buildDataset(fl, db, overrides, onProgress);
      const ids = new Map(); for (const g of ds.games) ids.set(g.myId, (ids.get(g.myId) || 0) + 1);
      const id = [...ids.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || key;
      const meta = fl.find(f => /contributor\.json$/i.test(f.path));
      let name = ""; if (meta) { try { name = String(JSON.parse(new TextDecoder().decode(meta.bytes)).name || "").slice(0, 40); } catch (e) {} }
      const dates = ds.games.map(g => g.ts).sort((a, b) => a - b);
      const report = { key, id, name, games: ds.games.length, ...ds.stats, errors: ds.errors, first: dates[0], last: dates[dates.length - 1], usable: ds.games.length > 0 };
      out.players.push(report);
      if (!report.usable) continue;
      gi++;
      for (const g of ds.games) { g.playerKey = key; g.playerId = id; g.playerName = name; g.matchId += matchOffset; g.id = (groups.size > 1 ? "P" + gi + "-" : "") + g.id; }
      matchOffset = Math.max(matchOffset, ...ds.games.map(g => g.matchId));
      for (const v of ds.versions) v.playerKey = key;
      for (const r of ds.deckRows) r.playerKey = key;
      out.games.push(...ds.games); out.versions.push(...ds.versions); out.deckRows.push(...ds.deckRows); out.errors.push(...ds.errors);
    }
    // label players: chosen name, else a short id; a single player is just "Me"
    const multi = out.players.filter(p => p.usable).length > 1;
    for (const p of out.players) p.label = !multi ? (p.name || "Me") : (p.name ? `${p.name} (…${p.id.slice(-4)})` : "Player …" + p.id.slice(-6));
    const lab = new Map(out.players.map(p => [p.key, p.label]));
    for (const g of out.games) g.player = lab.get(g.playerKey);
    for (const v of out.versions) v.player = lab.get(v.playerKey);
    for (const r of out.deckRows) r.player = lab.get(r.playerKey);
    out.games.sort((a, b) => a.ts - b.ts);
    return out;
  }

  // ------------------------------------------------------------------ data packs
  async function deflateRaw(bytes) {
    const cs = new CompressionStream("deflate-raw");
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
  }
  // offsets of top-level BSON int64 fields (Player0 / Player1)
  function topLevelInt64(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), end = dv.getInt32(0, true), at = {};
    let i = 4;
    while (i < end - 1) {
      const t = b[i++]; let j = i; while (b[j] !== 0) j++; const k = td.decode(b.subarray(i, j)); i = j + 1;
      if (t === 0x12) { at[k] = i; i += 8; }
      else if (t === 1 || t === 9 || t === 17) i += 8;
      else if (t === 2) i += 4 + dv.getInt32(i, true);
      else if (t === 3 || t === 4) i += dv.getInt32(i, true);
      else if (t === 5) i += 5 + dv.getInt32(i, true);
      else if (t === 8) i += 1; else if (t === 16) i += 4; else if (t === 10) {}
      else break;
    }
    return at;
  }
  async function anonId(id) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("omega-duel-log:" + id)));
    return new DataView(h.buffer).getBigUint64(0) & ((1n << 62n) - 1n);
  }
  // Replace the opponent's account id in a replay with a stable anonymous code.
  async function anonymizeReplay(bytes) {
    const raw = await inflateRaw(bytes), d = bson(raw), msgs = d.GameMessages || [];
    const me = msgs.length && msgs[0][0] === 4 ? msgs[0][1] : 0, opp = 1 - me;
    const at = topLevelInt64(raw), key = "Player" + opp;
    if (at[key] !== undefined && d[key] !== undefined) new DataView(raw.buffer, raw.byteOffset).setBigInt64(at[key], await anonId(d[key]), true);
    return { bytes: await deflateRaw(raw), myId: String(d["Player" + me]) };
  }

  // ------------------------------------------------------------------ minimal zip (store on write; store + deflate on read)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = d => (((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  // entries: [{name, bytes, date}] -> Uint8Array of a .zip
  function zipWrite(entries) {
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), d = e.date || new Date(), crc = crc32(e.bytes), n = e.bytes.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dosTime(d), true); h.setUint16(12, dosDate(d), true); h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, e.bytes);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dosTime(d), true); c.setUint16(14, dosDate(d), true); c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + n;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0; for (const a of all) { out.set(a, p); p += a.length; } return out;
  }
  // .zip bytes -> [{name, bytes, date}]
  async function zipRead(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let e = b.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error("not a zip file");
    const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), t = dv.getUint16(p + 12, true), d = dv.getUint16(p + 14, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
      const name = td.decode(b.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
      if (name.endsWith("/")) continue;
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true), raw = b.subarray(start, start + csize);
      const date = new Date(1980 + (d >> 9), ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2);
      out.push({ name, date, method, raw });
    }
    for (const o of out) { o.bytes = o.method === 0 ? o.raw : o.method === 8 ? await inflateRaw(o.raw) : null; delete o.raw; }
    return out.filter(o => o.bytes);
  }

  const api = { zipWrite, zipRead, buildMulti, anonymizeReplay, deflateRaw, inflateRaw, bson, loadBson, decodeDeckBlob, deckHistory, deckDiffRows, parseReplay, groupMatches, classify, buildDataset, GENERIC_CARDS, GENERIC_ARCHETYPES };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.OmegaParser = api;
})(typeof self !== "undefined" ? self : this);

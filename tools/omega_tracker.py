#!/usr/bin/env python3
"""
omega_tracker.py — turn YGO Omega replay files into a game-log spreadsheet.

Usage (on the Mac):
    pip3 install openpyxl            # once
    python3 omega_tracker.py                       # writes ~/Documents/omega_games.xlsx
    python3 omega_tracker.py --out ~/Desktop/log.xlsx --no-names

What it reads (nothing is modified):
    <Omega>/Files/Replays/Client/*.bytes   one file per game (raw-deflate BSON)
    <Omega>/Files/Player.data              your current decklists
    <Omega>/Files/Backup/Player_*.data     older versions of your decklists

Card names come from the YGOPRODeck API (downloaded once, cached in ~/.omega_tracker/).
Optional: ~/.omega_tracker/archetypes.csv with columns card_name,archetype lets the
script label the opponent's deck from the cards they showed.
"""
import argparse, base64, collections, csv, datetime as dt, glob, json, os, struct, sys, urllib.request, zlib

OMEGA_FILES = "/Applications/YGO Omega/YGO Omega.app/Contents/Files"
CACHE_DIR = os.path.expanduser("~/.omega_tracker")
CARD_API = "https://db.ygoprodeck.com/api/v7/cardinfo.php"

LOC = {0x01: "deck", 0x02: "hand", 0x04: "monster_zone", 0x08: "spell_trap_zone",
       0x10: "graveyard", 0x20: "banished", 0x40: "extra_deck", 0x80: "overlay"}
WIN_REASON = {0: "surrender", 1: "LP to 0", 2: "deck out", 3: "timeout", 4: "disconnect"}
EVENT = {60: "normal_summoned", 62: "special_summoned", 64: "flip_summoned", 70: "activated"}


# ---------------------------------------------------------------- BSON (minimal reader)
def _doc(b, i=0):
    n = struct.unpack_from("<i", b, i)[0]; end = i + n; i += 4; d = {}
    while i < end - 1:
        t = b[i]; i += 1
        j = b.index(b"\x00", i); k = b[i:j].decode("utf8", "replace"); i = j + 1
        if t == 0x01: v = struct.unpack_from("<d", b, i)[0]; i += 8
        elif t == 0x02:
            l = struct.unpack_from("<i", b, i)[0]; v = b[i + 4:i + 3 + l].decode("utf8", "replace"); i += 4 + l
        elif t in (0x03, 0x04):
            v, _ = _doc(b, i); i += struct.unpack_from("<i", b, i)[0]
            if t == 0x04: v = list(v.values())
        elif t == 0x05:
            l = struct.unpack_from("<i", b, i)[0]; v = bytes(b[i + 5:i + 5 + l]); i += 5 + l
        elif t == 0x08: v = bool(b[i]); i += 1
        elif t in (0x09, 0x11, 0x12): v = struct.unpack_from("<q", b, i)[0]; i += 8
        elif t == 0x0A: v = None
        elif t == 0x10: v = struct.unpack_from("<i", b, i)[0]; i += 4
        else: raise ValueError(f"unknown BSON type {t:#x}")
        d[k] = v
    return d, end


def load_bson_deflate(path):
    return _doc(zlib.decompress(open(path, "rb").read(), -15))[0]


def u32(b, i): return struct.unpack_from("<I", b, i)[0]


# ---------------------------------------------------------------- decks
def decode_deck_blob(blob_b64):
    raw = zlib.decompress(base64.b64decode(blob_b64), -15)
    return [u32(raw, i) for i in range(2, len(raw) - 3, 4)]


SECTIONS = (("MD", "Main"), ("ED", "Extra"), ("SD", "Side"))


def load_deck_history(files_dir):
    """Every distinct version of every saved deck, oldest first.

    Omega copies Player.data into Backup/Player_<date>.data each time it launches, and the
    copy keeps the original file's modified time, i.e. when that deck state was last saved.
    A deck gets a new version whenever its main/extra/side contents differ from the previous one.
    """
    paths = sorted(glob.glob(os.path.join(files_dir, "Backup", "Player_*.data"))) + [os.path.join(files_dir, "Player.data")]
    snaps = []
    for p in paths:
        try: snaps.append((os.path.getmtime(p), load_bson_deflate(p).get("DeckList", {})))
        except Exception as e: print(f"  (skipped {os.path.basename(p)}: {e})", file=sys.stderr)
    snaps.sort(key=lambda s: s[0])
    versions, last = [], {}
    for mtime, decks in snaps:
        for name, parts in decks.items():
            name = name.strip()
            secs = {k: list(parts.get(k) or []) for k, _ in SECTIONS}
            key = tuple(tuple(sorted(secs[k])) for k, _ in SECTIONS)
            if last.get(name, (None,))[0] == key: continue
            n = sum(v["deck"] == name for v in versions) + 1
            versions.append(dict(deck=name, version=n, label=f"{name} v{n}", sections=secs,
                                 saved_on=dt.datetime.fromtimestamp(mtime)))
            last[name] = (key,)
    return versions


def deck_rows(versions, nm):
    """Long table of every version; changes vs the previous version of the same deck."""
    rows, prev = [], {}
    for v in versions:
        before = prev.get(v["deck"])
        for key, label in SECTIONS:
            now = collections.Counter(v["sections"][key]); old = collections.Counter(before[key]) if before else None
            order = list(dict.fromkeys(v["sections"][key]))
            if old: order += [c for c in dict.fromkeys(before[key]) if c not in now]   # removed cards last
            for c in order:
                diff = 0 if old is None else now[c] - old[c]
                rows.append(dict(deck=v["deck"], version=v["version"], version_label=v["label"],
                                 saved_on=v["saved_on"].date(), section=label, card_name=nm(c), card_id=c,
                                 count=now[c], change=f"+{diff}" if diff > 0 else (f"-{diff * -1}" if diff < 0 else ""),
                                 _status="added" if diff > 0 else "removed" if diff < 0 else ""))
        prev[v["deck"]] = v["sections"]
    return rows


def match_deck(cards, decklists):
    c = collections.Counter(cards); best, score = None, 0.0
    for name, dc in decklists:
        u = sum((c | dc).values()); s = sum((c & dc).values()) / u if u else 0
        if s > score: best, score = name, s
    return best, round(score, 2)


# ---------------------------------------------------------------- one replay
def parse_replay(path, decklists):
    d = load_bson_deflate(path)
    gs = d.get("GameSettings", {}); msgs = d.get("GameMessages", [])
    me = msgs[0][1] if msgs and msgs[0][0] == 4 else 0          # MSG_START tells which seat is ours
    opp = 1 - me
    my_cards = decode_deck_blob(d[f"Deck{me}"]) if d.get(f"Deck{me}") else []
    stamp = os.path.basename(path).rsplit(".", 1)[0]
    try: ts = dt.datetime.strptime(stamp, "%y_%m_%d-%H_%M_%S")
    except ValueError: ts = dt.datetime.fromtimestamp(os.path.getmtime(path))

    opening, first, winner, reason, turn = [], None, None, None, 0
    opp_draws, opp_open, rows = 0, [], []

    def log(ctrl, code, event, loc):
        if not code: return
        rows.append(dict(player="me" if ctrl == me else "opponent", card_id=code, event=event,
                         from_location=LOC.get(loc, str(loc)), turn=turn))
        if ctrl == opp and loc == 0x02 and opp_draws <= 1:   # left opp's hand before their first draw
            opp_open.append(code)

    for m in msgs:
        t = m[0]
        if t == 90:                                     # MSG_DRAW
            p, n = m[1], m[2]
            codes = [u32(m, 3 + 4 * k) & 0x7FFFFFFF for k in range(n)]
            if p == me and not opening: opening = codes
            elif p == me:
                for c in codes: log(p, c, "drawn", 0x01)
            else: opp_draws += 1
        elif t == 40:                                   # MSG_NEW_TURN
            turn += 1
            if first is None: first = m[1]
        elif t == 5: winner, reason = m[1], m[2]        # MSG_WIN
        elif t in EVENT: log(m[5], u32(m, 1), EVENT[t], m[6])
        elif t == 50:                                   # MSG_MOVE out of a hidden zone
            if m[6] in (0x01, 0x02, 0x40) and u32(m, 1): log(m[5], u32(m, 1), "revealed_move", m[6])
        elif t == 31:                                   # MSG_CONFIRM_CARDS
            for k in range(m[3]):
                o = 4 + 7 * k; log(m[o + 4], u32(m, o), "revealed", m[o + 5])

    label, score = match_deck(my_cards, decklists) if my_cards else (None, None)
    return dict(file=os.path.basename(path), timestamp=ts, opponent_id=str(d.get(f"Player{opp}")),
                my_deck=label.rsplit(" v", 1)[0] if label else None, my_deck_version=label,
                deck_match=score, start_hand_size=gs.get("StartHand"),
                went_first=None if first is None else first == me,
                result=None if winner is None else ("W" if winner == me else "L"),
                end_reason=WIN_REASON.get(reason, reason), turns=turn,
                opening_hand=opening, opp_known_opening=list(dict.fromkeys(opp_open))), rows


def group_matches(games, gap_minutes=45):
    games.sort(key=lambda g: g["timestamp"]); mid, prev = 0, None
    for g in games:
        new = (prev is None or g["opponent_id"] != prev["opponent_id"] or prev["game_in_match"] >= 3 or
               (g["timestamp"] - prev["timestamp"]).total_seconds() > gap_minutes * 60)
        if new: mid += 1
        g["match_id"] = mid; g["game_in_match"] = 1 if new else prev["game_in_match"] + 1; prev = g
    by = collections.defaultdict(list)
    for g in games: by[g["match_id"]].append(g)
    for gl in by.values():
        w = sum(x["result"] == "W" for x in gl); l = sum(x["result"] == "L" for x in gl)
        for x in gl: x["match_score"] = f"{w}-{l}"; x["match_result"] = "W" if w > l else "L" if l > w else "D"
    return games


# ---------------------------------------------------------------- card database + archetypes
EXTRA_TYPES = ("Fusion", "Synchro", "XYZ", "Link")

# Cards that carry an archetype tag in YGOPRODeck but are played as generic staples.
GENERIC_CARDS = {
    "maxx \"c\"", "ash blossom & joyous spring", "effect veiler", "infinite impermanence", "droll & lock bird",
    "nibiru, the primal being", "ghost ogre & snow rabbit", "ghost belle & haunted mansion",
    "ghost mourner & moonlit chill", "ghost sister & spooky dogwood", "d.d. crow", "dimension shifter",
    "called by the grave", "crossout designator", "forbidden droplet", "harpie's feather duster",
    "pot of prosperity", "pot of desires", "pot of extravagance", "pot of duality", "pot of greed",
    "book of moon", "book of eclipse", "triple tactics talent", "triple tactics thrust", "monster reborn",
    "super polymerization", "dark ruler no more", "lightning storm", "evenly matched", "cosmic cyclone",
    "mystical space typhoon", "twin twisters", "solemn judgment", "solemn strike", "solemn warning",
    "upstart goblin", "one for one", "foolish burial", "gold sarcophagus", "small world", "terraforming",
    "dark hole", "raigeki", "torrential tribute", "bottomless trap hole", "ice hand", "fire hand",
}
# Whole archetypes that are almost always splashed as generic packages.
GENERIC_ARCHETYPES = {"Mulcharmy", "Dominus", "Kaiju", "Knightmare", "Code Talker", "Borrel", "Gold Pride",
                      "Hand (archetype)"}


def card_db(offline=False):
    """{card_id: (name, archetype or '', is_extra_deck)} cached from YGOPRODeck."""
    os.makedirs(CACHE_DIR, exist_ok=True); cache = os.path.join(CACHE_DIR, "cards_v2.json")
    if not os.path.exists(cache) and not offline:
        print("Downloading card database from YGOPRODeck (one time)...")
        req = urllib.request.Request(CARD_API, headers={"User-Agent": "omega-tracker"})
        data = json.load(urllib.request.urlopen(req, timeout=180))["data"]
        db = {}
        for c in data:
            rec = [c["name"], c.get("archetype") or "", any(t in c.get("type", "") for t in EXTRA_TYPES)]
            db[c["id"]] = rec
            for img in c.get("card_images", []): db.setdefault(img["id"], rec)   # alternate artworks
        json.dump(db, open(cache, "w"))
    if not os.path.exists(cache): return {}
    return {int(k): tuple(v) for k, v in json.load(open(cache)).items()}


def load_overrides():
    """~/.omega_tracker/archetypes.csv: card_name,archetype  (archetype 'generic' = ignore the card)."""
    p = os.path.join(CACHE_DIR, "archetypes.csv")
    if not os.path.exists(p): return {}
    return {r["card_name"].strip().lower(): r["archetype"].strip() for r in csv.DictReader(open(p))}


def card_archetype(cid, db, overrides):
    name, arch, extra = db.get(cid, (str(cid), "", False))
    o = overrides.get(name.lower())
    if o is not None: arch = "" if o.lower() == "generic" else o
    elif name.lower() in GENERIC_CARDS or arch in GENERIC_ARCHETYPES: arch = ""
    return arch, extra


def classify(card_ids, db, overrides):
    """Deck label from the opponent's non-generic cards.

    Main-deck archetypes name the deck (most cards first, e.g. 'Toon Tri-Brigade');
    Extra Deck archetypes only count when no main-deck archetype was seen.
    Returns (label, evidence) where evidence lists the cards behind each archetype.
    """
    main, extra = collections.OrderedDict(), collections.OrderedDict()
    for cid in dict.fromkeys(card_ids):
        arch, is_extra = card_archetype(cid, db, overrides)
        if arch: (extra if is_extra else main).setdefault(arch, []).append(db.get(cid, (str(cid),))[0])
    pool = main or extra
    if not card_ids: return "unknown (no cards seen)", ""
    if not pool: return "unknown (generics only)", ""
    order = sorted(pool, key=lambda a: -len(pool[a]))
    return " ".join(order), " | ".join(f"{a}: {', '.join(pool[a])}" for a in order)


# ---------------------------------------------------------------- output
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--omega", default=OMEGA_FILES, help="Omega 'Files' folder")
    ap.add_argument("--out", default=os.path.expanduser("~/Documents/omega_games.xlsx"))
    ap.add_argument("--no-names", action="store_true", help="skip the card-name download")
    a = ap.parse_args()

    versions = load_deck_history(a.omega)
    decklists = [(v["label"], collections.Counter(c for s in v["sections"].values() for c in s)) for v in versions]
    games, cards = [], []
    for f in sorted(glob.glob(os.path.join(a.omega, "Replays", "Client", "*.bytes"))):
        try:
            g, rows = parse_replay(f, decklists)
        except Exception as e:
            print(f"  could not parse {os.path.basename(f)}: {e}", file=sys.stderr); continue
        games.append(g); cards += [dict(file=g["file"], **r) for r in rows]
    group_matches(games)

    db = card_db(offline=a.no_names); overrides = load_overrides()
    nm = lambda c: db.get(c, (str(c),))[0]
    gid = {g["file"]: f"G{i + 1:04d}" for i, g in enumerate(games)}
    opp_ids = collections.defaultdict(list)
    for r in cards:
        if r["player"] == "opponent": opp_ids[r["file"]].append(r["card_id"])
    by_match = collections.defaultdict(list)
    for g in games:
        ids = opp_ids[g["file"]]; by_match[g["match_id"]] += ids
        g["opp_cards_seen"] = "; ".join(dict.fromkeys(nm(c) for c in ids))
        g["opp_deck_this_game"], _ = classify(ids, db, overrides)
    for g in games:   # the match label pools every game of the set (same opponent deck, before siding)
        g["opp_deck"], g["opp_deck_evidence"] = classify(by_match[g["match_id"]], db, overrides)

    game_cols = ["game_id", "match_id", "game_in_match", "timestamp", "rank", "my_deck", "my_deck_version", "deck_match", "opp_deck", "opp_deck_this_game",
                 "opponent_id", "went_first", "result", "end_reason", "turns", "match_score", "match_result",
                 "start_hand_size", "opening_hand", "opp_known_opening", "opp_cards_seen", "opp_deck_evidence", "file"]
    game_rows = []
    for g in games:
        r = dict(g, game_id=gid[g["file"]], rank="",
                 went_first={True: "first", False: "second", None: ""}[g["went_first"]],
                 opening_hand="; ".join(nm(c) for c in g["opening_hand"]),
                 opp_known_opening="; ".join(nm(c) for c in g["opp_known_opening"]))
        game_rows.append([r[c] for c in game_cols])
    card_cols = ["game_id", "player", "card_id", "card_name", "event", "from_location", "turn"]
    card_rows = [[gid[r["file"]], r["player"], r["card_id"], nm(r["card_id"]), r["event"], r["from_location"], r["turn"]]
                 for r in cards]
    for g in games:   # opening hands as rows too
        card_rows += [[gid[g["file"]], "me", c, nm(c), "opening_hand", "deck", 0] for c in g["opening_hand"]]

    deck_cols = ["deck", "version", "version_label", "saved_on", "section", "card_name", "card_id", "count", "change"]
    drows = deck_rows(versions, nm)
    deck_table = [[r[c] for c in deck_cols] for r in drows]

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Border, Font, Side
        wb = Workbook(); ws = wb.active; ws.title = "Games"
        for title, cols, rows in [("Games", game_cols, game_rows), ("Cards", card_cols, card_rows),
                                  ("Decks", deck_cols, deck_table)]:
            ws = ws if title == "Games" else wb.create_sheet(title)
            ws.append(cols); [setattr(c, "font", Font(bold=True)) for c in ws[1]]
            for row in rows: ws.append(row)
            ws.freeze_panes = "A2"; ws.auto_filter.ref = ws.dimensions
            for col in ws.columns:
                ws.column_dimensions[col[0].column_letter].width = min(60, max(9, max(len(str(c.value or "")) for c in col[:400]) + 2))
        # Decks: green = added / count up, red = removed / count down; a line above each new version
        ws = wb["Decks"]; colour = {"added": Font(color="00A040"), "removed": Font(color="D00000")}
        line = Border(top=Side(style="medium")); prev_label = None
        for c in ws["D"][1:]: c.number_format = "yyyy-mm-dd"
        for i, r in enumerate(drows, start=2):
            if r["_status"]:
                for cell in ws[i]: cell.font = colour[r["_status"]]
            if r["version_label"] != prev_label:
                for cell in ws[i]: cell.border = line
                prev_label = r["version_label"]
        wb.save(a.out)
    except ImportError:
        base = os.path.splitext(a.out)[0]
        for suffix, cols, rows in [("_games.csv", game_cols, game_rows), ("_cards.csv", card_cols, card_rows),
                                   ("_decks.csv", deck_cols, deck_table)]:
            with open(base + suffix, "w", newline="") as fh: w = csv.writer(fh); w.writerow(cols); w.writerows(rows)
        a.out = base + "_games.csv / _cards.csv (pip3 install openpyxl for .xlsx)"
    print(f"{len(games)} games, {games[-1]['match_id'] if games else 0} matches -> {a.out}")


if __name__ == "__main__":
    main()

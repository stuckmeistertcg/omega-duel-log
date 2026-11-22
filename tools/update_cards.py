#!/usr/bin/env python3
"""Refresh cards.json from the YGOPRODeck API.

Writes one card per line: [id, name, archetype, is_extra_deck]. Alternate-artwork ids
point to the same card. Run by the weekly GitHub Action, or by hand:
    python3 tools/update_cards.py
"""
import json, os, urllib.request

API = "https://db.ygoprodeck.com/api/v7/cardinfo.php"
EXTRA = ("Fusion", "Synchro", "XYZ", "Link")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cards.json")

req = urllib.request.Request(API, headers={"User-Agent": "omega-duel-log (github action)"})
data = json.load(urllib.request.urlopen(req, timeout=180))["data"]

rows = {}
for c in data:
    rec = [c["name"], c.get("archetype") or "", any(t in c.get("type", "") for t in EXTRA)]
    rows[c["id"]] = rec
    for img in c.get("card_images", []):
        rows.setdefault(img["id"], rec)

lines = [json.dumps([cid, *rec], ensure_ascii=False) for cid, rec in sorted(rows.items())]
with open(OUT, "w", encoding="utf-8") as fh:
    fh.write("[\n" + ",\n".join(lines) + "\n]\n")
print(f"{len(lines)} cards written to cards.json")

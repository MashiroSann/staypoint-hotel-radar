import json
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import hotel_service

t = time.time()
res = hotel_service.search_hotels("上海外滩", radius_m=3000, only_bookable=False, sort="distance")
print("elapsed", round(time.time() - t, 2), "ok", res.get("ok"), "source", res.get("source"))
print("anchor", res.get("anchor"))
print("stats", res.get("stats"))
for h in res.get("hotels", [])[:10]:
    print(f"{h['distance_m']:5}m ¥{h['price']:<5} {h['rating']} {h['level']:<4} {h['name']} | photos={len(h['photos'])} reviews={len(h['reviews'])} rooms={len(h['rooms'])} tags={h['tags'][:3]}")
print("\nROOM SAMPLE:", json.dumps(res["hotels"][0]["rooms"], ensure_ascii=False, indent=1)[:1200])
print("\nREVIEW SAMPLE:", json.dumps(res["hotels"][0]["reviews"][:1], ensure_ascii=False, indent=1)[:800])
print("\nHOTEL KEYS:", sorted(res["hotels"][0].keys()))

"""搜索链路自检：覆盖小半径、大半径、区县查询与“每次重新请求”。"""
import json
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import hotel_service

CASES = [
    ("上海外滩", 3000),
    ("杭州站", 10000),
    ("上城区", 10000),
]


def check(query: str, radius: int) -> None:
    t = time.time()
    res = hotel_service.search_hotels(query, radius_m=radius, only_bookable=False, sort="distance")
    hotels = res.get("hotels", [])
    dists = [h["distance_m"] for h in hotels]
    print(f"\n== {query} {radius}m")
    print("elapsed", round(time.time() - t, 2), "ok", res.get("ok"), "source", res.get("source"))
    print("anchor", res.get("anchor"))
    print("stats", res.get("stats"))
    print("returned", len(hotels), "dist min/max", (min(dists), max(dists)) if dists else None)
    if dists:
        buckets = {k: sum(1 for d in dists if d <= k) for k in (1000, 3000, 5000, 8000, 10000)}
        print("buckets", buckets)
        assert max(dists) <= radius + 10, "返回了半径外的酒店"
    if hotels:
        h = hotels[0]
        print(f"sample {h['distance_m']}m ¥{h['price']} {h['rating']} {h['name']} "
              f"| photos={len(h['photos'])} reviews={len(h['reviews'])} rooms={len(h['rooms'])}")
        print("ROOM SAMPLE:", json.dumps(h["rooms"][:1], ensure_ascii=False)[:400])


for q, r in CASES:
    check(q, r)

print("\n== 无缓存验证：连续两次同一查询应是两次真实请求")
starts = []
for _ in range(2):
    t = time.time()
    res = hotel_service.search_hotels("杭州站", radius_m=10000, only_bookable=True)
    starts.append((round(time.time() - t, 2), res["stats"]["count"]))
print("two runs (elapsed, count):", starts)
assert all(item[0] > 0.5 for item in starts), "第二次查询太快，可能命中了缓存"
print("\nALL CHECKS PASSED")

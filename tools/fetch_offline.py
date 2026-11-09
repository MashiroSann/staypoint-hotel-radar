"""生成离线兜底快照。

用法（在 G:\\workdir\\staypoint 目录）：
    python tools/fetch_offline.py

实时数据不可用时，hotel_service.search_offline 会从
data/offline/hotels.json 里挑选匹配的地标返回缓存样本。
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import hotel_service  # noqa: E402

LANDMARKS = [
    ("上海外滩", "上海 · 外滩"),
    ("杭州西湖", "杭州 · 西湖"),
    ("北京故宫", "北京 · 故宫"),
    ("成都太古里", "成都 · 太古里"),
]
RADIUS_M = 3000
LIMIT = 48


def main() -> int:
    landmarks = []
    for index, (query, title) in enumerate(LANDMARKS, 1):
        print(f"[{index}/{len(LANDMARKS)}] 抓取 {title} ...", flush=True)
        started = time.time()
        try:
            result = hotel_service.search_hotels(
                query, radius_m=RADIUS_M, only_bookable=False, sort="distance",
                limit=LIMIT, use_cache=False,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  失败：{exc}", file=sys.stderr)
            continue
        if not result.get("ok"):
            print(f"  失败：{result.get('error') or '无结果'}", file=sys.stderr)
            continue
        hotels = result.get("hotels") or []
        if not hotels:
            print("  跳过：没有酒店", file=sys.stderr)
            continue
        landmarks.append({
            "query": query,
            "title": title,
            "anchor": result["anchor"],
            "radius_m": RADIUS_M,
            "hotels": hotels,
        })
        print(f"  {len(hotels)} 家 · {time.time() - started:.1f}s", flush=True)

    if not landmarks:
        print("没有生成任何快照（请检查网络）。", file=sys.stderr)
        return 1

    out = ROOT / "data" / "offline" / "hotels.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "百度地图公开页面",
        "note": "离线缓存样本，仅供实时接口不可用时演示；图片仍需要网络或本地缓存。",
        "landmarks": landmarks,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已写入 {out}（{out.stat().st_size / 1024:.0f} KB，{len(landmarks)} 个地标）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

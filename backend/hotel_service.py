"""酒店搜索编排：解析地标 → 抓取百度 POI → 归一化 → 排序/筛选。"""

from __future__ import annotations

import json
import logging
import math
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import baidu, coords

log = logging.getLogger("staypoint.service")

ROOT = Path(__file__).resolve().parent.parent
OFFLINE_FILE = ROOT / "data" / "offline" / "hotels.json"

SORT_OPTIONS = {"distance", "price", "rating", "reviews"}
LEVEL_FILTERS = ("经济型", "舒适型", "高档型", "豪华型", "五星级")
TAG_FILTER_OPTIONS = ("近地铁", "免费停车", "近景点", "家庭房",
                      "会议室", "景观很棒", "浴缸", "接送机")
DISCLAIMER = ("酒店名称、地址、评分、评论、图片与实时起价来自百度地图公开页面；"
              "标注“参考套房”的房型由酒店等级与公开起价估算，实际房型与价格以酒店为准。")


def _to_int(value: Any, default: int = 0, minimum: int = 0, maximum: int = 10**9) -> int:
    try:
        number = int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(number, maximum))


def _to_float(value: Any, default: float = 0.0, minimum: float = 0.0,
              maximum: float = 10.0) -> float:
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return default
    return max(minimum, min(number, maximum))


def _text_list(value: Any, limit: int = 16) -> List[str]:
    if isinstance(value, (list, tuple, set)):
        raw = list(value)
    else:
        raw = str(value or "").split(",")
    result: List[str] = []
    for item in raw:
        text = str(item or "").strip()
        if text and text not in result:
            result.append(text)
    return result[:limit]


def normalize_filters(filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """把 API/前端传入的筛选条件归一化成稳定结构，便于缓存与测试。"""
    raw = filters or {}
    price_min = _to_int(raw.get("price_min"), 0, 0, 100000)
    price_max = _to_int(raw.get("price_max"), 0, 0, 100000)
    if price_min and price_max and price_min > price_max:
        price_min, price_max = price_max, price_min
    levels = [x for x in _text_list(raw.get("levels"), 10) if x in LEVEL_FILTERS]
    min_rating = round(_to_float(raw.get("min_rating"), 0, 0, 5), 1)
    min_reviews = _to_int(raw.get("min_reviews"), 0, 0, 1000000)
    tags = _text_list(raw.get("tags"), 12)
    kw = str(raw.get("kw") or "").strip()[:40]
    return {
        "price_min": price_min,
        "price_max": price_max,
        "levels": levels,
        "min_rating": min_rating,
        "min_reviews": min_reviews,
        "tags": tags,
        "kw": kw,
    }


def filter_count(filters: Optional[Dict[str, Any]]) -> int:
    """统计已启用的筛选维度，用于前端筛选按钮角标/标题。"""
    f = normalize_filters(filters)
    return sum((
        1 if f["price_min"] or f["price_max"] else 0,
        1 if f["levels"] else 0,
        1 if f["min_rating"] else 0,
        1 if f["min_reviews"] else 0,
        1 if f["tags"] else 0,
        1 if f["kw"] else 0,
    ))


def _filter_hotels(hotels: List[Dict[str, Any]],
                   filters: Dict[str, Any]) -> List[Dict[str, Any]]:
    if filter_count(filters) == 0:
        return hotels
    price_min = filters["price_min"]
    price_max = filters["price_max"]
    levels = [x.lower() for x in filters["levels"]]
    tags = [x.lower() for x in filters["tags"]]
    kw = filters["kw"].lower()
    result: List[Dict[str, Any]] = []
    for h in hotels:
        price = _to_int(h.get("price"), 0, 0)
        if price_min or price_max:
            if price <= 0:
                continue
            if price_min and price < price_min:
                continue
            if price_max and price > price_max:
                continue
        if levels:
            haystack = f"{h.get('level') or ''} {h.get('category') or ''}".lower()
            if not any(level in haystack for level in levels):
                continue
        if filters["min_rating"] and _to_float(h.get("rating"), 0) < filters["min_rating"]:
            continue
        if filters["min_reviews"]:
            reviews = _to_int(h.get("review_count", h.get("review_total")), 0, 0)
            if reviews < filters["min_reviews"]:
                continue
        if tags:
            labels = (h.get("tags") or []) + (h.get("facilities") or [])
            haystack = " ".join(str(x) for x in labels).lower()
            if not any(tag in haystack for tag in tags):
                continue
        if kw:
            haystack = f"{h.get('name') or ''} {h.get('brand') or ''}".lower()
            if kw not in haystack:
                continue
        result.append(h)
    return result


def _service_cache_key(query: str, radius: int, bookable: bool, sort: str,
                       limit: int, filters_key: str = "") -> str:
    return f"service|{query}|{radius}|{int(bookable)}|{sort}|{limit}|{filters_key}"


def _dedupe(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    best: Dict[str, Dict[str, Any]] = {}
    for item in items:
        uid = str(item.get("uid") or "")
        if not uid:
            continue
        di = (item.get("ext") or {}).get("detail_info") or {}
        score = len(di) if isinstance(di, dict) else 0
        old = best.get(uid)
        if old is None:
            best[uid] = item
            continue
        old_di = (old.get("ext") or {}).get("detail_info") or {}
        if score > (len(old_di) if isinstance(old_di, dict) else 0):
            best[uid] = item
    return list(best.values())


def _sort_hotels(hotels: List[Dict[str, Any]], sort: str) -> None:
    if sort == "price":
        hotels.sort(key=lambda h: (h["price"] <= 0, h["price"] if h["price"] > 0 else 10**9, h["distance_m"]))
    elif sort == "rating":
        hotels.sort(key=lambda h: (-(h["rating"] or 0), -(h["review_count"] or 0), h["distance_m"]))
    elif sort == "reviews":
        hotels.sort(key=lambda h: (-(h["review_count"] or 0), -(h["rating"] or 0), h["distance_m"]))
    else:
        hotels.sort(key=lambda h: (h["distance_m"], -(h["rating"] or 0)))


def _stats(hotels: List[Dict[str, Any]], radius_m: int,
           returned_count: Optional[int] = None) -> Dict[str, Any]:
    prices = [h["price"] for h in hotels if h.get("price", 0) > 0]
    ratings = [h["rating"] for h in hotels if h.get("rating", 0) > 0]
    total = len(hotels)
    returned = total if returned_count is None else int(returned_count)
    return {
        "count": total,
        "returned": returned,
        "total_found": total,
        "truncated": total > returned,
        "available": sum(1 for h in hotels if h.get("available")),
        "min_price": min(prices) if prices else 0,
        "max_price": max(prices) if prices else 0,
        "avg_rating": round(sum(ratings) / len(ratings), 1) if ratings else 0,
        "radius_m": radius_m,
    }


def _finalize(anchor: Dict[str, Any], hotels: List[Dict[str, Any]], radius_m: int,
              query: str, source: str, warning: str = "",
              stats_hotels: Optional[List[Dict[str, Any]]] = None,
              filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    active_filters = filters or {}
    return {
        "ok": True,
        "query": query,
        "anchor": {
            "name": anchor.get("name"),
            "city": anchor.get("city"),
            "city_code": anchor.get("city_code"),
            "lng": anchor.get("lng"),
            "lat": anchor.get("lat"),
            "is_area_center": bool(anchor.get("is_area_center")),
        },
        "radius_m": radius_m,
        "hotels": hotels,
        "stats": _stats(stats_hotels if stats_hotels is not None else hotels,
                        radius_m, len(hotels)),
        "source": source,
        "source_label": "百度地图实时数据" if source == "live" else "内置离线样本",
        "filters": active_filters,
        "filter_count": filter_count(active_filters),
        "warning": warning,
        "disclaimer": DISCLAIMER,
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


def search_hotels(query: str, radius_m: int = 3000, only_bookable: bool = True,
                  sort: str = "distance", limit: int = 48, use_cache: bool = True,
                  filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    started = time.time()
    radius_m = max(300, min(int(radius_m), 20000))
    sort = sort if sort in SORT_OPTIONS else "distance"
    limit = max(1, min(int(limit), 80))
    active_filters = normalize_filters(filters)
    filters_key = json.dumps(active_filters, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"))
    cache_key = _service_cache_key(query, radius_m, only_bookable, sort, limit, filters_key)
    if use_cache:
        cached = baidu._cache_get(cache_key)
        if cached is not None:
            cached = dict(cached)
            cached["cached"] = True
            return cached

    try:
        anchor = baidu.resolve_query(query)
        raw = baidu.collect_raw_hotels(query, anchor, radius_m)
        hotels: List[Dict[str, Any]] = []
        seen = set()
        for item in _dedupe(raw):
            h = baidu.normalize_hotel(item, anchor, radius_m)
            if not h or h["uid"] in seen:
                continue
            seen.add(h["uid"])
            h["available"] = bool(h.get("bookable")) and not bool(h.get("fullroom"))
            hotels.append(h)
        if only_bookable:
            hotels = [h for h in hotels if h["available"]]
        hotels = _filter_hotels(hotels, active_filters)
        _sort_hotels(hotels, sort)
        all_hotels = hotels
        hotels = hotels[:limit]
        # 去掉仅供内部排序的字段
        for h in hotels:
            h.pop("_x", None)
            h.pop("_y", None)
            h.pop("_match_term", None)
        result = _finalize(anchor, hotels, radius_m, query, "live",
                           stats_hotels=all_hotels, filters=active_filters)
        result["elapsed_ms"] = int((time.time() - started) * 1000)
        if use_cache:
            baidu._cache_put(cache_key, result)
        return result
    except baidu.BaiduError as exc:
        log.warning("live search failed: %s", exc)
        offline = search_offline(query, radius_m, only_bookable, sort, limit,
                                 filters=active_filters)
        if offline.get("ok") is False:
            offline["error"] = f"{exc}。{offline.get('error') or ''}".strip()
        else:
            offline["warning"] = f"实时数据暂时不可用（{exc}），已切换到内置离线样本。"
        offline["elapsed_ms"] = int((time.time() - started) * 1000)
        return offline


def _offline_landmarks() -> List[Dict[str, Any]]:
    try:
        data = json.loads(OFFLINE_FILE.read_text(encoding="utf-8"))
        return data.get("landmarks") or []
    except Exception as exc:  # noqa: BLE001
        log.info("offline snapshot unavailable: %s", exc)
        return []


def _offline_landmark_names() -> List[str]:
    names: List[str] = []
    for lm in _offline_landmarks():
        name = str(lm.get("query") or (lm.get("anchor") or {}).get("name") or "").strip()
        if name and name not in names:
            names.append(name)
    return names


def search_offline(query: str, radius_m: int, only_bookable: bool, sort: str,
                   limit: int = 48, filters: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    active_filters = normalize_filters(filters)
    landmarks = _offline_landmarks()
    if not landmarks:
        return {
            "ok": False, "error": "网络不可用，且没有找到内置离线数据。请检查网络后重试。",
            "query": query, "hotels": [], "stats": _stats([], radius_m), "source": "offline",
        }
    q = (query or "").strip().lower()
    chosen = None
    for lm in landmarks:
        names = [str(lm.get("query") or "").lower(), str((lm.get("anchor") or {}).get("name") or "").lower()]
        if any(n and (n in q or q in n) for n in names):
            chosen = lm
            break
    if chosen is None:
        supported = "、".join(_offline_landmark_names())
        return {
            "ok": False,
            "error": (f"内置离线样例只覆盖：{supported}。"
                      f"当前查询「{query}」没有对应的离线数据，请稍后重试实时查询。"),
            "query": query,
            "anchor": None,
            "radius_m": radius_m,
            "hotels": [],
            "stats": _stats([], radius_m),
            "source": "offline",
            "source_label": "内置离线样例",
            "warning": "",
            "elapsed_ms": 0,
        }
    anchor = chosen["anchor"]
    hotels = []
    for h in chosen.get("hotels") or []:
        h = dict(h)
        try:
            h["distance_m"] = int(round(coords.haversine_m(anchor["lng"], anchor["lat"], h["lng"], h["lat"])))
        except Exception:
            pass
        if h.get("distance_m", 0) > radius_m:
            continue
        if only_bookable and not h.get("available"):
            continue
        hotels.append(h)
    hotels = _filter_hotels(hotels, active_filters)
    _sort_hotels(hotels, sort)
    all_hotels = hotels
    hotels = hotels[:limit]
    result = _finalize(anchor, hotels, radius_m, query, "offline",
                       stats_hotels=all_hotels, filters=active_filters)
    result["offline_anchor_chosen"] = chosen.get("query")
    return result

"""百度地图公开 POI 接口的轻量客户端。

仅供学习演示：数据来自百度地图公开网页接口，不含任何密钥，也不做高频抓取。
"""

from __future__ import annotations

import base64
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import requests

from . import coords

log = logging.getLogger("staypoint.baidu")

MAP_URL = "https://map.baidu.com/"
MOBILE_LIST_URL = "https://map.baidu.com/mobile/webapp/place/list/qt=s"
SUGGEST_URL = "https://map.baidu.com/su"
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://map.baidu.com/",
}

# 百度图片 CDN 白名单（只允许代理这些域的图片，避免 SSRF）
IMAGE_HOST_SUFFIXES = (
    "poi-pic.cdn.bcebos.com",
    "poi-pic-gz.cdn.bcebos.com",
    "lbsugc.cdn.bcebos.com",
    "se-feed-bucket.cdn.bcebos.com",
    "dimg04.c-ctrip.com",
    "youimg1.c-ctrip.com",
    "himg.bdimg.com",
    "timg.baidu.com",
    "map-mobile-resource.cdn.bcebos.com",
)

_LOCAL = threading.local()


class BaiduError(RuntimeError):
    pass


def _session() -> requests.Session:
    s = getattr(_LOCAL, "session", None)
    if s is None:
        s = requests.Session()
        s.headers.update(HEADERS)
        adapter = requests.adapters.HTTPAdapter(pool_connections=12, pool_maxsize=24)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        try:
            # 先访问一次首页拿到 BAIDUID Cookie；桌面版 qt=s 接口对没有 Cookie 的请求更容易 403。
            s.get(MAP_URL, timeout=6)
        except Exception:  # noqa: BLE001
            pass
        _LOCAL.session = s
    return s


def _content(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = data.get("content") or []
    if isinstance(raw, dict):
        # 区县等“行政区划”查询会返回单个对象而不是数组，补一个 name 方便统一处理。
        raw = [raw]
    items: List[Dict[str, Any]] = []
    for x in raw:
        if not isinstance(x, dict):
            continue
        if not x.get("name"):
            x = dict(x)
            x["name"] = x.get("cname") or x.get("gbk_name") or ""
        items.append(x)
    return items


def _desktop_search_page(keyword: str, city_code: Optional[int], page: int,
                         bounds: Optional[str] = None, timeout: float = 15.0,
                         retries: int = 2) -> Dict[str, Any]:
    """桌面版 `qt=s` JSON 接口，支持 `b=` 矩形范围与深翻页。

    `b=(x1,y1;x2,y2)` 的单位是 BD-09 墨卡托米（即 content[].x / 100），
    传了它以后翻页会围绕该范围深挖，而不是城市级混排结果。
    """
    params: Dict[str, Any] = {
        "qt": "s", "wd": keyword, "pn": max(0, int(page)), "rn": 10, "ie": "utf-8",
    }
    if city_code:
        params["c"] = int(city_code)
    if bounds:
        params["b"] = bounds
        params["l"] = 12
    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            resp = _session().get(MAP_URL, params=params, timeout=timeout)
            if resp.status_code != 200:
                raise BaiduError(f"HTTP {resp.status_code}")
            data = resp.json()
            if not isinstance(data, dict):
                raise BaiduError("接口返回格式异常")
            anti = data.get("result") or {}
            if isinstance(anti, dict) and (anti.get("anti_session") or {}).get("need_recaptcha"):
                raise BaiduError("百度地图要求人机验证")
            return data
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < retries:
                time.sleep(0.8 + attempt * 1.2)
    raise BaiduError(f"百度地图请求失败：{last_err}")


def _mobile_search_page(keyword: str, city_code: Optional[int], page: int,
                        timeout: float = 20.0, retries: int = 2) -> Dict[str, Any]:
    """移动版搜索页 SSR 兜底：桌面接口被风控时会整页内嵌同一份 content。"""
    params: Dict[str, Any] = {
        "qt": "s", "wd": keyword, "pn": max(0, int(page)), "rn": 10, "ie": "utf-8",
    }
    if city_code:
        params["c"] = int(city_code)
    headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://map.baidu.com/",
    }
    last_err: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            resp = _session().get(MOBILE_LIST_URL, params=params, headers=headers, timeout=timeout)
            resp.raise_for_status()
            text = resp.content.decode("utf-8", "replace")
            marker = re.search(r'\{"place_info"\s*:', text)
            if not marker:
                raise BaiduError("百度地图页面中没有找到酒店数据，请稍后重试")
            data, _ = json.JSONDecoder().raw_decode(text[marker.start():])
            if not isinstance(data, dict) or not isinstance(data.get("content"), list):
                raise BaiduError("百度地图页面数据格式异常")
            return data
        except BaiduError:
            raise
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < retries:
                # 百度移动页在并发较高时会偶发 403；退避后重试，避免整页结果丢失。
                time.sleep(0.5 + attempt * 0.9)
    raise BaiduError(f"百度地图请求失败：{last_err}")


def _search_page(keyword: str, city_code: Optional[int], page: int,
                 bounds: Optional[str] = None) -> Dict[str, Any]:
    """先走桌面 JSON 接口（支持范围+深翻页），失败再退回移动版页面。"""
    try:
        return _desktop_search_page(keyword, city_code, page, bounds=bounds)
    except BaiduError as exc:
        log.info("desktop search failed (%s), fallback to mobile: %s", keyword, exc)
        return _mobile_search_page(keyword, city_code, page)


def _city_center_raw(geo: str) -> Optional[tuple[float, float]]:
    """current_city.geo 形如 '1|13523265.31,3641114.64;...'，单位是 BD09 墨卡托米。"""
    try:
        # 注意前面可能带 "1|" 标记，不能直接按数字顺序取前两个（会把 1 当成 x）。
        match = re.search(r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", geo or "")
        if match:
            return (float(match.group(1)) * coords.BD09MC_SCALE,
                    float(match.group(2)) * coords.BD09MC_SCALE)
    except Exception:
        pass
    return None


_ADMIN_SUFFIX_RE = re.compile(r"(区|县|旗|镇|街道)$")


def _district_anchor(query: str, city_code: Optional[int]) -> Optional[Dict[str, Any]]:
    """区县查询在百度普通搜索里可能没有 POI，改用区县政府作为区域中心。"""
    q = (query or "").strip()
    if not q or not city_code or not _ADMIN_SUFFIX_RE.search(q):
        return None
    try:
        data = _search_page(f"{q}人民政府", int(city_code), 0)
    except BaiduError:
        return None
    for item in _content(data):
        if not _valid_xy(item):
            continue
        name = str(item.get("name") or "")
        if q in name:
            return {"name": q, "x": item["x"], "y": item["y"], "is_area_center": True}
    return None


def _valid_xy(item: Dict[str, Any]) -> bool:
    try:
        return bool(item.get("x")) and bool(item.get("y")) and abs(int(item["x"])) > 0 and abs(int(item["y"])) > 0
    except Exception:
        return False


def _pick_anchor(query: str, items: List[Dict[str, Any]], city_name: str,
                 center_raw: Optional[tuple[float, float]]) -> Dict[str, Any]:
    q = (query or "").strip()
    q_norm = q.replace("市", "").replace("区", "").replace("县", "").lower()
    city_norm = (city_name or "").replace("市", "").lower()
    if center_raw and (q_norm == city_norm or q_norm in {"", "附近", "周边"}):
        return {"name": city_name or q, "x": center_raw[0], "y": center_raw[1], "is_area_center": True}

    best = None
    for idx, item in enumerate(items):
        if not _valid_xy(item):
            continue
        name = str(item.get("name") or "")
        if name.strip().lower() == q.strip().lower():
            return {"name": name, "x": item["x"], "y": item["y"], "is_area_center": False}
        if best is None:
            best = item

    if best is not None:
        # 百度已按相关性排序：优先取第一条有效 POI（而不是名字里碰巧包含查询词的第 N 条）
        return {"name": str(best.get("name") or q), "x": best["x"], "y": best["y"], "is_area_center": False}
    if center_raw:
        return {"name": city_name or q, "x": center_raw[0], "y": center_raw[1], "is_area_center": True}
    if items:
        item = items[0]
        return {"name": str(item.get("name") or q), "x": item.get("x"), "y": item.get("y"), "is_area_center": False}
    raise BaiduError(f"没有找到「{q}」的位置，请换一个地标或地区试试")


def resolve_query(query: str) -> Dict[str, Any]:
    """把一个地区/地标解析成城市 + 锚点坐标（BD09MC 原始单位）。"""
    query = (query or "").strip()
    if not query:
        raise BaiduError("请输入地区或地标")
    if len(query) > 60:
        raise BaiduError("搜索词太长，请精简后重试")

    data: Optional[Dict[str, Any]] = None
    try:
        data = _search_page(query, None, 0)
    except BaiduError as exc:
        # 裸区县名（如“上城区”）在移动版列表页里没有 POI 数据，
        # 但可以先从 /su 推断城市，再以区县政府作为区域中心。
        if not _ADMIN_SUFFIX_RE.search(query):
            raise
        log.info("bare district search fallback: %s (%s)", query, exc)

    items = _content(data) if data else []
    city = (data.get("current_city") or {}) if data else {}
    if items:
        city_name = str(city.get("name") or "全国")
        city_code = city.get("code")
        if not city_code:
            # 个别境外查询没有城市码
            city_code = None
        center_raw = _city_center_raw(city.get("geo") or "")
        anchor = _pick_anchor(query, items, city_name, center_raw)
        q_norm = query.replace("市", "").replace("区", "").replace("县", "").lower()
        city_norm = city_name.replace("市", "").lower()
        if anchor.get("is_area_center") and q_norm != city_norm:
            district = _district_anchor(query, city_code)
            if district:
                anchor = district
    else:
        if not _ADMIN_SUFFIX_RE.search(query):
            raise BaiduError(f"没有找到「{query}」的位置，请换一个地标或地区试试")
        city_code = _suggest_city_code(query)
        district = _district_anchor(query, city_code)
        if not district:
            raise BaiduError(f"没有找到「{query}」的位置，请换一个地标或地区试试")
        data = _search_page(f"{query}人民政府", city_code, 0)
        city = data.get("current_city") or {}
        city_name = str(city.get("name") or "全国")
        city_code = city.get("code") or city_code
        anchor = district

    # 计算 GCJ-02 经纬度，用于前端地图和距离展示
    lng, lat = coords.bd09mc_to_gcj02(float(anchor["x"]), float(anchor["y"]))
    anchor.update({
        "city": city_name,
        "city_code": city_code,
        "lng": round(lng, 7),
        "lat": round(lat, 7),
    })
    return anchor


def parse_suggest(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen = set()
    for row in data.get("s") or []:
        if not isinstance(row, str):
            continue
        parts = row.split("$")
        if len(parts) < 4:
            continue
        name = (parts[3] if len(parts) > 3 else "") or (parts[0] if parts else "")
        name = name.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append({
            "name": name,
            "city": parts[0].strip() if parts else "",
            "district": parts[1].strip() if len(parts) > 1 else "",
            "city_code": int(parts[4]) if len(parts) > 4 and str(parts[4]).isdigit() else None,
            "uid": parts[5].strip() if len(parts) > 5 else "",
        })
    return out[:10]


def _suggest_city_code(query: str) -> Optional[int]:
    """用 /su 联想接口推断查询词所在城市。

    `/su` 不带 cid 时百度会返回空数组，但 `cid=0` 会按全国范围给出联想，
    每条的 `pf[4]` 就是城市码；这样即使移动版搜索页无法解析裸区县名，
    也能拿到城市上下文。
    """
    code: Optional[int] = None
    try:
        resp = _session().get(
            SUGGEST_URL,
            params={"wd": query, "type": 0, "pc_ver": 2, "cid": 0},
            timeout=6,
        )
        resp.raise_for_status()
        rows = parse_suggest(json.loads(resp.content.decode("utf-8")))
        for row in rows:
            if row.get("city_code"):
                code = int(row["city_code"])
                break
    except Exception as exc:  # noqa: BLE001
        log.info("suggest city inference failed: %s", exc)
    return code


def suggest(query: str, city_code: Optional[int] = None) -> List[Dict[str, Any]]:
    query = (query or "").strip()
    if not query:
        return []
    city_code = city_code or _suggest_city_code(query)
    params: Dict[str, Any] = {"wd": query, "type": 0, "pc_ver": 2,
                              "cid": city_code or 0}
    try:
        resp = _session().get(SUGGEST_URL, params=params, timeout=6)
        resp.raise_for_status()
        # 百度返回 text/javascript 且不带 charset，requests 会按 latin-1 解码；
        # 直接对原始字节做 UTF-8 解码，避免中文变成乱码。
        rows = parse_suggest(json.loads(resp.content.decode("utf-8")))
    except Exception as exc:  # noqa: BLE001
        log.info("suggest failed: %s", exc)
        rows = []
    return rows


# 每类 POI 的搜索词；百度“酒店”类目下还混着宾馆/民宿/公寓等词条，
# 只搜“酒店”会漏掉相当一部分，所以按类别并行抓取后取并集。
HOTEL_TERMS = ("酒店", "宾馆", "民宿", "公寓", "客栈", "旅社")

# 半径 -> 每个关键词翻页数（每页 10 条）。百度单关键词最多约 20 页。
_PAGES_BY_RADIUS = (
    (1000, 2),
    (2000, 3),
    (3000, 4),
    (5000, 6),
    (8000, 7),
    (20000, 9),
)


def _pages_for_radius(radius_m: int) -> int:
    r = max(300, min(int(radius_m), 20000))
    for limit, pages in _PAGES_BY_RADIUS:
        if r <= limit:
            return pages
    return 9


def _bounds_for(anchor: Dict[str, Any], radius_m: int) -> str:
    """构造 `b=(x1,y1;x2,y2)`，单位为 BD09MC 米（content 坐标 / 100）。"""
    pad = max(600, int(radius_m * 0.15))
    half = max(300, min(int(radius_m), 20000)) + pad
    x = float(anchor["x"]) / coords.BD09MC_SCALE
    y = float(anchor["y"]) / coords.BD09MC_SCALE
    return f"({x - half:.2f},{y - half:.2f};{x + half:.2f},{y + half:.2f})"


def collect_raw_hotels(query: str, anchor: Dict[str, Any], radius_m: int) -> List[Dict[str, Any]]:
    """并行抓取多个关键词的多页结果，去重后返回原始 POI 列表（未按半径过滤）。"""
    city_code = anchor.get("city_code")
    anchor_name = str(anchor.get("name") or query)
    bounds = _bounds_for(anchor, radius_m)
    pages = _pages_for_radius(radius_m)

    terms: List[str] = []

    def add_term(term: str) -> None:
        term = term.strip()
        if term and term not in terms:
            terms.append(term)

    # 地标限定词放在前面：先拿“杭州站酒店”这类强相关结果，再用类目词补全半径覆盖。
    add_term(f"{anchor_name}酒店")
    if anchor_name != query:
        add_term(f"{query}酒店")
    for term in HOTEL_TERMS:
        add_term(term)

    jobs: List[tuple[str, int]] = [(term, page) for term in terms for page in range(pages)]

    results: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(6, len(jobs) or 1)) as pool:
        futures = [(term, page, pool.submit(_search_page, term, city_code, page, bounds))
                   for term, page in jobs]
        for term, page, fut in futures:
            try:
                data = fut.result()
            except Exception as exc:  # noqa: BLE001
                log.warning("搜索页失败 %s p%s: %s", term, page, exc)
                continue
            for item in _content(data):
                item["_match_term"] = term
                results.append(item)

    log.info("collect query=%r anchor=%r terms=%s pages=%s bounds=%s raw=%s",
             query, anchor_name, len(terms), pages, bounds, len(results))
    return results


def _decode_b64_text(value: Any) -> str:
    if not value:
        return ""
    if not isinstance(value, str):
        return str(value)
    s = value.strip()
    if not s:
        return ""
    try:
        padded = s + "=" * (-len(s) % 4)
        return base64.b64decode(padded).decode("utf-8", "replace")
    except Exception:
        return s


def _num(value: Any, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    if isinstance(value, (int, float)):
        return float(value)
    m = re.search(r"-?\d+(?:\.\d+)?", str(value))
    return float(m.group()) if m else default


def _price(*values: Any) -> int:
    for v in values:
        try:
            n = _num(v, 0)
            if n > 0:
                return int(round(n))
        except Exception:
            continue
    return 0


def _boolflag(*values: Any) -> bool:
    for v in values:
        try:
            if str(v).strip() in {"1", "true", "True"}:
                return True
        except Exception:
            continue
    return False


def _photos(di: Dict[str, Any]) -> List[str]:
    urls: List[str] = []
    seen = set()

    def add(u: Any) -> None:
        if not isinstance(u, str) or not u.startswith(("http://", "https://")):
            return
        u = u.replace("http://", "https://", 1)
        base = u.split("?")[0]
        if base in seen:
            return
        seen.add(base)
        urls.append(u)

    for p in di.get("photos") or []:
        if not isinstance(p, dict):
            continue
        add(p.get("imgUrl") or p.get("origin_imgUrl") or p.get("photo_url") or p.get("toutu_url"))
    add(di.get("image"))
    return urls


def _review_photos(c: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    for p in c.get("comment_photo") or []:
        if isinstance(p, dict):
            u = p.get("pic_url") or p.get("imgUrl") or p.get("url")
            if isinstance(u, str) and u.startswith(("http://", "https://")):
                out.append(u.replace("http://", "https://", 1))
    return out[:6]


def _hotel_photos_count(di: Dict[str, Any]) -> int:
    n = di.get("image_num")
    try:
        return int(n)
    except Exception:
        return len(_photos(di))


def normalize_rooms(di: Dict[str, Any], level: str) -> tuple[List[str], List[Dict[str, Any]]]:
    """返回 (百度返回的房型词, 房型卡片列表)。

    百度公开接口只提供房型词和起价，没有完整的房价日历/面积/早餐字段，
    因此这里保留 1 个“实时在售”房型，再生成 3 个明确标注“参考”的套房，
    避免把估算信息伪装成实时房价。
    """
    vs = di.get("vs_content") or {}
    arr = vs.get("arr_rooms") or {}
    detail = arr.get("hotel_detail") if isinstance(arr, dict) else None
    base_words: List[str] = []
    if isinstance(detail, str):
        base_words = [w.strip() for w in re.split(r"[;；,，]", detail) if w.strip()]
    elif isinstance(detail, list):
        base_words = [str(w).strip() for w in detail if str(w).strip()]

    price = _price(di.get("pc_realtime_price"),
                   ((di.get("hotelprice") or {}).get("for_se_price") or {}).get("pc_price"),
                   di.get("origin_price"))
    level_text = level or ""
    if "经济" in level_text:
        area = 18
    elif "舒适" in level_text:
        area = 24
    elif "高档" in level_text:
        area = 30
    elif "豪华" in level_text or "五星" in level_text:
        area = 36
    else:
        area = 26

    bed_map = {
        "单人床房": ("1张1.2米单人床", "单人房"),
        "双床房": ("2张1.2米单人床", "双床房"),
        "大床房": ("1张1.8米大床", "大床房"),
        "多床房": ("多张床型，适合家庭/多人", "家庭房"),
    }
    rooms: List[Dict[str, Any]] = []
    if price > 0:
        first = base_words[0] if base_words else "大床房"
        bed, display = bed_map.get(first, ("床型以酒店为准", first))
        rooms.append({
            "name": f"{display} · 实时在售",
            "price": price,
            "area": area,
            "bed": bed,
            "max_guests": 2,
            "breakfast": "以酒店实际政策为准",
            "cancel": "以酒店实际政策为准",
            "window": "有窗",
            "badge": "实时在售",
            "is_reference": False,
            "note": "价格来自百度地图公开房价，实际以下单页面为准",
        })

    # 参考套房：按等级与起价估算，表达上明确是“参考”
    base_room_name = (base_words[0] if base_words else "大床房")
    level_is_high = any(k in level_text for k in ("豪华", "五星", "高档"))
    suites = [
        ("行政大床房", 1.22, area + 6, "1张1.8米大床", 2, "高楼层", "含单早"),
        ("豪华套房", 1.65, int(area * 1.6), "1张2米大床 + 独立客厅", 2, "城市景观", "含双早"),
        ("景观套房", 2.05 if level_is_high else 1.9, int(area * 1.9), "1张2米大床 + 独立客厅", 3, "地标/江景", "含双早"),
    ]
    if "多床" in "".join(base_words) or "家庭" in "".join(base_words):
        suites.insert(1, ("家庭套房", 1.55, int(area * 1.7), "1张大床 + 2张单人床", 4, "家庭友好", "含双早"))
    for name, ratio, r_area, bed, guests, view, breakfast in suites[:3]:
        rooms.append({
            "name": name,
            "price": int(round(price * ratio / 10) * 10) if price else 0,
            "area": r_area,
            "bed": bed,
            "max_guests": guests,
            "breakfast": f"{breakfast}（参考）",
            "cancel": "入住当日 18:00 前可取消（参考）",
            "window": "有窗",
            "badge": "参考套房",
            "is_reference": True,
            "note": "参考房型，由酒店等级与公开起价估算，实际以酒店为准",
        })
    if not rooms:
        for name, ratio, r_area, bed, guests, view, breakfast in suites[:3]:
            rooms.append({
                "name": name, "price": 0, "area": r_area, "bed": bed,
                "max_guests": guests, "breakfast": f"{breakfast}（参考）",
                "cancel": "以酒店为准", "window": "有窗",
                "badge": "参考套房", "is_reference": True,
                "note": "参考房型，实际以酒店为准",
            })
    return base_words, rooms


def normalize_hotel(item: Dict[str, Any], anchor: Dict[str, Any], radius_m: int) -> Optional[Dict[str, Any]]:
    di = (item.get("ext") or {}).get("detail_info") or {}
    if not isinstance(di, dict) or not di:
        return None
    if not _valid_xy(item):
        return None
    try:
        x, y = float(item["x"]), float(item["y"])
    except Exception:
        return None
    dist = coords.mc_distance_m(x, y, float(anchor["x"]), float(anchor["y"]))
    if dist > radius_m + 5:
        return None

    std_tag = str(item.get("std_tag") or "")
    name = str(item.get("name") or di.get("name") or "未命名酒店")
    category = str(item.get("tag") or di.get("tag") or "")
    if not any(k in std_tag + category + name for k in ("酒店", "宾馆", "民宿", "公寓", "旅社", "客栈")):
        return None
    # “公寓”类目里混着大量住宅小区/写字楼（std_tag=房地产;住宅区），
    # 只保留真正有酒店信息（价格、可订状态或档次）的条目。
    if "房地产" in std_tag and not (di.get("pc_realtime_price") or di.get("level")
                                   or di.get("pc_bookable") or di.get("comment_num")):
        return None

    lng, lat = coords.bd09mc_to_gcj02(x, y)
    level = str(di.get("level") or "")
    vs = di.get("vs_content") or {}
    basic = ((vs.get("basic_facts") or {}).get("hotel_detail") or {})
    info = basic.get("basic_info") or {}

    facilities: List[str] = []
    fac = ((vs.get("hotel_facilities") or {}).get("hotel_detail") if isinstance(vs.get("hotel_facilities"), dict) else None)
    if isinstance(fac, str):
        try:
            fac_obj = json.loads(fac)
            if isinstance(fac_obj, dict):
                value_labels = {
                    "wired_internet": "宽带", "swimming": "游泳池", "gym": "健身房",
                    "bar": "酒吧", "cafe": "咖啡厅", "restaurant": "餐厅",
                    "elevator": "电梯", "leave_luggage": "行李寄存", "breakfast": "早餐",
                    "room_service": "送餐", "business_center": "商务中心",
                    "front_desk_24": "24小时前台", "laundry": "洗衣", "parking": "停车场",
                    "morning_call": "叫醒服务", "receive_foreign": "接待外宾",
                    "child_care": "儿童看护", "fax_copy": "传真/复印",
                }
                facilities = [value_labels.get(k, str(v)) for k, v in fac_obj.items() if v]
        except Exception:
            pass
    tags: List[str] = []
    arr_tags = ((vs.get("arr_tags") or {}).get("hotel_detail") if isinstance(vs.get("arr_tags"), dict) else None)
    if isinstance(arr_tags, dict):
        for k, v in arr_tags.items():
            if k == "official_reminder" or not isinstance(v, dict):
                continue
            text = str(v.get("text") or "").strip()
            if text and text not in tags:
                tags.append(text)
    for word in ("近地铁", "近景点", "免费停车", "含早餐"):
        if word in name or word in category:
            continue
    poi_tags = ((di.get("poi_tags") or {}).get("attr_tag") or [])
    if isinstance(poi_tags, list):
        for t in poi_tags:
            text = t.get("tag") if isinstance(t, dict) else str(t)
            if text and text not in tags:
                tags.append(str(text))

    base_words, rooms = normalize_rooms(di, level)
    price = _price(di.get("pc_realtime_price"),
                   ((di.get("hotelprice") or {}).get("for_se_price") or {}).get("pc_price"),
                   di.get("origin_price"))
    bookable = _boolflag(di.get("pc_bookable"),
                         ((di.get("hotelprice") or {}).get("for_se_price") or {}).get("pc_bookable"))
    fullroom = _boolflag(di.get("pc_fullroom"),
                         ((di.get("hotelprice") or {}).get("for_se_price") or {}).get("pc_fullroom"))
    rating = _num(di.get("overall_rating"), 0)
    reviews = []
    for c in (di.get("comments") or [])[:8]:
        if not isinstance(c, dict):
            continue
        text = _decode_b64_text(c.get("content")).strip()
        user = _decode_b64_text(c.get("user_name")).strip() or "匿名住客"
        if not text:
            continue
        reviews.append({
            "user": user,
            "rating": _num(c.get("overall_rating"), 0),
            "date": str(c.get("date") or ""),
            "text": text,
            "photos": _review_photos(c),
            "logo": str(c.get("user_logo") or ""),
        })

    intro = str(info.get("hotel_introduction") or "").strip()
    address = str(di.get("poi_address") or item.get("addr") or "").strip()
    city = str(item.get("city_name") or anchor.get("city") or "").strip()
    area = str(item.get("area_name") or "").strip()
    if address and city and city not in address:
        address_full = f"{city}{area}{address}"
    else:
        address_full = address or f"{city}{area}"

    return {
        "uid": str(item.get("uid") or di.get("uid") or ""),
        "name": name,
        "brand": str(di.get("brand_name") or "").strip(),
        "level": level,
        "category": category,
        "address": address_full,
        "city": city,
        "district": area,
        "phone": str(di.get("phone") or "").strip(),
        "lng": round(lng, 7),
        "lat": round(lat, 7),
        "distance_m": int(round(dist)),
        "rating": round(rating, 1),
        "rating_src": str(di.get("overall_rating_src") or ""),
        "rating_facility": round(_num(di.get("facility_rating"), 0), 1),
        "rating_hygiene": round(_num(di.get("hygiene_rating"), 0), 1),
        "rating_service": round(_num(di.get("service_rating"), 0), 1),
        "review_count": int(_num(di.get("comment_num"), 0)),
        "price": price,
        "origin_price": _price(di.get("origin_price"), price),
        "bookable": bookable,
        "fullroom": fullroom,
        "cover": _photos(di)[0] if _photos(di) else "",
        "photos": _photos(di)[:8],
        "photo_count": _hotel_photos_count(di),
        "landmark_eta": str(di.get("landmark_eta") or "").strip(),
        "intro": intro,
        "checkin": str(info.get("checkin_policy") or "").strip(),
        "checkout": str(info.get("checkout_policy") or "").strip(),
        "open_year": str(info.get("open_year") or "").strip(),
        "renovation": str(info.get("fitment_year") or "").strip(),
        "notices": str(info.get("important_notice") or "").strip(),
        "pet_policy": str(info.get("petText") or "").strip(),
        "applicability": str(info.get("applicability_info") or "").strip(),
        "tags": tags[:8],
        "facilities": facilities[:14],
        "base_room_words": base_words,
        "rooms": rooms,
        "reviews": reviews,
        "review_total": int(_num(di.get("comment_num"), 0)),
        "source": "百度地图公开页面",
        "_match_term": item.get("_match_term") or "",
        "_x": x,
        "_y": y,
    }

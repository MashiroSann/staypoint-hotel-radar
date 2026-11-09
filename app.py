"""栖点 · STAYPOINT 酒店雷达 —— 本地 Flask 服务。"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
import webbrowser
from pathlib import Path
from threading import Timer

from flask import Flask, jsonify, request, send_file, send_from_directory

from backend import baidu, hotel_service, images

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
PORT = int(os.environ.get("STAYPOINT_PORT", "8765"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("staypoint.app")

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.config["JSON_AS_ASCII"] = False
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024

RADIUS_OPTIONS = [
    {"value": 500, "label": "500 米"},
    {"value": 1000, "label": "1 公里"},
    {"value": 2000, "label": "2 公里"},
    {"value": 3000, "label": "3 公里"},
    {"value": 5000, "label": "5 公里"},
    {"value": 10000, "label": "10 公里"},
]
EXAMPLES = [
    {"query": "上海外滩", "hint": "黄浦江两岸 · 万国建筑群"},
    {"query": "杭州西湖", "hint": "湖滨商圈 · 断桥残雪"},
    {"query": "北京故宫", "hint": "王府井 · 景山前街"},
    {"query": "成都太古里", "hint": "春熙路 · 大慈寺"},
    {"query": "深圳湾公园", "hint": "后海 · 深圳湾口岸"},
]


@app.after_request
def _headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/favicon.ico")
def favicon():
    p = STATIC_DIR / "img" / "favicon.svg"
    if p.exists():
        return send_file(p, mimetype="image/svg+xml")
    return ("", 204)


@app.get("/api/health")
def health():
    offline_ready = hotel_service.OFFLINE_FILE.exists()
    return jsonify({
        "ok": True,
        "service": "staypoint",
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "offline_snapshot": offline_ready,
        "source": "百度地图公开页面",
    })


@app.get("/api/config")
def config():
    return jsonify({
        "ok": True,
        "radius_options": RADIUS_OPTIONS,
        "default_radius": 3000,
        "examples": EXAMPLES,
        "filter_options": {
            "levels": list(hotel_service.LEVEL_FILTERS),
            "tags": list(hotel_service.TAG_FILTER_OPTIONS),
        },
        "disclaimer": hotel_service.DISCLAIMER,
    })


@app.get("/api/suggest")
def suggest():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"ok": True, "items": []})
    city_code = request.args.get("city_code", type=int)
    try:
        items = baidu.suggest(q, city_code=city_code)
    except Exception as exc:  # noqa: BLE001
        log.info("suggest error: %s", exc)
        items = []
    return jsonify({"ok": True, "items": items})


@app.get("/api/search")
def search():
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"ok": False, "error": "请输入地区或地标，例如「上海外滩」"}), 400
    if len(q) > 60:
        return jsonify({"ok": False, "error": "搜索词太长，请精简后重试"}), 400
    try:
        radius = int(request.args.get("radius", "3000"))
    except ValueError:
        radius = 3000
    radius = max(300, min(radius, 20000))
    only_bookable = (request.args.get("bookable", "1") not in {"0", "false", "False"})
    sort = request.args.get("sort", "distance")
    filters = hotel_service.normalize_filters({
        "price_min": request.args.get("price_min", "0"),
        "price_max": request.args.get("price_max", "0"),
        "levels": request.args.get("levels", ""),
        "min_rating": request.args.get("min_rating", "0"),
        "min_reviews": request.args.get("min_reviews", "0"),
        "tags": request.args.get("tags", ""),
        "kw": request.args.get("kw", ""),
    })
    try:
        result = hotel_service.search_hotels(
            q, radius_m=radius, only_bookable=only_bookable, sort=sort, filters=filters,
        )
        status = 200 if result.get("ok") else 502
        return jsonify(result), status
    except Exception as exc:  # noqa: BLE001
        log.exception("search failed")
        return jsonify({
            "ok": False,
            "error": f"查询失败：{exc}",
            "query": q,
            "hotels": [],
            "source": "error",
        }), 500


@app.get("/api/image")
def image_proxy():
    url = (request.args.get("u") or "").strip()
    if not url or len(url) > 3000:
        return jsonify({"ok": False, "error": "缺少图片地址"}), 400
    if not images.is_allowed(url):
        return jsonify({"ok": False, "error": "图片域名不在白名单内"}), 403
    try:
        path, ctype = images.fetch(url)
        resp = send_file(path, mimetype=ctype, conditional=True, max_age=2592000)
        resp.headers["Cache-Control"] = "public, max-age=2592000, immutable"
        return resp
    except Exception as exc:  # noqa: BLE001
        log.info("image proxy failed: %s (%s)", exc, url[:120])
        return jsonify({"ok": False, "error": "图片加载失败"}), 502


@app.errorhandler(404)
def not_found(_err):
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "接口不存在"}), 404
    return send_from_directory(STATIC_DIR, "index.html")


def _open_browser_later(url: str, delay: float = 1.1) -> None:
    Timer(delay, lambda: webbrowser.open(url)).start()


def main() -> int:
    parser = argparse.ArgumentParser(description="栖点 · STAYPOINT 酒店雷达")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}/"
    print("=" * 62)
    print("  栖点 · STAYPOINT 酒店雷达")
    print(f"  本机地址：{url}")
    print("  数据来源：百度地图公开页面（仅供学习演示）")
    print("  按 Ctrl+C 停止服务")
    print("=" * 62)
    if args.open:
        _open_browser_later(url)
    app.run(host="127.0.0.1", port=args.port, debug=False, threaded=True, use_reloader=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())

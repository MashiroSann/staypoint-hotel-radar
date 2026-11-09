"""图片代理与磁盘缓存。

前端不直接访问百度/携程 CDN（避免热链、CORS 与混合内容），统一走后端代理；
只允许白名单域名，响应写入 data/image_cache，按 URL 哈希命名。
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
import threading
import time
from pathlib import Path
from typing import Optional, Tuple
from urllib.parse import urlparse

import requests

from .baidu import IMAGE_HOST_SUFFIXES, HEADERS

log = logging.getLogger("staypoint.images")
ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "image_cache"
MAX_BYTES = 12 * 1024 * 1024
_LOCK = threading.Lock()

_ALLOWED_EXACT = set(IMAGE_HOST_SUFFIXES)
_ALLOWED_SUFFIXES = tuple("." + s for s in IMAGE_HOST_SUFFIXES)


def _host_allowed(host: str) -> bool:
    host = (host or "").lower().strip(".")
    if not host:
        return False
    if host in _ALLOWED_EXACT:
        return True
    return any(host.endswith(suffix) for suffix in _ALLOWED_SUFFIXES)


def is_allowed(url: str) -> bool:
    try:
        parsed = urlparse(url)
        return parsed.scheme in {"http", "https"} and _host_allowed(parsed.hostname or "")
    except Exception:
        return False


def cache_key(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def cache_path(url: str, ext: str = ".jpg") -> Path:
    return CACHE_DIR / f"{cache_key(url)}{ext}"


def _guess_ext(url: str, content_type: str) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    mapping = {
        "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
        "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif",
    }
    if ct in mapping:
        return mapping[ct]
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".jpg"


def get_cached(url: str) -> Optional[Tuple[Path, str]]:
    if not is_allowed(url):
        return None
    key = cache_key(url)
    for ext, ctype in ((".jpg", "image/jpeg"), (".png", "image/png"),
                       (".webp", "image/webp"), (".gif", "image/gif"), (".avif", "image/avif")):
        p = CACHE_DIR / f"{key}{ext}"
        if p.exists() and p.stat().st_size > 0:
            return p, ctype
    return None


def fetch(url: str, timeout: float = 15.0) -> Tuple[Path, str]:
    """下载并缓存图片，返回 (本地路径, MIME)。调用前请先 is_allowed。"""
    if not is_allowed(url):
        raise ValueError("图片域名不在白名单内")
    cached = get_cached(url)
    if cached:
        return cached

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    headers = dict(HEADERS)
    headers["Accept"] = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
    headers["Referer"] = "https://map.baidu.com/"
    last_err: Optional[Exception] = None
    for candidate in (url, url.replace("http://", "https://", 1)):
        try:
            with requests.get(candidate, headers=headers, timeout=(6, timeout), stream=True) as resp:
                resp.raise_for_status()
                ct = resp.headers.get("Content-Type", "")
                if ct and not ct.lower().startswith("image/"):
                    raise ValueError(f"不是图片内容：{ct}")
                ext = _guess_ext(candidate, ct)
                tmp = CACHE_DIR / f".{cache_key(url)}.part"
                total = 0
                with open(tmp, "wb") as fh:
                    for chunk in resp.iter_content(65536):
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > MAX_BYTES:
                            raise ValueError("图片超过 12MB 限制")
                        fh.write(chunk)
                if total < 64:
                    tmp.unlink(missing_ok=True)
                    raise ValueError("图片内容为空")
                dest = CACHE_DIR / f"{cache_key(url)}{ext}"
                with _LOCK:
                    os.replace(tmp, dest)
                ctype = ct.split(";")[0] if ct else (mimetypes.guess_type(str(dest))[0] or "image/jpeg")
                return dest, ctype
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue
    raise RuntimeError(f"图片下载失败：{last_err}")

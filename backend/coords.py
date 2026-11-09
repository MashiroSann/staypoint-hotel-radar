"""坐标系转换工具。

百度地图 POI 接口返回的 x/y 是 BD-09 墨卡托（单位：米，content 里通常放大 100 倍），
本模块负责：
1. 把 content 中的整数 x/y 还原成 BD-09 墨卡托坐标；
2. BD-09 墨卡托 -> BD-09 经纬度 -> GCJ-02（高德/腾讯地图瓦片使用的坐标系）；
3. 计算两点间距离。
"""

from __future__ import annotations

import math
from typing import Tuple

# 百度墨卡托反向转换系数（来自 projzh，MIT License）
_MCBAND = (12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0)
_MC2LL = (
    (1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331,
     200.9824383106796, -187.2403703815547, 91.6087516669843,
     -23.38765649603339, 2.57121317296198, -0.03801003308653, 17337981.2),
    (-7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289,
     96.32687599759846, -1.85204757529826, -59.36935905485877,
     47.40033549296737, -16.50741931063887, 2.28786674699375, 10260144.86),
    (-3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616,
     59.74293618442277, 7.357984074871, -25.38371002664745,
     13.45380521110908, -3.29883767235584, 0.32710905363475, 6856817.37),
    (-1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591,
     40.31678527705744, 0.65659298677277, -4.44255534477492,
     0.85341911805263, 0.12923347998204, -0.04625736007561, 4482777.06),
    (3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062,
     23.10934304144901, -0.00023663490511, -0.6321817810242,
     -0.00663494467273, 0.03430082397953, -0.00466043876332, 2555164.4),
    (2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8,
     7.47137025468032, -0.00000353937994, -0.02145144861037,
     -0.00001234426596, 0.00010322952773, -0.00000323890364, 826088.5),
)

_X_PI = math.pi * 3000.0 / 180.0
_PI = math.pi
_A = 6378245.0
_EE = 0.00669342162296594323

BD09MC_SCALE = 100.0  # 接口 content[].x / content[].y 与真实墨卡托米之间相差 100 倍
EARTH_RADIUS_M = 6371008.8


def _bd09mc_to_bd09(x: float, y: float) -> Tuple[float, float]:
    """BD-09 墨卡托（米）-> BD-09 经纬度（度）。"""
    table = None
    ay = abs(y)
    for band, row in zip(_MCBAND, _MC2LL):
        if ay >= band:
            table = row
            break
    if table is None:  # pragma: no cover - 极端坐标
        table = _MC2LL[-1]
    lng = table[0] + table[1] * abs(x)
    d = abs(y) / table[9]
    lat = (table[2] + table[3] * d + table[4] * d ** 2 + table[5] * d ** 3
           + table[6] * d ** 4 + table[7] * d ** 5 + table[8] * d ** 6)
    return (lng if x >= 0 else -lng, lat if y >= 0 else -lat)


def bd09_to_gcj02(lng: float, lat: float) -> Tuple[float, float]:
    """BD-09 经纬度 -> GCJ-02 经纬度。"""
    x, y = lng - 0.0065, lat - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * _X_PI)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * _X_PI)
    return z * math.cos(theta), z * math.sin(theta)


def bd09mc_to_gcj02(x: float, y: float) -> Tuple[float, float]:
    """接口原始整数坐标（content[].x/y）-> GCJ-02 经纬度。"""
    lng, lat = _bd09mc_to_bd09(x / BD09MC_SCALE, y / BD09MC_SCALE)
    return bd09_to_gcj02(lng, lat)


def out_of_china(lng: float, lat: float) -> bool:
    return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)


def _transform_lat(lng: float, lat: float) -> float:
    ret = (-100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat
           + 0.1 * lng * lat + 0.2 * math.sqrt(abs(lng)))
    ret += (20.0 * math.sin(6.0 * lng * _PI) + 20.0 * math.sin(2.0 * lng * _PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lat * _PI) + 40.0 * math.sin(lat / 3.0 * _PI)) * 2.0 / 3.0
    ret += (160.0 * math.sin(lat / 12.0 * _PI) + 320.0 * math.sin(lat * _PI / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(lng: float, lat: float) -> float:
    ret = (300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat
           + 0.1 * math.sqrt(abs(lng)))
    ret += (20.0 * math.sin(6.0 * lng * _PI) + 20.0 * math.sin(2.0 * lng * _PI)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lng * _PI) + 40.0 * math.sin(lng / 3.0 * _PI)) * 2.0 / 3.0
    ret += (150.0 * math.sin(lng / 12.0 * _PI) + 300.0 * math.sin(lng / 30.0 * _PI)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lng: float, lat: float) -> Tuple[float, float]:
    if out_of_china(lng, lat):
        return lng, lat
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * _PI
    magic = math.sin(radlat)
    magic = 1 - _EE * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtmagic) * _PI)
    dlng = (dlng * 180.0) / (_A / sqrtmagic * math.cos(radlat) * _PI)
    return lng + dlng, lat + dlat


def gcj02_to_wgs84(lng: float, lat: float) -> Tuple[float, float]:
    if out_of_china(lng, lat):
        return lng, lat
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * _PI
    magic = math.sin(radlat)
    magic = 1 - _EE * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtmagic) * _PI)
    dlng = (dlng * 180.0) / (_A / sqrtmagic * math.cos(radlat) * _PI)
    return lng * 2 - (lng + dlng), lat * 2 - (lat + dlat)


def bd09mc_to_wgs84(x: float, y: float) -> Tuple[float, float]:
    lng, lat = _bd09mc_to_bd09(x / BD09MC_SCALE, y / BD09MC_SCALE)
    gcj_lng, gcj_lat = bd09_to_gcj02(lng, lat)
    return gcj02_to_wgs84(gcj_lng, gcj_lat)


def haversine_m(lng1: float, lat1: float, lng2: float, lat2: float) -> float:
    """球面距离（米）。"""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def mc_distance_m(x1: float, y1: float, x2: float, y2: float) -> float:
    """百度墨卡托平面上的近似距离（content[].x/y 原始整数）。"""
    dx = (x1 - x2) / BD09MC_SCALE
    dy = (y1 - y2) / BD09MC_SCALE
    return math.hypot(dx, dy)

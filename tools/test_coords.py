import sys

sys.path.insert(0, r"G:\workdir\staypoint")
from backend.coords import bd09mc_to_gcj02, bd09mc_to_wgs84, haversine_m

for name, x, y in [
    ("WestLake", 1337271244, 351129799),
    ("Waitan", 1352538943, 364140546),
    ("ForbiddenCity", 1295810975, 482723808),
]:
    print(name, "GCJ", tuple(round(v, 6) for v in bd09mc_to_gcj02(x, y)),
          "WGS", tuple(round(v, 6) for v in bd09mc_to_wgs84(x, y)))
print("dist wgs->gcj approx", round(haversine_m(121.4737, 31.2304, 121.4779, 31.2317), 1))

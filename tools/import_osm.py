"""Импорт мест Шымкента из OpenStreetMap в таблицу places (серые знаки «нет данных»).

Запуск из корня проекта:
    python tools/import_osm.py --dry-run   # только показать, что будет загружено
    python tools/import_osm.py             # загрузить

Повторный запуск безопасен: места с уже известным osm_id пропускаются.
Нужны SUPABASE_URL и SUPABASE_SECRET_KEY в .env. Работает по HTTPS, сторонних библиотек не требует.
Данные © участники OpenStreetMap, лицензия ODbL — на сайте должна оставаться подпись об этом.
"""
import json
import pathlib
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BBOX = "42.24,69.45,42.42,69.75"  # юг, запад, север, восток — Шымкент с пригородами
# Публичные серверы Overpass; пробуем по очереди, потому что любой из них бывает недоступен
OVERPASS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# Значение тега OSM → наша категория (enum place_category)
AMENITY = {
    "pharmacy": "pharmacy",
    "cafe": "cafe", "restaurant": "cafe", "fast_food": "cafe",
    "clinic": "clinic", "hospital": "clinic", "doctors": "clinic", "dentist": "clinic",
    "school": "school", "college": "school", "university": "school", "library": "school",
    "townhall": "government", "post_office": "government", "courthouse": "government",
    "bank": "other",
}
SHOP = {"supermarket": "shop", "convenience": "shop", "mall": "shop", "department_store": "shop"}
TYPE_DIGIT = {"node": 1, "way": 2, "relation": 3}

QUERY = f"""
[out:json][timeout:120];
(
  nwr["amenity"~"^({'|'.join(AMENITY)})$"]["name"]({BBOX});
  nwr["shop"~"^({'|'.join(SHOP)})$"]["name"]({BBOX});
  nwr["office"="government"]["name"]({BBOX});
);
out center tags;
"""


def read_env() -> dict:
    env = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return env


def fetch_osm() -> list[dict]:
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    for server in OVERPASS:
        request = urllib.request.Request(server, data=body, headers={"User-Agent": "jol-accessibility-map/0.1"})
        try:
            with urllib.request.urlopen(request, timeout=150) as response:
                return json.load(response)["elements"]
        except Exception as error:  # сеть, таймаут, перегруженный сервер — пробуем следующий
            print(f"   {urllib.parse.urlparse(server).hostname}: не ответил ({type(error).__name__})")
    raise SystemExit("Ни один сервер Overpass не ответил. Попробуйте позже.")


def to_place(element: dict) -> dict | None:
    tags = element.get("tags", {})
    category = AMENITY.get(tags.get("amenity")) or SHOP.get(tags.get("shop"))
    if not category and tags.get("office") == "government":
        category = "government"
    lat = element.get("lat") or element.get("center", {}).get("lat")
    lon = element.get("lon") or element.get("center", {}).get("lon")
    name = (tags.get("name") or "").strip()
    if not (category and lat and lon and len(name) >= 2):
        return None
    return {
        "name": name[:100],
        "category": category,
        "geom": f"SRID=4326;POINT({lon} {lat})",
        # id узлов, линий и отношений в OSM пересекаются — добавляем цифру типа в конец
        "osm_id": element["id"] * 10 + TYPE_DIGIT[element["type"]],
    }


def upload(places: list[dict], url: str, key: str) -> None:
    endpoint = f"{url}/rest/v1/places?on_conflict=osm_id"
    headers = {
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        "Prefer": "resolution=ignore-duplicates,return=minimal",
    }
    for start in range(0, len(places), 500):
        batch = places[start:start + 500]
        request = urllib.request.Request(endpoint, data=json.dumps(batch).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=60) as response:
            print(f"   загружено {start + len(batch)} из {len(places)} (HTTP {response.status})")


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    print("Запрашиваю OpenStreetMap…")
    places = [p for p in map(to_place, fetch_osm()) if p]
    by_category: dict[str, int] = {}
    for p in places:
        by_category[p["category"]] = by_category.get(p["category"], 0) + 1
    print(f"Подходящих мест: {len(places)}")
    for category, count in sorted(by_category.items(), key=lambda item: -item[1]):
        print(f"   {category:<11} {count}")
    print("Примеры:", "; ".join(p["name"] for p in places[:8]))
    if dry_run:
        print("Пробный запуск: в базу ничего не записано.")
        return
    env = read_env()
    upload(places, env["SUPABASE_URL"], env["SUPABASE_SECRET_KEY"])
    print("Готово.")


if __name__ == "__main__":
    main()

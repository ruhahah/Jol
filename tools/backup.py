"""Резервная копия базы Jol в JSON-файлы на этом компьютере.

Запуск из корня проекта (раз в неделю достаточно):
    python tools/backup.py

Файлы появятся в папке backups/<дата>/. В копии есть Telegram ID пользователей, поэтому
папка backups/ исключена из git: не выкладывай её в репозиторий и не пересылай.
Нужны SUPABASE_URL и SUPABASE_SECRET_KEY в .env. Сторонних библиотек не требует.
"""
import datetime
import json
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
TABLES = ["users", "places", "reports", "photos", "verifications", "place_flags", "campaigns"]
PAGE = 1000


def read_env() -> dict:
    env = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return env


def fetch_table(url: str, key: str, table: str) -> list[dict]:
    rows: list[dict] = []
    while True:
        request = urllib.request.Request(
            f"{url}/rest/v1/{table}?select=*&order=id&limit={PAGE}&offset={len(rows)}"
            if table != "place_flags" else
            f"{url}/rest/v1/{table}?select=*&order=place_id,user_id&limit={PAGE}&offset={len(rows)}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            page = json.load(response)
        rows += page
        if len(page) < PAGE:
            return rows


def main() -> None:
    env = read_env()
    folder = ROOT / "backups" / datetime.date.today().isoformat()
    folder.mkdir(parents=True, exist_ok=True)
    for table in TABLES:
        try:
            rows = fetch_table(env["SUPABASE_URL"], env["SUPABASE_SECRET_KEY"], table)
        except urllib.error.HTTPError as error:
            print(f"{table:<14} пропущена: HTTP {error.code}")
            continue
        (folder / f"{table}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{table:<14} {len(rows)} строк")
    print("Готово:", folder)


if __name__ == "__main__":
    main()

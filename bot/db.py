"""Работа с базой по HTTPS: вызовы SQL-функций из db/bot_api.sql через REST API Supabase.

Прямое подключение к Postgres (порт 5432) блокируется во многих сетях, а HTTPS работает везде.
Вся логика транзакций живёт в SQL-функциях, здесь только их вызовы."""
import json

import aiohttp

POINTS_PER_REPORT = 10
POINTS_PER_CONFIRM = 5
SEARCH_RADIUS_M = 200     # «места рядом» при добавлении отчёта
FIND_RADIUS_M = 1500      # поиск доступных мест
CHECK_RADIUS_M = 500      # места, ждущие второго мнения

_session: aiohttp.ClientSession | None = None
_rpc_url = ""


async def connect(supabase_url: str, secret_key: str) -> None:
    global _session, _rpc_url
    _rpc_url = supabase_url.rstrip("/") + "/rest/v1/rpc/"
    _session = aiohttp.ClientSession(
        headers={"apikey": secret_key, "Authorization": f"Bearer {secret_key}"},
        timeout=aiohttp.ClientTimeout(total=20),
    )


async def close() -> None:
    if _session:
        await _session.close()


async def _rpc(function: str, **params):
    async with _session.post(_rpc_url + function, json=params) as res:
        body = await res.text()
        if res.status >= 400:
            raise RuntimeError(f"Supabase {function}: HTTP {res.status} {body[:300]}")
        return json.loads(body) if body else None


async def touch_user(tg_id: int, username: str | None) -> dict:
    """Создаёт пользователя при первом сообщении. Возвращает {"id": ..., "lang": ...}."""
    return await _rpc("bot_touch_user", p_tg_id=tg_id, p_username=username)


async def set_lang(user_id: int, lang: str) -> None:
    await _rpc("bot_set_lang", p_user_id=user_id, p_lang=lang)


async def get_place(place_id: int) -> dict | None:
    return await _rpc("bot_get_place", p_place_id=place_id)


async def nearby_places(lat: float, lon: float) -> list[dict]:
    return await _rpc("bot_nearby_places", p_lat=lat, p_lon=lon, p_radius=SEARCH_RADIUS_M)


async def find_accessible(lat: float, lon: float, category: str | None = None) -> list[dict]:
    """Ближайшие места со статусом «доступно» или «частично»."""
    return await _rpc("bot_find_accessible", p_lat=lat, p_lon=lon, p_category=category,
                      p_radius=FIND_RADIUS_M)


async def places_to_verify(user_id: int, lat: float, lon: float) -> list[dict]:
    """Места рядом, которые ждут второго мнения, вместе с ответами последнего отчёта."""
    return await _rpc("bot_places_to_verify", p_user_id=user_id, p_lat=lat, p_lon=lon,
                      p_radius=CHECK_RADIUS_M)


async def confirm_report(user_id: int, report_id: int) -> dict | None:
    """Подтверждает чужой отчёт. None — если подтвердить нельзя (свой или уже подтверждал)."""
    return await _rpc("bot_confirm_report", p_user_id=user_id, p_report_id=report_id,
                      p_points=POINTS_PER_CONFIRM)


async def dispute_report(user_id: int, report_id: int) -> None:
    await _rpc("bot_dispute_report", p_user_id=user_id, p_report_id=report_id)


async def save_report(*, user_id: int, lat: float | None, lon: float | None, answers: dict, status: str,
                      photos: list[str], place_id: int | None = None,
                      new_place: tuple[str, str] | None = None) -> int:
    """Сохраняет отчёт одной транзакцией (см. bot_save_report). Возвращает id места."""
    name, category = new_place or (None, None)
    return await _rpc(
        "bot_save_report",
        p_user_id=user_id, p_answers=answers, p_status=status, p_photos=photos,
        p_place_id=place_id, p_new_name=name, p_new_category=category,
        p_lat=lat, p_lon=lon, p_points=POINTS_PER_REPORT,
    )

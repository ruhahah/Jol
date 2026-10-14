"""Работа с базой по HTTPS: вызовы SQL-функций из db/bot_api.sql через REST API Supabase.

Прямое подключение к Postgres (порт 5432) блокируется во многих сетях, а HTTPS работает везде.
Вся логика транзакций живёт в SQL-функциях, здесь только их вызовы."""
import json
from datetime import datetime, timezone

import aiohttp

POINTS_PER_REPORT = 10
POINTS_PER_CONFIRM = 5
SEARCH_RADIUS_M = 200     # «места рядом» при добавлении отчёта
FIND_RADIUS_M = 1500      # поиск доступных мест
CHECK_RADIUS_M = 500      # места, ждущие второго мнения

_session: aiohttp.ClientSession | None = None
_rest_url = ""
_rpc_url = ""


async def connect(supabase_url: str, secret_key: str) -> None:
    global _session, _rest_url, _rpc_url
    _rest_url = supabase_url.rstrip("/") + "/rest/v1/"
    _rpc_url = _rest_url + "rpc/"
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


# --- Шаг диалога (таблица bot_state), чтобы он переживал «сон» бесплатного хостинга ----

async def load_state(key: str) -> dict | None:
    params = {"key": f"eq.{key}", "select": "state,data,updated_at"}
    async with _session.get(_rest_url + "bot_state", params=params) as res:
        rows = await res.json() if res.status == 200 else []
        return rows[0] if rows else None


async def save_state(key: str, state: str | None, data: dict) -> None:
    headers = {"Prefer": "resolution=merge-duplicates,return=minimal"}
    row = {"key": key, "state": state, "data": data, "updated_at": datetime.now(timezone.utc).isoformat()}
    async with _session.post(_rest_url + "bot_state", params={"on_conflict": "key"},
                             json=row, headers=headers) as res:
        if res.status >= 400:
            raise RuntimeError(f"Supabase bot_state: HTTP {res.status} {(await res.text())[:200]}")


async def delete_state(key: str) -> None:
    async with _session.delete(_rest_url + "bot_state", params={"key": f"eq.{key}"}) as res:
        if res.status >= 400:
            raise RuntimeError(f"Supabase bot_state: HTTP {res.status}")


# --- Чтение публичных представлений (те же, что читает сайт) ------------------------------

async def _view(name: str, **params) -> list[dict]:
    async with _session.get(_rest_url + name, params={"select": "*", **params}) as res:
        if res.status >= 400:
            raise RuntimeError(f"Supabase {name}: HTTP {res.status} {(await res.text())[:200]}")
        return await res.json()


async def summary() -> dict:
    """Числа по городу: всего мест, сколько в каждом статусе, сколько проверено, сколько отчётов."""
    return (await _view("places_summary_public"))[0]


async def leaderboard(limit: int = 10) -> list[dict]:
    return await _view("leaderboard_public", limit=str(limit))


async def campaigns() -> list[dict]:
    """Идущие сейчас акции с прогрессом (представление campaigns_public)."""
    now = datetime.now(timezone.utc).isoformat()
    return await _view("campaigns_public", ends_at=f"gt.{now}", order="ends_at")


# --- Модерация (только для администраторов) --------------------------------------------

async def admin_recent() -> dict:
    return await _rpc("bot_admin_recent", p_limit=8)


async def admin_hide_note(report_id: int) -> bool:
    return bool(await _rpc("bot_admin_hide_note", p_report_id=report_id))


async def admin_reset_name(user_id: int) -> bool:
    return bool(await _rpc("bot_admin_reset_name", p_user_id=user_id))


async def admin_ban(user_id: int, ban: bool = True) -> bool:
    return bool(await _rpc("bot_admin_ban", p_user_id=user_id, p_ban=ban))


async def admin_unhide_place(place_id: int) -> bool:
    return bool(await _rpc("bot_admin_unhide_place", p_place_id=place_id))


async def admin_create_campaign(title: str, category: str | None, lat: float, lon: float,
                                goal: int, days: int, radius_m: float = 1000) -> int:
    return await _rpc("bot_admin_create_campaign", p_title=title, p_category=category, p_lat=lat, p_lon=lon,
                      p_radius_m=radius_m, p_goal=goal, p_days=days)


async def admin_end_campaign(campaign_id: int) -> bool:
    return bool(await _rpc("bot_admin_end_campaign", p_id=campaign_id))


# --- Места ---------------------------------------------------------------------------------

async def search(query: str) -> list[dict]:
    """Места, в названии которых есть эта строка."""
    return await _rpc("bot_search", p_query=query)


async def flag_gone(user_id: int, place_id: int) -> dict | None:
    """«Места больше нет». Возвращает {"name", "flags", "hidden"}; после второго сигнала место скрыто."""
    return await _rpc("bot_flag_gone", p_user_id=user_id, p_place_id=place_id)


# --- Пользователи ------------------------------------------------------------------------

async def me(user_id: int) -> dict:
    """Профиль для /me: очки, число отчётов и подтверждений, место в рейтинге."""
    return await _rpc("bot_me", p_user_id=user_id)


async def set_name(user_id: int, name: str) -> None:
    await _rpc("bot_set_name", p_user_id=user_id, p_name=name)


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

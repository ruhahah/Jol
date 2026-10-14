"""Диалоги бота от начала до конца — с подменённым Telegram и подменённой базой.

Запуск из корня проекта:
    pip install -r bot/requirements.txt
    python tests/test_bot_flow.py

Сеть не нужна: ответы Telegram и базы подставляются здесь же. Падает на первой ошибке.
"""
import asyncio
import datetime
import hashlib
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "bot"))
os.environ.pop("ADMIN_IDS", None)

import aiohttp
from aiogram import Bot, Dispatcher
from aiogram.client.session.base import BaseSession
from aiogram.fsm.storage.memory import MemoryStorage, SimpleEventIsolation
from aiogram.types import Chat, Message

import db
import main
from storage import FlushStateMiddleware, SupabaseStorage

sent = []      # (метод, текст, клавиатура, chat_id) — всё, что бот отправил или отредактировал
calls = []     # (метод, объект) — вообще все вызовы Telegram
saved = []
log = []       # вызовы БД, которые что-то меняют
stored_states = {}   # «таблица bot_state»
state = {"lang": "ru", "nearby": [], "found": [], "waiting": [], "confirm": None, "search": [], "gone": None,
         "me": {"points": 45, "reports": 4, "confirms": 1, "slopes": 0, "rank": 3}, "leaders": []}


class FakeSession(BaseSession):
    async def close(self):
        pass

    async def make_request(self, bot, method, timeout=None):
        name = type(method).__name__
        calls.append((name, method))
        if name in ("AnswerCallbackQuery", "SetWebhook", "SetMyCommands"):
            return True
        sent.append((name, getattr(method, "text", None), getattr(method, "reply_markup", None),
                     getattr(method, "chat_id", None)))
        return Message(message_id=999, date=datetime.datetime.now(), chat=Chat(id=1, type="private"))

    async def stream_content(self, *a, **k):
        yield b""


async def touch_user(tg_id, username):
    return {"id": 7, "lang": state["lang"], "banned": state.get("banned", False)}


async def set_lang(user_id, lang):
    state["lang"] = lang


async def nearby_places(lat, lon):
    return state["nearby"]


async def get_place(place_id):
    return {"id": place_id, "name": "ЦОН"} if place_id in (12, 30) else None


async def save_report(**kw):
    saved.append(kw)
    return 1


async def find_accessible(lat, lon, category=None):
    log.append(("find", category))
    return [p for p in state["found"] if category in (None, p["category"])]


async def places_to_verify(user_id, lat, lon):
    return state["waiting"]


async def confirm_report(user_id, report_id):
    log.append(("confirm", report_id))
    return state["confirm"]


async def dispute_report(user_id, report_id):
    log.append(("dispute", report_id))


async def me(user_id):
    return {"id": user_id, "display_name": state.get("name"), **state["me"]}


async def set_name(user_id, name):
    state["name"] = name


async def search(query):
    log.append(("search", query))
    return state["search"]


async def flag_gone(user_id, place_id):
    log.append(("gone", place_id))
    return state["gone"]


async def summary():
    return {"total": 994, "accessible": 3, "partial": 2, "inaccessible": 1, "unknown": 988, "verified": 1, "reports": 7}


async def leaderboard(limit=10):
    return state["leaders"]


async def campaigns():
    return state.get("campaigns", [])


async def admin_recent():
    return {"notes": [{"report_id": 81, "comment": "спам", "user_id": 9, "place_id": 8, "place": "Аптека В",
                       "created_at": "2026-10-14T10:00:00+00:00"}],
            "names": [{"user_id": 9, "display_name": "Плохое имя", "points": 10}]}


async def admin_action(*args):
    log.append(("admin",) + args)
    return True


async def load_state(key):
    return stored_states.get(key)


async def save_state(key, st, data):
    stored_states[key] = {"state": st, "data": json.loads(json.dumps(data)),
                          "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}


async def delete_state(key):
    stored_states.pop(key, None)


for fn in (touch_user, set_lang, nearby_places, get_place, save_report, find_accessible, places_to_verify,
           confirm_report, dispute_report, me, set_name, search, flag_gone, summary, leaderboard,
           campaigns, admin_recent, load_state, save_state, delete_state):
    setattr(db, fn.__name__, fn)
for name in ("admin_hide_note", "admin_reset_name", "admin_ban", "admin_unhide_place", "admin_end_campaign"):
    setattr(db, name, lambda *a, _n=name: admin_action(_n, *a))
db.admin_create_campaign = lambda *a: admin_action("create_campaign", *a)

MENU = ["menu:find", "menu:add", "menu:check", "menu:campaign", "menu:me"]
USER = {"id": 100, "is_bot": False, "first_name": "T", "username": "tester"}
CHAT = {"id": 100, "type": "private"}
uid = 0


def msg(**fields):
    global uid
    uid += 1
    return {"update_id": uid, "message": {"message_id": uid, "date": 1700000000, "chat": CHAT,
                                          "from": USER, **fields}}


def cb(data):
    global uid
    uid += 1
    return {"update_id": uid, "callback_query": {
        "id": str(uid), "from": USER, "chat_instance": "x", "data": data,
        "message": {"message_id": 999, "date": 1700000000, "chat": CHAT, "text": "prev",
                    "from": {"id": 42, "is_bot": True, "first_name": "bot"}}}}


PHOTO = {"photo": [{"file_id": "small", "file_unique_id": "s", "width": 90, "height": 90},
                   {"file_id": "BIG", "file_unique_id": "b", "width": 900, "height": 900}]}
LOC = {"location": {"latitude": 42.3417, "longitude": 69.5901}}
NO_NOTE = cb("comment:skip")


def buttons(index=-1):
    markup = sent[index][2]
    return [b.callback_data or b.url for row in markup.inline_keyboard for b in row]


def last_alert():
    return [m for name, m in calls if name == "AnswerCallbackQuery"][-1]


def finish():
    """Два последних необязательных шага отчёта: «что ещё есть у входа» и заметка."""
    return cb("ext:done"), cb("comment:skip")


async def run():
    bot = Bot("42:TEST", session=FakeSession())
    dp = Dispatcher(storage=MemoryStorage(), events_isolation=SimpleEventIsolation())
    dp.update.outer_middleware(main.UserMiddleware())
    dp.include_router(main.router)

    async def feed(*updates):
        for update in updates:
            n = len(sent)
            await dp.feed_raw_update(bot, update)
            for kind, text, markup, chat in sent[n:]:
                print(f"   <- {kind}: {text!r}")

    print("== 1. /start → язык → меню → новое место (kk), без ступенек, без заметки ==")
    await feed(msg(text="/start"))
    assert buttons() == ["lang:kk", "lang:ru", "lang:en"]
    await feed(cb("lang:kk"))
    assert state["lang"] == "kk" and buttons() == MENU
    await feed(cb("menu:add"))
    assert sent[-1][2].keyboard[0][0].request_location
    await feed(msg(text="привет"), msg(**LOC), msg(text="Europharma"))
    assert "cat:pharmacy" in buttons()
    await feed(cb("cat:pharmacy"), msg(text="не фото"), msg(**PHOTO), cb("photos:done"))
    assert buttons() == ["q:steps:none", "q:steps:one", "q:steps:many", "q:steps:unknown"]
    await feed(cb("q:steps:none"))
    assert buttons()[0] == "q:door_wide:yes"                  # пандус и замер уклона пропущены
    await feed(cb("q:steps:many"), cb("q:door_wide:yes"), cb("q:call_button:no"), cb("q:toilet:unknown"))
    assert not saved and buttons() == ["ext:parking", "ext:elevator", "ext:tactile", "ext:done"]
    await feed(cb("ext:parking"), cb("ext:tactile"), cb("ext:parking"))   # отметил и снял парковку
    assert sent[-1][0] == "EditMessageReplyMarkup" and "✅" in sent[-1][2].inline_keyboard[2][0].text
    await feed(cb("ext:done"))
    assert buttons() == ["comment:skip"]                      # перед сохранением — вопрос про заметку
    await feed(msg(**PHOTO))                                  # не текст — подсказка, шаг не теряется
    assert not saved
    await feed(cb("comment:skip"))
    r = saved.pop()
    assert r["answers"]["extras"] == ["tactile"]
    assert r["status"] == "accessible" and r["place_id"] is None and r["photos"] == ["BIG"]
    assert r["new_place"] == ("Europharma", "pharmacy") and (r["lat"], r["lon"]) == (42.3417, 69.5901)
    assert "ramp" not in r["answers"] and r["answers"]["comment"] == "" and buttons() == MENU

    print("== 2. Существующее место, пандус → замер уклона → заметка текстом ==")
    state["lang"] = "ru"
    state["nearby"] = [{"id": 5, "name": "ЦОН", "dist_m": 40}]
    await feed(msg(text="/add"), msg(**LOC))
    assert buttons() == ["place:5", "place:search", "place:new"]
    await feed(cb("place:5"), cb("photos:done"), cb("q:steps:many"), cb("q:ramp:good"))
    keyboard = sent[-1][2].keyboard
    assert keyboard[0][0].web_app.url == "https://jol-web.onrender.com/?tg=1&lang=ru#/slope"
    await feed(msg(text="что?"), msg(web_app_data={"data": "мусор", "button_text": "x"}))
    assert "Измерить уклон" in sent[-1][1]
    await feed(msg(web_app_data={"data": json.dumps({"slope_pct": 13.84, "spread": 0.3, "n": 90}), "button_text": "x"}))
    await feed(cb("q:door_wide:yes"), cb("q:call_button:yes"), cb("q:toilet:no"), cb("ext:done"))
    await feed(msg(text="  Вход   со двора,\n звонок справа " + "я" * 300))
    r = saved.pop()
    print("   saved:", {k: (v if k != "comment" else v[:30] + "…") for k, v in r["answers"].items()})
    assert r["answers"]["ramp_slope_pct"] == 13.8 and r["place_id"] == 5
    assert r["answers"]["comment"].startswith("Вход со двора, звонок справа") and len(r["answers"]["comment"]) == 200

    print("== 3. Замер пропущен; пандуса нет — про уклон не спрашиваем ==")
    await feed(msg(text="/add"), msg(**LOC), cb("place:5"), cb("photos:done"), cb("q:steps:one"), cb("q:ramp:bad"))
    await feed(msg(text="Пропустить"), cb("q:door_wide:yes"), cb("q:call_button:no"), cb("q:toilet:no"), *finish())
    r = saved.pop()
    assert "ramp_slope_pct" not in r["answers"] and r["status"] == "partial"
    await feed(msg(text="/add"), msg(**LOC), cb("place:5"), cb("photos:done"), cb("q:steps:many"), cb("q:ramp:none"))
    assert buttons()[0] == "q:door_wide:yes"
    await feed(msg(text="/cancel"))

    print("== 4. Найти доступное место, сузить до аптек ==")
    state["found"] = [
        {"id": 3, "name": "Аптека А", "category": "pharmacy", "status": "accessible", "is_verified": True, "dist_m": 120},
        {"id": 4, "name": "Кафе Б", "category": "cafe", "status": "partial", "is_verified": False, "dist_m": 300},
    ]
    await feed(msg(text="/find"), msg(**LOC))
    rows = sent[-1][2].inline_keyboard
    assert rows[0][0].url == "https://jol-web.onrender.com/#/map/3" and "✓" in rows[0][0].text
    assert [len(row) for row in rows] == [1, 1, 3, 3, 1]
    await feed(cb("find:pharmacy"), cb("find:school"))
    assert "пока нет" in sent[-1][1]

    print("== 5. Проверить места рядом: подтвердить → автору приходит уведомление ==")
    state["waiting"] = [
        {"id": 8, "name": "Аптека В", "category": "pharmacy", "status": "accessible", "report_id": 81,
         "steps": "one", "ramp": "good", "door_wide": "yes", "call_button": "no", "toilet": "unknown",
         "ramp_slope_pct": 6.4, "dist_m": 60},
        {"id": 9, "name": "Кафе Г", "category": "cafe", "status": "inaccessible", "report_id": 91,
         "steps": "none", "ramp": "unknown", "door_wide": "no", "call_button": "no", "toilet": "no",
         "ramp_slope_pct": None, "dist_m": 200},
    ]
    await feed(msg(text="/check"), msg(**LOC), cb("chk:0"))
    assert "уклон 6.4%" in sent[-1][1] and buttons() == ["chkyes:0", "chkno:0", "chkgone:0", "chkback"]
    state["confirm"] = None
    await feed(cb("chkyes:0"))
    assert last_alert().show_alert
    state["confirm"] = {"place_id": 8, "name": "Аптека В", "status": "accessible", "is_verified": True,
                        "author_tg_id": 555, "author_lang": "kk"}
    await feed(cb("chkyes:0"))
    to_me, to_author = sent[-2], sent[-1]
    assert "проверенное" in to_me[1] and "+5" in to_me[1] and to_author[3] == 555
    assert "Аптека В" in to_author[1] and "ерікті растады" in to_author[1]   # автору — на его языке

    print("== 6. Не согласен → свой отчёт; «места нет» из карточки проверки ==")
    await feed(msg(text="/check"), msg(**LOC), cb("chk:1"), cb("chkno:1"))
    assert log[-1] == ("dispute", 91) and buttons() == ["photos:done"]
    await feed(cb("photos:done"), cb("q:steps:none"), cb("q:door_wide:yes"), cb("q:call_button:no"),
               cb("q:toilet:no"), *finish())
    assert saved.pop()["place_id"] == 9
    await feed(msg(text="/check"), msg(**LOC), cb("chk:1"), cb("chkgone:1"))
    assert "Кафе Г" in sent[-1][1] and buttons() == ["gone:yes", "gone:no"]
    state["gone"] = {"name": "Кафе Г", "flags": 1, "hidden": False}
    await feed(cb("gone:yes"))
    assert log[-1] == ("gone", 9) and "ещё один человек" in sent[-1][1] and buttons() == MENU

    print("== 7. Ссылки с сайта: /start place_12 и /start gone_30 ==")
    await feed(msg(text="/start place_12"), cb("lang:ru"))
    assert "ЦОН" in sent[-2][1] and buttons() == ["photos:done"]
    await feed(cb("photos:done"), cb("q:steps:one"), cb("q:ramp:unknown"), cb("q:door_wide:yes"),
               cb("q:call_button:no"), cb("q:toilet:no"), *finish())
    r = saved.pop()
    assert r["place_id"] == 12 and r["lat"] is None and r["status"] == "partial"
    await feed(msg(text="/start gone_30"), cb("lang:ru"))
    assert buttons() == ["gone:yes", "gone:no"]
    state["gone"] = {"name": "ЦОН", "flags": 2, "hidden": True}
    await feed(cb("gone:yes"))
    assert log[-1] == ("gone", 30) and "скрыто" in sent[-1][1]
    await feed(msg(text="/start gone_30"), cb("lang:ru"), cb("gone:no"))
    assert log[-1] == ("gone", 30) and "Отменено" in sent[-1][1]          # новых сигналов не добавилось
    await feed(msg(text="/start place_999"), cb("lang:ru"))
    assert buttons() == MENU

    print("== 8. Поиск по названию: команда, из списка «рядом», действия с местом ==")
    state["search"] = [{"id": 12, "name": "ЦОН", "category": "government", "status": "unknown"},
                       {"id": 30, "name": "ЦОН №2", "category": "government", "status": "accessible"}]
    await feed(msg(text="/search цон"))
    assert log[-1] == ("search", "цон") and buttons() == ["pick:12", "pick:30"]
    await feed(cb("pick:12"))
    assert buttons() == ["act:report:12", "https://jol-web.onrender.com/#/map/12", "act:gone:12"]
    await feed(cb("act:report:12"))
    assert buttons() == ["photos:done"]
    await feed(msg(text="/cancel"), msg(text="/search"))
    assert "от 2 букв" in sent[-1][1]
    await feed(msg(text="я"))
    assert "от 2 букв" in sent[-1][1]
    state["search"] = []
    await feed(msg(text="несуществующее"))
    assert "ничего не нашлось" in sent[-1][1]
    state["search"] = [{"id": 30, "name": "ЦОН №2", "category": "government", "status": "accessible"}]
    await feed(msg(text="/add"), msg(**LOC), cb("place:search"), msg(text="цон"), cb("pick:30"), cb("act:gone:30"))
    assert buttons() == ["gone:yes", "gone:no"]
    await feed(cb("gone:no"))

    print("== 9. Профиль со значками, имя, рейтинг, цифры города ==")
    await feed(msg(text="/me"))
    print("  ", sent[-1][1].replace("\n", " | "))
    assert "Волонтёр №7" in sent[-1][1] and "Следопыт" in sent[-1][1] and "🥇 Первый отчёт" in sent[-1][1]
    assert "Замерщик" not in sent[-1][1]
    state["me"] = {"points": 0, "reports": 0, "confirms": 0, "slopes": 0, "rank": 9}
    await feed(msg(text="/me"))
    assert "пока нет" in sent[-1][1]
    state["me"] = {"points": 320, "reports": 12, "confirms": 6, "slopes": 2, "rank": 1}
    await feed(msg(text="/name   Айгерим   Р.  "), cb("menu:me"))
    assert sent[-1][1].startswith("Айгерим Р.") and "Проводник" in sent[-1][1]
    assert all(b in sent[-1][1] for b in ("10 отчётов", "Замерщик уклона", "Проверяющий"))
    await feed(msg(text="/top"))
    assert "пуст" in sent[-1][1]
    state["leaders"] = [{"id": 1, "name": "Айгерим Р.", "points": 320, "reports_count": 18},
                        {"id": 2, "name": None, "points": 40, "reports_count": 4}]
    await feed(msg(text="/top"))
    print("  ", sent[-1][1].replace("\n", " | "))
    assert "1. Айгерим Р. — 320" in sent[-1][1] and "2. Волонтёр №2 — 40" in sent[-1][1]
    await feed(msg(text="/stats"))
    assert "994" in sent[-1][1] and buttons() == ["https://jol-web.onrender.com/#/stats"]

    print("== 10. Без диалога: сообщение → меню, старая кнопка → подсказка ==")
    await feed(msg(text="НИШ"))
    assert buttons() == MENU
    await feed(cb("cat:school"), cb("pick:12"), cb("gone:yes"), cb("comment:skip"))
    assert last_alert().show_alert and not saved

    print("== 11. Шаг диалога переживает перезапуск бота (включая шаг заметки) ==")

    def make_dp():
        storage = SupabaseStorage()
        d = Dispatcher(storage=storage, events_isolation=SimpleEventIsolation())
        d.update.outer_middleware(FlushStateMiddleware(storage))
        d.update.outer_middleware(main.UserMiddleware())
        main.router._parent_router = None
        d.include_router(main.router)
        return d

    dp1 = make_dp()
    state["nearby"] = [{"id": 5, "name": "ЦОН", "dist_m": 40}]
    for update in (msg(text="/add"), msg(**LOC), cb("place:5"), cb("photos:done"), cb("q:steps:none"),
                   cb("q:door_wide:yes"), cb("q:call_button:no"), cb("q:toilet:no"), cb("ext:elevator"),
                   cb("ext:done")):
        await dp1.feed_raw_update(bot, update)
    assert stored_states["100:100"]["state"] == "Flow:comment" and not saved
    dp2 = make_dp()                                           # «бот проснулся»: память пуста
    await dp2.feed_raw_update(bot, msg(text="вход со двора"))
    r = saved.pop()
    assert r["place_id"] == 5 and r["answers"]["comment"] == "вход со двора" and "100:100" not in stored_states
    stored_states["100:100"] = {"state": "Flow:questions", "data": {"answers": {}, "photos": []},
                                "updated_at": (datetime.datetime.now(datetime.timezone.utc)
                                               - datetime.timedelta(hours=7)).isoformat()}
    dp3 = make_dp()
    await dp3.feed_raw_update(bot, cb("q:steps:none"))        # диалог семичасовой давности не продолжаем
    assert last_alert().show_alert and not saved
    main.router._parent_router = None
    dp.include_router(main.router)

    print("== 13. Давно проверенное место: бот спрашивает, всё ли по-прежнему ==")
    old = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=250)).isoformat()
    state["waiting"] = [{"id": 8, "name": "Аптека В", "category": "pharmacy", "status": "accessible",
                         "report_id": 81, "steps": "none", "ramp": "unknown", "door_wide": "yes",
                         "call_button": "no", "toilet": "no", "ramp_slope_pct": None, "extras": ["parking"],
                         "last_checked_at": old, "stale": True, "dist_m": 60}]
    await feed(msg(text="/check"), msg(**LOC), cb("chk:0"))
    assert "8 мес. назад" in sent[-1][1] and "по-прежнему" in sent[-1][1] and "Парковка" in sent[-1][1]
    await feed(msg(text="/cancel"))

    print("== 14. Акции для волонтёров ==")
    await feed(msg(text="/campaign"))
    assert "акций нет" in sent[-1][1]
    state["campaigns"] = [{"id": 1, "title": "Аптеки центра", "category": "pharmacy", "goal": 30, "done": 12,
                           "ends_at": "2026-10-21T10:00:00+00:00"}]
    await feed(cb("menu:campaign"))
    print("  ", sent[-1][1].replace("\n", " | "))
    assert "▓▓▓▓░░░░░░ 12 из 30" in sent[-1][1] and "21.10" in sent[-1][1]

    print("== 15. Модерация: только для ADMIN_IDS ==")
    await feed(msg(text="/mod"))
    assert buttons() == MENU                                   # не админ — команда как неизвестная
    os.environ["ADMIN_IDS"] = "5, 100"
    await feed(msg(text="/mod"))
    assert "спам" in sent[-1][1] and buttons() == ["mod:note:81", "mod:name:9", "mod:ban:9"]
    await feed(cb("mod:note:81"), cb("mod:ban:9"))
    assert log[-2:] == [("admin", "admin_hide_note", 81), ("admin", "admin_ban", 9)]
    await feed(msg(text="/mod_place 12"), msg(text="/mod_unban 9"), msg(text="/mod_end 1"), msg(text="/mod_place x"))
    assert log[-3:] == [("admin", "admin_unhide_place", 12), ("admin", "admin_ban", 9, False),
                        ("admin", "admin_end_campaign", 1)] and "Команды" in sent[-1][1]
    await feed(msg(text="/mod_campaign 30 7 pizza Неверная категория"))
    assert "Пример" in sent[-1][1]
    await feed(msg(text="/mod_campaign 30 7 pharmacy Аптеки на Тауке хана"), msg(**LOC))
    assert log[-1] == ("admin", "create_campaign", "Аптеки на Тауке хана", "pharmacy", 42.3417, 69.5901, 30, 7)
    os.environ["ADMIN_IDS"] = ""

    print("== 16. Заблокированный пользователь ==")
    state["banned"] = True
    n = len(saved)
    await feed(msg(text="/add"))
    assert "ограничен" in sent[-1][1]
    await feed(cb("menu:add"))
    assert "ограничен" in last_alert().text and len(saved) == n
    state["banned"] = False

    print("== 12. Команды и режим webhook ==")
    await main.set_commands(bot)
    commands = [m for name, m in calls if name == "SetMyCommands"]
    print("   меню команд:", [c.command for c in commands[0].commands])
    assert [c.command for c in commands[0].commands] == list(main.COMMANDS)
    os.environ["PORT"] = "8765"
    task = asyncio.create_task(main.run_webhook(bot, dp, "https://example.invalid/"))
    await asyncio.sleep(1)
    secret = hashlib.sha256(b"42:TEST").hexdigest()
    async with aiohttp.ClientSession() as http:
        async with http.post("http://127.0.0.1:8765/webhook", json=msg(text="/add")) as res:
            assert res.status == 401
        n = len(sent)
        async with http.post("http://127.0.0.1:8765/webhook", json=msg(text="/add"),
                             headers={"X-Telegram-Bot-Api-Secret-Token": secret}) as res:
            assert res.status == 200
        await asyncio.sleep(0.5)
        assert len(sent) == n + 1 and sent[-1][2].keyboard[0][0].request_location
    task.cancel()
    print("FLOW OK")


asyncio.run(run())

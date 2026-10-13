import asyncio
import hashlib
import json
import logging
import math
import os

from aiogram import BaseMiddleware, Bot, Dispatcher, F, Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import SimpleEventIsolation
from aiogram.types import (BotCommand, CallbackQuery, InlineKeyboardButton, KeyboardButton, Message,
                           ReplyKeyboardMarkup, ReplyKeyboardRemove, WebAppInfo)
from aiogram.utils.keyboard import InlineKeyboardBuilder
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application
from aiohttp import web
from dotenv import load_dotenv

import db
from scoring import report_status
from storage import FlushStateMiddleware, SupabaseStorage
from texts import CATEGORIES, CHOOSE_LANG, LANGS, t

MAX_PHOTOS = 3
WEBHOOK_PATH = "/webhook"
COMMANDS = ("find", "add", "check", "search", "me", "top", "stats", "menu", "start", "cancel")
# Очки, с которых начинается каждый уровень (названия — level_0 … level_3 в texts.py)
LEVELS = (0, 30, 100, 300)
# Значки в профиле: ключ текста и условие по данным bot_me
BADGES = (
    ("badge_first", lambda me: me["reports"] >= 1),
    ("badge_ten", lambda me: me["reports"] >= 10),
    ("badge_slope", lambda me: me.get("slopes", 0) >= 1),
    ("badge_checker", lambda me: me["confirms"] >= 5),
)
log = logging.getLogger("jol")
STATUS_EMOJI = {"accessible": "🟢", "partial": "🟡", "inaccessible": "🔴", "unknown": "⚪"}

# Порядок вопросов и допустимые ответы. Значения совпадают с enum в db/schema.sql.
QUESTIONS = {
    "steps": ["none", "one", "many", "unknown"],
    "ramp": ["good", "bad", "none", "unknown"],
    "door_wide": ["yes", "no", "unknown"],
    "call_button": ["yes", "no", "unknown"],
    "toilet": ["yes", "no", "unknown"],
}

router = Router()
router.message.filter(F.chat.type == "private")


class Flow(StatesGroup):
    location = State()      # ждём геолокацию; зачем — в data["purpose"]: add / find / check
    place = State()
    new_name = State()
    new_category = State()
    photos = State()
    questions = State()
    slope = State()         # ждём замер уклона из мини-приложения или «Пропустить»
    comment = State()       # последний шаг отчёта: необязательная заметка
    find = State()          # показаны результаты поиска, можно сузить категорию
    check = State()         # список мест, ждущих второго мнения
    search = State()        # поиск места по названию
    gone = State()          # ждём подтверждения «места больше нет»


class UserMiddleware(BaseMiddleware):
    """Создаёт пользователя при первом сообщении и передаёт в хендлеры user_id и lang."""

    async def __call__(self, handler, event, data):
        tg_user = data.get("event_from_user")
        if tg_user:
            row = await db.touch_user(tg_user.id, tg_user.username)
            data["user_id"], data["lang"] = row["id"], row["lang"]
        return await handler(event, data)


def site_url() -> str:
    return os.getenv("SITE_URL", "https://jol-web.onrender.com").rstrip("/")


def kb(buttons: list[tuple[str, str]], width: int = 1):
    """Инлайн-клавиатура из пар (текст, callback_data). Если вместо данных ссылка — кнопка-ссылка."""
    builder = InlineKeyboardBuilder()
    for text, target in buttons:
        if target.startswith("https://"):
            builder.button(text=text, url=target)
        else:
            builder.button(text=text, callback_data=target)
    return builder.adjust(width).as_markup()


def menu_kb(lang: str):
    return kb([(t(lang, f"btn_{action}"), f"menu:{action}") for action in ("find", "add", "check", "me")])


async def profile_text(lang: str, user_id: int) -> str:
    me = await db.me(user_id)
    level = max(i for i, threshold in enumerate(LEVELS) if me["points"] >= threshold)
    upcoming = ""
    if level + 1 < len(LEVELS):
        upcoming = t(lang, "me_next", level=t(lang, f"level_{level + 1}"), left=LEVELS[level + 1] - me["points"])
    badges = [t(lang, key) for key, earned in BADGES if earned(me)]
    return t(
        lang, "me",
        name=me["display_name"] or t(lang, "me_anon", id=me["id"]),
        level=t(lang, f"level_{level}"), next=upcoming,
        points=me["points"], reports=me["reports"], confirms=me["confirms"], rank=me["rank"],
        badges=" · ".join(badges) if badges else t(lang, "badges_none"),
    )


def next_question(answers: dict) -> str | None:
    for key in QUESTIONS:
        if key in answers:
            continue
        if key == "ramp" and answers.get("steps") == "none":
            continue  # ступенек нет — про пандус не спрашиваем
        return key
    return None


def report_summary(lang: str, r: dict) -> str:
    """Ответы чужого отчёта словами — для экрана «всё так?»"""
    lines = [t(lang, "sum_rating", status=t(lang, f"status_{r['status']}")), ""]
    for key in QUESTIONS:
        if key == "ramp" and r["steps"] == "none":
            continue
        value = t(lang, f"opt_{r[key]}")
        if key == "ramp" and r.get("ramp_slope_pct") is not None:
            value += " · " + t(lang, "slope_value", pct=r["ramp_slope_pct"])
        lines.append(f"{t(lang, f'sum_{key}')}: {value}")
    return "\n".join(lines)


# --- /start, язык, меню ---------------------------------------------------------------

@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext, command: CommandObject):
    await state.clear()
    # Кнопка «Обновить в Telegram» на сайте ведёт на t.me/<бот>?start=place_12
    # а кнопка «Места больше нет» — на t.me/<бот>?start=gone_12
    args = command.args or ""
    kind, _, number = args.partition("_")
    if kind in ("place", "gone") and number.isdigit() and len(number) <= 12:
        await state.update_data(**{f"pending_{kind}": int(number)})
    await message.answer(
        CHOOSE_LANG,
        reply_markup=kb([(name, f"lang:{code}") for code, name in LANGS.items()], width=3),
    )


@router.callback_query(F.data.startswith("lang:"))
async def chose_lang(cb: CallbackQuery, state: FSMContext, user_id: int):
    lang = cb.data.split(":")[1]
    if lang not in LANGS:
        return await cb.answer()
    await db.set_lang(user_id, lang)
    await cb.message.edit_text(t(lang, "lang_saved"))
    await cb.answer()
    data = await state.get_data()
    pending = data.get("pending_place") or data.get("pending_gone")
    place = await db.get_place(pending) if pending else None
    if place and "pending_gone" in data:  # с сайта: «этого места больше нет»
        await ask_gone(cb.message, state, lang, place)
    elif place:  # с сайта к конкретному месту — геолокация не нужна
        await state.update_data(place_id=place["id"])
        await cb.message.answer(t(lang, "place_selected", name=place["name"]))
        await ask_photos(cb.message, state, lang)
    else:
        await cb.message.answer(t(lang, "menu"), reply_markup=menu_kb(lang))


@router.message(Command("menu"))
async def cmd_menu(message: Message, state: FSMContext, lang: str):
    await state.clear()
    await message.answer(t(lang, "menu"), reply_markup=menu_kb(lang))


@router.callback_query(F.data.startswith("menu:"))
async def chose_menu(cb: CallbackQuery, state: FSMContext, lang: str, user_id: int):
    purpose = cb.data.split(":")[1]
    await cb.answer()
    if purpose == "me":
        await cb.message.answer(await profile_text(lang, user_id))
    elif purpose in ("find", "add", "check"):
        await ask_location(cb.message, state, lang, purpose)


@router.message(Command("me"))
async def cmd_me(message: Message, lang: str, user_id: int):
    await message.answer(await profile_text(lang, user_id), reply_markup=menu_kb(lang))


@router.message(Command("name"))
async def cmd_name(message: Message, lang: str, user_id: int, command: CommandObject):
    """Имя для рейтинга на сайте. Telegram-имя мы не публикуем, поэтому человек выбирает его сам."""
    name = " ".join((command.args or "").split())[:24]
    if len(name) < 2:
        return await message.answer(t(lang, "name_help"))
    await db.set_name(user_id, name)
    await message.answer(t(lang, "name_saved", name=name))


@router.message(Command("find", "add", "check"))
async def cmd_purpose(message: Message, state: FSMContext, lang: str, command: CommandObject):
    await ask_location(message, state, lang, command.command)


@router.message(Command("cancel"))
async def cmd_cancel(message: Message, state: FSMContext, lang: str):
    await state.clear()
    await message.answer(t(lang, "cancelled"), reply_markup=ReplyKeyboardRemove())


@router.message(Command("top"))
async def cmd_top(message: Message, lang: str):
    leaders = await db.leaderboard()
    if not leaders:
        return await message.answer(t(lang, "top_empty"))
    lines = [
        f"{i}. {row['name'] or t(lang, 'me_anon', id=row['id'])} — {row['points']}"
        for i, row in enumerate(leaders, start=1)
    ]
    await message.answer(t(lang, "top_title") + "\n\n" + "\n".join(lines))


@router.message(Command("stats"))
async def cmd_stats(message: Message, lang: str):
    await message.answer(
        t(lang, "city_stats", **await db.summary()),
        reply_markup=kb([(t(lang, "btn_open_stats"), f"{site_url()}/#/stats")]),
    )


# --- Поиск места по названию и действия с найденным местом ---------------------------

@router.message(Command("search"))
async def cmd_search(message: Message, state: FSMContext, lang: str, command: CommandObject):
    await state.clear()
    await state.set_state(Flow.search)
    query = (command.args or "").strip()
    if query:
        await show_search(message, lang, query)
    else:
        await message.answer(t(lang, "ask_search"))


@router.message(Flow.search, F.text)
async def got_search(message: Message, lang: str):
    await show_search(message, lang, message.text.strip())


async def show_search(message: Message, lang: str, query: str):
    if len(query) < 2:
        return await message.answer(t(lang, "ask_search"))
    places = await db.search(query[:60])
    if not places:
        return await message.answer(t(lang, "search_none", query=query[:60]))
    await message.answer(
        t(lang, "search_title"),
        reply_markup=kb([(f"{STATUS_EMOJI[p['status']]} {p['name']}", f"pick:{p['id']}") for p in places]),
    )


@router.callback_query(Flow.search, F.data.startswith("pick:"))
async def picked_place(cb: CallbackQuery, lang: str):
    place = await db.get_place(int(cb.data.split(":")[1]))
    if not place:
        return await cb.answer(t(lang, "stale_button"), show_alert=True)
    await cb.answer()
    await cb.message.edit_text(
        t(lang, "place_selected", name=place["name"]),
        reply_markup=kb([
            (t(lang, "btn_describe"), f"act:report:{place['id']}"),
            (t(lang, "btn_on_map"), f"{site_url()}/#/map/{place['id']}"),
            (t(lang, "btn_gone"), f"act:gone:{place['id']}"),
        ]),
    )


@router.callback_query(Flow.search, F.data.startswith("act:"))
async def place_action(cb: CallbackQuery, state: FSMContext, lang: str):
    _, action, place_id = cb.data.split(":")
    place = await db.get_place(int(place_id))
    if not place:
        return await cb.answer(t(lang, "stale_button"), show_alert=True)
    await cb.answer()
    await cb.message.edit_reply_markup()
    if action == "gone":
        await ask_gone(cb.message, state, lang, place)
    else:
        await state.update_data(place_id=place["id"])
        await ask_photos(cb.message, state, lang)


# --- «Места больше нет» ----------------------------------------------------------------

async def ask_gone(message: Message, state: FSMContext, lang: str, place: dict):
    await state.clear()
    await state.set_state(Flow.gone)
    await state.update_data(gone_place=place["id"])
    await message.answer(
        t(lang, "ask_gone", name=place["name"]),
        reply_markup=kb([(t(lang, "btn_gone_yes"), "gone:yes"), (t(lang, "btn_gone_no"), "gone:no")]),
    )


@router.callback_query(Flow.gone, F.data.startswith("gone:"))
async def gone_answer(cb: CallbackQuery, state: FSMContext, lang: str, user_id: int):
    place_id = (await state.get_data())["gone_place"]
    await state.clear()
    await cb.answer()
    if cb.data != "gone:yes":
        return await cb.message.edit_text(t(lang, "cancelled"))
    result = await db.flag_gone(user_id, place_id)
    text = t(lang, "gone_hidden" if result and result["hidden"] else "gone_noted")
    await cb.message.edit_text(text, reply_markup=menu_kb(lang))


# --- Геолокация: общий первый шаг для «добавить», «найти» и «проверить» ---------------

async def ask_location(message: Message, state: FSMContext, lang: str, purpose: str):
    await state.clear()
    await state.set_state(Flow.location)
    await state.update_data(purpose=purpose)
    await message.answer(
        t(lang, f"ask_location_{purpose}"),
        reply_markup=ReplyKeyboardMarkup(
            keyboard=[[KeyboardButton(text=t(lang, "btn_location"), request_location=True)]],
            resize_keyboard=True,
            one_time_keyboard=True,
        ),
    )


@router.message(Flow.location, F.location)
async def got_location(message: Message, state: FSMContext, lang: str, user_id: int):
    lat, lon = message.location.latitude, message.location.longitude
    await state.update_data(lat=lat, lon=lon)
    purpose = (await state.get_data())["purpose"]
    if purpose == "find":
        await state.set_state(Flow.find)
        await show_found(message.answer, lang, lat, lon, category=None)
    elif purpose == "check":
        await show_check_list(message, state, lang, user_id, lat, lon)
    else:
        await show_nearby_for_report(message, state, lang, lat, lon)


@router.message(Flow.location)
async def need_location(message: Message, lang: str):
    await message.answer(t(lang, "need_location"))


# --- Найти доступное место -------------------------------------------------------------

async def show_found(send, lang: str, lat: float, lon: float, category: str | None):
    """send — message.answer для нового сообщения или message.edit_text при смене категории."""
    places = await db.find_accessible(lat, lon, category)
    category_name = t(lang, f"cat_{category}" if category else "cat_all")
    builder = InlineKeyboardBuilder()
    for p in places:  # каждое место — ссылка на его карточку на сайте
        label = f"{STATUS_EMOJI[p['status']]} {p['name']} · {p['dist_m']} m{' ✓' if p['is_verified'] else ''}"
        builder.row(InlineKeyboardButton(text=label, url=f"{site_url()}/#/map/{p['id']}"))
    filters = [InlineKeyboardButton(text=t(lang, "cat_all"), callback_data="find:all")] + [
        InlineKeyboardButton(text=t(lang, f"cat_{c}"), callback_data=f"find:{c}") for c in CATEGORIES[:5]
    ]
    builder.row(*filters, width=3)
    builder.row(InlineKeyboardButton(text=t(lang, "btn_open_map"), url=f"{site_url()}/#/map"))
    await send(t(lang, "find_title" if places else "find_none", category=category_name),
               reply_markup=builder.as_markup())


@router.callback_query(Flow.find, F.data.startswith("find:"))
async def chose_find_category(cb: CallbackQuery, state: FSMContext, lang: str):
    category = cb.data.split(":")[1]
    if category != "all" and category not in CATEGORIES:
        return await cb.answer()
    data = await state.get_data()
    await cb.answer()
    await show_found(cb.message.edit_text, lang, data["lat"], data["lon"], None if category == "all" else category)


# --- Проверить места рядом --------------------------------------------------------------

async def show_check_list(message: Message, state: FSMContext, lang: str, user_id: int, lat: float, lon: float):
    waiting = await db.places_to_verify(user_id, lat, lon)
    if not waiting:
        await state.clear()
        await message.answer(t(lang, "check_none"), reply_markup=menu_kb(lang))
        return
    await state.set_state(Flow.check)
    await state.update_data(waiting=waiting)
    await message.answer(t(lang, "check_title"), reply_markup=check_list_kb(waiting))


def check_list_kb(waiting: list[dict]):
    return kb([(f"{STATUS_EMOJI[p['status']]} {p['name']} · {p['dist_m']} m", f"chk:{i}")
               for i, p in enumerate(waiting)])


@router.callback_query(Flow.check, F.data.startswith("chk"))
async def check_action(cb: CallbackQuery, state: FSMContext, lang: str, user_id: int):
    action, _, index = cb.data.partition(":")
    waiting = (await state.get_data())["waiting"]
    if action == "chkback":
        await cb.answer()
        await cb.message.edit_text(t(lang, "check_title"), reply_markup=check_list_kb(waiting))
        return
    if not index.isdigit() or int(index) >= len(waiting):
        return await cb.answer()
    place = waiting[int(index)]

    if action == "chk":  # карточка: что написал предыдущий человек
        await cb.answer()
        await cb.message.edit_text(
            f"{place['name']}\n{report_summary(lang, place)}\n\n{t(lang, 'check_question')}",
            reply_markup=kb([(t(lang, "btn_confirm"), f"chkyes:{index}"),
                             (t(lang, "btn_fix"), f"chkno:{index}"),
                             (t(lang, "btn_gone"), f"chkgone:{index}"),
                             (t(lang, "btn_back"), "chkback")]),
        )
    elif action == "chkgone":
        await cb.answer()
        await cb.message.edit_reply_markup()
        await ask_gone(cb.message, state, lang, place)
    elif action == "chkyes":
        result = await db.confirm_report(user_id, place["report_id"])
        if not result:
            return await cb.answer(t(lang, "confirm_failed"), show_alert=True)
        await cb.answer()
        await state.clear()
        text = t(lang, "confirm_thanks", name=result["name"], points=db.POINTS_PER_CONFIRM)
        if result["is_verified"]:
            text += "\n" + t(lang, "confirm_verified")
        await cb.message.edit_text(text, reply_markup=menu_kb(lang))
        await notify_author(cb.bot, result)
    elif action == "chkno":  # не согласен — заполняет свой отчёт по этому месту
        await db.dispute_report(user_id, place["report_id"])
        await cb.answer()
        await cb.message.edit_text(t(lang, "place_selected", name=place["name"]))
        await state.update_data(place_id=place["id"])
        await ask_photos(cb.message, state, lang)
    else:
        await cb.answer()


async def notify_author(bot: Bot, result: dict):
    """Пишет автору отчёта, что его подтвердили. Автор мог заблокировать бота — тогда молча пропускаем."""
    author = result.get("author_tg_id")
    if not author:
        return
    lang = result.get("author_lang") or "ru"
    text = t(lang, "your_report_confirmed", name=result["name"])
    if result["is_verified"]:
        text += "\n" + t(lang, "confirm_verified")
    try:
        await bot.send_message(author, text)
    except Exception:
        log.info("Не удалось уведомить автора отчёта %s", author)


# --- Добавить место: существующее или новое -------------------------------------------

async def show_nearby_for_report(message: Message, state: FSMContext, lang: str, lat: float, lon: float):
    places = await db.nearby_places(lat, lon)
    if not places:
        await state.set_state(Flow.new_name)
        await message.answer(t(lang, "no_places_ask_name"), reply_markup=ReplyKeyboardRemove())
        return
    buttons = [(f"{p['name']} · {p['dist_m']} m", f"place:{p['id']}") for p in places]
    buttons.append((t(lang, "btn_search"), "place:search"))
    buttons.append((t(lang, "btn_new_place"), "place:new"))
    await state.set_state(Flow.place)
    await message.answer(t(lang, "choose_place"), reply_markup=kb(buttons))


@router.callback_query(Flow.place, F.data.startswith("place:"))
async def chose_place(cb: CallbackQuery, state: FSMContext, lang: str):
    value = cb.data.split(":")[1]
    await cb.answer()
    if value == "new":
        await state.set_state(Flow.new_name)
        await cb.message.edit_text(t(lang, "ask_name"))
        return
    if value == "search":  # нужного места нет среди ближайших — ищем по названию
        await state.clear()
        await state.set_state(Flow.search)
        await cb.message.edit_text(t(lang, "ask_search"))
        return
    await state.update_data(place_id=int(value))
    await cb.message.edit_reply_markup()
    await ask_photos(cb.message, state, lang)


@router.message(Flow.new_name, F.text)
async def got_name(message: Message, state: FSMContext, lang: str):
    name = message.text.strip()[:100]
    if len(name) < 2:
        return await message.answer(t(lang, "bad_name"))
    await state.update_data(new_name=name)
    await state.set_state(Flow.new_category)
    await message.answer(
        t(lang, "ask_category"),
        reply_markup=kb([(t(lang, f"cat_{c}"), f"cat:{c}") for c in CATEGORIES], width=2),
    )


@router.callback_query(Flow.new_category, F.data.startswith("cat:"))
async def chose_category(cb: CallbackQuery, state: FSMContext, lang: str):
    category = cb.data.split(":")[1]
    if category not in CATEGORIES:
        return await cb.answer()
    await state.update_data(new_category=category)
    await cb.message.edit_text(t(lang, f"cat_{category}"))
    await cb.answer()
    await ask_photos(cb.message, state, lang)


# --- Фото -------------------------------------------------------------------------------

async def ask_photos(message: Message, state: FSMContext, lang: str):
    await state.set_state(Flow.photos)
    await state.update_data(photos=[])
    # Фото желательны, но не обязательны: иначе тот, кто не может снять вход, застревает здесь
    await message.answer(t(lang, "ask_photos"), reply_markup=kb([(t(lang, "btn_no_photo"), "photos:done")]))


@router.message(Flow.photos, F.photo)
async def got_photo(message: Message, state: FSMContext, lang: str):
    data = await state.get_data()
    photos = data["photos"] + [message.photo[-1].file_id]  # [-1] — самый большой размер
    await state.update_data(photos=photos)
    if len(photos) >= MAX_PHOTOS:
        await start_questions(message, state, lang)
        return
    await message.answer(
        t(lang, "photo_saved", n=len(photos), max=MAX_PHOTOS),
        reply_markup=kb([(t(lang, "btn_done"), "photos:done")]),
    )


@router.callback_query(Flow.photos, F.data == "photos:done")
async def photos_done(cb: CallbackQuery, state: FSMContext, lang: str):
    await cb.answer()
    await cb.message.edit_reply_markup()
    await start_questions(cb.message, state, lang)


@router.message(Flow.photos)
async def need_photo(message: Message, lang: str):
    await message.answer(t(lang, "need_photo"))


# --- Вопросы кнопками -------------------------------------------------------------------

async def start_questions(message: Message, state: FSMContext, lang: str):
    await state.set_state(Flow.questions)
    await state.update_data(answers={})
    await ask_question(message, lang, next_question({}))


async def ask_question(message: Message, lang: str, key: str):
    buttons = [(t(lang, f"opt_{value}"), f"q:{key}:{value}") for value in QUESTIONS[key]]
    await message.answer(t(lang, f"q_{key}"), reply_markup=kb(buttons, width=2))


@router.callback_query(Flow.questions, F.data.startswith("q:"))
async def got_answer(cb: CallbackQuery, state: FSMContext, lang: str, user_id: int):
    _, key, value = cb.data.split(":")
    answers = (await state.get_data())["answers"]
    if key != next_question(answers) or value not in QUESTIONS[key]:
        return await cb.answer()  # нажали кнопку старого вопроса
    answers[key] = value
    await state.update_data(answers=answers)
    await cb.message.edit_text(f"{t(lang, f'q_{key}')}\n— {t(lang, f'opt_{value}')}")
    await cb.answer()

    if key == "ramp" and value in ("good", "bad"):
        await ask_slope(cb.message, state, lang)
    else:
        await continue_report(cb.message, state, lang, user_id)


async def continue_report(message: Message, state: FSMContext, lang: str, user_id: int):
    """Следующий вопрос, а если вопросы кончились — сохранение отчёта."""
    data = await state.get_data()
    answers = data["answers"]
    key = next_question(answers)
    if key:
        await state.set_state(Flow.questions)
        await ask_question(message, lang, key)
        return

    if "comment" not in answers:  # последний шаг — необязательная заметка
        await state.set_state(Flow.comment)
        await message.answer(t(lang, "ask_comment"),
                             reply_markup=kb([(t(lang, "btn_no_comment"), "comment:skip")]))
        return

    status = report_status(answers)
    new_place = (data["new_name"], data["new_category"]) if "place_id" not in data else None
    await db.save_report(
        user_id=user_id, lat=data.get("lat"), lon=data.get("lon"), answers=answers, status=status,
        photos=data["photos"], place_id=data.get("place_id"), new_place=new_place,
    )
    await state.clear()
    await message.answer(
        t(lang, "thanks", status=t(lang, f"status_{status}"), points=db.POINTS_PER_REPORT),
        reply_markup=menu_kb(lang),
    )


# --- Заметка к отчёту -------------------------------------------------------------------
# Одна строка о том, чего не передать кнопками: «вход со двора», «пандус за углом».

async def save_comment(message: Message, state: FSMContext, lang: str, user_id: int, comment: str):
    answers = (await state.get_data())["answers"]
    answers["comment"] = comment
    await state.update_data(answers=answers)
    await continue_report(message, state, lang, user_id)


@router.callback_query(Flow.comment, F.data == "comment:skip")
async def comment_skipped(cb: CallbackQuery, state: FSMContext, lang: str, user_id: int):
    await cb.answer()
    await cb.message.edit_reply_markup()
    await save_comment(cb.message, state, lang, user_id, "")


@router.message(Flow.comment, F.text)
async def got_comment(message: Message, state: FSMContext, lang: str, user_id: int):
    await save_comment(message, state, lang, user_id, " ".join(message.text.split())[:200])


@router.message(Flow.comment)
async def need_comment(message: Message, lang: str):
    await message.answer(t(lang, "comment_hint"))


# --- Замер уклона пандуса телефоном -----------------------------------------------------
# Кнопка открывает страницу измерителя с сайта внутри Telegram (мини-приложение).
# Страница возвращает результат через Telegram.WebApp.sendData — он приходит как web_app_data.

async def ask_slope(message: Message, state: FSMContext, lang: str):
    await state.set_state(Flow.slope)
    await message.answer(
        t(lang, "ask_slope"),
        reply_markup=ReplyKeyboardMarkup(
            keyboard=[
                [KeyboardButton(text=t(lang, "btn_measure"),
                                web_app=WebAppInfo(url=f"{site_url()}/?tg=1&lang={lang}#/slope"))],
                [KeyboardButton(text=t(lang, "btn_skip_slope"))],
            ],
            resize_keyboard=True,
        ),
    )


@router.message(Flow.slope, F.web_app_data)
async def got_slope(message: Message, state: FSMContext, lang: str, user_id: int):
    try:
        pct = round(float(json.loads(message.web_app_data.data)["slope_pct"]), 1)
    except (ValueError, TypeError, KeyError):
        pct = math.nan
    if not 0 <= pct <= 60:  # nan сюда тоже попадает
        return await message.answer(t(lang, "slope_hint"))
    answers = (await state.get_data())["answers"]
    answers["ramp_slope_pct"] = pct
    await state.update_data(answers=answers)
    await message.answer(t(lang, "slope_saved", pct=pct), reply_markup=ReplyKeyboardRemove())
    await continue_report(message, state, lang, user_id)


@router.message(Flow.slope)
async def slope_skipped_or_other(message: Message, state: FSMContext, lang: str, user_id: int):
    if message.text != t(lang, "btn_skip_slope"):
        return await message.answer(t(lang, "slope_hint"))
    await message.answer(t(lang, "slope_skipped"), reply_markup=ReplyKeyboardRemove())
    await continue_report(message, state, lang, user_id)


# --- Всё, что не подошло ни под один шаг ----------------------------------------------
# Например, кнопка из давно законченного диалога. Без этих двух хендлеров бот бы молчал.

@router.message()
async def unexpected_message(message: Message, state: FSMContext, lang: str):
    if await state.get_state() is not None:
        return await message.answer(t(lang, "use_buttons"))
    await message.answer(t(lang, "menu"), reply_markup=menu_kb(lang))


@router.callback_query()
async def stale_button(cb: CallbackQuery, lang: str):
    await cb.answer(t(lang, "stale_button"), show_alert=True)


async def set_commands(bot: Bot):
    """Меню команд рядом с полем ввода — на языке интерфейса Telegram."""
    for lang in (None, "kk", "en"):
        await bot.set_my_commands(
            [BotCommand(command=c, description=t(lang or "ru", f"cmd_{c}")) for c in COMMANDS],
            language_code=lang,
        )


async def main():
    load_dotenv()
    logging.basicConfig(level=logging.INFO)
    await db.connect(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    bot = Bot(os.environ["BOT_TOKEN"])
    # Шаг диалога дублируется в базу, чтобы пережить «сон» бесплатного хостинга (см. storage.py)
    storage = SupabaseStorage()
    dp = Dispatcher(storage=storage, events_isolation=SimpleEventIsolation())
    dp.update.outer_middleware(FlushStateMiddleware(storage))
    dp.update.outer_middleware(UserMiddleware())
    dp.include_router(router)
    await set_commands(bot)

    # На хостинге Telegram сам присылает сообщения на наш адрес (webhook).
    # Render подставляет RENDER_EXTERNAL_URL автоматически.
    base_url = os.getenv("WEBHOOK_URL") or os.getenv("RENDER_EXTERNAL_URL")
    try:
        if base_url:
            await run_webhook(bot, dp, base_url)
        else:
            # На своём компьютере бот сам опрашивает Telegram. Внимание: это отключает webhook,
            # поэтому для локальных опытов при работающем хостинге заведи второго, тестового бота.
            await bot.delete_webhook()
            await dp.start_polling(bot)
    finally:
        await db.close()


async def run_webhook(bot: Bot, dp: Dispatcher, base_url: str):
    # Секрет, по которому мы отличаем запросы Telegram от чужих
    secret = hashlib.sha256(bot.token.encode()).hexdigest()
    app = web.Application()
    app.router.add_get("/", lambda _: web.Response(text="Jol bot is running"))
    SimpleRequestHandler(dp, bot, secret_token=secret).register(app, path=WEBHOOK_PATH)
    setup_application(app, dp, bot=bot)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", int(os.getenv("PORT", "8080"))).start()
    await bot.set_webhook(
        base_url.rstrip("/") + WEBHOOK_PATH,
        secret_token=secret,
        allowed_updates=dp.resolve_used_update_types(),
    )
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())

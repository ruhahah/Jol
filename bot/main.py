import asyncio
import hashlib
import logging
import os

from aiogram import BaseMiddleware, Bot, Dispatcher, F, Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage, SimpleEventIsolation
from aiogram.types import (CallbackQuery, KeyboardButton, Message,
                           ReplyKeyboardMarkup, ReplyKeyboardRemove)
from aiogram.utils.keyboard import InlineKeyboardBuilder
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application
from aiohttp import web
from dotenv import load_dotenv

import db
from scoring import report_status
from texts import CATEGORIES, CHOOSE_LANG, LANGS, t

MAX_PHOTOS = 3
WEBHOOK_PATH = "/webhook"

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
    location = State()
    place = State()
    new_name = State()
    new_category = State()
    photos = State()
    questions = State()


class UserMiddleware(BaseMiddleware):
    """Создаёт пользователя при первом сообщении и передаёт в хендлеры user_id и lang."""

    async def __call__(self, handler, event, data):
        tg_user = data.get("event_from_user")
        if tg_user:
            row = await db.touch_user(tg_user.id, tg_user.username)
            data["user_id"], data["lang"] = row["id"], row["lang"]
        return await handler(event, data)


def kb(buttons: list[tuple[str, str]], width: int = 1):
    builder = InlineKeyboardBuilder()
    for text, callback_data in buttons:
        builder.button(text=text, callback_data=callback_data)
    return builder.adjust(width).as_markup()


def next_question(answers: dict) -> str | None:
    for key in QUESTIONS:
        if key in answers:
            continue
        if key == "ramp" and answers.get("steps") == "none":
            continue  # ступенек нет — про пандус не спрашиваем
        return key
    return None


# --- /start, язык, служебные команды -------------------------------------------------

@router.message(CommandStart())
async def cmd_start(message: Message, state: FSMContext, command: CommandObject):
    await state.clear()
    # Кнопка «Обновить в Telegram» на сайте ведёт на t.me/<бот>?start=place_12
    args = command.args or ""
    if args.startswith("place_") and args[6:].isdigit() and len(args) <= 18:
        await state.update_data(pending_place=int(args[6:]))
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
    place = await db.get_place(data["pending_place"]) if "pending_place" in data else None
    if place:  # пришли с сайта к конкретному месту — геолокация не нужна
        await state.update_data(place_id=place["id"])
        await cb.message.answer(t(lang, "place_selected", name=place["name"]))
        await ask_photos(cb.message, state, lang)
    else:
        await ask_location(cb.message, state, lang)


@router.message(Command("add"))
async def cmd_add(message: Message, state: FSMContext, lang: str):
    await state.clear()
    await ask_location(message, state, lang)


@router.message(Command("cancel"))
async def cmd_cancel(message: Message, state: FSMContext, lang: str):
    await state.clear()
    await message.answer(t(lang, "cancelled"), reply_markup=ReplyKeyboardRemove())


# --- Шаг 1: геолокация ---------------------------------------------------------------

async def ask_location(message: Message, state: FSMContext, lang: str):
    await state.set_state(Flow.location)
    await message.answer(
        t(lang, "ask_location"),
        reply_markup=ReplyKeyboardMarkup(
            keyboard=[[KeyboardButton(text=t(lang, "btn_location"), request_location=True)]],
            resize_keyboard=True,
            one_time_keyboard=True,
        ),
    )


@router.message(Flow.location, F.location)
async def got_location(message: Message, state: FSMContext, lang: str):
    lat, lon = message.location.latitude, message.location.longitude
    await state.update_data(lat=lat, lon=lon)
    places = await db.nearby_places(lat, lon)
    if not places:
        await state.set_state(Flow.new_name)
        await message.answer(t(lang, "no_places_ask_name"), reply_markup=ReplyKeyboardRemove())
        return
    buttons = [(f"{p['name']} · {p['dist_m']} m", f"place:{p['id']}") for p in places]
    buttons.append((t(lang, "btn_new_place"), "place:new"))
    await state.set_state(Flow.place)
    await message.answer(t(lang, "choose_place"), reply_markup=kb(buttons))


@router.message(Flow.location)
async def need_location(message: Message, lang: str):
    await message.answer(t(lang, "need_location"))


# --- Шаг 2: существующее место или новое ---------------------------------------------

@router.callback_query(Flow.place, F.data.startswith("place:"))
async def chose_place(cb: CallbackQuery, state: FSMContext, lang: str):
    value = cb.data.split(":")[1]
    await cb.answer()
    if value == "new":
        await state.set_state(Flow.new_name)
        await cb.message.edit_text(t(lang, "ask_name"))
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


# --- Шаг 3: фото ---------------------------------------------------------------------

async def ask_photos(message: Message, state: FSMContext, lang: str):
    await state.set_state(Flow.photos)
    await state.update_data(photos=[])
    await message.answer(t(lang, "ask_photos"), reply_markup=ReplyKeyboardRemove())


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


# --- Шаг 4: вопросы кнопками ---------------------------------------------------------

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
    data = await state.get_data()
    answers = data["answers"]
    if key != next_question(answers) or value not in QUESTIONS[key]:
        return await cb.answer()  # нажали кнопку старого вопроса
    answers[key] = value
    await state.update_data(answers=answers)
    await cb.message.edit_text(f"{t(lang, f'q_{key}')}\n— {t(lang, f'opt_{value}')}")
    await cb.answer()

    key = next_question(answers)
    if key:
        await ask_question(cb.message, lang, key)
        return

    # --- Шаг 5: сохранение ---
    status = report_status(answers)
    new_place = (data["new_name"], data["new_category"]) if "place_id" not in data else None
    await db.save_report(
        user_id=user_id, lat=data.get("lat"), lon=data.get("lon"), answers=answers, status=status,
        photos=data["photos"], place_id=data.get("place_id"), new_place=new_place,
    )
    await state.clear()
    await cb.message.answer(
        t(lang, "thanks", status=t(lang, f"status_{status}"), points=db.POINTS_PER_REPORT)
    )


async def main():
    load_dotenv()
    logging.basicConfig(level=logging.INFO)
    await db.connect(os.environ["DATABASE_URL"])
    bot = Bot(os.environ["BOT_TOKEN"])
    # MemoryStorage: состояние диалога теряется при перезапуске бота — для MVP-0 это нормально.
    dp = Dispatcher(storage=MemoryStorage(), events_isolation=SimpleEventIsolation())
    dp.update.outer_middleware(UserMiddleware())
    dp.include_router(router)

    # На хостинге Telegram сам присылает сообщения на наш адрес (webhook).
    # Render подставляет RENDER_EXTERNAL_URL автоматически.
    base_url = os.getenv("WEBHOOK_URL") or os.getenv("RENDER_EXTERNAL_URL")
    if base_url:
        await run_webhook(bot, dp, base_url)
    else:
        # На своём компьютере бот сам опрашивает Telegram. Внимание: это отключает webhook,
        # поэтому для локальных опытов при работающем хостинге заведи второго, тестового бота.
        await bot.delete_webhook()
        await dp.start_polling(bot)


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

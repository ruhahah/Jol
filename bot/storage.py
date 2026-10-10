"""Хранилище шага диалога, которое переживает перезапуск бота.

Бесплатный хостинг усыпляет бота через 15 минут без сообщений, и всё, что лежало в памяти,
пропадает: человек отвечал на вопросы, отвлёкся — и бот «забыл», где они остановились.
Здесь шаг и собранные ответы дублируются в таблицу bot_state.

Чтобы не ходить в базу на каждое мелкое изменение, изменения копятся в памяти и
записываются один раз после обработки сообщения (см. FlushStateMiddleware)."""
import logging
from datetime import datetime, timedelta, timezone

from aiogram import BaseMiddleware
from aiogram.fsm.state import State
from aiogram.fsm.storage.base import BaseStorage, StorageKey

import db

log = logging.getLogger(__name__)

# Незаконченный диалог старше этого срока не продолжаем: человек давно ушёл от того входа
MAX_AGE = timedelta(hours=6)


class SupabaseStorage(BaseStorage):
    def __init__(self) -> None:
        self._cache: dict[str, dict] = {}
        self._dirty: set[str] = set()

    async def _entry(self, key: StorageKey) -> dict:
        k = f"{key.chat_id}:{key.user_id}"
        if k not in self._cache:
            entry = {"state": None, "data": {}}
            try:
                row = await db.load_state(k)
                if row and datetime.now(timezone.utc) - datetime.fromisoformat(row["updated_at"]) < MAX_AGE:
                    entry = {"state": row["state"], "data": row["data"] or {}}
            except Exception:  # база недоступна — работаем только в памяти, как раньше
                log.warning("Не удалось прочитать шаг диалога %s", k, exc_info=True)
            self._cache[k] = entry
        return self._cache[k]

    async def set_state(self, key: StorageKey, state: State | str | None = None) -> None:
        entry = await self._entry(key)
        entry["state"] = state.state if isinstance(state, State) else state
        self._dirty.add(f"{key.chat_id}:{key.user_id}")

    async def get_state(self, key: StorageKey) -> str | None:
        return (await self._entry(key))["state"]

    async def set_data(self, key: StorageKey, data: dict) -> None:
        entry = await self._entry(key)
        entry["data"] = dict(data)
        self._dirty.add(f"{key.chat_id}:{key.user_id}")

    async def get_data(self, key: StorageKey) -> dict:
        return dict((await self._entry(key))["data"])

    async def flush(self) -> None:
        """Записывает в базу всё, что изменилось с прошлого раза."""
        dirty, self._dirty = self._dirty, set()
        for k in dirty:
            entry = self._cache[k]
            try:
                if entry["state"] is None and not entry["data"]:
                    await db.delete_state(k)
                else:
                    await db.save_state(k, entry["state"], entry["data"])
            except Exception:
                log.warning("Не удалось сохранить шаг диалога %s", k, exc_info=True)

    async def close(self) -> None:
        await self.flush()


class FlushStateMiddleware(BaseMiddleware):
    """После каждого обработанного сообщения сохраняет изменившийся шаг диалога."""

    def __init__(self, storage: SupabaseStorage) -> None:
        self.storage = storage

    async def __call__(self, handler, event, data):
        try:
            return await handler(event, data)
        finally:
            await self.storage.flush()

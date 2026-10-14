"""Проверка SQL проекта (db/*.sql) на встроенном Postgres — без доступа к Supabase.

Запуск из корня проекта:
    pip install pgserver asyncpg
    python tests/test_sql.py

PostGIS во встроенном Postgres нет, поэтому несколько его функций подменены простыми
заглушками (координаты хранятся строкой «долгота широта», расстояние считается по
приближённой формуле). Этого хватает, чтобы проверить, что все файлы применяются без
ошибок, права доступа выставлены верно и логика функций работает. Настоящий PostGIS
проверяется уже на Supabase.
"""
import asyncio
import json
import pathlib
import sys
import tempfile

import asyncpg
import pgserver

ROOT = pathlib.Path(__file__).resolve().parent.parent

POSTGIS_STUBS = """
create schema if not exists extensions;
create domain extensions.geography as text;
create domain extensions.geometry as text;
create function extensions.st_makepoint(x float8, y float8) returns text
    language sql immutable as $$ select x || ' ' || y $$;
create function extensions.st_setsrid(g text, srid int) returns text language sql immutable as $$ select g $$;
create function extensions.st_x(g extensions.geometry) returns float8
    language sql immutable as $$ select split_part(g, ' ', 1)::float8 $$;
create function extensions.st_y(g extensions.geometry) returns float8
    language sql immutable as $$ select split_part(g, ' ', 2)::float8 $$;
create function extensions.st_distance(a extensions.geography, b extensions.geography) returns float8
    language sql immutable as $$
    select sqrt(power((split_part(b, ' ', 1)::float8 - split_part(a, ' ', 1)::float8) * 111320
                      * cos(radians(split_part(a, ' ', 2)::float8)), 2)
              + power((split_part(b, ' ', 2)::float8 - split_part(a, ' ', 2)::float8) * 110574, 2)) $$;
create function extensions.st_dwithin(a extensions.geography, b extensions.geography, d float8) returns boolean
    language sql immutable as $$ select extensions.st_distance(a, b) <= d $$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public, extensions to anon, authenticated, service_role;
-- Как в Supabase: новые таблицы по умолчанию доступны всем ролям, а закрывает их RLS
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
"""

checks = 0


def check(condition, label):
    global checks
    checks += 1
    print(("OK   " if condition else "FAIL ") + label)
    if not condition:
        raise SystemExit(1)


async def run(uri: str):
    con = await asyncpg.connect(uri)
    await con.execute(POSTGIS_STUBS)
    await con.execute("set search_path = public, extensions")
    schema = (ROOT / "db" / "schema.sql").read_text(encoding="utf-8")
    schema = schema.replace("create extension if not exists postgis with schema extensions;", "")
    schema = schema.replace("geography(Point, 4326)", "extensions.geography")
    schema = schema.replace("using gist (geom)", "(geom)")  # у заглушки нет пространственного индекса
    await con.execute(schema)
    for name in ("bot_api.sql", "public_api.sql", "bot_api.sql", "public_api.sql"):  # дважды: повторный запуск безопасен
        await con.execute((ROOT / "db" / name).read_text(encoding="utf-8"))
    check(True, "schema.sql, bot_api.sql и public_api.sql применяются, повторно тоже")

    closed = await con.fetchval(
        """select bool_and(has_function_privilege('service_role', p.oid, 'execute')
                           and not has_function_privilege('anon', p.oid, 'execute'))
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'bot\\_%' or p.proname = 'recalc_place')""")
    check(closed, "функции бота доступны только сервисному ключу")

    j = lambda v: json.loads(v) if v is not None else None
    sql = lambda q, *a: con.fetchval(q, *a)
    await con.execute("set role service_role")

    users = [j(await sql("select bot_touch_user($1, 'user')", tg))["id"] for tg in (1, 2, 3, 4)]
    a, b, c, admin = users
    save = ("select bot_save_report(p_user_id => $1, p_answers => $2::jsonb, p_status => $3::access_status, "
            "p_photos => $4, p_place_id => $5, p_new_name => $6, p_new_category => 'pharmacy', "
            "p_lat => 42.3417, p_lon => 69.5901)")
    answers = {"steps": "one", "ramp": "good", "door_wide": "yes", "ramp_slope_pct": 6.4,
               "extras": ["parking", "tactile", "parking", "rocket"], "comment": "  вход   со двора  "}
    pid = await sql(save, a, json.dumps(answers), "accessible", ["f1"], None, "Аптека 100%")
    row = await con.fetchrow("select extras, comment, ramp_slope_pct from reports where place_id = $1", pid)
    check(row["extras"] == ["parking", "tactile"] and row["comment"] == "вход со двора" and float(row["ramp_slope_pct"]) == 6.4,
          "отчёт: допустимые extras без повторов, заметка без лишних пробелов, уклон")
    no_slope = await sql(save, b, json.dumps({"steps": "many", "ramp": "none", "door_wide": "yes"}),
                         "inaccessible", [], None, "Кафе рядом")
    check(await sql("select ramp_slope_pct from reports where place_id = $1", no_slope) is None,
          "«не мерили» остаётся пустым, а не 0")

    found = j(await sql("select bot_search('аптека 100%')"))
    check([p["id"] for p in found] == [pid] and j(await sql("select bot_search('аптека_100')")) == [],
          "поиск по названию, % и _ ищутся как обычные символы")
    near = j(await sql("select bot_nearby_places(42.3419, 69.5905)"))
    check({p["id"] for p in near} == {pid, no_slope}, "места в радиусе 200 м")
    accessible = j(await sql("select bot_find_accessible(42.3419, 69.5905)"))
    check([p["id"] for p in accessible] == [pid], "поиск доступных мест не показывает недоступные")

    waiting = j(await sql("select bot_places_to_verify($1, 42.3419, 69.5905)", c))
    check({p["id"] for p in waiting} == {pid, no_slope} and waiting[0]["extras"] is not None,
          "места, ждущие проверки, с ответами последнего отчёта")
    report_id = next(p["report_id"] for p in waiting if p["id"] == pid)
    check(await sql("select bot_confirm_report($1, $2)", a, report_id) is None, "свой отчёт подтвердить нельзя")
    confirmed = j(await sql("select bot_confirm_report($1, $2)", c, report_id))
    check(confirmed["is_verified"] and confirmed["author_tg_id"] == 1, "подтверждение делает место проверенным и называет автора")
    check(await sql("select extras from reports where user_id = $1 and place_id = $2", c, pid) == ["parking", "tactile"],
          "копия отчёта при подтверждении сохраняет extras")

    # «Устаревшее» место: проверено больше полугода назад — снова попадает в список на проверку
    await con.execute("reset role")
    await con.execute("update reports set created_at = now() - interval '200 days' where place_id = $1", pid)
    await con.execute("select recalc_place($1)", pid)
    await con.execute("set role service_role")
    check(await sql("select is_verified from places where id = $1", pid) is True, "отчёты моложе года ещё считаются")
    stale =[p for p in j(await sql("select bot_places_to_verify($1, 42.3419, 69.5905)", admin)) if p["id"] == pid]
    check(len(stale) == 1 and stale[0]["stale"] is True, "проверенное больше полугода назад место снова ждёт проверки")

    me = j(await sql("select bot_me($1)", a))
    check(me["reports"] == 1 and me["slopes"] == 1 and me["confirms"] == 0, "профиль: отчёты и замеры уклона")
    await sql("select bot_set_name($1, '  Айгерим   Р. ')", a)
    check(await sql("select display_name from users where id = $1", a) == "Айгерим Р.", "имя для рейтинга")

    # Модерация
    recent = j(await sql("select bot_admin_recent(5)"))
    check(recent["notes"][0]["comment"] == "вход со двора" and recent["names"][0]["display_name"] == "Айгерим Р.",
          "модерация: последние заметки и имена")
    await con.execute("set role anon")
    check(await sql("select comment from places_public where id = $1", pid) == "вход со двора", "сайт видит заметку")
    await con.execute("set role service_role")
    check(await sql("select bot_admin_hide_note($1)", recent["notes"][0]["report_id"]) is True, "заметку можно скрыть")
    await con.execute("set role anon")
    check(await sql("select comment from places_public where id = $1", pid) is None, "скрытую заметку сайт не видит")
    check(await sql("select count(*) from leaderboard_public where id = $1", a) == 1, "автор в рейтинге")
    await con.execute("set role service_role")
    check(await sql("select bot_admin_ban($1)", a) is True, "блокировка пользователя")
    check(j(await sql("select bot_touch_user(1, 'user')"))["banned"] is True, "бот узнаёт о блокировке")
    try:
        await sql(save, a, json.dumps({"steps": "none"}), "accessible", [], None, "Спам")
        check(False, "заблокированный не может добавить отчёт")
    except asyncpg.RaiseError:
        check(await sql("select count(*) from places where name = 'Спам'") == 0,
              "заблокированный не может добавить отчёт (и место не создаётся)")
    check(await sql("select bot_confirm_report($1, $2)", a, report_id) is None, "заблокированный не может подтверждать")
    await sql("select bot_set_name($1, 'Новое имя')", a)
    check(await sql("select display_name from users where id = $1", a) is None, "имя заблокированного сброшено и не меняется")
    await con.execute("set role anon")
    check(await sql("select count(*) from leaderboard_public where id = $1", a) == 0, "заблокированного нет в рейтинге")
    await con.execute("set role service_role")
    await sql("select bot_admin_ban($1, false)", a)
    check(j(await sql("select bot_touch_user(1, 'user')"))["banned"] is False, "разблокировка")

    # «Места больше нет» и возврат модератором
    await sql("select bot_flag_gone($1, $2)", b, pid)
    gone = j(await sql("select bot_flag_gone($1, $2)", c, pid))
    check(gone["hidden"] and await sql("select bot_get_place($1)", pid) is None, "после двух сигналов место скрыто")
    await con.execute("set role anon")
    check(await sql("select count(*) from places_public where id = $1", pid) == 0, "скрытого места нет на сайте")
    await con.execute("set role service_role")
    check(await sql("select bot_admin_unhide_place($1)", pid) is True and
          await sql("select bot_get_place($1)", pid) is not None, "модератор возвращает место")
    check(await sql("select count(*) from place_flags where place_id = $1", pid) == 0, "сигналы при этом сбрасываются")

    # Акции
    cid = await sql("select bot_admin_create_campaign('Аптеки центра', 'pharmacy', 42.3417, 69.5901, 1000, 5, 7)")
    await sql(save, b, json.dumps({"steps": "none", "door_wide": "yes"}), "accessible", [], None, "Аптека в зоне акции")
    await con.execute("set role anon")
    camp = dict(await con.fetchrow("select * from campaigns_public where id = $1", cid))
    # в зоне три аптеки (все места в этом тесте создаются аптеками), отчёт за время акции — у одной
    check(camp["done"] == 1 and camp["places_in_area"] == 3 and camp["goal"] == 5,
          f"акция: прогресс считается по отчётам за время акции (done={camp['done']}, мест={camp['places_in_area']})")
    await con.execute("set role service_role")
    check(await sql("select bot_admin_end_campaign($1)", cid) is True, "акцию можно завершить досрочно")

    await con.execute("set role anon")
    for table in ("users", "reports", "photos", "verifications", "bot_state", "campaigns", "place_flags"):
        try:
            rows = await con.fetch(f"select * from {table}")
            check(rows == [], f"{table}: публичный ключ не видит строк (закрывает RLS)")
        except asyncpg.InsufficientPrivilegeError:
            check(True, f"{table}: публичному ключу доступ запрещён")
    summary = dict(await con.fetchrow("select * from places_summary_public"))
    check(summary["total"] == 3, "сводка для главной")
    history = await con.fetch("select * from place_history_public where place_id = $1", pid)
    check(len(history) == 2 and set(history[0].keys()) == {"place_id", "created_at", "status", "ramp_slope_pct"},
          "история проверок без авторов")
    await con.close()
    print(f"SQL OK — проверок: {checks}")


def main():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        server = pgserver.get_server(tmp)
        try:
            asyncio.run(run(server.get_uri()))
        finally:
            server.cleanup()


if __name__ == "__main__":
    sys.exit(main())

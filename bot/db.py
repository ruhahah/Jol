import asyncpg

POINTS_PER_REPORT = 10
SEARCH_RADIUS_M = 200

pool: asyncpg.Pool | None = None

NEARBY_PLACES = """
select p.id, p.name, p.category, p.status,
       round(st_distance(p.geom, pt.g))::int as dist_m
from places p,
     (select st_setsrid(st_makepoint($1, $2), 4326)::geography as g) pt
where st_dwithin(p.geom, pt.g, $3)
order by dist_m
limit 8
"""

INSERT_PLACE = """
insert into places (name, category, geom, created_by)
values ($1, $2, st_setsrid(st_makepoint($3, $4), 4326)::geography, $5)
returning id
"""

INSERT_REPORT = """
insert into reports (place_id, user_id, steps, ramp, door_wide, call_button, toilet, status)
values ($1, $2, $3, $4, $5, $6, $7, $8)
returning id
"""

# Берём последний отчёт каждого пользователя за 12 месяцев (без «не знаю»).
# Статус места = самый частый; при равенстве — более строгий.
# «Проверено» = за этот статус высказались минимум 2 разных человека.
RECALC_PLACE = """
with latest as (
    select distinct on (user_id) user_id, status, created_at
    from reports
    where place_id = $1
      and status <> 'unknown'
      and created_at > now() - interval '12 months'
    order by user_id, created_at desc
), top as (
    select status, count(*) as votes
    from latest
    group by status
    order by votes desc, status desc
    limit 1
)
update places set
    status          = coalesce((select status from top), 'unknown'),
    score           = (select round(avg(case status when 'accessible' then 100
                                                    when 'partial' then 50
                                                    else 0 end)) from latest),
    reports_count   = (select count(*) from latest),
    is_verified     = coalesce((select votes from top), 0) >= 2,
    last_checked_at = (select max(created_at) from latest)
where id = $1
"""


async def connect(dsn: str) -> None:
    global pool
    # statement_cache_size=0 нужен для пулера Supabase в режиме transaction (порт 6543)
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5, statement_cache_size=0)


async def touch_user(tg_id: int, username: str | None) -> asyncpg.Record:
    return await pool.fetchrow(
        """insert into users (tg_id, username) values ($1, $2)
           on conflict (tg_id) do update set username = excluded.username
           returning id, lang""",
        tg_id, username,
    )


async def set_lang(user_id: int, lang: str) -> None:
    await pool.execute("update users set lang = $2 where id = $1", user_id, lang)


async def get_place(place_id: int) -> asyncpg.Record | None:
    return await pool.fetchrow("select id, name from places where id = $1", place_id)


async def nearby_places(lat: float, lon: float) -> list[asyncpg.Record]:
    # PostGIS ждёт порядок (долгота, широта)
    return await pool.fetch(NEARBY_PLACES, lon, lat, float(SEARCH_RADIUS_M))


async def save_report(*, user_id: int, lat: float | None, lon: float | None, answers: dict, status: str,
                      photos: list[str], place_id: int | None = None,
                      new_place: tuple[str, str] | None = None) -> int:
    """Одна транзакция: (новое место) → отчёт → фото → пересчёт места → очки."""
    async with pool.acquire() as con:
        async with con.transaction():
            if place_id is None:
                name, category = new_place
                place_id = await con.fetchval(INSERT_PLACE, name, category, lon, lat, user_id)
            report_id = await con.fetchval(
                INSERT_REPORT, place_id, user_id,
                answers["steps"], answers.get("ramp", "unknown"), answers["door_wide"],
                answers["call_button"], answers["toilet"], status,
            )
            await con.executemany(
                "insert into photos (report_id, tg_file_id) values ($1, $2)",
                [(report_id, file_id) for file_id in photos],
            )
            await con.execute(RECALC_PLACE, place_id)
            await con.execute(
                "update users set points = points + $2 where id = $1", user_id, POINTS_PER_REPORT
            )
    return place_id

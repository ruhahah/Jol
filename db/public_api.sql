-- Jol: публичное чтение для сайта. Выполнить в Supabase SQL Editor после schema.sql.
-- Повторный запуск безопасен.
--
-- Сайт читает только это представление по anon-ключу. Таблицы users, reports и photos
-- остаются закрытыми: наружу не попадают ни Telegram ID, ни фото, ни авторы отчётов.

create or replace view places_public as
select
    p.id,
    p.name,
    p.category,
    st_y(p.geom::geometry) as lat,
    st_x(p.geom::geometry) as lon,
    p.status,
    p.score,
    p.reports_count,
    p.is_verified,
    p.last_checked_at,
    -- ответы самого свежего отчёта; null, если у входа ещё никто не был
    r.steps,
    r.ramp,
    r.door_wide,
    r.call_button,
    r.toilet,
    r.ramp_slope_pct
from places p
left join lateral (
    select steps, ramp, door_wide, call_button, toilet, ramp_slope_pct
    from reports
    where place_id = p.id and status <> 'unknown'
    order by created_at desc
    limit 1
) r on true;

-- Представление выполняется с правами владельца, поэтому RLS на таблицах его не блокирует,
-- а anon видит ровно те столбцы, что перечислены выше.
grant select on places_public to anon;

-- Сводка для главной страницы: одна строка с числами вместо загрузки всего списка мест.
create or replace view places_summary_public as
select
    count(*)                                          as total,
    count(*) filter (where status = 'accessible')     as accessible,
    count(*) filter (where status = 'partial')        as partial,
    count(*) filter (where status = 'inaccessible')   as inaccessible,
    count(*) filter (where status = 'unknown')        as unknown,
    count(*) filter (where is_verified)               as verified,
    coalesce(sum(reports_count), 0)                   as reports
from places;

grant select on places_summary_public to anon;

-- Рейтинг волонтёров для сайта: только придуманное имя, очки и число отчётов.
-- Ни Telegram ID, ни Telegram-имя сюда не попадают. Требует db/bot_api.sql (столбец display_name).
create or replace view leaderboard_public as
select
    u.id,
    u.display_name as name,
    u.points,
    (select count(*) from reports r where r.user_id = u.id) as reports_count
from users u
where u.points > 0
order by u.points desc, u.id
limit 20;

grant select on leaderboard_public to anon;

-- Jol: публичное чтение для сайта. Выполнить в Supabase SQL Editor после schema.sql.
-- ВНИМАНИЕ: файл написан, но ещё не запускался на настоящей базе с PostGIS.
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

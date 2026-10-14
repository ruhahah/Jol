-- Jol: публичное чтение для сайта. Выполнить в Supabase SQL Editor после schema.sql
-- и bot_api.sql (он добавляет столбцы, на которые ссылаются представления ниже).
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
    r.ramp_slope_pct,
    -- самая свежая заметка волонтёра об этом входе (например, «вход со двора»);
    -- скрытые модератором и заметки заблокированных пользователей не показываем
    (select rc.comment from reports rc join users u on u.id = rc.user_id
     where rc.place_id = p.id and rc.comment is not null and not rc.comment_hidden and not u.banned
     order by rc.created_at desc limit 1) as comment,
    r.extras
from places p
left join lateral (
    select steps, ramp, door_wide, call_button, toilet, ramp_slope_pct, extras
    from reports
    where place_id = p.id and status <> 'unknown'
    order by created_at desc
    limit 1
) r on true
-- места, которых больше нет (см. bot_flag_gone в bot_api.sql), на сайте не показываем
where not p.hidden;

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
from places
where not hidden;

grant select on places_summary_public to anon;

-- История проверок места для карточки на сайте: только дата, оценка и измеренный уклон.
-- Кто именно проверял, наружу не отдаётся.
create or replace view place_history_public as
select place_id, created_at, status, ramp_slope_pct
from reports
where status <> 'unknown';

grant select on place_history_public to anon;

-- Рейтинг волонтёров для сайта: только придуманное имя, очки и число отчётов.
-- Ни Telegram ID, ни Telegram-имя сюда не попадают. Требует db/bot_api.sql (столбец display_name).
create or replace view leaderboard_public as
select
    u.id,
    u.display_name as name,
    u.points,
    (select count(*) from reports r where r.user_id = u.id) as reports_count
from users u
where u.points > 0 and not u.banned
order by u.points desc, u.id
limit 20;

grant select on leaderboard_public to anon;

-- Акции для волонтёров с прогрессом: сколько мест в районе акции получили отчёт за её время.
-- Показываем текущие и закончившиеся за последние 30 дней.
create or replace view campaigns_public as
select
    c.id, c.title, c.category, c.south, c.west, c.north, c.east, c.goal, c.starts_at, c.ends_at,
    (select count(distinct r.place_id)
     from reports r join places p on p.id = r.place_id
     where r.created_at between c.starts_at and c.ends_at
       and r.status <> 'unknown'
       and not p.hidden
       and (c.category is null or p.category = c.category)
       and st_y(p.geom::geometry) between c.south and c.north
       and st_x(p.geom::geometry) between c.west and c.east) as done,
    (select count(*)
     from places p
     where not p.hidden
       and (c.category is null or p.category = c.category)
       and st_y(p.geom::geometry) between c.south and c.north
       and st_x(p.geom::geometry) between c.west and c.east) as places_in_area
from campaigns c
where c.ends_at > now() - interval '30 days';

grant select on campaigns_public to anon;

-- Jol: функции, через которые бот работает с базой по HTTPS (Supabase REST → /rpc/...).
-- Нужны потому, что прямое подключение к Postgres (порты 5432/6543) блокируется во многих
-- сетях, а HTTPS работает везде. Запускать после schema.sql; повторный запуск безопасен.
--
-- Вызывать функции может только сервисный ключ (service_role). По публичному anon-ключу
-- они недоступны.

-- Пересчёт агрегатов места. Берём последний отчёт каждого пользователя за 12 месяцев
-- (без «не знаю»). Статус места = самый частый; при равенстве — более строгий.
-- «Проверено» = за этот статус высказались минимум 2 разных человека.
create or replace function recalc_place(p_place_id bigint) returns void
language sql set search_path = public, extensions as $$
    with latest as (
        select distinct on (user_id) user_id, status, created_at
        from reports
        where place_id = p_place_id
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
    where id = p_place_id;
$$;

-- Создаёт пользователя при первом сообщении, возвращает {"id": ..., "lang": ...}
create or replace function bot_touch_user(p_tg_id bigint, p_username text) returns jsonb
language sql set search_path = public, extensions as $$
    with u as (
        insert into users (tg_id, username) values (p_tg_id, p_username)
        on conflict (tg_id) do update set username = excluded.username
        returning id, lang
    )
    select jsonb_build_object('id', id, 'lang', lang) from u;
$$;

create or replace function bot_set_lang(p_user_id bigint, p_lang lang_code) returns void
language sql set search_path = public, extensions as $$
    update users set lang = p_lang where id = p_user_id;
$$;

-- {"id": ..., "name": ...} или null, если места нет
create or replace function bot_get_place(p_place_id bigint) returns jsonb
language sql stable set search_path = public, extensions as $$
    select jsonb_build_object('id', id, 'name', name) from places where id = p_place_id;
$$;

-- До 8 ближайших мест в радиусе p_radius метров, от ближнего к дальнему
create or replace function bot_nearby_places(p_lat float8, p_lon float8, p_radius float8 default 200)
returns jsonb
language sql stable set search_path = public, extensions as $$
    select coalesce(
        jsonb_agg(jsonb_build_object('id', id, 'name', name, 'category', category,
                                     'status', status, 'dist_m', dist_m) order by dist_m),
        '[]'::jsonb)
    from (
        select p.id, p.name, p.category, p.status,
               round(st_distance(p.geom, pt.g))::int as dist_m
        from places p,
             (select st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography as g) pt
        where st_dwithin(p.geom, pt.g, p_radius)
        order by dist_m
        limit 8
    ) nearest;
$$;

-- Одна транзакция: (новое место) → отчёт → фото → пересчёт места → очки. Возвращает id места.
create or replace function bot_save_report(
    p_user_id      bigint,
    p_answers      jsonb,
    p_status       access_status,
    p_photos       text[],
    p_place_id     bigint default null,
    p_new_name     text default null,
    p_new_category place_category default null,
    p_lat          float8 default null,
    p_lon          float8 default null,
    p_points       integer default 10
) returns bigint
language plpgsql set search_path = public, extensions as $$
declare
    v_place_id  bigint := p_place_id;
    v_report_id bigint;
    v_slope     numeric := (p_answers->>'ramp_slope_pct')::numeric;
begin
    if v_place_id is null then
        insert into places (name, category, geom, created_by)
        values (p_new_name, p_new_category,
                st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, p_user_id)
        returning id into v_place_id;
    end if;

    insert into reports (place_id, user_id, steps, ramp, door_wide, call_button, toilet,
                         ramp_slope_pct, status)
    values (v_place_id, p_user_id,
            coalesce(p_answers->>'steps', 'unknown')::steps_level,
            coalesce(p_answers->>'ramp', 'unknown')::ramp_state,
            coalesce(p_answers->>'door_wide', 'unknown')::tri_state,
            coalesce(p_answers->>'call_button', 'unknown')::tri_state,
            coalesce(p_answers->>'toilet', 'unknown')::tri_state,
            -- уклон, измеренный телефоном; зажимаем в допустимые рамки столбца.
            -- case нужен, потому что greatest/least игнорируют null и превратили бы «не мерили» в 0
            case when v_slope is not null then least(greatest(v_slope, 0), 100) end,
            p_status)
    returning id into v_report_id;

    insert into photos (report_id, tg_file_id)
    select v_report_id, unnest(p_photos);

    perform recalc_place(v_place_id);
    update users set points = points + p_points where id = p_user_id;
    return v_place_id;
end
$$;

-- Поиск для тех, кому нужно войти: ближайшие места со статусом «доступно» или «частично».
-- p_category = null — любая категория.
create or replace function bot_find_accessible(
    p_lat float8, p_lon float8,
    p_category place_category default null,
    p_radius float8 default 1500,
    p_limit integer default 6
) returns jsonb
language sql stable set search_path = public, extensions as $$
    select coalesce(
        jsonb_agg(jsonb_build_object('id', id, 'name', name, 'category', category, 'status', status,
                                     'is_verified', is_verified, 'dist_m', dist_m) order by dist_m),
        '[]'::jsonb)
    from (
        select p.id, p.name, p.category, p.status, p.is_verified,
               round(st_distance(p.geom, pt.g))::int as dist_m
        from places p,
             (select st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography as g) pt
        where p.status in ('accessible', 'partial')
          and (p_category is null or p.category = p_category)
          and st_dwithin(p.geom, pt.g, p_radius)
        order by dist_m
        limit p_limit
    ) nearest;
$$;

-- Места рядом, которые ждут второго мнения: есть отчёт, но ещё не «проверено», и этот
-- пользователь сам о месте не писал. Вместе с ответами последнего отчёта.
create or replace function bot_places_to_verify(
    p_user_id bigint, p_lat float8, p_lon float8, p_radius float8 default 500
) returns jsonb
language sql stable set search_path = public, extensions as $$
    select coalesce(jsonb_agg(to_jsonb(waiting) order by dist_m), '[]'::jsonb)
    from (
        select p.id, p.name, p.category, p.status, r.id as report_id,
               r.steps, r.ramp, r.door_wide, r.call_button, r.toilet, r.ramp_slope_pct,
               round(st_distance(p.geom, pt.g))::int as dist_m
        from places p
        cross join (select st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography as g) pt
        join lateral (
            select * from reports
            where place_id = p.id and status <> 'unknown'
            order by created_at desc
            limit 1
        ) r on true
        where not p.is_verified
          and st_dwithin(p.geom, pt.g, p_radius)
          and not exists (select 1 from reports where place_id = p.id and user_id = p_user_id)
        order by dist_m
        limit 8
    ) waiting;
$$;

-- «Да, всё так»: подтверждение записывается в verifications, а в reports добавляется копия
-- отчёта от имени подтвердившего — так место набирает второй голос по обычному правилу.
-- Возвращает {"place_id", "name", "status", "is_verified"} или null, если подтвердить нельзя
-- (свой отчёт, уже подтверждал, отчёта нет).
create or replace function bot_confirm_report(p_user_id bigint, p_report_id bigint, p_points integer default 5)
returns jsonb
language plpgsql set search_path = public, extensions as $$
declare
    r reports%rowtype;
    result jsonb;
begin
    select * into r from reports where id = p_report_id;
    if not found or r.user_id = p_user_id then
        return null;
    end if;

    insert into verifications (report_id, user_id, kind)
    values (p_report_id, p_user_id, 'confirm')
    on conflict (report_id, user_id) do nothing;
    if not found then
        return null;
    end if;

    insert into reports (place_id, user_id, steps, ramp, door_wide, call_button, toilet,
                         ramp_slope_pct, status)
    values (r.place_id, p_user_id, r.steps, r.ramp, r.door_wide, r.call_button, r.toilet,
            r.ramp_slope_pct, r.status);
    perform recalc_place(r.place_id);
    update users set points = points + p_points where id = p_user_id;

    select jsonb_build_object('place_id', id, 'name', name, 'status', status, 'is_verified', is_verified)
    into result from places where id = r.place_id;
    return result;
end
$$;

-- «Нет, исправить»: отмечаем несогласие; сам новый отчёт человек заполняет обычным путём.
create or replace function bot_dispute_report(p_user_id bigint, p_report_id bigint) returns void
language sql set search_path = public, extensions as $$
    insert into verifications (report_id, user_id, kind)
    select p_report_id, p_user_id, 'dispute'
    from reports where id = p_report_id and user_id <> p_user_id
    on conflict (report_id, user_id) do nothing;
$$;

-- Имя, под которым волонтёр виден в рейтинге на сайте. Пока не задано — «Волонтёр №…».
-- Telegram-имя наружу не показываем никогда.
alter table users add column if not exists display_name text;

create or replace function bot_set_name(p_user_id bigint, p_name text) returns void
language sql set search_path = public, extensions as $$
    update users
    set display_name = nullif(left(btrim(regexp_replace(p_name, '\s+', ' ', 'g')), 24), '')
    where id = p_user_id;
$$;

-- Профиль для команды /me. Подтверждение создаёт копию отчёта, поэтому собственные
-- отчёты = все отчёты минус подтверждения.
create or replace function bot_me(p_user_id bigint) returns jsonb
language sql stable set search_path = public, extensions as $$
    select jsonb_build_object(
        'id', u.id,
        'display_name', u.display_name,
        'points', u.points,
        'confirms', c.confirms,
        'reports', greatest((select count(*) from reports r where r.user_id = u.id) - c.confirms, 0),
        'rank', (select count(*) + 1 from users other where other.points > u.points)
    )
    from users u
    cross join lateral (
        select count(*) as confirms from verifications v where v.user_id = u.id and v.kind = 'confirm'
    ) c
    where u.id = p_user_id;
$$;

-- Шаг диалога каждого пользователя. Бесплатный хостинг усыпляет бота через 15 минут без
-- сообщений, и память очищается; с этой таблицей человек продолжает с того же места.
create table if not exists bot_state (
    key        text primary key,          -- "<chat_id>:<user_id>"
    state      text,
    data       jsonb not null default '{}',
    updated_at timestamptz not null default now()
);
alter table bot_state enable row level security;
revoke all on bot_state from anon, authenticated;
grant all on bot_state to service_role;

-- По умолчанию функции в схеме public может вызвать кто угодно, включая anon. Закрываем.
do $$
declare
    fn text;
begin
    foreach fn in array array[
        'recalc_place(bigint)',
        'bot_touch_user(bigint, text)',
        'bot_set_lang(bigint, lang_code)',
        'bot_get_place(bigint)',
        'bot_nearby_places(float8, float8, float8)',
        'bot_save_report(bigint, jsonb, access_status, text[], bigint, text, place_category, float8, float8, integer)',
        'bot_find_accessible(float8, float8, place_category, float8, integer)',
        'bot_places_to_verify(bigint, float8, float8, float8)',
        'bot_confirm_report(bigint, bigint, integer)',
        'bot_dispute_report(bigint, bigint)',
        'bot_set_name(bigint, text)',
        'bot_me(bigint)'
    ] loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end
$$;

notify pgrst, 'reload schema';

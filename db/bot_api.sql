-- Jol: функции, через которые бот работает с базой по HTTPS (Supabase REST → /rpc/...).
-- Нужны потому, что прямое подключение к Postgres (порты 5432/6543) блокируется во многих
-- сетях, а HTTPS работает везде. Запускать после schema.sql; повторный запуск безопасен.
--
-- Вызывать функции может только сервисный ключ (service_role). По публичному anon-ключу
-- они недоступны.

-- Дополнения к схеме (идут первыми: функции ниже на них ссылаются).
-- Место, которого больше нет: скрывается, когда об этом сообщили два разных человека.
-- Вернуть ошибочно скрытое место: update places set hidden = false where id = ...;
alter table places add column if not exists hidden boolean not null default false;

create table if not exists place_flags (
    place_id   bigint not null references places (id) on delete cascade,
    user_id    bigint not null references users (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (place_id, user_id)
);
alter table place_flags enable row level security;
revoke all on place_flags from anon, authenticated;
grant all on place_flags to service_role;

-- Модерация: заблокированный пользователь не может ничего добавлять, его заметки и имя
-- не показываются; отдельную заметку можно скрыть, не трогая отчёт.
alter table users   add column if not exists banned boolean not null default false;
alter table reports add column if not exists comment_hidden boolean not null default false;

-- Что ещё есть у входа (необязательный шаг отчёта): parking, elevator, tactile
alter table reports add column if not exists extras text[] not null default '{}';

-- Акции для волонтёров: «описать 30 аптек в этом районе до субботы».
-- Район — прямоугольник по координатам; прогресс = сколько мест в нём получили отчёт за время акции.
create table if not exists campaigns (
    id         bigint generated always as identity primary key,
    title      text not null,
    category   place_category,                  -- null = любые места
    south      float8 not null,
    west       float8 not null,
    north      float8 not null,
    east       float8 not null,
    goal       integer not null check (goal > 0),
    starts_at  timestamptz not null default now(),
    ends_at    timestamptz not null,
    created_at timestamptz not null default now()
);
alter table campaigns enable row level security;
revoke all on campaigns from anon, authenticated;
grant all on campaigns to service_role;

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
        returning id, lang, banned
    )
    select jsonb_build_object('id', id, 'lang', lang, 'banned', banned) from u;
$$;

create or replace function bot_set_lang(p_user_id bigint, p_lang lang_code) returns void
language sql set search_path = public, extensions as $$
    update users set lang = p_lang where id = p_user_id;
$$;

-- {"id": ..., "name": ...} или null, если места нет
create or replace function bot_get_place(p_place_id bigint) returns jsonb
language sql stable set search_path = public, extensions as $$
    select jsonb_build_object('id', id, 'name', name) from places where id = p_place_id and not hidden;
$$;

-- Поиск места по части названия (без учёта регистра), для команды /search
create or replace function bot_search(p_query text, p_limit integer default 8) returns jsonb
language sql stable set search_path = public, extensions as $$
    select coalesce(jsonb_agg(to_jsonb(found)), '[]'::jsonb)
    from (
        select id, name, category, status
        from places
        where not hidden
          -- экранируем % и _, чтобы они искались как обычные символы
          and name ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        order by (status = 'unknown'), length(name), name
        limit p_limit
    ) found;
$$;

-- «Места больше нет». Каждый человек считается один раз; после второго сигнала место скрывается.
-- Возвращает {"name", "flags", "hidden"} или null, если места нет.
create or replace function bot_flag_gone(p_user_id bigint, p_place_id bigint) returns jsonb
language plpgsql set search_path = public, extensions as $$
declare
    v_flags integer;
    result  jsonb;
begin
    if not exists (select 1 from places where id = p_place_id)
       or exists (select 1 from users where id = p_user_id and banned) then
        return null;
    end if;
    insert into place_flags (place_id, user_id) values (p_place_id, p_user_id)
    on conflict do nothing;
    select count(*) into v_flags from place_flags where place_id = p_place_id;
    update places set hidden = true where id = p_place_id and v_flags >= 2;
    select jsonb_build_object('name', name, 'flags', v_flags, 'hidden', hidden)
    into result from places where id = p_place_id;
    return result;
end
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
          and not p.hidden
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
    if exists (select 1 from users where id = p_user_id and banned) then
        raise exception 'user % is banned', p_user_id;
    end if;

    if v_place_id is null then
        insert into places (name, category, geom, created_by)
        values (p_new_name, p_new_category,
                st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, p_user_id)
        returning id into v_place_id;
    end if;

    insert into reports (place_id, user_id, steps, ramp, door_wide, call_button, toilet,
                         extras, comment, ramp_slope_pct, status)
    values (v_place_id, p_user_id,
            coalesce(p_answers->>'steps', 'unknown')::steps_level,
            coalesce(p_answers->>'ramp', 'unknown')::ramp_state,
            coalesce(p_answers->>'door_wide', 'unknown')::tri_state,
            coalesce(p_answers->>'call_button', 'unknown')::tri_state,
            coalesce(p_answers->>'toilet', 'unknown')::tri_state,
            -- только известные значения, без повторов
            array(select distinct value
                  from jsonb_array_elements_text(case when jsonb_typeof(p_answers->'extras') = 'array'
                                                      then p_answers->'extras' else '[]' end)
                  where value in ('parking', 'elevator', 'tactile') order by value),
            -- заметка волонтёра («вход со двора»); её видят все на сайте, поэтому не длиннее 200 символов
            nullif(left(btrim(regexp_replace(p_answers->>'comment', '\s+', ' ', 'g')), 200), ''),
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
          and not p.hidden
          and (p_category is null or p.category = p_category)
          and st_dwithin(p.geom, pt.g, p_radius)
        order by dist_m
        limit p_limit
    ) nearest;
$$;

-- Места рядом, которые ждут второго мнения: есть отчёт, но ещё не «проверено» — или
-- проверено, но больше полугода назад (пандус могли сломать или построить). Этот
-- пользователь сам о месте за последние полгода не писал. Вместе с ответами последнего отчёта.
create or replace function bot_places_to_verify(
    p_user_id bigint, p_lat float8, p_lon float8, p_radius float8 default 500
) returns jsonb
language sql stable set search_path = public, extensions as $$
    select coalesce(jsonb_agg(to_jsonb(waiting) order by stale, dist_m), '[]'::jsonb)
    from (
        select p.id, p.name, p.category, p.status, r.id as report_id,
               r.steps, r.ramp, r.door_wide, r.call_button, r.toilet, r.ramp_slope_pct, r.extras,
               p.last_checked_at,
               (p.is_verified and p.last_checked_at < now() - interval '6 months') as stale,
               round(st_distance(p.geom, pt.g))::int as dist_m
        from places p
        cross join (select st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography as g) pt
        join lateral (
            select * from reports
            where place_id = p.id and status <> 'unknown'
            order by created_at desc
            limit 1
        ) r on true
        where (not p.is_verified or p.last_checked_at < now() - interval '6 months')
          and not p.hidden
          and st_dwithin(p.geom, pt.g, p_radius)
          and not exists (select 1 from reports
                          where place_id = p.id and user_id = p_user_id
                            and created_at > now() - interval '6 months')
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
    if not found or r.user_id = p_user_id
       or exists (select 1 from users where id = p_user_id and banned) then
        return null;
    end if;

    insert into verifications (report_id, user_id, kind)
    values (p_report_id, p_user_id, 'confirm')
    on conflict (report_id, user_id) do nothing;
    if not found then
        return null;
    end if;

    insert into reports (place_id, user_id, steps, ramp, door_wide, call_button, toilet,
                         extras, ramp_slope_pct, status)
    values (r.place_id, p_user_id, r.steps, r.ramp, r.door_wide, r.call_button, r.toilet,
            r.extras, r.ramp_slope_pct, r.status);
    perform recalc_place(r.place_id);
    update users set points = points + p_points where id = p_user_id;

    -- author_* нужны боту, чтобы написать автору отчёта: «ваш отчёт подтвердили»
    select jsonb_build_object('place_id', p.id, 'name', p.name, 'status', p.status,
                              'is_verified', p.is_verified,
                              'author_tg_id', author.tg_id, 'author_lang', author.lang)
    into result
    from places p, users author
    where p.id = r.place_id and author.id = r.user_id;
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
    where id = p_user_id and not banned;
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
        -- сколько раз человек сам измерил уклон (копии при подтверждении не считаются)
        'slopes', (select count(*) from reports r
                   where r.user_id = u.id and r.ramp_slope_pct is not null
                     and not exists (select 1 from verifications v
                                     join reports original on original.id = v.report_id
                                     where v.user_id = u.id and v.kind = 'confirm'
                                       and original.place_id = r.place_id)),
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

-- --- Модерация (команды бота только для администраторов из ADMIN_IDS) -------------------

-- Последние заметки и имена в рейтинге — то, что видно всем и что стоит просматривать
create or replace function bot_admin_recent(p_limit integer default 10) returns jsonb
language sql stable set search_path = public, extensions as $$
    select jsonb_build_object(
        'notes', coalesce((
            select jsonb_agg(to_jsonb(n) order by n.created_at desc) from (
                select r.id as report_id, r.comment, r.created_at, r.user_id, p.id as place_id, p.name as place
                from reports r join places p on p.id = r.place_id
                where r.comment is not null and not r.comment_hidden
                order by r.created_at desc limit p_limit
            ) n), '[]'::jsonb),
        'names', coalesce((
            select jsonb_agg(to_jsonb(u) order by u.user_id desc) from (
                select id as user_id, display_name, points from users
                where display_name is not null and not banned
                order by id desc limit p_limit
            ) u), '[]'::jsonb)
    );
$$;

create or replace function bot_admin_hide_note(p_report_id bigint) returns boolean
language sql set search_path = public, extensions as $$
    update reports set comment_hidden = true where id = p_report_id and comment is not null
    returning true;
$$;

create or replace function bot_admin_reset_name(p_user_id bigint) returns boolean
language sql set search_path = public, extensions as $$
    update users set display_name = null where id = p_user_id returning true;
$$;

-- Блокировка: имя сбрасывается, заметки скрываются. Отчёты остаются — их можно оспорить обычным путём.
create or replace function bot_admin_ban(p_user_id bigint, p_ban boolean default true) returns boolean
language plpgsql set search_path = public, extensions as $$
begin
    update users set banned = p_ban, display_name = case when p_ban then null else display_name end
    where id = p_user_id;
    if not found then
        return false;
    end if;
    if p_ban then
        update reports set comment_hidden = true where user_id = p_user_id and comment is not null;
    end if;
    return true;
end
$$;

-- Вернуть на карту место, скрытое по ошибке («места больше нет»)
create or replace function bot_admin_unhide_place(p_place_id bigint) returns boolean
language plpgsql set search_path = public, extensions as $$
begin
    update places set hidden = false where id = p_place_id;
    if not found then
        return false;
    end if;
    delete from place_flags where place_id = p_place_id;
    return true;
end
$$;

-- --- Акции -----------------------------------------------------------------------------

create or replace function bot_admin_create_campaign(
    p_title text, p_category place_category, p_lat float8, p_lon float8,
    p_radius_m float8, p_goal integer, p_days integer
) returns bigint
language sql set search_path = public, extensions as $$
    -- прямоугольник примерно p_radius_m в каждую сторону от точки
    insert into campaigns (title, category, south, west, north, east, goal, ends_at)
    values (left(btrim(p_title), 80), p_category,
            p_lat - p_radius_m / 111320.0, p_lon - p_radius_m / (111320.0 * cos(radians(p_lat))),
            p_lat + p_radius_m / 111320.0, p_lon + p_radius_m / (111320.0 * cos(radians(p_lat))),
            p_goal, now() + make_interval(days => p_days))
    returning id;
$$;

create or replace function bot_admin_end_campaign(p_id bigint) returns boolean
language sql set search_path = public, extensions as $$
    update campaigns set ends_at = now() where id = p_id and ends_at > now() returning true;
$$;

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
        'bot_me(bigint)',
        'bot_search(text, integer)',
        'bot_flag_gone(bigint, bigint)',
        'bot_admin_recent(integer)',
        'bot_admin_hide_note(bigint)',
        'bot_admin_reset_name(bigint)',
        'bot_admin_ban(bigint, boolean)',
        'bot_admin_unhide_place(bigint)',
        'bot_admin_create_campaign(text, place_category, float8, float8, float8, integer, integer)',
        'bot_admin_end_campaign(bigint)'
    ] loop
        execute format('revoke all on function %s from public, anon, authenticated', fn);
        execute format('grant execute on function %s to service_role', fn);
    end loop;
end
$$;

notify pgrst, 'reload schema';

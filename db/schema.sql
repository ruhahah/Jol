-- Jol: схема БД (PostgreSQL + PostGIS).
-- Supabase: SQL Editor → вставить целиком → Run (один раз).
-- Локальный Postgres: замени первую строку на `create extension if not exists postgis;`
create extension if not exists postgis with schema extensions;

create type lang_code         as enum ('kk', 'ru', 'en');
create type user_role         as enum ('volunteer', 'moderator', 'business', 'admin');
create type place_category    as enum ('pharmacy', 'cafe', 'government', 'clinic', 'school', 'shop', 'other');
-- Порядок значений важен: при равенстве голосов побеждает более строгий (правый) статус.
create type access_status     as enum ('unknown', 'accessible', 'partial', 'inaccessible');
create type steps_level       as enum ('none', 'one', 'many', 'unknown');
create type ramp_state        as enum ('good', 'bad', 'none', 'unknown');
create type tri_state         as enum ('yes', 'no', 'unknown');
create type verification_kind as enum ('confirm', 'dispute');

create table users (
    id         bigint generated always as identity primary key,
    tg_id      bigint not null unique,
    username   text,
    lang       lang_code not null default 'ru',
    role       user_role not null default 'volunteer',
    points     integer not null default 0,
    created_at timestamptz not null default now()
);

create table places (
    id              bigint generated always as identity primary key,
    name            text not null,
    category        place_category not null default 'other',
    geom            geography(Point, 4326) not null,
    address         text,
    osm_id          bigint unique,              -- для импорта точек из OpenStreetMap
    -- Агрегаты ниже пересчитываются после каждого отчёта (RECALC_PLACE в bot/db.py)
    status          access_status not null default 'unknown',
    score           smallint check (score between 0 and 100),
    reports_count   integer not null default 0,
    is_verified     boolean not null default false,
    last_checked_at timestamptz,
    created_by      bigint references users (id) on delete set null,
    created_at      timestamptz not null default now()
);
create index places_geom_idx     on places using gist (geom);
create index places_category_idx on places (category);
create index places_status_idx   on places (status);

create table reports (
    id             bigint generated always as identity primary key,
    place_id       bigint not null references places (id) on delete cascade,
    user_id        bigint not null references users (id) on delete cascade,
    steps          steps_level not null default 'unknown',
    ramp           ramp_state  not null default 'unknown',
    door_wide      tri_state   not null default 'unknown',
    call_button    tri_state   not null default 'unknown',
    toilet         tri_state   not null default 'unknown',
    ramp_slope_pct numeric(4, 1) check (ramp_slope_pct between 0 and 100),
    status         access_status not null,      -- оценка этого отчёта (bot/scoring.py)
    comment        text,
    created_at     timestamptz not null default now()
);
create index reports_place_idx on reports (place_id, created_at desc);
create index reports_user_idx  on reports (user_id);

create table photos (
    id          bigint generated always as identity primary key,
    report_id   bigint not null references reports (id) on delete cascade,
    tg_file_id  text not null,                  -- MVP-0: фото лежит на серверах Telegram
    storage_url text,                           -- позже: Supabase Storage / R2
    ai_result   jsonb,
    is_blurred  boolean not null default false,
    created_at  timestamptz not null default now()
);
create index photos_report_idx on photos (report_id);

create table verifications (
    id         bigint generated always as identity primary key,
    report_id  bigint not null references reports (id) on delete cascade,
    user_id    bigint not null references users (id) on delete cascade,
    kind       verification_kind not null,
    comment    text,
    created_at timestamptz not null default now(),
    unique (report_id, user_id)
);

-- Supabase отдаёт схему public наружу через REST API. Включаем RLS без политик:
-- по anon-ключу таблицы недоступны, а бот ходит напрямую в Postgres и RLS его не касается.
-- Для сайта позже добавим политику «только чтение» на places.
alter table users         enable row level security;
alter table places        enable row level security;
alter table reports       enable row level security;
alter table photos        enable row level security;
alter table verifications enable row level security;

alter table public.leaderboard_scores
  add column if not exists device_id text,
  add column if not exists avatar text default 'bolt',
  add column if not exists updated_at timestamptz default now();

update public.leaderboard_scores
set
  avatar = coalesce(nullif(avatar, ''), 'bolt'),
  updated_at = coalesce(updated_at, created_at, now())
where avatar is null or avatar = '' or updated_at is null;

create index if not exists leaderboard_scores_device_id_idx
  on public.leaderboard_scores (device_id)
  where device_id is not null;

with ranked_device_scores as (
  select
    id,
    row_number() over (
      partition by device_id
      order by score desc nulls last, updated_at desc nulls last, created_at desc nulls last, id desc
    ) as rank_in_device
  from public.leaderboard_scores
  where device_id is not null
)
delete from public.leaderboard_scores score
using ranked_device_scores ranked
where score.id = ranked.id
  and ranked.rank_in_device > 1;

create unique index if not exists leaderboard_scores_device_id_unique
  on public.leaderboard_scores (device_id)
  where device_id is not null;

create index if not exists leaderboard_scores_score_idx
  on public.leaderboard_scores (score desc);

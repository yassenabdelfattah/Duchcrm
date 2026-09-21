-- ---------------------------------------------------------------------------
-- A name on the ledger cannot be erased by deleting the person.
--
-- stock_movements and order_events are append-only: a trigger refuses UPDATE
-- and DELETE outright. Both carried `staff_id ... on delete set null`, which
-- is a contradiction - removing a staff member makes Postgres try to UPDATE
-- every row they ever touched, and the trigger refuses. The delete fails with
--
--   stock_movements is append-only; UPDATE is not permitted.
--
-- which says nothing about staff and sends whoever tried it looking in the
-- wrong place entirely. It surfaced the first time a real person adjusted an
-- order and someone then tried to remove an admin.
--
-- The right answer is not to make the erasure work. An append-only ledger
-- that forgets who did something is not much of a ledger, and the whole point
-- of recording a name against every movement is that it survives the person
-- leaving. So the foreign key refuses instead, clearly: staff who have
-- touched anything are deactivated, never deleted. `is_active = false` is
-- already what stops someone signing in, and it takes effect on their very
-- next click.
-- ---------------------------------------------------------------------------

alter table public.stock_movements
  drop constraint stock_movements_staff_id_fkey,
  add constraint stock_movements_staff_id_fkey
    foreign key (staff_id) references public.staff (id) on delete restrict;

alter table public.order_events
  drop constraint order_events_staff_id_fkey,
  add constraint order_events_staff_id_fkey
    foreign key (staff_id) references public.staff (id) on delete restrict;

comment on constraint stock_movements_staff_id_fkey on public.stock_movements is
  'Restrict, not set null: this table is append-only, so attribution cannot be rewritten. Deactivate staff rather than deleting them.';

comment on constraint order_events_staff_id_fkey on public.order_events is
  'Restrict, not set null: this table is append-only, so attribution cannot be rewritten. Deactivate staff rather than deleting them.';

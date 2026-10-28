-- Run this in the Supabase SQL editor before deploying the booking server.

-- 1. New columns on the existing `bookings` table
alter table bookings
  add column if not exists remaining_amount bigint,      -- paise still owed; 0 once confirmed
  add column if not exists amount_verified boolean default false;

-- Make sure `status` defaults to pending, not confirmed, for new rows.
-- (The booking server always sets this explicitly, but a safe default helps.)
alter table bookings
  alter column status set default 'pending';

-- 2. New `payments` table — records every captured Razorpay payment,
--    so partial payments / top-ups can be summed correctly and audited.
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  booking_number text not null references bookings(booking_number),
  razorpay_payment_id text not null unique,
  razorpay_order_id text not null,
  amount_paid bigint not null,       -- paise
  captured_at timestamptz not null default now()
);

create index if not exists payments_booking_number_idx on payments(booking_number);

-- 3. Hotel addons need stable `id` fields for server-side lookup.
--    If your `addons` jsonb column currently has entries without an `id`,
--    backfill them, e.g.:
--
--  update hotels
--  set addons = (
--    select jsonb_agg(elem || jsonb_build_object('id', idx - 1))
--    from jsonb_array_elements(addons) with ordinality as t(elem, idx)
--  )
--  where addons is not null;

create table public.bookings (id uuid primary key default gen_random_uuid(), salon_id uuid not null, starts_at timestamptz not null, customer_email text);
alter table public.bookings enable row level security;

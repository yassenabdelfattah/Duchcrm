-- ---------------------------------------------------------------------------
-- Paying later.
--
-- A customer takes the goods and settles up afterwards. It happens in a shop
-- where the people buying are often known to the people selling, and until
-- now it was recorded as cash, which quietly overstated the day's takings.
--
-- Its own migration, because Postgres will not let a new enum value be used
-- in the same transaction that adds it. The function that reads it is in the
-- next file.
-- ---------------------------------------------------------------------------

alter type public.payment_method add value if not exists 'deferred';

-- Two new kinds of sync issue, about whole orders rather than stock.
--
-- In a file of their own: a value added to an enum cannot be used in the same
-- transaction that adds it, and the next migration's functions use both.

alter type public.sync_issue_type add value if not exists 'order_changed_in_shopify';
alter type public.sync_issue_type add value if not exists 'order_sync_failed';

-- ---------------------------------------------------------------------------
-- Fill in sizes and colours the import missed.
--
-- The import took a variant's size only from an option named exactly "Size".
-- Duch's slippers name it "Shoe Size" or "Shoe size", so all of their sizes
-- were left empty and their chips on the stock and sale pages showed only a
-- colour - five identical "Black" buttons for sizes 41 to 45. The import and
-- the product webhook now match any option whose name contains the word.
--
-- This fills the empty fields for variants already imported, from the
-- Shopify options each one already has stored. Only empty values are
-- written; a size or colour that is already set is left as it is.
-- ---------------------------------------------------------------------------

update public.variants v
   set size = (
         select o.value
           from jsonb_each_text(v.options) o
          where lower(o.key) like '%size%' or o.key like '%مقاس%'
          order by o.key
          limit 1
       )
 where v.size is null
   and exists (
         select 1 from jsonb_each_text(v.options) o
          where (lower(o.key) like '%size%' or o.key like '%مقاس%') and o.value <> ''
       );

update public.variants v
   set color = (
         select o.value
           from jsonb_each_text(v.options) o
          where lower(o.key) like '%color%' or lower(o.key) like '%colour%' or o.key like '%لون%'
          order by o.key
          limit 1
       )
 where v.color is null
   and exists (
         select 1 from jsonb_each_text(v.options) o
          where (lower(o.key) like '%color%' or lower(o.key) like '%colour%' or o.key like '%لون%')
            and o.value <> ''
       );

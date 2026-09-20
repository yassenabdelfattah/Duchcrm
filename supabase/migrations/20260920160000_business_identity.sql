-- ---------------------------------------------------------------------------
-- Phase 3: who the invoice is from.
--
-- An invoice is a formal document, so it has to carry the seller's identity:
-- legal name, address, and whatever registration numbers the business holds.
-- Those are facts about Duch rather than facts about the code, and they change
-- when the business registers something new - so they live in settings, where
-- an admin edits them without a deploy.
--
-- Every field starts empty except the ones already visible on the thermal
-- receipt. The invoice prints only the fields that are filled in, so an
-- unregistered detail leaves no blank label on the paper.
-- ---------------------------------------------------------------------------

insert into public.settings (key, value, description) values
  ('business_identity',
   jsonb_build_object(
     'legal_name_ar',       'دوتش',
     'legal_name_en',       'Duch',
     'address_ar',          null,
     'address_en',          null,
     'tax_number',          null,
     'commercial_register', null,
     'phone',               null,
     'email',               null,
     'website',             'duch.store'
   ),
   'Seller details printed on invoices. Not secrets; safe for any staff to read.')
on conflict (key) do nothing;

insert into public.organisations (id, slug, name, kind, synthetic) values
  ('11000000-0000-4000-8000-000000000001', 'khunou', 'Khunou Ore Exports', 'exporter', true),
  ('11000000-0000-4000-8000-000000000002', 'kopano', 'Kopano Stockyard Custody', 'custodian', true),
  ('11000000-0000-4000-8000-000000000003', 'mosela', 'Mosela Haulage', 'transporter', true),
  ('11000000-0000-4000-8000-000000000004', 'port-t1', 'Port Terminal T1', 'terminal', true),
  ('11000000-0000-4000-8000-000000000005', 'lender-one', 'Lender One Bank', 'lender', true),
  ('11000000-0000-4000-8000-000000000006', 'lender-two', 'Lender Two Bank', 'lender', true),
  ('11000000-0000-4000-8000-000000000007', 'buyer-smelter', 'Buyer Smelter Co', 'buyer', true)
on conflict (slug) do nothing;

insert into private.settings (key, value)
values ('link_domain', 'localhost:3100')
on conflict (key) do nothing;

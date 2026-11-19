insert into public.organisations (slug, name, kind, synthetic) values
  ('khunou', 'Khunou Ore Exports', 'exporter', true),
  ('kopano', 'Kopano Stockyard Custody', 'custodian', true),
  ('mosela', 'Mosela Haulage', 'transporter', true),
  ('port-t1', 'Port Terminal T1', 'terminal', true),
  ('lender-one', 'Lender One Bank', 'lender', true),
  ('lender-two', 'Lender Two Bank', 'lender', true),
  ('buyer-smelter', 'Buyer Smelter Co', 'buyer', true)
on conflict (slug) do nothing;

insert into private.settings (key, value)
values ('link_domain', 'localhost:3100')
on conflict (key) do nothing;

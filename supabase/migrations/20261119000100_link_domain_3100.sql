insert into private.settings (key, value)
values ('link_domain', 'localhost:3100')
on conflict (key) do update
set value = excluded.value
where private.settings.value = 'localhost:3000';

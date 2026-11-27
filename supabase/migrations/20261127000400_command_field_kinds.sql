-- The field command kinds whose program instructions exist (field-app.md §6.3, fold 16):
-- issue_lot and handover. record_observation and record_loading append their own values when
-- their instructions land. Roles live in the signers jsonb, so they need no type change.
alter type public.command_kind add value 'issue_lot';
alter type public.command_kind add value 'handover';

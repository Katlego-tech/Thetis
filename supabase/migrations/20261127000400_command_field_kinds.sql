-- The field command kinds whose program instructions exist (field-app.md §6.3, fold 16). Each
-- later kind (handover, record_observation, record_loading) appends its own value when its
-- instruction lands. Roles live in the signers jsonb, so they need no type change.
alter type public.command_kind add value 'issue_lot';

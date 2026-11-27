-- The record_observation field command kind (field-app.md §6.3, fold 16; T067r.2 fold 35), now
-- that its program instruction exists. The observer role lives in the signers jsonb, so it needs
-- no type change.
alter type public.command_kind add value 'record_observation';

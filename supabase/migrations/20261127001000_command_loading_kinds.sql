-- The loading field command kinds (field-app.md §6.3, fold 16; T067r.3 folds 41 and 48), now that
-- their program instructions exist. The owner and terminal roles live in the signers jsonb, so
-- they need no type change.
alter type public.command_kind add value 'create_loading_intent';
alter type public.command_kind add value 'record_loading';

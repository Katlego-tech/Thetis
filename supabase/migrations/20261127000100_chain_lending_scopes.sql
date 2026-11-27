-- Phase 2 of the chain read model (live-lending.md §6.1): the event scopes of facility- and
-- pool-scoped events. A new enum value can't be used in the transaction that adds it, so the
-- values come first, alone.
alter type public.chain_event_scope add value 'facility';
alter type public.chain_event_scope add value 'pool';

-- Phase 3 of the chain read model, part one (live-custody.md §6.1): the event scopes of the custody
-- streams. A new enum value can't be used in the transaction that adds it, so the values come
-- first, alone. All three Phase 3 scopes at once, so no later custody migration needs one.
alter type public.chain_event_scope add value 'shipment';
alter type public.chain_event_scope add value 'loading';
alter type public.chain_event_scope add value 'incident';

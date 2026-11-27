-- accept_loading as a relay transaction kind (field-app.md owner decision 1 on loading, 27 Nov;
-- T067r.4 fold 56): the lender signs the transaction and the sponsor pays as `payer`. The lender
-- role already lives in the signers jsonb, so no type change is needed.
alter type public.command_kind add value 'accept_loading';

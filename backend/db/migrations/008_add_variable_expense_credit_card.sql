-- 008: credit card as a variable expense type
--
-- 'credit_card' joins the variable expense categories so a credit card charge
-- (statement payment / one-off purchase) can be recorded as an actual expense,
-- not only as a fixed monthly bill. The type CHECK constraint is replaced
-- rather than edited in place: existing rows keep their values untouched and
-- every pre-existing category stays valid.

ALTER TABLE belanja.variable_expenses
  DROP CONSTRAINT IF EXISTS variable_expenses_type_check;

ALTER TABLE belanja.variable_expenses
  ADD CONSTRAINT variable_expenses_type_check
  CHECK (type IN ('food','groceries','parent','toll','fuel','credit_card','others'));

-- 011: additional variable expense types
-- Keep the existing values valid while allowing the new variable categories.

ALTER TABLE belanja.variable_expenses
  DROP CONSTRAINT IF EXISTS variable_expenses_type_check;

ALTER TABLE belanja.variable_expenses
  ADD CONSTRAINT variable_expenses_type_check
  CHECK (type IN (
    'food',
    'groceries',
    'parent',
    'toll',
    'fuel',
    'credit_card',
    'bill',
    'shopee_paylater',
    'tiktok_paylater',
    'atome',
    'hutang_orang',
    'belanja_orang',
    'others'
  ));

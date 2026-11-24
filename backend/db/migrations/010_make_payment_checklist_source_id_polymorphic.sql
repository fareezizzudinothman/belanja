-- 010: checklist source_id is polymorphic across fixed, installment, and variable expenses.
-- A foreign key to fixed_expenses rejects installment and variable checklist rows.
ALTER TABLE belanja.monthly_payment_checklist
  DROP CONSTRAINT IF EXISTS monthly_payment_checklist_source_id_fkey;

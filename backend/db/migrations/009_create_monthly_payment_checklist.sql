-- 009: monthly payment checklist
-- A payment tracking layer that is independent of expense status.
-- Each row represents "this expense needs to be paid for this user+year+month".
-- "paid" only means "I have paid this expense" - it must NOT deactivate fixed expenses,
-- change installment paid_months, change remaining_months, delete variable expenses,
-- or change the expense amount.
--
-- Uniqueness: (user_id, year, month, expense_type, source_id) prevents duplicate
-- checklist items for the same expense in the same month.
-- When source_id is NULL, the item is a standalone entry (e.g. a variable expense
-- with no original master, or a manually added item).

CREATE TABLE IF NOT EXISTS belanja.monthly_payment_checklist (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid           NOT NULL REFERENCES belanja.users(id) ON DELETE CASCADE,
  year          int            NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month         int            NOT NULL CHECK (month BETWEEN 1 AND 12),
  expense_type  text           NOT NULL CHECK (expense_type IN ('fixed', 'variable', 'installment')),
  source_id     uuid           REFERENCES belanja.fixed_expenses(id) ON DELETE SET NULL,
               -- source_id can also reference installments or variable_expenses;
               -- we keep a single column for simplicity; NULL means standalone.
  name          text           NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 150),
  amount        numeric(12,2)  NOT NULL CHECK (amount >= 0 AND amount <= 9999999999.99),
  paid          boolean        NOT NULL DEFAULT false,
  paid_at       timestamptz,
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT chk_paid_at CHECK (NOT paid OR paid_at IS NOT NULL),
  CONSTRAINT chk_unpaid_at CHECK (paid OR paid_at IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_payment_checklist_user_month
  ON belanja.monthly_payment_checklist (user_id, year, month);

CREATE INDEX IF NOT EXISTS idx_payment_checklist_user_month_type
  ON belanja.monthly_payment_checklist (user_id, year, month, expense_type);

-- Prevent duplicate checklist items for the same expense in the same month.
-- When source_id is NULL the uniqueness still applies per (user,year,month,expense_type)
-- but the name/amount may differ; we allow multiple standalone items per month.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_checklist_uniq
  ON belanja.monthly_payment_checklist (user_id, year, month, expense_type, source_id)
  WHERE source_id IS NOT NULL;

-- Trigger to keep updated_at in sync.
DROP TRIGGER IF EXISTS trg_monthly_payment_checklist_updated_at ON belanja.monthly_payment_checklist;
CREATE TRIGGER trg_monthly_payment_checklist_updated_at
  BEFORE UPDATE ON belanja.monthly_payment_checklist
  FOR EACH ROW EXECUTE FUNCTION belanja.set_updated_at();

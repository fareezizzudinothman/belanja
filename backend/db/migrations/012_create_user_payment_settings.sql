-- 012: per-user Payment Checklist settings

CREATE TABLE IF NOT EXISTS belanja.user_payment_settings (
  user_id                  uuid        PRIMARY KEY REFERENCES belanja.users(id) ON DELETE CASCADE,
  payment_music_enabled    boolean     NOT NULL DEFAULT false,
  payment_music_youtube_id text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_payment_settings_youtube_id_check
    CHECK (payment_music_youtube_id IS NULL OR payment_music_youtube_id ~ '^[A-Za-z0-9_-]{11}$')
);

DROP TRIGGER IF EXISTS trg_user_payment_settings_updated_at ON belanja.user_payment_settings;
CREATE TRIGGER trg_user_payment_settings_updated_at
  BEFORE UPDATE ON belanja.user_payment_settings
  FOR EACH ROW EXECUTE FUNCTION belanja.set_updated_at();

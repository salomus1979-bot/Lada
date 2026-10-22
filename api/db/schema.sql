-- Схема БД сервиса записи «Лада».
-- Соответствует docs/db-schema.md. Время — UTC TEXT, деньги — копейки INTEGER.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  email             TEXT    NOT NULL COLLATE NOCASE,
  phone             TEXT    NOT NULL,
  password_hash     TEXT    NOT NULL,
  is_blocked        INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0,1)),
  no_show_count     INTEGER NOT NULL DEFAULT 0 CHECK (no_show_count >= 0),
  created_at_utc    TEXT    NOT NULL,
  last_login_at_utc TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email COLLATE NOCASE);
-- Роли списком: у одного человека их может быть несколько — например мастер,
-- который заодно ведёт администрирование. Проверка прав спрашивает «есть ли
-- такая роль в списке», а не «совпадает ли единственное значение».
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role    TEXT    NOT NULL CHECK (role IN ('client','master','admin','owner')),
  PRIMARY KEY (user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles (role);

CREATE TABLE IF NOT EXISTS sessions (
  -- SHA-256 от токена, hex. Сам токен не хранится нигде: он существует только
  -- в cookie у владельца. Укради кто-нибудь эту таблицу — войти по ней нельзя.
  token_hash     TEXT    PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at_utc TEXT    NOT NULL,
  expires_at_utc TEXT    NOT NULL,
  -- User-Agent входа. Нужен только чтобы показать «Chrome · Windows» в списке
  -- активных сессий; наружу уходит разобранная подпись, а не строка целиком.
  user_agent     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at_utc);

CREATE TABLE IF NOT EXISTS service_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id      INTEGER NOT NULL REFERENCES service_categories (id),
  name             TEXT    NOT NULL,
  description      TEXT,
  duration_min     INTEGER NOT NULL CHECK (duration_min > 0 AND duration_min % 5 = 0),
  buffer_after_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0),
  price_kopecks    INTEGER NOT NULL CHECK (price_kopecks >= 0),
  is_visible       INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0,1)),
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at_utc   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_services_category ON services (category_id, is_active);

CREATE TABLE IF NOT EXISTS masters (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER UNIQUE REFERENCES users (id) ON DELETE SET NULL,
  first_name       TEXT    NOT NULL,
  last_name        TEXT    NOT NULL,
  specialization   TEXT,
  experience_years INTEGER CHECK (experience_years IS NULL OR experience_years >= 0),
  bio              TEXT,
  photo_url        TEXT,
  is_visible       INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0,1)),
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at_utc   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS master_services (
  master_id  INTEGER NOT NULL REFERENCES masters (id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, service_id)
);

CREATE TABLE IF NOT EXISTS master_work_schedule (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id       INTEGER NOT NULL REFERENCES masters (id) ON DELETE CASCADE,
  weekday         INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  is_day_off      INTEGER NOT NULL DEFAULT 0 CHECK (is_day_off IN (0,1)),
  start_min       INTEGER CHECK (start_min IS NULL OR (start_min >= 0 AND start_min <= 1440)),
  end_min         INTEGER CHECK (end_min IS NULL OR (end_min >= 0 AND end_min <= 1440)),
  break_start_min INTEGER,
  break_end_min   INTEGER,
  UNIQUE (master_id, weekday),
  CHECK (is_day_off = 1 OR (start_min IS NOT NULL AND end_min IS NOT NULL AND end_min > start_min)),
  CHECK (break_start_min IS NULL OR (break_end_min IS NOT NULL AND break_end_min > break_start_min))
);

CREATE TABLE IF NOT EXISTS master_schedule_exceptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id      INTEGER NOT NULL REFERENCES masters (id) ON DELETE CASCADE,
  type           TEXT    NOT NULL CHECK (type IN ('vacation','sick_leave','hours_override','day_off')),
  start_date     TEXT    NOT NULL,
  end_date       TEXT    NOT NULL,
  start_min      INTEGER,
  end_min        INTEGER,
  reason         TEXT,
  created_at_utc TEXT    NOT NULL,
  CHECK (end_date >= start_date),
  CHECK (type <> 'hours_override'
         OR (start_min IS NOT NULL AND end_min IS NOT NULL AND end_min > start_min))
);
CREATE INDEX IF NOT EXISTS idx_exceptions_master_range
  ON master_schedule_exceptions (master_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS time_blocks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  master_id          INTEGER NOT NULL REFERENCES masters (id) ON DELETE CASCADE,
  type               TEXT    NOT NULL CHECK (type IN ('break','time_off','vacation','sick_leave')),
  starts_at_utc      TEXT    NOT NULL,
  ends_at_utc        TEXT    NOT NULL,
  comment            TEXT,
  created_by_user_id INTEGER REFERENCES users (id),
  created_at_utc     TEXT    NOT NULL,
  CHECK (ends_at_utc > starts_at_utc)
);
CREATE INDEX IF NOT EXISTS idx_time_blocks_master
  ON time_blocks (master_id, starts_at_utc, ends_at_utc);

CREATE TABLE IF NOT EXISTS appointments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  client_user_id       INTEGER NOT NULL REFERENCES users (id),
  master_id            INTEGER NOT NULL REFERENCES masters (id),
  starts_at_utc        TEXT    NOT NULL,
  ends_at_utc          TEXT    NOT NULL,
  service_duration_min INTEGER NOT NULL CHECK (service_duration_min > 0),
  total_price_kopecks  INTEGER NOT NULL CHECK (total_price_kopecks >= 0),
  status               TEXT    NOT NULL CHECK (status IN
                         ('pending','confirmed','completed','no_show',
                          'cancelled_by_client','cancelled_by_studio')),
  client_comment       TEXT,
  cancel_reason        TEXT,
  cancelled_at_utc     TEXT,
  reschedule_count     INTEGER NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  -- Осознанное наложение: администратор поставил визит поверх занятого времени.
  -- Описывает ТЕКУЩЕЕ размещение, а не историю: при переносе пересчитывается.
  is_override          INTEGER NOT NULL DEFAULT 0 CHECK (is_override IN (0, 1)),
  -- Как визит попал в студию (страница 24: телефон / лично / WhatsApp).
  -- 'online' ставит сам API, когда клиент записался через кабинет, — поэтому
  -- извне это значение не принимается, и признак «клиент оформил сам»
  -- остаётся достоверным. NULL — источник не указан: так лежат записи,
  -- созданные до появления колонки, и админские записи без указания.
  -- В отличие от is_override описывает происхождение, а не размещение,
  -- поэтому при переносе не меняется.
  source               TEXT    CHECK (source IS NULL OR source IN
                         ('online','phone','in_person','whatsapp')),
  created_at_utc       TEXT    NOT NULL,
  updated_at_utc       TEXT    NOT NULL,
  CHECK (ends_at_utc > starts_at_utc)
);
CREATE INDEX IF NOT EXISTS idx_appointments_master ON appointments (master_id, starts_at_utc);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments (client_user_id, starts_at_utc);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments (status);

-- Последний рубеж против двойной записи: пересечение визитов одного мастера
-- запрещено на уровне БД, даже если проверка в приложении не сработала или
-- запись пришла в обход API.
--
-- Триггеры СНАЧАЛА удаляются, а потом создаются заново: schema.sql выполняется
-- при каждом открытии базы, и CREATE TRIGGER IF NOT EXISTS молча оставил бы
-- старое определение. Для триггеров это дёшево и избавляет от расхождения
-- между файлом и базой.
--
-- Пересечение: NEW.starts < существующий.ends AND NEW.ends > существующий.starts.
-- Визиты встык (15:00-16:00 и 16:00-17:00) пересечением НЕ считаются:
-- при равенстве границ оба строгих сравнения ложны.
--
-- Сравнение строковое, и это корректно: starts_at_utc/ends_at_utc всегда
-- хранятся в одном формате 'YYYY-MM-DDTHH:MM:SSZ' фиксированной длины,
-- поэтому лексикографический порядок совпадает с хронологическим.
--
-- Отменённые и завершённые визиты слот не держат, поэтому и в NEW (WHEN),
-- и в проверяемых строках учитываются только 'pending' и 'confirmed'.
--
-- NEW.is_override = 1 снимает проверку ТОЛЬКО с записываемой строки.
-- Подзапрос намеренно НЕ фильтрует по is_override: визит, поставленный
-- внахлёст, дальше участвует в проверках как обычный и блокирует другие.

DROP TRIGGER IF EXISTS appointments_no_overlap_insert;
CREATE TRIGGER appointments_no_overlap_insert
BEFORE INSERT ON appointments
FOR EACH ROW
WHEN NEW.status IN ('pending', 'confirmed') AND NEW.is_override = 0
BEGIN
  SELECT RAISE(ABORT, 'appointment_overlap')
  WHERE EXISTS (
    SELECT 1 FROM appointments a
     WHERE a.master_id = NEW.master_id
       AND a.status IN ('pending', 'confirmed')
       AND a.starts_at_utc < NEW.ends_at_utc
       AND a.ends_at_utc > NEW.starts_at_utc
  );
END;

-- Отдельный триггер на UPDATE: перенос времени и смена мастера проходят
-- через него же. Строка исключает саму себя (a.id <> NEW.id), иначе любая
-- правка активной записи конфликтовала бы со своим прежним интервалом.
--
-- is_override здесь тоже снимает проверку, поэтому API обязан сбрасывать
-- признак в 0 при переносе не-администратором: иначе клиент, перенося свой
-- визит, протащил бы наложение мимо триггера.
DROP TRIGGER IF EXISTS appointments_no_overlap_update;
CREATE TRIGGER appointments_no_overlap_update
BEFORE UPDATE ON appointments
FOR EACH ROW
WHEN NEW.status IN ('pending', 'confirmed') AND NEW.is_override = 0
BEGIN
  SELECT RAISE(ABORT, 'appointment_overlap')
  WHERE EXISTS (
    SELECT 1 FROM appointments a
     WHERE a.id <> NEW.id
       AND a.master_id = NEW.master_id
       AND a.status IN ('pending', 'confirmed')
       AND a.starts_at_utc < NEW.ends_at_utc
       AND a.ends_at_utc > NEW.starts_at_utc
  );
END;

CREATE TABLE IF NOT EXISTS appointment_services (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id            INTEGER NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  service_id                INTEGER NOT NULL REFERENCES services (id),
  name_snapshot             TEXT    NOT NULL,
  price_kopecks_snapshot    INTEGER NOT NULL CHECK (price_kopecks_snapshot >= 0),
  duration_min_snapshot     INTEGER NOT NULL CHECK (duration_min_snapshot > 0),
  buffer_after_min_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_min_snapshot >= 0)
);
CREATE INDEX IF NOT EXISTS idx_appointment_services ON appointment_services (appointment_id);

-- История записи: кто, когда и что с ней сделал.
--
-- Отмена и перенос не стирают и не подменяют строку визита: `appointments`
-- хранит ТЕКУЩЕЕ состояние, а здесь лежит то, как оно менялось. Поэтому
-- отменённая запись остаётся в списках с пометкой, а перенесённая остаётся
-- тем же самым визитом — у неё просто другое время и новая строка истории.
--
-- `actor_user_id` — кто это сделал: сам клиент, администратор или владелец.
-- ON DELETE SET NULL: аккаунт могут удалить, а история визита остаётся.
-- `actor_role` фиксируется в момент действия: роли со временем меняются, а
-- «отменила студия» должно остаться правдой и через год.
--
-- `from_starts_at_utc` / `to_starts_at_utc` заполняются только у переноса —
-- откуда и куда. У отмены вместо них `reason`, у смены статуса — `status`.
CREATE TABLE IF NOT EXISTS appointment_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id     INTEGER NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  type               TEXT    NOT NULL CHECK (type IN
                       ('created','rescheduled','cancelled','status_changed')),
  actor_user_id      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  actor_role         TEXT    NOT NULL CHECK (actor_role IN ('client','master','admin','owner')),
  from_starts_at_utc TEXT,
  to_starts_at_utc   TEXT,
  status             TEXT,
  reason             TEXT,
  created_at_utc     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointment_events
  ON appointment_events (appointment_id, created_at_utc);

CREATE TABLE IF NOT EXISTS slot_holds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT    NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  master_id      INTEGER NOT NULL REFERENCES masters (id) ON DELETE CASCADE,
  starts_at_utc  TEXT    NOT NULL,
  ends_at_utc    TEXT    NOT NULL,
  expires_at_utc TEXT    NOT NULL,
  created_at_utc TEXT    NOT NULL,
  CHECK (ends_at_utc > starts_at_utc)
);
CREATE INDEX IF NOT EXISTS idx_holds_master ON slot_holds (master_id, starts_at_utc);
CREATE INDEX IF NOT EXISTS idx_holds_expires ON slot_holds (expires_at_utc);
CREATE INDEX IF NOT EXISTS idx_holds_user ON slot_holds (user_id);

CREATE TABLE IF NOT EXISTS salon_settings (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  name                    TEXT    NOT NULL,
  phone                   TEXT    NOT NULL,
  address                 TEXT    NOT NULL,
  timezone                TEXT    NOT NULL,
  slot_step_min           INTEGER NOT NULL CHECK (slot_step_min > 0),
  cancel_window_hours     INTEGER NOT NULL CHECK (cancel_window_hours >= 0),
  booking_horizon_months  INTEGER NOT NULL CHECK (booking_horizon_months > 0),
  max_active_appointments INTEGER NOT NULL CHECK (max_active_appointments > 0),
  max_reschedules         INTEGER NOT NULL CHECK (max_reschedules >= 0),
  no_show_block_threshold INTEGER NOT NULL CHECK (no_show_block_threshold > 0),
  hold_ttl_min            INTEGER NOT NULL CHECK (hold_ttl_min > 0)
);

CREATE TABLE IF NOT EXISTS salon_hours (
  weekday   INTEGER PRIMARY KEY CHECK (weekday BETWEEN 1 AND 7),
  is_closed INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0,1)),
  start_min INTEGER,
  end_min   INTEGER,
  CHECK (is_closed = 1 OR (start_min IS NOT NULL AND end_min IS NOT NULL AND end_min > start_min))
);

CREATE TABLE IF NOT EXISTS salon_day_overrides (
  date      TEXT    PRIMARY KEY,
  is_closed INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0,1)),
  start_min INTEGER,
  end_min   INTEGER,
  note      TEXT,
  CHECK (is_closed = 1 OR (start_min IS NOT NULL AND end_min IS NOT NULL AND end_min > start_min))
);

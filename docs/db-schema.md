# Схема базы данных — сервис записи «Лада»

Документ выведен из прототипа (47 страниц Claude Design + `Инвентаризация страниц.md`)
и является контрактом для API в `api/`.

## Общие соглашения

| Правило | Решение |
|---|---|
| СУБД | SQLite (`node:sqlite`), файл `api/db/lada.sqlite` |
| Время | все моменты времени хранятся в **UTC**, в формате `YYYY-MM-DDTHH:MM:SSZ` (TEXT). Колонки с таким содержимым имеют суффикс `_at_utc` |
| Локальное время | график работы и блокировки по шаблону хранятся как **минуты от полуночи** в часовом поясе салона (`salon_settings.timezone`), суффикс `_min` |
| Даты | календарные даты (отпуск, исключения) — `YYYY-MM-DD` в поясе салона, суффикс `_date` |
| Деньги | только целое число **копеек**, суффикс `_kopecks`. Никаких float |
| Длительности | целое число минут, суффикс `_min` |
| Дни недели | ISO-8601: 1 = понедельник … 7 = воскресенье |
| Удаление | услуги и мастера не удаляются физически, а скрываются (`is_active = 0`) — иначе ломается история записей |
| Внешние ключи | `PRAGMA foreign_keys = ON` обязателен для каждого соединения |
| Добавленные колонки | `api/db/schema.sql` описывает актуальное состояние и годится для новой базы. В уже созданную базу колонка досоздаётся шагом `ADDED_COLUMNS` в `api/src/lib/db.js` (сейчас `appointments.is_override`, `appointments.source` и `sessions.user_agent`). Перевод `sessions` с токена на `token_hash` менял первичный ключ, а не набор колонок, поэтому сделан отдельным шагом `migrateSessionTokens`: старая таблица удаляется целиком — переносить токены, лежавшие открытым текстом, значило бы продлить жизнь именно тем значениям, которые перестали хранить. Полноценного версионирования схемы (`PRAGMA user_version`) нет |

Заранее подготовленных слотов в БД **нет**. Свободное время всегда вычисляется на лету
из `master_work_schedule` + `master_schedule_exceptions` + `appointments` + `time_blocks` + `slot_holds`.

---

## 1. `users` — аккаунты

Единая таблица для всех ролей. Клиент и мастер — это роль, а не отдельная таблица аккаунтов.

| Колонка | Тип | Ограничения | Назначение |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `role` | TEXT | NOT NULL, CHECK in (`client`,`master`,`admin`,`owner`) | роль; `owner` дополнительно может менять цены |
| `name` | TEXT | NOT NULL | имя (прототип: регистрация просит только имя) |
| `email` | TEXT | NOT NULL UNIQUE (COLLATE NOCASE) | логин |
| `phone` | TEXT | NOT NULL | формат `+7XXXXXXXXXX` после нормализации |
| `password_hash` | TEXT | NOT NULL | `scrypt$N$r$p$salt_b64$hash_b64` — соль своя у каждого пароля (16 случайных байт), параметры стойкости (`N=16384`, `r=8`, `p=1`) лежат рядом с хешем, поэтому их можно поднять, не ломая старые пароли. **Никогда не выходит за пределы БД**. У клиента, которого создал администратор, пароля нет: там лежит заглушка `nologin$<random>` — схема не `scrypt`, поэтому проверка пароля отказывает всегда. Это статус «Без аккаунта» со страницы 26 |
| `is_blocked` | INTEGER | NOT NULL DEFAULT 0 | автоблокировка после неявок (`salon_settings.no_show_block_threshold`) |
| `no_show_count` | INTEGER | NOT NULL DEFAULT 0 | счётчик неявок |
| `created_at_utc` | TEXT | NOT NULL | |
| `last_login_at_utc` | TEXT | NULL | показывается админу в карточке мастера |

Индексы: `UNIQUE(email)`, `INDEX(role)`.

## 2. `sessions` — сессии входа

Непрозрачный токен в HttpOnly-cookie `lada_session`; выход удаляет строку.

| Колонка | Тип | Ограничения | Назначение |
|---|---|---|---|
| `token_hash` | TEXT | PK | **SHA-256 от токена**, hex. Сам токен — 32 случайных байта — в базе не хранится нигде |
| `user_id` | INTEGER | NOT NULL → `users.id` ON DELETE CASCADE | |
| `created_at_utc` | TEXT | NOT NULL | |
| `expires_at_utc` | TEXT | NOT NULL | срок жизни 30 дней |
| `user_agent` | TEXT | NULL | User-Agent входа, обрезанный до 400 символов. Нужен только для подписи устройства в списке «Активные сессии» (страница 16). NULL — сессия открыта до появления колонки |

Индекс: `INDEX(user_id)`, `INDEX(expires_at_utc)`.

**Токен в базе не хранится.** Он существует только в cookie у владельца, а в
таблице лежит его SHA-256: укради кто-нибудь эту таблицу — войти по ней
нельзя. При каждом запросе токен из cookie хешируется и ищется по `token_hash`.

Почему SHA-256, а не scrypt, как у паролей: scrypt нарочно медленный, чтобы
дорого было перебирать пароль — у пароля мало энтропии. Токен — 32 случайных
байта, перебирать его бессмысленно при любой скорости хеша, а проверяется он
на КАЖДОМ запросе. Соль ему тоже не нужна: солью служит сама случайность.

`token_hash` — он же идентификатор в списке «Активные сессии»: отдавать его
наружу безопасно, а для кнопки «Завершить» достаточно.

Срок действия — 30 дней (`expires_at_utc`). Просроченные строки удаляются при
проверке сессии, при входе и раз в минуту таймером в `server.js`.

## 3. `service_categories` — категории каталога

В сиде: Ногти (`nails`), Брови (`brows`).

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | INTEGER | PK |
| `slug` | TEXT | NOT NULL UNIQUE (в сиде: `nails`, `brows`) |
| `title` | TEXT | NOT NULL |
| `description` | TEXT | NULL |
| `sort_order` | INTEGER | NOT NULL DEFAULT 0 |

## 4. `services` — услуги

| Колонка | Тип | Ограничения | Назначение |
|---|---|---|---|
| `id` | INTEGER | PK | |
| `category_id` | INTEGER | NOT NULL → `service_categories.id` | |
| `name` | TEXT | NOT NULL | |
| `description` | TEXT | NULL | до 160 символов (ограничение формы) |
| `duration_min` | INTEGER | NOT NULL, CHECK > 0 AND % 5 = 0 | шаг 10 минут в UI, кратность 5 в БД |
| `buffer_after_min` | INTEGER | NOT NULL DEFAULT 0, CHECK >= 0 | уборка рабочего места, клиенту не видна, но занимает время мастера |
| `price_kopecks` | INTEGER | NOT NULL, CHECK >= 0 | цену меняет только `owner` |
| `is_visible` | INTEGER | NOT NULL DEFAULT 1 | «Показывать в каталоге» |
| `is_active` | INTEGER | NOT NULL DEFAULT 1 | мягкое удаление |
| `created_at_utc` | TEXT | NOT NULL | |

Индекс: `INDEX(category_id, is_active)`.

## 5. `masters` — мастера

| Колонка | Тип | Ограничения | Назначение |
|---|---|---|---|
| `id` | INTEGER | PK | |
| `user_id` | INTEGER | NULL UNIQUE → `users.id` ON DELETE SET NULL | аккаунт доступа; «Доступ не выдан» = NULL |
| `first_name` | TEXT | NOT NULL | |
| `last_name` | TEXT | NOT NULL | |
| `specialization` | TEXT | NULL | |
| `experience_years` | INTEGER | NULL, CHECK >= 0 | |
| `bio` | TEXT | NULL | до 300 символов |
| `photo_url` | TEXT | NULL | |
| `is_visible` | INTEGER | NOT NULL DEFAULT 1 | «Показывать в каталоге мастеров» |
| `is_active` | INTEGER | NOT NULL DEFAULT 1 | мягкое удаление |
| `sort_order` | INTEGER | NOT NULL DEFAULT 0 | |
| `created_at_utc` | TEXT | NOT NULL | |

## 6. `master_services` — кто какие услуги выполняет

Прототип: «Клиент увидит мастера только если тот выполняет **все** выбранные услуги визита».

| Колонка | Тип | Ограничения |
|---|---|---|
| `master_id` | INTEGER | NOT NULL → `masters.id` ON DELETE CASCADE |
| `service_id` | INTEGER | NOT NULL → `services.id` ON DELETE CASCADE |

PK: `(master_id, service_id)`.

## 7. `master_work_schedule` — регулярный недельный график

Одна строка на мастера и день недели. Время — минуты от полуночи в поясе салона.

| Колонка | Тип | Ограничения | Назначение |
|---|---|---|---|
| `id` | INTEGER | PK | |
| `master_id` | INTEGER | NOT NULL → `masters.id` ON DELETE CASCADE | |
| `weekday` | INTEGER | NOT NULL, CHECK 1..7 | ISO, 1 = Пн |
| `is_day_off` | INTEGER | NOT NULL DEFAULT 0 | «Выходной» |
| `start_min` | INTEGER | NULL, CHECK 0..1440 | NULL при выходном |
| `end_min` | INTEGER | NULL, CHECK 0..1440, CHECK `end_min > start_min` | |
| `break_start_min` | INTEGER | NULL | «Перерыв», ежедневно кроме выходных |
| `break_end_min` | INTEGER | NULL, CHECK `break_end_min > break_start_min` | |

UNIQUE: `(master_id, weekday)`.

## 8. `master_schedule_exceptions` — исключения из графика

Отпуск, больничный, разовое изменение часов, разовый выходной. Перекрывают регулярный график.

| Колонка | Тип | Ограничения | Назначение |
|---|---|---|---|
| `id` | INTEGER | PK | |
| `master_id` | INTEGER | NOT NULL → `masters.id` ON DELETE CASCADE | |
| `type` | TEXT | NOT NULL, CHECK in (`vacation`,`sick_leave`,`hours_override`,`day_off`) | |
| `start_date` | TEXT | NOT NULL `YYYY-MM-DD` | |
| `end_date` | TEXT | NOT NULL `YYYY-MM-DD`, CHECK >= `start_date` | включительно |
| `start_min` | INTEGER | NULL | обязателен только для `hours_override` |
| `end_min` | INTEGER | NULL | |
| `reason` | TEXT | NULL | |
| `created_at_utc` | TEXT | NOT NULL | |

Индекс: `INDEX(master_id, start_date, end_date)`.

## 9. `time_blocks` — точечные блокировки времени

Мастер/админ закрывает конкретный интервал («Перерыв», «Отгул», «Отпуск», «Больничный»
со страницы 39). В отличие от исключений, хранится готовыми UTC-моментами.

| Колонка | Тип | Ограничения | Назначение |
|---|---|---|---|
| `id` | INTEGER | PK | |
| `master_id` | INTEGER | NOT NULL → `masters.id` ON DELETE CASCADE | |
| `type` | TEXT | NOT NULL, CHECK in (`break`,`time_off`,`vacation`,`sick_leave`) | |
| `starts_at_utc` | TEXT | NOT NULL | |
| `ends_at_utc` | TEXT | NOT NULL, CHECK > `starts_at_utc` | |
| `comment` | TEXT | NULL | |
| `created_by_user_id` | INTEGER | NULL → `users.id` | |
| `created_at_utc` | TEXT | NOT NULL | |

Индекс: `INDEX(master_id, starts_at_utc, ends_at_utc)`.

## 10. `appointments` — записи

| Колонка | Тип | Ограничения | Назначение |
|---|---|---|---|
| `id` | INTEGER | PK | |
| `client_user_id` | INTEGER | NOT NULL → `users.id` | клиент визита. Запись мог оформить администратор за него (страница 24) — кто именно её создал, схема не хранит |
| `master_id` | INTEGER | NOT NULL → `masters.id` | |
| `starts_at_utc` | TEXT | NOT NULL | начало визита |
| `ends_at_utc` | TEXT | NOT NULL, CHECK > `starts_at_utc` | конец **с буферами** услуг |
| `service_duration_min` | INTEGER | NOT NULL | сумма `duration_min` без буферов — то, что видит клиент |
| `total_price_kopecks` | INTEGER | NOT NULL, CHECK >= 0 | сумма цен на момент создания |
| `status` | TEXT | NOT NULL, CHECK in (`pending`,`confirmed`,`completed`,`no_show`,`cancelled_by_client`,`cancelled_by_studio`) | статусы со страницы 23 |
| `client_comment` | TEXT | NULL | «Комментарий мастеру» |
| `cancel_reason` | TEXT | NULL | |
| `cancelled_at_utc` | TEXT | NULL | |
| `reschedule_count` | INTEGER | NOT NULL DEFAULT 0 | лимит — `salon_settings.max_reschedules` |
| `is_override` | INTEGER | NOT NULL DEFAULT 0, CHECK in (0,1) | осознанное наложение: администратор поставил визит поверх занятого времени. Описывает текущее размещение, а не историю — при переносе пересчитывается |
| `source` | TEXT | NULL, CHECK in (`online`,`phone`,`in_person`,`whatsapp`) | источник записи (страница 24). `online` ставит сам API, когда клиент записался через кабинет, — извне это значение не принимается, поэтому признак «клиент оформил сам» достоверен. NULL — источник не указан: записи, созданные до появления колонки, и админские записи без указания. В отличие от `is_override` описывает происхождение, а не размещение, поэтому при переносе не меняется |
| `created_at_utc` | TEXT | NOT NULL | |
| `updated_at_utc` | TEXT | NOT NULL | |

Индексы: `INDEX(master_id, starts_at_utc)`, `INDEX(client_user_id, starts_at_utc)`, `INDEX(status)`.

Активными (занимающими время) считаются статусы `pending` и `confirmed`.

**Эту таблицу меняет только `api/src/lib/booking.js`** — по одной функции на операцию:

| Операция | Функция | Запись в БД |
|---|---|---|
| создание | `createAppointment` | единственный `INSERT INTO appointments` |
| перенос | `rescheduleAppointment` | `starts_at_utc`, `ends_at_utc`, `is_override`, `reschedule_count` |
| отмена | `cancelAppointment` | `status`, `cancel_reason`, `cancelled_at_utc` |
| смена статуса | `changeAppointmentStatus` | только `status`; `cancelled_by_studio` уходит в `cancelAppointment` |

Роль вызывающего выбирает не путь, а доступные поля и правила: один и тот же
`POST /api/appointments` обслуживает и клиента, и администратора. Роуты
(`routes/appointments.js`, `routes/admin.js`) своего SQL по этой таблице не
имеют — иначе проверку занятости можно было бы обойти новым эндпоинтом.
Роль `master` своего пути записи не имеет: по прототипу (страницы 35–42)
создавать, отменять и переносить записи мастер не может — он лишь запрашивает
отмену у администратора. На общем пути создания аккаунт с этой ролью
записывает себя как обычный клиент. Единственная его операция над визитом —
смена статуса (страница 38), и она идёт через тот же
`changeAppointmentStatus`: роль сужает список статусов и запирает мастера на
своих визитах, нового пути записи не появляется.

Таблицу `time_blocks` по той же причине меняет только
`api/src/lib/blocks.js`: блокировку ставит и администратор (страница 30), и
сам мастер (страница 39), а проверка «на это время уже есть запись» должна
быть у них одна.

## 11. `appointment_services` — состав записи

Цена и длительность копируются в момент создания: «Изменение длительности не затронет
уже созданные записи» (страница 32).

| Колонка | Тип | Ограничения |
|---|---|---|
| `id` | INTEGER | PK |
| `appointment_id` | INTEGER | NOT NULL → `appointments.id` ON DELETE CASCADE |
| `service_id` | INTEGER | NOT NULL → `services.id` |
| `name_snapshot` | TEXT | NOT NULL |
| `price_kopecks_snapshot` | INTEGER | NOT NULL |
| `duration_min_snapshot` | INTEGER | NOT NULL |
| `buffer_after_min_snapshot` | INTEGER | NOT NULL |

Индекс: `INDEX(appointment_id)`.

## 12. `slot_holds` — удержания слотов

Слот держится на время оформления (`salon_settings.hold_ttl_min`, по умолчанию 7 минут).
Истёкшие удержания удаляются физически перед любым расчётом доступности и при создании записи.

| Колонка | Тип | Ограничения | Назначение |
|---|---|---|---|
| `id` | INTEGER | PK | |
| `token` | TEXT | NOT NULL UNIQUE | 32 случайных байта hex; клиент предъявляет его при создании записи |
| `user_id` | INTEGER | NOT NULL → `users.id` ON DELETE CASCADE | удержание всегда принадлежит аккаунту |
| `master_id` | INTEGER | NOT NULL → `masters.id` ON DELETE CASCADE | |
| `starts_at_utc` | TEXT | NOT NULL | |
| `ends_at_utc` | TEXT | NOT NULL, CHECK > `starts_at_utc` | с буферами |
| `expires_at_utc` | TEXT | NOT NULL | |
| `created_at_utc` | TEXT | NOT NULL | |

Индексы: `UNIQUE(token)`, `INDEX(master_id, starts_at_utc)`, `INDEX(expires_at_utc)`, `INDEX(user_id)`.

Чужое действующее удержание блокирует слот; своё — не блокирует (клиент вернулся на шаг назад).

## 13. `salon_settings` — настройки студии

Одна строка, `id = 1` (CHECK `id = 1`). Источник — страница 33.

| Колонка | Тип | По умолчанию | Назначение |
|---|---|---|---|
| `id` | INTEGER | 1 | |
| `name` | TEXT | `Лада` | |
| `phone` | TEXT | | |
| `address` | TEXT | | |
| `timezone` | TEXT | `Europe/Moscow` | пояс салона для отображения |
| `slot_step_min` | INTEGER | 30 | «Шаг сетки слотов, мин» |
| `cancel_window_hours` | INTEGER | 4 | «Отмена и перенос не позднее чем за, ч» |
| `booking_horizon_months` | INTEGER | 3 | «Горизонт записи вперёд, мес.» |
| `max_active_appointments` | INTEGER | 3 | «Макс. активных записей на клиента» |
| `max_reschedules` | INTEGER | 2 | «не более двух раз» (System 01) |
| `no_show_block_threshold` | INTEGER | 3 | «Автоблокировка клиента после неявок» |
| `hold_ttl_min` | INTEGER | 7 | срок жизни удержания слота |

## 14. `salon_hours` — часы работы студии

Границы, внутри которых вообще возможна запись, независимо от графика мастера.

| Колонка | Тип | Ограничения |
|---|---|---|
| `weekday` | INTEGER | PK, CHECK 1..7 |
| `is_closed` | INTEGER | NOT NULL DEFAULT 0 |
| `start_min` | INTEGER | NULL |
| `end_min` | INTEGER | NULL |

## 15. `salon_day_overrides` — праздничные и особые дни

«Переопределяют обычное расписание на конкретную дату» (страница 33).

| Колонка | Тип | Ограничения |
|---|---|---|
| `date` | TEXT | PK `YYYY-MM-DD` |
| `is_closed` | INTEGER | NOT NULL DEFAULT 0 |
| `start_min` | INTEGER | NULL |
| `end_min` | INTEGER | NULL |
| `note` | TEXT | NULL |

---

## Алгоритм расчёта свободного времени

Для `master_id`, календарной даты `D` (в поясе салона) и набора услуг `S`:

1. `service_duration_min` = Σ `duration_min` по `S` — длительность, которую видит клиент.
   `occupied_min` = Σ `duration_min` + Σ `buffer_after_min` — время, которое реально занимает мастер.
2. Определить рабочее окно мастера на `D`:
   - исключение типа `vacation`/`sick_leave`/`day_off`, покрывающее `D` → окон нет;
   - исключение `hours_override` → окно из него;
   - иначе `master_work_schedule` по `weekday(D)`; `is_day_off` → окон нет;
   - из окна вырезается перерыв (`break_start_min`..`break_end_min`).
3. Пересечь с часами работы студии: `salon_day_overrides[D]`, иначе `salon_hours[weekday(D)]`.
4. Перевести границы окон из локальных минут в UTC-моменты.
5. Вычесть занятые интервалы: активные `appointments`, `time_blocks`,
   действующие `slot_holds` других пользователей.
6. Пройти по сетке с шагом `slot_step_min` от начала каждого окна; слот годен,
   если `[start, start + occupied_min)` целиком лежит в окне и не пересекает занятое.
7. Отбросить слоты, начинающиеся раньше «сейчас», и слоты за горизонтом
   `booking_horizon_months`.

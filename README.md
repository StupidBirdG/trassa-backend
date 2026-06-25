# Трасса — бэкенд

Node.js + Express + PostgreSQL. SMS-авторизация через SMSC.kz.

## Требования

- Node.js 18+
- PostgreSQL 14+

## 1. Установка PostgreSQL (если не установлен)

**macOS:**
```bash
brew install postgresql@16
brew services start postgresql@16
```

**Ubuntu/Debian:**
```bash
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
```

**Windows:** скачать установщик с https://www.postgresql.org/download/windows/

## 2. Создание базы данных

```bash
psql -U postgres
```
В psql:
```sql
CREATE DATABASE trassa_db;
\q
```

## 3. Настройка проекта

```bash
cd trassa-backend
npm install

# Скопировать конфиг и заполнить
cp .env.example .env
```

Открыть `.env` и заполнить:
```
DB_PASSWORD=ваш_пароль_postgres
JWT_SECRET=любая_длинная_строка_от_64_символов
SMSC_LOGIN=ваш_логин_на_smsc.kz
SMSC_PASSWORD=ваш_пароль_на_smsc.kz
```

## 4. Создание таблиц

```bash
npm run db:migrate
```

## 5. Запуск

```bash
npm run dev
```

Сервер поднимется на http://localhost:3001

В режиме разработки SMS-коды **не отправляются** — они печатаются прямо в консоль:
```
📱  [DEV] SMS на +77001234567: "Трасса: ваш код 483921. Действует 5 минут."
```

---

## API Reference

### Авторизация

| Метод | URL | Описание |
|-------|-----|----------|
| POST | /api/auth/send-code | Отправить SMS-код |
| POST | /api/auth/verify | Проверить код (вход) |
| POST | /api/auth/register | Регистрация нового пользователя |
| GET  | /api/auth/me | Данные текущего пользователя |
| DELETE | /api/auth/account | Удалить аккаунт |

**Пример — отправить код:**
```bash
curl -X POST http://localhost:3001/api/auth/send-code \
  -H "Content-Type: application/json" \
  -d '{"phone": "+77001234567"}'
```

**Пример — войти:**
```bash
curl -X POST http://localhost:3001/api/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"phone": "+77001234567", "code": "483921"}'
```

**Пример — зарегистрироваться:**
```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"phone":"+77001234567","code":"483921","name":"Ерлан","role":"carrier","company_name":"ТОО ТрансЛогист"}'
```

Сохраните `token` из ответа — он нужен для всех запросов к грузам.

---

### Грузы (требуют заголовок Authorization: Bearer <token>)

| Метод | URL | Описание |
|-------|-----|----------|
| GET  | /api/cargos | Список грузов |
| POST | /api/cargos | Создать груз |
| DELETE | /api/cargos/:id | Отменить груз |
| POST | /api/cargos/:id/bids | Откликнуться (перевозчик) |
| POST | /api/cargos/:id/accept/:bidId | Принять ставку (грузовладелец) |
| POST | /api/cargos/:id/deliver | Отметить доставленным |
| POST | /api/cargos/:id/ping | Обновить GPS-прогресс |
| GET  | /api/cargos/:id/events | История трекинга |

**Пример — создать груз:**
```bash
curl -X POST http://localhost:3001/api/cargos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ВАШ_ТОКЕН" \
  -d '{
    "from_city":"Алматы","to_city":"Шымкент",
    "weight_tons":18,"cargo_type":"Стройматериалы",
    "pickup_date":"2026-07-01","price":420000
  }'
```

---

## Подключение фронтенда

В `trassa-mobile/src/` создайте файл `api.js`:

```javascript
const BASE = 'http://localhost:3001/api';

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}
```

Затем в `App.jsx` заменяете `useState(makeSeed())` на вызовы `apiFetch('/cargos')`.

---

## Структура проекта

```
trassa-backend/
├── src/
│   ├── index.js              # точка входа, Express app
│   ├── db/
│   │   ├── pool.js           # подключение к PostgreSQL
│   │   └── migrate.js        # создание таблиц
│   ├── middleware/
│   │   └── auth.js           # JWT middleware + signToken
│   ├── routes/
│   │   ├── auth.js           # SMS авторизация
│   │   └── cargos.js         # грузы, ставки, трекинг
│   └── services/
│       └── sms.js            # SMSC.kz интеграция
├── .env.example
└── package.json
```

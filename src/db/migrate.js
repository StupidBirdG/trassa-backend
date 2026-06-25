require('dotenv').config();
const pool = require('./pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      -- ========== USERS ==========
      CREATE TABLE IF NOT EXISTS users (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone            VARCHAR(20)  UNIQUE NOT NULL,
        phone_verified   BOOLEAN      DEFAULT FALSE,
        role             VARCHAR(20)  NOT NULL CHECK (role IN ('shipper','carrier')),
        name             VARCHAR(255) NOT NULL,
        company_name     VARCHAR(255),
        rating           NUMERIC(2,1) DEFAULT 5.0,
        completed_deliveries INT      DEFAULT 0,
        created_at       TIMESTAMPTZ  DEFAULT now()
      );

      -- ========== SMS CODES (верификация по телефону) ==========
      CREATE TABLE IF NOT EXISTS sms_codes (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone      VARCHAR(20) NOT NULL,
        code       VARCHAR(6)  NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used       BOOLEAN     DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes(phone);

      -- ========== CARGOS ==========
      CREATE TABLE IF NOT EXISTS cargos (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id         UUID         NOT NULL REFERENCES users(id),
        from_city        VARCHAR(100) NOT NULL,
        to_city          VARCHAR(100) NOT NULL,
        weight_tons      NUMERIC(6,2) NOT NULL,
        cargo_type       VARCHAR(100) NOT NULL,
        pickup_date      DATE         NOT NULL,
        price            NUMERIC(12,2) NOT NULL,
        comment          TEXT,
        status           VARCHAR(20)  NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','in_transit','delivered','cancelled')),
        progress         INT          DEFAULT 0,
        accepted_bid_id  UUID,
        created_at       TIMESTAMPTZ  DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_cargos_status    ON cargos(status);
      CREATE INDEX IF NOT EXISTS idx_cargos_route     ON cargos(from_city, to_city);
      CREATE INDEX IF NOT EXISTS idx_cargos_owner     ON cargos(owner_id);

      -- ========== TRACKING EVENTS ==========
      CREATE TABLE IF NOT EXISTS tracking_events (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cargo_id   UUID         NOT NULL REFERENCES cargos(id) ON DELETE CASCADE,
        label      VARCHAR(500) NOT NULL,
        created_at TIMESTAMPTZ  DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_tracking_cargo ON tracking_events(cargo_id);

      -- ========== BIDS ==========
      CREATE TABLE IF NOT EXISTS bids (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cargo_id   UUID         NOT NULL REFERENCES cargos(id) ON DELETE CASCADE,
        carrier_id UUID         NOT NULL REFERENCES users(id),
        truck_type VARCHAR(100) NOT NULL,
        price      NUMERIC(12,2) NOT NULL,
        status     VARCHAR(20)  NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','accepted','rejected')),
        created_at TIMESTAMPTZ  DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_bids_cargo   ON bids(cargo_id);
      CREATE INDEX IF NOT EXISTS idx_bids_carrier ON bids(carrier_id);

      -- accepted_bid_id FK — добавляем после создания bids
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'cargos_accepted_bid_fk'
        ) THEN
          ALTER TABLE cargos
            ADD CONSTRAINT cargos_accepted_bid_fk
            FOREIGN KEY (accepted_bid_id) REFERENCES bids(id);
        END IF;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('✅  Миграция выполнена успешно');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌  Ошибка миграции:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();

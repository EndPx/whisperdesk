-- WhisperDesk — Neon Postgres schema
-- INVARIANT (rules/flare-integration.md): DB ini HANYA untuk data publik.
-- Tidak boleh ada: plaintext RFQ/quote, identitas counterparty, seed/keys, isi sealed book.
-- Semua baris di sini mirror dari event onchain (sudah publik) atau agregat tape.

-- Cache settlement tracker (mirror event onchain Coston2 — publik by definition)
CREATE TABLE IF NOT EXISTS settlements (
    escrow_id     TEXT PRIMARY KEY,          -- bytes32 hex dari event escrow
    status        TEXT NOT NULL CHECK (status IN (
                    'locked',                -- FXRP terkunci, menunggu leg XRPL
                    'proof_submitted',       -- FDC proof masuk, verifikasi jalan
                    'released',              -- proof valid, FXRP rilis ke maker
                    'refunded',              -- deadline lewat, refund ke taker
                    'slashed'                -- default + bond di-slash
                  )),
    amount_fxrp   NUMERIC(20, 6) NOT NULL,   -- FXRP = 6 desimal
    deadline_at   TIMESTAMPTZ NOT NULL,
    xrpl_tx_hash  TEXT,                      -- diisi saat proof submitted
    fdc_round_id  BIGINT,
    lock_tx_hash  TEXT NOT NULL,             -- tx Coston2
    settle_tx_hash TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements (status);
CREATE INDEX IF NOT EXISTS idx_settlements_created ON settlements (created_at DESC);

-- Tape publik: agregat HARIAN, delay 24 jam (sesuai quantified policy whisperdesk.md)
CREATE TABLE IF NOT EXISTS daily_tape (
    trade_day     DATE PRIMARY KEY,
    total_volume_fxrp NUMERIC(24, 6) NOT NULL DEFAULT 0,
    trade_count   INTEGER NOT NULL DEFAULT 0,
    published_at  TIMESTAMPTZ                -- diisi saat >= trade_day + 24h; NULL = belum boleh tampil
);

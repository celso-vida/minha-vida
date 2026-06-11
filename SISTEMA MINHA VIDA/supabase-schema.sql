-- ============================================================
-- MINHA VIDA - Schema Supabase
-- Execute este SQL no Supabase > SQL Editor > New Query
-- ============================================================

-- Extensão UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ------------------------------------------------------------
-- TABELA 1: personal_data
-- Dados privados de cada usuário (devocional, hábitos, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personal_data (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       JSONB,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, key)
);

ALTER TABLE personal_data ENABLE ROW LEVEL SECURITY;

-- Cada usuário vê e modifica apenas seus próprios dados
CREATE POLICY "personal_own" ON personal_data
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ------------------------------------------------------------
-- TABELA 2: shared_data
-- Dados compartilhados do casal: financeiro (fin_*) e agenda (agenda_*)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shared_data (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,
  value            JSONB,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  last_updated_by  UUID REFERENCES auth.users(id)
);

ALTER TABLE shared_data ENABLE ROW LEVEL SECURITY;

-- Qualquer usuário autenticado (= casal) pode ler e escrever
CREATE POLICY "shared_read" ON shared_data
  FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "shared_insert" ON shared_data
  FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "shared_update" ON shared_data
  FOR UPDATE
  USING (auth.role() = 'authenticated');


-- ------------------------------------------------------------
-- Trigger: atualiza updated_at automaticamente
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_personal_updated_at
  BEFORE UPDATE ON personal_data
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_shared_updated_at
  BEFORE UPDATE ON shared_data
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ------------------------------------------------------------
-- Índices para performance
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_personal_user_key ON personal_data(user_id, key);
CREATE INDEX IF NOT EXISTS idx_shared_key ON shared_data(key);

"""
Importação do backup para o Supabase
Execute: python importar-supabase.py
"""

import json
import urllib.request
import urllib.error

SUPABASE_URL = 'https://eatfoibrhaobcnpaorlo.supabase.co'
SERVICE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhdGZvaWJyaGFvYmNucGFvcmxvIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTE0NDgxMywiZXhwIjoyMDk2NzIwODEzfQ.k0fS3EG5OajdGADHfp9pHwP2q43-arMBAdiqrzgbgOM'
CELSO_UID    = '749d9766-940a-43cc-b6c4-2ab13389df78'
BACKUP_FILE  = 'backup_minha_vida_2026-06-11.json'

SHARED_PREFIXES = ['fin_', 'agenda_']

SKIP_KEYS = {
    'sb-eatfoibrhaobcnpaorlo-auth-token',
    'NRBA_SESSION', 'mv_reminder_state',
    'copa_2026_seeded', 'copa_2026_v2',
    'agenda_base_v1', 'agenda_base_v2',
    'ma-tutorial-visible',
    'soc_seeded_v1', 'soc_docs_v1',
    'prof_seeded_v1', 'prof_links_v1',
    'palavra_ref',
}

EMPTY_VALUES = {'null', 'false', '[]', '{}', '"null"'}

def is_shared(key):
    return any(key.startswith(p) for p in SHARED_PREFIXES)

def parse_value(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except:
            return v
    return v

def upsert(table, payload):
    url = f'{SUPABASE_URL}/rest/v1/{table}'
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=body,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'apikey': SERVICE_KEY,
            'Authorization': f'Bearer {SERVICE_KEY}',
            'Prefer': 'resolution=merge-duplicates',
        }
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return True, resp.status
    except urllib.error.HTTPError as e:
        return False, e.read().decode('utf-8')

def main():
    print('Lendo backup...')
    with open(BACKUP_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)

    print(f'Total de chaves: {len(data)}\n')

    ok = 0
    skip = 0
    erros = 0

    for key, raw_val in data.items():
        # Ignorar chaves internas
        if key in SKIP_KEYS:
            print(f'  ⏭  {key} (ignorado)')
            skip += 1
            continue

        # Ignorar valores vazios
        serialized = json.dumps(raw_val)
        if serialized in EMPTY_VALUES:
            print(f'  ⏭  {key} (vazio)')
            skip += 1
            continue

        value = parse_value(raw_val)

        if is_shared(key):
            payload = {
                'key': key,
                'value': value,
                'last_updated_by': CELSO_UID
            }
            success, result = upsert('shared_data', payload)
            tabela = 'shared_data'
        else:
            payload = {
                'user_id': CELSO_UID,
                'key': key,
                'value': value
            }
            success, result = upsert('personal_data', payload)
            tabela = 'personal_data'

        if success:
            print(f'  ✅ {key} → {tabela}')
            ok += 1
        else:
            print(f'  ❌ {key}: {result}')
            erros += 1

    print(f'\n--- Resultado ---')
    print(f'  Importados : {ok}')
    print(f'  Ignorados  : {skip}')
    print(f'  Erros      : {erros}')
    if erros == 0:
        print('\n✅ Importação concluída com sucesso!')
    else:
        print(f'\n⚠️  {erros} chave(s) com erro. Verifique acima.')

if __name__ == '__main__':
    main()

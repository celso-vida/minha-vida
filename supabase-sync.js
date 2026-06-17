// ============================================================
// supabase-sync.js  —  Camada de sincronização Minha Vida
// Inclua ANTES de qualquer outro script nos dashboards:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="supabase-sync.js"></script>
// ============================================================

(function () {
  'use strict';

  // ----------------------------------------------------------
  // Configuração
  // ----------------------------------------------------------
  var SUPABASE_URL = 'https://eatfoibrhaobcnpaorlo.supabase.co';
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhdGZvaWJyaGFvYmNucGFvcmxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDQ4MTMsImV4cCI6MjA5NjcyMDgxM30.phRBbUJ92yAo62DvuUbDYUqTlUD-jkxo9U0PHZF_x7U';

  // Prefixos de chaves que são dados do casal (tabela shared_data)
  var SHARED_PREFIXES = ['fin_', 'agenda_'];

  // Prefixos internos que NÃO devem ser sincronizados
  var IGNORE_PREFIXES = ['sb-', 'supabase', 'debug_', 'theme_', 'ui_', 'mv_ctrl_'];

  // ----------------------------------------------------------
  // Inicialização do cliente Supabase
  // ----------------------------------------------------------
  if (typeof supabase === 'undefined') {
    console.error('[sync] @supabase/supabase-js não carregado. Verifique a tag <script> CDN.');
    return;
  }
  var db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  var currentUser = null;

  // ----------------------------------------------------------
  // mvSignOut — definido IMEDIATAMENTE e NUNCA sobrescrito
  // Usa db.auth.signOut() que é o método oficial do SDK
  // ----------------------------------------------------------
  window.mvSignOut = async function () {
    try { await db.auth.signOut(); } catch(e) {}
    sessionStorage.removeItem('mv_synced');
    window.name = '';
    localStorage.removeItem('mv_ctrl_synced_ts');
    window.location.href = 'login.html';
  };

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------
  function isSharedKey(key) {
    return SHARED_PREFIXES.some(function (p) { return key.startsWith(p); });
  }

  function shouldIgnore(key) {
    return IGNORE_PREFIXES.some(function (p) { return key.startsWith(p); });
  }

  function parseValue(raw) {
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (_) { return raw; }
  }

  // ----------------------------------------------------------
  // Overlay de carregamento (só aparece no 1º acesso da sessão)
  // ----------------------------------------------------------
  function showOverlay() {
    var el = document.createElement('div');
    el.id = 'sync-overlay';
    el.style.cssText = [
      'position:fixed;inset:0;z-index:99999',
      'background:rgba(255,255,255,0.95)',
      'display:flex;flex-direction:column;align-items:center;justify-content:center',
      'font-family:system-ui,sans-serif;color:#334155;gap:12px;padding:20px;text-align:center'
    ].join(';');
    el.innerHTML = [
      '<div style="font-size:32px">☁️</div>',
      '<div id="sync-msg" style="font-size:16px;font-weight:600">Sincronizando dados...</div>',
      '<div id="sync-detail" style="font-size:13px;color:#64748b;min-height:20px"></div>',
      '<div style="width:200px;height:5px;background:#e2e8f0;border-radius:3px">',
      '  <div id="sync-bar" style="height:5px;background:#3b82f6;border-radius:3px;width:0;transition:width .4s"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(el);
    return el;
  }

  function setOverlayMsg(msg, detail, color) {
    var m = document.getElementById('sync-msg');
    var d = document.getElementById('sync-detail');
    if (m) { m.textContent = msg; if (color) m.style.color = color; }
    if (d && detail !== undefined) d.textContent = detail;
  }

  function setProgress(pct) {
    var bar = document.getElementById('sync-bar');
    if (bar) bar.style.width = pct + '%';
  }

  function hideOverlay() {
    var el = document.getElementById('sync-overlay');
    if (el) el.remove();
  }

  // ----------------------------------------------------------
  // Sincronizar: Supabase → localStorage
  // Estratégia: cloud tem precedência (dados mais recentes)
  // ----------------------------------------------------------
  // Busca token via SDK (auto-renova se expirado)
  async function getAccessToken() {
    try {
      var resp = await db.auth.getSession();
      if (resp.data.session) return resp.data.session.access_token;
    } catch(e) {}
    // Fallback: lê do localStorage
    try {
      var raw = localStorage.getItem('sb-eatfoibrhaobcnpaorlo-auth-token');
      if (!raw) return null;
      return JSON.parse(raw).access_token || null;
    } catch(e) { return null; }
  }

  // Fetch nativo
  async function supaFetch(path) {
    var token = (await getAccessToken()) || SUPABASE_KEY;
    var resp = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    });
    if (!resp.ok) {
      var err = await resp.text();
      throw new Error(resp.status + ' ' + err);
    }
    return resp.json();
  }

  async function supaUpsert(table, payload, onConflict) {
    var token = (await getAccessToken()) || SUPABASE_KEY;
    var resp = await fetch(SUPABASE_URL + '/rest/v1/' + table, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(payload)
    });
    return resp.ok;
  }

  // Aplica linhas de shared_data no localStorage (sem overlay)
  function applySharedRows(rows) {
    rows.forEach(function (row) {
      var val = row.value;
      if (typeof val === 'string') {
        try { val = JSON.parse(val); } catch(_) {}
      }
      _origSet(row.key, JSON.stringify(val));
    });
  }

  // Sync silencioso dos dados compartilhados — roda em todo carregamento de página.
  // Se houver dados novos, recarrega a página para mostrar os valores atualizados.
  var _syncInProgress = false;
  async function syncSharedSilently(forceCheck) {
    if (!currentUser) return;
    if (_syncInProgress) return;
    // Anti-loop: bloqueia apenas por 10s (antes era 60s — bloqueava dados da Selma)
    if (!forceCheck) {
      var nameMatch = (window.name || '').match(/mv_synced_(\d+)/);
      if (nameMatch && (Date.now() - parseInt(nameMatch[1])) < 10000) return;
      var lastReload = localStorage.getItem('mv_ctrl_reload_ts');
      if (lastReload && (Date.now() - parseInt(lastReload)) < 10000) return;
    }
    // Proteção: se o usuário salvou algo nos últimos 15s, não sobrescreve (evita perda de dados)
    var lastLocalSave = localStorage.getItem('mv_ctrl_save_ts');
    if (lastLocalSave && (Date.now() - parseInt(lastLocalSave)) < 15000) return;
    // Proteção: não sincroniza se há pushes pendentes
    if (_pendingPushes > 0) return;
    _syncInProgress = true;
    try {
      var sharedData = await supaFetch('shared_data?select=key,value');
      var changed = false;
      sharedData.forEach(function(row) {
        var val = row.value;
        if (typeof val === 'string') { try { val = JSON.parse(val); } catch(_) {} }
        var newStr = JSON.stringify(val);
        if (localStorage.getItem(row.key) !== newStr) {
          _origSet(row.key, newStr);
          changed = true;
        }
      });
      if (changed) {
        _origSet('mv_ctrl_reload_ts', String(Date.now()));
        window.name = 'mv_synced_' + Date.now();
        window.location.reload();
      }
    } catch (err) {
      console.warn('[sync] ⚠️ Falha ao atualizar dados compartilhados:', err.message);
    } finally {
      _syncInProgress = false;
    }
  }

  // Sync periódico a cada 30 segundos — garante que dados da Selma apareçam mesmo sem WebSocket
  function startPeriodicSync() {
    setInterval(function() {
      syncSharedSilently(false); // anti-loop de 10s protege contra recargas excessivas
    }, 30000);
  }

  async function syncFromSupabase() {
    if (!currentUser) return false;
    var changed = false;
    var totalLoaded = 0;

    try {
      setOverlayMsg('Buscando dados pessoais...', 'usuário: ' + currentUser.email);
      setProgress(20);

      // Dados pessoais via fetch nativo
      var personalData = await supaFetch(
        'personal_data?select=key,value&user_id=eq.' + currentUser.id
      );
      totalLoaded += personalData.length;
      setOverlayMsg('Dados pessoais: ' + personalData.length, '');
      setProgress(50);

      personalData.forEach(function (row) {
        // Chaves compartilhadas (fin_, agenda_) NÃO vêm de personal_data — ignorar
        if (isSharedKey(row.key)) return;
        // Se o valor JSONB veio como string (importado duplo-encoded), faz parse extra
        var val = row.value;
        if (typeof val === 'string') {
          try { val = JSON.parse(val); } catch(_) {}
        }
        var serialized = JSON.stringify(val);
        _origSet(row.key, serialized);
        changed = true;
      });

      setOverlayMsg('Buscando dados compartilhados...', '');
      setProgress(65);

      // Dados compartilhados via fetch nativo
      var sharedData = await supaFetch('shared_data?select=key,value');
      totalLoaded += sharedData.length;
      if (sharedData.length > 0) {
        applySharedRows(sharedData);
        changed = true;
      }

      setProgress(100);
      setOverlayMsg('✅ ' + totalLoaded + ' itens carregados!', 'Abrindo dashboard...', '#16a34a');
    } catch (err) {
      // Mostra erro e NÃO recarrega — fica parado para o usuário ler
      var detail = err.message || String(err);
      setOverlayMsg('❌ Erro na sincronização', detail, '#dc2626');
      // Adiciona botão de copiar o erro
      var overlay = document.getElementById('sync-overlay');
      if (overlay) {
        var btn = document.createElement('button');
        btn.textContent = 'Fechar e continuar sem dados';
        btn.style.cssText = 'margin-top:16px;padding:10px 20px;background:#dc2626;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer';
        btn.onclick = function() { overlay.remove(); };
        overlay.appendChild(btn);
      }
      // Se JWT expirado, redireciona para login após 3s
      var isJwtError = (err.message || '').indexOf('JWT') !== -1 ||
                       (err.message || '').indexOf('401') !== -1 ||
                       (err.message || '').indexOf('PGRST303') !== -1;
      if (isJwtError) {
        setOverlayMsg('🔐 Sessão expirada', 'Redirecionando para login em 3 segundos...', '#f59e0b');
        await new Promise(function(r){ setTimeout(r, 3000); });
        sessionStorage.removeItem('mv_synced');
        _origSet('sb-eatfoibrhaobcnpaorlo-auth-token', '');
        window.location.href = 'login.html';
        return changed;
      }
      // Outros erros: aguarda o usuário fechar
      await new Promise(function() {});
    }

    return changed;
  }

  // ----------------------------------------------------------
  // Sincronizar: localStorage → Supabase (push de uma chave)
  // ----------------------------------------------------------
  async function pushKey(key, rawValue) {
    if (!currentUser) return;
    if (shouldIgnore(key)) return;

    var value = parseValue(rawValue);

    try {
      if (isSharedKey(key)) {
        await supaUpsert('shared_data?on_conflict=key', { key: key, value: value, last_updated_by: currentUser.id });
      } else {
        await supaUpsert('personal_data?on_conflict=user_id,key', { user_id: currentUser.id, key: key, value: value });
      }
    } catch (err) {
      console.warn('[sync] ⚠️ Falha ao enviar chave', key, err);
    }
  }

  // ----------------------------------------------------------
  // Patch do localStorage.setItem
  // ----------------------------------------------------------
  var _origSet = localStorage.setItem.bind(localStorage);
  var _pendingPushes = 0;

  // Avisa antes de fechar/atualizar se há dados sendo salvos
  window.addEventListener('beforeunload', function(e) {
    if (_pendingPushes > 0) {
      e.preventDefault();
      e.returnValue = 'Dados ainda sendo salvos na nuvem. Aguarde um momento antes de atualizar.';
    }
  });

  // Indicador visual de salvamento
  function showSavingIndicator() {
    var el = document.getElementById('mv-saving-indicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mv-saving-indicator';
      el.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99998;background:#1e3a5f;color:#fff;font-size:.75rem;padding:6px 12px;border-radius:20px;opacity:0;transition:opacity .3s;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = '☁️ Salvando...';
    el.style.opacity = '1';
  }
  function hideSavingIndicator() {
    var el = document.getElementById('mv-saving-indicator');
    if (el) el.style.opacity = '0';
  }

  var _origPushKey = pushKey;
  pushKey = async function(key, rawValue) {
    _pendingPushes++;
    showSavingIndicator();
    try {
      await _origPushKey(key, rawValue);
    } finally {
      _pendingPushes--;
      if (_pendingPushes === 0) hideSavingIndicator();
    }
  };

  localStorage.setItem = function (key, value) {
    _origSet(key, value);
    if (!shouldIgnore(key)) {
      // Registra timestamp do último save local para proteger contra sync regressivo
      _origSet('mv_ctrl_save_ts', String(Date.now()));
      pushKey(key, value);
    }
  };

  // ----------------------------------------------------------
  // Lê e decodifica o JWT do localStorage sem depender do CDN
  // ----------------------------------------------------------
  function getStoredUser() {
    try {
      var raw = localStorage.getItem('sb-eatfoibrhaobcnpaorlo-auth-token');
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var token = parsed.access_token;
      if (!token) return null;
      // Decodifica payload do JWT (base64url)
      var payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      // Verifica se não expirou (com 60s de margem)
      if (payload.exp && payload.exp < (Date.now()/1000 - 60)) return null;
      return { id: payload.sub, email: payload.email, _token: token };
    } catch(e) { return null; }
  }

  // ----------------------------------------------------------
  // Autenticação e inicialização (sem depender do CDN para auth)
  // ----------------------------------------------------------
  // ----------------------------------------------------------
  // Realtime: detecta mudanças na shared_data via WebSocket
  // ----------------------------------------------------------
  function startRealtime() {
    if (!currentUser) return;
    var wsUrl = SUPABASE_URL.replace('https://', 'wss://') +
                '/realtime/v1/websocket?apikey=' + SUPABASE_KEY + '&vsn=1.0.0';
    var ws;
    var reloadPending = false;
    var ref = 0;

    function connect() {
      try { ws = new WebSocket(wsUrl); } catch(e) { return; }

      ws.onopen = function() {
        // Formato correto Supabase Realtime v2
        ws.send(JSON.stringify({
          topic: 'realtime:public:shared_data',
          event: 'phx_join',
          payload: {
            config: { broadcast: { self: false }, presence: { key: '' }, postgres_changes: [{ event: '*', schema: 'public', table: 'shared_data' }] },
            access_token: SUPABASE_KEY
          },
          ref: String(++ref)
        }));
        // Heartbeat a cada 30s para manter a conexão viva
        setInterval(function() {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }));
          }
        }, 30000);
      };

      ws.onmessage = function(evt) {
        try {
          var msg = JSON.parse(evt.data);
          // Evento postgres_changes na shared_data
          var isChange = (
            msg.event === 'postgres_changes' ||
            msg.event === 'INSERT' || msg.event === 'UPDATE'
          ) && !reloadPending;
          if (isChange) {
            reloadPending = true;
            console.info('[sync] 🔔 Dado compartilhado atualizado — recarregando...');
            setTimeout(function() {
              syncSharedSilently(true); // tenta sync sem reload completo primeiro
              reloadPending = false;
            }, 1000);
          }
        } catch(e) {}
      };

      ws.onclose = function() {
        setTimeout(connect, 5000); // reconecta após 5s
      };
    }

    connect();
  }

  async function init() {
    // Usa o SDK para obter sessão válida (auto-renova token se necessário)
    var sessionResp = await db.auth.getSession();
    var session = sessionResp.data.session;

    if (!session) {
      // Não logado — redireciona para login (exceto se já estiver lá)
      if (!window.location.pathname.endsWith('login.html') &&
          !window.location.href.endsWith('login.html')) {
        window.location.href = 'login.html';
      }
      return;
    }

    currentUser = { id: session.user.id, email: session.user.email, _token: session.access_token };

    // Nome de exibição por email
    var NAME_MAP = {
      'celso@3whotelaria.com.br': 'Celso',
      'selmamiziara@hotmail.com': 'Selma'
    };
    var displayName = NAME_MAP[currentUser.email] || currentUser.email.split('@')[0];
    window.mvDisplayName = displayName;

    // Substitui "Celso" pelo nome do usuário logado no título e no DOM
    function applyUserName() {
      document.title = document.title.replace(/Celso/g, displayName);
      function walk(node) {
        if (node.nodeType === 3) {
          if (node.textContent.includes('Celso')) node.textContent = node.textContent.replace(/Celso/g, displayName);
        } else if (node.nodeType === 1 && node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE') {
          node.childNodes.forEach(walk);
        }
      }
      if (document.body) walk(document.body);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyUserName);
    else applyUserName();

    // Força novo sync se os dados estiverem em formato errado (duplo-encoded)
    var testVal = localStorage.getItem('pipe_items') || localStorage.getItem('fin_contas');
    if (testVal && testVal.charAt(0) === '"') {
      sessionStorage.removeItem('mv_synced');
      _origSet('mv_ctrl_synced_ts', ''); // limpa fallback também
    }

    var alreadySynced = sessionStorage.getItem('mv_synced');
    // Fallback 1: window.name persiste em reloads no Edge/Safari (mais confiável que sessionStorage)
    if (!alreadySynced) {
      var nameMatch = (window.name || '').match(/mv_synced_(\d+)/);
      if (nameMatch && (Date.now() - parseInt(nameMatch[1])) < 120000) {
        alreadySynced = 'name_fallback';
      }
    }
    // Fallback 2: localStorage (caso window.name também seja limpo)
    if (!alreadySynced) {
      var ctrlSyncTs = localStorage.getItem('mv_ctrl_synced_ts');
      if (ctrlSyncTs && (Date.now() - parseInt(ctrlSyncTs)) < 120000) {
        alreadySynced = 'ls_fallback';
      }
    }
    if (!alreadySynced) {
      // Primeira visita da sessão: sync completo com overlay (dados pessoais + compartilhados)
      if (document.body) showOverlay();
      else document.addEventListener('DOMContentLoaded', showOverlay);

      await syncFromSupabase();
      sessionStorage.setItem('mv_synced', '1');
      // Fallbacks para browsers que limpam sessionStorage em reloads (Edge, Safari)
      window.name = 'mv_synced_' + Date.now();
      _origSet('mv_ctrl_synced_ts', String(Date.now()));
      _origSet('mv_ctrl_reload_ts', String(Date.now()));
      // Pausa para o usuário ver o resultado antes de recarregar
      await new Promise(function(r){ setTimeout(r, 1500); });
      window.location.reload();
      return;
    }

    // Sessão já sincronizada: atualiza só os dados compartilhados silenciosamente.
    // Se o outro dispositivo fez um lançamento novo, detecta e recarrega a página.
    syncSharedSilently(); // fire-and-forget

    // Realtime: escuta mudanças na shared_data via WebSocket
    // Quando outro dispositivo salvar um dado compartilhado, recarrega automaticamente.
    startRealtime();

    // Sync periódico a cada 30s como fallback caso WebSocket falhe ou perca conexão
    startPeriodicSync();

    // Exposição pública
    window.mvUser = currentUser;
    // mvSignOut já definido globalmente acima — não sobrescrever aqui

    console.info('[sync] 👤 Usuário:', currentUser.email);
  }

  // Inicia assim que possível
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

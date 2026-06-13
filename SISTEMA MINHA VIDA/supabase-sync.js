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
  var IGNORE_PREFIXES = ['sb-', 'supabase', 'debug_', 'theme_', 'ui_'];

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
  // Busca token do localStorage diretamente (nosso código, não CDN)
  function getAccessToken() {
    try {
      var raw = localStorage.getItem('sb-eatfoibrhaobcnpaorlo-auth-token');
      if (!raw) return null;
      return JSON.parse(raw).access_token || null;
    } catch(e) { return null; }
  }

  // Fetch nativo — não depende do cliente CDN, sem restrições de tracking
  async function supaFetch(path) {
    var token = getAccessToken() || SUPABASE_KEY;
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
    var token = getAccessToken() || SUPABASE_KEY;
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
  async function syncSharedSilently() {
    if (!currentUser) return;
    // Anti-loop: só recarrega uma vez a cada 60 segundos por sessão
    var lastReload = sessionStorage.getItem('mv_shared_reload_ts');
    if (lastReload && (Date.now() - parseInt(lastReload)) < 60000) return;
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
        sessionStorage.setItem('mv_shared_reload_ts', String(Date.now()));
        window.location.reload();
      }
    } catch (err) {
      console.warn('[sync] ⚠️ Falha ao atualizar dados compartilhados:', err.message);
    }
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
      applySharedRows(sharedData);
      changed = true;

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
      // Nunca resolve — fica parado aqui até o usuário clicar "Fechar"
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
        await supaUpsert('shared_data', { key: key, value: value, last_updated_by: currentUser.id });
      } else {
        await supaUpsert('personal_data', { user_id: currentUser.id, key: key, value: value });
      }
    } catch (err) {
      console.warn('[sync] ⚠️ Falha ao enviar chave', key, err);
    }
  }

  // ----------------------------------------------------------
  // Patch do localStorage.setItem
  // ----------------------------------------------------------
  var _origSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    _origSet(key, value);
    if (!shouldIgnore(key)) pushKey(key, value);
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
    var token = getAccessToken() || SUPABASE_KEY;
    var wsUrl = SUPABASE_URL.replace('https://', 'wss://') +
                '/realtime/v1/websocket?apikey=' + SUPABASE_KEY + '&vsn=1.0.0';
    var ws;
    var reloadPending = false;

    function connect() {
      try {
        ws = new WebSocket(wsUrl);
      } catch(e) { return; }

      ws.onopen = function() {
        // Autentica e se inscreve na tabela shared_data
        ws.send(JSON.stringify({
          topic: 'realtime:public:shared_data',
          event: 'phx_join',
          payload: { access_token: token },
          ref: '1'
        }));
      };

      ws.onmessage = function(evt) {
        try {
          var msg = JSON.parse(evt.data);
          // Evento de INSERT ou UPDATE na shared_data
          if (msg.topic === 'realtime:public:shared_data' &&
              (msg.event === 'INSERT' || msg.event === 'UPDATE') &&
              !reloadPending) {
            reloadPending = true;
            // Pequena pausa para garantir que o dado já está no servidor
            setTimeout(function() { window.location.reload(); }, 800);
          }
        } catch(e) {}
      };

      ws.onclose = function() {
        // Reconecta após 5 segundos se a conexão cair
        setTimeout(connect, 5000);
      };
    }

    connect();
  }

  async function init() {
    var user = getStoredUser();

    if (!user) {
      // Não logado — redireciona para login (exceto se já estiver lá)
      if (!window.location.pathname.endsWith('login.html') &&
          !window.location.href.endsWith('login.html')) {
        window.location.href = 'login.html';
      }
      return;
    }

    currentUser = user;

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
    }

    var alreadySynced = sessionStorage.getItem('mv_synced');
    // Se mv_synced está ativo mas não há dados pessoais no localStorage,
    // força novo sync (ex: novo navegador, localStorage limpo, novo dispositivo)
    if (alreadySynced && !localStorage.getItem('pipe_items') && !localStorage.getItem('dev_planos')) {
      alreadySynced = null;
      sessionStorage.removeItem('mv_synced');
    }
    if (!alreadySynced) {
      // Primeira visita da sessão: sync completo com overlay (dados pessoais + compartilhados)
      if (document.body) showOverlay();
      else document.addEventListener('DOMContentLoaded', showOverlay);

      await syncFromSupabase();
      sessionStorage.setItem('mv_synced', '1');
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

    // Exposição pública
    window.mvUser = currentUser;
    window.mvSignOut = async function () {
      sessionStorage.removeItem('mv_synced');
      // Encerra sessão via fetch nativo (não depende do CDN para localStorage)
      try {
        var token = getAccessToken();
        if (token) {
          await fetch(SUPABASE_URL + '/auth/v1/logout', {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': 'Bearer ' + token
            }
          });
        }
      } catch(e) { /* ignora erros de rede no logout */ }
      // Remove token do localStorage diretamente
      _origSet.call ? localStorage.removeItem('sb-eatfoibrhaobcnpaorlo-auth-token')
                    : (function(){ try { localStorage.removeItem('sb-eatfoibrhaobcnpaorlo-auth-token'); } catch(_){} })();
      window.location.href = 'login.html';
    };

    console.info('[sync] 👤 Usuário:', currentUser.email);
  }

  // Inicia assim que possível
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

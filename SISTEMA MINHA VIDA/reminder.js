// ══════════════════════════════════════════════════════════════════
//  MINHA VIDA · SISTEMA DE LEMBRETES  v1.2
//  Edge / Chrome · Web Speech API · pt-BR
//  Arquivo compartilhado — incluído em todos os dashboards
// ══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const STATE_KEY      = 'mv_reminder_state';
  const CHECK_MS       = 30000;   // verifica a cada 30 segundos
  const WARN_BEFORE    = 5;       // mostra cartão X min antes
  const AUDIO_STOP_MIN = 15;      // para áudio após X min de atraso

  // ── Data LOCAL (respeita fuso onde o usuário está) ──────────────
  // Usa getFullYear/Month/Date que retornam hora local, não UTC
  function localDateStr(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function horaToMin(s) {
    if (!s) return null;
    const [h, m] = s.split(':').map(Number);
    return h * 60 + (m || 0);
  }

  // ── Estado persistente ──────────────────────────────────────────
  function getState()    { try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch { return {}; } }
  function saveState(s)  { localStorage.setItem(STATE_KEY, JSON.stringify(s)); }
  function cleanState()  {
    const s = getState();
    const cut = Date.now() - 86400000; // 24h
    let ch = false;
    for (const k of Object.keys(s)) { if ((s[k].ts || 0) < cut) { delete s[k]; ch = true; } }
    if (ch) saveState(s);
  }

  // ── Síntese de voz ──────────────────────────────────────────────
  function speak(texto) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang    = 'pt-BR';
    u.rate    = 0.92;
    u.pitch   = 1.05;
    u.volume  = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const voz = voices.find(v => v.lang === 'pt-BR')
             || voices.find(v => v.lang.startsWith('pt'))
             || null;
    if (voz) u.voice = voz;
    window.speechSynthesis.speak(u);
  }

  // ── Helpers visuais ─────────────────────────────────────────────
  const EMOJI_AREA = {
    Devocional:'🙏', Pessoal:'💪', Familiar:'👨‍👩‍👧', Financeiro:'💰',
    Profissional:'💼', Ministerial:'⛪', Social:'🌐', Geral:'📋'
  };
  function emoji(area) { return EMOJI_AREA[area] || '📅'; }

  function urgColor(min) {
    if (min <  0) return '#1A4168'; // antes do horário — azul
    if (min <  5) return '#ca8a04'; // 0–5 min atraso — âmbar
    if (min < 10) return '#ea580c'; // 5–10 min — laranja
    return '#dc2626';               // 10+ min — vermelho
  }

  // ── Cartão de lembrete ──────────────────────────────────────────
  function showCard(item, lateMin) {
    if (document.getElementById('mv-ov')) return; // já visível

    const cor   = urgColor(lateMin);
    const tarde = lateMin > 0;

    const badgeHTML = tarde
      ? `<span class="mv-badge" style="background:#fee2e2;color:#dc2626;">⚠️ ${lateMin} min de atraso</span>`
      : `<span class="mv-badge" style="background:#dcfce7;color:#16a34a;">⏰ Começa em ${Math.max(1, -lateMin)} min</span>`;

    const ov = document.createElement('div');
    ov.id = 'mv-ov';
    ov.innerHTML = `
<style>
@keyframes mvIn{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}
@keyframes mvPulse{0%,100%{box-shadow:0 0 0 0 ${cor}55}60%{box-shadow:0 0 0 18px transparent}}
#mv-card{animation:mvPulse 2.2s infinite}
.mv-badge{display:inline-block;border-radius:9px;padding:5px 14px;font-size:.78rem;font-weight:700;margin-bottom:14px}
#mv-ov{position:fixed;inset:0;background:rgba(16,30,60,.93);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;animation:mvIn .3s ease}
#mv-card{background:#fff;border-radius:22px;padding:36px 30px;width:min(520px,96vw);text-align:center;border-top:7px solid ${cor};position:relative}
.mv-hora-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#94a3b8;margin-bottom:4px}
.mv-titulo{font-size:1.5rem;font-weight:800;color:#1A4168;line-height:1.2;margin-bottom:6px}
.mv-sub{font-size:.9rem;color:#64748b;margin-bottom:26px}
.mv-btn{width:100%;border:none;border-radius:13px;padding:15px;font-size:.97rem;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:9px;transition:opacity .15s}
.mv-btn:hover{opacity:.87}
.mv-btn-start{background:#16a34a;color:#fff}
.mv-btn-snooze{background:#f59e0b;color:#fff}
.mv-btn-cancel{background:#f8fafc;color:#dc2626;border:1px solid #fecaca!important}
#mv-snooze-form{display:none;margin-top:14px;background:#f8fafc;border-radius:12px;padding:14px;text-align:left}
#mv-snooze-form label{font-size:.75rem;font-weight:700;color:#1A4168;display:block;margin-bottom:8px}
.mv-inp{padding:9px 10px;border:1px solid #c0c8d0;border-radius:9px;font-family:inherit;font-size:.84rem;width:100%;box-sizing:border-box;margin-bottom:8px}
.mv-snooze-row{display:flex;gap:8px}
.mv-snooze-row input{flex:1}
</style>
<div id="mv-card">
  <div style="font-size:2.8rem;margin-bottom:8px">${emoji(item.area)}</div>
  ${badgeHTML}
  <div class="mv-hora-label">${item.hora}h · ${item.area || 'Geral'}</div>
  <div class="mv-titulo">${item.titulo}</div>
  <div style="margin-top:22px">
    <button class="mv-btn mv-btn-start"  id="mv-b1">▶&nbsp; Começar Agora</button>
    <button class="mv-btn mv-btn-snooze" id="mv-b2">⏰&nbsp; Adiar para outra hora</button>
    <button class="mv-btn mv-btn-cancel" id="mv-b3">✕&nbsp; Cancelar este compromisso</button>
  </div>
  <div id="mv-snooze-form">
    <label>Adiar para:</label>
    <div class="mv-snooze-row">
      <input type="date" id="mv-sd" class="mv-inp">
      <input type="time" id="mv-sh" class="mv-inp">
    </div>
    <button class="mv-btn mv-btn-start" id="mv-b4" style="margin-bottom:0">Confirmar Adiamento</button>
  </div>
</div>`;

    // Default adiar: +30 min
    const def = new Date(Date.now() + 30 * 60000);
    document.body.appendChild(ov);
    document.getElementById('mv-sd').value = def.toISOString().slice(0, 10);
    document.getElementById('mv-sh').value = def.toTimeString().slice(0, 5);

    document.getElementById('mv-b1').onclick = () => dismiss(item.id, 'comecar');
    document.getElementById('mv-b2').onclick = () => { document.getElementById('mv-snooze-form').style.display = 'block'; };
    document.getElementById('mv-b3').onclick = () => {
      if (confirm('Tem certeza que deseja cancelar este compromisso?')) dismiss(item.id, 'cancelar');
    };
    document.getElementById('mv-b4').onclick = () => {
      const nd = document.getElementById('mv-sd').value;
      const nh = document.getElementById('mv-sh').value;
      if (!nd || !nh) { alert('Informe data e hora.'); return; }
      const list = JSON.parse(localStorage.getItem('agenda_items') || '[]');
      list.push({ texto: item.titulo, data: nd, hora: nh, hora_fim: '', area: item.area, nota: '(Adiado)' });
      localStorage.setItem('agenda_items', JSON.stringify(list));
      dismiss(item.id, 'adiar');
      const dd = nd.split('-').reverse().join('/');
      alert(`✅ Adiado para ${nh}h de ${dd}`);
    };
  }

  function dismiss(id, acao) {
    const s = getState();
    if (s[id]) { s[id].dismissed = true; s[id].acao = acao; saveState(s); }
    const ov = document.getElementById('mv-ov');
    if (ov) ov.remove();
  }

  function refreshCard(lateMin) {
    const card = document.getElementById('mv-card');
    if (!card) return;
    card.style.borderTopColor = urgColor(lateMin);
    const badge = card.querySelector('.mv-badge');
    if (badge && lateMin > 0) {
      badge.style.background = '#fee2e2';
      badge.style.color = '#dc2626';
      badge.textContent = `⚠️ ${lateMin} min de atraso`;
    }
  }

  // ── Loop principal ──────────────────────────────────────────────
  function check() {
    cleanState();
    const now    = new Date();
    const hoje   = localDateStr(now);   // data LOCAL — respeita Itália/Dubai/Brasil
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const s      = getState();

    const candidatos = [];

    // ── Agenda Real (agenda_items) — únicos que geram alertas ──────
    // A Agenda Base (agenda_sem_base) é só referência, não gera alertas
    const agItems = JSON.parse(localStorage.getItem('agenda_items') || '[]');
    for (const it of agItems) {
      if (it.data !== hoje || !it.hora) continue;
      const id = `ag_${it.data}_${it.hora}_${it.texto}`.replace(/\s/g, '_').slice(0, 80);
      candidatos.push({ id, titulo: it.texto, hora: it.hora, area: it.area || 'Geral', min: horaToMin(it.hora) });
    }

    for (const item of candidatos) {
      const late    = nowMin - item.min;   // >0 = atrasado, <0 = falta X min
      const minLeft = -late;               // minutos que faltam (positivo antes)

      if (!s[item.id]) s[item.id] = { ts: Date.now(), shown: false, a0: false, a5: false, a10: false, a15: false, dismissed: false };
      const st = s[item.id];
      if (st.dismissed) continue;

      // Janela de exibição: 5 min antes até 60 min após
      if (minLeft <= WARN_BEFORE && late <= 60) {
        if (!st.shown) { st.shown = true; showCard(item, late); }
        else           { refreshCard(late); }
      }

      // Sequência de áudio
      if (late >= 0  && late <  2  && !st.a0)  { st.a0  = true; speak(`Celso, está na hora: ${item.titulo}`); }
      if (late >= 5  && late <  7  && !st.a5)  { st.a5  = true; speak(`Celso, você está 5 minutos atrasado para: ${item.titulo}`); }
      if (late >= 10 && late < 12  && !st.a10) { st.a10 = true; speak(`Celso, você está 10 minutos atrasado para: ${item.titulo}`); }
      if (late >= 15 && late < 17  && !st.a15) { st.a15 = true; speak(`Celso, você está 15 minutos atrasado para: ${item.titulo}`); }
    }

    saveState(s);
  }

  // ── Inicialização ───────────────────────────────────────────────
  function init() {
    if (window.speechSynthesis) {
      // "Aquece" a lista de vozes (Edge/Chrome carregam de forma assíncrona)
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
    }
    setInterval(check, CHECK_MS);
    setTimeout(check, 5000); // primeira verificação após 5s de carregamento
  }

  // Expõe função para limpar estado manualmente (útil para testes)
  window.mvLimparLembretes = function() {
    localStorage.removeItem(STATE_KEY);
    console.log('✅ Estado de lembretes limpo.');
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

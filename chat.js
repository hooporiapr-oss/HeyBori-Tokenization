// chat.js — Hoops.Money chat frontend with free/pro gating
// Anonymous users: 15 messages/day, then prompted to upgrade
// Pro users: unlimited (status stored in browser after Stripe redirect)

(function () {
  'use strict';

  const ENDPOINT = '/api/chat';
  const STORAGE_KEY = 'hoopsMoneyConversation';
  const LANG_KEY = 'hoopsMoneyLang';
  const ANON_ID_KEY = 'hoopsMoneyAnonId';
  const PRO_KEY = 'hoopsMoneyPro';
  const STRIPE_CHECKOUT_URL = 'https://buy.stripe.com/8x228sg0T0xw4og1Ue8Zq04';

  const messagesEl   = document.getElementById('messages');
  const inputEl      = document.getElementById('input');
  const sendBtn      = document.getElementById('send');
  const langEnBtn    = document.getElementById('lang-en');
  const langEsBtn    = document.getElementById('lang-es');
  const newChatBtn   = document.getElementById('newChat');
  const upgradeBtn   = document.getElementById('upgradeBtn');
  const proBadge     = document.getElementById('proBadge');
  const upgradeModal = document.getElementById('upgradeModal');

  if (!messagesEl || !inputEl || !sendBtn) {
    console.error('[Hoops.Money] Required markup missing.');
    return;
  }

  const I18N = {
    en: {
      placeholder: 'Ask about NIL, contracts, money, agents, taxes…',
      error: 'Something went wrong. Please try again.',
      networkError: "I couldn't reach the server. Check your connection.",
      clearConfirm: 'Start a new conversation? Your current chat will be cleared.',
      welcomeEyebrow: 'Educational · Independent · Neutral',
      welcomeTitle: 'The business of basketball — explained clearly.',
      welcomeSub: "Ask anything about NIL, financial literacy, contracts, agents, taxes, endorsements, and post-career planning. Straight answers. No hype. No selling. No sugar-coating bad deals. Built to help players, families, and coaches navigate the money side of the game.",
      topics: ['NIL Deals', 'Financial Literacy', 'Contracts', 'Agents', 'Taxes', 'Post-Career'],
      limitTitle: "You've reached today's free limit",
      limitBody: "You've used all 15 free messages for today. Upgrade to Pro for unlimited access — $9/month, cancel anytime.",
      upgradeCta: 'Upgrade to Pro',
      modalTitle: 'Hoops.Money Pro',
      modalSub: 'Unlimited messages. $9/month. Cancel anytime.',
      modalBenefit1: 'Unlimited daily messages',
      modalBenefit2: 'Priority access',
      modalBenefit3: 'Support independent basketball education',
      modalClose: 'Maybe later',
      modalCta: 'Upgrade — $9/month',
      proActive: 'Pro',
      proWelcome: "You're Pro. Unlimited access is active. Thanks for supporting Hoops.Money.",
      upgradeNavLabel: 'Upgrade'
    },
    es: {
      placeholder: 'Pregunta sobre NIL, contratos, dinero, agentes, impuestos…',
      error: 'Algo salió mal. Intenta de nuevo.',
      networkError: 'No pude conectar con el servidor. Revisa tu conexión.',
      clearConfirm: '¿Comenzar una nueva conversación? Tu chat actual será borrado.',
      welcomeEyebrow: 'Educativo · Independiente · Neutral',
      welcomeTitle: 'El negocio del baloncesto — explicado con claridad.',
      welcomeSub: 'Pregunta lo que quieras sobre NIL, educación financiera, contratos, agentes, impuestos, patrocinios y planificación post-carrera. Respuestas directas. Sin hype. Sin venderte nada. Sin endulzar malos acuerdos. Construido para ayudar a jugadores, familias y entrenadores a navegar el lado financiero del juego.',
      topics: ['Acuerdos NIL', 'Educación Financiera', 'Contratos', 'Agentes', 'Impuestos', 'Post-Carrera'],
      limitTitle: 'Alcanzaste el límite gratis de hoy',
      limitBody: 'Has usado los 15 mensajes gratis del día. Pásate a Pro para acceso ilimitado — $9/mes, cancela cuando quieras.',
      upgradeCta: 'Pásate a Pro',
      modalTitle: 'Hoops.Money Pro',
      modalSub: 'Mensajes ilimitados. $9/mes. Cancela cuando quieras.',
      modalBenefit1: 'Mensajes ilimitados todos los días',
      modalBenefit2: 'Acceso prioritario',
      modalBenefit3: 'Apoya la educación independiente del baloncesto',
      modalClose: 'Después',
      modalCta: 'Pásate a Pro — $9/mes',
      proActive: 'Pro',
      proWelcome: 'Eres Pro. Acceso ilimitado activo. Gracias por apoyar a Hoops.Money.',
      upgradeNavLabel: 'Pro'
    }
  };

  let history = [];
  let conversationStarted = false;
  let isSending = false;

  // ── ANONYMOUS ID ──────────────────────────────────────────────
  function getOrCreateAnonId() {
    try {
      let id = localStorage.getItem(ANON_ID_KEY);
      if (!id) {
        id = 'anon_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(ANON_ID_KEY, id);
      }
      return id;
    } catch {
      return 'anon_fallback_' + Date.now();
    }
  }

  // ── PRO STATUS ────────────────────────────────────────────────
  function isPro() {
    try {
      return localStorage.getItem(PRO_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function setPro(val) {
    try {
      if (val) localStorage.setItem(PRO_KEY, 'true');
      else localStorage.removeItem(PRO_KEY);
    } catch {}
    updateProUI();
  }

  function updateProUI() {
    const pro = isPro();
    if (proBadge) proBadge.style.display = pro ? 'inline-flex' : 'none';
    if (upgradeBtn) upgradeBtn.style.display = pro ? 'none' : 'inline-flex';
  }

  // Detect Stripe redirect on page load
  function checkStripeRedirect() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('upgraded') === 'true') {
      setPro(true);
      // Clean the URL so the flag doesn't persist
      window.history.replaceState({}, document.title, window.location.pathname);
      // Show a brief Pro welcome
      setTimeout(() => {
        addMessage('assistant', I18N[currentLang()].proWelcome, { store: false });
      }, 400);
    }
  }

  // ── LANGUAGE ──────────────────────────────────────────────────
  function currentLang() {
    try {
      return localStorage.getItem(LANG_KEY) === 'es' ? 'es' : 'en';
    } catch {
      return 'en';
    }
  }

  function setLang(lang) {
    try { localStorage.setItem(LANG_KEY, lang); } catch {}

    document.querySelectorAll('[data-lang]').forEach(el => {
      el.classList.toggle('show', el.dataset.lang === lang);
    });

    if (langEnBtn) langEnBtn.classList.toggle('active', lang === 'en');
    if (langEsBtn) langEsBtn.classList.toggle('active', lang === 'es');

    document.documentElement.lang = lang === 'es' ? 'es' : 'en';
    inputEl.placeholder = I18N[lang].placeholder;

    if (!conversationStarted) renderWelcome();
  }

  // ── PERSISTENCE ───────────────────────────────────────────────
  function saveConversation() {
    try {
      if (history.length === 0) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {}
  }

  function loadConversation() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(m =>
        m && (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.length > 0
      );
    } catch {
      return [];
    }
  }

  // ── RENDERING ─────────────────────────────────────────────────
  function renderWelcome() {
    messagesEl.innerHTML = '';
    const t = I18N[currentLang()];

    const wrap = document.createElement('div');
    wrap.className = 'welcome';

    const eyebrow = document.createElement('div');
    eyebrow.className = 'welcome-eyebrow';
    eyebrow.textContent = t.welcomeEyebrow;

    const title = document.createElement('h1');
    title.className = 'welcome-title';
    title.innerHTML = t.welcomeTitle.replace(
      /basketball|baloncesto/i,
      match => `<span class="accent">${match}</span>`
    );

    const sub = document.createElement('p');
    sub.className = 'welcome-sub';
    sub.textContent = t.welcomeSub;

    const topics = document.createElement('div');
    topics.className = 'welcome-topics';
    t.topics.forEach(topic => {
      const chip = document.createElement('span');
      chip.className = 'topic-chip';
      chip.textContent = topic;
      topics.appendChild(chip);
    });

    wrap.appendChild(eyebrow);
    wrap.appendChild(title);
    wrap.appendChild(sub);
    wrap.appendChild(topics);
    messagesEl.appendChild(wrap);
  }

  function renderMessage(role, content, isError) {
    const el = document.createElement('div');
    el.className = 'msg ' + (isError ? 'error' : (role === 'user' ? 'user' : 'bori'));
    el.textContent = content;
    messagesEl.appendChild(el);
  }

  function renderLimitMessage() {
    const t = I18N[currentLang()];
    const wrap = document.createElement('div');
    wrap.className = 'msg bori limit-notice';

    const title = document.createElement('div');
    title.className = 'limit-title';
    title.textContent = t.limitTitle;

    const body = document.createElement('div');
    body.className = 'limit-body';
    body.textContent = t.limitBody;

    const btn = document.createElement('button');
    btn.className = 'limit-upgrade-btn';
    btn.type = 'button';
    btn.textContent = t.upgradeCta;
    btn.addEventListener('click', openUpgradeModal);

    wrap.appendChild(title);
    wrap.appendChild(body);
    wrap.appendChild(btn);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function startConversation() {
    if (conversationStarted) return;
    conversationStarted = true;
    messagesEl.innerHTML = '';
  }

  function addMessage(role, content, opts) {
    opts = opts || {};
    const store = opts.store !== false;
    const isError = !!opts.isError;

    renderMessage(role, content, isError);
    scrollToBottom();

    if (store && (role === 'user' || role === 'assistant')) {
      history.push({ role, content });
      saveConversation();
    }
  }

  function showTyping() {
    const el = document.createElement('div');
    el.className = 'typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function setSending(state) {
    isSending = state;
    sendBtn.disabled = state;
    inputEl.disabled = state;
    if (newChatBtn) newChatBtn.disabled = state;
  }

  function restoreConversation() {
    const saved = loadConversation();
    if (saved.length === 0) {
      renderWelcome();
      return;
    }
    history = saved;
    conversationStarted = true;
    messagesEl.innerHTML = '';
    history.forEach(m => renderMessage(m.role, m.content, false));
    scrollToBottom();
  }

  function clearConversation() {
    if (isSending) return;
    if (history.length > 0) {
      const ok = window.confirm(I18N[currentLang()].clearConfirm);
      if (!ok) return;
    }
    history = [];
    saveConversation();
    conversationStarted = false;
    renderWelcome();
    inputEl.focus();
  }

  // ── UPGRADE MODAL ─────────────────────────────────────────────
  function openUpgradeModal() {
    if (upgradeModal) upgradeModal.classList.add('show');
  }

  function closeUpgradeModal() {
    if (upgradeModal) upgradeModal.classList.remove('show');
  }

  function goToCheckout() {
    // Pass the anon ID so we can link it to the Stripe session later if needed
    const anonId = getOrCreateAnonId();
    window.location.href = STRIPE_CHECKOUT_URL + '?client_reference_id=' + encodeURIComponent(anonId);
  }

  // ── API CALL ──────────────────────────────────────────────────
  async function fetchReply() {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history,
        language: currentLang(),
        isPro: isPro(),
        anonId: getOrCreateAnonId()
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (data && data.limitReached) {
        const err = new Error('LIMIT_REACHED');
        err.limitReached = true;
        throw err;
      }
      throw new Error(data.error || 'Request failed (' + res.status + ')');
    }

    if (!data || typeof data.reply !== 'string') {
      throw new Error('Malformed response from server.');
    }
    return data.reply;
  }

  async function handleSend() {
    if (isSending) return;
    const text = (inputEl.value || '').trim();
    if (!text) return;

    startConversation();
    addMessage('user', text);
    inputEl.value = '';
    autoResize();

    setSending(true);
    const typing = showTyping();

    try {
      const reply = await fetchReply();
      if (typing) typing.remove();
      addMessage('assistant', reply);
    } catch (err) {
      if (typing) typing.remove();
      if (err.limitReached) {
        // Remove the user message we just added since it wasn't processed
        // Actually — keep it, just show the upgrade block
        renderLimitMessage();
        setTimeout(openUpgradeModal, 600);
      } else {
        console.error('[Hoops.Money] send failed:', err);
        const t = I18N[currentLang()];
        const msg = /fetch|network|failed to fetch/i.test(err.message || '') ? t.networkError : t.error;
        addMessage('assistant', msg, { store: false, isError: true });
      }
    } finally {
      setSending(false);
      inputEl.focus();
    }
  }

  function autoResize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  }

  inputEl.addEventListener('input', autoResize);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  sendBtn.addEventListener('click', handleSend);

  if (langEnBtn) langEnBtn.addEventListener('click', () => setLang('en'));
  if (langEsBtn) langEsBtn.addEventListener('click', () => setLang('es'));
  if (newChatBtn) newChatBtn.addEventListener('click', clearConversation);
  if (upgradeBtn) upgradeBtn.addEventListener('click', openUpgradeModal);

  // Modal wiring
  if (upgradeModal) {
    const closeBtn = upgradeModal.querySelector('[data-modal-close]');
    const ctaBtn = upgradeModal.querySelector('[data-modal-cta]');
    const backdrop = upgradeModal.querySelector('.modal-backdrop');
    if (closeBtn) closeBtn.addEventListener('click', closeUpgradeModal);
    if (backdrop) backdrop.addEventListener('click', closeUpgradeModal);
    if (ctaBtn) ctaBtn.addEventListener('click', goToCheckout);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeUpgradeModal();
    });
  }

  function init() {
    getOrCreateAnonId();
    updateProUI();
    checkStripeRedirect();
    setLang(currentLang());
    restoreConversation();
    autoResize();
    if (window.matchMedia('(min-width: 700px)').matches) inputEl.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

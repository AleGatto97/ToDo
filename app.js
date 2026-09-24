/**
 * TODO UNIFI - TO-DO LIST APPLICATION
 * ============================================================================
 * Architettura dati (Progetto -> Attività -> Task) sincronizzata in tempo reale
 * tramite Firebase Realtime Database.
 *
 *   Progetto (livello 1)      ordinabile via drag & drop (maniglia)
 *     |- Task dirette         ordinate per priorità decrescente
 *     |- Attività (livello 2) ordinabile via drag & drop (dentro il progetto)
 *          |- Task            ordinate per priorità decrescente
 *
 * Il salvataggio è sempre locale (localStorage) + remoto (Firebase) quando
 * configurato. Le scritture remote sono granulari: si scrive solo il campo
 * modificato, non tutto l'albero. Così due dispositivi che modificano cose
 * diverse non si sovrascrivono a vicenda.
 * ============================================================================
 */

/* ===========================================================================
   >>> CONFIGURAZIONE CLOUD <<<
   Questi valori possono stare tranquillamente in un repository pubblico: non
   sono segreti. Google li progetta per stare nel codice del browser, e quello
   che protegge davvero i dati e la password dell'utenza più le regole di
   sicurezza del database (".read": "auth != null").
   L'unica cosa da non scrivere mai qui dentro è la password.
   Istruzioni complete: vedi README.md
   =========================================================================== */
const FIREBASE_DEFAULTS = {
  // Da Firebase: Impostazioni progetto -> Le tue app -> App web
  apiKey: 'AIzaSyA1HpiJjTTbTBuhPsI4PPCG7RvsciN1Xx0',
  authDomain: 'todo-unifi.firebaseapp.com',

  databaseURL: 'https://todo-unifi-default-rtdb.europe-west1.firebasedatabase.app',

  // Contenitore dei dati dentro il database. Se lo cambi, aggiorna anche le
  // regole di sicurezza su Firebase o la sincronizzazione si blocca.
  workspaceKey: 'gatto-n51m791ngms786j3sfn8',

  // Identificativo tecnico dell'utenza, non una casella di posta vera: serve
  // solo perché Firebase pretende un'email. Non riceve e non invia nulla, e
  // l'app lo compila da sola (all'accesso digiti solo la password).
  // Deve essere identico all'utente creato in Firebase -> Authentication.
  authEmail: 'todo-unifi@todo-unifi.app'
};

// Versioni dell'SDK Firebase da provare, in ordine. La prima che si carica vince:
// se una versione venisse ritirata dalla CDN, l'app ripiega sulla successiva
// invece di restare senza sincronizzazione.
const FIREBASE_SDK_VERSIONS = ['12.19.0', '11.10.0', '10.14.1'];

(function () {
  'use strict';

  // ==========================================================================
  // COSTANTI E STATO
  // ==========================================================================
  const STORAGE_KEY = 'todo_unifi_workspace_v3';
  const LEGACY_STORAGE_KEY = 'todo_unifi_workspace_v2';
  const CLOUD_CONFIG_KEY = 'todo_unifi_cloud_config_v3';

  const ORDER_STEP = 1000;
  const ORDER_MIN_GAP = 0.0001;
  const TASK_DELETION_MS = 5000;

  const PRIORITIES = {
    5: { name: 'Estrema', class: 'dot-extreme', priorityClass: 'priority-5' },
    4: { name: 'Alta', class: 'dot-high', priorityClass: 'priority-4' },
    3: { name: 'Media', class: 'dot-medium', priorityClass: 'priority-3' },
    2: { name: 'Bassa', class: 'dot-low', priorityClass: 'priority-2' },
    1: { name: 'In attesa', class: 'dot-waiting', priorityClass: 'priority-1' }
  };

  /** Stato applicativo. projects è un OGGETTO indicizzato per id (non un array). */
  let state = { projects: {} };

  let cloudConfig = {
    apiKey: FIREBASE_DEFAULTS.apiKey || '',
    authDomain: FIREBASE_DEFAULTS.authDomain || '',
    databaseURL: FIREBASE_DEFAULTS.databaseURL || '',
    workspaceKey: FIREBASE_DEFAULTS.workspaceKey || 'workspace-unifi',
    authEmail: FIREBASE_DEFAULTS.authEmail || ''
  };

  /** Handle Firebase: { app, db, auth, m, authM, unsubData, unsubConn, unsubAuth } */
  let fb = null;
  let lastSyncAt = null;
  let currentUser = null;

  /** Timer di cancellazione automatica delle task completate. */
  const deletionTimers = new Map(); // taskId -> { timeoutId, startedAt }

  /** Lock di rendering: evita che un aggiornamento remoto distrugga un input aperto. */
  let renderLocked = false;
  let renderPending = false;

  let pendingDeleteProjectId = null;

  // ==========================================================================
  // UTILITY
  // ==========================================================================
  function genId() {
    return 'id_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);
  }

  function sanitizeKey(k) {
    return String(k || '').trim().replace(/[.#$\[\]\/\s]+/g, '-') || 'workspace-unifi';
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  const byOrder = (a, b) =>
    (num(a.order, 0) - num(b.order, 0)) || String(a.id).localeCompare(String(b.id));

  const byPriority = (a, b) =>
    (num(b.priority, 1) - num(a.priority, 1)) ||
    (num(a.createdAt, 0) - num(b.createdAt, 0)) ||
    String(a.id).localeCompare(String(b.id));

  function projectList() {
    return Object.values(state.projects || {}).sort(byOrder);
  }

  function activityList(project) {
    return Object.values((project && project.activities) || {}).sort(byOrder);
  }

  function taskList(owner) {
    return Object.values((owner && owner.tasks) || {}).sort(byPriority);
  }

  function nextOrder(list) {
    return list.length ? num(list[list.length - 1].order, 0) + ORDER_STEP : ORDER_STEP;
  }

  function orderBetween(prev, next) {
    if (!prev && !next) return ORDER_STEP;
    if (!prev) return num(next.order, ORDER_STEP) - ORDER_STEP;
    if (!next) return num(prev.order, 0) + ORDER_STEP;
    return (num(prev.order, 0) + num(next.order, 0)) / 2;
  }

  // ==========================================================================
  // NORMALIZZAZIONE E MIGRAZIONE DEI DATI
  // ==========================================================================

  /** Porta qualsiasi payload (locale, remoto, importato) nella forma canonica. */
  function normalize(raw) {
    const out = { projects: {} };
    if (!raw) return out;

    // Formato legacy v2: projects come array
    if (Array.isArray(raw.projects)) return migrateLegacy(raw);

    const projects = raw.projects || {};
    Object.keys(projects).forEach((pid, pi) => {
      const p = projects[pid] || {};
      const project = {
        id: p.id || pid,
        name: String(p.name || 'Senza nome'),
        order: num(p.order, (pi + 1) * ORDER_STEP),
        tasks: {},
        activities: {}
      };

      const ptasks = p.tasks || {};
      Object.keys(ptasks).forEach((tid) => {
        const t = normalizeTask(ptasks[tid], tid);
        if (t) project.tasks[t.id] = t;
      });

      const acts = p.activities || {};
      Object.keys(acts).forEach((aid, ai) => {
        const a = acts[aid] || {};
        const activity = {
          id: a.id || aid,
          name: String(a.name || 'Senza nome'),
          order: num(a.order, (ai + 1) * ORDER_STEP),
          tasks: {}
        };
        const atasks = a.tasks || {};
        Object.keys(atasks).forEach((tid) => {
          const t = normalizeTask(atasks[tid], tid);
          if (t) activity.tasks[t.id] = t;
        });
        project.activities[activity.id] = activity;
      });

      out.projects[project.id] = project;
    });

    return out;
  }

  function normalizeTask(t, fallbackId) {
    if (!t || typeof t !== 'object') return null;
    const priority = Math.min(5, Math.max(1, Math.round(num(t.priority, 1))));
    return {
      id: t.id || fallbackId || genId(),
      name: String(t.name || ''),
      priority: priority,
      completed: !!t.completed,
      createdAt: num(t.createdAt, 0)
    };
  }

  /** Converte il vecchio formato ad array nel nuovo formato a chiavi + order. */
  function migrateLegacy(legacy) {
    const out = { projects: {} };
    (legacy.projects || []).forEach((p, pi) => {
      const pid = p.id || genId();
      const project = {
        id: pid,
        name: String(p.name || 'Senza nome'),
        order: (pi + 1) * ORDER_STEP,
        tasks: {},
        activities: {}
      };
      (p.tasks || []).forEach((t, ti) => {
        const tid = t.id || genId();
        project.tasks[tid] = {
          id: tid,
          name: String(t.name || ''),
          priority: Math.min(5, Math.max(1, Math.round(num(t.priority, 1)))),
          completed: !!t.completed,
          createdAt: num(t.createdAt, Date.now() + ti)
        };
      });
      (p.activities || []).forEach((a, ai) => {
        const aid = a.id || genId();
        const activity = {
          id: aid,
          name: String(a.name || 'Senza nome'),
          order: (ai + 1) * ORDER_STEP,
          tasks: {}
        };
        (a.tasks || []).forEach((t, ti) => {
          const tid = t.id || genId();
          activity.tasks[tid] = {
            id: tid,
            name: String(t.name || ''),
            priority: Math.min(5, Math.max(1, Math.round(num(t.priority, 1)))),
            completed: !!t.completed,
            createdAt: num(t.createdAt, Date.now() + ti)
          };
        });
        project.activities[aid] = activity;
      });
      out.projects[pid] = project;
    });
    return out;
  }

  /** Firebase scarta gli oggetti vuoti: li rimuoviamo prima di inviare. */
  function stripEmpty(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach((k) => {
        const v = stripEmpty(value[k]);
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return;
        out[k] = v;
      });
      return out;
    }
    return value;
  }

  // ==========================================================================
  // PERSISTENZA LOCALE
  // ==========================================================================
  function loadLocal() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        state = normalize(JSON.parse(saved));
        return true;
      }
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        state = normalize(JSON.parse(legacy));
        saveLocal();
        return true;
      }
    } catch (e) {
      console.error('Errore nel caricamento locale', e);
    }
    return false;
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Errore nel salvataggio locale', e);
    }
  }

  function loadCloudConfig() {
    try {
      const saved = localStorage.getItem(CLOUD_CONFIG_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        cloudConfig = {
          apiKey: String(parsed.apiKey || FIREBASE_DEFAULTS.apiKey || '').trim(),
          authDomain: String(parsed.authDomain || FIREBASE_DEFAULTS.authDomain || '').trim(),
          databaseURL: String(parsed.databaseURL || FIREBASE_DEFAULTS.databaseURL || '').trim(),
          workspaceKey: sanitizeKey(parsed.workspaceKey || FIREBASE_DEFAULTS.workspaceKey),
          authEmail: String(parsed.authEmail || FIREBASE_DEFAULTS.authEmail || '').trim()
        };
      }
    } catch (e) {
      console.error('Errore nel caricamento della configurazione cloud', e);
    }
  }

  function saveCloudConfig() {
    try {
      localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(cloudConfig));
    } catch (e) {
      console.error('Errore nel salvataggio della configurazione cloud', e);
    }
  }

  function createDemoData() {
    const pid = genId();
    const aid = genId();
    const now = Date.now();
    state = {
      projects: {
        [pid]: {
          id: pid,
          name: 'PROGETTI ACCADEMICI & LAVORO',
          order: ORDER_STEP,
          tasks: {},
          activities: {
            [aid]: {
              id: aid,
              name: 'Pianificazione',
              order: ORDER_STEP,
              tasks: {}
            }
          }
        }
      }
    };
    const t1 = genId();
    state.projects[pid].tasks[t1] = {
      id: t1, name: 'Inviare mail di conferma docente', priority: 5, completed: false, createdAt: now
    };
    const t2 = genId();
    const t3 = genId();
    state.projects[pid].activities[aid].tasks[t2] = {
      id: t2, name: 'Concludere report di laboratorio', priority: 4, completed: false, createdAt: now + 1
    };
    state.projects[pid].activities[aid].tasks[t3] = {
      id: t3, name: 'Revisione presentazioni e slides', priority: 3, completed: false, createdAt: now + 2
    };
    saveLocal();
  }

  // ==========================================================================
  // MOTORE DI SINCRONIZZAZIONE (Firebase Realtime Database)
  // ==========================================================================
  function rootPath() {
    return 'workspaces/' + sanitizeKey(cloudConfig.workspaceKey);
  }

  function cloudEnabled() {
    return !!(cloudConfig.databaseURL && cloudConfig.databaseURL.trim());
  }

  /** Cosa manca alla configurazione, se manca qualcosa. */
  function missingCloudConfig() {
    const missing = [];
    if (!cloudConfig.apiKey) missing.push('apiKey');
    if (!cloudConfig.authDomain) missing.push('authDomain');
    if (!cloudConfig.authEmail) missing.push('authEmail');
    return missing;
  }

  const SDK_ATTEMPT_TIMEOUT_MS = 8000;
  const SDK_TOTAL_TIMEOUT_MS = 20000;

  function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ': tempo scaduto')), ms);
      })
    ]);
  }

  /**
   * Carica l'SDK dalla CDN provando le versioni in ordine, con un tetto di
   * tempo: senza rete l'utente non deve restare davanti a "Verifica accesso"
   * finche tutti i tentativi non scadono uno dopo l'altro.
   */
  async function loadFirebaseSdk() {
    const deadline = Date.now() + SDK_TOTAL_TIMEOUT_MS;
    let lastError = null;

    for (let i = 0; i < FIREBASE_SDK_VERSIONS.length; i++) {
      const budget = Math.min(SDK_ATTEMPT_TIMEOUT_MS, deadline - Date.now());
      if (budget <= 0) break;

      const base = 'https://www.gstatic.com/firebasejs/' + FIREBASE_SDK_VERSIONS[i] + '/';
      try {
        const mods = await withTimeout(
          Promise.all([
            import(base + 'firebase-app.js'),
            import(base + 'firebase-database.js'),
            import(base + 'firebase-auth.js')
          ]),
          budget,
          'SDK ' + FIREBASE_SDK_VERSIONS[i]
        );
        return { appMod: mods[0], dbMod: mods[1], authMod: mods[2] };
      } catch (e) {
        lastError = e;
        console.warn('SDK Firebase ' + FIREBASE_SDK_VERSIONS[i] + ' non caricato, provo la versione successiva.');
      }
    }

    throw new Error(
      'SDK Firebase non raggiungibile (' + (lastError && lastError.message ? lastError.message : 'errore di rete') + ')'
    );
  }

  async function initCloud() {
    await teardownCloud();

    if (!cloudEnabled()) {
      hideAuthGate();
      setSyncStatus('local');
      return;
    }

    const missing = missingCloudConfig();
    if (missing.length) {
      hideAuthGate();
      setSyncStatus('error', 'Configurazione incompleta: manca ' + missing.join(', ') + '.');
      return;
    }

    setSyncStatus('connecting');

    try {
      const { appMod, dbMod, authMod } = await loadFirebaseSdk();

      const app = appMod.initializeApp(
        {
          apiKey: cloudConfig.apiKey.trim(),
          authDomain: cloudConfig.authDomain.trim(),
          databaseURL: cloudConfig.databaseURL.trim()
        },
        'todo-unifi-' + Date.now()
      );
      const db = dbMod.getDatabase(app);
      const auth = authMod.getAuth(app);

      fb = { app, db, auth, m: dbMod, authM: authMod, appMod };

      // La sessione resta salvata nel browser: si accede una volta per
      // dispositivo, poi anche senza rete l'app si apre già autenticata.
      try {
        await authMod.setPersistence(auth, authMod.browserLocalPersistence);
      } catch (e) {
        console.warn('Persistenza della sessione non impostabile', e);
      }

      fb.unsubAuth = authMod.onAuthStateChanged(auth, (user) => {
        currentUser = user || null;
        if (user) {
          hideAuthGate();
          attachCloudListeners();
        } else {
          detachCloudListeners();
          setSyncStatus('locked');
          showAuthGate();
        }
        updateCloudModalStatus();
      });
    } catch (e) {
      console.error('Inizializzazione Firebase fallita', e);
      fb = null;
      hideAuthGate();
      setSyncStatus('error', e && e.message ? e.message : String(e));
    }
  }

  async function teardownCloud() {
    if (!fb) return;
    try {
      detachCloudListeners();
      if (fb.unsubAuth) fb.unsubAuth();
      if (fb.appMod && fb.appMod.deleteApp) await fb.appMod.deleteApp(fb.app);
    } catch (e) {
      console.warn('Chiusura connessione cloud', e);
    }
    fb = null;
    currentUser = null;
  }

  function detachCloudListeners() {
    if (!fb) return;
    if (fb.unsubData) { fb.unsubData(); fb.unsubData = null; }
    if (fb.unsubConn) { fb.unsubConn(); fb.unsubConn = null; }
  }

  function attachCloudListeners() {
    const { ref, onValue } = fb.m;
    detachCloudListeners();

    fb.unsubConn = onValue(ref(fb.db, '.info/connected'), (snap) => {
      setSyncStatus(snap.val() ? 'online' : 'offline');
    });

    fb.unsubData = onValue(
      ref(fb.db, rootPath()),
      (snap) => {
        const val = snap.val();
        lastSyncAt = Date.now();

        if (val === null || !val.projects) {
          // Il nodo remoto e vuoto: ci carichiamo dentro lo stato locale.
          if (Object.keys(state.projects).length > 0) pushFullState();
          return;
        }

        state = normalize(val);
        saveLocal();
        pruneDeletionTimers();
        scheduleRender();
        refreshSyncTitle();
      },
      (err) => {
        console.error('Lettura dal cloud fallita', err);
        setSyncStatus('error', err && err.message ? err.message : String(err));
      }
    );
  }

  // ==========================================================================
  // ACCESSO CON PASSWORD
  // ==========================================================================

  /** Messaggi leggibili per i codici di errore di Firebase Auth. */
  function authErrorMessage(code) {
    switch (code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/invalid-login-credentials':
        return 'Password errata.';
      case 'auth/user-not-found':
        return "Utenza inesistente: creala in Firebase, sezione Authentication.";
      case 'auth/invalid-email':
        return "L'identificativo dell'utenza non è valido (authEmail in app.js).";
      case 'auth/too-many-requests':
        return 'Troppi tentativi falliti. Riprova fra qualche minuto.';
      case 'auth/network-request-failed':
        return 'Nessuna connessione: riprova quando torni online.';
      case 'auth/operation-not-allowed':
        return "Su Firebase non è attivo l'accesso con email e password.";
      case 'auth/api-key-not-valid':
      case 'auth/invalid-api-key':
        return 'apiKey mancante o errata in app.js.';
      default:
        return null;
    }
  }

  /**
   * @param {'form'|'checking'} mode  'checking' evita che la schermata di
   * accesso lampeggi mentre si verifica una sessione già salvata.
   */
  function showAuthGate(mode) {
    const gate = document.getElementById('auth-gate');
    if (!gate) return;

    const checking = mode === 'checking';
    gate.classList.remove('hidden');
    gate.classList.toggle('auth-checking', checking);

    const form = document.getElementById('form-auth');
    if (form) form.classList.toggle('hidden', checking);

    setAuthError('');
    if (checking) return;

    const field = document.getElementById('auth-password');
    if (field) {
      field.value = '';
      setTimeout(() => field.focus(), 80);
    }
  }

  function hideAuthGate() {
    const gate = document.getElementById('auth-gate');
    if (gate) gate.classList.add('hidden');
  }

  function setAuthError(message) {
    const el = document.getElementById('auth-error');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  function setAuthBusy(busy) {
    const btn = document.getElementById('auth-submit');
    const field = document.getElementById('auth-password');
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? 'Accesso in corso...' : 'Entra';
    }
    if (field) field.disabled = busy;
  }

  async function signIn(password) {
    if (!fb || !fb.auth) {
      setAuthError('Connessione a Firebase non disponibile.');
      return;
    }
    if (!password) {
      setAuthError('Inserisci la password.');
      return;
    }

    setAuthBusy(true);
    setAuthError('');
    try {
      await fb.authM.signInWithEmailAndPassword(fb.auth, cloudConfig.authEmail, password);
      // onAuthStateChanged chiude il pannello e aggancia i listener.
    } catch (e) {
      const code = e && e.code ? e.code : '';
      setAuthError(authErrorMessage(code) || ('Accesso non riuscito (' + (code || e.message) + ').'));
      const field = document.getElementById('auth-password');
      if (field) { field.value = ''; field.focus(); }
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOutUser() {
    if (!fb || !fb.auth) return;
    try {
      await fb.authM.signOut(fb.auth);
      toast('Uscita effettuata su questo dispositivo.', 'info');
    } catch (e) {
      toast('Uscita non riuscita: ' + (e && e.message ? e.message : e), 'error');
    }
  }

  /** Invia un update multi-path relativo alla radice del workspace. */
  function push(updates) {
    if (!fb || !currentUser || !updates || Object.keys(updates).length === 0) return;
    const { ref, update } = fb.m;
    const payload = Object.assign({}, updates, { updatedAt: Date.now() });
    update(ref(fb.db, rootPath()), payload)
      .then(() => { lastSyncAt = Date.now(); refreshSyncTitle(); })
      .catch((e) => {
        console.error('Scrittura sul cloud fallita', e);
        setSyncStatus('error', e && e.message ? e.message : String(e));
        toast('Modifica salvata solo in locale: scrittura cloud rifiutata.', 'error');
      });
  }

  function pushFullState() {
    if (!fb || !currentUser) return;
    const { ref, set } = fb.m;
    set(ref(fb.db, rootPath()), {
      projects: stripEmpty(state.projects),
      updatedAt: Date.now()
    })
      .then(() => { lastSyncAt = Date.now(); refreshSyncTitle(); })
      .catch((e) => {
        console.error('Caricamento iniziale sul cloud fallito', e);
        setSyncStatus('error', e && e.message ? e.message : String(e));
      });
  }

  /**
   * Applica una modifica: prima in locale (istantanea), poi verso il cloud.
   * @param {Function} localFn  muta lo stato in memoria
   * @param {Object}   updates  path relativi -> valore (null per cancellare)
   */
  function mutate(localFn, updates) {
    if (localFn) localFn();
    saveLocal();
    render();
    push(updates);
  }

  // ==========================================================================
  // BADGE DI STATO SINCRONIZZAZIONE
  // ==========================================================================
  const SYNC_LABELS = {
    local: { text: 'Solo locale', cls: 'sync-local' },
    connecting: { text: 'Connessione...', cls: 'sync-connecting' },
    locked: { text: 'Accesso richiesto', cls: 'sync-connecting' },
    online: { text: 'Sincronizzato', cls: 'sync-online' },
    offline: { text: 'Offline', cls: 'sync-offline' },
    error: { text: 'Errore sync', cls: 'sync-error' }
  };

  let syncStatus = 'local';
  let syncDetail = '';

  function setSyncStatus(status, detail) {
    syncStatus = status;
    syncDetail = detail || '';
    const badge = document.getElementById('sync-status-badge');
    const text = document.getElementById('sync-status-text');
    if (!badge || !text) return;
    const meta = SYNC_LABELS[status] || SYNC_LABELS.local;
    badge.className = 'sync-badge ' + meta.cls;
    text.textContent = meta.text;
    refreshSyncTitle();
  }

  function refreshSyncTitle() {
    const badge = document.getElementById('sync-status-badge');
    if (!badge) return;
    const parts = [];
    if (syncStatus === 'local') {
      parts.push('Nessun cloud configurato: i dati restano su questo dispositivo.');
    } else {
      parts.push('Workspace: ' + sanitizeKey(cloudConfig.workspaceKey));
      if (lastSyncAt) parts.push('Ultimo scambio: ' + new Date(lastSyncAt).toLocaleTimeString('it-IT'));
      if (syncStatus === 'offline') parts.push('Le modifiche verranno inviate al ritorno della rete.');
    }
    if (syncDetail) parts.push(syncDetail);
    badge.title = parts.join('\n');
  }

  // ==========================================================================
  // TOAST
  // ==========================================================================
  function toast(message, type) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.setAttribute('role', 'status');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-out');
      setTimeout(() => el.remove(), 250);
    }, 3200);
  }

  // ==========================================================================
  // RENDER
  // ==========================================================================
  function scheduleRender() {
    render();
  }

  function render() {
    if (renderLocked || dragState.active) {
      renderPending = true;
      return;
    }
    renderPending = false;

    const container = document.getElementById('projects-container');
    const emptyState = document.getElementById('empty-state');
    if (!container) return;

    container.innerHTML = '';

    const projects = projectList();
    if (projects.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }
    emptyState.classList.add('hidden');

    projects.forEach((project) => container.appendChild(buildProjectCard(project)));
  }

  function releaseRenderLock() {
    renderLocked = false;
    if (renderPending) render();
  }

  function icon(paths, size, width) {
    return (
      '<svg width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="' + (width || 2) + '" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'
    );
  }

  const ICONS = {
    grip:
      '<circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="12" r="1"></circle>' +
      '<circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="5" r="1"></circle>' +
      '<circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="19" r="1"></circle>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
    trash:
      '<polyline points="3 6 5 6 21 6"></polyline>' +
      '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>',
    close: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'
  };

  function buildProjectCard(project) {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.dataset.projectId = project.id;

    // ---- Header -------------------------------------------------------
    const header = document.createElement('div');
    header.className = 'project-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'project-title-group';

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'drag-handle project-drag-handle';
    handle.title = 'Trascina per riordinare i progetti';
    handle.setAttribute('aria-label', 'Riordina progetto ' + project.name);
    handle.innerHTML = icon(ICONS.grip, 18);
    bindDragHandle(handle, { type: 'project', id: project.id, element: card });

    const title = document.createElement('h2');
    title.className = 'project-title editable';
    title.textContent = project.name.toUpperCase();
    title.title = 'Clicca per rinominare';
    title.tabIndex = 0;
    const editProjectName = () =>
      startInlineEdit(title, {
        value: project.name,
        className: 'inline-edit-project',
        onSave: (v) => renameProject(project.id, v)
      });
    title.addEventListener('click', editProjectName);
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editProjectName(); }
    });

    titleGroup.appendChild(handle);
    titleGroup.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'project-actions';

    const addTaskBtn = document.createElement('button');
    addTaskBtn.type = 'button';
    addTaskBtn.className = 'btn-add-task';
    addTaskBtn.title = 'Aggiungi una task direttamente al progetto';
    addTaskBtn.innerHTML = icon(ICONS.plus, 14, 2.5) + '<span>Task</span>';
    addTaskBtn.addEventListener('click', () => openAddTaskModal(project.id, null));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-icon btn-icon-danger';
    deleteBtn.title = 'Elimina progetto';
    deleteBtn.setAttribute('aria-label', 'Elimina progetto ' + project.name);
    deleteBtn.innerHTML = icon(ICONS.trash, 18);
    deleteBtn.addEventListener('click', () => openDeleteProjectModal(project.id, project.name));

    actions.appendChild(addTaskBtn);
    actions.appendChild(deleteBtn);

    header.appendChild(titleGroup);
    header.appendChild(actions);
    card.appendChild(header);

    // ---- Task dirette --------------------------------------------------
    const directTasks = taskList(project);
    if (directTasks.length > 0) {
      const box = document.createElement('div');
      box.className = 'project-direct-tasks';

      const subheading = document.createElement('div');
      subheading.className = 'section-subheading';
      subheading.textContent = 'TASK DIRETTE PROGETTO';

      const list = document.createElement('div');
      list.className = 'tasks-container';
      directTasks.forEach((task) => list.appendChild(buildTask(project.id, null, task)));

      box.appendChild(subheading);
      box.appendChild(list);
      card.appendChild(box);
    }

    // ---- Attività ------------------------------------------------------
    const activitiesContainer = document.createElement('div');
    activitiesContainer.className = 'activities-container';
    activitiesContainer.dataset.projectId = project.id;
    activityList(project).forEach((activity) =>
      activitiesContainer.appendChild(buildActivity(project.id, activity))
    );
    card.appendChild(activitiesContainer);

    // ---- Footer --------------------------------------------------------
    const footer = document.createElement('div');
    footer.className = 'project-footer-actions';

    const addActivityBtn = document.createElement('button');
    addActivityBtn.type = 'button';
    addActivityBtn.className = 'btn-add-activity';
    addActivityBtn.innerHTML = icon(ICONS.plus, 16, 2.5) + '<span>Attività</span>';
    addActivityBtn.addEventListener('click', () => openAddActivityModal(project.id));

    const addDirectTaskBtn = document.createElement('button');
    addDirectTaskBtn.type = 'button';
    addDirectTaskBtn.className = 'btn-add-activity btn-add-direct-task';
    addDirectTaskBtn.innerHTML = icon(ICONS.plus, 16, 2.5) + '<span>Task diretta</span>';
    addDirectTaskBtn.addEventListener('click', () => openAddTaskModal(project.id, null));

    footer.appendChild(addActivityBtn);
    footer.appendChild(addDirectTaskBtn);
    card.appendChild(footer);

    return card;
  }

  function buildActivity(projectId, activity) {
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.dataset.projectId = projectId;
    item.dataset.activityId = activity.id;

    const header = document.createElement('div');
    header.className = 'activity-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'activity-title-group';

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'drag-handle';
    handle.title = 'Trascina per riordinare le attività';
    handle.setAttribute('aria-label', 'Riordina attività ' + activity.name);
    handle.innerHTML = icon(ICONS.grip, 16);
    bindDragHandle(handle, {
      type: 'activity',
      id: activity.id,
      projectId: projectId,
      element: item
    });

    const title = document.createElement('h3');
    title.className = 'activity-title editable';
    title.textContent = activity.name;
    title.title = 'Clicca per rinominare';
    title.tabIndex = 0;
    const editActivityName = () =>
      startInlineEdit(title, {
        value: activity.name,
        className: 'inline-edit-activity',
        onSave: (v) => renameActivity(projectId, activity.id, v)
      });
    title.addEventListener('click', editActivityName);
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editActivityName(); }
    });

    titleGroup.appendChild(handle);
    titleGroup.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'activity-actions';

    const addTaskBtn = document.createElement('button');
    addTaskBtn.type = 'button';
    addTaskBtn.className = 'btn-add-task';
    addTaskBtn.title = "Aggiungi una task nell'attività";
    addTaskBtn.innerHTML = icon(ICONS.plus, 14, 2.5) + '<span>Task</span>';
    addTaskBtn.addEventListener('click', () => openAddTaskModal(projectId, activity.id));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-icon btn-icon-danger btn-icon-sm';
    deleteBtn.title = 'Elimina attività';
    deleteBtn.setAttribute('aria-label', 'Elimina attività ' + activity.name);
    deleteBtn.innerHTML = icon(ICONS.close, 14);
    deleteBtn.addEventListener('click', () => deleteActivity(projectId, activity.id));

    actions.appendChild(addTaskBtn);
    actions.appendChild(deleteBtn);

    header.appendChild(titleGroup);
    header.appendChild(actions);
    item.appendChild(header);

    const tasks = document.createElement('div');
    tasks.className = 'tasks-container';
    taskList(activity).forEach((task) => tasks.appendChild(buildTask(projectId, activity.id, task)));
    item.appendChild(tasks);

    return item;
  }

  function buildTask(projectId, activityId, task) {
    const meta = PRIORITIES[task.priority] || PRIORITIES[1];

    const el = document.createElement('div');
    el.className = 'task-item ' + meta.priorityClass + (task.completed ? ' completed' : '');
    el.dataset.taskId = task.id;

    const left = document.createElement('div');
    left.className = 'task-left';

    const checkboxWrapper = document.createElement('div');
    checkboxWrapper.className = 'task-checkbox-wrapper';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-checkbox';
    checkbox.checked = !!task.completed;
    checkbox.setAttribute('aria-label', 'Completa ' + task.name);
    checkbox.addEventListener('change', (e) =>
      toggleTask(projectId, activityId, task.id, e.target.checked)
    );
    checkboxWrapper.appendChild(checkbox);

    const title = document.createElement('span');
    title.className = 'task-title editable';
    title.textContent = task.name;
    title.title = 'Clicca per modificare';
    title.tabIndex = 0;
    const editTaskName = () =>
      startInlineEdit(title, {
        value: task.name,
        className: 'inline-edit-task',
        onSave: (v) => renameTask(projectId, activityId, task.id, v)
      });
    title.addEventListener('click', editTaskName);
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editTaskName(); }
    });

    left.appendChild(checkboxWrapper);
    left.appendChild(title);

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'task-badge-priority editable';
    badge.title = 'Clicca per cambiare priorità';
    badge.innerHTML = '<span class="priority-dot ' + meta.class + '"></span><span>' + meta.name + '</span>';
    badge.addEventListener('click', () =>
      startPriorityEdit(badge, task, (v) => setTaskPriority(projectId, activityId, task.id, v))
    );

    el.appendChild(left);
    el.appendChild(badge);

    if (task.completed) {
      const bar = document.createElement('div');
      bar.className = 'task-deletion-bar';
      // Se il timer era già partito, allinea l'animazione al tempo rimanente.
      const existing = deletionTimers.get(task.id);
      if (existing) {
        const elapsed = Date.now() - existing.startedAt;
        bar.style.animationDelay = '-' + Math.min(elapsed, TASK_DELETION_MS) + 'ms';
      }
      el.appendChild(bar);
      ensureDeletionTimer(projectId, activityId, task.id);
    }

    return el;
  }

  // ==========================================================================
  // MODIFICA INLINE
  // ==========================================================================
  function startInlineEdit(target, opts) {
    if (renderLocked) return;
    renderLocked = true;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit ' + (opts.className || '');
    input.value = opts.value;
    input.setAttribute('aria-label', 'Modifica testo');

    target.style.display = 'none';
    target.parentNode.insertBefore(input, target);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      target.style.display = '';
      if (commit && value && value !== opts.value) {
        renderLocked = false;
        renderPending = false;
        opts.onSave(value);
      } else {
        releaseRenderLock();
        render();
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function startPriorityEdit(badge, task, onSave) {
    if (renderLocked) return;
    renderLocked = true;

    const select = document.createElement('select');
    select.className = 'inline-priority';
    select.setAttribute('aria-label', 'Priorità');
    [5, 4, 3, 2, 1].forEach((p) => {
      const opt = document.createElement('option');
      opt.value = String(p);
      opt.textContent = PRIORITIES[p].name;
      if (p === task.priority) opt.selected = true;
      select.appendChild(opt);
    });

    badge.style.display = 'none';
    badge.parentNode.insertBefore(select, badge);
    select.focus();
    try { if (select.showPicker) select.showPicker(); } catch (e) { /* non supportato */ }

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const value = parseInt(select.value, 10);
      select.remove();
      badge.style.display = '';
      if (commit && value && value !== task.priority) {
        renderLocked = false;
        renderPending = false;
        onSave(value);
      } else {
        releaseRenderLock();
        render();
      }
    };

    select.addEventListener('change', () => finish(true));
    select.addEventListener('blur', () => finish(true));
    select.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
  }

  // ==========================================================================
  // DRAG & DROP (Pointer Events: mouse, touch e penna)
  // ==========================================================================
  const dragState = {
    active: false,
    type: null,
    id: null,
    projectId: null,
    element: null,
    ghost: null,
    offsetX: 0,
    offsetY: 0,
    lastX: 0,
    lastY: 0,
    targetId: null,
    place: null,
    scrollTimer: null
  };

  function bindDragHandle(handle, info) {
    handle.addEventListener('pointerdown', (e) => onHandlePointerDown(e, info));
    // Evita che un click sulla maniglia venga interpretato come submit/click
    handle.addEventListener('click', (e) => e.preventDefault());
  }

  function onHandlePointerDown(e, info) {
    if (e.button !== undefined && e.button !== 0) return;
    if (renderLocked) return;
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;

    const onMove = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        started = true;
        beginDrag(info, ev);
      }
      updateDrag(ev);
    };

    const onEnd = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onCancel);
      if (started) endDrag(ev);
    };

    const onCancel = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onCancel);
      if (started) cancelDrag();
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onCancel);
  }

  function beginDrag(info, ev) {
    dragState.active = true;
    dragState.type = info.type;
    dragState.id = info.id;
    dragState.projectId = info.projectId || null;
    dragState.element = info.element;
    dragState.targetId = null;
    dragState.place = null;

    const rect = info.element.getBoundingClientRect();
    dragState.offsetX = ev.clientX - rect.left;
    dragState.offsetY = ev.clientY - rect.top;

    const ghost = info.element.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    dragState.ghost = ghost;

    info.element.classList.add('drag-source');
    document.body.classList.add('dragging-active');

    moveGhost(ev.clientX, ev.clientY);

    dragState.scrollTimer = setInterval(autoScrollTick, 16);
  }

  function moveGhost(x, y) {
    if (!dragState.ghost) return;
    dragState.lastX = x;
    dragState.lastY = y;
    dragState.ghost.style.transform =
      'translate(' + (x - dragState.offsetX) + 'px,' + (y - dragState.offsetY) + 'px)';
  }

  function autoScrollTick() {
    if (!dragState.active) return;

    const margin = 56;
    const maxSpeed = 9;
    const y = dragState.lastY;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const current = window.scrollY;

    let delta = 0;
    if (y < margin && current > 0) {
      delta = -maxSpeed * (1 - y / margin);
    } else if (y > window.innerHeight - margin && current < maxScroll) {
      delta = maxSpeed * (1 - (window.innerHeight - y) / margin);
    }
    if (Math.abs(delta) < 0.5) return;

    window.scrollBy(0, delta);
    // Dopo lo scorrimento sotto il puntatore c'e un altro elemento:
    // ricalcoliamo subito il bersaglio, altrimenti l'indicatore resta fermo.
    refreshDropTarget(dragState.lastX, dragState.lastY);
  }

  function clearDropMarkers() {
    document.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  function updateDrag(ev) {
    if (!dragState.active) return;
    ev.preventDefault();
    moveGhost(ev.clientX, ev.clientY);
    refreshDropTarget(ev.clientX, ev.clientY);
  }

  /** Individua l'elemento sotto al puntatore e da che lato va inserito. */
  function refreshDropTarget(x, y) {
    if (!dragState.active) return;
    clearDropMarkers();

    dragState.targetId = null;
    dragState.place = null;

    const under = document.elementFromPoint(x, y);
    if (!under) return;

    const selector = dragState.type === 'project' ? '.project-card' : '.activity-item';
    const target = under.closest(selector);
    if (!target || target.classList.contains('drag-ghost')) return;

    // Un'attività non può cambiare progetto.
    if (dragState.type === 'activity' && target.dataset.projectId !== dragState.projectId) return;

    const targetId =
      dragState.type === 'project' ? target.dataset.projectId : target.dataset.activityId;
    if (!targetId || targetId === dragState.id) return;

    const rect = target.getBoundingClientRect();
    let after;
    if (dragState.type === 'activity') {
      after = y > rect.top + rect.height / 2;
    } else if (y >= rect.top && y <= rect.bottom) {
      // Stessa riga della griglia: decide l'asse orizzontale.
      after = x > rect.left + rect.width / 2;
    } else {
      after = y > rect.top + rect.height / 2;
    }

    dragState.targetId = targetId;
    dragState.place = after ? 'after' : 'before';
    target.classList.add(after ? 'drop-after' : 'drop-before');
  }

  function cleanupDrag() {
    if (dragState.scrollTimer) clearInterval(dragState.scrollTimer);
    dragState.scrollTimer = null;
    if (dragState.ghost) dragState.ghost.remove();
    if (dragState.element) dragState.element.classList.remove('drag-source');
    document.body.classList.remove('dragging-active');
    clearDropMarkers();
    dragState.active = false;
    dragState.ghost = null;
    dragState.element = null;
  }

  function cancelDrag() {
    cleanupDrag();
    if (renderPending) render();
  }

  function endDrag() {
    const type = dragState.type;
    const id = dragState.id;
    const projectId = dragState.projectId;
    const targetId = dragState.targetId;
    const place = dragState.place;

    cleanupDrag();

    if (!targetId) {
      if (renderPending) render();
      return;
    }

    if (type === 'project') moveProject(id, targetId, place);
    else moveActivity(projectId, id, targetId, place);
  }

  /** Calcola il nuovo valore di `order`, rinumerando solo se necessario. */
  function computeReorder(list, movedId, targetId, place, pathFor) {
    const without = list.filter((x) => x.id !== movedId);
    const ti = without.findIndex((x) => x.id === targetId);
    if (ti < 0) return null;

    const index = place === 'after' ? ti + 1 : ti;
    const prev = without[index - 1] || null;
    const next = without[index] || null;

    if (prev && next && Math.abs(num(next.order, 0) - num(prev.order, 0)) < ORDER_MIN_GAP) {
      // Precisione esaurita: rinumeriamo tutta la lista.
      const moved = list.find((x) => x.id === movedId);
      without.splice(index, 0, moved);
      const updates = {};
      without.forEach((item, i) => {
        const o = (i + 1) * ORDER_STEP;
        item.order = o;
        updates[pathFor(item.id)] = o;
      });
      return { updates: updates, apply: null };
    }

    const newOrder = orderBetween(prev, next);
    return { newOrder: newOrder };
  }

  function moveProject(id, targetId, place) {
    const result = computeReorder(
      projectList(), id, targetId, place, (pid) => 'projects/' + pid + '/order'
    );
    if (!result) return;

    if (result.updates) {
      mutate(null, result.updates);
      return;
    }
    mutate(
      () => { state.projects[id].order = result.newOrder; },
      { ['projects/' + id + '/order']: result.newOrder }
    );
  }

  function moveActivity(projectId, id, targetId, place) {
    const project = state.projects[projectId];
    if (!project) return;

    const base = 'projects/' + projectId + '/activities/';
    const result = computeReorder(
      activityList(project), id, targetId, place, (aid) => base + aid + '/order'
    );
    if (!result) return;

    if (result.updates) {
      mutate(null, result.updates);
      return;
    }
    mutate(
      () => { project.activities[id].order = result.newOrder; },
      { [base + id + '/order']: result.newOrder }
    );
  }

  // ==========================================================================
  // TIMER DI CANCELLAZIONE AUTOMATICA (5 secondi dopo la spunta)
  // ==========================================================================
  function ensureDeletionTimer(projectId, activityId, taskId) {
    if (deletionTimers.has(taskId)) return;
    const timeoutId = setTimeout(() => {
      deletionTimers.delete(taskId);
      deleteTask(projectId, activityId, taskId);
    }, TASK_DELETION_MS);
    deletionTimers.set(taskId, { timeoutId: timeoutId, startedAt: Date.now() });
  }

  function cancelDeletionTimer(taskId) {
    const entry = deletionTimers.get(taskId);
    if (entry) {
      clearTimeout(entry.timeoutId);
      deletionTimers.delete(taskId);
    }
  }

  /** Annulla i timer di task sparite (eliminate altrove o da un altro dispositivo). */
  function pruneDeletionTimers() {
    if (deletionTimers.size === 0) return;
    const alive = new Set();
    Object.values(state.projects || {}).forEach((p) => {
      Object.keys(p.tasks || {}).forEach((t) => alive.add(t));
      Object.values(p.activities || {}).forEach((a) => {
        Object.keys(a.tasks || {}).forEach((t) => alive.add(t));
      });
    });
    Array.from(deletionTimers.keys()).forEach((tid) => {
      if (!alive.has(tid)) cancelDeletionTimer(tid);
    });
  }

  // ==========================================================================
  // OPERAZIONI SU PROGETTI / ATTIVITA / TASK
  // ==========================================================================
  function addProject(name) {
    const clean = String(name || '').trim();
    if (!clean) return;

    const id = genId();
    const project = {
      id: id,
      name: clean.toUpperCase(),
      order: nextOrder(projectList()),
      tasks: {},
      activities: {}
    };

    mutate(
      () => { state.projects[id] = project; },
      { ['projects/' + id]: { id: id, name: project.name, order: project.order } }
    );
  }

  function renameProject(projectId, name) {
    const project = state.projects[projectId];
    if (!project) return;
    const clean = String(name || '').trim().toUpperCase();
    if (!clean) return;
    mutate(
      () => { project.name = clean; },
      { ['projects/' + projectId + '/name']: clean }
    );
  }

  function deleteProject(projectId) {
    const project = state.projects[projectId];
    if (project) {
      Object.keys(project.tasks || {}).forEach(cancelDeletionTimer);
      Object.values(project.activities || {}).forEach((a) =>
        Object.keys(a.tasks || {}).forEach(cancelDeletionTimer)
      );
    }
    mutate(
      () => { delete state.projects[projectId]; },
      { ['projects/' + projectId]: null }
    );
  }

  function addActivity(projectId, name) {
    const project = state.projects[projectId];
    if (!project) return;
    const clean = String(name || '').trim();
    if (!clean) return;

    const id = genId();
    const activity = { id: id, name: clean, order: nextOrder(activityList(project)), tasks: {} };

    mutate(
      () => { project.activities[id] = activity; },
      {
        ['projects/' + projectId + '/activities/' + id]: {
          id: id, name: activity.name, order: activity.order
        }
      }
    );
  }

  function renameActivity(projectId, activityId, name) {
    const project = state.projects[projectId];
    const activity = project && project.activities[activityId];
    if (!activity) return;
    const clean = String(name || '').trim();
    if (!clean) return;
    mutate(
      () => { activity.name = clean; },
      { ['projects/' + projectId + '/activities/' + activityId + '/name']: clean }
    );
  }

  function deleteActivity(projectId, activityId) {
    const project = state.projects[projectId];
    const activity = project && project.activities[activityId];
    if (activity) Object.keys(activity.tasks || {}).forEach(cancelDeletionTimer);
    mutate(
      () => { if (project) delete project.activities[activityId]; },
      { ['projects/' + projectId + '/activities/' + activityId]: null }
    );
  }

  function taskPath(projectId, activityId, taskId) {
    return activityId
      ? 'projects/' + projectId + '/activities/' + activityId + '/tasks/' + taskId
      : 'projects/' + projectId + '/tasks/' + taskId;
  }

  function findTaskOwner(projectId, activityId) {
    const project = state.projects[projectId];
    if (!project) return null;
    if (!activityId) return project;
    return project.activities[activityId] || null;
  }

  function addTask(projectId, activityId, name, priority) {
    const owner = findTaskOwner(projectId, activityId);
    if (!owner) return;
    const clean = String(name || '').trim();
    if (!clean) return;

    const id = genId();
    const task = {
      id: id,
      name: clean,
      priority: Math.min(5, Math.max(1, parseInt(priority, 10) || 1)),
      completed: false,
      createdAt: Date.now()
    };

    mutate(
      () => { owner.tasks[id] = task; },
      { [taskPath(projectId, activityId, id)]: task }
    );
  }

  function renameTask(projectId, activityId, taskId, name) {
    const owner = findTaskOwner(projectId, activityId);
    const task = owner && owner.tasks[taskId];
    if (!task) return;
    const clean = String(name || '').trim();
    if (!clean) return;
    mutate(
      () => { task.name = clean; },
      { [taskPath(projectId, activityId, taskId) + '/name']: clean }
    );
  }

  function setTaskPriority(projectId, activityId, taskId, priority) {
    const owner = findTaskOwner(projectId, activityId);
    const task = owner && owner.tasks[taskId];
    if (!task) return;
    const value = Math.min(5, Math.max(1, parseInt(priority, 10) || 1));
    mutate(
      () => { task.priority = value; },
      { [taskPath(projectId, activityId, taskId) + '/priority']: value }
    );
  }

  function toggleTask(projectId, activityId, taskId, completed) {
    const owner = findTaskOwner(projectId, activityId);
    const task = owner && owner.tasks[taskId];
    if (!task) return;

    if (!completed) cancelDeletionTimer(taskId);

    mutate(
      () => { task.completed = !!completed; },
      { [taskPath(projectId, activityId, taskId) + '/completed']: !!completed }
    );

    if (completed) ensureDeletionTimer(projectId, activityId, taskId);
  }

  function deleteTask(projectId, activityId, taskId) {
    const owner = findTaskOwner(projectId, activityId);
    cancelDeletionTimer(taskId);
    if (!owner || !owner.tasks[taskId]) return;
    mutate(
      () => { delete owner.tasks[taskId]; },
      { [taskPath(projectId, activityId, taskId)]: null }
    );
  }

  // ==========================================================================
  // MODALI
  // ==========================================================================
  function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('hidden');
    const field = modal.querySelector('input[type="text"], input[type="url"], select, button');
    if (field) setTimeout(() => field.focus(), 80);
  }

  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('hidden');
  }

  function closeTopModal() {
    const open = Array.from(document.querySelectorAll('.modal-backdrop')).filter(
      (m) => !m.classList.contains('hidden')
    );
    if (open.length) closeModal(open[open.length - 1].id);
  }

  function openAddProjectModal() {
    document.getElementById('project-name').value = '';
    openModal('modal-project');
  }

  function openAddActivityModal(projectId) {
    document.getElementById('activity-project-id').value = projectId;
    document.getElementById('activity-name').value = '';
    openModal('modal-activity');
  }

  function openAddTaskModal(projectId, activityId) {
    document.getElementById('task-project-id').value = projectId;
    document.getElementById('task-activity-id').value = activityId || '';
    document.getElementById('task-name').value = '';
    const preset = document.querySelector('input[name="task-priority"][value="5"]');
    if (preset) preset.checked = true;
    openModal('modal-task');
  }

  function openDeleteProjectModal(projectId, projectName) {
    pendingDeleteProjectId = projectId;
    document.getElementById('delete-project-name-placeholder').textContent =
      '"' + String(projectName).toUpperCase() + '"';
    openModal('modal-delete-confirm');
  }

  function openCloudModal() {
    document.getElementById('firebase-api-key').value = cloudConfig.apiKey || '';
    document.getElementById('firebase-auth-domain').value = cloudConfig.authDomain || '';
    document.getElementById('firebase-db-url').value = cloudConfig.databaseURL || '';
    document.getElementById('firebase-workspace').value = cloudConfig.workspaceKey || '';
    document.getElementById('firebase-auth-email').value = cloudConfig.authEmail || '';
    updateCloudModalStatus();
    openModal('modal-cloud');
  }

  function updateCloudModalStatus() {
    const el = document.getElementById('cloud-status-line');
    if (el) {
      const meta = SYNC_LABELS[syncStatus] || SYNC_LABELS.local;
      el.className = 'cloud-status cloud-status-' + syncStatus;
      el.textContent = 'Stato attuale: ' + meta.text + (syncDetail ? ' - ' + syncDetail : '');
    }
    const logout = document.getElementById('btn-logout');
    if (logout) logout.classList.toggle('hidden', !currentUser);
  }

  // ==========================================================================
  // EXPORT / IMPORT
  // ==========================================================================
  function downloadBackup() {
    const payload = {
      version: 3,
      exportedAt: new Date().toISOString(),
      projects: state.projects
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'todo_unifi_backup_' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup scaricato.', 'success');
  }

  function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.target.result);
      } catch (err) {
        toast('File JSON non leggibile: ' + err.message, 'error');
        return;
      }

      const hasProjects =
        parsed && (Array.isArray(parsed.projects) || (parsed.projects && typeof parsed.projects === 'object'));
      if (!hasProjects) {
        toast('Formato del file non riconosciuto.', 'error');
        return;
      }

      const count = Array.isArray(parsed.projects)
        ? parsed.projects.length
        : Object.keys(parsed.projects).length;

      const ok = window.confirm(
        'Importare ' + count + ' progetti?\n\n' +
        'Questa operazione SOSTITUISCE tutti i dati attuali, anche sul cloud.'
      );
      if (!ok) return;

      deletionTimers.forEach((entry) => clearTimeout(entry.timeoutId));
      deletionTimers.clear();

      state = normalize(parsed);
      saveLocal();
      render();
      pushFullState();
      closeModal('modal-data');
      toast('Backup ripristinato.', 'success');
    };
    reader.readAsText(file);
  }

  // ==========================================================================
  // EVENT BINDING
  // ==========================================================================
  function bindEvents() {
    document.getElementById('btn-add-project').addEventListener('click', openAddProjectModal);
    document.getElementById('btn-empty-add-project').addEventListener('click', openAddProjectModal);

    document.getElementById('form-project').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('project-name');
      addProject(input.value);
      input.value = '';
      closeModal('modal-project');
    });

    document.getElementById('form-activity').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('activity-name');
      addActivity(document.getElementById('activity-project-id').value, input.value);
      input.value = '';
      closeModal('modal-activity');
    });

    document.getElementById('form-task').addEventListener('submit', (e) => {
      e.preventDefault();
      const projectId = document.getElementById('task-project-id').value;
      const activityId = document.getElementById('task-activity-id').value || null;
      const nameInput = document.getElementById('task-name');
      const checked = document.querySelector('input[name="task-priority"]:checked');
      addTask(projectId, activityId, nameInput.value, checked ? checked.value : 1);
      nameInput.value = '';
      closeModal('modal-task');
    });

    document.getElementById('btn-confirm-delete-project').addEventListener('click', () => {
      if (pendingDeleteProjectId) {
        deleteProject(pendingDeleteProjectId);
        pendingDeleteProjectId = null;
      }
      closeModal('modal-delete-confirm');
    });

    // --- Cloud ---
    document.getElementById('btn-cloud-sync').addEventListener('click', openCloudModal);

    document.getElementById('btn-save-cloud-config').addEventListener('click', async () => {
      cloudConfig.apiKey = document.getElementById('firebase-api-key').value.trim();
      cloudConfig.authDomain = document.getElementById('firebase-auth-domain').value.trim();
      cloudConfig.databaseURL = document.getElementById('firebase-db-url').value.trim();
      cloudConfig.workspaceKey = sanitizeKey(document.getElementById('firebase-workspace').value);
      cloudConfig.authEmail = document.getElementById('firebase-auth-email').value.trim();
      document.getElementById('firebase-workspace').value = cloudConfig.workspaceKey;
      saveCloudConfig();
      closeModal('modal-cloud');
      await initCloud();
      toast(cloudEnabled() ? 'Configurazione salvata, connessione in corso.' : 'Sincronizzazione disattivata.', 'info');
    });

    document.getElementById('btn-disconnect-cloud').addEventListener('click', async () => {
      cloudConfig.databaseURL = '';
      saveCloudConfig();
      document.getElementById('firebase-db-url').value = '';
      await teardownCloud();
      hideAuthGate();
      setSyncStatus('local');
      updateCloudModalStatus();
      toast('Disconnesso dal cloud. I dati restano su questo dispositivo.', 'info');
    });

    document.getElementById('btn-logout').addEventListener('click', async () => {
      closeModal('modal-cloud');
      await signOutUser();
    });

    // --- Accesso con password ---
    document.getElementById('form-auth').addEventListener('submit', (e) => {
      e.preventDefault();
      signIn(document.getElementById('auth-password').value);
    });

    // --- Dati ---
    document.getElementById('btn-export-import').addEventListener('click', () => openModal('modal-data'));
    document.getElementById('btn-download-json').addEventListener('click', downloadBackup);
    document.getElementById('btn-trigger-import-file').addEventListener('click', () => {
      document.getElementById('import-json-file').click();
    });
    document.getElementById('import-json-file').addEventListener('change', handleImportFile);

    // --- Chiusura modali ---
    document.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close')));
    });

    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeModal(backdrop.id);
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (dragState.active) { cancelDrag(); return; }
        closeTopModal();
      }
    });

    // Se un'altra scheda dello stesso browser modifica i dati, allineati subito.
    window.addEventListener('storage', (e) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        state = normalize(JSON.parse(e.newValue));
        pruneDeletionTimers();
        scheduleRender();
      } catch (err) {
        console.warn('Sincronizzazione tra schede fallita', err);
      }
    });
  }

  // ==========================================================================
  // AVVIO
  // ==========================================================================
  function init() {
    loadCloudConfig();
    const hadLocal = loadLocal();
    if (!hadLocal && !cloudEnabled()) createDemoData();

    bindEvents();

    // Se il cloud è configurato, copriamo subito l'app: evita di mostrare i
    // dati in cache un istante prima di sapere se la sessione è valida.
    if (cloudEnabled() && missingCloudConfig().length === 0) showAuthGate('checking');

    setSyncStatus(cloudEnabled() ? 'connecting' : 'local');
    render();
    initCloud();
  }

  /**
   * Registra il service worker: e cio che rende l'app installabile e capace
   * di aprirsi senza rete. Richiede https (GitHub Pages lo e), quindi aprendo
   * il file in locale con doppio clic non si attiva: non e un errore.
   */
  function registraServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // isSecureContext copre https, localhost e 127.0.0.1, ed esclude file://
    if (!window.isSecureContext) return;
    navigator.serviceWorker.register('sw.js').catch((e) => {
      console.warn('Service worker non registrato', e);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('load', registraServiceWorker);

  // Esposto per i test automatici.
  window.__todoDebug = {
    getState: () => state,
    render: render,
    addProject: addProject,
    addActivity: addActivity,
    addTask: addTask,
    projectList: projectList
  };
})();

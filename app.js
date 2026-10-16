(() => {
  'use strict';

  const STORAGE_KEY = 'aligneros_next_demo_v8';
  const STAGES = ['Impresión', 'Termoformado', 'Acabado', 'Control final'];
  const STOCK_ID = 'plancha-075';
  const ZERO_STOCK_ID = 'plancha-05';
  const RETENTION_STOCK_ID = 'plancha-10';
  const PACKAGING_ID = 'bolsas-demo';
  const byId = id => document.getElementById(id);
  let state = loadState();
  let undoStack = [];
  let toastTimer;
  let currentView = 'inicio';
  let ownFilter = 'all';
  let externalFilter = 'all';
  let productionFilter = 'all';
  let confirmCallback = null;

  function uid(prefix = 'c') { return `${prefix}-${Math.random().toString(36).slice(2, 9)}`; }
  function nextCode(prefix) { let code; do { code = `${prefix}-${Math.random().toString(10).slice(2, 6)}`; } while (state.cases.some(c => c.code === code)); return code; }
  function isoDate(offset = 0) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); }
  function dateOffset(date) { if (!date) return 999; const today = new Date(); today.setHours(0, 0, 0, 0); const d = new Date(`${date}T12:00:00`); return Math.ceil((d - today) / 86400000); }
  function fmtDate(date) { if (!date) return 'Sin fecha'; return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: 'short' }).format(new Date(`${date}T12:00:00`)); }
  function fmtEventDate(date) { return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(date)); }
  function quantityText(value, unit) { const abs = Math.abs(value); const shown = Number.isInteger(abs) ? String(abs) : String(Number(abs.toFixed(2))); const singular = { láminas: 'lámina', unidades: 'unidad', botellas: 'botella' }[unit] || unit; return `${shown} ${abs === 1 ? singular : unit}`; }
  function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
  function activeArches(c) { return Number((c.upperCount || 0) > 0) + Number((c.lowerCount || 0) > 0); }
  function archNames(c) { return [c.upperCount ? 'Sup.' : '', c.lowerCount ? 'Inf.' : ''].filter(Boolean).join(' + ') || 'Sin arcos'; }
  function totalUnits(c) { return (c.aligners || []).filter(item => !item.superseded).length; }
  function createAligners(upper, lower, options = {}) {
    const phase = options.phase || 'E1';
    const prefix = phase === 'E1' ? 'E1-' : `${phase}-`;
    const createArch = (count, arch, label, includeZero) => [
      ...(includeZero ? [{ id: `${prefix}${label}-0`, arch, number: 0, phase, kind: 'aligner', materialId: ZERO_STOCK_ID, stage: 0, attempts: [0, 0, 0, 0], events: [] }] : []),
      ...Array.from({ length: count }, (_, i) => ({ id: `${prefix}${label}-${i + 1}`, arch, number: i + 1, phase, kind: 'aligner', materialId: STOCK_ID, stage: 0, attempts: [0, 0, 0, 0], events: [] }))
    ];
    return [...createArch(upper, 'upper', 'SUP', options.upperZero), ...createArch(lower, 'lower', 'INF', options.lowerZero)];
  }
  function createRetainers(upper, lower, generation = 1) {
    const phase = `CONT${generation}`;
    return [
      ...(upper ? [{ id: `${phase}-SUP`, arch: 'upper', number: 1, phase, kind: 'retainer', materialId: RETENTION_STOCK_ID, stage: -2, attempts: [0, 0, 0, 0], events: [] }] : []),
      ...(lower ? [{ id: `${phase}-INF`, arch: 'lower', number: 1, phase, kind: 'retainer', materialId: RETENTION_STOCK_ID, stage: -2, attempts: [0, 0, 0, 0], events: [] }] : [])
    ];
  }
  function phaseUnits(c, phase) { return (c.aligners || []).filter(item => item.phase === phase && !item.superseded); }
  function lastTreatmentPhase(c) { return c.treatmentStages?.at(-1) || 'E1'; }
  function phaseComplete(c, phase) { const units = phaseUnits(c, phase); return units.length > 0 && units.every(item => item.stage >= STAGES.length); }
  function unlockRetainers(c) { for (const item of phaseUnits(c, c.finalRetentionPhase || 'CONT1')) if (item.stage === -2) item.stage = 0; }
  function workStepLabel(c, stage) {
    const units = (c.aligners || []).filter(item => item.stage === stage && !item.superseded);
    return units.length && units.every(item => item.kind === 'retainer') ? `Contenciones · ${STAGES[stage]}` : STAGES[stage];
  }
  function advanceTreatmentFlow(c) {
    if (phaseComplete(c, lastTreatmentPhase(c))) unlockRetainers(c);
    if (c.mode === 'own' && caseComplete(c)) c.archived = true;
  }
  function ensureWork(c) {
    c.upperCount = Number(c.upperCount || 0);
    c.lowerCount = Number(c.lowerCount || 0);
    c.aligners ||= [...createAligners(c.upperCount, c.lowerCount), ...createRetainers(c.upperCount > 0, c.lowerCount > 0)];
    const work = { upper: { pending: [0, 0, 0, 0], complete: 0 }, lower: { pending: [0, 0, 0, 0], complete: 0 } };
    for (const item of c.aligners) {
      if (item.superseded) continue;
      if (item.stage >= STAGES.length) work[item.arch].complete++;
      else if (item.stage >= 0) work[item.arch].pending[item.stage]++;
    }
    return work;
  }
  function caseComplete(c) { ensureWork(c); return phaseComplete(c, lastTreatmentPhase(c)) && phaseComplete(c, c.finalRetentionPhase || 'CONT1'); }
  function availableAtStage(c, stage) { const work = ensureWork(c); return { upper: work.upper.pending[stage] || 0, lower: work.lower.pending[stage] || 0 }; }
  function nextWorkStage(c) { for (let stage = 0; stage < STAGES.length; stage++) { const a = availableAtStage(c, stage); if (a.upper || a.lower) return stage; } return -1; }
  function safeCase(id) { return state.cases.find(c => c.id === id); }
  function recordEvent(c, description) { c.events ||= []; c.events.push({ date: new Date().toISOString(), description }); if (c.events.length > 80) c.events.shift(); }

  function sampleState() {
    const own1 = makeOwnCase('Muestra · caso propio A', 'Mi consultorio', 15, 4, 0, 0);
    own1.aligners.forEach(item => {
      if (item.phase !== 'E1') return;
      item.stage = item.id === 'E1-SUP-3' ? 0 : 1;
      if (item.id === 'E1-SUP-3') { item.attempts[0] = 1; item.events.push({ date: new Date().toISOString(), stage: 0, outcome: 'rework', attempt: 1 }); }
    });
    own1.events.push({ date: new Date().toISOString(), description: 'Etapa 1 · Impresión · Superior #3 falló; quedó para rehacer' });
    own1.events.push({ date: new Date().toISOString(), description: 'Termoformado · restantes de ambos arcos avanzaron' });
    const own2 = makeOwnCase('Muestra · caso propio B', 'Mi consultorio', 20, 11, 4, 1);
    const own3 = makeOwnCase('Muestra · caso propio C', 'Mi consultorio', 8, 8, 2, 0);
    const lowerTwo = own3.aligners.find(item => item.id === 'E1-INF-2');
    lowerTwo.stage = 1; lowerTwo.attempts[0] = 1; lowerTwo.events.push({ date: new Date().toISOString(), stage: 0, outcome: 'good', attempt: 1 });
    lowerTwo.attempts[1] = 1; lowerTwo.events.push({ date: new Date().toISOString(), stage: 1, outcome: 'rework', attempt: 1 });
    own3.events.push({ date: new Date().toISOString(), description: 'Termoformado · INF-2 falló; quedó identificado para rehacer' });
    const ownArchived = makeOwnCase('Muestra · caso archivado', 'Mi consultorio', 6, 6, 10, 3);
    ownArchived.events.push({ date: new Date().toISOString(), description: 'Caso terminado · archivado' });
    const external1 = makeExternalCase('Muestra · orden externa A', 'Clínica Norte · Dra. Suárez', 24, 12, 0, 0);
    const external2 = makeExternalCase('Muestra · orden externa B', 'Centro Dental Sur · Dr. Ponce', 6, 6, 3, 3);
    external2.shipment = null;
    const external3 = makeExternalCase('Muestra · orden externa C', 'Clínica Río · Dra. Acosta', 4, 4, 3, 3);
    external3.shipment = { carrier: 'Mensajería local', tracking: 'DEMO-208', note: 'Entrega de muestra', date: isoDate(-1), status: 'transit' };
    external3.archived = true;
    external3.events.push({ date: new Date(`${isoDate(-1)}T12:00:00`).toISOString(), description: 'Orden despachada · Mensajería local' });
    const externalArchived = makeExternalCase('Muestra · orden archivada', 'Clínica Central · Dra. Vidal', 6, 6, 14, 3);
    externalArchived.shipment = { carrier: 'Mensajería local', tracking: 'DEMO-104', note: '', date: isoDate(-7), deliveredDate: isoDate(-6), status: 'delivered' };
    externalArchived.archived = true;
    externalArchived.events.push({ date: new Date(`${isoDate(-6)}T12:00:00`).toISOString(), description: 'Orden entregada · archivada' });
    return {
      version: 8,
      cases: [own1, own2, own3, ownArchived, external1, external2, external3, externalArchived],
      stock: [
        { id: ZERO_STOCK_ID, name: 'Planchas termoformables 0.5 mm · alineador 0', unit: 'láminas', qty: 24, min: 6, perAligner: 1 },
        { id: STOCK_ID, name: 'Planchas termoformables 0.75 mm', unit: 'láminas', qty: 81, min: 24, perAligner: 1 },
        { id: RETENTION_STOCK_ID, name: 'Planchas termoformables 1 mm · contenciones', unit: 'láminas', qty: 16, min: 4, perAligner: 1 },
        { id: 'resina-demo', name: 'Resina de modelo', unit: 'botellas', qty: 6, min: 2, perAligner: 0 },
        { id: PACKAGING_ID, name: 'Bolsas de envío', unit: 'unidades', qty: 14, min: 6, perOrder: 1 }
      ],
      movements: [
        { id: uid('m'), item: 'Planchas termoformables 0.75 mm', qty: -1, unit: 'láminas', kind: 'consume', note: 'MC · Termoformado · INF-2 para rehacer', date: isoDate(0) },
        { id: uid('m'), item: 'Planchas termoformables 0.75 mm', qty: -4, unit: 'láminas', kind: 'consume', note: 'MC · tandas de ambos arcos', date: isoDate(0) },
        { id: uid('m'), item: 'Planchas termoformables 0.75 mm', qty: -10, unit: 'láminas', kind: 'consume', note: 'MC · tandas parciales', date: isoDate(-1) },
        { id: uid('m'), item: 'Planchas termoformables 0.75 mm', qty: -12, unit: 'láminas', kind: 'consume', note: 'OT · lote completo', date: isoDate(-2) },
        { id: uid('m'), item: 'Planchas termoformables 0.75 mm', qty: -8, unit: 'láminas', kind: 'consume', note: 'OT · lote despachado', date: isoDate(-3) },
        { id: uid('m'), item: 'Bolsas de envío', qty: -1, unit: 'unidades', kind: 'consume', note: 'Despacho OT · muestra', date: isoDate(-1) },
        { id: uid('m'), item: 'Bolsas de envío', qty: 10, unit: 'unidades', kind: 'restock', note: 'Reposición de muestra', date: isoDate(-2) }
      ]
    };
  }

  function makeOwnCase(patient, clinic, upperCount, lowerCount, dueIn, stage) {
    const aligners = [...createAligners(upperCount, lowerCount), ...createRetainers(upperCount > 0, lowerCount > 0, 1)];
    if (stage > 0) aligners.filter(item => item.phase === 'E1').forEach(item => { item.stage = stage === 3 ? 4 : stage; });
    const events = [{ date: new Date().toISOString(), description: 'Caso de muestra · cantidades independientes por arco' }];
    if (stage >= 0) events.push({ date: new Date().toISOString(), description: `Tanda de muestra · ${STAGES[stage]}` });
    const finished = stage === 3;
    if (finished) aligners.filter(item => item.kind === 'retainer').forEach(item => { item.stage = 4; });
    return { id: uid(), mode: 'own', code: `MC-${Math.random().toString(10).slice(2, 6)}`, patient, clinic, due: isoDate(dueIn), upperCount, lowerCount, includeZeroUpper: false, includeZeroLower: false, aligners, treatmentStages: ['E1'], finalRetentionPhase: 'CONT1', archived: finished, notes: '', events, createdAt: Date.now() };
  }

  function makeExternalCase(patient, clinic, upperCount, lowerCount, dueIn, stage) {
    const eventDate = stage === 3 ? new Date(`${isoDate(-2)}T12:00:00`).toISOString() : new Date().toISOString();
    const aligners = [...createAligners(upperCount, lowerCount), ...createRetainers(upperCount > 0, lowerCount > 0, 1)];
    if (stage > 0) aligners.filter(item => item.phase === 'E1').forEach(item => { item.stage = stage === 3 ? 4 : stage; });
    aligners.filter(item => item.kind === 'retainer').forEach(item => { item.stage = stage === 3 ? 4 : -2; });
    const finished = stage === 3;
    return { id: uid(), mode: 'external', code: `OT-${Math.random().toString(10).slice(2, 6)}`, patient, clinic, due: isoDate(dueIn), upperCount, lowerCount, includeZeroUpper: false, includeZeroLower: false, aligners, treatmentStages: ['E1'], finalRetentionPhase: 'CONT1', archived: false, shipment: null, shipmentHistory: [], notes: '', events: [{ date: eventDate, description: stage < 0 ? 'Orden de muestra creada' : `Orden de muestra · ${STAGES[stage]}` }], createdAt: Date.now() };
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.version === 8 && Array.isArray(parsed.cases) && Array.isArray(parsed.stock)) {
          let normalized = false;
          for (const c of parsed.cases) {
            if (c.mode === 'external' && ['transit', 'delivered'].includes(c.shipment?.status) && !c.archived) { c.archived = true; normalized = true; }
          }
          if (normalized) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)); } catch (error) { console.warn('No se pudo actualizar el archivo local.', error); } }
          return parsed;
        }
      }
    } catch (error) { console.warn('Se inició la demo con datos de muestra.', error); }
    const initial = sampleState();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(initial)); } catch (error) { console.warn('La demo no pudo guardar el estado local.', error); }
    return initial;
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (error) { showToast('No se pudo guardar en este navegador'); }
  }

  function pushUndo() {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 15) undoStack.shift();
    updateUndoButton();
  }

  function undoLast() {
    const snapshot = undoStack.pop();
    if (!snapshot) return;
    state = JSON.parse(snapshot);
    saveState();
    renderAll();
    showToast('Último cambio deshecho');
    updateUndoButton();
  }

  function updateUndoButton() { byId('undoBtn').disabled = undoStack.length === 0; }
  function showToast(message) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function showView(view) {
    currentView = view;
    document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
    document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
    const titles = { inicio: 'Resumen', propios: 'Mi clínica', externos: 'Otras clínicas', produccion: 'Producción', materiales: 'Materiales' };
    byId('pageTitle').textContent = titles[view] || 'Resumen';
    history.replaceState(null, '', `#${view}`);
    renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function completedUnits(c) { const work = ensureWork(c); return work.upper.complete + work.lower.complete; }
  function ownStageLabel(c) { const stage = nextWorkStage(c); return stage < 0 ? caseComplete(c) ? 'Caso completo' : `Etapa ${c.treatmentStages?.length || 1}` : workStepLabel(c, stage); }
  function phaseLabel(phase, item) {
    if (item?.kind === 'retainer') return 'Contención · 1 mm';
    if (phase === 'E1') return 'Etapa 1';
    const match = /^RP(\d+)$/.exec(phase || '');
    return match ? `Etapa ${match[1]} · reperfilado` : 'Reperfilado';
  }
  function progressSummary(c) {
    const work = ensureWork(c);
    const shortStages = ['impr.', 'termo.', 'acab.', 'control'];
    const summary = (key, label) => {
      const parts = shortStages.map((stage, index) => work[key].pending[index] ? `${work[key].pending[index]} ${stage}` : '').filter(Boolean);
      if (work[key].complete) parts.push(`${work[key].complete} listas`);
      return `${label} ${parts.join(' · ') || 'completo'}`;
    };
    return [summary('upper', 'Sup.'), summary('lower', 'Inf.')].filter((_, index) => index === 0 ? c.upperCount > 0 : c.lowerCount > 0).join(' · ');
  }
  function caseProgress(c) {
    const units = (c.aligners || []).filter(item => !item.superseded && item.stage !== -2);
    const total = units.length;
    if (!total) return 0;
    const weighted = units.reduce((sum, item) => sum + Math.min(STAGES.length, Math.max(0, item.stage)), 0);
    if (c.shipment?.status === 'delivered') return 100;
    return Math.min(100, Math.round(weighted / (total * STAGES.length) * 100));
  }
  function priority(c) {
    const days = dateOffset(c.due);
    if (days < 0) return { label: `Vencido ${Math.abs(days)}d`, className: 'priority-overdue', days };
    if (days <= 3) return { label: days === 0 ? 'Entrega hoy' : `Entrega ${days}d`, className: 'priority-soon', days };
    return { label: `Entrega ${fmtDate(c.due)}`, className: '', days };
  }
  function stageButtonLabel(c) {
    if (c.shipment?.status === 'transit') return 'Marcar como entregada';
    if (c.shipment?.status === 'delivered') return 'Orden entregada';
    if (caseComplete(c)) return c.mode === 'own' ? 'Caso completo' : 'Registrar envío';
    const stage = nextWorkStage(c);
    return stage < 0 ? 'Sin trabajo pendiente' : `Procesar · ${workStepLabel(c, stage)}`;
  }
  function sortedCases(cases) { return [...cases].sort((a, b) => dateOffset(a.due) - dateOffset(b.due) || a.patient.localeCompare(b.patient, 'es')); }
  function filteredCases(cases) {
    const query = byId('globalSearch').value.trim().toLocaleLowerCase('es');
    return sortedCases(cases.filter(c => !query || `${c.patient} ${c.clinic} ${c.code}`.toLocaleLowerCase('es').includes(query)));
  }
  function emptyState(title, note) { return `<div class="empty-state"><div class="empty-mark">✓</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(note)}</p></div>`; }

  function renderAll() {
    renderNavCounts();
    renderDashboard();
    renderOwnCases();
    renderExternalCases();
    renderProduction();
    renderStock();
  }

  function renderNavCounts() {
    byId('ownNavCount').textContent = state.cases.filter(c => c.mode === 'own' && !c.archived).length;
    byId('externalNavCount').textContent = state.cases.filter(c => c.mode === 'external' && !c.archived).length;
  }

  function renderDashboard() {
    byId('dashboardDate').textContent = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()).toLocaleUpperCase('es');
    const own = state.cases.filter(c => c.mode === 'own');
    const external = state.cases.filter(c => c.mode === 'external');
    const overdue = state.cases.filter(c => dateOffset(c.due) < 0 && !c.archived);
    const lowStock = state.stock.filter(s => s.qty <= s.min).length;
    byId('dashboardStats').innerHTML = [
      statCard('Casos de mi clínica', own.length, `${own.filter(c => !caseComplete(c)).length} en producción`, '◉'),
      statCard('Órdenes externas', external.length, `${external.filter(c => c.shipment?.status === 'transit').length} en tránsito`, '⇄'),
      statCard('Entregas demoradas', overdue.length, overdue.length ? 'Revisar fecha y siguiente paso' : 'Sin retrasos en la muestra', '◷', overdue.length > 0),
      statCard('Materiales en mínimo', lowStock, lowStock ? 'Revisar reposición' : 'Niveles dentro del mínimo', '◈', lowStock > 0)
    ].join('');
    const actions = sortedCases(state.cases.filter(c => dateOffset(c.due) <= 7 && !c.archived)).slice(0, 4);
    byId('nextActions').innerHTML = actions.length ? actions.map(c => {
      const p = priority(c);
      return `<div class="action-row"><div><div class="action-patient">${escapeHtml(c.patient)}</div><div class="action-detail">${escapeHtml(c.code)} · ${escapeHtml(p.label)}</div></div><span class="mode-pill ${c.mode}">${c.mode === 'own' ? '◉ Mi clínica' : '⇄ Orden externa'}</span><div class="action-main">${escapeHtml(stageButtonLabel(c))}</div><button class="button button-quiet" onclick="window.AlignOS.action('${c.id}')">Abrir tarea</button></div>`;
    }).join('') : `<div class="empty-inline">No hay vencimientos cercanos en la muestra. La cola completa está en Producción.</div>`;
    const low = state.stock.filter(s => s.qty <= s.min).slice(0, 3);
    const glance = low.length ? low.map(s => `<div class="glance-item"><div><div class="glance-name">${escapeHtml(s.name)}</div><div class="glance-note">Mínimo ${s.min} ${escapeHtml(s.unit)}</div></div><div class="glance-value low">${s.qty}</div></div>`).join('') : state.stock.slice(0, 3).map(s => `<div class="glance-item"><div><div class="glance-name">${escapeHtml(s.name)}</div><div class="glance-note">Disponible · mínimo ${s.min} ${escapeHtml(s.unit)}</div></div><div class="glance-value">${s.qty}</div></div>`).join('');
    byId('stockGlance').innerHTML = glance || `<div class="empty-inline">Sin materiales registrados.</div>`;
    byId('workModeSummary').innerHTML = `<div class="mode-summary-card"><span class="mode-summary-symbol own">◉</span><div><strong>Mi clínica</strong><p>Tandas por arco · consumo gradual</p></div><span class="mode-summary-value">${own.length}</span></div><div class="mode-summary-card"><span class="mode-summary-symbol external">⇄</span><div><strong>Otras clínicas</strong><p>Orden completa · salida registrada</p></div><span class="mode-summary-value">${external.length}</span></div>`;
  }

  function statCard(label, value, foot, icon, alert = false) { return `<article class="stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon"${alert ? ' style="color:var(--red);background:var(--red-soft)"' : ''}>${icon}</span></div><div class="stat-value">${value}</div><div class="stat-foot">${foot}</div></article>`; }

  function renderOwnCases() {
    let cases = filteredCases(state.cases.filter(c => c.mode === 'own'));
    if (ownFilter === 'active') cases = cases.filter(c => !caseComplete(c) && !c.archived);
    if (ownFilter === 'ready') { cases = cases.filter(c => { const work = ensureWork(c); return !c.archived && (work.upper.pending[3] + work.lower.pending[3]) > 0; }); }
    if (ownFilter === 'archived') cases = cases.filter(c => c.archived);
    byId('ownResultCount').textContent = `${cases.length} casos`;
    byId('ownPendingMetric').textContent = `${state.cases.filter(c => c.mode === 'own' && !c.archived).length} activos`;
    byId('ownCases').innerHTML = cases.length ? cases.map(renderCaseCard).join('') : emptyState('Sin casos', 'Probá otro filtro o agregá un caso.');
  }

  function renderExternalCases() {
    let cases = filteredCases(state.cases.filter(c => c.mode === 'external'));
    if (externalFilter === 'production') cases = cases.filter(c => !c.archived && !c.shipment && !caseComplete(c));
    if (externalFilter === 'ready') cases = cases.filter(c => !c.archived && !c.shipment && caseComplete(c));
    if (externalFilter === 'archived') cases = cases.filter(c => c.archived);
    byId('externalResultCount').textContent = `${cases.length} órdenes`;
    const inProcess = state.cases.filter(c => c.mode === 'external' && !c.archived && !c.shipment).length;
    const shipping = state.cases.filter(c => c.mode === 'external' && c.shipment?.status === 'transit').length;
    byId('externalPendingMetric').textContent = `${inProcess} en taller · ${shipping} en tránsito`;
    byId('externalCases').innerHTML = cases.length ? cases.map(renderCaseCard).join('') : emptyState('Sin órdenes', 'Probá otro filtro o agregá una orden.');
  }

  function renderCaseCard(c) {
    const p = priority(c);
    const progress = caseProgress(c);
    const isOwn = c.mode === 'own';
    const statusText = c.shipment?.status === 'transit' ? 'Despachado · en tránsito' : c.archived ? 'Archivado' : c.shipment?.status === 'delivered' ? 'Entregada' : caseComplete(c) ? `Etapa ${c.treatmentStages?.length || 1} completa` : (isOwn ? ownStageLabel(c) : externalStatus(c));
    const targetText = `${c.upperCount} sup. · ${c.lowerCount} inf.${c.includeZeroUpper ? ' · SUP-0' : ''}${c.includeZeroLower ? ' · INF-0' : ''}`;
    const work = ensureWork(c);
    const ready = work.upper.pending[3] + work.lower.pending[3];
    const directWorkButton = !caseComplete(c) && !c.shipment
      ? `<button class="button button-direct" onclick="window.AlignOS.direct('${c.id}')">Completar de una vez</button>` : '';
    const addPhaseButton = caseComplete(c) && c.shipment?.status !== 'transit'
      ? `<button class="button button-primary" onclick="window.AlignOS.reprofile('${c.id}')">＋ Nueva etapa</button>` : '';
    const actionButtons = c.shipment?.status === 'transit'
      ? `<button class="button button-quiet" onclick="window.AlignOS.action('${c.id}')">Marcar entregada</button>`
      : c.shipment?.status === 'delivered'
        ? `<span class="tag status-ready">✓ Entregada</span>`
        : caseComplete(c) && !isOwn
          ? `<button class="button button-primary" onclick="window.AlignOS.action('${c.id}')">Registrar envío</button>`
          : c.shipment ? '' : STAGES.map((stage, index) => {
            const available = availableAtStage(c, index);
            if (!available.upper && !available.lower) return '';
            const amount = [available.upper ? `${available.upper} sup.` : '', available.lower ? `${available.lower} inf.` : ''].filter(Boolean).join(' · ');
            return `<button class="button ${index === nextWorkStage(c) ? 'button-primary' : 'button-quiet'}" onclick="window.AlignOS.process('${c.id}',${index})">${workStepLabel(c, index)} · ${amount}</button>`;
          }).join('');
    const events = c.events || [];
    const history = events.length ? `<details class="case-history"><summary>Actividad · ${events.length}</summary><div class="case-history-list">${events.slice(-4).reverse().map(event => `<div><time>${fmtEventDate(event.date)}</time><span>${escapeHtml(event.description)}</span></div>`).join('')}</div></details>` : '';
    const oldDeliveries = c.shipmentHistory?.length ? `<details class="case-history"><summary>Entregas previas · ${c.shipmentHistory.length}</summary><div class="case-history-list">${c.shipmentHistory.slice().reverse().map(item => `<div><time>${fmtDate(item.date)}</time><span>${escapeHtml(item.carrier || 'Sin transporte')}${item.tracking ? ` · ${escapeHtml(item.tracking)}` : ''}</span></div>`).join('')}</div></details>` : '';
    const reworkIds = pendingReworkIds(c);
    const reworkNotice = reworkIds.length ? `<div class="case-rework-alert"><strong>Rehacer:</strong> ${escapeHtml(reworkIds.slice(0, 8).join(', '))}${reworkIds.length > 8 ? ` · +${reworkIds.length - 8} más en el detalle` : ''}</div>` : '';
    return `<article class="case-card ${isOwn ? '' : 'external'}"><div class="case-card-top"><div class="case-identity"><div class="case-code">${escapeHtml(c.code)} · ${isOwn ? 'MI CLÍNICA' : 'OTRA CLÍNICA'}</div><div class="case-name">${escapeHtml(c.patient)}</div><div class="case-clinic">${escapeHtml(c.clinic)} · ${escapeHtml(archNames(c))}</div></div><div class="case-date"><div class="date-label">ENTREGA</div><div class="date-value ${p.days < 0 ? 'overdue' : p.days <= 3 ? 'soon' : ''}">${escapeHtml(p.label)}</div></div></div><div class="case-tags"><span class="tag">${targetText}</span>${c.archived ? '<span class="tag status-ready">Archivado</span>' : ''}${c.treatmentStages?.length > 1 ? `<span class="tag">${c.treatmentStages.length} etapas</span>` : ''}</div><div class="case-progress"><div class="progress-top"><span>${escapeHtml(statusText)}${caseComplete(c) ? '' : ` · ${escapeHtml(progressSummary(c))}`}</span><strong>${progress}%</strong></div><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div></div>${reworkNotice}<div class="case-actions"><div class="case-action-buttons">${actionButtons}${directWorkButton}${addPhaseButton}<button class="button button-quiet" onclick="window.AlignOS.edit('${c.id}')">Editar</button></div></div>${c.shipment ? `<div class="case-clinic" style="margin-top:8px">${c.shipment.status === 'delivered' ? 'Entregada' : `Despachada ${fmtDate(c.shipment.date)}`}${c.shipment.carrier ? ` · ${escapeHtml(c.shipment.carrier)}` : ''}${c.shipment.tracking ? ` · Guía ${escapeHtml(c.shipment.tracking)}` : ''}</div>` : ''}${c.notes ? `<div class="case-clinic" style="margin-top:8px">${escapeHtml(c.notes)}</div>` : ''}${oldDeliveries}${renderAlignerLedger(c)}${history}</article>`;
  }

  function pendingReworkIds(c) {
    return (c.aligners || []).filter(item => !item.superseded && item.stage >= 0 && item.events?.at(-1)?.outcome === 'rework' && item.events.at(-1).stage === item.stage).map(item => item.id);
  }

  function renderAlignerLedger(c) {
    const items = c.aligners || [];
    if (!items.length) return '';
    const rows = items.map(item => {
      const phase = phaseLabel(item.phase, item);
      const status = item.superseded ? 'Reemplazada' : item.stage >= STAGES.length ? 'Lista' : item.stage < 0 ? 'Pendiente' : STAGES[item.stage];
      const attempts = (item.attempts || []).map((count, index) => count ? `${STAGES[index]}: ${count} ${count === 1 ? 'intento' : 'intentos'}` : '').filter(Boolean).join(' · ');
      const failedLast = !item.superseded && item.events?.at(-1)?.outcome === 'rework' && item.events.at(-1).stage === item.stage;
      return `<div class="aligner-ledger-row"><strong>${escapeHtml(item.id)}</strong><span>${escapeHtml(phase)} · ${escapeHtml(status)}${failedLast ? ' · rehacer' : ''}${attempts ? ` · ${escapeHtml(attempts)}` : ''}</span></div>`;
    }).join('');
    return `<details class="aligner-ledger"><summary>Piezas · ${items.length}</summary><div class="aligner-ledger-list">${rows}</div></details>`;
  }

  function externalStatus(c) {
    if (c.shipment?.status === 'delivered') return 'Orden entregada';
    if (c.shipment?.status === 'transit') return 'Despachada · en tránsito';
    if (caseComplete(c)) return 'Lote completo · listo para enviar';
    const stage = nextWorkStage(c);
    if (stage < 0) return 'En cola';
    return `${workStepLabel(c, stage)} · etapa ${c.treatmentStages?.length || 1}`;
  }

  function renderProduction() {
    let cases = filteredCases(state.cases.filter(c => !c.archived && !caseComplete(c) && !c.shipment));
    if (productionFilter === 'own') cases = cases.filter(c => c.mode === 'own');
    if (productionFilter === 'external') cases = cases.filter(c => c.mode === 'external');
    byId('productionList').innerHTML = cases.length ? cases.map(c => {
      const own = c.mode === 'own';
      const action = stageButtonLabel(c);
      return `<article class="production-card"><div><div class="production-case">${escapeHtml(c.patient)}</div><div class="production-sub">${escapeHtml(c.code)} · ${escapeHtml(c.clinic)} · ${escapeHtml(archNames(c))}</div></div><div class="production-stage"><strong>${c.upperCount} sup. · ${c.lowerCount} inf.</strong>${escapeHtml(own ? ownStageLabel(c) : externalStatus(c))} · ${escapeHtml(progressSummary(c))} · entrega ${fmtDate(c.due)}</div><button class="button button-primary" onclick="window.AlignOS.action('${c.id}')">${escapeHtml(action)}</button></article>`;
    }).join('') : emptyState('Cola despejada', 'No hay trabajo pendiente con estos filtros.');
  }

  function renderStock() {
    const low = state.stock.filter(s => s.qty <= s.min).length;
    byId('stockSummary').innerHTML = `<div class="stock-stat"><span>Materiales activos</span><strong>${state.stock.length}</strong></div><div class="stock-stat"><span>En o bajo el mínimo</span><strong style="${low ? 'color:var(--red)' : ''}">${low}</strong></div><div class="stock-stat"><span>Consumos registrados</span><strong>${state.movements.filter(m => m.kind === 'consume').length}</strong></div>`;
    byId('stockList').innerHTML = state.stock.length ? state.stock.map(s => {
      const pct = s.min > 0 ? Math.min(100, Math.round((s.qty / (s.min * 3)) * 100)) : Math.min(100, s.qty);
      const rule = [STOCK_ID, ZERO_STOCK_ID, RETENTION_STOCK_ID].includes(s.id) ? `<label class="stock-use">Láminas / pieza <input type="number" min="0.1" max="10" step="0.1" value="${Number(s.perAligner || 1)}" data-stock-rule="${s.id}" data-rule-field="perAligner" aria-label="Láminas por pieza"></label>` : s.id === PACKAGING_ID ? `<label class="stock-use">Bolsas / envío <input type="number" min="1" max="20" step="1" value="${Number(s.perOrder || 1)}" data-stock-rule="${s.id}" data-rule-field="perOrder" aria-label="Bolsas por envío"></label>` : `<div class="stock-min">Mínimo ${s.min}</div>`;
      return `<div class="stock-row"><div><div class="stock-name">${escapeHtml(s.name)}</div><div class="stock-unit">${escapeHtml(s.unit)}</div>${rule}</div><div class="stock-bar"><span class="${s.qty <= s.min ? 'low' : ''}" style="width:${pct}%"></span></div><div><div class="stock-qty" style="${s.qty <= s.min ? 'color:var(--red)' : ''}">${s.qty}</div><div class="stock-min">mín. ${s.min}</div></div><button class="button button-quiet" onclick="window.AlignOS.restock('${s.id}')">＋ Reponer</button></div>`;
    }).join('') : emptyState('Sin materiales', 'Registrá una reposición inicial para empezar a controlar consumos.');
    byId('restockMaterial').innerHTML = state.stock.map(s => `<option value="${s.id}">${escapeHtml(s.name)} · ${s.qty} ${escapeHtml(s.unit)}</option>`).join('');
    byId('movementLedger').innerHTML = state.movements.length ? [...state.movements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map(m => `<div class="ledger-item"><span class="ledger-dot ${m.kind === 'restock' ? 'restock' : ''}"></span><div><div class="ledger-main">${escapeHtml(m.item)} ${m.kind === 'restock' ? '· reposición' : '· consumo'}</div><div class="ledger-sub">${fmtDate(m.date)}${m.note ? ` · ${escapeHtml(m.note)}` : ''}</div></div><span class="ledger-amount" style="color:${m.qty < 0 ? 'var(--red)' : 'var(--green)'}">${m.qty > 0 ? '+' : m.qty < 0 ? '−' : ''}${escapeHtml(quantityText(m.qty, m.unit))}</span></div>`).join('') : `<div class="empty-inline">Los movimientos aparecerán cuando se reponga o se produzca.</div>`;
  }

  function openModal(backdropId) { byId(backdropId).hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal(backdropId) { byId(backdropId).hidden = true; if ([...document.querySelectorAll('.modal-backdrop')].every(el => el.hidden)) document.body.style.overflow = ''; }
  function openCaseModal(mode, id = '') {
    const c = id ? safeCase(id) : null;
    if (c) mode = c.mode;
    const locked = c ? caseWorkStarted(c) : false;
    byId('caseForm').reset();
    byId('caseId').value = c?.id || '';
    byId('modalEyebrow').textContent = c ? 'ACTUALIZAR DATOS' : mode === 'own' ? 'MI CLÍNICA · PRODUCCIÓN FLEXIBLE' : 'OTRA CLÍNICA · ORDEN COMPLETA';
    byId('modalTitle').textContent = c ? 'Editar caso' : mode === 'own' ? 'Nuevo caso propio' : 'Nueva orden externa';
    byId('saveCaseBtn').textContent = c ? 'Guardar cambios' : 'Crear caso';
    byId('patientName').value = c?.patient || '';
    byId('clinicName').value = c?.clinic || (mode === 'own' ? 'Mi consultorio' : '');
    byId('orderCode').value = c?.code || '';
    byId('dueDate').value = c?.due || isoDate(14);
    byId('upperCount').value = c ? c.upperCount : 12;
    byId('lowerCount').value = c ? c.lowerCount : 12;
    byId('upperZero').checked = Boolean(c?.includeZeroUpper);
    byId('lowerZero').checked = Boolean(c?.includeZeroLower);
    byId('upperZero').disabled = locked;
    byId('lowerZero').disabled = locked;
    byId('caseNotes').value = c?.notes || '';
    byId('formModeInfo').textContent = mode === 'own' ? 'Cantidades independientes por arco.' : 'Se envía al completar el caso.';
    byId('caseForm').dataset.mode = mode;
    openModal('modalBackdrop');
    byId('patientName').focus();
  }

  function saveCase(event) {
    event.preventDefault();
    const existingId = byId('caseId').value;
    const mode = byId('caseForm').dataset.mode;
    const patient = byId('patientName').value.trim();
    const clinic = byId('clinicName').value.trim();
    const upperCount = Number(byId('upperCount').value);
    const lowerCount = Number(byId('lowerCount').value);
    const upperZero = byId('upperZero').checked;
    const lowerZero = byId('lowerZero').checked;
    if (!Number.isInteger(upperCount) || !Number.isInteger(lowerCount) || upperCount < 0 || lowerCount < 0 || upperCount + lowerCount < 1 || upperCount + lowerCount + Number(upperZero) + Number(lowerZero) > 240) return showToast('Ingresá entre 1 y 240 piezas en total');
    if ((upperZero && upperCount < 1) || (lowerZero && lowerCount < 1)) return showToast('El alineador 0 requiere al menos un alineador en ese arco');
    const codeInput = byId('orderCode').value.trim();
    if (codeInput && state.cases.some(c => String(c.code || '').toLocaleLowerCase('es') === codeInput.toLocaleLowerCase('es') && c.id !== existingId)) return showToast('Ese código ya está usado en otro caso');
    if (existingId) {
      const c = safeCase(existingId);
      if (!c) return showToast('El caso no está disponible');
      const workHasStarted = caseWorkStarted(c);
      if (workHasStarted && (upperCount !== c.upperCount || lowerCount !== c.lowerCount || upperZero !== Boolean(c.includeZeroUpper) || lowerZero !== Boolean(c.includeZeroLower))) return showToast('No se pueden cambiar piezas después de iniciar producción; conservá la trazabilidad');
      pushUndo();
      c.patient = patient; c.clinic = clinic; c.code = codeInput || c.code; c.due = byId('dueDate').value; c.upperCount = upperCount; c.lowerCount = lowerCount; c.includeZeroUpper = upperZero; c.includeZeroLower = lowerZero; c.notes = byId('caseNotes').value.trim();
      if (!workHasStarted) c.aligners = [...createAligners(upperCount, lowerCount, { upperZero, lowerZero }), ...createRetainers(upperCount > 0, lowerCount > 0)];
      recordEvent(c, 'Datos del caso actualizados');
      closeModal('modalBackdrop'); saveState(); renderAll(); showToast('Caso actualizado'); return;
    }
    const c = { id: uid(), mode, code: codeInput || nextCode(mode === 'own' ? 'MC' : 'OT'), patient, clinic, due: byId('dueDate').value, upperCount, lowerCount, includeZeroUpper: upperZero, includeZeroLower: lowerZero, aligners: [...createAligners(upperCount, lowerCount, { upperZero, lowerZero }), ...createRetainers(upperCount > 0, lowerCount > 0, 1)], treatmentStages: ['E1'], finalRetentionPhase: 'CONT1', archived: false, shipmentHistory: [], notes: byId('caseNotes').value.trim(), createdAt: Date.now(), shipment: null };
    c.events = [{ date: new Date().toISOString(), description: mode === 'own' ? 'Caso propio creado · cantidades por arco' : 'Orden externa creada · lote pendiente' }];
    pushUndo(); state.cases.push(c); closeModal('modalBackdrop'); saveState(); renderAll(); showToast(mode === 'own' ? 'Caso propio creado · sin consumo de material' : 'Orden externa creada · lote pendiente');
  }

  function caseWorkStarted(c) {
    const work = ensureWork(c);
    return Boolean(c.hasProductionActivity) || ['upper', 'lower'].some(key => work[key].complete > 0 || work[key].pending.slice(1).some(count => count > 0)) || Boolean(c.shipment) || (c.treatmentStages?.length || 1) > 1;
  }

  function openReprofileModal(id) {
    const c = safeCase(id);
    if (!c || !caseComplete(c)) return showToast('Terminá la etapa y sus contenciones antes de agregar otra');
    byId('reprofileCaseId').value = id;
    byId('reprofileUpperCount').value = c.upperCount ? c.upperCount : 0;
    byId('reprofileLowerCount').value = c.lowerCount ? c.lowerCount : 0;
    byId('reprofileUpperZero').checked = false; byId('reprofileLowerZero').checked = false;
    byId('reprofileUpperZero').disabled = !c.upperCount; byId('reprofileLowerZero').disabled = !c.lowerCount;
    const nextStage = (c.treatmentStages?.length || 1) + 1;
    byId('reprofilePatient').textContent = `${c.patient} · ${c.code} · etapa ${nextStage}`;
    byId('reprofileTitle').textContent = `Agregar etapa ${nextStage}`;
    openModal('reprofileBackdrop');
  }

  function saveReprofiling(event) {
    event.preventDefault();
    const c = safeCase(byId('reprofileCaseId').value);
    const upper = Number(byId('reprofileUpperCount').value); const lower = Number(byId('reprofileLowerCount').value);
    const upperZero = byId('reprofileUpperZero').checked; const lowerZero = byId('reprofileLowerZero').checked;
    if (!c || !caseComplete(c)) return showToast('Terminá la etapa actual antes de agregar otra');
    if (!Number.isInteger(upper) || !Number.isInteger(lower) || upper < 0 || lower < 0 || upper + lower < 1 || upper + lower + Number(upperZero) + Number(lowerZero) > 240) return showToast('Indicá entre 1 y 240 piezas de reperfilado');
    if ((upperZero && !upper) || (lowerZero && !lower)) return showToast('El alineador 0 requiere al menos una pieza en ese arco');
    pushUndo();
    const generation = (c.treatmentStages?.length || 1) + 1;
    const phase = `RP${generation}`;
    const retentionPhase = `CONT${generation}`;
    c.aligners.filter(item => item.kind === 'retainer' && !item.superseded).forEach(item => { item.superseded = true; });
    if (c.shipment) { c.shipmentHistory ||= []; c.shipmentHistory.push({ ...c.shipment }); c.shipment = null; }
    c.treatmentStages ||= ['E1']; c.treatmentStages.push(phase); c.finalRetentionPhase = retentionPhase; c.archived = false;
    c.aligners.push(...createAligners(upper, lower, { phase, upperZero, lowerZero }), ...createRetainers(c.upperCount > 0, c.lowerCount > 0, generation));
    recordEvent(c, `Etapa ${generation} · reperfilado agregado · ${upper} sup. · ${lower} inf.`);
    closeModal('reprofileBackdrop'); saveState(); renderAll(); showToast(`Etapa ${generation} agregada · ${c.code}`);
  }

  function confirmAction(title, body, buttonText, callback) {
    confirmCallback = callback;
    byId('confirmTitle').textContent = title;
    byId('confirmBody').textContent = body;
    byId('confirmAccept').textContent = buttonText;
    openModal('confirmBackdrop');
  }

  function action(id) {
    const c = safeCase(id);
    if (!c) return showToast('El caso ya no está disponible');
    if (c.shipment?.status === 'transit') return markExternalDelivered(id);
    if (c.shipment?.status === 'delivered') return showToast('La orden ya está entregada');
    if (caseComplete(c)) return c.mode === 'external' ? openShipment(id) : showToast('Este caso ya está completo');
    return processCase(id, nextWorkStage(c));
  }

  function stockForUnit(unit) { return state.stock.find(s => s.id === (unit.materialId || STOCK_ID)); }
  function consumeSheets(stockId, amount, caseLabel) {
    const item = state.stock.find(s => s.id === stockId);
    if (!item || item.qty < amount) return { ok: false, missing: amount - (item?.qty || 0), item };
    item.qty -= amount;
    state.movements.unshift({ id: uid('m'), item: item.name, qty: -amount, unit: item.unit, kind: 'consume', note: caseLabel, date: isoDate(0) });
    return { ok: true, item };
  }

  function processCase(id, stage) {
    const c = safeCase(id); if (!c || stage < 0 || stage >= STAGES.length) return;
    const aligners = (c.aligners || []).filter(item => item.stage === stage);
    if (!aligners.length) return showToast('No hay piezas esperando esta etapa');
    byId('workCaseId').value = id; byId('workStage').value = stage;
    const workLabel = aligners.every(item => item.kind === 'retainer') ? `Contenciones · ${STAGES[stage]}` : STAGES[stage];
    byId('workTitle').textContent = `${workLabel} · ${c.patient}`;
    byId('workEyebrow').textContent = `${c.mode === 'own' ? 'MI CLÍNICA' : 'ORDEN EXTERNA'} · ${c.code}`;
    byId('workHelp').textContent = 'Elegí las piezas y marcá el resultado.';
    const archFields = [['upper', 'Superior'], ['lower', 'Inferior']].map(([key, label]) => {
      const pieces = aligners.filter(item => item.arch === key);
      if (!pieces.length) return '';
      return `<fieldset class="work-arch field field-wide"><legend>${label} · ${pieces.length} piezas</legend><div class="aligner-batch-list">${pieces.map(item => `<div class="aligner-batch-row"><label><input type="checkbox" class="batch-item" data-aligner-id="${item.id}" checked><strong>${item.id}</strong><small>${phaseLabel(item.phase, item)}</small></label><select class="batch-result" data-aligner-id="${item.id}" aria-label="Resultado de ${item.id}"><option value="good">Conforme</option><option value="rework">Rehacer</option></select></div>`).join('')}</div></fieldset>`;
    }).join('');
    byId('workFields').innerHTML = `<div class="batch-selection-tools"><span>Seleccionar piezas</span><div><button type="button" class="button button-quiet" data-batch-select="all">Todas</button><button type="button" class="button button-quiet" data-batch-select="none">Ninguna</button></div></div>${archFields}`;
    byId('workMaterialInfo').hidden = stage !== 1;
    byId('workSubmit').disabled = false;
    byId('workForm').dataset.mode = c.mode;
    if (stage === 1) updateWorkMaterialInfo();
    openModal('workBackdrop');
  }

  function updateWorkMaterialInfo() {
    if (Number(byId('workStage').value) !== 1) return;
    const c = safeCase(byId('workCaseId').value);
    const selectedIds = new Set([...byId('workFields').querySelectorAll('.batch-item:checked')].map(input => input.dataset.alignerId));
    const needs = materialNeeds(c, selectedIds);
    const lines = needs.map(({ stock, need }) => stock ? `${quantityText(need, stock.unit)} de ${stock.name} · disponible ${quantityText(stock.qty, stock.unit)}` : `${need} lámina(s) de material no configurado`);
    const missing = needs.some(({ stock, need }) => !stock || stock.qty < need);
    byId('workMaterialInfo').textContent = needs.length ? `Consumo: ${lines.join(' · ')}. Incluye rehacer.` : 'Seleccioná piezas.';
    byId('workSubmit').disabled = missing || !needs.length;
  }

  function materialNeeds(c, selectedIds) {
    const groups = new Map();
    for (const unit of c?.aligners || []) {
      if (!selectedIds.has(unit.id)) continue;
      const stock = stockForUnit(unit);
      if (!stock) { groups.set(unit.materialId || STOCK_ID, { stock: null, need: 1 }); continue; }
      const current = groups.get(stock.id) || { stock, need: 0 };
      current.need += Number(stock.perAligner || 1);
      groups.set(stock.id, current);
    }
    return [...groups.values()].map(group => ({ ...group, need: Number(group.need.toFixed(2)) }));
  }

  function saveWork(event) {
    event.preventDefault();
    const c = safeCase(byId('workCaseId').value); const stage = Number(byId('workStage').value);
    if (!c || stage < 0 || stage >= STAGES.length) return showToast('No se encuentra la tanda');
    const selected = [...byId('workFields').querySelectorAll('.batch-item:checked')];
    if (!selected.length) return showToast('Seleccioná al menos un alineador para esta tanda');
    const outcomes = selected.map(input => ({ item: c.aligners.find(item => item.id === input.dataset.alignerId), outcome: byId('workFields').querySelector(`.batch-result[data-aligner-id="${input.dataset.alignerId}"]`)?.value }));
    if (outcomes.some(entry => !entry.item || entry.item.stage !== stage || !['good', 'rework'].includes(entry.outcome))) return showToast('La tanda cambió; volvé a abrirla para actualizar los alineadores pendientes');
    const needs = stage === 1 ? materialNeeds(c, new Set(selected.map(input => input.dataset.alignerId))) : [];
    const shortage = needs.find(({ stock, need }) => !stock || stock.qty < need);
    if (shortage) return showToast(`Stock insuficiente de ${shortage.stock?.name || 'material de termoformado'}`);
    pushUndo();
    for (const { stock, need } of needs) consumeSheets(stock.id, need, `${c.code} · ${STAGES[stage]} · ${selected.length} piezas (${outcomes.filter(row => row.item.materialId === stock.id).map(row => row.item.id).join(', ')})`);
    const failed = { upper: [], lower: [] }; const advanced = { upper: [], lower: [] };
    const retentionPhase = c.finalRetentionPhase || 'CONT1';
    const retainersWereLocked = phaseUnits(c, retentionPhase).some(item => item.stage === -2);
    for (const { item, outcome } of outcomes) {
      item.attempts ||= [0, 0, 0, 0]; item.events ||= [];
      item.attempts[stage] = (item.attempts[stage] || 0) + 1;
      item.events.push({ date: new Date().toISOString(), stage, outcome, attempt: item.attempts[stage] });
      if (outcome === 'rework') failed[item.arch].push(item.id);
      else { item.stage++; advanced[item.arch].push(item.id); }
    }
    const moved = advanced.upper.length + advanced.lower.length; const rework = failed.upper.length + failed.lower.length;
    const idSummary = (label, ids, word) => ids.length ? `${label} ${word} ${ids.join(', ')}` : '';
    const details = [idSummary('Avanzan', advanced.upper.concat(advanced.lower), '·'), idSummary('Rehacer', failed.upper.concat(failed.lower), '·')].filter(Boolean).join(' | ');
    c.hasProductionActivity = true;
    advanceTreatmentFlow(c);
    if (c.mode === 'own' && caseComplete(c)) c.archived = true;
    const usedText = needs.map(({ stock, need }) => `${quantityText(need, stock.unit)} ${stock.name}`).join(' · ');
    recordEvent(c, `${STAGES[stage]} · ${details}${usedText ? ` · ${usedText}` : ''}`);
    const retentionUnlocked = retainersWereLocked && phaseUnits(c, retentionPhase).some(item => item.stage >= 0);
    const workLabel = outcomes.every(({ item }) => item.kind === 'retainer') ? `Contenciones · ${STAGES[stage]}` : STAGES[stage];
    closeModal('workBackdrop'); saveState(); renderAll(); showToast(`${workLabel} registrada · ${moved} avanzan${rework ? ` · ${rework} para rehacer` : ''}${retentionUnlocked ? ' · contenciones habilitadas' : ''}`);
  }

  function directWork(id) {
    const c = safeCase(id);
    if (!c || c.shipment || caseComplete(c)) return;
    const units = (c.aligners || []).filter(item => !item.superseded && item.stage >= 0 && item.stage < STAGES.length);
    if (!units.length) return showToast('No hay piezas listas para fabricar');
    byId('directWorkCaseId').value = id;
    byId('directWorkEyebrow').textContent = `${c.mode === 'own' ? 'MI CLÍNICA' : 'ORDEN EXTERNA'} · ${c.code}`;
    byId('directWorkTitle').textContent = `Completar piezas · ${c.patient}`;
    byId('directWorkHelp').textContent = 'Seleccioná las piezas que vas a fabricar completas. Si alguna falla, marcá en qué etapa para dejarla identificada y pendiente de rehacer.';
    const archGroups = [['upper', 'Superior'], ['lower', 'Inferior']].map(([arch, label]) => {
      const pieces = units.filter(item => item.arch === arch);
      if (!pieces.length) return '';
      return `<fieldset class="work-arch direct-work-arch"><legend>${label} · ${pieces.length} piezas</legend><div class="aligner-batch-list">${pieces.map(item => {
        const fromStage = Math.max(0, item.stage);
        const options = [`<option value="complete">Completar</option>`, ...STAGES.slice(fromStage).map((stage, offset) => `<option value="${fromStage + offset}">Rehacer en ${stage}</option>`)].join('');
        return `<div class="aligner-batch-row"><label><input type="checkbox" class="direct-item" data-aligner-id="${item.id}"><strong>${item.id}</strong><small>${phaseLabel(item.phase, item)} · ${STAGES[item.stage]}</small></label><select class="direct-result" data-aligner-id="${item.id}" aria-label="Resultado de ${item.id}">${options}</select></div>`;
      }).join('')}</div></fieldset>`;
    }).join('');
    byId('directWorkFields').innerHTML = `<div class="batch-selection-tools"><span>Seleccioná las piezas de esta tanda</span><div><button type="button" class="button button-quiet" data-direct-select="all">Todas</button><button type="button" class="button button-quiet" data-direct-select="none">Ninguna</button></div></div>${archGroups}`;
    byId('directWorkSubmit').disabled = false;
    updateDirectMaterialInfo();
    openModal('directWorkBackdrop');
  }

  function updateDirectMaterialInfo() {
    const c = safeCase(byId('directWorkCaseId').value);
    if (!c) return;
    const selected = [...byId('directWorkFields').querySelectorAll('.direct-item:checked')];
    const selectedUnits = selected.map(input => c.aligners.find(item => item.id === input.dataset.alignerId)).filter(Boolean);
    const thermoformIds = new Set(selectedUnits.filter(item => {
      const result = byId('directWorkFields').querySelector(`.direct-result[data-aligner-id="${item.id}"]`)?.value;
      return item.stage <= 1 && result !== '0';
    }).map(item => item.id));
    const needs = thermoformIds.size ? materialNeeds(c, thermoformIds) : [];
    const lines = needs.map(({ stock, need }) => stock ? `${quantityText(need, stock.unit)} de ${stock.name}` : `${need} lámina(s) de material no configurado`);
    const shortage = needs.find(({ stock, need }) => !stock || stock.qty < need);
    byId('directWorkInfo').textContent = !selected.length ? 'Seleccioná al menos una pieza.'
      : needs.length ? `Consumo al termoformar: ${lines.join(' · ')}. ${shortage ? `Falta stock de ${shortage.stock?.name || 'material de termoformado'}.` : `Disponible para esta tanda.`}`
        : 'Las piezas ya pasaron por termoformado o se rehacen en impresión; no se descuenta material en esta tanda.';
    byId('directWorkSubmit').disabled = !selected.length || !!shortage;
  }

  function saveDirectWork(event) {
    event.preventDefault();
    const c = safeCase(byId('directWorkCaseId').value);
    if (!c || c.shipment || caseComplete(c)) return showToast('El caso cambió; actualizá la tarjeta y volvé a abrir la fabricación');
    const selected = [...byId('directWorkFields').querySelectorAll('.direct-item:checked')];
    if (!selected.length) return showToast('Seleccioná al menos una pieza');
    const outcomes = selected.map(input => ({ item: c.aligners.find(item => item.id === input.dataset.alignerId), result: byId('directWorkFields').querySelector(`.direct-result[data-aligner-id="${input.dataset.alignerId}"]`)?.value }));
    if (outcomes.some(({ item, result }) => !item || item.superseded || item.stage < 0 || item.stage >= STAGES.length || (result !== 'complete' && (!Number.isInteger(Number(result)) || Number(result) < item.stage || Number(result) >= STAGES.length)))) return showToast('Una pieza cambió; volvé a abrir la fabricación para actualizar la selección');
    const thermoformIds = new Set(outcomes.filter(({ item, result }) => item.stage <= 1 && result !== '0').map(({ item }) => item.id));
    const needs = thermoformIds.size ? materialNeeds(c, thermoformIds) : [];
    const shortage = needs.find(({ stock, need }) => !stock || stock.qty < need);
    if (shortage) return showToast(`Stock insuficiente de ${shortage.stock?.name || 'material de termoformado'}`);
    pushUndo();
    for (const { stock, need } of needs) consumeSheets(stock.id, need, `${c.code} · fabricación completa · ${thermoformIds.size} piezas (${outcomes.filter(row => thermoformIds.has(row.item.id)).map(row => row.item.id).join(', ')})`);
    const completed = []; const failures = [];
    for (const { item, result } of outcomes) {
      item.attempts ||= [0, 0, 0, 0]; item.events ||= [];
      const failAt = result === 'complete' ? null : Number(result);
      for (let stage = Math.max(0, item.stage); stage < STAGES.length; stage++) {
        const outcome = stage === failAt ? 'rework' : 'good';
        item.attempts[stage] = (item.attempts[stage] || 0) + 1;
        item.events.push({ date: new Date().toISOString(), stage, outcome, attempt: item.attempts[stage] });
        if (outcome === 'rework') { item.stage = stage; failures.push(`${item.id} · ${STAGES[stage]}`); break; }
        item.stage = stage + 1;
      }
      if (item.stage >= STAGES.length) completed.push(item.id);
    }
    c.hasProductionActivity = true;
    advanceTreatmentFlow(c);
    if (c.mode === 'own' && caseComplete(c)) c.archived = true;
    const usedText = needs.map(({ stock, need }) => `${quantityText(need, stock.unit)} ${stock.name}`).join(' · ');
    recordEvent(c, `Fabricación completa · ${completed.length} listas${completed.length ? ` (${completed.join(', ')})` : ''}${failures.length ? ` · rehacer ${failures.join(', ')}` : ''}${usedText ? ` · ${usedText}` : ''}`);
    closeModal('directWorkBackdrop'); saveState(); renderAll();
    showToast(`${completed.length} piezas listas${failures.length ? ` · ${failures.length} para rehacer` : ''}${usedText ? ` · ${usedText}` : ''}`);
  }

  function openShipment(id) {
    const c = safeCase(id); if (!c) return;
    byId('shipmentCaseId').value = id; byId('shipmentCarrier').value = ''; byId('shipmentTracking').value = ''; byId('shipmentNote').value = '';
    byId('shipmentTitle').textContent = `Enviar · ${c.patient}`;
    const packaging = state.stock.find(s => s.id === PACKAGING_ID);
    const packagingNeed = packaging?.perOrder || 0;
    byId('shipmentMaterialInfo').textContent = !packaging ? 'Falta configurar el material de empaque. Registrá bolsas en Materiales antes de despachar.' : packaging.qty < packagingNeed ? `Este envío requiere ${quantityText(packagingNeed, packaging.unit)}; hay ${quantityText(packaging.qty, packaging.unit)}. Reponé antes de despachar.` : `Al registrar el despacho se descontarán ${quantityText(packagingNeed, packaging.unit)} de empaque. Quedarán ${quantityText(packaging.qty - packagingNeed, packaging.unit)}.`;
    byId('shipmentSubmit').disabled = !packaging || packaging.qty < packagingNeed;
    openModal('shipmentBackdrop');
  }

  function saveShipment(event) {
    event.preventDefault();
    const c = safeCase(byId('shipmentCaseId').value); if (!c || !caseComplete(c)) return showToast('La orden necesita completar todos los alineadores y el control final antes del envío');
    const packaging = state.stock.find(s => s.id === PACKAGING_ID);
    const packagingNeed = packaging?.perOrder || 0;
    if (!packaging || !Number.isInteger(packagingNeed) || packagingNeed < 1 || packaging.qty < packagingNeed) return showToast('Falta empaque suficiente para este envío');
    pushUndo(); packaging.qty -= packagingNeed;
    state.movements.unshift({ id: uid('m'), item: packaging.name, qty: -packagingNeed, unit: packaging.unit, kind: 'consume', note: `Despacho ${c.code}`, date: isoDate(0) });
    c.shipment = { carrier: byId('shipmentCarrier').value.trim(), tracking: byId('shipmentTracking').value.trim(), note: byId('shipmentNote').value.trim(), date: isoDate(0), status: 'transit' }; c.archived = true; recordEvent(c, `Orden despachada · archivada${c.shipment.carrier ? ` · ${c.shipment.carrier}` : ''}${c.shipment.tracking ? ` · guía ${c.shipment.tracking}` : ''} · ${quantityText(packagingNeed, packaging.unit)}`);
    closeModal('shipmentBackdrop'); saveState(); renderAll(); showToast('Despacho registrado');
  }

  function markExternalDelivered(id) {
    const c = safeCase(id); if (!c?.shipment || c.shipment.status !== 'transit') return;
    confirmAction('¿Archivar entrega?', `${c.patient} · ${c.code}`, 'Archivar', () => {
      pushUndo(); c.shipment.status = 'delivered'; c.shipment.deliveredDate = isoDate(0); c.archived = true; recordEvent(c, 'Orden entregada · archivada'); saveState(); renderAll(); showToast('Entrega archivada');
    });
  }

  function openRestock(id = '') {
    byId('restockForm').reset();
    if (id) byId('restockMaterial').value = id;
    openModal('restockBackdrop');
  }

  function saveRestock(event) {
    event.preventDefault();
    const item = state.stock.find(s => s.id === byId('restockMaterial').value);
    const qty = Number(byId('restockQuantity').value);
    if (!item || !Number.isInteger(qty) || qty < 1) return showToast('Ingresá una cantidad entera mayor que cero');
    pushUndo(); item.qty += qty;
    state.movements.unshift({ id: uid('m'), item: item.name, qty, unit: item.unit, kind: 'restock', note: byId('restockNote').value.trim() || 'Reposición manual', date: isoDate(0) });
    closeModal('restockBackdrop'); saveState(); renderAll(); showToast(`Stock actualizado · +${quantityText(qty, item.unit)}`);
  }

  function saveStockRule(event) {
    const field = event.target.closest('[data-stock-rule]');
    if (!field) return;
    const item = state.stock.find(s => s.id === field.dataset.stockRule);
    const value = Number(field.value);
    const ruleField = field.dataset.ruleField;
    const valid = ruleField === 'perAligner' ? [STOCK_ID, ZERO_STOCK_ID, RETENTION_STOCK_ID].includes(field.dataset.stockRule) && Number.isFinite(value) && value > 0 && value <= 10 : ruleField === 'perOrder' ? Number.isInteger(value) && value >= 1 && value <= 20 : false;
    if (!item || !valid) { showToast('La regla de consumo no es válida'); renderStock(); return; }
    if (item[ruleField] === value) return;
    pushUndo(); item[ruleField] = value; saveState(); renderAll(); showToast('Regla de consumo actualizada');
  }

  function resetDemo() {
    confirmAction('¿Restablecer la demo?', 'Se reemplazarán solo los datos locales de este prototipo por sus ejemplos iniciales. No se conecta ni escribe en la base de tu aplicación actual.', 'Restablecer demo', () => {
      undoStack = []; updateUndoButton(); state = sampleState(); saveState(); renderAll(); showToast('Datos de muestra restablecidos');
    });
  }

  function handleGlobalSearch() { renderDashboard(); renderOwnCases(); renderExternalCases(); renderProduction(); }

  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
  document.querySelectorAll('[data-open-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.openView)));
  document.querySelectorAll('[data-new-mode]').forEach(button => button.addEventListener('click', () => openCaseModal(button.dataset.newMode)));
  byId('newCaseBtn').addEventListener('click', () => openCaseModal(currentView === 'externos' ? 'external' : 'own'));
  byId('caseForm').addEventListener('submit', saveCase);
  byId('reprofileForm').addEventListener('submit', saveReprofiling);
  byId('workForm').addEventListener('submit', saveWork);
  byId('workForm').addEventListener('input', updateWorkMaterialInfo);
  byId('directWorkForm').addEventListener('submit', saveDirectWork);
  byId('directWorkFields').addEventListener('change', updateDirectMaterialInfo);
  byId('directWorkFields').addEventListener('click', event => {
    const button = event.target.closest('[data-direct-select]');
    if (!button) return;
    const checked = button.dataset.directSelect === 'all';
    byId('directWorkFields').querySelectorAll('.direct-item').forEach(input => { input.checked = checked; });
    updateDirectMaterialInfo();
  });
  byId('workFields').addEventListener('click', event => {
    const button = event.target.closest('[data-batch-select]');
    if (!button) return;
    const checked = button.dataset.batchSelect === 'all';
    byId('workFields').querySelectorAll('.batch-item').forEach(input => { input.checked = checked; });
    updateWorkMaterialInfo();
  });
  byId('workFields').addEventListener('change', event => { if (event.target.matches('.batch-item')) updateWorkMaterialInfo(); });
  byId('globalSearch').addEventListener('input', handleGlobalSearch);
  byId('undoBtn').addEventListener('click', undoLast);
  byId('resetDemoBtn').addEventListener('click', resetDemo);
  byId('resetDemoFromStock').addEventListener('click', resetDemo);
  byId('closeModal').addEventListener('click', () => closeModal('modalBackdrop'));
  byId('cancelModal').addEventListener('click', () => closeModal('modalBackdrop'));
  byId('confirmCancel').addEventListener('click', () => closeModal('confirmBackdrop'));
  byId('confirmAccept').addEventListener('click', () => { const fn = confirmCallback; confirmCallback = null; closeModal('confirmBackdrop'); fn?.(); });
  byId('restockBtn').addEventListener('click', () => openRestock());
  byId('restockForm').addEventListener('submit', saveRestock);
  byId('stockList').addEventListener('change', saveStockRule);
  byId('shipmentForm').addEventListener('submit', saveShipment);
  document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
  byId('ownFilters').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (!button) return; ownFilter = button.dataset.filter; byId('ownFilters').querySelectorAll('button').forEach(b => b.classList.toggle('selected', b === button)); renderOwnCases(); });
  byId('externalFilters').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (!button) return; externalFilter = button.dataset.filter; byId('externalFilters').querySelectorAll('button').forEach(b => b.classList.toggle('selected', b === button)); renderExternalCases(); });
  byId('productionTabs').addEventListener('click', event => { const button = event.target.closest('[data-production]'); if (!button) return; productionFilter = button.dataset.production; byId('productionTabs').querySelectorAll('button').forEach(b => b.classList.toggle('selected', b === button)); renderProduction(); });
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(backdrop.id); }));
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); byId('globalSearch').focus(); }
    if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop:not([hidden])').forEach(modal => closeModal(modal.id));
  });
  window.AlignOS = { action, process: processCase, direct: directWork, edit: id => openCaseModal('own', id), restock: openRestock, reprofile: openReprofileModal };

  const hashView = location.hash.replace('#', '');
  showView(['inicio', 'propios', 'externos', 'produccion', 'materiales'].includes(hashView) ? hashView : 'inicio');
})();


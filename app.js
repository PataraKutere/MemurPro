'use strict';

const STORAGE_KEYS = {
  saved: 'memurpro.saved.v1',
  profile: 'memurpro.profile.v1',
  tracking: 'memurpro.tracking.v1'
};

const state = {
  view: 'overview',
  listings: [],
  saved: readJSON(STORAGE_KEYS.saved, []),
  profile: readJSON(STORAGE_KEYS.profile, null),
  tracking: readJSON(STORAGE_KEYS.tracking, {}),
  filters: { q: '', city: '', education: '', score: '', type: '' }
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function readJSON(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2600);
}

function setView(view) {
  const validViews = ['overview', 'listings', 'saved', 'tools'];
  if (!validViews.includes(view)) return;
  state.view = view;
  $$('.view').forEach(panel => panel.classList.toggle('active', panel.id === `view-${view}`));
  $$('.nav-link, .mobile-nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  const names = { overview: 'Genel Bakış', listings: 'Kamu İlanları', saved: 'Takip Listem', tools: 'Araçlar' };
  $('#breadcrumbCurrent').textContent = names[view];
  if (view === 'saved') renderSaved();
  if (view === 'listings') renderListings();
  if (view === 'overview') renderMatchedListings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateSavedCount() {
  $('#savedCount').textContent = String(state.saved.length);
}

function isSaved(id) {
  return state.saved.some(item => item.id === id);
}

function toggleSaved(listing) {
  if (isSaved(listing.id)) {
    state.saved = state.saved.filter(item => item.id !== listing.id);
    delete state.tracking[listing.id];
    localStorage.setItem(STORAGE_KEYS.tracking, JSON.stringify(state.tracking));
    showToast('İlan takip listenden çıkarıldı.');
  } else {
    state.saved.push(listing);
    showToast('İlan takip listene eklendi.');
  }
  localStorage.setItem(STORAGE_KEYS.saved, JSON.stringify(state.saved));
  updateSavedCount();
  if (state.view === 'saved') renderSaved();
  else if (state.view === 'listings') renderListings();
}

function listingCard(listing) {
  const saved = isSaved(listing.id);
  const status = listing.status === 'open' ? 'Başvuru açık' : (listing.status === 'closed' ? 'Başvuru kapandı' : 'Kontrol gerekli');
  const chips = [listing.city, listing.education, listing.scoreType, listing.category]
    .filter(Boolean).map(item => `<span class="meta-chip">${escapeHTML(item)}</span>`).join('');
  const endDate = listing.endDate ? new Date(`${listing.endDate}T23:59:59`) : null;
  const deadline = endDate && !Number.isNaN(endDate.getTime()) ? `Son başvuru: ${endDate.toLocaleDateString('tr-TR')}` : 'Son tarih kaynakta kontrol edilmeli';
  return `<article class="listing-card">
    <div><div class="listing-org">${escapeHTML(listing.institution || 'Kurum bilgisi belirtilmemiş')}</div>
      <h3>${escapeHTML(listing.title || 'İsimsiz ilan')}</h3>
      <p>${escapeHTML(listing.summary || '')}</p>
      <div class="listing-meta">${chips}<span class="meta-chip">${escapeHTML(deadline)}</span></div>
      <div class="listing-meta"><span class="listing-status">${escapeHTML(status)}</span><span class="meta-chip">Kaynak: ${escapeHTML(listing.sourceName || 'Resmî kaynak')}</span></div>
    </div>
    <div class="listing-actions"><button class="save-button ${saved ? 'saved' : ''}" data-save-id="${escapeHTML(listing.id)}" aria-label="${saved ? 'Takipten çıkar' : 'Takibe al'}" title="${saved ? 'Takipten çıkar' : 'Takibe al'}">${saved ? '★' : '☆'}</button>
      ${listing.url ? `<a class="details-button" href="${escapeHTML(listing.url)}" target="_blank" rel="noopener">Resmî ilana git ↗</a>` : ''}
    </div>
  </article>`;
}

function applyFilters(listings) {
  const f = state.filters;
  return listings.filter(item => {
    const haystack = `${item.title || ''} ${item.institution || ''} ${item.summary || ''}`.toLocaleLowerCase('tr-TR');
    if (f.q && !haystack.includes(f.q.toLocaleLowerCase('tr-TR'))) return false;
    if (f.city && item.city !== f.city && item.city !== 'Türkiye Geneli') return false;
    if (f.education && item.education !== f.education) return false;
    if (f.score && item.scoreType !== f.score) return false;
    if (f.type && item.category !== f.type && item.category !== f.type) return false;
    return true;
  });
}

function sortListings(listings) {
  const sort = $('#sortFilter')?.value || 'newest';
  return [...listings].sort((a, b) => {
    if (sort === 'institution') return (a.institution || '').localeCompare(b.institution || '', 'tr');
    if (sort === 'deadline') return (a.endDate || '9999-12-31').localeCompare(b.endDate || '9999-12-31');
    return (b.publishedAt || '').localeCompare(a.publishedAt || '');
  });
}

function renderListings() {
  const filtered = sortListings(applyFilters(state.listings));
  $('#listingCount').textContent = `${filtered.length} kayıt`;
  $('#resultSummary').textContent = state.listings.length
    ? `${filtered.length} ilan gösteriliyor.`
    : 'Canlı ilan kaynağı henüz bağlanmadı.';
  if (!state.listings.length) {
    $('#listingResults').innerHTML = `<div class="listing-placeholder"><div class="empty-icon">⌕</div><strong>Henüz doğrulanmış ilan bulunmuyor</strong><p>MemurPro, resmî kaynaklardan veri bağlantıları tamamlanmadan ilan uydurmaz veya eski ilanları güncelmiş gibi göstermez. Kaynaklar bağlandığında arama ve filtreler burada çalışacak.</p><button class="button button-outline" data-go="overview">Kaynak durumunu gör</button></div>`;
    return;
  }
  $('#listingResults').innerHTML = filtered.length ? filtered.map(listingCard).join('') : `<div class="listing-placeholder"><strong>Bu kriterlerle eşleşen ilan yok</strong><p>Filtrelerini değiştirerek yeniden deneyebilirsin.</p></div>`;
}

function getProfileMatch(listing) {
  const profile = state.profile;
  const hasScore = profile && profile.score !== null && profile.score !== undefined && profile.score !== '';
  if (!profile || !(profile.education || profile.scoreType || profile.city || hasScore)) return null;
  let points = 0;
  let known = 0;
  const reasons = [];
  if (profile.education) {
    if (listing.education) {
      known++;
      if (listing.education === profile.education) { points += 3; reasons.push('Öğrenim uyumu'); }
      else return { matched: false, points: 0, reasons: ['Öğrenim düzeyi farklı'] };
    }
  }
  if (profile.scoreType) {
    if (listing.scoreType) {
      known++;
      if (listing.scoreType === profile.scoreType) { points += 3; reasons.push('KPSS türü uyumu'); }
      else if (listing.scoreType !== 'KPSS şartı yok') return { matched: false, points: 0, reasons: ['KPSS puan türü farklı'] };
    } else if (/KPSS şartı yok/i.test(listing.summary || '')) {
      known++;
      points += 2;
      reasons.push('KPSS şartı aranmıyor');
    }
  }
  if (profile.city) {
    if (listing.city) {
      known++;
      if (listing.city.toLocaleLowerCase('tr-TR') === profile.city.toLocaleLowerCase('tr-TR') || listing.city === 'Türkiye Geneli') {
        points += listing.city === 'Türkiye Geneli' ? 1 : 2;
        reasons.push(listing.city === 'Türkiye Geneli' ? 'Türkiye geneli' : 'Şehir uyumu');
      } else return { matched: false, points: 0, reasons: ['Şehir tercihi farklı'] };
    }
  }
  if (Number.isFinite(Number(profile.score)) && profile.score !== null && profile.score !== '') {
    if (Number.isFinite(Number(listing.minimumScore))) {
      known++;
      if (Number(profile.score) >= Number(listing.minimumScore)) {
        points += 2;
        reasons.push('Puan barajı karşılanıyor');
      } else return { matched: false, points: 0, reasons: ['KPSS puanı barajın altında'] };
    }
  }
  return { matched: true, points, known, reasons };
}

function renderMatchedListings() {
  const container = $('#matchedListings');
  if (!container) return;
  const profile = state.profile;
  if (!profile || !(profile.education || profile.scoreType || profile.city || (profile.score !== null && profile.score !== undefined && profile.score !== ''))) {
    container.innerHTML = `<div class="listing-placeholder"><strong>Aday profilini tamamla</strong><p>Öğrenim, KPSS türü, puan ve şehir bilgilerini ekleyerek ilan eşleştirmesini etkinleştir. Bilgilerin yalnızca bu cihazda saklanır.</p><button class="button button-outline" data-go="tools">Aday profilini oluştur</button></div>`;
    return;
  }
  const matches = state.listings.map(item => ({ item, match: getProfileMatch(item) }))
    .filter(entry => entry.match && entry.match.matched)
    .sort((a,b) => b.match.points-a.match.points || (b.item.publishedAt || '').localeCompare(a.item.publishedAt || ''));
  if (!matches.length) {
    container.innerHTML = `<div class="listing-placeholder"><strong>Şu an eşleşen ilan bulunamadı</strong><p>Bu, uygun ilan olmadığı anlamına kesin olarak gelmez. Kaynaklarda öğrenim, puan türü veya şehir bilgisi eksik olabilir. Profilini güncelleyebilir ya da tüm ilanları inceleyebilirsin.</p><button class="button button-outline" data-go="listings">Tüm ilanları gör</button></div>`;
    return;
  }
  container.innerHTML = matches.slice(0,4).map(({item,match}) => {
    const reasons = match.reasons.length ? match.reasons.join(' · ') : 'İlan şartlarında çelişen bilgi yok; ayrıntıları resmî kaynaktan doğrula.';
    return listingCard(item).replace('<div class="listing-org">', `<div class="match-reasons">${escapeHTML(reasons)}</div><div class="listing-org">`);
  }).join('');
}

const APPLICATION_STATUSES = [
  ['review', 'İncelenecek'],
  ['documents', 'Evrak hazırlanıyor'],
  ['applied', 'Başvuruldu'],
  ['waiting', 'Sonuç bekleniyor'],
  ['positive', 'Olumlu'],
  ['negative', 'Olumsuz']
];

function getTracking(id) {
  return state.tracking[id] || { status: 'review', deadline: '' };
}

function saveTracking(id, patch) {
  state.tracking[id] = { ...getTracking(id), ...patch, updatedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEYS.tracking, JSON.stringify(state.tracking));
}

function deadlineLabel(value) {
  if (!value) return 'Son başvuru tarihi girilmedi';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 'Geçersiz tarih';
  const left = daysBetween(new Date(), date);
  if (left < 0) return `Son tarih ${Math.abs(left)} gün geçti`;
  if (left === 0) return 'Son başvuru bugün';
  return `${left} gün kaldı`;
}

function renderSaved() {
  const container = $('#savedResults');
  if (!state.saved.length) {
    container.innerHTML = `<div class="listing-placeholder"><div class="empty-icon">☆</div><strong>Henüz takip ettiğin ilan yok</strong><p>İlanlar bölümünde bir ilanı yıldızlayarak buraya ekleyebilirsin. Kayıtların bu tarayıcıda saklanır.</p><button class="button button-outline" data-go="listings">İlanları keşfet</button></div>`;
    return;
  }
  const ordered = [...state.saved].sort((a, b) => {
    const da = getTracking(a.id).deadline || a.endDate || '9999-12-31';
    const db = getTracking(b.id).deadline || b.endDate || '9999-12-31';
    return da.localeCompare(db);
  });
  const today = new Date(); today.setHours(0,0,0,0);
  const deadlines = ordered.filter(item => {
    const value = getTracking(item.id).deadline || item.endDate;
    return value && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
  });
  const dueSoon = deadlines.filter(item => {
    const value = getTracking(item.id).deadline || item.endDate;
    const days = daysBetween(today, new Date(`${value}T00:00:00`));
    return days >= 0 && days <= 7;
  }).length;
  const overdue = deadlines.filter(item => {
    const value = getTracking(item.id).deadline || item.endDate;
    return daysBetween(today, new Date(`${value}T00:00:00`)) < 0;
  }).length;
  const summary = `<div class="tracking-summary"><span><strong>${state.saved.length}</strong> takip edilen ilan</span><span><strong>${dueSoon}</strong> 7 gün içinde</span><span><strong>${overdue}</strong> tarihi geçen</span></div>`;
  container.innerHTML = summary + ordered.map(item => {
    const tracking = getTracking(item.id);
    const deadline = tracking.deadline || item.endDate || '';
    const options = APPLICATION_STATUSES.map(([value, label]) => `<option value="${value}" ${tracking.status === value ? 'selected' : ''}>${label}</option>`).join('');
    const days = deadlineLabel(deadline);
    const tone = days.includes('geçti') ? ' overdue' : days.includes('bugün') || days.includes('kaldı') ? ' upcoming' : '';
    const controls = `<div class="application-tracker">
      <label><span>Başvuru durumu</span><select data-track-status="${escapeHTML(item.id)}">${options}</select></label>
      <label><span>Son başvuru tarihi</span><input type="date" value="${escapeHTML(deadline)}" data-track-deadline="${escapeHTML(item.id)}"></label>
      <span class="deadline-countdown${tone}">${escapeHTML(days)}</span>
    </div>`;
    return listingCard(item).replace('</article>', `${controls}</article>`);
  }).join('');
}

async function loadLiveData() {
  try {
    const apiBase = String(window.MEMURPRO_API_BASE || '').replace(/\/$/, '');
    if (!apiBase) return null; // GitHub Pages tek başına kullanılıyorsa API çağrısı yapma.
    const response = await fetch(`${apiBase}/api/listings`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.listings)) throw new Error('Beklenmeyen API yanıtı');
    state.listings = payload.listings;
    renderListings();
    renderMatchedListings();
    if (state.view === 'saved') renderSaved();
    if (payload.sources) renderSourceStatuses(payload.sources);
    return payload;
  } catch {
    // API yoksa uygulama kontrollü ön izleme durumunda kalır; sahte ilan eklenmez.
    return null;
  }
}

function renderSourceStatuses(sources) {
  const rows = new Map(sources.map(source => [source.name, source]));
  $$('.source-row').forEach(row => {
    const name = $('strong', row)?.textContent;
    const source = rows.get(name);
    if (!source) return;
    const stateEl = $('.source-state', row);
    if (!stateEl) return;
    const labels = { connected: 'Bağlı', pending: 'İlk kontrol bekleniyor', failed: 'Erişim hatası' };
    stateEl.textContent = labels[source.status] || 'Durum bilinmiyor';
    stateEl.className = `source-state ${source.status || 'pending'}`;
    const detailEl = $('.source-copy small', row);
    const details = [];
    if (source.lastError) details.push(source.lastError);
    else if (source.checkedAt) details.push(`Son kontrol: ${new Date(source.checkedAt).toLocaleString('tr-TR')}`);
    else details.push('Otomatik kontrol henüz çalışmadı.');
    if (detailEl) {
      detailEl.textContent = details.join(' · ');
      detailEl.title = details.join(' · ');
    }
    stateEl.title = details.join(' · ');
  });
}

function bindFilters() {
  state.filters = {
    q: $('#searchInput').value.trim(),
    city: $('#cityFilter').value,
    education: $('#educationFilter').value,
    score: $('#scoreFilter').value,
    type: $('#typeFilter').value
  };
  renderListings();
}

function daysBetween(today, target) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.ceil((end - start) / 86400000);
}

function calculateAge() {
  const value = $('#birthDate').value;
  const maxAgeValue = $('#maxAge').value;
  const result = $('#ageResult');
  if (!value) return setToolResult(result, 'Önce doğum tarihini gir.', 'warning');
  const birth = new Date(`${value}T00:00:00`);
  const now = new Date();
  if (Number.isNaN(birth.getTime()) || birth > now) return setToolResult(result, 'Geçerli bir doğum tarihi gir.', 'warning');
  let age = now.getFullYear() - birth.getFullYear();
  const birthdayThisYear = new Date(now.getFullYear(), birth.getMonth(), birth.getDate());
  if (now < birthdayThisYear) age--;
  const maxAge = maxAgeValue === '' ? null : Number(maxAgeValue);
  const limitText = maxAge === null ? '' : (age <= maxAge ? ` ${maxAge} yaş sınırına göre yaş şartını karşılıyorsun.` : ` ${maxAge} yaş sınırını aşıyorsun.`);
  setToolResult(result, `Bugün itibarıyla yaşın ${age}.${limitText} İlanın yaş hesabı için belirttiği tarihi ve yöntemi ayrıca kontrol et.`, maxAge === null ? '' : (age <= maxAge ? 'success' : 'warning'));
}

function calculateScore() {
  const type = $('#toolScoreType').value;
  const mine = Number($('#myScore').value);
  const required = Number($('#requiredScore').value);
  const result = $('#scoreResult');
  if ($('#myScore').value === '' || $('#requiredScore').value === '' || !Number.isFinite(mine) || !Number.isFinite(required) || mine < 0 || mine > 100 || required < 0 || required > 100) {
    return setToolResult(result, '0–100 arasında geçerli iki puan gir.', 'warning');
  }
  const delta = mine - required;
  const text = delta >= 0
    ? `${type} puanın barajın ${delta.toFixed(2)} puan üzerinde. Bu yalnızca puan şartı karşılaştırmasıdır; yerleşme garantisi değildir.`
    : `${type} puanın barajın ${Math.abs(delta).toFixed(2)} puan altında. Diğer başvuru şartlarını da ayrıca incele.`;
  setToolResult(result, text, delta >= 0 ? 'success' : 'warning');
}

function calculateDeadline() {
  const value = $('#deadlineDate').value;
  const result = $('#deadlineResult');
  if (!value) return setToolResult(result, 'Son başvuru tarihini seç.', 'warning');
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return setToolResult(result, 'Geçerli bir tarih gir.', 'warning');
  const left = daysBetween(new Date(), date);
  if (left < 0) setToolResult(result, `Bu tarih ${Math.abs(left)} gün önce geçti. Başvuru kapanmış olabilir.`, 'warning');
  else if (left === 0) setToolResult(result, 'Son başvuru tarihi bugün. Saat ve başvuru kanalını resmî ilandan kontrol et.', 'warning');
  else setToolResult(result, `Son başvuru tarihine ${left} gün kaldı. Başvuru saatini resmî ilandan kontrol et.`, 'success');
}

function setToolResult(element, message, kind = '') {
  element.textContent = message;
  element.className = `tool-result ${kind}`.trim();
}

function saveProfile() {
  const profile = {
    education: $('#profileEducation').value,
    scoreType: $('#profileScore').value,
    score: $('#profileScoreValue').value === '' ? null : Number($('#profileScoreValue').value),
    city: $('#profileCity').value.trim(),
    savedAt: new Date().toISOString()
  };
  if (profile.score !== null && (!Number.isFinite(profile.score) || profile.score < 0 || profile.score > 100)) {
    return setToolResult($('#profileResult'), 'KPSS puanı 0–100 arasında olmalı.', 'warning');
  }
  localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(profile));
  state.profile = profile;
  setToolResult($('#profileResult'), 'Tercihlerin bu tarayıcıya kaydedildi. Sunucuya gönderilmedi.', 'success');
  renderMatchedListings();
  showToast('Aday tercihlerin kaydedildi.');
}

function populateProfile() {
  if (!state.profile) return;
  $('#profileEducation').value = state.profile.education || '';
  $('#profileScore').value = state.profile.scoreType || '';
  $('#profileScoreValue').value = state.profile.score ?? '';
  $('#profileCity').value = state.profile.city || '';
}

function showProfileTool() {
  setView('tools');
  $('#profileEducation').focus({ preventScroll: true });
  showToast('Aday tercihlerini Araçlar bölümünden düzenleyebilirsin.');
}

async function refreshSources() {
  const button = $('#refreshSources');
  const apiBase = String(window.MEMURPRO_API_BASE || '').replace(/\/$/, '');
  if (!apiBase) return showToast('Kaynak kontrol API adresi ayarlanmamış.');
  if (button?.disabled) return;

  if (button) {
    button.disabled = true;
    button.textContent = 'Kaynaklar kontrol ediliyor…';
  }

  try {
    // The Worker keeps this request open until every source has finished.
    const response = await fetch(`${apiBase}/api/sync-now`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `API ${response.status}`);

    await loadLiveData();
    const results = Array.isArray(payload.results) ? payload.results : [];
    const processed = results.reduce((sum, item) => sum + (Number(item.imported) || 0), 0);
    const failed = results.filter(item => item.status === 'failed').length;
    const connected = results.filter(item => item.status === 'connected').length;
    const skipped = results.filter(item => item.skipped || item.status === 'pending').length;
    const summary = results.map(item => {
      const state = item.status === 'connected' ? '✓' : item.status === 'failed' ? '!' : '–';
      return `${state} ${item.source}${item.message ? ': ' + item.message : ''}`;
    }).join('\n');
    if (summary) console.info('MemurPro kaynak kontrolü:\n' + summary);
    if (failed) {
      showToast(`Kontrol bitti: ${connected} bağlı, ${failed} hatalı, ${skipped} beklemede.`);
    } else if (!connected && skipped) {
      showToast('Yeni kontrol yapılmadı; kaynakların kontrol aralığı henüz dolmadı.');
    } else {
      showToast(`Kontrol tamamlandı: ${processed} kayıt işlendi, ${connected} kaynak bağlı.`);
    }
  } catch (error) {
    showToast(`Kaynak kontrolü başlatılamadı: ${error.message}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Şimdi kontrol et ↻';
    }
  }
}

function bindEvents() {
  $$('.nav-link, .mobile-nav-link').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('[data-go]').forEach(button => button.addEventListener('click', () => setView(button.dataset.go)));
  $$('[data-filter-category]').forEach(button => button.addEventListener('click', () => {
    setView('listings');
    const category = button.dataset.filterCategory;
    $('#typeFilter').value = category;
    bindFilters();
  }));
  $('#applyFilters').addEventListener('click', bindFilters);
  $('#searchInput').addEventListener('keydown', event => { if (event.key === 'Enter') bindFilters(); });
  $('#sortFilter').addEventListener('change', renderListings);
  $('#clearFilters').addEventListener('click', () => {
    ['searchInput','cityFilter','educationFilter','scoreFilter','typeFilter'].forEach(id => { $(`#${id}`).value = ''; });
    bindFilters();
  });
  document.addEventListener('change', event => {
    const statusControl = event.target.closest('[data-track-status]');
    const deadlineControl = event.target.closest('[data-track-deadline]');
    if (statusControl) {
      saveTracking(statusControl.dataset.trackStatus, { status: statusControl.value });
      showToast('Başvuru durumu kaydedildi.');
    }
    if (deadlineControl) {
      saveTracking(deadlineControl.dataset.trackDeadline, { deadline: deadlineControl.value });
      renderSaved();
      showToast('Son başvuru tarihi kaydedildi.');
    }
  });
  document.addEventListener('click', event => {
    const saveButton = event.target.closest('[data-save-id]');
    if (saveButton) {
      const item = [...state.listings, ...state.saved].find(listing => listing.id === saveButton.dataset.saveId);
      if (item) toggleSaved(item);
    }
    const goButton = event.target.closest('[data-go]');
    if (goButton && goButton.closest('.listing-placeholder')) setView(goButton.dataset.go);
  });
  $('#calculateAge').addEventListener('click', calculateAge);
  $('#checkScore').addEventListener('click', calculateScore);
  $('#calculateDeadline').addEventListener('click', calculateDeadline);
  $('#saveProfile').addEventListener('click', saveProfile);
  $('#profileButton').addEventListener('click', showProfileTool);
  $('#editMatchProfile')?.addEventListener('click', showProfileTool);
  $('#refreshSources')?.addEventListener('click', refreshSources);
}

function init() {
  const now = new Date();
  $('#todayLabel').textContent = now.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  updateSavedCount();
  populateProfile();
  bindEvents();
  renderListings();
  renderSaved();
  loadLiveData();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);

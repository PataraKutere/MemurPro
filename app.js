'use strict';

const STORAGE_KEYS = {
  saved: 'memurpro.saved.v1',
  profile: 'memurpro.profile.v1',
  tracking: 'memurpro.tracking.v1'
};

const state = {
  view: 'overview',
  listings: [],
  sources: [],
  saved: readJSON(STORAGE_KEYS.saved, []),
  profile: readJSON(STORAGE_KEYS.profile, null),
  tracking: readJSON(STORAGE_KEYS.tracking, {}),
  filters: { q: '', city: '', education: '', score: '', type: '', source: '' }
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

function decodeHtmlEntities(value) {
  let text = String(value ?? '');
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ccedil: 'ç', Ccedil: 'Ç', uuml: 'ü', Uuml: 'Ü', ouml: 'ö', Ouml: 'Ö', gbreve: 'ğ', Gbreve: 'Ğ', scedil: 'ş', Scedil: 'Ş', idot: 'ı', Idot: 'İ' };
  for (let pass = 0; pass < 4; pass++) {
    const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (code[0] === '#') {
        const hex = code[1]?.toLowerCase() === 'x';
        const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\\uFFFD';
      }
      return Object.prototype.hasOwnProperty.call(named, code) ? named[code] : entity;
    });
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

function escapeHTML(value) {
  return decodeHtmlEntities(value).replace(/[&<>"']/g, char => ({
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

function formatListingDate(value) {
  if (!value) return '';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function listingFact(label, value) {
  return `<div class="listing-fact"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value || 'Kaynakta belirtilmemiş')}</strong></div>`;
}

function safeListingUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function listingCard(listing) {
  const saved = isSaved(listing.id);
  const status = listing.status === 'open' ? 'Başvuru açık' : (listing.status === 'closed' ? 'Başvuru kapandı' : 'Kontrol gerekli');
  const start = formatListingDate(listing.startDate);
  const end = formatListingDate(listing.endDate);
  const dateRange = start && end ? `${start} – ${end}` : start ? `${start} – Bitiş tarihi belirtilmemiş` : end ? `Başlangıç belirtilmemiş – ${end}` : 'Başvuru tarih aralığı kaynakta belirtilmemiş';
  const education = listing.education || 'Aranan bölüm / öğrenim şartı belirtilmemiş';
  const score = listing.scoreType
    ? `${listing.scoreType}${listing.minimumScore !== null && listing.minimumScore !== undefined && listing.minimumScore !== '' ? ` · Asgari ${listing.minimumScore} puan` : ' · Asgari puan belirtilmemiş'}`
    : (/KPSS şartı yok|KPSS aranmıyor/i.test(listing.summary || '') ? 'KPSS şartı aranmadığı belirtilmiş' : 'KPSS şartı / puan bilgisi belirtilmemiş');
  const chips = [listing.city, listing.category].filter(Boolean)
    .map(item => `<span class="meta-chip">${escapeHTML(item)}</span>`).join('');
  const url = safeListingUrl(listing.url || listing.detailUrl);
  return `<article class="listing-card">
    <div class="listing-main">
      <div class="listing-org">${escapeHTML(listing.institution || 'Kurum bilgisi belirtilmemiş')}</div>
      <h3>${escapeHTML(listing.title || 'İsimsiz ilan')}</h3>
      <div class="listing-facts">
        ${listingFact('Başvuru tarihleri', dateRange)}
        ${listingFact('Aranan bölümler / öğrenim', education)}
        ${listingFact('KPSS şartı ve puan', score)}
      </div>
      ${listing.summary ? `<p class="listing-summary">${escapeHTML(listing.summary)}</p>` : ''}
      ${eligibilityMarkup(listing)}
      <div class="listing-meta">${chips}<span class="listing-status">${escapeHTML(status)}</span><span class="meta-chip">Kaynak: ${escapeHTML(listing.sourceName || 'Resmî kaynak')}</span></div>
    </div>
    <div class="listing-actions">
      <button class="save-button ${saved ? 'saved' : ''}" data-save-id="${escapeHTML(listing.id)}" aria-label="${saved ? 'Takipten çıkar' : 'Takibe al'}" title="${saved ? 'Takipten çıkar' : 'Takibe al'}">${saved ? '★' : '☆'}</button>
      <button class="details-button" type="button" data-detail-id="${escapeHTML(listing.id)}">İlan detayları</button>
      ${url ? `<a class="details-button official-link" href="${escapeHTML(url)}" target="_blank" rel="noopener">Resmî ilana git ↗</a>` : ''}
    </div>
  </article>`;
}

function updateCityFilter() {
  const select = $('#cityFilter');
  if (!select) return;
  const selected = select.value;
  const existing = new Set([...select.options].map(option => normalizeSearchText(option.value)));
  const cities = [...new Set(state.listings.map(item => String(item.city || '').trim()).filter(city => city && city !== 'Türkiye Geneli'))]
    .sort((a, b) => a.localeCompare(b, 'tr'));
  for (const city of cities) {
    if (existing.has(normalizeSearchText(city))) continue;
    const option = document.createElement('option');
    option.value = city;
    option.textContent = city;
    select.appendChild(option);
  }
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function updateSourceFilter() {
  const select = $('#sourceFilter');
  if (!select) return;
  const selected = select.value || state.filters.source || '';
  // Filtre seçeneklerini yalnızca Genel Bakış > Veri Kaynakları bölümündeki
  // resmî kaynak satırlarından üret. API yanıtı gelmese bile seçenekler görünür.
  const names = new Map(
    Array.from(document.querySelectorAll('.source-row .source-copy strong'))
      .map(element => [element.textContent.trim(), null])
      .filter(([name]) => name)
  );
  state.sources.forEach(source => {
    if (!source?.name) return;
    const officialName = [...names.keys()].find(name =>
      name.toLocaleLowerCase('tr-TR') === String(source.name).toLocaleLowerCase('tr-TR')
    );
    if (officialName) names.set(officialName, source);
  });
  const counts = new Map();
  state.listings.forEach(item => {
    const sourceNames = String(item.sourceName || '').split(' · ').map(name => name.trim()).filter(Boolean);
    for (const name of new Set(sourceNames)) counts.set(name, (counts.get(name) || 0) + 1);
  });
  const options = [...names.entries()].sort((a,b) => a[0].localeCompare(b[0], 'tr'));
  select.innerHTML = '<option value="">Tüm kaynaklar</option>' + options.map(([name, source]) => {
    const count = counts.get(name) || 0;
    const status = source?.status === 'connected' ? ' · bağlantı aktif' :
      source?.status === 'degraded' ? ' · kısmi sorun' :
      source?.status === 'failed' ? ' · erişilemiyor' :
      source?.status === 'pending' ? ' · beklemede' : '';
    return '<option value="' + escapeHTML(name) + '">' + escapeHTML(name) + ' · ' + count + ' ilan' + status + '</option>';
  }).join('');
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
  else if (selected) {
    state.filters.source = '';
    select.value = '';
  }
}

function normalizeSearchText(value) {
  return String(value ?? '').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
}

function listingSearchText(item) {
  const excluded = new Set(['id', 'externalId', 'detailUrl', 'url']);
  return Object.entries(item || {})
    .filter(([key, value]) => !excluded.has(key) && value !== null && value !== undefined)
    .map(([, value]) => Array.isArray(value) ? value.join(' ') : typeof value === 'object' ? JSON.stringify(value) : String(value))
    .join(' ');
}

function applyFilters(listings) {
  const f = state.filters;
  return listings.filter(item => {
    const allText = normalizeSearchText(listingSearchText(item));
    const qualificationText = normalizeSearchText([item.education, item.summary, item.title].filter(Boolean).join(' '));
    if (f.q && !allText.includes(normalizeSearchText(f.q))) return false;
    if (f.department && !qualificationText.includes(normalizeSearchText(f.department))) return false;
    if (f.city && normalizeSearchText(item.city) !== normalizeSearchText(f.city) && item.city !== 'Türkiye Geneli') return false;
    if (f.education && !qualificationText.includes(normalizeSearchText(f.education))) return false;
    if (f.score && !normalizeSearchText([item.scoreType, item.summary].join(' ')).includes(normalizeSearchText(f.score))) return false;
    if (f.type && normalizeSearchText(item.category) !== normalizeSearchText(f.type)) return false;
    if (f.source) {
      const itemSources = String(item.sourceName || '').split(' · ').map(name => normalizeSearchText(name));
      if (!itemSources.includes(normalizeSearchText(f.source))) return false;
    }
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

function hasCandidateProfile() {
  const p = state.profile;
  return Boolean(p && (p.education || p.department || p.scoreType || p.city || (p.score !== null && p.score !== undefined && p.score !== '')));
}

function normalizeEducation(value) {
  const text = String(value || '').toLocaleLowerCase('tr-TR').replace(/\\s+/g, ' ').trim();
  if (/ön ?lisans|on ?lisans|associate/.test(text)) return 'ön lisans';
  if (/orta ?öğretim|lise|ortaöğretim/.test(text)) return 'ortaöğretim';
  if (/lisans|üniversite/.test(text)) return 'lisans';
  if (/doktora|doktora/.test(text)) return 'doktora';
  return text;
}

function assessListing(listing) {
  if (!hasCandidateProfile()) return { status: 'unknown', label: 'Profil gerekli', checks: ['Aday profilini tamamla.'] };
  const p = state.profile;
  const checks = [];
  let failed = false;
  let unknown = false;
  const markUnknown = (message) => { unknown = true; checks.push(message); };
  const markPass = (message) => checks.push(message);
  const markFail = (message) => { failed = true; checks.push(message); };

  if (p.department) {
    const requirementText = normalizeSearchText([listing.education, listing.summary, listing.title].filter(Boolean).join(' '));
    if (!requirementText) markUnknown('İlanın bölüm şartı kaynak verisinde yok.');
    else if (requirementText.includes(normalizeSearchText(p.department))) markPass(`${p.department} bölüm/program adı ilanda geçiyor.`);
    else markUnknown(`İlan metninde ${p.department} bölüm/programı doğrulanamadı; tam ilan şartını kontrol et.`);
  }
  if (p.education) {
    const listingEducation = normalizeEducation([listing.education, listing.summary].filter(Boolean).join(' '));
    const candidateEducation = normalizeEducation(p.education);
    if (!listingEducation) markUnknown('İlanın öğrenim şartı kaynak verisinde yok.');
    else if (listingEducation.includes(candidateEducation)) markPass('Öğrenim düzeyi ilan metninde eşleşiyor.');
    else markFail(`İlanın öğrenim şartı profilindeki ${p.education} düzeyiyle eşleşmiyor.`);
  }
  if (p.scoreType) {
    if (listing.scoreType) {
      if (/KPSS şartı yok|KPSS aranmıyor/i.test(listing.scoreType)) markPass('Bu ilanda KPSS puan türü şartı görünmüyor.');
      else if (String(listing.scoreType).toUpperCase().includes(String(p.scoreType).toUpperCase())) markPass(`${p.scoreType} puan türü eşleşiyor.`);
      else markFail(`Puan türü farklı: ${listing.scoreType}.`);
    } else if (/KPSS şartı yok|KPSS aranmıyor/i.test(listing.summary || '')) {
      markPass('İlan metninde KPSS şartı aranmadığı belirtiliyor.');
    } else markUnknown('KPSS puan türü ilan verisinde doğrulanmamış.');
  }
  if (p.city) {
    if (!listing.city) markUnknown('Görev yeri ilan verisinde belirtilmemiş.');
    else if (String(listing.city).toLocaleLowerCase('tr-TR') === String(p.city).toLocaleLowerCase('tr-TR') || listing.city === 'Türkiye Geneli') {
      markPass(listing.city === 'Türkiye Geneli' ? 'Türkiye geneli ilana şehir tercihinle başvurabilirsin.' : 'Şehir tercihin eşleşiyor.');
    } else markFail(`Görev yeri farklı: ${listing.city}.`);
  }
  const hasScore = p.score !== null && p.score !== undefined && p.score !== '' && Number.isFinite(Number(p.score));
  if (hasScore) {
    if (listing.minimumScore === null || listing.minimumScore === undefined || listing.minimumScore === '') markUnknown('Asgari KPSS puanı kaynak verisinde yok.');
    else if (Number(p.score) >= Number(listing.minimumScore)) markPass(`Puanın asgari ${Number(listing.minimumScore)} şartını karşılıyor.`);
    else markFail(`Puanın asgari ${Number(listing.minimumScore)} şartının altında.`);
  }
  const status = failed ? 'ineligible' : unknown ? 'unknown' : 'eligible';
  const label = status === 'eligible' ? 'Bilinen şartlarla uyumlu' : status === 'ineligible' ? 'En az bir şart uyuşmuyor' : 'Şartlar eksik — kontrol gerekli';
  if (!checks.length) checks.push('Profil bilgisi veya ilan şartı yetersiz.');
  return { status, label, checks };
}

function eligibilityMarkup(listing) {
  if (!hasCandidateProfile()) return '';
  const result = assessListing(listing);
  const details = result.checks.map(item => `<li>${escapeHTML(item)}</li>`).join('');
  return `<div class="eligibility-result ${result.status}">
    <strong>${escapeHTML(result.label)}</strong>
    <ul>${details}</ul>
    <small>Ön değerlendirmedir; nihai şartlar resmî ilanda ve eklerinde kontrol edilmelidir.</small>
  </div>`;
}
function renderMatchedListings() {
  const container = $('#matchedListings');
  if (!container) return;
  if (!hasCandidateProfile()) {
    container.innerHTML = `<div class="listing-placeholder"><strong>Aday profilini tamamla</strong><p>Öğrenim, KPSS türü, puan ve şehir bilgilerini ekleyerek ilan şartlarını karşılaştır. Bilgilerin yalnızca bu cihazda saklanır.</p><button class="button button-outline" data-go="tools">Aday profilini oluştur</button></div>`;
    return;
  }
  const evaluated = state.listings.map(item => ({ item, result: assessListing(item) }));
  const candidates = evaluated.filter(entry => entry.result.status !== 'ineligible')
    .sort((a,b) => {
      const rank = { eligible: 0, unknown: 1, ineligible: 2 };
      return rank[a.result.status] - rank[b.result.status] || (b.item.publishedAt || '').localeCompare(a.item.publishedAt || '');
    });
  if (!candidates.length) {
    container.innerHTML = `<div class="listing-placeholder"><strong>Bilinen şartlarla uyuşan ilan yok</strong><p>İlanların tamamında profilinle çelişen en az bir bilgi bulundu. Yine de resmî ilanları kendin incele; kaynak verileri eksik veya güncel olmayabilir.</p><button class="button button-outline" data-go="listings">Tüm ilanları gör</button></div>`;
    return;
  }
  container.innerHTML = candidates.slice(0,4).map(({item}) => listingCard(item)).join('');
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
  return state.tracking[id] || { status: 'review', deadline: '', steps: {}, documents: [] };
}

const APPLICATION_STEPS = [
  ['reviewed', 'Resmî ilanı ve eklerini inceledim'],
  ['conditions', 'Özel şartları ve başvuru yöntemini kontrol ettim'],
  ['prepared', 'Gerekli belgeleri hazırladım'],
  ['submitted', 'Başvurumu gönderdim'],
  ['confirmed', 'Başvuru / kayıt onayını sakladım']
];

const DEFAULT_DOCUMENTS = [
  { id: 'identity', label: 'Kimlik belgesi', note: 'İlan veya başvuru sistemi istiyorsa' },
  { id: 'diploma', label: 'Diploma / mezuniyet belgesi', note: 'İlanın öğrenim şartına göre' },
  { id: 'kpss', label: 'KPSS sonuç belgesi', note: 'KPSS şartı bulunan ilanlarda' },
  { id: 'photo', label: 'Fotoğraf', note: 'Kurum talep ediyorsa' },
  { id: 'other', label: 'Diğer kurum belgeleri', note: 'Sertifika, sağlık raporu, ehliyet vb. — ilana göre' }
];

function checklistMarkup(item, tracking) {
  const steps = tracking.steps || {};
  const documents = Array.isArray(tracking.documents) && tracking.documents.length
    ? tracking.documents
    : DEFAULT_DOCUMENTS;
  const completed = APPLICATION_STEPS.filter(([key]) => steps[key]).length;
  const percent = Math.round(completed / APPLICATION_STEPS.length * 100);
  const stepRows = APPLICATION_STEPS.map(([key, label]) => `
    <label class="checklist-row">
      <input type="checkbox" data-track-step="${escapeHTML(item.id)}" data-step-key="${key}" ${steps[key] ? 'checked' : ''}>
      <span>${escapeHTML(label)}</span>
    </label>`).join('');
  const documentRows = documents.map(doc => `
    <div class="document-row">
      <label class="checklist-row">
        <input type="checkbox" data-doc-check="${escapeHTML(item.id)}" data-doc-key="${escapeHTML(doc.id)}" ${doc.done ? 'checked' : ''}>
        <span><strong>${escapeHTML(doc.label)}</strong><small>${escapeHTML(doc.note || 'Kişisel kontrol kalemi')}</small></span>
      </label>
      ${doc.custom ? `<button type="button" class="remove-doc" data-remove-doc="${escapeHTML(item.id)}" data-doc-key="${escapeHTML(doc.id)}" aria-label="Belgeyi kaldır">×</button>` : ''}
    </div>`).join('');
  return `<section class="application-checklist" aria-label="Başvuru kontrol listesi">
    <div class="checklist-heading"><div><strong>Başvuru adımları</strong><small>${completed}/${APPLICATION_STEPS.length} adım tamamlandı</small></div><b>${percent}%</b></div>
    <div class="checklist-progress"><span style="width:${percent}%"></span></div>
    <div class="checklist-steps">${stepRows}</div>
    <div class="documents-heading"><strong>Evrak kontrol listesi</strong><small>Belgeler otomatik olarak zorunlu kabul edilmez; resmî ilandaki listeyi esas al.</small></div>
    <div class="document-list">${documentRows}</div>
    <div class="add-document-row"><input type="text" maxlength="100" placeholder="İlana özel belge ekle" data-doc-input="${escapeHTML(item.id)}"><button type="button" data-add-doc="${escapeHTML(item.id)}">Ekle +</button></div>
  </section>`;
}

function addCustomDocument(id) {
  const input = $('[data-doc-input]').find(element => element.dataset.docInput === String(id));
  const label = input?.value.trim();
  if (!label) return showToast('Önce eklenecek belge adını yaz.');
  const tracking = getTracking(id);
  const documents = Array.isArray(tracking.documents) && tracking.documents.length
    ? [...tracking.documents]
    : DEFAULT_DOCUMENTS.map(doc => ({ ...doc }));
  documents.push({ id: `custom-${Date.now()}`, label, note: 'Kişisel eklediğin kontrol kalemi', done: false, custom: true });
  saveTracking(id, { documents });
  renderSaved();
  showToast('Belge kontrol listene eklendi.');
}

function removeCustomDocument(id, docId) {
  const tracking = getTracking(id);
  const documents = (Array.isArray(tracking.documents) && tracking.documents.length
    ? tracking.documents
    : DEFAULT_DOCUMENTS.map(doc => ({ ...doc }))).filter(doc => doc.id !== docId);
  saveTracking(id, { documents });
  renderSaved();
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

function renderReminderCenter(items) {
  const today = new Date(); today.setHours(0,0,0,0);
  const reminders = [];
  items.forEach(item => {
    const tracking = getTracking(item.id);
    const deadline = tracking.deadline || item.endDate || '';
    const lead = Number(tracking.reminderDays ?? 3);
    if (deadline && lead > 0) {
      const date = new Date(`${deadline}T00:00:00`);
      if (!Number.isNaN(date.getTime())) {
        const left = daysBetween(today, date);
        if (left >= 0 && left <= lead) reminders.push({ item, date, kind: 'deadline', left, label: left === 0 ? 'Son başvuru bugün' : `Son başvuruya ${left} gün kaldı` });
      }
    }
    if (tracking.resultDate) {
      const date = new Date(`${tracking.resultDate}T00:00:00`);
      if (!Number.isNaN(date.getTime())) {
        const left = daysBetween(today, date);
        if (left >= 0 && left <= 30) reminders.push({ item, date, kind: 'result', left, label: left === 0 ? 'Beklenen sonuç tarihi bugün' : `Beklenen sonuç tarihine ${left} gün kaldı` });
      }
    }
  });
  reminders.sort((a,b) => a.date - b.date || a.item.title.localeCompare(b.item.title, 'tr'));
  const rows = reminders.length ? reminders.map(reminder => `
    <div class="reminder-row">
      <span class="reminder-date">${reminder.date.toLocaleDateString('tr-TR',{day:'2-digit',month:'short'})}</span>
      <div><strong>${escapeHTML(reminder.item.title)}</strong><small>${escapeHTML(reminder.label)} · ${reminder.kind === 'deadline' ? 'Başvuru son tarihi' : 'Sonuç takibi'}</small></div>
    </div>`).join('') : `<div class="reminder-empty">Yaklaşan hatırlatma yok. Son başvuru veya beklenen sonuç tarihini eklediğinde burada görünecek.</div>`;
  return `<section class="reminder-center"><div class="reminder-center-head"><div><strong>Yaklaşan tarihler</strong><small>Başvuru ve sonuç takvimin</small></div><span>${reminders.length} hatırlatma</span></div><div class="reminder-list">${rows}</div><p class="reminder-note">Bu hatırlatmalar MemurPro'yu açtığında takip listende görünür; uygulama kapalıyken otomatik bildirim gönderilmez.</p></section>`;
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
  const reminderCenter = renderReminderCenter(ordered);
  container.innerHTML = summary + reminderCenter + ordered.map(item => {
    const tracking = getTracking(item.id);
    const deadline = tracking.deadline || item.endDate || '';
    const options = APPLICATION_STATUSES.map(([value, label]) => `<option value="${value}" ${tracking.status === value ? 'selected' : ''}>${label}</option>`).join('');
    const days = deadlineLabel(deadline);
    const tone = days.includes('geçti') ? ' overdue' : days.includes('bugün') || days.includes('kaldı') ? ' upcoming' : '';
    const controls = `<div class="application-tracker">
      <label><span>Başvuru durumu</span><select data-track-status="${escapeHTML(item.id)}">${options}</select></label>
      <label><span>Son başvuru tarihi</span><input type="date" value="${escapeHTML(deadline)}" data-track-deadline="${escapeHTML(item.id)}"></label>
      <label><span>Hatırlatma</span><select data-track-reminder="${escapeHTML(item.id)}">
        <option value="0" ${Number(tracking.reminderDays ?? 3)===0?'selected':''}>Kapalı</option>
        <option value="1" ${Number(tracking.reminderDays ?? 3)===1?'selected':''}>1 gün önce</option>
        <option value="3" ${Number(tracking.reminderDays ?? 3)===3?'selected':''}>3 gün önce</option>
        <option value="7" ${Number(tracking.reminderDays ?? 3)===7?'selected':''}>7 gün önce</option>
        <option value="14" ${Number(tracking.reminderDays ?? 3)===14?'selected':''}>14 gün önce</option>
      </select></label>
      <label><span>Beklenen sonuç tarihi</span><input type="date" value="${escapeHTML(tracking.resultDate || '')}" data-track-result="${escapeHTML(item.id)}"></label>
      <span class="deadline-countdown${tone}">${escapeHTML(days)}</span>
    </div>${checklistMarkup(item, tracking)}`;
    return listingCard(item).replace('</article>', `${controls}</article>`);
  }).join('');
}

async function loadLiveData() {
  try {
    const apiBase = String(window.MEMURPRO_API_BASE || '').replace(/\/$/, '');
    if (!apiBase) return null; // GitHub Pages tek başına kullanılıyorsa API çağrısı yapma.
    const response = await fetch(`${apiBase}/api/listings?limit=200`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`API ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.listings)) throw new Error('Beklenmeyen API yanıtı');
    state.listings = payload.listings;
    updateCityFilter();
    state.sources = Array.isArray(payload.sources) ? payload.sources : state.sources;
    updateSourceFilter();
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
  state.sources = Array.isArray(sources) ? sources : [];
  updateSourceFilter();
  const footnote = $('#sourceAutomationStatus');
  if (footnote) {
    const checked = sources.map(source => source.checkedAt).filter(Boolean).map(value => new Date(value)).filter(date => !Number.isNaN(date.getTime())).sort((a, b) => b - a)[0];
    const failed = sources.filter(source => source.status === 'failed').length;
    const degraded = sources.filter(source => source.status === 'degraded').length;
    const pending = sources.filter(source => source.status === 'pending').length;
    const connected = sources.filter(source => source.status === 'connected').length;
    const activeListings = state.listings.filter(item => item.status === 'open').length;
    const detail = checked ? `Son kaynak kontrolü: ${checked.toLocaleString('tr-TR')}` : 'Henüz kaynak kontrol kaydı yok.';
    const status = `Kaynak başına farklı aralıklarla otomatik tarama · ${connected}/${sources.length} kaynak bağlı · ${state.listings.length} kayıt, ${activeListings} açık başvuru · ${degraded} kısmi sorun, ${failed} erişilemiyor, ${pending} beklemede. ${detail}`;
    const label = $('span:last-child', footnote);
    if (label) label.textContent = status;
    footnote.title = status;
  }
  const rows = new Map(sources.map(source => [source.name, source]));
  $$('.source-row').forEach(row => {
    const name = $('strong', row)?.textContent;
    const source = rows.get(name);
    if (!source) return;
    const stateEl = $('.source-state', row);
    if (!stateEl) return;
    const labels = { connected: 'Bağlı', degraded: 'Site açık · akış hatalı', pending: 'İlk kontrol bekleniyor', failed: 'Erişim hatası' };
    stateEl.textContent = labels[source.status] || 'Durum bilinmiyor';
    stateEl.className = `source-state ${source.status || 'pending'}`;
    const detailEl = $('.source-copy small', row);
    const details = [];
    if (source.lastError) details.push(source.lastError);
    else if (source.checkedAt) details.push(`Son kontrol: ${new Date(source.checkedAt).toLocaleString('tr-TR')}`);
    else details.push('İlk başarılı veri aktarımı bekleniyor.');
    if (source.lastSuccessAt) details.push(`Son başarılı: ${new Date(source.lastSuccessAt).toLocaleString('tr-TR')}`);
    if (source.successRate24h !== null && source.successRate24h !== undefined) details.push(`24 saat başarı: ${source.successRate24h}% (${source.successes24h}/${source.checks24h})`);
    if (source.failureCount) details.push(`${source.failureCount} ardışık hata`);
    if (source.backoffUntil) details.push(`Yeniden deneme: ${new Date(source.backoffUntil).toLocaleString('tr-TR')}`);
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
    department: $('#departmentFilter')?.value.trim() || '',
    city: $('#cityFilter').value,
    education: $('#educationFilter').value,
    score: $('#scoreFilter').value,
    type: $('#typeFilter').value,
    source: $('#sourceFilter').value
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
    department: $('#profileDepartment')?.value.trim() || '',
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
  if ($('#profileDepartment')) $('#profileDepartment').value = state.profile.department || '';
  $('#profileScore').value = state.profile.scoreType || '';
  $('#profileScoreValue').value = state.profile.score ?? '';
  $('#profileCity').value = state.profile.city || '';
}

function showProfileTool() {
  setView('tools');
  $('#profileEducation').focus({ preventScroll: true });
  showToast('Aday tercihlerini Araçlar bölümünden düzenleyebilirsin.');
}

function refreshSources() {
  const url = 'https://github.com/PataraKutere/MemurPro/actions/workflows/collect.yml';
  window.open(url, '_blank', 'noopener');
  showToast('Kaynak kontrolünü başlatmak için açılan GitHub Actions sayfasında “Run workflow” düğmesine bas. Otomatik tarama 30 dakikada bir çalışır.');
}

function ensureListingDialog() {
  let dialog = $('#listingDetailDialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'listingDetailDialog';
  dialog.className = 'listing-detail-dialog';
  dialog.setAttribute('aria-labelledby', 'listingDetailTitle');
  dialog.innerHTML = `<div class="detail-dialog-head">
    <div><span class="panel-kicker">İLAN BİLGİLERİ</span><h2 id="listingDetailTitle">İlan detayları</h2></div>
    <button type="button" class="dialog-close" data-close-detail aria-label="Kapat">×</button>
  </div>
  <div id="listingDetailContent" class="detail-dialog-content"></div>`;
  document.body.appendChild(dialog);
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  return dialog;
}

function openListingDetails(id) {
  const listing = [...state.listings, ...state.saved].find(item => String(item.id) === String(id));
  if (!listing) return;
  const dialog = ensureListingDialog();
  const start = formatListingDate(listing.startDate);
  const end = formatListingDate(listing.endDate);
  const published = formatListingDate(listing.publishedAt);
  const dateRange = start && end ? `${start} – ${end}` : start ? `${start} – Bitiş tarihi belirtilmemiş` : end ? `Başlangıç belirtilmemiş – ${end}` : 'Başvuru tarih aralığı kaynakta belirtilmemiş';
  const score = listing.scoreType
    ? `${listing.scoreType}${listing.minimumScore !== null && listing.minimumScore !== undefined && listing.minimumScore !== '' ? ` · Asgari ${listing.minimumScore} puan` : ' · Asgari puan belirtilmemiş'}`
    : (/KPSS şartı yok|KPSS aranmıyor/i.test(listing.summary || '') ? 'KPSS şartı aranmadığı belirtilmiş' : 'KPSS şartı / puan bilgisi belirtilmemiş');
  const url = safeListingUrl(listing.url || listing.detailUrl);
  const status = listing.status === 'open' ? 'Başvuru açık' : listing.status === 'closed' ? 'Başvuru kapandı' : 'Başvuru durumu resmî kaynaktan kontrol edilmeli';
  $('#listingDetailTitle').textContent = listing.title || 'İlan detayları';
  $('#listingDetailContent').innerHTML = `
    <div class="detail-institution">${escapeHTML(listing.institution || 'Kurum bilgisi belirtilmemiş')} · ${escapeHTML(listing.sourceName || 'Resmî kaynak')}</div>
    <div class="detail-facts">
      ${listingFact('Başvuru tarih aralığı', dateRange)}
      ${listingFact('Yayın tarihi', published || 'Kaynakta belirtilmemiş')}
      ${listingFact('Görev yeri', listing.city || 'Kaynakta belirtilmemiş')}
      ${listingFact('Aranan bölümler / öğrenim', listing.education || 'Kaynakta belirtilmemiş')}
      ${listingFact('KPSS şartı ve puan', score)}
      ${listingFact('İlan türü', listing.category || 'Kaynakta belirtilmemiş')}
      ${listingFact('Başvuru durumu', status)}
    </div>
    <section class="detail-description"><h3>İlan açıklaması</h3><p>${escapeHTML(listing.summary || 'Kaynak tarafından ayrıca bir açıklama sağlanmamış. Ayrıntılar için resmî duyuruyu incele.')}</p></section>
    ${eligibilityMarkup(listing)}
    <div class="detail-dialog-actions">${url ? `<a class="details-button" href="${escapeHTML(url)}" target="_blank" rel="noopener">Resmî ilanı aç ↗</a>` : '<span class="detail-no-link">Resmî bağlantı kaynak verisinde yok.</span>'}</div>
    <p class="detail-warning">Bu kart kaynaklardan alınabilen bilgilerin özetidir. Eksik şartlar, özel koşullar, belgeler ve başvuru yöntemi için resmî ilan metni ve ekleri esas alınmalıdır.</p>`;
  dialog.showModal();
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
  $('#searchInput').addEventListener('input', bindFilters);
  $('#departmentFilter')?.addEventListener('input', bindFilters);
  $('#searchInput').addEventListener('keydown', event => { if (event.key === 'Enter') bindFilters(); });
  $('#sortFilter').addEventListener('change', renderListings);
  $('#sourceFilter')?.addEventListener('change', bindFilters);
  $('#clearFilters').addEventListener('click', () => {
    ['searchInput','departmentFilter','cityFilter','educationFilter','scoreFilter','typeFilter','sourceFilter'].forEach(id => { $(`#${id}`).value = ''; });
    bindFilters();
  });
  document.addEventListener('change', event => {
    const statusControl = event.target.closest('[data-track-status]');
    const deadlineControl = event.target.closest('[data-track-deadline]');
    const reminderControl = event.target.closest('[data-track-reminder]');
    const resultControl = event.target.closest('[data-track-result]');
    if (statusControl) {
      saveTracking(statusControl.dataset.trackStatus, { status: statusControl.value });
      showToast('Başvuru durumu kaydedildi.');
    }
    if (deadlineControl) {
      saveTracking(deadlineControl.dataset.trackDeadline, { deadline: deadlineControl.value });
      renderSaved();
      showToast('Son başvuru tarihi kaydedildi.');
    }
    if (reminderControl) {
      saveTracking(reminderControl.dataset.trackReminder, { reminderDays: Number(reminderControl.value) });
      renderSaved();
      showToast(reminderControl.value === '0' ? 'Başvuru hatırlatması kapatıldı.' : 'Hatırlatma tercihi kaydedildi.');
    }
    if (resultControl) {
      saveTracking(resultControl.dataset.trackResult, { resultDate: resultControl.value });
      renderSaved();
      showToast('Beklenen sonuç tarihi kaydedildi.');
    }
    const stepControl = event.target.closest('[data-track-step]');
    if (stepControl) {
      const id = stepControl.dataset.trackStep;
      const key = stepControl.dataset.stepKey;
      const steps = { ...(getTracking(id).steps || {}), [key]: stepControl.checked };
      saveTracking(id, { steps });
      renderSaved();
      showToast('Başvuru adımı kaydedildi.');
    }
    const docControl = event.target.closest('[data-doc-check]');
    if (docControl) {
      const id = docControl.dataset.docCheck;
      const key = docControl.dataset.docKey;
      const current = getTracking(id);
      const documents = Array.isArray(current.documents) && current.documents.length
        ? current.documents.map(doc => doc.id === key ? { ...doc, done: docControl.checked } : doc)
        : DEFAULT_DOCUMENTS.map(doc => doc.id === key ? { ...doc, done: docControl.checked } : { ...doc });
      saveTracking(id, { documents });
      renderSaved();
      showToast('Evrak durumu kaydedildi.');
    }
  });
  document.addEventListener('click', event => {
    const closeDetail = event.target.closest('[data-close-detail]');
    if (closeDetail) $('#listingDetailDialog')?.close();
    const detailButton = event.target.closest('[data-detail-id]');
    if (detailButton) openListingDetails(detailButton.dataset.detailId);
    const addDocButton = event.target.closest('[data-add-doc]');
    if (addDocButton) addCustomDocument(addDocButton.dataset.addDoc);
    const removeDocButton = event.target.closest('[data-remove-doc]');
    if (removeDocButton) removeCustomDocument(removeDocButton.dataset.removeDoc, removeDocButton.dataset.docKey);
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
  updateSourceFilter();
  renderListings();
  renderSaved();
  loadLiveData();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);

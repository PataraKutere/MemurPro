const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, 'access-control-allow-origin': '*', 'access-control-allow-methods': ALLOWED_METHODS, 'access-control-allow-headers': 'content-type,x-admin-token', ...extraHeaders }
  });
}

function safeText(value, max = 4000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function decodeNumericEntity(_match, hex, decimal) {
  const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
    return '\uFFFD';
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value) {
  let text = String(value ?? '');
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ccedil: 'ç', uuml: 'ü', ouml: 'ö' };
  for (let pass = 0; pass < 4; pass++) {
    const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
      if (code[0] === '#') return code[1]?.toLowerCase() === 'x'
        ? decodeNumericEntity(entity, code.slice(2), '')
        : decodeNumericEntity(entity, '', code.slice(1));
      return Object.prototype.hasOwnProperty.call(named, code.toLowerCase()) ? named[code.toLowerCase()] : entity;
    });
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

function xmlText(value) {
  const plain = String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ');
  return safeText(decodeHtmlEntities(plain));
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? match[1] : '';
}

function parseXmlFeed(xml, source) {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map(match => match[2]);
  return blocks.map((block, index) => {
    const atomLink = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
    const linkTag = tag(block, 'link');
    const link = atomLink?.[1] || xmlText(linkTag);
    const title = xmlText(tag(block, 'title'));
    const description = xmlText(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'));
    const published = xmlText(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated'));
    if (!title || !link) return null;

    if (source.id === 'resmi-gazete') {
      const searchable = (title + ' ' + description).toLocaleLowerCase('tr-TR');
      if (!/(personel alım|personel alımı|memur alım|sözleşmeli personel|işçi alım|araştırma görevlisi|öğretim görevlisi|uzman yardımcısı|müfettiş yardımcısı|kariyer uzman|başvuru ilanı)/i.test(searchable)) return null;
    }

    const url = new URL(link, source.homepage_url).toString();
    return {
      externalId: url,
      title,
      institution: source.name,
      summary: description,
      category: source.id === 'resmi-gazete' ? 'Resmî Gazete' : classifyPublicCategory(title),
      detailUrl: url,
      publishedAt: normalizeDate(published),
      sourceName: source.name,
      status: 'check_required'
    };
  }).filter(Boolean).slice(0, 200);
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeDateOnly(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const local = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (local) return local[3] + '-' + local[2].padStart(2, '0') + '-' + local[1].padStart(2, '0');
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function normalizeJsonFeed(payload, source) {
  const items = Array.isArray(payload) ? payload : (Array.isArray(payload.items) ? payload.items : null);
  if (!items) throw new Error('JSON kaynağı beklenen liste biçiminde değil.');
  return items.slice(0, 200).map((item, index) => {
    const detailUrl = safeText(item.detailUrl || item.detail_url || item.url || item.link, 2000);
    const title = safeText(item.title || item.name, 500);
    if (!title || !detailUrl) return null;
    return {
      externalId: safeText(item.id || item.externalId || item.external_id || detailUrl, 2000) || `${source.id}-${index}`,
      title,
      institution: safeText(item.institution || item.institutionName || item.organization || source.name, 500),
      summary: safeText(item.summary || item.description, 4000),
      category: safeText(item.category || item.type || 'Kamu ilanı', 100),
      city: safeText(item.city || item.location, 100),
      education: safeText(item.education || item.educationLevel, 100),
      scoreType: safeText(item.scoreType || item.score_type, 50),
      minimumScore: Number.isFinite(Number(item.minimumScore ?? item.minimum_score)) ? Number(item.minimumScore ?? item.minimum_score) : null,
      publishedAt: normalizeDate(item.publishedAt || item.published_at || item.date),
      startDate: normalizeDateOnly(item.startDate || item.start_date),
      endDate: normalizeDateOnly(item.endDate || item.end_date),
      detailUrl: new URL(detailUrl, source.homepage_url).toString(),
      sourceName: source.name,
      status: item.status === 'open' && (item.endDate || item.end_date) && normalizeDateOnly(item.endDate || item.end_date) >= new Date().toISOString().slice(0, 10) ? 'open' : 'check_required'
    };
  }).filter(Boolean);
}

async function hashText(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}


function normalizeIngestItem(item, source) {
  const title = safeText(item?.title, 500);
  const institution = safeText(item?.institution, 500);
  const detailUrl = safeText(item?.detailUrl || item?.url, 2000);
  if (!title || !detailUrl) return null;
  let parsed;
  try { parsed = new URL(detailUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  const endDate = normalizeDateOnly(item.endDate);
  const startDate = normalizeDateOnly(item.startDate);
  const today = new Date().toISOString().slice(0, 10);
  const explicitOpen = item.status === 'open' && Boolean(endDate) && endDate >= today && (!startDate || startDate <= today);
  const status = endDate && endDate < today ? 'closed' : explicitOpen ? 'open' : 'check_required';
  const positionCount = Number.isInteger(Number(item.positionCount)) && Number(item.positionCount) > 0 ? Number(item.positionCount) : null;
  return {
    externalId: safeText(item.externalId || item.id || detailUrl, 2000),
    title,
    institution: institution || source.name,
    summary: safeText(item.summary, 4000),
    category: safeText(item.category || 'Kamu ilanı', 100),
    city: safeText(item.city, 100),
    education: safeText(item.education, 200),
    scoreType: safeText(item.scoreType, 50),
    minimumScore: Number.isFinite(Number(item.minimumScore)) && item.minimumScore !== null && item.minimumScore !== '' ? Number(item.minimumScore) : null,
    publishedAt: normalizeDate(item.publishedAt),
    startDate,
    endDate,
    detailUrl: parsed.toString(),
    sourceName: source.name,
    status,
    positionCount
  };
}

async function ingestBatch(request, env) {
  if (!env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) {
    return json({ error: 'Yetkisiz işlem.' }, 401);
  }
  const raw = await request.text();
  if (raw.length > 1_000_000) return json({ error: 'İstek gövdesi 1 MB sınırını aşıyor.' }, 413);
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'Geçersiz JSON.' }, 400); }
  const sourceId = safeText(payload.sourceId, 80);
  if (!sourceId) return json({ error: 'sourceId zorunludur.' }, 400);
  const sourceResult = await env.DB.prepare('SELECT id, name FROM sources WHERE id=? AND enabled=1').bind(sourceId).first();
  if (!sourceResult) return json({ error: 'Kaynak bulunamadı veya devre dışı.' }, 404);
  const now = new Date().toISOString();

  if (payload.error) {
    const message = safeText(payload.error, 500);
    const current = await env.DB.prepare('SELECT failure_count FROM sources WHERE id=?').bind(sourceId).first();
    const failures = Number(current?.failure_count || 0) + 1;
    const backoffMinutes = failures >= 3 ? Math.min(30 * (2 ** Math.min(failures - 3, 3)), 240) : 0;
    const backoffUntil = backoffMinutes ? new Date(Date.now() + backoffMinutes * 60000).toISOString() : null;
    await env.DB.prepare("UPDATE sources SET status='failed', failure_count=?, backoff_until=?, last_checked_at=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(failures, backoffUntil, now, message, sourceId).run();
    return json({ ok: true, sourceId, status: 'failed', failureCount: failures, backoffUntil, imported: 0 });
  }

  if (!Array.isArray(payload.items) || payload.items.length > 250) {
    return json({ error: 'items alanı en fazla 250 kayıt içeren bir dizi olmalıdır.' }, 400);
  }

  let imported = 0;
  let rejected = 0;
  for (const rawItem of payload.items) {
    const item = normalizeIngestItem(rawItem, sourceResult);
    if (!item) { rejected++; continue; }
    const dedupeInput = [
      item.institution.toLocaleLowerCase('tr-TR').replace(/[^a-z0-9çğıöşü]+/g, ' ').trim(),
      item.title.toLocaleLowerCase('tr-TR').replace(/[^a-z0-9çğıöşü]+/g, ' ').trim(),
      item.endDate || '',
      item.positionCount ?? ''
    ].join('|');
    const dedupeHash = item.endDate ? await hashText(dedupeInput) : null;
    const id = sourceId + '-' + (await hashText(item.externalId)).slice(0, 24);
    const sourceRef = { sourceId, sourceName: sourceResult.name, url: item.detailUrl };
    const existingSourceItem = await env.DB.prepare('SELECT id FROM announcements WHERE source_id=? AND external_id=?').bind(sourceId, item.externalId).first();
    if (existingSourceItem) {
      await env.DB.prepare(`UPDATE announcements SET
        title=?, institution=?, summary=?, category=?, city=?, education=?, score_type=?,
        minimum_score=?, published_at=?, start_date=?, end_date=?, detail_url=?, source_name=?,
        status=?, content_hash=?, last_verified_at=?, dedupe_hash=COALESCE(?, dedupe_hash),
        publication_state=?, position_count=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?`)
        .bind(item.title, item.institution, item.summary || null, item.category, item.city || null,
          item.education || null, item.scoreType || null, item.minimumScore, item.publishedAt || null,
          item.startDate, item.endDate, item.detailUrl, sourceResult.name, item.status,
          await hashText(JSON.stringify(item)), now, dedupeHash,
          item.status === 'open' ? 'published' : item.status === 'closed' ? 'expired' : 'draft',
          item.positionCount, existingSourceItem.id).run();
      imported++;
      continue;
    }

    const existing = dedupeHash
      ? await env.DB.prepare('SELECT id, source_refs, source_name FROM announcements WHERE dedupe_hash=? LIMIT 1').bind(dedupeHash).first()
      : null;

    if (existing) {
      let refs = [];
      try { refs = JSON.parse(existing.source_refs || '[]'); } catch {}
      if (!refs.some(ref => ref.sourceId === sourceId)) refs.push(sourceRef);
      const names = [...new Set([...(existing.source_name || '').split(' · ').filter(Boolean), sourceResult.name])].join(' · ');
      await env.DB.prepare(`UPDATE announcements SET source_refs=?, source_name=?, updated_at=CURRENT_TIMESTAMP,
        last_verified_at=?, status=CASE WHEN end_date IS NOT NULL AND end_date < ? THEN 'closed' ELSE status END
        WHERE id=?`)
        .bind(JSON.stringify(refs), names, now, now.slice(0, 10), existing.id).run();
      imported++;
      continue;
    }

    const refs = JSON.stringify([sourceRef]);
    await env.DB.prepare(`
      INSERT INTO announcements (
        id, source_id, external_id, title, institution, summary, category, city, education,
        score_type, minimum_score, published_at, start_date, end_date, detail_url, source_name,
        status, content_hash, last_verified_at, dedupe_hash, source_refs, publication_state,
        position_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(source_id, external_id) DO UPDATE SET
        title=excluded.title, institution=excluded.institution, summary=excluded.summary,
        category=excluded.category, city=excluded.city, education=excluded.education,
        score_type=excluded.score_type, minimum_score=excluded.minimum_score,
        published_at=excluded.published_at, start_date=excluded.start_date, end_date=excluded.end_date,
        detail_url=excluded.detail_url, source_name=excluded.source_name, status=excluded.status,
        content_hash=excluded.content_hash, last_verified_at=excluded.last_verified_at,
        dedupe_hash=COALESCE(excluded.dedupe_hash, announcements.dedupe_hash),
        source_refs=excluded.source_refs, publication_state=excluded.publication_state,
        position_count=excluded.position_count, updated_at=CURRENT_TIMESTAMP
    `).bind(
      id, sourceId, item.externalId, item.title, item.institution, item.summary || null,
      item.category, item.city || null, item.education || null, item.scoreType || null,
      item.minimumScore, item.publishedAt || null, item.startDate, item.endDate,
      item.detailUrl, sourceResult.name, item.status, await hashText(JSON.stringify(item)),
      now, dedupeHash, refs, item.status === 'open' ? 'published' : item.status === 'closed' ? 'expired' : 'draft',
      item.positionCount
    ).run();
    imported++;
  }

  await env.DB.prepare("UPDATE sources SET status='connected', failure_count=0, backoff_until=NULL, last_checked_at=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(now, sourceId).run();
  return json({ ok: true, sourceId, status: 'connected', imported, rejected, checkedAt: now });
}

async function getSources(env) {
  const result = await env.DB.prepare(`SELECT id, name, homepage_url AS homepageUrl, feed_type AS feedType, adapter, status, last_checked_at AS checkedAt, last_error AS lastError, failure_count AS failureCount, backoff_until AS backoffUntil, enabled FROM sources ORDER BY name`).all();
  return result.results || [];
}

async function getListings(request, env) {
  const url = new URL(request.url);
  const q = safeText(url.searchParams.get('q'), 120);
  const city = safeText(url.searchParams.get('city'), 100);
  const education = safeText(url.searchParams.get('education'), 100);
  const score = safeText(url.searchParams.get('score'), 50);
  const category = safeText(url.searchParams.get('type'), 100);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 200);

  let sql = `SELECT id, title, institution, summary, category, city, education, score_type AS scoreType, minimum_score AS minimumScore, published_at AS publishedAt, start_date AS startDate, end_date AS endDate, detail_url AS url, source_name AS sourceName, status, source_refs AS sourceRefs, publication_state AS publicationState, position_count AS positionCount FROM announcements WHERE status IN ('open','check_required') AND publication_state NOT IN ('expired','invalid')`;
  const params = [];
  if (q) { sql += ` AND (title LIKE ? OR institution LIKE ? OR summary LIKE ?)`; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (city) { sql += ` AND (city = ? OR city = 'Türkiye Geneli')`; params.push(city); }
  if (education) { sql += ` AND education = ?`; params.push(education); }
  if (score) { sql += ` AND score_type = ?`; params.push(score); }
  if (category) { sql += ` AND category = ?`; params.push(category); }
  sql += ` ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`;
  params.push(limit);
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return rows.results || [];
}

function parseOsymKpssPage(html, source) {
  const months = { 'ocak':'01','şubat':'02','mart':'03','nisan':'04','mayıs':'05','haziran':'06','temmuz':'07','ağustos':'08','eylül':'09','ekim':'10','kasım':'11','aralık':'12' };
  const matches = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const seen = new Set();
  const items = [];

  for (const match of matches) {
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;

    const title = xmlText(inner);
    if (!/kpss/i.test(title) || title.trim().length < 12) continue;

    let detailUrl;
    try {
      detailUrl = new URL(hrefMatch[1], source.homepage_url).toString();
      const parsed = new URL(detailUrl);
      if (parsed.hostname !== 'www.osym.gov.tr' && parsed.hostname !== 'osym.gov.tr') continue;
      if (/SinavGrubu\/Index\/3/i.test(parsed.pathname)) continue;
    } catch {
      continue;
    }
    if (seen.has(detailUrl)) continue;
    seen.add(detailUrl);

    let publishedAt = null;
    const dateMatch = title.match(/(\d{1,2})\s+(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s+(\d{4})/i);
    if (dateMatch) {
      const day = dateMatch[1].padStart(2, '0');
      const month = months[dateMatch[2].toLocaleLowerCase('tr-TR')];
      if (month) publishedAt = new Date(dateMatch[3] + '-' + month + '-' + day + 'T00:00:00+03:00').toISOString();
    }

    items.push({
      externalId: detailUrl,
      title,
      institution: 'ÖSYM',
      summary: 'ÖSYM KPSS duyurusu. Ayrıntılar ve başvuru koşulları için resmî duyuru sayfasını inceleyin.',
      category: 'KPSS',
      detailUrl,
      publishedAt,
      sourceName: source.name,
      status: 'check_required'
    });
  }
  return items.slice(0, 100);
}

function parseTurkishDayMonth(value) {
  const months = { 'ocak':'01','şubat':'02','subat':'02','mart':'03','nisan':'04','mayıs':'05','mayis':'05','haziran':'06','temmuz':'07','ağustos':'08','agustos':'08','eylül':'09','eylul':'09','ekim':'10','kasım':'11','kasim':'11','aralık':'12','aralik':'12' };
  const match = String(value || '').trim().toLocaleLowerCase('tr-TR').match(/(\d{1,2})\s+([a-zçşğıöü]+)/i);
  if (!match) return null;
  const month = months[match[2]];
  if (!month) return null;
  const now = new Date();
  let year = now.getFullYear();
  const monthNumber = Number(month);
  if (monthNumber < now.getMonth() + 1 && now.getMonth() === 11 && monthNumber === 1) year++;
  return year + '-' + month + '-' + match[1].padStart(2, '0');
}

function classifyPublicCategory(title) {
  const value = String(title || '').toLocaleLowerCase('tr-TR');
  if (/zabıta|itfaiye|belediye/.test(value)) return 'Belediye';
  if (/sözleşmeli|4\/b/.test(value)) return 'Sözleşmeli';
  if (/işçi|sürekli işçi|geçici işçi/.test(value)) return 'İşçi';
  if (/memur|uzman yardımcısı|müfettiş yardımcısı|denetçi|icra müdürü/.test(value)) return 'Memur';
  return 'Kamu ilanı';
}

function parseIlanGovItems(payload, source) {
  const ads = payload && payload.result && Array.isArray(payload.result.ads) ? payload.result.ads : null;
  if (!ads) throw new Error('İlan.gov.tr API beklenen result.ads listesini döndürmedi.');
  return ads.map(item => {
    const id = safeText(item.id || item.idInt || item.adNo, 100);
    const title = safeText(item.title, 600);
    if (!title || !id) return null;

    const relativeUrl = safeText(item.urlStr, 1800);
    let detailUrl = 'https://www.ilan.gov.tr/';
    if (relativeUrl) {
      try {
        const parsed = new URL(relativeUrl, 'https://www.ilan.gov.tr');
        if (parsed.hostname === 'www.ilan.gov.tr' || parsed.hostname === 'ilan.gov.tr') detailUrl = parsed.toString();
      } catch {}
    } else {
      const slug = safeText(item.slugifyTitle || item.slug, 500);
      detailUrl = 'https://www.ilan.gov.tr/ilan/' + encodeURIComponent(id) + (slug ? '/' + encodeURIComponent(slug) : '');
    }

    const filters = Array.isArray(item.adTypeFilters) ? item.adTypeFilters : [];
    const filterText = filters.map(entry => {
      const key = safeText(entry.key, 100);
      const value = safeText(entry.value, 300);
      return key && value ? key + ': ' + value : '';
    }).filter(Boolean).join(' · ');

    return {
      externalId: 'ilan-gov-' + id,
      title,
      institution: safeText(item.advertiserName || 'Kamu / akademik kurum', 500),
      summary: filterText ? 'Resmî ilan bilgileri: ' + filterText : 'İlan.gov.tr kamu-akademik personel ilanı. Şartlar ve başvuru yöntemi için resmî ilanı inceleyin.',
      category: classifyPublicCategory(title) === 'Kamu ilanı' ? 'Akademik Personel' : classifyPublicCategory(title),
      city: safeText(item.addressCityName, 100),
      publishedAt: normalizeDate(item.publishStartDate),
      detailUrl,
      sourceName: source.name,
      status: 'check_required'
    };
  }).filter(Boolean);
}

function parseSbbItems(html, source) {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const seen = new Set();
  const items = [];
  for (const match of anchors) {
    const attrs = match[1] || '';
    const inner = match[2] || '';
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*ilanDetay\.aspx\?kod=[^"']+)["']/i);
    if (!hrefMatch) continue;
    const title = xmlText(inner);
    if (title.length < 5) continue;
    let code = '';
    try {
      const parsed = new URL(hrefMatch[1], source.homepage_url);
      if (parsed.hostname !== 'kamuilan.sbb.gov.tr') continue;
      code = parsed.searchParams.get('kod') || '';
    } catch { continue; }
    if (!code || seen.has(code)) continue;
    seen.add(code);

    const dateMatch = title.match(/(\d{1,2}\s+[A-Za-zÇŞĞÜÖİçşğıöü]+\s*-\s*\d{1,2}\s+[A-Za-zÇŞĞÜÖİçşğıöü]+)/i);
    let startDate = null;
    let endDate = null;
    if (dateMatch) {
      const parts = dateMatch[1].split('-');
      startDate = parseTurkishDayMonth(parts[0]);
      endDate = parseTurkishDayMonth(parts[1]);
      if (startDate && endDate && endDate < startDate) {
        const nextYear = Number(endDate.slice(0, 4)) + 1;
        endDate = nextYear + endDate.slice(4);
      }
    }

    const cleanTitle = dateMatch ? title.replace(dateMatch[0], '').replace(/[()]/g, '').trim() : title;
    const parts = cleanTitle.split(/\s+-\s+/).filter(Boolean);
    const institution = safeText(parts[0] || 'Kamu kurumu', 500);
    items.push({
      externalId: 'sbb-' + code,
      title: cleanTitle || title,
      institution,
      summary: 'SBB Kamu İlan Portalı kaydı. Detay/PDF bağlantısı oturum korumalı olabilir; ilanı resmî portalın ana sayfasından başlıkla bulun.',
      category: classifyPublicCategory(cleanTitle),
      startDate,
      endDate,
      detailUrl: 'https://kamuilan.sbb.gov.tr/',
      sourceName: source.name,
      status: 'check_required'
    });
  }
  return items.slice(0, 150);
}


function istanbulDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: values.year, month: values.month, day: values.day };
}

function parseResmiGazeteItems(html, source, dateKey, pageUrl) {
  const decoded = decodeHtmlEntities(String(html || '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' '));
  const plainPage = xmlText(decoded);
  const relevant = /(personel\s+al[ıi]m|memur\s+al[ıi]m|sözleşmeli\s+personel|işçi\s+al[ıi]m|öğretim\s+(?:üyesi|elemanı|görevlisi)\s+al[ıi]m|uzman\s+yardımcısı|müfettiş\s+yardımcısı|zabıta\s+memuru|itfaiye\s+eri)/i;
  const dateLabel = dateKey.slice(6, 8) + '.' + dateKey.slice(4, 6) + '.' + dateKey.slice(0, 4);
  const anchors = [...decoded.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const items = [];
  const seen = new Set();

  for (const match of anchors) {
    const attrs = match[1] || '';
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    let detailUrl;
    try {
      detailUrl = new URL(hrefMatch[1], pageUrl).toString();
      const parsed = new URL(detailUrl);
      if (parsed.hostname !== 'www.resmigazete.gov.tr' && parsed.hostname !== 'resmigazete.gov.tr') continue;
    } catch { continue; }

    const anchorText = xmlText(match[2]);
    const offset = match.index || 0;
    const context = xmlText(decoded.slice(Math.max(0, offset - 1000), Math.min(decoded.length, offset + match[0].length + 1800)));
    const searchable = anchorText + ' ' + context;
    if (!relevant.test(searchable)) continue;
    if (seen.has(detailUrl)) continue;
    seen.add(detailUrl);

    const titleMatch = context.match(/(?:PERSONEL\s+AL[ıI]M[ıI]|MEMUR\s+AL[ıI]M[ıI]|SÖZLEŞMELİ\s+PERSONEL[^.]{0,100}|İŞÇİ\s+AL[ıI]M[ıI]|ÖĞRETİM\s+(?:ÜYESİ|ELEMANI|GÖREVLİSİ)\s+AL[ıI]M[ıI]|UZMAN\s+YARDIMCISI[^.]{0,100}|MÜFETTİŞ\s+YARDIMCISI[^.]{0,100}|ZABITA\s+MEMURU[^.]{0,100}|İTFAİYE\s+ERİ[^.]{0,100})/i);
    const title = safeText(anchorText.length >= 12 && !/pdf|görüntüle|indir/i.test(anchorText) ? anchorText : (titleMatch?.[0] || context), 500);
    const institutionMatch = context.match(/([A-ZÇĞİÖŞÜa-zçğıöşü0-9 .,'’()-]{3,140}?(?:Bakanlığından|Genel Müdürlüğünden|Başkanlığından|Rektörlüğünden|Müdürlüğünden))/i);
    items.push({
      externalId: detailUrl,
      title: title || 'Resmî Gazete personel alım ilanı',
      institution: safeText(institutionMatch?.[1] || source.name, 500),
      summary: 'Resmî Gazete Çeşitli İlânlar bölümünde personel alımıyla ilişkili kayıt. Başvuru şartları ve tarihler için resmî belgeyi inceleyin.',
      category: classifyPublicCategory(title),
      publishedAt: new Date(dateKey.slice(0, 4) + '-' + dateKey.slice(4, 6) + '-' + dateKey.slice(6, 8) + 'T00:00:00+03:00').toISOString(),
      detailUrl,
      sourceName: source.name,
      status: 'check_required'
    });
  }

  if (!items.length && relevant.test(plainPage)) {
    items.push({
      externalId: pageUrl,
      title: 'Resmî Gazete Çeşitli İlânlar — ' + dateLabel,
      institution: source.name,
      summary: 'Bu tarihin resmî Çeşitli İlânlar sayfasında personel alımıyla ilişkili ifadeler bulundu. İlan başlıklarını ve başvuru belgelerini resmî sayfadan kontrol edin.',
      category: 'Kamu ilanı',
      publishedAt: new Date(dateKey.slice(0, 4) + '-' + dateKey.slice(4, 6) + '-' + dateKey.slice(6, 8) + 'T00:00:00+03:00').toISOString(),
      detailUrl: pageUrl,
      sourceName: source.name,
      status: 'check_required'
    });
  }
  return items.slice(0, 100);
}

async function fetchResmiGazete(source) {
  const today = istanbulDateParts();
  const baseDate = new Date(Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day)));
  let lastError = null;

  // Tarihli ilan dosyasını tahmin etmek yerine önce Resmî Gazete fihristinden resmî bağlantıyı bul.
  for (let offset = 0; offset < 3; offset++) {
    const date = new Date(baseDate.getTime() - offset * 86400000);
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const dateKey = year + month + day;
    const isoDate = year + '-' + month + '-' + day;
    const directUrl = 'https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/' + year + '/' + month + '/' + dateKey + '-4.htm';
    const fihristUrl = 'https://www.resmigazete.gov.tr/fihrist?tarih=' + isoDate;
    const candidates = [fihristUrl, directUrl];

    for (const pageUrl of candidates) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(pageUrl, {
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.7',
            'referer': 'https://www.resmigazete.gov.tr/',
            'cache-control': 'no-cache'
          },
          redirect: 'follow'
        });
        if (!response.ok) {
          lastError = new Error('Resmî Gazete ' + (pageUrl.includes('/fihrist?') ? 'fihrist' : 'Çeşitli İlânlar') + ' sayfası HTTP ' + response.status + ' döndürdü.');
          continue;
        }
        let html = await response.text();
        if (html.length > 4_000_000) throw new Error('Resmî Gazete yanıtı güvenli boyut sınırını aşıyor.');

        if (pageUrl.includes('/fihrist?')) {
          const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
          const section = anchors.find(match => /çeşitli\s+il[âa]nlar/i.test(xmlText(match[2])));
          const href = section?.[1]?.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
          if (href) {
            const sectionUrl = new URL(href, pageUrl);
            if (sectionUrl.hostname !== 'www.resmigazete.gov.tr' && sectionUrl.hostname !== 'resmigazete.gov.tr') {
              throw new Error('Resmî Gazete fihrist bağlantısı resmî alan adı dışında.');
            }
            const sectionController = new AbortController();
            const sectionTimeout = setTimeout(() => sectionController.abort(), 8000);
            try {
              const sectionResponse = await fetch(sectionUrl.toString(), {
                signal: sectionController.signal,
                headers: {
                  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
                  'accept': 'text/html,application/xhtml+xml',
                  'accept-language': 'tr-TR,tr;q=0.9',
                  'referer': fihristUrl
                },
                redirect: 'follow'
              });
              if (!sectionResponse.ok) {
                lastError = new Error('Resmî Gazete Çeşitli İlânlar bağlantısı HTTP ' + sectionResponse.status + ' döndürdü.');
                continue;
              }
              html = await sectionResponse.text();
            } finally {
              clearTimeout(sectionTimeout);
            }
          }
        }

        if (!/ÇEŞİTLİ\s+İL[ÂA]NLAR/i.test(xmlText(html))) {
          lastError = new Error('Resmî Gazete sayfası açıldı ancak Çeşitli İlânlar başlığı bulunamadı.');
          continue;
        }
        // Bölüm doğrulandıysa boş sonuç da başarılı kontroldür.
        return parseResmiGazeteItems(html, source, dateKey, pageUrl);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  throw lastError || new Error('Son 3 gün içinde Resmî Gazete Çeşitli İlânlar sayfası doğrulanamadı.');
}
async function fetchKariyerKapisi(source) {
  const endpoints = ['https://api.kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage', 'https://kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage'];
  const requestBody = { krM_ID: 0, searchText: '', il: '0', ilanTuru: '0' };
  let response;
  let lastError;

  for (const endpoint of endpoints) {
   for (let attempt = 0; attempt < 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'origin': 'https://kariyerkapisi.gov.tr',
          'referer': 'https://kariyerkapisi.gov.tr/isealim',
          'user-agent': 'Mozilla/5.0 (compatible; MemurPro/0.1; public announcement monitor)',
          'accept': 'application/json, text/plain, */*'
        },
        body: JSON.stringify(requestBody)
      });
      if (response.ok) break;
      lastError = new Error('Kariyer Kapısı API HTTP ' + response.status);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
      const status = response?.status;
      const retryable = !status || [429, 500, 502, 503, 504].includes(status);
      if (!retryable || attempt === 0) { lastError = error; break; }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
   }
   if (response?.ok) break;
  }

  if (!response || !response.ok) throw new Error('Kariyer Kapısı herkese açık ilan akışı yanıt vermedi: ' + safeText(lastError?.message || 'iki resmî API adresi de başarısız', 300));
  const payload = await response.json();
  if (!Array.isArray(payload?.searchIlan)) throw new Error('Kariyer Kapısı API beklenen searchIlan listesini döndürmedi.');

  const today = new Date().toISOString().slice(0, 10);
  return payload.searchIlan.slice(0, 500).map(item => {
    const guid = safeText(item.guid, 100);
    const title = safeText(item.ilanBaslik || item.ilanAdi || item.baslik, 500);
    if (!guid || !title) return null;

    const startDate = normalizeDateOnly(item.basTarih || item.baslangicTarihi);
    const endDate = normalizeDateOnly(item.bitTarih || item.bitisTarihi);
    const hasStarted = !startDate || startDate <= today;
    const notEnded = !endDate || endDate >= today;
    const confirmedOpen = Boolean(endDate && hasStarted && notEnded);

    return {
      externalId: guid,
      title,
      institution: safeText(item.kurumAdi || item.kurum || source.name, 500),
      summary: 'Kariyer Kapısı kamu işe alım ilanı. Başvuru şartları, pozisyonlar ve güncel takvim için resmî ilan sayfasını açın.',
      category: item.ilanTipi === 2 ? 'Duyuru' : 'Kamu ilanı',
      city: safeText(item.ilAdi || item.il || item.sehir, 100),
      education: safeText(item.ogrenimDurumu || item.ogrenim, 100),
      scoreType: safeText(item.puanTuru || item.kpssPuanTuru, 50),
      publishedAt: normalizeDate(item.yayinTarihi || item.ilanTarihi || item.kayitTarihi),
      startDate,
      endDate,
      detailUrl: 'https://kariyerkapisi.gov.tr/IlanDetay?i=' + encodeURIComponent(guid),
      sourceName: source.name,
      status: confirmedOpen ? 'open' : 'check_required'
    };
  }).filter(Boolean);
}

async function fetchIlanGov(source) {
  const endpoint = 'https://www.ilan.gov.tr/api/api/services/app/Ad/AdsByFilter';
  const results = [];
  const seen = new Set();

  for (const skipCount of [0, 20, 40]) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json-patch+json',
          'accept': 'application/json, text/plain, */*',
          'origin': 'https://www.ilan.gov.tr',
          'referer': 'https://www.ilan.gov.tr/ilan/kategori/8/kamu-akademik-personel?ats=5',
          'x-request-origin': 'IGT-UI',
          'x-requested-with': 'XMLHttpRequest',
          'user-agent': 'Mozilla/5.0 (compatible; MemurPro/0.1; public announcement monitor)'
        },
        body: JSON.stringify({
          keys: { txv: [8], ats: [5], order: ['desc'], field: ['publish_time'] },
          sorting: 'publish_time desc',
          skipCount,
          maxResultCount: 20
        }),
        redirect: 'follow'
      });
      if (!response.ok) throw new Error('İlan.gov.tr API HTTP ' + response.status);
      const payload = await response.json();
      const pageItems = parseIlanGovItems(payload, source);
      for (const item of pageItems) {
        if (!seen.has(item.externalId)) {
          seen.add(item.externalId);
          results.push(item);
        }
      }
      if (pageItems.length < 20) break;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return results;
}

async function fetchSbb(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('https://kamuilan.sbb.gov.tr/', {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; MemurPro/0.1; public announcement monitor)',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'tr-TR,tr;q=0.9',
        'referer': 'https://kamuilan.sbb.gov.tr/'
      },
      redirect: 'follow'
    });
    if (!response.ok) throw new Error('SBB portalı HTTP ' + response.status + ' döndürdü.');
    const html = await response.text();
    if (html.length > 3_000_000) throw new Error('SBB sayfası güvenli boyut sınırını aşıyor.');
    const items = parseSbbItems(html, source);
    if (!items.length) throw new Error('SBB portalında ayrıştırılabilir ilanDetay bağlantısı bulunamadı.');
    return { items };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFeed(source) {
  if (source.id === 'resmi-gazete') {
    return { items: await fetchResmiGazete(source) };
  }
  if (source.id === 'iskur' && !source.feed_url) {
    return { skipped: true, reason: 'İŞKUR iş arama hizmeti giriş gerektiriyor; doğrulanmış, herkese açık ve kimlik doğrulamasız ilan akışı bulunamadı.' };
  }
  if (source.adapter === 'ilan-gov') {
    return { items: await fetchIlanGov(source) };
  }
  if (source.adapter === 'sbb-portal') {
    return await fetchSbb(source);
  }
  if (source.adapter === 'kariyer-kapisi') {
    return { items: await fetchKariyerKapisi(source) };
  }
  if (source.adapter === 'osym-kpss') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(source.feed_url || 'https://www.osym.gov.tr/SinavGrubu/Index/3', {
        signal: controller.signal,
        headers: { 'user-agent': 'MemurPro/0.1 (+public-announcement-monitor)', 'accept': 'text/html,application/xhtml+xml' },
        redirect: 'follow'
      });
      if (!response.ok) throw new Error(`ÖSYM sayfası HTTP ${response.status} döndürdü.`);
      const html = await response.text();
      if (html.length > 3_000_000) throw new Error('ÖSYM sayfası güvenli boyut sınırını aşıyor.');
      const items = parseOsymKpssPage(html, source);
      if (!items.length) throw new Error('ÖSYM sayfasında ayrıştırılabilir KPSS duyurusu bulunamadı.');
      return { items };
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!source.feed_url || !['rss', 'json'].includes(source.feed_type)) {
    return { skipped: true, reason: 'Doğrulanmış herkese açık RSS/JSON akışı henüz tanımlanmadı.' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(source.feed_url, {
      signal: controller.signal,
      headers: { 'user-agent': 'MemurPro/0.1 (+official-source-monitor)', 'accept': 'application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9, */*;q=0.8' },
      redirect: 'follow'
    });
    if (!response.ok) throw new Error(`Kaynak HTTP ${response.status} döndürdü.`);
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error('Kaynak yanıtı güvenli boyut sınırını aşıyor.');
    if (source.feed_type === 'json') return { items: normalizeJsonFeed(JSON.parse(body), source) };
    if (!/<(?:rss|feed|rdf|item|entry)(?:\s|>)/i.test(body)) throw new Error('Yanıt RSS/Atom biçiminde değil; HTML sayfa otomatik ilan akışı olarak kullanılamaz.');
    return { items: parseXmlFeed(body, source) };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeSourceHomepage(source) {
  if (!source.homepage_url) return { reachable: false, reason: 'Ana sayfa adresi tanımlı değil.' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(source.homepage_url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; MemurPro/0.1; public-source-health-check)',
        'accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow'
    });
    try { await response.body?.cancel(); } catch {}
    return {
      reachable: response.ok,
      reason: response.ok ? 'Ana sayfa erişilebilir.' : 'Ana sayfa HTTP ' + response.status + ' döndürdü.'
    };
  } catch (error) {
    return { reachable: false, reason: 'Ana sayfa kontrolü: ' + safeText(error?.message || error, 180) };
  } finally {
    clearTimeout(timeout);
  }
}

async function syncOneSource(source, env) {
  const checkedAt = new Date().toISOString();
  try {
    const result = await fetchFeed(source);
    if (result.skipped) {
      await env.DB.prepare(`UPDATE sources SET status='pending', last_checked_at=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(checkedAt, result.reason, source.id).run();
      return { source: source.name, status: 'pending', imported: 0, message: result.reason };
    }

    let imported = 0;
    for (const item of result.items) {
      const externalId = safeText(item.externalId || item.detailUrl, 2000);
      if (!externalId) continue;
      const id = `${source.id}-${(await hashText(externalId)).slice(0, 24)}`;
      const fingerprint = await hashText(JSON.stringify(item));
      await env.DB.prepare(`
        INSERT INTO announcements (
          id, source_id, external_id, title, institution, summary, category, city, education,
          score_type, minimum_score, published_at, start_date, end_date, detail_url, source_name,
          status, content_hash, last_verified_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source_id, external_id) DO UPDATE SET
          title=excluded.title, institution=excluded.institution, summary=excluded.summary,
          category=excluded.category, city=excluded.city, education=excluded.education,
          score_type=excluded.score_type, minimum_score=excluded.minimum_score,
          published_at=excluded.published_at, start_date=excluded.start_date, end_date=excluded.end_date,
          detail_url=excluded.detail_url, source_name=excluded.source_name, status=excluded.status,
          content_hash=excluded.content_hash, last_verified_at=excluded.last_verified_at,
          updated_at=CURRENT_TIMESTAMP
      `).bind(
        id, source.id, externalId, item.title, item.institution || source.name, item.summary || null,
        item.category || 'Kamu ilanı', item.city || null, item.education || null,
        item.scoreType || null, item.minimumScore ?? null, item.publishedAt || null,
        item.startDate || null, item.endDate || null, item.detailUrl, source.name,
        item.status || 'check_required', fingerprint, checkedAt
      ).run();
      imported++;
    }
    await env.DB.prepare(`UPDATE sources SET status='connected', last_checked_at=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(checkedAt, source.id).run();
    return { source: source.name, status: 'connected', imported };
  } catch (error) {
    const message = safeText(error?.message || 'Bilinmeyen kaynak hatası', 500);
    const homepage = await probeSourceHomepage(source);
    const status = homepage.reachable ? 'degraded' : 'failed';
    const detail = homepage.reachable
      ? message + ' Ana site erişilebilir; ilan veri akışı çalışmıyor.'
      : message + ' ' + homepage.reason;
    await env.DB.prepare(`UPDATE sources SET status=?, last_checked_at=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(status, checkedAt, safeText(detail, 500), source.id).run();
    return { source: source.name, status, imported: 0, message: detail };
  }
}

async function syncConfiguredSources(env) {
  const result = await env.DB.prepare(`SELECT id, name, homepage_url, feed_url, feed_type, adapter, enabled, last_checked_at, status FROM sources WHERE enabled=1`).all();
  const sources = result.results || [];
  const minIntervals = {
    'kariyer-kapisi': 30 * 60 * 1000,
    'osym': 60 * 60 * 1000,
    'ilan-gov': 60 * 60 * 1000,
    'kamuilan-sbb': 60 * 60 * 1000,
    'resmi-gazete': 24 * 60 * 60 * 1000,
    'iskur': 60 * 60 * 1000
  };

  // Claim sources atomically, then fetch independent official sources concurrently.
  // This keeps a full manual refresh from waiting on each remote site's timeout in turn.
  const outcomes = await Promise.all(sources.map(async source => {
    const now = Date.now();
    const lastChecked = source.last_checked_at ? Date.parse(source.last_checked_at) : NaN;
    const normalInterval = minIntervals[source.id] || 60 * 60 * 1000;
    // Hatalı/bozulmuş kaynakları günlük normal aralığı beklemeden yeniden dene.
    const pendingAge = Number.isFinite(lastChecked) ? now - lastChecked : 0;
    const stalePending = source.id !== 'iskur' && source.status === 'pending' && pendingAge > 10 * 60 * 1000;
    const minInterval = ['failed', 'degraded'].includes(source.status)
      ? 15 * 60 * 1000
      : stalePending ? 5 * 60 * 1000 : normalInterval;
    const nowIso = new Date(now).toISOString();
    const cutoffIso = new Date(now - minInterval).toISOString();

    const claim = await env.DB.prepare(`
      UPDATE sources
      SET last_checked_at=?, status='pending', last_error='Kontrol ediliyor.'
      WHERE id=? AND (last_checked_at IS NULL OR last_checked_at<=?)
    `).bind(nowIso, source.id, cutoffIso).run();

    if (!claim.meta || claim.meta.changes === 0) {
      return {
        source: source.name,
        status: source.status,
        imported: 0,
        skipped: true,
        message: Number.isFinite(lastChecked) ? 'Kaynağın kontrol aralığı dolmadı.' : 'Kaynak başka bir işlem tarafından kontrol ediliyor.'
      };
    }
    return await syncOneSource(source, env);
  }));

  return outcomes;
}
export default {
  async fetch(request, env, ctx) {
    if (!env.DB) return json({ error: 'D1 veritabanı bağlantısı yapılandırılmamış.' }, 503);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': ALLOWED_METHODS, 'access-control-allow-headers': 'content-type,x-admin-token' } });
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/api/ingest') return await ingestBatch(request, env);
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return json({ ok: true, service: 'MemurPro API', time: new Date().toISOString() });
      }
      if (request.method === 'GET' && url.pathname === '/api/sources') {
        return json({ sources: await getSources(env) });
      }
      if (request.method === 'GET' && url.pathname === '/api/listings') {
        const [listings, sources] = await Promise.all([getListings(request, env), getSources(env)]);
        return json({ listings, sources, updatedAt: new Date().toISOString() });
      }
      if (request.method === 'POST' && (url.pathname === '/api/sync-now' || url.pathname === '/api/admin/sync')) {
        return json({ error: 'Kaynak taraması GitHub Actions tarafından yürütülür. Actions ekranından workflow_dispatch başlatın.' }, 410);
      }
      return json({ error: 'Bulunamadı.' }, 404);
    } catch (error) {
      return json({ error: safeText(error?.message || 'Sunucu hatası', 500) }, 500);
    }
  },

  async scheduled() {
    // Collection is handled by GitHub Actions. Worker only validates and stores batches.
  }
};

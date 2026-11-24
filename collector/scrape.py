import json, os, re, sys, time, io
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from pypdf import PdfReader
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

API=os.environ["MEMURPRO_API_BASE"].rstrip("/")  # public MemurPro read API
TOKEN=os.environ.get("MEMURPRO_INGEST_TOKEN","")
S=requests.Session()
_retry=Retry(total=3, connect=3, read=2, backoff_factor=0.8, status_forcelist=(408,425,429,500,502,503,504), allowed_methods=frozenset(["GET","HEAD"]), raise_on_status=False)
S.mount("https://", HTTPAdapter(max_retries=_retry, pool_connections=10, pool_maxsize=10))
S.mount("http://", HTTPAdapter(max_retries=_retry, pool_connections=5, pool_maxsize=5))
S.headers.update({"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36","Accept-Language":"tr-TR,tr;q=0.9"})
RE=re.compile(r"personel\s+al[ıi]m[ıi]?|memur\s+al[ıi]m[ıi]?|sözleşmeli(?:\s+\w+){0,3}\s+personel|işçi\s+al[ıi]m[ıi]?|öğretim\s+(?:üyesi|elemanı|görevlisi)\s+al[ıi]m[ıi]?|uzman\s+yardımcısı|müfettiş\s+yardımcısı|zabıta\s+memuru|itfaiye\s+eri",re.I)
BAD=re.compile(r"\b(sonuç|yerleştirilen|kazanan|iptal|düzeltme|duyuru sonucu|cevap anahtarı|cevap kâğıdı|aday cevapları|kura sonucu|atama sonucu)\b",re.I)

def tx(v): return re.sub(r"\s+"," ",BeautifulSoup(str(v or ""),"html.parser").get_text(" ",strip=True)).strip()
def decode(r):
    for enc in [r.encoding,r.apparent_encoding,"utf-8","windows-1254"]:
        if not enc: continue
        try:
            x=r.content.decode(enc)
            if x.count("\ufffd")<2: return x
        except (UnicodeDecodeError,LookupError): pass
    return r.content.decode("windows-1254",errors="replace")
def local_today():
    return datetime.now(ZoneInfo("Europe/Istanbul")).date().isoformat()

_ROBOTS_CACHE={}
def robots_check(url):
    parsed=urlparse(url)
    if parsed.scheme not in ("http","https") or not parsed.netloc:
        return False,"geçersiz kaynak URL'si"
    origin=f"{parsed.scheme}://{parsed.netloc}"
    if origin not in _ROBOTS_CACHE:
        robots_url=origin+"/robots.txt"
        try:
            response=S.get(robots_url,timeout=10,headers={"Accept":"text/plain"})
            if response.status_code in (404,410):
                parser=RobotFileParser()
                parser.parse([])
                _ROBOTS_CACHE[origin]=(parser,None)
            elif response.status_code>=400:
                _ROBOTS_CACHE[origin]=(None,f"robots.txt HTTP {response.status_code}")
            else:
                parser=RobotFileParser()
                parser.set_url(robots_url)
                parser.parse(decode(response).splitlines())
                _ROBOTS_CACHE[origin]=(parser,None)
        except Exception as exc:
            _ROBOTS_CACHE[origin]=(None,f"robots.txt okunamadı: {str(exc)[:120]}")
    parser,error=_ROBOTS_CACHE[origin]
    if error:
        return False,error
    if not parser.can_fetch("MemurPro",url):
        return False,"robots.txt bu URL'nin taranmasına izin vermiyor"
    return True,None

def require_robots_permission(url):
    allowed,reason=robots_check(url)
    if not allowed:
        raise RuntimeError(reason or "robots.txt taramaya izin vermiyor")

def date(v):
    v=tx(v)
    iso=re.match(r"^(\d{4}-\d{2}-\d{2})",v)
    if iso:
        try: return datetime.strptime(iso.group(1),"%Y-%m-%d").date().isoformat()
        except ValueError: return None
    m=re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})",v)
    if m:
        d,mo,y=m.groups()
        try: return datetime(int(y),int(mo),int(d)).date().isoformat()
        except ValueError: return None
    return None
def item(sid,eid,title,inst,url,summary="",**kw):
    institution=tx(inst)[:500] or sid
    title_text=tx(title)[:500]
    category=kw.get("category","Kamu ilanı")
    combined=(institution+" "+title_text).lower()
    institution_type=kw.get("institutionType")
    if not institution_type:
        institution_type="Belediye" if re.search(r"belediye|büyükşehir",combined) else "Üniversite" if re.search(r"üniversite|rektörlük",combined) else "Bakanlık / Başkanlık" if re.search(r"bakanlık|başkanlık|genel müdürlük",combined) else "Diğer kamu kurumu"
    employment_type=kw.get("employmentType") or ("İşçi" if category=="İşçi" else "Sözleşmeli personel" if re.search(r"sözleşmeli|4/b",combined) else "Memur" if category=="Memur" or re.search(r"memur|zabıta|itfaiye",combined) else "")
    announcement_type=kw.get("announcementType") or ("KPSS tercih / yerleştirme" if re.search(r"kpss.*(tercih|yerleştirme)|merkezi yerleştirme",combined) else "Personel alımı" if RE.search(title_text) else "Duyuru")
    return {"externalId":str(eid),"title":title_text,"institution":institution,
      "summary":tx(summary)[:12000],"category":category,"city":kw.get("city"),
      "education":kw.get("education"),"departments":kw.get("departments",[]),
      "employmentType":employment_type,"institutionType":institution_type,"announcementType":announcement_type,
      "scoreType":kw.get("scoreType"),"minimumScore":kw.get("minimumScore"),
      "publishedAt":kw.get("publishedAt"),"startDate":kw.get("startDate"),"endDate":kw.get("endDate"),
      "positionCount":kw.get("positionCount"),"detailUrl":url,"status":kw.get("status","check_required")}
def keep(x):
    return bool(x["title"] and x["detailUrl"] and not BAD.search(x["title"]) and (RE.search(x["title"]+" "+x["summary"]) or x["category"] in ("KPSS","Memur","İşçi","Akademik Personel")))

def sbb_html(html):
    soup=BeautifulSoup(html,"html.parser"); out=[]; seen=set()
    for a in soup.select('a[href*="ilanDetay.aspx"][href*="kod="]'):
        u=urljoin("https://kamuilan.sbb.gov.tr/",a.get("href","")); m=re.search(r"[?&]kod=([^&]+)",u); title=tx(a)
        if not m or len(title)<5 or m.group(1) in seen: continue
        seen.add(m.group(1)); clean=re.sub(r"\s*\([^)]*\d{1,2}[^)]*-\s*[^)]*\)","",title).strip()
        inst=clean.split(" - ")[0] if " - " in clean else "Kamu kurumu"
        out.append(item("kamuilan-sbb",m.group(1),clean,inst,u,"SBB Kamu İlan Portalı kaydı; koşul ve tarihler resmî ilan metninden doğrulanmalı.",category="Memur"))
    return out[:150]
def kariyer_rows(payload):
    rows=payload.get("searchIlan") if isinstance(payload,dict) else None
    if not isinstance(rows,list): return []
    out=[]; today=local_today()
    for r in rows:
        gid=r.get("guid"); title=r.get("ilanBaslik") or r.get("ilanAdi") or r.get("baslik")
        if not gid or not title: continue
        start=date(r.get("basTarih") or r.get("baslangicTarihi")); end=date(r.get("bitTarih") or r.get("bitisTarihi"))
        opened=bool(end and end>=today and (not start or start<=today))
        out.append(item("kariyer-kapisi",gid,title,r.get("kurumAdi") or r.get("kurum") or "Kariyer Kapısı",
          "https://kariyerkapisi.gov.tr/IlanDetay?i="+str(gid),"Kariyer Kapısı kamu işe alım ilanı; şartlar ve ekler resmî sayfadan kontrol edilmeli.",
          category="Memur",city=r.get("ilAdi") or r.get("il"),education=r.get("ogrenimDurumu") or r.get("ogrenim"),
          scoreType=r.get("puanTuru") or r.get("kpssPuanTuru"),publishedAt=r.get("yayinTarihi") or r.get("ilanTarihi"),
          startDate=start,endDate=end,status="open" if opened else "check_required"))
    return out
def scrape_kariyer(browser):
    p=browser.new_page(); captured=[]; api_urls=[]
    api_endpoints=[
        "https://api.kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage",
        "https://kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage"
    ]
    api_permissions={endpoint:robots_check(endpoint)[0] for endpoint in api_endpoints}
    def guard_robots(route):
        request_url=route.request.url
        if "GetIseAlimPage" in request_url:
            allowed=any(request_url.startswith(endpoint) and api_permissions.get(endpoint,False) for endpoint in api_endpoints)
            if not allowed:
                route.abort()
                return
        route.continue_()
    p.route("**/*",guard_robots)
    def on_request(req):
        if req.resource_type in ("xhr","fetch") and "/api/" in req.url:
            api_urls.append(req.url)
            if "GetIseAlimPage" in req.url:
                print("Kariyer gerçek XHR:",req.method,req.url,"body:",(req.post_data or "")[:800],"headers:",{k:v for k,v in req.headers.items() if k.lower() in ("accept","content-type","origin","referer","x-requested-with")},file=sys.stderr)
    def on_response(resp):
        if "/api/" in resp.url:
            if "GetIseAlimPage" in resp.url:
                try: sample=resp.text()[:350]
                except Exception: sample=""
                print("Kariyer XHR yanıtı:",resp.status,resp.headers.get("content-type"),resp.url,"body:",sample,file=sys.stderr)
            try:
                data=resp.json()
                if isinstance(data,dict) and isinstance(data.get("searchIlan"),list):
                    captured.append(data)
            except Exception: pass
    p.on("request",on_request); p.on("response",on_response)
    try:
        try:
            p.goto("https://kariyerkapisi.gov.tr/isealim",wait_until="domcontentloaded",timeout=25000)
            p.wait_for_timeout(3500)
        except Exception as exc:
            print("Kariyer sayfa açılışı:",str(exc)[:180],file=sys.stderr)
        print("Kariyer sayfası XHR adresleri:",", ".join(dict.fromkeys(api_urls[-10:])) or "XHR bulunamadı",file=sys.stderr)
        if captured:
            return kariyer_rows(max(captured,key=lambda x:len(x.get("searchIlan",[]))))
        # API yanıt vermezse, herkese açık ve kullanıcıya görünen ilan kartlarını DOM'dan çıkar.
        # Detay bağlantısı ve ilan başlığı birlikte doğrulanmadan genel sayfa linkleri kaydedilmez.
        dom_items=[]; seen=set()
        for a in p.locator("a[href]").all():
            try:
                raw_href=a.get_attribute("href") or ""
                href=urljoin("https://kariyerkapisi.gov.tr/isealim",raw_href)
                host=urlparse(href).hostname or ""
                if host not in ("kariyerkapisi.gov.tr","www.kariyerkapisi.gov.tr"): continue
                if href.rstrip("/") in ("https://kariyerkapisi.gov.tr/isealim","https://kariyerkapisi.gov.tr"): continue
                anchor=tx(a.inner_text(timeout=1000))
                context=""
                node=a
                for _ in range(5):
                    try:
                        node=node.locator("xpath=..")
                        candidate=tx(node.inner_text(timeout=1000))
                        if len(candidate)>len(context) and len(candidate)<3500: context=candidate
                        if candidate and (RE.search(candidate) or re.search(r"başvuru\s+tarihi|son\s+başvuru",candidate,re.I)): break
                    except Exception: break
                combined=anchor+" "+context
                detail_like=bool(re.search(r"ilan.?detay|ilan-detay|detay|basvuru|başvuru|guid=|[?&]i=",href,re.I))
                if not detail_like or not RE.search(combined): continue
                lines=[tx(x) for x in re.split(r"[\n|•]+",context) if tx(x)]
                title=next((line for line in lines if RE.search(line) and len(line)>8),anchor)
                if len(title)<8 or href in seen: continue
                seen.add(href)
                start_match=re.search(r"(?:başvuru(?:lar)?|başlangıç)[^0-9]{0,50}(\d{1,2}[./-]\d{1,2}[./-]\d{4})",context,re.I)
                end_match=re.search(r"(?:son\s+başvuru|başvuruların\s+son\s+günü|bitiş)[^0-9]{0,60}(\d{1,2}[./-]\d{1,2}[./-]\d{4})",context,re.I)
                edu_match=re.search(r"ön\s+lisans|ortaöğretim|lise|lisans",context,re.I)
                score_match=re.search(r"\b(P93|P94|P3)\b",context,re.I)
                start_date=date(start_match.group(1)) if start_match else None
                end_date=date(end_match.group(1)) if end_match else None
                is_open=bool(end_date and end_date>=local_today() and (not start_date or start_date<=local_today()))
                dom_items.append(item("kariyer-kapisi",href,title,"Kariyer Kapısı (kurum bilgisi ilanda)",href,
                    context or "Kariyer Kapısı aktif ilan kartı; şartlar ve tarihler resmî ilandan doğrulanmalı.",
                    category="Memur",education=edu_match.group(0) if edu_match else None,
                    scoreType=score_match.group(1).upper() if score_match else None,
                    startDate=start_date,endDate=end_date,status="open" if is_open else "check_required"))
            except Exception: continue
        if dom_items:
            print(f"Kariyer DOM yedek yöntemi: {len(dom_items)} doğrulanmış ilan kartı",file=sys.stderr)
            return dom_items[:150]
        body={"krM_ID":0,"searchText":"","il":"0","ilanTuru":"0"}
        last_error=None
        for endpoint in ("https://api.kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage","https://kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage"):
            for attempt in range(3):
                try:
                    # Site XHR's actual request is JSON; form-urlencoded requests receive HTTP 406.
                    resp=p.request.post(endpoint,data=json.dumps(body,ensure_ascii=False),
                      headers={"Referer":"https://kariyerkapisi.gov.tr/isealim","Origin":"https://kariyerkapisi.gov.tr","Content-Type":"application/json","Accept":"application/json, text/plain, */*"},
                      timeout=25000)
                    if not resp.ok: raise RuntimeError(f"Kariyer API HTTP {resp.status}")
                    payload=resp.json()
                    if isinstance(payload,dict) and isinstance(payload.get("searchIlan"),list):
                        return kariyer_rows(payload)
                    raise RuntimeError("Kariyer API searchIlan listesi döndürmedi.")
                except Exception as exc:
                    last_error=exc
                    if "HTTP 406" in str(exc):
                        # 406 istemin reddedildiğini gösterir; aynı isteği tekrar denemek sonuç vermiyor.
                        break
                    if attempt<2: time.sleep(1.5*(2**attempt))
        raise RuntimeError(f"İki resmî Kariyer API adresi yanıt vermedi: {last_error}")
    finally: p.close()

def parse_resmi(html,date_key,page_url):
    soup=BeautifulSoup(html,"html.parser")
    lines=[tx(x) for x in soup.get_text("\n").splitlines()]
    lines=[x for x in lines if x]
    heading_re=re.compile(r"^(.{3,180}?(?:Bakanlığından|Bakanlığından|Genel Müdürlüğünden|Başkanlığından|Rektörlüğünden|Belediye Başkanlığından|Müdürlüğünden|Üniversitesinden))\s*:?\s*$",re.I)
    blocks=[]; current_heading="Resmî Gazete"; current=[]
    for line in lines:
        if heading_re.search(line) and current:
            blocks.append((current_heading,current)); current_heading=line.rstrip(":"); current=[]
        elif heading_re.search(line):
            current_heading=line.rstrip(":")
        current.append(line)
    if current: blocks.append((current_heading,current))
    out=[]
    for index,(institution,block_lines) in enumerate(blocks):
        block="\n".join(block_lines)
        if not RE.search(block) or BAD.search(block[:500]):
            continue
        useful=[x for x in block_lines if RE.search(x)]
        title=useful[0] if useful else institution+" personel alımı ilanı"
        end_match=re.search(r"(?:son\s+başvuru(?:\s+tarihi)?|başvurular(?:ın)?\s+son\s+günü|başvuru\s+süresi)[^\d]{0,80}(\d{1,2}[./-]\d{1,2}[./-]\d{4})",block,re.I)
        start_match=re.search(r"(?:başvurular?\s+)?(?:başlangıç|başlama)\s+tarihi[^\d]{0,50}(\d{1,2}[./-]\d{1,2}[./-]\d{4})",block,re.I)
        count_match=re.search(r"(\d{1,4})\s*(?:adet|kişilik|kişi|personel|sözleşmeli\s+personel)",block,re.I)
        score_match=re.search(r"\b(P93|P3|P94)\b",block,re.I)
        min_match=re.search(r"(?:en\s+az|taban|asgari)\s*(?:KPSS\s*)?(?:puan[ıi])?\s*[:\-]?\s*(\d{2}(?:[.,]\d{1,2})?)",block,re.I)
        edu_match=re.search(r"\b(ön\s+lisans|lisans|ortaöğretim|lise|ilköğretim)\b",block,re.I)
        city_match=re.search(r"\b(İstanbul|Ankara|İzmir|Bursa|Antalya|Adana|Konya|Gaziantep|Kocaeli|Mersin|Kayseri|Samsun|Trabzon|Erzurum)\b",block,re.I)
        end_date=date(end_match.group(1)) if end_match else None
        start_date=date(start_match.group(1)) if start_match else None
        out.append(item("resmi-gazete",page_url+"#notice-"+str(index),title,institution,page_url,block,
            category="İşçi" if re.search(r"işçi\s+al[ıi]m",block,re.I) else "Memur",
            city=city_match.group(1) if city_match else None,
            education=edu_match.group(1) if edu_match else None,
            scoreType=score_match.group(1).upper() if score_match else None,
            minimumScore=float(min_match.group(1).replace(",", ".")) if min_match else None,
            publishedAt=f"{date_key[:4]}-{date_key[4:6]}-{date_key[6:8]}",
            startDate=start_date,endDate=end_date,
            positionCount=int(count_match.group(1)) if count_match else None,
            status="open" if end_date and end_date>=local_today() else "check_required"))
    return out[:100]

def decode_resmi(response):
    # Resmî Gazete's legacy announcement pages are served as Windows-1254.
    return response.content.decode("windows-1254", errors="replace")

def extract_resmi_pdf(content):
    try:
        reader=PdfReader(io.BytesIO(content))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as exc:
        raise RuntimeError(f"Resmî Gazete PDF metni okunamadı: {exc}")

def scrape_resmi():
    now=datetime.now(timezone.utc)+timedelta(hours=3); errors=[]
    for off in range(4):
        d=now.date()-timedelta(days=off); key=d.strftime("%Y%m%d")
        index=f"https://www.resmigazete.gov.tr/fihrist?tarih={d.isoformat()}"
        candidates=[]
        try:
            r=S.get(index,timeout=25,headers={"Referer":"https://www.resmigazete.gov.tr/"})
            if r.ok:
                soup=BeautifulSoup(decode_resmi(r),"html.parser")
                for a in soup.find_all("a",href=True):
                    label=tx(a); href=urljoin(index,a["href"])
                    if re.search(r"çeşitli\s+il[âa]nlar",label,re.I) or re.search(r"\.pdf(?:$|\?)",href,re.I):
                        candidates.append(href)
            else: errors.append(f"{d} fihrist HTTP {r.status_code}")
        except Exception as exc:
            errors.append(f"{d} fihrist: {str(exc)[:100]}")
        candidates.extend([
            f"https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/{d.year}/{d.month:02d}/{key}-4.htm",
            f"https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/{d.year}/{d.month:02d}/{key}-4.pdf",
            f"https://www.resmigazete.gov.tr/eskiler/{d.year}/{d.month:02d}/{key}.pdf"
        ])
        checked=set()
        for u in candidates:
            if u in checked: continue
            checked.add(u)
            try:
                page=S.get(u,timeout=30,headers={"Referer":index})
                if not page.ok:
                    errors.append(f"{d} HTTP {page.status_code} {u.rsplit('/',1)[-1]}")
                    continue
                is_pdf=("pdf" in page.headers.get("content-type","").lower() or u.lower().endswith(".pdf") or page.content[:4]==b"%PDF")
                if is_pdf:
                    pdf_text=extract_resmi_pdf(page.content)
                    if len(pdf_text.strip())<100: raise RuntimeError("PDF metni boş veya taranmış görüntü.")
                    html="<html><body><pre>"+pdf_text.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")+"</pre></body></html>"
                else:
                    html=decode_resmi(page)
                body=tx(html)
                if not re.search(r"çeşitli\s+il[âa]nlar",body,re.I) and not RE.search(body):
                    errors.append(f"{d} içerik eşleşmedi: {u.rsplit('/',1)[-1]}")
                    continue
                found=parse_resmi(html,key,u)
                if found:
                    print(f"Resmî Gazete OK {d}: {len(found)} ilan adayı ({'PDF' if is_pdf else 'HTML'})",file=sys.stderr)
                    return found[:150]
                errors.append(f"{d} {u.rsplit('/',1)[-1]}: içerik açıldı ancak personel ilanı ayrıştırılamadı; sonraki alternatif deneniyor.")
                continue
            except Exception as exc:
                errors.append(f"{d} {u.rsplit('/',1)[-1]}: {str(exc)[:100]}")
    raise RuntimeError("Resmî Gazete son 4 günün HTML/PDF alternatifleri okunamadı. "+"; ".join(errors[-8:])[:450])

def scrape_osym():
    u="https://www.osym.gov.tr/SinavGrubu/Index/3"; r=S.get(u,timeout=15); r.raise_for_status()
    soup=BeautifulSoup(decode(r),"html.parser"); out=[]; seen=set()
    for a in soup.find_all("a",href=True):
        title=tx(a); href=urljoin(u,a["href"])
        if "kpss" not in title.lower() or len(title)<12 or "osym.gov.tr" not in (urlparse(href).hostname or "") or href in seen or "/SinavGrubu/Index/3" in href: continue
        seen.add(href); out.append(item("osym",href,title,"ÖSYM",href,"ÖSYM KPSS duyurusu; resmî duyuruyu inceleyin.",category="KPSS"))
    return out[:100]

def parse_ilan_payload(payload):
    ads=payload.get("result",{}).get("ads") if isinstance(payload,dict) else None
    if not isinstance(ads,list): raise RuntimeError("İlan.gov.tr result.ads listesi bulunamadı")
    out=[]
    for x in ads:
        aid=x.get("id") or x.get("idInt") or x.get("adNo"); title=x.get("title")
        if not aid or not title: continue
        u=urljoin("https://www.ilan.gov.tr/",x.get("urlStr") or f"ilan/{aid}")
        summary=" · ".join(f"{v.get('key')}: {v.get('value')}" for v in (x.get("adTypeFilters") or []) if v.get("key") and v.get("value"))
        out.append(item("ilan-gov","ilan-gov-"+str(aid),title,x.get("advertiserName") or "Kamu / akademik kurum",u,summary,
            category="Akademik Personel",city=x.get("addressCityName"),publishedAt=x.get("publishStartDate")))
    return out

def scrape_ilan(browser):
    p=browser.new_page(); captured=[]
    require_robots_permission("https://www.ilan.gov.tr/api/api/services/app/Ad/AdsByFilter")
    endpoint="/api/api/services/app/Ad/AdsByFilter"
    def on_response(resp):
        if endpoint in resp.url:
            try:
                data=resp.json()
                if isinstance(data,dict) and isinstance(data.get("result",{}).get("ads"),list): captured.append(data)
            except Exception: pass
    p.on("response",on_response)
    try:
        response=p.goto("https://www.ilan.gov.tr/ilan/kategori/8/kamu-akademik-personel?ats=5",wait_until="domcontentloaded",timeout=20000)
        if response and response.status>=400: raise RuntimeError(f"İlan.gov.tr sayfası HTTP {response.status}")
        p.wait_for_timeout(1200)
        pages=list(captured)
        if not pages:
            for skip in (0,20,40):
                payload=p.evaluate("""async (skip) => {
                  const body={keys:{txv:[8],ats:[5],order:['desc'],field:['publish_time']},sorting:'publish_time desc',skipCount:skip,maxResultCount:20};
                  const r=await fetch('/api/api/services/app/Ad/AdsByFilter',{method:'POST',headers:{'content-type':'application/json-patch+json','accept':'application/json, text/plain, */*','x-request-origin':'IGT-UI','x-requested-with':'XMLHttpRequest'},body:JSON.stringify(body)});
                  if(!r.ok) return {__httpStatus:r.status};
                  return await r.json();
                }""",skip)
                if payload.get("__httpStatus"): raise RuntimeError(f"İlan.gov.tr API HTTP {payload['__httpStatus']}")
                pages.append(payload)
                ads=payload.get("result",{}).get("ads",[])
                if len(ads)<20: break
                time.sleep(.25)
        out=[]; seen=set()
        for payload in pages:
            for x in parse_ilan_payload(payload):
                if x["externalId"] not in seen: seen.add(x["externalId"]); out.append(x)
        return out
    finally: p.close()

def scrape_iskur(browser):
    p=browser.new_page()
    try:
        p.goto("https://esube.iskur.gov.tr/Istihdam/AcikIsIlanAra.aspx",wait_until="domcontentloaded",timeout=25000)
        p.wait_for_timeout(1800)

        # İŞKUR e-Şube'de "Kamu" bir select option değil, İşyeri Türü
        # alanında ayrı bir radio/checkbox seçeneğidir.
        chosen=False
        labels=p.locator("label")
        for i in range(labels.count()):
            lab=labels.nth(i)
            if re.fullmatch(r"kamu",tx(lab.inner_text()),re.I):
                target=lab.get_attribute("for")
                if target:
                    control=p.locator("#"+target)
                    if control.count():
                        control.check(force=True)
                    else:
                        lab.click(force=True)
                else:
                    lab.click(force=True)
                chosen=True
                break

        if not chosen:
            controls=p.locator('input[type="radio"],input[type="checkbox"]')
            for i in range(controls.count()):
                control=controls.nth(i)
                info=control.evaluate("""el => {
                    const labels=[...(el.labels||[])].map(x=>x.innerText||'').join(' ');
                    let p=el.parentElement, parts=[];
                    for(let n=0;n<3 && p;n++,p=p.parentElement) parts.push(p.innerText||'');
                    return {labels,parents:parts};
                }""")
                texts=[tx(info.get("labels",""))]+[tx(x) for x in info.get("parents",[])]
                if any(re.fullmatch(r"kamu",x,re.I) for x in texts):
                    control.check(force=True)
                    chosen=True
                    break

        if not chosen:
            raise RuntimeError("İŞKUR e-Şube sayfasında İşyeri Türü > Kamu seçim kutusu bulunamadı.")

        p.wait_for_timeout(300)
        # Ara butonu sayfada submit dışı bir kontrol olabileceğinden metinle de aranır.
        clicked=False
        for selector in ['input[type="submit"]','input[type="button"]','button','a']:
            els=p.locator(selector)
            for i in range(els.count()):
                el=els.nth(i)
                label=tx(el.get_attribute("value") or el.inner_text())
                if re.fullmatch(r"ara",label,re.I):
                    el.click(force=True)
                    clicked=True
                    break
            if clicked: break
        if not clicked:
            raise RuntimeError("İŞKUR kamu filtresi seçildi ancak Ara kontrolü bulunamadı.")

        try:
            p.wait_for_load_state("domcontentloaded",timeout=10000)
        except Exception:
            pass
        p.wait_for_timeout(1800)

        # İlan kartları bazı sayfa sürümlerinde tablo satırı değil bağlantı/kart olarak geliyor.
        soup=BeautifulSoup(p.content(),"html.parser")
        out=[]; seen=set()
        for a in soup.find_all("a",href=True):
            title=tx(a.get_text(" ",strip=True))
            href=urljoin("https://esube.iskur.gov.tr/",a["href"])
            if len(title)<4 or not re.search(r"ilan|acikis",href,re.I):
                continue
            if href in seen: continue
            seen.add(href)
            parent=a
            card_text=title
            for _ in range(4):
                if parent.parent:
                    parent=parent.parent
                    candidate=tx(parent.get_text(" ",strip=True))
                    if len(candidate)>len(title) and (re.search(r"\d{8,11}",candidate) or re.search(r"son başvuru|açık pozisyon|çalışma yeri",candidate,re.I)):
                        card_text=candidate
                        break
            out.append(item("iskur",href,title,"İŞKUR kamu işyeri türü filtresinden listelenen açık iş ilanı",href,card_text,category="İşçi"))
        if not out:
            body=tx(p.locator("body").inner_text())
            if re.search(r"aradığınız kriterlere uygun kayıt bulunamadı",body,re.I):
                return []
            raise RuntimeError("Kamu filtresi uygulandı ancak sayfadan okunabilir ilan bağlantısı çıkarılamadı.")
        return out[:150]
    finally:
        p.close()

def scrape_iskur_memur(browser):
    url="https://www.iskur.gov.tr/ilanlar/kamu-memur-alim-ilanlari/?idId=istanbul&il=%C4%B0stanbul"
    p=browser.new_page()
    try:
        response=p.goto(url,wait_until="domcontentloaded",timeout=25000)
        if response and response.status>=400:
            raise RuntimeError(f"İŞKUR Kamu Memur Alım sayfası HTTP {response.status}")
        p.wait_for_timeout(700)
        soup=BeautifulSoup(p.content(),"html.parser")
        out=[]; seen=set()
        for row in soup.select("tr"):
            cells=row.find_all(["td","th"])
            if len(cells)<2: continue
            row_text=tx(row.get_text(" ",strip=True))
            title_cell=cells[1] if len(cells)>1 else row
            title=tx(title_cell.get_text(" ",strip=True))
            if not title or not RE.search(title) or BAD.search(title): continue
            link=row.find("a",href=True)
            detail=urljoin("https://www.iskur.gov.tr/",link["href"]) if link else url
            date_text=tx(cells[0].get_text(" ",strip=True))
            date_match=re.search(r"(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2}))?",date_text)
            end_date=None
            if date_match:
                end_date=f"{date_match.group(3)}-{date_match.group(2).zfill(2)}-{date_match.group(1).zfill(2)}"
            eid=detail if detail!=url else re.sub(r"\W+","-",title.lower())+"-"+(end_date or "current")
            if eid in seen: continue
            seen.add(eid)
            # İŞKUR listesi yalnızca başlık ve bitiş tarihini verir; ayrıntılı bölüm şartları
            # bağlı resmî PDF ekinden alınır. Böylece "İlanın her alanında ara" gerçek içeriği tarar.
            full_text=row_text
            education=None
            score_type=None
            minimum_score=None
            position_count=None
            departments=[]
            start_date=None
            if link and detail.lower().split("?")[0].endswith(".pdf"):
                try:
                    require_robots_permission(detail)
                    pdf_response=S.get(detail,timeout=30,headers={"Referer":"https://www.iskur.gov.tr/"})
                    pdf_response.raise_for_status()
                    reader=PdfReader(io.BytesIO(pdf_response.content))
                    full_text=tx(" ".join(page.extract_text() or "" for page in reader.pages))[:12000]
                    if not full_text:
                        raise RuntimeError("İŞKUR PDF metni boş veya taranmış görüntü.")
                    department_patterns=[
                        (r"\badalet\b","Adalet"),
                        (r"mahalli\s+idareler","Mahalli İdareler"),
                        (r"yerel\s+yönetimler","Yerel Yönetimler"),
                        (r"büro\s+yönetimi(?:\s+ve\s+yönetici\s+asistanlığı)?","Büro Yönetimi"),
                        (r"bilgisayar\s+programcılığı","Bilgisayar Programcılığı"),
                        (r"çocuk\s+gelişimi","Çocuk Gelişimi"),
                        (r"insan\s+kaynakları","İnsan Kaynakları")
                    ]
                    departments=[name for pattern,name in department_patterns if re.search(pattern,full_text,re.I)]
                    if "Adalet" in departments and re.search(r"ön\s*lisans",full_text,re.I):
                        education="Ön lisans: "+", ".join(departments)+" ve ilanda belirtilen diğer programlar"
                    department_row=None
                    for row_match in re.finditer(r"\b\d+\s+Zabıta\s+Memuru\s+GİH\s+\d+\s+(\d{1,3})\s*-\s*([\s\S]{0,1200}?)(?=\s+\d+\s+Zabıta\s+Memuru|\s+BAŞVURU\s+GENEL|$)",full_text,re.I):
                        if re.search(r"\badalet\b",row_match.group(2),re.I):
                            department_row=row_match
                            position_count=int(row_match.group(1))
                            break
                    score_context=department_row.group(0) if department_row else full_text
                    score_match=re.search(r"\bP\s*(93|94|3)\b",score_context,re.I)
                    score_type=("P"+score_match.group(1)) if score_match else None
                    min_match=re.search(r"(?:en\s+az|asgari)\s*(\d{2,3})\s*(?:puan)?",score_context,re.I)
                    minimum_score=int(min_match.group(1)) if min_match else None
                    application_section=re.search(r"BAŞVURU\s+YERİ.{0,80}?TARİHİ.{0,80}?SÜRESİ\s*:?([\s\S]{0,1800}?)(?=BAŞVURULARIN\s+DEĞERLENDİRİLMESİ|SINAVIN\s+YERİ|$)",full_text,re.I)
                    date_matches=re.findall(r"\b(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b",application_section.group(1) if application_section else "")
                    if date_matches:
                        start_date=date(date_matches[0])
                    print(f"İŞKUR PDF OK: {title} · {len(full_text)} karakter · bölümler: {', '.join(departments) if departments else 'çıkarılamadı'} · KPSS: {score_type or 'çıkarılamadı'} · kontenjan: {position_count or 'çıkarılamadı'} · başlangıç: {start_date or 'çıkarılamadı'}",file=sys.stderr)
                except Exception as exc:
                    print(f"İŞKUR PDF ayrıntısı alınamadı: {detail}: {str(exc)[:180]}",file=sys.stderr)
            is_open=bool(end_date and end_date>=local_today() and (not start_date or start_date<=local_today()))
            out.append(item("iskur-kamu-memur",eid,title,"İŞKUR Kamu Memur Alım İlanları",detail,
                full_text,category="Memur",city="İstanbul",education=education,scoreType=score_type,
                minimumScore=minimum_score,positionCount=position_count,departments=departments,startDate=start_date,
                endDate=end_date,status="open" if is_open else "check_required"))
        if not out:
            body=tx(soup.get_text(" ",strip=True))
            if "İstanbul iline ait İlanlar" not in body and "Kamu Memur Alım İlanları" not in body:
                raise RuntimeError("İŞKUR kamu memur ilan sayfası beklenen içerikle açılmadı.")
            print("İŞKUR Kamu Memur: sayfa erişilebilir, uygun ilan bulunamadı.")
        print(f"İŞKUR Kamu Memur: {len(out)} ilan bulundu.")
        return out[:100]
    finally:
        p.close()

def scrape_sbb_official():
    # Bu yedek kaynak yalnızca SBB'nin kendi resmî duyurularını tarar.
    # kamuilan.sbb.gov.tr portalının yerine geçtiği veya tüm kurum ilanlarını kapsadığı iddia edilmez.
    url="https://www.sbb.gov.tr/tumu/"
    r=S.get(url,timeout=25,headers={"Referer":"https://www.sbb.gov.tr/"})
    r.raise_for_status()
    soup=BeautifulSoup(decode(r),"html.parser")
    out=[]; seen=set()
    for a in soup.find_all("a",href=True):
        title=tx(a)
        href=urljoin(url,a["href"])
        host=urlparse(href).hostname or ""
        if host not in ("sbb.gov.tr","www.sbb.gov.tr") or href.rstrip("/") == url.rstrip("/"):
            continue
        if len(title)<8 or not RE.search(title) or BAD.search(title):
            continue
        if href in seen: continue
        seen.add(href)
        parent=a
        context=title
        for _ in range(4):
            if not parent.parent: break
            parent=parent.parent
            candidate=tx(parent.get_text(" ",strip=True))
            if len(candidate)>len(context) and len(candidate)<2500:
                context=candidate
        date_match=re.search(r"(\\d{4}-\\d{2}-\\d{2})",context)
        published=date(date_match.group(1)) if date_match else None
        category="İşçi" if re.search(r"işçi\\s+al[ıi]m",title,re.I) else "Memur"
        out.append(item("sbb-kurum-duyurulari",href,title,"Strateji ve Bütçe Başkanlığı",href,
            context or "SBB'nin kendi personel duyurusu; ayrıntılar resmî sayfadan kontrol edilmeli.",
            category=category,publishedAt=published,status="check_required"))
    print(f"SBB kurum duyuruları: {len(out)} personel ilanı bulundu.",file=sys.stderr)
    return out[:100]

def scrape_sbb(browser):
    p=browser.new_page()
    try:
        target="https://kamuilan.sbb.gov.tr/"
        require_robots_permission(target)
        response=p.goto(target,wait_until="domcontentloaded",timeout=25000)
        if response and response.status>=400:
            headers=response.headers
            try: body_sample=tx(p.locator("body").inner_text())[:450]
            except Exception: body_sample=""
            details={key:headers.get(key) for key in ("content-type","server","cf-ray","retry-after") if headers.get(key)}
            print("SBB HTTP yanıtı:",response.status,"headers:",details,"body:",body_sample,file=sys.stderr)
            raise RuntimeError(f"SBB portal HTTP {response.status}; headers={details}; body={body_sample}")
        p.wait_for_timeout(1500)
        page_text=tx(p.locator("body").inner_text())
        if re.search(r"access denied|forbidden|captcha|robot doğrulama",page_text,re.I):
            raise RuntimeError("SBB portalı tarayıcı isteğini engelledi.")
        return sbb_html(p.content())
    finally: p.close()

SCRAPERS={"kariyer-kapisi":scrape_kariyer,"resmi-gazete":lambda b:scrape_resmi(),"osym":lambda b:scrape_osym(),"ilan-gov":scrape_ilan,"kamuilan-sbb":scrape_sbb,"sbb-kurum-duyurulari":lambda b:scrape_sbb_official(),"iskur":scrape_iskur,"iskur-kamu-memur":scrape_iskur_memur}
SOURCE_INTERVAL_MINUTES={"kariyer-kapisi":30,"resmi-gazete":30,"osym":120,"ilan-gov":90,"kamuilan-sbb":180,"sbb-kurum-duyurulari":180,"iskur":240,"iskur-kamu-memur":5}
def report(sid,items=None,error=None):
    if not TOKEN: raise RuntimeError("MEMURPRO_INGEST_TOKEN secret is missing")
    r=requests.post(API+"/api/ingest",headers={"x-admin-token":TOKEN},json={"sourceId":sid,"items":items or [],"error":error},timeout=30); r.raise_for_status(); return r.json()
def main():
    r=S.get(API+"/api/sources",timeout=20); r.raise_for_status(); sources={x["id"]:x for x in r.json().get("sources",[])}
    now=datetime.now(timezone.utc); results=[]; dry=os.environ.get("COLLECTOR_DRY_RUN")=="1"
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        try:
            for sid,scraper in SCRAPERS.items():
                src=sources.get(sid)
                if not src or not src.get("enabled",1): continue
                backoff=src.get("backoffUntil")
                if backoff:
                    try:
                        if datetime.fromisoformat(backoff.replace("Z","+00:00"))>now:
                            print("BACKOFF",sid,"yeniden deneme",backoff); continue
                    except ValueError: pass
                checked=src.get("checkedAt")
                if checked and src.get("status") not in ("failed","degraded"):
                    try:
                        last=datetime.fromisoformat(checked.replace("Z","+00:00"))
                        interval=SOURCE_INTERVAL_MINUTES.get(sid,120)
                        if (now-last).total_seconds()<interval*60:
                            print("INTERVAL SKIP",sid,f"{interval} dk dolmadı"); continue
                    except ValueError: pass
                try:
                    targets={
                        "kariyer-kapisi":"https://kariyerkapisi.gov.tr/isealim",
                        "resmi-gazete":"https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/",
                        "osym":"https://www.osym.gov.tr/SinavGrubu/Index/3",
                        "ilan-gov":"https://www.ilan.gov.tr/ilan/kategori/8/kamu-akademik-personel?ats=5",
                        "kamuilan-sbb":"https://kamuilan.sbb.gov.tr/",
                        "sbb-kurum-duyurulari":"https://www.sbb.gov.tr/tumu/",
                        "iskur":"https://esube.iskur.gov.tr/Istihdam/AcikIsIlanAra.aspx",
                        "iskur-kamu-memur":src.get("homepageUrl") or "https://www.iskur.gov.tr/ilanlar/kamu-memur-alim-ilanlari/"
                    }
                    require_robots_permission(targets.get(sid) or src.get("homepageUrl") or "")
                    items=[x for x in scraper(browser) if keep(x)]
                    if dry:
                        results.append({"source":sid,"status":"connected","count":len(items),"dryRun":True})
                        print(f"DRY RUN {sid}: {len(items)} kayıt")
                        continue
                    result=report(sid,items); results.append({"source":sid,**result})
                    print(f"OK {sid}: {result.get('imported',0)}")
                except Exception as e:
                    msg=f"{type(e).__name__}: {e}"[:450]
                    if sid=="iskur" and "oturumsuz" in msg.lower():
                        results.append({"source":sid,"status":"pending","skipped":True,"message":msg})
                        print("SKIP",sid,msg,file=sys.stderr)
                        continue
                    print("ERROR",sid,msg,file=sys.stderr)
                    try:
                        failed_report=report(sid,error=msg) if not dry else {"status":"failed"}
                        results.append({"source":sid,**failed_report,"error":msg})
                    except Exception as ie: results.append({"source":sid,"status":"failed","error":msg,"ingestError":str(ie)})
        finally: browser.close()
    print(json.dumps(results,ensure_ascii=False))
    if not results:
        print("NO-OP: Hiçbir kaynak bu çalıştırmada kontrol gerektirmiyor; tüm kaynaklar kontrol aralığı veya backoff nedeniyle atlandı.")
        return
    failed=[x for x in results if x.get("status")=="failed"]
    checked=[x for x in results if not x.get("skipped")]
    if checked and len(failed)==len(checked):
        print("ERROR: Kontrol edilen tüm kaynaklar başarısız oldu.",file=sys.stderr)
        sys.exit(1)
if __name__=="__main__": main()

import json, os, re, sys, time, io
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse
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
RE=re.compile(r"personel\s+al[ıi]m|memur\s+al[ıi]m|sözleşmeli\s+personel|işçi\s+al[ıi]m|öğretim\s+(?:üyesi|elemanı|görevlisi)\s+al[ıi]m|uzman\s+yardımcısı|müfettiş\s+yardımcısı|zabıta\s+memuru|itfaiye\s+eri",re.I)
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
def date(v):
    v=tx(v)
    iso=re.match(r"^(\d{4}-\d{2}-\d{2})",v)
    if iso: return iso.group(1)
    m=re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})",v)
    if m:
        d,mo,y=m.groups(); return f"{y}-{int(mo):02d}-{int(d):02d}"
    return None
def item(sid,eid,title,inst,url,summary="",**kw):
    return {"externalId":str(eid),"title":tx(title)[:500],"institution":tx(inst)[:500] or sid,
      "summary":tx(summary)[:4000],"category":kw.get("category","Kamu ilanı"),"city":kw.get("city"),
      "education":kw.get("education"),"scoreType":kw.get("scoreType"),"minimumScore":kw.get("minimumScore"),
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
    out=[]; today=datetime.now(timezone.utc).date().isoformat()
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
        body={"krM_ID":0,"searchText":"","il":"0","ilanTuru":"0"}
        last_error=None
        for endpoint in ("https://api.kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage","https://kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage"):
            for attempt in range(3):
                try:
                    resp=p.request.post(endpoint,data=body,
                      headers={"Referer":"https://kariyerkapisi.gov.tr/","Origin":"https://kariyerkapisi.gov.tr","Accept":"application/json, text/plain, */*"},
                      timeout=25000)
                    if not resp.ok: raise RuntimeError(f"Kariyer API HTTP {resp.status}")
                    payload=resp.json()
                    if isinstance(payload,dict) and isinstance(payload.get("searchIlan"),list):
                        return kariyer_rows(payload)
                    raise RuntimeError("Kariyer API searchIlan listesi döndürmedi.")
                except Exception as exc:
                    last_error=exc
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
            status="open" if end_date and end_date>=datetime.now(timezone.utc).date().isoformat() else "check_required"))
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
                print(f"Resmî Gazete OK {d}: {len(found)} ilan adayı ({'PDF' if is_pdf else 'HTML'})",file=sys.stderr)
                return found[:150]
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
        p.goto("https://esube.iskur.gov.tr/Istihdam/AcikIsIlanAra.aspx",wait_until="domcontentloaded",timeout=25000); p.wait_for_timeout(1200)
        sels=p.locator("select"); chosen=False
        for i in range(sels.count()):
            sel=sels.nth(i); opts=sel.locator("option")
            for j in range(opts.count()):
                opt=opts.nth(j)
                if tx(opt.inner_text()).lower()=="kamu":
                    sel.select_option(opt.get_attribute("value")); chosen=True; break
            if chosen: break
        if not chosen: raise RuntimeError("Oturumsuz İŞKUR sayfasında Kamu filtresi yok; kaynak atlandı.")
        buttons=p.locator("input[type=submit],button")
        for i in range(buttons.count()):
            b=buttons.nth(i); label=(b.get_attribute("value") or b.inner_text()).lower()
            if "ara" in label or "listele" in label:
                b.click(); p.wait_for_load_state("domcontentloaded",timeout=10000); break
        soup=BeautifulSoup(p.content(),"html.parser"); out=[]
        for row in soup.select("tr"):
            a=row.find("a",href=True); title=tx(a) if a else ""
            if not a or len(title)<5: continue
            href=urljoin("https://esube.iskur.gov.tr/",a["href"])
            if "ilan" not in href.lower() and "acikis" not in href.lower(): continue
            out.append(item("iskur",href,title,"İŞKUR aracılığıyla kamu işçi alımı",href,tx(row),category="İşçi"))
        if not out: raise RuntimeError("Kamu filtresinde oturumsuz okunabilir ilan listesi yok.")
        return out[:100]
    finally: p.close()

def scrape_sbb(browser):
    p=browser.new_page()
    try:
        response=p.goto("https://kamuilan.sbb.gov.tr/",wait_until="domcontentloaded",timeout=25000)
        if response and response.status>=400: raise RuntimeError(f"SBB portal HTTP {response.status}")
        p.wait_for_timeout(1500)
        page_text=tx(p.locator("body").inner_text())
        if re.search(r"access denied|forbidden|captcha|robot doğrulama",page_text,re.I):
            raise RuntimeError("SBB portalı tarayıcı isteğini engelledi.")
        return sbb_html(p.content())
    finally: p.close()

SCRAPERS={"kariyer-kapisi":scrape_kariyer,"resmi-gazete":lambda b:scrape_resmi(),"osym":lambda b:scrape_osym(),"ilan-gov":scrape_ilan,"kamuilan-sbb":scrape_sbb,"iskur":scrape_iskur}
SOURCE_INTERVAL_MINUTES={"kariyer-kapisi":30,"resmi-gazete":360,"osym":120,"ilan-gov":90,"kamuilan-sbb":180,"iskur":240}
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

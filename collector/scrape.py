import json, os, re, sys, time
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

API=os.environ["MEMURPRO_API_BASE"].rstrip("/")
TOKEN=os.environ.get("MEMURPRO_INGEST_TOKEN","")
S=requests.Session()
S.headers.update({"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36","Accept-Language":"tr-TR,tr;q=0.9"})
RE=re.compile(r"personel\s+al[ıi]m|memur\s+al[ıi]m|sözleşmeli\s+personel|işçi\s+al[ıi]m|öğretim\s+(?:üyesi|elemanı|görevlisi)\s+al[ıi]m|uzman\s+yardımcısı|müfettiş\s+yardımcısı|zabıta\s+memuru|itfaiye\s+eri",re.I)
BAD=re.compile(r"\b(sonuç|yerleştirilen|kazanan|iptal|düzeltme|duyuru sonucu)\b",re.I)

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
    p=browser.new_page(); captured=[]
    def on_response(resp):
        if "GetIseAlimPage" in resp.url:
            try:
                data=resp.json()
                if isinstance(data,dict) and isinstance(data.get("searchIlan"),list): captured.append(data)
            except Exception: pass
    p.on("response",on_response)
    try:
        p.goto("https://kariyerkapisi.gov.tr/isealim",wait_until="domcontentloaded",timeout=25000); p.wait_for_timeout(3500)
        if captured: return kariyer_rows(max(captured,key=lambda x:len(x.get("searchIlan",[]))))
        resp=p.request.post("https://api.kariyerkapisi.gov.tr/api/ilan/GetIseAlimPage",
          data={"krM_ID":0,"searchText":"","il":"0","ilanTuru":"0"},
          headers={"Referer":"https://kariyerkapisi.gov.tr/isealim","Origin":"https://kariyerkapisi.gov.tr"},timeout=12000)
        if not resp.ok: raise RuntimeError(f"Kariyer API HTTP {resp.status}")
        return kariyer_rows(resp.json())
    finally: p.close()

def scrape_resmi():
    now=datetime.now(timezone.utc)+timedelta(hours=3); out=[]
    for off in range(3):
        d=now.date()-timedelta(days=off); key=d.strftime("%Y%m%d"); index=f"https://www.resmigazete.gov.tr/fihrist?tarih={d.isoformat()}"
        try:
            r=S.get(index,timeout=12); r.raise_for_status(); soup=BeautifulSoup(decode(r),"html.parser")
            a=next((a for a in soup.find_all("a",href=True) if re.search(r"çeşitli\s+il[âa]nlar",tx(a),re.I)),None)
            if a:
                u=urljoin(index,a["href"]); page=S.get(u,timeout=12); page.raise_for_status(); html=decode(page); ps=BeautifulSoup(html,"html.parser")
            else:
                u=f"https://www.resmigazete.gov.tr/ilanlar/eskiilanlar/{d.year}/{d.month:02d}/{key}-4.htm"
                page=S.get(u,timeout=12)
                if not page.ok: continue
                html=decode(page); ps=BeautifulSoup(html,"html.parser")
            for a in ps.find_all("a",href=True):
                title=tx(a); href=urljoin(u,a["href"])
                if urlparse(href).hostname not in ("www.resmigazete.gov.tr","resmigazete.gov.tr"): continue
                context=tx(a.parent.parent if a.parent and a.parent.parent else a.parent)
                if not RE.search(title+" "+context) or BAD.search(title): continue
                inst="Resmî Gazete"
                m=re.search(r"([A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜçğıöşü0-9 .,'’()-]{3,130}?(?:Bakanlığı|Genel Müdürlüğü|Başkanlığı|Üniversitesi|Belediyesi))",context)
                if m: inst=m.group(1)
                out.append(item("resmi-gazete",href,title or context[:250],inst,href,"Resmî Gazete Çeşitli İlânlar bölümü; başvuru şartları resmî belgeyle doğrulanmalı.",category="Memur",publishedAt=f"{d.year}-{d.month:02d}-{d.day:02d}"))
            if out: break
        except Exception as e: print(f"Resmî Gazete {d}: {e}",file=sys.stderr)
    return out[:100]

def scrape_osym():
    u="https://www.osym.gov.tr/SinavGrubu/Index/3"; r=S.get(u,timeout=15); r.raise_for_status()
    soup=BeautifulSoup(decode(r),"html.parser"); out=[]; seen=set()
    for a in soup.find_all("a",href=True):
        title=tx(a); href=urljoin(u,a["href"])
        if "kpss" not in title.lower() or len(title)<12 or "osym.gov.tr" not in (urlparse(href).hostname or "") or href in seen or "/SinavGrubu/Index/3" in href: continue
        seen.add(href); out.append(item("osym",href,title,"ÖSYM",href,"ÖSYM KPSS duyurusu; resmî duyuruyu inceleyin.",category="KPSS"))
    return out[:100]

def scrape_ilan():
    endpoint="https://www.ilan.gov.tr/api/api/services/app/Ad/AdsByFilter"; out=[]; seen=set()
    for skip in (0,20,40):
        r=S.post(endpoint,json={"keys":{"txv":[8],"ats":[5],"order":["desc"],"field":["publish_time"]},"sorting":"publish_time desc","skipCount":skip,"maxResultCount":20},
          headers={"Content-Type":"application/json-patch+json","Origin":"https://www.ilan.gov.tr","Referer":"https://www.ilan.gov.tr/ilan/kategori/8/kamu-akademik-personel?ats=5","X-Request-Origin":"IGT-UI","X-Requested-With":"XMLHttpRequest"},timeout=15)
        r.raise_for_status(); ads=r.json().get("result",{}).get("ads")
        if not isinstance(ads,list): raise RuntimeError("result.ads listesi bulunamadı")
        for x in ads:
            aid=x.get("id") or x.get("idInt") or x.get("adNo"); title=x.get("title")
            if not aid or not title or str(aid) in seen: continue
            seen.add(str(aid)); u=urljoin("https://www.ilan.gov.tr/",x.get("urlStr") or f"ilan/{aid}")
            summary=" · ".join(f"{v.get('key')}: {v.get('value')}" for v in (x.get("adTypeFilters") or []) if v.get("key") and v.get("value"))
            out.append(item("ilan-gov","ilan-gov-"+str(aid),title,x.get("advertiserName") or "Kamu / akademik kurum",u,summary,category="Akademik Personel",city=x.get("addressCityName"),publishedAt=x.get("publishStartDate")))
        if len(ads)<20: break
        time.sleep(.3)
    return out

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
        p.goto("https://kamuilan.sbb.gov.tr/",wait_until="domcontentloaded",timeout=25000); p.wait_for_timeout(1500)
        return sbb_html(p.content())
    finally: p.close()

SCRAPERS={"kariyer-kapisi":scrape_kariyer,"resmi-gazete":lambda b:scrape_resmi(),"osym":lambda b:scrape_osym(),"ilan-gov":lambda b:scrape_ilan(),"kamuilan-sbb":scrape_sbb,"iskur":scrape_iskur}
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
                        if datetime.fromisoformat(backoff.replace("Z","+00:00"))>now: print("BACKOFF",sid); continue
                    except ValueError: pass
                try:
                    items=[x for x in scraper(browser) if keep(x)]
                    if dry:
                        results.append({"source":sid,"count":len(items),"dryRun":True})
                        print(f"DRY RUN {sid}: {len(items)} kayıt")
                        continue
                    result=report(sid,items); results.append({"source":sid,**result})
                    print(f"OK {sid}: {result.get('imported',0)}")
                except Exception as e:
                    msg=f"{type(e).__name__}: {e}"[:450]; print("ERROR",sid,msg,file=sys.stderr)
                    try: results.append({"source":sid,**report(sid,error=msg)})
                    except Exception as ie: results.append({"source":sid,"error":msg,"ingestError":str(ie)})
        finally: browser.close()
    print(json.dumps(results,ensure_ascii=False))
    if not results or all(x.get("status")=="failed" for x in results): sys.exit(1)
if __name__=="__main__": main()

# MemurPro

**MemurPro**, Türkiye'deki kamu personel alımlarını, KPSS duyurularını ve başvuru tarihlerini tek ekranda takip etmek için hazırlanan mobil uyumlu bir web uygulamasıdır.

## Bu sürümde neler var?

- Genel Bakış ekranı ve resmî kaynak listesi
- Kamu ilanları için arama ve filtre arayüzü
- Takip listesi (tarayıcının `localStorage` alanında saklanır)
- Araçlar sekmesi: yaş hesaplama, KPSS asgari puan karşılaştırma, son başvuru sayacı ve aday tercihleri
- Mobil uyumlu tasarım ve PWA temel dosyaları
- Cloudflare Worker API başlangıç kodu ve D1 şeması

## Önemli: canlı ilan durumu

Bu sürümde Cloudflare Worker ve D1 veritabanı kuruldu. ÖSYM duyuruları, Kariyer Kapısı'nın JSON ilan listesi, İlan.gov.tr'nin Kamu-Akademik Personel API'si, SBB portalının liste sayfası ve Resmî Gazete RSS'i için kaynak adaptörleri eklendi. Kariyer Kapısı, SBB ve İlan.gov.tr kaynakları erişim kısıtları uygulayabilir. Worker gerçek istek başarılı olursa kaynağı bağlı, başarısız olursa hata olarak işaretler. SBB'nin ilan detay/PDF bağlantıları oturuma bağlı olabildiği için MemurPro doğrudan kırılabilecek oturum URL'si yerine portal ana sayfasına yönlendirir. İŞKUR için henüz resmî, kimlik doğrulaması gerektirmeyen bir kamu ilanı API uç noktası doğrulanmadı. e-Devlet üzerinden erişilebilen iş arama hizmeti, kullanıcı oturumu gerektirdiği için MemurPro tarafından otomatik oturum açma yoluyla kullanılmaz.

Resmî kaynak dizini (Resmî Gazete RSS bağlayıcısı `https://www.resmigazete.gov.tr/rss/rss.xml` adresini kullanacak şekilde yapılandırılmıştır; gerçek erişim ilk senkronizasyonda doğrulanır):
- Kariyer Kapısı: <https://kariyerkapisi.gov.tr/>
- ÖSYM KPSS: <https://www.osym.gov.tr/SinavGrubu/Index/3>
- İŞKUR: <https://www.iskur.gov.tr/>
- İlan.gov.tr: <https://www.ilan.gov.tr/>
- Resmî Gazete: <https://www.resmigazete.gov.tr/>
- Kamu İlanları (SBB): <https://kamuilan.sbb.gov.tr/>

Her kaynak için ayrı veri bağlayıcısı doğrulanmalı. Bir sayfanın ana adresi RSS/API gibi kullanılmamalı ve korumalı sayfalardan izinsiz veri çekilmemelidir. Başvuru durumu yalnızca tarih alanına bakılarak kesinleştirilmemeli; kurum duyurusu ve başvuru sistemi esas alınmalıdır.

## GitHub Pages ile yayımlama

Bu depo `PataraKutere/MemurPro` adıyla oluşturulmuştur. Dosyalar kök dizindedir.

1. Depoda **Settings → Pages** bölümünü aç.
2. **Build and deployment** altında **Deploy from a branch** seç.
3. Branch olarak `main`, klasör olarak `/ (root)` seçip **Save** düğmesine bas.
4. Birkaç dakika sonra site şu adreste açılır: <https://patarakutere.github.io/MemurPro/>

## Cloudflare Worker API

`worker/schema.sql` D1 veritabanı tablolarını ve resmî kaynak kayıtlarını oluşturur. `worker/index.js` şu uç noktaları sağlar:

- `GET /api/health`
- `GET /api/sources`
- `GET /api/listings`
- `POST /api/sync-now` (public, synchronous response; source-specific polling limits and atomic claim are enforced)

In the site, **Şimdi kontrol et** runs the source check without requiring a user to open Cloudflare. The request stays open until the Worker finishes and returns per-source results. The periodic Cron runs every 30 minutes, but individual source adapters apply their own lower polling frequency.
- `POST /api/admin/sync` (yalnızca `x-admin-token` gizli başlığıyla)

### Backend kurulum özeti

1. Cloudflare Dashboard → **Workers & Pages** bölümünde `memurpro-api` isimli bir Worker oluştur ve `worker/index.js` içeriğini Worker kodu olarak ekle.
2. Cloudflare D1 bölümünde `memurpro-db` isimli bir veritabanı oluştur.
3. D1 Console'da `worker/schema.sql` dosyasının tamamını çalıştır.
4. Worker Settings → Bindings bölümünde D1 veritabanını `DB` adıyla bağla.
5. Worker Settings → Variables and Secrets bölümünde `ADMIN_TOKEN` isminde rastgele ve güçlü bir secret oluştur. Bu değeri kaynak koda yazma.
6. Worker için Cron Trigger ekle. MemurPro Worker `*/30 * * * *` takviminde çalışır. Kaynak başına istek aralıkları ayrıca sınırlandırılır: Kariyer Kapısı 30 dakika, ÖSYM/İlan.gov.tr/SBB 1 saat, Resmî Gazete RSS 24 saat. Böylece bütün kaynaklara her 30 dakikada bir gereksiz istek gönderilmez.
7. `config.js` içindeki API adresi hazır kurulumda `https://memurpro-api.28berat28.workers.dev` olarak ayarlanmıştır.

### Kaynak bağlayıcıları

Worker kaynak kimliğine göre özel bağlayıcılar çalıştırır: `kariyer-kapisi` (Kariyer Kapısı JSON API), `osym-kpss` (ÖSYM KPSS duyuru listesi), `ilan-gov` (İlan.gov.tr Kamu-Akademik Personel API), `sbb-portal` (SBB portal liste sayfası) ve `feed` (RSS/JSON; Resmî Gazete RSS). `iskur` kaynağı için giriş gerektirmeyen resmî kamu ilanı API'si doğrulanana kadar otomatik veri çekilmez. RSS/JSON bağlayıcılarında `feed_url` ve `feed_type` alanları kullanılır.

JSON akışı aşağıdaki normalize edilmiş alanları içermelidir:

```json
{
  "items": [
    {
      "id": "source-item-id",
      "title": "İlan başlığı",
      "institution": "Kurum adı",
      "summary": "Kısa açıklama",
      "category": "Memur",
      "city": "İstanbul",
      "education": "Ön lisans",
      "scoreType": "P93",
      "minimumScore": 70,
      "publishedAt": "2026-11-24T10:00:00+03:00",
      "startDate": "2026-11-25",
      "endDate": "2026-12-05",
      "detailUrl": "https://kurum.gov.tr/ilan",
      "status": "open"
    }
  ]
}
```

`status: open` yalnızca kaynak başvurunun açık olduğunu ve son tarihi gerçekten verdiğinde kullanılmalıdır. RSS'den gelen ve başvuru bitişi bilinmeyen kayıtlar `check_required` olarak saklanır; kesin açık ilan gibi sunulmaz.

## Yerel geliştirme

Statik arayüz için derleme/paket kurulumu gerekmez. `index.html` bir HTTPS statik barındırma hizmetinde açılabilir. PWA/service worker özellikleri `file://` yerine HTTPS veya localhost altında çalışır.

## Açık kaynaklardan teknik ilham

- n8n: <https://github.com/n8n-io/n8n> — zamanlanmış otomasyon fikri
- changedetection.io: <https://github.com/dgtlmoon/changedetection.io> — sayfa değişikliği izleme yaklaşımı
- Uptime Kuma: <https://github.com/louislam/uptime-kuma> — kaynak/API sağlık kontrolü
- Excalidraw: <https://github.com/excalidraw/excalidraw> — etkileşimli arayüz örneği

MemurPro bu projelerin kopyası değildir; yalnızca ilgili teknik yaklaşımlardan yararlanır.

## Gizlilik

Takip listesi ve aday tercihleri varsayılan olarak yalnızca kullanıcının tarayıcısında saklanır. Bu sürümde üyelik veya merkezi kişisel veri deposu yoktur.

## Lisans

Henüz bir lisans dosyası eklenmedi. Yeniden kullanım ve dağıtım koşulları lisans seçildikten sonra netleşir.

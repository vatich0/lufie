# Lufie · İmalat Sipariş Panosu

İmalat personeline **bugün gelen sipariş**, **bugün kargoya verilen sipariş** ve
**gecikmeye giren / acil siparişleri** canlı gösteren tam ekran pano.
Veriler Trendyol ve Shopify API'lerinden sunucu tarafında çekilir (anahtarlar tarayıcıya sızmaz).

## Panoda ne var?
- **Bugün Gelen Sipariş** (Trendyol + Shopify ayrı ayrı ve toplam)
- **Bugün Kargoya Verilen** + "gelenlerin yüzde kaçı kargolandı" hız barı
- **Kuyrukta Bekleyen** (henüz kargolanmamış toplam Trendyol siparişi)
- **Gecikmede / Bugün Terminli** tablosu (Trendyol) — gecikmişler kırmızı, bugün dolacaklar sarı
- **Acil Etiketli** tablosu (Shopify) — "acil" etiketli, henüz kargolanmamış siparişler
- **Sipariş / Ürün adedi şalteri** — üstteki 3 kutu sipariş sayısını ya da içindeki ürün adedini gösterir
- **Gelen vs Kargolanan (son 7 gün)** — gün gün gelen ve kargolanan; her günün altında `net = kargolanan − gelen` (yeşil: gelenden fazla çıktı, kırmızı: kuyruk büyüdü)
- **Açık Kuyruk Trendi (son 7 gün)** — her akşamki açık ürün/sipariş adedinin eğrisi (geçmiş `history.json`'da tutulur, her gün bir nokta eklenir)
- **Renk / Numara Kırılımı** (`/renkler`) — seçilen tarih aralığında gelen ürünleri **renge göre** konsolide eder (Trendyol + Shopify birlikte); renge tıklayınca **numara** kırılımı açılır. Eşleştirme SKU'daki renk koduyla yapılır (isim farkları önemsiz); model 03 = Rugan, 01 = mat ayrı sayılır. Ana sayfadaki linkten erişilir.

---

## 1) Anahtarları edinme

### Trendyol
Satıcı Paneli → **Hesap Bilgilerim → Entegrasyon Bilgileri** sayfasından:
- **Satıcı ID (Seller/Supplier ID)** → `TRENDYOL_SELLER_ID`
- **API Key** → `TRENDYOL_API_KEY`
- **API Secret** → `TRENDYOL_API_SECRET`

### Shopify (read_orders izinli Custom App)
1. Shopify admin → **Settings** (Ayarlar) → **Apps and sales channels**
2. **Develop apps** → (gerekiyorsa özelliği etkinleştir) → **Create an app**
3. İsim ver (örn. `Imalat Panosu`) → **Create app**
4. **Configuration → Admin API integration → Configure** →
   **Admin API access scopes** içinden şunları işaretle:
   - `read_orders`
   - `read_fulfillments`
   - (siparişler 60 günden eskiyse `read_all_orders` da gerekebilir)
5. **Save** → sonra **API credentials** sekmesi → **Install app**
6. Kurulumdan sonra çıkan **Admin API access token** (`shpat_...` ile başlar) →
   `SHOPIFY_ACCESS_TOKEN`. ⚠️ Bu token sadece bir kez gösterilir, kopyala.
7. Mağaza alan adı → `SHOPIFY_SHOP`. **Custom domain değil**, kalıcı `.myshopify.com`
   adını kullan (örn. `xst1gd-b8.myshopify.com`).

### Alternatif: Dev dashboard uygulaması (client credentials)
Mağazada "Develop apps" kapalıysa ve uygulamayı **dev dashboard**'da oluşturuyorsan,
statik token yerine **client credentials** verilir (24 saatlik token, kod otomatik yeniler):
- `SHOPIFY_ACCESS_TOKEN`'ı boş bırak,
- `SHOPIFY_CLIENT_ID` ve `SHOPIFY_CLIENT_SECRET`'ı doldur.
- Uygulama scope'larında `read_orders` + `read_fulfillments` işaretli **ve onaylı** olmalı
  (`read_orders` korumalı veri kapsamındadır; merchant onayı ister).

---

## 2) Yerelde çalıştırma
```bash
npm install
cp .env.example .env      # .env dosyasını anahtarlarınla doldur
npm run local             # http://localhost:3000
```
(Node 20+ gerekir; `.env` yerleşik olarak okunur.)

---

## 3) İnternette yayınlama (Railway — en kolayı)

Proje deploy'a hazır: repoda `Dockerfile`, `Procfile`, `railway.json` ve `render.yaml` var.
Git deposu da hazır (`git init` + ilk commit yapılmış); tek yapman gereken bir GitHub
deposuna **push** edip bir servise bağlamak.

1. **GitHub'a yükle:** GitHub'da boş bir repo aç, sonra bu klasörde:
   ```bash
   git remote add origin https://github.com/<kullanıcı>/<repo>.git
   git push -u origin main
   ```
   (`.env`, `history.json`, `node_modules` `.gitignore`'da — yüklenmez.)
2. [railway.app](https://railway.app) → GitHub ile giriş → **New Project → Deploy from GitHub repo** → bu depoyu seç. (Railway `railway.json`'ı okur.)
3. Railway otomatik build + `npm start` yapar.
4. Proje → **Variables** sekmesine şu değişkenleri **tek tek** ekle:
   `TRENDYOL_SELLER_ID`, `TRENDYOL_API_KEY`, `TRENDYOL_API_SECRET`,
   `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
   **`SITE_PASSWORD`** (giriş şifresi; boş bırakılırsa `lufie`),
   `SHOPIFY_URGENT_TAG`, `DELAY_OFFSET_DAYS`, `REFRESH_SECONDS`.
   `PORT`'u Railway kendi verir, eklemene gerek yok.
   > Not: Statik `shpat_` token kullanıyorsan `SHOPIFY_CLIENT_ID/SECRET` yerine
   > `SHOPIFY_ACCESS_TOKEN` gir.
5. **Settings → Networking → Generate Domain** ile herkese açık bir adres al.
   Bu adresi imalattaki TV/tablet tarayıcısında tam ekran aç; ilk açılışta şifre sorulur.
6. **Alt grafiklerin geçmişi için kalıcı disk (önemli):** Railway'in dosya sistemi
   her deploy'da sıfırlanır. Grafik geçmişinin kaybolmaması için proje →
   **Variables → Volumes** (veya **Settings → Volumes**) altından bir **Volume**
   ekle (ör. mount path `/data`) ve `HISTORY_FILE=/data/history.json` değişkenini gir.

> Alternatif: **Render.com** — repo `render.yaml` içerdiğinden **New → Blueprint** ile
> tek tıkla kurulur; değişkenleri panelde doldur. (Free planda kalıcı disk yok; grafik
> geçmişi için ücretli disk veya HISTORY_FILE'ı bir volume'a yönlendir.)
> Docker destekleyen her platform da `Dockerfile` ile çalışır.

---

## Ayarlar (ortam değişkenleri)
| Değişken | Açıklama | Varsayılan |
|---|---|---|
| `SITE_PASSWORD` | Açılışta sorulan giriş şifresi | `lufie` |
| `DELAY_OFFSET_DAYS` | Termini kaç gün içinde dolacaklar da "gecikecek" sayılsın (0 = bugün+geçmiş) | `0` |
| `REFRESH_SECONDS` | Pano yenileme aralığı | `60` |
| `SHOPIFY_URGENT_TAG` | Acil sayılacak etiket | `acil` |
| `HISTORY_FILE` | Günlük geçmiş dosyası (kalıcı disk için `/data/history.json`) | `history.json` |

## Notlar / varsayımlar
- **"Bugün"** Türkiye saatine (Europe/Istanbul, +03:00) göre hesaplanır.
- **Gecikme** ölçütü Trendyol'un `agreedDeliveryDate` (termin) alanıdır; henüz
  kargolanmamış (Created/Picking/Invoiced) ve termini geçmiş/bugün dolan siparişler listelenir.
- **Bugün kargolanan**, durumu `Shipped` olup bugün güncellenen paketlerden sayılır
  (Trendyol'da birebir "kargolama saati" filtresi olmadığı için yaklaşık ölçüttür).

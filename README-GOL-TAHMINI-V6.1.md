# Gol Tahmini V6.1 – dört mantık düzeltmesi

Bu sürüm, V6 paketindeki dört tespiti düzeltir. Railway'deki mevcut Node/Express projesinin üzerine uygulanır.

## Paketteki dosyalar

- `server.js`
- `goal-model.mjs`
- `rules.mjs`
- `package.json`
- `public/index.html`
- `test-fixes.mjs` – regresyon testleri

## Yapılan düzeltmeler

### 1. Sonraki gol tarafı için canlı veri ve fark eşiği
- Maç önü favoriliği tek başına sonraki gol tarafını belirleyemez.
- Her iki takım için de son 10 dakika penceresinde en az iki ayrı canlı hücum metriği bulunmalıdır.
- Canlı veri penceresi hazır değilse veya iki taraf için kanıt yeterli değilse sonuç `Belirsiz` olur.
- İki takımın karşılaştırmalı ham hücum puanları arasındaki fark en az 6 değilse taraf seçilmez.
- Dashboard ve Telegram gerekçe, kanıt sayısı ve farkı gösterir. Bu puanlar olasılık/yüzde değildir.

### 2. Oyuncu değişikliği anındaki skor
- Olaylar dakika sırasına göre işlenir.
- Her oyuncu değişikliği için o ana kadar gerçekleşmiş goller kullanılarak `scoreAt` saklanır.
- 60+ dakikada gerideyken yapılan değişiklik, yalnızca değişiklik anındaki skor gerçekten gerideyse sayılır.
- Takım değişiklik anında öndeyken daha sonra geriye düşerse eski değişiklik gerideyken yapılmış gibi sınıflandırılmaz.
- Golü atan takımın beraberlik veya üstünlük durumundayken yaptığı sonraki değişiklikler de değişiklik anındaki skorla değerlendirilir.

### 3. Favori belirleme eşiği
- 1-X-2 oranlarından önce ham ima edilen olasılıklar hesaplanır, sonra overround (marj) normalize edilerek temizlenir.
- Ev sahibi ve deplasman adil kazanma olasılıkları arasındaki fark en az 3 yüzde puanı değilse maç dengeli kabul edilir ve favori atanmaz.
- Bu nedenle 2.50 ve 2.52 gibi birbirine çok yakın oranlar favori üretmez.

### 4. Son 15 dakika gol yeme profili
- Sezonun 76–90 dakika gol yeme toplamı artık doğrudan eşik olarak kullanılmaz.
- Önce oynanan maç sayısına bölünerek maç başına 76–90 gol yeme oranı hesaplanır.
- API'nin yüzde alanı mevcutsa ayrıca sezon içindeki yenilen gollerin 76–90 aralığına düşen payı saklanır.
- Dashboard ve Telegram bunun sezon profili olduğunu açıkça belirtir; canlı son 15 dakika istatistiği gibi sunulmaz.

## Kurulum

1. Proje klasörünün yedeğini alın.
2. ZIP içeriğini proje ana klasörüne çıkarın. `public/index.html`, `public/` içinde kalmalıdır.
3. `server.js`, `goal-model.mjs`, `rules.mjs`, `package.json` ve `public/index.html` dosyalarını güncelleyin.
4. Terminal'de çalıştırın:

```bash
node --check server.js
node --check goal-model.mjs
node --check rules.mjs
node test-fixes.mjs
```

5. `public/index.html` gömülü script kontrolleri de paket hazırlanırken çalıştırılmıştır.
6. GitHub'a commit/push yapın ve Railway deploy'un başarılı olmasını bekleyin.
7. Railway Volume ve `DATA_DIR=/data` ayarlarını koruyun.

## Test edilen regresyonlar

- Canlı istatistik yokken sonraki gol tarafının `Belirsiz` kalması.
- 2.50 / 2.52 gibi yakın oranlarda favori belirlenmemesi.
- Yeterli ve belirgin canlı veri farkı olduğunda taraf seçilmesi.
- Değişiklik anında önde olan takımın, maçın ilerleyen bölümünde geriye düşmesi halinde eski değişikliğin yanlışlıkla `gerideyken değişiklik` sayılmaması.
- V6 eğitim vektörünün 32 özellikli şemasının korunması.

## Sınırlar

- 3 yüzde puanı favori eşiği ve 6 puan sonraki-gol tarafı farkı başlangıç eşikleridir; geçmiş maçlarda bağımsız testle ayarlanmalıdır.
- Sonraki gol tarafı bir karşılaştırmalı sinyaldir, kalibre edilmiş olasılık değildir.
- Sezon 76–90 verisi takımın geçmiş profilidir; canlı maçın son 15 dakikadaki baskısından ayrı tutulur.
- Oyuncu değişikliği amacı doğrudan bilinemez; değişiklik anındaki skor ve sonraki saha davranışından çıkarım yapılır.
- Sözdizimi ve regresyon testleri başarılıdır. Gerçek API-Football, bookmaker ve Telegram bağlantısı Railway deploy sonrası ayrıca doğrulanmalıdır.


## V6.1.1 – Son 10 dakika alarm sınırı

- Gol alarmı ve kullanıcı tanımlı gol kuralları yalnızca canlı maçın 0–81. dakikalarında bildirim gönderebilir.
- 82. dakika ve sonrası, 90+ uzatmalar dahil, yeni gol bildirimi üretmez.
- 81. dakikada gönderilmiş bir alarmın tekrarları da 82. dakikadan itibaren engellenir.
- Devre arası ve tamamlanmış maçlarda bildirim gönderilmez.
- Bu sınır API-Football maç durumu ve geçen dakika alanlarına göre uygulanır.

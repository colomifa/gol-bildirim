# GPT V6.1.1 – 7 Günlük Başlangıç Ölçümü

## Amaç
Bu sürüm, çalışan V6.1.1 davranışını koruyarak 7 gün boyunca başlangıç performans verisi toplar. Bu dönemde otomatik model yeniden eğitimi kapalıdır. Önceden kayıtlı model ağırlıkları varsa tahminlerde kullanılmaya devam eder; mevcut ağırlıklar değiştirilmez.

## Neler kaydedilir?
- Her uygun canlı maç örnekleme penceresinin 32 özellikli veri vektörü
- Sinyal oluşup oluşmadığı ve alarm üretmeye uygun olup olmadığı
- O örnekte alarm gönderilmesinin beklenip beklenmediği
- Örnek anındaki dakika ve skor, model puanı, canlı baskı ve veri kapsamı
- Sonraki 5/10 dakikalık pencerede gol olup olmadığı
- Maç bittikten sonra henüz etiketlenmemiş örneklerin maç olaylarından tamamlanması

Alarm üretmeyen pencereler de kaydedilir. Böylece "alarm yokken gol oldu" örnekleri de değerlendirmeye girer. Ölçüm yalnızca yeterli canlı veri bulunan ve örnekleme koşullarını sağlayan pencereleri kapsar; veri kapsamı yetersiz maçlar örnek olarak sayılmaz.

## 7 günlük süre
İlk açılışta `goal-model.json` içine `baselineStartedAt` yazılır. Tarih Railway Volume üzerinde korunur; uygulama yeniden başlasa veya yeniden deploy edilse de süre baştan başlamaz. Yedi gün sonunda ölçüm tamamlanır. Otomatik eğitim kendiliğinden açılmaz; sonuçlar incelendikten sonra ayrıca karar verilir.

## Ana ekran ve ayrıntılar
Dashboard ana ekranına 7 günlük ölçüm kartları eklendi. Dört karta dokunarak ilgili örneklerin maç listesini açabilirsiniz:
- Doğru alarm: alarm kararı verilen ve hedef pencerede gol olan örnekler
- Yanlış alarm: alarm kararı verilen ancak hedef pencerede gol olmayan örnekler
- Kaçırılan gol: alarm kararı verilmeyen ancak hedef pencerede gol olan örnekler
- Doğru pas geçme: alarm kararı verilmeyen ve hedef pencerede gol olmayan örnekler

Her satırda takım isimleri, lig, örnek zamanı, hedef dakika, örnek anındaki skor, canlı baskı ve veri kapsamı gösterilir. Liste en fazla 500 örnek döndürür.

## Rapor
Kimlik doğrulamalı API:

`GET /api/learning-baseline`

Kategori ayrıntısı:

`GET /api/learning-baseline/items?type=correct`

`type` değerleri: `correct`, `false_alarm`, `missed`, `correct_reject`.

Önemli alanlar:
- `startedAt`, `endsAt`, `complete`, `remainingMs`
- `sampleCount`, `labelledCount`, `pendingCount`
- `alarmWindows`, `alarmThenGoal`, `alarmNoGoal`
- `noAlarmWindows`, `missedGoalWindows`, `noAlarmNoGoal`

Sayılar 5/10 dakikalık örnekleme pencerelerine aittir; aynı maçta birden fazla pencere olabilir. Bunlar maç bazında tekil alarm sayısı değildir ve tek başına model başarısını kanıtlamaz.

## Railway yükleme
1. Mevcut V6.1.1 projesini ve Railway Volume verilerini yedekleyin.
2. Bu paketteki kaynak dosyaları mevcut proje dosyalarıyla değiştirin.
3. Railway'deki mevcut `DATA_DIR=/data` ve Volume mount ayarını aynen koruyun.
4. `BASELINE_MODE` değişkeni tanımlanmasa da varsayılan olarak `true` çalışır. Yedi günlük ölçüm boyunca `false` yapmayın.
5. Deploy sonrasında `/api/learning-baseline` raporunu kimlik doğrulamalı uygulama isteğiyle kontrol edin.

## Korunan davranış
- Mevcut bildirim kuralları ve Telegram gönderimi değiştirilmez.
- 81. dakika bildirim sınırı korunur.
- Mevcut `goal-model.json`, `goal-profiles.json`, `rules.json`, `fired.json` ve bildirim geçmişi silinmez.
- Bu paket deploy edilmez; Railway'e yükleme kullanıcı tarafından yapılmalıdır.

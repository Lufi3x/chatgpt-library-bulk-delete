# Bulk Delete for ChatGPT Library

ChatGPT Kitaplık görsellerini istediğin adette, tek tıkla Çöp Kutusu'na taşır: "en eski 500 görsel" ya da "şu tarihten eski hepsi" gibi.

*Move your ChatGPT library images to Trash in bulk: all of them, the oldest N, or everything before a date. The panel is available in Turkish and English.*

<p align="center"><img src="docs/panel.png" alt="Eklentinin paneli: görselleri tara, tarih seç, çöpe taşı" width="332"></p>

> OpenAI ile bağlantısı yoktur, resmi değildir. ChatGPT'nin belgelenmemiş iç API'sini kullanır, OpenAI değiştirirse çalışmayı bırakabilir. Kullanım sorumluluğu sana aittir.

## ChatGPT'de zaten toplu silme yok mu?

Var, ama sınırlı. ChatGPT'de görselleri tek tek veya Shift ile aralık seçerek işaretleyebilirsin. **Tümü** sekmesinin liste görünümünde başlığın üstüne gelince çıkan bir **Tümünü seç** kutusu da var, ama sadece o an yüklenmiş satırları seçiyor (önce 20, kaydırdıkça artıyor) ve görsel dışındaki dosyaları da listeliyor.

Birkaç görsel silmek için ChatGPT'nin kendisi yeterli. Bu eklenti binlerce görsel içindir:

- Kaydırmadan tüm görselleri tarar.
- Kaç görsel silineceğini yazabilirsin, en eskilerden başlar.
- Tarihe göre silebilirsin.
- Sadece görsellere dokunur.

## Kurulum

1. Bu repoyu indir (**Code → Download ZIP**) ve klasöre çıkar.
2. Chrome'da `chrome://extensions` adresini aç, sağ üstten **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle** deyip klasörü seç.

## Kullanım

1. `chatgpt.com/library` sayfasını aç (eklentiyi kurmadan önce açıksa yenile), sağ alttaki **Toplu sil** düğmesine bas.
2. **Görselleri tara**.
3. **Tümü**'nü ya da **Belirli adet**'i seç. Örneğin 500 yazarsan en eski 500 görsel silinir.
4. İstersen tarih de seç, sadece ondan eski görseller hesaba katılır.
5. Kırmızı düğmeye iki kez bas (ikincisi onay).

Dili panelin üstünden değiştirebilirsin (Türkçe, English).

## Silinince ne olur

- Görseller ChatGPT'nin kendi arayüzündeki **Sil** gibi Çöp Kutusu'na gider ve 30 gün sonra kalıcı olarak silinir. Bu süre içinde Çöp Kutusu'ndan geri alabilirsin.
- Proje ve özel GPT dosyalarına, sana ait olmayan dosyalara dokunulmaz.
- **Favoriler korunmaz.** API kayıtlarında favori bilgisi yok, tarih aralığına giren favoriler de silinir.
- Silinen görseller eski sohbetlerde açılmayabilir. Saklamak istediklerini önce indir.

## Gizlilik

Sunucu yok, analitik yok, ek izin yok. Eklenti sadece `chatgpt.com` üzerinde çalışır ve sadece `chatgpt.com`'a istek atar. Oturum anahtarı bellekte tutulur, hiçbir yere kaydedilmez. Kod tek dosya: [`content.js`](content.js).

## Geliştirme

```
node test.js
```

## Lisans

MIT

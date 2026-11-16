// Language support.
//
// The interface is written in Turkish and the Turkish text itself is the key: t('Gönder') returns
// 'Gönder' in Turkish and 'Send' in English. That keeps the HTML and the strings the Rust side
// sends (error messages, node sync phases) readable as they are. A key may hold {name} slots:
// t('Blok {n}', { n: 5 }), and a dictionary key with slots also matches a finished sentence from
// Rust ('Bloklar indiriliyor (3 / 9)' matches 'Bloklar indiriliyor ({a} / {b})').
//
// To add a language: add a dictionary below (Turkish text -> translation), list it in LANGS, and
// add its name to the language select in index.html. A missing entry falls back to Turkish and is
// recorded in I18N.missed, so gaps are easy to find (open the app with ?debug-i18n and read it).
'use strict';

const LANGS = { tr: 'Türkçe', en: 'English', de: 'Deutsch', fr: 'Français', ru: 'Русский', zh: '简体中文' };
const LOCALES = { tr: 'tr-TR', en: 'en-GB', de: 'de-DE', fr: 'fr-FR', ru: 'ru-RU', zh: 'zh-CN' };

const EN = {
  // ---- chrome
  'OrkoWallet – Grin': 'OrkoWallet – Grin',
  'Ağ': 'Network',
  'Ana ağ': 'Mainnet',
  'Test ağı': 'Testnet',
  'Yerel': 'Local',
  'Yerel test ağı': 'Local test network',
  'Ayarlar': 'Settings',
  'Kilitle': 'Lock',
  'Çıkış yap': 'Log out',
  'Kapat': 'Close',
  'Vazgeç': 'Cancel',
  'Kaydet': 'Save',
  'Kaydedildi': 'Saved',
  'Kopyala': 'Copy',
  'Kopyalandı': 'Copied',
  'Kopyalanamadı; metni seçip Ctrl+C ile kopyala': 'Could not copy; select the text and press Ctrl+C',
  'Yenile': 'Refresh',
  'Yükleniyor': 'Loading',
  'Geri': 'Back',
  '← Cüzdanlar': '← Wallets',

  // ---- node panel
  'Gömülü': 'Built-in',
  'Uzak': 'Remote',
  'Bağlanıyor…': 'Connecting…',
  'Bağlı': 'Connected',
  'Bağlı · {n} sn önce güncellendi': 'Connected · updated {n} s ago',
  'Node\'a ulaşılamıyor': 'Node unreachable',
  'Node başlatılamadı': 'Node could not start',
  'Node kapanıyor…': 'Node is shutting down…',
  'Node başlatılıyor': 'Node is starting',
  'Hazırlanıyor': 'Preparing',
  'Senkronize': 'In sync',
  'Eş (peer) bekleniyor': 'Waiting for peers',
  'Blok başlıkları indiriliyor ({a} / {b})': 'Downloading block headers ({a} / {b})',
  'Bloklar indiriliyor ({a} / {b})': 'Downloading blocks ({a} / {b})',
  'Zincir durumu indiriliyor': 'Downloading chain state',
  'Zincir durumu kuruluyor': 'Setting up chain state',
  'Zincir durumu kaydediliyor': 'Saving chain state',
  'Kernel\'ler doğrulanıyor': 'Verifying kernels',
  'Range proof\'lar doğrulanıyor': 'Verifying range proofs',
  'Kapanıyor': 'Shutting down',
  'Senkronize ediliyor ({a} / {b})': 'Syncing ({a} / {b})',
  'Uzak node': 'Remote node',
  'Kendi node\'unu çalıştır': 'Run your own node',
  'Node\'u durdur': 'Stop node',
  'Node ayarları': 'Node settings',
  'Gömülü node Grin zincirini bu bilgisayara indirir (ana ağda birkaç GB, ilk senkron uzun sürer). Sonra cüzdanın kimseye sormadan çalışır.': 'The built-in node downloads the Grin chain to this computer (several GB on mainnet, the first sync takes long). After that your wallet works without asking anyone.',
  'Header': 'Header',
  'Block': 'Block',
  'Data': 'Data',
  'Peers': 'Peers',
  'Blocks': 'Blocks',
  'Hash': 'Hash',
  'Height': 'Height',
  'Difficulty': 'Difficulty',
  'Time': 'Time',
  'Main pool': 'Main pool',
  'Stem pool': 'Stem pool',
  'Size': 'Size',
  'Eşit': 'Equal',
  'Header önde (+{n})': 'Header ahead (+{n})',
  'Henüz blok bilgisi yok': 'No block data yet',
  'Henüz eş yok': 'No peers yet',
  'Eş bilgisi uzak node\'larda görünmez; kendi node\'unu çalıştırınca burada listelenir.': 'Peer information is not available on remote nodes; run your own node to see it here.',
  'gelen': 'inbound',
  'giden': 'outbound',
  '{n} sn önce': '{n} s ago',
  '{n} dk önce': '{n} min ago',
  '{n} sa önce': '{n} h ago',
  '{n} gün önce': '{n} d ago',
  '{n} sn': '{n} s',
  '{n} dk': '{n} min',
  'Gömülü node başlatılıyor': 'Starting the built-in node',
  'Node durduruldu': 'Node stopped',
  'Kullanılan node: {url}': 'Node in use: {url}',

  // ---- wallets list / forms
  'Cüzdanlar': 'Wallets',
  '{net} · {n} cüzdan': '{net} · {n} wallets',
  '+ Yeni cüzdan': '+ New wallet',
  'Geri yükle': 'Restore',
  'İçe aktar': 'Import',
  'Bu ağda henüz cüzdanın yok': 'You have no wallet on this network yet',
  'Yeni bir cüzdan oluştur, kurtarma ifadenle geri yükle ya da grin-wallet / Grim cüzdan klasörünü içe aktar. Anahtarların yalnızca bu bilgisayarda durur; ödemeler Tor üzerinden gelir ve gider.': 'Create a new wallet, restore one with your recovery phrase, or import a grin-wallet / Grim wallet folder. Your keys stay on this computer only; payments come and go over Tor.',
  'Oluşturuldu {date}': 'Created {date}',
  'İçe aktarıldı': 'Imported',
  'Kendi node\'u': 'Own node',
  'Node havuzu': 'Node pool',
  'Aç': 'Open',
  '“{name}” cüzdanını aç': 'Open wallet “{name}”',
  'Parola': 'Password',
  'Cüzdanın parolası': 'Wallet password',
  'Parola (tekrar)': 'Password (again)',
  'Yeni cüzdan': 'New wallet',
  'Bu parola cüzdan dosyanı bu bilgisayarda şifreler. Unutursan cüzdanı yalnızca kurtarma ifadesiyle açabilirsin.': 'This password encrypts your wallet file on this computer. If you forget it you can only recover the wallet with the recovery phrase.',
  'Oluştur': 'Create',
  'Cüzdanı geri yükle': 'Restore wallet',
  'grin-wallet, Grim ya da bu uygulamadan aldığın kurtarma ifadesi çalışır; adresin aynı kalır.': 'A recovery phrase from grin-wallet, Grim or this app works; your address stays the same.',
  'Geri yüklemeden sonra zincir taranır; uzak node ile birkaç dakika sürebilir.': 'After restoring, the chain is scanned in the background; this can take a few minutes.',
  'Cüzdanı içe aktar': 'Import wallet',
  'grin-wallet ya da Grim cüzdan klasörünü kopyalayarak açar. Parola o cüzdanın mevcut parolasıdır.': 'Copies a grin-wallet or Grim wallet folder and opens it. The password is that wallet\'s current password.',
  'Cüzdan adı': 'Wallet name',
  'Örn. Günlük': 'e.g. Daily',
  'Kurtarma ifadesi': 'Recovery phrase',
  'Cüzdan klasörü': 'Wallet folder',
  'İçinde <code>wallet_data</code> klasörü olan klasör. Dosyalar kopyalanır, aslına dokunulmaz.': 'The folder that contains <code>wallet_data</code>. Files are copied; the original is untouched.',
  'İçinde': 'The folder that contains',
  'klasörü olan klasör. Dosyalar kopyalanır, aslına dokunulmaz.': 'Files are copied; the original is untouched.',
  'Node bağlantısı': 'Node connection',
  'Otomatik: birkaç node, hata olunca kendiliğinden geçer (önerilen)': 'Automatic: several nodes, switches by itself on errors (recommended)',
  'Kendi node\'um (gömülü, senkron gerekir)': 'My own node (built-in, needs to sync)',
  'Bu cüzdanı ne zaman oluşturdun?': 'When did you create this wallet?',
  'Cüzdan hemen açılır; eski işlemlerin arkada taranır. Seçtiğin yıldan önce gelen para görünmez, emin değilsen "Bilmiyorum"u seç (sonradan "Cüzdanı onar" ile de taratabilirsin).': 'The wallet opens at once; your old transactions are scanned in the background. Money received before the year you pick will not show up. If unsure choose "I don\'t know" (you can also rescan later with "Repair wallet").',
  'Bilmiyorum / emin değilim: en baştan (en uzun, en güvenli)': 'I don\'t know / not sure: from the start (longest, safest)',
  '{y} veya sonrasında': '{y} or later',
  'Bu cüzdan hiç kullanılmadı (tarama yok)': 'This wallet was never used (no scan)',

  // ---- recovery phrase
  'Kurtarma ifaden': 'Your recovery phrase',
  'Bu kelimeleri kâğıda yaz ve güvenli bir yerde sakla.': 'Write these words on paper and keep them somewhere safe.',
  'Bilgisayarın bozulursa paran yalnızca bu kelimelerle geri gelir. Kimseyle paylaşma, ekran görüntüsü alma, internete kaydetme.': 'If your computer breaks, your money only comes back with these words. Share them with nobody, do not take screenshots, do not save them online.',
  'Kelimeleri sırasıyla kâğıda yazdım.': 'I wrote the words down in order.',
  'Devam': 'Continue',
  'Kontrol edelim': 'Let\'s check',
  'Yazdığın kâğıda bakarak istenen kelimeleri gir.': 'Look at your paper and enter the requested words.',
  'Kelimelere dön': 'Back to the words',
  'Bitir': 'Finish',
  '{n}. kelime': 'Word {n}',
  'Bazı kelimeler tutmuyor. Kâğıdı kontrol et.': 'Some words do not match. Check your paper.',
  'Ekranında kimse görmüyorken aç. Kelimeleri kimseyle paylaşma.': 'Open this only when nobody can see your screen. Share the words with nobody.',
  'Göster': 'Show',
  'Kurtarma ifadesi geçersiz. Kelimeleri ve sırasını kontrol et.': 'The recovery phrase is not valid. Check the words and their order.',
  'Kurtarma ifadesi 12-24 kelime olmalı, {n} kelime girildi.': 'The recovery phrase must be 12-24 words, you entered {n}.',

  // ---- wallet screen
  'Kullanılabilir bakiye': 'Spendable balance',
  'Gönder': 'Send',
  'Al': 'Receive',
  'Slatepack': 'Slatepack',
  'Onay bekliyor': 'Awaiting confirmation',
  'Olgunlaşmamış': 'Immature',
  'Kilitli': 'Locked',
  'Toplam': 'Total',
  'Cüzdan yüksekliği': 'Wallet height',
  'İşlemler': 'Transactions',
  'Hesaplar': 'Accounts',
  'Cüzdan ayarları': 'Wallet settings',
  '{n} işlem': '{n} transactions',
  'Henüz işlem yok. Tor adresini paylaşarak ödeme alabilirsin.': 'No transactions yet. Share your Tor address to receive payments.',
  'Node\'a ulaşılamıyor; gösterilen bakiye son bilinen değer.': 'Node unreachable; the balance shown is the last known value.',
  'Kendi node\'una ulaşılamıyor ya da node henüz senkronize değil; gösterilen bakiye son bilinen değer. Node panelinden node\'u başlat.': 'Your own node is unreachable or not yet in sync; the balance shown is the last known value. Start the node from the Node panel.',
  'Eski işlemlerin taranıyor: %{p}{eta}. Bu sırada bakiye eksik görünebilir; cüzdanı kullanmaya devam edebilirsin.': 'Scanning your old transactions: {p}%{eta}. The balance may look incomplete meanwhile; you can keep using the wallet.',
  ' · yaklaşık {n} dk kaldı': ' · about {n} min left',
  ' · az kaldı': ' · almost done',
  'Tarama yarıda kaldı: {e}. Cüzdanı yeniden açınca kaldığı yerden sürer; ya da Cüzdan ayarları > Bakım\'dan yeniden başlat.': 'The scan stopped: {e}. It continues when you open the wallet again, or restart it from Wallet settings > Maintenance.',
  'Tarama bitti, bakiye güncel': 'Scan finished, balance is up to date',
  'Tarama başladı; ilerlemesi bakiye kartında': 'Scan started; progress shows on the balance card',
  'Zaten bir tarama sürüyor.': 'A scan is already running.',
  'Tarama beklenmedik şekilde durdu (ayrıntılar log dosyasında).': 'The scan stopped unexpectedly (details in the log file).',

  // ---- transactions
  'Alındı': 'Received',
  'Gönderildi': 'Sent',
  'Alma iptal edildi': 'Receive cancelled',
  'Gönderim iptal edildi': 'Send cancelled',
  'Madencilik ödülü': 'Mining reward',
  'İptal edildi': 'Cancelled',
  'Onaylandı': 'Confirmed',
  'Zincirde onay bekliyor': 'Waiting for confirmation on the chain',
  'Alıcının yanıtı bekleniyor (tutar kilitli)': 'Waiting for the recipient\'s reply (amount locked)',
  'Yanıt bekliyor': 'Waiting for reply',
  'Durum': 'Status',
  'Tutar': 'Amount',
  'Ağ ücreti': 'Network fee',
  'Oluşturuldu': 'Created',
  'Girdi / çıktı': 'Inputs / outputs',
  'Geçerlilik (blok)': 'Valid until (block)',
  'İşlem kimliği': 'Transaction ID',
  'Kernel': 'Kernel',
  'Yerel no': 'Local no.',
  'İşlem': 'Transaction',
  'Ödeme kanıtı': 'Payment proof',
  'Kanıtı kopyala': 'Copy proof',
  'Yeniden yayınla': 'Rebroadcast',
  'Yeniden yayınlandı': 'Rebroadcast done',
  'İşlemi iptal et': 'Cancel transaction',
  'İşlem iptal edildi': 'Transaction cancelled',
  'İşlem iptal edildi, tutar serbest': 'Transaction cancelled, amount released',

  // ---- accounts
  'Hesaplar bir cüzdanın içindeki ayrı bölmelerdir; her hesabın bakiyesi ve adresi ayrıdır. Aynı kurtarma ifadesiyle hepsi geri gelir.': 'Accounts are separate compartments inside one wallet; each has its own balance and address. All of them come back with the same recovery phrase.',
  'Etkin': 'Active',
  'Etkinleştir': 'Activate',
  'Yeni hesap adı': 'New account name',
  'Hesap ekle': 'Add account',
  'Hesap adı yaz.': 'Enter an account name.',
  'Hesap adı boş olamaz': 'The account name cannot be empty',
  '“{name}” hesabı etkin; Tor adresi değişti': 'Account “{name}” is active; the Tor address changed',
  'Hesap: {name} · her hesabın adresi ayrıdır': 'Account: {name} · every account has its own address',

  // ---- wallet settings
  'Genel': 'General',
  'Harcamak için gereken onay sayısı': 'Confirmations needed to spend',
  'Gelen bir ödeme bu kadar blok onayı alınca harcanabilir. Grin varsayılanı 10 (~10 dk).': 'An incoming payment can be spent after this many block confirmations. Grin default is 10 (~10 min).',
  'Otomatik (node havuzu)': 'Automatic (node pool)',
  'Tek node (kendim seçeceğim)': 'One node (I choose)',
  'Kendi node\'um (gömülü)': 'My own node (built-in)',
  'Bu cüzdan için node adresi': 'Node address for this wallet',
  'Otomatik modda cüzdan, listedeki node\'lardan sağlıklı ve hızlı olanla başlar; bir node bozuk yanıt verirse sıradakine kendiliğinden geçer.': 'In automatic mode the wallet starts on the healthiest, fastest node of the list; if a node gives a bad answer it switches to the next by itself.',
  'Kaydedildi. Yeni node bağlantısı cüzdan yeniden açılınca geçerli olur.': 'Saved. The new node connection applies when the wallet is opened again.',
  'Şimdi kapat': 'Close now',
  'Güvenlik': 'Security',
  'Parolayı değiştir': 'Change password',
  'Kurtarma ifadesini göster': 'Show recovery phrase',
  'Bakım': 'Maintenance',
  'Bakiye ya da işlemler yanlış görünüyorsa cüzdanı zincirle yeniden eşleştir. Tarama arkada sürer; ilerlemesi bakiye kartında görünür.': 'If the balance or transactions look wrong, re-match the wallet with the chain. The scan runs in the background; progress shows on the balance card.',
  'Nereden taransın': 'Scan from',
  'Cüzdanı onar (yeniden tara)': 'Repair wallet (rescan)',
  'Cüzdanı sil': 'Delete wallet',
  'Cüzdan dosyaları bu bilgisayardan silinir. Kurtarma ifaden yoksa paran kaybolur.': 'The wallet files are deleted from this computer. Without your recovery phrase the money is lost.',
  'Cüzdanı sil…': 'Delete wallet…',
  'Mevcut parola': 'Current password',
  'Yeni parola': 'New password',
  'Yeni parola (tekrar)': 'New password (again)',
  'Değiştir': 'Change',
  'Parola değiştirildi': 'Password changed',
  'Yeni parola en az 4 karakter olmalı.': 'The new password must be at least 4 characters.',
  'Yeni parolalar aynı değil.': 'The new passwords do not match.',
  'Parola en az 4 karakter olmalı.': 'The password must be at least 4 characters.',
  'Parolalar aynı değil.': 'The passwords do not match.',
  'Parola yanlış.': 'Wrong password.',
  '{name} bu bilgisayardan silinecek. Kurtarma ifaden yanında değilse içindeki para kaybolur. Bu işlem geri alınamaz.': '{name} will be deleted from this computer. If you do not have your recovery phrase, the money in it is lost. This cannot be undone.',
  'Kurtarma ifadem yanımda / bu cüzdandaki parayı kaybetmeyi kabul ediyorum.': 'I have my recovery phrase / I accept losing the money in this wallet.',
  'Kalıcı olarak sil': 'Delete permanently',

  // ---- tor card
  'Tor adresin': 'Your Tor address',
  'Adresi kopyala': 'Copy address',
  'QR': 'QR',
  'Onion adresi': 'Onion address',
  'Tor bağlantısı': 'Tor connection',
  'Tor engelleniyorsa ya da bağlanmıyorsa bir köprü seç. Değişiklik hemen uygulanır.': 'If Tor is blocked or does not connect, pick a bridge. The change applies at once.',
  'Köprü yok (doğrudan)': 'No bridge (direct)',
  'Snowflake': 'Snowflake',
  '(en dayanıklı)': '(most resilient)',
  'obfs4': 'obfs4',
  '(yerleşik)': '(built-in)',
  'Kendi köprülerim': 'My own bridges',
  'Tor motoru': 'Tor engine',
  'Uygulamayla gelen Tor (önerilen)': 'Tor shipped with the app (recommended)',
  'Gömülü Arti (deneysel)': 'Built-in Arti (experimental)',
  'Uygula': 'Apply',
  'Tor kapalı': 'Tor off',
  'Kapalı': 'Off',
  'Hata': 'Error',
  'Yayılıyor': 'Publishing',
  'Çevrimiçi': 'Online',
  'Bağlanıyor %{p}': 'Connecting {p}%',
  'Tor bağlanıyor {p}%': 'Tor connecting {p}%',
  'Tor hatası': 'Tor error',
  'Tor hazır': 'Tor ready',
  'Tor hazır · adres yayılıyor': 'Tor ready · address spreading',
  'Tor kapalı: Tor üzerinden ödeme alınamaz, Slatepack ile alabilirsin.': 'Tor is off: you cannot receive over Tor, but you can receive with Slatepack.',
  'Tor ağına bağlanılıyor; birkaç saniye sürer.': 'Connecting to the Tor network; takes a few seconds.',
  'Tor bağlanamadı. Aşağıdan bir köprü (Snowflake) seçip "Uygula"ya bas.': 'Tor could not connect. Pick a bridge (Snowflake) below and press "Apply".',
  'Tor hazır. Adresinin Tor ağında bulunabilir olması ~{n} dk daha sürebilir; bu sırada gelen ödeme denemeleri başarısız olabilir.': 'Tor is ready. It can take ~{n} more min for your address to become findable on Tor; payment attempts may fail meanwhile.',
  'Adresin Tor ağında çevrimiçi: ödemeler doğrudan gelebilir.': 'Your address is online on Tor: payments can arrive directly.',
  'Tor motoru cüzdan yeniden açılınca değişecek': 'The Tor engine changes when the wallet is opened again',
  'Tor yeni ayarlarla yeniden bağlanıyor': 'Tor is reconnecting with the new settings',
  'En az bir köprü satırı yaz.': 'Enter at least one bridge line.',

  // ---- send / receive / slatepack
  'Grin gönder': 'Send Grin',
  'Alıcının adresi': 'Recipient\'s address',
  'Adres yoksa boş bırak; alıcıya vereceğin bir Slatepack metni oluşur.': 'If you have no address leave it empty; a Slatepack text to hand to the recipient is created.',
  'Kullanılabilir': 'Available',
  'Ağ ücreti otomatik eklenir.': 'The network fee is added automatically.',
  'Alıcı Tor üzerinde aranıyor…': 'Looking for the recipient on Tor…',
  'Alıcı çevrimiçi; ödeme Tor üzerinden doğrudan gidecek.': 'Recipient is online; the payment will go directly over Tor.',
  'Alıcıya şu an Tor ile ulaşılamıyor. Yine de gönderebilirsin: alıcıya vereceğin bir Slatepack metni oluşur.': 'The recipient cannot be reached over Tor right now. You can still send: a Slatepack text to hand over is created.',
  'Bu, bu ağ için geçerli bir Grin adresi değil.': 'This is not a valid Grin address for this network.',
  'Bu adres bu ağ için geçerli bir Grin adresi değil.': 'This address is not a valid Grin address for this network.',
  'Tutar gir.': 'Enter an amount.',
  'Tutar geçersiz.': 'The amount is not valid.',
  'Tutar sıfırdan büyük olmalı.': 'The amount must be greater than zero.',
  'Gönderildi.': 'Sent.',
  'Alıcı imzaladı, işlem zincire iletildi. Onaylanması birkaç dakika sürer.': 'The recipient signed it and the transaction was posted to the chain. Confirmation takes a few minutes.',
  'Alıcıya Tor üzerinden ulaşılamadı, bu yüzden ödeme Slatepack ile tamamlanacak. Tutar, işlem bitene ya da iptal edilene kadar kilitli kalır.': 'The recipient could not be reached over Tor, so the payment will be completed with Slatepack. The amount stays locked until it finishes or is cancelled.',
  'Ödeme Slatepack ile tamamlanacak. Tutar, işlem bitene ya da iptal edilene kadar kilitli kalır.': 'The payment will be completed with Slatepack. The amount stays locked until it finishes or is cancelled.',
  'Bu Slatepack metnini alıcıya ilet (kopyala ya da QR).': 'Pass this Slatepack text to the recipient (copy or QR).',
  'Alıcının sana geri verdiği yanıtı yapıştır (alıcı Tor kullanıyorsa bu adım kendiliğinden tamamlanır):': 'Paste the reply the recipient gives back (if the recipient uses Tor this step completes by itself):',
  'Tamamla ve gönder': 'Finish and send',
  'Alıcının yanıtını yapıştır.': 'Paste the recipient\'s reply.',
  'Bu metin bu gönderimin yanıtı değil.': 'This text is not the reply to this payment.',
  'Grin al': 'Receive Grin',
  'Bu adresi gönderene ver. Uygulama açık ve Tor hazırken ödemeler kendiliğinden gelir.': 'Give this address to the sender. While the app is open and Tor is ready, payments arrive by themselves.',
  'Gönderen Tor kullanamıyorsa sana bir Slatepack metni verir; onu "Slatepack" düğmesiyle işle.': 'If the sender cannot use Tor they give you a Slatepack text; process it with the "Slatepack" button.',
  'Slatepack işle': 'Process Slatepack',
  'Sana verilen Slatepack metnini yapıştır. Gelen bir ödemeyse imzalanır; kendi gönderdiğin bir ödemenin yanıtıysa tamamlanıp zincire iletilir.': 'Paste the Slatepack text you were given. An incoming payment gets signed; a reply to a payment you sent gets finished and posted to the chain.',
  'İşle': 'Process',
  'Slatepack metnini yapıştır.': 'Paste the Slatepack text.',
  'İmzalandı.': 'Signed.',
  'Ödemenin tamamlanması için bu yanıtı gönderene geri ver.': 'Give this reply back to the sender so the payment can finish.',
  'Ödeme alındı.': 'Payment received.',
  'İmzalı yanıt gönderene Tor üzerinden iletildi.': 'The signed reply was sent to the sender over Tor.',
  'Tamamlandı.': 'Done.',
  'İşlem zincire iletildi.': 'The transaction was posted to the chain.',
  'Yetersiz bakiye (ücret dahil). Onay bekleyen tutarlar henüz harcanamaz.': 'Insufficient balance (fee included). Amounts awaiting confirmation cannot be spent yet.',

  // ---- lock
  'Kilitli ekran': 'Locked screen',
  'Cüzdan kilitli': 'Wallet locked',
  'Kilidi aç': 'Unlock',
  'Cüzdan kilitli. Arka planda çalışmaya devam eder, ödemeler gelmeye devam eder.': 'The wallet is locked. It keeps running in the background and payments keep arriving.',
  'Kilitle: ekranı parolaya bağlar, cüzdan çalışmaya devam eder. Çıkış yap: cüzdanı tamamen kapatır.': 'Lock: puts the screen behind the password, the wallet keeps running. Log out: closes the wallet completely.',
  'Çıkış yapınca cüzdan kapanır ve Tor adresin çevrimdışı olur; ödeme alamazsın.': 'Logging out closes the wallet and your Tor address goes offline; you cannot receive payments.',
  'Cüzdan kapanıyor…': 'Closing the wallet…',

  // ---- settings
  'Dil': 'Language',
  'Otomatik (sistem dili)': 'Automatic (system language)',
  'Görünüm': 'Appearance',
  'Sistem': 'System',
  'Koyu': 'Dark',
  'Açık': 'Light',
  'Ağ değiştirmek uygulamayı yeniden başlatır; her ağın cüzdanları ve node\'u ayrıdır. Test ağı yalnızca denemeler içindir, gerçek para taşımaz.': 'Changing the network restarts the app; every network has its own wallets and node. The testnet is for trying things out only and carries no real money.',
  'Ana ağ (gerçek Grin)': 'Mainnet (real Grin)',
  'Test ağı (deneme, para değeri yok)': 'Testnet (for trying, no monetary value)',
  'Yerel test (usernet)': 'Local test (usernet)',
  'Ağı değiştir ve yeniden başlat': 'Switch network and restart',
  'Otomatik kilit': 'Auto lock',
  'Kullanılmazsa ekranı kilitler. Cüzdan arka planda çalışmaya devam eder.': 'Locks the screen when idle. The wallet keeps running in the background.',
  'Kapalı': 'Off',
  '{n} dakika': '{n} minutes',
  '1 dakika': '1 minute',
  '1 saat': '1 hour',
  'Hakkında': 'About',
  'OrkoWallet – Grin 0.1.1 · grin-wallet 5.5.1 ve grin 5.5.2 resmi kütüphaneleri · Tor 0.4.9.16 · Orkoswap': 'OrkoWallet – Grin 0.1.1 · official grin-wallet 5.5.1 and grin 5.5.2 libraries · Tor 0.4.9.16 · Orkoswap',
  'Ağ değişince açık cüzdan kapanır ve uygulama yeniden başlar.': 'The open wallet closes and the app restarts when the network changes.',
  'Uygulama seçtiğin ağ ile yeniden başlayacak.': 'The app will restart on the network you picked.',

  // ---- node settings / pool
  'Node havuzu ({net})': 'Node pool ({net})',
  'Cüzdan listedeki sağlıklı ve hızlı node ile başlar. Bir node bozuk ya da yarım yanıt verirse sıradakine kendiliğinden geçer; bu yüzden birden fazla node tutmak iyidir. Yeni eklenen node cüzdan yeniden açılınca kullanılır.': 'The wallet starts on the healthy, fast node of the list. If a node gives a bad or cut-off answer it switches to the next by itself, so keeping several nodes is a good idea. A newly added node is used when the wallet is opened again.',
  'Yerleşik': 'Built-in',
  'Eklediğin': 'Added by you',
  'Kullanımda': 'In use',
  'Sil': 'Remove',
  'Kontrol ediliyor…': 'Checking…',
  'Çalışıyor': 'Working',
  'Ulaşılamıyor': 'Unreachable',
  '{ms} ms · blok {h}': '{ms} ms · block {h}',
  'Node ekle': 'Add node',
  'Ekle': 'Add',
  'https://node-adresin:3413': 'https://your-node:3413',
  'Şimdi kontrol et': 'Check now',
  'Node eklendi': 'Node added',
  'Node silindi': 'Node removed',
  'Node adresi http:// ya da https:// ile başlamalı.': 'The node address must start with http:// or https://.',
  'Bu node zaten listede.': 'This node is already in the list.',
  'Bu adrese ulaşılamadı: {e}': 'This address could not be reached: {e}',
  'Gömülü node': 'Built-in node',
  'Uygulama açılınca gömülü node\'u başlat': 'Start the built-in node when the app opens',
  'Arşiv modu (tüm geçmiş, çok daha fazla disk)': 'Archive mode (full history, much more disk)',
  'Ek eşler (her satıra host:port)': 'Extra peers (one host:port per line)',
  'Yalnızca bu eşlere bağlan (özel test ağı)': 'Only connect to these peers (private test network)',
  'Gömülü node değişiklikleri uygulama yeniden açılınca geçerli olur.': 'Built-in node changes apply when the app is started again.',
  'Eş adresi host:port olmalı: {p}': 'A peer address must be host:port: {p}',
  'Node ayarları kaydedildi': 'Node settings saved',
  'Node\'lardan okunabilir yanıt alınamadı (hepsi denendi). Birkaç dakika sonra yeniden dene ya da Node ayarları\'ndan kendi node\'unu ekle.': 'No node gave a readable answer (all were tried). Try again in a few minutes or add your own node in Node settings.',
  'Node\'a ulaşılamadı. Node panelinden bağlantıyı kontrol et.': 'The node could not be reached. Check the connection in the Node panel.',
  '{port} portu kullanımda: bu bilgisayarda başka bir Grin node\'u çalışıyor olabilir': 'Port {port} is in use: another Grin node may be running on this computer',

  // ---- misc errors
  'Açık cüzdan yok.': 'No wallet is open.',
  'hesap adı boş olamaz': 'the account name cannot be empty',
  'Cüzdanı aç': 'Open wallet',
  'node\'a ulaşılamadı: {e}': 'could not reach the node: {e}',
  'node hatası: {e}': 'node error: {e}',
  'node beklenmeyen yanıt verdi': 'the node gave an unexpected answer',
  'Node\'lar': 'Nodes',
  'Bağlantı': 'Connection',
  'Bunu kullan': 'Use this one',
  'Tercih edilen': 'Preferred',
  'Otomatik seç': 'Pick automatically',
  'Node değiştirildi': 'Node switched',
  'Otomatik seçim açık': 'Automatic choice is on',
  'Bu node listede yok.': 'This node is not in the list.',
  'Cüzdan listedeki sağlıklı ve hızlı node ile başlar. Bir node\'u seçip "Bunu kullan" dersen cüzdan hemen ona geçer; o bozulursa yine havuzdaki diğerine geçilir. Yeni eklenen node cüzdan yeniden açılınca havuza girer.': 'The wallet starts on the healthy, fast node of the list. If you pick a node and press "Use this one" the wallet switches to it at once; if it breaks it still moves to another node of the pool. A newly added node joins the pool when the wallet is opened again.',
  'Bu cüzdanın node bağlantısı': 'This wallet\'s node connection',
  'hata olunca diğerine geçer': 'switches to another on errors',
  'başka node\'a geçmez': 'never switches to another node',
  'Tek node': 'Single node',
  'Bağlantı türü cüzdan yeniden açılınca geçerli olur.': 'The connection type applies when the wallet is opened again.',
  'Önce bir cüzdan aç.': 'Open a wallet first.',
  'Kaydedildi. Yeni node bağlantısı cüzdan yeniden açılınca geçerli olur.': 'Saved. The new node connection applies when the wallet is opened again.',
  'Gömülü node ayarlarını kaydet': 'Save built-in node settings',
  '{n} sa': '{n} h',
  '{n} gün': '{n} d',
  '{ms} ms': '{ms} ms',
  'Alıcının Grin adresini yaz; ödeme Tor üzerinden doğrudan gider, alıcı imzalar ve işlem zincire iletilir.': 'Enter the recipient\'s Grin address; the payment goes straight over Tor, the recipient signs it and the transaction is posted to the chain.',
  'Alıcı çevrimdışıysa dakikada bir yeniden denenir (en fazla {n} dk); olmazsa işlem başarısız olur ve tutar serbest kalır.': 'If the recipient is offline it is retried every minute (up to {n} min); if that fails the transaction fails and the amount is released.',
  'Alıcı çevrimdışıysa işlem başarısız olur ve tutar serbest kalır.': 'If the recipient is offline the transaction fails and the amount is released.',
  'Alıcıya {s} sn içinde Tor ile ulaşılamadı; çevrimdışı olabilir.': 'The recipient could not be reached over Tor within {s} s; they may be offline.',
  'Yine de gönderirsen dakikada bir yeniden denenir (en fazla {n} dk).': 'If you send anyway it is retried every minute (up to {n} min).',
  'Şimdi gönderirsen işlem başarısız olur.': 'If you send now the transaction will fail.',
  'Alıcıya şu an ulaşılamadı.': 'The recipient could not be reached right now.',
  'Dakikada bir yeniden denenecek (en fazla {n} dk). Bu pencereyi kapatabilirsin; sonuç İşlemler listesinde görünür. Yeniden deneme için uygulama ve cüzdan açık kalmalı.': 'It will be retried every minute (up to {n} min). You can close this window; the result shows in the Transactions list. The app and wallet must stay open for the retries.',
  'Alıcı çevrimdışıysa': 'If the recipient is offline',
  'Dakikada bir yeniden dene': 'Retry every minute',
  'Kaç dakika boyunca': 'For how many minutes',
  'Tor ile gönderirken alıcıya ulaşılamazsa işlem hemen başarısız olmaz: seçtiğin süre boyunca dakikada bir denenir. Süre dolarsa işlem başarısız olur ve tutar serbest kalır. Yeniden deneme yalnızca uygulama ve cüzdan açıkken sürer. Kapatırsan her gönderim ilk denemede başarısız olur.': 'When sending over Tor and the recipient cannot be reached, the transaction does not fail at once: it is tried every minute for the time you choose. If the time runs out the transaction fails and the amount is released. Retries only continue while the app and wallet are open. If you turn this off, every payment fails on the first attempt.',
  'Alıcı aranıyor {a}/{b}': 'Looking for recipient {a}/{b}',
  'sonraki deneme {n} sn': 'next try in {n} s',
  'Gönderim başarısız': 'Send failed',
  'Alıcı çevrimiçi oldu, ödeme gönderildi': 'The recipient came online, the payment was sent',
  'Gönderim başarısız: alıcıya ulaşılamadı. Tutar serbest bırakıldı.': 'Send failed: the recipient could not be reached. The amount was released.',
  'Alıcıya ulaşılamadı; işlem başarısız oldu, tutar serbest kaldı. Ayarlardan yeniden denemeyi açabilirsin.': 'The recipient could not be reached; the transaction failed and the amount was released. You can turn retries on in Settings.',
  'Alıcının çevrimiçi olup olmadığına bakılıyor… {p}% · genelde 10-30 sn, en fazla {s} sn sürer': 'Checking whether the recipient is online… {p}% · usually 10-30 s, at most {s} s',
  'Alıcıya {s} sn içinde Tor ile ulaşılamadı; çevrimdışı olabilir. Yine de gönderebilirsin: ulaşılamazsa Slatepack metni oluşturulur.': 'The recipient could not be reached over Tor within {s} s; they may be offline. You can still send: if they cannot be reached a Slatepack text is created.',
  'Tekrar kontrol et': 'Check again',
  'Gönderme yöntemi': 'Send method',
  'Tor ile gönder': 'Send over Tor',
  'Slatepack ile gönder': 'Send with Slatepack',
  'Alıcının Grin adresini yaz; ödeme Tor üzerinden doğrudan gider, alıcı imzalar ve işlem zincire iletilir. Alıcıya ulaşılamazsa otomatik olarak Slatepack\'e geçilir.': 'Enter the recipient\'s Grin address; the payment goes straight over Tor, the recipient signs it and the transaction is posted to the chain. If the recipient cannot be reached it switches to Slatepack automatically.',
  'Alıcı çevrimdışıysa ya da Tor kullanamıyorsa: bir Slatepack metni oluşturulur. Onu alıcıya mesajla, e-postayla ya da QR ile ilet; alıcı yanıtı geri verince buraya yapıştırıp tamamlarsın.': 'If the recipient is offline or cannot use Tor: a Slatepack text is created. Hand it to the recipient by message, e-mail or QR; when they give the reply back, paste it here to finish.',
  'Alıcının adresi (isteğe bağlı)': 'Recipient\'s address (optional)',
  'grin1… ile başlar. Adresi yazınca alıcının çevrimiçi olup olmadığı otomatik kontrol edilir.': 'Starts with grin1…. Once you type it, the app checks automatically whether the recipient is online.',
  'Yazarsan metin yalnızca o adrese şifrelenir; yazmazsan metni eline geçiren herkes görebilir.': 'If you enter one, the text is encrypted for that address only; if you do not, anyone who gets the text can read it.',
  'Slatepack oluştur': 'Create Slatepack',
  'Tor ile göndermek için alıcının adresini yaz.': 'Enter the recipient\'s address to send over Tor.',
  'Tümü': 'All',
  'Gelen': 'Incoming',
  'Giden': 'Outgoing',
  'Bekleyen': 'Pending',
  'Sayfa başına': 'Per page',
  'Önceki sayfa': 'Previous page',
  'Sonraki sayfa': 'Next page',
  'Doğrudan': 'Direct',
  'Özel': 'Custom',
  'Tor köprüleri': 'Tor bridges',
  'Tor motoru': 'Tor engine',
  'Tor ağına bağlan': 'Connect to Tor',
  'Adresi duyur': 'Announce the address',
  'Erişim testi': 'Reachability test',
  'Tor çevrimiçi': 'Tor online',
  'Tor hazır · adres duyuruluyor {p}%': 'Tor ready · announcing address {p}%',
  'Adresin Tor ağına duyuruluyor. Ulaşılabilir olunca burada \"Çevrimiçi\" yazar; o zamana kadar gelen ödeme denemeleri başarısız olabilir.': 'Your address is being announced to the Tor network. \"Online\" appears here once it is reachable; payment attempts may fail until then.',
  'Yedekleme': 'Backup',
  'Parola': 'Password',
  'Ekranı açık bırakan birinin senin adına para göndermesini engeller.': 'Stops someone at an unlocked screen from sending money in your name.',
  'Yedeklemek için önce bir cüzdan aç.': 'Open a wallet first to back it up.',
  'Gönderme': 'Sending',
  'Her gönderimden önce parolayı tekrar iste': 'Ask for the password again before every payment',
  'Hemen yayınla (Dandelion kapalı)': 'Broadcast at once (Dandelion off)',
  'Dandelion, işlemin kaynağını gizlemek için önce rastgele node\'lara iletilmesini sağlar. Kapatırsan işlem hızlı yayılır ama gizlilik azalır.': 'Dandelion passes a transaction through random nodes first to hide where it came from. Turning it off spreads the transaction faster but reduces privacy.',
  'Değişim çıktısı sayısı': 'Number of change outputs',
  'Girdi seçimi': 'Input selection',
  'En küçükler (yeterli en az çıktı)': 'Smallest (fewest outputs that are enough)',
  'Hepsi (tüm çıktıları birleştir)': 'All (combine every output)',
  'İşlem geçerlilik süresi (blok, 0 = sınırsız)': 'Transaction lifetime (blocks, 0 = unlimited)',
  'Yedek ve dışa aktarma': 'Backup and export',
  'Cüzdanı yedekle': 'Back up wallet',
  'İşlemleri CSV olarak aktar': 'Export transactions as CSV',
  'Yedek kaydedildi: {path}': 'Backup saved: {path}',
  'Dışa aktarıldı: {path}': 'Exported: {path}',
  'Destek': 'Support',
  'Günlük klasörünü aç': 'Open the log folder',
  'Küçült': 'Minimize',
  'Ekranı kapla / geri al': 'Maximize / restore',
  'Cüzdan ekle': 'Add a wallet',
  'Son kullanılan': 'Last used',
  'Cüzdan silindi': 'Wallet deleted',
  'Bu ağda henüz cüzdanın yok. Yeni bir cüzdan oluştur, kurtarma ifadenle geri yükle ya da grin-wallet / Grim cüzdan klasörünü içe aktar. Anahtarların yalnızca bu bilgisayarda durur; ödemeler Tor üzerinden gelir ve gider.': 'You have no wallet on this network yet. Create a new wallet, restore one with your recovery phrase, or import a grin-wallet / Grim folder. Your keys stay on this computer only; payments come and go over Tor.',
  'Sıfırdan oluştur, 24 kelimelik kurtarma ifadeni al.': 'Create from scratch and get your 24-word recovery phrase.',
  'Kurtarma ifadenle eski cüzdanını geri getir.': 'Bring your old wallet back with your recovery phrase.',
  'grin-wallet ya da Grim klasörünü kopyala.': 'Copy a grin-wallet or Grim folder.',
  'Çok fazla hatalı deneme. {n} sn sonra yeniden dene.': 'Too many wrong attempts. Try again in {n} s.',
  'Yanıt ayrıca gönderene Tor ile iletilmeye çalışılıyor; ulaşırsa işlem kendiliğinden tamamlanır. Ulaşamazsa bu metni gönderene ver.': 'The reply is also being sent to the sender over Tor; if it gets through the payment completes by itself. If not, give this text to the sender.',
  'Bu metni gönderene ver; o da işlemi tamamlar.': 'Give this text to the sender; they will finish the payment.',
  'Tek node': 'Single node',
  'Cüzdan': 'Wallet',
  'Node': 'Node',
  'Önce açık cüzdanı kapat.': 'Close the open wallet first.',
  'geçersiz cüzdan': 'invalid wallet',
  'Bu klasörde zaten bir cüzdan var.': 'There is already a wallet in this folder.',
  'Bu klasörde bir Grin cüzdanı bulunamadı (wallet_data\\wallet.seed yok).': 'No Grin wallet was found in this folder (wallet_data\\wallet.seed is missing).',
  'Kopyalanamadı: {e}': 'Could not copy: {e}',
  'Beklenmeyen bir hata oluştu (ayrıntılar log dosyasında).': 'An unexpected error occurred (details in the log file).',
  'İşlem yarıda kaldı': 'The operation was interrupted',
  'Başlatılamadı: {e}': 'Could not start: {e}',
  'Maks': 'Max',
  'Harcanabilir tüm bakiyeyi gönderir; ağ ücreti bu tutardan düşülür.': 'Sends the whole spendable balance; the network fee is taken from this amount.',
  'Kurtarma ifadesi 12, 15, 18, 21 veya 24 kelime olabilir.': 'The recovery phrase can have 12, 15, 18, 21 or 24 words.',
  'Gelen bir ödeme bu kadar blok onayı alınca harcanabilir. Grin varsayılanı 10 (~10 dk). 1 onayda harcamak daha hızlıdır, ama zincir yeniden düzenlenirse işlem geçersiz kalabilir.': 'An incoming payment becomes spendable after this many block confirmations. Grin default is 10 (~10 min). Spending after 1 confirmation is faster, but the transaction can become invalid if the chain reorganises.',
  'Kurtarma ifadesi uzunluğu': 'Recovery phrase length',
  '24 kelime (önerilen)': '24 words (recommended)',
  '12 kelime (daha kısa)': '12 words (shorter)',
  'İkisi de güvenlidir; 24 kelime daha geniş bir pay bırakır, 12 kelimeyi yazmak ve saklamak daha kolaydır.': 'Both are secure; 24 words leave a wider margin, 12 words are easier to write down and keep.',
  "Bağış": "Donate",
  "OrkoWallet ücretsiz ve açık kaynaklıdır. Geliştirmeye destek olmak istersen aşağıdaki adrese Grin gönderebilirsin.": "OrkoWallet is free and open source. If you want to support its development you can send Grin to the address below.",
  "Bağış yap": "Donate",
  "Bağış yalnızca Mainnet üzerinde gönderilebilir.": "Donations can only be sent on Mainnet.",
  "Bağış göndermek için önce bir cüzdan aç.": "Open a wallet first to send a donation.",
  "Adres uzun süredir ulaşılamıyor. Bilgisayarın saatini eşitle; olmazsa aşağıdan Snowflake köprüsünü seç ve “Uygula”ya bas.": "The address has been unreachable for a while. Sync your computer clock; if that does not help, pick the Snowflake bridge below and press “Apply”.",
  "Bu işlem Slatepack ile tamamlanıyor": "This transaction is being completed with Slatepack",
  "Alıcıya ilettiğin Slatepack metni": "The Slatepack text you gave the recipient",
  "Gönderene vereceğin yanıt": "The reply you give back to the sender",
  "Alıcının geri verdiği yanıtı buraya yapıştır:": "Paste the reply the recipient gave back here:",
  "İşlem tamamlandı ve zincire iletildi.": "The transaction is complete and was sent to the chain.",
  "Bu pencereyi kapatırsan İşlemler listesinde bu işleme tıklayarak kaldığın yerden devam edebilirsin.": "If you close this window you can continue from the Transactions list by clicking this transaction.",
  "Silmek için cüzdanın adını yaz:": "To delete, type the wallet name:",
  "Cüzdanın adı tutmuyor.": "The wallet name does not match.",
  "Açık cüzdan silinemez. Önce çıkış yap.": "An open wallet cannot be deleted. Log out first.",
  "Cüzdan bulunamadı.": "Wallet not found.",
  "Silinemedi: {e}": "Could not delete: {e}",
  "Cüzdan dosyaları hâlâ kullanımda; birkaç saniye sonra tekrar dene.": "The wallet files are still in use; try again in a few seconds.",
  "Onarım": "Repair",
  "Bağlantıyı onar": "Repair the connection",
  "Tor bağlantısı kurulamıyorsa ya da adresin çevrimiçi görünmüyorsa bunu dene: Tor'un kayıtlı durumu (seçtiği giriş röleleri ve önbellek) silinir ve uygulama yeniden başlar. Cüzdanların, kurtarma ifaden ve bakiyen etkilenmez.": "If Tor cannot connect or your address does not show as online, try this: Tor's saved state (the entry relays it picked and its cache) is deleted and the app restarts. Your wallets, recovery phrase and balance are not affected.",
  "Bağlantıyı yeniden kur ve yeniden başlat": "Reset the connection and restart",
  "Uygulama yeniden başlatılıyor…": "Restarting the app…",
  'Gönderilebilir bakiye yok.': 'There is no balance to send.',
};

// lang-xx.js (loaded before this file) define LANG_DE/FR/RU/ZH; a missing entry falls back to English.
const DICTS = { en: EN, de: typeof LANG_DE !== 'undefined' ? LANG_DE : null, fr: typeof LANG_FR !== 'undefined' ? LANG_FR : null, ru: typeof LANG_RU !== 'undefined' ? LANG_RU : null, zh: typeof LANG_ZH !== 'undefined' ? LANG_ZH : null };
function lookup(key) { const d = DICTS[I18N.lang]; return (d && d[key] !== undefined) ? d[key] : EN[key]; }

const I18N = { lang: 'tr', locale: 'tr-TR', missed: new Set() };

// Patterns for dictionary keys that contain {slots}.
let PATTERNS = null;
function buildPatterns() {
  PATTERNS = [];
  for (const key of Object.keys(EN)) {
    if (!/\{\w+\}/.test(key)) continue;
    const names = [];
    const src = key
      .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
      .replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([\\s\\S]+?)'; });
    PATTERNS.push({ re: new RegExp(`^${src}$`), names, key });
  }
}

function fill(tpl, params) {
  return params ? tpl.replace(/\{(\w+)\}/g, (m, n) => (n in params ? params[n] : m)) : tpl;
}

/** Translate `msg` (Turkish source text) into the current language, filling {slots} from params. */
function t(msg, params) {
  if (msg === undefined || msg === null) return '';
  if (I18N.lang === 'tr' || !msg) return fill(msg, params);
  if (EN[msg] !== undefined) return fill(lookup(msg), params);
  if (!PATTERNS) buildPatterns();
  for (const p of PATTERNS) {
    const m = msg.match(p.re);
    if (m) {
      const got = {};
      p.names.forEach((n, i) => { got[n] = m[i + 1]; });
      return fill(lookup(p.key), { ...got, ...params });
    }
  }
  if (/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(msg)) I18N.missed.add(msg);
  return fill(msg, params);
}

// Static markup is translated in place and can be switched at any time: the Turkish source text
// of every static text node / attribute is remembered once, then re-translated on each change.
const STATIC_TEXT = [];
const STATIC_ATTR = [];
function collectStatic(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const key = n.nodeValue.trim();
    if (key) STATIC_TEXT.push({ n, raw: n.nodeValue, key });
  }
  root.querySelectorAll('[placeholder],[title],[aria-label]').forEach((e) => {
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = e.getAttribute(a);
      if (v) STATIC_ATTR.push({ e, a, v });
    }
  });
  STATIC_TEXT.push({ title: true, key: document.title });
}
/** Apply the current language to the static markup collected by collectStatic(). */
function translateStatic() {
  for (const x of STATIC_TEXT) {
    if (x.title) { document.title = t(x.key); continue; }
    x.n.nodeValue = x.raw.replace(x.key, t(x.key));
  }
  for (const x of STATIC_ATTR) x.e.setAttribute(x.a, t(x.v));
}
function setLanguage(pref) {
  const nav = (navigator.language || 'en').toLowerCase().slice(0, 2);
  const sys = LANGS[nav] ? nav : 'en';
  const lang = LANGS[pref] ? pref : sys;
  I18N.lang = lang;
  I18N.locale = LOCALES[lang];
  document.documentElement.lang = lang;
}

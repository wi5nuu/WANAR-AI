# MASTER PROMPT — PERSONAL AI AGENT: REAL-TIME LOCATION, ACTIVITY INTELLIGENCE, EMERGENCY RESPONSE & MOTORCYCLE CARE

## 1. PERAN DAN MISI UTAMA

Bertindaklah sebagai **Senior Full-Stack Engineer, Mobile Systems Engineer, AI Agent Architect, Geospatial Engineer, IoT Engineer, dan Application Security Engineer**.

Saya sedang mengembangkan personal AI agent milik saya sendiri. Sistem ini sudah memiliki implementasi dan kode yang berjalan. Saya ingin kamu mengembangkan fitur baru yang terintegrasi dengan sistem existing, bukan membuat aplikasi baru yang terpisah tanpa alasan.

Misi utamanya adalah membuat personal AI assistant yang, dengan izin dan persetujuan saya, dapat:

1. Melacak lokasi saya secara real-time ketika saya bepergian.
2. Memahami konteks perjalanan, seperti di rumah, di jalan, di kantor, di mal, di SPBU, di warung makan, atau di lokasi yang belum dikenal.
3. Menghitung durasi saya berada di sebuah tempat, jarak perjalanan, dan riwayat aktivitas harian.
4. Membantu mendeteksi kemungkinan kecelakaan atau kondisi darurat dan menjalankan prosedur respons otomatis yang sudah saya setujui.
5. Memantau estimasi konsumsi bahan bakar, jarak tempuh, odometer, dan jadwal perawatan motor.
6. Mempelajari kebiasaan serta koreksi saya dari waktu ke waktu agar rekomendasi dan prediksi semakin personal.
7. Memberikan notifikasi proaktif yang berguna tanpa menunggu saya membuka chatbot dan bertanya terlebih dahulu.

**Prinsip utama:** sistem harus benar-benar berfungsi, aman, dapat diuji, transparan mengenai tingkat akurasi, serta menggunakan data dan integrasi yang nyata. Jangan membuat mockup seolah-olah sudah menjadi fitur produksi.

## 2. TAHAP PERTAMA: AUDIT SISTEM EXISTING

Sebelum menulis atau mengubah kode, lakukan audit menyeluruh terhadap repository dan environment proyek yang tersedia.

Periksa:

- Bahasa pemrograman dan framework frontend/backend.
- Struktur direktori, entry point, modul, layanan, dan dependency.
- Database, skema, migration, autentikasi, otorisasi, dan penyimpanan file.
- Arsitektur personal AI agent, model AI, sistem tools/function calling, memory, dan background jobs.
- Integrasi Telegram, email, push notification, maps, dan layanan pihak ketiga yang sudah tersedia.
- Deployment, VPS, Docker, reverse proxy, konfigurasi domain, logging, dan monitoring.
- Mekanisme realtime yang sudah digunakan, misalnya WebSocket, Server-Sent Events, atau layanan realtime yang telah tersedia.
- Sistem keamanan serta penggunaan environment variables dan secret management.

Jangan mengasumsikan teknologi tertentu sudah tersedia apabila belum ditemukan di repository.

Setelah audit, buat ringkasan singkat mengenai kondisi sistem, komponen yang bisa digunakan kembali, dependensi baru yang diperlukan, keterbatasan platform, dan rencana implementasi.

Setelah itu, lanjutkan implementasi secara bertahap. Jangan berhenti hanya pada analisis atau rencana jika pekerjaan dapat dilanjutkan dengan aman.

**Ketentuan:**
- Jangan melakukan rewrite seluruh aplikasi tanpa alasan teknis yang kuat.
- Jangan menghapus fitur existing yang masih berfungsi.
- Jangan merusak konfigurasi produksi, database, atau data pengguna.
- Buat backup atau gunakan migration yang aman sebelum perubahan berisiko.
- Jangan memasukkan API key, password, token, maupun informasi rahasia ke source code atau log.
- Jangan mengklaim fitur sudah selesai sebelum benar-benar diuji.

## 3. FITUR A — REAL-TIME LOCATION TRACKING

Bangun sistem pelacakan lokasi personal yang terintegrasi dengan AI agent.

### A.1. Lokasi terkini

Dengan persetujuan dan permission yang sesuai, sistem dapat menerima dan menampilkan:

- Latitude dan longitude.
- Alamat atau area perkiraan.
- Akurasi GPS dalam meter.
- Kecepatan dan arah perjalanan apabila tersedia.
- Waktu pembaruan lokasi terakhir.
- Status pergerakan: bergerak, berhenti sementara, atau diam dalam waktu lama.
- Jarak perjalanan saat ini.
- Status konektivitas dan kualitas data lokasi.

Tampilkan status dengan jelas. Apabila lokasi sudah kedaluwarsa, GPS tidak akurat, perangkat offline, atau permission dicabut, nyatakan kondisi tersebut. Jangan menampilkan lokasi lama seolah-olah merupakan posisi terkini.

### A.2. Mekanisme tracking

Tentukan arsitektur tracking yang sesuai dengan aplikasi existing.

Apabila browser atau PWA tidak dapat memenuhi kebutuhan background tracking, evaluasi kebutuhan aplikasi mobile native atau komponen mobile pendamping. Jangan beranggapan bahwa website yang berjalan di server dapat mengetahui posisi GPS perangkat secara mandiri.

Implementasikan:

- Permission dan persetujuan eksplisit dari pengguna.
- Penjelasan yang mudah dipahami tentang tujuan pengumpulan lokasi.
- Pelacakan foreground dan background sesuai dukungan OS.
- Interval pembaruan adaptif sesuai kecepatan, kondisi perangkat, dan konsumsi baterai.
- Pengelolaan ketika GPS hilang, jaringan putus, perangkat offline, atau aplikasi ditutup.
- Pengiriman ulang data yang tertunda ketika jaringan kembali tersedia.
- Tombol mulai, jeda, lanjutkan, dan berhenti melacak.
- Indikator tracking yang sedang aktif.
- Pencegahan duplikasi titik lokasi dan penyaringan GPS yang menyimpang.

Gunakan interval tracking yang dapat dikonfigurasi. Sebagai nilai awal untuk diuji, evaluasi pembaruan sekitar 5–15 detik saat perjalanan dan interval lebih panjang ketika perangkat diam. Jangan menganggap nilai ini sebagai jaminan kemampuan background setiap perangkat.

### A.3. Peta dan riwayat rute

Sediakan peta interaktif yang memperlihatkan:

- Posisi terakhir saya.
- Rute perjalanan.
- Titik awal dan tujuan.
- Lokasi singgah.
- Durasi perjalanan dan berhenti.
- Jarak berdasarkan lintasan GPS.
- Waktu tiba dan berangkat.
- Akurasi serta kelengkapan data.

Bedakan jarak lintasan GPS, estimasi jarak jalan dari layanan routing, dan pembacaan odometer kendaraan. Ketiganya bukan nilai yang identik.

Gunakan layanan peta dan geocoding yang nyata dan sesuai dengan arsitektur existing. Pertimbangkan batas penggunaan API, lisensi data, biaya, privasi, dan kebutuhan caching.

## 4. FITUR B — AI MEMAHAMI AKTIVITAS DAN LOKASI

Tujuan saya bukan sekadar melihat titik koordinat. Saya ingin AI agent bisa memahami aktivitas saya berdasarkan bukti yang tersedia.

### B.1. Klasifikasi tempat otomatis

Ketika saya tiba atau berada di sebuah area, sistem mencoba mengklasifikasikan tempat tersebut, misalnya:

- Rumah.
- Kantor.
- Mal atau pusat perbelanjaan.
- SPBU.
- Restoran atau warung makan.
- Minimarket, termasuk Alfamart atau Indomaret apabila datanya tersedia.
- Bengkel.
- Kampus.
- Parkiran.
- Jalan raya.
- Area publik atau lokasi yang belum dikenal.

Gunakan kombinasi koordinat GPS, reverse geocoding, data tempat atau POI, geofence, riwayat pengguna, dan durasi keberadaan.

Buat sistem geofence yang dapat dikonfigurasi untuk rumah, kantor, serta tempat penting lain. Hindari penentuan tempat hanya berdasarkan nama terdekat ketika GPS tidak cukup akurat.

### B.2. Memahami konteks dan durasi

Contoh perilaku yang saya harapkan:

- Ketika saya berangkat dari rumah dan bergerak menuju kantor, sistem membuat ringkasan perjalanan.
- Ketika saya tiba di kantor, sistem mencatat perkiraan waktu kedatangan.
- Ketika saya berada di sebuah mal selama dua jam, sistem mencatat durasi kunjungan jika bukti lokasi mencukupi.
- Ketika saya berhenti di pinggir jalan atau lahan kosong, sistem tidak boleh mengarang bahwa saya sedang berada di mal, warung, atau minimarket.
- Ketika saya berhenti di tempat yang tidak diketahui, sistem menyimpan status seperti “berhenti di lokasi yang belum teridentifikasi”, beserta koordinat, akurasi, dan durasinya.
- Ketika saya mengoreksi bahwa lokasi tersebut adalah warung tertentu atau tempat membantu orang, sistem menyimpan koreksi tersebut sesuai pengaturan personal memory saya.

Bedakan berhenti sebentar karena lampu merah atau kemacetan dari berhenti untuk melakukan aktivitas. Gunakan gabungan durasi, kecepatan, pola GPS, dan konteks rute.

Klasifikasi AI harus memiliki tingkat keyakinan atau confidence. Apabila bukti tidak mencukupi, gunakan status “belum diketahui” dan jangan memaksakan kesimpulan.

### B.3. Laporan perjalanan otomatis

Sediakan ringkasan perjalanan harian, misalnya:

- Waktu meninggalkan rumah.
- Waktu tiba di kantor.
- Lama perjalanan.
- Total jarak perjalanan.
- Daftar persinggahan.
- Durasi di setiap tempat.
- Waktu berhenti yang belum dapat diidentifikasi.
- Perkiraan jarak yang ditempuh menggunakan motor.
- Informasi lokasi yang hilang atau tidak akurat.

Saya juga ingin dapat bertanya kepada AI agent:

“Sejak pagi saya pergi ke mana saja?”

“Berapa lama saya berada di kantor?”

“Berapa kilometer perjalanan saya hari ini?”

“Kemarin saya singgah di mana?”

“Berapa lama saya berhenti di lokasi terakhir?”

AI harus menjawab dari data tersimpan, menyertakan rentang waktu yang relevan, dan mengakui apabila datanya tidak lengkap.

## 5. FITUR C — POTENSI KECELAKAAN DAN EMERGENCY RESPONSE

Ini merupakan fitur keselamatan dengan prioritas tertinggi. Implementasikan secara hati-hati karena deteksi yang keliru dapat berakibat serius.

### C.1. Deteksi kemungkinan kecelakaan

Saya ingin sistem dapat mengenali kemungkinan kecelakaan ketika sedang melakukan perjalanan.

Namun, lokasi GPS atau tampilan peta saja tidak cukup untuk memastikan kecelakaan terjadi.

Audit kemungkinan penggunaan:

- Sensor accelerometer dan gyroscope perangkat, jika dapat diakses.
- Perubahan kecepatan yang sangat mendadak.
- Benturan atau perubahan orientasi yang tidak biasa.
- Kendaraan berhenti mendadak setelah sebelumnya bergerak.
- Perangkat tetap diam setelah anomali.
- Konteks perjalanan dan kualitas data sensor.
- Sinyal dari perangkat wearable atau perangkat kendaraan, jika tersedia dan benar-benar terintegrasi.

Jangan menyebut sistem ini memiliki kemampuan mendeteksi benturan jika perangkat tidak mengirimkan data sensor yang diperlukan. Posisi ponsel di saku, tas, atau dudukan motor juga dapat memengaruhi kualitas deteksi.

Buat sistem penilaian risiko yang menggabungkan beberapa sinyal, bukan hanya satu kondisi, dan sediakan konfigurasi sensitivitas.

### C.2. Prosedur konfirmasi keadaan darurat

Ketika sistem mendeteksi dugaan insiden dengan tingkat risiko tinggi:

1. Tampilkan peringatan yang jelas.
2. Keluarkan bunyi atau notifikasi apabila perangkat mendukungnya dan pengaturannya mengizinkan.
3. Mulai hitung mundur konfirmasi, misalnya 20–30 detik, yang dapat dikonfigurasi.
4. Berikan opsi besar dan mudah diakses: “Saya aman” dan “Butuh bantuan”.
5. Jika saya menyatakan aman, batalkan eskalasi dan catat kejadian untuk evaluasi.
6. Jika saya meminta bantuan atau tidak memberikan respons hingga hitung mundur selesai, jalankan prosedur eskalasi yang telah saya konfigurasi.
7. Catat waktu, alasan pemicu, tingkat keyakinan, lokasi terakhir, akurasi GPS, dan status pengiriman bantuan.

Buat perlindungan terhadap false positive, seperti berhenti di lampu merah, parkir, mengisi bensin, terjebak kemacetan, atau ponsel terjatuh tanpa kecelakaan motor.

Jika data sensor tidak tersedia, sistem boleh mendeteksi pola berhenti tidak biasa dan meminta konfirmasi, tetapi jangan menyatakan bahwa kecelakaan sudah terkonfirmasi.

### C.3. Menghubungi orang terdekat

Bangun konfigurasi kontak darurat yang memungkinkan saya menetapkan:

- Nama kontak.
- Nomor telepon.
- Hubungan dengan saya.
- Prioritas penghubungan.
- Kanal notifikasi yang tersedia.
- Persetujuan serta status verifikasi kontak.
- Ketentuan kapan kontak tersebut diberi tahu.

Apabila prosedur eskalasi terpicu, sistem mencoba mengirimkan notifikasi darurat melalui kanal yang benar-benar tersedia dan sudah dikonfigurasi, seperti SMS, push notification, atau layanan pesan yang mendukung integrasi.

Isi pesan darurat sekurang-kurangnya:

“Sistem mendeteksi kemungkinan keadaan darurat pada Wisnu. Mohon segera mencoba menghubunginya dan memeriksa kondisinya. Lokasi terakhir: [tautan peta]. Waktu: [timestamp]. Akurasi GPS: [akurasi]. Status terakhir: [status].”

Sertakan koordinat dan tautan peta yang valid jika tersedia. Bedakan posisi aktual terkini dengan lokasi terakhir yang berhasil diterima.

Jika kontak pertama tidak menerima atau kanal pengiriman gagal, gunakan mekanisme percobaan ulang serta eskalasi ke kontak berikutnya sesuai konfigurasi saya. Catat status pengiriman agar sistem tidak mengklaim pesan telah terkirim ketika provider gagal.

Sediakan simulasi dan mode pengujian darurat supaya pengembangan tidak mengirimkan pesan nyata kepada orang lain secara tidak sengaja.

Jangan mengandalkan AI model sebagai satu-satunya jalur keselamatan. Gunakan prosedur eskalasi yang deterministik, dapat diaudit, dan memiliki fallback ketika layanan AI tidak tersedia.

### C.4. Telepon otomatis dan batasan platform

Evaluasi kelayakan panggilan otomatis berdasarkan OS, izin perangkat, API telekomunikasi, dan ketentuan provider.

Jika panggilan otomatis tidak didukung atau tidak diizinkan, berikan alternatif yang dapat dijalankan, seperti SMS, notifikasi, membuka dialer untuk konfirmasi pengguna, atau layanan komunikasi resmi yang sesuai.

Jangan mengklaim bisa memaksa ponsel menelepon ketika perangkat terkunci, offline, kehabisan baterai, atau ketika OS membatasi tindakan tersebut.

Utamakan menghubungi kontak pribadi yang telah dikonfigurasi. Integrasi dengan layanan darurat resmi hanya boleh dilakukan jika tersedia, sesuai ketentuan layanan, dan telah dirancang secara benar. Jangan menguji panggilan darurat sungguhan tanpa prosedur resmi.

### C.5. Lokasi terakhir dan pemulihan setelah insiden

Simpan event log yang mencakup:

- Posisi sebelum dugaan insiden.
- Posisi saat anomali terdeteksi.
- Posisi terakhir yang valid.
- Timestamp setiap pembaruan.
- Perkiraan kecepatan dan perubahan gerak jika tersedia.
- Hasil konfirmasi pengguna.
- Daftar upaya pengiriman peringatan.
- Status respons kontak darurat.

Apabila perangkat kehilangan koneksi, kirimkan notifikasi dengan label waktu yang benar dan tandai bahwa lokasi tersebut adalah lokasi terakhir yang diketahui, bukan lokasi live.

Sistem tidak boleh menjanjikan pelacakan tanpa celah jika perangkat kehabisan baterai, GPS tidak tersedia, izin dicabut, atau jaringan terputus. Bangun fallback yang jujur dan teruji.

## 6. FITUR D — FUEL TRACKING DAN BIAYA BAHAN BAKAR

Saya menggunakan motor Honda Vario 160 CBS. Buat modul pemantauan konsumsi Pertamax dan biaya bahan bakar yang terintegrasi dengan riwayat perjalanan.

### D.1. Konfigurasi awal

Gunakan nilai awal yang dapat saya ubah:

- Kendaraan: Honda Vario 160 CBS.
- Bahan bakar: Pertamax.
- Baseline awal: 50 km per liter.
- Perhitungan jarak: berdasarkan lintasan GPS yang sudah difilter.
- Harga per liter: dapat diperbarui sesuai harga pembelian aktual.
- Koreksi konsumsi: berdasarkan riwayat pengisian dan jarak.

Nilai 50 km/liter adalah asumsi awal saya, bukan jaminan konsumsi aktual. Sistem harus dapat mengkalibrasi estimasi berdasarkan data nyata. Jangan mengubah baseline diam-diam.

### D.2. Fitur pencatatan bensin

Buat fitur untuk mencatat:

- Tanggal dan waktu pengisian.
- Odometer ketika mengisi.
- Jarak sejak pengisian sebelumnya.
- Jenis bahan bakar.
- Jumlah liter.
- Harga per liter.
- Total biaya.
- Apakah tangki diisi penuh atau hanya sebagian.
- SPBU atau lokasi pengisian jika diketahui.
- Catatan tambahan.

Data dapat diinput manual melalui chatbot, halaman web, atau form mobile. Jika provider pembayaran atau data transaksi tersedia, integrasikan hanya setelah akses dan formatnya diverifikasi.

### D.3. Estimasi konsumsi

Hitung estimasi pemakaian bahan bakar dari jarak perjalanan dan baseline yang dikonfigurasi.

Formula awal:

Estimasi liter terpakai = jarak sejak titik pengisian × konsumsi acuan dalam liter per kilometer.

Jika baseline dinyatakan dalam km/liter:

Estimasi liter terpakai = jarak tempuh ÷ konsumsi acuan km/liter.

Estimasi biaya = estimasi liter terpakai × harga per liter.

Gunakan rumus dan satuan yang konsisten. Validasi perhitungan dengan unit test.

Untuk pengisian full-to-full, hitung konsumsi aktual berdasarkan jarak dan liter yang diperlukan untuk mengisi kembali hingga penuh. Untuk pengisian sebagian, nyatakan konsumsi aktual sebagai belum dapat dipastikan jika data tidak memadai.

### D.4. Peringatan bahan bakar

Berikan notifikasi ketika:

- Estimasi konsumsi mendekati batas aman yang dikonfigurasi.
- Jarak perjalanan berikutnya berpotensi melampaui jangkauan yang diperkirakan.
- Saya mungkin perlu mengisi bensin sebelum melanjutkan perjalanan.
- Ada perbedaan besar antara estimasi dan riwayat pengisian aktual.

Jangan memberikan angka sisa bensin yang terkesan pasti jika tidak ada sensor level bahan bakar yang terintegrasi. Bedakan antara “estimasi liter terpakai”, “perkiraan sisa berdasarkan model”, dan “level bahan bakar aktual dari sensor”.

Sediakan koreksi manual untuk kondisi macet, jalan menanjak, perjalanan pendek, beban kendaraan, dan faktor lain yang memengaruhi konsumsi.

## 7. FITUR E — ODOMETER DAN MAINTENANCE MOTORCYCLE

Saya ingin AI agent menjadi asisten pemeliharaan motor yang mengingat jadwal perawatan berdasarkan kilometer, waktu, dan riwayat servis.

### E.1. Pencatatan odometer

Simpan:

- Pembacaan odometer terakhir.
- Tanggal pembacaan.
- Jarak yang dihitung GPS sejak pembacaan tersebut.
- Pembacaan odometer manual berikutnya.
- Riwayat servis dan odometer saat servis.
- Sumber data dan tingkat keyakinan untuk setiap pembacaan.

Jangan menganggap total odometer kendaraan dapat dibaca secara otomatis hanya melalui Google Maps atau GPS. GPS dapat memperkirakan jarak perjalanan, sedangkan total odometer membutuhkan pembacaan langsung, input pengguna, atau integrasi sensor kendaraan yang kompatibel.

Jangan menjumlahkan jarak GPS ke total odometer tanpa aturan kalibrasi dan pemeriksaan duplikasi.

### E.2. Jadwal perawatan

Buat maintenance tracker untuk komponen berikut, sesuai rekomendasi resmi yang cocok dengan model, tahun kendaraan, dan pasar Indonesia:

- Oli mesin.
- Oli gardan atau final gear oil.
- CVT, termasuk pemeriksaan komponen dan penggantian bagian sesuai jadwal.
- Filter udara.
- Busi.
- Sistem rem dan minyak rem.
- Ban, tekanan, keausan, serta kondisi tapak.
- Aki.
- Sistem pendingin dan coolant.
- Sistem lampu dan kelistrikan.
- Komponen lain yang relevan berdasarkan buku pedoman pemilik.

Sebelum menetapkan interval perawatan, telusuri dan verifikasi manual atau sumber resmi Honda yang sesuai. Jangan mengarang interval kilometer, jumlah oli, spesifikasi oli, ataupun masa pakai komponen.

Buat jadwal setiap item dapat dikonfigurasi menggunakan:

- Interval kilometer.
- Interval waktu.
- Tanggal servis terakhir.
- Odometer saat servis.
- Target servis berikutnya.
- Bengkel dan biaya servis.
- Bukti atau catatan pekerjaan yang dilakukan.
- Status: aman, mendekati jadwal, terlambat, atau perlu pemeriksaan.

Apabila jadwal berbasis waktu dan kilometer sama-sama berlaku, gunakan pemicu mana yang tercapai lebih dahulu sesuai panduan resmi yang terverifikasi.

### E.3. Sistem pengingat proaktif

Contoh perilaku:

- “Oli mesin mendekati jadwal penggantian berdasarkan data servis dan odometer terakhir.”
- “Jarak GPS Anda hari ini sekitar X km; angka ini berbeda dari pembacaan odometer aktual.”
- “Ban belakang dilaporkan aus pada pemeriksaan terakhir. Sebaiknya prioritaskan pemeriksaan karena kondisi ban berkaitan langsung dengan keselamatan.”
- “Jadwal pemeriksaan CVT sudah mendekati interval sesuai pedoman yang tersimpan.”
- “Catatan odometer belum diperbarui selama beberapa minggu. Periksa angka aktual pada panel motor untuk meningkatkan akurasi.”

Jangan menyatakan komponen aman hanya berdasarkan jadwal digital. Sistem hanya mengelola catatan dan pengingat, bukan menggantikan inspeksi mekanis oleh teknisi.

Buat laporan kesehatan kendaraan yang menunjukkan item yang sudah jatuh tempo, item yang akan datang, item tanpa data yang memadai, serta rekomendasi tindakan.

## 8. FITUR F — PERSONAL MEMORY DAN PEMBELAJARAN BERKELANJUTAN

Saya ingin personal AI agent mempelajari rutinitas serta preferensi saya dari waktu ke waktu agar semakin relevan.

Namun, implementasi pembelajaran harus nyata, terukur, dan dapat dikontrol. Jangan hanya menambahkan slogan “AI belajar setiap hari”.

Implementasikan lapisan personal memory yang terdiri atas:

1. Event history dari perjalanan, singgah, pengisian bensin, dan perawatan.
2. Preferensi pengguna, seperti tempat favorit dan pola notifikasi.
3. Koreksi klasifikasi lokasi.
4. Pola rutinitas yang memiliki dukungan data cukup.
5. Ringkasan aktivitas harian dan mingguan.
6. Evaluasi prediksi serta feedback pengguna.
7. Versi data dan histori perubahan yang dapat diaudit.

Gunakan retrieval dari database atau memory store sebagai konteks ketika AI menjawab pertanyaan. Bangun job terjadwal untuk merangkum pola, menghitung statistik, mengevaluasi prediksi, dan memperbarui model preferensi secara terkendali.

Jangan menganggap penyimpanan histori otomatis berarti bobot model AI telah dilatih ulang. Fine-tuning atau online training adalah pekerjaan berbeda dan hanya boleh dilakukan jika benar-benar diperlukan, memiliki data yang sesuai, dan memberikan manfaat yang terukur.

Contoh pembelajaran:

- Saya sering berangkat menuju kantor pada rentang waktu tertentu. Setelah data cukup, sistem dapat memperkirakan waktu perjalanan.
- Saya mengoreksi bahwa suatu koordinat merupakan warung makan yang sering saya kunjungi. Sistem menyimpan koreksi yang sudah disetujui.
- Catatan isi bensin menunjukkan estimasi konsumsi berbeda dari baseline awal. Sistem dapat mengusulkan kalibrasi berdasarkan data yang cukup.
- Saya sering mengabaikan notifikasi tertentu. Sistem dapat mengusulkan perubahan preferensi, tetapi jangan mengubah pengaturan penting secara diam-diam.
- Perawatan dilakukan pada tanggal atau odometer tertentu. Sistem menyesuaikan pengingat berikutnya berdasarkan data dan interval resmi.

Setiap prediksi harus mempertimbangkan jumlah data, kualitas data, dan ketidakpastian. Jangan mengambil kesimpulan kuat dari satu atau dua kejadian yang belum cukup mewakili kebiasaan saya.

Sediakan kontrol untuk:
- Melihat memory yang tersimpan.
- Memperbaiki fakta atau klasifikasi.
- Menghapus memory tertentu.
- Menghapus riwayat lokasi.
- Mengatur lama retensi data.
- Menghentikan sementara pengumpulan data.
- Menonaktifkan personalisasi tertentu.
- Mengekspor data pribadi.
- Menghapus data sesuai ketentuan yang berlaku.

Jangan menggunakan riwayat lokasi pribadi untuk melatih model eksternal atau membagikannya kepada pihak lain tanpa persetujuan yang sesuai.

## 9. FITUR G — AI PROAKTIF DAN NOTIFIKASI

Integrasikan seluruh modul dengan orchestration layer AI agent existing.

AI harus dapat mengambil keputusan berdasarkan data aktual yang tersedia, bukan sekadar menghasilkan jawaban bahasa alami.

Gunakan contoh notifikasi berikut sebagai acuan:

- “Perjalanan dimulai. Lokasi awal berhasil direkam.”
- “Anda mungkin sudah tiba di kantor. Apakah ingin mengonfirmasi lokasi ini?”
- “Anda berhenti di area yang belum teridentifikasi selama beberapa menit.”
- “Perkiraan jarak perjalanan hari ini mencapai X km.”
- “Berdasarkan baseline konsumsi bahan bakar, estimasi pemakaian hari ini adalah X liter. Ini bukan pembacaan sensor bensin aktual.”
- “Ada indikasi anomali gerak yang perlu dikonfirmasi. Apakah Anda aman?”
- “Jadwal perawatan kendaraan mendekati batas berdasarkan catatan yang tersedia.”

Gunakan kanal yang benar-benar tersedia dalam aplikasi, seperti dashboard, Telegram, push notification, atau email sesuai integrasi yang sudah dikonfigurasi.

Berikan pengaturan untuk mengendalikan frekuensi notifikasi, jam tenang, tingkat urgensi, dan notifikasi yang perlu dikirimkan segera.

Peringatan darurat harus mempunyai jalur prioritas sendiri dan tidak boleh tertahan oleh antrean notifikasi rutin.

Jangan mengirimkan notifikasi berulang tanpa batas, dan jangan mengirim pesan kepada kontak darurat untuk kejadian simulasi atau anomali berisiko rendah.

## 10. ARSITEKTUR, DATABASE, DAN REALTIME

Rancang modul dengan batas tanggung jawab yang jelas. Sesuaikan dengan bahasa, framework, dan infrastruktur proyek existing.

Komponen logis yang perlu dievaluasi:

- Location ingestion service.
- Geospatial processing dan place classification.
- Trip tracking dan trip summarization.
- Geofence management.
- Emergency detection dan escalation engine.
- Emergency contact management.
- Fuel log dan consumption estimator.
- Odometer tracking.
- Maintenance schedule dan service history.
- Personal memory dan learning jobs.
- Notification service.
- Realtime event delivery.
- Audit log, monitoring, dan administration.

Buat model data yang mencakup entitas terkait, misalnya:

- User privacy preferences dan tracking sessions.
- Location samples.
- Trips dan trip stops.
- Places dan geofences.
- Emergency events dan escalation attempts.
- Emergency contacts.
- Fuel fill-ups dan fuel estimates.
- Odometer readings.
- Vehicle maintenance schedules dan service records.
- Personal memories dan user corrections.
- Notification history.
- Audit logs.

Nama dan struktur final harus mengikuti pola database existing. Hindari membuat tabel duplikat jika entitas serupa sudah tersedia.

### Persyaratan teknis

- Validasi input di backend.
- Autentikasi dan otorisasi setiap endpoint.
- Akses data antar pengguna harus terisolasi.
- Gunakan timezone yang benar dan simpan waktu secara konsisten.
- Tambahkan indeks untuk query lokasi, timestamp, user, dan riwayat perjalanan sesuai kebutuhan.
- Tangani data duplikat, event yang datang terlambat, dan pengiriman ulang.
- Terapkan rate limiting serta perlindungan terhadap spam notifikasi.
- Pisahkan pemrosesan darurat dari proses AI yang berpotensi lambat.
- Gunakan retry, idempotency, dan logging yang sesuai.
- Sediakan health checks serta monitoring untuk layanan kritis.
- Gunakan migration yang aman dan terdokumentasi.
- Sediakan konfigurasi yang tidak memerlukan secret di repository.
- Jangan menambahkan dependency berbayar sebelum memeriksa kebutuhan, biaya, batas penggunaan, dan alternatif yang layak.

Realtime berarti sistem dapat menerima event baru, memperbarui dashboard, dan menjalankan logika yang diperlukan dengan latensi yang terukur. Jangan menyamakan realtime dengan jaminan bahwa semua data GPS selalu tersedia setiap detik.

## 11. KEAMANAN DAN PRIVASI

Karena aplikasi menyimpan lokasi, aktivitas, dan informasi darurat yang sensitif, terapkan privacy-by-design.

Persyaratan minimal:

- Persetujuan yang jelas sebelum tracking dimulai.
- Pengumpulan data sesuai tujuan dan kebutuhan.
- Permission OS yang tepat dan penjelasan background location.
- Enkripsi data ketika dikirimkan serta perlindungan penyimpanan sesuai kemampuan infrastruktur.
- Kontrol akses berbasis peran dan identitas pengguna.
- Proteksi terhadap pencurian sesi dan akses endpoint yang tidak sah.
- Pengelolaan secret melalui environment atau secret manager.
- Redaksi koordinat serta data pribadi dari log umum.
- Retensi dan penghapusan data yang terdefinisi.
- Audit setiap kejadian darurat dan tindakan otomatis.
- Verifikasi kontak sebelum aktivasi emergency workflow.
- Perlindungan terhadap manipulasi lokasi dan input yang tidak valid.
- Kebijakan backup yang tidak menyimpan data yang sudah dihapus secara permanen tanpa alasan yang sah.

Batasi akses terhadap lokasi live dan riwayat perjalanan hanya untuk pengguna atau pihak yang diberi wewenang. Jangan mengaktifkan pelacakan tersembunyi.

Sediakan dokumentasi tentang izin, data yang dikumpulkan, tujuan pemrosesan, pihak ketiga yang menerima data, dan prosedur penghentian tracking.

## 12. TESTING DAN ACCEPTANCE CRITERIA

Jangan menyelesaikan pekerjaan hanya karena halaman dashboard dapat ditampilkan.

Buat unit test, integration test, dan end-to-end test yang relevan.

### Skenario 1 — Perjalanan rutin

Saya meninggalkan rumah dan menuju kantor.

Hasil yang diharapkan:
- Tracking hanya aktif sesuai persetujuan.
- Titik lokasi masuk ke backend.
- Rute dan jarak perjalanan tercatat.
- Sistem mengklasifikasikan perjalanan dengan tingkat keyakinan yang masuk akal.
- Perkiraan kedatangan dan ringkasan perjalanan dihasilkan jika data cukup.

### Skenario 2 — Berhenti di lokasi tidak dikenal

Saya berhenti di lahan kosong selama beberapa menit untuk membantu seseorang.

Hasil yang diharapkan:
- Sistem mendeteksi bahwa pergerakan berhenti.
- Lokasi beserta durasi dan akurasi GPS dicatat.
- Sistem tidak mengarang nama tempat.
- AI menyatakan lokasi belum teridentifikasi sampai ditemukan bukti tambahan atau koreksi pengguna.

### Skenario 3 — Mengunjungi mal

Saya memasuki sebuah pusat perbelanjaan dan berada di sana selama beberapa jam.

Hasil yang diharapkan:
- Sistem memadukan geofence, data tempat, dan waktu keberadaan.
- Waktu tiba dan berangkat dihitung.
- Durasi kunjungan disimpan dengan ketidakpastian yang sesuai.
- Sistem tidak menghitung masuk dan keluar dari batas geofence secara keliru.

### Skenario 4 — Dugaan kecelakaan

Simulasikan anomali gerak saat perjalanan.

Hasil yang diharapkan:
- Sistem mendeteksi kondisi berdasarkan sinyal yang tersedia.
- Countdown konfirmasi bekerja.
- Jika saya memilih “Saya aman”, tidak ada eskalasi darurat.
- Jika saya memilih “Butuh bantuan”, kontak terpilih mendapat pemberitahuan melalui kanal uji.
- Jika tidak ada respons, eskalasi berlangsung sesuai konfigurasi dan kemampuan platform.
- Lokasi terakhir memiliki timestamp dan akurasi yang benar.
- Tidak ada klaim bahwa panggilan atau pesan berhasil jika provider gagal.

Seluruh pengujian menggunakan kontak dan endpoint simulasi sampai proses aktivasi produksi dikonfirmasi.

### Skenario 5 — Tracking offline

GPS dan koneksi internet terputus saat perjalanan.

Hasil yang diharapkan:
- Dashboard menampilkan status lokasi terakhir.
- Data lama tidak ditampilkan sebagai posisi live.
- Sistem menangani data tertunda dan sinkronisasi ulang saat koneksi pulih.
- Event darurat tetap dicatat apabila dapat diproses secara lokal, sesuai dukungan platform.

### Skenario 6 — Bahan bakar

Catat pengisian Pertamax, jarak tempuh, dan biaya.

Hasil yang diharapkan:
- Estimasi liter dan biaya dihitung dengan rumus yang benar.
- Pengisian sebagian dibedakan dari pengisian full-to-full.
- Baseline konsumsi dapat diubah.
- Sistem tidak mengklaim level bensin aktual tanpa sensor yang mendukungnya.

### Skenario 7 — Maintenance

Tambahkan pembacaan odometer dan satu riwayat penggantian oli.

Hasil yang diharapkan:
- Riwayat tersimpan dengan benar.
- Jadwal berikutnya memakai interval yang terverifikasi.
- Notifikasi tidak muncul berulang secara tidak terkendali.
- Perkiraan jarak GPS tidak salah dianggap sebagai odometer aktual.

### Skenario 8 — Privacy dan security

Uji:
- Permission dicabut.
- Tracking dihentikan.
- Pengguna tidak berwenang mencoba membaca lokasi.
- Token atau secret tidak tersedia.
- Permintaan duplikat.
- Data malformed.
- Permintaan penghapusan riwayat.
- Akses kontak darurat yang tidak diizinkan.

Pastikan semua hasil pengujian dicatat dan kegagalan kritis diperbaiki sebelum menyatakan fitur siap produksi.

## 13. DELIVERABLE YANG WAJIB

Setelah implementasi, berikan:

1. Ringkasan perubahan dan arsitektur yang dibuat.
2. Daftar file baru dan file existing yang diubah.
3. Migration dan perubahan database.
4. Daftar endpoint serta kontrak API.
5. Flow event realtime dan emergency escalation.
6. Dependensi baru berikut alasan pemilihannya.
7. Daftar environment variables yang diperlukan dalam format contoh tanpa secret nyata.
8. Instruksi instalasi dan deployment sesuai environment existing.
9. Daftar permission mobile dan keterbatasan platform.
10. Hasil unit test, integration test, dan end-to-end test.
11. Daftar fitur yang benar-benar berfungsi.
12. Daftar fitur yang belum berfungsi beserta alasan teknis dan dependensi yang belum tersedia.
13. Estimasi biaya operasional bulanan untuk layanan pihak ketiga jika ada.
14. Panduan konfigurasi kontak darurat, geofence, baseline bahan bakar, dan maintenance.
15. Dokumentasi monitoring, backup, rollback, dan troubleshooting.

Pisahkan status menjadi:
- **Implemented:** kode sudah dibuat.
- **Tested:** sudah dijalankan dan hasilnya tercatat.
- **Ready for configuration:** menunggu credential, permission, perangkat, atau konfigurasi pengguna.
- **Blocked:** belum dapat berjalan karena keterbatasan API, OS, perangkat, atau dependensi.
- **Production-ready:** hanya jika persyaratan keselamatan, keamanan, konfigurasi, dan acceptance test terkait sudah terpenuhi.

Jangan memberi label production-ready hanya karena build berhasil.

## 14. URUTAN PRIORITAS PENGEMBANGAN

Kerjakan dengan urutan berikut:

**P0 — Fondasi**
Audit repository, threat model, persetujuan tracking, model data, dan rencana implementasi.

**P1 — Location MVP**
Tracking lokasi, peta realtime, riwayat perjalanan, status lokasi terakhir, dan klasifikasi tempat.

**P2 — Personal activity intelligence**
Trip summaries, geofence, durasi singgah, koreksi lokasi, dan personal memory.

**P3 — Emergency response**
Deteksi anomali, countdown konfirmasi, manajemen kontak, notifikasi darurat, retry, audit, dan simulasi.

**P4 — Motorcycle care**
Fuel tracking, estimator konsumsi, riwayat pengisian, odometer, maintenance schedule, dan pengingat.

**P5 — Continuous improvement**
Statistik personal, evaluasi kualitas prediksi, kalibrasi konsumsi, laporan berkala, dan optimalisasi notifikasi.

Sesuaikan urutan apabila audit menunjukkan dependensi teknis tertentu harus diselesaikan lebih dahulu. Keselamatan dan keamanan tidak boleh ditunda hanya demi mempercepat demo.

## 15. INSTRUKSI PENUTUP

Mulai dengan memeriksa sistem existing secara nyata.

Pilih solusi yang paling masuk akal berdasarkan repository, perangkat yang didukung, anggaran operasional, keamanan, dan kebutuhan jangka panjang.

Jangan langsung menambahkan banyak framework baru atau memindahkan seluruh aplikasi ke arsitektur berbeda jika tidak dibutuhkan.

Jangan berhenti pada mockup, pseudocode, atau penjelasan konseptual. Implementasikan fitur secara bertahap, jalankan test, dokumentasikan hasilnya, dan pastikan setiap integrasi yang digunakan memang benar-benar tersedia.

Jika membutuhkan layanan pihak ketiga, sensor perangkat, API key, izin OS, atau konfigurasi yang belum tersedia, identifikasi kebutuhan tersebut dengan spesifik dan buat mekanisme fallback yang layak.

**Hasil akhir yang saya inginkan:** personal AI agent yang semakin memahami konteks keseharian saya, membantu mengelola perjalanan dan perawatan motor, memberikan informasi yang akurat, serta memiliki prosedur respons darurat yang dapat diandalkan sejauh kemampuan perangkat dan integrasinya benar-benar mendukung.
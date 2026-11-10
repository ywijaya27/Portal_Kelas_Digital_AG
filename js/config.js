// ============================================================
// KONFIGURASI FRONTEND — Portal Kelas Digital
// ============================================================
// INSTRUKSI: Ganti nilai GAS_URL dengan URL deployment GAS Anda
// setelah menjalankan setupAppEnvironment() dan melakukan Deploy
// sebagai Web App di Google Apps Script.
//
// JANGAN simpan kredensial lain di file ini!
// Semua token/secret harus di Script Properties (backend).
// ============================================================

const GAS_URL = 'YOUR_GAS_DEPLOYMENT_URL_HERE';
// Contoh: 'https://script.google.com/macros/s/AKfycbyP2v-dKGb7SYU-RgKOeBkEVY3gm_m0YkLc7YShr7-26w4dVft7WkvAjyCxWEfocfU5/exec'

// Google OAuth Client ID (aman untuk frontend — ini public key)
const GOOGLE_CLIENT_ID = '284236973062-p0c55vodp26pei9a4vhufhtb213g8h4k.apps.googleusercontent.com';

// Versi aplikasi (untuk cache busting)
const APP_VERSION = '1.0.0';

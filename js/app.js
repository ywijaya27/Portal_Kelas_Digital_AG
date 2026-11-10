/**
 * app.js - File JavaScript Utama Portal Kelas Digital SPA
 * Arsitektur: SPA murni client-side, komunikasi backend via fetch() ke GAS URL
 * Pattern: gas-pro-api + gas-instant-ux + gas-scale-turbo
 */

'use strict';

// ============================================================
// KONFIGURASI & KONSTANTA
// ============================================================

/** URL backend Google Apps Script — dibaca dari config.js */
/** Ambil URL backend Google Apps Script secara dinamis & aman */
function getGasUrl() {
  const url = (typeof window !== 'undefined' && window.GAS_URL) || 
              (typeof GAS_URL !== 'undefined' ? GAS_URL : '') || '';
  if (url && url.startsWith('http') && !url.includes('YOUR_GAS_DEPLOYMENT_URL_HERE')) {
    return url;
  }
  return 'https://script.google.com/macros/s/AKfycbyP2v-dKGb7SYU-RgKOeBkEVY3gm_m0YkLc7YShr7-26w4dVft7WkvAjyCxWEfocfU5/exec';
}

/** Durasi countdown checkout (24 jam dalam ms) */
const CHECKOUT_DURATION_MS = 24 * 60 * 60 * 1000;

/** Debounce delay untuk pencarian (ms) */
const SEARCH_DEBOUNCE_MS = 300;

/** Kunci penyimpanan sesi di localStorage */
const SESSION_KEY = 'portal_session';
const THEME_KEY = 'theme';

// ============================================================
// STATE APLIKASI (In-Memory + localStorage)
// ============================================================

/**
 * State pusat aplikasi — JANGAN akses localStorage berulang,
 * baca/tulis melalui helper di bawah.
 */
const appState = {
  user: null,           // { email, name, role, token }
  theme: 'system',      // 'light' | 'dark' | 'system'
  currentSection: 'login',
  catalog: null,        // cache data katalog
  myCourses: null,      // cache kelas milik member
  currentCourse: null,  // kelas yang sedang dilihat
  currentLesson: null,  // pelajaran yang sedang dilihat
  adminData: {}         // berbagai data admin
};

// Ekspos ke window agar bisa diakses dari HTML inline (opsional)
window.appState = appState;

// ============================================================
// IN-FLIGHT REQUEST DEDUPLICATION (gas-scale-turbo)
// ============================================================

/** Map request yang sedang berjalan agar tidak duplikat */
const _inflight = {};

/** Epoch tulis — setiap write operasi increment angka ini */
let _writeEpoch = 0;

/**
 * Wrapper API cerdas: deduplication untuk GET, langsung POST untuk write.
 * @param {string} action - Nama action GAS
 * @param {object} data - Data request
 * @param {boolean} isWrite - true jika operasi tulis (POST)
 * @returns {Promise<any>}
 */
async function api(action, data = {}, isWrite = false) {
  if (isWrite) {
    _writeEpoch++;
    return apiPost(action, data);
  }
  const cacheKey = `${_writeEpoch}|${action}|${JSON.stringify(data)}`;
  if (_inflight[cacheKey]) return _inflight[cacheKey];
  const promise = apiGet(action, data);
  _inflight[cacheKey] = promise;
  promise.then(
    () => delete _inflight[cacheKey],
    () => delete _inflight[cacheKey]
  );
  return promise;
}

// ============================================================
// API HELPERS (gas-pro-api pattern)
// ============================================================

/**
 * Kirim GET request ke GAS backend.
 * @param {string} action - Nama action
 * @param {object} params - Query parameters tambahan
 * @returns {Promise<any>}
 */
async function apiGet(action, params = {}) {
  const url = new URL(getGasUrl());
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

/**
 * Kirim POST request ke GAS backend.
 * Content-Type harus text/plain agar CORS GAS tidak diblokir.
 * @param {string} action - Nama action
 * @param {object} data - Body request
 * @returns {Promise<any>}
 */
async function apiPost(action, data = {}) {
  const res = await fetch(getGasUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...data })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// ============================================================
// HELPER AUTH
// ============================================================

/** Ambil token sesi dari state atau localStorage */
function getToken() {
  return appState.user?.token || localStorage.getItem('session_token');
}

/** Cek apakah pengguna sudah login */
function isLoggedIn() {
  return !!getToken();
}

/** Cek apakah pengguna adalah admin */
function isAdmin() {
  return appState.user?.role === 'admin';
}

/** Cek apakah pengguna adalah member */
function isMember() {
  return appState.user?.role === 'member';
}

// ============================================================
// TEMA (Light / Dark / System)
// ============================================================

/**
 * Terapkan tema ke dokumen dan simpan ke localStorage.
 * @param {'light'|'dark'|'system'} mode
 */
function setTheme(mode) {
  appState.theme = mode;
  localStorage.setItem(THEME_KEY, mode);

  if (mode === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', mode);
  }

  // Perbarui tombol toggle tema jika ada
  document.querySelectorAll('[data-theme-btn]').forEach(btn => {
    btn.setAttribute('data-theme-btn', mode);
  });
}

/** Inisialisasi tema saat halaman pertama dimuat */
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'system';
  setTheme(saved);

  // Dengarkan perubahan preferensi sistem
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (appState.theme === 'system') setTheme('system');
  });
}

// ============================================================
// NAVIGASI SPA (0ms delay)
// ============================================================

/** Daftar section yang membutuhkan login */
const AUTH_REQUIRED_SECTIONS = [
  'dashboard-member', 'kelas-saya', 'ruang-belajar',
  'dashboard-admin', 'admin-pembayaran',
  'admin-kelas', 'admin-anggota', 'admin-crm', 'admin-pengumuman'
];

/** Daftar section khusus admin */
const ADMIN_ONLY_SECTIONS = [
  'dashboard-admin', 'admin-pembayaran', 'admin-kelas',
  'admin-anggota', 'admin-crm', 'admin-pengumuman'
];

/**
 * Navigasi ke section tertentu tanpa page reload.
 * @param {string} sectionId - ID section tujuan
 * @param {object} params - Parameter tambahan (mis. lessonId, courseId)
 */
function navigateTo(sectionId, params = {}) {
  // Guard: section yang memerlukan login
  if (AUTH_REQUIRED_SECTIONS.includes(sectionId) && !isLoggedIn()) {
    navigateTo('login');
    return;
  }

  // Guard: section khusus admin
  if (ADMIN_ONLY_SECTIONS.includes(sectionId) && !isAdmin()) {
    navigateTo('dashboard-member');
    return;
  }

  // Sembunyikan semua section
  document.querySelectorAll('.content-section').forEach(el => {
    el.classList.remove('active');
    el.style.display = 'none';
  });

  // Tampilkan section target
  const target = document.getElementById(`section-${sectionId}`);
  if (target) {
    target.style.display = '';
    target.classList.add('active');
  }

  // Perbarui sidebar active state
  document.querySelectorAll('[data-nav-link]').forEach(link => {
    link.classList.toggle('active', link.getAttribute('data-nav-link') === sectionId);
  });

  // Perbarui URL hash tanpa reload
  history.pushState({ section: sectionId, params }, '', `#${sectionId}`);

  // Simpan section aktif
  appState.currentSection = sectionId;

  // Tutup sidebar mobile setelah navigasi
  closeSidebar();

  // Muat data sesuai section yang dituju
  loadSectionData(sectionId, params);
}

/**
 * Muat data yang diperlukan untuk section tertentu.
 * @param {string} sectionId
 * @param {object} params
 */
async function loadSectionData(sectionId, params = {}) {
  switch (sectionId) {
    case 'katalog':
      await loadCatalog();
      break;
    case 'dashboard-member':
      await loadMemberDashboard();
      break;
    case 'kelas-saya':
      await loadMyCourses();
      break;
    case 'ruang-belajar':
      if (params.lessonId) await loadLesson(params.lessonId);
      break;
    case 'checkout':
      if (params.courseId) await initCheckout(params.courseId);
      break;
    case 'dashboard-admin':
      await loadAdminDashboard();
      break;
    case 'admin-pembayaran':
      await loadAdminOrders();
      break;
    case 'admin-kelas':
      await loadAdminCourses();
      break;
    case 'admin-anggota':
      await loadAdminMembers();
      break;
    case 'admin-crm':
      await loadCRM();
      break;
    case 'profil':
      updateUserProfileUI();
      break;
  }
}

/** Inisialisasi event listener navigasi */
/** Perbarui tampilan profil pengguna di sidebar dan seksi profil */
function updateUserProfileUI() {
  const user = appState.user;
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  const pName = document.getElementById('profile-name');
  const pEmail = document.getElementById('profile-email');
  const pBadge = document.getElementById('profile-badge');
  const pLoginBtn = document.getElementById('profile-login-btn');
  const pLogoutBtn = document.getElementById('profile-logout-btn');

  if (user) {
    if (nameEl) nameEl.textContent = user.name || 'Member';
    if (roleEl) roleEl.textContent = user.role === 'admin' ? 'Administrator' : 'Member Aktif';
    if (pName) pName.value = user.name || '';
    if (pEmail) pEmail.value = user.email || '';
    if (pBadge) {
      pBadge.textContent = user.role === 'admin' ? 'Administrator' : 'Member Terdaftar';
      pBadge.className = 'badge badge-paid text-xs mt-1';
    }
    if (pLoginBtn) pLoginBtn.style.display = 'none';
    if (pLogoutBtn) pLogoutBtn.style.display = '';
  } else {
    if (nameEl) nameEl.textContent = 'Pengunjung';
    if (roleEl) roleEl.textContent = 'Tamu';
    if (pName) pName.value = 'Pengunjung / Tamu';
    if (pEmail) pEmail.value = 'Belum masuk ke akun';
    if (pBadge) {
      pBadge.textContent = 'Tamu (Belum Masuk)';
      pBadge.className = 'badge badge-pending text-xs mt-1';
    }
    if (pLoginBtn) pLoginBtn.style.display = '';
    if (pLogoutBtn) pLogoutBtn.style.display = 'none';
  }
}
function initNavigation() {
  // Tangani klik pada link navigasi
  document.addEventListener('click', e => {
    const link = e.target.closest('[data-nav-link]');
    if (link) {
      e.preventDefault();
      const section = link.getAttribute('data-nav-link');
      const params = link.dataset.params ? JSON.parse(link.dataset.params) : {};
      navigateTo(section, params);
    }
  });

  // Tangani tombol browser back/forward
  window.addEventListener('popstate', e => {
    if (e.state?.section) {
      navigateTo(e.state.section, e.state.params || {});
    }
  });
}

// ============================================================
// SISTEM AUTENTIKASI (Google OAuth + HMAC session)
// ============================================================

/**
 * Inisialisasi Google Identity Services (One Tap / tombol login).
 * Pastikan script Google sudah di-load di HTML.
 */
function initGoogleLogin() {
  if (typeof google === 'undefined' || !google.accounts) {
    console.warn('Google Identity Services belum dimuat.');
    return;
  }

  google.accounts.id.initialize({
    client_id: window.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID',
    callback: handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true
  });

  // Render tombol Google Sign-In jika elemen ada
  const btnContainer = document.getElementById('google-signin-btn');
  if (btnContainer) {
    google.accounts.id.renderButton(btnContainer, {
      type: 'standard',
      shape: 'pill',
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      locale: 'id'
    });
  }

  // Tampilkan One Tap jika belum login
  if (!isLoggedIn()) {
    google.accounts.id.prompt();
  }
}

/**
 * Tangani credential dari Google OAuth.
 * @param {{ credential: string }} response - Respon dari Google
 */
async function handleGoogleCredential(response) {
  showSkeleton('section-login');
  try {
    const result = await apiPost('loginGoogle', { id_token: response.credential });

    if (!result.success) {
      throw new Error(result.message || 'Login gagal.');
    }

    // Simpan sesi ke state dan localStorage
    const session = {
      email: result.email,
      name: result.name,
      role: result.role,
      token: result.token,
      avatar: result.avatar || null
    };
    appState.user = session;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.setItem('session_token', result.token);

    showToast(`Selamat datang, ${result.name}! 👋`, 'success');

    // Arahkan ke dashboard sesuai role
    if (result.role === 'admin') {
      navigateTo('dashboard-admin');
    } else {
      navigateTo('dashboard-member');
    }
  } catch (err) {
    showToast('Login gagal: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-login');
  }
}

/**
 * Logout pengguna: hapus state dan session.
 */
function logout() {
  appState.user = null;
  appState.catalog = null;
  appState.myCourses = null;
  appState.currentCourse = null;
  appState.currentLesson = null;
  appState.adminData = {};

  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem('session_token');

  // Revoke Google session jika ada
  if (typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.disableAutoSelect();
  }

  updateUserProfileUI();
  showToast('Kamu berhasil keluar.', 'info');
  navigateTo('katalog');
}

// ============================================================
// HALAMAN KATALOG
// ============================================================

/** Warna pastel untuk kartu kelas */
const PASTEL_COLORS = [
  '#EEEAF8', '#E8F4FD', '#FFF3CD', '#D1F2EB',
  '#FADBD8', '#F9EBEA', '#EBF5FB', '#E9F7EF'
];

/**
 * Muat dan tampilkan katalog kelas.
 */
async function loadCatalog() {
  const container = document.getElementById('catalog-grid');
  if (!container) return;

  // Gunakan cache jika sudah ada (SWR pattern)
  if (appState.catalog) {
    renderCatalog(appState.catalog);
    return;
  }

  showSkeleton('section-katalog');
  try {
    const result = await api('getCatalog');
    if (result.success) {
      appState.catalog = result.data;
      renderCatalog(result.data);
    } else {
      showToast('Gagal memuat katalog: ' + result.message, 'error');
    }
  } catch (err) {
    showToast('Gagal memuat katalog: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-katalog');
  }
}

/**
 * Render daftar kelas ke grid katalog.
 * @param {Array} courses - Array data kelas
 */
function renderCatalog(courses) {
  const container = document.getElementById('catalog-grid');
  if (!container) return;

  const sampleCourses = [
    {
      id: 'demo-gas',
      title: 'Mastering GAS Fullstack & Pure REST API',
      category: 'Google Apps Script',
      description: 'Bangun web app decoupling dengan backend Google Apps Script, Google Sheets database, dan frontend modern.',
      price: 249000,
      totalDuration: '18 jam',
      lessonCount: 24,
      isDemo: true
    },
    {
      id: 'demo-nextjs',
      title: 'Next.js 14 & Cloud Products Architecture',
      category: 'Fullstack Cloud',
      description: 'Pelajari arsitektur fullstack enterprise, Server Actions, pipeline otentikasi Google, dan rilis web app siap pakai.',
      price: 299000,
      totalDuration: '22 jam',
      lessonCount: 30,
      isDemo: true
    },
    {
      id: 'demo-automasi',
      title: 'Automasi Bisnis dengan WhatsApp API & CRM',
      category: 'Automasi Bisnis',
      description: 'Integrasi WhatsApp Gateway Fonnte, antrean pengiriman pesan non-blocking, blast massal, dan manajemen pipeline CRM.',
      price: 199000,
      totalDuration: '12 jam',
      lessonCount: 16,
      isDemo: true
    }
  ];

  const list = (courses && courses.length > 0) ? courses : sampleCourses;

  container.innerHTML = list.map((course, idx) => renderCourseCard(course, idx)).join('');
  initSearch('catalog-search', list, (filtered) => {
    container.innerHTML = filtered.map((c, i) => renderCourseCard(c, i)).join('');
  });
}

/**
 * Render HTML kartu kelas individu.
 * @param {object} course - Data kelas
 * @param {number} idx - Index untuk warna pastel
 * @returns {string} HTML string
 */
function renderCourseCard(course, idx = 0) {
  const bgColor = PASTEL_COLORS[idx % PASTEL_COLORS.length];
  const harga = course.price === 0
    ? '<span class="badge-free">GRATIS</span>'
    : `<span class="price">Rp ${formatRupiah(course.price)}</span>`;

  return `
    <div class="course-card" style="background:${bgColor}; border-radius:24px;"
         data-course-id="${course.id}">
      <div class="course-cover">
        ${course.coverUrl
          ? `<img src="${course.coverUrl}" alt="${escapeHtml(course.title)}" loading="lazy">`
          : `<div class="cover-placeholder" style="background:#5B50AD20">📚</div>`}
      </div>
      <div class="course-body">
        <span class="category-badge">${escapeHtml(course.category || 'Umum')}</span>
        <h3 class="course-title">${escapeHtml(course.title)}</h3>
        <p class="course-desc">${escapeHtml(truncate(course.description, 80))}</p>
        <div class="course-meta">
          <span>⏱ ${course.totalDuration || '—'}</span>
          <span>📖 ${course.lessonCount || 0} pelajaran</span>
        </div>
        <div class="course-footer">
          ${harga}
          <button class="btn-primary btn-sm"
            onclick="handleBuyCourse('${course.id}', '${escapeHtml(course.title)}', ${course.price})">
            ${course.price === 0 ? 'Daftar Gratis' : 'Beli Sekarang'}
          </button>
        </div>
      </div>
    </div>`;
}

/**
 * Tangani klik beli kelas.
 * @param {string} courseId
 * @param {string} title
 * @param {number} price
 */
function handleBuyCourse(courseId, title, price) {
  if (!isLoggedIn()) {
    showToast('Silakan login terlebih dahulu untuk membeli kelas.', 'warning');
    navigateTo('login');
    return;
  }
  navigateTo('checkout', { courseId, title, price });
}

// ============================================================
// DASHBOARD MEMBER
// ============================================================

/**
 * Muat dan tampilkan dashboard member.
 */
async function loadMemberDashboard() {
  const section = document.getElementById('section-dashboard-member');
  if (!section) return;

  showSkeleton('section-dashboard-member');
  try {
    const result = await api('getMyDashboard', { token: getToken() });
    if (result.success) {
      renderMemberDashboard(result.data);
    } else {
      showToast('Gagal memuat dashboard: ' + result.message, 'error');
    }
  } catch (err) {
    showToast('Gagal memuat dashboard: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-dashboard-member');
  }
}

/**
 * Render konten dashboard member.
 * @param {object} data
 */
function renderMemberDashboard(data) {
  const { user, continueCourse, enrolledCourses, announcements } = data;

  // Sapaan
  const greetEl = document.getElementById('member-greeting');
  if (greetEl) {
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Selamat Pagi' : hour < 18 ? 'Selamat Siang' : 'Selamat Malam';
    greetEl.textContent = `${greet}, ${user?.name || 'Sobat'}! 👋`;
  }

  // Lanjutkan belajar
  const continueEl = document.getElementById('continue-learning');
  if (continueEl && continueCourse) {
    continueEl.innerHTML = `
      <div class="continue-card" onclick="loadLesson('${continueCourse.lessonId}')">
        <h4>▶ Lanjutkan: ${escapeHtml(continueCourse.title)}</h4>
        <div class="progress-bar-wrap">
          <div class="progress-bar" style="width:${continueCourse.progress || 0}%"></div>
        </div>
        <small>${continueCourse.progress || 0}% selesai</small>
      </div>`;
  }

  // Daftar kelas terdaftar
  const coursesEl = document.getElementById('enrolled-courses-list');
  if (coursesEl && enrolledCourses) {
    coursesEl.innerHTML = enrolledCourses.map(c => `
      <div class="enrolled-item" onclick="navigateTo('ruang-belajar', {courseId:'${c.id}'})">
        <span>${escapeHtml(c.title)}</span>
        <div class="progress-bar-wrap mini">
          <div class="progress-bar" style="width:${c.progress || 0}%"></div>
        </div>
      </div>`).join('');
  }

  // Pengumuman
  const annEl = document.getElementById('announcements-list');
  if (annEl && announcements) {
    annEl.innerHTML = announcements.map(a => `
      <div class="announcement-item">
        <strong>${escapeHtml(a.title)}</strong>
        <p>${escapeHtml(a.body)}</p>
        <small>${formatDate(a.date)}</small>
      </div>`).join('');
  }
}

// ============================================================
// KELAS SAYA (Daftar kelas milik member)
// ============================================================

/**
 * Muat daftar kelas yang dimiliki member.
 */
async function loadMyCourses() {
  const container = document.getElementById('my-courses-list');
  if (!container) return;

  if (appState.myCourses) {
    renderMyCourses(appState.myCourses);
    return;
  }

  showSkeleton('section-kelas-saya');
  try {
    const result = await api('getMyCourses', { token: getToken() });
    if (result.success) {
      appState.myCourses = result.data;
      renderMyCourses(result.data);
    } else {
      showToast('Gagal memuat kelas saya: ' + result.message, 'error');
    }
  } catch (err) {
    showToast('Gagal memuat kelas saya: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-kelas-saya');
  }
}

/**
 * Render daftar kelas milik member.
 * @param {Array} courses
 */
function renderMyCourses(courses) {
  const container = document.getElementById('my-courses-list');
  if (!container) return;

  if (!courses || courses.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Kamu belum punya kelas. Yuk, mulai belajar!</p>
        <button class="btn-primary" onclick="navigateTo('katalog')">Lihat Katalog</button>
      </div>`;
    return;
  }

  container.innerHTML = courses.map((course, idx) => `
    <div class="my-course-card" style="background:${PASTEL_COLORS[idx % PASTEL_COLORS.length]}; border-radius:16px;"
         onclick="navigateTo('ruang-belajar', {courseId:'${course.id}'})">
      <h4>${escapeHtml(course.title)}</h4>
      <div class="progress-bar-wrap">
        <div class="progress-bar" style="width:${course.progress || 0}%"></div>
      </div>
      <div class="course-meta-row">
        <small>${course.progress || 0}% selesai</small>
        <small>${course.completedLessons || 0}/${course.totalLessons || 0} pelajaran</small>
      </div>
    </div>`).join('');
}

// ============================================================
// RUANG BELAJAR
// ============================================================

/**
 * Muat dan tampilkan halaman pelajaran.
 * @param {string} lessonId
 */
async function loadLesson(lessonId) {
  const section = document.getElementById('section-ruang-belajar');
  if (!section) return;

  showSkeleton('section-ruang-belajar');
  try {
    const result = await api('getLesson', { lessonId, token: getToken() });
    if (result.success) {
      appState.currentLesson = result.data;
      renderLesson(result.data);
    } else {
      showToast('Gagal memuat pelajaran: ' + result.message, 'error');
    }
  } catch (err) {
    showToast('Gagal memuat pelajaran: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-ruang-belajar');
  }
}

/**
 * Render konten pelajaran ke halaman ruang belajar.
 * @param {object} lesson
 */
function renderLesson(lesson) {
  // Embed YouTube
  const videoEl = document.getElementById('lesson-video');
  if (videoEl && lesson.youtubeId) {
    videoEl.innerHTML = `
      <iframe
        src="https://www.youtube.com/embed/${lesson.youtubeId}?rel=0"
        title="${escapeHtml(lesson.title)}"
        frameborder="0" allowfullscreen
        style="width:100%;aspect-ratio:16/9;border-radius:12px;">
      </iframe>`;
  }

  // Judul pelajaran
  const titleEl = document.getElementById('lesson-title');
  if (titleEl) titleEl.textContent = lesson.title;

  // Daftar modul (accordion)
  const moduleEl = document.getElementById('lesson-modules');
  if (moduleEl && lesson.modules) {
    moduleEl.innerHTML = lesson.modules.map(mod => `
      <div class="accordion">
        <button class="accordion-header" onclick="toggleAccordion(this)">
          📁 ${escapeHtml(mod.title)}
          <span class="accordion-icon">▼</span>
        </button>
        <div class="accordion-body">
          ${(mod.lessons || []).map(l => `
            <div class="lesson-item ${l.id === lesson.id ? 'active' : ''} ${l.completed ? 'completed' : ''}"
                 onclick="loadLesson('${l.id}')">
              ${l.completed ? '✅' : '○'} ${escapeHtml(l.title)}
              ${l.duration ? `<small>${l.duration}</small>` : ''}
            </div>`).join('')}
        </div>
      </div>`).join('');
  }

  // Materi download
  const dlEl = document.getElementById('lesson-downloads');
  if (dlEl && lesson.materials) {
    dlEl.innerHTML = lesson.materials.length
      ? lesson.materials.map(m => `
          <a class="download-item" href="${m.url}" target="_blank" rel="noopener">
            📎 ${escapeHtml(m.name)}
          </a>`).join('')
      : '<p>Tidak ada materi unduhan.</p>';
  }

  // Navigasi Sebelumnya / Berikutnya
  const prevBtn = document.getElementById('btn-prev-lesson');
  const nextBtn = document.getElementById('btn-next-lesson');
  if (prevBtn) {
    prevBtn.disabled = !lesson.prevLessonId;
    prevBtn.onclick = () => lesson.prevLessonId && loadLesson(lesson.prevLessonId);
  }
  if (nextBtn) {
    nextBtn.disabled = !lesson.nextLessonId;
    nextBtn.onclick = () => lesson.nextLessonId && loadLesson(lesson.nextLessonId);
  }

  // Tombol Selesai Pelajaran
  const doneBtn = document.getElementById('btn-lesson-done');
  if (doneBtn) {
    doneBtn.textContent = lesson.completed ? '✅ Sudah Selesai' : 'Tandai Selesai';
    doneBtn.disabled = lesson.completed;
    doneBtn.onclick = () => markLessonComplete(lesson.id);
  }
}

/**
 * Tandai pelajaran sebagai selesai (Optimistic UI).
 * @param {string} lessonId
 */
async function markLessonComplete(lessonId) {
  // Optimistic UI: perbarui UI langsung
  const doneBtn = document.getElementById('btn-lesson-done');
  if (doneBtn) {
    doneBtn.textContent = '✅ Sudah Selesai';
    doneBtn.disabled = true;
  }

  // Perbarui progress bar secara optimis
  if (appState.currentLesson) {
    appState.currentLesson.completed = true;
  }

  // Invalidasi cache kelas saya agar reload saat dibuka
  appState.myCourses = null;

  try {
    const result = await api('markLessonComplete', { lessonId, token: getToken() }, true);
    if (!result.success) throw new Error(result.message || 'Gagal menandai selesai.');
    showToast('Pelajaran berhasil ditandai selesai! 🎉', 'success');
  } catch (err) {
    // Revert jika gagal
    if (doneBtn) {
      doneBtn.textContent = 'Tandai Selesai';
      doneBtn.disabled = false;
    }
    if (appState.currentLesson) appState.currentLesson.completed = false;
    showToast('Gagal menandai selesai: ' + err.message, 'error');
  }
}

/** Toggle accordion modul */
function toggleAccordion(headerEl) {
  const body = headerEl.nextElementSibling;
  const icon = headerEl.querySelector('.accordion-icon');
  const isOpen = body.style.display === 'block';
  body.style.display = isOpen ? 'none' : 'block';
  if (icon) icon.textContent = isOpen ? '▼' : '▲';
}

// ============================================================
// CHECKOUT
// ============================================================

/** Timer countdown checkout */
let _checkoutTimerInterval = null;

/**
 * Inisialisasi halaman checkout.
 * @param {string} courseId
 */
async function initCheckout(courseId) {
  const section = document.getElementById('section-checkout');
  if (!section) return;

  showSkeleton('section-checkout');
  try {
    // Ambil detail kelas
    const result = await api('getCourseDetail', { courseId, token: getToken() });
    if (!result.success) throw new Error(result.message);

    appState.currentCourse = result.data;
    renderCheckoutSummary(result.data);
    startCheckoutCountdown(courseId);
  } catch (err) {
    showToast('Gagal memuat checkout: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-checkout');
  }
}

/**
 * Render ringkasan pesanan di halaman checkout.
 * @param {object} course
 */
function renderCheckoutSummary(course) {
  const summaryEl = document.getElementById('checkout-summary');
  if (!summaryEl) return;

  summaryEl.innerHTML = `
    <div class="checkout-course-info">
      ${course.coverUrl
        ? `<img src="${course.coverUrl}" alt="${escapeHtml(course.title)}" style="width:80px;border-radius:8px;">`
        : ''}
      <div>
        <h4>${escapeHtml(course.title)}</h4>
        <p>${escapeHtml(course.category || '')}</p>
      </div>
    </div>
    <div class="checkout-price-row">
      <span>Harga</span>
      <strong>Rp ${formatRupiah(course.price)}</strong>
    </div>
    <div id="checkout-method" class="checkout-method-select">
      <h5>Pilih Metode Pembayaran</h5>
      <label>
        <input type="radio" name="payment-method" value="manual" checked>
        Transfer Manual
      </label>
      <label>
        <input type="radio" name="payment-method" value="gateway">
        Payment Gateway
      </label>
      <button class="btn-primary" onclick="createOrder('${course.id}', getSelectedMethod())">
        Buat Pesanan
      </button>
    </div>`;
}

/** Dapatkan metode pembayaran yang dipilih */
function getSelectedMethod() {
  const radio = document.querySelector('input[name="payment-method"]:checked');
  return radio ? radio.value : 'manual';
}

/**
 * Mulai countdown 24 jam untuk checkout.
 * @param {string} courseId
 */
function startCheckoutCountdown(courseId) {
  const timerKey = `checkout_timer_${courseId}`;
  let expiry = parseInt(localStorage.getItem(timerKey) || '0');
  if (!expiry || expiry < Date.now()) {
    expiry = Date.now() + CHECKOUT_DURATION_MS;
    localStorage.setItem(timerKey, expiry.toString());
  }

  if (_checkoutTimerInterval) clearInterval(_checkoutTimerInterval);

  _checkoutTimerInterval = setInterval(() => {
    const remaining = expiry - Date.now();
    if (remaining <= 0) {
      clearInterval(_checkoutTimerInterval);
      localStorage.removeItem(timerKey);
      showToast('Waktu checkout telah habis.', 'warning');
      navigateTo('katalog');
      return;
    }
    const h = Math.floor(remaining / 3600000);
    const m = Math.floor((remaining % 3600000) / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    const el = document.getElementById('checkout-countdown');
    if (el) el.textContent = `⏳ Selesaikan pembayaran dalam ${pad(h)}:${pad(m)}:${pad(s)}`;
  }, 1000);
}

/**
 * Buat pesanan baru.
 * @param {string} courseId
 * @param {string} method - 'manual' | 'gateway'
 */
async function createOrder(courseId, method) {
  try {
    const result = await api('createOrder', { courseId, method, token: getToken() }, true);
    if (!result.success) throw new Error(result.message);

    appState.adminData.currentOrderId = result.orderId;
    renderPaymentInstructions(result);
    showToast('Pesanan berhasil dibuat!', 'success');
  } catch (err) {
    showToast('Gagal membuat pesanan: ' + err.message, 'error');
  }
}

/**
 * Render instruksi pembayaran setelah order dibuat.
 * @param {object} orderData
 */
function renderPaymentInstructions(orderData) {
  const instrEl = document.getElementById('payment-instructions');
  if (!instrEl) return;

  instrEl.innerHTML = `
    <div class="payment-info-box">
      <h4>Instruksi Pembayaran</h4>
      <p>No. Pesanan: <strong>${orderData.orderId}</strong></p>
      ${orderData.bankAccount
        ? `<p>Transfer ke: <strong>${orderData.bankAccount}</strong></p>
           <p>Nominal: <strong>Rp ${formatRupiah(orderData.amount)}</strong></p>`
        : `<p><a href="${orderData.paymentUrl}" target="_blank" class="btn-primary">Bayar via Gateway</a></p>`}
      <div class="upload-proof-section">
        <h5>Upload Bukti Pembayaran</h5>
        <input type="file" id="payment-proof-file" accept="image/*,application/pdf">
        <button class="btn-secondary"
          onclick="uploadPaymentProof('${orderData.orderId}', document.getElementById('payment-proof-file').files[0])">
          Upload Bukti
        </button>
      </div>
    </div>`;
}

/**
 * Upload bukti pembayaran ke backend (konversi ke base64 chunked).
 * @param {string} orderId
 * @param {File} file
 */
async function uploadPaymentProof(orderId, file) {
  if (!file) {
    showToast('Pilih file bukti pembayaran terlebih dahulu.', 'warning');
    return;
  }

  const MAX_SIZE_MB = 5;
  if (file.size > MAX_SIZE_MB * 1024 * 1024) {
    showToast(`Ukuran file maksimal ${MAX_SIZE_MB}MB.`, 'warning');
    return;
  }

  showToast('Mengupload bukti pembayaran...', 'info');

  try {
    const base64 = await fileToBase64(file);
    const result = await api('uploadPaymentProof', {
      orderId,
      fileData: base64,
      fileName: file.name,
      fileType: file.type,
      token: getToken()
    }, true);

    if (!result.success) throw new Error(result.message);
    showToast('Bukti pembayaran berhasil diupload! Menunggu verifikasi admin.', 'success');
  } catch (err) {
    showToast('Gagal upload bukti: ' + err.message, 'error');
  }
}

/**
 * Konversi File ke base64 string.
 * @param {File} file
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ============================================================
// ADMIN DASHBOARD
// ============================================================

/**
 * Muat dan render dashboard admin.
 */
async function loadAdminDashboard() {
  const section = document.getElementById('section-dashboard-admin');
  if (!section) return;

  showSkeleton('section-dashboard-admin');
  try {
    const result = await api('getAdminDashboard', { token: getToken() });
    if (!result.success) throw new Error(result.message);

    const data = result.data;
    appState.adminData.dashboard = data;

    renderAdminKPIs(data.kpis);
    renderRevenueChart(data.revenueChart);
    renderSalesChart(data.salesChart);
    renderMemberChart(data.memberChart);
    renderVerificationQueue(data.pendingPayments);
    renderCRMTasks(data.crmTasks);
  } catch (err) {
    showToast('Gagal memuat dashboard admin: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-dashboard-admin');
  }
}

/**
 * Render kartu KPI admin.
 * @param {object} kpis - { revenue, orders, members, activeMembers }
 */
function renderAdminKPIs(kpis) {
  if (!kpis) return;

  const kpiMap = {
    'kpi-revenue': { label: 'Total Pendapatan', value: `Rp ${formatRupiah(kpis.revenue || 0)}`, icon: '💰' },
    'kpi-orders': { label: 'Total Pesanan', value: kpis.orders || 0, icon: '🛒' },
    'kpi-members': { label: 'Total Member', value: kpis.members || 0, icon: '👥' },
    'kpi-active': { label: 'Member Aktif', value: kpis.activeMembers || 0, icon: '🔥' }
  };

  Object.entries(kpiMap).forEach(([id, info]) => {
    const el = document.getElementById(id);
    if (el) {
      el.innerHTML = `
        <div class="kpi-card">
          <span class="kpi-icon">${info.icon}</span>
          <div>
            <div class="kpi-value">${info.value}</div>
            <div class="kpi-label">${info.label}</div>
          </div>
        </div>`;
    }
  });
}

/**
 * Render antrean verifikasi pembayaran.
 * @param {Array} payments
 */
function renderVerificationQueue(payments) {
  const container = document.getElementById('verification-queue');
  if (!container) return;

  if (!payments || payments.length === 0) {
    container.innerHTML = '<p class="empty-state">Tidak ada pembayaran yang menunggu verifikasi.</p>';
    return;
  }

  container.innerHTML = payments.map(p => `
    <div class="verification-item">
      <div>
        <strong>${escapeHtml(p.memberName)}</strong>
        <span>${escapeHtml(p.courseName)}</span>
        <small>Rp ${formatRupiah(p.amount)} · ${formatDate(p.date)}</small>
      </div>
      <div class="verification-actions">
        ${p.proofUrl
          ? `<a href="${p.proofUrl}" target="_blank" class="btn-ghost btn-sm">Lihat Bukti</a>`
          : ''}
        <button class="btn-success btn-sm" onclick="reviewPayment('${p.id}', 'approve')">✅ Approve</button>
        <button class="btn-danger btn-sm" onclick="reviewPayment('${p.id}', 'reject')">❌ Tolak</button>
      </div>
    </div>`).join('');
}

/**
 * Render daftar tugas CRM di dashboard admin.
 * @param {Array} tasks
 */
function renderCRMTasks(tasks) {
  const container = document.getElementById('crm-tasks-list');
  if (!container) return;

  if (!tasks || tasks.length === 0) {
    container.innerHTML = '<p class="empty-state">Tidak ada tugas CRM.</p>';
    return;
  }

  container.innerHTML = tasks.map(t => `
    <div class="crm-task-item priority-${t.priority || 'low'}">
      <span>${escapeHtml(t.contact)}</span>
      <span class="task-stage">${escapeHtml(t.stage)}</span>
      <span>${escapeHtml(t.note)}</span>
      <small>${formatDate(t.followUpDate)}</small>
    </div>`).join('');
}

// ============================================================
// ADMIN - KELOLA PEMBAYARAN
// ============================================================

/**
 * Muat daftar pesanan/pembayaran untuk admin.
 * @param {'all'|'pending'|'AwaitingReview'|'paid'|'rejected'} status
 */
async function loadAdminOrders(status = 'all') {
  const container = document.getElementById('admin-orders-table-body');
  if (!container) return;

  showSkeleton('section-admin-pembayaran');
  try {
    const result = await api('getAdminOrders', { token: getToken(), status });
    if (!result.success) throw new Error(result.message);

    appState.adminData.orders = result.data;
    renderAdminOrdersTable(result.data);
    initOrderPagination(result.data);
  } catch (err) {
    showToast('Gagal memuat data pesanan: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-admin-pembayaran');
  }
}

/**
 * Render tabel pesanan admin.
 * @param {Array} orders
 */
function renderAdminOrdersTable(orders) {
  const tbody = document.getElementById('admin-orders-table-body');
  if (!tbody) return;

  if (!orders || orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">Tidak ada data.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map(o => `
    <tr>
      <td>${escapeHtml(o.id)}</td>
      <td>${escapeHtml(o.memberName)}</td>
      <td>${escapeHtml(o.courseName)}</td>
      <td>Rp ${formatRupiah(o.amount)}</td>
      <td><span class="status-badge status-${o.status.toLowerCase()}">${o.status}</span></td>
      <td>
        ${o.proofUrl
          ? `<a href="${o.proofUrl}" target="_blank" class="btn-ghost btn-xs">Bukti</a>`
          : '—'}
        ${o.status === 'AwaitingReview'
          ? `<button class="btn-success btn-xs" onclick="reviewPayment('${o.id}', 'approve')">✅</button>
             <button class="btn-danger btn-xs" onclick="reviewPayment('${o.id}', 'reject')">❌</button>`
          : ''}
      </td>
    </tr>`).join('');
}

/** Inisialisasi paginasi sederhana untuk tabel pesanan */
function initOrderPagination(orders, pageSize = 10) {
  const container = document.getElementById('orders-pagination');
  if (!container || !orders) return;

  const pageCount = Math.ceil(orders.length / pageSize);
  if (pageCount <= 1) { container.innerHTML = ''; return; }

  let currentPage = 1;

  const render = () => {
    const start = (currentPage - 1) * pageSize;
    const sliced = orders.slice(start, start + pageSize);
    renderAdminOrdersTable(sliced);

    container.innerHTML = `
      <button onclick="changePage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>‹ Prev</button>
      <span>Hal ${currentPage} / ${pageCount}</span>
      <button onclick="changePage(${currentPage + 1})" ${currentPage === pageCount ? 'disabled' : ''}>Next ›</button>`;
  };

  window.changePage = (page) => {
    if (page < 1 || page > pageCount) return;
    currentPage = page;
    render();
  };

  render();
}

/**
 * Review pembayaran: approve atau reject.
 * @param {string} paymentId
 * @param {'approve'|'reject'} action
 * @param {string} [reason]
 */
async function reviewPayment(paymentId, action, reason = '') {
  const confirmed = await confirmDialog(
    action === 'approve'
      ? 'Approve pembayaran ini?'
      : 'Tolak pembayaran ini? Masukkan alasan jika diperlukan.'
  );
  if (!confirmed) return;

  if (action === 'reject' && !reason) {
    reason = await promptDialog('Alasan penolakan (opsional):') || '';
  }

  try {
    const result = await api('updatePaymentStatus', {
      paymentId, action, reason, token: getToken()
    }, true);

    if (!result.success) throw new Error(result.message);

    showToast(
      action === 'approve' ? 'Pembayaran berhasil di-approve! ✅' : 'Pembayaran ditolak.',
      action === 'approve' ? 'success' : 'warning'
    );

    // Reload tabel setelah sukses
    await loadAdminOrders();
    await loadAdminDashboard();
  } catch (err) {
    showToast('Gagal update status: ' + err.message, 'error');
  }
}

// ============================================================
// ADMIN - CRUD KELAS
// ============================================================

/** Muat daftar kelas untuk admin */
async function loadAdminCourses() {
  const container = document.getElementById('admin-courses-list');
  if (!container) return;

  showSkeleton('section-admin-kelas');
  try {
    const result = await api('getAdminCourses', { token: getToken() });
    if (!result.success) throw new Error(result.message);

    appState.adminData.courses = result.data;
    renderAdminCoursesList(result.data);
  } catch (err) {
    showToast('Gagal memuat daftar kelas: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-admin-kelas');
  }
}

/**
 * Render daftar kelas di halaman admin.
 * @param {Array} courses
 */
function renderAdminCoursesList(courses) {
  const container = document.getElementById('admin-courses-list');
  if (!container) return;

  container.innerHTML = `
    <div class="admin-toolbar">
      <button class="btn-primary" onclick="openCourseEditor()">+ Tambah Kelas</button>
    </div>
    ${!courses || courses.length === 0
      ? '<p class="empty-state">Belum ada kelas.</p>'
      : courses.map(c => `
          <div class="admin-course-item">
            <div>
              <strong>${escapeHtml(c.title)}</strong>
              <span>${c.lessonCount || 0} pelajaran · Rp ${formatRupiah(c.price)}</span>
              <span class="status-badge status-${c.isPublished ? 'paid' : 'pending'}">
                ${c.isPublished ? 'Publik' : 'Draft'}
              </span>
            </div>
            <div class="item-actions">
              <button class="btn-ghost btn-sm" onclick="openCourseEditor('${c.id}')">✏️ Edit</button>
              <button class="btn-ghost btn-sm" onclick="openModuleManager('${c.id}')">📚 Modul</button>
              <button class="btn-danger btn-sm" onclick="deleteCourse('${c.id}')">🗑️</button>
            </div>
          </div>`).join('')}`;
}

/**
 * Simpan data kelas (create atau update).
 * @param {object} data - Data form kelas
 */
async function saveCourse(data) {
  try {
    const result = await api('saveCourse', { ...data, token: getToken() }, true);
    if (!result.success) throw new Error(result.message);

    showToast('Kelas berhasil disimpan!', 'success');
    appState.adminData.courses = null;
    appState.catalog = null; // Invalidasi cache katalog
    closeModal();
    await loadAdminCourses();
  } catch (err) {
    showToast('Gagal menyimpan kelas: ' + err.message, 'error');
  }
}

/**
 * Simpan data modul kelas.
 * @param {object} data
 */
async function saveModule(data) {
  try {
    const result = await api('saveModule', { ...data, token: getToken() }, true);
    if (!result.success) throw new Error(result.message);
    showToast('Modul berhasil disimpan!', 'success');
    closeModal();
    if (data.courseId) await loadModuleManager(data.courseId);
  } catch (err) {
    showToast('Gagal menyimpan modul: ' + err.message, 'error');
  }
}

/**
 * Simpan data pelajaran/lesson.
 * @param {object} data
 */
async function saveLesson(data) {
  try {
    const result = await api('saveLesson', { ...data, token: getToken() }, true);
    if (!result.success) throw new Error(result.message);
    showToast('Pelajaran berhasil disimpan!', 'success');
    closeModal();
    if (data.moduleId) await loadModuleManager(data.courseId);
  } catch (err) {
    showToast('Gagal menyimpan pelajaran: ' + err.message, 'error');
  }
}

/**
 * Hapus kelas.
 * @param {string} courseId
 */
async function deleteCourse(courseId) {
  const ok = await confirmDialog('Yakin ingin menghapus kelas ini? Tindakan ini tidak dapat dibatalkan.');
  if (!ok) return;
  try {
    const result = await api('deleteCourse', { courseId, token: getToken() }, true);
    if (!result.success) throw new Error(result.message);
    showToast('Kelas berhasil dihapus.', 'success');
    appState.adminData.courses = null;
    appState.catalog = null;
    await loadAdminCourses();
  } catch (err) {
    showToast('Gagal menghapus kelas: ' + err.message, 'error');
  }
}

/**
 * Buka modal form editor kelas.
 * @param {string|null} courseId - null untuk tambah baru
 */
async function openCourseEditor(courseId = null) {
  let course = {};

  if (courseId) {
    try {
      const result = await api('getCourseDetail', { courseId, token: getToken() });
      if (result.success) course = result.data;
    } catch (_) {}
  }

  const formHtml = `
    <form id="course-form" onsubmit="handleCourseFormSubmit(event, '${courseId || ''}')">
      <div class="form-group">
        <label>Judul Kelas *</label>
        <input type="text" name="title" value="${escapeHtml(course.title || '')}" required
               placeholder="Masukkan judul kelas">
      </div>
      <div class="form-group">
        <label>Kategori</label>
        <input type="text" name="category" value="${escapeHtml(course.category || '')}"
               placeholder="mis. Programming, Design">
      </div>
      <div class="form-group">
        <label>Deskripsi</label>
        <textarea name="description" rows="3" placeholder="Deskripsi kelas">${escapeHtml(course.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Harga (Rp)</label>
        <input type="number" name="price" value="${course.price || 0}" min="0">
      </div>
      <div class="form-group">
        <label>URL Cover</label>
        <input type="url" name="coverUrl" value="${escapeHtml(course.coverUrl || '')}"
               placeholder="https://...">
      </div>
      <div class="form-group">
        <label>
          <input type="checkbox" name="isPublished" ${course.isPublished ? 'checked' : ''}>
          Publikasikan kelas ini
        </label>
      </div>
    </form>`;

  openModal(
    courseId ? 'Edit Kelas' : 'Tambah Kelas Baru',
    formHtml,
    [
      { label: 'Batal', className: 'btn-ghost', onClick: closeModal },
      { label: 'Simpan', className: 'btn-primary', onClick: () => {
        document.getElementById('course-form').requestSubmit();
      }}
    ]
  );
}

/**
 * Handle submit form kelas.
 * @param {Event} e
 * @param {string} courseId
 */
function handleCourseFormSubmit(e, courseId) {
  e.preventDefault();
  const form = e.target;
  const data = {
    id: courseId || null,
    title: form.title.value.trim(),
    category: form.category.value.trim(),
    description: form.description.value.trim(),
    price: parseInt(form.price.value) || 0,
    coverUrl: form.coverUrl.value.trim(),
    isPublished: form.isPublished.checked
  };

  if (!data.title) {
    showToast('Judul kelas tidak boleh kosong.', 'warning');
    return;
  }

  saveCourse(data);
}

/** Buka manajer modul untuk kelas tertentu */
async function openModuleManager(courseId) {
  navigateTo('admin-kelas');
  await loadModuleManager(courseId);
}

/** Muat dan tampilkan modul untuk kelas tertentu */
async function loadModuleManager(courseId) {
  try {
    const result = await api('getCourseModules', { courseId, token: getToken() });
    if (!result.success) throw new Error(result.message);

    openModal(`Modul Kelas: ${escapeHtml(result.courseTitle || '')}`,
      renderModuleManagerHtml(courseId, result.modules),
      [{ label: 'Tutup', className: 'btn-ghost', onClick: closeModal }]
    );
  } catch (err) {
    showToast('Gagal memuat modul: ' + err.message, 'error');
  }
}

/**
 * Render HTML manajer modul.
 * @param {string} courseId
 * @param {Array} modules
 * @returns {string}
 */
function renderModuleManagerHtml(courseId, modules) {
  return `
    <div class="module-manager">
      <button class="btn-secondary btn-sm" onclick="openModuleEditor('${courseId}')">+ Tambah Modul</button>
      ${(modules || []).map(mod => `
        <div class="module-item">
          <strong>${escapeHtml(mod.title)}</strong>
          <button class="btn-ghost btn-xs" onclick="openModuleEditor('${courseId}', '${mod.id}')">Edit</button>
          <div class="lesson-list">
            ${(mod.lessons || []).map(l => `
              <div class="lesson-row">
                <span>${escapeHtml(l.title)}</span>
                <button class="btn-ghost btn-xs" onclick="openLessonEditor('${courseId}', '${mod.id}', '${l.id}')">Edit</button>
              </div>`).join('')}
            <button class="btn-ghost btn-xs" onclick="openLessonEditor('${courseId}', '${mod.id}')">+ Tambah Pelajaran</button>
          </div>
        </div>`).join('')}
    </div>`;
}

/** Buka form editor modul */
function openModuleEditor(courseId, moduleId = null) {
  openModal(moduleId ? 'Edit Modul' : 'Tambah Modul', `
    <form id="module-form">
      <div class="form-group">
        <label>Judul Modul *</label>
        <input type="text" id="module-title" required placeholder="Judul modul">
      </div>
      <div class="form-group">
        <label>Urutan</label>
        <input type="number" id="module-order" value="1" min="1">
      </div>
    </form>`,
    [
      { label: 'Batal', className: 'btn-ghost', onClick: closeModal },
      { label: 'Simpan', className: 'btn-primary', onClick: () => {
        const title = document.getElementById('module-title').value.trim();
        const order = parseInt(document.getElementById('module-order').value) || 1;
        if (!title) { showToast('Judul modul wajib diisi.', 'warning'); return; }
        saveModule({ id: moduleId, courseId, title, order });
      }}
    ]
  );
}

/** Buka form editor pelajaran */
function openLessonEditor(courseId, moduleId, lessonId = null) {
  openModal(lessonId ? 'Edit Pelajaran' : 'Tambah Pelajaran', `
    <form id="lesson-form">
      <div class="form-group">
        <label>Judul Pelajaran *</label>
        <input type="text" id="lesson-title" required placeholder="Judul pelajaran">
      </div>
      <div class="form-group">
        <label>YouTube ID</label>
        <input type="text" id="lesson-youtube" placeholder="mis. dQw4w9WgXcQ">
      </div>
      <div class="form-group">
        <label>Durasi</label>
        <input type="text" id="lesson-duration" placeholder="mis. 15:30">
      </div>
      <div class="form-group">
        <label>Urutan</label>
        <input type="number" id="lesson-order" value="1" min="1">
      </div>
    </form>`,
    [
      { label: 'Batal', className: 'btn-ghost', onClick: closeModal },
      { label: 'Simpan', className: 'btn-primary', onClick: () => {
        const title = document.getElementById('lesson-title').value.trim();
        const youtubeId = document.getElementById('lesson-youtube').value.trim();
        const duration = document.getElementById('lesson-duration').value.trim();
        const order = parseInt(document.getElementById('lesson-order').value) || 1;
        if (!title) { showToast('Judul pelajaran wajib diisi.', 'warning'); return; }
        saveLesson({ id: lessonId, courseId, moduleId, title, youtubeId, duration, order });
      }}
    ]
  );
}

// ============================================================
// ADMIN - KELOLA ANGGOTA
// ============================================================

/** Muat daftar anggota/member untuk admin */
async function loadAdminMembers() {
  const container = document.getElementById('admin-members-list');
  if (!container) return;

  showSkeleton('section-admin-anggota');
  try {
    const result = await api('getAdminMembers', { token: getToken() });
    if (!result.success) throw new Error(result.message);

    appState.adminData.members = result.data;
    renderAdminMembersList(result.data);
  } catch (err) {
    showToast('Gagal memuat anggota: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-admin-anggota');
  }
}

/**
 * Render tabel anggota admin.
 * @param {Array} members
 */
function renderAdminMembersList(members) {
  const container = document.getElementById('admin-members-list');
  if (!container) return;

  container.innerHTML = `
    <div class="admin-toolbar">
      <input type="text" id="member-search" placeholder="Cari anggota..." oninput="filterMembers(this.value)">
    </div>
    <table class="data-table">
      <thead>
        <tr><th>Nama</th><th>Email</th><th>Kelas</th><th>Bergabung</th><th>Aksi</th></tr>
      </thead>
      <tbody id="members-table-body">
        ${(members || []).map(m => `
          <tr>
            <td>${escapeHtml(m.name)}</td>
            <td>${escapeHtml(m.email)}</td>
            <td>${m.courseCount || 0}</td>
            <td>${formatDate(m.joinDate)}</td>
            <td>
              <button class="btn-ghost btn-xs" onclick="viewMemberDetail('${m.id}')">Detail</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

/** Filter member berdasarkan keyword */
function filterMembers(keyword) {
  const members = appState.adminData.members || [];
  const kw = keyword.toLowerCase();
  const filtered = members.filter(m =>
    m.name.toLowerCase().includes(kw) || m.email.toLowerCase().includes(kw)
  );
  const tbody = document.getElementById('members-table-body');
  if (tbody) {
    tbody.innerHTML = filtered.map(m => `
      <tr>
        <td>${escapeHtml(m.name)}</td>
        <td>${escapeHtml(m.email)}</td>
        <td>${m.courseCount || 0}</td>
        <td>${formatDate(m.joinDate)}</td>
        <td><button class="btn-ghost btn-xs" onclick="viewMemberDetail('${m.id}')">Detail</button></td>
      </tr>`).join('');
  }
}

/** Lihat detail member */
async function viewMemberDetail(memberId) {
  try {
    const result = await api('getMemberDetail', { memberId, token: getToken() });
    if (!result.success) throw new Error(result.message);
    const m = result.data;
    openModal(`Detail: ${escapeHtml(m.name)}`, `
      <div class="member-detail">
        <p><strong>Email:</strong> ${escapeHtml(m.email)}</p>
        <p><strong>Bergabung:</strong> ${formatDate(m.joinDate)}</p>
        <p><strong>Kelas Dimiliki:</strong> ${(m.courses || []).map(c => escapeHtml(c.title)).join(', ') || '—'}</p>
        <p><strong>Total Pembelian:</strong> Rp ${formatRupiah(m.totalSpent || 0)}</p>
      </div>`,
      [{ label: 'Tutup', className: 'btn-ghost', onClick: closeModal }]
    );
  } catch (err) {
    showToast('Gagal memuat detail anggota: ' + err.message, 'error');
  }
}

// ============================================================
// CRM ADMIN
// ============================================================

/** Tahapan pipeline CRM */
const CRM_STAGES = ['Prospek', 'Tertarik', 'Menunggu Bayar', 'Pelanggan'];

/**
 * Muat dan tampilkan halaman CRM admin.
 */
async function loadCRM() {
  const section = document.getElementById('section-admin-crm');
  if (!section) return;

  showSkeleton('section-admin-crm');
  try {
    const result = await api('getCRMContacts', { token: getToken() });
    if (!result.success) throw new Error(result.message);

    appState.adminData.crm = result.data;
    renderCRMPipeline(result.data);
    initSearch('crm-search', result.data, (filtered) => renderCRMPipeline(filtered));
  } catch (err) {
    showToast('Gagal memuat CRM: ' + err.message, 'error');
  } finally {
    hideSkeleton('section-admin-crm');
  }
}

/**
 * Render pipeline CRM dengan Kanban-style kolom.
 * @param {Array} contacts
 */
function renderCRMPipeline(contacts) {
  const container = document.getElementById('crm-pipeline');
  if (!container) return;

  const grouped = {};
  CRM_STAGES.forEach(s => grouped[s] = []);
  (contacts || []).forEach(c => {
    if (grouped[c.stage] !== undefined) grouped[c.stage].push(c);
  });

  container.innerHTML = `
    <div class="crm-toolbar">
      <input type="text" id="crm-search" placeholder="Cari kontak...">
      <button class="btn-primary btn-sm" onclick="openAddContactModal()">+ Tambah Kontak</button>
    </div>
    <div class="crm-kanban">
      ${CRM_STAGES.map(stage => `
        <div class="crm-column">
          <h4 class="crm-stage-title">${stage} <span class="badge">${grouped[stage].length}</span></h4>
          ${grouped[stage].map(c => `
            <div class="crm-card" onclick="openContactDetail('${c.id}')">
              <strong>${escapeHtml(c.name)}</strong>
              <span>${escapeHtml(c.phone || '')}</span>
              <span>${escapeHtml(c.note || '')}</span>
              <small>Follow up: ${formatDate(c.followUpDate)}</small>
            </div>`).join('')}
        </div>`).join('')}
    </div>`;

  // Re-inisialisasi search setelah render
  document.getElementById('crm-search')?.addEventListener('input', e => {
    const kw = e.target.value.toLowerCase();
    const filtered = (appState.adminData.crm || []).filter(c =>
      c.name.toLowerCase().includes(kw) ||
      (c.phone || '').includes(kw) ||
      (c.email || '').toLowerCase().includes(kw)
    );
    renderCRMPipeline(filtered);
  });
}

/** Buka modal tambah kontak CRM */
function openAddContactModal() {
  openModal('Tambah Kontak CRM', `
    <form id="contact-form">
      <div class="form-group">
        <label>Nama *</label>
        <input type="text" id="contact-name" required placeholder="Nama lengkap">
      </div>
      <div class="form-group">
        <label>No. WhatsApp</label>
        <input type="tel" id="contact-phone" placeholder="08xx...">
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="contact-email" placeholder="email@example.com">
      </div>
      <div class="form-group">
        <label>Stage</label>
        <select id="contact-stage">
          ${CRM_STAGES.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Catatan</label>
        <textarea id="contact-note" rows="2" placeholder="Catatan interaksi awal"></textarea>
      </div>
      <div class="form-group">
        <label>Tanggal Follow Up</label>
        <input type="date" id="contact-followup">
      </div>
    </form>`,
    [
      { label: 'Batal', className: 'btn-ghost', onClick: closeModal },
      { label: 'Simpan', className: 'btn-primary', onClick: saveContact }
    ]
  );
}

/** Simpan kontak CRM baru */
async function saveContact() {
  const name = document.getElementById('contact-name')?.value.trim();
  if (!name) { showToast('Nama kontak wajib diisi.', 'warning'); return; }

  const data = {
    name,
    phone: document.getElementById('contact-phone')?.value.trim(),
    email: document.getElementById('contact-email')?.value.trim(),
    stage: document.getElementById('contact-stage')?.value,
    note: document.getElementById('contact-note')?.value.trim(),
    followUpDate: document.getElementById('contact-followup')?.value,
    token: getToken()
  };

  try {
    const result = await api('saveCRMContact', data, true);
    if (!result.success) throw new Error(result.message);
    showToast('Kontak berhasil disimpan!', 'success');
    closeModal();
    appState.adminData.crm = null;
    await loadCRM();
  } catch (err) {
    showToast('Gagal menyimpan kontak: ' + err.message, 'error');
  }
}

/** Buka detail kontak CRM */
async function openContactDetail(contactId) {
  try {
    const result = await api('getCRMContactDetail', { contactId, token: getToken() });
    if (!result.success) throw new Error(result.message);
    const c = result.data;
    openModal(`Kontak: ${escapeHtml(c.name)}`, `
      <div class="contact-detail">
        <p><strong>Phone:</strong> ${escapeHtml(c.phone || '—')}</p>
        <p><strong>Email:</strong> ${escapeHtml(c.email || '—')}</p>
        <p><strong>Stage:</strong> ${escapeHtml(c.stage)}</p>
        <p><strong>Follow Up:</strong> ${formatDate(c.followUpDate)}</p>
        <h5>Riwayat Interaksi</h5>
        ${(c.interactions || []).map(i => `
          <div class="interaction-item">
            <small>${formatDate(i.date)}</small>
            <p>${escapeHtml(i.note)}</p>
          </div>`).join('') || '<p>Belum ada interaksi.</p>'}
        <div class="form-group">
          <label>Tambah Catatan</label>
          <textarea id="new-interaction-note" rows="2" placeholder="Catatan interaksi baru"></textarea>
          <button class="btn-secondary btn-sm" onclick="addInteractionNote('${contactId}')">Tambah</button>
        </div>
        <div class="form-group">
          <label>Pindah Stage</label>
          <select id="contact-stage-change">
            ${CRM_STAGES.map(s => `<option value="${s}" ${s === c.stage ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <button class="btn-secondary btn-sm" onclick="updateContactStage('${contactId}')">Update Stage</button>
        </div>
      </div>`,
      [{ label: 'Tutup', className: 'btn-ghost', onClick: closeModal }]
    );
  } catch (err) {
    showToast('Gagal memuat detail kontak: ' + err.message, 'error');
  }
}

/** Tambah catatan interaksi CRM */
async function addInteractionNote(contactId) {
  const note = document.getElementById('new-interaction-note')?.value.trim();
  if (!note) { showToast('Tulis catatan terlebih dahulu.', 'warning'); return; }
  try {
    const result = await api('addCRMInteraction', { contactId, note, token: getToken() }, true);
    if (!result.success) throw new Error(result.message);
    showToast('Catatan berhasil ditambahkan.', 'success');
    openContactDetail(contactId);
  } catch (err) {
    showToast('Gagal menambah catatan: ' + err.message, 'error');
  }
}

/** Update stage kontak CRM */
async function updateContactStage(contactId) {
  const stage = document.getElementById('contact-stage-change')?.value;
  try {
    const result = await api('updateCRMStage', { contactId, stage, token: getToken() }, true);
    if (!result.success) throw new Error(result.message);
    showToast(`Stage diperbarui ke "${stage}".`, 'success');
    closeModal();
    appState.adminData.crm = null;
    await loadCRM();
  } catch (err) {
    showToast('Gagal update stage: ' + err.message, 'error');
  }
}

// ============================================================
// CHART.JS INTEGRATION (Admin)
// ============================================================

/** Simpan referensi chart agar bisa dihancurkan sebelum re-render */
const _charts = {};

/**
 * Render grafik pendapatan 30 hari (line chart).
 * @param {object} data - { labels: string[], values: number[] }
 */
function renderRevenueChart(data) {
  const canvas = document.getElementById('revenue-chart');
  if (!canvas || !data) return;

  if (typeof Chart === 'undefined') {
    console.warn('Chart.js belum dimuat.');
    return;
  }

  if (_charts.revenue) _charts.revenue.destroy();

  _charts.revenue = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.labels || [],
      datasets: [{
        label: 'Pendapatan (Rp)',
        data: data.values || [],
        borderColor: '#5B50AD',
        backgroundColor: '#EEEAF8',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#5B50AD',
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `Rp ${formatRupiah(ctx.raw)}`
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: v => `Rp ${formatRupiah(v)}` }
        }
      }
    }
  });
}

/**
 * Render grafik penjualan kelas (bar chart).
 * @param {object} data
 */
function renderSalesChart(data) {
  const canvas = document.getElementById('sales-chart');
  if (!canvas || !data || typeof Chart === 'undefined') return;

  if (_charts.sales) _charts.sales.destroy();

  _charts.sales = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: data.labels || [],
      datasets: [{
        label: 'Penjualan',
        data: data.values || [],
        backgroundColor: '#5B50AD',
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } }
    }
  });
}

/**
 * Render grafik pertumbuhan member (line chart).
 * @param {object} data
 */
function renderMemberChart(data) {
  const canvas = document.getElementById('member-chart');
  if (!canvas || !data || typeof Chart === 'undefined') return;

  if (_charts.member) _charts.member.destroy();

  _charts.member = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.labels || [],
      datasets: [{
        label: 'Member Baru',
        data: data.values || [],
        borderColor: '#4CAF50',
        backgroundColor: '#E8F5E9',
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } }
    }
  });
}

// ============================================================
// MOBILE SIDEBAR DRAWER
// ============================================================

/** Buka/tutup sidebar mobile */
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar) return;

  const isOpen = sidebar.classList.toggle('open');
  if (overlay) overlay.classList.toggle('active', isOpen);
  document.body.style.overflow = isOpen ? 'hidden' : '';
}

/** Tutup sidebar mobile */
function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
  document.body.style.overflow = '';
}

/** Inisialisasi event listener untuk sidebar mobile */
function initMobileDrawer() {
  // Tombol hamburger
  const hamburger = document.getElementById('btn-hamburger');
  if (hamburger) hamburger.addEventListener('click', toggleSidebar);

  // Klik overlay untuk tutup
  const overlay = document.getElementById('sidebar-overlay');
  if (overlay) overlay.addEventListener('click', closeSidebar);

  // Tutup sidebar saat layar melebar ke desktop
  window.matchMedia('(min-width: 768px)').addEventListener('change', e => {
    if (e.matches) closeSidebar();
  });
}

// ============================================================
// SEARCH & FILTER (Instant, client-side)
// ============================================================

/** Simpan timeout debounce untuk setiap input */
const _debounceMap = {};

/**
 * Inisialisasi search dengan debounce pada input tertentu.
 * @param {string} inputId - ID elemen input
 * @param {Array} dataArray - Array data asli untuk difilter
 * @param {Function} renderFn - Fungsi untuk render hasil filter
 */
function initSearch(inputId, dataArray, renderFn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  input.addEventListener('input', () => {
    clearTimeout(_debounceMap[inputId]);
    _debounceMap[inputId] = setTimeout(() => {
      const kw = input.value.toLowerCase().trim();
      const filtered = kw
        ? dataArray.filter(item =>
            Object.values(item).some(v =>
              String(v).toLowerCase().includes(kw)
            )
          )
        : dataArray;
      renderFn(filtered);
    }, SEARCH_DEBOUNCE_MS);
  });
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

/** Counter untuk ID unik toast */
let _toastCounter = 0;

/**
 * Tampilkan toast notification.
 * @param {string} message - Pesan yang ditampilkan
 * @param {'success'|'error'|'warning'|'info'} type - Jenis toast
 * @param {number} duration - Durasi tampil dalam ms
 */
function showToast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      display: flex; flex-direction: column; gap: 8px; align-items: flex-end;`;
    document.body.appendChild(container);
  }

  const id = `toast-${++_toastCounter}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const colors = {
    success: '#4CAF50', error: '#F44336',
    warning: '#FF9800', info: '#5B50AD'
  };

  const toast = document.createElement('div');
  toast.id = id;
  toast.style.cssText = `
    background: white; color: #333; border-left: 4px solid ${colors[type] || colors.info};
    padding: 12px 16px; border-radius: 8px; min-width: 260px; max-width: 360px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12); display: flex; align-items: center; gap: 10px;
    animation: toastSlideIn 0.3s ease-out; font-size: 14px; cursor: pointer;`;

  toast.innerHTML = `
    <span style="font-size:18px;">${icons[type] || icons.info}</span>
    <span style="flex:1;">${escapeHtml(message)}</span>
    <button onclick="document.getElementById('${id}').remove()"
            style="background:none;border:none;cursor:pointer;font-size:18px;line-height:1;color:#999;">×</button>`;

  // Inject animasi jika belum ada
  if (!document.getElementById('toast-styles')) {
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
      @keyframes toastSlideIn {
        from { transform: translateX(120%); opacity: 0; }
        to   { transform: translateX(0);    opacity: 1; }
      }
      @keyframes toastSlideOut {
        from { transform: translateX(0);    opacity: 1; }
        to   { transform: translateX(120%); opacity: 0; }
      }`;
    document.head.appendChild(style);
  }

  container.appendChild(toast);
  toast.addEventListener('click', () => removeToast(id));

  // Auto-dismiss
  setTimeout(() => removeToast(id), duration);
}

/**
 * Hapus toast dengan animasi keluar.
 * @param {string} id - ID elemen toast
 */
function removeToast(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.animation = 'toastSlideOut 0.3s ease-in forwards';
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

// ============================================================
// LOADING SKELETONS
// ============================================================

/**
 * Tampilkan skeleton loading di dalam section.
 * @param {string} sectionId - ID section yang akan diberi skeleton
 */
function showSkeleton(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return;

  const existing = section.querySelector('.skeleton-overlay');
  if (existing) return;

  const skeleton = document.createElement('div');
  skeleton.className = 'skeleton-overlay';
  skeleton.style.cssText = `
    position: absolute; inset: 0; background: rgba(255,255,255,0.8);
    z-index: 10; padding: 24px; border-radius: inherit;`;

  skeleton.innerHTML = Array(4).fill(0).map(() => `
    <div style="margin-bottom:16px;">
      <div class="skeleton-line" style="width:60%;height:20px;margin-bottom:8px;"></div>
      <div class="skeleton-line" style="width:100%;height:14px;margin-bottom:4px;"></div>
      <div class="skeleton-line" style="width:80%;height:14px;"></div>
    </div>`).join('');

  if (!document.getElementById('skeleton-styles')) {
    const style = document.createElement('style');
    style.id = 'skeleton-styles';
    style.textContent = `
      .skeleton-line {
        background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
        background-size: 200% 100%;
        animation: shimmer 1.5s infinite;
        border-radius: 4px;
      }
      @keyframes shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }`;
    document.head.appendChild(style);
  }

  if (getComputedStyle(section).position === 'static') {
    section.style.position = 'relative';
  }
  section.appendChild(skeleton);
}

/**
 * Hapus skeleton loading dari section.
 * @param {string} sectionId
 */
function hideSkeleton(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  section.querySelectorAll('.skeleton-overlay').forEach(el => el.remove());
}

// ============================================================
// MODAL SYSTEM
// ============================================================

/**
 * Buka modal dialog.
 * @param {string} title - Judul modal
 * @param {string} content - HTML konten modal
 * @param {Array<{label:string, className:string, onClick:Function}>} actions - Tombol aksi
 */
function openModal(title, content, actions = []) {
  closeModal();

  const overlay = document.createElement('div');
  overlay.id = 'modal-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000;
    display: flex; align-items: center; justify-content: center; padding: 16px;`;

  const modal = document.createElement('div');
  modal.id = 'modal-dialog';
  modal.style.cssText = `
    background: white; border-radius: 16px; padding: 24px;
    max-width: 540px; width: 100%; max-height: 85vh;
    overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.2);
    animation: modalIn 0.2s ease-out;`;

  if (!document.getElementById('modal-styles')) {
    const style = document.createElement('style');
    style.id = 'modal-styles';
    style.textContent = `
      @keyframes modalIn {
        from { transform: scale(0.9); opacity: 0; }
        to   { transform: scale(1);   opacity: 1; }
      }`;
    document.head.appendChild(style);
  }

  const actionsHtml = actions.map(a =>
    `<button class="${a.className || 'btn-ghost'}" data-modal-action="${a.label}">${a.label}</button>`
  ).join('');

  modal.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
      <h3 style="margin:0;font-size:18px;">${escapeHtml(title)}</h3>
      <button onclick="closeModal()"
              style="background:none;border:none;font-size:24px;cursor:pointer;color:#999;line-height:1;">×</button>
    </div>
    <div id="modal-content">${content}</div>
    ${actions.length ? `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">${actionsHtml}</div>` : ''}`;

  // Pasang event listener ke tombol aksi
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  actions.forEach(a => {
    const btn = modal.querySelector(`[data-modal-action="${a.label}"]`);
    if (btn && a.onClick) btn.addEventListener('click', a.onClick);
  });

  // Klik overlay untuk tutup
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal();
  });

  // Tutup dengan Escape
  document.addEventListener('keydown', _handleModalEscape);
}

/** Handler Escape untuk modal */
function _handleModalEscape(e) {
  if (e.key === 'Escape') closeModal();
}

/** Tutup modal yang sedang aktif */
function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) {
    overlay.remove();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', _handleModalEscape);
  }
}

/**
 * Tampilkan dialog konfirmasi.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function confirmDialog(message) {
  return new Promise(resolve => {
    openModal('Konfirmasi', `<p style="margin:0;font-size:16px;">${escapeHtml(message)}</p>`, [
      { label: 'Batal', className: 'btn-ghost', onClick: () => { closeModal(); resolve(false); } },
      { label: 'Ya, Lanjutkan', className: 'btn-primary', onClick: () => { closeModal(); resolve(true); } }
    ]);
  });
}

/**
 * Tampilkan dialog prompt input.
 * @param {string} message
 * @returns {Promise<string|null>}
 */
function promptDialog(message) {
  return new Promise(resolve => {
    openModal('Input', `
      <p style="margin:0 0 12px;">${escapeHtml(message)}</p>
      <input type="text" id="prompt-input" class="form-control"
             style="width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:8px;">`,
      [
        { label: 'Batal', className: 'btn-ghost', onClick: () => { closeModal(); resolve(null); } },
        { label: 'OK', className: 'btn-primary', onClick: () => {
          const val = document.getElementById('prompt-input')?.value.trim() || '';
          closeModal();
          resolve(val);
        }}
      ]
    );
    setTimeout(() => document.getElementById('prompt-input')?.focus(), 50);
  });
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Escape HTML untuk mencegah XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format angka ke format Rupiah (tanpa simbol Rp).
 * @param {number} num
 * @returns {string}
 */
function formatRupiah(num) {
  return Number(num || 0).toLocaleString('id-ID');
}

/**
 * Format tanggal ke format Indonesia (DD MMMM YYYY).
 * @param {string|Date} dateStr
 * @returns {string}
 */
function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) {
    return String(dateStr);
  }
}

/**
 * Potong teks panjang dengan ellipsis.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(text, maxLen = 100) {
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

/**
 * Tambahkan angka nol di depan jika satu digit.
 * @param {number} n
 * @returns {string}
 */
function pad(n) {
  return String(Math.max(0, n)).padStart(2, '0');
}

// ============================================================
// INIT & ROUTER (DOMContentLoaded)
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // 1. Inisialisasi tema
  initTheme();

  // 2. Inisialisasi navigasi SPA
  initNavigation();

  // 3. Inisialisasi sidebar mobile
  initMobileDrawer();
  updateUserProfileUI();

  // 4. Cek sesi tersimpan di localStorage
  const savedSession = localStorage.getItem(SESSION_KEY);
  if (savedSession) {
    try {
      const session = JSON.parse(savedSession);
      if (session && session.token) {
        appState.user = session;

        // Arahkan ke dashboard sesuai role
        if (session.role === 'admin') {
          navigateTo('dashboard-admin');
        } else {
          navigateTo('dashboard-member');
        }
      } else {
        navigateTo('katalog');
      }
    } catch (_) {
      localStorage.removeItem(SESSION_KEY);
      navigateTo('katalog');
    }
  } else {
    // Tampilkan katalog publik untuk pengunjung
    navigateTo('katalog');
  }

  // 5. Tangani routing dari URL hash (deep link)
  if (location.hash) {
    const section = location.hash.slice(1);
    // Navigasikan ke section dari hash, tapi jangan override jika sudah ada sesi
    if (section && !savedSession) {
      navigateTo(section);
    } else if (section && savedSession) {
      navigateTo(section);
    }
  }

  // 6. Inisialisasi Google Login setelah DOM siap
  // Google Identity Services mungkin belum selesai dimuat, tunggu sebentar
  if (typeof google !== 'undefined' && google.accounts) {
    initGoogleLogin();
  } else {
    window.addEventListener('google-identity-ready', initGoogleLogin);
    // Fallback: coba inisialisasi setelah 1 detik
    setTimeout(() => {
      if (typeof google !== 'undefined' && google.accounts && !window._googleLoginInitialized) {
        window._googleLoginInitialized = true;
        initGoogleLogin();
      }
    }, 1000);
  }

  // 7. Daftarkan fungsi global agar bisa dipanggil dari HTML inline
  window.navigateTo = navigateTo;
  window.logout = logout;
  window.setTheme = setTheme;
  window.toggleSidebar = toggleSidebar;
  window.closeSidebar = closeSidebar;
  window.showToast = showToast;
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.confirmDialog = confirmDialog;
  window.reviewPayment = reviewPayment;
  window.openCourseEditor = openCourseEditor;
  window.openModuleManager = openModuleManager;
  window.openModuleEditor = openModuleEditor;
  window.openLessonEditor = openLessonEditor;
  window.deleteCourse = deleteCourse;
  window.loadLesson = loadLesson;
  window.markLessonComplete = markLessonComplete;
  window.toggleAccordion = toggleAccordion;
  window.uploadPaymentProof = uploadPaymentProof;
  window.createOrder = createOrder;
  window.getSelectedMethod = getSelectedMethod;
  window.loadAdminOrders = loadAdminOrders;
  window.loadCRM = loadCRM;
  window.openAddContactModal = openAddContactModal;
  window.openContactDetail = openContactDetail;
  window.addInteractionNote = addInteractionNote;
  window.updateContactStage = updateContactStage;
  window.handleBuyCourse = handleBuyCourse;
  window.viewMemberDetail = viewMemberDetail;
  window.filterMembers = filterMembers;
  window.changePage = window.changePage || (() => {});
});

// ============================================================
// EKSPOS FUNGSI GLOBAL TAMBAHAN (untuk kompatibilitas HTML inline)
// ============================================================

window.initGoogleLogin = initGoogleLogin;
window.handleGoogleCredential = handleGoogleCredential;
window.isLoggedIn = isLoggedIn;
window.isAdmin = isAdmin;
window.isMember = isMember;
window.getToken = getToken;
window.apiGet = apiGet;
window.apiPost = apiPost;
window.api = api;

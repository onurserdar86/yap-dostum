// Yap-Dostum — ana uygulama mantığı
// Firebase JS SDK (modular, CDN üzerinden ES module olarak yüklenir)

import { firebaseConfig } from "./firebase-config.js";
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, orderBy, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ---------- Firebase init ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function getSecondaryAuth() {
  // Yeni kullanıcı hesabı oluştururken mevcut oturumu (admin/sahip) etkilememek için
  // ayrı bir Firebase App örneği kullanıyoruz.
  let secApp;
  try { secApp = getApp("Secondary"); } catch (e) { secApp = initializeApp(firebaseConfig, "Secondary"); }
  return getAuth(secApp);
}

// ---------- Sabitler ----------
const DAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];
const DAY_SHORT = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
const root = document.getElementById("app");

let currentUser = null; // {uid, username, displayName, role, ownerId, active}

// ---------- Yardımcılar ----------
function pad(n) { return n.toString().padStart(2, "0"); }
function formatDateLocal(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function formatTRDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}
function todayDayIndex(d = new Date()) { return (d.getDay() + 6) % 7; } // 0=Pzt ... 6=Paz
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return formatDateLocal(d);
}
function usernameToEmail(username) {
  const clean = username.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  return `${clean}@yapdostum.local`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function friendlyError(e) {
  const code = e && e.code ? e.code : "";
  const map = {
    "auth/invalid-credential": "Kullanıcı adı veya şifre hatalı.",
    "auth/wrong-password": "Kullanıcı adı veya şifre hatalı.",
    "auth/user-not-found": "Kullanıcı adı veya şifre hatalı.",
    "auth/email-already-in-use": "Bu kullanıcı adı zaten kullanılıyor.",
    "auth/weak-password": "Şifre en az 6 karakter olmalı.",
    "auth/too-many-requests": "Çok fazla deneme yapıldı, biraz sonra tekrar dene.",
  };
  return map[code] || (e && e.message) || "Bir hata oluştu.";
}
// Bir görevin (item) verilen tarihte geçerli olup olmadığını checklist'in
// başlangıç/bitiş tarihine göre kontrol eder.
function inRange(item, dateStr) {
  if (item.startDate && dateStr < item.startDate) return false;
  if (item.endDate && dateStr > item.endDate) return false;
  return true;
}

// ---------- Konum (Dost görev tamamlarken) ----------
let locationPrimed = false;
// Uygulamaya girer girmez konum iznini bir kez "ısıtır" (tarayıcı izin diyaloğunu erkenden gösterir),
// böylece Dost bir görevi tamamlarken beklemeden konum alınabilir.
function primeLocationPermission() {
  if (locationPrimed || !("geolocation" in navigator)) return;
  locationPrimed = true;
  try {
    navigator.geolocation.getCurrentPosition(() => {}, () => {}, { maximumAge: 300000, timeout: 5000 });
  } catch (e) { /* yoksay */ }
}
function getCurrentLocationSafe(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) { resolve(null); return; }
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy || null,
        });
      },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60000 }
    );
  });
}

// ---------- Firestore yardımcıları ----------
async function getUserDoc(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}
async function listUsersByRole(role, ownerId = null) {
  let q;
  if (ownerId) q = query(collection(db, "users"), where("role", "==", role), where("ownerId", "==", ownerId));
  else q = query(collection(db, "users"), where("role", "==", role));
  const snap = await getDocs(q);
  const list = [];
  snap.forEach(d => list.push({ uid: d.id, ...d.data() }));
  list.sort((a, b) => (a.displayName || "").localeCompare(b.displayName || "", "tr"));
  return list;
}
async function isSetupDone() {
  const snap = await getDoc(doc(db, "meta", "setup"));
  return snap.exists() && snap.data().adminCreated === true;
}

// ---------- Kullanıcı oluşturma (admin->sahip, sahip->dost) ----------
async function createManagedUser({ username, password, displayName, role, ownerId }) {
  const secAuth = getSecondaryAuth();
  const email = usernameToEmail(username);
  const cred = await createUserWithEmailAndPassword(secAuth, email, password);
  await setDoc(doc(db, "users", cred.user.uid), {
    username: username.trim().toLowerCase(),
    displayName: displayName.trim(),
    role, ownerId: ownerId || null,
    active: true,
    createdAt: serverTimestamp(),
  });
  await signOut(secAuth);
  return cred.user.uid;
}

// ============================================================
// GİRİŞ / İLK KURULUM EKRANLARI
// ============================================================
async function renderLogin() {
  const setupDone = await isSetupDone().catch(() => true);
  if (!setupDone) return renderFirstSetup();

  root.innerHTML = `
    <div class="login-wrap">
      <img src="logo.svg" alt="Yap-Dostum" class="login-logo-img">
      <div class="login-logo">Yap<span>-</span>Dostum</div>
      <div class="login-tag">Haftalık checklist ve görev takip uygulaması</div>
      <div class="card">
        <label>Kullanıcı adı</label>
        <input type="text" id="li-username" autocapitalize="none" autocomplete="username">
        <label>Şifre</label>
        <input type="password" id="li-password" autocomplete="current-password">
        <div class="error-text" id="li-error"></div>
        <button class="btn btn-primary btn-block mt16" id="li-submit">Giriş Yap</button>
      </div>
    </div>
  `;
  document.getElementById("li-submit").onclick = async () => {
    const username = document.getElementById("li-username").value;
    const password = document.getElementById("li-password").value;
    const errEl = document.getElementById("li-error");
    errEl.textContent = "";
    if (!username || !password) { errEl.textContent = "Kullanıcı adı ve şifre gerekli."; return; }
    try {
      await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
    } catch (e) {
      errEl.textContent = friendlyError(e);
    }
  };
}

async function renderFirstSetup() {
  root.innerHTML = `
    <div class="login-wrap">
      <img src="logo.svg" alt="Yap-Dostum" class="login-logo-img">
      <div class="login-logo">Yap<span>-</span>Dostum</div>
      <div class="login-tag">İlk kurulum — Admin hesabı oluştur</div>
      <div class="card">
        <label>Ad Soyad</label>
        <input type="text" id="su-name">
        <label>Kullanıcı adı</label>
        <input type="text" id="su-username" autocapitalize="none">
        <label>Şifre</label>
        <input type="password" id="su-password">
        <div class="hint">Bu ekran sadece uygulamada hiç admin yokken bir kez görünür.</div>
        <div class="error-text" id="su-error"></div>
        <button class="btn btn-primary btn-block mt16" id="su-submit">Admin Hesabı Oluştur</button>
      </div>
    </div>
  `;
  document.getElementById("su-submit").onclick = async () => {
    const displayName = document.getElementById("su-name").value.trim();
    const username = document.getElementById("su-username").value.trim();
    const password = document.getElementById("su-password").value;
    const errEl = document.getElementById("su-error");
    errEl.textContent = "";
    if (!displayName || !username || password.length < 6) {
      errEl.textContent = "Tüm alanları doldur, şifre en az 6 karakter olsun.";
      return;
    }
    try {
      const cred = await createUserWithEmailAndPassword(auth, usernameToEmail(username), password);
      await setDoc(doc(db, "users", cred.user.uid), {
        username: username.toLowerCase(), displayName, role: "admin",
        ownerId: null, active: true, createdAt: serverTimestamp(),
      });
      await setDoc(doc(db, "meta", "setup"), { adminCreated: true });
      // onAuthStateChanged otomatik olarak admin ekranına yönlendirecek
    } catch (e) {
      errEl.textContent = friendlyError(e);
    }
  };
}

function topbar(title, sub) {
  return `
    <div class="topbar">
      <div class="topbar-left">
        <img src="logo.svg" alt="Yap-Dostum" class="topbar-logo">
        <div>
          <h1>${escapeHtml(title)}</h1>
          ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" id="logout-btn">Çıkış</button>
    </div>
  `;
}
function wireLogout() {
  const b = document.getElementById("logout-btn");
  if (b) b.onclick = () => signOut(auth);
}

// ============================================================
// ADMIN GÖRÜNÜMÜ
// ============================================================
async function renderAdmin() {
  root.innerHTML = topbar("Yap-Dostum · Admin", currentUser.displayName) + `
    <div class="container">
      <div class="card">
        <h2>Yeni Sahip Ekle</h2>
        <label>Ad Soyad</label>
        <input type="text" id="ns-name">
        <label>Kullanıcı adı</label>
        <input type="text" id="ns-username" autocapitalize="none">
        <label>Şifre</label>
        <input type="password" id="ns-password">
        <div class="error-text" id="ns-error"></div>
        <button class="btn btn-primary btn-block mt16" id="ns-submit">Sahip Oluştur</button>
      </div>
      <div class="card">
        <h2>Sahip Kullanıcıları</h2>
        <div id="owner-list" class="empty">Yükleniyor…</div>
      </div>
    </div>
  `;
  wireLogout();

  document.getElementById("ns-submit").onclick = async () => {
    const displayName = document.getElementById("ns-name").value.trim();
    const username = document.getElementById("ns-username").value.trim();
    const password = document.getElementById("ns-password").value;
    const errEl = document.getElementById("ns-error");
    errEl.textContent = "";
    if (!displayName || !username || password.length < 6) {
      errEl.textContent = "Tüm alanları doldur, şifre en az 6 karakter olsun."; return;
    }
    try {
      await createManagedUser({ username, password, displayName, role: "owner", ownerId: currentUser.uid });
      document.getElementById("ns-name").value = "";
      document.getElementById("ns-username").value = "";
      document.getElementById("ns-password").value = "";
      await loadOwnerList();
    } catch (e) {
      errEl.textContent = friendlyError(e);
    }
  };

  await loadOwnerList();
}

async function loadOwnerList() {
  const listEl = document.getElementById("owner-list");
  const owners = await listUsersByRole("owner");
  if (!owners.length) { listEl.innerHTML = `<div class="empty">Henüz sahip kullanıcı yok.</div>`; return; }
  listEl.innerHTML = "";
  owners.forEach(o => {
    const row = el(`
      <div class="list-item">
        <div class="info">
          <div class="name">${escapeHtml(o.displayName)}</div>
          <div class="meta">@${escapeHtml(o.username)} · <span class="badge ${o.active === false ? "inactive" : ""}">${o.active === false ? "Pasif" : "Aktif"}</span></div>
        </div>
        <button class="btn btn-outline btn-sm" data-uid="${o.uid}" data-active="${o.active !== false}">${o.active === false ? "Aktifleştir" : "Pasifleştir"}</button>
      </div>
    `);
    row.querySelector("button").onclick = async (e) => {
      const uid = e.target.getAttribute("data-uid");
      const isActive = e.target.getAttribute("data-active") === "true";
      await updateDoc(doc(db, "users", uid), { active: !isActive });
      await loadOwnerList();
    };
    listEl.appendChild(row);
  });
}

// ============================================================
// SAHİP (OWNER) GÖRÜNÜMÜ
// ============================================================
let ownerTab = "friends";
let ownerFriendsCache = null; // null = henüz yüklenmedi

async function ensureFriendsLoaded(force = false) {
  if (force || ownerFriendsCache === null) {
    ownerFriendsCache = await listUsersByRole("friend", currentUser.uid);
  }
  return ownerFriendsCache;
}

async function renderOwner() {
  root.innerHTML = topbar("Yap-Dostum · Sahip", currentUser.displayName) + `
    <div class="tabs">
      <button class="tab-btn ${ownerTab === "friends" ? "active" : ""}" data-tab="friends">Dostlarım</button>
      <button class="tab-btn ${ownerTab === "checklists" ? "active" : ""}" data-tab="checklists">Checklistler</button>
      <button class="tab-btn ${ownerTab === "tracking" ? "active" : ""}" data-tab="tracking">Takip</button>
    </div>
    <div class="container" id="owner-body"><div class="empty">Yükleniyor…</div></div>
  `;
  wireLogout();
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.onclick = () => {
      const newTab = b.getAttribute("data-tab");
      if (newTab !== "checklists") renderOwnerChecklists._editing = null;
      ownerTab = newTab;
      renderOwner();
    };
  });

  if (ownerTab === "friends") await renderOwnerFriends();
  else if (ownerTab === "checklists") await renderOwnerChecklists();
  else await renderOwnerTracking();
}

async function renderOwnerFriends() {
  const body = document.getElementById("owner-body");
  const friends = await ensureFriendsLoaded();
  body.innerHTML = `
    <div class="card">
      <h2>Yeni Dost Ekle</h2>
      <label>Ad Soyad</label>
      <input type="text" id="nf-name">
      <label>Kullanıcı adı</label>
      <input type="text" id="nf-username" autocapitalize="none">
      <label>Şifre</label>
      <input type="password" id="nf-password">
      <div class="error-text" id="nf-error"></div>
      <button class="btn btn-primary btn-block mt16" id="nf-submit">Dost Oluştur</button>
    </div>
    <div class="card">
      <h2>Dostlarım</h2>
      <div id="friend-list" class="empty">${friends.length ? "" : "Henüz dost eklemedin."}</div>
    </div>
  `;
  document.getElementById("nf-submit").onclick = async () => {
    const displayName = document.getElementById("nf-name").value.trim();
    const username = document.getElementById("nf-username").value.trim();
    const password = document.getElementById("nf-password").value;
    const errEl = document.getElementById("nf-error");
    errEl.textContent = "";
    if (!displayName || !username || password.length < 6) {
      errEl.textContent = "Tüm alanları doldur, şifre en az 6 karakter olsun."; return;
    }
    try {
      await createManagedUser({ username, password, displayName, role: "friend", ownerId: currentUser.uid });
      await ensureFriendsLoaded(true);
      await renderOwnerFriends();
    } catch (e) {
      errEl.textContent = friendlyError(e);
    }
  };

  const listEl = document.getElementById("friend-list");
  if (!friends.length) return;
  listEl.innerHTML = "";
  friends.forEach(f => {
    const row = el(`
      <div class="list-item">
        <div class="info">
          <div class="name">${escapeHtml(f.displayName)}</div>
          <div class="meta">@${escapeHtml(f.username)} · <span class="badge ${f.active === false ? "inactive" : ""}">${f.active === false ? "Pasif" : "Aktif"}</span></div>
        </div>
        <button class="btn btn-outline btn-sm" data-uid="${f.uid}" data-active="${f.active !== false}">${f.active === false ? "Aktifleştir" : "Pasifleştir"}</button>
      </div>
    `);
    row.querySelector("button").onclick = async (e) => {
      const uid = e.target.getAttribute("data-uid");
      const isActive = e.target.getAttribute("data-active") === "true";
      await updateDoc(doc(db, "users", uid), { active: !isActive });
      await ensureFriendsLoaded(true);
      await renderOwnerFriends();
    };
    listEl.appendChild(row);
  });
}

async function fetchOwnerChecklists() {
  const q = query(collection(db, "checklists"), where("ownerId", "==", currentUser.uid));
  const snap = await getDocs(q);
  const list = [];
  snap.forEach(d => list.push({ id: d.id, ...d.data() }));
  list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return list;
}
// Sahibin TÜM görevlerini tek sorguda getirir (checklist başına ayrı sorgu yapmaktan
// çok daha hızlıdır); sonuç checklistId'ye göre grupla.
async function fetchOwnerItemsAll() {
  const q = query(collection(db, "items"), where("ownerId", "==", currentUser.uid));
  const snap = await getDocs(q);
  const list = [];
  snap.forEach(d => list.push({ id: d.id, ...d.data() }));
  return list;
}

// Görev tekrarlayan mı (gün+metin) yoksa belirli bir tarihe mi (tarih+metin) bağlı,
// buna göre benzersiz bir anahtar üretir. Düzenlerken aynı anahtara sahip görevler
// KORUNUR (geçmiş işaretlemeleri kaybolmaz), farklı olanlar oluşturulur/silinir.
function itemKey(it) {
  const type = it.type === "specific" ? "specific" : "recurring";
  return type === "specific" ? `specific|${it.date}|${it.text}` : `recurring|${it.day}|${it.text}`;
}

// Bir checklist'i düzenlerken: checklist dokümanını günceller; görevlerde ise
// aynı kalanları KORUYARAK günceller, yeni eklenenleri oluşturur, kaldırılanları siler.
async function saveChecklistEdit(checklistId, existingItems, formData) {
  const { title, assignedTo, startDate, endDate, itemsToCreate } = formData;

  await updateDoc(doc(db, "checklists", checklistId), { title, assignedTo, startDate, endDate });

  const existingByKey = new Map();
  existingItems.forEach(it => {
    const key = itemKey(it);
    if (!existingByKey.has(key)) existingByKey.set(key, it);
  });

  const desiredKeys = new Set();
  const ops = [];
  itemsToCreate.forEach(desired => {
    const key = itemKey(desired);
    desiredKeys.add(key);
    const existing = existingByKey.get(key);
    const updatePayload = desired.type === "specific"
      ? { order: desired.order, assignedTo, active: true }
      : { order: desired.order, assignedTo, startDate, endDate, active: true };
    if (existing) {
      ops.push(updateDoc(doc(db, "items", existing.id), updatePayload));
    } else {
      ops.push(addDoc(collection(db, "items"), {
        checklistId, ownerId: currentUser.uid, assignedTo, type: desired.type,
        text: desired.text, order: desired.order, active: true,
        ...(desired.type === "specific" ? { date: desired.date } : { day: desired.day, startDate, endDate }),
      }));
    }
  });
  existingItems.forEach(it => {
    const key = itemKey(it);
    if (!desiredKeys.has(key)) ops.push(deleteDoc(doc(db, "items", it.id)));
  });

  await Promise.all(ops);
}

async function renderOwnerChecklists() {
  const body = document.getElementById("owner-body");
  body.innerHTML = `<div class="empty">Yükleniyor…</div>`;

  const [friends, checklists, allItems] = await Promise.all([
    ensureFriendsLoaded(),
    fetchOwnerChecklists(),
    fetchOwnerItemsAll(),
  ]);

  const itemsByChecklist = {};
  allItems.forEach(it => {
    (itemsByChecklist[it.checklistId] || (itemsByChecklist[it.checklistId] = [])).push(it);
  });

  const today = formatDateLocal(new Date());
  const editing = renderOwnerChecklists._editing || null; // null = yeni oluşturma modu
  const editingItems = editing ? (itemsByChecklist[editing.id] || []) : [];

  body.innerHTML = `
    <div class="card">
      <h2>${editing ? "Checklisti Düzenle" : "Yeni Checklist Oluştur"}</h2>
      ${friends.length ? "" : `<div class="hint">Önce "Dostlarım" sekmesinden en az bir dost eklemelisin.</div>`}
      <div id="new-checklist-form" style="${friends.length ? "" : "display:none"}">
        <label>Başlık</label>
        <input type="text" id="cl-title" placeholder="Örn: Ev İşleri Haftalık" value="${editing ? escapeHtml(editing.title) : ""}">
        <label>Kimin için</label>
        <select id="cl-assignee">
          ${friends.map(f => `<option value="${f.uid}" ${editing && editing.assignedTo === f.uid ? "selected" : ""}>${escapeHtml(f.displayName)}</option>`).join("")}
        </select>
        <div class="row">
          <div>
            <label>Başlangıç Tarihi</label>
            <input type="date" id="cl-start" value="${editing ? editing.startDate : today}">
          </div>
          <div>
            <label>Bitiş Tarihi (opsiyonel)</label>
            <input type="date" id="cl-end" value="${editing && editing.endDate ? editing.endDate : ""}">
          </div>
        </div>
        <div class="hint">Bitiş tarihini boş bırakırsan checklist süresiz devam eder.</div>

        <label class="mt16">Görevler</label>
        <div class="hint">Her görev "Tekrarlayan" (belirli haftalık günlerde) veya "Belirli Tarih(ler)" (sadece seçtiğin takvim günlerinde) olabilir. Tekrarlayan görevlerde tüm günler otomatik seçilir, istemediğini kaldırabilirsin.</div>
        <div id="cl-task-rows" class="mt8"></div>
        <button type="button" class="btn btn-outline btn-sm mt8" id="cl-add-row">+ Görev Ekle</button>

        <div class="error-text" id="cl-error"></div>
        <div class="row mt16">
          ${editing ? `<button type="button" class="btn btn-outline" id="cl-cancel">İptal</button>` : ""}
          <button class="btn btn-primary" id="cl-submit">${editing ? "Güncelle" : "Checklisti Kaydet"}</button>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Checklistlerim</h2>
      <div id="checklist-list" class="empty">${checklists.length ? "" : "Henüz checklist yok."}</div>
    </div>
  `;

  if (friends.length) {
    const rowsWrap = document.getElementById("cl-task-rows");
    if (editing) {
      const byOrder = {};
      editingItems.forEach(it => {
        const key = it.order ?? 0;
        const type = it.type === "specific" ? "specific" : "recurring";
        if (!byOrder[key]) byOrder[key] = { text: it.text, type, days: [], dates: [] };
        if (type === "specific") byOrder[key].dates.push(it.date);
        else byOrder[key].days.push(it.day);
      });
      const rows = Object.keys(byOrder).sort((a, b) => a - b).map(k => byOrder[k]);
      if (rows.length) rows.forEach(r => addTaskRow(rowsWrap, r));
      else addTaskRow(rowsWrap);
    } else {
      addTaskRow(rowsWrap); // başlangıçta bir satır ile başla
    }
    document.getElementById("cl-add-row").onclick = () => addTaskRow(rowsWrap);

    if (editing) {
      document.getElementById("cl-cancel").onclick = () => {
        renderOwnerChecklists._editing = null;
        renderOwnerChecklists();
      };
    }

    document.getElementById("cl-submit").onclick = async () => {
      const title = document.getElementById("cl-title").value.trim();
      const assignedTo = document.getElementById("cl-assignee").value;
      const startDate = document.getElementById("cl-start").value;
      const endDate = document.getElementById("cl-end").value || null;
      const errEl = document.getElementById("cl-error");
      errEl.textContent = "";

      if (!title) { errEl.textContent = "Başlık gerekli."; return; }
      if (!startDate) { errEl.textContent = "Başlangıç tarihi gerekli."; return; }
      if (endDate && endDate < startDate) { errEl.textContent = "Bitiş tarihi başlangıçtan önce olamaz."; return; }

      const itemsToCreate = [];
      document.querySelectorAll("#cl-task-rows .task-input-block").forEach((rowEl, idx) => {
        const text = rowEl.querySelector(".ti-text").value.trim();
        if (!text) return;
        const mode = rowEl.dataset.mode === "specific" ? "specific" : "recurring";
        if (mode === "recurring") {
          const days = Array.from(rowEl.querySelectorAll(".day-chip:not(.day-chip-all).selected"))
            .map(b => parseInt(b.getAttribute("data-day"), 10));
          days.forEach(day => itemsToCreate.push({ type: "recurring", day, text, order: idx }));
        } else {
          const dates = Array.from(rowEl.querySelectorAll(".date-chip")).map(c => c.getAttribute("data-date"));
          dates.forEach(date => itemsToCreate.push({ type: "specific", date, text, order: idx }));
        }
      });
      if (!itemsToCreate.length) { errEl.textContent = "En az bir görev ekle: tekrarlayan görevler için en az bir gün, belirli tarihli görevler için en az bir tarih seç."; return; }

      try {
        if (editing) {
          await saveChecklistEdit(editing.id, editingItems, { title, assignedTo, startDate, endDate, itemsToCreate });
          renderOwnerChecklists._editing = null;
        } else {
          const clRef = await addDoc(collection(db, "checklists"), {
            ownerId: currentUser.uid, assignedTo, title,
            startDate, endDate, active: true, createdAt: serverTimestamp(),
          });
          await Promise.all(itemsToCreate.map(it => addDoc(collection(db, "items"), {
            checklistId: clRef.id, ownerId: currentUser.uid, assignedTo, type: it.type,
            text: it.text, order: it.order, active: true,
            ...(it.type === "specific" ? { date: it.date } : { day: it.day, startDate, endDate }),
          })));
        }
        await renderOwnerChecklists();
      } catch (e) {
        errEl.textContent = friendlyError(e);
      }
    };
  }

  const listEl = document.getElementById("checklist-list");
  if (!checklists.length) return;
  listEl.innerHTML = "";
  checklists.forEach(cl => {
    const friend = friends.find(f => f.uid === cl.assignedTo);
    const items = itemsByChecklist[cl.id] || [];
    const dateRange = `${formatTRDate(cl.startDate)} – ${cl.endDate ? formatTRDate(cl.endDate) : "Süresiz"}`;
    const row = el(`
      <div class="list-item">
        <div class="info">
          <div class="name">${escapeHtml(cl.title)}</div>
          <div class="meta">${friend ? escapeHtml(friend.displayName) : "?"} · ${items.length} görev · ${dateRange}</div>
          <div class="meta"><span class="badge ${cl.active === false ? "inactive" : ""}">${cl.active === false ? "Pasif" : "Aktif"}</span></div>
        </div>
        <div class="row-actions">
          <button class="btn btn-outline btn-sm" data-edit="${cl.id}">Düzenle</button>
          <button class="btn btn-outline btn-sm" data-id="${cl.id}" data-active="${cl.active !== false}">${cl.active === false ? "Aktifleştir" : "Pasifleştir"}</button>
        </div>
      </div>
    `);
    row.querySelector("[data-edit]").onclick = () => {
      renderOwnerChecklists._editing = cl;
      renderOwnerChecklists();
    };
    row.querySelector("[data-id]").onclick = async (e) => {
      const id = e.target.getAttribute("data-id");
      const isActive = e.target.getAttribute("data-active") === "true";
      await updateDoc(doc(db, "checklists", id), { active: !isActive });
      await renderOwnerChecklists();
    };
    listEl.appendChild(row);
  });
}

// Bir görev satırının "belirli tarih" alanına yeni bir tarih çipi ekler (aynı tarih tekrar eklenmez).
function addDateChip(container, dateStr) {
  if (!dateStr) return;
  const already = Array.from(container.querySelectorAll(".date-chip")).some(c => c.getAttribute("data-date") === dateStr);
  if (already) return;
  const chip = el(`
    <span class="date-chip" data-date="${dateStr}">
      ${formatTRDate(dateStr)}
      <button type="button" class="date-chip-remove">✕</button>
    </span>
  `);
  chip.querySelector(".date-chip-remove").onclick = () => chip.remove();
  container.appendChild(chip);
}

// Checklist formunda bir "görev satırı" ekler: metin girişi + tekrarlayan/belirli tarih seçimi.
// initial = {text, type, days:[...], dates:[...]} verilirse (düzenleme modu) satır o değerlerle
// önceden doldurulur; verilmezse (yeni checklist) tekrarlayan mod + tüm günler seçili gelir.
function addTaskRow(container, initial) {
  const mode = initial && initial.type === "specific" ? "specific" : "recurring";
  const presetDays = initial && mode === "recurring" ? initial.days : null;
  const presetDates = initial && mode === "specific" ? initial.dates : [];

  const row = el(`
    <div class="task-input-block" data-mode="${mode}">
      <div class="item-input-row">
        <input type="text" class="ti-text" placeholder="Görev metni (örn: Bulaşıkları yıka)" value="${initial ? escapeHtml(initial.text) : ""}">
        <button type="button" class="icon-btn ti-remove" title="Sil">✕</button>
      </div>

      <div class="mode-toggle">
        <button type="button" class="mode-btn ${mode === "recurring" ? "active" : ""}" data-mode-btn="recurring">Tekrarlayan</button>
        <button type="button" class="mode-btn ${mode === "specific" ? "active" : ""}" data-mode-btn="specific">Belirli Tarih(ler)</button>
      </div>

      <div class="recurring-ui" style="${mode === "specific" ? "display:none" : ""}">
        <div class="day-chip-row">
          ${DAY_SHORT.map((d, i) => {
            const sel = presetDays ? presetDays.includes(i) : true;
            return `<button type="button" class="day-chip ${sel ? "selected" : ""}" data-day="${i}">${d}</button>`;
          }).join("")}
          <button type="button" class="day-chip day-chip-all" data-all="1">Tümü</button>
        </div>
      </div>

      <div class="specific-ui" style="${mode === "recurring" ? "display:none" : ""}">
        <div class="date-chip-row"></div>
        <div class="item-input-row">
          <input type="date" class="ti-date-input">
          <button type="button" class="btn btn-outline btn-sm ti-date-add">+ Ekle</button>
        </div>
      </div>
    </div>
  `);
  row.querySelector(".ti-remove").onclick = () => row.remove();

  // Mod geçişi (Tekrarlayan <-> Belirli Tarih)
  const modeBtns = row.querySelectorAll(".mode-btn");
  const recurringUi = row.querySelector(".recurring-ui");
  const specificUi = row.querySelector(".specific-ui");
  modeBtns.forEach(b => {
    b.onclick = () => {
      const m = b.getAttribute("data-mode-btn");
      row.dataset.mode = m;
      modeBtns.forEach(x => x.classList.toggle("active", x === b));
      recurringUi.style.display = m === "recurring" ? "" : "none";
      specificUi.style.display = m === "specific" ? "" : "none";
    };
  });

  // Tekrarlayan (gün rozetleri)
  const allBtn = row.querySelector(".day-chip-all");
  const dayBtns = Array.from(row.querySelectorAll(".day-chip:not(.day-chip-all)"));
  function syncAllBtn() {
    const allSelected = dayBtns.every(b => b.classList.contains("selected"));
    allBtn.classList.toggle("selected", allSelected);
  }
  dayBtns.forEach(b => {
    b.onclick = () => { b.classList.toggle("selected"); syncAllBtn(); };
  });
  allBtn.onclick = () => {
    const shouldSelect = !allBtn.classList.contains("selected");
    dayBtns.forEach(b => b.classList.toggle("selected", shouldSelect));
    allBtn.classList.toggle("selected", shouldSelect);
  };
  syncAllBtn();

  // Belirli tarih(ler)
  const dateChipRow = row.querySelector(".date-chip-row");
  (presetDates || []).forEach(d => addDateChip(dateChipRow, d));
  row.querySelector(".ti-date-add").onclick = () => {
    const inp = row.querySelector(".ti-date-input");
    if (inp.value) { addDateChip(dateChipRow, inp.value); inp.value = ""; }
  };

  container.appendChild(row);
  row.querySelector(".ti-text").focus();
}

// ---- Sahip: Takip sekmesi ----
async function renderOwnerTracking() {
  const body = document.getElementById("owner-body");
  const selectedDate = renderOwnerTracking._date || formatDateLocal(new Date());
  const selectedFriend = renderOwnerTracking._friend || "all";
  renderOwnerTracking._date = selectedDate;
  renderOwnerTracking._friend = selectedFriend;

  const friends = await ensureFriendsLoaded();

  body.innerHTML = `
    <div class="card">
      <h2>Günlük Takip</h2>
      <label>Dost</label>
      <select id="tr-friend">
        <option value="all">Tümü</option>
        ${friends.map(f => `<option value="${f.uid}" ${f.uid === selectedFriend ? "selected" : ""}>${escapeHtml(f.displayName)}</option>`).join("")}
      </select>
      <div class="date-nav mt16">
        <button class="btn btn-outline btn-sm" id="tr-prev">‹ Önceki Gün</button>
        <input type="date" id="tr-date" value="${selectedDate}">
        <button class="btn btn-outline btn-sm" id="tr-next">Sonraki Gün ›</button>
      </div>
      <div id="tr-results" class="mt16"><div class="empty">Yükleniyor…</div></div>
    </div>
  `;
  document.getElementById("tr-friend").onchange = (e) => { renderOwnerTracking._friend = e.target.value; renderOwnerTracking(); };
  document.getElementById("tr-date").onchange = (e) => { renderOwnerTracking._date = e.target.value; renderOwnerTracking(); };
  document.getElementById("tr-prev").onclick = () => { renderOwnerTracking._date = addDays(selectedDate, -1); renderOwnerTracking(); };
  document.getElementById("tr-next").onclick = () => { renderOwnerTracking._date = addDays(selectedDate, 1); renderOwnerTracking(); };

  const resultsEl = document.getElementById("tr-results");

  const dateObj = new Date(selectedDate + "T00:00:00");
  const dayIdx = todayDayIndex(dateObj);

  const friendsToShow = selectedFriend === "all" ? friends : friends.filter(f => f.uid === selectedFriend);
  if (!friendsToShow.length) { resultsEl.innerHTML = `<div class="empty">Gösterilecek dost yok.</div>`; return; }

  // Her dost için görev + tamamlanma sorgularını paralel çalıştır (sırayla beklemek yerine).
  // Görevler iki türde olabilir: tekrarlayan (day == dayIdx) veya belirli tarih (date == selectedDate).
  const blocks = await Promise.all(friendsToShow.map(async (friend) => {
    const recurringQ = query(collection(db, "items"),
      where("ownerId", "==", currentUser.uid),
      where("assignedTo", "==", friend.uid),
      where("day", "==", dayIdx),
      where("active", "==", true));
    const specificQ = query(collection(db, "items"),
      where("ownerId", "==", currentUser.uid),
      where("assignedTo", "==", friend.uid),
      where("date", "==", selectedDate),
      where("active", "==", true));
    const compQ = query(collection(db, "completions"),
      where("ownerId", "==", currentUser.uid),
      where("assignedTo", "==", friend.uid),
      where("date", "==", selectedDate));

    const [recSnap, specSnap, compSnap] = await Promise.all([getDocs(recurringQ), getDocs(specificQ), getDocs(compQ)]);

    let items = [];
    recSnap.forEach(d => items.push({ id: d.id, ...d.data() }));
    specSnap.forEach(d => items.push({ id: d.id, ...d.data() }));
    items = items.filter(it => inRange(it, selectedDate));
    items.sort((a, b) => (a.order || 0) - (b.order || 0));

    const compMap = {};
    compSnap.forEach(d => { const v = d.data(); compMap[v.itemId] = v; });

    return { friend, items, compMap };
  }));

  resultsEl.innerHTML = "";
  blocks.forEach(({ friend, items, compMap }) => {
    const doneCount = items.filter(it => compMap[it.id] && compMap[it.id].done).length;
    const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0;

    const block = el(`
      <div class="card">
        <h3>${escapeHtml(friend.displayName)} — ${DAYS[dayIdx]}</h3>
        ${items.length ? `
          <div>${doneCount}/${items.length} tamamlandı</div>
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="mt16"></div>
        ` : `<div class="empty">Bu gün için görev yok.</div>`}
      </div>
    `);
    items.forEach(it => {
      const comp = compMap[it.id];
      const done = !!(comp && comp.done);
      const loc = comp && comp.location;
      const trow = el(`
        <div class="task-row">
          <div class="check ${done ? "done" : ""}">${done ? "✓" : ""}</div>
          <div class="task-text ${done ? "done" : ""}">${escapeHtml(it.text)}${it.type === "specific" ? ` <span class="hint">(${formatTRDate(it.date)})</span>` : ""}</div>
          ${done && loc ? `<a class="loc-link" href="https://www.google.com/maps?q=${loc.lat},${loc.lng}" target="_blank" rel="noopener" title="Tamamlandığı andaki konum">📍</a>` : ""}
        </div>
      `);
      block.appendChild(trow);
    });
    resultsEl.appendChild(block);
  });
}

// ============================================================
// DOST (FRIEND) GÖRÜNÜMÜ
// ============================================================
async function renderFriend() {
  const selectedDate = renderFriend._date || formatDateLocal(new Date());
  renderFriend._date = selectedDate;
  const isToday = selectedDate === formatDateLocal(new Date());

  const dateObj = new Date(selectedDate + "T00:00:00");
  const dayIdx = todayDayIndex(dateObj);

  root.innerHTML = topbar("Yap-Dostum", currentUser.displayName) + `
    <div class="container">
      <div class="card">
        <div class="date-nav">
          <button class="btn btn-outline btn-sm" id="fr-prev">‹</button>
          <div class="center" style="flex:1">
            <div style="font-weight:700">${DAYS[dayIdx]}</div>
            <div class="hint">${selectedDate}${isToday ? " · Bugün" : ""}</div>
          </div>
          <button class="btn btn-outline btn-sm" id="fr-next">›</button>
        </div>
        <div id="fr-tasks" class="mt16"><div class="empty">Yükleniyor…</div></div>
        ${!isToday ? `<div class="hint mt16">Geçmiş/gelecek günlerde işaretleme yapılamaz, sadece bugünkü görevler işaretlenebilir.</div>` : ""}
        ${isToday ? `<div class="hint mt16">Bir görevi tamamlandı işaretlediğinde, tarayıcın izin verirse o anki konumun Sahibine gösterilir.</div>` : ""}
      </div>
    </div>
  `;
  wireLogout();
  primeLocationPermission();
  document.getElementById("fr-prev").onclick = () => { renderFriend._date = addDays(selectedDate, -1); renderFriend(); };
  document.getElementById("fr-next").onclick = () => { renderFriend._date = addDays(selectedDate, 1); renderFriend(); };

  const tasksEl = document.getElementById("fr-tasks");
  // Görevler iki türde olabilir: tekrarlayan (day == dayIdx) veya belirli tarih (date == selectedDate).
  const recurringQ = query(collection(db, "items"),
    where("assignedTo", "==", currentUser.uid),
    where("day", "==", dayIdx),
    where("active", "==", true));
  const specificQ = query(collection(db, "items"),
    where("assignedTo", "==", currentUser.uid),
    where("date", "==", selectedDate),
    where("active", "==", true));
  const [recSnap, specSnap] = await Promise.all([getDocs(recurringQ), getDocs(specificQ)]);
  let items = [];
  recSnap.forEach(d => items.push({ id: d.id, ...d.data() }));
  specSnap.forEach(d => items.push({ id: d.id, ...d.data() }));
  items = items.filter(it => inRange(it, selectedDate));
  items.sort((a, b) => (a.order || 0) - (b.order || 0));

  if (!items.length) { tasksEl.innerHTML = `<div class="empty">Bu gün için görevin yok. 🎉</div>`; return; }

  const compQ = query(collection(db, "completions"),
    where("assignedTo", "==", currentUser.uid),
    where("date", "==", selectedDate));
  const compSnap = await getDocs(compQ);
  const doneMap = {};
  compSnap.forEach(d => { const v = d.data(); doneMap[v.itemId] = !!v.done; });

  tasksEl.innerHTML = "";
  items.forEach(it => {
    const done = !!doneMap[it.id];
    const row = el(`
      <div class="task-row">
        <div class="check ${done ? "done" : ""}" data-item="${it.id}">${done ? "✓" : ""}</div>
        <div class="task-text ${done ? "done" : ""}">${escapeHtml(it.text)}${it.type === "specific" ? ` <span class="hint">(${formatTRDate(it.date)})</span>` : ""}</div>
      </div>
    `);
    if (isToday) {
      row.querySelector(".check").onclick = async (e) => {
        const itemId = e.currentTarget.getAttribute("data-item");
        const newDone = !doneMap[itemId];
        doneMap[itemId] = newDone;
        await setDoc(doc(db, "completions", `${itemId}_${selectedDate}`), {
          itemId, ownerId: it.ownerId, assignedTo: currentUser.uid,
          date: selectedDate, done: newDone, completedAt: serverTimestamp(),
        }, { merge: true });
        renderFriend(); // anında güncelle; konum arka planda ayrıca eklenir

        if (newDone) {
          const loc = await getCurrentLocationSafe();
          if (loc) {
            await setDoc(doc(db, "completions", `${itemId}_${selectedDate}`), { location: loc }, { merge: true });
          }
        }
      };
    } else {
      row.querySelector(".check").style.opacity = "0.6";
    }
    tasksEl.appendChild(row);
  });
}

// ============================================================
// AUTH DURUM DİNLEYİCİ
// ============================================================
onAuthStateChanged(auth, async (fbUser) => {
  if (!fbUser) { currentUser = null; ownerFriendsCache = null; renderOwnerChecklists._editing = null; renderLogin(); return; }
  const udoc = await getUserDoc(fbUser.uid);
  if (!udoc) { await signOut(auth); return; }
  if (udoc.active === false) {
    alert("Hesabın devre dışı bırakılmış. Lütfen sahibinle iletişime geç.");
    await signOut(auth);
    return;
  }
  currentUser = udoc;
  if (udoc.role === "admin") renderAdmin();
  else if (udoc.role === "owner") renderOwner();
  else if (udoc.role === "friend") renderFriend();
  else { await signOut(auth); }
});

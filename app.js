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
const root = document.getElementById("app");

let currentUser = null; // {uid, username, displayName, role, ownerId, active}

// ---------- Yardımcılar ----------
function pad(n) { return n.toString().padStart(2, "0"); }
function formatDateLocal(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
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
      <div>
        <h1>${escapeHtml(title)}</h1>
        ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}
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
let ownerFriendsCache = [];

async function renderOwner() {
  root.innerHTML = topbar("Yap-Dostum · Sahip", currentUser.displayName) + `
    <div class="tabs">
      <button class="tab-btn ${ownerTab === "friends" ? "active" : ""}" data-tab="friends">Dostlarım</button>
      <button class="tab-btn ${ownerTab === "checklists" ? "active" : ""}" data-tab="checklists">Checklistler</button>
      <button class="tab-btn ${ownerTab === "tracking" ? "active" : ""}" data-tab="tracking">Takip</button>
    </div>
    <div class="container" id="owner-body"></div>
  `;
  wireLogout();
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.onclick = () => { ownerTab = b.getAttribute("data-tab"); renderOwner(); };
  });

  ownerFriendsCache = await listUsersByRole("friend", currentUser.uid);

  if (ownerTab === "friends") await renderOwnerFriends();
  else if (ownerTab === "checklists") await renderOwnerChecklists();
  else await renderOwnerTracking();
}

async function renderOwnerFriends() {
  const body = document.getElementById("owner-body");
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
      <div id="friend-list" class="empty">Yükleniyor…</div>
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
      ownerFriendsCache = await listUsersByRole("friend", currentUser.uid);
      await renderOwnerFriends();
    } catch (e) {
      errEl.textContent = friendlyError(e);
    }
  };

  const listEl = document.getElementById("friend-list");
  if (!ownerFriendsCache.length) { listEl.innerHTML = `<div class="empty">Henüz dost eklemedin.</div>`; return; }
  listEl.innerHTML = "";
  ownerFriendsCache.forEach(f => {
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
      ownerFriendsCache = await listUsersByRole("friend", currentUser.uid);
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
async function fetchItemsForChecklist(checklistId) {
  const q = query(collection(db, "items"), where("checklistId", "==", checklistId));
  const snap = await getDocs(q);
  const list = [];
  snap.forEach(d => list.push({ id: d.id, ...d.data() }));
  list.sort((a, b) => a.day - b.day || (a.order || 0) - (b.order || 0));
  return list;
}

async function renderOwnerChecklists() {
  const body = document.getElementById("owner-body");
  const checklists = await fetchOwnerChecklists();
  body.innerHTML = `
    <div class="card">
      <h2>Yeni Checklist Oluştur</h2>
      ${ownerFriendsCache.length ? "" : `<div class="hint">Önce "Dostlarım" sekmesinden en az bir dost eklemelisin.</div>`}
      <div id="new-checklist-form" style="${ownerFriendsCache.length ? "" : "display:none"}">
        <label>Başlık</label>
        <input type="text" id="cl-title" placeholder="Örn: Ev İşleri Haftalık">
        <label>Kimin için</label>
        <select id="cl-assignee">
          ${ownerFriendsCache.map(f => `<option value="${f.uid}">${escapeHtml(f.displayName)}</option>`).join("")}
        </select>
        <div id="cl-days"></div>
        <div class="error-text" id="cl-error"></div>
        <button class="btn btn-primary btn-block mt16" id="cl-submit">Checklisti Kaydet</button>
      </div>
    </div>
    <div class="card">
      <h2>Checklistlerim</h2>
      <div id="checklist-list" class="empty">Yükleniyor…</div>
    </div>
  `;

  if (ownerFriendsCache.length) {
    const daysWrap = document.getElementById("cl-days");
    DAYS.forEach((dayName, idx) => {
      const group = el(`
        <div class="day-group">
          <div class="day-title">${dayName}</div>
          <div class="item-rows" data-day="${idx}"></div>
          <button type="button" class="btn btn-outline btn-sm" data-add-day="${idx}">+ Görev ekle</button>
        </div>
      `);
      daysWrap.appendChild(group);
      group.querySelector("[data-add-day]").onclick = () => addItemInputRow(group.querySelector(".item-rows"));
    });

    document.getElementById("cl-submit").onclick = async () => {
      const title = document.getElementById("cl-title").value.trim();
      const assignedTo = document.getElementById("cl-assignee").value;
      const errEl = document.getElementById("cl-error");
      errEl.textContent = "";
      const itemsToCreate = [];
      document.querySelectorAll(".item-rows").forEach(rowsEl => {
        const day = parseInt(rowsEl.getAttribute("data-day"), 10);
        rowsEl.querySelectorAll("input").forEach((inp, order) => {
          const text = inp.value.trim();
          if (text) itemsToCreate.push({ day, text, order });
        });
      });
      if (!title) { errEl.textContent = "Başlık gerekli."; return; }
      if (!itemsToCreate.length) { errEl.textContent = "En az bir gün için görev ekle."; return; }
      try {
        const clRef = await addDoc(collection(db, "checklists"), {
          ownerId: currentUser.uid, assignedTo, title, active: true, createdAt: serverTimestamp(),
        });
        await Promise.all(itemsToCreate.map(it => addDoc(collection(db, "items"), {
          checklistId: clRef.id, ownerId: currentUser.uid, assignedTo,
          day: it.day, text: it.text, order: it.order, active: true,
        })));
        await renderOwnerChecklists();
      } catch (e) {
        errEl.textContent = friendlyError(e);
      }
    };
  }

  const listEl = document.getElementById("checklist-list");
  if (!checklists.length) { listEl.innerHTML = `<div class="empty">Henüz checklist yok.</div>`; return; }
  listEl.innerHTML = "";
  for (const cl of checklists) {
    const friend = ownerFriendsCache.find(f => f.uid === cl.assignedTo);
    const items = await fetchItemsForChecklist(cl.id);
    const row = el(`
      <div class="list-item">
        <div class="info">
          <div class="name">${escapeHtml(cl.title)}</div>
          <div class="meta">${friend ? escapeHtml(friend.displayName) : "?"} · ${items.length} görev · <span class="badge ${cl.active === false ? "inactive" : ""}">${cl.active === false ? "Pasif" : "Aktif"}</span></div>
        </div>
        <button class="btn btn-outline btn-sm" data-id="${cl.id}" data-active="${cl.active !== false}">${cl.active === false ? "Aktifleştir" : "Pasifleştir"}</button>
      </div>
    `);
    row.querySelector("button").onclick = async (e) => {
      const id = e.target.getAttribute("data-id");
      const isActive = e.target.getAttribute("data-active") === "true";
      await updateDoc(doc(db, "checklists", id), { active: !isActive });
      await renderOwnerChecklists();
    };
    listEl.appendChild(row);
  }
}

function addItemInputRow(container) {
  const row = el(`
    <div class="item-input-row">
      <input type="text" placeholder="Görev metni">
      <button type="button" class="icon-btn" title="Sil">✕</button>
    </div>
  `);
  row.querySelector("button").onclick = () => row.remove();
  container.appendChild(row);
  row.querySelector("input").focus();
}

// ---- Sahip: Takip sekmesi ----
async function renderOwnerTracking() {
  const body = document.getElementById("owner-body");
  const selectedDate = renderOwnerTracking._date || formatDateLocal(new Date());
  const selectedFriend = renderOwnerTracking._friend || "all";
  renderOwnerTracking._date = selectedDate;
  renderOwnerTracking._friend = selectedFriend;

  body.innerHTML = `
    <div class="card">
      <h2>Günlük Takip</h2>
      <label>Dost</label>
      <select id="tr-friend">
        <option value="all">Tümü</option>
        ${ownerFriendsCache.map(f => `<option value="${f.uid}" ${f.uid === selectedFriend ? "selected" : ""}>${escapeHtml(f.displayName)}</option>`).join("")}
      </select>
      <div class="date-nav mt16">
        <button class="btn btn-outline btn-sm" id="tr-prev">‹ Önceki Gün</button>
        <input type="date" id="tr-date" value="${selectedDate}">
        <button class="btn btn-outline btn-sm" id="tr-next">Sonraki Gün ›</button>
      </div>
      <div id="tr-results" class="mt16"></div>
    </div>
  `;
  document.getElementById("tr-friend").onchange = (e) => { renderOwnerTracking._friend = e.target.value; renderOwnerTracking(); };
  document.getElementById("tr-date").onchange = (e) => { renderOwnerTracking._date = e.target.value; renderOwnerTracking(); };
  document.getElementById("tr-prev").onclick = () => { renderOwnerTracking._date = addDays(selectedDate, -1); renderOwnerTracking(); };
  document.getElementById("tr-next").onclick = () => { renderOwnerTracking._date = addDays(selectedDate, 1); renderOwnerTracking(); };

  const resultsEl = document.getElementById("tr-results");
  resultsEl.innerHTML = `<div class="empty">Yükleniyor…</div>`;

  const dateObj = new Date(selectedDate + "T00:00:00");
  const dayIdx = todayDayIndex(dateObj);

  const friendsToShow = selectedFriend === "all" ? ownerFriendsCache : ownerFriendsCache.filter(f => f.uid === selectedFriend);
  if (!friendsToShow.length) { resultsEl.innerHTML = `<div class="empty">Gösterilecek dost yok.</div>`; return; }

  resultsEl.innerHTML = "";
  for (const friend of friendsToShow) {
    const itemsQ = query(collection(db, "items"),
      where("ownerId", "==", currentUser.uid),
      where("assignedTo", "==", friend.uid),
      where("day", "==", dayIdx),
      where("active", "==", true));
    const itemsSnap = await getDocs(itemsQ);
    const items = [];
    itemsSnap.forEach(d => items.push({ id: d.id, ...d.data() }));
    items.sort((a, b) => (a.order || 0) - (b.order || 0));

    const compQ = query(collection(db, "completions"),
      where("ownerId", "==", currentUser.uid),
      where("assignedTo", "==", friend.uid),
      where("date", "==", selectedDate));
    const compSnap = await getDocs(compQ);
    const doneMap = {};
    compSnap.forEach(d => { const v = d.data(); doneMap[v.itemId] = !!v.done; });

    const doneCount = items.filter(it => doneMap[it.id]).length;
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
      const done = !!doneMap[it.id];
      const trow = el(`
        <div class="task-row">
          <div class="check ${done ? "done" : ""}">${done ? "✓" : ""}</div>
          <div class="task-text ${done ? "done" : ""}">${escapeHtml(it.text)}</div>
        </div>
      `);
      block.appendChild(trow);
    });
    resultsEl.appendChild(block);
  }
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
      </div>
    </div>
  `;
  wireLogout();
  document.getElementById("fr-prev").onclick = () => { renderFriend._date = addDays(selectedDate, -1); renderFriend(); };
  document.getElementById("fr-next").onclick = () => { renderFriend._date = addDays(selectedDate, 1); renderFriend(); };

  const tasksEl = document.getElementById("fr-tasks");
  const itemsQ = query(collection(db, "items"),
    where("assignedTo", "==", currentUser.uid),
    where("day", "==", dayIdx),
    where("active", "==", true));
  const itemsSnap = await getDocs(itemsQ);
  const items = [];
  itemsSnap.forEach(d => items.push({ id: d.id, ...d.data() }));
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
        <div class="task-text ${done ? "done" : ""}">${escapeHtml(it.text)}</div>
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
        renderFriend();
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
  if (!fbUser) { currentUser = null; renderLogin(); return; }
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

/* === SEBIT EMERGENCY LOGIN REPAIR ===
   로그인/인트로 화면에서는 실시간 리렌더를 절대 실행하지 않음.
   입력·클릭 감시 리스너를 제거하여 iPad 입력 지연/튕김을 막음.
*/
function sebitHoldRealtimeRender(ms){ /* no-op: login stability */ }
function sebitShouldDelayRealtimeRender(){ return false; }
function sebitRunRealtimeRefreshSafely(callback){
  try{
    if(typeof callback !== "function") return;
    const page = String(document.body && document.body.getAttribute("data-page") || "");
    if(page === "intro" || page === "teacher-login" || page === "student-login") return;
    callback();
  }catch(err){ console.warn("[SEBIT] realtime refresh skipped", err); }
}

// Firebase 연결은 index.html의 compat script에서 처리함 (iPad Safari 호환)
// 기존 modular 코드 형태를 유지하기 위한 compat 래퍼
function sebitEnsureDbReady(){
  if (typeof db === "undefined" || !db || typeof db.collection !== "function") {
    const err = window.__sebitFirebaseError || new Error("Firestore db is not ready");
    console.error("[SEBIT] Firestore is not connected. Check Firebase script/config in index.html.", err);
    throw err;
  }
  return db;
}
function collection(dbObj, collectionName){
  dbObj = dbObj || sebitEnsureDbReady();
  return dbObj.collection(collectionName);
}
function doc(dbObj, collectionName, docId){
  dbObj = dbObj || sebitEnsureDbReady();
  return dbObj.collection(collectionName).doc(docId);
}
async function getDocs(collectionRef){
  const snap = await collectionRef.get();
  return {
    docs: snap.docs,
    forEach: (callback) => snap.forEach(callback)
  };
}
function writeBatch(dbObj){
  dbObj = dbObj || sebitEnsureDbReady();
  const batch = dbObj.batch();
  return {
    set: (ref, data, options) => batch.set(ref, data, options),
    delete: (ref) => batch.delete(ref),
    commit: () => batch.commit()
  };
}
function onSnapshot(ref, next, error){
  return ref.onSnapshot(next, error);
}

/* === Firestore sync: constitution / law + penalty values (final) ===
   - 기준 데이터: sharedState/constitution.value
   - 교사 메뉴 세빛 헌법 저장값을 서버에 올림
   - 학생 헌법 화면과 교실 레인저 체크리스트는 같은 localStorage 키를 읽으므로 서버 변경 즉시 같은 기준 적용
*/
const SEBIT_CONSTITUTION_DOC = "constitution";
let __sebitConstitutionLoadingFromFirestore = false;
let __sebitConstitutionSyncTimer = null;
let __sebitConstitutionRealtimeStarted = false;
let __sebitUnsubConstitution = null;

function normalizeConstitutionForFirestore(state){
  const fallback = (typeof DEFAULT_CONSTITUTION !== "undefined") ? JSON.parse(JSON.stringify(DEFAULT_CONSTITUTION)) : { version:1, categories:[] };
  const st = (state && typeof state === "object") ? JSON.parse(JSON.stringify(state)) : fallback;
  st.version = Number(st.version || fallback.version || 1);
  if(!Array.isArray(st.categories)) st.categories = [];
  st.categories.forEach(cat=>{
    if(!cat || typeof cat !== "object") return;
    if(!Array.isArray(cat.items)) cat.items = [];
    cat.items.forEach((item, idx)=>{
      if(!item || typeof item !== "object") return;
      const n = Number(item.num || idx + 1);
      item.num = n;
      item.label = item.label || `제${n}조`;
      item.id = String(item.id || `art_${n}`);
      item.title = String(item.title || "");
      item.desc = String(item.desc || "");
      item.lumen = Math.max(0, Number(item.lumen || 0));
      item.xp = Math.max(0, Number(item.xp || 0));
      item.active = item.active === false ? false : true;
    });
  });
  return st;
}
function readLocalConstitutionForFirestore(){
  try{
    const raw = localStorage.getItem("sebit_constitution_v1");
    if(raw) return normalizeConstitutionForFirestore(JSON.parse(raw));
  }catch(_){ }
  return normalizeConstitutionForFirestore(typeof DEFAULT_CONSTITUTION !== "undefined" ? DEFAULT_CONSTITUTION : null);
}
async function syncConstitutionToFirestoreNow(){
  if(__sebitConstitutionLoadingFromFirestore) return;
  try{
    const value = readLocalConstitutionForFirestore();
    await doc(db, "sharedState", SEBIT_CONSTITUTION_DOC).set({ key: SEBIT_CONSTITUTION_DOC, value, updatedAt: Date.now() }, { merge:false });
    console.log("[SEBIT] constitution synced to Firestore");
  }catch(err){ console.error("[SEBIT] constitution Firestore sync failed", err); }
}
function scheduleConstitutionFirestoreSync(){
  if(__sebitConstitutionLoadingFromFirestore) return;
  clearTimeout(__sebitConstitutionSyncTimer);
  __sebitConstitutionSyncTimer = setTimeout(syncConstitutionToFirestoreNow, 350);
}
async function loadConstitutionFromFirestore(){
  try{
    __sebitConstitutionLoadingFromFirestore = true;
    const snap = await doc(db, "sharedState", SEBIT_CONSTITUTION_DOC).get();
    if(snap.exists){
      const data = snap.data() || {};
      const value = normalizeConstitutionForFirestore(data.value || data);
      localStorage.setItem("sebit_constitution_v1", JSON.stringify(value));
      console.log("[SEBIT] constitution loaded from Firestore");
    }else{
      __sebitConstitutionLoadingFromFirestore = false;
      await syncConstitutionToFirestoreNow();
      __sebitConstitutionLoadingFromFirestore = true;
    }
  }catch(err){ console.error("[SEBIT] constitution Firestore load failed", err); }
  finally{ __sebitConstitutionLoadingFromFirestore = false; }
}
function refreshConstitutionViewsFromRealtime(){
  try{
    const modal = document.getElementById("studentReadonlyViewModal");
    if(modal){
      const title = modal.querySelector(".student-view-title")?.textContent || "";
      const body = modal.querySelector(".student-view-body");
      if(body && title.includes("세빛 헌법") && typeof renderStudentConstitutionReadOnlyHTML === "function"){
        body.innerHTML = renderStudentConstitutionReadOnlyHTML();
      }
    }
  }catch(err){ console.warn("[SEBIT] constitution realtime refresh skipped", err); }
}
function startConstitutionFirestoreRealtimeSync(){
  if(__sebitConstitutionRealtimeStarted) return;
  __sebitConstitutionRealtimeStarted = true;
  try{
    __sebitUnsubConstitution = onSnapshot(doc(db, "sharedState", SEBIT_CONSTITUTION_DOC), (snap)=>{
      if(!snap.exists) return;
      const data = snap.data() || {};
      const value = normalizeConstitutionForFirestore(data.value || data);
      __sebitConstitutionLoadingFromFirestore = true;
      localStorage.setItem("sebit_constitution_v1", JSON.stringify(value));
      __sebitConstitutionLoadingFromFirestore = false;
      console.log("[SEBIT] constitution realtime updated");
      refreshConstitutionViewsFromRealtime();
    }, (err)=>{ console.error("[SEBIT] constitution realtime sync failed", err); });
  }catch(err){ __sebitConstitutionRealtimeStarted = false; console.error("[SEBIT] constitution realtime listener failed", err); }
}

/* === Firestore sync: students + lumen/xp (1단계) ===
   - 화면은 기존 localStorage를 그대로 읽음
   - 학생명단/루멘/XP가 바뀌면 Firestore students 컬렉션에 자동 저장
   - 접속 시 Firestore students를 먼저 불러와 localStorage 캐시를 갱신
*/
const FS_COLLECTIONS = { students: "students", penaltyLogs: "penaltyLogs" };
let __sebitStudentsLoadingFromFirestore = false;
let __sebitStudentsSyncTimer = null;

function fsStudentDocId(studentId){
  const raw = String(studentId || "").trim() || ("student_" + Date.now());
  return encodeURIComponent(raw).replace(/\./g, "%2E");
}
function normalizeStudentForFirestore(s){
  const out = { ...(s || {}) };
  out.id = String(out.id || "").trim();
  out.name = String(out.name || "").trim();
  out.no = Number.isFinite(Number(out.no)) ? Number(out.no) : 0;
  out.lumen = Number.isFinite(Number(out.lumen)) ? Number(out.lumen) : 0;
  out.xp = Number.isFinite(Number(out.xp)) ? Number(out.xp) : 0;
  out.active = out.active === false ? false : true;
  out.updatedAt = Date.now();
  return out;
}
async function syncStudentsToFirestoreNow(){
  if(__sebitStudentsLoadingFromFirestore) return;
  try{
    const arr = readJSON(LS.students, []);
    const students = Array.isArray(arr) ? arr.map(normalizeStudentForFirestore).filter(s=>s.id) : [];
    const existingSnap = await getDocs(collection(db, FS_COLLECTIONS.students));
    const existingIds = new Set(existingSnap.docs.map(d=>d.id));
    const nextIds = new Set(students.map(s=>fsStudentDocId(s.id)));
    const batch = writeBatch(db);
    students.forEach(s=>{
      batch.set(doc(db, FS_COLLECTIONS.students, fsStudentDocId(s.id)), s, { merge:false });
    });
    existingIds.forEach(id=>{
      if(!nextIds.has(id)) batch.delete(doc(db, FS_COLLECTIONS.students, id));
    });
    await batch.commit();
    console.log("[SEBIT] students synced to Firestore", students.length);
  }catch(err){
    console.error("[SEBIT] students Firestore sync failed", err);
  }
}
function scheduleStudentsFirestoreSync(){
  if(__sebitStudentsLoadingFromFirestore) return;
  clearTimeout(__sebitStudentsSyncTimer);
  __sebitStudentsSyncTimer = setTimeout(syncStudentsToFirestoreNow, 500);
}

async function syncOneStudentToFirestoreNow(student){
  try{
    const s = normalizeStudentForFirestore(student);
    if(!s.id) return;
    const batch = writeBatch(db);
    batch.set(doc(db, FS_COLLECTIONS.students, fsStudentDocId(s.id)), s, { merge:false });
    await batch.commit();
    console.log("[SEBIT] one student synced to Firestore", s.id, s.lumen, s.xp);
  }catch(err){
    console.error("[SEBIT] one student Firestore sync failed", err);
  }
}

async function loadStudentsFromFirestore(){
  try{
    __sebitStudentsLoadingFromFirestore = true;
    const snap = await getDocs(collection(db, FS_COLLECTIONS.students));
    const fromCloud = [];
    snap.forEach(d=>{
      const data = d.data() || {};
      fromCloud.push(normalizeStudentForFirestore({ ...data, id: data.id || decodeURIComponent(d.id) }));
    });
    fromCloud.sort((a,b)=>(Number(a.no)||0)-(Number(b.no)||0) || String(a.name).localeCompare(String(b.name), "ko"));

    if(fromCloud.length > 0){
      localStorage.setItem(LS.students, JSON.stringify(fromCloud));
      console.log("[SEBIT] students loaded from Firestore", fromCloud.length);
    }else{
      // 처음 연결한 날: 기존 localStorage 학생명단이 있으면 서버에 1회 업로드
      const local = readJSON(LS.students, []);
      if(Array.isArray(local) && local.length > 0){
        __sebitStudentsLoadingFromFirestore = false;
        await syncStudentsToFirestoreNow();
        __sebitStudentsLoadingFromFirestore = true;
      }
    }
  }catch(err){
    console.error("[SEBIT] students Firestore load failed", err);
  }finally{
    __sebitStudentsLoadingFromFirestore = false;
  }
}





/* === Firestore sync: penalty logs (2단계: 벌점 기록) ===
   - 벌점 기록은 penaltyLogs 컬렉션에 저장
   - 학생 루멘/XP 변경은 1단계 students 동기화가 함께 처리
*/
let __sebitPenaltyLoadingFromFirestore = false;
let __sebitPenaltySyncTimer = null;

function fsPenaltyDocId(logId){
  const raw = String(logId || "").trim() || ("penalty_" + Date.now());
  return encodeURIComponent(raw).replace(/\./g, "%2E");
}
function normalizePenaltyForFirestore(log){
  const n = normalizePenaltyLog(log);
  if(!n) return null;
  n.lumen = Math.abs(Number(n.lumen || 0));
  n.xp = Math.abs(Number(n.xp || 0));
  n.ts = Number(n.ts || Date.now());
  n.updatedAt = Date.now();
  return n;
}
async function syncPenaltyLogsToFirestoreNow(){
  if(__sebitPenaltyLoadingFromFirestore) return;
  try{
    const store = readPenaltyStoreRaw() || { version:2, logs:[] };
    const logs = Array.isArray(store.logs) ? store.logs.map(normalizePenaltyForFirestore).filter(Boolean) : [];
    const existingSnap = await getDocs(collection(db, FS_COLLECTIONS.penaltyLogs));
    const existingIds = new Set(existingSnap.docs.map(d=>d.id));
    const nextIds = new Set(logs.map(l=>fsPenaltyDocId(l.id)));
    const batch = writeBatch(db);
    logs.forEach(l=>{
      batch.set(doc(db, FS_COLLECTIONS.penaltyLogs, fsPenaltyDocId(l.id)), l, { merge:false });
    });
    existingIds.forEach(id=>{
      if(!nextIds.has(id)) batch.delete(doc(db, FS_COLLECTIONS.penaltyLogs, id));
    });
    await batch.commit();
    console.log("[SEBIT] penalty logs synced to Firestore", logs.length);
  }catch(err){
    console.error("[SEBIT] penalty logs Firestore sync failed", err);
  }
}
function schedulePenaltyLogsFirestoreSync(){
  if(__sebitPenaltyLoadingFromFirestore) return;
  clearTimeout(__sebitPenaltySyncTimer);
  __sebitPenaltySyncTimer = setTimeout(syncPenaltyLogsToFirestoreNow, 500);
}
async function loadPenaltyLogsFromFirestore(){
  try{
    __sebitPenaltyLoadingFromFirestore = true;
    const snap = await getDocs(collection(db, FS_COLLECTIONS.penaltyLogs));
    const fromCloud = [];
    snap.forEach(d=>{
      const data = d.data() || {};
      const n = normalizePenaltyForFirestore({ ...data, id: data.id || decodeURIComponent(d.id) });
      if(n) fromCloud.push(n);
    });
    fromCloud.sort((a,b)=>Number(b.ts||0)-Number(a.ts||0));
    if(fromCloud.length > 0){
      localStorage.setItem(LS_KEYS.penaltyStore, JSON.stringify({ version:2, logs:fromCloud }));
      console.log("[SEBIT] penalty logs loaded from Firestore", fromCloud.length);
    }else{
      const local = readPenaltyStoreRaw();
      if(local && Array.isArray(local.logs) && local.logs.length > 0){
        __sebitPenaltyLoadingFromFirestore = false;
        await syncPenaltyLogsToFirestoreNow();
        __sebitPenaltyLoadingFromFirestore = true;
      }
    }
  }catch(err){
    console.error("[SEBIT] penalty logs Firestore load failed", err);
  }finally{
    __sebitPenaltyLoadingFromFirestore = false;
  }
}

/* === Firestore realtime sync: students + penaltyLogs (2-3단계) ===
   - 다른 기기에서 학생 루멘/XP 또는 벌점 기록이 바뀌면 현재 기기 localStorage 캐시를 즉시 갱신
   - 기존 화면 구조는 유지하고 필요한 화면만 다시 그림
*/
let __sebitRealtimeStarted = false;
let __sebitUnsubStudents = null;
let __sebitUnsubPenaltyLogs = null;

function refreshCurrentSebitPageFromRealtime(){
  sebitRunRealtimeRefreshSafely(function(){
  try{
    const page = String(document.body.getAttribute("data-page") || "");
    if(page === "teacher-home" && typeof renderTeacherHome === "function") renderTeacherHome();
    if(page === "teacher-students" && typeof renderTeacherStudents === "function") renderTeacherStudents();
    if(page === "teacher-activity" && typeof renderTeacherActivity === "function") renderTeacherActivity();
    if(page.startsWith("student-") && typeof renderStudentShell === "function") renderStudentShell();
    if(page === "student-dashboard" && typeof renderStudentDashboard === "function") renderStudentDashboard();
    if(page === "student-home" && typeof renderStudentHomeV1 === "function") renderStudentHomeV1();
    if(page === "student-shop" && typeof renderStudentShop === "function") {
      if(window.__sebitStudentShopPurchaseBusy || sebitShouldDelayRealtimeRender()) return;
      renderStudentShop();
    }
    if(page === "student-pocket" && typeof renderStudentPocket === "function") renderStudentPocket();
  }catch(err){ console.warn("[SEBIT] realtime refresh skipped", err); }
  });
}

function startFirestoreRealtimeSync(){
  if(__sebitRealtimeStarted) return;
  __sebitRealtimeStarted = true;

  try{
    __sebitUnsubStudents = onSnapshot(collection(db, FS_COLLECTIONS.students), (snap)=>{
      const fromCloud = [];
      snap.forEach(d=>{
        const data = d.data() || {};
        fromCloud.push(normalizeStudentForFirestore({ ...data, id: data.id || decodeURIComponent(d.id) }));
      });
      fromCloud.sort((a,b)=>(Number(a.no)||0)-(Number(b.no)||0) || String(a.name).localeCompare(String(b.name), "ko"));
      if(fromCloud.length > 0){
        __sebitStudentsLoadingFromFirestore = true;
        localStorage.setItem(LS.students, JSON.stringify(fromCloud));
        __sebitStudentsLoadingFromFirestore = false;
        console.log("[SEBIT] students realtime updated", fromCloud.length);
        refreshCurrentSebitPageFromRealtime();
      }
    }, (err)=>{ console.error("[SEBIT] students realtime sync failed", err); });
  }catch(err){ __sebitRealtimeStarted = false; console.error("[SEBIT] students realtime listener failed", err); }

  try{
    __sebitUnsubPenaltyLogs = onSnapshot(collection(db, FS_COLLECTIONS.penaltyLogs), (snap)=>{
      const fromCloud = [];
      snap.forEach(d=>{
        const data = d.data() || {};
        const n = normalizePenaltyForFirestore({ ...data, id: data.id || decodeURIComponent(d.id) });
        if(n) fromCloud.push(n);
      });
      fromCloud.sort((a,b)=>Number(b.ts||0)-Number(a.ts||0));
      __sebitPenaltyLoadingFromFirestore = true;
      localStorage.setItem(LS_KEYS.penaltyStore, JSON.stringify({ version:2, logs:fromCloud }));
      __sebitPenaltyLoadingFromFirestore = false;
      console.log("[SEBIT] penaltyLogs realtime updated", fromCloud.length);
      refreshCurrentSebitPageFromRealtime();
    }, (err)=>{ console.error("[SEBIT] penaltyLogs realtime sync failed", err); });
  }catch(err){ __sebitRealtimeStarted = false; console.error("[SEBIT] penaltyLogs realtime listener failed", err); }
}

/* === Firestore sync: shop + light pocket (3단계) ===
   - 상점 상품, 라이트 포켓, 지급 요청/기록을 Firestore sharedState 문서로 공유
   - 기존 화면은 localStorage를 그대로 읽고, 저장될 때 서버에 자동 반영
*/
const FS_SHARED_STATE_COLLECTION = "sharedState";
const FS_SHOP_KEYS = [
  "shopProducts",
  "shopPurchaseLog",
  "shopDailyCounter",
  "lightPocket",
  "lightMerchantRequests",
  "lightMerchantHistory",
  "lightMerchantClosed"
];
let __sebitShopLoadingFromFirestore = false;
let __sebitShopSyncTimer = null;
let __sebitShopRealtimeStarted = false;
let __sebitUnsubShopState = null;
let __sebitUnsubShopDocs = [];

function fsSharedStateDocId(name){ return String(name || "").trim(); }
function fsShopKeyNameFromLSKey(key){
  try{
    if(typeof LS === "undefined") return "";
    if(key === LS.shopProducts) return "shopProducts";
    if(key === LS.shopPurchaseLog) return "shopPurchaseLog";
    if(key === LS.shopDailyCounter) return "shopDailyCounter";
    if(key === LS.lightPocket) return "lightPocket";
    if(key === LS.lightMerchantRequests) return "lightMerchantRequests";
    if(key === LS.lightMerchantHistory) return "lightMerchantHistory";
    if(key === LS.lightMerchantClosed) return "lightMerchantClosed";
  }catch(_){}
  return "";
}
function fsShopLocalStorageKeyFromName(name){
  try{
    if(typeof LS === "undefined") return "";
    const map = {
      shopProducts: LS.shopProducts,
      shopPurchaseLog: LS.shopPurchaseLog,
      shopDailyCounter: LS.shopDailyCounter,
      lightPocket: LS.lightPocket,
      lightMerchantRequests: LS.lightMerchantRequests,
      lightMerchantHistory: LS.lightMerchantHistory,
      lightMerchantClosed: LS.lightMerchantClosed
    };
    return map[name] || "";
  }catch(_){ return ""; }
}
function fsDefaultValueForShopKey(name){
  if(name === "shopProducts" || name === "shopPurchaseLog" || name === "lightMerchantHistory") return [];
  if(name === "lightMerchantClosed") return false;
  return {};
}
function fsReadShopValue(name){
  const key = fsShopLocalStorageKeyFromName(name);
  if(!key) return fsDefaultValueForShopKey(name);
  return readJSON(key, fsDefaultValueForShopKey(name));
}
async function syncShopStateToFirestoreNow(){
  if(__sebitShopLoadingFromFirestore) return;
  try{
    const batch = writeBatch(db);
    FS_SHOP_KEYS.forEach(name=>{
      batch.set(doc(db, FS_SHARED_STATE_COLLECTION, fsSharedStateDocId(name)), {
        key: name,
        value: fsReadShopValue(name),
        updatedAt: Date.now()
      }, { merge:false });
    });
    await batch.commit();
    console.log("[SEBIT] shop/pocket synced to Firestore");
  }catch(err){ console.error("[SEBIT] shop/pocket Firestore sync failed", err); }
}
function scheduleShopFirestoreSync(){
  if(__sebitShopLoadingFromFirestore) return;
  clearTimeout(__sebitShopSyncTimer);
  __sebitShopSyncTimer = setTimeout(syncShopStateToFirestoreNow, 500);
}
async function loadShopStateFromFirestore(){
  try{
    __sebitShopLoadingFromFirestore = true;
    const snap = await getDocs(collection(db, FS_SHARED_STATE_COLLECTION));
    const found = new Set();
    snap.forEach(d=>{
      const id = String(d.id || "");
      if(!FS_SHOP_KEYS.includes(id)) return;
      const data = d.data() || {};
      const key = fsShopLocalStorageKeyFromName(id);
      if(!key) return;
      localStorage.setItem(key, JSON.stringify(data.value !== undefined ? data.value : fsDefaultValueForShopKey(id)));
      found.add(id);
    });
    let shouldUpload = false;
    FS_SHOP_KEYS.forEach(name=>{
      if(found.has(name)) return;
      const key = fsShopLocalStorageKeyFromName(name);
      if(key && localStorage.getItem(key) !== null) shouldUpload = true;
    });
    if(shouldUpload){
      __sebitShopLoadingFromFirestore = false;
      await syncShopStateToFirestoreNow();
      __sebitShopLoadingFromFirestore = true;
    }
    console.log("[SEBIT] shop/pocket loaded from Firestore", found.size);
  }catch(err){ console.error("[SEBIT] shop/pocket Firestore load failed", err); }
  finally{ __sebitShopLoadingFromFirestore = false; }
}
function refreshShopPagesFromRealtime(){
  sebitRunRealtimeRefreshSafely(function(){
  try{
    const page = String(document.body.getAttribute("data-page") || "");
    if(page === "student-shop" && typeof renderStudentShop === "function") {
      if(window.__sebitStudentShopPurchaseBusy || sebitShouldDelayRealtimeRender()) return;
      renderStudentShop();
    }
    if(page === "student-pocket" && typeof renderStudentPocket === "function") renderStudentPocket();
    if(page === "teacher-home" && typeof renderTeacherHome === "function") renderTeacherHome();
    if(typeof renderLightMerchantRequests === "function") renderLightMerchantRequests();
    if(typeof renderShopAdmin === "function") renderShopAdmin();
  }catch(err){ console.warn("[SEBIT] shop realtime refresh skipped", err); }
  });
}
function startShopFirestoreRealtimeSync(){
  if(__sebitShopRealtimeStarted) return;
  __sebitShopRealtimeStarted = true;

  // 중요: sharedState는 "컬렉션 전체"보다 각 문서(shopProducts 등)를 직접 감시하는 방식이 iPad에서 더 안정적임.
  try{
    __sebitUnsubShopDocs = FS_SHOP_KEYS.map(name => {
      return onSnapshot(doc(db, FS_SHARED_STATE_COLLECTION, fsSharedStateDocId(name)), (docSnap)=>{
        try{
          // compat DocumentSnapshot: exists는 함수
          const exists = (typeof docSnap.exists === "function") ? docSnap.exists() : !!docSnap.exists;
          if(!exists) return;
          const data = docSnap.data() || {};
          const key = fsShopLocalStorageKeyFromName(name);
          if(!key) return;
          __sebitShopLoadingFromFirestore = true;
          localStorage.setItem(key, JSON.stringify(data.value !== undefined ? data.value : fsDefaultValueForShopKey(name)));
          __sebitShopLoadingFromFirestore = false;
          console.log("[SEBIT] shop doc realtime updated", name);
          refreshShopPagesFromRealtime();
        }catch(err){
          __sebitShopLoadingFromFirestore = false;
          console.error("[SEBIT] shop doc realtime apply failed", name, err);
        }
      }, (err)=>{ console.error("[SEBIT] shop doc realtime sync failed", name, err); });
    });
  }catch(err){ __sebitShopRealtimeStarted = false; console.error("[SEBIT] shop doc realtime listener failed", err); }
}


/* === Firestore sync: jobs + job checklists (4단계) ===
   - 직업 배정/설정/세션과 직업 체크리스트 기록을 Firestore jobState 컬렉션으로 공유
   - localStorage를 쓰는 기존 직업 코드를 그대로 살리고, 저장/삭제를 감지해 서버에 반영
*/
const FS_JOB_STATE_COLLECTION = "jobState";
const FS_JOB_FIXED_KEYS = [
  "sebit:jobsConfig_v1",
  "sebit:jobsAssign_v1",
  "sebit:jobsSession_v1",
  "sebit:jobsNonregular_v1",
  "sebit:jobsParttime_v1"
];
const FS_JOB_PREFIXES = [
  "sebit_jobdone_",
  "sebit_studycheck_",
  "sebit_studycheck_closed_",
  "sebit_tidymaster_",
  "sebit_tidymaster_closed_",
  "sebit_artcurator_",
  "sebit_artcurator_closed_",
  "sebit_artcurator_praise_",
  "sebit_greensaver_",
  "sebit_greensaver_closed_",
  "sebit_lunchsaver_",
  "sebit_lunchsaver_closed_",
  "sebit_weathercaster_",
  "sebit_weathercaster_closed_",
  "sebit_lightmerchant_",
  "sebit_lightmerchant_closed_",
  "sebit_techkeeper_",
  "sebit_techkeeper_closed_",
  "sebit_timekeeper_",
  "sebit_timekeeper_closed_",
  "sebit_docmaster_",
  "sebit_docmaster_closed_",
  "sebit_ranger_",
  "sebit_ranger_closed_",
  "sebit_fairjustice_",
  "sebit_fairjustice_closed_"
];
let __sebitJobLoadingFromFirestore = false;
let __sebitJobRealtimeStarted = false;
let __sebitUnsubJobState = null;
let __sebitJobSyncTimer = null;
const __sebitJobChangedKeys = new Set();

function fsJobDocIdFromKey(key){
  return encodeURIComponent(String(key || "")).replace(/\./g, "%2E");
}
function fsJobKeyFromDocId(id){
  try{ return decodeURIComponent(String(id || "")); }catch(_){ return String(id || ""); }
}
function isSebitJobStorageKey(key){
  const k = String(key || "");
  if(FS_JOB_FIXED_KEYS.includes(k)) return true;
  return FS_JOB_PREFIXES.some(p => k.startsWith(p));
}
function getExistingJobStorageKeys(){
  const keys = [];
  try{
    for(let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if(isSebitJobStorageKey(k)) keys.push(k);
    }
  }catch(_){ }
  return keys;
}
async function syncJobKeysToFirestoreNow(keys){
  if(__sebitJobLoadingFromFirestore) return;
  const list = Array.from(new Set((keys || []).filter(isSebitJobStorageKey)));
  if(!list.length) return;
  try{
    const batch = writeBatch(db);
    list.forEach(key=>{
      const raw = localStorage.getItem(key);
      const ref = doc(db, FS_JOB_STATE_COLLECTION, fsJobDocIdFromKey(key));
      if(raw === null){
        batch.delete(ref);
      }else{
        batch.set(ref, { key, raw, updatedAt: Date.now() }, { merge:false });
      }
    });
    await batch.commit();
    console.log("[SEBIT] job state synced to Firestore", list.length);
  }catch(err){ console.error("[SEBIT] job state Firestore sync failed", err); }
}
function scheduleJobFirestoreSync(key){
  if(__sebitJobLoadingFromFirestore) return;
  if(!isSebitJobStorageKey(key)) return;
  __sebitJobChangedKeys.add(String(key));
  clearTimeout(__sebitJobSyncTimer);
  __sebitJobSyncTimer = setTimeout(()=>{
    const keys = Array.from(__sebitJobChangedKeys);
    __sebitJobChangedKeys.clear();
    syncJobKeysToFirestoreNow(keys);
  }, 500);
}
async function syncAllLocalJobStateToFirestoreNow(){
  await syncJobKeysToFirestoreNow(getExistingJobStorageKeys());
}
async function loadJobStateFromFirestore(){
  try{
    __sebitJobLoadingFromFirestore = true;
    const snap = await getDocs(collection(db, FS_JOB_STATE_COLLECTION));
    let count = 0;
    snap.forEach(d=>{
      const data = d.data() || {};
      const key = String(data.key || fsJobKeyFromDocId(d.id));
      if(!isSebitJobStorageKey(key)) return;
      if(data.raw === null || data.deleted === true){
        localStorage.removeItem(key);
      }else{
        localStorage.setItem(key, String(data.raw ?? ""));
      }
      count++;
    });
    console.log("[SEBIT] job state loaded from Firestore", count);
    if(count === 0){
      __sebitJobLoadingFromFirestore = false;
      await syncAllLocalJobStateToFirestoreNow();
      __sebitJobLoadingFromFirestore = true;
    }
  }catch(err){ console.error("[SEBIT] job state Firestore load failed", err); }
  finally{ __sebitJobLoadingFromFirestore = false; }
}
function refreshJobPagesFromRealtime(){
  sebitRunRealtimeRefreshSafely(function(){
  try{
    const page = String(document.body.getAttribute("data-page") || "");
    if(page === "teacher-home" && typeof renderTeacherHome === "function") renderTeacherHome();
    if(page.startsWith("student-") && typeof renderStudentShell === "function") renderStudentShell();
    if(page === "student-home" && typeof renderStudentHomeV1 === "function") renderStudentHomeV1();
    if(page === "teacher-students" && typeof renderTeacherStudents === "function") renderTeacherStudents();
    if(String(location.hash || "") === "#admin-jobs" && typeof openAdminModal === "function") openAdminModal({ key:"jobs", title:"직업 관리" });
    if(String(location.hash || "") === "#admin-job-status" && typeof openAdminModal === "function") openAdminModal({ key:"job-status", title:"직업 수행 현황 관리" });
  }catch(err){ console.warn("[SEBIT] job realtime refresh skipped", err); }
  });
}
function startJobFirestoreRealtimeSync(){
  if(__sebitJobRealtimeStarted) return;
  __sebitJobRealtimeStarted = true;
  try{
    __sebitUnsubJobState = onSnapshot(collection(db, FS_JOB_STATE_COLLECTION), (snap)=>{
      __sebitJobLoadingFromFirestore = true;
      let changed = false;
      snap.forEach(d=>{
        const data = d.data() || {};
        const key = String(data.key || fsJobKeyFromDocId(d.id));
        if(!isSebitJobStorageKey(key)) return;
        if(data.raw === null || data.deleted === true){
          localStorage.removeItem(key);
        }else{
          localStorage.setItem(key, String(data.raw ?? ""));
        }
        changed = true;
      });
      __sebitJobLoadingFromFirestore = false;
      if(changed){
        console.log("[SEBIT] job state realtime updated");
        refreshJobPagesFromRealtime();
      }
    }, (err)=>{ console.error("[SEBIT] job state realtime sync failed", err); });
  }catch(err){ __sebitJobRealtimeStarted = false; console.error("[SEBIT] job realtime listener failed", err); }
}

/* localStorage 직접 저장도 Firestore에 반영되게 감지함 */
(function installSebitLocalStorageSyncHooks(){
  if(window.__sebitLocalStorageSyncHookInstalled) return;
  window.__sebitLocalStorageSyncHookInstalled = true;
  const originalSetItem = Storage.prototype.setItem;
  const originalRemoveItem = Storage.prototype.removeItem;
  Storage.prototype.setItem = function(key, value){
    const ret = originalSetItem.apply(this, arguments);
    try{
      if(this === window.localStorage){
        if(typeof fsShopKeyNameFromLSKey === "function" && fsShopKeyNameFromLSKey(String(key || ""))) scheduleShopFirestoreSync();
        if(typeof fsActivityKeyNameFromLSKey === "function" && fsActivityKeyNameFromLSKey(String(key || ""))) scheduleActivityFirestoreSync();
        if(typeof scheduleJobFirestoreSync === "function" && isSebitJobStorageKey(String(key || ""))) scheduleJobFirestoreSync(String(key || ""));
      }
    }catch(_){ }
    return ret;
  };
  Storage.prototype.removeItem = function(key){
    const ret = originalRemoveItem.apply(this, arguments);
    try{
      if(this === window.localStorage){
        if(typeof fsShopKeyNameFromLSKey === "function" && fsShopKeyNameFromLSKey(String(key || ""))) scheduleShopFirestoreSync();
        if(typeof fsActivityKeyNameFromLSKey === "function" && fsActivityKeyNameFromLSKey(String(key || ""))) scheduleActivityFirestoreSync();
        if(typeof scheduleJobFirestoreSync === "function" && isSebitJobStorageKey(String(key || ""))) scheduleJobFirestoreSync(String(key || ""));
      }
    }catch(_){ }
    return ret;
  };
})();

// --- utils: safe text ---
function escapeHTML(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* === Ranger penalties (v1) === */
function nowKST(){
  // local time assumed KST environment; keep as Date()
  return new Date();
}
function isAfter1700(){
  const d = nowKST();
  return d.getHours() >= 17;
}
function normalizeStudentLumen(){
  // 기존 데이터 보정: 일부 버전에서 lumens로 저장된 값을 lumen으로 안전하게 합침
  const st = readJSON(LS.students, []);
  if(!Array.isArray(st)) return;
  let changed = false;
  st.forEach(s=>{
    if(!s || typeof s !== "object") return;
    if(s.lumens !== undefined){
      s.lumen = Number(s.lumen||0) + Number(s.lumens||0);
      delete s.lumens;
      changed = true;
    }
  });
  if(changed) writeJSON(LS.students, st);
}

function normalizePenaltyLog(log, dayKey){
  if(!log || typeof log !== "object") return null;
  const ts = Number(log.ts || log.createdAt || Date.now());
  return {
    id: String(log.id || ("pen_" + ts + "_" + Math.random().toString(16).slice(2))),
    ts,
    date: String(log.date || dayKey || ""),
    ruleId: String(log.ruleId || log.articleId || ""),
    ruleTitle: String(log.ruleTitle || log.articleTitle || log.articleText || ""),
    articleTitle: String(log.articleTitle || log.ruleTitle || ""),
    articleText: String(log.articleText || log.ruleTitle || log.articleTitle || ""),
    lumen: Math.abs(Number(log.lumen || log.lumenMinus || 0)),
    xp: Math.abs(Number(log.xp || log.xpMinus || 0)),
    studentId: String(log.studentId || log.sid || ""),
    status: String(log.status || "applied"),
    canceledTs: log.canceledTs || null
  };
}

function readPenaltyStoreRaw(){
  try{
    const raw = localStorage.getItem(LS_KEYS.penaltyStore);
    const p = raw ? JSON.parse(raw) : null;
    if(p && p.version===2 && Array.isArray(p.logs)) return p;
  }catch(_){}
  return null;
}
function savePenaltyStore(store){
  const logs = Array.isArray(store?.logs) ? store.logs.map(x=>normalizePenaltyLog(x)).filter(Boolean) : [];
  localStorage.setItem(LS_KEYS.penaltyStore, JSON.stringify({ version:2, logs }));
  try { schedulePenaltyLogsFirestoreSync(); } catch(_) {}
}
function getPenaltyStore(){
  const existing = readPenaltyStoreRaw();
  if(existing) return existing;

  const logs = [];
  // legacy daily: {version:1, days:{YYYY-MM-DD:[...]}}
  try{
    const raw = localStorage.getItem(LS_KEYS.rangerPenaltyDaily);
    const daily = raw ? JSON.parse(raw) : null;
    Object.entries(daily?.days || {}).forEach(([day, arr])=>{
      if(Array.isArray(arr)) arr.forEach(v=>{ const n=normalizePenaltyLog(v, day); if(n) logs.push(n); });
    });
  }catch(_){}
  // legacy archive: either {items:[...]} or {days:{YYYY-MM-DD:[...]}}
  try{
    const raw = localStorage.getItem(LS_KEYS.penaltyArchive);
    const arch = raw ? JSON.parse(raw) : null;
    if(Array.isArray(arch?.items)) arch.items.forEach(v=>{ const n=normalizePenaltyLog(v); if(n) logs.push(n); });
    Object.entries(arch?.days || {}).forEach(([day, arr])=>{
      if(Array.isArray(arr)) arr.forEach(v=>{ const n=normalizePenaltyLog(v, day); if(n) logs.push(n); });
    });
  }catch(_){}

  // de-duplicate by id, keep latest object
  const byId = new Map();
  logs.forEach(l=>{ if(l && l.studentId) byId.set(String(l.id), l); });
  const store = { version:2, logs:[...byId.values()].sort((a,b)=>Number(b.ts||0)-Number(a.ts||0)) };
  savePenaltyStore(store);
  return store;
}
function getAllPenaltyLogs(){
  return getPenaltyStore().logs.slice().sort((a,b)=>Number(b.ts||0)-Number(a.ts||0));
}

// 호환 래퍼: 기존 교실 레인저 코드가 daily/archive 함수를 호출해도 통합 저장소(v2)에 반영됨
function getPenaltyDailyState(){
  const today = (typeof todayKey === "function") ? todayKey() : new Date().toISOString().slice(0,10);
  const days = {};
  getAllPenaltyLogs().forEach(l=>{
    const day = l.date || today;
    if(day !== today) return;
    if(!Array.isArray(days[day])) days[day] = [];
    days[day].push(l);
  });
  if(!Array.isArray(days[today])) days[today] = [];
  return { version:1, days };
}
function savePenaltyDailyState(st){
  const store = getPenaltyStore();
  const days = st?.days || {};
  Object.entries(days).forEach(([day, arr])=>{
    // 해당 날짜 로그만 새 daily 상태로 교체
    store.logs = store.logs.filter(l=>String(l.date||"") !== String(day));
    if(Array.isArray(arr)) arr.forEach(v=>{ const n=normalizePenaltyLog(v, day); if(n) store.logs.push(n); });
  });
  savePenaltyStore(store);
}
function getPenaltyArchiveState(){
  return { version:1, items:getAllPenaltyLogs(), days:{} };
}
function savePenaltyArchiveState(st){
  if(Array.isArray(st?.items)) savePenaltyStore({ version:2, logs:st.items });
}
function applyPenaltyToStudent(studentId, lumenMinus, xpMinus){
  normalizeStudentLumen();
  const st = readJSON(LS.students, []);
  const idx = st.findIndex(s=>String(s.id)===String(studentId));
  if(idx<0) return false;

  const beforeLumen = Number(st[idx].lumen||0);
  const beforeXp = Number(st[idx].xp||0);
  st[idx].lumen = beforeLumen - Math.abs(Number(lumenMinus)||0);
  st[idx].xp = beforeXp - Math.abs(Number(xpMinus)||0);
  st[idx].updatedAt = Date.now();

  // 로컬 화면 즉시 반영 + Firebase students 문서도 즉시 반영
  writeJSON(LS.students, st);
  try { syncOneStudentToFirestoreNow(st[idx]); } catch(_) {}
  return true;
}
function revertPenaltyToStudent(studentId, lumenMinus, xpMinus){
  normalizeStudentLumen();
  const st = readJSON(LS.students, []);
  const idx = st.findIndex(s=>String(s.id)===String(studentId));
  if(idx<0) return false;

  const beforeLumen = Number(st[idx].lumen||0);
  const beforeXp = Number(st[idx].xp||0);
  st[idx].lumen = beforeLumen + Math.abs(Number(lumenMinus)||0);
  st[idx].xp = beforeXp + Math.abs(Number(xpMinus)||0);
  st[idx].updatedAt = Date.now();

  // 벌점 취소/되돌리기도 Firebase students 문서에 즉시 반영
  writeJSON(LS.students, st);
  try { syncOneStudentToFirestoreNow(st[idx]); } catch(_) {}
  return true;
}

/* === DEFAULT: Constitution/Law (editable) === */
const DEFAULT_CONSTITUTION = {"version":1,"categories":[{"id":"cat_1","name":"Ⅰ. 기본 생활 질서","items":[{"id":"art_1","num":1,"label":"제1조","title":"시간 준수의 의무","desc":"정해진 시간에 자리에 앉지 않음","lumen":10,"xp":30,"active":true},{"id":"art_2","num":2,"label":"제2조","title":"수업 방해 금지","desc":"수업 중 불필요한 말, 소리, 행동","lumen":15,"xp":30,"active":true},{"id":"art_3","num":3,"label":"제3조","title":"준비물 관리 의무","desc":"반복적인 준비물 미지참","lumen":10,"xp":30,"active":true},{"id":"art_4","num":4,"label":"제4조","title":"자리 이동 규정","desc":"허락 없이 교실 내 돌아다님","lumen":10,"xp":30,"active":true}]},{"id":"cat_2","name":"Ⅱ. 말과 태도","items":[{"id":"art_5","num":5,"label":"제5조","title":"무시 표현 금지","desc":"“에이~”, “그게 뭐야” 등 상대를 낮추는 말","lumen":20,"xp":30,"active":true},{"id":"art_6","num":6,"label":"제6조","title":"비웃음 행위 금지","desc":"실수·발표·외모 등에 대한 웃음","lumen":25,"xp":30,"active":true},{"id":"art_7","num":7,"label":"제7조","title":"눈치 주기 행위 금지","desc":"한숨, 눈 굴리기, 의미 있는 표정","lumen":20,"xp":30,"active":true},{"id":"art_8","num":8,"label":"제8조","title":"소외 유발 언행 금지","desc":"“너는 빼고”, “쟤랑 안 해” 발언","lumen":30,"xp":30,"active":true}]},{"id":"cat_3","name":"Ⅲ. 관계·집단 행동","items":[{"id":"art_9","num":9,"label":"제9조","title":"뒷말·소문 금지","desc":"당사자 없는 자리에서 부정적 이야기","lumen":30,"xp":30,"active":true},{"id":"art_10","num":10,"label":"제10조","title":"집단 배제 행위 금지","desc":"일부러 끼워주지 않음","lumen":40,"xp":30,"active":true},{"id":"art_11","num":11,"label":"제11조","title":"장난 가장 괴롭힘 금지","desc":"상대가 싫다고 표현했는데 반복","lumen":40,"xp":30,"active":true},{"id":"art_12","num":12,"label":"제12조","title":"물건 장난 금지","desc":"남의 물건 숨김·훼손·던짐","lumen":35,"xp":30,"active":true}]},{"id":"cat_4","name":"Ⅳ. 몸으로 하는 행동","items":[{"id":"art_13","num":13,"label":"제13조","title":"신체 접촉 주의","desc":"밀기, 잡아당기기, 발 걸기","lumen":40,"xp":30,"active":true},{"id":"art_14","num":14,"label":"제14조","title":"위협 행동 금지","desc":"때릴 것처럼 행동, 물건 휘두름","lumen":45,"xp":30,"active":true}]},{"id":"cat_5","name":"Ⅴ. 디지털·기기","items":[{"id":"art_15","num":15,"label":"제15조","title":"기기 사용 규정 위반","desc":"허가 없는 패드 사용","lumen":20,"xp":30,"active":true},{"id":"art_16","num":16,"label":"제16조","title":"온라인 말폭력 금지","desc":"메시지·댓글에서의 무시·비하","lumen":40,"xp":30,"active":true}]},{"id":"cat_6","name":"Ⅵ. 공동체 책임","items":[{"id":"art_17","num":17,"label":"제17조","title":"환경 관리 의무 위반","desc":"쓰레기 방치, 정리 거부","lumen":15,"xp":30,"active":true},{"id":"art_18","num":18,"label":"제18조","title":"급식 예절 위반","desc":"음식 던짐, 장난","lumen":20,"xp":30,"active":true},{"id":"art_19","num":19,"label":"제19조","title":"역할 방해 금지","desc":"직업 수행 친구 방해","lumen":20,"xp":30,"active":true}]},{"id":"cat_7","name":"Ⅶ. 공정성과 책임","items":[{"id":"art_20","num":20,"label":"제20조","title":"거짓 진술 금지","desc":"사실과 다른 말로 책임 회피","lumen":30,"xp":10,"active":true},{"id":"art_21","num":21,"label":"제21조","title":"반복 위반 가중","desc":"동일 조항 3회 이상","lumen":0,"xp":0,"active":true},{"id":"art_22","num":22,"label":"제22조","title":"사과·회복 선택권","desc":"진심 어린 사과 시","lumen":0,"xp":0,"active":true}]},{"id":"cat_8","name":"Ⅷ. 보호 조항","items":[{"id":"art_23","num":23,"label":"제23조","title":"보복 행위 금지","desc":"신고·지적 후 보복","lumen":0,"xp":0,"active":true},{"id":"art_24","num":24,"label":"제24조","title":"관찰 기반 판단 원칙","desc":"추측·소문만으로 처벌 ❌","lumen":0,"xp":0,"active":true}]}]};
const LS_KEYS = {
  constitution: "sebit_constitution_v1",
  rangerPenaltyDaily: "sebit_ranger_penalty_daily_v1",
  penaltyArchive: "sebit_penalty_archive_v1",
  penaltyStore: "sebit_penalty_store_v2",
};

function applyBgByPage(pageName){
  // reset
  document.body.classList.remove("bg-sky","bg-student","bg-teacher-core");

  // sky (기존 유지): intro + teacher-login + teacher-home
  if(pageName === "intro" || pageName === "teacher-login" || pageName === "teacher-home"){
    document.body.classList.add("bg-sky");
    return;
  }

  // LOCKED base bg (교사홈 중앙에서 이어지는 4개 페이지)
  if(pageName === "teacher-thermometer" || pageName === "teacher-activity" || pageName === "teacher-calendar" || pageName === "teacher-students"){
    document.body.classList.add("bg-teacher-core");
      }

  // student-home placeholder hook
  if(pageName === "student-home"){
    document.body.classList.add("bg-student");
    return;
  }

  // others: plain
}


/* === FINAL FIX: explicit intro flow === */
function forceIntro(){
  session.teacherAuthed = false;
  session.studentId = null;
  
  applyBgByPage("intro");
  showPage("intro");
}


/**
 * SEBIT Light World (정적 · localStorage)
 * - 새로고침/재접속: 인트로부터 시작 (인증 상태는 메모리에서만)
 * - 페이지 전환: data-page + .hidden 단일 방식
 * - 버튼 이벤트: [data-go] 이벤트 위임 (리스너 누락 방지)
 * - 학생 명단: Seed → 최초 1회 localStorage에 복사
 */

const LS = {
  teacherPw: "sebit:teacherPassword",
  masterCodeHash: "sebit:masterCodeHash",
  students: "sebit:students",
  thermo: "sebit:thermometer",
  activityDaily: "sebit:activityDaily", // { [YYYY-MM-DD]: { [studentId]: {morning:boolean, reading:[{start,end,ts}]} } }
  activityReadingHistory: "sebit:activityReadingHistory", // { [studentId]: [{date,start,end,pages,ts}] }
  calendar: "sebit:calendarEvents", // 일정 누적
  meals: "sebit:todayLunch",       // 오늘 급식(0시 삭제)
  calendarDrafts: "sebit:calendarDrafts", // 일정 임시저장(날짜별)
  mealDraft: "sebit:mealDraft",          // 급식 입력 임시저장
  quests: "sebit:quests",     // 추후
  dailyStamp: "sebit:dailyStamp", // 0시 초기화 체크
  systemLog: "sebit:systemLog",
  studentsBulkUndo: "sebit:studentsBulkUndo",
  shopProducts: "sebit:shopProducts",
  shopPurchaseLog: "sebit:shopPurchaseLog",
  shopDailyCounter: "sebit:shopDailyCounter",
  lightPocket: "sebit:lightPocket",
  lightMerchantRequests: "sebit:lightMerchantRequests",
  lightMerchantHistory: "sebit:lightMerchantHistory",
  lightMerchantClosed: "sebit:lightMerchantClosed"
};

/* === Thermometer (v59) === */
const THERMO_STAGES = [20,40,60,80,100];
function defaultThermoModel(){
  const rewardsText = Object.fromEntries(THERMO_STAGES.map(v=>[String(v), ""]));
  const claimed = Object.fromEntries(THERMO_STAGES.map(v=>[String(v), false]));
  return { now:0, donations:[], rewardsText, claimed, cycleId:0 };
}
function normalizeThermo(raw){
  const base = defaultThermoModel();
  const t = (raw && typeof raw === "object") ? raw : {};
  const donations = Array.isArray(t.donations) ? t.donations : [];
  // degrees from donations (100 lumen = 1도)
  const total = donations.reduce((a,d)=>a + (Number(d?.amount)||0), 0);
  const deg = Math.min(100, Math.max(0, Math.floor(total/100)));
  const rewardsText = (t.rewardsText && typeof t.rewardsText === "object") ? t.rewardsText : base.rewardsText;
  const claimed = (t.claimed && typeof t.claimed === "object") ? t.claimed : base.claimed;
  const cycleId = Number.isFinite(Number(t.cycleId)) ? Number(t.cycleId) : 0;
  return { now: deg, donations, rewardsText: {...base.rewardsText, ...rewardsText}, claimed: {...base.claimed, ...claimed}, cycleId };
}
function readThermo(){
  return normalizeThermo(readJSON(LS.thermo, defaultThermoModel()));
}
function writeThermo(next){
  const normalized = normalizeThermo(next);
  writeJSON(LS.thermo, normalized);
  try { scheduleThermoFirestoreSync(normalized); } catch(_) {}
}

/* === Firestore sync: morning self-study + reading logs (final) ===
   - 기준 데이터: activityState/activityDaily.value, activityState/activityReadingHistory.value
   - 학생 아침자습/독서 기록과 교사 수정 내용을 모든 기기에서 공유
   - 기존 UI는 LS.activityDaily / LS.activityReadingHistory를 그대로 읽고, 저장될 때 서버에 자동 반영
*/
const FS_ACTIVITY_STATE_COLLECTION = "activityState";
const FS_ACTIVITY_KEYS = ["activityDaily", "activityReadingHistory"];
let __sebitActivityLoadingFromFirestore = false;
let __sebitActivitySyncTimer = null;
let __sebitActivityRealtimeStarted = false;
let __sebitUnsubActivityState = null;

function fsActivityLocalStorageKeyFromName(name){
  try{
    if(typeof LS === "undefined") return "";
    if(name === "activityDaily") return LS.activityDaily;
    if(name === "activityReadingHistory") return LS.activityReadingHistory;
  }catch(_){ }
  return "";
}
function fsActivityKeyNameFromLSKey(key){
  try{
    if(typeof LS === "undefined") return "";
    if(key === LS.activityDaily) return "activityDaily";
    if(key === LS.activityReadingHistory) return "activityReadingHistory";
  }catch(_){ }
  return "";
}
function fsDefaultValueForActivityKey(name){ return {}; }
function fsReadActivityValue(name){
  const key = fsActivityLocalStorageKeyFromName(name);
  if(!key) return fsDefaultValueForActivityKey(name);
  return readJSON(key, fsDefaultValueForActivityKey(name));
}
async function syncActivityStateToFirestoreNow(){
  if(__sebitActivityLoadingFromFirestore) return;
  try{
    const batch = writeBatch(db);
    FS_ACTIVITY_KEYS.forEach(name=>{
      batch.set(doc(db, FS_ACTIVITY_STATE_COLLECTION, name), {
        key:name,
        value:fsReadActivityValue(name),
        updatedAt:Date.now()
      }, { merge:false });
    });
    await batch.commit();
    console.log("[SEBIT] activity state synced to Firestore");
  }catch(err){ console.error("[SEBIT] activity state Firestore sync failed", err); }
}
function scheduleActivityFirestoreSync(){
  if(__sebitActivityLoadingFromFirestore) return;
  clearTimeout(__sebitActivitySyncTimer);
  __sebitActivitySyncTimer = setTimeout(syncActivityStateToFirestoreNow, 500);
}
async function loadActivityStateFromFirestore(){
  try{
    __sebitActivityLoadingFromFirestore = true;
    const snap = await getDocs(collection(db, FS_ACTIVITY_STATE_COLLECTION));
    const found = new Set();
    snap.forEach(d=>{
      const id = String(d.id || "");
      if(!FS_ACTIVITY_KEYS.includes(id)) return;
      const data = d.data() || {};
      const key = fsActivityLocalStorageKeyFromName(id);
      if(!key) return;
      localStorage.setItem(key, JSON.stringify(data.value !== undefined ? data.value : fsDefaultValueForActivityKey(id)));
      found.add(id);
    });
    let shouldUpload = false;
    FS_ACTIVITY_KEYS.forEach(name=>{
      if(found.has(name)) return;
      const key = fsActivityLocalStorageKeyFromName(name);
      if(key && localStorage.getItem(key) !== null) shouldUpload = true;
    });
    if(shouldUpload){
      __sebitActivityLoadingFromFirestore = false;
      await syncActivityStateToFirestoreNow();
      __sebitActivityLoadingFromFirestore = true;
    }
    console.log("[SEBIT] activity state loaded from Firestore", found.size);
  }catch(err){ console.error("[SEBIT] activity state Firestore load failed", err); }
  finally{ __sebitActivityLoadingFromFirestore = false; }
}
function refreshActivityPagesFromRealtime(){
  try{
    const page = String(document.body.getAttribute("data-page") || "");
    if(page === "teacher-home" && typeof renderTeacherHome === "function") renderTeacherHome();
    if(page === "teacher-activity" && typeof renderTeacherActivity === "function") renderTeacherActivity();
    if(page.startsWith("student-") && typeof renderStudentShell === "function") renderStudentShell();
    if(page === "student-home" && typeof renderStudentActivity === "function") renderStudentActivity();
    if(page === "student-home" && typeof renderStudentHomeV1 === "function") renderStudentHomeV1();
    if(typeof renderTodayReadingDetail === "function") renderTodayReadingDetail();
  }catch(err){ console.warn("[SEBIT] activity realtime refresh skipped", err); }
}
function startActivityFirestoreRealtimeSync(){
  if(__sebitActivityRealtimeStarted) return;
  __sebitActivityRealtimeStarted = true;
  try{
    __sebitUnsubActivityState = onSnapshot(collection(db, FS_ACTIVITY_STATE_COLLECTION), (snap)=>{
      __sebitActivityLoadingFromFirestore = true;
      let changed = false;
      snap.forEach(d=>{
        const id = String(d.id || "");
        if(!FS_ACTIVITY_KEYS.includes(id)) return;
        const data = d.data() || {};
        const key = fsActivityLocalStorageKeyFromName(id);
        if(!key) return;
        localStorage.setItem(key, JSON.stringify(data.value !== undefined ? data.value : fsDefaultValueForActivityKey(id)));
        changed = true;
      });
      __sebitActivityLoadingFromFirestore = false;
      if(changed){
        console.log("[SEBIT] activity state realtime updated");
        refreshActivityPagesFromRealtime();
      }
    }, (err)=>{ console.error("[SEBIT] activity state realtime sync failed", err); });
  }catch(err){ __sebitActivityRealtimeStarted = false; console.error("[SEBIT] activity realtime listener failed", err); }
}

/* === Firestore sync: class thermometer / donations (final) ===
   - 기준 데이터: sharedState/thermo.value
   - 학생 기부, 교사 보상 설정/지급/초기화를 서버에 저장
   - 교사/학생 온도계와 학생 홈 기부 한도를 실시간 갱신
*/
const SEBIT_THERMO_DOC = "thermo";
let __sebitThermoLoadingFromFirestore = false;
let __sebitThermoSyncTimer = null;
let __sebitThermoRealtimeStarted = false;
let __sebitUnsubThermo = null;

function normalizeThermoForFirestore(state){ return normalizeThermo(state); }
function readLocalThermoForFirestore(){
  try{ const raw = localStorage.getItem(LS.thermo); if(raw) return normalizeThermoForFirestore(JSON.parse(raw)); }catch(_){}
  return normalizeThermoForFirestore(defaultThermoModel());
}
async function syncThermoToFirestoreNow(value){
  if(__sebitThermoLoadingFromFirestore) return;
  try{
    const next = normalizeThermoForFirestore(value || readLocalThermoForFirestore());
    await doc(db, "sharedState", SEBIT_THERMO_DOC).set({ key: SEBIT_THERMO_DOC, value: next, updatedAt: Date.now() }, { merge:false });
    console.log("[SEBIT] thermo synced to Firestore", next.now);
  }catch(err){ console.error("[SEBIT] thermo Firestore sync failed", err); }
}
function scheduleThermoFirestoreSync(value){
  if(__sebitThermoLoadingFromFirestore) return;
  clearTimeout(__sebitThermoSyncTimer);
  __sebitThermoSyncTimer = setTimeout(()=>syncThermoToFirestoreNow(value), 350);
}
async function loadThermoFromFirestore(){
  try{
    __sebitThermoLoadingFromFirestore = true;
    const snap = await doc(db, "sharedState", SEBIT_THERMO_DOC).get();
    const exists = (typeof snap.exists === "function") ? snap.exists() : !!snap.exists;
    if(exists){
      const data = snap.data() || {};
      const value = normalizeThermoForFirestore(data.value || data);
      localStorage.setItem(LS.thermo, JSON.stringify(value));
      console.log("[SEBIT] thermo loaded from Firestore", value.now);
    }else{
      // 서버에 온도계 문서가 없을 때만 1회 생성.
      // 단, 새 기기에서 만든 빈 기본값(0도/기부 없음)은 서버에 올리지 않음.
      const local = readLocalThermoForFirestore();
      const hasLocalHistory = Array.isArray(local.donations) && local.donations.length > 0;
      const hasLocalProgress = Number(local.now || 0) > 0;
      const hasRewardText = local.rewardsText && Object.values(local.rewardsText).some(v => String(v || '').trim());
      if(hasLocalHistory || hasLocalProgress || hasRewardText){
        __sebitThermoLoadingFromFirestore = false;
        await syncThermoToFirestoreNow(local);
        __sebitThermoLoadingFromFirestore = true;
      }
    }
  }catch(err){ console.error("[SEBIT] thermo Firestore load failed", err); }
  finally{ __sebitThermoLoadingFromFirestore = false; }
}
function refreshThermoViewsFromRealtime(){
  try{
    const page = String(document.body.getAttribute("data-page") || "");
    if(page === "teacher-home" && typeof renderTeacherHome === "function") renderTeacherHome();
    if(page === "teacher-thermometer" && typeof renderThermometer === "function") renderThermometer();
    if(page === "student-thermometer" && typeof renderStudentThermo === "function") renderStudentThermo();
    if(page === "student-home" && typeof renderStudentHomeV1 === "function") renderStudentHomeV1();
    if(typeof renderThermoDrawer === "function") renderThermoDrawer();
  }catch(err){ console.warn("[SEBIT] thermo realtime refresh skipped", err); }
}
function startThermoFirestoreRealtimeSync(){
  if(__sebitThermoRealtimeStarted) return;
  __sebitThermoRealtimeStarted = true;
  try{
    __sebitUnsubThermo = onSnapshot(doc(db, "sharedState", SEBIT_THERMO_DOC), (snap)=>{
      const exists = (typeof snap.exists === "function") ? snap.exists() : !!snap.exists;
      if(!exists) return;
      const data = snap.data() || {};
      const value = normalizeThermoForFirestore(data.value || data);
      __sebitThermoLoadingFromFirestore = true;
      localStorage.setItem(LS.thermo, JSON.stringify(value));
      __sebitThermoLoadingFromFirestore = false;
      console.log("[SEBIT] thermo realtime updated", value.now);
      refreshThermoViewsFromRealtime();
    }, (err)=>{ console.error("[SEBIT] thermo realtime sync failed", err); });
  }catch(err){ __sebitThermoRealtimeStarted = false; console.error("[SEBIT] thermo realtime listener failed", err); }
}



function readQuests(){
  const arr = readJSON(LS.quests, []);
  return Array.isArray(arr) ? arr : [];
}
function writeQuests(next){
  writeJSON(LS.quests, Array.isArray(next)?next:[]);
}

// === Quest View/Detail (Shared) ===
function questViewStatus3(q){
  const s = String(q?.status||"");
  if(s==="paused") return {t:"중단", cls:"off"};
  if(s==="active") return {t:"진행중", cls:"on"};
  // ended / rewarded / others collapse to 완료
  return {t:"완료", cls:"done"};
}
function questPeriodText(q){
  const st = String(q?.start||"").trim();
  const en = String(q?.end||"").trim();
  if(st && en) return `${st} ~ ${en}`;
  if(st) return `${st} 시작`;
  if(en) return `${en} 종료`;
  return "";
}

function openQuestViewModal(){
  const modal = document.getElementById("questViewModal");
  if(!modal) return;
  document.body.classList.add('no-scroll');
  modal.classList.remove("hidden");
  renderQuestView();
}
function closeQuestViewModal(){
  const modal = document.getElementById("questViewModal");
  if(!modal) return;
  modal.classList.add("hidden");
  document.body.classList.remove('no-scroll');
}
function openQuestDetailModal(qid){
  const modal = document.getElementById("questDetailModal");
  if(!modal) return;
  document.body.classList.add('no-scroll');
  modal.classList.remove("hidden");
  modal.dataset.qid = String(qid);
  renderQuestDetail(qid);
}
function closeQuestDetailModal(){
  const modal = document.getElementById("questDetailModal");
  if(!modal) return;
  modal.classList.add("hidden");
  // keep questViewModal open state if it is open
  const view = document.getElementById("questViewModal");
  if(!view || view.classList.contains("hidden")){
    document.body.classList.remove('no-scroll');
  }
}

function renderQuestView(){
  const body = document.getElementById("questViewBody");
  if(!body) return;
  const arr = readQuests();
  // sort: active > paused > others, then newest first
  const rank = (q)=>{
    const s=String(q?.status||"");
    if(s==="active") return 0;
    if(s==="paused") return 1;
    return 2;
  };
  const quests = [...arr].sort((a,b)=>{
    const ra=rank(a), rb=rank(b);
    if(ra!==rb) return ra-rb;
    return Number(b?.createdAt||0)-Number(a?.createdAt||0);
  });
  if(!quests.length){
    body.innerHTML = `<div class="muted">표시할 퀘스트가 없습니다.</div>`;
    return;
  }
  body.innerHTML = `
    <div class="quest-grid">
      ${quests.map(q=>{
        const st = questViewStatus3(q);
        const period = questPeriodText(q);
        const reward = `루멘 ${Number(q?.lumen||0)} / XP ${Number(q?.xp||0)}`;
        return `
          <div class="quest-box">
            <div class="q-status ${st.cls}">${st.t}</div>
           <button class="q-chest" type="button"
data-qopen="${escapeHTML(String(q.id||""))}"
aria-label="퀘스트 열기">
  <img src="assets/ui/chest.png" class="quest-chest-img">
</button>
            <div class="q-main">
              <div class="q-name">${escapeHTML(String(q.title||""))}</div>
              <div class="q-meta">
                <span>${escapeHTML(reward)}</span>
                ${period?`<span>(${escapeHTML(period)})</span>`:""}
              </div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderQuestDetail(qid){
  const body = document.getElementById("questDetailBody");
  const titleEl = document.getElementById("questDetailTitle");
  if(!body) return;

  // make body behave like a "panel" (header + scroll + footer)
  body.classList.add("quest-detail-body");

  const q = readQuests().find(x=>String(x.id)===String(qid));
  if(!q){
    body.innerHTML = `<div class="muted">퀘스트를 찾을 수 없습니다.</div>`;
    if(titleEl) titleEl.textContent = "퀘스트 현황";
    return;
  }
  if(titleEl) titleEl.textContent = "퀘스트 현황";

  const st = questViewStatus3(q);
  const period = questPeriodText(q);

  // student list (layout-first): use roster if present, otherwise empty
  const students = readJSON(LS.students, []);
  const completedRaw = q?.completedIds || q?.completed || q?.completedStudents || [];
  const completedSet = new Set(
    Array.isArray(completedRaw) ? completedRaw.map(String)
      : (completedRaw && typeof completedRaw === "object") ? Object.keys(completedRaw).map(String)
      : []
  );

  const total = Array.isArray(students) ? students.length : 0;
  const done = total ? students.filter(s=>completedSet.has(String(s?.id||""))).length : 0;

  const rewardText = `루멘 ${Number(q.lumen||0)} / XP ${Number(q.xp||0)}`;

  const avatarText = (s)=>{
    const v = String((s?.char || s?.avatar || "")).trim();
    if(v) return v;
    const n = String(s?.name||"").trim();
    return n ? n.slice(0,1) : "?";
  };

  body.innerHTML = `
    <div class="qd-head">
      <div class="qd-top">
        <div class="qd-info">
          <div class="qd-title">${escapeHTML(String(q.title||""))}</div>
          <div class="qd-desc">${escapeHTML(String(q.desc||""))}</div>
          <div class="qd-line">보상: ${escapeHTML(rewardText)}</div>
          <div class="qd-line">기간: ${escapeHTML(period || "상시")}</div>
        </div>
        <div class="q-status ${st.cls} qd-badge">${st.t}</div>
      </div>

      <div class="qd-summary">
        오늘의 미션 완료 학생 <b>${done}</b> / <b>${total}</b>
      </div>
    </div>

    <div class="qd-scroll">
      ${total ? `
        <div class="qd-grid">
          ${students.map(s=>{
            const sid = String(s?.id||"");
            const clear = completedSet.has(sid);
            return `
              <div class="qd-stud ${clear?`is-done`:`is-todo`}" data-sid="${escapeHTML(sid)}" aria-label="학생 카드">
                <div class="qd-avatar">${escapeHTML(avatarText(s))}</div>
                <div class="qd-name">${escapeHTML(String(s?.name||sid||""))}</div>
                ${clear?`<div class="qd-clear">CLEAR</div>`:``}
              </div>
            `;
          }).join("")}
        </div>
      ` : `<div class="muted" style="padding:12px;">학생 목록이 없습니다.</div>`}
    </div>

    <div class="qd-foot">
      <button class="btn soft wide" type="button" data-qclose="1">닫기</button>
    </div>
  `;
}

function uid(prefix="q"){
  return prefix + "_" + Math.random().toString(36).slice(2,8) + "_" + Date.now().toString(36);
}


const DEFAULT_TEACHER_PW = "sebit2026"; // 영어+숫자 (교사 설정에서 변경)
const DEFAULT_PIN = "1234";


/* === SEBIT Teacher Auth: Firestore cloud-first final ===
   - 교사용 비밀번호는 Firestore sharedState/teacherAuth 문서를 기준으로 사용
   - localStorage의 예전 교사 비밀번호가 서버 값을 덮어쓰지 않도록 제거
   - 서버 문서가 아직 없을 때만 기본 비밀번호 sebit2026으로 문서를 생성
   - Firestore 연결 실패 시에만 긴급 fallback 허용
*/
const SEBIT_TEACHER_AUTH_DOC = "teacherAuth";
let __sebitTeacherAuthCache = null;
let __sebitTeacherAuthLoading = null;
let __sebitTeacherAuthSource = "none";

function sebitSimpleHash(s){
  s = String(s ?? "");
  let h1 = 5381;
  for (let i=0;i<s.length;i++) h1 = ((h1<<5) + h1) + s.charCodeAt(i);
  return String(h1 >>> 0);
}
function sebitTeacherAuthRef(){
  return doc(db, "sharedState", SEBIT_TEACHER_AUTH_DOC);
}
function sebitNormalizeTeacherAuth(data){
  const d = (data && typeof data === "object") ? data : {};
  const passwordHash = String(d.passwordHash || (d.password ? sebitSimpleHash(d.password) : "") || "");
  const masterCodeHash = String(d.masterCodeHash || "");
  return { passwordHash, masterCodeHash, updatedAt: Number(d.updatedAt || 0) };
}
async function loadTeacherAuthFromFirestore(){
  if(__sebitTeacherAuthLoading) return __sebitTeacherAuthLoading;

  __sebitTeacherAuthLoading = (async()=>{
    try{
      const ref = sebitTeacherAuthRef();
      const snap = await ref.get();
      const exists = (typeof snap.exists === "function") ? snap.exists() : !!snap.exists;

      if(exists){
        const auth = sebitNormalizeTeacherAuth(snap.data() || {});
        if(auth.passwordHash){
          __sebitTeacherAuthCache = auth;
          __sebitTeacherAuthSource = "cloud";
          if(auth.masterCodeHash) localStorage.setItem(LS.masterCodeHash, auth.masterCodeHash);
          // 예전 기기별 교사 비밀번호 캐시는 더 이상 기준으로 쓰지 않음
          try{ localStorage.removeItem(LS.teacherPw); }catch(_){}
          console.log("[SEBIT] teacher auth loaded from Firestore");
          return auth;
        }
      }

      // 서버 문서가 없을 때만 기본 비밀번호로 클라우드 문서 생성
      const localMaster = String(localStorage.getItem(LS.masterCodeHash) || "");
      const auth = {
        passwordHash: sebitSimpleHash(DEFAULT_TEACHER_PW),
        masterCodeHash: localMaster,
        updatedAt: Date.now()
      };
      await ref.set({ key: SEBIT_TEACHER_AUTH_DOC, ...auth }, { merge:false });
      __sebitTeacherAuthCache = auth;
      __sebitTeacherAuthSource = "cloud-created-default";
      try{ localStorage.removeItem(LS.teacherPw); }catch(_){}
      console.log("[SEBIT] teacher auth cloud doc created with default password");
      return auth;

    }catch(err){
      console.error("[SEBIT] teacher auth load failed", err);
      __sebitTeacherAuthSource = "fallback";
      // 네트워크/Firestore 장애 때만 로그인 자체가 완전히 막히지 않도록 긴급 fallback
      const fallback = {
        passwordHash: sebitSimpleHash(DEFAULT_TEACHER_PW),
        masterCodeHash: String(localStorage.getItem(LS.masterCodeHash) || ""),
        updatedAt: 0
      };
      __sebitTeacherAuthCache = fallback;
      return fallback;
    }finally{
      __sebitTeacherAuthLoading = null;
    }
  })();

  return __sebitTeacherAuthLoading;
}
async function saveTeacherAuthToFirestore({ password, masterCodeHash } = {}){
  const current = await loadTeacherAuthFromFirestore().catch(()=>__sebitTeacherAuthCache || null);
  const next = {
    passwordHash: password ? sebitSimpleHash(password) : String(current?.passwordHash || sebitSimpleHash(DEFAULT_TEACHER_PW)),
    masterCodeHash: (masterCodeHash !== undefined) ? String(masterCodeHash || "") : String(current?.masterCodeHash || localStorage.getItem(LS.masterCodeHash) || ""),
    updatedAt: Date.now()
  };
  await sebitTeacherAuthRef().set({ key: SEBIT_TEACHER_AUTH_DOC, ...next }, { merge:false });
  __sebitTeacherAuthCache = next;
  __sebitTeacherAuthSource = "cloud";
  // 실제 교사 비밀번호는 기기 localStorage에 저장하지 않음
  try{ localStorage.removeItem(LS.teacherPw); }catch(_){}
  if(next.masterCodeHash) localStorage.setItem(LS.masterCodeHash, next.masterCodeHash);
  console.log("[SEBIT] teacher auth saved to Firestore");
  return next;
}
async function checkTeacherPassword(raw){
  const pw = String(raw || "").trim();
  let auth = null;
  try{
    auth = await Promise.race([
      loadTeacherAuthFromFirestore(),
      new Promise(resolve => setTimeout(()=>resolve(null), 4000))
    ]);
  }catch(_){ auth = null; }

  if(auth?.passwordHash){
    return sebitSimpleHash(pw) === String(auth.passwordHash);
  }

  // 서버 응답이 전혀 없을 때만 기본 비밀번호 긴급 허용
  return pw === DEFAULT_TEACHER_PW;
}
async function checkMasterCode(raw){
  const code = String(raw || "").trim();
  const auth = await loadTeacherAuthFromFirestore();
  const h = String(auth?.masterCodeHash || localStorage.getItem(LS.masterCodeHash) || "");
  if(!h) return false;
  return sebitSimpleHash(code) === h;
}

const STUDENT_SEED = [];

let session = {
  teacherAuthed: false,
  studentId: null,
  calendarMode: "schedule",
};

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
  try {
    if (typeof LS !== "undefined" && key === LS.students) {
      scheduleStudentsFirestoreSync();
    }
    if (typeof LS !== "undefined" && key === LS.thermo && typeof scheduleThermoFirestoreSync === "function") {
      scheduleThermoFirestoreSync(val);
    }
    if (typeof FS_SHOP_KEYS !== "undefined" && fsShopKeyNameFromLSKey(key)) {
      scheduleShopFirestoreSync();
    }
  } catch (_) {}
}





/* === SEBIT SHOP PURCHASE FINAL FIX ===
   구매 버튼 → 구매 확인 → 구매 처리 흐름을 한 번에 안정화.
   - 일부 iPad/Safari에서 crypto.randomUUID가 없어 구매 중단되는 문제 방지
   - 30건/시간/수동잠금 제한이 구매를 막지 않게 처리
   - 학생홈 메뉴의 data-go 안내 이벤트가 구매 버튼 클릭을 가로채지 않게 처리
   - 구매 후 학생/상품/포켓/구매기록을 즉시 로컬 갱신 + Firestore 동기화 예약
*/
function sebitSafeId(prefix){
  try{
    if(window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  }catch(_){}
  return String(prefix || "id") + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
}
function sebitNormalizeStudentId(v){
  return String(v == null ? "" : v).trim();
}
function sebitGetCurrentStudent(){
  try{
    const sid = sebitNormalizeStudentId(session && session.studentId);
    if(!sid) return null;
    const arr = readJSON(LS.students, []);
    if(!Array.isArray(arr)) return null;
    return arr.find(s => sebitNormalizeStudentId(s.id) === sid) || null;
  }catch(_){ return null; }
}
async function sebitPushPurchaseNowToCloud(){
  try{ if(typeof syncStudentsToFirestoreNow === "function") await syncStudentsToFirestoreNow(); }catch(e){ console.warn("[SEBIT] purchase students cloud sync skipped", e); }
  try{ if(typeof syncShopStateToFirestoreNow === "function") await syncShopStateToFirestoreNow(); }catch(e){ console.warn("[SEBIT] purchase shop cloud sync skipped", e); }
}
function sebitForceRefreshAfterPurchase(){
  try{ if(typeof renderStudentShop === "function") renderStudentShop(); }catch(_){}
  try{ if(typeof renderStudentPocket === "function") renderStudentPocket(); }catch(_){}
  try{ if(typeof renderTeacherHome === "function") renderTeacherHome(); }catch(_){}
}

// === Light Pocket (학생: 나의 라이트 포켓) ===
function loadLightPocketAll(){
  const raw = readJSON(LS.lightPocket, {});
  return (raw && typeof raw === "object") ? raw : {};
}
function saveLightPocketAll(all){
  writeJSON(LS.lightPocket, all && typeof all === "object" ? all : {});
}
function getMyPocketItems(studentId){
  const all = loadLightPocketAll();
  let arr = all[studentId];
  arr = Array.isArray(arr) ? arr : [];
  // migrate/cleanup: slot-based (max 10), drop placeholders
  const out = [];
  for (const it of arr){
    if(!it) continue;
    const pid = it.productId || it.productID || it.pid;
    const img = it.image || it.img || it.imgSrc || it.imgURL || "";
    const name = (it.name||it.productName||"").trim();
    let status = it.status || (it.requesting===true ? "requested" : "normal");
    const qRaw = (it.quantity!=null ? it.quantity : (it.qty!=null ? it.qty : null));
    const qty = qRaw==null ? null : Number(qRaw);
    // 익일 자동 해제: 신청중이 다음날로 넘어가면 일반 상태로 복귀
    if(status === "requested"){
      const reqYmd = String(it.requestedYmd || "").trim();
      const reqDay = reqYmd || shopDateFromTs(it.requestedAt);
      if(reqDay && reqDay !== shopUiTodayKey()){
        status = "normal";
        it.status = "normal";
        it.requesting = false;
        delete it.requestedAt;
        delete it.requestedYmd;
      }
    }
    // skip empty/placeholder
    if(!pid) continue;
    if(qty!=null && qty<=0) continue;
    const pushOne = ()=> out.push({
      id: it.id || crypto.randomUUID(),
      productId: pid,
      name: name || "상품",
      image: img || "",
      status,
      requestedAt: it.requestedAt || null,
      requestedYmd: it.requestedYmd || ""
    });
    if(qty!=null && qty>1){
      for(let i=0;i<qty;i++) pushOne();
    }else{
      pushOne();
    }
    if(out.length>=10) break;
  }
  // persist if changed shape
  all[studentId] = out;
  saveLightPocketAll(all);
  return out;
}
function setMyPocketItems(studentId, items){
  const all = loadLightPocketAll();
  all[studentId] = Array.isArray(items) ? items : [];
  saveLightPocketAll(all);
}
function pocketTotalCount(items){
  return (items||[]).filter(it=>it && it.productId).length;
}
function sanitizeAllPockets(){
  const all = loadLightPocketAll();
  let changed = false;
  for(const sid of Object.keys(all)){
    const before = all[sid];
    if(!Array.isArray(before)) { all[sid]=[]; changed=true; continue; }
    const clean = [];
    for(const it of before){
      if(!it) continue;
      const pid = it.productId || it.productID || it.pid;
      const qRaw = (it.quantity!=null ? it.quantity : (it.qty!=null ? it.qty : null));
      const qty = qRaw==null ? null : Number(qRaw);
      if(!pid) continue;
      if(qty!=null && qty<=0) continue;
      const base = {
        id: it.id || crypto.randomUUID(),
        productId: pid,
        name: (String(it.name||it.productName||"상품")).trim() || "상품",
        image: it.image || it.img || it.imgSrc || it.imgURL || it.imgLabel || "",
        status: it.status || (it.requesting===true ? "requested" : "normal"),
        requestedAt: it.requestedAt || null,
        requestedYmd: it.requestedYmd || ""
      };
      if(qty!=null && qty>1){
        for(let i=0;i<qty;i++) clean.push({ ...base, id: crypto.randomUUID() });
      }else{
        clean.push(base);
      }
      if(clean.length>=10) break;
    }
    if(JSON.stringify(before) !== JSON.stringify(clean)){ all[sid]=clean; changed=true; }
  }
  if(changed) saveLightPocketAll(all);
}
function shopDateFromTs(ts){
  const n = Number(ts||0);
  if(!n) return "";
  const d = new Date(n);
  if(Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const da = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}
function removePocketRequestItem(studentId, req){
  const items = getMyPocketItems(studentId);
  if(!items.length) return false;
  let idx = -1;
  if(req?.pocketItemId){
    idx = items.findIndex(it => it && it.id === req.pocketItemId);
  }
  if(idx < 0){
    idx = items.findIndex(it => it && it.productId === req?.productId && String(it.name||"") === String(req?.productName||"") && (it.status === "requested" || it.requesting === true));
  }
  if(idx < 0){
    idx = items.findIndex(it => it && String(it.name||"") === String(req?.productName||"") && (it.status === "requested" || it.requesting === true));
  }
  if(idx < 0) return false;
  items.splice(idx, 1);
  setMyPocketItems(studentId, items);
  return true;
}


function renderStudentPocket(){
  const me = getMe();
  if(!me) return showPage("student-login");

  const items = getMyPocketItems(me.id);
  const total = pocketTotalCount(items);
  const remain = Math.max(0, 10 - total);

  const lumenEl = document.getElementById("pocketLumen");
  if(lumenEl) lumenEl.textContent = String(Number(me.lumen)||0);

  const remainEl = document.getElementById("pocketRemain");
  if(remainEl) remainEl.textContent = `${total}/10`;

  const grid = document.getElementById("pocketGrid");
  if(!grid) return;
  grid.innerHTML = "";

  // v39: tabs (카테고리) 활성화 + 선택 상태 저장
  const tabs = document.querySelector(".lightshop-tabs");
  if(tabs){
    tabs.innerHTML = `
      <button class="lightshop-tab" data-cat="전체" type="button">전체</button>
      <button class="lightshop-tab" data-cat="간식" type="button">간식</button>
      <button class="lightshop-tab" data-cat="쿠폰" type="button">쿠폰</button>
      <button class="lightshop-tab" data-cat="학용품" type="button">학용품</button>
      <button class="lightshop-tab" data-cat="특별" type="button">특별</button>
    `;
    tabs.addEventListener("click",(e)=>{
      const b = e.target.closest("button[data-cat]");
      if(!b) return;
      const c = b.dataset.cat || "전체";
      try{ localStorage.setItem(SHOP_UI.catKey, c); }catch(_){}
      renderStudentShop();
    }, { once:true });
  }
  const setTabActive = (cat)=>{
    if(!tabs) return;
    [...tabs.querySelectorAll(".lightshop-tab")].forEach(btn=>{
      btn.classList.toggle("is-active", (btn.dataset.cat||"")===cat);
    });
  };


  const makeCard = (it)=>{
    const requesting = it && (it.status === "requested" || it.requesting === true);
    const name = String(it?.name||"상품");
    const qty = 1;
    const imgLabel = String(it?.image || it?.imgLabel || "");
    const wrap = document.createElement("div");
    wrap.className = "pocket-item" + (requesting ? " requesting" : "");
    wrap.innerHTML = `
      <div class="badge">${requesting ? "(신청중)" : "신청 가능"}</div>
      <div class="img">${imgLabel ? ((String(imgLabel).includes("/")||String(imgLabel).includes(".png")||String(imgLabel).includes(".jpg")||String(imgLabel).includes("data:")) ? `<img src="${imgLabel}">` : escapeHTML(imgLabel)) : ""}</div>
      <div class="name">${escapeHtml(name)}</div>
      <div class="meta"><span class="qty">${qty}개</span></div>
      <div class="btnline">
        <button class="btn ${requesting ? "" : "primary"}" ${requesting ? "disabled" : ""}>${requesting ? "(신청중)" : "지급 요청"}</button>
      </div>
    `;
    const btn = wrap.querySelector("button");
    if(btn && !requesting){
      btn.addEventListener("click", ()=>{
        // 선착순 30건(하루) 초과 시: 신청 불가 안내(라이트 포켓에서)
// 요청 생성(빛의 상인 체크리스트 연동)
        const req = {
          id: "lm_"+Date.now()+"_"+Math.random().toString(16).slice(2),
          ts: Date.now(),
          requestedYmd: shopUiTodayKey(),
          studentId: me.id,
          studentName: String(me.name||""),
          productId: String(it.productId||""),
          pocketItemId: String(it.id||""),
          productName: String(it.name||"상품"),
          qty: 1,
          memo: "",
          status: "pending"
        };
        const list = lmGetTodayList();
        list.push(req);
        lmSetTodayList(list);
        shopIncTodayCount(); // '지급 요청' 기준으로 카운트 증가
        it.status = "requested";
        it.requesting = true;
        it.requestedAt = Date.now();
        it.requestedYmd = shopUiTodayKey();
        setMyPocketItems(me.id, items);
        renderStudentPocket();
      });
    }
    return wrap;
  };

  items.forEach(it=> grid.appendChild(makeCard(it)));

  // 빈 슬롯 표시(가시성용) - 남은 칸만큼
  for(let i=0;i<remain;i++){
    const empty = document.createElement("div");
    empty.className = "pocket-item";
    empty.style.opacity = ".45";
    empty.innerHTML = `
      <div class="badge">비어 있음</div>
      <div class="img"></div>
      <div class="name">빈 칸</div>
      <div class="meta"><span class="qty">0개</span></div>
      <div class="btnline"><button class="btn" disabled>—</button></div>
    `;
    grid.appendChild(empty);
  }
}

function shopTodayKey(){
  return new Date().toISOString().slice(0,10);
}
function shopGetTodayCount(){
  const obj = readJSON(LS.shopDailyCounter, {});
  const key = shopTodayKey();
  const n = Math.max(0, Number(obj?.[key]||0));
  return n;
}
function shopIncTodayCount(){
  const obj = readJSON(LS.shopDailyCounter, {});
  const key = shopTodayKey();
  obj[key] = Math.max(0, Number(obj?.[key]||0)) + 1;
  writeJSON(LS.shopDailyCounter, obj);
}
function shopIsClosed(){ return false; }

// === Light Merchant Requests (v1) ===
function lmTodayKey(){ return shopTodayKey(); }
function lmGetRequests(){
  const raw = readJSON(LS.lightMerchantRequests, {});
  return raw && typeof raw==='object' ? raw : {};
}
function lmSaveRequests(obj){ writeJSON(LS.lightMerchantRequests, obj||{}); }
function lmGetTodayList(){
  const obj = lmGetRequests();
  const key = lmTodayKey();
  const list = Array.isArray(obj[key]) ? obj[key] : [];
  return list;
}
function lmSetTodayList(list){
  const obj = lmGetRequests();
  obj[lmTodayKey()] = Array.isArray(list)? list : [];
  lmSaveRequests(obj);
}
function lmIsClosed(){ return !!readJSON(LS.lightMerchantClosed, false); }
function lmSetClosed(v){ writeJSON(LS.lightMerchantClosed, !!v); }
function lmPushHistory(entry){
  const raw = readJSON(LS.lightMerchantHistory, []);
  const hist = Array.isArray(raw)? raw: [];
  hist.push(entry);
  while(hist.length>50) hist.shift();
  writeJSON(LS.lightMerchantHistory, hist);
}

// === Light Shop shared helpers ===
const SHOP_UI = { catKey: "sebit:shopCat", dealKey:"sebit:shopDailyDealV1" };
function shopImgSrc(imgId){
  return `assets/shop/${(Number(imgId||0)%10)+1}.png`;
}
function shopImgTag(imgId, cls='shop-thumb-img', alt='상품 이미지'){
  const n = (Number(imgId||0)%10)+1;
  return `<img src="${shopImgSrc(imgId)}" class="${cls}" alt="${alt} ${n}" loading="lazy" onerror="this.replaceWith(document.createTextNode('${n}'))">`;
}

function shopUiTodayKey(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const da = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}
function shopHashStr(s){
  let h = 2166136261;
  for(let i=0;i<String(s||"").length;i++){ h ^= String(s||"").charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h>>>0);
}
function getOrMakeDeal(products){
  const today = shopUiTodayKey();
  let deal = null;
  try{ deal = JSON.parse(localStorage.getItem(SHOP_UI.dealKey)||'null'); }catch(_){}
  const eligible = (Array.isArray(products)?products:[]).filter(p=> (Number(p?.stock||0)>0) && p?.isPublished!==false);
  if(!eligible.length) return null;
  if(!deal || deal.date!==today || !eligible.some(p=>p.id===deal.productId)) {
    const idx = shopHashStr(today) % eligible.length;
    deal = { v:1, date: today, productId: eligible[idx].id, rate: 0.25 };
    try{ localStorage.setItem(SHOP_UI.dealKey, JSON.stringify(deal)); }catch(_){}
  }
  return deal;
}
function getEffectivePrice(p, deal){
  const base = Math.max(0, Number(p?.price||0));
  if(deal && deal.productId===p?.id){
    const rate = Math.min(0.8, Math.max(0.05, Number(deal.rate||0.25)));
    return Math.max(0, Math.round(base * (1-rate)));
  }
  return base;
}

function renderStudentShop(){
  const me = getMe();
  if(!me) return showPage("student-login");

  const grid = document.getElementById("studentShopGrid");
  const empty = document.getElementById("studentShopEmpty");
  const lumenEl = document.getElementById("studentShopLumen");
  const pocketRemainEl = document.getElementById("studentShopPocketRemain");

  if(lumenEl) lumenEl.textContent = String(Number(me.lumen)||0);

  const items = getMyPocketItems(me.id);
  const total = pocketTotalCount(items);
  const remain = Math.max(0, 10 - total);
  if(pocketRemainEl) pocketRemainEl.textContent = `${total}/10`;

  const dailyEl = document.getElementById("studentShopDailyCount");
  if(dailyEl){
    const c = shopGetTodayCount();
    dailyEl.textContent = `${Math.min(c,30)}/30`;
  }


  if(!grid) return;
  grid.innerHTML = "";

  const productsRaw = readJSON(LS.shopProducts, []);
  const products = Array.isArray(productsRaw) ? productsRaw : [];

  const tabs = document.querySelector(".lightshop-tabs");
  const setTabActive = (cat)=>{
    if(!tabs) return;
    [...tabs.querySelectorAll(".lightshop-tab")].forEach(btn=>{
      btn.classList.toggle("is-active", (btn.dataset.cat||"")===cat);
    });
  };
  if(tabs){
    tabs.innerHTML = `
      <button class="lightshop-tab" data-cat="전체" type="button">전체</button>
      <button class="lightshop-tab" data-cat="간식" type="button">간식</button>
      <button class="lightshop-tab" data-cat="쿠폰" type="button">쿠폰</button>
      <button class="lightshop-tab" data-cat="학용품" type="button">학용품</button>
      <button class="lightshop-tab" data-cat="특별" type="button">특별</button>
    `;
    if(!tabs.dataset.shopBound){
      tabs.dataset.shopBound = "1";
      tabs.addEventListener("click", (e)=>{
        const b = e.target.closest("button[data-cat]");
        if(!b) return;
        try{ localStorage.setItem(SHOP_UI.catKey, b.dataset.cat || "전체"); }catch(_){}
        renderStudentShop();
      });
    }
  }

const list = products.map(p => ({
    id: p?.id || ("p_" + Math.random().toString(36).slice(2,10)),
    name: (p?.name || "").trim(),
    imgId: Number.isFinite(p?.imgId) ? p.imgId : 0,
    price: Math.max(0, Number(p?.price||0)),
    stock: Math.max(0, Number(p?.stock||0)),
    desc: (p?.desc || "").trim(),
    category: (p?.category || "간식").trim(),
    isPublished: (p?.isPublished === false ? false : true)
  }));

  
  const deal = getOrMakeDeal(list);

  // v39: 오늘의 추천 라인
  const dealLine = document.createElement("div");
  dealLine.className = "shop-dealline";
  if(deal){
    const dp = list.find(x=>x.id===deal.productId);
    dealLine.innerHTML = `오늘의 추천: <b>${escapeHtml(dp?.name||"")}</b> · <span class="shop-dealrate">25% OFF</span>`;
  } else {
    dealLine.innerHTML = `<span class="muted">오늘의 추천 상품이 없습니다.</span>`;
  }
  grid.appendChild(dealLine);

  const selectedCat = (localStorage.getItem(SHOP_UI.catKey)||"전체");
  setTabActive(selectedCat);
  const filtered = (selectedCat==="전체") ? list : list.filter(p=> (p.category||"")===selectedCat);

const cards = filtered.map(p=>{
    const effPrice = getEffectivePrice(p, deal);
    const isSoldOut = (p.stock||0) <= 0;
    const isStopped = p.isPublished === false;
    const state = (isSoldOut ? "품절" : (isStopped ? "판매중단" : "판매중"));
    const disabled = (isSoldOut || isStopped);


    const wrap = document.createElement("div");
    wrap.className = "lightshop-item" + (disabled ? " is-disabled" : "");
    wrap.innerHTML = `
      ${disabled ? `<div class="lightshop-banner">${state}</div>` : ``}
      ${deal && deal.productId===p.id ? `<div class="shop-deal-badge">오늘의 추천</div>` : ``}
      <div class="lightshop-thumb"><img src="assets/shop/${(Number(p.imgId||0)%10)+1}.png" class="shop-thumb-img"></div>
      <div class="lightshop-name">${escapeHtml(p.name||"상품")}</div>
      ${p.desc ? `<div class="lightshop-desc">${escapeHtml(p.desc)}</div>` : ``}
      <div class="lightshop-meta">
        <div class="lightshop-price">${(deal && deal.productId===p.id && effPrice < Number(p.price||0)) ? `<span class="shop-price-old">● ${Number(p.price||0)}</span> <span class="shop-price-new">● ${effPrice}</span>` : `● ${Number(p.price||0)}`}</div>
        <div class="muted small">재고 ${Number(p.stock||0)}</div>
        <div class="muted small lightshop-cat">${escapeHtml(p.category||"")}</div>
      </div>
      <button type="button" class="btn wide lightshop-buy" data-shop-buy="${escapeHtml(p.id)}" ${disabled ? "disabled" : ""}>구매</button>
    `;
    const btn = wrap.querySelector(".lightshop-buy");
    if(btn){
      btn.addEventListener("click", (ev)=>{
        ev.preventDefault(); ev.stopPropagation();
        openPurchaseConfirm(p.id);
      });
    }
    return wrap;
  });

  if(!cards.length){
    if(empty) empty.textContent = "등록된 상품이 없습니다.";
  } else {
    if(empty) empty.textContent = "";
    cards.forEach(c=> grid.appendChild(c));
  }
}


function openPurchaseConfirm(productId){
  const me = sebitGetCurrentStudent();
  if(!me){ toast("다시 로그인해 주세요"); return; }

  const productsRaw = readJSON(LS.shopProducts, []);
  const products = Array.isArray(productsRaw) ? productsRaw : [];
  const p = products.find(x => (x?.id||"") === productId);
  if(!p){ toast("상품을 찾을 수 없어요"); return; }

  const name = String(p?.name||"상품");
  const deal = getOrMakeDeal(products);
  const price = getEffectivePrice(p, deal);
  const stock = Math.max(0, Number(p?.stock||0));
  const isStopped = (p?.isPublished === false);

  const items = getMyPocketItems(me.id);
  const total = pocketTotalCount(items);
if(isStopped){ toast("판매중단 상품입니다"); return; }
  if(stock <= 0){ toast("품절 상품입니다"); return; }
  if(Math.max(0, Number(me.lumen||0)) < price){ toast("루멘이 부족해요"); return; }
  if(total >= 10){ toast("라이트 포켓이 가득 찼어요(10개)"); return; }

  let modal = document.getElementById("purchaseConfirmModal");
  if(!modal){
    modal = document.createElement("div");
    modal.id = "purchaseConfirmModal";
    modal.className = "sebit-modal-backdrop";
    modal.innerHTML = `
      <div class="sebit-modal" role="dialog" aria-modal="true">
        <div class="sebit-modal-header">
          <div class="sebit-modal-title">구매 확인</div>
          <button type="button" class="btn btn-ghost" id="purchaseConfirmClose">닫기</button>
        </div>
        <div class="sebit-modal-body" id="purchaseConfirmBody"></div>
        <div class="sebit-modal-footer" style="display:flex; gap:10px; justify-content:flex-end;">
          <button type="button" class="btn btn-ghost" id="purchaseCancelBtn">취소</button>
          <button type="button" class="btn" id="purchaseOkBtn">확인</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (e)=>{
      if(e.target === modal) closePurchaseConfirm();
    });
    modal.querySelector("#purchaseConfirmClose")?.addEventListener("click", closePurchaseConfirm);
    modal.querySelector("#purchaseCancelBtn")?.addEventListener("click", closePurchaseConfirm);
  }

  const body = modal.querySelector("#purchaseConfirmBody");
  if(body){
    body.innerHTML = `
      <div style="display:flex; gap:14px; align-items:center;">
        <div class="lightshop-thumb" style="width:56px; height:56px; display:flex; align-items:center; justify-content:center; border-radius:14px;">${shopImgTag(p?.imgId)}</div>
        <div>
          <div style="font-weight:800; font-size:18px; margin-bottom:4px;">${escapeHtml(name)}</div>
          <div class="muted">가격 ● ${price} · 재고 ${stock} · 포켓 ${total}/10</div>
        </div>
      </div>
      <div class="muted" style="margin-top:12px;">구매 즉시 확정 · 환불/되돌리기 없음</div>
    `;
  }

  const okBtn = modal.querySelector("#purchaseOkBtn");
  if(okBtn){
    okBtn.onclick = ()=>{
      closePurchaseConfirm();
      shopTryPurchase(productId);
    };
  }

  modal.style.display = "flex";
  document.body.classList.add("no-scroll");
}

function closePurchaseConfirm(){
  const modal = document.getElementById("purchaseConfirmModal");
  if(modal) modal.style.display = "none";
  document.body.classList.remove("no-scroll");
}

function shopTryPurchase(productId){
  if(window.__sebitPurchaseBusy){
    toast("구매 처리 중입니다.");
    return;
  }
  window.__sebitPurchaseBusy = true;

  try{
    const studentId = sebitNormalizeStudentId(session && session.studentId);
    if(!studentId){
      toast("다시 로그인해 주세요");
      return;
    }

    const studentsRaw = readJSON(LS.students, []);
    const students = Array.isArray(studentsRaw) ? studentsRaw : [];
    const sidx = students.findIndex(s => sebitNormalizeStudentId(s.id) === studentId);
    if(sidx < 0){
      toast("학생 정보를 찾을 수 없어요. 다시 로그인해 주세요.");
      return;
    }

    const productsRaw = readJSON(LS.shopProducts, []);
    const products = Array.isArray(productsRaw) ? productsRaw : [];
    const idx = products.findIndex(p => String(p?.id || "") === String(productId || ""));
    if(idx < 0){
      toast("상품을 찾을 수 없어요.");
      return;
    }

    const p = products[idx] || {};
    const deal = (typeof getOrMakeDeal === "function") ? getOrMakeDeal(products) : null;
    const price = Math.max(0, Number((typeof getEffectivePrice === "function") ? getEffectivePrice(p, deal) : p.price || 0));
    const stock = Math.max(0, Number(p.stock || 0));
    const isStopped = (p.isPublished === false);

    if(isStopped){
      toast("판매중단 상품입니다.");
      return;
    }
    if(stock <= 0){
      toast("품절 상품입니다.");
      return;
    }

    const lumen = Math.max(0, Number(students[sidx].lumen || 0));
    if(lumen < price){
      toast("루멘이 부족해요.");
      return;
    }

    const items = getMyPocketItems(studentId);
    const total = pocketTotalCount(items);
    if(total >= 10){
      toast("라이트 포켓이 가득 찼어요(10개).");
      return;
    }

    // 1) 학생 루멘 차감
    students[sidx] = { ...students[sidx], lumen: lumen - price };
    writeJSON(LS.students, students);

    // 2) 상품 재고 차감
    products[idx] = { ...products[idx], stock: stock - 1 };
    writeJSON(LS.shopProducts, products);

    // 3) 라이트 포켓 추가
    const imgId = Number.isFinite(Number(p.imgId)) ? Number(p.imgId) : 0;
    items.push({
      id: sebitSafeId("pocket"),
      productId: String(productId),
      name: String(p.name || "상품"),
      image: String((Number(imgId) % 10) + 1),
      status: "normal",
      purchasedAt: new Date().toISOString()
    });
    setMyPocketItems(studentId, items);

    // 4) 구매 기록 추가
    const logsRaw = readJSON(LS.shopPurchaseLog, []);
    const logs = Array.isArray(logsRaw) ? logsRaw : [];
    logs.push({
      id: sebitSafeId("purchase"),
      ts: new Date().toISOString(),
      studentId,
      studentName: String(students[sidx].name || ""),
      student: String(students[sidx].name || ""),
      productId: String(productId),
      productName: String(p.name || "상품"),
      product: String(p.name || "상품"),
      price
    });
    while(logs.length > 50) logs.shift();
    writeJSON(LS.shopPurchaseLog, logs);

    toast("구매 완료!");
    sebitForceRefreshAfterPurchase();

    // 화면은 즉시 바꾸고, 서버는 바로 밀어넣기
    setTimeout(()=>{ sebitPushPurchaseNowToCloud(); }, 0);

  }catch(err){
    console.error("[SEBIT] shop purchase failed", err);
    toast("구매 처리 중 오류가 났어요. 새로고침 후 다시 시도해 주세요.");
  }finally{
    setTimeout(()=>{ window.__sebitPurchaseBusy = false; }, 350);
  }
}


function pushSystemLog(line) {
  const logs = readJSON(LS.systemLog, []);
  logs.push(line);
  while (logs.length > 50) logs.shift();
  writeJSON(LS.systemLog, logs);
}



  // default: no background image

function ensureSeed() {
  // 교사 비밀번호는 Firestore(sharedState/teacherAuth) 기준으로 사용함.
  try{ localStorage.removeItem(LS.teacherPw); }catch(_){}

  const students = readJSON(LS.students, null);
  if (!students || !Array.isArray(students)) {
    writeJSON(LS.students, STUDENT_SEED);
  }
  normalizeStudentLumen();
  getPenaltyStore(); // legacy daily/archive -> unified v2 migration

  const thermo = readJSON(LS.thermo, null);
  if (!thermo) {
    // 새 기기 최초 접속 시 빈 온도계(0도)를 Firestore에 덮어쓰면 안 되므로
    // seed 단계에서는 writeJSON(=서버 동기화 트리거)을 쓰지 않고 로컬 기본값만 넣음.
    localStorage.setItem(LS.thermo, JSON.stringify(defaultThermoModel()));
  }

  const daily = readJSON(LS.activityDaily, null);
  if (!daily || typeof daily !== "object") {
    writeJSON(LS.activityDaily, {});
  }
  const hist = readJSON(LS.activityReadingHistory, null);
  if (!hist || typeof hist !== "object") {
    writeJSON(LS.activityReadingHistory, {});
  }
}

function showPage(pageName) {
  applyBgByPage(pageName);
  // page-scoped styling hook
  try {
    const lockPages = new Set(["student-shop","student-pocket"]);
    if (lockPages.has(pageName)) document.body.classList.add("no-scroll");
    else if (!String(location.hash||"").startsWith('#admin-')) document.body.classList.remove("no-scroll");
  } catch(_) {}

  try { document.body.setAttribute('data-page', pageName); } catch(_) {}
  $all(".page").forEach(p => p.classList.add("hidden"));
  const el = document.querySelector(`.page[data-page="${pageName}"]`);
  if (!el) return;
  el.classList.remove("hidden");

  if (pageName === "teacher-home") {
    if (!session.teacherAuthed) return showPage("teacher-login");
    renderTeacherHome();
    // restore last opened admin modal (shop etc.) after refresh
    try {
      const hk = String(location.hash||"");
      const pending = hk.startsWith('#admin-') ? hk.replace('#admin-','') : (localStorage.getItem('sebit:lastAdminKey')||"");
      if(pending){
        const t = pending==='shop' ? '상점 관리' : (pending==='quests' ? '퀘스트 관리' : '관리');
        openAdminModal({ key: pending, title: t });
      }
    } catch(_) {}
  }
  if (pageName === "teacher-thermometer") {
    if (!session.teacherAuthed) return showPage("teacher-login");
    renderThermometer();
  }
  if (pageName === "teacher-activity") {
    if (!session.teacherAuthed) return showPage("teacher-login");
    renderTeacherActivity();
  }
  if (pageName === "teacher-calendar") {
    if (!session.teacherAuthed) return showPage("teacher-login");
    renderTeacherCalendar();
    wireCalendarUI();
  }
  if (pageName === "teacher-students") {
    if (!session.teacherAuthed) return showPage("teacher-login");
    renderTeacherStudents();
  }
  if (pageName.startsWith("teacher-") && pageName !== "teacher-login") {
    if (!session.teacherAuthed) return showPage("teacher-login");
  }
  if (pageName.startsWith("student-")) {
    if (!session.studentId) return showPage("student-login");
    renderStudentShell();
    if (pageName === "student-dashboard") renderStudentDashboard();
    if (pageName === "student-home") renderStudentHomeV1();
    if (pageName === "student-thermometer") renderStudentThermo();
    if (pageName === "student-pocket") renderStudentPocket();
    if (pageName === "student-shop") renderStudentShop();
  }

  clearErrors();

  renderInputWindowBanner();
}

function clearErrors() {
  ["teacherLoginError","studentLoginError","pinModalError","pinResetError"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });
}

function normalizeStudentId(raw) {
  return (raw || "").trim().toUpperCase();
}

function validateTeacherPw(pw) {
  if (!pw || pw.length < 4) return false;
  if (!/[A-Za-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  return true;
}

function kstNow() {
  // 확정: 교사 계정 기준 타임존 = KST 고정
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

function todayKey() {
  const d = kstNow();
  // UTC getter를 사용해 KST 고정 날짜를 안정적으로 yyyy-mm-dd로 생성
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function kstHour() {
  return kstNow().getUTCHours();
}

function parseYMD(s) {
  const [y, m, d] = (s || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtYMD(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function runMidnightResetIfNeeded() {
  // 확정:
  // - 로그인 직후 1회 실행
  // - 누락된 모든 날짜 연속 정리
  // - 사용자 알림 없음
  // - 내부 로그 1줄 저장(최대 50개)
  const today = todayKey();
  const stamp = localStorage.getItem(LS.dailyStamp);

  if (!stamp) {
    cleanupMealsForToday(today);

  localStorage.setItem(LS.dailyStamp, today);
    pushSystemLog(`[auto-cleanup] init -> ${today}`);
    return;
  }
  if (stamp === today) return;

  const from = parseYMD(stamp);
  const to = parseYMD(today);

  if (!from || !to || from > to) {
    cleanupMealsForToday(today);
    localStorage.setItem(LS.dailyStamp, today);
    pushSystemLog(`[auto-cleanup] stamp invalid (${stamp}) -> ${today}`);
    return;
  }

  let cur = new Date(from.getTime());
  let days = 0;
  // process [stamp .. day before today]
  while (cur < to) {
    const k = fmtYMD(cur);
    if (k !== today) {
      cleanupActivityForDay(k);
    }
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
    days++;
  }

  cleanupMealsForToday(today);
  localStorage.setItem(LS.dailyStamp, today);
  pushSystemLog(`[auto-cleanup] ${stamp} -> ${today} (${days} day(s))`);
}



function scheduleMidnightResetTick(){
  // keep one timer; ensures 00:00 rollover even if page stays open
  if (session._midnightTimer) return;
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0,0,1,0); // +1s after midnight
  const ms = Math.max(1000, next.getTime() - now.getTime());
  session._midnightTimer = setTimeout(()=>{
    session._midnightTimer = null;
    runMidnightResetIfNeeded();
    scheduleMidnightResetTick();
  }, ms);
}


function cleanupMealsForToday(today){
  // 급식은 '당일만' 유지 (0시 기준 자동 삭제)
  const meal = readJSON(LS.meals, null);
  if (!meal || typeof meal !== "object") return;
  if (meal.date !== today) {
    writeJSON(LS.meals, null);
  }
}

function migratePenaltyDailyToArchive(dayKey){
  // v2 통합 저장소 사용: daily/archive 이동 없이 한 곳에서 관리
  getPenaltyStore();
}

function cleanupActivityForDay(dayKey){
  // dayKey: 이전 날짜(오늘 제외)
  migratePenaltyDailyToArchive(dayKey);
  const daily = readJSON(LS.activityDaily, {});
  const hist = readJSON(LS.activityReadingHistory, {});
  const day = daily[dayKey];
  if (!day || typeof day !== "object") return;

  Object.entries(day).forEach(([sid, rec])=>{
    const reading = Array.isArray(rec?.reading) ? rec.reading : [];
    if (reading.length > 0) {
      if (!Array.isArray(hist[sid])) hist[sid] = [];
      reading.forEach(r=>{
        const start = Number(r?.start);
        const end = Number(r?.end);
        if (!start || !end) return;
        const pages = Math.max(0, (end - start + 1));
        hist[sid].push({ date: dayKey, start, end, pages, ts: r?.ts || Date.now() });
      });
      // keep latest 50
      if (hist[sid].length > 50) hist[sid] = hist[sid].slice(-50);
    }
  });

  delete daily[dayKey];
  writeJSON(LS.activityDaily, daily);
  writeJSON(LS.activityReadingHistory, hist);
}


function getTodayScheduleText(today){
  const all = readJSON(LS.calendar, {});
  const list = Array.isArray(all?.[today]) ? all[today] : [];
  if (list.length === 0) return "등록된 일정이 없습니다.";
  // 제목만 1줄 요약(최신순, 중복 제거, 최대 3개)
  const sorted = [...list].sort((a,b)=>(b?.ts||0)-(a?.ts||0));
  const seen = new Set();
  const titles = [];
  for(const x of sorted){
    const t = String(x?.title||"").trim();
    if(!t) continue;
    if(seen.has(t)) continue;
    seen.add(t);
    titles.push(t);
    if(titles.length>=3) break;
  }
  const more = list.length > 3 ? ` 외 ${list.length-3}개` : "";
  return titles.join(" · ") + more;
}
function getTodayMealText(today){
  const meal = readJSON(LS.meals, null);
  if (!meal || typeof meal !== "object") return "급식 정보 없음";
  if (meal.date !== today) return "급식 정보 없음";
  const items = Array.isArray(meal.items) ? meal.items.filter(Boolean) : [];
  if (items.length === 0) return "급식 정보 없음";
  return items.slice(0,5).join(" / ");
}
function renderTodayScheduleMeal(){
  const today = todayKey();
  const t1 = $("#todaySchedule"); if (t1) t1.textContent = getTodayScheduleText(today);
  const t2 = $("#todayMeal"); if (t2) t2.textContent = getTodayMealText(today);
  const s1 = $("#studentTodaySchedule"); if (s1) s1.textContent = getTodayScheduleText(today);
  const s2 = $("#studentTodayMeal"); if (s2) s2.textContent = getTodayMealText(today);
}
function renderTeacherHome() {
  const today = todayKey();
  const elToday = $("#teacherTodayFixed");
  if (elToday) elToday.textContent = `오늘 날짜: ${today}`;

  const st = readJSON(LS.students, []);
  const activeCount = st.filter(s=>s.active!==false).length;
  const thermo = readJSON(LS.thermo, {goal:0, now:0, donations:[]});
  $("#thermoSummary").textContent = `${thermo.now} / ${thermo.goal}`;

  const thermoState = readThermo();
  const tempNumEl = $("#thermoTemp");
  const tempFillEl = $("#thermoTempFill");
  if (tempNumEl) tempNumEl.textContent = String(thermoState.now || 0);
  if (tempFillEl) tempFillEl.style.width = `${Math.min(100, thermoState.now || 0)}%`;

  const daily = readJSON(LS.activityDaily, {});
  const day = daily[today] || {};
  let morningDone = 0;
  let readingDone = 0;
  st.filter(s=>s.active!==false).forEach(s=>{
    const rec = day[s.id];
    if (rec?.morning) morningDone++;
    if (Array.isArray(rec?.reading) && rec.reading.length > 0) readingDone++;
  });
  $("#morningSummary").textContent = `${morningDone} / ${activeCount}`;
  $("#readingSummary").textContent = `${readingDone} / ${activeCount}`;
  const mPct = activeCount>0 ? Math.round((morningDone/activeCount)*100) : 0;
  const rPct = activeCount>0 ? Math.round((readingDone/activeCount)*100) : 0;
  const mFill = $("#morningFill");
  const rFill = $("#readingFill");
  if (mFill) mFill.style.width = `${Math.min(100, mPct)}%`;
  if (rFill) rFill.style.width = `${Math.min(100, rPct)}%`;

  // 오늘 독서 로그(최근 3건)
  const logEl = $("#todayReadingLog");
  if (logEl) {
    const items = [];
    st.filter(s=>s.active!==false).forEach(s=>{
      const rec = day[s.id];
      if (Array.isArray(rec?.reading)) {
        rec.reading.forEach(r=>{
          if (!r) return;
          items.push({ at: Number(r.at||r.ts||0), name: s.name, title: String(r.title||""), start: r.start, end: r.end });
        });
      }
    });
    items.sort((a,b)=>(b.at-a.at));
    const top = items.slice(0,3).map(it=>{
      const rng = (it.start!=null && it.end!=null) ? `${it.start}~${it.end}` : "";
      const t = it.title ? it.title : "제목 없음";
      return `${it.name}: ${t} (${rng})`;
    });
    logEl.textContent = top.length ? top.join(" · ") : "기록 없음";
  }

  renderTodayScheduleMeal();
  $("#activeQuests").textContent = "진행 중 퀘스트가 없습니다.";
}


function renderInputWindowBanner() {
  const el = $("#studentInputWindowMsg");
  if (!el) return;
  if (kstHour() >= 17) {
    el.classList.add("is-closed");
    el.textContent = "17:00 이후에는 입력할 수 없습니다.";
  } else {
    el.classList.remove("is-closed");
    el.textContent = "입력 가능 시간입니다. (00:00~17:00)";
  }
}
function renderThermometer() {
  const thermo = readThermo();
  $("#thermoNow").textContent = String(thermo.now || 0);
  $("#thermoFill").style.height = Math.min(100, thermo.now || 0) + "%";

  const msg = $("#thermoEventMsg");
  if (msg) {
    msg.textContent = (thermo.now >= 100) ? "우리 반 온도 100도 달성! · 오늘의 기부는 여기까지예요." : "";
  }

  // Stage list — 1단계(20)↓ … 5단계(100)↑
  const stageWrap = $("#thermoStageList");
  if (stageWrap) {
    stageWrap.innerHTML = "";
    const stagesDesc = THERMO_STAGES.slice().reverse(); // 100..20 (5 at top)
    stagesDesc.forEach(v=>{
      const key = String(v);
      const isClaimed = !!thermo.claimed[key];
      const isReached = (thermo.now >= v);
      const isAvailable = isReached && !isClaimed;

      const stageNum = THERMO_STAGES.indexOf(v) + 1;
      const rewardText = (thermo.rewardsText[key] || "").trim() || "보상 미설정";
      const el = document.createElement("div");
      el.className = "stage-item" + (isClaimed ? " claimed" : (isAvailable ? " available" : (isReached ? " reached" : " locked")));
      const state = isClaimed ? "완료" : (isAvailable ? "지급 가능" : (isReached ? "도달" : "대기"));
      el.innerHTML = `<span class="badge">${stageNum}단계 · ${v}도</span><span class="reward">${escapeHtml(rewardText)}</span><span class="muted small">${state}</span>`;
      stageWrap.appendChild(el);
    });
  }

  // Donations (window + log)
  const st = readJSON(LS.students, []);
  const nameById = Object.fromEntries(st.map(s=>[s.id, s.name]));
  const donationsNewest = thermo.donations.slice().reverse();

  const win = $("#donationWindow");
  if (win) {
    win.innerHTML = "";
    if (!donationsNewest.length) {
      win.innerHTML = `<div class="muted small">아직 기부 내역이 없습니다.</div>`;
    } else {
      donationsNewest.forEach(d=>{
        const who = nameById[d.studentId] || d.studentId || "알 수 없음";
        const memo = (d.memo || "").trim();
        const row = document.createElement("div");
        row.className = "donation-row";
        row.innerHTML = `<div class="who">${escapeHtml(who)}</div><div class="amt mono">+${Number(d.amount)||0}</div><div class="msg">${escapeHtml(memo||"")}</div>`;
        win.appendChild(row);
      });
    }
  }

  const log = $("#donationLog");
  if (log) {
    log.innerHTML = "";
    const capped = donationsNewest.slice(0, 50);
    if (!capped.length) {
      log.innerHTML = `<div class="muted small">아직 기부 내역이 없습니다.</div>`;
    } else {
      capped.forEach(d=>{
        const who = nameById[d.studentId] || d.studentId || "알 수 없음";
        const memo = d.memo ? ` · <span class="muted">${escapeHtml(d.memo)}</span>` : "";
        const time = d.ts ? new Date(d.ts).toLocaleString() : "";
        const el = document.createElement("div");
        el.className = "donation-item";
        el.innerHTML = `<b>${escapeHtml(who)}</b> <span class="mono">+${Number(d.amount)||0}</span>${memo}<div class="muted small">${escapeHtml(time)}</div>`;
        log.appendChild(el);
      });
    }
  }

  renderThermoDrawer();
}


function renderStudentShell() {
  const matured = processStudentBankMaturity(session.studentId);
  if (matured) {
    toast(`만기 환급 완료! ${matured.payout}루멘이 지급되었습니다.`);
  }
  wireStudentBankButtons();
  const st = readJSON(LS.students, []);
  const me = st.find(s=>s.id === session.studentId);
  if ($("#studentHomeTitle") && me) {
    $("#studentHomeTitle").textContent = `${me.name} (${me.id})`;
  }
  if ($("#studentTodaySchedule")) $("#studentTodaySchedule").textContent = "등록된 일정이 없습니다.";
  if ($("#studentTodayMeal")) $("#studentTodayMeal").textContent = "급식 정보 없음";
}

function computeLevelFromXp(xp){
  const x = Math.max(0, Number(xp)||0);
  const lv = Math.min(5, Math.max(1, Math.floor(x/300)+1));
  return { lv, xpShown: Math.min(1200, x), xpRaw: x };
}

function getMe(){
  const st = readJSON(LS.students, []);
  return st.find(s=>s.id === session.studentId) || null;
}


function readAllStudents(){
  const arr = readJSON(LS.students, []);
  return Array.isArray(arr) ? arr : [];
}
function writeAllStudents(arr){
  writeJSON(LS.students, Array.isArray(arr) ? arr : []);
}
function getBankEndDateText(ymd){
  if (!ymd) return 'D-';
  const end = parseYMD(String(ymd));
  const today = parseYMD(todayKey());
  if (!end || !today) return 'D-';
  const diff = Math.round((end.getTime() - today.getTime()) / 86400000);
  if (diff <= 0) return '오늘 만기';
  return `D-${diff}`;
}
function clearStudentBankFields(stu){
  if (!stu || typeof stu !== 'object') return stu;
  delete stu.bank;
  delete stu.bankEnd;
  delete stu.bankDday;
  return stu;
}
function processStudentBankMaturity(studentId){
  if (!studentId) return null;
  const students = readAllStudents();
  const idx = students.findIndex(s => s && s.id === studentId);
  if (idx < 0) return null;

  const stu = students[idx];
  const amount = Number(stu.bank || 0);
  const endYmd = String(stu.bankEnd || '').trim();
  if (amount <= 0 || !endYmd) {
    if (amount <= 0 && (stu.bankEnd || stu.bankDday)) {
      clearStudentBankFields(stu);
      students[idx] = stu;
      writeAllStudents(students);
    }
    return null;
  }

  const end = parseYMD(endYmd);
  const today = parseYMD(todayKey());
  if (!end || !today) return null;
  if (today.getTime() < end.getTime()) return null;

  const payout = Math.round(amount * 1.03);
  stu.lumen = Number(stu.lumen || 0) + payout;
  clearStudentBankFields(stu);
  students[idx] = stu;
  writeAllStudents(students);
  return { amount, payout };
}
function startStudentBankDeposit(){
  if (!session.studentId) return;
  const matured = processStudentBankMaturity(session.studentId);
  if (matured) {
    toast(`만기 환급 완료! ${matured.payout}루멘이 지급되었습니다.`);
  }

  const students = readAllStudents();
  const idx = students.findIndex(s => s && s.id === session.studentId);
  if (idx < 0) { toast('학생 정보를 찾을 수 없습니다.'); return; }
  const stu = students[idx];

  if (Number(stu.bank || 0) > 0) {
    toast('이미 진행 중인 예금이 있어요. 해지하거나 만기 후 다시 저금할 수 있어요.');
    return;
  }

  const raw = prompt('저금할 루멘을 입력하세요. (100루멘 단위 / 10일 만기 / 3% 이자)');
  if (raw === null) return;
  const amount = Number(String(raw).replace(/[^\d]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0 || amount % 100 !== 0) {
    toast('100루멘 단위로만 저금할 수 있어요.');
    return;
  }

  const myLumen = Number(stu.lumen || 0);
  if (myLumen < amount) {
    toast('루멘이 부족합니다.');
    return;
  }

  if (!confirm(`${amount}루멘을 10일 예금할까요?\n만기 시 ${Math.round(amount * 1.03)}루멘이 자동 지급됩니다.`)) return;

  const today = parseYMD(todayKey());
  const end = new Date(today.getTime() + 10 * 86400000);

  stu.lumen = myLumen - amount;
  stu.bank = amount;
  stu.bankEnd = fmtYMD(end);
  stu.bankDday = getBankEndDateText(stu.bankEnd);

  students[idx] = stu;
  writeAllStudents(students);
  toast(`${amount}루멘 저금 완료!`);
  renderStudentHomeV1();
}
function cancelStudentBankDeposit(){
  if (!session.studentId) return;
  const students = readAllStudents();
  const idx = students.findIndex(s => s && s.id === session.studentId);
  if (idx < 0) { toast('학생 정보를 찾을 수 없습니다.'); return; }

  const stu = students[idx];
  const amount = Number(stu.bank || 0);
  if (amount <= 0) {
    toast('현재 진행 중인 예금이 없습니다.');
    return;
  }

  if (!confirm(`예금을 해지할까요?\n원금 ${amount}루멘만 반환되고 이자는 지급되지 않습니다.`)) return;

  stu.lumen = Number(stu.lumen || 0) + amount;
  clearStudentBankFields(stu);
  students[idx] = stu;
  writeAllStudents(students);
  toast(`해지 완료! ${amount}루멘이 반환되었습니다.`);
  renderStudentHomeV1();
}
function wireStudentBankButtons(){
  const goOld = document.getElementById('studentGoBankBtn');
  if (goOld && !goOld.dataset.bankBound) {
    const goNew = goOld.cloneNode(true);
    goNew.dataset.bankBound = '1';
    goOld.replaceWith(goNew);
    goNew.addEventListener('click', startStudentBankDeposit);
  }
  const cancelOld = document.getElementById('studentBankCancelBtn');
  if (cancelOld && !cancelOld.dataset.bankBound) {
    const cancelNew = cancelOld.cloneNode(true);
    cancelNew.dataset.bankBound = '1';
    cancelOld.replaceWith(cancelNew);
    cancelNew.addEventListener('click', cancelStudentBankDeposit);
  }
}

function getAvatarSrc(charKey){
  const sid = session?.studentId || "";
  const saved = localStorage.getItem("studentAvatar_" + sid);
  if (saved) return saved;

  if (charKey) return `assets/characters/${charKey}.png`;

  return "assets/characters/CHR-1.png";
}

function renderStudentDashboard(){
  const me = getMe();
  if (!me) return;
  const title = $("#studentDashTitle");
  if (title) title.textContent = `${me.name} (${me.id})`;
  const name = $("#dashName");
  if (name) name.textContent = me.name;

  const lumen = Number(me.lumen)||0;
  const xp = Number(me.xp)||0;
  if ($("#dashLumen")) $("#dashLumen").textContent = String(lumen);
  if ($("#dashXp")) $("#dashXp").textContent = String(xp);

  const img = $("#dashAvatarImg");
  if (img) img.src = getAvatarSrc(me.charKey);
}



/* === Student personal job checklist link (phase 1) === */
function studentJobChecklistItems(jobName){
  const n = String(jobName||'');
  if(n.includes('빛의 상인') || n.includes('상인')) return ['상품 신청 확인하기', '지급 처리 확인하기', '정리 후 마감하기'];
  if(n.includes('학습 체크단') || n.includes('준비물')) return ['준비물 상태 확인하기', '필요한 친구 기록하기', '마감하기'];
  if(n.includes('정리 마스터') || n.includes('정리')) return ['교실 바닥 확인하기', '책상 주변 확인하기', '정리 상태 마감하기'];
  if(n.includes('작품 큐레이터') || n.includes('작품')) return ['작품 상태 확인하기', '전시 자리 정리하기', '마감하기'];
  if(n.includes('런치 세이버') || n.includes('급식')) return ['급식 준비 확인하기', '식사 후 자리 확인하기', '마감하기'];
  if(n.includes('타임 키퍼') || n.includes('시간')) return ['시간 안내하기', '활동 전환 확인하기', '마감하기'];
  if(n.includes('교실 레인저') || n.includes('레인저')) return ['교실 안전 확인하기', '도움 필요한 곳 확인하기', '마감하기'];
  if(n.includes('페어 저스티스') || n.includes('공정')) return ['규칙 지키기 확인하기', '갈등 상황 살피기', '마감하기'];
  if(n.includes('테크 키퍼') || n.includes('패드')) return ['기기 상태 확인하기', '충전/정리 확인하기', '마감하기'];
  if(n.includes('그린 세이버') || n.includes('분리배출')) return ['쓰레기/분리배출 확인하기', '주변 정리 확인하기', '마감하기'];
  if(n.includes('웨더 캐스터') || n.includes('날씨')) return ['날씨 확인하기', '알림 내용 정리하기', '마감하기'];
  if(n.includes('문서 마스터') || n.includes('문서')) return ['문서/안내물 확인하기', '전달 상태 확인하기', '마감하기'];
  if(n.includes('빛의 파수꾼') || n.includes('파수꾼')) return ['담당 구역 확인하기', '필요한 도움 확인하기', '마감하기'];
  return ['오늘 할 일 확인하기', '수행 내용 확인하기', '마감하기'];
}

function openStudentJobChecklist(jobName){
  const rawName = String(jobName||'').trim();
  if(!rawName){ if(typeof toast==='function') toast('배정된 직업이 없습니다.'); return; }

  // 학생 화면에서는 새 체크리스트를 만들지 않고,
  // 교사용 직업 관리 안의 기존 "직업 체크리스트 관리 → 해당 직업 열기" 버튼 흐름을 그대로 재사용한다.
  if(window.__sebitOpenExistingJobChecklist && typeof window.__sebitOpenExistingJobChecklist === 'function'){
    window.__sebitOpenExistingJobChecklist(rawName);
    return;
  }

  if(typeof toast==='function') toast('기존 직업 체크리스트 연결을 준비 중입니다.');
}

function bindStudentJobLine(el, jobName){
  if(!el) return;
  const name = String(jobName||'').trim();
  el.textContent = name;
  el.onclick = null;
  el.removeAttribute('role');
  el.removeAttribute('tabindex');
  if(!name){
    el.style.cursor = '';
    el.title = '';
    return;
  }
  el.style.cursor = 'pointer';
  el.title = '눌러서 직업 체크리스트 열기';
  el.setAttribute('role','button');
  el.setAttribute('tabindex','0');
  el.onclick = ()=> openStudentJobChecklist(name);
  el.onkeydown = (e)=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); openStudentJobChecklist(name); } };
}


/* === Model Citizen / Job Reward helpers (v60) === */
function sebitCurrentJobSession(){
  try{
    const raw = localStorage.getItem('sebit:jobsSession_v1');
    const s = raw ? JSON.parse(raw) : null;
    return (s && typeof s==='object') ? s : {startedAt:null, endedAt:null};
  }catch(_){ return {startedAt:null, endedAt:null}; }
}
function sebitPenaltyTs(log){
  const n = Number(log?.ts || log?.createdAt || 0);
  if(n) return n;
  const d = new Date(String(log?.date || ''));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}
function sebitHasPenaltyInJobSession(studentId){
  const sess = sebitCurrentJobSession();
  const start = Number(sess.startedAt || 0);
  if(!start) return false;
  const end = Number(sess.endedAt || Date.now());
  let logs = [];
  try{ logs = (typeof getAllPenaltyLogs==='function') ? getAllPenaltyLogs() : []; }catch(_){ logs = []; }
  return logs.some(l=>{
    if(String(l?.studentId||'') !== String(studentId||'')) return false;
    if(String(l?.status||'applied') === 'canceled') return false;
    const ts = sebitPenaltyTs(l);
    return ts >= start && ts <= end;
  });
}
function sebitModelCitizenStateText(studentId){
  const sess = sebitCurrentJobSession();
  if(!sess.startedAt) return '모범 시민 대기 중';
  return sebitHasPenaltyInJobSession(studentId) ? '모범 시민 탈락' : '모범 시민 진행 중';
}

function renderStudentHomeV1(){
  if (!session.studentId) return;
  const stu = getMe();
  if (!stu) return;

  // Header
  const title = $("#studentHomeTitle");
  if (title) title.textContent = `${stu.name} (${stu.id})`;
  const nameLine = $("#studentNameLine");
  if (nameLine) nameLine.textContent = stu.name;
  const ribbon = $("#studentRibbonTitle");
  if (ribbon) ribbon.textContent = `${stu.name}의 빛나는 하루`;

  // avatar
  const img = $("#studentAvatarImg");
  if (img) img.src = getAvatarSrc(stu.charKey);

  // assets
  const lumenEl = $("#studentLumenNow");
  const xpEl = $("#studentXpNow");
  const levelEl = $("#studentLevelNow");
  const xpText = $("#studentXpText");
  const fill = $("#studentXpBarFill");

  const lumen = Number(stu.lumen || 0);
  const xp = Number(stu.xp || 0);
  const capped = Math.min(1200, Math.max(0, xp));
  const lv = Math.min(5, Math.floor(capped / 300) + 1);

  if (lumenEl) lumenEl.textContent = String(lumen);
  if (xpEl) xpEl.textContent = String(xp);
  if (levelEl) levelEl.textContent = `Lv.${lv}${lv===5 ? ' (MAX)' : ''}`;
  if (xpText) xpText.textContent = `${capped} / 1200 XP`;
  if (fill) fill.style.width = `${(capped/1200)*100}%`;

  // input window banner
  const msg = $("#studentInputWindowMsg");
  const locked = (kstHour() >= 17);
  if (msg) {
    if (locked) {
      msg.style.display = 'block';
      msg.textContent = '17:00 이후에는 입력할 수 없습니다.';
    } else {
      msg.style.display = 'none';
      msg.textContent = '';
    }
  }

  // jobs (clickable checklist link, max 2 lines)
  const j1 = $("#studentJobLine1");
  const j2 = $("#studentJobLine2");
  const jobs = Array.isArray(stu.jobs) ? stu.jobs : [];
  bindStudentJobLine(j1, jobs[0] ? String(jobs[0]) : '');
  bindStudentJobLine(j2, jobs[1] ? String(jobs[1]) : '');

  // penalties (read-only)
  const plist = $("#studentPenaltyList");
  const pempty = $("#studentPenaltyEmpty");
  const penalties = Array.isArray(stu.penalties) ? stu.penalties.slice(0,10) : [];
  if (plist) plist.innerHTML = '';
  if (penalties.length === 0) {
    if (pempty) {
      pempty.style.display = 'block';
      try{ pempty.textContent = sebitModelCitizenStateText(stu.id); }catch(_){ pempty.textContent = '모범 시민 진행 중'; }
    }
  } else {
    if (pempty) pempty.style.display = 'none';
    for (const p of penalties) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(p.date || '')} ${escapeHtml(p.reason || '')}</span><span>${escapeHtml(p.points || '')}</span>`;
      plist?.appendChild(li);
    }
  }

  // personal penalty log button (always visible; independent from model citizen status)
  try { ensureStudentPenaltyLogButton(); } catch(_) {}

  // bank info
  const bankBal = $("#studentBankBalance");
  const bankD = $("#studentBankDday");
  const bankAmount = Number(stu.bank || 0);
  const bankDday = bankAmount > 0 ? getBankEndDateText(stu.bankEnd || stu.bankDday || '') : 'D-';
  if (bankBal) bankBal.textContent = String(bankAmount);
  if (bankD) bankD.textContent = bankDday;

  renderStudentDonationStatus();
  renderStudentActivity();
}


function setMorning(flag){
  const msg = $("#morningStateMsg");
  if (kstHour() >= 17) { toast("17:00 이후에는 입력할 수 없습니다."); return; }
  const today = todayKey();
  const d = ensureTodayActivityRecord(session.studentId);
  d[today][session.studentId].morning = !!flag;
  setDailyActivity(d);
  if (msg) msg.textContent = flag ? "체크됨" : "";
  renderStudentHomeV1();
  renderTeacherHome();
}

function debounce(fn, wait){
  let t = null;
  return (...args)=>{
    clearTimeout(t);
    t = setTimeout(()=>fn(...args), wait);
  };
}

function validateReadingDraft(){
  const err = $("#studentActivityError");
  if (!err) return true;
  err.textContent = "";

  const title = ($("#studentReadTitle")?.value || "").trim();
  const start = ($("#studentReadStart")?.value || "").trim();
  const end = ($("#studentReadEnd")?.value || "").trim();

  // Allow partial typing.
  if (title === "" && start === "" && end === "") return true;

  if (title === "") {
    err.textContent = "제목을 입력하세요.";
    return false;
  }
  if (start === "" || end === "") {
    err.textContent = "시작/끝 쪽을 모두 입력하세요.";
    return false;
  }
  const sNum = Number(start);
  const eNum = Number(end);
  if (!Number.isFinite(sNum) || !Number.isFinite(eNum) || sNum <= 0 || eNum <= 0) {
    err.textContent = "쪽수는 숫자로 입력하세요.";
    return false;
  }
  if (sNum > eNum) {
    err.textContent = "시작 쪽은 끝 쪽보다 클 수 없습니다.";
    return false;
  }
  return true;
}


function saveReadingDraft(){
  ensureTodayActivityRecord(session.studentId);
  const today = todayKey();
  const daily = getDailyActivity();
  const rec = daily[today][session.studentId];

  rec.readingDraft = {
    title: ($("#studentReadTitle")?.value || "").trim(),
    start: ($("#studentReadStart")?.value || "").trim(),
    end: ($("#studentReadEnd")?.value || "").trim(),
  };

  setDailyActivity(daily);

  const hint = $("#studentReadingSavedHint");
  if (hint) hint.textContent = "임시 저장됨";
  setTimeout(()=>{ if (hint) hint.textContent = "입력하면 자동 저장됩니다."; }, 900);
}


function applyReadingSelection(){
  const today = todayKey();
  const daily = getDailyActivity();
  const rec = (daily[today] && daily[today][session.studentId]) ? daily[today][session.studentId] : null;
  if (!rec) return;

  const locked = (kstHour() >= 17);
  const sel = $("#studentReadingSelect");
  const val = sel ? sel.value : '';
  if (locked) {
    rec.readingEditIndex = null;
    setDailyActivity(daily);
    return;
  }

  // Reset edit mode
  if (!val) {
    rec.readingEditIndex = null;
    rec.readingDraft = { title: "", start: "", end: "" };
    setDailyActivity(daily);
    renderStudentActivity();
    return;
  }

  const idx = Number(val);
  if (!Number.isFinite(idx)) return;
  const pick = (rec.reading||[])[idx];
  if (!pick) return;

  rec.readingEditIndex = idx;
  rec.readingDraft = { title: String(pick.title||""), start: String(pick.start??""), end: String(pick.end??"") };
  setDailyActivity(daily);
  renderStudentActivity();
}

function commitReadingEntry(){
  if (kstHour() >= 17) { toast("17:00 이후에는 저장할 수 없습니다."); return; }
  ensureTodayActivityRecord(session.studentId);
  const today = todayKey();
  const daily = getDailyActivity();
  const rec = daily[today][session.studentId];

  // Always read current input values (debounce 미반영 대비)
  const title = ($("#studentReadTitle")?.value || rec.readingDraft?.title || "").trim();
  const startRaw = ($("#studentReadStart")?.value || rec.readingDraft?.start || "").trim();
  const endRaw = ($("#studentReadEnd")?.value || rec.readingDraft?.end || "").trim();

  // Sync draft immediately
  rec.readingDraft = { title, start: startRaw, end: endRaw };

  // Commit requires full fields (자동저장은 부분 입력 허용)
  if (title === "" || startRaw === "" || endRaw === "") {
    const err = $("#studentActivityError");
    if (err) err.textContent = "제목/쪽수를 모두 입력하세요.";
    const hint = $("#studentReadingSavedHint");
    if (hint) hint.textContent = "저장되지 않았습니다.";
    return;
  }

  // Validate using the synced draft
  setDailyActivity(daily);
  if (!validateReadingDraft()) {
    const err = $("#studentActivityError");
    if (err) err.textContent = "독서 입력을 확인해주세요.";
  const hint = $("#studentReadingSavedHint");
    if (hint) hint.textContent = "저장되지 않았습니다.";
    return;
  }

  rec.reading = Array.isArray(rec.reading) ? rec.reading : [];

  const editIdx = Number.isFinite(rec.readingEditIndex) ? rec.readingEditIndex : null;
  // Cap only applies to "add new". Editing an existing record must be allowed even at 3/3.
  if (editIdx === null && rec.reading.length >= 3) {
    const err = $("#studentActivityError");
    if (err) err.textContent = "오늘은 최대 3건까지 기록할 수 있습니다.";
    return;
  }

  const t = title;
  const s = Number(startRaw);
  const e = Number(endRaw);
  if (editIdx !== null && rec.reading[editIdx]) {
    rec.reading[editIdx] = { title: t, start: s, end: e, at: Date.now() };
  } else {
    rec.reading.unshift({ title: t, start: s, end: e, at: Date.now() });
  }
  rec.readingEditIndex = null;

  // reset draft
  rec.readingDraft = { title: "", start: "", end: "" };
  setDailyActivity(daily);

  // clear inputs
  const it = $("#studentReadTitle");
  const is = $("#studentReadStart");
  const ie = $("#studentReadEnd");
  if (it) it.value = "";
  if (is) is.value = "";
  if (ie) ie.value = "";

  const err = $("#studentActivityError");
  if (err) err.textContent = "";
  const hint = $("#studentReadingSavedHint");
  if (hint) hint.textContent = "저장됨";
  setTimeout(()=>{ if (hint) hint.textContent = "입력하면 자동 저장됩니다."; }, 900);

  const sel = $("#studentReadingSelect");
  if (sel) sel.value = "";
  renderStudentActivity();
}



function toast(msg){
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(session._toastTimer);
  session._toastTimer = setTimeout(()=> t.classList.add("hidden"), 1800);
}

function openCharModal(){
  const modal = $("#charModal"); if (!modal) return;
  buildCharGrid();
  modal.classList.remove("hidden");
}
function closeCharModal(){ $("#charModal")?.classList.add("hidden"); }

function buildCharGrid(){
  const grid = $("#charGrid");
  if (!grid) return;

  grid.innerHTML = "";

  for (let i = 1; i <= 30; i++) {
    const btn = document.createElement("button");
    btn.className = "char-item";
    btn.type = "button";

    const path = `assets/characters/CHR-${i}.png`;
    btn.innerHTML = `
      <div class="avatar-ring">
        <img alt="캐릭터 ${i}" src="${path}">
      </div>
      <div class="muted small">#${i}</div>
    `;

    btn.addEventListener("click", () => {
      try {
        localStorage.setItem("studentAvatar_" + session.studentId, path);
      } catch (_) {}

      const st = readJSON(LS.students, []);
      const idx = st.findIndex(s => s.id === session.studentId);
      if (idx >= 0) {
        st[idx].charKey = `CHR-${i}`;
        writeJSON(LS.students, st);
      }

      const img1 = $("#studentAvatarImg");
      if (img1) img1.src = path;

      const img2 = $("#dashAvatarImg");
      if (img2) img2.src = path;

      closeCharModal();
      renderStudentDashboard();
      renderStudentHomeV1();
      toast("저장되었습니다.");
    });

    grid.appendChild(btn);
  }
}
function openPinResetModal(){
  $("#pinResetInput").value = "";
  $("#pinResetError").textContent = "";
  $("#pinResetModal").classList.remove("hidden");
}
function closePinResetModal(){ $("#pinResetModal")?.classList.add("hidden"); }
function savePinReset(){
  const next = ($("#pinResetInput").value || "").trim();
  const err = $("#pinResetError");
  if (!/^[0-9]{4,6}$/.test(next)) { err.textContent = "PIN은 숫자 4~6자리"; return; }
  const st = readJSON(LS.students, []);
  const idx = st.findIndex(s=>s.id===session.studentId);
  if (idx < 0) { err.textContent = "교사에게 문의하세요."; return; }
  st[idx].pin = next;
  writeJSON(LS.students, st);
  closePinResetModal();
  toast("저장되었습니다.");
}

function renderStudentThermo() {
  const thermo = readThermo();
  $("#sThermoNow").textContent = String(thermo.now || 0);
  $("#sThermoGoal").textContent = "100";
  $("#sThermoFill").style.height = Math.min(100, thermo.now || 0) + "%";
}

function renderStudentDonationStatus(){
  if(!session.studentId) return;
  const thermo = readThermo();
  const today = todayKey();
  const usedToday = (Array.isArray(thermo.donations) ? thermo.donations : []).filter(d=>d && d.studentId===session.studentId && d.date===today).reduce((a,d)=>a + (Number(d.amount)||0), 0);
  const remain = Math.max(0, 100 - usedToday);
  const remainEl = $("#studentDonateRemain");
  if(remainEl) remainEl.textContent = remain>0 ? `오늘 남은 기부 한도: ${remain}루멘` : `오늘의 기부 한도(100루멘)를 모두 사용했어요.`;
  const hintEl = $("#studentDonateHint");
  if(hintEl){
    hintEl.textContent = (thermo.now||0) >= 100 ? "우리 반 온도 100도 달성! · 오늘의 기부는 여기까지예요." : "기부한 루멘은 되돌릴 수 없으며, 하루 최대 100루멘까지 가능합니다.";
  }
}


/* === Activity (Morning/Reading) === */
function getDailyActivity(){
  return readJSON(LS.activityDaily, {});
}
function setDailyActivity(next){
  writeJSON(LS.activityDaily, next);
  try { scheduleActivityFirestoreSync(); } catch(_) {}
}
function ensureTodayActivityRecord(studentId){
  const today = todayKey();
  const daily = getDailyActivity();
  if (!daily[today] || typeof daily[today] !== "object") daily[today] = {};
  if (!daily[today][studentId] || typeof daily[today][studentId] !== "object") {
    daily[today][studentId] = { morning:false, reading:[], readingDraft:{title:"", start:"", end:""} };
  }
  if (!Array.isArray(daily[today][studentId].reading)) daily[today][studentId].reading = [];
  if (!daily[today][studentId].readingDraft || typeof daily[today][studentId].readingDraft !== 'object') {
    daily[today][studentId].readingDraft = { title:'', start:'', end:'' };
  }
  setDailyActivity(daily);
  return daily;
}

function renderStudentActivity(){
  const err = $("#studentActivityError");
  if (err) err.textContent = "";

  const today = todayKey();
  const daily = getDailyActivity();
  const day = daily[today] || {};
  const rec = day[session.studentId] || { morning:false, reading:[], readingDraft:{title:'', start:'', end:''} };

  // morning buttons
  const mDoneBtn = $("#studentMorningDoneBtn");
  const mCancelBtn = $("#studentMorningCancelBtn");
  const locked = (kstHour() >= 17);
  if (mDoneBtn) {
    mDoneBtn.disabled = !!rec.morning || locked;
    mDoneBtn.classList.toggle('success', !!rec.morning);
  }
  if (mCancelBtn) mCancelBtn.disabled = !rec.morning || locked;

  // reading draft -> inputs
  const t = $("#studentReadTitle");
  const s = $("#studentReadStart");
  const e = $("#studentReadEnd");
  if (t) t.value = rec.readingDraft?.title ?? "";
  if (s) s.value = rec.readingDraft?.start ?? "";
  if (e) e.value = rec.readingDraft?.end ?? "";

  if (t) t.disabled = locked;
  if (s) s.disabled = locked;
  if (e) e.disabled = locked;

  // sanitize invalid reading entries (빈값으로 3/3 고정되는 문제 방지)
  const cleanedReading = (rec.reading||[]).filter(r=>{
    const title = String(r?.title||"").trim();
    const sNum = Number(r?.start);
    const eNum = Number(r?.end);
    return title !== "" && Number.isFinite(sNum) && Number.isFinite(eNum) && sNum > 0 && eNum > 0;
  });
  if (cleanedReading.length !== (rec.reading||[]).length) {
    rec.reading = cleanedReading;
    // persist cleanup for today
    if (daily[today] && daily[today][session.studentId]) {
      daily[today][session.studentId].reading = cleanedReading;
      setDailyActivity(daily);
    }
  }


  // reading list + counter
  const counter = $("#studentReadingCounter");
  if (counter) counter.textContent = `${(rec.reading||[]).length} / 3`;

  const sel = $("#studentReadingSelect");
  if (sel) {
    const keep = sel.value;
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '저장된 독서 기록(오늘)';
    sel.appendChild(opt0);
    (rec.reading||[]).forEach((r, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      const title = (r.title || '').trim() || '제목 없음';
      opt.textContent = `${idx+1}. ${title} (${r.start}~${r.end})`;
      sel.appendChild(opt);
    });
    if (keep) sel.value = keep;
    sel.disabled = locked;
  }

  const editBtn = $("#btnStudentReadEdit");
  if (editBtn) { editBtn.disabled = locked || !(sel && sel.value); }

  // 1줄 미리보기(학생홈 첫 화면)
  const panel = $("#studentReadingPanel");
  const pv = $("#studentReadingPreviewText");
  const chev = $("#studentReadingPreview")?.querySelector?.('.chev');
  if (pv) {
    const idx = sel && sel.value !== '' ? Number(sel.value) : -1;
    const pick = (Number.isFinite(idx) && idx >= 0) ? (rec.reading||[])[idx] : (rec.reading||[])[0];
    if (pick) {
      const title = (pick.title || '').trim() || '제목 없음';
      pv.textContent = `${title} (${pick.start}~${pick.end})`;
    } else {
      pv.textContent = "오늘 독서 기록 없음";
    }
  }
  if (chev && panel) chev.textContent = panel.classList.contains('collapsed') ? '▾' : '▴';

  const addBtn = $("#btnStudentReadAdd");
  if (addBtn) {
    addBtn.disabled = locked;
    const editIdx = Number.isFinite(rec.readingEditIndex) ? rec.readingEditIndex : null;
    addBtn.textContent = (editIdx !== null) ? "수정 저장" : "독서 기록 추가";
  }

  const hint = $("#studentReadingSavedHint");
  if (hint && locked) hint.textContent = "17:00 이후 입력 잠금";
}


function renderTeacherActivity(){
  const today = todayKey();
  const label = $("#activityTodayLabel");
  if (label) label.textContent = `기준 날짜: ${today}`;

  const students = readJSON(LS.students, []).filter(s=>s.active!==false);
  const daily = getDailyActivity();
  const day = daily[today] || {};

  const wrap = $("#activityTableWrap");
  if (!wrap) return;

  if (students.length === 0) {
    wrap.innerHTML = `<div class="muted small">학생 명단이 없습니다. (메뉴 8에서 추가)</div>`;
    return;
  }

  const table = document.createElement("table");
  table.className = "activity-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width:64px;">번호</th>
        <th>이름</th>
        <th style="width:90px;">아침자습</th>
        <th style="width:140px;">독서</th>
        <th style="width:90px;"></th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  const countReadingDone = (arr)=>{
    if (!Array.isArray(arr)) return 0;
    return arr.filter(r=>{
      const s = String(r?.start ?? "").trim();
      const e = String(r?.end ?? "").trim();
      return s !== "" && e !== "";
    }).length;
  };

  const makeDetailRow = (reading, studentId, studentName, onCountChange) => {
    const dtr = document.createElement("tr");
    dtr.className = "activity-expand-row hidden";
    const td = document.createElement("td");
    td.colSpan = 5;
    td.innerHTML = `
      <div class="activity-detail">
        <div class="activity-detail-head">
          <div class="muted small">오늘 독서 기록</div>
          <button class="btn soft" data-action="history">누적 보기</button>
        </div>
        <div class="activity-detail-body"></div>
      </div>
    `;
    dtr.appendChild(td);

    const body = td.querySelector(".activity-detail-body");
    // 입력형 UI (도서 제목/시작쪽/끝쪽) — 1인 3회까지
    const grid = document.createElement("div");
    grid.className = "activity-input";
    grid.innerHTML = `
      <div class="activity-input-head">
        <div class="muted small">도서 제목</div>
        <div class="muted small">시작쪽</div>
        <div class="muted small">끝쪽</div>
        <div class="muted small">쪽수</div>
      </div>
      <div class="activity-input-rows"></div>
    `;
    const rowsWrap = grid.querySelector(".activity-input-rows");

    const ensureReadingArr = ()=>{
      const d = ensureTodayActivityRecord(studentId);
      const arr = d[today][studentId].reading;
      while (arr.length < 3) arr.push({ title:"", start:"", end:"", ts:Date.now() });
      if (arr.length > 3) arr.length = 3;
      setDailyActivity(d);
      return arr;
    };

    const renderPages = (s,e)=>{
      const start = Number(s);
      const end = Number(e);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "-";
      return String(end - start + 1);
    };

    const arr = ensureReadingArr();
    for (let i=0;i<3;i++){
      const r = arr[i] || { title:"", start:"", end:"" };
      const row = document.createElement("div");
      row.className = "activity-input-row";
      row.innerHTML = `
        <input class="input" data-k="title" data-i="${i}" placeholder="제목" value="${escapeHtml(String(r.title ?? ""))}" />
        <input class="input mono" data-k="start" data-i="${i}" inputmode="numeric" placeholder="시작" value="${escapeHtml(String(r.start ?? ""))}" />
        <input class="input mono" data-k="end" data-i="${i}" inputmode="numeric" placeholder="끝" value="${escapeHtml(String(r.end ?? ""))}" />
        <div class="activity-pages mono" data-pages-i="${i}">${escapeHtml(renderPages(r.start, r.end))}</div>
      `;
      rowsWrap.appendChild(row);
    }
    body.innerHTML = "";
    body.appendChild(grid);

    const applyChange = ()=>{
      const d = ensureTodayActivityRecord(studentId);
      const a = d[today][studentId].reading;
      // sync from inputs
      body.querySelectorAll('input[data-i]').forEach(inp=>{
        const idx = Number(inp.getAttribute("data-i"));
        const key = inp.getAttribute("data-k");
        if (!a[idx]) a[idx] = { title:"", start:"", end:"", ts:Date.now() };
        a[idx][key] = inp.value;
        a[idx].ts = Date.now();
      });
      // update pages display
      for (let i=0;i<3;i++){
        const p = body.querySelector(`[data-pages-i="${i}"]`);
        if (p) p.textContent = renderPages(a[i]?.start, a[i]?.end);
      }
      setDailyActivity(d);
      if (typeof onCountChange === "function") onCountChange(countReadingDone(a));
    };

    body.querySelectorAll('input[data-i]').forEach(inp=>{
      inp.addEventListener("input", applyChange);
      inp.addEventListener("change", applyChange);
    });

    td.querySelector('[data-action="history"]').addEventListener("click", ()=> openActivityHistory(studentId, studentName));
    return dtr;
  };

  students.sort((a,b)=>(a.no||0)-(b.no||0)).forEach(s=>{
    const rec = day[s.id] || { morning:false, reading:[], readingDraft:{title:"", start:"", end:""} };
    const reading = Array.isArray(rec.reading) ? rec.reading : [];

    const tr = document.createElement("tr");
    tr.className = "activity-main-row";
    const readingCount = countReadingDone(reading);
    tr.innerHTML = `
      <td class="mono">${escapeHtml(s.no ?? "")}</td>
      <td><b>${escapeHtml(s.name || "")}</b> <span class="muted small">(${escapeHtml(s.id)})</span></td>
      <td>${rec.morning ? `<span class="activity-check">✓</span>` : ""}</td>
      <td><span class="activity-pill">${readingCount}/3</span></td>
      <td><div class="activity-actions"><button class="btn soft" data-action="toggle">펼치기</button></div></td>
    `;

    // 이름 클릭 -> 누적 보기(바로 열람)
    const nameCell = tr.children[1];
    if (nameCell) {
      nameCell.style.cursor = "pointer";
      nameCell.addEventListener("click", ()=> openActivityHistory(s.id, s.name));
    }


    const pill = tr.querySelector(".activity-pill");
    const dtr = makeDetailRow(reading, s.id, s.name, (cnt)=>{ if (pill) pill.textContent = `${cnt}/3`; });
    const toggleBtn = tr.querySelector('[data-action="toggle"]');
    toggleBtn.addEventListener("click", ()=>{
      const open = !dtr.classList.contains("hidden");
      if (open) {
        dtr.classList.add("hidden");
        toggleBtn.textContent = "펼치기";
      } else {
        dtr.classList.remove("hidden");
        toggleBtn.textContent = "접기";
      }
    });

    tbody.appendChild(tr);
    tbody.appendChild(dtr);
  });

  wrap.innerHTML = "";
  wrap.appendChild(table);
}

function openActivityHistory(studentId, studentName){
  const modal = $("#activityHistoryModal");
  const title = $("#activityHistoryTitle");
  const body = $("#activityHistoryBody");
  if (!modal || !body) return;

  if (title) title.textContent = `독서 누가기록 · ${studentName || studentId}`;

  const histAll = readJSON(LS.activityReadingHistory, {});
  const rows = Array.isArray(histAll[studentId]) ? histAll[studentId].slice() : [];
  rows.sort((a,b)=>(b.ts||0)-(a.ts||0));

  body.innerHTML = `
    <div class="history-toolbar">
      <div class="muted small">정렬: 최신순 · 최대 50</div>
      <div class="history-actions">
        <button class="chip" id="histBackupBtn" disabled title="준비중">JSON 백업</button>
        <button class="chip" id="histRestoreBtn" disabled title="준비중">JSON 복원</button>
      </div>
    </div>
    <div class="history-list" id="histList"></div>
  `;

  const list = $("#histList");
  if (!list) return;

  if (rows.length === 0) {
    list.innerHTML = `<div class="muted small">누가 기록이 없습니다.</div>`;
  } else {
    rows.slice(0,50).forEach((r, idx)=>{
      const row = document.createElement("div");
      row.className = "history-row";

      const left = document.createElement("div");
      left.className = "history-left";
      left.innerHTML = `<div><b>${escapeHtml(r.date || "")}</b> <span class="mono">${escapeHtml(r.start)}~${escapeHtml(r.end)}</span> <span class="muted small">(${escapeHtml(r.pages)}쪽)</span></div>`;
      left.innerHTML += `<div class="history-meta">삭제는 교사만 가능 · 이전 날짜만</div>`;

      const del = document.createElement("button");
      del.className = "btn danger";
      del.textContent = "삭제";
      del.addEventListener("click", ()=>{
        const h = readJSON(LS.activityReadingHistory, {});
        const arr = Array.isArray(h[studentId]) ? h[studentId] : [];
        const target = rows[idx];
        const pos = arr.findIndex(x => (x.ts||0)===(target.ts||0) && x.date===target.date && x.start===target.start && x.end===target.end);
        if (pos >= 0) {
          arr.splice(pos, 1);
          h[studentId] = arr;
          writeJSON(LS.activityReadingHistory, h);
          openActivityHistory(studentId, studentName);
        }
      });

      row.appendChild(left);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  modal.classList.remove("hidden");
}


function closeActivityHistory(){
  const modal = $("#activityHistoryModal");
  if (modal) modal.classList.add("hidden");
}

function openTodayReadingDetail(){
  const modal = $("#todayReadingDetailModal");
  const body = $("#todayReadingDetailBody");
  if (!modal || !body) return;

  const st = readJSON(LS.students, []);
  const dailyAll = readJSON(LS.activityDaily, {});
  const date = todayStr();
  const day = dailyAll[date] || {};

  // build rows per student (active only)
  const students = st.filter(s=>s && s.active!==false);
  body.innerHTML = `<div class="history-toolbar">
      <div class="muted small">오늘(${escapeHtml(date)}) · 학생별 독서 1~3건</div>
    </div>
    <div class="history-list" id="todayReadingStudentList"></div>`;

  const list = $("#todayReadingStudentList");
  if (!list) return;

  if (students.length === 0) {
    list.innerHTML = `<div class="muted small">학생이 없습니다.</div>`;
  } else {
    students.forEach(s=>{
      const rec = day[s.id];
      const arr = Array.isArray(rec?.reading) ? rec.reading.slice() : [];
      arr.sort((a,b)=>Number(b.at||b.ts||0)-Number(a.at||a.ts||0));
      const top = arr.slice(0,3);

      const row = document.createElement("div");
      row.className = "history-row";
      row.dataset.sid = s.id;

      const left = document.createElement("div");
      left.className = "history-left";
      const cnt = top.length;
      left.innerHTML = `<div><b>${escapeHtml(s.name||s.id)}</b> <span class="muted small">${cnt?`${cnt}건`:"기록 없음"}</span></div>`;

      const details = document.createElement("div");
      details.className = "history-meta";
      details.id = `trd_${s.id}`;
      details.style.display = "none";

      if (top.length === 0) {
        details.innerHTML = `<div class="muted small">오늘 기록 없음</div>`;
      } else {
        details.innerHTML = top.map(r=>{
          const at = Number(r.at||r.ts||0);
          const d = at ? new Date(at) : null;
          const hhmm = d ? `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}` : "";
          const title = escapeHtml(String(r.title||"제목 없음"));
          const start = r.start!=null ? escapeHtml(String(r.start)) : "";
          const end = r.end!=null ? escapeHtml(String(r.end)) : "";
          const pages = (r.start!=null && r.end!=null && !isNaN(Number(r.start)) && !isNaN(Number(r.end))) ? ` · ${Math.max(0, Number(r.end)-Number(r.start)+1)}쪽` : "";
          const range = (start && end) ? `${start}~${end}` : "";
          return `<div class="muted small">• <b>${title}</b> <span class="mono">${range}</span>${pages} <span class="muted">(${hhmm})</span></div>`;
        }).join("");
      }

      left.appendChild(details);

      const btn = document.createElement("button");
      btn.className = "chip";
      btn.textContent = "자세히 보기";
      btn.addEventListener("click", (e)=>{
        e.preventDefault();
        e.stopPropagation();
        const el = $(`#trd_${s.id}`);
        if (!el) return;
        const isOpen = el.style.display !== "none";
        // close others
        list.querySelectorAll(".history-meta").forEach(x=>{ x.style.display="none"; });
        el.style.display = isOpen ? "none" : "block";
      });

      row.appendChild(left);
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  modal.classList.remove("hidden");
  try{ document.body.classList.add("no-scroll"); }catch(_){}
}

function closeTodayReadingDetail(){
  $("#todayReadingDetailModal")?.classList.add("hidden");
  try{ document.body.classList.remove("no-scroll"); }catch(_){}
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/* === Student personal penalty log viewer (read-only, latest 10) === */
function ensureStudentPenaltyLogButton(){
  const list = document.getElementById("studentPenaltyList");
  const empty = document.getElementById("studentPenaltyEmpty");
  if(!list && !empty) return;
  const parent = (list && list.parentElement) || (empty && empty.parentElement);
  if(!parent) return;
  if(document.getElementById("viewMyPenaltyLogsBtn")) return;
  const btn = document.createElement("button");
  btn.id = "viewMyPenaltyLogsBtn";
  btn.type = "button";
  btn.className = "btn soft wide";
  btn.style.margin = "10px 0";
  btn.textContent = "내 최근 벌점 기록 보기";
  if(list) parent.insertBefore(btn, list.nextSibling);
  else parent.appendChild(btn);
}

function formatPenaltyLogDate(ts){
  const n = Number(ts || 0);
  if(!n) return "날짜 없음";
  const d = new Date(n);
  if(Number.isNaN(d.getTime())) return "날짜 없음";
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

async function fetchMyPenaltyLogsLatest10(){
  const me = (typeof getMe === "function") ? getMe() : null;
  const sid = String(session?.studentId || me?.id || "").trim();
  const sname = String(me?.name || "").trim();
  if(!sid) return [];
  const arr = [];
  try{
    const snap = await collection(db, FS_COLLECTIONS.penaltyLogs).get();
    snap.forEach(d=>{
      const data = d.data() || {};
      const log = (typeof normalizePenaltyLog === "function") ? normalizePenaltyLog({ ...data, id: data.id || d.id }) : { ...data, id:data.id || d.id };
      if(!log) return;
      const logSid = String(log.studentId || data.sid || "").trim();
      const logName = String(data.studentName || data.name || "").trim();
      if(logSid === sid || (sname && logName === sname)) arr.push(log);
    });
  }catch(err){
    console.warn("[SEBIT] direct penalty log read failed; fallback to local cache", err);
    try{
      const local = (typeof getAllPenaltyLogs === "function") ? getAllPenaltyLogs() : [];
      local.forEach(l=>{ if(String(l.studentId||"").trim() === sid) arr.push(l); });
    }catch(_){}
  }
  return arr.sort((a,b)=>Number(b.ts||0)-Number(a.ts||0)).slice(0,10);
}

function renderMyPenaltyLogsHTML(logs){
  if(!Array.isArray(logs) || logs.length === 0){
    return `<div class="muted" style="padding:14px;">최근 벌점 기록이 없습니다.</div>`;
  }
  return `<div class="history-list">${logs.map(l=>{
    const title = escapeHTML(String(l.ruleTitle || l.articleTitle || l.articleText || "벌점 기록"));
    const date = escapeHTML(formatPenaltyLogDate(l.ts));
    const lumen = Math.abs(Number(l.lumen || 0));
    const xp = Math.abs(Number(l.xp || 0));
    const canceled = String(l.status || "") === "canceled";
    return `<div class="history-row" style="align-items:flex-start;"><div class="history-left"><div><b>${title}</b> ${canceled ? `<span class="muted small">(취소됨)</span>` : ``}</div><div class="muted small">${date}</div><div class="muted small">-${lumen} 루멘 / -${xp} XP</div></div></div>`;
  }).join("")}</div>`;
}

function openMyPenaltyLogsModal(logs){
  let modal = document.getElementById("myPenaltyLogsModal");
  if(!modal){
    modal = document.createElement("div");
    modal.id = "myPenaltyLogsModal";
    modal.className = "modal hidden";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `<div class="modal-card wide"><header class="modal-top"><div class="modal-title">내 최근 벌점 기록</div><button class="chip" id="closeMyPenaltyLogsBtn" type="button">닫기</button></header><div class="activity-history" id="myPenaltyLogsBody"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e)=>{ if(e.target === modal) closeMyPenaltyLogsModal(); else e.stopPropagation(); });
    modal.querySelector("#closeMyPenaltyLogsBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); closeMyPenaltyLogsModal(); });
  }
  const body = modal.querySelector("#myPenaltyLogsBody");
  if(body) body.innerHTML = renderMyPenaltyLogsHTML(logs);
  modal.classList.remove("hidden");
  try{ document.body.classList.add("no-scroll"); }catch(_){}
}

function closeMyPenaltyLogsModal(){
  document.getElementById("myPenaltyLogsModal")?.classList.add("hidden");
  try{ document.body.classList.remove("no-scroll"); }catch(_){}
}

async function handleViewMyPenaltyLogsClick(){
  const btn = document.getElementById("viewMyPenaltyLogsBtn");
  try{
    if(btn){ btn.disabled = true; btn.textContent = "불러오는 중..."; }
    const logs = await fetchMyPenaltyLogsLatest10();
    openMyPenaltyLogsModal(logs);
  }catch(err){
    console.error("[SEBIT] my penalty logs open failed", err);
    if(typeof toast === "function") toast("벌점 기록을 불러오지 못했습니다.");
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = "내 최근 벌점 기록 보기"; }
  }
}

(function bindStudentPenaltyLogAlwaysButton(){
  if(window.__sebitPenaltyLogButtonBound) return;
  window.__sebitPenaltyLogButtonBound = true;
  document.addEventListener("click", (e)=>{
    const btn = e.target && e.target.closest ? e.target.closest("#viewMyPenaltyLogsBtn") : null;
    if(!btn) return;
    e.preventDefault();
    e.stopPropagation();
    handleViewMyPenaltyLogsClick();
  }, true);
})();
async function onTeacherLogin() {
  const input = $("#teacherPwInput");
  const err = $("#teacherLoginError");
  const btn = $("#teacherLoginBtn");
  const raw = (input?.value || "").trim();

  if (!validateTeacherPw(raw)) {
    err.textContent = "영어+숫자 조합으로 입력해 주세요. (예: sebit2026)";
    return;
  }

  try{
    if(btn) btn.disabled = true;
    err.textContent = "비밀번호 확인 중...";
    const ok = await checkTeacherPassword(raw);
    if (!ok) {
      err.textContent = "비밀번호가 올바르지 않습니다.";
      return;
    }
    err.textContent = "";
    session.teacherAuthed = true;
    runMidnightResetIfNeeded();
    scheduleMidnightResetTick();
    showPage("teacher-home");
  }catch(e){
    console.error("[SEBIT] teacher login failed", e);
    err.textContent = "서버 비밀번호 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.";
  }finally{
    if(btn) btn.disabled = false;
  }
}

function onStudentLogin() {
  const id = normalizeStudentId($("#studentIdInput")?.value);
  const pin = ($("#studentPinInput")?.value || "").trim();
  const err = $("#studentLoginError");

  const st = readJSON(LS.students, []);
  const me = st.find(s=>s.id === id);

  if (!me || me.active === false) {
    err.textContent = "ID를 확인해 주세요.";
    return;
  }
  if (pin !== (me.pin || DEFAULT_PIN)) {
    err.textContent = "PIN이 올바르지 않습니다.";
    return;
  }

  session.studentId = me.id;
  runMidnightResetIfNeeded();
  scheduleMidnightResetTick();
  showPage("student-dashboard");
}

function openPinModal() {
  $("#newPinInput").value = "";
  $("#pinModalError").textContent = "";
  $("#pinModal").classList.remove("hidden");
}
function closePinModal() {
  $("#pinModal").classList.add("hidden");
}
function saveNewPin() {
  const next = ($("#newPinInput").value || "").trim();
  const err = $("#pinModalError");
  if (!/^[0-9]{4,6}$/.test(next)) {
    err.textContent = "숫자 4~6자리로 입력해 주세요.";
    return;
  }
  const st = readJSON(LS.students, []);
  const idx = st.findIndex(s=>s.id === session.studentId);
  if (idx < 0) {
    err.textContent = "학생 정보를 찾을 수 없습니다.";
    return;
  }
  st[idx].pin = next;
  writeJSON(LS.students, st);
  closePinModal();
}

function onSaveThermoGoal() {
  const v = Number($("#thermoGoalInput").value);
  const thermo = readJSON(LS.thermo, {goal:0, now:0, donations:[]});
  thermo.goal = Number.isFinite(v) && v >= 0 ? v : 0;
  writeThermo(thermo);
  renderThermometer();
  renderTeacherHome();
}
function onResetThermo() {
  const ok = confirm("학급 온도계를 초기화할까요? (기부/보상 상태가 모두 초기화됩니다)");
  if (!ok) return;
  const base = defaultThermoModel();
  base.cycleId = Date.now();
  writeThermo(base);
  renderThermometer();
  renderTeacherHome();
}


function logoutToIntro() {
  session.teacherAuthed = false;
  session.studentId = null;
  showPage("intro");
  

  
}


function openThermoDrawer(){
  const d = $("#thermoDrawer");
  if (!d) return;
  d.classList.remove("hidden");
  d.setAttribute("aria-hidden","false");
  renderThermoDrawer();
}
function closeThermoDrawer(){
  const d = $("#thermoDrawer");
  if (!d) return;
  d.classList.add("hidden");
  d.setAttribute("aria-hidden","true");
}
let thermoActiveTab = "rewards";
function setThermoTab(tab){
  thermoActiveTab = tab;
  document.querySelectorAll("[data-thermo-tab]").forEach(b=>{
    b.classList.toggle("active", b.getAttribute("data-thermo-tab")===tab);
  });
  document.querySelectorAll("[data-thermo-pane]").forEach(p=>{
    p.classList.toggle("hidden", p.getAttribute("data-thermo-pane")!==tab);
  });
  renderThermoDrawer();
}
function renderThermoAdminPreview(thermo){
  const nowEl = $("#adminThermoNow");
  if (nowEl) nowEl.textContent = String(thermo.now || 0);
  const wrap = $("#adminThermoStageList");
  if (!wrap) return;
  wrap.innerHTML = "";
  // 1(아래)→5(위): CSS column-reverse, 여기서는 20→100 순서로 쌓기
  THERMO_STAGES.forEach(v=>{
    const key = String(v);
    const rewardText = (thermo.rewardsText[key] || "").trim() || "보상 미설정";
    const reached = (thermo.now || 0) >= v;
    const row = document.createElement("div");
    row.className = "thermo-stage-row" + (reached ? " reached" : "");
    row.innerHTML = `
      <div class="l">
        <div class="thermo-stage-pill">${v}도</div>
        <div class="t">${escapeHtml(rewardText)}</div>
      </div>
      <div class="muted small">${reached ? "도달" : "대기"}</div>
    `;
    wrap.appendChild(row);
  });
}

function renderThermoDrawer(){
  const d = $("#thermoDrawer");
  if (!d || d.classList.contains("hidden")) return;

  const thermo = readThermo();

  // preview
  renderThermoAdminPreview(thermo);

  // sync inputs
  const map = {20:"reward20",40:"reward40",60:"reward60",80:"reward80",100:"reward100"};
  Object.entries(map).forEach(([k,id])=>{
    const el = $("#"+id);
    if (el) el.value = thermo.rewardsText[String(k)] || "";
  });

  // grant list
  const list = $("#grantList");
  if (list) {
    list.innerHTML = "";
    THERMO_STAGES.forEach(v=>{
      const key = String(v);
      const stageNum = THERMO_STAGES.indexOf(v)+1;
      const rewardText = (thermo.rewardsText[key] || "").trim() || "보상 미설정";
      const isClaimed = !!thermo.claimed[key];
      const isReached = thermo.now >= v;
      const state = isClaimed ? "CLAIMED" : (isReached ? "AVAILABLE" : "LOCKED");
      const item = document.createElement("div");
      item.className = "grant-item";
      item.innerHTML = `
        <div class="left">
          <div class="title">${stageNum}단계 · ${v}도</div>
          <div class="muted small">${escapeHtml(rewardText)}</div>
          <div class="state muted small">상태: ${state}</div>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn soft" data-thermo-grant="${key}">지급</button>
          <button class="btn" data-thermo-cancel="${key}">취소</button>
        </div>
      `;
      list.appendChild(item);
    });
  }
}
function saveThermoRewards(){
  const thermo = readThermo();
  const readVal = (id)=> ($("#"+id)?.value || "").trim();
  thermo.rewardsText["20"]=readVal("reward20");
  thermo.rewardsText["40"]=readVal("reward40");
  thermo.rewardsText["60"]=readVal("reward60");
  thermo.rewardsText["80"]=readVal("reward80");
  thermo.rewardsText["100"]=readVal("reward100");
  writeThermo(thermo);
  renderThermometer();
  renderTeacherHome();
  renderThermoDrawer();
}
function setThermoClaim(stageKey, next){
  const thermo = readThermo();
  thermo.claimed[String(stageKey)] = !!next;
  writeThermo(thermo);
  renderThermometer();
  renderTeacherHome();
  renderThermoDrawer();
}




/* === Student read-only views: constitution poster + job status (v1) === */
function ensureStudentReadonlyViewStyles(){
  if(document.getElementById('studentReadonlyViewStyles')) return;
  const st = document.createElement('style');
  st.id = 'studentReadonlyViewStyles';
  st.textContent = `
    .student-view-modal{position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,.28); display:flex; align-items:center; justify-content:center; padding:18px;}
    .student-view-card{width:min(760px,94vw); max-height:86vh; overflow:hidden; border-radius:24px; background:rgba(255,255,255,.92); box-shadow:0 24px 80px rgba(0,0,0,.22); border:1px solid rgba(255,255,255,.75); backdrop-filter: blur(14px); display:flex; flex-direction:column;}
    .student-view-head{display:flex; align-items:center; justify-content:space-between; gap:12px; padding:18px 20px; border-bottom:1px solid rgba(0,0,0,.08);}
    .student-view-title{font-weight:900; font-size:20px; color:#222;}
    .student-view-body{overflow:auto; padding:16px 18px 20px;}
    .student-view-close{border:0; border-radius:999px; padding:10px 18px; font-weight:800; background:#fff; box-shadow:0 8px 24px rgba(0,0,0,.10); cursor:pointer;}
    .student-poster-cat{margin-bottom:16px; border:1px solid rgba(0,0,0,.08); border-radius:18px; background:rgba(255,255,255,.72); overflow:hidden;}
    .student-poster-cat-title{font-weight:900; padding:12px 14px; background:rgba(255,255,255,.8); border-bottom:1px solid rgba(0,0,0,.06);}
    .student-poster-item{padding:12px 14px; border-top:1px solid rgba(0,0,0,.05);}
    .student-poster-item:first-of-type{border-top:0;}
    .student-poster-item-title{font-weight:850; margin-bottom:5px;}
    .student-poster-item-desc{font-size:13px; color:#555; line-height:1.45;}
    .student-poster-penalty{display:inline-flex; margin-top:8px; border-radius:999px; padding:6px 10px; background:#fff3cf; color:#7a5200; font-size:12px; font-weight:900;}
    .student-job-summary{display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px;}
    .student-job-pill{border-radius:999px; background:#fff; border:1px solid rgba(0,0,0,.08); padding:8px 12px; font-weight:800;}
    .student-job-grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px;}
    .student-job-card{border:1px solid rgba(0,0,0,.08); background:rgba(255,255,255,.78); border-radius:18px; padding:13px 14px;}
    .student-job-name{font-weight:900; margin-bottom:6px;}
    .student-job-holder{font-size:13px; color:#555; margin-bottom:8px;}
    .student-job-state{display:inline-flex; border-radius:999px; padding:6px 10px; font-size:12px; font-weight:900;}
    .student-job-state.done{background:#dff6e8; color:#16703a;}
    .student-job-state.wait{background:#fff3cf; color:#805c00;}
    .student-job-note{font-size:12px; color:#777; margin-top:8px; line-height:1.45;}
  `;
  document.head.appendChild(st);
}

function openStudentReadonlyModal(title, bodyHTML){
  ensureStudentReadonlyViewStyles();
  const old = document.getElementById('studentReadonlyViewModal');
  if(old) old.remove();
  const modal = document.createElement('div');
  modal.id = 'studentReadonlyViewModal';
  modal.className = 'student-view-modal';
  modal.innerHTML = `
    <div class="student-view-card" role="dialog" aria-modal="true">
      <div class="student-view-head">
        <div class="student-view-title">${escapeHTML(title)}</div>
        <button class="student-view-close" type="button">닫기</button>
      </div>
      <div class="student-view-body">${bodyHTML}</div>
    </div>
  `;
  modal.addEventListener('click', (e)=>{ if(e.target===modal) modal.remove(); });
  modal.querySelector('.student-view-close')?.addEventListener('click', ()=> modal.remove());
  document.body.appendChild(modal);
}

function renderStudentConstitutionReadOnlyHTML(){
  const state = (typeof getConstitutionState === 'function') ? getConstitutionState() : readJSON(LS_KEYS.constitution, DEFAULT_CONSTITUTION);
  const cats = Array.isArray(state?.categories) ? state.categories : [];
  if(!cats.length) return `<div class="muted">등록된 세빛 헌법이 없습니다.</div>`;
  return cats.map(cat=>{
    const items = (Array.isArray(cat.items) ? cat.items : []).filter(it=>it && it.active!==false);
    return `
      <section class="student-poster-cat">
        <div class="student-poster-cat-title">${escapeHTML(cat.name||'')}</div>
        ${items.length ? items.map((it, idx)=>`
          <div class="student-poster-item">
            <div class="student-poster-item-title">${escapeHTML(it.label || `제${idx+1}조`)} ${escapeHTML(it.title||'')}</div>
            <div class="student-poster-item-desc">${escapeHTML(it.desc||'')}</div>
            <div class="student-poster-penalty">벌점 기준: -${Number(it.lumen)||0} 루멘 / -${Number(it.xp)||0} XP</div>
          </div>
        `).join('') : `<div class="student-poster-item"><div class="student-poster-item-desc">표시할 조항이 없습니다.</div></div>`}
      </section>
    `;
  }).join('');
}

function openStudentConstitutionView(){
  openStudentReadonlyModal('세빛 헌법', renderStudentConstitutionReadOnlyHTML());
}

function jobDoneKeyForName(jobName, today){
  const n = String(jobName||'');
  const pairs = [
    ['학습 체크단','studycheck'], ['준비물','studycheck'],
    ['정리 마스터','tidymaster'], ['정리','tidymaster'],
    ['작품 큐레이터','artcurator'], ['작품','artcurator'],
    ['런치 세이버','lunchsaver'], ['급식','lunchsaver'],
    ['타임 키퍼','timekeeper'], ['등교','timekeeper'],
    ['교실 레인저','ranger'], ['레인저','ranger'],
    ['빛의 상인','lightmerchant'], ['상인','lightmerchant'],
    ['그린 세이버','greensaver'], ['분리배출','greensaver'],
    ['웨더 캐스터','weathercaster'], ['날씨','weathercaster'],
    ['페어 저스티스','fairjustice'], ['공정','fairjustice'],
    ['빛의 파수꾼','lightkeeper'], ['파수꾼','lightkeeper'],
    ['테크 키퍼','techkeeper'], ['패드','techkeeper'],
    ['문서 마스터','docmaster'], ['문서','docmaster']
  ];
  for(const [label, key] of pairs){
    if(n.includes(label)) return `sebit_jobdone_${key}_${today}`;
  }
  return '';
}

function isJobDoneToday(jobName, today){
  const key = jobDoneKeyForName(jobName, today);
  if(key && localStorage.getItem(key)) return true;
  // fallback: unknown/new jobs. If any jobdone key contains a simplified token and today's date, treat as done.
  const keys = [];
  for(let i=0;i<localStorage.length;i++){
    const k = localStorage.key(i) || '';
    if(k.startsWith('sebit_jobdone_') && k.endsWith('_'+today)) keys.push(k);
  }
  return false;
}

function renderStudentJobStatusHTML(){
  const today = todayKey();
  const students = readJSON(LS.students, []);
  const active = Array.isArray(students) ? students.filter(s=>s && s.active!==false) : [];
  const rows = [];
  active.forEach(s=>{
    const jobs = Array.isArray(s.jobs) ? s.jobs : [];
    jobs.filter(Boolean).forEach(job=>{
      rows.push({ studentId:String(s.id||''), studentName:String(s.name||s.id||''), jobName:String(job), done:isJobDoneToday(job, today) });
    });
  });
  const doneCount = rows.filter(r=>r.done).length;
  const myId = String(session?.studentId||'');
  const myRows = rows.filter(r=>String(r.studentId)===myId);
  const myText = myRows.length ? myRows.map(r=>r.jobName).join(', ') : '배정된 직업 없음';
  if(!rows.length){
    return `
      <div class="student-job-summary">
        <div class="student-job-pill">오늘 날짜 ${escapeHTML(today)}</div>
        <div class="student-job-pill">배정된 직업 없음</div>
      </div>
      <div class="muted">아직 직업 배정이 확정되지 않았습니다.</div>
    `;
  }
  return `
    <div class="student-job-summary">
      <div class="student-job-pill">오늘 날짜 ${escapeHTML(today)}</div>
      <div class="student-job-pill">내 직업: ${escapeHTML(myText)}</div>
      <div class="student-job-pill">마감 ${doneCount}/${rows.length}</div>
    </div>
    <div class="student-job-grid">
      ${rows.map(r=>`
        <div class="student-job-card">
          <div class="student-job-name">${escapeHTML(r.jobName)}</div>
          <div class="student-job-holder">담당: ${escapeHTML(r.studentName)}</div>
          <span class="student-job-state ${r.done?'done':'wait'}">${r.done?'마감 완료':'기록 대기'}</span>
          <div class="student-job-note">체크리스트에서 마감을 누르면 이곳에 마감 완료로 표시됩니다.</div>
        </div>
      `).join('')}
    </div>
  `;
}

function openStudentJobStatusView(){
  openStudentReadonlyModal('직업 현황', renderStudentJobStatusHTML());
}

function bindStudentQuickReadonlyButtons(){
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('button, [role="button"], .btn');
    if(!btn) return;
    const modal = document.getElementById('studentQuickModal');
    if(modal && modal.contains(btn)){
      const txt = (btn.textContent || '').replace(/\s+/g,' ').trim();
      if(txt.includes('세빛 헌법')){
        e.preventDefault(); e.stopPropagation();
        modal.classList.add('hidden');
        openStudentConstitutionView();
        return;
      }
      if(txt.includes('직업 현황')){
        e.preventDefault(); e.stopPropagation();
        modal.classList.add('hidden');
        openStudentJobStatusView();
        return;
      }
    }
  }, true);
}



/* 구매 버튼 전용 캡처 핸들러: data-go 임시 안내보다 먼저 실행 */
document.addEventListener("click", function(e){
  const buy = e.target && e.target.closest ? e.target.closest("[data-shop-buy]") : null;
  if(!buy) return;
  e.preventDefault();
  e.stopPropagation();
  if(typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
  if(buy.disabled){
    toast("구매할 수 없는 상품입니다.");
    return;
  }
  const pid = buy.getAttribute("data-shop-buy");
  if(pid) openPurchaseConfirm(pid);
}, true);

function bind() {
  bindStudentQuickReadonlyButtons();
  document.addEventListener("click", (e) => {
    if(e.defaultPrevented) return;
    if(e.target && e.target.closest && e.target.closest("[data-shop-buy]")) return;
    const g = e.target.closest("[data-thermo-grant]");
    if (g) { setThermoClaim(g.getAttribute("data-thermo-grant"), true); return; }
    const c = e.target.closest("[data-thermo-cancel]");
    if (c) { setThermoClaim(c.getAttribute("data-thermo-cancel"), false); return; }
    const target = e.target.closest("[data-go]");
    if (!target) return;
    const page = target.getAttribute("data-go");
    if (!page) return;

    const mode = target.getAttribute("data-calendar-mode");
    if (mode) session.calendarMode = mode;
    const exists = document.querySelector(`.page[data-page="${page}"]`);
    if (!exists) { toast('해당 페이지는 다음 단계에서 연결합니다.'); return; }
    showPage(page);
  });

  $("#teacherLoginBtn")?.addEventListener("click", onTeacherLogin);
  $("#teacherPwInput")?.addEventListener("keydown", (e)=>{ if (e.key==="Enter") onTeacherLogin(); });

  
  $("#studentLoginBtn")?.addEventListener("click", onStudentLogin);
  $("#studentPinInput")?.addEventListener("keydown", (e)=>{ if (e.key==="Enter") onStudentLogin(); });

  // Student Dashboard
  $("#studentDashLogoutBtn")?.addEventListener("click", logoutToIntro);
  $("#dashProfileBtn")?.addEventListener("click", ()=> showPage("student-home"));
  $("#dashProfileBtn")?.addEventListener("keydown", (e)=>{ if (e.key==="Enter" || e.key===" ") showPage("student-home"); });

  // Student Home v1 (개인관리)
  $("#studentChangeAvatarBtn")?.addEventListener("click", openCharModal);
  $("#closeCharModalBtn")?.addEventListener("click", closeCharModal);
  $("#charModal")?.addEventListener("click", (e)=>{ if (e.target.id==="charModal") closeCharModal(); });

  $("#studentChangePinBtn")?.addEventListener("click", openPinResetModal);

  $("#studentLogoutBtn")?.addEventListener("click", logoutToIntro);
  $("#studentCloseBtn")?.addEventListener("click", ()=> showPage("student-dashboard"));
  $("#studentProfileBtn")?.addEventListener("click", ()=> { $("#studentQuickModal")?.classList.remove("hidden"); });
  $("#studentQuickCloseBtn")?.addEventListener("click", ()=> { $("#studentQuickModal")?.classList.add("hidden"); });
  $("#studentQuickModal")?.addEventListener("click", (e)=>{ if(e.target && e.target.id==="studentQuickModal"){ $("#studentQuickModal").classList.add("hidden"); } });

  // Bank handlers are wired in wireStudentBankButtons().


// Class Donation (below bank)
  renderStudentDonationStatus();

  $("#studentDonateBtn")?.addEventListener('click', async ()=>{
    const thermoNow = readThermo();
    if ((thermoNow.now||0) >= 100) { toast('이미 100도 달성! 지금은 기부할 수 없습니다.'); return; }
    const today2 = todayKey();
    const used2 = (Array.isArray(thermoNow.donations) ? thermoNow.donations : []).filter(d=>d && d.studentId===session.studentId && d.date===today2).reduce((a,d)=>a + (Number(d.amount)||0), 0);
    const remain2 = Math.max(0, 100 - used2);
    if (remain2 <= 0) { toast('오늘의 기부 한도(100루멘)를 모두 사용했어요.'); return; }
    const raw = ($("#studentDonateAmount")?.value || "").trim();
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount<=0 || amount>remain2 || amount>100) { toast('기부 금액은 1~100, 그리고 오늘 남은 한도 이내로 입력하세요.'); return; }
    const st = readJSON(LS.students, []);
    const me = st.find(s=>s.id===session.studentId);
    if (!me) { toast('학생 정보가 없습니다.'); return; }
    const meL = Number(me.lumen||0);
    if (meL < amount) { toast('루멘이 부족합니다.'); return; }
    if (!confirm(`학급에 ${amount}루멘을 기부할까요? (되돌림 불가)`)) return;
    me.lumen = meL - amount;
    me.updatedAt = Date.now();
    writeJSON(LS.students, st);
    try { syncOneStudentToFirestoreNow(me); } catch(_) {}
    const entry = { id: "don_" + Date.now() + "_" + Math.random().toString(16).slice(2), ts: Date.now(), date: today2, studentId: session.studentId, studentName: String(me.name || ""), amount, memo: "" };
    const next = normalizeThermo({ ...thermoNow, donations: [...(thermoNow.donations || []), entry] });
    writeThermo(next);
    try { await syncThermoToFirestoreNow(next); } catch(_) {}
    const input = $("#studentDonateAmount");
    if(input) input.value = "";
    toast('기부가 완료되었습니다.');
    renderStudentHomeV1();
    try{ renderTeacherHome(); }catch(_){}
  });

  // Quest View triggers (student/teacher shared)
  $("#studentQuestViewBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); openQuestViewModal(); });
  $("#closeQuestViewBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); closeQuestViewModal(); });
  $("#closeQuestDetailBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); closeQuestDetailModal(); });
  $("#questDetailBody")?.addEventListener("click", (e)=>{
    // toggle CLEAR on student card
    const card = e.target.closest(".qd-stud");
    if(card){
      e.preventDefault(); e.stopPropagation();
      const sid = String(card.getAttribute("data-sid")||"");
      const modal = document.getElementById("questDetailModal");
      const qid = modal?.dataset?.qid;
      if(sid && qid){
        const list = readQuests();
        const idx = list.findIndex(x=>String(x.id)===String(qid));
        if(idx>=0){
          const q = list[idx];
          const raw = q?.completedIds || q?.completed || q?.completedStudents || [];
          let arr = Array.isArray(raw) ? raw.map(String) : (raw && typeof raw==="object" ? Object.keys(raw).map(String) : []);
          const set = new Set(arr);
          if(set.has(sid)) set.delete(sid); else set.add(sid);
          q.completedIds = Array.from(set);
          list[idx] = q;
          writeQuests(list);
          // rerender to update summary + labels
          renderQuestDetail(qid);
        }
      }
      return;
    }

    // close button
    const c = e.target.closest("[data-qclose]");
    if(!c) return;
    e.preventDefault(); e.stopPropagation();
    closeQuestDetailModal();
  });

  $("#questViewBody")?.addEventListener("click", (e)=>{
    const btn = e.target.closest("[data-qopen]");
    if(!btn) return;
    e.preventDefault(); e.stopPropagation();
    const qid = btn.getAttribute("data-qopen");
    openQuestDetailModal(qid);
  });
  // Menu buttons: 실제 data-go 이동은 공통 핸들러에서 처리함. 임시 안내 토스트 제거.
  $("#closePinResetModalBtn")?.addEventListener("click", closePinResetModal);
  $("#savePinResetBtn")?.addEventListener("click", savePinReset);
  $("#pinResetModal")?.addEventListener("click", (e)=>{ if (e.target.id==="pinResetModal") closePinResetModal(); });

  // Morning study (17:00 lock)
  $("#studentMorningDoneBtn")?.addEventListener("click", ()=> setMorning(true));
  $("#studentMorningCancelBtn")?.addEventListener("click", ()=> setMorning(false));

  // Reading autosave (debounce)
  const debouncedSaveReading = debounce(saveReadingDraft, 400);
  ["studentReadTitle","studentReadStart","studentReadEnd"].forEach(id=>{
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", ()=> debouncedSaveReading());
  });

  // Reading commit
  $("#btnStudentReadAdd")?.addEventListener("click", ()=> commitReadingEntry());
  $("#btnStudentReadEdit")?.addEventListener("click", ()=> { applyReadingSelection(); });


  // Reading: 1줄 미리보기 토글 + 드롭다운 변경 시 미리보기 갱신
  $("#studentReadingPreview")?.addEventListener('click', ()=>{
    const panel = $("#studentReadingPanel");
    if (!panel) return;
    panel.classList.toggle('collapsed');
    renderStudentActivity();
  });
  $("#studentReadingSelect")?.addEventListener('change', ()=> { applyReadingSelection(); renderStudentActivity(); });

  // Bank handlers are wired in wireStudentBankButtons().

  // Activity history modal
  $("#closeActivityHistoryBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); closeActivityHistory(); });
  $("#activityHistoryModal")?.addEventListener("click", (e)=>{
    if(e.target && e.target.id==="activityHistoryModal") closeActivityHistory();
    else e.stopPropagation();
  });

  // Today reading detail modal (teacher home)
  $("#openTodayReadingDetailBtn")?.addEventListener("click", (e)=>{
    e.preventDefault();
    e.stopPropagation();
    openTodayReadingDetail();
  });
  $("#closeTodayReadingDetailBtn")?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); closeTodayReadingDetail(); });
  $("#todayReadingDetailModal")?.addEventListener("click", (e)=>{
    if(e.target && e.target.id==="todayReadingDetailModal") closeTodayReadingDetail();
    else e.stopPropagation();
  });




  /* === Teacher Home: Menu dropdown (8 slots) + Admin Modal === */
  const menuBtn = $("#menuManageBtn");
  const menuDropdown = $("#menuDropdown");
  const adminModal = $("#adminModal");
  const adminTitle = $("#adminModalTitle");
  const adminBody = $("#adminModalBody");

  const hideMenu = () => { if(menuDropdown) menuDropdown.classList.add("hidden"); };
  const positionMenu = () => {
    if (!menuBtn || !menuDropdown) return;
    const r = menuBtn.getBoundingClientRect();
    const gap = 10;
    // fixed positioning relative to viewport
    menuDropdown.style.position = "fixed";
    menuDropdown.style.top = `${Math.round(r.bottom + gap)}px`;
    menuDropdown.style.left = "";
    menuDropdown.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  };
  const toggleMenu = () => {
    if(!menuDropdown) return;
    const willShow = menuDropdown.classList.contains("hidden");
    if (willShow) positionMenu();
    menuDropdown.classList.toggle("hidden");
  };

  const normalizeConstitutionNumbering = (state) => {
    const st = (state && typeof state === "object") ? state : JSON.parse(JSON.stringify(DEFAULT_CONSTITUTION));
    st.version = DEFAULT_CONSTITUTION.version;
    if(!Array.isArray(st.categories)) st.categories = [];
    st.categories.forEach(cat => {
      if(!Array.isArray(cat.items)) cat.items = [];
      cat.items.forEach((item, idx) => {
        if(!item || typeof item !== "object") return;
        const n = idx + 1;
        item.num = n;
        item.label = `제${n}조`;
      });
    });
    return st;
  };

  const getConstitutionState = () => {
    try{
      const raw = localStorage.getItem(LS_KEYS.constitution);
      if(raw){
        const parsed = JSON.parse(raw);
        if(parsed && parsed.version===DEFAULT_CONSTITUTION.version) return normalizeConstitutionNumbering(parsed);
        // version mismatch -> fall through to default
      }
    }catch(_){}
    return normalizeConstitutionNumbering(JSON.parse(JSON.stringify(DEFAULT_CONSTITUTION)));
  };

  const saveConstitutionState = (state) => {
    localStorage.setItem(LS_KEYS.constitution, JSON.stringify(normalizeConstitutionNumbering(state)));
    try { scheduleConstitutionFirestoreSync(); } catch(_) {}
  };

  const renderConstitutionAdmin = (root) => {
    if(!root) return;
    let state = getConstitutionState();
    let selectedCatId = state.categories?.[0]?.id || null;
    let editingId = null;

    // autosave (debounced)
    let saveT = null;
    let dirty = false;
    const markDirty = () => {
      dirty = true;
      if(saveT) clearTimeout(saveT);
      saveT = setTimeout(()=>{ commitSave(false); }, 600);
    };
    const commitSave = (flash=true) => {
      try{ saveConstitutionState(state); dirty = false; }catch(_){}
      if(!flash) return;
      const b = root.querySelector('[data-const-status]');
      if(!b) return;
      b.textContent = "저장됨";
      setTimeout(()=>{ b.textContent = ""; }, 900);
    };

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if(cls) n.className = cls;
      if(text!=null) n.textContent = text;
      return n;
    };

    const render = () => {
      root.innerHTML = "";
      const wrap = el("div","admin-layout");
      const sidebar = el("div","admin-sidebar");
      const content = el("div","admin-content");

      // Sidebar header
      sidebar.appendChild(el("div","admin-side-title","조항 그룹"));

      // Categories
      const catList = el("div","admin-cat-list");
      state.categories.forEach(cat=>{
        const btn = el("button","admin-cat-btn"+(cat.id===selectedCatId?" active":""));
        btn.type="button";
        btn.textContent = cat.name;
        btn.addEventListener("click", ()=>{
          selectedCatId = cat.id;
          editingId = null;
          render();
        });
        catList.appendChild(btn);
      });
      sidebar.appendChild(catList);

      // Content header + toolbar
      const selCat = state.categories.find(c=>c.id===selectedCatId) || state.categories[0];
      const top = el("div","admin-content-top");
      top.appendChild(el("div","admin-content-title", selCat?.name || "조항"));

      const toolbar = el("div","admin-toolbar");
      const addBtn = el("button","admin-btn");
      addBtn.type="button";
      addBtn.textContent="조항 추가";
      addBtn.addEventListener("click", ()=>{
        if(!selCat) return;
        const newNum = (Array.isArray(selCat.items) ? selCat.items.length : 0) + 1;
        const newItem = {
          id: "art_"+Date.now(),
          num: newNum,
          label: `제${newNum}조`,
          title: "새 조항",
          desc: "",
          lumen: 0,
          xp: 0,
          active: true,
        };
        selCat.items.push(newItem);
        markDirty();
        editingId = newItem.id;
        render();
      });

      const saveBtn = el("button","admin-btn primary","저장");
      saveBtn.type="button";
      saveBtn.addEventListener("click", ()=>{
        commitSave();
      });

      const resetBtn = el("button","admin-btn ghost","초기화");
      resetBtn.type="button";
      resetBtn.addEventListener("click", ()=>{
        localStorage.removeItem(LS_KEYS.constitution);
        state = getConstitutionState();
        saveConstitutionState(state);
        selectedCatId = state.categories?.[0]?.id || null;
        editingId = null;
        render();
      });

      // Export / Import (JSON)
      const exportBtn = el("button","admin-btn ghost","내보내기");
      exportBtn.type="button";
      exportBtn.addEventListener("click", ()=>{
        commitSave(false);
        const blob = new Blob([JSON.stringify(state, null, 2)], {type:"application/json"});
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "sebit_constitution.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(()=>{ try{ URL.revokeObjectURL(a.href); }catch(_){} }, 2000);
      });

      const importBtn = el("button","admin-btn ghost","가져오기");
      importBtn.type="button";
      const fileIn = el("input","admin-file-hidden");
      fileIn.type="file";
      fileIn.accept="application/json,.json";
      fileIn.style.display="none";
      importBtn.addEventListener("click", ()=> fileIn.click());
      fileIn.addEventListener("change", async ()=>{
        const f = fileIn.files?.[0];
        fileIn.value = "";
        if(!f) return;
        try{
          const text = await f.text();
          const parsed = JSON.parse(text);
          if(!parsed || !parsed.version || !Array.isArray(parsed.categories)) throw new Error("bad");
          state = normalizeConstitutionNumbering(parsed);
          saveConstitutionState(state);
          selectedCatId = state.categories?.[0]?.id || null;
          editingId = null;
          render();
          commitSave();
        }catch(_){
          alert("가져오기 실패: JSON 형식 확인 필요");
        }
      });

      const status = el("span","admin-status","");
      status.setAttribute("data-const-status","1");

      toolbar.append(addBtn, saveBtn, resetBtn, exportBtn, importBtn, fileIn, status);
      top.appendChild(toolbar);
      content.appendChild(top);

      // List
      const list = el("div","admin-rule-list");
      (selCat?.items || []).forEach((item, idx)=>{
        item.num = idx + 1;
        item.label = `제${idx + 1}조`;
        const row = el("div","admin-rule-row"+(item.active?"":" is-off"));
        const left = el("div","admin-rule-main");
        const h = el("div","admin-rule-head");
        h.appendChild(el("div","admin-rule-label", item.label));
        h.appendChild(el("div","admin-rule-title", item.title));
        left.appendChild(h);
        if(item.desc){
          left.appendChild(el("div","admin-rule-desc", item.desc));
        }

        const right = el("div","admin-rule-actions");
        right.appendChild(el("div","admin-penalty", `-${Number(item.lumen)||0} 루멘 · -${Number(item.xp)||0} XP`));

        const editBtn = el("button","admin-mini-btn", editingId===item.id?"닫기":"수정");
        editBtn.type="button";
        editBtn.addEventListener("click", ()=>{
          editingId = (editingId===item.id) ? null : item.id;
          render();
        });

        const toggleBtn = el("button","admin-mini-btn ghost", item.active?"사용 안 함":"사용");
        toggleBtn.type="button";
        toggleBtn.addEventListener("click", ()=>{
          item.active = !item.active;
          markDirty();
          render();
        });

        right.append(editBtn, toggleBtn);
        row.append(left, right);

        // editor
        if(editingId===item.id){
          const ed = el("div","admin-editor");
          const grid = el("div","admin-form-grid");

          const mkField = (label, inputEl) => {
            const w = el("div","admin-field");
            w.appendChild(el("div","admin-field-label", label));
            w.appendChild(inputEl);
            return w;
          };

          const titleIn = el("input","admin-input");
          titleIn.value = item.title || "";
          titleIn.addEventListener("input", ()=>{ item.title = titleIn.value; markDirty(); });

          const descIn = el("input","admin-input");
          descIn.value = item.desc || "";
          descIn.placeholder = "내용";
          descIn.addEventListener("input", ()=>{ item.desc = descIn.value; markDirty(); });

          const lumenIn = el("input","admin-input");
          lumenIn.type="number"; lumenIn.min="0"; lumenIn.value = Number(item.lumen)||0;
          lumenIn.addEventListener("input", ()=>{ item.lumen = Math.max(0, Number(lumenIn.value)||0); markDirty(); });

          const xpIn = el("input","admin-input");
          xpIn.type="number"; xpIn.min="0"; xpIn.value = Number(item.xp)||0;
          xpIn.addEventListener("input", ()=>{ item.xp = Math.max(0, Number(xpIn.value)||0); markDirty(); });

          grid.append(
            mkField("조항 제목", titleIn),
            mkField("내용", descIn),
            mkField("차감 루멘", lumenIn),
            mkField("차감 XP", xpIn),
          );

          const note = el("div","admin-editor-note","삭제는 비활성(사용 안 함)으로 처리되며 기존 기록은 유지됨.");
          ed.append(grid, note);
          row.appendChild(ed);
        }

        list.appendChild(row);
      });

      // footer hint
      const hint = el("div","admin-hint","※ 저장 시 즉시 연동 Source of Truth (교사용 헌법/법령 편집).");
      content.append(list, hint);

      wrap.append(sidebar, content);
      root.appendChild(wrap);
    };

    render();
  };

  /* === Menu 8: Teacher Settings + Student Roster (Source) === */
  const simpleHash = (s) => {
    s = String(s ?? "");
    let h1 = 5381;
    for (let i=0;i<s.length;i++) h1 = ((h1<<5) + h1) + s.charCodeAt(i);
    return String(h1 >>> 0);
  };

  const readStudents = () => readJSON(LS.students, []);
  const writeStudents = (arr) => writeJSON(LS.students, Array.isArray(arr)?arr:[]);
  const nextStudentId = (students) => {
    const used = new Set((students||[]).map(s=>String(s.id||"")));
    let n = 1;
    while(true){
      const id = "S" + String(n).padStart(2,"0");
      if(!used.has(id)) return id;
      n++;
      if(n>9999) return "S"+Date.now();
    }
  };

  const renderTeacherSettingsAdmin = (root) => {
    if(!root) return;
    let tab = "teacher";
    let students = readStudents();

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if(cls) n.className = cls;
      if(text!=null) n.textContent = text;
      return n;
    };
    const saveStudents = () => {
      writeStudents(students);
      try{ renderTeacherHome(); }catch(_){ }
    };
    const downloadJSON = (filename, obj) => {
      const blob = new Blob([JSON.stringify(obj, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 500);
    };

    const render = () => {
      root.innerHTML = "";
      const wrap = el("div","admin-layout");
      const sidebar = el("div","admin-sidebar");
      const content = el("div","admin-content");

      sidebar.appendChild(el("div","admin-side-title","메뉴 8"));
      const tabs = el("div","admin-cat-list");
      const t1 = el("button","admin-cat-btn"+(tab==="teacher"?" active":""),"교사 기본 설정");
      t1.type="button";
      t1.addEventListener("click",()=>{ tab="teacher"; render(); });
      const t2 = el("button","admin-cat-btn"+(tab==="roster"?" active":""),"학생 명단 관리");
      t2.type="button";
      t2.addEventListener("click",()=>{ tab="roster"; render(); });
      tabs.append(t1,t2);
      sidebar.appendChild(tabs);

      if(tab==="teacher"){
        const top = el("div","admin-content-top");
        top.appendChild(el("div","admin-content-title","교사 기본 설정"));
        content.appendChild(top);
        const box = el("div","admin-list");

        const mcSet = el("div","admin-editor");
        mcSet.appendChild(el("div","admin-editor-note","마스터 코드는 분실 시 복구 불가. 오프라인 보관."));
        const hasMC = !!(localStorage.getItem(LS.masterCodeHash) || __sebitTeacherAuthCache?.masterCodeHash);
        if(!hasMC){
          const row = el("div","admin-form-grid");
          const inp = el("input","admin-input");
          inp.placeholder = "마스터 코드 설정";
          const btn = el("button","admin-btn");
          btn.type="button"; btn.textContent = "설정";
          btn.addEventListener("click", async ()=>{
            const v = (inp.value||"").trim();
            if(!v) return;
            const h = sebitSimpleHash(v);
            localStorage.setItem(LS.masterCodeHash, h);
            try{ await saveTeacherAuthToFirestore({ masterCodeHash:h }); }catch(e){ console.error("[SEBIT] master code save failed", e); }
            inp.value = "";
            render();
          });
          row.append(inp, btn);
          mcSet.appendChild(row);
        } else {
          mcSet.appendChild(el("div","admin-hint","마스터 코드: 설정 완료"));
        }

        const pwBox = el("div","admin-editor");
        pwBox.appendChild(el("div","admin-editor-note","교사용 로그인 비밀번호(영어+숫자)"));
        const g = el("div","admin-form-grid");
        const cur = el("input","admin-input");
        cur.type="password"; cur.placeholder="현재 비밀번호";
        const nw = el("input","admin-input");
        nw.type="password"; nw.placeholder="새 비밀번호";
        const save = el("button","admin-btn");
        save.type="button"; save.textContent="변경";
        const msg = el("div","admin-hint","");
        save.addEventListener("click", async ()=>{
          msg.textContent = "";
          const curPw = (cur.value||"").trim();
          const newPw = (nw.value||"").trim();
          const ok = await checkTeacherPassword(curPw);
          if(!ok) { msg.textContent = "현재 비밀번호가 다름"; return; }
          if(!validateTeacherPw(newPw)) { msg.textContent = "영어+숫자 필요"; return; }
          try{
            await saveTeacherAuthToFirestore({ password:newPw });
            cur.value=""; nw.value="";
            msg.textContent = "변경됨(클라우드 저장 완료 · 모든 기기 적용)";
          }catch(e){
            console.error("[SEBIT] teacher password save failed", e);
            msg.textContent = "서버 저장 실패";
          }
        });
        g.append(cur, nw, save);
        pwBox.append(g, msg);

        const resetBox = el("div","admin-editor");
        resetBox.appendChild(el("div","admin-editor-note","비밀번호 분실: 마스터 코드로 재설정"));
        const rg = el("div","admin-form-grid");
        const mc = el("input","admin-input");
        mc.type="password"; mc.placeholder="마스터 코드";
        const npw = el("input","admin-input");
        npw.type="password"; npw.placeholder="새 비밀번호";
        const rbtn = el("button","admin-btn");
        rbtn.type="button"; rbtn.textContent="재설정";
        const rmsg = el("div","admin-hint","");
        rbtn.addEventListener("click", async ()=>{
          rmsg.textContent = "";
          const code = (mc.value||"").trim();
          const newPw = (npw.value||"").trim();
          const auth = await loadTeacherAuthFromFirestore();
          const h = String(auth?.masterCodeHash || localStorage.getItem(LS.masterCodeHash) || "");
          if(!h) { rmsg.textContent = "마스터 코드 미설정"; return; }
          if(sebitSimpleHash(code) !== h) { rmsg.textContent = "마스터 코드 불일치"; return; }
          if(!validateTeacherPw(newPw)) { rmsg.textContent = "영어+숫자 필요"; return; }
          try{
            await saveTeacherAuthToFirestore({ password:newPw, masterCodeHash:h });
            mc.value=""; npw.value="";
            rmsg.textContent = "재설정됨(클라우드 저장 완료 · 모든 기기 적용)";
          }catch(e){
            console.error("[SEBIT] teacher password reset failed", e);
            rmsg.textContent = "서버 저장 실패";
          }
        });
        rg.append(mc, npw, rbtn);
        resetBox.append(rg, rmsg);

        const bk = el("div","admin-editor");
        bk.appendChild(el("div","admin-editor-note","학생 명단 백업/복원(JSON)"));
        const bkRow = el("div","admin-toolbar");
        const out = el("button","admin-btn"); out.type="button"; out.textContent="내보내기";
        out.addEventListener("click",()=> downloadJSON("sebit_students.json", { students: readStudents() }));
        const file = el("input","admin-input");
        file.type="file"; file.accept="application/json";
        file.classList.add("admin-file");
        file.addEventListener("change", async ()=>{
          const f = file.files?.[0];
          if(!f) return;
          try{
            const text = await f.text();
            const obj = JSON.parse(text);
            if(obj && Array.isArray(obj.students)){
              students = obj.students;
              saveStudents();
              render();
            }
          }catch(_){ }
          file.value = "";
        });
        bkRow.append(out, file);
        bk.appendChild(bkRow);

        box.append(mcSet, pwBox, resetBox, bk);
        content.appendChild(box);
      }

      if(tab==="roster"){
        const top = el("div","admin-content-top");
        top.appendChild(el("div","admin-content-title","학생 명단 관리"));
        const toolbar = el("div","admin-toolbar");
        const addBtn = el("button","admin-btn");
        addBtn.type="button"; addBtn.textContent = "전입 추가";
        addBtn.addEventListener("click",()=>{
          const id = nextStudentId(students);
          students.push({ id, name:"", gender:"미지정", pin: DEFAULT_PIN, lumens:0, xp:0, active:true, character:"" });
          saveStudents();
          render();
        });
        toolbar.appendChild(addBtn);
        top.appendChild(toolbar);
        content.appendChild(top);

        const list = el("div","admin-list");
        list.style.maxHeight = "60vh";
        list.style.overflowY = "auto";
        list.style.paddingRight = "6px";
        students.forEach((s)=>{
          const row = el("div","admin-row");
          const left = el("div","admin-row-left");
          const right = el("div","admin-row-right");
          const title = el("div","admin-row-title", `${s.id || ""} · ${s.name || "(이름 없음)"}`);
          const meta = el("div","admin-row-meta", `PIN: ${s.pin || DEFAULT_PIN} · 성별: ${s.gender || "미지정"}`);
          left.append(title, meta);

          const editBtn = el("button","admin-btn");
          editBtn.type="button"; editBtn.textContent = "수정";
          editBtn.addEventListener("click",()=>{
            const ed = row.querySelector(".admin-editor");
            if(ed) ed.classList.toggle("hidden");
          });
          const toggleBtn = el("button","admin-btn outline");
          toggleBtn.type="button";
          toggleBtn.textContent = s.active===false ? "사용" : "전출";
          toggleBtn.addEventListener("click",()=>{
            s.active = !(s.active===false);
            saveStudents();
            render();
          });
          const deleteBtn = el("button","admin-btn");
          deleteBtn.type = "button";
          deleteBtn.textContent = "삭제";
          deleteBtn.addEventListener("click",()=>{
            const label = `${s.id || ""}${s.name ? " · " + s.name : ""}`;
            if(!confirm(`정말 삭제할까요?\n${label}\n삭제 후에는 복구되지 않습니다.`)) return;
            students = students.filter(x => String(x.id) !== String(s.id));
            saveStudents();
            render();
          });
          right.append(editBtn, toggleBtn, deleteBtn);
          row.append(left, right);

          const ed = el("div","admin-editor hidden");
          const grid = el("div","admin-form-grid");
          const nameIn = el("input","admin-input");
          nameIn.placeholder = "이름";
          nameIn.value = s.name || "";
          nameIn.addEventListener("input",()=>{
            s.name = nameIn.value;
            saveStudents();
            title.textContent = `${s.id || ""} · ${s.name || "(이름 없음)"}`;
          });
          const genderSel = el("select","admin-input");
          ["미지정","남","여"].forEach(v=>{
            const o = document.createElement("option");
            o.value=v; o.textContent=v;
            if((s.gender||"미지정")===v) o.selected=true;
            genderSel.appendChild(o);
          });
          genderSel.addEventListener("change",()=>{
            s.gender = genderSel.value;
            saveStudents();
            meta.textContent = `PIN: ${s.pin || DEFAULT_PIN} · 성별: ${s.gender || "미지정"}`;
          });
          const pinReset = el("button","admin-btn");
          pinReset.type="button"; pinReset.textContent="PIN 초기화";
          pinReset.addEventListener("click",()=>{
            s.pin = DEFAULT_PIN;
            saveStudents();
            meta.textContent = `PIN: ${s.pin || DEFAULT_PIN} · 성별: ${s.gender || "미지정"}`;
          });
          grid.append(nameIn, genderSel, pinReset);
          ed.appendChild(grid);
          row.appendChild(ed);

          list.appendChild(row);
        });
        content.appendChild(list);
        content.appendChild(el("div","admin-hint","※ 학생은 본인 페이지에서 PIN 변경 가능 / 교사는 여기서 초기화 가능"));
      }

      wrap.append(sidebar, content);
      root.appendChild(wrap);
    };
    render();
  };

  /* === Admin: Jobs (Menu 3) === */
  const JOB_KEYS = {
    config: "sebit:jobsConfig_v1",
    assign: "sebit:jobsAssign_v1",
    session: "sebit:jobsSession_v1",
    nonregular: "sebit:jobsNonregular_v1",   // [{id,name,lumen,xp,active}]
    parttime: "sebit:jobsParttime_v1",       // { [YYYY-MM-DD]: [{id,name,lumen,xp,participants:[studentId],paid:boolean}] }
  };

  const FIXED_JOBS = [
    { id:"ranger", name:"교실 레인저" },
    { id:"fairjustice", name:"페어 저스티스" },
    { id:"timekeeper", name:"타임 키퍼" },
    { id:"techkeeper", name:"테크 키퍼" },
    { id:"studycheck", name:"학습 체크단" },
    { id:"tidymaster", name:"정리 마스터" },
    { id:"lightguardian_front", name:"빛의 파수꾼(앞)" },
    { id:"lightguardian_back",  name:"빛의 파수꾼(뒤)" },
    { id:"artcurator", name:"작품 큐레이터" },
    { id:"greensaver", name:"그린 세이버" },   // '세이퍼'→'세이버' 통일
    { id:"docmaster", name:"문서 마스터" },    // '매니저'→'마스터' 통일
    { id:"weathercaster", name:"웨더 캐스터" },
    { id:"lunchsaver", name:"런치 세이버" },
    { id:"lightmerchant", name:"빛의 상인" },  // '상점 운영'→'빛의 상인'
  ];

  const getRoster = () => {
    const st = readJSON(LS.students, []);
    // 안정 정렬: 번호 오름차순
    return [...st].sort((a,b)=> (a.num||0)-(b.num||0));
  };

  const getJobConfig = () => {
    const cfg = readJSON(JOB_KEYS.config, null);
    if (cfg && cfg.version===1) return cfg;
    const defaults = {};
    // 기본 정원(0 허용) — 이후 교사 수정
    FIXED_JOBS.forEach(j=>{
      const dCap = (j.id==="studycheck"||j.id==="tidymaster"||j.id==="lunchsaver") ? 2 : 1;
      defaults[j.id] = { cap: dCap, lumen: 50, xp: 30, active: true };
    });
    return { version:1, fixed: defaults };
  };
  const saveJobConfig = (cfg) => localStorage.setItem(JOB_KEYS.config, JSON.stringify(cfg));

  const getJobAssign = () => {
    const a = readJSON(JOB_KEYS.assign, null);
    if (a && a.version===1) return a;
    return { version:1, jobs:{} };
  };
  const saveJobAssign = (a) => localStorage.setItem(JOB_KEYS.assign, JSON.stringify(a));

  const getJobSession = () => readJSON(JOB_KEYS.session, { startedAt:null, endedAt:null });
  const startSessionIfNeeded = () => {
    const s = getJobSession();
    if (!s.startedAt || s.endedAt){
      const next = { startedAt: Date.now(), endedAt: null };
      localStorage.setItem(JOB_KEYS.session, JSON.stringify(next));
      return next;
    }
    return s;
  };
  const endSession = () => {
    const s = getJobSession();
    const next = { startedAt: s.startedAt || Date.now(), endedAt: Date.now() };
    localStorage.setItem(JOB_KEYS.session, JSON.stringify(next));
    return next;
  };

  const renderJobsAdmin = (root) => {
    if(!root) return;
    const roster = getRoster();
    let cfg = getJobConfig();
    let assign = getJobAssign();
    const s = getJobSession();

    const el = (tag, cls, text) => {
      const n = document.createElement(tag);
      if(cls) n.className = cls;
      if(text!=null) n.textContent = text;
      return n;
    };

    const sectionTitle = (t, sub) => {
      const wrap = el("div","jobs-sec-title");
      wrap.appendChild(el("div","jobs-sec-h", t));
      if(sub) wrap.appendChild(el("div","jobs-sec-sub", sub));
      return wrap;
    };

    const getJobTargetStudentsForChecklist = (jobId) => {
      const rosterNow = getRoster();
      const a = getJobAssign();
      const cur = a.jobs?.[jobId] || { holders: [], targetsByHolder: {} };
      const byId = new Map(rosterNow.map(st => [String(st.id), st]));
      const holderId = session?.studentId ? String(session.studentId) : "";

      // 학생이 자기 직업에서 열면, 그 학생에게 배치된 대상만 우선 표시
      if(holderId && Array.isArray(cur.targetsByHolder?.[holderId]) && cur.targetsByHolder[holderId].length){
        return cur.targetsByHolder[holderId].map(id => byId.get(String(id))).filter(Boolean);
      }

      // 교사용/전체 보기에서는 배치된 모든 대상 학생 표시
      const ids = [];
      Object.values(cur.targetsByHolder || {}).forEach(arr => {
        if(Array.isArray(arr)) arr.forEach(id => { if(!ids.includes(String(id))) ids.push(String(id)); });
      });
      const targets = ids.map(id => byId.get(String(id))).filter(Boolean);

      // 배치 데이터가 없으면 명단 전체를 보여 체크 가능하게 함
      return targets.length ? targets : rosterNow;
    };

    const openJobChecklistHub = () => {
      // 중복 생성 방지
      if (root.querySelector(".jobcheck-hub-overlay")) return;
      const overlay = el("div","jobcheck-hub-overlay");
      const panel = el("div","jobcheck-hub");
      const head = el("div","jobcheck-hub-head");
      head.appendChild(el("div","jobcheck-hub-title","직업 체크리스트 관리(14)"));
      const closeBtn = el("button","btn small","닫기");
      closeBtn.addEventListener("click", ()=> overlay.remove());
      head.appendChild(closeBtn);

      const grid = el("div","jobcheck-hub-grid");
      FIXED_JOBS.forEach(j=>{
        const card = el("div","jobcheck-hub-card");
        card.appendChild(el("div","name", j.name));
        card.appendChild(el("div","sub muted","체크리스트 페이지 연결 예정"));
        const openBtn = el("button","btn small","열기");
        openBtn.addEventListener("click", ()=>{
if(j.id==="studycheck"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","학습 체크단 · 준비물 점검"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const body = el("div","jobcheck-view-body");
    const today = todayKey();
    const kBase = "sebit_studycheck_"+today;
    const kClosed = "sebit_studycheck_closed_"+today;
    const kDone = "sebit_jobdone_studycheck_"+today;

    const read = ()=>{ try{ return JSON.parse(localStorage.getItem(kBase) || "{}"); }catch(e){ return {}; } };
    const write = (v)=> localStorage.setItem(kBase, JSON.stringify(v||{}));
    const isClosed = ()=> localStorage.getItem(kClosed)==="1";
    const setClosed = (v)=> localStorage.setItem(kClosed, v ? "1":"0");

    const card = el("div","weather-card");
    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","학습 체크단"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
    card.appendChild(lockBadge);

    const panel = el("div","weather-panel");
    panel.appendChild(el("div","weather-sec-h","급식 점검"));
    // === studycheck_slot_msg_v1 ===
    const slotMsg = el("div","muted","학습 체크단에 배정된 학생이 여기에 표시됩니다.");
    slotMsg.style.margin="6px 0 10px";
    panel.appendChild(slotMsg);
    // === end studycheck_slot_msg_v1 ===

    const tableWrap = el("div","studycheck-table-wrap");
    const table = document.createElement("table");
    table.className = "studycheck-table";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>번호</th><th>이름</th><th>잘 깎은 연필 3자루 (X)</th><th>지우개 1개 (X)</th><th>기타 메모</th></tr>";
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);

    const renderRows = ()=>{
      const data = read();
      const targets = getJobTargetStudentsForChecklist("studycheck");
      tbody.innerHTML = "";
      if(slotMsg) slotMsg.textContent = targets.length ? `점검 대상 ${targets.length}명이 불러와졌습니다.` : "표시할 학생 명단이 없습니다.";
      targets.forEach((stu, i)=>{
        const tr = document.createElement("tr");
        const idxTd = document.createElement("td"); idxTd.textContent = String(i+1);
        const nameTd = document.createElement("td"); nameTd.textContent = stu.name || "";
        const key = String(stu.id || stu.name || i);
        const st = data[key] || {};

        const cbP = document.createElement("input"); cbP.type="checkbox"; cbP.checked=!!st.pencil;
        const cbE = document.createElement("input"); cbE.type="checkbox"; cbE.checked=!!st.eraser;
        const memo = document.createElement("input"); memo.type="text"; memo.placeholder="기타(선택)"; memo.value = st.memo || "";

        const tdP = document.createElement("td"); tdP.appendChild(cbP);
        const tdE = document.createElement("td"); tdE.appendChild(cbE);
        const tdM = document.createElement("td"); tdM.appendChild(memo);

        const sync = ()=>{
          if(isClosed()) return;
          const next = read();
          const cur = next[key] || {};
          cur.studentId = key;
          cur.studentName = stu.name || "";
          cur.pencil = cbP.checked;
          cur.eraser = cbE.checked;
          cur.memo = memo.value || "";
          next[key] = cur;
          write(next);
        };
        cbP.addEventListener("change", sync);
        cbE.addEventListener("change", sync);
        memo.addEventListener("input", sync);

        tr.append(idxTd, nameTd, tdP, tdE, tdM);
        tbody.appendChild(tr);
      });
    };

    renderRows();

    const note = el("div","muted","* 문제 없었다면 체크하지 않아도 됩니다.");
    note.style.marginTop="10px";
    panel.appendChild(note);

    const btnRow = el("div","weather-btnrow");
    const btnClose = el("button","btn primary","기록 마감");
    const btnOpen = el("button","btn","마감 해제");
    btnRow.appendChild(btnClose);
    btnRow.appendChild(btnOpen);
    panel.appendChild(btnRow);

    card.appendChild(panel);

    const syncUI = ()=>{
      const closed = isClosed();
      lockBadge.classList.toggle("hidden", !closed);
      btnClose.disabled = closed;
      btnOpen.disabled = !closed;
      renderRows();
    };

    btnClose.addEventListener("click", ()=>{
      setClosed(true);
      localStorage.setItem(kDone,"1");
      syncUI();
    });
    btnOpen.addEventListener("click", ()=>{
      setClosed(false);
      localStorage.removeItem(kDone);
      syncUI();
    });

    syncUI();
    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);
    return;
  }

  

if(j.id==="tidymaster"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","정리 마스터 · 정리 점검"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const body = el("div","jobcheck-view-body");
    const today = todayKey();
    const kBase = "sebit_tidymaster_"+today;
    const kClosed = "sebit_tidymaster_closed_"+today;
    const kDone = "sebit_jobdone_tidymaster_"+today;

    const read = ()=>{ try{ return JSON.parse(localStorage.getItem(kBase) || "{}"); }catch(e){ return {}; } };
    const write = (v)=> localStorage.setItem(kBase, JSON.stringify(v||{}));
    const isClosed = ()=> localStorage.getItem(kClosed)==="1";
    const setClosed = (v)=> localStorage.setItem(kClosed, v ? "1":"0");

    // 배정 대상: targetsByHolder 우선, 없으면 roster(표시만)
    const getTargets = ()=> getJobTargetStudentsForChecklist("tidymaster");

    const card = el("div","weather-card");
    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","정리 마스터"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
    card.appendChild(lockBadge);

    const panel = el("div","weather-panel");
    panel.appendChild(el("div","weather-sec-h","정리 점검"));
    const slotInfo = el("div","slot-info","배정된 학생이 여기에 표시됩니다.");
    slotInfo.style.margin="10px 0 14px";
    slotInfo.style.textAlign="center";
    slotInfo.style.fontWeight="700";
    slotInfo.style.color="rgba(0,0,0,.55)";
    panel.appendChild(slotInfo);

    const tableWrap = el("div","studycheck-table-wrap");
    const table = document.createElement("table");
    table.className = "studycheck-table";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>번호</th><th>이름</th><th>사물함 정리 안 됨</th><th>서랍 정리 안 됨</th><th>기타 메모</th></tr>";
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);

    const renderRows = ()=>{
      const data = read();
      const targets = getTargets();
      tbody.innerHTML = "";
      if(slotInfo) slotInfo.textContent = targets.length ? `점검 대상 ${targets.length}명이 불러와졌습니다.` : "표시할 학생 명단이 없습니다.";
      targets.forEach((stu, i)=>{
        const tr = document.createElement("tr");
        const idxTd = document.createElement("td"); idxTd.textContent = String(i+1);
        const nameTd = document.createElement("td"); nameTd.textContent = stu.name || stu;

        const key = stu.id || stu.name || String(i);
        const st = data[key] || {};

        const cbL = document.createElement("input"); cbL.type="checkbox"; cbL.checked=!!st.locker;
        const cbD = document.createElement("input"); cbD.type="checkbox"; cbD.checked=!!st.drawer;
        const memo = document.createElement("input"); memo.type="text"; memo.placeholder="기타(선택)"; memo.value = st.memo || "";

        const tdL = document.createElement("td"); tdL.appendChild(cbL);
        const tdD = document.createElement("td"); tdD.appendChild(cbD);
        const tdM = document.createElement("td"); tdM.appendChild(memo);

        const sync = ()=>{
          const next = read();
          const cur = next[key] || {};
          cur.locker = cbL.checked;
          cur.drawer = cbD.checked;
          cur.memo = memo.value || "";
          next[key] = cur;
          write(next);
        };
        cbL.addEventListener("change", sync);
        cbD.addEventListener("change", sync);
        memo.addEventListener("input", sync);

        tr.appendChild(idxTd);
        tr.appendChild(nameTd);
        tr.appendChild(tdL);
        tr.appendChild(tdD);
        tr.appendChild(tdM);
        tbody.appendChild(tr);
      });
    };

    const actions = el("div","weather-btnrow");
    const btnClose = el("button","btn","기록 마감");
    const btnOpen  = el("button","btn ghost","마감 해제");
    actions.appendChild(btnClose);
    actions.appendChild(btnOpen);

    const applyClosed = ()=>{
      const closed = isClosed();
      lockBadge.classList.toggle("hidden", !closed);
      // 입력 비활성
      tbody.querySelectorAll("input").forEach(inp=> inp.disabled = closed);
      btnClose.disabled = closed;
      btnOpen.disabled = !closed;
    };

    btnClose.addEventListener("click", ()=>{
      setClosed(true);
      localStorage.setItem(kDone,"1");
      applyClosed();
    });
    btnOpen.addEventListener("click", ()=>{
      setClosed(false);
      localStorage.removeItem(kDone);
      applyClosed();
    });

    panel.appendChild(actions);
    card.appendChild(panel);
    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    document.body.appendChild(ov);

    renderRows();
    applyClosed();
    return;
}
if(j.id==="artcurator"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","작품 큐레이터 · 작품 전시 점검"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const body = el("div","jobcheck-view-body");
    const today = todayKey();
    const kBase   = "sebit_artcurator_"+today;
    const kClosed = "sebit_artcurator_closed_"+today;
    const kDone   = "sebit_jobdone_artcurator_"+today;
    const kPraise = "sebit_artcurator_praise_"+today;

    const read = ()=>{ try{ return JSON.parse(localStorage.getItem(kBase) || "{}"); }catch(e){ return {}; } };
    const write = (v)=> localStorage.setItem(kBase, JSON.stringify(v||{}));
    const isClosed = ()=> localStorage.getItem(kClosed)==="1";
    const setClosed = (v)=> localStorage.setItem(kClosed, v ? "1":"0");
    const isPraiseDone = ()=> localStorage.getItem(kPraise)==="1";
    const setPraiseDone = (v)=> localStorage.setItem(kPraise, v ? "1":"0");

    const showPraisePopup = ()=>{
      let modal = document.getElementById("artcuratorPraiseModal");
      if(!modal){
        modal = document.createElement("div");
        modal.id = "artcuratorPraiseModal";
        modal.className = "sebit-modal-backdrop";
        modal.innerHTML = `
          <div class="sebit-modal" role="dialog" aria-modal="true">
            <div class="sebit-modal-header">
              <div class="sebit-modal-title">칭찬</div>
              <button class="btn small" id="artcuratorPraiseClose" type="button">닫기</button>
            </div>
            <div class="sebit-modal-body" id="artcuratorPraiseBody"></div>
            <div class="sebit-modal-footer" style="display:flex; justify-content:flex-end;">
              <button class="btn" id="artcuratorPraiseOk" type="button">확인</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener("click", (e)=>{ if(e.target===modal) modal.style.display="none"; });
        modal.querySelector("#artcuratorPraiseClose")?.addEventListener("click", ()=> modal.style.display="none");
        modal.querySelector("#artcuratorPraiseOk")?.addEventListener("click", ()=> modal.style.display="none");
      }
      const b = modal.querySelector("#artcuratorPraiseBody");
      if(b) b.textContent = "작품이 더 빛나게 전시되었어요! 큐레이터의 손길 덕분이에요.";
      modal.style.display = "flex";
    };

    const card = el("div","weather-card");
    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","작품 큐레이터"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
    card.appendChild(lockBadge);

    const panel = el("div","weather-panel");
    panel.appendChild(el("div","weather-sec-h","오늘의 점검"));

    const fixedNote = el("div","muted","학생은 오늘 기록만 남길 수 있어요.");
    fixedNote.style.marginTop = "6px";
    panel.appendChild(fixedNote);

    const st = read();
    const q1Pos = el("input"); q1Pos.type="checkbox"; q1Pos.checked = !!st.q1_pos;
    const q1Clean = el("input"); q1Clean.type="checkbox"; q1Clean.checked = !!st.q1_clean;
    const q2 = el("input"); q2.type="checkbox"; q2.checked = !!st.q2_done;

    const mkLine = (inp, text)=>{
      const line = document.createElement("label");
      line.style.display="flex";
      line.style.alignItems="center";
      line.style.gap="10px";
      line.style.fontWeight="700";
      line.style.color="rgba(0,0,0,.75)";
      line.appendChild(inp);
      const t = document.createElement("span"); t.textContent = text;
      line.appendChild(t);
      return line;
    };

    const sec1 = el("div","studycheck-sec");
    sec1.style.marginTop = "14px";
    sec1.appendChild(el("div","weather-sec-h","질문 1: 전시 상태가 괜찮았나요?"));
    const row1 = el("div","check-row");
    row1.style.display="flex"; row1.style.flexDirection="column"; row1.style.gap="10px"; row1.style.marginTop="10px";
    row1.appendChild(mkLine(q1Pos, "잘 보이는 위치에 전시됨"));
    row1.appendChild(mkLine(q1Clean, "훼손되거나 어지러운 부분 없음"));
    sec1.appendChild(row1);

    const sec2 = el("div","studycheck-sec");
    sec2.style.marginTop = "16px";
    sec2.appendChild(el("div","weather-sec-h","질문 2: 전시물을 정리하거나 다시 전시했나요?"));
    const row2 = el("div","check-row");
    row2.style.marginTop="10px";
    row2.appendChild(mkLine(q2, "정리 또는 재전시 완료"));
    sec2.appendChild(row2);

    const sync = ()=>{
      const next = read();
      next.q1_pos = !!q1Pos.checked;
      next.q1_clean = !!q1Clean.checked;
      next.q2_done = !!q2.checked;
      write(next);
    };

    q1Pos.addEventListener("change", ()=>{ if(isClosed()) return; sync(); });
    q1Clean.addEventListener("change", ()=>{ if(isClosed()) return; sync(); });

    q2.addEventListener("change", ()=>{
      if(isClosed()) return;
      const was = !!read().q2_done;
      sync();
      if(!was && q2.checked && !isPraiseDone()){
        setPraiseDone(true);
        showPraisePopup();
      }
    });

    panel.appendChild(sec1);
    panel.appendChild(sec2);

    const actions = el("div","weather-btnrow");
    const btnClose = el("button","btn","기록 마감");
    const btnOpen  = el("button","btn ghost","마감 해제");
    actions.appendChild(btnClose);
    actions.appendChild(btnOpen);

    const applyClosed = ()=>{
      const closed = isClosed();
      lockBadge.classList.toggle("hidden", !closed);
      q1Pos.disabled = closed;
      q1Clean.disabled = closed;
      q2.disabled = closed;
      btnClose.disabled = closed;
      btnOpen.disabled = !closed;
    };

    btnClose.addEventListener("click", ()=>{
      setClosed(true);
      localStorage.setItem(kDone,"1");
      applyClosed();
    });
    btnOpen.addEventListener("click", ()=>{
      setClosed(false);
      localStorage.removeItem(kDone);
      applyClosed();
    });

    panel.appendChild(actions);
    card.appendChild(panel);
    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    document.body.appendChild(ov);

    applyClosed();
    return;
}
if(j.id==="lunchsaver"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","런치 세이버 · 급식 점검"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const body = el("div","jobcheck-view-body");
    const today = todayKey();
    const kBase = "sebit_lunchsaver_"+today;
    const kClosed = "sebit_lunchsaver_closed_"+today;
    const kDone = "sebit_jobdone_lunchsaver_"+today;

    const read = ()=>{ try{ return JSON.parse(localStorage.getItem(kBase) || "{}"); }catch(e){ return {}; } };
    const write = (v)=> localStorage.setItem(kBase, JSON.stringify(v||{}));
    const isClosed = ()=> localStorage.getItem(kClosed)==="1";
    const setClosed = (v)=> localStorage.setItem(kClosed, v ? "1":"0");

    const getTargets = ()=> getJobTargetStudentsForChecklist("lunchsaver");

    const card = el("div","weather-card");
    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","런치 세이버"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
    card.appendChild(lockBadge);

    const panel = el("div","weather-panel");
    panel.appendChild(el("div","weather-sec-h","급식 점검"));

    const guide = el("div","muted","문제 있는 학생만 체크해 주세요. (문제 없으면 아무 표시도 하지 않습니다)");
    guide.style.margin="8px 0 10px";
    panel.appendChild(guide);

    const slotInfo = el("div","slot-info","런치 세이버에 배정된 학생이 여기에 표시됩니다.");
    slotInfo.style.margin="10px 0 14px";
    slotInfo.style.textAlign="center";
    slotInfo.style.fontWeight="700";
    slotInfo.style.color="rgba(0,0,0,.55)";
    panel.appendChild(slotInfo);

    const tableWrap = el("div","studycheck-table-wrap");
    const table = document.createElement("table");
    table.className = "studycheck-table";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>번호</th><th>학생명</th><th>급식을 많이 남김 (X)</th><th>식판 정리를 바로 하지 않음 (X)</th><th>음식을 흘리고 치우지 않음 (X)</th><th>메모(선택)</th></tr>";
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);

    const renderRows = ()=>{
      const data = read();
      const targets = getTargets();
      tbody.innerHTML = "";
      if(slotInfo) slotInfo.textContent = targets.length ? `점검 대상 ${targets.length}명이 불러와졌습니다.` : "표시할 학생 명단이 없습니다.";
      targets.forEach((stu, i)=>{
        const tr = document.createElement("tr");
        const idxTd = document.createElement("td"); idxTd.textContent = String(i+1);
        const nameTd = document.createElement("td"); nameTd.textContent = stu.name || "";
        const key = String(stu.id || stu.name || i);
        const st = data[key] || {};

        const cbLeft = document.createElement("input"); cbLeft.type="checkbox"; cbLeft.checked=!!st.leftover;
        const cbTray = document.createElement("input"); cbTray.type="checkbox"; cbTray.checked=!!st.tray;
        const cbSpill = document.createElement("input"); cbSpill.type="checkbox"; cbSpill.checked=!!st.spill;
        const memo = document.createElement("input"); memo.type="text"; memo.placeholder="메모"; memo.value = st.memo || "";

        const tdLeft = document.createElement("td"); tdLeft.appendChild(cbLeft);
        const tdTray = document.createElement("td"); tdTray.appendChild(cbTray);
        const tdSpill = document.createElement("td"); tdSpill.appendChild(cbSpill);
        const tdMemo = document.createElement("td"); tdMemo.appendChild(memo);

        const sync = ()=>{
          if(isClosed()) return;
          const next = read();
          const cur = next[key] || {};
          cur.studentId = key;
          cur.studentName = stu.name || "";
          cur.leftover = cbLeft.checked;
          cur.tray = cbTray.checked;
          cur.spill = cbSpill.checked;
          cur.memo = memo.value || "";
          next[key] = cur;
          write(next);
        };
        cbLeft.addEventListener("change", sync);
        cbTray.addEventListener("change", sync);
        cbSpill.addEventListener("change", sync);
        memo.addEventListener("input", sync);

        tr.append(idxTd, nameTd, tdLeft, tdTray, tdSpill, tdMemo);
        tbody.appendChild(tr);
      });
    };

    const btnRow = el("div","weather-btn-row");
    const closeBtn = el("button","btn primary","기록 마감");
    const openBtn2 = el("button","btn","마감 해제");

    const syncLock = ()=>{
      const locked = isClosed();
      lockBadge.classList.toggle("hidden", !locked);
      closeBtn.disabled = locked;
      openBtn2.disabled = !locked;
      tbody.querySelectorAll("input").forEach(inp=> inp.disabled = locked);
    };

    closeBtn.addEventListener("click", ()=>{
      setClosed(true);
      localStorage.setItem(kDone,"1");
      syncLock();
    });
    openBtn2.addEventListener("click", ()=>{
      setClosed(false);
      localStorage.setItem(kDone,"0");
      syncLock();
    });

    btnRow.appendChild(closeBtn);
    btnRow.appendChild(openBtn2);
    panel.appendChild(btnRow);

    card.appendChild(panel);
    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    document.body.appendChild(ov);

    renderRows();
    syncLock();
    return;
}

if(j.id==="timekeeper"){
  // 타임 키퍼(Time Keeper) - 웨더 캐스터 템플릿 기반(처음부터 재작성)
  const ov = el("div","jobcheck-view-overlay");
  const p = el("div","jobcheck-view weather-view");
  const h = el("div","jobcheck-view-head");
  h.appendChild(el("div","jobcheck-view-title","타임 키퍼 · 등교 시각 기록"));
  const x = el("button","btn small","닫기");
  x.addEventListener("click", ()=> ov.remove());
  h.appendChild(x);
  p.appendChild(h);

  const body = el("div","jobcheck-view-body");
  const today = todayKey();
  const kBase = "sebit_timekeeper_"+today;
  const kClosed = "sebit_timekeeper_closed_"+today;
  const kDone = "sebit_jobdone_timekeeper_"+today;

  const read = ()=>{ try{ return JSON.parse(localStorage.getItem(kBase) || "{}"); }catch(e){ return {}; } };
  const write = (v)=> localStorage.setItem(kBase, JSON.stringify(v||{}));
  const isClosed = ()=> localStorage.getItem(kClosed)==="1";
  const setClosed = (v)=> localStorage.setItem(kClosed, v ? "1":"0");

  const lock = isAfter1700();

  // 웨더 캐스터 카드 프레임
  const card = el("div","weather-card");
  const top = el("div","weather-top");
  top.appendChild(el("div","weather-brand","SEBIT Light World"));
  top.appendChild(el("div","weather-title","타임 키퍼"));
  top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
  card.appendChild(top);

  const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
  card.appendChild(lockBadge);

  const panel = el("div","weather-panel");
  panel.appendChild(el("div","weather-sec-h","등교 시각 기록"));

  if(lock){
    panel.appendChild(el("div","ranger-lock-banner","17시 이후 잠김 · 오늘 기록은 내일 다시 진행해요."));
  }

  const tableWrap = el("div","timekeeper-table-wrap");
  const table = document.createElement("table");
  table.className = "timekeeper-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>학생</th><th>8:45 이전</th><th>9:00 이전</th><th>기타</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);

  const allDone = (data)=>{
    const active = roster.filter(s=>s.active!==false);
    return active.every(s=> !!data[s.id]);
  };

  const renderRows = ()=>{
    const data = read();
    tbody.innerHTML = "";
    const active = roster.filter(s=>s.active!==false);

    active.forEach((stu)=>{
      const tr = document.createElement("tr");
      tr.className = "tk-row";
      const sel = data[stu.id] || "";
      if(sel) tr.classList.add("tk-done");

      const nameTd = document.createElement("td");
      nameTd.className = "tk-stu";
      nameTd.textContent = (stu.num!=null ? `${stu.num}. ` : "") + (stu.name||"");
      tr.appendChild(nameTd);

      const makeCell = (opt, label)=>{
        const td = document.createElement("td");
        td.className = "tk-cell";
        const box = document.createElement("div");
        box.className = "tk-box" + (sel===opt ? " checked" : "");
        box.setAttribute("aria-label", label);
        td.appendChild(box);
        td.addEventListener("click", ()=>{
          if(lock || isClosed()) return;
          const cur = read();
          cur[stu.id] = opt; // 단일 선택
          write(cur);
          renderRows();
          renderFoot();
        });
        return td;
      };

      tr.appendChild(makeCell("845","8:45 이전"));
      tr.appendChild(makeCell("900","9:00 이전"));
      tr.appendChild(makeCell("etc","기타"));

      tbody.appendChild(tr);
    });
  };

  const foot = el("div","weather-foot");
  const msg = el("div","weather-msg","⏱️ 오늘 기록을 남겨주세요");
  const tip = el("div","weather-tip","★ 학생은 오늘 기록만 남길 수 있어요.");
  const tip2 = el("div","weather-tip2","★ 1명당 8:45/9:00/기타 중 1개만 선택됩니다.");
  const btnRow = el("div","weather-btnrow");
  const btnClose = el("button","btn","기록 마감");
  const btnOpen = el("button","btn ghost","마감 해제");
  btnRow.appendChild(btnClose);
  btnRow.appendChild(btnOpen);

  foot.appendChild(msg);
  foot.appendChild(tip);
  foot.appendChild(tip2);
  foot.appendChild(btnRow);
  panel.appendChild(foot);

  const renderFoot = ()=>{
    if(lock){
      lockBadge.classList.remove("hidden");
      msg.textContent = "⏱️ 17시 이후 잠김";
      btnClose.disabled = true;
      btnOpen.disabled = true;
      return;
    }
    const data = read();
    if(isClosed()){
      lockBadge.classList.remove("hidden");
      msg.textContent = allDone(data) ? "✅ 오늘 기록 마감됨" : "🔒 마감됨(미완료 있음)";
      btnClose.disabled = true;
      btnOpen.disabled = false;
    }else{
      lockBadge.classList.add("hidden");
      msg.textContent = allDone(data) ? "✅ 오늘 기록 완료(마감 가능)" : "⏱️ 오늘 기록을 남겨주세요";
      btnClose.disabled = !allDone(data);
      btnOpen.disabled = true;
    }
  };

  btnClose.addEventListener("click", ()=>{
    if(lock || isClosed()) return;
    const data = read();
    if(!allDone(data)) return;
    setClosed(true);
    localStorage.setItem(kDone,"1");
    renderRows();
    renderFoot();
  });
  btnOpen.addEventListener("click", ()=>{
    if(lock || !isClosed()) return;
    setClosed(false);
    localStorage.setItem(kDone,"0");
    renderRows();
    renderFoot();
  });

  card.appendChild(panel);
  body.appendChild(card);

  p.appendChild(body);
  ov.appendChild(p);
  document.body.appendChild(ov);

  renderRows();
  renderFoot();
}


  if(j.id==="ranger"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view ranger-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","교실 레인저 · 학급 법령 점검"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const body = el("div","jobcheck-view-body");
    const lock = isAfter1700();
    let lockBanner = null;
    if(lock){
      lockBanner = el("div","ranger-lock-banner","17시 이후 잠김 · 벌점 부과/취소는 내일 0시 전까지만 가능 (이후 취소는 메뉴 2에서)");
    }

    // unified header/card (match other checklists)
    const card = el("div","weather-card");
    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","교실 레인저"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const panel = el("div","weather-panel");
    if(lockBanner) panel.appendChild(lockBanner);

    const logBtn = el("button","btn small","당일 누가기록");
    logBtn.style.margin="0 0 12px auto";
    logBtn.style.display="block";
    panel.appendChild(logBtn);const listWrap = el("div","ranger-law-list");

    const state = getConstitutionState();
    const rangerGroups = (state.categories||[]).map(cat=>({
      name: cat?.name || "조항 그룹",
      items: (cat?.items||[]).filter(it=>it && it.active)
    })).filter(g=>g.items.length>0);

    const today = todayKey();

    const openStudentPick = ({mode, rule})=>{
      // mode: "apply" | "cancel"
      const overlay = el("div","ranger-pick-overlay");
      const modal = el("div","ranger-pick-modal");
      overlay.appendChild(modal);

      modal.appendChild(el("div","ranger-pick-title", mode==="apply" ? "벌점 부과" : "벌점 취소"));
      modal.appendChild(el("div","ranger-pick-sub", `${rule.label} ${rule.title}  ·  -${Number(rule.lumen)||0}루멘 / -${Number(rule.xp)||0}XP`));

      const roster = getRoster().filter(s=>s.active!==false);
      const picks = el("div","ranger-pick-list");

      let candidates = roster;
      if(mode==="cancel"){
        const daily = getPenaltyDailyState();
        const logs = Array.isArray(daily.days?.[today]) ? daily.days[today] : [];
        const active = logs.filter(l=>String(l.ruleId)===String(rule.id) && String(l.status||"applied")==="applied");
        const set = new Set(active.map(a=>String(a.studentId)));
        candidates = roster.filter(s=>set.has(String(s.id)));
      }

      if(candidates.length===0){
        picks.appendChild(el("div","muted small", mode==="apply" ? "학생이 없습니다." : "취소할 기록이 없습니다."));
      } else {
        candidates.forEach(s=>{
          const row = el("label","ranger-pick-row");
          const cb = el("input");
          cb.type="checkbox";
          cb.dataset.sid = s.id;
          row.appendChild(cb);
          row.appendChild(el("div","name", `${s.num||""} ${s.name}`.trim()));
          picks.appendChild(row);
        });
      }

      modal.appendChild(picks);

      const btns = el("div","ranger-pick-actions");
      const cancelBtn = el("button","btn ghost small","닫기");
      cancelBtn.addEventListener("click", ()=> overlay.remove());
      const okBtn = el("button","btn small", mode==="apply" ? "벌점 부과" : "벌점 취소");
      okBtn.disabled = lock || candidates.length===0;
      okBtn.addEventListener("click", ()=>{
        const checked = Array.from(picks.querySelectorAll("input[type=checkbox]:checked")).map(c=>c.dataset.sid);
        if(checked.length===0){ toast("학생을 선택하세요."); return; }

        const msg = mode==="apply"
          ? `선택한 ${checked.length}명에게 벌점을 부과할까요?`
          : `선택한 ${checked.length}명의 벌점을 취소할까요?`;
        if(!confirm(msg)) return;

        if(mode==="apply"){
          const daily = getPenaltyDailyState();
          if(!Array.isArray(daily.days[today])) daily.days[today]=[];
          checked.forEach(sid=>{
            const ok = applyPenaltyToStudent(sid, rule.lumen, rule.xp);
            if(!ok) return;
            daily.days[today].push({
              id: "pen_"+Date.now()+"_"+Math.random().toString(16).slice(2),
              ts: Date.now(),
              date: today,
              ruleId: rule.id,
              ruleTitle: `${rule.label} ${rule.title}`,
              lumen: Math.abs(Number(rule.lumen)||0),
              xp: Math.abs(Number(rule.xp)||0),
              studentId: sid,
              status: "applied"
            });
          });
          savePenaltyDailyState(daily);
          toast("처리되었습니다.");
        } else {
          const daily = getPenaltyDailyState();
          const logs = Array.isArray(daily.days?.[today]) ? daily.days[today] : [];
          checked.forEach(sid=>{
            // cancel only one per sid per rule at a time (latest)
            const idx = [...logs].reverse().findIndex(l=>String(l.ruleId)===String(rule.id) && String(l.studentId)===String(sid) && String(l.status||"applied")==="applied");
            if(idx<0) return;
            const realIdx = logs.length-1-idx;
            const log = logs[realIdx];
            const ok = revertPenaltyToStudent(sid, log.lumen, log.xp);
            if(!ok) return;
            logs[realIdx] = {...log, status:"canceled", canceledTs: Date.now()};
          });
          daily.days[today]=logs;
          savePenaltyDailyState(daily);
          toast("취소되었습니다.");
        }

        overlay.remove();
      });

      btns.append(cancelBtn, okBtn);
      modal.appendChild(btns);

      document.body.appendChild(overlay);
    };

    const openTodayLog = ()=>{
      const overlay = el("div","ranger-log-overlay");
      const modal = el("div","ranger-log-modal");
      overlay.appendChild(modal);
      const head = el("div","ranger-log-head");
      head.appendChild(el("div","ranger-log-title","당일 누가기록"));
      const close = el("button","btn small","닫기");
      close.addEventListener("click", ()=> overlay.remove());
      head.appendChild(close);
      modal.appendChild(head);

      const daily = getPenaltyDailyState();
      const logs = Array.isArray(daily.days?.[today]) ? daily.days[today] : [];
      const roster = getRoster();
      const nameById = Object.fromEntries(roster.map(s=>[s.id, `${s.num||""} ${s.name}`.trim()]));

      const list = el("div","ranger-log-list");
      if(logs.length===0){
        list.appendChild(el("div","muted small","오늘 기록이 없습니다."));
      } else {
        logs.slice().reverse().forEach(l=>{
          const row = el("div","ranger-log-row");
          const who = nameById[l.studentId] || l.studentId;
          const st = l.status==="canceled" ? "취소됨" : "부과";
          const t = new Date(l.ts||0).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
          row.appendChild(el("div","time mono", t));
          row.appendChild(el("div","who", who));
          row.appendChild(el("div","rule", l.ruleTitle));
          row.appendChild(el("div","amt", `-${l.lumen}L / -${l.xp}XP`));
          row.appendChild(el("div","st", st));
          list.appendChild(row);
        });
      }
      modal.appendChild(list);
      document.body.appendChild(overlay);
    };

    logBtn.addEventListener("click", openTodayLog);

    if(rangerGroups.length===0){
      listWrap.appendChild(el("div","muted small","사용 중인 벌점 조항이 없습니다."));
    }

    rangerGroups.forEach((group, groupIdx)=>{
      const groupBox = el("div","ranger-law-group");
      groupBox.style.border = "1px solid rgba(0,0,0,.08)";
      groupBox.style.borderRadius = "16px";
      groupBox.style.margin = "10px 0";
      groupBox.style.overflow = "hidden";
      groupBox.style.background = "rgba(255,255,255,.72)";

      const head = el("button","ranger-law-group-head");
      head.type = "button";
      head.style.width = "100%";
      head.style.display = "flex";
      head.style.alignItems = "center";
      head.style.justifyContent = "space-between";
      head.style.gap = "10px";
      head.style.padding = "14px 16px";
      head.style.border = "0";
      head.style.background = "rgba(255,255,255,.9)";
      head.style.cursor = "pointer";
      head.style.fontWeight = "800";
      head.style.fontSize = "16px";

      const leftTitle = el("div","ranger-law-group-title", group.name);
      leftTitle.style.textAlign = "left";
      const rightInfo = el("div","ranger-law-group-info", `${group.items.length}개 조항  ▾`);
      rightInfo.style.fontSize = "13px";
      rightInfo.style.fontWeight = "700";
      rightInfo.style.color = "#666";
      head.append(leftTitle, rightInfo);

      const detail = el("div","ranger-law-group-detail");
      detail.style.display = groupIdx===0 ? "block" : "none";
      detail.style.padding = "6px 10px 12px";
      if(groupIdx===0) rightInfo.textContent = `${group.items.length}개 조항  ▴`;

      head.addEventListener("click", ()=>{
        const open = detail.style.display !== "none";
        detail.style.display = open ? "none" : "block";
        rightInfo.textContent = `${group.items.length}개 조항  ${open ? "▾" : "▴"}`;
      });

      group.items.forEach((rule, idx)=>{
        const viewRule = {...rule, label:`제${idx+1}조`};
        const row = el("div","ranger-law-row");
        const left = el("div","left");
        left.appendChild(el("div","title", `${viewRule.label} ${viewRule.title}`));
        if(viewRule.desc) left.appendChild(el("div","desc muted small", viewRule.desc));
        const right = el("div","right");
        right.appendChild(el("div","pen", `-${Number(viewRule.lumen)||0}L / -${Number(viewRule.xp)||0}XP`));

        const plus = el("button","btn small", "+");
        const minus = el("button","btn ghost small", "-");
        plus.disabled = lock;
        minus.disabled = lock;
        plus.addEventListener("click", (e)=>{ e.stopPropagation(); openStudentPick({mode:"apply", rule:viewRule}); });
        minus.addEventListener("click", (e)=>{ e.stopPropagation(); openStudentPick({mode:"cancel", rule:viewRule}); });

        right.append(plus, minus);
        row.append(left, right);
        detail.appendChild(row);
      });

      groupBox.append(head, detail);
      listWrap.appendChild(groupBox);
    });

    panel.appendChild(listWrap);

    // 교실 레인저도 다른 직업 체크리스트처럼 학생 개인 마감/해제가 가능하도록 버튼 추가
    const rangerFoot = el("div","weather-foot");
    rangerFoot.appendChild(el("div","weather-msg","교실 레인저 확인을 마쳤으면 기록 마감을 눌러 주세요."));
    const rangerBtnRow = el("div","weather-btnrow");
    const rangerCloseBtn = el("button","btn primary","기록 마감");
    const rangerOpenBtn = el("button","btn","마감 해제");
    rangerBtnRow.append(rangerCloseBtn, rangerOpenBtn);
    rangerFoot.appendChild(rangerBtnRow);
    panel.appendChild(rangerFoot);

    const rangerDoneKey = `sebit_jobdone_ranger_${today}`;
    const renderRangerFoot = ()=>{
      const done = localStorage.getItem(rangerDoneKey)==="1";
      rangerCloseBtn.disabled = !!done;
      rangerOpenBtn.disabled = !done;
    };
    rangerCloseBtn.addEventListener("click", ()=>{
      try{ localStorage.setItem(rangerDoneKey,"1"); }catch(_){}
      renderRangerFoot();
      if(typeof toast === "function") toast("교실 레인저 기록 마감");
    });
    rangerOpenBtn.addEventListener("click", ()=>{
      try{ localStorage.removeItem(rangerDoneKey); }catch(_){}
      renderRangerFoot();
      if(typeof toast === "function") toast("교실 레인저 마감 해제");
    });
    renderRangerFoot();

    card.appendChild(panel);
    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    document.body.appendChild(ov);
    return;
  }
 else if(j.id==="lightmerchant"){

    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","빛의 상인 · 상점 지급 요청"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const body = el("div","jobcheck-view-body");
    const card = el("div","weather-card");

    // Top
    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","빛의 상인"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
    card.appendChild(lockBadge);

    // Panel
    const panel = el("div","weather-panel");

    const sub = el("div","roster-sub");
    sub.appendChild(el("div","weather-sec-h","지급 요청 목록"));
    const cnt = el("div","qcount", "");
    sub.appendChild(cnt);
    panel.appendChild(sub);

    const tableWrap = el("div","lm-tablewrap");
    const table = el("table","lm-table");
    table.innerHTML = `
      <thead>
        <tr><th style="width:64px;">번호</th><th style="width:120px;">학생</th><th>상품</th><th style="width:140px;"></th></tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);

    const note = el("div","weather-note");
    note.textContent = "오늘까지 최대 30건까지 지급 요청이 생성돼요.";
    panel.appendChild(note);

    card.appendChild(panel);

    // Controls
    const ctl = el("div","weather-ctl");
    const btnClose = el("button","btn","기록 마감");
    const btnOpen = el("button","btn","마감 해제");
    ctl.appendChild(btnClose);
    ctl.appendChild(btnOpen);
    card.appendChild(ctl);

    const rerender = ()=>{
      const closed = lmIsClosed();
      cnt.textContent = `오늘 신청 ${Math.min(shopGetTodayCount(),30)}/30`;
      lockBadge.classList.toggle("hidden", !closed);
      card.classList.toggle("locked", !!closed);

      btnClose.disabled = closed;
      btnOpen.disabled = !closed;

      tbody.innerHTML = "";
      const listAll = lmGetTodayList();
      const list = listAll.filter(x=>x && x.status==="pending");
      if(list.length===0){
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="4" class="muted" style="padding:14px; text-align:center;">요청 없음</td>`;
        tbody.appendChild(tr);
        return;
      }

      list.forEach((r, i)=>{
        const tr = document.createElement("tr");
        const btnDisabled = closed ? "disabled" : "";
        tr.innerHTML = `
          <td>${i+1}</td>
          <td>${escapeHTML(r.studentName||"")}</td>
          <td>${escapeHTML(r.productName||"")}</td>
          <td><button class="btn small primary" ${btnDisabled}>지급 확인</button></td>
        `;
        const b = tr.querySelector("button");
        if(b){
          b.addEventListener("click", ()=>{
            if(lmIsClosed()){ toast("마감 상태입니다."); return; }
            if(!confirm("상품을 잘 전달했나요?")) return;
            const all = lmGetTodayList();
            const idx = all.findIndex(x=>x && x.id===r.id);
            if(idx>-1){
              all[idx].status = "done";
              all[idx].doneAt = Date.now();
              lmSetTodayList(all);
              lmPushHistory(all[idx]);

              // 상점관리 구매기록에도 이관(표시용)
              const logsRaw = readJSON(LS.shopPurchaseLog, []);
              const logs = Array.isArray(logsRaw) ? logsRaw : [];
              const done = all[idx];
              removePocketRequestItem(done.studentId, done);
              logs.push({
                ts: new Date().toISOString(),
                studentId: done.studentId,
                studentName: String(done.studentName||""),
                student: String(done.studentName||""),
                productId: done.productId,
                productName: String(done.productName||""),
                product: String(done.productName||""),
                price: Number(done.price||0)
              });
              while(logs.length > 50) logs.shift();
              writeJSON(LS.shopPurchaseLog, logs);
              pushSystemLog(`[빛의 상인] 지급완료: ${String(done.studentName||"")} · ${String(done.productName||"")} · ${new Date().toISOString()}`);
            }
            rerender();
          });
        }
        tbody.appendChild(tr);
      });
    };

    btnClose.addEventListener("click", ()=>{ lmSetClosed(true); rerender(); toast("기록 마감"); });
    btnOpen.addEventListener("click", ()=>{ lmSetClosed(false); rerender(); toast("마감 해제"); });

    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);

    rerender();
    return;
  }



if(j.id==="greensaver"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","그린 세이버 · 교실 환경/분리배출 점검"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const KEY = "sebit:greensaver_v1";
    const today = todayKey();
    const ITEMS = [
      { id:"trash_near_bin", label:"휴지통 주변에<br/>쓰레기방치<br/>치우지 않음" },
      { id:"recycle_not_sorted", label:"분리수거함<br/>정리 안 됨" },
    ];

    const loadState = () => {
      const s = readJSON(KEY, null);
      if(s && s.date===today && s.version===1) return s;
      return { version:1, date: today, closed:false, memo:"", rows:{} };
    };
    const saveState = (s) => { try{ localStorage.setItem(KEY, JSON.stringify(s)); }catch(_){ } };
    let state = loadState();

    const ensureRow = (sid) => {
      if(!state.rows) state.rows = {};
      if(!state.rows[sid]) state.rows[sid] = {};
      return state.rows[sid];
    };

    const body = el("div","jobcheck-view-body");
    const card = el("div","weather-card");

    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","그린 세이버"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
    card.appendChild(lockBadge);

    const panel = el("div","weather-panel");
    panel.appendChild(el("div","weather-sec-h","교실 환경/분리배출 점검"));

    const tableWrap = el("div","greensaver-tablewrap");
    const table = el("table","greensaver-table");
    const thead = el("thead");
    const trh = el("tr");
    trh.appendChild(el("th","col-num","번호"));
    trh.appendChild(el("th","col-name","이름"));
    ITEMS.forEach(it=>{
      const th = el("th","col-item");
      th.innerHTML = it.label;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = el("tbody");
    roster.forEach(st=>{
      const sid = String(st.id ?? st.num ?? st.name ?? "");
      const row = ensureRow(sid);

      const tr = el("tr");
      tr.appendChild(el("td","td-num", String(st.num ?? "")));
      tr.appendChild(el("td","td-name", escapeHTML(st.name ?? "")));

      ITEMS.forEach(it=>{
        const td = el("td","td-check");
        const input = el("input");
        input.type = "checkbox";
        input.checked = !!row[it.id];
        input.addEventListener("change", ()=>{
          if(state.closed) return;
          row[it.id] = !!input.checked;
          saveState(state);
        });
        td.appendChild(input);
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);

    const memoWrap = el("div","greensaver-memo");
    memoWrap.appendChild(el("div","memo-label","기타 메모"));
    const memo = el("textarea","memo-input");
    memo.value = state.memo || "";
    memo.placeholder = "당일 참고용 메모 (공통)";
    memo.addEventListener("input", ()=>{
      if(state.closed) return;
      state.memo = memo.value;
      saveState(state);
    });
    memoWrap.appendChild(memo);
    panel.appendChild(memoWrap);

    const note = el("div","weather-note");
    note.textContent = "★ 문제 없었다면 체크하지 않아도 됩니다.";
    panel.appendChild(note);

    card.appendChild(panel);

    const ctl = el("div","weather-ctl");
    const btnClose = el("button","btn","기록 마감");
    const btnOpen = el("button","btn","마감 해제");
    btnClose.addEventListener("click", ()=>{ state.closed=true; saveState(state); rerender(); toast("기록 마감"); });
    btnOpen.addEventListener("click", ()=>{ state.closed=false; saveState(state); rerender(); toast("마감 해제"); });
    ctl.appendChild(btnClose);
    ctl.appendChild(btnOpen);
    card.appendChild(ctl);

    const rerender = () => {
      const cur = loadState();
      state = cur;

      lockBadge.classList.toggle("hidden", !state.closed);

      // disable/enable all inputs inside table
      table.querySelectorAll("input[type=checkbox]").forEach(cb=>{
        cb.disabled = !!state.closed;
      });
      memo.disabled = !!state.closed;
    };

    // initial
    rerender();

    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);
    return;
  }
if(j.id==="weathercaster"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","웨더 캐스터 · 오늘 미세먼지/내일 날씨 예보"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const WEATHER_KEY = "sebit:weathercaster_v1";
    const today = todayKey();
    const loadState = () => {
      const s = readJSON(WEATHER_KEY, null);
      if(s && s.date===today) return s;
      return { version:1, date: today, dust: null, forecast: {sunny:false, cloudy:false, rain:false, snow:false}, sent:false, closed:false };
    };
    const saveState = (s) => { try{ localStorage.setItem(WEATHER_KEY, JSON.stringify(s)); }catch(_){ } };
    let state = loadState();
    if(typeof state.praised==="undefined") state.praised = false;

    const showGreenPraise = () => {
      const pov = el("div","weather-popup-overlay");
      const box = el("div","weather-popup");
      box.appendChild(el("div","t","오늘의 칭찬")); 
      box.appendChild(el("div","m","그린 세이버의 노력 덕분에 교실이 더욱 맑고 깨끗해졌어요 🌿"));
      const ok = el("button","btn primary","확인");
      ok.addEventListener("click", ()=> pov.remove());
      box.appendChild(ok);
      pov.appendChild(box);
      ov.appendChild(pov);
    };


    const showPraise = () => {
      const pov = el("div","weather-popup-overlay");
      const box = el("div","weather-popup");
      box.appendChild(el("div","t","잘했어요!"));
      box.appendChild(el("div","m","날씨 예보를 잘 전달했어요."));
      const ok = el("button","btn primary","확인");
      ok.addEventListener("click", ()=> pov.remove());
      box.appendChild(ok);
      pov.appendChild(box);
      ov.appendChild(pov);
    };

    const body = el("div","jobcheck-view-body");
    const card = el("div","weather-card");

    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","웨더 캐스터"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
    card.appendChild(lockBadge);

    const panel = el("div","weather-panel");

    // Dust
    panel.appendChild(el("div","weather-sec-h","오늘 미세먼지 확인"));
    const dustRow = el("div","weather-choice-row");

    const mkDust = (key, label) => {
      const lab = el("label","weather-radio");
      const input = el("input");
      input.type="radio";
      input.name="dust";
      input.value=key;
      input.checked = state.dust===key;
      input.addEventListener("change", ()=>{
        state.dust = key;
        saveState(state);
        rerender();
      });
      lab.appendChild(input);
      lab.appendChild(el("span","dot"));
      lab.appendChild(el("span","txt", label));
      return lab;
    };
    dustRow.appendChild(mkDust("good","좋아"));
    dustRow.appendChild(mkDust("normal","보통"));
    const bad = mkDust("bad","나쁨");
    bad.classList.add("bad");
    dustRow.appendChild(bad);
    panel.appendChild(dustRow);

    const badMsg = el("div","weather-badmsg hidden");
    badMsg.innerHTML = `<span class="ico">😷</span><span>마스크 쓰기를 친구들에게 추천해 주세요!</span>`;
    panel.appendChild(badMsg);

    // Forecast
    panel.appendChild(el("div","weather-sec-h","내일 날씨 예보 전달"));
    const fcGrid = el("div","weather-fc-grid");

    const mkFc = (k, label) => {
      const lab = el("label","weather-check");
      const cb = el("input");
      cb.type="checkbox";
      cb.checked = !!state.forecast?.[k];
      cb.addEventListener("change", ()=>{
        state.forecast = state.forecast || {};
        state.forecast[k]=cb.checked;
        saveState(state);
      });
      lab.appendChild(cb);
      lab.appendChild(el("span","box"));
      lab.appendChild(el("span","txt", label));
      return lab;
    };

    fcGrid.appendChild(mkFc("sunny","맑음"));
    fcGrid.appendChild(mkFc("cloudy","흐림"));
    fcGrid.appendChild(mkFc("rain","비"));
    fcGrid.appendChild(mkFc("snow","눈"));
    panel.appendChild(fcGrid);

    // Sent button
    const sentBtn = el("button","weather-sent-btn");
    sentBtn.type="button";
    sentBtn.innerHTML = `<span class="sun">🌤️</span><span>오늘 예보 전달했어요</span>`;
    sentBtn.addEventListener("click", ()=>{
      if(state.closed) return;
      if(state.sent) return;
      state.sent = true;
      saveState(state);
      rerender();
      showPraise();
    });
    panel.appendChild(sentBtn);

    // Notice
    const note = el("div","weather-note");
    note.textContent = "★ 학생은 오늘 기록만 남길 수 있어요.";
    panel.appendChild(note);

    card.appendChild(panel);

    // Teacher controls (always visible in this admin view)
    const ctl = el("div","weather-ctl");
    const btnClose = el("button","btn","기록 마감");
    const btnOpen = el("button","btn","마감 해제");
    btnClose.addEventListener("click", ()=>{ state.closed=true; saveState(state); rerender(); toast("기록 마감"); });
    btnOpen.addEventListener("click", ()=>{ state.closed=false; saveState(state); rerender(); toast("마감 해제"); });
    ctl.appendChild(btnClose);
    ctl.appendChild(btnOpen);
    card.appendChild(ctl);

    const rerender = () => {
      // daily reset (if date changed while open)
      const cur = loadState();
      state = cur;
      // update inputs
      const disabled = !!state.closed;
      lockBadge.classList.toggle("hidden", !disabled);

      // dust checked
      card.querySelectorAll('input[name="dust"]').forEach(r=>{ r.checked = (r.value===state.dust); r.disabled = disabled; });
      // forecast checked
      const fmap = state.forecast || {};
      const fcKeys = {sunny:0,cloudy:1,rain:2,snow:3};
      card.querySelectorAll(".weather-check input[type=checkbox]").forEach((cb,idx)=>{
        const k = Object.keys(fcKeys).find(k=>fcKeys[k]===idx) || null;
        if(k) cb.checked = !!fmap[k];
        cb.disabled = disabled;
      });
      // bad msg
      badMsg.classList.toggle("hidden", state.dust!=="bad");
      // sent btn
      sentBtn.disabled = disabled || !!state.sent;
      sentBtn.classList.toggle("done", !!state.sent);
      sentBtn.querySelector("span:last-child").textContent = state.sent ? "오늘 예보 전달완료" : "오늘 예보 전달했어요";
      // grey out panel
      card.classList.toggle("locked", disabled);
    };

    rerender();
    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);
    return;
  }



if(j.id==="fairjustice"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","페어 저스티스 · 공정한 활동 점검"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const body = el("div","jobcheck-view-body");

    let today = todayKey();
    const kBase = ()=> "sebit_fairjustice_"+today;
    const kClosed = ()=> "sebit_fairjustice_closed_"+today;

    const read = ()=>{ try{ return JSON.parse(localStorage.getItem(kBase()) || "{}"); }catch(e){ return {}; } };
    const write = (v)=>{ try{ localStorage.setItem(kBase(), JSON.stringify(v||{})); }catch(e){} };
    const isClosed = ()=> localStorage.getItem(kClosed())==="1";
    const setClosed = (v)=> localStorage.setItem(kClosed(), v ? "1":"0");

    const resetIfNewDay = ()=>{
      const t = todayKey();
      if(t!==today){
        today = t;
        // 새날: 입력/메모 초기화 + 마감 해제
        try{ localStorage.removeItem("sebit_fairjustice_"+t); }catch(_){}
        setClosed(false);
      }
    };

    // UI
    const card = el("div","weather-card");
    const top = el("div","weather-top");
    const brand = el("div","weather-brand","SEBIT Light World");
    const title = el("div","weather-title","페어 저스티스");
    const datePill = el("div","weather-date", new Date().toLocaleDateString("ko-KR"));
    top.appendChild(brand); top.appendChild(title); top.appendChild(datePill);
    card.appendChild(top);

    const panel = el("div","weather-panel");
    panel.appendChild(el("div","weather-sec-h","공정한 활동 점검"));

    const makeRadioRow = (qid, qText, opts)=>{
      const wrap = el("div","fj-q");
      wrap.appendChild(el("div","fj-qtext", qText));
      const row = el("div","fj-opts");
      opts.forEach(o=>{
        const lab = el("label","fj-opt");
        const inp = document.createElement("input");
        inp.type="radio";
        inp.name=qid;
        inp.value=o.value;
        lab.appendChild(inp);
        lab.appendChild(el("span","", o.label));
        row.appendChild(lab);

        inp.addEventListener("change", ()=>{
          if(isClosed()) return;
          const s = read();
          s[qid]=o.value;
          write(s);
          // [확인 필요] 선택 시마다 메시지
          if(o.value==="need"){
            showNeedMsg();
          }
          syncUI();
        });
      });
      wrap.appendChild(row);
      return wrap;
    };

    const q1 = makeRadioRow(
      "q1",
      "오늘 규칙 기록과 처리 과정에 문제가 있었나요?",
      [{value:"ok", label:"문제 없음"},{value:"need", label:"확인 필요"}]
    );
    const q2 = makeRadioRow(
      "q2",
      "누군가 불편함을 느낄 수 있는 처리 방식이 있었나요?",
      [{value:"no", label:"없었음"},{value:"need", label:"확인 필요"}]
    );
    panel.appendChild(q1);
    panel.appendChild(q2);

    // memo
    const memoWrap = el("div","fj-memo");
    memoWrap.appendChild(el("div","fj-qtext","메모(선택)"));
    const memo = document.createElement("textarea");
    memo.className="fj-memo-input";
    memo.placeholder="(학생 개인 참고용 · 당일 화면 전용)";
    memoWrap.appendChild(memo);
    panel.appendChild(memoWrap);

    memo.addEventListener("input", ()=>{
      if(isClosed()) return;
      const s = read();
      s.memo = memo.value || "";
      write(s);
    });

    // Buttons: 마감/해제
    const btnRow = el("div","weather-btnrow");
    const btnClose = el("button","btn primary","기록 마감");
    const btnUnclose = el("button","btn","마감 해제");
    btnRow.appendChild(btnClose);
    btnRow.appendChild(btnUnclose);
    panel.appendChild(btnRow);

    btnClose.addEventListener("click", ()=>{
      setClosed(true);
      syncUI();
      toast("기록 마감");
    });

    btnUnclose.addEventListener("click", ()=>{
      setClosed(false);
      syncUI();
      toast("마감 해제");
    });

    card.appendChild(panel);

    // confirm modal
    let msgOv = null;
    const showNeedMsg = ()=>{
      if(isClosed()) return;
      // 기존 메시지가 떠 있어도 다시 띄우기(요구: 누를 때마다 등장)
      if(msgOv) msgOv.remove();
      msgOv = el("div","fj-msg-overlay");
      const box = el("div","fj-msg");
      box.appendChild(el("div","fj-msg-text","오늘 활동 중 확인이 필요한 점이 있어요.\n쉬는 시간에 선생님과 함께 이야기해요."));
      const ok = el("button","btn primary","확인");
      ok.addEventListener("click", ()=>{ if(msgOv){ msgOv.remove(); msgOv=null; } });
      box.appendChild(ok);
      msgOv.appendChild(box);
      ov.appendChild(msgOv);
    };

    const syncUI = ()=>{
      resetIfNewDay();
      datePill.textContent = new Date().toLocaleDateString("ko-KR");
      const s = read();
      // set selected
      const setRadio = (qid,val)=>{
        const inputs = card.querySelectorAll('input[name="'+qid+'"]');
        inputs.forEach(i=>{ i.checked = (i.value===val); i.disabled = isClosed(); });
      };
      setRadio("q1", s.q1||"");
      setRadio("q2", s.q2||"");
      memo.value = s.memo || "";
      memo.disabled = isClosed();
      btnClose.disabled = isClosed();
      btnUnclose.disabled = !isClosed();
    };

    // style injection (minimal) if not present
    if(!document.getElementById("fj-style")){
      const st = document.createElement("style");
      st.id="fj-style";
      st.textContent = `
        .fj-q{ margin-top:14px; }
        .fj-qtext{ font-weight:700; margin-bottom:8px; }
        .fj-opts{ display:flex; gap:10px; flex-wrap:wrap; }
        .fj-opt{ display:flex; align-items:center; gap:8px; padding:10px 12px; border:1px solid rgba(0,0,0,.08); border-radius:12px; background:rgba(255,255,255,.7); }
        .fj-memo{ margin-top:16px; }
        .fj-memo-input{ width:100%; min-height:84px; resize:vertical; padding:10px 12px; border-radius:12px; border:1px solid rgba(0,0,0,.1); }
        .fj-msg-overlay{ position:fixed; inset:0; background:rgba(0,0,0,.35); display:flex; align-items:center; justify-content:center; z-index:9999; }
        .fj-msg{ width:min(520px, 92vw); background:#fff; border-radius:16px; padding:16px; box-shadow:0 14px 40px rgba(0,0,0,.22); }
        .fj-msg-text{ white-space:pre-line; margin-bottom:14px; font-weight:700; }
      `;
      document.head.appendChild(st);
    }

    // polling to reflect menu-based 마감 해제 즉시 반영
    const tick = ()=>{
      if(!document.body.contains(ov)) return;
      syncUI();
      setTimeout(tick, 250);
    };
    tick();

    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);
    return;
  }


if(j.id==="studycheck"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","학습 체크단 · 준비물 점검"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const body = el("div","jobcheck-view-body");
    const today = todayKey();
    const kBase = "sebit_studycheck_"+today;
    const kClosed = "sebit_studycheck_closed_"+today;
    const kDone = "sebit_jobdone_studycheck_"+today;

    const read = ()=>{ try{ return JSON.parse(localStorage.getItem(kBase) || "{}"); }catch(e){ return {}; } };
    const write = (v)=> localStorage.setItem(kBase, JSON.stringify(v||{}));
    const isClosed = ()=> localStorage.getItem(kClosed)==="1";
    const setClosed = (v)=> localStorage.setItem(kClosed, v ? "1":"0");

    const card = el("div","weather-card");
    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","학습 체크단"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const panel = el("div","weather-panel");
    panel.appendChild(el("div","weather-sec-h","급식 점검"));
    // === studycheck_slot_msg_v1 ===
    const slotMsg = el("div","muted","학습 체크단에 배정된 학생이 여기에 표시됩니다.");
    slotMsg.style.margin="6px 0 10px";
    panel.appendChild(slotMsg);
    // === end studycheck_slot_msg_v1 ===

    const tableWrap = el("div","studycheck-table-wrap");
    const table = document.createElement("table");
    table.className = "studycheck-table";
    const thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>번호</th><th>이름</th><th>잘 깎은 연필 3자루 (X)</th><th>지우개 1개 (X)</th><th>기타 메모</th></tr>";
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);

    const renderRows = ()=>{
      const data = read();
      tbody.innerHTML = "";
      roster.forEach((stu, i)=>{
        const tr = document.createElement("tr");
        const idxTd = document.createElement("td"); idxTd.textContent = String(i+1);
        const nameTd = document.createElement("td"); nameTd.textContent = stu.name || stu;

        const key = stu.id || stu.name || String(i);
        const st = data[key] || {};

        const cbP = document.createElement("input"); cbP.type="checkbox"; cbP.checked=!!st.pencil;
        const cbE = document.createElement("input"); cbE.type="checkbox"; cbE.checked=!!st.eraser;
        const memo = document.createElement("input"); memo.type="text"; memo.value=(st.memo||""); memo.placeholder="";

        const disabled = isClosed();
        cbP.disabled = disabled; cbE.disabled = disabled; memo.disabled = disabled;

        const save = ()=>{
          const next = read();
          next[key] = { pencil: cbP.checked, eraser: cbE.checked, memo: memo.value||"" };
          write(next);
        };
        cbP.addEventListener("change", save);
        cbE.addEventListener("change", save);
        memo.addEventListener("input", ()=>{ clearTimeout(memo._t); memo._t=setTimeout(save,200); });

        const pTd = document.createElement("td"); pTd.appendChild(cbP);
        const eTd = document.createElement("td"); eTd.appendChild(cbE);
        const mTd = document.createElement("td"); mTd.appendChild(memo);

        tr.appendChild(idxTd);
        tr.appendChild(nameTd);
        tr.appendChild(pTd);
        tr.appendChild(eTd);
        tr.appendChild(mTd);
        tbody.appendChild(tr);
      });
    };
    renderRows();

    const note = el("div","muted","* 문제 없었다면 체크하지 않아도 됩니다.");
    note.style.marginTop="10px";
    panel.appendChild(note);

    const btnRow = el("div","weather-btnrow");
    const btnClose = el("button","btn primary","기록 마감");
    const btnOpen = el("button","btn","마감 해제");
    btnRow.appendChild(btnClose);
    btnRow.appendChild(btnOpen);
    panel.appendChild(btnRow);

    card.appendChild(panel);

    const syncUI = ()=>{
      const closed = isClosed();
      lockBadge.classList.toggle("hidden", !closed);
      btnClose.disabled = closed;
      btnOpen.disabled = !closed;
      renderRows();
    };

    btnClose.addEventListener("click", ()=>{
      setClosed(true);
      localStorage.setItem(kDone,"1");
      syncUI();
    });
    btnOpen.addEventListener("click", ()=>{
      setClosed(false);
      localStorage.removeItem(kDone);
      syncUI();
    });

    syncUI();
    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);
    return;
  }

  
if(j.id==="timekeeper"){
  // 타임 키퍼(Time Keeper) - 웨더 캐스터 템플릿 기반(처음부터 재작성)
  const ov = el("div","jobcheck-view-overlay");
  const p = el("div","jobcheck-view weather-view");
  const h = el("div","jobcheck-view-head");
  h.appendChild(el("div","jobcheck-view-title","타임 키퍼 · 등교 시각 기록"));
  const x = el("button","btn small","닫기");
  x.addEventListener("click", ()=> ov.remove());
  h.appendChild(x);
  p.appendChild(h);

  const body = el("div","jobcheck-view-body");
  const today = todayKey();
  const kBase = "sebit_timekeeper_"+today;
  const kClosed = "sebit_timekeeper_closed_"+today;
  const kDone = "sebit_jobdone_timekeeper_"+today;

  const read = ()=>{ try{ return JSON.parse(localStorage.getItem(kBase) || "{}"); }catch(e){ return {}; } };
  const write = (v)=> localStorage.setItem(kBase, JSON.stringify(v||{}));
  const isClosed = ()=> localStorage.getItem(kClosed)==="1";
  const setClosed = (v)=> localStorage.setItem(kClosed, v ? "1":"0");

  const lock = isAfter1700();

  // 웨더 캐스터 카드 프레임
  const card = el("div","weather-card");
  const top = el("div","weather-top");
  top.appendChild(el("div","weather-brand","SEBIT Light World"));
  top.appendChild(el("div","weather-title","타임 키퍼"));
  top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
  card.appendChild(top);

  const panel = el("div","weather-panel");
  panel.appendChild(el("div","weather-sec-h","등교 시각 기록"));

  if(lock){
    panel.appendChild(el("div","ranger-lock-banner","17시 이후 잠김 · 오늘 기록은 내일 다시 진행해요."));
  }

  const tableWrap = el("div","timekeeper-table-wrap");
  const table = document.createElement("table");
  table.className = "timekeeper-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>학생</th><th>8:45 이전</th><th>9:00 이전</th><th>기타</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);

  const allDone = (data)=>{
    const active = roster.filter(s=>s.active!==false);
    return active.every(s=> !!data[s.id]);
  };

  const renderRows = ()=>{
    const data = read();
    tbody.innerHTML = "";
    const active = roster.filter(s=>s.active!==false);

    active.forEach((stu)=>{
      const tr = document.createElement("tr");
      tr.className = "tk-row";
      const sel = data[stu.id] || "";
      if(sel) tr.classList.add("tk-done");

      const nameTd = document.createElement("td");
      nameTd.className = "tk-stu";
      nameTd.textContent = (stu.num!=null ? `${stu.num}. ` : "") + (stu.name||"");
      tr.appendChild(nameTd);

      const makeCell = (opt, label)=>{
        const td = document.createElement("td");
        td.className = "tk-cell";
        const box = document.createElement("div");
        box.className = "tk-box" + (sel===opt ? " checked" : "");
        box.setAttribute("aria-label", label);
        td.appendChild(box);
        td.addEventListener("click", ()=>{
          if(lock || isClosed()) return;
          const cur = read();
          cur[stu.id] = opt; // 단일 선택
          write(cur);
          renderRows();
          renderFoot();
        });
        return td;
      };

      tr.appendChild(makeCell("845","8:45 이전"));
      tr.appendChild(makeCell("900","9:00 이전"));
      tr.appendChild(makeCell("etc","기타"));

      tbody.appendChild(tr);
    });
  };

  const foot = el("div","weather-foot");
  const msg = el("div","weather-msg","⏱️ 오늘 기록을 남겨주세요");
  const tip = el("div","weather-tip","★ 학생은 오늘 기록만 남길 수 있어요.");
  const tip2 = el("div","weather-tip2","★ 1명당 8:45/9:00/기타 중 1개만 선택됩니다.");
  const btnRow = el("div","weather-btnrow");
  const btnClose = el("button","btn","기록 마감");
  const btnOpen = el("button","btn ghost","마감 해제");
  btnRow.appendChild(btnClose);
  btnRow.appendChild(btnOpen);

  foot.appendChild(msg);
  foot.appendChild(tip);
  foot.appendChild(tip2);
  foot.appendChild(btnRow);
  panel.appendChild(foot);

  const renderFoot = ()=>{
    if(lock){
      lockBadge.classList.remove("hidden");
      msg.textContent = "⏱️ 17시 이후 잠김";
      btnClose.disabled = true;
      btnOpen.disabled = true;
      return;
    }
    const data = read();
    if(isClosed()){
      lockBadge.classList.remove("hidden");
      msg.textContent = allDone(data) ? "✅ 오늘 기록 마감됨" : "🔒 마감됨(미완료 있음)";
      btnClose.disabled = true;
      btnOpen.disabled = false;
    }else{
      lockBadge.classList.add("hidden");
      msg.textContent = allDone(data) ? "✅ 오늘 기록 완료(마감 가능)" : "⏱️ 오늘 기록을 남겨주세요";
      btnClose.disabled = !allDone(data);
      btnOpen.disabled = true;
    }
  };

  btnClose.addEventListener("click", ()=>{
    if(lock || isClosed()) return;
    const data = read();
    if(!allDone(data)) return;
    setClosed(true);
    localStorage.setItem(kDone,"1");
    renderRows();
    renderFoot();
  });
  btnOpen.addEventListener("click", ()=>{
    if(lock || !isClosed()) return;
    setClosed(false);
    localStorage.setItem(kDone,"0");
    renderRows();
    renderFoot();
  });

  card.appendChild(panel);
  body.appendChild(card);

  p.appendChild(body);
  ov.appendChild(p);
  document.body.appendChild(ov);

  renderRows();
  renderFoot();
}


  

// (removed duplicate ranger block)


 else if(j.id==="lightmerchant"){

    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","빛의 상인 · 상점 지급 요청"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const body = el("div","jobcheck-view-body");
    const card = el("div","weather-card");

    // Top
    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","빛의 상인"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    // Panel
    const panel = el("div","weather-panel");

    const sub = el("div","roster-sub");
    sub.appendChild(el("div","weather-sec-h","지급 요청 목록"));
    const cnt = el("div","qcount", "");
    sub.appendChild(cnt);
    panel.appendChild(sub);

    const tableWrap = el("div","lm-tablewrap");
    const table = el("table","lm-table");
    table.innerHTML = `
      <thead>
        <tr><th style="width:64px;">번호</th><th style="width:120px;">학생</th><th>상품</th><th style="width:140px;"></th></tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);

    const note = el("div","weather-note");
    note.textContent = "오늘까지 최대 30건까지 지급 요청이 생성돼요.";
    panel.appendChild(note);

    card.appendChild(panel);

    // Controls
    const ctl = el("div","weather-ctl");
    const btnClose = el("button","btn","기록 마감");
    const btnOpen = el("button","btn","마감 해제");
    ctl.appendChild(btnClose);
    ctl.appendChild(btnOpen);
    card.appendChild(ctl);

    const rerender = ()=>{
      const closed = lmIsClosed();
      cnt.textContent = `오늘 신청 ${Math.min(shopGetTodayCount(),30)}/30`;
      lockBadge.classList.toggle("hidden", !closed);
      card.classList.toggle("locked", !!closed);

      btnClose.disabled = closed;
      btnOpen.disabled = !closed;

      tbody.innerHTML = "";
      const listAll = lmGetTodayList();
      const list = listAll.filter(x=>x && x.status==="pending");
      if(list.length===0){
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="4" class="muted" style="padding:14px; text-align:center;">요청 없음</td>`;
        tbody.appendChild(tr);
        return;
      }

      list.forEach((r, i)=>{
        const tr = document.createElement("tr");
        const btnDisabled = closed ? "disabled" : "";
        tr.innerHTML = `
          <td>${i+1}</td>
          <td>${escapeHTML(r.studentName||"")}</td>
          <td>${escapeHTML(r.productName||"")}</td>
          <td><button class="btn small primary" ${btnDisabled}>지급 확인</button></td>
        `;
        const b = tr.querySelector("button");
        if(b){
          b.addEventListener("click", ()=>{
            if(lmIsClosed()){ toast("마감 상태입니다."); return; }
            if(!confirm("상품을 잘 전달했나요?")) return;
            const all = lmGetTodayList();
            const idx = all.findIndex(x=>x && x.id===r.id);
            if(idx>-1){
              all[idx].status = "done";
              all[idx].doneAt = Date.now();
              lmSetTodayList(all);
              lmPushHistory(all[idx]);

              // 상점관리 구매기록에도 이관(표시용)
              const logsRaw = readJSON(LS.shopPurchaseLog, []);
              const logs = Array.isArray(logsRaw) ? logsRaw : [];
              const done = all[idx];
              removePocketRequestItem(done.studentId, done);
              logs.push({
                ts: new Date().toISOString(),
                studentId: done.studentId,
                studentName: String(done.studentName||""),
                student: String(done.studentName||""),
                productId: done.productId,
                productName: String(done.productName||""),
                product: String(done.productName||""),
                price: Number(done.price||0)
              });
              while(logs.length > 50) logs.shift();
              writeJSON(LS.shopPurchaseLog, logs);
              pushSystemLog(`[빛의 상인] 지급완료: ${String(done.studentName||"")} · ${String(done.productName||"")} · ${new Date().toISOString()}`);
            }
            rerender();
          });
        }
        tbody.appendChild(tr);
      });
    };

    btnClose.addEventListener("click", ()=>{ lmSetClosed(true); rerender(); toast("기록 마감"); });
    btnOpen.addEventListener("click", ()=>{ lmSetClosed(false); rerender(); toast("마감 해제"); });

    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);

    rerender();
    return;
  }




  if(j.id==="lightguardian_front" || j.id==="lightguardian_back"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    const side = (j.id==="lightguardian_front") ? "앞" : "뒤";
    h.appendChild(el("div","jobcheck-view-title", `빛의 파수꾼(${side}) · 교실 청소 점검`));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const KEY = (j.id==="lightguardian_front") ? "sebit:lightguardian_front_q_v1" : "sebit:lightguardian_back_q_v1";
    const today = todayKey();
    const loadState = () => {
      const s = readJSON(KEY, null);
      if(s && s.version===1 && s.date===today) return s;
      return { version:1, date: today, q1:null, q2:null, memo:"", closed:false };
    };
    const saveState = (s)=> { try{ localStorage.setItem(KEY, JSON.stringify(s)); }catch(_){ } };
    let state = loadState();

    const body = el("div","jobcheck-view-body");
    const card = el("div","weather-card");

    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title", `빛의 파수꾼(${side})`));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
    card.appendChild(lockBadge);

    const panel = el("div","weather-panel");

    const mkYesNo = (name, cur, onChange) => {
      const row = el("div","weather-choice-row");
      const mk = (val, label) => {
        const lab = el("label","weather-radio");
        const input = el("input");
        input.type="radio";
        input.name=name;
        input.value = val ? "yes" : "no";
        input.checked = (cur===val);
        input.addEventListener("change", ()=> onChange(val));
        lab.appendChild(input);
        lab.appendChild(el("span","", label));
        return lab;
      };
      row.appendChild(mk(true,"예"));
      row.appendChild(mk(false,"아니요"));
      return row;
    };

    // Q1
    const q1Text = (j.id==="lightguardian_front")
      ? "Q1. 교실 앞(칠판쪽)을 깨끗하게 청소했나요?"
      : "Q1. 교실 뒤(사물함) 쪽을 깨끗하게 청소했나요?";
    panel.appendChild(el("div","weather-sec-h", q1Text));
    const q1Row = mkYesNo("lg_q1", state.q1, (v)=>{
      if(state.closed) return;
      state.q1 = v;
      saveState(state);
      rerender();
    });
    panel.appendChild(q1Row);

    // Q2
    const q2Text = (j.id==="lightguardian_front")
      ? "Q2. 주변 정리를 안 한 친구가 있나요?"
      : "Q2. 사물함 문을 잘 닫지 않은 친구가 있나요?";
    const eventMsg = (j.id==="lightguardian_front")
      ? "주변 정리를 안 한 친구에게 친절하게 알려주세요."
      : "사물함 문을 잘 닫지 않은 친구에게 친절하게 알려주세요.";
    panel.appendChild(el("div","weather-sec-h", q2Text));
    const q2Row = mkYesNo("lg_q2", state.q2, (v)=>{
      if(state.closed) return;
      state.q2 = v;
      saveState(state);
      rerender();
    });
    panel.appendChild(q2Row);

    const evt = el("div","weather-note");
    evt.textContent = `💬 ${eventMsg}`;
    panel.appendChild(evt);

    // Memo
    panel.appendChild(el("div","weather-sec-h","메모 (선택)"));
    const memo = el("textarea");
    memo.className = "weather-badmsg";
    memo.placeholder = "특이사항을 적어주세요.";
    memo.value = state.memo || "";
    memo.addEventListener("input", ()=>{
      if(state.closed){ memo.value = state.memo||""; return; }
      state.memo = memo.value;
      saveState(state);
    });
    panel.appendChild(memo);

    // Notice
    const note = el("div","weather-note");
    note.textContent = "★ 학생은 오늘 기록만 남길 수 있어요.";
    panel.appendChild(note);

    card.appendChild(panel);

    // Controls
    const ctl = el("div","weather-ctl");
    const btnClose = el("button","btn","기록 마감");
    const btnOpen = el("button","btn","마감 해제");
    btnClose.addEventListener("click", ()=>{ state.closed=true; saveState(state); rerender(); toast("기록 마감"); });
    btnOpen.addEventListener("click", ()=>{ state.closed=false; saveState(state); rerender(); toast("마감 해제"); });
    ctl.appendChild(btnClose);
    ctl.appendChild(btnOpen);
    card.appendChild(ctl);

    const rerender = () => {
      // daily reset if date changed while open
      const cur = loadState();
      state = cur;
      const disabled = !!state.closed;
      lockBadge.classList.toggle("hidden", !disabled);

      // q1 radios
      card.querySelectorAll('input[name="lg_q1"]').forEach(r=>{
        r.checked = (r.value==="yes") ? (state.q1===true) : (state.q1===false);
        r.disabled = disabled;
      });
      // q2 radios
      card.querySelectorAll('input[name="lg_q2"]').forEach(r=>{
        r.checked = (r.value==="yes") ? (state.q2===true) : (state.q2===false);
        r.disabled = disabled;
      });

      memo.disabled = disabled;
      memo.value = state.memo || "";

      // event message only when Q2 === true
      evt.classList.toggle("hidden", state.q2!==true);
    };

    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);

    rerender();
    return;
  }


if(j.id==="greensaver"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","그린 세이버 · 교실 환경/분리배출 점검"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const KEY = "sebit:greensaver_v1";
    const today = todayKey();
    const ITEMS = [
      { id:"trash_near_bin", label:"휴지통 주변에<br/>쓰레기방치<br/>치우지 않음" },
      { id:"recycle_not_sorted", label:"분리수거함<br/>정리 안 됨" },
    ];

    const loadState = () => {
      const s = readJSON(KEY, null);
      if(s && s.date===today && s.version===1) return s;
      return { version:1, date: today, closed:false, memo:"", rows:{} };
    };
    const saveState = (s) => { try{ localStorage.setItem(KEY, JSON.stringify(s)); }catch(_){ } };
    let state = loadState();

    const ensureRow = (sid) => {
      if(!state.rows) state.rows = {};
      if(!state.rows[sid]) state.rows[sid] = {};
      return state.rows[sid];
    };

    const body = el("div","jobcheck-view-body");
    const card = el("div","weather-card");

    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","그린 세이버"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const panel = el("div","weather-panel");
    panel.appendChild(el("div","weather-sec-h","교실 환경/분리배출 점검"));

    const tableWrap = el("div","greensaver-tablewrap");
    const table = el("table","greensaver-table");
    const thead = el("thead");
    const trh = el("tr");
    trh.appendChild(el("th","col-num","번호"));
    trh.appendChild(el("th","col-name","이름"));
    ITEMS.forEach(it=>{
      const th = el("th","col-item");
      th.innerHTML = it.label;
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = el("tbody");
    roster.forEach(st=>{
      const sid = String(st.id ?? st.num ?? st.name ?? "");
      const row = ensureRow(sid);

      const tr = el("tr");
      tr.appendChild(el("td","td-num", String(st.num ?? "")));
      tr.appendChild(el("td","td-name", escapeHTML(st.name ?? "")));

      ITEMS.forEach(it=>{
        const td = el("td","td-check");
        const input = el("input");
        input.type = "checkbox";
        input.checked = !!row[it.id];
        input.addEventListener("change", ()=>{
          if(state.closed) return;
          row[it.id] = !!input.checked;
          saveState(state);
        });
        td.appendChild(input);
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    panel.appendChild(tableWrap);

    const memoWrap = el("div","greensaver-memo");
    memoWrap.appendChild(el("div","memo-label","기타 메모"));
    const memo = el("textarea","memo-input");
    memo.value = state.memo || "";
    memo.placeholder = "당일 참고용 메모 (공통)";
    memo.addEventListener("input", ()=>{
      if(state.closed) return;
      state.memo = memo.value;
      saveState(state);
    });
    memoWrap.appendChild(memo);
    panel.appendChild(memoWrap);

    const note = el("div","weather-note");
    note.textContent = "★ 문제 없었다면 체크하지 않아도 됩니다.";
    panel.appendChild(note);

    card.appendChild(panel);

    const ctl = el("div","weather-ctl");
    const btnClose = el("button","btn","기록 마감");
    const btnOpen = el("button","btn","마감 해제");
    btnClose.addEventListener("click", ()=>{ state.closed=true; saveState(state); rerender(); toast("기록 마감"); });
    btnOpen.addEventListener("click", ()=>{ state.closed=false; saveState(state); rerender(); toast("마감 해제"); });
    ctl.appendChild(btnClose);
    ctl.appendChild(btnOpen);
    card.appendChild(ctl);

    const rerender = () => {
      const cur = loadState();
      state = cur;

      lockBadge.classList.toggle("hidden", !state.closed);

      // disable/enable all inputs inside table
      table.querySelectorAll("input[type=checkbox]").forEach(cb=>{
        cb.disabled = !!state.closed;
      });
      memo.disabled = !!state.closed;
    };

    // initial
    rerender();

    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);
    return;
  }
if(j.id==="weathercaster"){
    const ov = el("div","jobcheck-view-overlay");
    const p = el("div","jobcheck-view weather-view");
    const h = el("div","jobcheck-view-head");
    h.appendChild(el("div","jobcheck-view-title","웨더 캐스터 · 오늘 미세먼지/내일 날씨 예보"));
    const x = el("button","btn small","닫기");
    x.addEventListener("click", ()=> ov.remove());
    h.appendChild(x);
    p.appendChild(h);

    const WEATHER_KEY = "sebit:weathercaster_v1";
    const today = todayKey();
    const loadState = () => {
      const s = readJSON(WEATHER_KEY, null);
      if(s && s.date===today) return s;
      return { version:1, date: today, dust: null, forecast: {sunny:false, cloudy:false, rain:false, snow:false}, sent:false, closed:false };
    };
    const saveState = (s) => { try{ localStorage.setItem(WEATHER_KEY, JSON.stringify(s)); }catch(_){ } };
    let state = loadState();
    if(typeof state.praised==="undefined") state.praised = false;

    const showGreenPraise = () => {
      const pov = el("div","weather-popup-overlay");
      const box = el("div","weather-popup");
      box.appendChild(el("div","t","오늘의 칭찬")); 
      box.appendChild(el("div","m","그린 세이버의 노력 덕분에 교실이 더욱 맑고 깨끗해졌어요 🌿"));
      const ok = el("button","btn primary","확인");
      ok.addEventListener("click", ()=> pov.remove());
      box.appendChild(ok);
      pov.appendChild(box);
      ov.appendChild(pov);
    };


    const showPraise = () => {
      const pov = el("div","weather-popup-overlay");
      const box = el("div","weather-popup");
      box.appendChild(el("div","t","잘했어요!"));
      box.appendChild(el("div","m","날씨 예보를 잘 전달했어요."));
      const ok = el("button","btn primary","확인");
      ok.addEventListener("click", ()=> pov.remove());
      box.appendChild(ok);
      pov.appendChild(box);
      ov.appendChild(pov);
    };

    const body = el("div","jobcheck-view-body");
    const card = el("div","weather-card");

    const top = el("div","weather-top");
    top.appendChild(el("div","weather-brand","SEBIT Light World"));
    top.appendChild(el("div","weather-title","웨더 캐스터"));
    top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
    card.appendChild(top);

    const panel = el("div","weather-panel");

    // Dust
    panel.appendChild(el("div","weather-sec-h","오늘 미세먼지 확인"));
    const dustRow = el("div","weather-choice-row");

    const mkDust = (key, label) => {
      const lab = el("label","weather-radio");
      const input = el("input");
      input.type="radio";
      input.name="dust";
      input.value=key;
      input.checked = state.dust===key;
      input.addEventListener("change", ()=>{
        state.dust = key;
        saveState(state);
        rerender();
      });
      lab.appendChild(input);
      lab.appendChild(el("span","dot"));
      lab.appendChild(el("span","txt", label));
      return lab;
    };
    dustRow.appendChild(mkDust("good","좋아"));
    dustRow.appendChild(mkDust("normal","보통"));
    const bad = mkDust("bad","나쁨");
    bad.classList.add("bad");
    dustRow.appendChild(bad);
    panel.appendChild(dustRow);

    const badMsg = el("div","weather-badmsg hidden");
    badMsg.innerHTML = `<span class="ico">😷</span><span>마스크 쓰기를 친구들에게 추천해 주세요!</span>`;
    panel.appendChild(badMsg);

    // Forecast
    panel.appendChild(el("div","weather-sec-h","내일 날씨 예보 전달"));
    const fcGrid = el("div","weather-fc-grid");

    const mkFc = (k, label) => {
      const lab = el("label","weather-check");
      const cb = el("input");
      cb.type="checkbox";
      cb.checked = !!state.forecast?.[k];
      cb.addEventListener("change", ()=>{
        state.forecast = state.forecast || {};
        state.forecast[k]=cb.checked;
        saveState(state);
      });
      lab.appendChild(cb);
      lab.appendChild(el("span","box"));
      lab.appendChild(el("span","txt", label));
      return lab;
    };

    fcGrid.appendChild(mkFc("sunny","맑음"));
    fcGrid.appendChild(mkFc("cloudy","흐림"));
    fcGrid.appendChild(mkFc("rain","비"));
    fcGrid.appendChild(mkFc("snow","눈"));
    panel.appendChild(fcGrid);

    // Sent button
    const sentBtn = el("button","weather-sent-btn");
    sentBtn.type="button";
    sentBtn.innerHTML = `<span class="sun">🌤️</span><span>오늘 예보 전달했어요</span>`;
    sentBtn.addEventListener("click", ()=>{
      if(state.closed) return;
      if(state.sent) return;
      state.sent = true;
      saveState(state);
      rerender();
      showPraise();
    });
    panel.appendChild(sentBtn);

    // Notice
    const note = el("div","weather-note");
    note.textContent = "★ 학생은 오늘 기록만 남길 수 있어요.";
    panel.appendChild(note);

    card.appendChild(panel);

    // Teacher controls (always visible in this admin view)
    const ctl = el("div","weather-ctl");
    const btnClose = el("button","btn","기록 마감");
    const btnOpen = el("button","btn","마감 해제");
    btnClose.addEventListener("click", ()=>{ state.closed=true; saveState(state); rerender(); toast("기록 마감"); });
    btnOpen.addEventListener("click", ()=>{ state.closed=false; saveState(state); rerender(); toast("마감 해제"); });
    ctl.appendChild(btnClose);
    ctl.appendChild(btnOpen);
    card.appendChild(ctl);

    const rerender = () => {
      // daily reset (if date changed while open)
      const cur = loadState();
      state = cur;
      // update inputs
      const disabled = !!state.closed;
      lockBadge.classList.toggle("hidden", !disabled);

      // dust checked
      card.querySelectorAll('input[name="dust"]').forEach(r=>{ r.checked = (r.value===state.dust); r.disabled = disabled; });
      // forecast checked
      const fmap = state.forecast || {};
      const fcKeys = {sunny:0,cloudy:1,rain:2,snow:3};
      card.querySelectorAll(".weather-check input[type=checkbox]").forEach((cb,idx)=>{
        const k = Object.keys(fcKeys).find(k=>fcKeys[k]===idx) || null;
        if(k) cb.checked = !!fmap[k];
        cb.disabled = disabled;
      });
      // bad msg
      badMsg.classList.toggle("hidden", state.dust!=="bad");
      // sent btn
      sentBtn.disabled = disabled || !!state.sent;
      sentBtn.classList.toggle("done", !!state.sent);
      sentBtn.querySelector("span:last-child").textContent = state.sent ? "오늘 예보 전달완료" : "오늘 예보 전달했어요";
      // grey out panel
      card.classList.toggle("locked", disabled);
    };

    rerender();
    body.appendChild(card);
    p.appendChild(body);
    ov.appendChild(p);
    overlay.appendChild(ov);
    return;
  }



if(j.id==="techkeeper"){
  const ov = el("div","jobcheck-view-overlay");
  const p  = el("div","jobcheck-view weather-view");
  const h  = el("div","jobcheck-view-head");
  h.appendChild(el("div","jobcheck-view-title","테크 키퍼 · 패드 반납 점검"));
  const x  = el("button","btn small","닫기");
  x.addEventListener("click", ()=> ov.remove());
  h.appendChild(x);
  p.appendChild(h);

  const body  = el("div","jobcheck-view-body");
  const today = todayKey();
  const kBase   = "sebit_techkeeper_"+today;
  const kClosed = "sebit_techkeeper_closed_"+today;
  const kDone   = "sebit_jobdone_techkeeper_"+today;

  const read = ()=>{ try{ return JSON.parse(localStorage.getItem(kBase) || "{}"); }catch(e){ return {}; } };
  const write = (v)=>{ try{ localStorage.setItem(kBase, JSON.stringify(v||{})); }catch(e){} };
  const isClosed = ()=> localStorage.getItem(kClosed)==="1";
  const setClosed = (v)=>{ try{ v ? localStorage.setItem(kClosed,"1") : localStorage.removeItem(kClosed); }catch(e){} };

  const card = el("div","weather-card");
  const top  = el("div","weather-top");
  top.appendChild(el("div","weather-brand","SEBIT Light World"));
  top.appendChild(el("div","weather-title","테크 키퍼"));
  top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
  card.appendChild(top);

  const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
  card.appendChild(lockBadge);

  const panel = el("div","weather-panel");
  panel.appendChild(el("div","weather-sec-h","미반납자"));
  panel.appendChild(el("div","muted","미반납한 친구를 체크해 주세요."));

  const tableWrap = el("div","timekeeper-table-wrap");
  const table = document.createElement("table");
  table.className = "timekeeper-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th style='width:70px'>번호</th><th>이름</th><th style='width:120px'>미반납</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);

  const renderRows = ()=> {
    const data = read();
    tbody.innerHTML = "";
    const active = roster.filter(s=>s.active!==false);
    active.forEach((stu, idx)=>{
      const tr = document.createElement("tr");
      const noTd = document.createElement("td");
      noTd.textContent = String(stu.no ?? (idx+1));
      const nameTd = document.createElement("td");
      nameTd.textContent = stu.name || "";
      const chkTd = document.createElement("td");

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = !!data[stu.id];
      chk.disabled = isClosed();
      chk.addEventListener("change", ()=>{
        if(isClosed()){ chk.checked = !!read()[stu.id]; return; }
        const d = read();
        if(chk.checked) d[stu.id] = 1;
        else delete d[stu.id];
        write(d);
      });

      chkTd.appendChild(chk);
      tr.appendChild(noTd);
      tr.appendChild(nameTd);
      tr.appendChild(chkTd);
      tbody.appendChild(tr);
    });
  };

  const foot = el("div","weather-foot");
  foot.appendChild(el("div","weather-msg","⏱️ 오늘까지는 모두 학생이 학습용 패드를 꼭 반납해야 해요."));
  foot.appendChild(el("div","jobcheck-help","★ 학생은 오늘 기록만 남길 수 있어요."));
  const btnRow = el("div","weather-btnrow");
  const btnClose = el("button","btn","기록 마감");
  const btnOpen  = el("button","btn ghost","마감 해제");
  btnRow.appendChild(btnClose);
  btnRow.appendChild(btnOpen);
  foot.appendChild(btnRow);
  panel.appendChild(foot);

  const renderFoot = ()=>{
    if(isClosed()){
      lockBadge.classList.remove("hidden");
      btnClose.disabled = true;
      btnOpen.disabled = false;
    }else{
      lockBadge.classList.add("hidden");
      btnClose.disabled = false;
      btnOpen.disabled = true;
    }
    Array.from(tbody.querySelectorAll("input[type='checkbox']")).forEach(i=> i.disabled = isClosed());
  };

  btnClose.addEventListener("click", ()=>{
    setClosed(true);
    try{ localStorage.setItem(kDone,"1"); }catch(e){}
    renderFoot();
  });
  btnOpen.addEventListener("click", ()=>{
    setClosed(false);
    try{ localStorage.removeItem(kDone); }catch(e){}
    renderFoot();
  });

  renderRows();
  renderFoot();

  card.appendChild(panel);
  body.appendChild(card);
  p.appendChild(body);
  ov.appendChild(p);
  overlay.appendChild(ov);
  return;
}

if(j.id==="docmaster"){
  const ov = el("div","jobcheck-view-overlay");
  const p = el("div","jobcheck-view weather-view");
  const h = el("div","jobcheck-view-head");
  h.appendChild(el("div","jobcheck-view-title","문서 마스터 · 오늘 수행 기록"));
  const x = el("button","btn small","닫기");
  x.addEventListener("click", ()=> ov.remove());
  h.appendChild(x);
  p.appendChild(h);

  const body = el("div","jobcheck-view-body");
  const today = todayKey();
  const kBase = "sebit_docmaster_"+today;
  const kClosed = "sebit_docmaster_closed_"+today;
  const kDone = "sebit_jobdone_docmaster_"+today;

  const load = ()=>{
    try{ return JSON.parse(localStorage.getItem(kBase) || "{}"); }catch(e){ return {}; }
  };
  const save = (v)=> localStorage.setItem(kBase, JSON.stringify(v||{}));
  const isClosed = ()=> localStorage.getItem(kClosed)==="1";
  const setClosed = (v)=> localStorage.setItem(kClosed, v ? "1":"0");

  let state = load();
  state.checks = state.checks || {};
  state.memo = state.memo || "";

  const ITEMS = [
    {id:"c1", label:"친구들에게 학습지를 나눠줌"},
    {id:"c2", label:"학급 문서 양식 필요한 친구에게 전달함"},
    {id:"c3", label:"부족한 학급 문서 양식을 선생님께 요청드림"},
    {id:"c4", label:"학년 연구실에서 복사물을 찾아옴"},
    {id:"c5", label:"오늘은 쉬어서 좋았다"}
  ];

  const card = el("div","weather-card");
  const top = el("div","weather-top");
  top.appendChild(el("div","weather-brand","SEBIT Light World"));
  top.appendChild(el("div","weather-title","문서 마스터"));
  top.appendChild(el("div","weather-date", new Date().toLocaleDateString("ko-KR")));
  card.appendChild(top);

  const lockBadge = el("div","weather-lock hidden","🔒 오늘 기록 마감");
  card.appendChild(lockBadge);

  const panel = el("div","weather-panel");
  panel.appendChild(el("div","weather-sec-h","오늘 수행 체크"));

  const list = el("div","docmaster-list");
  list.style.display="grid";
  list.style.gap="10px";
  list.style.margin="10px 0 14px";

  const inputs = [];
  ITEMS.forEach(it=>{
    const row = el("label","docmaster-item");
    row.style.display="flex";
    row.style.alignItems="center";
    row.style.gap="10px";
    row.style.padding="10px 12px";
    row.style.borderRadius="12px";
    row.style.background="rgba(255,255,255,.75)";
    row.style.border="1px solid rgba(0,0,0,.08)";

    const cb = el("input");
    cb.type="checkbox";
    cb.checked = !!state.checks[it.id];
    cb.addEventListener("change", ()=>{
      if(isClosed()) return;
      state.checks[it.id] = !!cb.checked;
      save(state);
    });
    inputs.push(cb);

    const t = el("div","docmaster-text", it.label);
    t.style.flex="1";
    t.style.fontWeight="700";
    t.style.color="rgba(0,0,0,.75)";
    row.appendChild(cb);
    row.appendChild(t);
    list.appendChild(row);
  });

  panel.appendChild(list);

  const memoWrap = el("div","greensaver-memo");
  memoWrap.appendChild(el("div","memo-label","메모(선택)"));
  const memo = el("textarea","memo-input");
  memo.rows = 3;
  memo.placeholder = "오늘 참고용 메모";
  memo.value = state.memo || "";
  memo.addEventListener("input", ()=>{
    if(isClosed()) return;
    state.memo = memo.value;
    save(state);
  });
  memoWrap.appendChild(memo);
  panel.appendChild(memoWrap);

  const note = el("div","weather-note");
  note.textContent = "✔ 복수 선택 가능 · ✔ 메모 존재 · ✔ 마감/해제 공통 규칙 · ✔ 연동 없음";
  panel.appendChild(note);

  card.appendChild(panel);

  const ctl = el("div","weather-ctl");
  const btnClose = el("button","btn","기록 마감");
  const btnOpen = el("button","btn","마감 해제");
  btnClose.addEventListener("click", ()=>{
    setClosed(true);
    try{ localStorage.setItem(kDone,"1"); }catch(e){}
    rerender();
    toast("기록 마감");
  });
  btnOpen.addEventListener("click", ()=>{
    setClosed(false);
    try{ localStorage.removeItem(kDone); }catch(e){}
    rerender();
    toast("마감 해제");
  });
  ctl.appendChild(btnClose);
  ctl.appendChild(btnOpen);
  card.appendChild(ctl);

  const rerender = ()=>{
    const closed = isClosed();
    lockBadge.classList.toggle("hidden", !closed);
    inputs.forEach(cb=> cb.disabled = closed);
    memo.disabled = closed;
    btnClose.disabled = closed;
    btnOpen.disabled = !closed;
  };

  rerender();

  body.appendChild(card);
  p.appendChild(body);
  ov.appendChild(p);
  overlay.appendChild(ov);
  return;
}



  toast("준비 중입니다. (나중에 연결)");
});
        card.appendChild(openBtn);
        grid.appendChild(card);
      });

      panel.appendChild(head);
      panel.appendChild(grid);
      overlay.appendChild(panel);
      root.prepend(overlay);
    };



    const rewardStoreKey = 'sebit:jobRewardPaid_v1';
    const citizenRewardKey = 'sebit:modelCitizenReward_v1';
    const citizenPaidKey = 'sebit:modelCitizenPaid_v1';
    const readObjLocal = (key, fallback={})=>{ try{ const raw=localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }catch(_){ return fallback; } };
    const saveObjLocal = (key, obj)=>{ try{ localStorage.setItem(key, JSON.stringify(obj)); }catch(_){} };
    const sessionKey = ()=> String((getJobSession().startedAt || 'no_session'));
    const addRewardToStudents = (items)=>{
      // items: [{sid,lumen,xp}]
      const st = readJSON(LS.students, []);
      let changed = 0;
      items.forEach(it=>{
        const idx = st.findIndex(s=>String(s.id)===String(it.sid));
        if(idx<0) return;
        st[idx].lumen = Number(st[idx].lumen||0) + Math.max(0, Number(it.lumen||0));
        st[idx].xp = Number(st[idx].xp||0) + Math.max(0, Number(it.xp||0));
        changed++;
      });
      writeJSON(LS.students, st);
      return changed;
    };
    const payJobRewards = ()=>{
      const sess = getJobSession();
      if(!sess.startedAt || sess.endedAt){
        alert('진행 중인 직업 세션이 없습니다. 먼저 직업 배정을 확정하거나 세션을 시작해 주세요.');
        return;
      }
      const a = getJobAssign();
      const cfgNow = getJobConfig();
      const paid = readObjLocal(rewardStoreKey, {});
      const sk = sessionKey();
      if(!paid[sk]) paid[sk] = {};
      const payItems = [];
      const people = new Set();
      FIXED_JOBS.forEach(j=>{
        const cur = a.jobs?.[j.id] || {};
        const holders = Array.isArray(cur.holders) ? cur.holders : [];
        const jc = cfgNow.fixed?.[j.id] || {lumen:0,xp:0};
        holders.forEach(sid=>{
          const key = `${j.id}__${sid}`;
          if(paid[sk][key]) return;
          payItems.push({ sid, jobId:j.id, jobName:j.name, lumen:Number(jc.lumen||0), xp:Number(jc.xp||0), key });
          people.add(String(sid));
        });
      });
      if(!payItems.length){
        alert('새로 지급할 직업 보상이 없습니다. 이미 지급되었거나 배정된 학생이 없습니다.');
        return;
      }
      const totalL = payItems.reduce((a,x)=>a+Math.max(0,Number(x.lumen||0)),0);
      const totalX = payItems.reduce((a,x)=>a+Math.max(0,Number(x.xp||0)),0);
      const msg = `직업 배정 학생 ${people.size}명에게 직업 수행 보상을 지급합니다.\n`+
                  `지급 건수: ${payItems.length}건\n총 보상: ${totalL}루멘 / ${totalX}XP\n\n마감 여부와 상관없이 현재 배정 기준으로 지급됩니다. 진행할까요?`;
      if(!confirm(msg)) return;
      const changed = addRewardToStudents(payItems);
      payItems.forEach(x=>{ paid[sk][x.key] = {ts:Date.now(), lumen:x.lumen, xp:x.xp, jobName:x.jobName}; });
      saveObjLocal(rewardStoreKey, paid);
      try{ pushSystemLog(`[job-reward] session ${sk}: ${changed} students, ${payItems.length} items, ${totalL}L/${totalX}XP`); }catch(_){}
      toast(`직업 보상 지급 완료: ${changed}명`);
      renderJobsAdmin(root);
    };
    const getCitizenReward = ()=>{
      const r = readObjLocal(citizenRewardKey, {lumen:0,xp:0});
      return { lumen:Math.max(0, Number(r.lumen||0)), xp:Math.max(0, Number(r.xp||0)) };
    };
    const setCitizenReward = ()=>{
      const cur = getCitizenReward();
      const l = prompt('모범 시민 보상 루멘을 입력하세요.', String(cur.lumen));
      if(l===null) return;
      const x = prompt('모범 시민 보상 XP를 입력하세요.', String(cur.xp));
      if(x===null) return;
      const reward = { lumen:Math.max(0, Number(l)||0), xp:Math.max(0, Number(x)||0) };
      saveObjLocal(citizenRewardKey, reward);
      toast(`모범 시민 보상 설정: ${reward.lumen}루멘 / ${reward.xp}XP`);
      renderJobsAdmin(root);
    };
    const getModelCitizenIds = ()=>{
      const sess = getJobSession();
      const start = Number(sess.startedAt||0);
      const end = Number(sess.endedAt || Date.now());
      const all = getRoster().filter(s=>s && s.active!==false);
      if(!start) return [];
      let logs=[];
      try{ logs = (typeof getAllPenaltyLogs==='function') ? getAllPenaltyLogs() : []; }catch(_){ logs=[]; }
      const bad = new Set();
      logs.forEach(l=>{
        if(String(l?.status||'applied') === 'canceled') return;
        const ts = (typeof sebitPenaltyTs==='function') ? sebitPenaltyTs(l) : Number(l?.ts||0);
        if(ts>=start && ts<=end && l?.studentId) bad.add(String(l.studentId));
      });
      return all.filter(s=>!bad.has(String(s.id))).map(s=>String(s.id));
    };
    const payModelCitizenReward = ()=>{
      const sess = getJobSession();
      if(!sess.startedAt){ alert('직업 세션 시작 기록이 없습니다. 먼저 직업 배정을 확정해 주세요.'); return; }
      const reward = getCitizenReward();
      if(reward.lumen<=0 && reward.xp<=0){ alert('모범 시민 보상값이 0입니다. 먼저 보상 설정을 해 주세요.'); return; }
      const sk = sessionKey();
      const paid = readObjLocal(citizenPaidKey, {});
      if(!paid[sk]) paid[sk] = {};
      const ids = getModelCitizenIds().filter(sid=>!paid[sk][sid]);
      if(!ids.length){ alert('새로 지급할 모범 시민 보상이 없습니다. 이미 지급되었거나 대상 학생이 없습니다.'); return; }
      const totalL = ids.length * reward.lumen;
      const totalX = ids.length * reward.xp;
      if(!confirm(`직업 수행 기간 동안 벌점이 없는 학생 ${ids.length}명에게\n1인당 ${reward.lumen}루멘 / ${reward.xp}XP를 지급합니다.\n총 ${totalL}루멘 / ${totalX}XP\n\n진행할까요?`)) return;
      const changed = addRewardToStudents(ids.map(sid=>({sid,lumen:reward.lumen,xp:reward.xp})));
      ids.forEach(sid=>{ paid[sk][sid] = {ts:Date.now(), lumen:reward.lumen, xp:reward.xp}; });
      saveObjLocal(citizenPaidKey, paid);
      try{ pushSystemLog(`[model-citizen-reward] session ${sk}: ${changed} students, ${totalL}L/${totalX}XP`); }catch(_){}
      toast(`모범 시민 보상 지급 완료: ${changed}명`);
      renderJobsAdmin(root);
    };

    const renderMain = () => {
      root.innerHTML = "";
      const top = el("div","jobs-topbar");
      const status = el("div","jobs-session");
      const started = s.startedAt ? new Date(s.startedAt).toLocaleString("ko-KR") : "미시작";
      status.innerHTML = `<b>세션</b> <span class="muted">시작:</span> ${started}`;
      const btnStart = el("button","btn small", s.startedAt && !s.endedAt ? "세션 진행중" : "세션 시작");
      btnStart.disabled = !!(s.startedAt && !s.endedAt);
      btnStart.addEventListener("click", ()=>{
        startSessionIfNeeded();
        toast("세션이 시작되었습니다.");
        renderJobsAdmin(root);
      });
      const btnReset = el("button","btn danger small","직업 초기화");
      btnReset.addEventListener("click", ()=>{
        if(!confirm("직업 배정과 수행 기록을 초기화합니다.\n되돌리기 없음. 진행할까요?")) return;
        endSession();
        localStorage.removeItem(JOB_KEYS.assign);
        localStorage.removeItem(JOB_KEYS.nonregular);
        localStorage.removeItem(JOB_KEYS.parttime);
        // RESET: also clear student jobs only (keep other student data)
        try{
          const _st = readJSON(LS.students, []);
          _st.forEach(s=>{ s.jobs = []; });
          localStorage.setItem(LS.students, JSON.stringify(_st));
        }catch(e){}
        localStorage.setItem("sebit:jobsResetDone_v1","1");
        localStorage.removeItem("sebit:jobsAssignConfirmed_v1");
        toast("초기화 완료");
        renderJobsAdmin(root);
      });
      const btnChecklist = el("button","btn small","직업 체크리스트 관리");
      btnChecklist.addEventListener("click", ()=>{
        openJobChecklistHub();
      });
      const btnPayJobReward = el("button","btn small","직업 보상 지급");
      btnPayJobReward.addEventListener("click", payJobRewards);
      const btnSetCitizenReward = el("button","btn small","모범 시민 보상 설정");
      btnSetCitizenReward.addEventListener("click", setCitizenReward);
      const btnPayCitizenReward = el("button","btn small","모범 시민 보상 지급");
      btnPayCitizenReward.addEventListener("click", payModelCitizenReward);
      
      // === job_assign_confirm_button_ui_v1 ===
      const _resetDone = localStorage.getItem("sebit:jobsResetDone_v1")==="1";
      const _confirmed = localStorage.getItem("sebit:jobsAssignConfirmed_v1")==="1";

      const btnConfirm = el("button","btn primary small","직업 배정 확정");
      btnConfirm.disabled = false;

      const guide = el("div","jobs-guide","직업 배정 전에 직업 초기화를 먼저 완료해 주세요.");
      guide.style.fontSize = "12px";
      guide.style.marginLeft = "8px";
      guide.style.color = "#d9534f";
      guide.style.display = "none";

      btnConfirm.addEventListener("click", ()=>{
        startSessionIfNeeded();

        // CONFIRM: sync holders -> students[].jobs (single source: sebit:students)
        const a = getJobAssign();
        let st = readJSON(LS.students, []);
        const byId = new Map(st.map(s=>[s.id, s ]));

        // 1) clear jobs for all students (jobs only)
        st.forEach(s=>{ s.jobs = []; });

        // 2) write jobs for holders (allow multiple jobs)
        let wrote = 0;
        FIXED_JOBS.forEach(j=>{
          const cur = a.jobs?.[j.id];
          const holders = Array.isArray(cur?.holders) ? cur.holders : [];
          holders.forEach(hid=>{
            const s = byId.get(hid);
            if(!s) return;
            if(!Array.isArray(s.jobs)) s.jobs = [];
            if(!s.jobs.includes(j.name)) s.jobs.push(j.name);
            wrote++;
          });
        });

        // partial confirm allowed: if nothing assigned, keep cleared state
        localStorage.setItem(LS.students, JSON.stringify(st));
        localStorage.setItem("sebit:jobsAssignConfirmed_v1","1");

        toast(wrote>0 ? "직업 배정이 저장되었습니다." : "배정된 담당자가 없어 직업을 비웠습니다.");
        renderJobsAdmin(root);
      });
      // === end job_assign_confirm_button_ui_v1 ===

      top.append(status, btnStart, btnReset, btnConfirm, btnPayJobReward, btnSetCitizenReward, btnPayCitizenReward, btnChecklist, guide);


      const fixedWrap = el("div","jobs-section");
      fixedWrap.appendChild(sectionTitle("고정 직업(14)","카드 클릭 → 배정/배치"));
      const grid = el("div","jobs-grid");
      FIXED_JOBS.forEach(j=>{
        const jc = cfg.fixed[j.id] || {cap:1,lumen:50,xp:30,active:true};
        const cur = assign.jobs[j.id] || { holders: [], targetsByHolder: {} };
        const cap = Number(jc.cap||0);
        const rosterLen = roster.length;

        // status 계산
        let badgeCls = "off";
        let badgeText = (cap===0) ? "운영안함" : "미배치";
        if (cap>0){
          if ((cur.holders||[]).length < cap){
            badgeCls = "mid";
            badgeText = `담당자 ${Math.min((cur.holders||[]).length, cap)}/${cap}`;
          } else {
            const assigned = new Set();
            (cur.holders||[]).forEach(h=> (cur.targetsByHolder?.[h]||[]).forEach(id=>assigned.add(id)));
            if (assigned.size === rosterLen){
              badgeCls = "ok";
              badgeText = "배치완료 ✔";
            } else if (assigned.size>0){
              badgeCls = "mid";
              badgeText = `배치중 ${assigned.size}/${rosterLen}`;
            } else {
              badgeCls = "mid";
              badgeText = `배치중 0/${rosterLen}`;
            }
          }
        }

        // 담당자 요약
        const holderNames = (cur.holders||[]).map(id=> roster.find(s=>s.id===id)?.name).filter(Boolean);
        const holderLine = holderNames.length
          ? `담당: ${holderNames.slice(0,2).join(", ")}${holderNames.length>2 ? ` 외 ${holderNames.length-2}명` : ""}`
          : "담당: -";

        const hasImg = (j.id === "lightmerchant");
        const imgHtml = hasImg
          ? `<div class="job-card-img"><img src="assets/jobs/job-lightmerchant.png" alt=""></div>`
          : `<div class="job-card-img"></div>`;

        const box = el("button","job-card", "");
        box.type="button";
        box.innerHTML = `
          ${imgHtml}
          <div class="job-card-main">
            <div class="job-card-topline">
              <div class="job-card-name">${j.name}</div>
              <span class="job-badge ${badgeCls}">${badgeText}</span>
            </div>
            <div class="job-card-meta">
              <span>역할 <b>${cap}</b></span>
              <span class="dot">•</span>
              <span>보상 <b>${jc.lumen}</b>L / <b>${jc.xp}</b>XP</span>
            </div>
            <div class="job-holders">${holderLine}</div>
          </div>
        `;
        box.addEventListener("click", ()=> openJobDetail(j));
        grid.appendChild(box);
      });
      fixedWrap.appendChild(grid);

      const nonWrap = el("div","jobs-section");
      nonWrap.appendChild(sectionTitle("비정규직(최대 5)","세션 직업(합산 2개 제한 적용) / 세션 종료 시 초기화"));
      const nonList = el("div","jobs-list");
      const non = readJSON(JOB_KEYS.nonregular, []);
      const addNonBtn = el("button","btn small","＋ 비정규직 추가");
      addNonBtn.disabled = non.length>=5;
      addNonBtn.addEventListener("click", ()=>{
        const name = prompt("비정규직 이름(활동 내용) 입력");
        if(!name) return;
        const lumen = Number(prompt("보상 루멘 입력", "50")||"50");
        const xp = Number(prompt("보상 XP 입력", "30")||"30");
        const next = [...non, {id:"nr_"+Date.now(), name, lumen, xp, active:true}].slice(0,5);
        localStorage.setItem(JOB_KEYS.nonregular, JSON.stringify(next));
        renderMain();
      });
      nonWrap.appendChild(addNonBtn);
      non.forEach(nr=>{
        const row = el("div","jobs-row");
        row.innerHTML = `
          <div class="jobs-row-main">
            <div class="jobs-row-name">${nr.name}</div>
            <div class="jobs-row-sub">보상 ${nr.lumen}L / ${nr.xp}XP · ${nr.active? "활성":"비활성"}</div>
          </div>
          <div class="jobs-row-actions">
            <button class="chip small" data-act="toggle">${nr.active? "비활성":"활성"}</button>
            <button class="chip small" data-act="edit">수정</button>
          </div>
        `;
        row.querySelector('[data-act="toggle"]').addEventListener("click", ()=>{
          nr.active = !nr.active;
          localStorage.setItem(JOB_KEYS.nonregular, JSON.stringify(non));
          renderMain();
        });
        row.querySelector('[data-act="edit"]').addEventListener("click", ()=>{
          const name = prompt("이름(활동 내용) 수정", nr.name);
          if(!name) return;
          const lumen = Number(prompt("보상 루멘 수정", String(nr.lumen))||nr.lumen);
          const xp = Number(prompt("보상 XP 수정", String(nr.xp))||nr.xp);
          nr.name=name; nr.lumen=lumen; nr.xp=xp;
          localStorage.setItem(JOB_KEYS.nonregular, JSON.stringify(non));
          renderMain();
        });
        nonList.appendChild(row);
      });
      if(non.length===0) nonList.appendChild(el("div","jobs-empty","등록된 비정규직이 없습니다."));
      nonWrap.appendChild(nonList);

      const partWrap = el("div","jobs-section");
      partWrap.appendChild(sectionTitle("일일 알바(하루 최대 5)","지급 전까지 명단 수정 가능 / 지급 후 종료"));
      const today = new Date().toISOString().slice(0,10);
      const ptAll = readJSON(JOB_KEYS.parttime, {});
      const pt = ptAll[today] || [];
      const addPtBtn = el("button","btn small","＋ 알바 추가");
      addPtBtn.disabled = pt.length>=5;
      addPtBtn.addEventListener("click", ()=>{
        const name = prompt("알바 이름 입력");
        if(!name) return;
        const lumen = Number(prompt("알바비(루멘) 입력", "30")||"30");
        const xp = Number(prompt("알바비(XP) 입력", "0")||"0");
        const next = [...pt, {id:"pt_"+Date.now(), name, lumen, xp, participants:[], paid:false}].slice(0,5);
        ptAll[today]=next;
        localStorage.setItem(JOB_KEYS.parttime, JSON.stringify(ptAll));
        renderMain();
      });
      partWrap.appendChild(addPtBtn);
      const ptList = el("div","jobs-list");
      pt.forEach(job=>{
        const row = el("div","jobs-row");
        row.innerHTML = `
          <div class="jobs-row-main">
            <div class="jobs-row-name">${job.name}</div>
            <div class="jobs-row-sub">일급 ${job.lumen}L / ${job.xp}XP · 참여 ${job.participants.length}명 · ${job.paid? "지급완료":"대기"}</div>
          </div>
          <div class="jobs-row-actions">
            <button class="chip small" data-act="pick">참여자</button>
            <button class="chip small" data-act="pay"${job.paid?" disabled":""}>지급하기</button>
          </div>
        `;
        row.querySelector('[data-act="pick"]').addEventListener("click", ()=> openParttimePick(today, job));
        row.querySelector('[data-act="pay"]').addEventListener("click", ()=> {
          if(job.paid) return;
          const names = roster.filter(s=> job.participants.includes(s.id)).map(s=> s.name).join(", ");
          if(!confirm(`지급 대상(${job.participants.length}명):\n${names || "(없음)"}\n\n지급할까요?`)) return;
          job.paid = true;
          ptAll[today]=pt;
          localStorage.setItem(JOB_KEYS.parttime, JSON.stringify(ptAll));
          toast("지급 완료(데이터 기록)");
          renderMain();
        });
        ptList.appendChild(row);
      });
      if(pt.length===0) ptList.appendChild(el("div","jobs-empty","오늘 등록된 알바가 없습니다."));
      partWrap.appendChild(ptList);

      root.append(top, fixedWrap, nonWrap, partWrap);
    };

    const openParttimePick = (dateKey, job) => {
      root.innerHTML = "";
      const top = el("div","jobs-subtop");
      const back = el("button","chip","← 돌아가기");
      back.addEventListener("click", renderMain);
      const title = el("div","jobs-subtitle", `알바 참여자 선택: ${job.name}`);
      top.append(back, title);

      const list = el("div","pick-list");
      roster.forEach(s=>{
        const item = el("button","pick-item");
        item.type="button";
        const on = job.participants.includes(s.id);
        item.classList.toggle("on", on);
        item.innerHTML = `<span class="pick-name">${(s.num? (s.num+" ") : "") + s.name}</span><span class="pick-state">${on? "선택됨":"선택"}</span>`;
        item.addEventListener("click", ()=>{
          const idx = job.participants.indexOf(s.id);
          if(idx>=0) job.participants.splice(idx,1);
          else job.participants.push(s.id);

          const ptAll = readJSON(JOB_KEYS.parttime, {});
          const pt = ptAll[dateKey] || [];
          const found = pt.find(x=>x.id===job.id);
          if(found){
            found.participants = job.participants;
            ptAll[dateKey]=pt;
            localStorage.setItem(JOB_KEYS.parttime, JSON.stringify(ptAll));
            openParttimePick(dateKey, found);
          }else{
            renderMain();
          }
        });
        list.appendChild(item);
      });

      const hint = el("div","jobs-hint","※ 지급하기 전까지 언제든 수정 가능");
      root.append(top, hint, list);
    };

    const openJobDetail = (job) => {
      startSessionIfNeeded();
      cfg = getJobConfig(); assign = getJobAssign();
      const jc = cfg.fixed[job.id] || {cap:1,lumen:50,xp:30,active:true};

      root.innerHTML = "";
      const top = el("div","jobs-subtop");
      const back = el("button","chip","← 직업 목록");
      back.addEventListener("click", renderMain);
      const title = el("div","jobs-subtitle", job.name);
      top.append(back, title);

      const settings = el("div","job-settings");
      settings.innerHTML = `
        <div class="set-row">
          <div class="set-label">정원(배정 인원)</div>
          <input class="set-input" id="jobCapInput" type="number" min="0" max="30" value="${jc.cap}">
        </div>
        <div class="set-row">
          <div class="set-label">보상(루멘/XP)</div>
          <div class="set-inline">
            <input class="set-input" id="jobLumenInput" type="number" min="0" value="${jc.lumen}">
            <input class="set-input" id="jobXpInput" type="number" min="0" value="${jc.xp}">
          </div>
        </div>
      `;
      const btnSave = el("button","btn","설정 저장");
      btnSave.addEventListener("click", ()=>{
        const cap = Math.max(0, Number($("#jobCapInput")?.value||0));
        const lumen = Math.max(0, Number($("#jobLumenInput")?.value||0));
        const xp = Math.max(0, Number($("#jobXpInput")?.value||0));
        cfg.fixed[job.id] = { ...jc, cap, lumen, xp, active: cap>0 };
        saveJobConfig(cfg);
        toast("저장됨");
        openJobDetail(job);
      });

      const cur = assign.jobs[job.id] || { holders: [], targetsByHolder: {} };
      const capNow = jc.cap;
      const pick = el("div","job-pick");
      pick.appendChild(el("div","job-subh","배정(직업 담당 학생) 선택"));
      const list = el("div","pick-list");
      roster.forEach(s=>{
        const on = cur.holders.includes(s.id);
        const disabled = capNow===0;
        const item = el("button","pick-item");
        item.type="button";
        item.disabled = disabled;
        item.classList.toggle("on", on);
        item.innerHTML = `<span class="pick-name">${(s.num? (s.num+" ") : "") + s.name}</span><span class="pick-state">${on? "담당":"선택"}</span>`;
        item.addEventListener("click", ()=>{
          const idx = cur.holders.indexOf(s.id);
          if(idx>=0){
            cur.holders.splice(idx,1);
            delete cur.targetsByHolder[s.id];
          }else{
            if(capNow>0 && cur.holders.length>=capNow){
              toast(`정원 ${capNow}명까지 가능합니다.`);
              return;
            }
            cur.holders.push(s.id);
            cur.targetsByHolder[s.id] = cur.targetsByHolder[s.id] || [];
          }
          assign.jobs[job.id]=cur;
          saveJobAssign(assign);
          openJobDetail(job);
        });
        list.appendChild(item);
      });
      const info = el("div","jobs-hint", capNow===0 ? "※ 정원이 0이면 운영 안 함(배정 불가)" : `※ 현재 ${cur.holders.length}/${capNow}명 선택`);
      pick.append(info, list);

      const btnDistribute = el("button","btn","대상 배치(업무 분배)");
      btnDistribute.disabled = !(capNow>0 && cur.holders.length>0 && cur.holders.length===capNow);
      btnDistribute.addEventListener("click", ()=> openDistribute(job, cur));

      root.append(top, settings, btnSave, pick, btnDistribute);
    };

    const openDistribute = (job, cur) => {
      const holders = cur.holders.slice();
      const rosterIds = roster.map(s=>s.id);

      holders.forEach(h=>{ cur.targetsByHolder[h]=cur.targetsByHolder[h]||[]; });

      let activeHolder = holders[0];

      const isAssignedElsewhere = (sid, holderId) => {
        return holders.some(h=> h!==holderId && (cur.targetsByHolder[h]||[]).includes(sid));
      };
      const allAssigned = () => {
        const assigned = new Set();
        holders.forEach(h=> (cur.targetsByHolder[h]||[]).forEach(id=> assigned.add(id)));
        return assigned.size === rosterIds.length;
      };

      const render = () => {
        root.innerHTML = "";
        const top = el("div","jobs-subtop");
        const back = el("button","chip","← 담당자 선택");
        back.addEventListener("click", ()=> openJobDetail(job));
        const title = el("div","jobs-subtitle", `${job.name} · 대상 배치`);
        top.append(back, title);

        const tabs = el("div","role-tabs");
        holders.forEach((h, idx)=>{
          const nm = roster.find(s=>s.id===h)?.name || `역할 ${idx+1}`;
          const t = el("button","role-tab", `역할 ${idx+1} · ${nm}`);
          t.type="button";
          t.classList.toggle("on", h===activeHolder);
          t.addEventListener("click", ()=> { activeHolder=h; render(); });
          tabs.appendChild(t);
        });

        const list = el("div","pick-list");
        roster.forEach(s=>{
          const on = (cur.targetsByHolder[activeHolder]||[]).includes(s.id);
          const locked = isAssignedElsewhere(s.id, activeHolder);
          const item = el("button","pick-item");
          item.type="button";
          if(locked) item.classList.add("locked");
          item.innerHTML = `<span class="pick-name">${(s.num? (s.num+" ") : "") + s.name}</span><span class="pick-state">${on? "배정됨": locked ? "다른 역할" : "선택"}</span>`;
          item.addEventListener("click", ()=>{
            if(locked) return;
            const arr = cur.targetsByHolder[activeHolder]||[];
            const i = arr.indexOf(s.id);
            if(i>=0) arr.splice(i,1);
            else arr.push(s.id);
            cur.targetsByHolder[activeHolder]=arr;
            render();
          });
          list.appendChild(item);
        });

        const done = el("button","btn","배치 완료");
        done.disabled = !allAssigned();
        done.addEventListener("click", ()=>{
          assign.jobs[job.id]=cur;
          saveJobAssign(assign);
          toast("배치 완료");
          openJobDetail(job);
        });

        const hint = el("div","jobs-hint","※ 학생 1회 배정(다른 역할 배정자는 회색) / 재클릭 시 취소");

        const bulkBar = el("div","bulk-bar");
        const bulkBtn = el("button","chip","전체 선택");
        bulkBtn.type="button";
        bulkBtn.addEventListener("click", ()=>{
          // selectable ids = not assigned to other roles
          const selectable = rosterIds.filter(sid=> !isAssignedElsewhere(sid, activeHolder));
          const curArr = cur.targetsByHolder[activeHolder]||[];
          const allOn = selectable.every(sid=> curArr.includes(sid));
          cur.targetsByHolder[activeHolder] = allOn ? [] : selectable.slice();
          render();
        });
        bulkBar.appendChild(bulkBtn);

        root.append(top, tabs, hint, bulkBar, list, done);
      };

      render();
    };

    renderMain();
  };

  
  // === Admin Modal: Shop Management (Teacher) ===
  const renderShopAdmin = (root) => {
    if(!root) return;
    if(!document.getElementById("shopImagePreviewStyle")){
      const st = document.createElement("style");
      st.id = "shopImagePreviewStyle";
      st.textContent = `
        .shop-thumb{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fff;border:1px solid rgba(0,0,0,.08);}
        .shop-thumb img,.shop-thumb-img{width:100%;height:100%;object-fit:cover;display:block;}
        .shop-imgpick{width:44px;height:44px;padding:3px;border-radius:12px;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;background:#fff;}
        .shop-imgpick-img{width:100%;height:100%;object-fit:cover;border-radius:9px;display:block;}
        .shop-imgpick.selected{outline:3px solid rgba(80,150,255,.35);}
      `;
      document.head.appendChild(st);
    }

    const nowTs = ()=> new Date().toISOString();

    const normalizeProduct = (p) => ({
      id: p?.id || ("p_" + Math.random().toString(36).slice(2,10)),
      name: (p?.name || "").trim(),
      imgId: Number.isFinite(p?.imgId) ? p.imgId : 0,
      category: (p?.category || "간식").trim(),
      price: Math.max(0, Number(p?.price||0)),
      stock: Math.max(0, Number(p?.stock||0)),
      desc: (p?.desc || "").trim(),
      isPublished: (p?.isPublished === false ? false : true) // default true
    });

    const computeStatus = (p) => {
      if ((p.stock||0) <= 0) return "품절";
      if (p.isPublished === false) return "판매중단";
      return "판매중";
    };

    const saveProducts = (arr) => writeJSON(LS.shopProducts, arr);
    const savePurchases = (arr) => writeJSON(LS.shopPurchaseLog, arr);
    let editingId = null;

    const fillShopForm = (p) => {
      if(!root || !p) return;
      editingId = p.id;
      const nameEl = root.querySelector("#shopName");
      const categoryEl = root.querySelector("#shopCategory");
      const priceEl = root.querySelector("#shopPrice");
      const stockEl = root.querySelector("#shopStock");
      const descEl = root.querySelector("#shopDesc");
      const modeEl = root.querySelector("#shopFormMode");
      const submitEl = root.querySelector("#shopAddBtn");
      const cancelEl = root.querySelector("#shopCancelEditBtn");
      if(nameEl) nameEl.value = p.name || "";
      if(categoryEl) categoryEl.value = p.category || "간식";
      if(priceEl) priceEl.value = Number(p.price || 0);
      if(stockEl) stockEl.value = Number(p.stock || 0);
      if(descEl) descEl.value = p.desc || "";
      const nextImg = Number(p.imgId || 0);
      root._shopSelectedImg = nextImg;
      [...root.querySelectorAll(".shop-imgpick")].forEach(el=>el.classList.toggle("selected", el.dataset.img===String(nextImg)));
      if(modeEl) modeEl.textContent = "수정 모드";
      if(submitEl) submitEl.textContent = "수정 저장";
      if(cancelEl) cancelEl.style.display = "inline-flex";
    };

    const resetShopForm = () => {
      editingId = null;
      const nameEl = root.querySelector("#shopName");
      const categoryEl = root.querySelector("#shopCategory");
      const priceEl = root.querySelector("#shopPrice");
      const stockEl = root.querySelector("#shopStock");
      const descEl = root.querySelector("#shopDesc");
      const modeEl = root.querySelector("#shopFormMode");
      const submitEl = root.querySelector("#shopAddBtn");
      const cancelEl = root.querySelector("#shopCancelEditBtn");
      if(nameEl) nameEl.value = "";
      if(categoryEl) categoryEl.value = "간식";
      if(priceEl) priceEl.value = 0;
      if(stockEl) stockEl.value = 0;
      if(descEl) descEl.value = "";
      root._shopSelectedImg = 0;
      [...root.querySelectorAll(".shop-imgpick")].forEach(el=>el.classList.toggle("selected", el.dataset.img==="0"));
      if(modeEl) modeEl.textContent = "등록 모드";
      if(submitEl) submitEl.textContent = "등록";
      if(cancelEl) cancelEl.style.display = "none";
    };

    const render = () => {
      root.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "shop-admin-wrap";

      const products = readJSON(LS.shopProducts, []);
      const purchases = readJSON(LS.shopPurchaseLog, []);


      const top = document.createElement("div");
      top.className = "shop-admin-top";
      top.innerHTML = `
        <div class="shop-admin-title">
          <div class="shop-admin-h">상점 관리</div>
          <div class="shop-admin-sub">상태 3가지(판매중/판매중단/품절) · 품절/중단은 학생 상점에서 회색 처리</div>
        </div>
        <div class="shop-admin-actions">
          <button type="button" class="btn btn-ghost" id="shopPreviewBtn">학생 상점 미리보기</button>
        </div>
      `;

      const grid = document.createElement("div");
      grid.className = "shop-admin-grid";

      // Left: product list
      const left = document.createElement("div");
      left.className = "shop-panel";
      left.innerHTML = `
        <div class="shop-panel-h">
          <div>상품 목록</div>
          <div class="muted">총 ${products.length}개</div>
        </div>
        <div class="shop-panel-b">
          <table class="shop-table">
            <thead>
              <tr>
                <th style="width:44px;">No</th>
                <th>상품</th>
                <th style="width:90px;">가격</th>
                <th style="width:90px;">재고</th>
                <th style="width:110px;">상태</th>
                <th style="width:220px;">제어</th>
              </tr>
            </thead>
            <tbody id="shopProductTbody"></tbody>
          </table>
          <div class="muted" style="margin-top:10px;">
            ※ 품절은 재고 0 자동 · 재고 보충 후에도 ‘판매재개’ 눌러야 판매됨
          </div>
        </div>
      `;

      // Right: register form
      const right = document.createElement("div");
      right.className = "shop-panel";
      right.innerHTML = `
        <div class="shop-panel-h"><div>상품 등록</div><div class="muted" id="shopFormMode">등록 모드</div></div>
        <div class="shop-panel-b">
          <div class="shop-form">
            <label class="shop-field"><span>상품명</span><input id="shopName" type="text" placeholder="예: 숙제 면제권 1장" /></label>
<label class="shop-field"><span>카테고리</span>
  <select id="shopCategory" class="shop-select">
    <option value="간식">간식</option>
    <option value="쿠폰">쿠폰</option>
    <option value="학용품">학용품</option>
    <option value="특별">특별</option>
  </select>
</label>
            <div class="shop-field">
              <span>상품 이미지</span>
              <div class="shop-imggrid" id="shopImgGrid"></div>
            </div>
            <div class="shop-form-row">
              <label class="shop-field"><span>가격(루멘)</span><input id="shopPrice" type="number" min="0" step="1" value="0"/></label>
              <label class="shop-field"><span>재고</span><input id="shopStock" type="number" min="0" step="1" value="0"/></label>
            </div>
            <label class="shop-field"><span>설명(선택)</span><textarea id="shopDesc" rows="3" placeholder="선택 입력"></textarea></label>
            <div class="shop-form-actions">
              <button type="button" class="btn" id="shopAddBtn">등록</button>
              <button type="button" class="btn btn-ghost" id="shopCancelEditBtn" style="display:none;">취소</button>
            </div>
          </div>
        </div>
      `;

      const bottom = document.createElement("div");
      bottom.className = "shop-panel";
      bottom.innerHTML = `
        <div class="shop-panel-h"><div>구매 기록 (최근 50)</div><div class="muted">구매 성공만</div></div>
        <div class="shop-panel-b">
          <table class="shop-table">
            <thead><tr><th style="width:44px;">No</th><th>학생</th><th>상품</th><th style="width:160px;">시각</th></tr></thead>
            <tbody id="shopPurchaseTbody"></tbody>
          </table>
        </div>
      `;

      grid.appendChild(left);
      grid.appendChild(right);

      wrap.appendChild(top);
      wrap.appendChild(grid);
      wrap.appendChild(bottom);

      root.appendChild(wrap);

      // build product rows
      const tbody = root.querySelector("#shopProductTbody");
      products.forEach((raw, idx)=> {
        const p = normalizeProduct(raw);
        const status = computeStatus(p);
        const tr = document.createElement("tr");

        const badgeClass = status === "판매중" ? "badge-good" : (status === "품절" ? "badge-warn" : "badge-stop");
        const ctlHtml = (() => {
          const publishBtn = status === "판매중"
            ? `<button class="btn btn-small" data-act="stop" data-id="${p.id}">판매중단</button>`
            : (status === "판매중단"
                ? `<button class="btn btn-small" data-act="resume" data-id="${p.id}">판매재개</button>`
                : `<button class="btn btn-small" disabled>품절</button>`);
          return `${publishBtn} <button class="btn btn-small btn-ghost" data-act="edit" data-id="${p.id}">수정</button> <button class="btn btn-small btn-ghost" data-act="delete" data-id="${p.id}">삭제</button>`;
        })();

        tr.innerHTML = `
          <td>${idx+1}</td>
          <td>
            <div class="shop-prod">
              <div class="shop-thumb">${shopImgTag(p.imgId)}</div>
              <div class="shop-prod-txt">
                <div class="shop-prod-name">${escapeHTML(p.name||"(이름 없음)")}</div>
                ${p.desc ? `<div class="shop-prod-desc">${escapeHTML(p.desc)}</div>` : ``}
              </div>
            </div>
          </td>
          <td>${p.price}</td>
          <td>${p.stock}</td>
          <td><span class="shop-badge ${badgeClass}">${status}</span></td>
          <td>${ctlHtml}</td>
        `;
        tbody.appendChild(tr);
      });

      // purchase rows (latest 50)
      const pbody = root.querySelector("#shopPurchaseTbody");
      const latest = [...purchases].slice(-50).reverse();
      latest.forEach((it, idx)=> {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${idx+1}</td>
          <td>${escapeHTML(it.studentName || it.student || "-")}</td>
          <td>${escapeHTML(it.productName || it.product || "-")}</td>
          <td class="mono">${escapeHTML(it.ts || "-")}</td>
        `;
        pbody.appendChild(tr);
      });

      // image grid 10
      let selectedImg = Number(root._shopSelectedImg ?? 0);
      const imgGrid = root.querySelector("#shopImgGrid");
      for(let i=0;i<10;i++){
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "shop-imgpick" + (i===selectedImg ? " selected" : "");
        btn.dataset.img = String(i);
        btn.title = `상품 이미지 ${i+1}`;
        btn.innerHTML = shopImgTag(i, "shop-imgpick-img", "상품 이미지");
        btn.addEventListener("click", ()=>{
          selectedImg = i;
          root._shopSelectedImg = i;
          [...imgGrid.querySelectorAll(".shop-imgpick")].forEach(el=>el.classList.toggle("selected", el.dataset.img===String(i)));
        });
        imgGrid.appendChild(btn);
      }

      // actions
      root.querySelector("#shopAddBtn")?.addEventListener("click", ()=>{
        const name = (root.querySelector("#shopName")?.value || "").trim();
        const price = Number(root.querySelector("#shopPrice")?.value || 0);
        const stock = Number(root.querySelector("#shopStock")?.value || 0);
        const desc = (root.querySelector("#shopDesc")?.value || "").trim();
        const category = (root.querySelector("#shopCategory")?.value||"간식");
        const currentImg = Number(root._shopSelectedImg ?? selectedImg ?? 0);
        if(!name){ alert("상품명을 입력하세요"); return; }
        const list = readJSON(LS.shopProducts, []).map(normalizeProduct);
        if(editingId){
          const i = list.findIndex(x=>x.id===editingId);
          if(i < 0){ alert("수정할 상품을 찾을 수 없어요."); return; }
          list[i] = normalizeProduct({
            ...list[i],
            name,
            category,
            imgId: currentImg,
            price,
            stock,
            desc,
            isPublished: stock <= 0 ? false : list[i].isPublished
          });
          saveProducts(list);
        }else{
          const p = normalizeProduct({ name, category, imgId: currentImg, price, stock, desc, isPublished:true });
          saveProducts([...list, p]);
        }
        render();
      });

      root.querySelector("#shopCancelEditBtn")?.addEventListener("click", ()=>{
        resetShopForm();
      });

      root.querySelector("#shopPreviewBtn")?.addEventListener("click", ()=>{
        openStudentShopPreviewModal();
      });

      resetShopForm();

      // delegate stop/resume/edit/delete (bind once)
      if(!root._shopAdminDelegated){
      root._shopAdminDelegated = true;
      root.addEventListener("click", (e)=>{
        const btn = e.target.closest("button[data-act]");
        if(!btn) return;
        const act = btn.dataset.act;
        const id = btn.dataset.id;
        const list = readJSON(LS.shopProducts, []).map(normalizeProduct);
        const i = list.findIndex(x=>x.id===id);
        if(i<0) return;
        if(act==="stop"){
          list[i].isPublished = false;
          saveProducts(list);
          render();
          return;
        } else if(act==="resume"){
          if((list[i].stock||0) <= 0){ alert("재고가 0이면 판매재개할 수 없어요."); return; }
          list[i].isPublished = true;
          saveProducts(list);
          render();
          return;
        } else if(act==="edit"){
          fillShopForm(list[i]);
          return;
        } else if(act==="delete"){
          if(!confirm(`'${list[i].name||"상품"}' 상품을 삭제할까요?`)) return;
          const next = list.filter(x=>x.id!==id);
          saveProducts(next);
          if(editingId===id) editingId = null;
          render();
          return;
        }
      });
      }
    };

    render();
  };

/* === Admin: Penalty Records (Menu 2) === */
function renderPenaltyAdmin(root){
  if(!root) return;
  // layout
  const wrap = document.createElement('div');
  wrap.className = 'penalty-admin';

  const top = document.createElement('div');
  top.className = 'penalty-topbar';
  top.innerHTML = `
    <div class="penalty-top-left">
      <div class="muted" style="font-size:12px;">학생 이름을 클릭하면 해당 학생의 최신 벌점 기록 10개만 표시합니다.</div>
    </div>
    <div class="penalty-top-right">
      <button class="btn" id="penaltyPosterBtn" type="button">세빛 헌법 포스터 보러가기</button>
    </div>
  `;

  const grid = document.createElement('div');
  grid.className = 'penalty-grid';
  grid.innerHTML = `
    <div class="penalty-col penalty-students">
      <div class="penalty-col-title">학생</div>
      <div class="penalty-student-list" id="penaltyStudentList"></div>
    </div>
    <div class="penalty-col penalty-logs">
      <div class="penalty-col-title" id="penaltyLogTitle">벌점 기록</div>
      <div class="penalty-log-list" id="penaltyLogList"></div>
    </div>
  `;

  wrap.appendChild(top);
  wrap.appendChild(grid);
  root.appendChild(wrap);

  const st = readJSON(LS.students, []);
  let all = getAllPenaltyLogs().filter(x=>String(x.status||"applied") === "applied");
  // latest first (global)
  all.sort((a,b)=> (Number(b.ts||0)-Number(a.ts||0)));

  const $studentList = root.querySelector('#penaltyStudentList');
  const $logList = root.querySelector('#penaltyLogList');
  const $logTitle = root.querySelector('#penaltyLogTitle');

  const fmtTime = (ts)=>{
    try{
      const d = new Date(Number(ts||0));
      const hh = String(d.getHours()).padStart(2,'0');
      const mm = String(d.getMinutes()).padStart(2,'0');
      const ss = String(d.getSeconds()).padStart(2,'0');
      return `${hh}:${mm}:${ss}`;
    }catch(_){ return ""; }
  };
  const fmtDate = (ts)=>{
    try{
      const d = new Date(Number(ts||0));
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const da = String(d.getDate()).padStart(2,'0');
      return `${y}-${m}-${da}`;
    }catch(_){ return ""; }
  };

  const byStudent = new Map();
  all.forEach(it=>{
    const sid = String(it.studentId||"");
    if(!sid) return;
    if(!byStudent.has(sid)) byStudent.set(sid, []);
    byStudent.get(sid).push(it);
  });

  const getStudentLabel = (sid)=>{
    const s = st.find(x=>String(x.id)===String(sid));
    if(!s) return sid;
    const name = s.name || sid;
    const num = s.no || s.number || s.num || "";
    const klass = s.class || s.className || s.klass || "";
    const prefix = (klass||num) ? `[${klass}${klass&&num?'-':''}${num}] ` : "";
    return prefix + name;
  };

  let selectedStudentId = null;

  const renderStudents = ()=>{
    if(!$studentList) return;
    $studentList.innerHTML = "";
    const sids = st.map(s=>s.id).filter(Boolean);
    // show only students that exist in roster
    sids.forEach(sid=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'penalty-student-item' + (sid===selectedStudentId ? ' active' : '');
      const cnt = (byStudent.get(sid)||[]).length;
      btn.innerHTML = `<div class="name">${escapeHTML(getStudentLabel(sid))}</div><div class="count">${cnt}</div>`;
      btn.addEventListener('click', ()=>{
        selectedStudentId = sid;
        renderStudents();
        renderLogs();
      });
      $studentList.appendChild(btn);
    });
  };

  const cancelLog = (logId)=>{
    const store = getPenaltyStore();
    const idx = store.logs.findIndex(x=>String(x.id||"")===String(logId));
    if(idx<0) return;
    const it = store.logs[idx];
    if(String(it.status||"applied") === "canceled") return;
    const ok = confirm(`벌점 취소(반환)하시겠습니까?\n\n${getStudentLabel(it.studentId)}\n${it.ruleTitle || it.articleText || it.articleTitle || ""}\n-${Math.abs(Number(it.lumen||0))}루멘 / -${Math.abs(Number(it.xp||0))}XP`);
    if(!ok) return;
    // revert student values
    revertPenaltyToStudent(it.studentId, Number(it.lumen||0), Number(it.xp||0));
    // 기록은 삭제하지 않고 취소 상태로 표시(중복 반환 방지)
    store.logs[idx] = {...it, status:"canceled", canceledTs:Date.now()};
    savePenaltyStore(store);
    toast('취소(반환)되었습니다.');
    // refresh local caches
    all = getAllPenaltyLogs().filter(x=>String(x.status||"applied") === "applied");
    byStudent.clear();
    all.forEach(v=>{
      const sid = String(v.studentId||"");
      if(!sid) return;
      if(!byStudent.has(sid)) byStudent.set(sid, []);
      byStudent.get(sid).push(v);
    });
    renderStudents();
    renderLogs();
  };

  const renderLogs = ()=>{
    if(!$logList) return;
    $logList.innerHTML = "";
    if(!selectedStudentId){
      if($logTitle) $logTitle.textContent = "벌점 기록";
      $logList.innerHTML = `<div class="muted" style="padding:10px;">왼쪽에서 학생을 선택하세요.</div>`;
      return;
    }
    const logs = (byStudent.get(selectedStudentId)||[]).slice().sort((a,b)=>Number(b.ts||0)-Number(a.ts||0)).slice(0,10);
    if($logTitle) $logTitle.textContent = `${getStudentLabel(selectedStudentId)} · 최신 10개`;
    if(!logs.length){
      $logList.innerHTML = `<div class="muted" style="padding:10px;">기록이 없습니다.</div>`;
      return;
    }
    logs.forEach(it=>{
      const row = document.createElement('div');
      row.className = 'penalty-log-item';
      const article = it.ruleTitle || it.articleText || it.articleTitle || '';
      const lum = Math.abs(Number(it.lumen||0));
      const xp = Math.abs(Number(it.xp||0));
      row.innerHTML = `
        <div class="meta">
          <div class="time">${escapeHTML(fmtDate(it.ts))} ${escapeHTML(fmtTime(it.ts))}</div>
          <div class="amount">-${lum}루멘 · -${xp}XP</div>
        </div>
        <div class="article">${escapeHTML(article)}</div>
        <div class="actions">
          <button class="chip danger" type="button" data-cancel="${escapeHTML(String(it.id||''))}">취소</button>
        </div>
      `;
      row.querySelector('[data-cancel]')?.addEventListener('click', ()=> cancelLog(it.id));
      $logList.appendChild(row);
    });
  };

  // poster view (read-only inside modal)
  root.querySelector('#penaltyPosterBtn')?.addEventListener('click', ()=>{
    const modal = document.createElement('div');
    modal.className = 'penalty-poster-modal';
    const state = getConstitutionState();
    const html = renderConstitutionReadOnlyHTML(state);
    modal.innerHTML = `
      <div class="penalty-poster-card">
        <header class="penalty-poster-top">
          <div class="penalty-poster-title">세빛 헌법 포스터 (읽기 전용)</div>
          <button class="chip" type="button" id="closePenaltyPosterBtn">닫기</button>
        </header>
        <div class="penalty-poster-body">${html}</div>
      </div>
    `;
    modal.addEventListener('click', (e)=>{ if(e.target===modal) modal.remove(); });
    modal.querySelector('#closePenaltyPosterBtn')?.addEventListener('click', ()=> modal.remove());
    document.body.appendChild(modal);
  });

  // initial
  renderStudents();
  renderLogs();
}

function renderConstitutionReadOnlyHTML(state){
  try{
    const c = state || DEFAULT_CONSTITUTION;
    const cats = Array.isArray(c.categories)? c.categories : [];
    let out = '';
    cats.forEach(cat=>{
      out += `<div class="poster-cat"><div class="poster-cat-title">${escapeHTML(cat.name||'')}</div>`;
      const items = Array.isArray(cat.items)? cat.items : [];
      items.forEach((it, idx)=>{
        if(it) { it.num = idx + 1; it.label = `제${idx + 1}조`; }
      });
      items.filter(it=>it.active!==false).forEach(it=>{
        const t = [it.label||'', it.title||''].filter(Boolean).join(' ');
        const d = it.desc || '';
        const lum = Number(it.lumen||0);
        const xp = Number(it.xp||0);
        out += `<div class="poster-item">
          <div class="poster-item-title">${escapeHTML(t)}</div>
          <div class="poster-item-desc">${escapeHTML(d)}</div>
          <div class="poster-item-points">-${Math.abs(lum)}루멘 · -${Math.abs(xp)}XP</div>
        </div>`;
      });
      out += `</div>`;
    });
    return out || '<div class="muted">표시할 조항이 없습니다.</div>';
  } catch(_){
    return '<div class="muted">표시 오류</div>';
  }
}



// === Quest Roster helpers (Admin) ===
function questRosterStats(q){
  const students = readJSON(LS.students, []);
  const completedRaw = q?.completedIds || q?.completed || q?.completedStudents || [];
  const completedAtMap = {};
  // 지원 형태:
  // 1) [id,id,...]
  // 2) { [id]: true | number(ms) | {doneAt/completedAt/ts/...} }
  if(completedRaw && typeof completedRaw === "object" && !Array.isArray(completedRaw)){
    Object.keys(completedRaw).forEach((k)=>{
      const v = completedRaw[k];
      let ts = null;
      if(typeof v === "number") ts = v;
      else if(v && typeof v === "object"){
        ts = v.doneAt ?? v.completedAt ?? v.ts ?? v.time ?? v.t ?? v.at ?? null;
      }
      if(ts!=null) completedAtMap[String(k)] = Number(ts);
    });
  }

  const completedSet = new Set(
    Array.isArray(completedRaw) ? completedRaw.map(String)
      : (completedRaw && typeof completedRaw === "object") ? Object.keys(completedRaw).map(String)
      : []
  );
  const total = Array.isArray(students) ? students.length : 0;
  const done = total ? students.filter(s=>completedSet.has(String(s?.id||""))).length : 0;
  return { total, done, completedSet, completedAtMap, students };
}

function ensureQuestRosterAdminModal(){
  if(document.getElementById("questRosterAdminModal")) return;
  const wrap = document.createElement("div");
  wrap.className = "modal quest-roster-modal hidden";
  wrap.id = "questRosterAdminModal";
  wrap.setAttribute("role","dialog");
  wrap.setAttribute("aria-modal","true");
  wrap.setAttribute("aria-label","퀘스트 완료자/미완료자 명단");
  wrap.innerHTML = `
    <div class="modal-card roster-card">
      <div class="roster-top">
        <div class="roster-title">완료자/미완료자 명단</div>
        <button class="roster-close" type="button" aria-label="닫기">✕</button>
      </div>
      <div class="roster-sub" id="questRosterAdminSub"></div>
      <div class="roster-tabs">
        <button class="roster-tab active" type="button" data-roster-tab="done">완료자 (0)</button>
        <button class="roster-tab" type="button" data-roster-tab="todo">미완료자 (0)</button>
      </div>
      <div class="roster-list" id="questRosterAdminList"></div>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = ()=>{ wrap.classList.add("hidden"); document.body.classList.remove('no-scroll'); };
  wrap.addEventListener("click",(e)=>{ if(e.target===wrap) close(); });
  wrap.querySelector(".roster-close")?.addEventListener("click",(e)=>{ e.preventDefault(); close(); });
  wrap.addEventListener("click",(e)=>{
    const btn = e.target.closest("[data-roster-tab]");
    if(!btn) return;
    const tab = btn.dataset.rosterTab;
    const qid = wrap.dataset.qid;
    if(!qid) return;
    renderQuestRosterAdmin(qid, tab);
  });
}

function renderQuestRosterAdmin(qid, tab){
  ensureQuestRosterAdminModal();
  const modal = document.getElementById("questRosterAdminModal");
  const sub = document.getElementById("questRosterAdminSub");
  const list = document.getElementById("questRosterAdminList");
  if(!modal || !list) return;

  const q = readQuests().find(x=>String(x.id)===String(qid));
  const stats = questRosterStats(q||{});
  const students = stats.students || [];
  const completedSet = stats.completedSet || new Set();
  const completedAtMap = stats.completedAtMap || {};

  const done = students.filter(s=>completedSet.has(String(s?.id||"")));
  const todo = students.filter(s=>!completedSet.has(String(s?.id||"")));

  const safeTitle = escapeHTML(String(q?.title||""));
  if(sub) sub.innerHTML = `<span class="qname">${safeTitle}</span> <span class="qcount">완료 ${done.length} / 전체 ${students.length}</span>`;

  const tabs = modal.querySelectorAll(".roster-tab");
  tabs.forEach(t=>{
    const is = (t.dataset.rosterTab === String(tab||"done"));
    t.classList.toggle("active", is);
  });
  const doneBtn = modal.querySelector('[data-roster-tab="done"]');
  const todoBtn = modal.querySelector('[data-roster-tab="todo"]');
  if(doneBtn) doneBtn.textContent = `완료자 (${done.length})`;
  if(todoBtn) todoBtn.textContent = `미완료자 (${todo.length})`;

  const arr = (String(tab||"done")==="todo") ? todo : done;

  const avatar = (s)=>{
    const v = String(s?.char || s?.avatar || s?.emoji || "").trim();
    if(v) return escapeHTML(v);
    const nm = String(s?.name||"").trim();
    return escapeHTML(nm ? nm[0] : "•");
  };

  const fmtHHMM = (ts)=>{
    if(ts===undefined || ts===null || ts==="") return "";
    const d = new Date(Number(ts));
    if(isNaN(d.getTime())) return "";
    const hh = String(d.getHours()).padStart(2,"0");
    const mm = String(d.getMinutes()).padStart(2,"0");
    return `${hh}:${mm}`;
  };

if(!arr.length){
    list.innerHTML = `<div class="muted" style="padding:14px;opacity:.7;">표시할 학생이 없습니다.</div>`;
    return;
  }

  list.innerHTML = arr.map(s=>{
    const nm = escapeHTML(String(s?.name||""));
    return `
      <div class="roster-item">
        <div class="roster-avatar">${avatar(s)}</div>
        <div class="roster-name">${nm}</div>
        ${String(tab||"done")==="todo" ? "" : `<div class="roster-time">${escapeHTML(fmtHHMM(completedAtMap[String(s?.id||"")] ))}</div>`}
        <div class="roster-mark">${String(tab||"done")==="todo" ? "✕" : "✓"}</div>
      </div>
    `;
  }).join("");
}

function openQuestRosterAdminModal(qid){
  ensureQuestRosterAdminModal();
  const modal = document.getElementById("questRosterAdminModal");
  if(!modal) return;
  modal.dataset.qid = String(qid||"");
  document.body.classList.add('no-scroll');
  modal.classList.remove("hidden");
  renderQuestRosterAdmin(qid, "done");
}
// === /Quest Roster helpers (Admin) ===

  // === Admin Modal: Quests Management (Teacher) ===
  const renderQuestsAdmin = (root) => {
    if(!root) return;

    const state = root.__questsState || {
      mode: "list", // list | wizard
      step: 1,
      filter: "all", // all | active | ended | rewarded
      draft: { title:"", desc:"", lumen:0, xp:0, type:"manual", start:"", end:"" },
    };
    root.__questsState = state;

    const statusLabel = (s)=>{
      if(s==="active") return {t:"진행중", cls:"on"};
      if(s==="paused") return {t:"일시중단", cls:"off"};
      if(s==="ended") return {t:"종료", cls:"end"};
      if(s==="rewarded") return {t:"지급완료", cls:"done"};
      return {t:"-", cls:"off"};
    };
    const typeLabel = (t)=> (t==="period" ? "기간형" : "수동형");

    const load = ()=> readQuests();
    const save = (arr)=> writeQuests(arr);

    const setMode = (m)=>{ state.mode=m; render(); };
    const setStep = (n)=>{ state.step=n; render(); };

    const h = (s)=> escapeHTML(s);

    const renderList = ()=>{
      const quests = load();

      root.innerHTML = `
        <div class="quests-admin">
          <div class="quests-frame">
            <div class="quests-head">
              <h3>퀘스트 생성</h3>
              <div class="qhead-actions">
                <button class="qbtn" type="button" data-qfilter="all">전체</button>
                <button class="qbtn" type="button" data-qfilter="active">진행</button>
                <button class="qbtn" type="button" data-qfilter="ended">종료</button>
                <button class="qbtn" type="button" data-qfilter="rewarded">지급완료</button>
              </div>
            </div>
            <div class="quests-body" id="qListBody"></div>
            <div class="qfoot">
              <div class="left"></div>
              <div class="right">
                <button class="qbtn primary" type="button" data-qnew>새로운 퀘스트 만들기</button>
              </div>
            </div>
          </div>
        </div>
      `;

      const body = root.querySelector("#qListBody");
      const filt = state.filter || "all";
      const filtered = quests.filter(q=>{
        if(filt==="all") return true;
        if(filt==="active") return (q.status==="active" || q.status==="paused");
        if(filt==="ended") return q.status==="ended";
        if(filt==="rewarded") return q.status==="rewarded";
        return true;
      });

      if(!filtered.length){
        body.innerHTML = `<div class="muted" style="font-weight:1000;opacity:.75;padding:10px;">표시할 퀘스트가 없습니다.</div>`;
        return;
      }

      body.innerHTML = filtered.map(q=>{
        const st = statusLabel(q.status);
        const rewards = `루멘 ${Number(q.lumen||0).toLocaleString()} / XP ${Number(q.xp||0).toLocaleString()}`;
        const range = (q.type==="period" && q.start && q.end) ? `${h(q.start)} ~ ${h(q.end)}` : "";
        const stats = questRosterStats(q);
        const doneCnt = stats.done;
        const totalCnt = stats.total;
        const endDisabled = (q.status==="ended" || q.status==="rewarded");
        const toggleDisabled = (q.status==="ended" || q.status==="rewarded");
        const payDisabled = (q.status!=="ended" || !!q.rewardPaid);

        const toggleText = (q.status==="paused") ? "활성화" : "중단";
        const payText = q.rewardPaid ? "지급완료" : "보상지급";

        return `
          <div class="qcard" data-qid="${h(q.id)}">
            <div class="qavatar" aria-hidden="true">🐾</div>
            <div class="qmeta">
              <div class="qtitle">${h(q.title||"")}</div>
              <div class="qdesc">${h(q.desc||"")}</div>
              <div class="qrow">
                <span class="qbadge ${st.cls}">${st.t}</span>
                <span class="qbadge">${typeLabel(q.type)}</span>
                <span class="qbadge">${h(rewards)}</span>
                ${range ? `<span class="qbadge">${range}</span>` : ``}
              </div>
              <div class="qcountline"><button class="qbtn ghost" type="button" data-qroster>완료자 ${doneCnt} / 전체 ${totalCnt}</button></div>
            </div>
            <div class="qactions">
              <button class="qbtn" type="button" data-qroster>명단</button>
              <button class="qbtn" type="button" data-qtoggle ${toggleDisabled?'disabled':''}>${toggleText}</button>
              <button class="qbtn" type="button" data-qend ${endDisabled?'disabled':''}>종료</button>
              <button class="qbtn" type="button" data-qpay ${payDisabled?'disabled':''}>${payText}</button>
              <button class="qbtn danger" type="button" data-qdel>삭제</button>
            </div>
          </div>
        `;
      }).join("");
    };

    const renderWizard = ()=>{
      const d = state.draft || (state.draft = { title:"", desc:"", lumen:0, xp:0, type:"manual", start:"", end:"" });
      const step = state.step || 1;

      root.innerHTML = `
        <div class="quests-admin">
          <div class="quests-frame">
            <div class="quests-head">
              <h3>퀘스트 생성</h3>
              <div class="qsteps">
                <div class="qstep ${step===1?'active':''}" data-qstep="1">1 기본 정보</div>
                <div class="qstep ${step===2?'active':''}" data-qstep="2">2 보상·유형 설정</div>
                <div class="qstep ${step===3?'active':''}" data-qstep="3">3 설정 확인</div>
              </div>
            </div>
            <div class="quests-body">
              ${step===1 ? `
                <div class="qform">
                  <div class="qfield">
                    <label>퀘스트 제목</label>
                    <input type="text" maxlength="40" value="${h(d.title)}" data-draft="title" placeholder="퀘스트 제목을 입력하세요."/>
                  </div>
                  <div class="qfield">
                    <label>퀘스트 설명</label>
                    <textarea data-draft="desc" maxlength="200" placeholder="퀘스트 설명을 입력하세요.">${h(d.desc)}</textarea>
                  </div>
                </div>
              ` : ``}

              ${step===2 ? `
                <div class="qform">
                  <div class="qreward">
                    <div class="qreward-row">
                      <div>루멘</div>
                      <input type="number" min="0" step="1" value="${Number(d.lumen||0)}" data-draft="lumen"/>
                      <div style="display:flex;gap:8px;">
                        <button class="qbtn" type="button" data-add="lumen" data-inc="100">+100</button>
                      </div>
                    </div>
                    <div class="qreward-row">
                      <div>XP</div>
                      <input type="number" min="0" step="1" value="${Number(d.xp||0)}" data-draft="xp"/>
                      <div style="display:flex;gap:8px;">
                        <button class="qbtn" type="button" data-add="xp" data-inc="50">+50</button>
                      </div>
                    </div>
                  </div>

                  <div class="qtoggle">
                    <button class="qbtn ${d.type==='period'?'primary':''}" type="button" data-type="period">기간형</button>
                    <button class="qbtn ${d.type==='manual'?'primary':''}" type="button" data-type="manual">수동형</button>
                  </div>

                  <div class="qgrid2" ${d.type==='period' ? '' : 'style="opacity:.45;pointer-events:none;"'}>
                    <div class="qfield">
                      <label>시작일</label>
                      <input type="date" value="${h(d.start||'')}" data-draft="start"/>
                    </div>
                    <div class="qfield">
                      <label>종료일</label>
                      <input type="date" value="${h(d.end||'')}" data-draft="end"/>
                    </div>
                  </div>
                </div>
              ` : ``}

              ${step===3 ? `
                <div class="qform">
                  <div class="qrow">
                    <span class="qbadge">제목</span><span style="font-weight:1000;">${h(d.title||'')}</span>
                  </div>
                  <div class="qrow">
                    <span class="qbadge">설명</span><span style="font-weight:1000;">${h(d.desc||'')}</span>
                  </div>
                  <div class="qrow">
                    <span class="qbadge">보상</span><span style="font-weight:1000;">루멘 ${Number(d.lumen||0).toLocaleString()} / XP ${Number(d.xp||0).toLocaleString()}</span>
                  </div>
                  <div class="qrow">
                    <span class="qbadge">유형</span><span style="font-weight:1000;">${typeLabel(d.type)}</span>
                  </div>
                  ${d.type==='period' ? `
                    <div class="qrow">
                      <span class="qbadge">기간</span><span style="font-weight:1000;">${h(d.start||'')} ~ ${h(d.end||'')}</span>
                    </div>
                  ` : ``}
                  <div class="muted" style="font-weight:1000;opacity:.75;">저장 시 즉시 ‘진행중’으로 등록됩니다.</div>
                </div>
              ` : ``}
            </div>
            <div class="qfoot">
              <div class="left">
                <button class="qbtn" type="button" data-qcancel>목록으로</button>
              </div>
              <div class="right">
                <button class="qbtn" type="button" data-qprev ${step===1?'disabled':''}>이전</button>
                ${step<3 ? `<button class="qbtn primary" type="button" data-qnext>다음</button>` : `<button class="qbtn primary" type="button" data-qsave>저장</button>`}
              </div>
            </div>
          </div>
        </div>
      `;
    };

    const commitDraft = ()=>{
      const title = String(state.draft.title||"").trim();
      const desc = String(state.draft.desc||"").trim();
      const lumen = Math.max(0, Number(state.draft.lumen||0)||0);
      const xp = Math.max(0, Number(state.draft.xp||0)||0);
      const type = (state.draft.type==="period") ? "period" : "manual";
      const start = String(state.draft.start||"");
      const end = String(state.draft.end||"");

      if(!title){ toast("퀘스트 제목을 입력하세요."); return null; }
      if(!desc){ toast("퀘스트 설명을 입력하세요."); return null; }
      if((lumen===0) && (xp===0)){ toast("보상은 0/0 저장 불가입니다."); return null; }
      if(type==="period"){
        if(!start || !end){ toast("기간형은 시작일/종료일이 필요합니다."); return null; }
        if(start > end){ toast("기간 설정을 확인하세요."); return null; }
      }
      return { title, desc, lumen, xp, type, start, end };
    };

    const onListClick = (e)=>{
      const btn = e.target.closest("button");
      if(!btn) return;

      if(btn.dataset.qnew != null){
        state.draft = { title:"", desc:"", lumen:0, xp:0, type:"manual", start:"", end:"" };
        state.step = 1;
        setMode("wizard");
        return;
      }
      if(btn.dataset.qfilter){
        state.filter = btn.dataset.qfilter;
        render();
        return;
      }

      const card = e.target.closest("[data-qid]");
      const qid = card ? card.dataset.qid : null;
      if(!qid) return;

      const quests = load();
      const idx = quests.findIndex(q=>String(q.id)===String(qid));
      if(idx<0) return;
      const q = quests[idx];

      if(btn.dataset.qroster != null){
        openQuestRosterAdminModal(qid);
        return;
      }

      if(btn.dataset.qtoggle != null){
        if(q.status==="active") q.status="paused";
        else if(q.status==="paused") q.status="active";
        save(quests); render();
        return;
      }
      if(btn.dataset.qend != null){
        q.status="ended";
        save(quests); render();
        return;
      }
      if(btn.dataset.qpay != null){
        const ok = confirm("보상을 지급하시겠습니까?");
        if(!ok) return;
        // NOTE: 실제 루멘/XP 지급(학생별)은 추후 학생 지갑 로직과 연결.
        q.rewardPaid = true;
        q.rewardAt = Date.now();
        q.status = "rewarded";
        save(quests);
        toast("보상 지급 처리됨");
        render();
        return;
      }
      if(btn.dataset.qdel != null){
        const ok = confirm("삭제하시겠습니까? (복구 불가)");
        if(!ok) return;
        quests.splice(idx,1);
        save(quests);
        toast("삭제됨");
        render();
        return;
      }
    };

    const onWizardInput = (e)=>{
      const el = e.target;
      const key = el && el.dataset ? el.dataset.draft : null;
      if(!key) return;
      state.draft[key] = el.value;
    };

    const onWizardClick = (e)=>{
      const btn = e.target.closest("button");
      if(!btn) return;

      if(btn.dataset.qcancel != null){
        setMode("list");
        return;
      }
      if(btn.dataset.qprev != null){
        if(state.step>1) setStep(state.step-1);
        return;
      }
      if(btn.dataset.qnext != null){
        if(state.step===1){
          const title = String(state.draft.title||"").trim();
          const desc = String(state.draft.desc||"").trim();
          if(!title){ toast("퀘스트 제목을 입력하세요."); return; }
          if(!desc){ toast("퀘스트 설명을 입력하세요."); return; }
        }
        if(state.step===2){
          const ok = commitDraft();
          if(!ok) return;
        }
        if(state.step<3) setStep(state.step+1);
        return;
      }
      if(btn.dataset.qsave != null){
        const ok = commitDraft();
        if(!ok) return;

        const quests = load();
        quests.unshift({
          id: uid("q"),
          title: ok.title,
          desc: ok.desc,
          lumen: ok.lumen,
          xp: ok.xp,
          type: ok.type,
          start: ok.type==="period" ? ok.start : "",
          end: ok.type==="period" ? ok.end : "",
          status: "active",
          rewardPaid: false,
          createdAt: Date.now(),
        });
        save(quests);
        toast("퀘스트 생성 완료");
        state.filter = "all";
        setMode("list");
        return;
      }

      if(btn.dataset.type){
        state.draft.type = btn.dataset.type;
        render();
        return;
      }
      if(btn.dataset.add){
        const k = btn.dataset.add;
        const inc = Number(btn.dataset.inc||0)||0;
        state.draft[k] = Math.max(0, Number(state.draft[k]||0)||0) + inc;
        render();
        return;
      }

      const stepBtn = e.target.closest("[data-qstep]");
      if(stepBtn){
        const n = Number(stepBtn.dataset.qstep||0);
        if(n>=1 && n<=3){ state.step=n; render(); }
      }
    };

    const render = ()=>{
      if(state.mode==="wizard"){
        renderWizard();
        root.querySelector(".quests-frame")?.addEventListener("input", onWizardInput);
        root.querySelector(".quests-frame")?.addEventListener("click", onWizardClick);
      } else {
        renderList();
        root.querySelector(".quests-frame")?.addEventListener("click", onListClick);
      }
    };

    render();
  };




const renderBankAdmin = (root) => {
  if(!root) return;

  const safeNum = (v)=> Math.max(0, Number(v)||0);
  const money = (v)=> String(Math.round(safeNum(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const esc = (v)=> (typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? ''));
  const calcDday = (ymd)=> {
    if(!ymd) return 'D-';
    try{ return getBankEndDateText(ymd); }catch(_){ return 'D-'; }
  };
  const getStudents = ()=> {
    const arr = readJSON(LS.students, []);
    return Array.isArray(arr) ? arr : [];
  };
  const saveStudents = (arr)=> writeJSON(LS.students, Array.isArray(arr) ? arr : []);

  const settleOne = (stu)=> {
    if(!stu || !stu.id) return false;
    const amount = safeNum(stu.bank);
    const endYmd = String(stu.bankEnd || '').trim();
    if(amount <= 0 || !endYmd) return false;
    const end = parseYMD(endYmd);
    const today = parseYMD(todayKey());
    if(!end || !today || today.getTime() < end.getTime()) return false;
    const payout = Math.round(amount * 1.03);
    stu.lumen = safeNum(stu.lumen) + payout;
    clearStudentBankFields(stu);
    return true;
  };

  const settleAll = ()=> {
    const arr = getStudents();
    let count = 0;
    arr.forEach(s=>{ if(settleOne(s)) count++; });
    saveStudents(arr);
    toast(count ? `만기 예금 ${count}건을 환급했습니다.` : '환급할 만기 예금이 없습니다.');
    renderBankAdmin(root);
  };

  const cancelDeposit = (sid)=> {
    const arr = getStudents();
    const stu = arr.find(s=>String(s.id)===String(sid));
    if(!stu) return toast('학생 정보를 찾을 수 없습니다.');
    const amount = safeNum(stu.bank);
    if(amount <= 0) return toast('진행 중인 예금이 없습니다.');
    if(!confirm(`${stu.name || sid} 학생의 예금을 해지할까요?\n원금 ${money(amount)}루멘만 반환됩니다.`)) return;
    stu.lumen = safeNum(stu.lumen) + amount;
    clearStudentBankFields(stu);
    saveStudents(arr);
    toast('예금 해지 완료');
    renderBankAdmin(root);
  };

  const openDeposit = (sid)=> {
    const arr = getStudents();
    const stu = arr.find(s=>String(s.id)===String(sid));
    if(!stu) return toast('학생 정보를 찾을 수 없습니다.');
    if(safeNum(stu.bank) > 0) return toast('이미 진행 중인 예금이 있습니다.');
    const raw = prompt(`${stu.name || sid} 학생이 저금할 루멘을 입력하세요.\n(100루멘 단위 / 기본 10일 만기 / 이자 3%)`);
    if(raw === null) return;
    const amount = Number(String(raw).replace(/[^\d]/g, ''));
    if(!Number.isFinite(amount) || amount <= 0 || amount % 100 !== 0) return toast('100루멘 단위로 입력해 주세요.');
    if(safeNum(stu.lumen) < amount) return toast('학생 루멘이 부족합니다.');
    const daysRaw = prompt('만기일을 며칠 뒤로 할까요?', '10');
    if(daysRaw === null) return;
    const days = Math.max(1, Math.floor(Number(String(daysRaw).replace(/[^\d]/g, '')) || 10));
    const today = parseYMD(todayKey());
    const end = new Date(today.getTime() + days * 86400000);
    stu.lumen = safeNum(stu.lumen) - amount;
    stu.bank = amount;
    stu.bankEnd = fmtYMD(end);
    stu.bankDday = calcDday(stu.bankEnd);
    saveStudents(arr);
    toast(`${money(amount)}루멘 예금 완료`);
    renderBankAdmin(root);
  };

  const students = getStudents().map(s=>{
    if(s && s.lumens !== undefined){
      s.lumen = safeNum(s.lumen) + safeNum(s.lumens);
      delete s.lumens;
    }
    return s;
  });
  saveStudents(students);

  const totalLumen = students.reduce((a,s)=>a+safeNum(s.lumen),0);
  const totalBank = students.reduce((a,s)=>a+safeNum(s.bank),0);
  const activeBank = students.filter(s=>safeNum(s.bank)>0).length;

  root.innerHTML = `
    <style>
      .bank-admin{display:flex;flex-direction:column;gap:14px;}
      .bank-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;}
      .bank-card{background:rgba(255,255,255,.7);border:1px solid rgba(0,0,0,.08);border-radius:18px;padding:14px;}
      .bank-card b{display:block;font-size:20px;margin-top:4px;}
      .bank-tools{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;}
      .bank-table-wrap{overflow:auto;border:1px solid rgba(0,0,0,.08);border-radius:18px;background:rgba(255,255,255,.7);}
      .bank-table{width:100%;border-collapse:collapse;font-size:14px;}
      .bank-table th,.bank-table td{padding:10px 12px;border-bottom:1px solid rgba(0,0,0,.06);text-align:left;white-space:nowrap;}
      .bank-table th{background:rgba(255,255,255,.65);font-weight:800;}
      .bank-table tr:last-child td{border-bottom:0;}
      .bank-actions{display:flex;gap:6px;}
      .bank-muted{color:#777;font-size:12px;line-height:1.5;}
    </style>
    <div class="bank-admin">
      <div class="bank-summary">
        <div class="bank-card"><span>전체 보유 루멘</span><b>${money(totalLumen)}</b></div>
        <div class="bank-card"><span>은행 예금 총액</span><b>${money(totalBank)}</b></div>
        <div class="bank-card"><span>예금 중 학생</span><b>${activeBank}명</b></div>
      </div>
      <div class="bank-tools">
        <button class="btn" type="button" id="bankSettleAllBtn">전체 만기 확인/환급</button>
      </div>
      <div class="bank-table-wrap">
        <table class="bank-table">
          <thead><tr><th>학생</th><th>보유 루멘</th><th>예금액</th><th>만기일</th><th>D-day</th><th>관리</th></tr></thead>
          <tbody>
            ${students.map(s=>{
              const sid = String(s?.id || '');
              const name = String(s?.name || sid || '이름 없음');
              const bank = safeNum(s?.bank);
              const end = String(s?.bankEnd || '');
              return `<tr>
                <td><b>${esc(name)}</b><div class="bank-muted">${esc(sid)}</div></td>
                <td>${money(s?.lumen)}</td>
                <td>${bank>0 ? money(bank) : '-'}</td>
                <td>${end ? esc(end) : '-'}</td>
                <td>${bank>0 ? esc(calcDday(end)) : 'D-'}</td>
                <td><div class="bank-actions">
                  <button class="btn small" type="button" data-bank-deposit="${esc(sid)}" ${bank>0?'disabled':''}>예금</button>
                  <button class="btn small danger" type="button" data-bank-cancel="${esc(sid)}" ${bank>0?'':'disabled'}>해지</button>
                </div></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="bank-muted">새빛은행은 학생별 루멘을 기준으로 예금을 관리합니다. 예금 시 보유 루멘에서 차감되고, 만기 환급 시 원금+3%가 보유 루멘으로 돌아갑니다.</div>
    </div>
  `;

  root.querySelector('#bankSettleAllBtn')?.addEventListener('click', settleAll);
  root.querySelectorAll('[data-bank-deposit]').forEach(btn=>btn.addEventListener('click', ()=>openDeposit(btn.dataset.bankDeposit)));
  root.querySelectorAll('[data-bank-cancel]').forEach(btn=>btn.addEventListener('click', ()=>cancelDeposit(btn.dataset.bankCancel)));
};


/* === Admin: Job Performance Status (Menu 4) === */
function renderJobPerformanceAdmin(root){
  const day = (typeof todayKey === 'function') ? todayKey() : new Date().toISOString().slice(0,10);
  const esc = (v)=> (typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m])));
  const norm = (v)=>String(v||'').replace(/\s+/g,'').toLowerCase();
  const readObj = (key, fallback={})=>{ try{ const raw=localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }catch(_){ return fallback; } };
  const studentsAll = Array.isArray(readJSON(LS.students, [])) ? readJSON(LS.students, []) : [];
  const studentName = (sid)=>{
    const s = studentsAll.find(x=>String(x?.id||'')===String(sid||''));
    return s ? String(s.name||sid) : String(sid||'');
  };
  const jobs = [
    { id:'ranger', name:'교실 레인저', aliases:['교실 레인저','레인저'] },
    { id:'fairjustice', name:'페어 저스티스', aliases:['페어 저스티스','공정'] },
    { id:'timekeeper', name:'타임 키퍼', aliases:['타임 키퍼','시간','등교'] },
    { id:'techkeeper', name:'테크 키퍼', aliases:['테크 키퍼','패드','기기'] },
    { id:'studycheck', name:'학습 체크단', aliases:['학습 체크단','준비물'] },
    { id:'tidymaster', name:'정리 마스터', aliases:['정리 마스터','정리'] },
    { id:'lightguardian_front', name:'빛의 파수꾼(앞)', aliases:['빛의 파수꾼(앞)','파수꾼 앞'] },
    { id:'lightguardian_back', name:'빛의 파수꾼(뒤)', aliases:['빛의 파수꾼(뒤)','파수꾼 뒤'] },
    { id:'artcurator', name:'작품 큐레이터', aliases:['작품 큐레이터','작품'] },
    { id:'greensaver', name:'그린 세이버', aliases:['그린 세이버','분리배출','환경'] },
    { id:'docmaster', name:'문서 마스터', aliases:['문서 마스터','문서'] },
    { id:'weathercaster', name:'웨더 캐스터', aliases:['웨더 캐스터','날씨'] },
    { id:'lunchsaver', name:'런치 세이버', aliases:['런치 세이버','런치마스터','급식'] },
    { id:'lightmerchant', name:'빛의 상인', aliases:['빛의 상인','상점','상인'] }
  ];
  const matchJob = (name)=>{
    const n = norm(name);
    return jobs.find(j=>[j.name, ...(j.aliases||[])].some(a=>n.includes(norm(a)) || norm(a).includes(n))) || null;
  };
  const assign = readObj('sebit:jobsAssign_v1', {version:1,jobs:{}});
  const holdersOf = (jobId)=>{
    const out = [];
    const cur = assign?.jobs?.[jobId] || {};
    const raw = Array.isArray(cur.holders) ? cur.holders : (Array.isArray(cur.students) ? cur.students : []);
    raw.forEach(id=>{ const sid=String(id||''); if(sid && !out.includes(sid)) out.push(sid); });
    // 혹시 학생 객체에 jobs로 저장된 경우도 함께 보정
    studentsAll.forEach(st=>{
      const sid = String(st?.id||'');
      const js = Array.isArray(st?.jobs) ? st.jobs : [];
      if(sid && js.some(x=>matchJob(String(x))?.id===jobId) && !out.includes(sid)) out.push(sid);
    });
    return out;
  };
  const doneKey = (jobId, sid='') => `sebit_jobdone_${jobId}_${day}${sid ? '_' + String(sid) : ''}`;
  const isStudentDone = (jobId, sid)=> localStorage.getItem(doneKey(jobId, sid)) === '1';
  const summarize = (jobId)=>{
    const data = readObj(`sebit_${jobId}_${day}`, {});
    const parts = [];
    if(data && typeof data==='object'){
      if(data.memo) parts.push('메모: '+String(data.memo));
      if(data.checks && typeof data.checks==='object'){
        const on = Object.entries(data.checks).filter(([,v])=>!!v).map(([a])=>a);
        if(on.length) parts.push('체크 '+on.length+'개');
      }
      const entries = Object.entries(data).filter(([kk,v])=> !['memo','checks'].includes(kk) && v && typeof v==='object');
      if(entries.length){
        const problemRows = entries.filter(([,v])=> Object.values(v||{}).some(x=>x===true || (typeof x==='string' && x.trim())));
        parts.push(problemRows.length ? '기록 학생 '+problemRows.length+'명' : '특이사항 없음');
      }
      if(!parts.length && Object.keys(data).length) parts.push('기록 있음');
    }
    return parts.length ? parts.join(' · ') : '기록 내용 없음';
  };
  const completedJobs = jobs.filter(j=>{ const h=holdersOf(j.id); return h.length>0 && h.every(sid=>isStudentDone(j.id,sid)); }).length;
  root.innerHTML = `
    <style>
      .jobperf-wrap{display:grid;gap:14px;}
      .jobperf-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;}
      .jobperf-summary{display:flex;gap:10px;flex-wrap:wrap;}
      .jobperf-pill{padding:10px 14px;border:1px solid rgba(0,0,0,.08);border-radius:16px;background:rgba(255,255,255,.7);font-weight:800;}
      .jobperf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;}
      .jobperf-card{border:1px solid rgba(0,0,0,.08);border-radius:18px;background:rgba(255,255,255,.78);padding:14px;box-shadow:0 8px 22px rgba(0,0,0,.04);}
      .jobperf-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:8px;}
      .jobperf-title{font-size:16px;font-weight:900;}
      .jobperf-badge{font-size:12px;font-weight:900;border-radius:999px;padding:6px 10px;white-space:nowrap;}
      .jobperf-badge.done{background:#dff5e8;color:#176c3b;border:1px solid #bde8cf;}
      .jobperf-badge.partial{background:#e8f0ff;color:#2855b8;border:1px solid #c8d8ff;}
      .jobperf-badge.wait{background:#fff4d9;color:#7b5200;border:1px solid #f0dc9b;}
      .jobperf-meta{font-size:13px;color:#666;line-height:1.5;margin-top:6px;}
      .jobperf-result{margin-top:10px;padding:10px;border-radius:14px;background:rgba(245,247,250,.9);font-size:13px;line-height:1.5;color:#444;}
      .jobperf-students{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
      .jobperf-student{font-size:12px;font-weight:800;padding:5px 8px;border-radius:999px;border:1px solid rgba(0,0,0,.08);background:#fff;}
      .jobperf-student.done{background:#dff5e8;color:#176c3b;border-color:#bde8cf;}
      .jobperf-student.wait{background:#fff4d9;color:#7b5200;border-color:#f0dc9b;}
      .jobperf-tools{display:flex;justify-content:flex-end;gap:8px;}
    </style>
    <div class="jobperf-wrap">
      <div class="jobperf-head">
        <div class="muted">${esc(day)} 기준 · 담당 학생별로 <b>완료/대기</b>를 따로 표시합니다.</div>
        <div class="jobperf-summary"><div class="jobperf-pill">전체 완료 ${completedJobs} / ${jobs.length}</div><div class="jobperf-pill">진행 중 ${jobs.length-completedJobs}</div></div>
      </div>
      <div class="jobperf-tools"><button class="btn small" type="button" id="jobperfRefreshBtn">새로고침</button></div>
      <div class="jobperf-grid">
        ${jobs.map(j=>{
          const h = holdersOf(j.id);
          const done = h.filter(sid=>isStudentDone(j.id,sid));
          const all = h.length>0 && done.length===h.length;
          const any = done.length>0;
          const cls = all ? 'done' : (any ? 'partial' : 'wait');
          const label = all ? '마감 완료' : (any ? `일부 마감 ${done.length}/${h.length}` : '대기 중');
          return `<div class="jobperf-card"><div class="jobperf-top"><div class="jobperf-title">${esc(j.name)}</div><div class="jobperf-badge ${cls}">${esc(label)}</div></div><div class="jobperf-meta">담당: ${h.length?esc(h.map(studentName).join(', ')):'배정 없음'}</div>${h.length ? `<div class="jobperf-students">${h.map(sid=>`<span class="jobperf-student ${isStudentDone(j.id,sid)?'done':'wait'}">${esc(studentName(sid))} · ${isStudentDone(j.id,sid)?'완료':'대기'}</span>`).join('')}</div>` : ''}<div class="jobperf-result">${any ? esc(summarize(j.id)) : '아직 학생 체크리스트가 마감되지 않았습니다.'}</div></div>`;
        }).join('')}
      </div>
    </div>`;
  root.querySelector('#jobperfRefreshBtn')?.addEventListener('click', ()=>renderJobPerformanceAdmin(root));
}


/* === Student → existing job checklist bridge (safe button-trigger version) === */
try{
  window.__sebitOpenExistingJobChecklist = function(jobName){
    const rawName = String(jobName||'').trim();
    if(!rawName){ if(typeof toast==='function') toast('배정된 직업이 없습니다.'); return; }

    const normalize = (v)=>String(v||'').replace(/\s+/g,'').toLowerCase();
    const aliases = [
      { id:'ranger', names:['교실 레인저','레인저'] },
      { id:'fairjustice', names:['페어 저스티스','공정'] },
      { id:'timekeeper', names:['타임 키퍼','시간','등교'] },
      { id:'techkeeper', names:['테크 키퍼','패드','기기'] },
      { id:'studycheck', names:['학습 체크단','준비물'] },
      { id:'tidymaster', names:['정리 마스터','정리'] },
      { id:'lightguardian_front', names:['빛의 파수꾼(앞)','빛의 파수꾼 앞','파수꾼 앞'] },
      { id:'lightguardian_back', names:['빛의 파수꾼(뒤)','빛의 파수꾼 뒤','파수꾼 뒤'] },
      { id:'artcurator', names:['작품 큐레이터','작품'] },
      { id:'greensaver', names:['그린 세이버','분리배출','환경'] },
      { id:'docmaster', names:['문서 마스터','문서'] },
      { id:'weathercaster', names:['웨더 캐스터','날씨'] },
      { id:'lunchsaver', names:['런치 세이버','급식'] },
      { id:'lightmerchant', names:['빛의 상인','상점','상인'] }
    ];
    const n = normalize(rawName);
    const matched = aliases.find(j => j.names.some(x => n.includes(normalize(x)) || normalize(x).includes(n)));
    const wantedNames = matched ? matched.names : [rawName];

    const oldScratch = document.getElementById('studentJobChecklistScratch');
    if(oldScratch) oldScratch.remove();
    const oldView = document.querySelector('.jobcheck-view-overlay[data-student-opened="1"]');
    if(oldView) oldView.remove();

    const scratch = document.createElement('div');
    scratch.id = 'studentJobChecklistScratch';
    scratch.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(scratch);

    try{
      renderJobsAdmin(scratch);

      const hubBtn = Array.from(scratch.querySelectorAll('button')).find(b => String(b.textContent||'').includes('직업 체크리스트 관리'));
      if(!hubBtn) throw new Error('직업 체크리스트 관리 버튼 없음');
      hubBtn.click();

      const cards = Array.from(scratch.querySelectorAll('.jobcheck-hub-card'));
      let targetCard = null;
      for(const c of cards){
        const cardName = normalize(c.querySelector('.name')?.textContent || c.textContent || '');
        if(wantedNames.some(x => cardName.includes(normalize(x)) || normalize(x).includes(cardName))){
          targetCard = c;
          break;
        }
      }
      if(!targetCard) throw new Error('직업 카드 없음: ' + rawName);

      const openBtn = Array.from(targetCard.querySelectorAll('button')).find(b => String(b.textContent||'').trim()==='열기') || targetCard.querySelector('button');
      if(!openBtn) throw new Error('열기 버튼 없음: ' + rawName);
      openBtn.click();

      const view = scratch.querySelector('.jobcheck-view-overlay');
      if(!view) throw new Error('기존 체크리스트 화면이 생성되지 않음');

      view.dataset.studentOpened = '1';
      view.style.zIndex = '9999';
      document.body.appendChild(view);
      scratch.remove();
      document.body.classList.add('no-scroll');

      view.querySelectorAll('button').forEach(btn=>{
        if(String(btn.textContent||'').includes('닫기')){
          btn.addEventListener('click', ()=>setTimeout(()=>{
            if(!document.querySelector('.jobcheck-view-overlay[data-student-opened="1"]')) document.body.classList.remove('no-scroll');
          },0));
        }
      });
    }catch(err){
      scratch.remove();
      console.warn('[SEBIT] 학생 직업 기존 체크리스트 연결 실패:', err);
      if(typeof toast==='function') toast('기존 체크리스트 연결을 확인해야 합니다.');
    }
  };
}catch(e){
  console.warn('[SEBIT] student job checklist bridge setup failed', e);
}

const openAdminModal = ({ title, key } = {}) => {
    if (!adminModal) return;
    // Lock background scroll while the admin modal is open.
    document.body.classList.add('no-scroll');
    if (adminTitle) adminTitle.textContent = title || "관리";

    // secondary action button (quests view)
    const sec = document.getElementById("adminSecondaryBtn");
    if(sec){
      if(key==="quests"){
        sec.classList.remove("hidden");
        sec.textContent = "퀘스트 보기";
        sec.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); openQuestViewModal(); };
      } else {
        sec.classList.add("hidden");
        sec.onclick = null;
      }
    }
    if (key){
      try { localStorage.setItem('sebit:lastAdminKey', key); } catch(_) {}
      try { location.hash = 'admin-' + key; } catch(_) {}
    }
    if (adminBody){
      adminBody.innerHTML = "";
      if (key === "constitution"){
        renderConstitutionAdmin(adminBody);
      } else if (key === "jobs"){
        renderJobsAdmin(adminBody);
      } else if (key === "teacher-settings"){
        renderTeacherSettingsAdmin(adminBody);
      } else if (key === "shop"){
        renderShopAdmin(adminBody);
      } else if (key === "quests"){
        renderQuestsAdmin(adminBody);
      } else if (key === "penalty"){
        renderPenaltyAdmin(adminBody);
      } else if (key === "bank" || key === "sebit-bank" || key === "sebitbank"){
        renderBankAdmin(adminBody);
      } else if (key === "job-performance" || key === "job-status" || key === "jobs-status" || key === "jobs-performance" || key === "jobcheck-status" || (title && String(title).includes("직업 수행"))){
        renderJobPerformanceAdmin(adminBody);
      } else {
        adminBody.textContent = "준비 중입니다.";
      }
    }
    adminModal.classList.remove("hidden");
  };
  const closeAdminModal = () => {
    if(adminModal) adminModal.classList.add("hidden");
    document.body.classList.remove('no-scroll');
    try { localStorage.removeItem('sebit:lastAdminKey'); } catch(_) {}
    try { if(String(location.hash||"").startsWith('#admin-')) location.hash = ''; } catch(_) {}
  };

  menuBtn?.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); toggleMenu(); });

  // keep menu aligned on resize
  window.addEventListener('resize', ()=>{
    if (!menuDropdown || menuDropdown.classList.contains('hidden')) return;
    positionMenu();
  });

  // click outside closes menu
document.addEventListener("click", (e)=> {
    if (!menuDropdown || menuDropdown.classList.contains("hidden")) return;
    const within = e.target.closest("#menuDropdown") || e.target.closest("#menuManageBtn");
    if (!within) hideMenu();
  });

  menuDropdown?.addEventListener("click", (e)=> {
    const item = e.target.closest(".menu-item");
    if(!item) return;
    const title = item.textContent.trim();
    const key = item.dataset.admin || null;
    hideMenu();
    openAdminModal({ title, key });
  });

  $("#closeAdminModalBtn")?.addEventListener("click", closeAdminModal);
  $("#adminModal")?.addEventListener("click", (e)=>{ if (e.target.id === "adminModal") closeAdminModal(); });

  $("#thermoManageBtn")?.addEventListener("click", openThermoDrawer);
  $("#thermoDrawerClose")?.addEventListener("click", closeThermoDrawer);
  $("#thermoDrawerX")?.addEventListener("click", closeThermoDrawer);
  $("#thermoDrawer")?.addEventListener("click", (e)=>{ if (e.target.id==="thermoDrawer") closeThermoDrawer(); });
  document.querySelectorAll("[data-thermo-tab]")?.forEach(btn=>btn.addEventListener("click", ()=>setThermoTab(btn.getAttribute("data-thermo-tab"))));
  $("#saveRewardsBtn")?.addEventListener("click", saveThermoRewards);
  $("#resetThermoBtn")?.addEventListener("click", onResetThermo);
}



function ymdFromParts(y,m,d){
  const mm = String(m).padStart(2,'0');
  const dd = String(d).padStart(2,'0');
  return `${y}-${mm}-${dd}`;
}
function parseYMDParts(ymd){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd||"");
  if(!m) return null;
  return {y:+m[1], m:+m[2], d:+m[3]};
}
function monthLabel(y,m){
  return `${y}년 ${m}월`;
}
function getMonthMatrix(y,m){
  // m: 1-12
  const first = new Date(y, m-1, 1);
  const startDay = first.getDay(); // 0 Sun
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = [];
  for(let i=0;i<startDay;i++) cells.push(null);
  for(let d=1; d<=daysInMonth; d++) cells.push(d);
  while(cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function readCalendarAll(){ return readJSON(LS.calendar, {}); }
function writeCalendarAll(v){ writeJSON(LS.calendar, v); renderTodayScheduleMeal(); }


function readCalendarDrafts(){ return readJSON(LS.calendarDrafts, {}); }
function writeCalendarDrafts(v){ writeJSON(LS.calendarDrafts, v); }

function saveCalendarDraft(dateKey){
  const title = ($("#calTitle")?.value||"").trim();
  const desc = ($("#calDesc")?.value||"").trim();
  const drafts = readCalendarDrafts();
  if(!title && !desc){
    if(drafts && drafts[dateKey]) delete drafts[dateKey];
  } else {
    drafts[dateKey] = {title, desc, ts: Date.now()};
  }
  writeCalendarDrafts(drafts);
}

function loadCalendarDraft(dateKey){
  const drafts = readCalendarDrafts();
  const d = drafts?.[dateKey];
  if(!d) return;
  if($("#calTitle")) $("#calTitle").value = d.title || "";
  if($("#calDesc")) $("#calDesc").value = d.desc || "";
}

function saveMealDraft(){
  const raw = ($("#mealText")?.value||"");
  writeJSON(LS.mealDraft, {ts: Date.now(), text: raw});
}
function loadMealDraft(){
  const d = readJSON(LS.mealDraft, null);
  if(d && typeof d.text === "string" && $("#mealText")){
    if(!$("#mealText").value) $("#mealText").value = d.text;
  }
}

function readMeal(){ return readJSON(LS.meals, null); }
function writeMeal(v){ writeJSON(LS.meals, v); renderTodayScheduleMeal(); }

function ensureCalendarState(){
  if(!session.calState){
    const t = parseYMDParts(todayKey());
    session.calState = {y:t.y, m:t.m, selected: todayKey(), editId: null};
  }
}

function setCalendarEdit(ev){
  ensureCalendarState();
  session.calState.editId = ev?.id || null;
  if($("#calTitle")) $("#calTitle").value = ev?.title || "";
  if($("#calDesc")) $("#calDesc").value = ev?.desc || "";
  const addBtn = $("#calAddBtn");
  const cancelBtn = $("#calCancelBtn");
  if(addBtn) addBtn.textContent = session.calState.editId ? "수정 저장" : "추가";
  if(cancelBtn) cancelBtn.style.display = session.calState.editId ? "" : "none";
}

function showCalendarUndoBar(text){
  const bar = $("#calUndoBar");
  const t = $("#calUndoText");
  if(!bar) return;
  if(t) t.textContent = text || "삭제됨";
  bar.style.display = "flex";
}

function hideCalendarUndoBar(){
  const bar = $("#calUndoBar");
  if(!bar) return;
  bar.style.display = "none";
}

function renderTeacherCalendar(){
  ensureCalendarState();
  const st = session.calState;

  // edit UI state
  const addBtn = $("#calAddBtn");
  const cancelBtn = $("#calCancelBtn");
  if(addBtn) addBtn.textContent = st.editId ? "수정 저장" : "추가";
  if(cancelBtn) cancelBtn.style.display = st.editId ? "" : "none";

  const lbl = $("#calMonthLabel"); if(lbl) lbl.textContent = monthLabel(st.y, st.m);

  const grid = $("#calGrid");
  if(grid){
    grid.innerHTML = "";
    const cells = getMonthMatrix(st.y, st.m);
    cells.forEach((d)=>{
      const b = document.createElement("button");
      b.className = "cal-day";
      if(d==null){
        b.classList.add("is-empty");
        b.disabled = true;
        b.textContent = "";
      } else {
        b.textContent = String(d);
        const key = ymdFromParts(st.y, st.m, d);
        if(key === st.selected) b.classList.add("is-selected");
        // today marker
        if(key === todayKey()) b.classList.add("is-today");
        // has events marker
        const all = readCalendarAll();
        const list = Array.isArray(all?.[key]) ? all[key] : [];
        if(list.length>0) b.classList.add("has-dot");
        b.addEventListener("click", ()=>{
          saveCalendarDraft(st.selected);
          st.editId = null;
          st.selected = key;
          renderTeacherCalendar();
        });
      }
      grid.appendChild(b);
    });
  }

  const sel = $("#calSelectedDate"); if(sel) sel.textContent = st.selected;

  renderCalendarListForSelected();
  renderMealForToday();
  if(!st.editId) loadCalendarDraft(st.selected);
  loadMealDraft();
}

function renderCalendarListForSelected(){
  const st = session.calState;
  const listEl = $("#calEventList");
  const all = readCalendarAll();
  const list = Array.isArray(all?.[st.selected]) ? all[st.selected] : [];

  if(!listEl) return;
  listEl.innerHTML = "";

  if(list.length===0){
    const p=document.createElement("div");
    p.className="muted";
    p.textContent="등록된 일정이 없습니다.";
    listEl.appendChild(p);
    return;
  }

  // 최신순(최근 추가가 위)
  const sorted = [...list].sort((a,b)=>(b?.ts||0)-(a?.ts||0)).slice(0,50);
  sorted.forEach((ev)=>{
    const row=document.createElement("div");
    row.className="cal-ev";
    if(st.editId && ev?.id===st.editId) row.classList.add("is-active");
    const title=document.createElement("div");
    title.className="cal-ev-title";
    title.textContent=String(ev?.title||"").trim() || "(제목 없음)";
    const desc=document.createElement("div");
    desc.className="cal-ev-desc muted";
    desc.textContent=String(ev?.desc||"").trim();

    const del=document.createElement("button");
    del.className="btn danger small";
    del.textContent="삭제";
    del.addEventListener("click", ()=>{
      // capture undo
      session._calUndo = {dateKey: st.selected, ev: ev, ts: Date.now()};
      const all2 = readCalendarAll();
      const cur = Array.isArray(all2?.[st.selected]) ? all2[st.selected] : [];
      const next = cur.filter(x=>x?.id !== ev?.id);
      if(next.length===0) delete all2[st.selected]; else all2[st.selected]=next;
      writeCalendarAll(all2);
      if(st.editId===ev?.id) setCalendarEdit(null);
      showCalendarUndoBar("일정이 삭제되었습니다.");
      if(session._calUndoTimer) clearTimeout(session._calUndoTimer);
      session._calUndoTimer = setTimeout(()=>{ hideCalendarUndoBar(); session._calUndo=null; }, 10000);
      renderTeacherCalendar();
});

    row.addEventListener("click", (e)=>{
      if(e.target.closest("button")) return;
      saveCalendarDraft(st.selected);
      setCalendarEdit(ev);
      renderCalendarListForSelected();
    });

    row.appendChild(title);
    row.appendChild(desc);
    row.appendChild(del);
    listEl.appendChild(row);
  });
}

function addCalendarEventFromForm(){
  const st = session.calState;
  const title = ($("#calTitle")?.value||"").trim();
  const desc = ($("#calDesc")?.value||"").trim();
  if(!title) return;
  const all = readCalendarAll();
  if(!Array.isArray(all[st.selected])) all[st.selected]=[];
  if(st.editId){
    const idx = all[st.selected].findIndex(x=>x?.id===st.editId);
    if(idx>=0){
      all[st.selected][idx] = {...all[st.selected][idx], title, desc, ts: Date.now()};
    } else {
      all[st.selected].push({id: st.editId, title, desc, ts: Date.now()});
    }
  } else {
    all[st.selected].push({id: "ev_"+Math.random().toString(36).slice(2,10), title, desc, ts: Date.now()});
  }
  // keep last 50 per day
  if(all[st.selected].length>50) all[st.selected]=all[st.selected].slice(-50);
  writeCalendarAll(all);
  if($("#calTitle")) $("#calTitle").value="";
  if($("#calDesc")) $("#calDesc").value="";
  setCalendarEdit(null);
  renderTeacherCalendar();
}

function renderMealForToday(){
  const today = todayKey();
  const meal = readMeal();
  if($("#mealDate")) $("#mealDate").textContent = today;

  const items = (meal && meal.date===today && Array.isArray(meal.items)) ? meal.items : [];
  if($("#mealText")) $("#mealText").value = items.join("\n");
}

function saveMealFromForm(){
  const today = todayKey();
  const raw = ($("#mealText")?.value||"");
  const items = raw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  writeMeal({date: today, items});
}
function clearMeal(){
  writeMeal(null);
  if($("#mealText")) $("#mealText").value="";
}




/* === SEBIT cost guard: realtime connection protection ===
   - 기능을 막지 않고, 화면이 꺼지거나 앱이 뒤로 가거나 10분간 조작이 없으면 onSnapshot 실시간 연결만 끊음
   - 다시 화면으로 돌아오거나 터치/클릭하면 서버에서 최신 데이터를 1회 읽고 실시간 연결을 재개함
   - 저장(write) 기능은 그대로 동작함
*/
const SEBIT_REALTIME_IDLE_MS = 10 * 60 * 1000;
let __sebitRealtimeIdleTimer = null;
let __sebitRealtimeResuming = false;
window.__sebitRealtimePaused = false;

function sebitSafeUnsub(fn, label){
  try{ if(typeof fn === "function") fn(); }
  catch(err){ console.warn("[SEBIT GUARD] unsubscribe skipped", label, err); }
}

function sebitStopRealtimeListeners(reason="idle"){
  window.__sebitRealtimePaused = true;

  sebitSafeUnsub(__sebitUnsubStudents, "students");
  sebitSafeUnsub(__sebitUnsubPenaltyLogs, "penaltyLogs");
  sebitSafeUnsub(__sebitUnsubConstitution, "constitution");
  sebitSafeUnsub(__sebitUnsubThermo, "thermo");
  sebitSafeUnsub(__sebitUnsubJobState, "jobState");
  sebitSafeUnsub(__sebitUnsubActivityState, "activityState");
  sebitSafeUnsub(__sebitUnsubShopState, "shopState");
  try{ (Array.isArray(__sebitUnsubShopDocs) ? __sebitUnsubShopDocs : []).forEach((fn, i)=>sebitSafeUnsub(fn, "shopDoc"+i)); }catch(_){ }
  try{ sebitSafeUnsub(window.__sebitEmergencyShopDirectUnsub, "directShop"); }catch(_){ }

  __sebitUnsubStudents = null;
  __sebitUnsubPenaltyLogs = null;
  __sebitUnsubConstitution = null;
  __sebitUnsubThermo = null;
  __sebitUnsubJobState = null;
  __sebitUnsubActivityState = null;
  __sebitUnsubShopState = null;
  __sebitUnsubShopDocs = [];
  window.__sebitEmergencyShopDirectUnsub = null;
  window.__sebitEmergencyShopDirectListener = false;

  __sebitRealtimeStarted = false;
  __sebitConstitutionRealtimeStarted = false;
  __sebitThermoRealtimeStarted = false;
  __sebitShopRealtimeStarted = false;
  __sebitJobRealtimeStarted = false;

  console.log("[SEBIT GUARD] realtime stopped:", reason);
}

function sebitStartRealtimeListeners(){
  if(document.hidden) return;
  window.__sebitRealtimePaused = false;
  try{ startFirestoreRealtimeSync(); }catch(err){ console.warn("[SEBIT GUARD] student/penalty realtime start skipped", err); }
  try{ startShopFirestoreRealtimeSync(); }catch(err){ console.warn("[SEBIT GUARD] shop realtime start skipped", err); }
  try{ startJobFirestoreRealtimeSync(); }catch(err){ console.warn("[SEBIT GUARD] job realtime start skipped", err); }
  try{ startConstitutionFirestoreRealtimeSync(); }catch(err){ console.warn("[SEBIT GUARD] constitution realtime start skipped", err); }
  try{ startThermoFirestoreRealtimeSync(); }catch(err){ console.warn("[SEBIT GUARD] thermo realtime start skipped", err); }
  try{ startActivityFirestoreRealtimeSync(); }catch(err){ console.warn("[SEBIT GUARD] activity realtime start skipped", err); }
  try{ if(typeof installDirectShopListener === "function") installDirectShopListener(); }catch(_){ }
  console.log("[SEBIT GUARD] realtime started");
}

function sebitRefreshVisiblePageAfterResume(){
  try{ refreshCurrentSebitPageFromRealtime(); }catch(_){ }
  try{ refreshShopPagesFromRealtime(); }catch(_){ }
  try{ refreshJobPagesFromRealtime(); }catch(_){ }
  try{ refreshConstitutionViewsFromRealtime(); }catch(_){ }
  try{ refreshThermoViewsFromRealtime(); }catch(_){ }
  try{ refreshActivityPagesFromRealtime(); }catch(_){ }
}

async function sebitResumeRealtimeListeners(reason="activity"){
  if(document.hidden || __sebitRealtimeResuming) return;
  __sebitRealtimeResuming = true;
  try{
    window.__sebitRealtimePaused = false;
    // 꺼져 있던 동안 바뀐 내용을 1회만 읽어와서 화면을 최신화한 뒤 실시간 감시 재개
    await Promise.all([
      loadTeacherAuthFromFirestore(),
      loadStudentsFromFirestore(),
      loadPenaltyLogsFromFirestore(),
      loadShopStateFromFirestore(),
      loadJobStateFromFirestore(),
      loadConstitutionFromFirestore(),
      loadThermoFromFirestore(),
      loadActivityStateFromFirestore()
    ]);
    sebitRefreshVisiblePageAfterResume();
    sebitStartRealtimeListeners();
    console.log("[SEBIT GUARD] realtime resumed:", reason);
  }catch(err){
    console.error("[SEBIT GUARD] realtime resume failed", err);
  }finally{
    __sebitRealtimeResuming = false;
    sebitResetIdleTimer();
  }
}

function sebitResetIdleTimer(){
  clearTimeout(__sebitRealtimeIdleTimer);
  if(document.hidden) return;
  __sebitRealtimeIdleTimer = setTimeout(()=>{
    sebitStopRealtimeListeners("10분 미사용");
  }, SEBIT_REALTIME_IDLE_MS);
}

function sebitMarkUserActivity(){
  sebitResetIdleTimer();
  if(window.__sebitRealtimePaused && !document.hidden){
    sebitResumeRealtimeListeners("사용자 조작");
  }
}

function installSebitRealtimeCostGuard(){
  ["click", "touchstart", "keydown", "pointerdown"].forEach(evt=>{
    window.addEventListener(evt, sebitMarkUserActivity, { passive:true });
  });
  document.addEventListener("visibilitychange", ()=>{
    if(document.hidden){
      sebitStopRealtimeListeners("화면 숨김/꺼짐");
      clearTimeout(__sebitRealtimeIdleTimer);
    }else{
      sebitResumeRealtimeListeners("화면 복귀");
    }
  });
  window.addEventListener("pagehide", ()=>sebitStopRealtimeListeners("페이지 종료"));
  window.addEventListener("beforeunload", ()=>sebitStopRealtimeListeners("페이지 종료"));
  sebitResetIdleTimer();
}

document.addEventListener("DOMContentLoaded", () => {
  ensureSeed();
  Promise.all([loadTeacherAuthFromFirestore(), loadStudentsFromFirestore(), loadPenaltyLogsFromFirestore(), loadShopStateFromFirestore(), loadJobStateFromFirestore(), loadConstitutionFromFirestore(), loadThermoFromFirestore(), loadActivityStateFromFirestore()]).then(() => {
    // Firestore에서 학생명단/루멘/XP/벌점/상점·포켓/직업/활동기록을 가져온 뒤 현재 화면이 관련 화면이면 다시 그림
    try {
      sanitizeAllPockets();
      const page = String(document.body.getAttribute("data-page") || "");
      if (page === "teacher-students" && typeof renderTeacherStudents === "function") renderTeacherStudents();
      if (page.startsWith("student-") && typeof renderStudentShell === "function") renderStudentShell();
      sebitStartRealtimeListeners();
      installSebitRealtimeCostGuard();
    } catch (_) {}
  });
  runMidnightResetIfNeeded();
  scheduleMidnightResetTick();
  // rule: always intro on load
  session.teacherAuthed = false;
  session.studentId = null;

  bind();
  forceIntro();
});

function wireCalendarUI(){
  if(session._calWired) return;
  session._calWired = true;

  const prev = $("#calPrev");
  const next = $("#calNext");
  const addBtn = $("#calAddBtn");
  const cancelBtn = $("#calCancelBtn");
  const undoBtn = $("#calUndoBtn");
  const mealSave = $("#mealSaveBtn");
  const mealClear = $("#mealClearBtn");

  if(prev) prev.addEventListener("click", ()=>{
    ensureCalendarState();
    saveCalendarDraft(session.calState.selected);
    session.calState.editId = null;
    let {y,m} = session.calState;
    m -= 1; if(m<=0){ m=12; y-=1; }
    session.calState.y=y; session.calState.m=m;
    renderTeacherCalendar();
  });

  if(next) next.addEventListener("click", ()=>{
    ensureCalendarState();
    saveCalendarDraft(session.calState.selected);
    session.calState.editId = null;
    let {y,m} = session.calState;
    m += 1; if(m>=13){ m=1; y+=1; }
    session.calState.y=y; session.calState.m=m;
    renderTeacherCalendar();
  });

  if(addBtn) addBtn.addEventListener("click", addCalendarEventFromForm);
  if(cancelBtn) cancelBtn.addEventListener("click", ()=>{
    ensureCalendarState();
    setCalendarEdit(null);
    loadCalendarDraft(session.calState.selected);
    renderCalendarListForSelected();
  });

  if(undoBtn) undoBtn.addEventListener("click", ()=>{
    const u = session._calUndo;
    if(!u || !u.dateKey || !u.ev) return;
    const all = readCalendarAll();
    if(!Array.isArray(all[u.dateKey])) all[u.dateKey]=[];
    // avoid duplicates
    if(!all[u.dateKey].some(x=>x?.id===u.ev.id)) all[u.dateKey].push(u.ev);
    if(all[u.dateKey].length>50) all[u.dateKey]=all[u.dateKey].slice(-50);
    writeCalendarAll(all);
    session._calUndo = null;
    hideCalendarUndoBar();
    renderTeacherCalendar();
  });
  if(mealSave) mealSave.addEventListener("click", saveMealFromForm);
  if(mealClear) mealClear.addEventListener("click", clearMeal);

  // autosave draft while typing
  const t = $("#calTitle");
  const d = $("#calDesc");
  const meal = $("#mealText");
  const deb = (fn, ms)=>{
    let h=null;
    return ()=>{ clearTimeout(h); h=setTimeout(fn, ms); };
  };

  const saveDraftDebounced = deb(()=>{
    ensureCalendarState();
    saveCalendarDraft(session.calState.selected);
  }, 200);

  if(t) t.addEventListener("input", saveDraftDebounced);
  if(d) d.addEventListener("input", saveDraftDebounced);

  const saveMealDebounced = deb(()=>{
    ensureCalendarState();
    saveMealDraft();
  }, 250);

  if(meal) meal.addEventListener("input", saveMealDebounced);
}


/* === Teacher Students (전체 학생 관리) === */
let _studAdminWired = false;
let _studAdminState = {
  mode: "lumen", // lumen | xp
  selected: new Set(),
  search: "",
  pendingDelta: null, // {delta:number, source:string}
};

function normalizeStudentPoints(s){
  const out = {...s};
  out.lumen = Number.isFinite(Number(out.lumen)) ? Number(out.lumen) : 0;
  out.xp = Number.isFinite(Number(out.xp)) ? Number(out.xp) : 0;
  return out;
}

function readStudentsAll(){
  const arr = readJSON(LS.students, []);
  return Array.isArray(arr) ? arr.map(normalizeStudentPoints) : [];
}
function writeStudentsAll(arr){
  writeJSON(LS.students, Array.isArray(arr)?arr:[]);
}

function studSetMode(next){
  _studAdminState.mode = next === "xp" ? "xp" : "lumen";
  const a = document.getElementById("studModeLumen");
  const b = document.getElementById("studModeXp");
  if(a) a.classList.toggle("active", _studAdminState.mode==="lumen");
  if(b) b.classList.toggle("active", _studAdminState.mode==="xp");
}

function studSelectedIds(){
  return Array.from(_studAdminState.selected);
}

function studUpdateSelectedMeta(){
  const el = document.getElementById("studSelectedMeta");
  if(el) el.textContent = `선택 ${_studAdminState.selected.size}명`;
}

function studToggleSelect(id){
  if(_studAdminState.selected.has(id)) _studAdminState.selected.delete(id);
  else _studAdminState.selected.add(id);
  studUpdateSelectedMeta();
  renderTeacherStudentsGrid();
}

function studSelectAll(){
  const students = readStudentsAll().filter(s=>s.active!==false);
  students.forEach(s=>_studAdminState.selected.add(String(s.id)));
  studUpdateSelectedMeta();
  renderTeacherStudentsGrid();
}

function studSelectNone(){
  _studAdminState.selected.clear();
  studUpdateSelectedMeta();
  renderTeacherStudentsGrid();
}

function studGetAvatarText(s){
  // future: charKey -> image. for now: prefer s.char / s.avatar / initials
  const v = (s.char || s.avatar || "").trim();
  if(v) return v;
  const name = String(s.name||"").trim();
  if(name) return name.slice(0,1);
  return "?";
}

function studGetAvatarSrc(s){
  if (!s) return "assets/characters/CHR-1.png";

  if (s.id) {
    const saved = localStorage.getItem("studentAvatar_" + s.id);
    if (saved) return saved;
  }

  if (s.charKey) return `assets/characters/${s.charKey}.png`;

  return "assets/characters/CHR-1.png";
}
function renderTeacherStudentsGrid(){
  const grid = document.getElementById("studGrid");
  const empty = document.getElementById("studEmptyMsg");
  if(!grid) return;

  const q = String(_studAdminState.search || "").trim().toLowerCase();
  const students = readStudentsAll().filter(s => s.active !== false);
  const view = q
    ? students.filter(s =>
        String(s.name || "").toLowerCase().includes(q) ||
        String(s.id || "").toLowerCase().includes(q)
      )
    : students;

  grid.innerHTML = "";
  if (empty) empty.style.display = (students.length === 0) ? "" : "none";
  if (students.length === 0) return;

  view.sort((a,b)=>(a.no||0)-(b.no||0)).forEach(s => {
    const id = String(s.id);
    const item = document.createElement("div");
    item.className = "stud-item" + (_studAdminState.selected.has(id) ? " is-selected" : "");
    item.setAttribute("data-id", id);

    const avatar = document.createElement("div");
    avatar.className = "stud-avatar";

    const img = document.createElement("img");
    img.src = studGetAvatarSrc(s);
    img.alt = `${String(s.name || "학생")} 캐릭터`;
    img.onerror = function () {
      avatar.innerHTML = "";
      avatar.textContent = String(s.name || "?").trim().slice(0,1) || "?";
      avatar.classList.add("is-fallback");
    };
    avatar.appendChild(img);

    const info = document.createElement("div");
    info.className = "stud-info";

    const name = document.createElement("div");
    name.className = "stud-name";
    name.innerHTML = `<span>${escapeHtml(String(s.name||""))}</span> <span class="stud-sub">(${escapeHtml(id)})</span>`;

    const stats = document.createElement("div");
    stats.className = "stud-stats";
    const inv = (s.holding != null) ? String(s.holding) : (s.inventory != null ? String(s.inventory) : "-");
    stats.innerHTML = `
      <span class="stud-pill">루멘 <span class="mono">${escapeHtml(String(Number(s.lumen)||0))}</span></span>
      <span class="stud-pill">XP <span class="mono">${escapeHtml(String(Number(s.xp)||0))}</span></span>
         `;

    info.append(name, stats);
    item.append(avatar, info);
    item.addEventListener("click", ()=> studToggleSelect(id));
    grid.appendChild(item);
  });
}function studOpenConfirm(delta){
  const modal = document.getElementById("studBulkConfirmModal");
  const sum = document.getElementById("studConfirmSummary");
  if(!modal || !sum) return;

  const ids = studSelectedIds();
  const modeLabel = _studAdminState.mode === "xp" ? "XP" : "루멘";
  const per = delta;
  const total = per * ids.length;
  const sign = per >= 0 ? "+" : "";
  sum.innerHTML = `
    <div>선택 인원: <b>${ids.length}명</b></div>
    <div>적용 항목: <b>${modeLabel}</b></div>
    <div>1인당 변경값: <b class="mono">${sign}${per}</b></div>
    <div>총 합계 변화량: <b class="mono">${sign}${total}</b></div>
  `;

  _studAdminState.pendingDelta = {delta: per, source: "confirm"};
  modal.classList.remove("hidden");
}

function studCloseConfirm(){
  const modal = document.getElementById("studBulkConfirmModal");
  if(modal) modal.classList.add("hidden");
  _studAdminState.pendingDelta = null;
}

function studShowUndo(text){
  const bar = document.getElementById("studUndoBar");
  const t = document.getElementById("studUndoText");
  if(!bar) return;
  if(t) t.textContent = text || "지급됨";
  bar.style.display = "flex";
}
function studHideUndo(){
  const bar = document.getElementById("studUndoBar");
  if(!bar) return;
  bar.style.display = "none";
}

function studApplyDelta(delta){
  const ids = studSelectedIds();
  if(ids.length===0) return;

  const students = readStudentsAll();
  const prev = {};

  students.forEach(s=>{
    const id = String(s.id);
    if(!ids.includes(id)) return;
    prev[id] = { lumen: Number(s.lumen)||0, xp: Number(s.xp)||0 };
    if(_studAdminState.mode === "xp"){
      s.xp = Math.max(0, (Number(s.xp)||0) + delta);
    } else {
      // 루멘은 벌점/차감으로 음수가 될 수 있으므로 학생관리 수동 변경에서는 0으로 보정하지 않음
      s.lumen = (Number(s.lumen)||0) + delta;
    }
  });

  writeStudentsAll(students);
  writeJSON(LS.studentsBulkUndo, { ts: Date.now(), mode: _studAdminState.mode, delta, ids, prev });

  const modeLabel = _studAdminState.mode === "xp" ? "XP" : "루멘";
  const sign = delta>=0?"+":"";
  studShowUndo(`${modeLabel} ${sign}${delta} 지급됨 (${ids.length}명)`);
  pushSystemLog(`[학생관리] ${modeLabel} ${sign}${delta} 지급 (${ids.join(",")})`);

  renderTeacherStudentsGrid();
  try{ renderTeacherHome(); }catch(_){ }
}

function studUndoLast(){
  const u = readJSON(LS.studentsBulkUndo, null);
  if(!u || !u.prev) return;
  const prev = u.prev;
  const students = readStudentsAll();
  students.forEach(s=>{
    const id = String(s.id);
    if(prev[id]){
      s.lumen = Number(prev[id].lumen)||0;
      s.xp = Number(prev[id].xp)||0;
    }
  });
  writeStudentsAll(students);
  localStorage.removeItem(LS.studentsBulkUndo);
  studHideUndo();
  pushSystemLog(`[학생관리] 되돌리기 (${Array.isArray(u.ids)?u.ids.join(","):""})`);
  renderTeacherStudentsGrid();
  try{ renderTeacherHome(); }catch(_){ }
}

function wireTeacherStudentsUI(){
  if(_studAdminWired) return;
  _studAdminWired = true;

  const modeL = document.getElementById("studModeLumen");
  const modeX = document.getElementById("studModeXp");
  if(modeL) modeL.addEventListener("click", ()=>{ studSetMode("lumen"); renderTeacherStudentsGrid(); });
  if(modeX) modeX.addEventListener("click", ()=>{ studSetMode("xp"); renderTeacherStudentsGrid(); });

  const topbar = document.getElementById("studAdminTopbar");
  if(topbar){
    topbar.addEventListener("click", (e)=>{
      const btn = e.target.closest("[data-bulk]");
      if(!btn) return;
      const raw = String(btn.getAttribute("data-bulk")||"");
      const delta = Number(raw);
      if(!Number.isFinite(delta)) return;
      if(_studAdminState.selected.size===0) return;
      studOpenConfirm(delta);
    });
  }

  const plus = document.getElementById("studDirectPlus");
  const minus = document.getElementById("studDirectMinus");
  if(plus) plus.addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ const v = Number(plus.value||0); if(v>0 && _studAdminState.selected.size>0) studOpenConfirm(Math.floor(v)); }});
  if(minus) minus.addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ const v = Number(minus.value||0); if(v>0 && _studAdminState.selected.size>0) studOpenConfirm(-Math.floor(v)); }});

  const selAll = document.getElementById("studSelectAllBtn");
  const selNone = document.getElementById("studSelectNoneBtn");
  if(selAll) selAll.addEventListener("click", studSelectAll);
  if(selNone) selNone.addEventListener("click", studSelectNone);

  const give = document.getElementById("studGiveBtn");
  if(give) give.addEventListener("click", ()=>{
    // if direct fields have value, prefer them, else no-op (user should press +/- buttons)
    if(_studAdminState.selected.size===0) return;
    const pv = Number((document.getElementById("studDirectPlus")?.value)||0);
    const mv = Number((document.getElementById("studDirectMinus")?.value)||0);
    if(pv>0) return studOpenConfirm(Math.floor(pv));
    if(mv>0) return studOpenConfirm(-Math.floor(mv));
    // no amount set -> ignore
  });

  const search = document.getElementById("studSearch");
  if(search) search.addEventListener("input", ()=>{ _studAdminState.search = search.value||""; renderTeacherStudentsGrid(); });

  const cancel = document.getElementById("studBulkCancelBtn");
  const cancelX = document.getElementById("studBulkCancelX");
  const confirm = document.getElementById("studBulkConfirmBtn");
  if(cancel) cancel.addEventListener("click", studCloseConfirm);
  if(cancelX) cancelX.addEventListener("click", studCloseConfirm);
  if(confirm) confirm.addEventListener("click", ()=>{
    const d = _studAdminState.pendingDelta?.delta;
    if(Number.isFinite(d)) studApplyDelta(d);
    studCloseConfirm();
    const plusEl = document.getElementById("studDirectPlus");
    const minusEl = document.getElementById("studDirectMinus");
    if(plusEl) plusEl.value="";
    if(minusEl) minusEl.value="";
  });

  const modal = document.getElementById("studBulkConfirmModal");
  if(modal) modal.addEventListener("click", (e)=>{ if(e.target===modal) studCloseConfirm(); });
  window.addEventListener("keydown", (e)=>{ if(e.key==="Escape") studCloseConfirm(); });

  const undo = document.getElementById("studUndoBtn");
  if(undo) undo.addEventListener("click", studUndoLast);
}

function renderTeacherStudents(){
  wireTeacherStudentsUI();
  // restore undo bar if exists
  const u = readJSON(LS.studentsBulkUndo, null);
  if(u && u.ids && u.delta!=null){
    const modeLabel = u.mode === "xp" ? "XP" : "루멘";
    const sign = Number(u.delta)>=0?"+":"";
    studShowUndo(`${modeLabel} ${sign}${u.delta} 지급됨 (${Array.isArray(u.ids)?u.ids.length:0}명)`);
  } else {
    studHideUndo();
  }
  studUpdateSelectedMeta();
  renderTeacherStudentsGrid();
}



// === 학생 상점 미리보기(교사용) ===
function openStudentShopPreviewModal(){
  // 이미 열려있으면 재사용
  let modal = document.getElementById('studentShopPreviewModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'studentShopPreviewModal';
    modal.className = 'sebit-modal-backdrop';
    modal.innerHTML = `
      <div class="sebit-modal sebit-modal-lg" role="dialog" aria-modal="true">
        <div class="sebit-modal-header">
          <div class="sebit-modal-title">학생 상점 미리보기</div>
          <button type="button" class="btn btn-ghost" id="studentShopPreviewClose">닫기</button>
        </div>
        <div class="sebit-modal-body" id="studentShopPreviewBody"></div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e)=>{
      if(e.target === modal) closeStudentShopPreviewModal();
    });
    modal.querySelector('#studentShopPreviewClose')?.addEventListener('click', closeStudentShopPreviewModal);
  }
  // 내용 렌더
const body = modal.querySelector('#studentShopPreviewBody');

const productsRaw = readJSON(LS.shopProducts, []);
const products = Array.isArray(productsRaw) ? productsRaw : [];
const list = products.map(p => ({
  id: p?.id || ("p_" + Math.random().toString(36).slice(2,10)),
  name: (p?.name || "").trim(),
  imgId: Number.isFinite(p?.imgId) ? p.imgId : 0,
  price: Math.max(0, Number(p?.price||0)),
  stock: Math.max(0, Number(p?.stock||0)),
  category: (p?.category || "간식").trim(),
  isPublished: (p?.isPublished === false ? false : true)
}));
const selectedCat = modal.dataset.previewCat || "전체";
const filtered = selectedCat === "전체" ? list : list.filter(p => (p.category||"") === selectedCat);
const cards = filtered.map(p=>{
  const isSoldOut = (p.stock||0) <= 0;
  const isStopped = p.isPublished === false;
  const state = isSoldOut ? "품절" : (isStopped ? "판매중단" : "판매중");
  const disabled = (isSoldOut || isStopped);

  return `
    <div class="lightshop-item ${disabled ? 'is-disabled' : ''}">
      ${disabled ? `<div class="lightshop-banner">${state}</div>` : ``}
      <div class="lightshop-thumb"><img src="assets/shop/${(Number(p.imgId||0)%10)+1}.png" class="shop-thumb-img"></div>
      <div class="lightshop-name">${escapeHTML(p.name||"상품")}</div>
      <div class="lightshop-meta">
        <div class="lightshop-price">● ${Number(p.price||0)}</div>
        <div class="muted small">재고 ${Number(p.stock||0)}</div>
        <div class="muted small">${escapeHTML(p.category||"")}</div>
      </div>
      <button type="button" class="btn wide lightshop-buy" ${disabled ? 'disabled' : ''}>구매</button>
    </div>
  `;
}).join('');

body.innerHTML = `
  <div class="lightshop-shell preview">
    <div class="lightshop-title">빛의 상점</div>
    <div class="lightshop-tabs" aria-label="카테고리">
      ${["전체","간식","쿠폰","학용품","특별"].map(cat=>`<button class="lightshop-tab ${cat===selectedCat?'is-active':''}" type="button" data-cat="${cat}">${cat}</button>`).join('')}
    </div>
    <div class="lightshop-grid">
      ${cards || `<div class="muted" style="grid-column:1 / -1; text-align:center; padding:18px 0;">등록된 상품이 없습니다.</div>`}
    </div>
    <div class="muted" style="margin-top:10px;">※ 품절/판매중단 상품은 배너+회색 처리, 구매 불가(미리보기).</div>
  </div>
`;
body.querySelector('.lightshop-tabs')?.addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-cat]');
  if(!btn) return;
  modal.dataset.previewCat = btn.dataset.cat || '전체';
  openStudentShopPreviewModal();
});

modal.style.display = 'flex';
  document.body.classList.add('no-scroll');
}
function closeStudentShopPreviewModal(){
  const modal = document.getElementById('studentShopPreviewModal');
  if(modal) modal.style.display = 'none';
  document.body.classList.remove('no-scroll');
}


/* === PATCH: per-student job close status for multi-holder jobs (v1) === */
(function(){
  const JOB_ALIASES_V1 = [
    { id:'ranger', names:['교실 레인저','레인저'] },
    { id:'fairjustice', names:['페어 저스티스','공정'] },
    { id:'timekeeper', names:['타임 키퍼','시간','등교'] },
    { id:'techkeeper', names:['테크 키퍼','패드','기기'] },
    { id:'studycheck', names:['학습 체크단','준비물'] },
    { id:'tidymaster', names:['정리 마스터','정리'] },
    { id:'lightguardian_front', names:['빛의 파수꾼(앞)','빛의 파수꾼 앞','파수꾼 앞'] },
    { id:'lightguardian_back', names:['빛의 파수꾼(뒤)','빛의 파수꾼 뒤','파수꾼 뒤'] },
    { id:'artcurator', names:['작품 큐레이터','작품'] },
    { id:'greensaver', names:['그린 세이버','분리배출','환경'] },
    { id:'docmaster', names:['문서 마스터','문서'] },
    { id:'weathercaster', names:['웨더 캐스터','날씨'] },
    { id:'lunchsaver', names:['런치 세이버','급식'] },
    { id:'lightmerchant', names:['빛의 상인','상점','상인'] }
  ];
  const JOB_LIST_V1 = [
    { id:'ranger', name:'교실 레인저' },
    { id:'fairjustice', name:'페어 저스티스' },
    { id:'timekeeper', name:'타임 키퍼' },
    { id:'techkeeper', name:'테크 키퍼' },
    { id:'studycheck', name:'학습 체크단' },
    { id:'tidymaster', name:'정리 마스터' },
    { id:'lightguardian_front', name:'빛의 파수꾼(앞)' },
    { id:'lightguardian_back',  name:'빛의 파수꾼(뒤)' },
    { id:'artcurator', name:'작품 큐레이터' },
    { id:'greensaver', name:'그린 세이버' },
    { id:'docmaster', name:'문서 마스터' },
    { id:'weathercaster', name:'웨더 캐스터' },
    { id:'lunchsaver', name:'런치 세이버' },
    { id:'lightmerchant', name:'빛의 상인' }
  ];
  const norm = (v)=>String(v||'').replace(/\s+/g,'').toLowerCase();
  const esc = (v)=> (typeof escapeHtml === 'function' ? escapeHtml(v) : String(v ?? '').replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m])));
  const today = ()=> (typeof todayKey === 'function') ? todayKey() : new Date().toISOString().slice(0,10);
  const readObj = (key, fallback={})=>{ try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback));}catch(_){return fallback;} };
  const studentNameById = (sid)=>{
    const students = readJSON(LS.students, []);
    const s = Array.isArray(students) ? students.find(x=>String(x?.id||'')===String(sid||'')) : null;
    return s ? String(s.name||sid) : String(sid||'');
  };
  const matchJob = (jobName)=>{
    const n = norm(jobName);
    return JOB_ALIASES_V1.find(j => j.names.some(x => n.includes(norm(x)) || norm(x).includes(n))) || { id:'', names:[jobName] };
  };
  const assignState = ()=>{
    try{return JSON.parse(localStorage.getItem('sebit:jobsAssign_v1')||'{"version":1,"jobs":{}}');}
    catch(_){return {version:1,jobs:{}};}
  };
  const holdersOf = (jobId)=>{
    const assign = assignState();
    const cur = assign?.jobs?.[jobId] || {};
    const holders = Array.isArray(cur.holders) ? cur.holders : (Array.isArray(cur.students) ? cur.students : []);
    return holders.map(x=>String(x||'')).filter(Boolean);
  };
  const doneKey = (jobId, day=today(), sid='') => `sebit_jobdone_${jobId}_${day}${sid ? '_' + String(sid) : ''}`;
  const markStudentDone = (jobId, sid)=>{
    if(!jobId || !sid) return;
    localStorage.setItem(doneKey(jobId, today(), sid), '1');
    const logKey = `sebit_jobdone_log_${jobId}_${today()}`;
    const log = readObj(logKey, {});
    log[String(sid)] = { studentId:String(sid), studentName:studentNameById(sid), at:Date.now() };
    try{ localStorage.setItem(logKey, JSON.stringify(log)); }catch(_){}
  };
  const unmarkStudentDone = (jobId, sid)=>{
    if(!jobId || !sid) return;
    localStorage.removeItem(doneKey(jobId, today(), sid));
    const logKey = `sebit_jobdone_log_${jobId}_${today()}`;
    const log = readObj(logKey, {});
    delete log[String(sid)];
    try{ localStorage.setItem(logKey, JSON.stringify(log)); }catch(_){}
  };
  const isStudentDone = (jobId, sid)=> localStorage.getItem(doneKey(jobId, today(), sid)) === '1';
  const allAssignedDone = (jobId)=>{
    const holders = holdersOf(jobId);
    return holders.length > 0 && holders.every(sid=>isStudentDone(jobId, sid));
  };
  const anyAssignedDone = (jobId)=> holdersOf(jobId).some(sid=>isStudentDone(jobId, sid));

  // 학생이 자기 직업을 열 때: 기존 화면은 그대로 쓰되, "마감" 저장 단위만 직업 전체 → 학생 개인으로 바꾼다.
  window.__sebitOpenExistingJobChecklist = function(jobName){
    const rawName = String(jobName||'').trim();
    if(!rawName){ if(typeof toast==='function') toast('배정된 직업이 없습니다.'); return; }
    const matched = matchJob(rawName);
    const jobId = matched.id;
    const wantedNames = matched.names || [rawName];
    const sid = String(session?.studentId || '');

    const oldScratch = document.getElementById('studentJobChecklistScratch');
    if(oldScratch) oldScratch.remove();
    const oldView = document.querySelector('.jobcheck-view-overlay[data-student-opened="1"]');
    if(oldView) oldView.remove();

    const scratch = document.createElement('div');
    scratch.id = 'studentJobChecklistScratch';
    scratch.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(scratch);

    try{
      renderJobsAdmin(scratch);

      const hubBtn = Array.from(scratch.querySelectorAll('button')).find(b => String(b.textContent||'').includes('직업 체크리스트 관리'));
      if(!hubBtn) throw new Error('직업 체크리스트 관리 버튼 없음');
      hubBtn.click();

      const cards = Array.from(scratch.querySelectorAll('.jobcheck-hub-card'));
      let targetCard = null;
      for(const c of cards){
        const cardName = norm(c.querySelector('.name')?.textContent || c.textContent || '');
        if(wantedNames.some(x => cardName.includes(norm(x)) || norm(x).includes(cardName))){
          targetCard = c;
          break;
        }
      }
      if(!targetCard) throw new Error('직업 카드 없음: ' + rawName);

      const openBtn = Array.from(targetCard.querySelectorAll('button')).find(b => String(b.textContent||'').trim()==='열기') || targetCard.querySelector('button');
      if(!openBtn) throw new Error('열기 버튼 없음: ' + rawName);
      openBtn.click();

      const view = scratch.querySelector('.jobcheck-view-overlay');
      if(!view) throw new Error('기존 체크리스트 화면이 생성되지 않음');

      view.dataset.studentOpened = '1';
      view.dataset.jobId = jobId || '';
      view.style.zIndex = '9999';

      // 핵심: 학생 화면에서 마감 버튼을 누르면 개인 마감으로 저장.
      view.addEventListener('click', function(e){
        const btn = e.target.closest('button');
        if(!btn) return;
        const text = String(btn.textContent||'').replace(/\s+/g,' ').trim();
        if(!text.includes('마감') || text.includes('해제')) return;

        if(jobId && sid){
          markStudentDone(jobId, sid);
          const holders = holdersOf(jobId);
          const allDone = holders.length > 0 && holders.every(x=>isStudentDone(jobId, x));
          // 모든 담당자가 마감한 경우에만 기존 전역 마감 로직을 통과시킨다.
          if(allDone){
            try{ localStorage.setItem(doneKey(jobId, today()), '1'); }catch(_){}
            return;
          }
          // 아직 다른 담당자가 남아 있으면 기존 전역 마감 이벤트를 막는다.
          e.preventDefault();
          e.stopImmediatePropagation();
          if(typeof toast==='function') toast('내 직업 기록이 마감되었습니다. 다른 담당자는 아직 대기 중입니다.');
          setTimeout(()=>{
            try{ view.remove(); }catch(_){}
            document.body.classList.remove('no-scroll');
          }, 60);
        }
      }, true);

      view.addEventListener('click', function(e){
        const btn = e.target.closest('button');
        if(!btn) return;
        const text = String(btn.textContent||'').replace(/\s+/g,' ').trim();
        if(!text.includes('마감 해제')) return;
        if(jobId && sid){
          unmarkStudentDone(jobId, sid);
          localStorage.removeItem(doneKey(jobId, today()));
        }
      }, true);

      document.body.appendChild(view);
      scratch.remove();
      document.body.classList.add('no-scroll');

      view.querySelectorAll('button').forEach(btn=>{
        if(String(btn.textContent||'').includes('닫기')){
          btn.addEventListener('click', ()=>setTimeout(()=>{
            if(!document.querySelector('.jobcheck-view-overlay[data-student-opened="1"]')) document.body.classList.remove('no-scroll');
          },0));
        }
      });
    }catch(err){
      scratch.remove();
      console.warn('[SEBIT] 학생 직업 기존 체크리스트 연결 실패:', err);
      if(typeof toast==='function') toast('기존 체크리스트 연결을 확인해야 합니다.');
    }
  };

  // 교사용 직업 수행 현황: 직업 전체 마감이 아니라 담당 학생별 마감 상태를 보여준다.
  if(typeof renderJobPerformanceAdmin === 'function'){
    renderJobPerformanceAdmin = function(root){
      const day = today();
      const jobs = JOB_LIST_V1;
      const completedJobs = jobs.filter(j=>allAssignedDone(j.id)).length;
      const waitingJobs = jobs.length - completedJobs;

      const summarize = (id)=>{
        const data = readObj(`sebit_${id}_${day}`, {});
        const parts = [];
        if(data && typeof data==='object'){
          if(data.memo) parts.push('메모: '+String(data.memo));
          if(data.checks && typeof data.checks==='object'){
            const on = Object.entries(data.checks).filter(([,v])=>!!v).map(([a])=>a);
            if(on.length) parts.push('체크 '+on.length+'개');
          }
          const entries = Object.entries(data).filter(([kk,v])=> !['memo','checks'].includes(kk) && v && typeof v==='object');
          if(entries.length){
            const problemRows = entries.filter(([,v])=> Object.values(v||{}).some(x=>x===true || (typeof x==='string' && x.trim())));
            parts.push(problemRows.length ? '기록 학생 '+problemRows.length+'명' : '특이사항 없음');
          }
          if(!parts.length && Object.keys(data).length) parts.push('기록 있음');
        }
        return parts.length ? parts.join(' · ') : '기록 내용 없음';
      };

      root.innerHTML = `
        <style>
          .jobperf-wrap{display:grid;gap:14px;}
          .jobperf-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;}
          .jobperf-summary{display:flex;gap:10px;flex-wrap:wrap;}
          .jobperf-pill{padding:10px 14px;border:1px solid rgba(0,0,0,.08);border-radius:16px;background:rgba(255,255,255,.7);font-weight:800;}
          .jobperf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;}
          .jobperf-card{border:1px solid rgba(0,0,0,.08);border-radius:18px;background:rgba(255,255,255,.78);padding:14px;box-shadow:0 8px 22px rgba(0,0,0,.04);}
          .jobperf-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:8px;}
          .jobperf-title{font-size:16px;font-weight:900;}
          .jobperf-badge{font-size:12px;font-weight:900;border-radius:999px;padding:6px 10px;white-space:nowrap;}
          .jobperf-badge.done{background:#dff5e8;color:#176c3b;border:1px solid #bde8cf;}
          .jobperf-badge.partial{background:#e8f0ff;color:#2855b8;border:1px solid #c8d8ff;}
          .jobperf-badge.wait{background:#fff4d9;color:#7b5200;border:1px solid #f0dc9b;}
          .jobperf-meta{font-size:13px;color:#666;line-height:1.5;margin-top:6px;}
          .jobperf-result{margin-top:10px;padding:10px;border-radius:14px;background:rgba(245,247,250,.9);font-size:13px;line-height:1.5;color:#444;}
          .jobperf-students{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
          .jobperf-student{font-size:12px;font-weight:800;padding:5px 8px;border-radius:999px;border:1px solid rgba(0,0,0,.08);background:#fff;}
          .jobperf-student.done{background:#dff5e8;color:#176c3b;border-color:#bde8cf;}
          .jobperf-student.wait{background:#fff4d9;color:#7b5200;border-color:#f0dc9b;}
          .jobperf-tools{display:flex;justify-content:flex-end;gap:8px;}
        </style>
        <div class="jobperf-wrap">
          <div class="jobperf-head">
            <div>
              <div class="muted">${esc(day)} 기준 · 담당 학생별로 마감 상태를 따로 반영합니다.</div>
            </div>
            <div class="jobperf-summary">
              <div class="jobperf-pill">전체 완료 ${completedJobs} / ${jobs.length}</div>
              <div class="jobperf-pill">진행 중 ${waitingJobs}</div>
            </div>
          </div>
          <div class="jobperf-tools"><button class="btn small" type="button" id="jobperfRefreshBtn">새로고침</button></div>
          <div class="jobperf-grid">
            ${jobs.map(j=>{
              const holders = holdersOf(j.id);
              const doneHolders = holders.filter(sid=>isStudentDone(j.id, sid));
              const any = doneHolders.length > 0;
              const all = holders.length > 0 && doneHolders.length === holders.length;
              const legacyDone = localStorage.getItem(doneKey(j.id, day)) === '1' || localStorage.getItem(`sebit_${j.id}_closed_${day}`)==='1';
              const cls = all ? 'done' : (any ? 'partial' : 'wait');
              const label = all ? '마감 완료' : (any ? `일부 마감 ${doneHolders.length}/${holders.length}` : '대기 중');
              return `<div class="jobperf-card">
                <div class="jobperf-top">
                  <div class="jobperf-title">${esc(j.name)}</div>
                  <div class="jobperf-badge ${cls}">${esc(label)}</div>
                </div>
                <div class="jobperf-meta">담당: ${holders.length?esc(holders.map(studentNameById).join(', ')):'배정 없음'}</div>
                ${holders.length ? `<div class="jobperf-students">
                  ${holders.map(sid=>`<span class="jobperf-student ${isStudentDone(j.id,sid)?'done':'wait'}">${esc(studentNameById(sid))} · ${isStudentDone(j.id,sid)?'완료':'대기'}</span>`).join('')}
                </div>` : ``}
                <div class="jobperf-result">${(all || any || legacyDone) ? esc(summarize(j.id)) : '아직 학생 체크리스트가 마감되지 않았습니다.'}</div>
              </div>`;
            }).join('')}
          </div>
        </div>
      `;
      root.querySelector('#jobperfRefreshBtn')?.addEventListener('click', ()=>renderJobPerformanceAdmin(root));
    };
  }

  // 학생용 직업 현황도 학생별 마감 기준으로 보정
  if(typeof renderStudentJobStatusHTML === 'function'){
    renderStudentJobStatusHTML = function(){
      const day = today();
      const students = readJSON(LS.students, []);
      const active = Array.isArray(students) ? students.filter(s=>s && s.active!==false) : [];
      const rows = [];
      active.forEach(s=>{
        const jobs = Array.isArray(s.jobs) ? s.jobs : [];
        jobs.filter(Boolean).forEach(job=>{
          const matched = matchJob(job);
          rows.push({ studentId:String(s.id||''), studentName:String(s.name||s.id||''), jobName:String(job), jobId:matched.id, done: matched.id ? isStudentDone(matched.id, String(s.id||'')) : false });
        });
      });
      const doneCount = rows.filter(r=>r.done).length;
      const myId = String(session?.studentId||'');
      const myRows = rows.filter(r=>String(r.studentId)===myId);
      const myText = myRows.length ? myRows.map(r=>r.jobName).join(', ') : '배정된 직업 없음';
      if(!rows.length){
        return `
          <div class="student-job-summary">
            <div class="student-job-pill">오늘 날짜 ${esc(day)}</div>
            <div class="student-job-pill">배정된 직업 없음</div>
          </div>
          <div class="muted">아직 직업 배정이 확정되지 않았습니다.</div>
        `;
      }
      return `
        <div class="student-job-summary">
          <div class="student-job-pill">오늘 날짜 ${esc(day)}</div>
          <div class="student-job-pill">내 직업: ${esc(myText)}</div>
          <div class="student-job-pill">마감 ${doneCount}/${rows.length}</div>
        </div>
        <div class="student-job-grid">
          ${rows.map(r=>`
            <div class="student-job-card">
              <div class="student-job-name">${esc(r.jobName)}</div>
              <div class="student-job-holder">담당: ${esc(r.studentName)}</div>
              <span class="student-job-state ${r.done?'done':'wait'}">${r.done?'마감 완료':'기록 대기'}</span>
              <div class="student-job-note">각 담당자가 자기 체크리스트를 마감해야 완료로 표시됩니다.</div>
            </div>
          `).join('')}
        </div>
      `;
    };
  }
})();


/* === FORCE FIX: job performance must be per-student, not per-job (2026-04-24) === */
(function(){
  const JOBS = [
    { id:'ranger', name:'교실 레인저', aliases:['교실 레인저','레인저'] },
    { id:'fairjustice', name:'페어 저스티스', aliases:['페어 저스티스','공정'] },
    { id:'timekeeper', name:'타임 키퍼', aliases:['타임 키퍼','시간'] },
    { id:'techkeeper', name:'테크 키퍼', aliases:['테크 키퍼','패드','기기'] },
    { id:'studycheck', name:'학습 체크단', aliases:['학습 체크단','준비물'] },
    { id:'tidymaster', name:'정리 마스터', aliases:['정리 마스터','정리'] },
    { id:'lightguardian_front', name:'빛의 파수꾼(앞)', aliases:['빛의 파수꾼(앞)','빛의 파수꾼 앞','파수꾼 앞'] },
    { id:'lightguardian_back', name:'빛의 파수꾼(뒤)', aliases:['빛의 파수꾼(뒤)','빛의 파수꾼 뒤','파수꾼 뒤'] },
    { id:'artcurator', name:'작품 큐레이터', aliases:['작품 큐레이터','작품'] },
    { id:'greensaver', name:'그린 세이버', aliases:['그린 세이버','분리배출','환경'] },
    { id:'docmaster', name:'문서 마스터', aliases:['문서 마스터','문서'] },
    { id:'weathercaster', name:'웨더 캐스터', aliases:['웨더 캐스터','날씨'] },
    { id:'lunchsaver', name:'런치 세이버', aliases:['런치 세이버','런치마스터','급식'] },
    { id:'lightmerchant', name:'빛의 상인', aliases:['빛의 상인','상점','상인'] }
  ];
  const norm = v => String(v||'').replace(/\s+/g,'').toLowerCase();
  const esc = v => String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const dayKey = () => (typeof todayKey === 'function' ? todayKey() : new Date().toISOString().slice(0,10));
  const read = (k, fb) => { try{ const raw=localStorage.getItem(k); return raw ? JSON.parse(raw) : fb; }catch(_){ return fb; } };
  const students = () => Array.isArray(read(LS.students, [])) ? read(LS.students, []) : [];
  const studentName = sid => {
    const s = students().find(x => String(x?.id||'') === String(sid||''));
    return s ? String(s.name || sid) : String(sid||'');
  };
  const matchJob = name => {
    const n = norm(name);
    return JOBS.find(j => [j.name, ...(j.aliases||[])].some(a => n.includes(norm(a)) || norm(a).includes(n))) || null;
  };
  const assign = () => read('sebit:jobsAssign_v1', {version:1,jobs:{}});
  const holdersOf = jobId => {
    const out = [];
    const cur = assign()?.jobs?.[jobId] || {};
    const raw = Array.isArray(cur.holders) ? cur.holders : (Array.isArray(cur.students) ? cur.students : []);
    raw.forEach(id => { const s=String(id||''); if(s && !out.includes(s)) out.push(s); });
    const job = JOBS.find(j=>j.id===jobId);
    students().forEach(st => {
      const sid = String(st?.id||'');
      const js = Array.isArray(st?.jobs) ? st.jobs : [];
      if(sid && job && js.some(x => matchJob(String(x))?.id === jobId) && !out.includes(sid)) out.push(sid);
    });
    return out;
  };
  const doneKey = (jobId, sid='', d=dayKey()) => `sebit_jobdone_${jobId}_${d}${sid ? '_' + String(sid) : ''}`;
  const legacyClosedKey = (jobId, d=dayKey()) => `sebit_${jobId}_closed_${d}`;
  const markDone = (jobId, sid) => {
    if(!jobId || !sid) return;
    const d = dayKey();
    localStorage.setItem(doneKey(jobId, sid, d), '1');
    localStorage.removeItem(doneKey(jobId, '', d));
    localStorage.removeItem(legacyClosedKey(jobId, d));
    const logKey = `sebit_jobdone_log_${jobId}_${d}`;
    const log = read(logKey, {});
    log[String(sid)] = {studentId:String(sid), studentName:studentName(sid), at:Date.now()};
    localStorage.setItem(logKey, JSON.stringify(log));
  };
  const unmarkDone = (jobId, sid) => {
    if(!jobId || !sid) return;
    const d = dayKey();
    localStorage.removeItem(doneKey(jobId, sid, d));
    localStorage.removeItem(doneKey(jobId, '', d));
    localStorage.removeItem(legacyClosedKey(jobId, d));
    const logKey = `sebit_jobdone_log_${jobId}_${d}`;
    const log = read(logKey, {});
    delete log[String(sid)];
    localStorage.setItem(logKey, JSON.stringify(log));
  };
  const isDone = (jobId, sid) => localStorage.getItem(doneKey(jobId, sid)) === '1';
  const summarize = jobId => {
    const data = read(`sebit_${jobId}_${dayKey()}`, {});
    if(!data || typeof data !== 'object' || Object.keys(data).length===0) return '기록 내용 없음';
    if(data.memo) return '메모: ' + String(data.memo);
    const entries = Object.entries(data).filter(([,v]) => v && typeof v === 'object');
    if(entries.length){
      const filled = entries.filter(([,v]) => Object.values(v).some(x => x===true || (typeof x==='string' && x.trim())));
      return filled.length ? `기록 학생 ${filled.length}명` : '특이사항 없음';
    }
    return '기록 있음';
  };

  window.__sebitOpenExistingJobChecklist = function(jobName){
    const job = matchJob(jobName);
    const sid = String(session?.studentId || '');
    if(!job || !sid){ if(typeof toast==='function') toast('직업 연결 정보를 찾지 못했습니다.'); return; }
    const d = dayKey();
    localStorage.removeItem(doneKey(job.id, '', d));
    localStorage.removeItem(legacyClosedKey(job.id, d));

    const oldScratch = document.getElementById('studentJobChecklistScratch');
    if(oldScratch) oldScratch.remove();
    const oldView = document.querySelector('.jobcheck-view-overlay[data-student-opened="1"]');
    if(oldView) oldView.remove();

    const scratch = document.createElement('div');
    scratch.id = 'studentJobChecklistScratch';
    scratch.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(scratch);
    try{
      renderJobsAdmin(scratch);
      const hubBtn = Array.from(scratch.querySelectorAll('button')).find(b => String(b.textContent||'').includes('직업 체크리스트 관리'));
      if(!hubBtn) throw new Error('hub button missing');
      hubBtn.click();
      const cards = Array.from(scratch.querySelectorAll('.jobcheck-hub-card'));
      const card = cards.find(c => {
        const t = norm(c.querySelector('.name')?.textContent || c.textContent || '');
        return [job.name, ...(job.aliases||[])].some(a => t.includes(norm(a)) || norm(a).includes(t));
      });
      if(!card) throw new Error('job card missing');
      const openBtn = Array.from(card.querySelectorAll('button')).find(b => String(b.textContent||'').trim()==='열기') || card.querySelector('button');
      if(!openBtn) throw new Error('open button missing');
      openBtn.click();
      const view = scratch.querySelector('.jobcheck-view-overlay');
      if(!view) throw new Error('view missing');
      view.dataset.studentOpened = '1';
      view.dataset.jobId = job.id;
      view.style.zIndex = '9999';
      view.addEventListener('click', function(e){
        const btn = e.target.closest('button');
        if(!btn) return;
        const text = String(btn.textContent||'').replace(/\s+/g,' ').trim();
        if(text.includes('마감 해제')){
          e.preventDefault(); e.stopImmediatePropagation();
          unmarkDone(job.id, sid);
          if(typeof toast==='function') toast('내 직업 마감이 해제되었습니다.');
          return;
        }
        if(text.includes('기록 마감') || text === '마감'){
          e.preventDefault(); e.stopImmediatePropagation();
          markDone(job.id, sid);
          if(typeof toast==='function') toast('내 직업 기록이 마감되었습니다.');
          setTimeout(()=>{ try{ view.remove(); }catch(_){} document.body.classList.remove('no-scroll'); }, 80);
        }
      }, true);
      document.body.appendChild(view);
      scratch.remove();
      document.body.classList.add('no-scroll');
    }catch(err){
      scratch.remove();
      console.warn('[SEBIT] job checklist bridge failed:', err);
      if(typeof toast==='function') toast('기존 체크리스트 연결을 확인해야 합니다.');
    }
  };

  window.renderJobPerformanceAdmin = function(root){
    const d = dayKey();
    const completed = JOBS.filter(j => { const h=holdersOf(j.id); return h.length && h.every(sid=>isDone(j.id,sid)); }).length;
    root.innerHTML = `
      <style>
        .jobperf-wrap{display:grid;gap:14px}.jobperf-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.jobperf-summary{display:flex;gap:10px;flex-wrap:wrap}.jobperf-pill{padding:10px 14px;border:1px solid rgba(0,0,0,.08);border-radius:16px;background:rgba(255,255,255,.7);font-weight:800}.jobperf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.jobperf-card{border:1px solid rgba(0,0,0,.08);border-radius:18px;background:rgba(255,255,255,.78);padding:14px;box-shadow:0 8px 22px rgba(0,0,0,.04)}.jobperf-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:8px}.jobperf-title{font-size:16px;font-weight:900}.jobperf-badge{font-size:12px;font-weight:900;border-radius:999px;padding:6px 10px;white-space:nowrap}.jobperf-badge.done{background:#dff5e8;color:#176c3b;border:1px solid #bde8cf}.jobperf-badge.partial{background:#e8f0ff;color:#2855b8;border:1px solid #c8d8ff}.jobperf-badge.wait{background:#fff4d9;color:#7b5200;border:1px solid #f0dc9b}.jobperf-meta{font-size:13px;color:#666;line-height:1.5;margin-top:6px}.jobperf-result{margin-top:10px;padding:10px;border-radius:14px;background:rgba(245,247,250,.9);font-size:13px;line-height:1.5;color:#444}.jobperf-students{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.jobperf-student{font-size:12px;font-weight:800;padding:5px 8px;border-radius:999px;border:1px solid rgba(0,0,0,.08);background:#fff}.jobperf-student.done{background:#dff5e8;color:#176c3b;border-color:#bde8cf}.jobperf-student.wait{background:#fff4d9;color:#7b5200;border-color:#f0dc9b}.jobperf-tools{display:flex;justify-content:flex-end;gap:8px}
      </style>
      <div class="jobperf-wrap">
        <div class="jobperf-head"><div class="muted">${esc(d)} 기준 · 담당 학생별로 마감 상태를 따로 표시합니다.</div><div class="jobperf-summary"><div class="jobperf-pill">전체 완료 ${completed} / ${JOBS.length}</div><div class="jobperf-pill">진행 중 ${JOBS.length-completed}</div></div></div>
        <div class="jobperf-tools"><button class="btn small" type="button" id="jobperfRefreshBtn">새로고침</button></div>
        <div class="jobperf-grid">
          ${JOBS.map(j=>{
            const h = holdersOf(j.id);
            const done = h.filter(sid=>isDone(j.id,sid));
            const all = h.length && done.length === h.length;
            const any = done.length > 0;
            const cls = all ? 'done' : (any ? 'partial' : 'wait');
            const label = all ? '마감 완료' : (any ? `일부 마감 ${done.length}/${h.length}` : '대기 중');
            return `<div class="jobperf-card"><div class="jobperf-top"><div class="jobperf-title">${esc(j.name)}</div><div class="jobperf-badge ${cls}">${esc(label)}</div></div><div class="jobperf-meta">담당: ${h.length ? esc(h.map(studentName).join(', ')) : '배정 없음'}</div>${h.length ? `<div class="jobperf-students">${h.map(sid=>`<span class="jobperf-student ${isDone(j.id,sid)?'done':'wait'}">${esc(studentName(sid))} · ${isDone(j.id,sid)?'완료':'대기'}</span>`).join('')}</div>` : ''}<div class="jobperf-result">${any ? esc(summarize(j.id)) : '아직 학생 체크리스트가 마감되지 않았습니다.'}</div></div>`;
          }).join('')}
        </div>
      </div>`;
    root.querySelector('#jobperfRefreshBtn')?.addEventListener('click', ()=>window.renderJobPerformanceAdmin(root));
  };
})();

/* === FINAL FIX v2: student job close saves per-student + admin reads per-student (2026-04-24) === */
(function(){
  const JOBS = [
    { id:'ranger', name:'교실 레인저', aliases:['교실 레인저','레인저'] },
    { id:'fairjustice', name:'페어 저스티스', aliases:['페어 저스티스','공정'] },
    { id:'timekeeper', name:'타임 키퍼', aliases:['타임 키퍼','시간'] },
    { id:'techkeeper', name:'테크 키퍼', aliases:['테크 키퍼','패드','기기'] },
    { id:'studycheck', name:'학습 체크단', aliases:['학습 체크단','준비물'] },
    { id:'tidymaster', name:'정리 마스터', aliases:['정리 마스터','정리'] },
    { id:'lightguardian_front', name:'빛의 파수꾼(앞)', aliases:['빛의 파수꾼(앞)','빛의 파수꾼 앞','파수꾼 앞'] },
    { id:'lightguardian_back', name:'빛의 파수꾼(뒤)', aliases:['빛의 파수꾼(뒤)','빛의 파수꾼 뒤','파수꾼 뒤'] },
    { id:'artcurator', name:'작품 큐레이터', aliases:['작품 큐레이터','작품'] },
    { id:'greensaver', name:'그린 세이버', aliases:['그린 세이버','분리배출','환경'] },
    { id:'docmaster', name:'문서 마스터', aliases:['문서 마스터','문서'] },
    { id:'weathercaster', name:'웨더 캐스터', aliases:['웨더 캐스터','날씨'] },
    { id:'lunchsaver', name:'런치 세이버', aliases:['런치 세이버','런치마스터','급식'] },
    { id:'lightmerchant', name:'빛의 상인', aliases:['빛의 상인','상점','상인'] }
  ];
  const norm = v => String(v||'').replace(/\s+/g,'').toLowerCase();
  const esc = v => String(v ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const dayKeySafe = () => (typeof todayKey === 'function' ? todayKey() : new Date().toISOString().slice(0,10));
  const read = (k, fb) => { try{ const raw=localStorage.getItem(k); return raw ? JSON.parse(raw) : fb; }catch(_){ return fb; } };
  const students = () => Array.isArray(read(LS.students, [])) ? read(LS.students, []) : [];
  const studentName = sid => { const s = students().find(x => String(x?.id||'') === String(sid||'')); return s ? String(s.name || sid) : String(sid||''); };
  const matchJob = name => { const n = norm(name); return JOBS.find(j => [j.name, ...(j.aliases||[])].some(a => n.includes(norm(a)) || norm(a).includes(n))) || null; };
  const doneKey = (jobId, sid='', d=dayKeySafe()) => `sebit_jobdone_${jobId}_${d}${sid ? '_' + String(sid) : ''}`;
  const legacyClosedKey = (jobId, d=dayKeySafe()) => `sebit_${jobId}_closed_${d}`;
  const logKey = (jobId, d=dayKeySafe()) => `sebit_jobdone_log_${jobId}_${d}`;
  const assign = () => read('sebit:jobsAssign_v1', {version:1,jobs:{}});
  const holdersOf = jobId => {
    const out = [];
    const cur = assign()?.jobs?.[jobId] || {};
    const raw = Array.isArray(cur.holders) ? cur.holders : (Array.isArray(cur.students) ? cur.students : []);
    raw.forEach(id => { const s=String(id||''); if(s && !out.includes(s)) out.push(s); });
    students().forEach(st => {
      const sid = String(st?.id||'');
      const js = Array.isArray(st?.jobs) ? st.jobs : [];
      if(sid && js.some(x => matchJob(String(x))?.id === jobId) && !out.includes(sid)) out.push(sid);
    });
    return out;
  };
  const markDone = (jobId, sid) => {
    if(!jobId || !sid) return;
    const d = dayKeySafe();
    localStorage.setItem(doneKey(jobId, sid, d), '1');
    // 전체 직업 마감 키는 더 이상 상태 판단에 쓰지 않도록 제거
    localStorage.removeItem(doneKey(jobId, '', d));
    localStorage.removeItem(legacyClosedKey(jobId, d));
    const log = read(logKey(jobId, d), {});
    log[String(sid)] = { studentId:String(sid), studentName:studentName(sid), at:Date.now() };
    localStorage.setItem(logKey(jobId, d), JSON.stringify(log));
  };
  const unmarkDone = (jobId, sid) => {
    if(!jobId || !sid) return;
    const d = dayKeySafe();
    localStorage.removeItem(doneKey(jobId, sid, d));
    localStorage.removeItem(doneKey(jobId, '', d));
    localStorage.removeItem(legacyClosedKey(jobId, d));
    const log = read(logKey(jobId, d), {});
    delete log[String(sid)];
    localStorage.setItem(logKey(jobId, d), JSON.stringify(log));
  };
  const isDone = (jobId, sid) => localStorage.getItem(doneKey(jobId, sid)) === '1';
  const summarize = jobId => {
    const d = dayKeySafe();
    const data = read(`sebit_${jobId}_${d}`, {});
    const log = read(logKey(jobId, d), {});
    const parts = [];
    if(Object.keys(log||{}).length) parts.push(`마감 ${Object.keys(log).length}명`);
    if(data && typeof data==='object'){
      if(data.memo) parts.push('메모: '+String(data.memo));
      const entries = Object.entries(data).filter(([,v]) => v && typeof v === 'object');
      if(entries.length){
        const filled = entries.filter(([,v]) => Object.values(v).some(x => x===true || (typeof x==='string' && x.trim())));
        if(filled.length) parts.push(`기록 학생 ${filled.length}명`);
      } else if(Object.keys(data).length && !data.memo) parts.push('기록 있음');
    }
    return parts.length ? parts.join(' · ') : '기록 내용 없음';
  };

  // 기존 체크리스트 화면이 전체 직업 키를 저장하더라도, 현재 학생의 개인 키로 확정 저장되도록 보정
  const nativeSetItem = localStorage.setItem.bind(localStorage);
  if(!window.__sebitJobSetItemPatched){
    window.__sebitJobSetItemPatched = true;
    localStorage.setItem = function(key, value){
      try{
        const ctx = window.__sebitCurrentStudentJobCtx;
        if(ctx && ctx.jobId && ctx.sid){
          const d = ctx.day || dayKeySafe();
          if(String(key) === doneKey(ctx.jobId, '', d) || String(key) === legacyClosedKey(ctx.jobId, d)){
            nativeSetItem(doneKey(ctx.jobId, ctx.sid, d), '1');
            const log = read(logKey(ctx.jobId, d), {});
            log[String(ctx.sid)] = { studentId:String(ctx.sid), studentName:studentName(ctx.sid), at:Date.now() };
            nativeSetItem(logKey(ctx.jobId, d), JSON.stringify(log));
            return;
          }
        }
      }catch(_){}
      return nativeSetItem(key, value);
    };
  }

  window.__sebitOpenExistingJobChecklist = function(jobName){
    const job = matchJob(jobName);
    const sid = String(session?.studentId || '');
    if(!job || !sid){ if(typeof toast==='function') toast('직업 연결 정보를 찾지 못했습니다.'); return; }
    const d = dayKeySafe();
    window.__sebitCurrentStudentJobCtx = { jobId:job.id, sid, day:d };
    localStorage.removeItem(doneKey(job.id, '', d));
    localStorage.removeItem(legacyClosedKey(job.id, d));

    const oldScratch = document.getElementById('studentJobChecklistScratch');
    if(oldScratch) oldScratch.remove();
    const oldView = document.querySelector('.jobcheck-view-overlay[data-student-opened="1"]');
    if(oldView) oldView.remove();

    const scratch = document.createElement('div');
    scratch.id = 'studentJobChecklistScratch';
    scratch.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    document.body.appendChild(scratch);
    try{
      renderJobsAdmin(scratch);
      const hubBtn = Array.from(scratch.querySelectorAll('button')).find(b => String(b.textContent||'').includes('직업 체크리스트 관리'));
      if(!hubBtn) throw new Error('hub button missing');
      hubBtn.click();
      const cards = Array.from(scratch.querySelectorAll('.jobcheck-hub-card'));
      const card = cards.find(c => {
        const t = norm(c.querySelector('.name')?.textContent || c.textContent || '');
        return [job.name, ...(job.aliases||[])].some(a => t.includes(norm(a)) || norm(a).includes(t));
      });
      if(!card) throw new Error('job card missing');
      const openBtn = Array.from(card.querySelectorAll('button')).find(b => String(b.textContent||'').trim()==='열기') || card.querySelector('button');
      if(!openBtn) throw new Error('open button missing');
      openBtn.click();
      const view = scratch.querySelector('.jobcheck-view-overlay');
      if(!view) throw new Error('view missing');
      view.dataset.studentOpened = '1';
      view.dataset.jobId = job.id;
      view.style.zIndex = '9999';
      view.addEventListener('click', function(e){
        const btn = e.target.closest('button');
        if(!btn) return;
        const text = String(btn.textContent||'').replace(/\s+/g,' ').trim();
        if(text.includes('마감 해제')){
          unmarkDone(job.id, sid);
          if(typeof toast==='function') toast('내 직업 마감이 해제되었습니다.');
          return;
        }
        if(text.includes('기록 마감') || text === '마감'){
          // 기존 화면 저장도 진행시키고, 개인 키도 확실히 저장
          markDone(job.id, sid);
          setTimeout(()=>{ markDone(job.id, sid); }, 50);
          setTimeout(()=>{ window.__sebitCurrentStudentJobCtx = null; }, 1200);
        }
      }, true);
      document.body.appendChild(view);
      scratch.remove();
      document.body.classList.add('no-scroll');
    }catch(err){
      scratch.remove();
      window.__sebitCurrentStudentJobCtx = null;
      console.warn('[SEBIT] job checklist bridge failed:', err);
      if(typeof toast==='function') toast('기존 체크리스트 연결을 확인해야 합니다.');
    }
  };

  // 교사용 현황은 반드시 개인별 키만 읽는다. 전체 마감 키는 무시한다.
  renderJobPerformanceAdmin = function(root){
    const d = dayKeySafe();
    const completed = JOBS.filter(j => { const h=holdersOf(j.id); return h.length && h.every(sid=>isDone(j.id,sid)); }).length;
    root.innerHTML = `
      <style>
        .jobperf-wrap{display:grid;gap:14px}.jobperf-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.jobperf-summary{display:flex;gap:10px;flex-wrap:wrap}.jobperf-pill{padding:10px 14px;border:1px solid rgba(0,0,0,.08);border-radius:16px;background:rgba(255,255,255,.7);font-weight:800}.jobperf-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.jobperf-card{border:1px solid rgba(0,0,0,.08);border-radius:18px;background:rgba(255,255,255,.78);padding:14px;box-shadow:0 8px 22px rgba(0,0,0,.04)}.jobperf-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:8px}.jobperf-title{font-size:16px;font-weight:900}.jobperf-badge{font-size:12px;font-weight:900;border-radius:999px;padding:6px 10px;white-space:nowrap}.jobperf-badge.done{background:#dff5e8;color:#176c3b;border:1px solid #bde8cf}.jobperf-badge.partial{background:#e8f0ff;color:#2855b8;border:1px solid #c8d8ff}.jobperf-badge.wait{background:#fff4d9;color:#7b5200;border:1px solid #f0dc9b}.jobperf-meta{font-size:13px;color:#666;line-height:1.5;margin-top:6px}.jobperf-result{margin-top:10px;padding:10px;border-radius:14px;background:rgba(245,247,250,.9);font-size:13px;line-height:1.5;color:#444}.jobperf-students{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.jobperf-student{font-size:12px;font-weight:800;padding:5px 8px;border-radius:999px;border:1px solid rgba(0,0,0,.08);background:#fff}.jobperf-student.done{background:#dff5e8;color:#176c3b;border-color:#bde8cf}.jobperf-student.wait{background:#fff4d9;color:#7b5200;border-color:#f0dc9b}.jobperf-tools{display:flex;justify-content:flex-end;gap:8px}
      </style>
      <div class="jobperf-wrap">
        <div class="jobperf-head"><div class="muted">${esc(d)} 기준 · 담당 학생별 마감 상태를 따로 표시합니다.</div><div class="jobperf-summary"><div class="jobperf-pill">전체 완료 ${completed} / ${JOBS.length}</div><div class="jobperf-pill">진행 중 ${JOBS.length-completed}</div></div></div>
        <div class="jobperf-tools"><button class="btn small" type="button" id="jobperfRefreshBtn">새로고침</button></div>
        <div class="jobperf-grid">
          ${JOBS.map(j=>{
            const h = holdersOf(j.id);
            const done = h.filter(sid=>isDone(j.id,sid));
            const all = h.length && done.length === h.length;
            const any = done.length > 0;
            const cls = all ? 'done' : (any ? 'partial' : 'wait');
            const label = all ? '마감 완료' : (any ? `일부 마감 ${done.length}/${h.length}` : '대기 중');
            return `<div class="jobperf-card"><div class="jobperf-top"><div class="jobperf-title">${esc(j.name)}</div><div class="jobperf-badge ${cls}">${esc(label)}</div></div><div class="jobperf-meta">담당: ${h.length ? esc(h.map(studentName).join(', ')) : '배정 없음'}</div>${h.length ? `<div class="jobperf-students">${h.map(sid=>`<span class="jobperf-student ${isDone(j.id,sid)?'done':'wait'}">${esc(studentName(sid))} · ${isDone(j.id,sid)?'완료':'대기'}</span>`).join('')}</div>` : ''}<div class="jobperf-result">${any ? esc(summarize(j.id)) : '아직 학생 체크리스트가 마감되지 않았습니다.'}</div></div>`;
          }).join('')}
        </div>
      </div>`;
    root.querySelector('#jobperfRefreshBtn')?.addEventListener('click', ()=>renderJobPerformanceAdmin(root));
  };
})();



/* === SEBIT image fallback + student quick button force bind (v62) === */
(function(){
  if(window.__sebitImageQuickPatchV62) return;
  window.__sebitImageQuickPatchV62 = true;

  function unique(arr){
    const seen = new Set();
    return arr.filter(x=>{
      x = String(x||"").trim();
      if(!x || seen.has(x)) return false;
      seen.add(x);
      return true;
    });
  }

  function charCandidatesFromSrc(src){
    const s = String(src||"");
    let n = "";
    const m1 = s.match(/CHR[-_]?(\d+)/i);
    const m2 = s.match(/characters\/(\d+)\.png/i);
    if(m1) n = m1[1];
    else if(m2) n = m2[1];
    if(!n) return [];
    return unique([
      `assets/characters/CHR-${n}.png`,
      `./assets/characters/CHR-${n}.png`,
      `assets/characters/chr-${n}.png`,
      `assets/characters/${n}.png`,
      `assets/chars/CHR-${n}.png`,
      `assets/avatar/CHR-${n}.png`,
      `assets/avatars/CHR-${n}.png`
    ]);
  }

  function shopCandidatesFromSrc(src){
    const s = String(src||"");
    const m = s.match(/shop\/(\d+)\.png/i);
    if(!m) return [];
    const n = m[1];
    return unique([
      `assets/shop/${n}.png`,
      `./assets/shop/${n}.png`,
      `assets/shops/${n}.png`,
      `assets/store/${n}.png`,
      `assets/shop/shop-${n}.png`
    ]);
  }

  window.sebitTryImageFallback = function(img){
    if(!img || img.tagName !== "IMG") return;
    const current = img.getAttribute("src") || "";
    let candidates = [];
    if(current.includes("characters") || /CHR[-_]?\d+/i.test(current)){
      candidates = charCandidatesFromSrc(current);
    }else if(current.includes("shop/")){
      candidates = shopCandidatesFromSrc(current);
    }
    const tried = new Set(String(img.dataset.sebitTried || "").split("|").filter(Boolean));
    tried.add(current);
    const next = candidates.find(x=>!tried.has(x));
    img.dataset.sebitTried = [...tried].join("|");
    if(next){
      img.src = next;
      return;
    }
    // 마지막 안전장치: 깨진 이미지 아이콘 대신 alt 텍스트 표시
    const alt = img.getAttribute("alt") || "이미지";
    const span = document.createElement("span");
    span.textContent = alt;
    span.style.fontSize = "12px";
    span.style.opacity = ".75";
    span.style.display = "inline-flex";
    span.style.alignItems = "center";
    span.style.justifyContent = "center";
    span.style.width = img.width ? img.width + "px" : "100%";
    span.style.minHeight = "32px";
    try{ img.replaceWith(span); }catch(_){}
  };

  document.addEventListener("error", function(e){
    const img = e.target;
    if(img && img.tagName === "IMG"){
      window.sebitTryImageFallback(img);
    }
  }, true);

  // 학생용 하단 퀵버튼: HTML onclick이 없어도 텍스트 기준으로 연결
  document.addEventListener("click", function(e){
    const btn = e.target && e.target.closest ? e.target.closest("button, .btn, [role='button'], a") : null;
    if(!btn) return;
    const text = String(btn.textContent || "").replace(/\s+/g, " ").trim();
    if(!text) return;

    const quickModal = document.getElementById("studentQuickModal");
    const inQuickModal = !!(quickModal && quickModal.contains(btn));
    const page = String(document.body.getAttribute("data-page") || "");
    const isStudentArea = inQuickModal || page.startsWith("student-");
    if(!isStudentArea) return;

    if(text.includes("세빛 헌법")){
      e.preventDefault();
      e.stopPropagation();
      if(quickModal) quickModal.classList.add("hidden");
      if(typeof openStudentConstitutionView === "function") openStudentConstitutionView();
      else if(typeof toast === "function") toast("세빛 헌법 보기 기능을 찾지 못했습니다.");
      return;
    }

    if(text.includes("직업 현황")){
      e.preventDefault();
      e.stopPropagation();
      if(quickModal) quickModal.classList.add("hidden");
      if(typeof openStudentJobStatusView === "function") openStudentJobStatusView();
      else if(typeof toast === "function") toast("직업 현황 보기 기능을 찾지 못했습니다.");
      return;
    }
  }, true);
})();


/* =========================================================
   SEBIT FINAL STABILIZER: jobs + shop realtime (iPad safe)
   - 직업 localStorage 키를 더 넓게 감지해 Firestore jobState에 저장
   - 상점 sharedState 변경 시 학생/교사 화면을 강제로 다시 그림
   - 직업 배정 변경 시 students[].jobs도 같이 반영해 학생 화면에 즉시 표시
   ========================================================= */
(function(){
  if(window.__sebitFinalJobsShopStabilizerInstalled) return;
  window.__sebitFinalJobsShopStabilizerInstalled = true;

  const FINAL_FIXED_JOBS = [
    { id:"ranger", name:"교실 레인저" },
    { id:"fairjustice", name:"페어 저스티스" },
    { id:"timekeeper", name:"타임 키퍼" },
    { id:"techkeeper", name:"테크 키퍼" },
    { id:"studycheck", name:"학습 체크단" },
    { id:"tidymaster", name:"정리 마스터" },
    { id:"lightguardian_front", name:"빛의 파수꾼(앞)" },
    { id:"lightguardian_back",  name:"빛의 파수꾼(뒤)" },
    { id:"artcurator", name:"작품 큐레이터" },
    { id:"greensaver", name:"그린 세이버" },
    { id:"docmaster", name:"문서 마스터" },
    { id:"weathercaster", name:"웨더 캐스터" },
    { id:"lunchsaver", name:"런치 세이버" },
    { id:"lightmerchant", name:"빛의 상인" }
  ];

  window.sebitFinalDeriveStudentJobsFromAssign = function(){
    try{
      const raw = localStorage.getItem("sebit:jobsAssign_v1");
      if(!raw) return false;
      const assign = JSON.parse(raw || '{"version":1,"jobs":{}}');
      const st = JSON.parse(localStorage.getItem("sebit:students") || "[]");
      if(!Array.isArray(st)) return false;
      const byId = new Map(st.map(s=>[String(s.id||""), s]));
      st.forEach(s=>{ s.jobs = []; });
      FINAL_FIXED_JOBS.forEach(j=>{
        const cur = assign && assign.jobs ? assign.jobs[j.id] : null;
        const holders = Array.isArray(cur && cur.holders) ? cur.holders : [];
        holders.forEach(hid=>{
          const s = byId.get(String(hid));
          if(!s) return;
          if(!Array.isArray(s.jobs)) s.jobs = [];
          if(!s.jobs.includes(j.name)) s.jobs.push(j.name);
        });
      });
      localStorage.setItem("sebit:students", JSON.stringify(st));
      try{ if(typeof syncStudentsToFirestoreNow === "function") syncStudentsToFirestoreNow(); }catch(_){ }
      return true;
    }catch(err){ console.warn("[SEBIT FINAL] derive jobs -> students skipped", err); return false; }
  };



  window.sebitFinalLoadShopProductsDocNow = async function(){
    try{
      const snap = await doc(db, FS_SHARED_STATE_COLLECTION, "shopProducts").get();
      const exists = (typeof snap.exists === "function") ? snap.exists() : !!snap.exists;
      if(!exists) return false;
      const data = snap.data() || {};
      localStorage.setItem(LS.shopProducts, JSON.stringify(data.value !== undefined ? data.value : []));
      return true;
    }catch(err){ console.warn("[SEBIT FINAL] load shopProducts doc skipped", err); return false; }
  };

  window.sebitFinalRefreshShopScreens = function(){
    sebitRunRealtimeRefreshSafely(function(){
    try{
      const page = String(document.body.getAttribute("data-page") || "");
      if(page === "student-shop" && typeof renderStudentShop === "function") {
        try{ window.sebitFinalLoadShopProductsDocNow && window.sebitFinalLoadShopProductsDocNow().then(function(){ renderStudentShop(); }); }catch(_){ renderStudentShop(); }
        renderStudentShop();
      }
      if(page === "student-pocket" && typeof renderStudentPocket === "function") renderStudentPocket();
      if(typeof renderTeacherHome === "function" && page === "teacher-home") renderTeacherHome();
      if(typeof renderStudentShell === "function" && page.startsWith("student-")) renderStudentShell();
      if(String(location.hash || "") === "#admin-shop" && typeof openAdminModal === "function") {
        openAdminModal({ key:"shop", title:"상점 관리" });
      }
    }catch(err){ console.warn("[SEBIT FINAL] shop refresh skipped", err); }
    });
  };

  window.sebitFinalRefreshJobScreens = function(){
    sebitRunRealtimeRefreshSafely(function(){
    try{
      const page = String(document.body.getAttribute("data-page") || "");
      if(typeof renderStudentShell === "function" && page.startsWith("student-")) renderStudentShell();
      if(typeof renderStudentHomeV1 === "function" && page === "student-home") renderStudentHomeV1();
      if(typeof renderTeacherStudents === "function" && page === "teacher-students") renderTeacherStudents();
      if(typeof renderTeacherHome === "function" && page === "teacher-home") renderTeacherHome();
      if(String(location.hash || "") === "#admin-jobs" && typeof openAdminModal === "function") openAdminModal({ key:"jobs", title:"직업 관리" });
      if(String(location.hash || "") === "#admin-job-status" && typeof openAdminModal === "function") openAdminModal({ key:"job-status", title:"직업 수행현황 관리" });
    }catch(err){ console.warn("[SEBIT FINAL] job refresh skipped", err); }
    });
  };

  window.sebitFinalIsJobKey = function(key){
    const k = String(key || "");
    if(k === "sebit:jobsConfig_v1" || k === "sebit:jobsAssign_v1" || k === "sebit:jobsSession_v1" ||
       k === "sebit:jobsNonregular_v1" || k === "sebit:jobsParttime_v1" ||
       k === "sebit:jobsAssignConfirmed_v1" || k === "sebit:jobsResetDone_v1") return true;
    return k.startsWith("sebit_jobdone_") || k.startsWith("sebit_studycheck_") ||
           k.startsWith("sebit_tidymaster_") || k.startsWith("sebit_artcurator_") ||
           k.startsWith("sebit_greensaver_") || k.startsWith("sebit_lunchsaver_") ||
           k.startsWith("sebit_weathercaster_") || k.startsWith("sebit_lightmerchant_") ||
           k.startsWith("sebit_techkeeper_") || k.startsWith("sebit_timekeeper_") ||
           k.startsWith("sebit_docmaster_") || k.startsWith("sebit_ranger_") ||
           k.startsWith("sebit_fairjustice_") || k.includes("job") || k.includes("Job");
  };

  try{ window.isSebitJobStorageKey = window.sebitFinalIsJobKey; }catch(_){ }
  try{ window.refreshShopPagesFromRealtime = window.sebitFinalRefreshShopScreens; }catch(_){ }
  try{ window.refreshJobPagesFromRealtime = window.sebitFinalRefreshJobScreens; }catch(_){ }

  const prevSet = Storage.prototype.setItem;
  const prevRemove = Storage.prototype.removeItem;
  Storage.prototype.setItem = function(key, value){
    const ret = prevSet.apply(this, arguments);
    try{
      if(this === window.localStorage){
        const k = String(key || "");
        if(typeof fsShopKeyNameFromLSKey === "function" && fsShopKeyNameFromLSKey(k)){
          if(typeof scheduleShopFirestoreSync === "function") scheduleShopFirestoreSync();
          setTimeout(window.sebitFinalRefreshShopScreens, 80);
        }
        if(window.sebitFinalIsJobKey(k)){
          if(k === "sebit:jobsAssign_v1") setTimeout(window.sebitFinalDeriveStudentJobsFromAssign, 30);
          if(typeof scheduleJobFirestoreSync === "function") scheduleJobFirestoreSync(k);
          setTimeout(window.sebitFinalRefreshJobScreens, 100);
        }
      }
    }catch(err){ console.warn("[SEBIT FINAL] setItem hook skipped", err); }
    return ret;
  };
  Storage.prototype.removeItem = function(key){
    const ret = prevRemove.apply(this, arguments);
    try{
      if(this === window.localStorage){
        const k = String(key || "");
        if(typeof fsShopKeyNameFromLSKey === "function" && fsShopKeyNameFromLSKey(k)){
          if(typeof scheduleShopFirestoreSync === "function") scheduleShopFirestoreSync();
          setTimeout(window.sebitFinalRefreshShopScreens, 80);
        }
        if(window.sebitFinalIsJobKey(k)){
          if(typeof scheduleJobFirestoreSync === "function") scheduleJobFirestoreSync(k);
          setTimeout(window.sebitFinalRefreshJobScreens, 100);
        }
      }
    }catch(err){ console.warn("[SEBIT FINAL] removeItem hook skipped", err); }
    return ret;
  };

  window.addEventListener("load", function(){
    setTimeout(function(){
      try{ if(typeof loadShopStateFromFirestore === "function") loadShopStateFromFirestore().then(function(){ try{ window.sebitFinalRefreshShopScreens(); }catch(_){} }); }catch(_){ }
      try{ if(typeof syncAllLocalJobStateToFirestoreNow === "function") syncAllLocalJobStateToFirestoreNow(); }catch(_){ }
      try{ window.sebitFinalDeriveStudentJobsFromAssign(); }catch(_){ }
      try{ window.sebitFinalRefreshShopScreens(); }catch(_){ }
      try{ window.sebitFinalRefreshJobScreens(); }catch(_){ }
    }, 1200);
  });
})();

/* =========================================================
   SEBIT EMERGENCY SHOP HYDRATOR v2
   - Fix for mobile/iPad not showing shop products even when Firestore has sharedState/shopProducts.value
   - Uses direct compat Firestore call and correct localStorage key: sebit:shopProducts
   - Forces category to 전체 when products are present but current filter may hide them
   ========================================================= */
(function(){
  if(window.__sebitEmergencyShopHydratorV2) return;
  window.__sebitEmergencyShopHydratorV2 = true;

  const SHOP_LS_KEY = "sebit:shopProducts";
  const SHOP_CAT_KEY = "sebit:shopCat";

  function safeProducts(){
    try{
      const arr = JSON.parse(localStorage.getItem(SHOP_LS_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    }catch(_){ return []; }
  }

  async function hydrateShopProducts(reason){
    try{
      if(!window.firebase || !firebase.firestore) return false;
      const snap = await firebase.firestore().collection("sharedState").doc("shopProducts").get();
      if(!snap.exists) return false;
      const data = snap.data() || {};
      const value = Array.isArray(data.value) ? data.value : [];
      localStorage.setItem(SHOP_LS_KEY, JSON.stringify(value));
      // legacy fallback key just in case an older screen reads it
      localStorage.setItem("sebit_shopProducts", JSON.stringify(value));
      if(value.length){
        const selected = localStorage.getItem(SHOP_CAT_KEY) || "전체";
        const cats = new Set(value.map(p => String((p && p.category) || "").trim()).filter(Boolean));
        if(selected !== "전체" && !cats.has(selected)) localStorage.setItem(SHOP_CAT_KEY, "전체");
      }
      console.log("[SEBIT EMERGENCY] shopProducts hydrated", value.length, reason || "");
      return true;
    }catch(err){
      console.error("[SEBIT EMERGENCY] shopProducts hydrate failed", err);
      return false;
    }
  }

  window.sebitHydrateShopProductsNow = hydrateShopProducts;

  // Wrap renderStudentShop so every mobile entry gets Firestore data first if needed.
  function installRenderWrapper(){
    if(typeof window.renderStudentShop !== "function" || window.renderStudentShop.__sebitWrapped) return false;
    const original = window.renderStudentShop;
    const wrapped = function(){
      const before = safeProducts();
      // If phone has no products yet, fetch immediately and rerender after data arrives.
      if(before.length === 0){
        hydrateShopProducts("renderStudentShop-empty").then(ok=>{
          if(ok){
            try{ localStorage.setItem(SHOP_CAT_KEY, "전체"); }catch(_){}
            try{ original(); }catch(e){ console.error("[SEBIT EMERGENCY] rerender shop failed", e); }
          }
        });
      }else{
        // Prevent hidden products due to stale category filter on mobile.
        try{
          const selected = localStorage.getItem(SHOP_CAT_KEY) || "전체";
          if(selected !== "전체"){
            const cats = new Set(before.map(p => String((p && p.category) || "").trim()).filter(Boolean));
            if(!cats.has(selected)) localStorage.setItem(SHOP_CAT_KEY, "전체");
          }
        }catch(_){}
      }
      return original.apply(this, arguments);
    };
    wrapped.__sebitWrapped = true;
    window.renderStudentShop = wrapped;
    return true;
  }

  function refreshIfShopPage(reason){
    try{
      const page = String(document.body.getAttribute("data-page") || "");
      if(page === "student-shop"){
        hydrateShopProducts(reason).then(()=>{
          try{ if(typeof window.renderStudentShop === "function") window.renderStudentShop(); }catch(e){}
        });
      }
    }catch(_){}
  }

  // Direct realtime listener for the exact document.
  function installDirectShopListener(){
    try{
      if(!window.firebase || !firebase.firestore || window.__sebitEmergencyShopDirectListener) return;
      if(window.__sebitRealtimePaused || document.hidden) return;
      window.__sebitEmergencyShopDirectListener = true;
      window.__sebitEmergencyShopDirectUnsub = firebase.firestore().collection("sharedState").doc("shopProducts").onSnapshot(function(snap){
        if(!snap.exists) return;
        const data = snap.data() || {};
        const value = Array.isArray(data.value) ? data.value : [];
        localStorage.setItem(SHOP_LS_KEY, JSON.stringify(value));
        localStorage.setItem("sebit_shopProducts", JSON.stringify(value));
        console.log("[SEBIT EMERGENCY] direct shop snapshot", value.length);
        try{ if(String(document.body.getAttribute("data-page")||"") === "student-shop" && typeof window.renderStudentShop === "function") window.renderStudentShop(); }catch(_){}
      }, function(err){ console.error("[SEBIT EMERGENCY] direct shop snapshot failed", err); });
    }catch(err){ console.error("[SEBIT EMERGENCY] direct listener install failed", err); }
  }

  window.addEventListener("load", function(){
    let tries = 0;
    const t = setInterval(function(){
      tries++;
      installRenderWrapper();
      installDirectShopListener();
      hydrateShopProducts("startup-" + tries).then(()=>refreshIfShopPage("startup-refresh"));
      if(tries >= 8) clearInterval(t);
    }, 700);
  });

  document.addEventListener("click", function(e){
    const btn = e.target && e.target.closest ? e.target.closest("[data-go]") : null;
    if(btn && btn.getAttribute("data-go") === "student-shop"){
      setTimeout(function(){
        installRenderWrapper();
        installDirectShopListener();
        refreshIfShopPage("click-student-shop");
      }, 150);
    }
  }, true);

  document.addEventListener("visibilitychange", function(){ if(!document.hidden) refreshIfShopPage("visible"); });
})();


/* === SEBIT PATCH: student shop purchase touch hold === */
(function installSebitStudentShopPurchaseHold(){
  if(window.__sebitStudentShopPurchaseHoldInstalled) return;
  window.__sebitStudentShopPurchaseHoldInstalled = true;
  window.__sebitStudentShopPurchaseBusy = window.__sebitStudentShopPurchaseBusy || false;

  function isShopBuyButton(target){
    try{
      const page = String(document.body.getAttribute("data-page") || "");
      if(page !== "student-shop") return false;
      const btn = target.closest ? target.closest("button") : null;
      const grid = document.getElementById("studentShopGrid");
      if(!btn || !grid || !grid.contains(btn)) return false;
      const txt = (btn.textContent || "").trim();
      return txt.includes("구입") || txt.includes("구매") || txt.includes("신청");
    }catch(_){ return false; }
  }

  document.addEventListener("click", function(e){
    if(!isShopBuyButton(e.target)) return;
    window.__sebitStudentShopPurchaseBusy = true;
    sebitHoldRealtimeRender(2200);
    setTimeout(function(){
      window.__sebitStudentShopPurchaseBusy = false;
    }, 2200);
  }, true);
})();


/* === SEBIT PATCH: real student shop purchase binding final ===
   - 학생홈 메뉴의 임시 안내 토스트가 상점 버튼을 방해하지 않도록 차단
   - 구매 버튼 클릭을 캡처 단계에서 직접 잡아 openPurchaseConfirm으로 연결
   - 자동 30건 제한은 구매/지급 흐름에 적용하지 않음
*/
(function installSebitRealShopPurchaseBinding(){
  if(window.__sebitRealShopPurchaseBindingInstalled) return;
  window.__sebitRealShopPurchaseBindingInstalled = true;

  function getProductIdFromBuyButton(btn){
    if(!btn) return "";
    const direct = btn.getAttribute("data-shop-buy") || btn.dataset?.shopBuy || "";
    if(direct) return String(direct);
    const card = btn.closest(".lightshop-item");
    const grid = document.getElementById("studentShopGrid");
    if(!card || !grid) return "";
    const cards = Array.from(grid.querySelectorAll(".lightshop-item"));
    const idx = cards.indexOf(card);
    const products = (typeof readJSON === "function" && typeof LS !== "undefined") ? readJSON(LS.shopProducts, []) : [];
    const visible = Array.isArray(products) ? products.filter(p => !(p && p.isPublished === false && false)) : [];
    const selectedCat = (localStorage.getItem("sebit:shopCat") || "전체");
    const filtered = selectedCat === "전체" ? visible : visible.filter(p => String(p?.category||"") === selectedCat);
    return String(filtered[idx]?.id || "");
  }

  document.addEventListener("click", function(e){
    try{
      const page = String(document.body.getAttribute("data-page") || "");
      if(page !== "student-shop") return;
      const btn = e.target.closest ? e.target.closest("button.lightshop-buy") : null;
      if(!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if(typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      if(btn.disabled){
        if(typeof toast === "function") toast("품절 또는 판매중단 상품입니다.");
        return;
      }
      const id = getProductIdFromBuyButton(btn);
      if(!id){
        if(typeof toast === "function") toast("상품 정보를 다시 불러와 주세요.");
        return;
      }
      if(typeof openPurchaseConfirm === "function") openPurchaseConfirm(id);
      else if(typeof shopTryPurchase === "function") shopTryPurchase(id);
      else if(typeof toast === "function") toast("구매 기능 연결을 찾지 못했어요.");
    }catch(err){
      console.error("[SEBIT] shop purchase binding failed", err);
      try{ if(typeof toast === "function") toast("구매 처리 중 오류가 났어요."); }catch(_){ }
    }
  }, true);
})();

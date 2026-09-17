// ── Thảo Tools — Auth module (Supabase) ──
// ES module riêng, tự cô lập scope (KHÔNG đụng vào global scope của index.html —
// xem báo cáo kiểm toán kiến trúc: đây là bước đầu áp dụng "mỗi thứ mới có scope riêng"
// mà không cần chờ migrate Vite/TypeScript đầy đủ).
//
// Publishable key CHỦ Ý để lộ ra client — Supabase thiết kế để dùng ngay trên trình
// duyệt, được khoá bằng Row Level Security (xem policies trong SQL đã chạy). Đây
// KHÔNG phải secret key (sb_secret_...) — tuyệt đối không đưa loại đó vào code frontend.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';

const SUPABASE_URL = 'https://mbqpujtqvevzwrnmhlep.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_xlJrUPaFZyNTxO_J1MyCEg_Lu6YDrqz';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// ── API cho các phần khác của app dùng (VD: nút "Lưu lên tài khoản" ở Cross Stitch) ──
export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

// Ghi 1 lượt dùng — fire-and-forget, không chặn UI nếu lỗi (chỉ log cảnh báo)
export async function logUsage(tool) {
  try {
    const session = await getSession();
    if (!session) return;
    await supabase.from('usage_events').insert({ user_id: session.user.id, tool });
  } catch (err) {
    console.warn('logUsage failed:', err.message);
  }
}

// ── Gate UI: chặn toàn bộ app cho tới khi đăng nhập ──
function $(id) { return document.getElementById(id); }

function showGate(show) {
  const gate = $('authGate');
  const main = document.querySelector('.main-content');
  const sidebar = document.querySelector('.sidebar');
  if (gate) gate.style.display = show ? 'flex' : 'none';
  if (main) main.style.filter = show ? 'blur(2px)' : '';
  if (main) main.style.pointerEvents = show ? 'none' : '';
  if (sidebar) sidebar.style.pointerEvents = show ? 'none' : '';
}

function setAccountUI(session) {
  const row = $('accountRow');
  const emailEl = $('accountEmail');
  const avatarEl = $('accountAvatar');
  if (!row) return;
  if (session) {
    row.style.display = 'flex';
    if (emailEl) emailEl.textContent = session.user.email;
    if (avatarEl) avatarEl.textContent = (session.user.email || '?').charAt(0);
  } else {
    row.style.display = 'none';
  }
}

let authMode = 'signin'; // 'signin' | 'signup'

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.authtab === mode));
  const submit = $('authSubmit');
  if (submit) submit.textContent = mode === 'signup' ? 'Đăng ký' : 'Đăng nhập';
  const msg = $('authMsg');
  if (msg) { msg.textContent = ''; msg.className = 'auth-msg'; }
}

function showAuthMsg(text, isError) {
  const msg = $('authMsg');
  if (!msg) return;
  msg.textContent = text;
  msg.className = 'auth-msg' + (isError ? ' error' : ' ok');
}

function initAuthUI() {
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.authtab));
  });

  $('authForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('authEmail')?.value.trim();
    const password = $('authPassword')?.value;
    const submit = $('authSubmit');
    if (!email || !password) return;
    if (submit) submit.disabled = true;
    try {
      if (authMode === 'signup') {
        await signUp(email, password);
        showAuthMsg('Đăng ký thành công! Kiểm tra email để xác nhận tài khoản, sau đó đăng nhập lại.', false);
        setAuthMode('signin');
      } else {
        await signIn(email, password);
        // onAuthStateChange bên dưới sẽ tự ẩn gate khi đăng nhập thành công
      }
    } catch (err) {
      showAuthMsg(err.message || 'Có lỗi xảy ra, thử lại.', true);
    } finally {
      if (submit) submit.disabled = false;
    }
  });

  $('accountLogout')?.addEventListener('click', async () => {
    try { await signOut(); } catch (err) { console.warn('signOut failed:', err.message); }
  });
}

// Phản ứng với mọi thay đổi trạng thái đăng nhập (đăng nhập/đăng xuất/khôi phục phiên khi reload)
supabase.auth.onAuthStateChange((_event, session) => {
  showGate(!session);
  setAccountUI(session);
});

document.addEventListener('DOMContentLoaded', async () => {
  initAuthUI();
  const session = await getSession();
  showGate(!session);
  setAccountUI(session);
});

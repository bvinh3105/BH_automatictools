// ── Thảo Tools — Edge Function: OCR dùng chung qua Groq ──
// Giữ GROQ_API_KEY bí mật ở server, không bao giờ gửi xuống trình duyệt.
// Chỉ phục vụ người dùng ĐÃ ĐĂNG NHẬP — Edge Function không tự có auth.uid()
// như RLS, nên phải tự verify JWT ở đây.
//
// Request:  POST { imageBase64: string, mimeType: string }
//           Header: Authorization: Bearer <supabase access token>
// Response: 200 { text: string }
//           4xx/5xx { error: string }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_API_KEY = Deno.env.get('GROQ_API_KEY');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Y HỆT OCR_PROMPT trong photo-timestamp-watermark/index.html (~dòng 7153).
// Không có cơ chế share-code giữa static site và Edge Function ở quy mô này —
// sửa 1 bên thì nhớ sửa bên kia.
const OCR_PROMPT = `Bạn là chuyên gia OCR tiếng Việt. Đọc và trích xuất TOÀN BỘ văn bản trong ảnh.

QUY TẮC:
- Giữ nguyên bố cục dòng, thứ tự từ trên xuống dưới, trái sang phải
- Với chữ viết tay tiếng Việt: đặc biệt chú ý dấu thanh (sắc, huyền, hỏi, ngã, nặng) và dấu phụ (ă, â, ê, ô, ơ, ư, đ)
- Nếu không chắc một ký tự, suy luận từ ngữ cảnh câu tiếng Việt (ví dụ: "bảo hiểm" chứ không phải "bao hiem")
- CHÚ Ý CHỮ VIẾT TAY / THƯ PHÁP TIẾNG VIỆT:
  + Chữ "C" hoa viết tay thường có nét cong tròn mở sang phải, KHÔNG có gạch ngang → KHÔNG nhầm với "Đ" (Đ có gạch ngang xuyên thân chữ)
  + Phân biệt: Cao ≠ Đào, Cường ≠ Đường, Cảnh ≠ Đảnh, Công ≠ Đông
  + Chữ "G" hoa viết tay có đuôi kéo xuống, không nhầm với "C" hay "O"
  + Chữ "B" hoa viết tay có 2 bụng tròn, không nhầm với "D" (D chỉ có 1 cung)
  + Họ Việt Nam phổ biến: Nguyễn, Trần, Lê, Phạm, Hoàng/Huỳnh, Phan, Vũ/Võ, Đặng, Bùi, Đỗ, Hồ, Ngô, Dương, Lý, Cao, Đào, Trương, Đinh, Lương, Tạ, Mai, Tô, Chu
  + Chức vụ phổ biến: Thượng tá, Đại tá, Thiếu tá, Trung tá, Đại úy, Thiếu úy, Trưởng CA, Phó CA
  + Khi đọc tên người trong văn bản hành chính/pháp lý, ưu tiên họ phổ biến hơn
- CHÚ Ý ĐƠN VỊ HÀNH CHÍNH VIỆT NAM (rất phổ biến trong giấy tờ):
  + "Xã" (commune) — dấu NGÃ (~), KHÔNG PHẢI "Xí" (dấu sắc). VD: "TRƯỞNG CA XÃ" ≠ "TRƯỞNG CA XÍ"
  + Phường, Quận, Huyện, Tỉnh, Thành phố — đây là các đơn vị hành chính chuẩn
  + "Xã" xuất hiện rất nhiều trong giấy đăng ký xe, sổ đỏ, CMND/CCCD
- CHÚ Ý SỐ SERIAL / MÃ SỐ (Số máy, Số khung, Số CMND, Biển số):
  + Đọc TỪNG KÝ TỰ một, KHÔNG suy luận hay tự sửa
  + Phân biệt rõ: 0 (số không) vs O (chữ O), 1 (số một) vs I (chữ I) vs l (chữ L nhỏ)
  + Số khung/số máy thường gồm cả CHỮ + SỐ (VD: RLUJC81DBMN000132, G4NLMU946156)
  + KHÔNG thêm/bớt ký tự, KHÔNG sửa lỗi serial number — ghi chính xác như thấy
- NẾU ẢNH BỊ XOAY (ngang, ngược, nghiêng): hãy tự xác định chiều đọc đúng rồi đọc theo chiều đó
- Với form/biểu mẫu: ghi theo format "Tên trường: giá trị"
- Số tiền giữ nguyên format (VD: 3,454,546 đồng)
- CHỈ trả về văn bản thuần túy. KHÔNG giải thích, KHÔNG mô tả ảnh, KHÔNG suy luận.`;

function stripThinking(text: string): string {
  if (!text) return '';
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<think>[\s\S]*/gi, '');
  text = text.replace(/\*\*(Image Analysis|Thinking|Analysis|Phân tích|Suy luận)\*\*:?[\s\S]*?(?=\n[A-ZĐ\d]|\n\n)/gi, '');
  return text.trim();
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!GROQ_API_KEY) {
    return json({ error: 'Dịch vụ OCR dùng chung chưa được cấu hình.' }, 500);
  }

  // --- Bắt buộc đã đăng nhập: tự verify JWT (Edge Function không tự có auth.uid()) ---
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Chưa đăng nhập.' }, 401);

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await authClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: 'Phiên đăng nhập không hợp lệ, thử đăng nhập lại.' }, 401);
  const user = userData.user;

  // --- Đọc request ---
  let body: { imageBase64?: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Body không hợp lệ.' }, 400);
  }
  const { imageBase64, mimeType } = body;
  if (!imageBase64 || !mimeType) return json({ error: 'Thiếu imageBase64/mimeType.' }, 400);

  // --- Gọi Groq bằng key bí mật (không bao giờ gửi xuống client) ---
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;
  const groqBody = {
    model: 'qwen/qwen3.6-27b',
    messages: [
      { role: 'system', content: 'You are a Vietnamese OCR expert specializing in handwritten text. Output ONLY the extracted text exactly as written. Pay close attention to Vietnamese diacritics (sắc, huyền, hỏi, ngã, nặng) and special characters (ă, â, ê, ô, ơ, ư, đ). No reasoning, no explanation, no thinking.' },
      { role: 'user', content: [
        { type: 'text', text: OCR_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ],
    temperature: 0.1,
    max_tokens: 4096,
  };

  let groqResp: Response;
  try {
    groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify(groqBody),
    });
  } catch (e) {
    return json({ error: 'Không gọi được Groq: ' + (e as Error).message }, 502);
  }

  if (!groqResp.ok) {
    const status = groqResp.status;
    const errBody = await groqResp.json().catch(() => ({} as Record<string, unknown>));
    // Lỗi auth/key (401/403) là sự cố CẤU HÌNH của dịch vụ dùng chung, không phải
    // lỗi của người dùng — không lộ chi tiết, map thành 502 chung chung.
    if (status === 401 || status === 403) {
      return json({ error: 'Dịch vụ OCR dùng chung đang gặp sự cố, thử provider khác hoặc báo admin.' }, 502);
    }
    // Giữ nguyên status 429/5xx để cơ chế fallback ở client hoạt động như bình thường.
    const raw = (errBody as { error?: { message?: string } })?.error?.message;
    return json({ error: raw || `Groq lỗi ${status}` }, status);
  }

  const data = await groqResp.json();
  const text = stripThinking(data.choices?.[0]?.message?.content || '');

  // --- Log usage phía server — đáng tin hơn logUsage() client-side vì không bị bypass ---
  try {
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await adminClient.from('usage_events').insert({ user_id: user.id, tool: 'ocr-groq-shared' });
  } catch (e) {
    console.warn('usage_events insert failed:', e);
  }

  return json({ text }, 200);
});

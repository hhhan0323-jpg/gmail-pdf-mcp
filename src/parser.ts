export interface ParsedEmailFields {
  rideDate: string;
  clientName: string;
  opposingName: string;
  caseNumber: string;
  destination: string;
  requester: string;
  amount: number | null;
  notes: string;
}

function splitAtForward(text: string): { before: string; after: string } {
  const idx = text.search(/-{4,}/);
  return idx !== -1
    ? { before: text.substring(0, idx), after: text.substring(idx) }
    : { before: text, after: '' };
}

const ALL_LABELS = ['客戶名稱', '對造名稱', '案號', '抵達地點', '請款人', '備註'];

function extractField(text: string, field: string): string {
  const lookahead = `(?=\\s*(?:${ALL_LABELS.join('|')})[：:]|$)`;
  const re = new RegExp(`${field}[：:]\\s*(.+?)${lookahead}`);
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function extractYoxiDate(text: string): string {
  // "乘車時間 2026年 04月 27日，週一"
  const m = text.match(/乘車時間\s+(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (m) return `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
  return '';
}

function extractYoxiAmount(text: string): number | null {
  // "支付金額 NTD 334"
  const m = text.match(/支付金額\s+NTD\s+([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function extractUberAmount(text: string): number | null {
  const m = text.match(/NT\$\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function extractUberDate(text: string): string {
  const m = text.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (m) return `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
  return '';
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#\d]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function extractRequester(senderName: string): string {
  // "黃筱涵 Hannah Huang" → "黃筱涵"
  const m = senderName.match(/^([一-鿿㐀-䶿]+)/);
  return m ? m[1] : (senderName.split(' ')[0] ?? senderName);
}

export function parseEmailFields(
  plainBody: string,
  htmlBody: string,
  senderName: string
): ParsedEmailFields {
  const text = plainBody || stripHtml(htmlBody);
  const { before, after } = splitAtForward(text);

  return {
    rideDate: extractYoxiDate(after) || extractUberDate(after),
    clientName: extractField(before, '客戶名稱'),
    opposingName: extractField(before, '對造名稱'),
    caseNumber: extractField(before, '案號'),
    destination: extractField(before, '抵達地點'),
    requester: extractRequester(senderName),
    amount: extractYoxiAmount(after) ?? extractUberAmount(after),
    notes: extractField(before, '備註'),
  };
}

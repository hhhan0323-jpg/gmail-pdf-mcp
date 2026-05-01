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

// Split email at the forwarded-message separator (Gmail dashes or iPhone "Begin forwarded message:")
function splitAtForward(text: string): { before: string; after: string } {
  const patterns = [/-{4,}/, /Begin forwarded message:/i];
  let minIdx = text.length;
  for (const pat of patterns) {
    const idx = text.search(pat);
    if (idx !== -1 && idx < minIdx) minIdx = idx;
  }
  return minIdx < text.length
    ? { before: text.substring(0, minIdx), after: text.substring(minIdx) }
    : { before: text, after: '' };
}

const ALL_LABELS = ['客戶名稱', '對造名稱', '案號', '抵達地點', '請款人', '備註'];

// Strip iPhone/mail client boilerplate appended to field values
function cleanValue(val: string): string {
  return val
    .replace(/\s*Sent from my iPhone.*/i, '')
    .replace(/\s*Begin forwarded message.*/i, '')
    .trim();
}

// Extract a structured field value (e.g. "客戶名稱：瓦城") from the pre-forward section
function extractField(text: string, field: string): string {
  const labelAlt = ALL_LABELS.join('|');
  // Match value (non-newline chars) up to the next label or end of line
  const re = new RegExp(`${field}[：:]\\s*([^\\n]+?)(?=\\s*(?:${labelAlt})[：:]|[ \\t]*$)`, 'm');
  const m = text.match(re);
  return m ? cleanValue(m[1].trim()) : '';
}

// Parse 客戶名稱 and 對造名稱 from subject when body has no structured fields
// Handles: "車資 - 德盛 v 富鴻網 260427 開庭" and "車資-瓦城-翔盟-冷凍冷藏案"
function parseSubjectForClients(subject: string): { clientName: string; opposingName: string } {
  // Pattern 1: "車資 - {A} v {B} ..."
  const m1 = subject.match(/車資\s*[-–]\s*(.+?)\s+v\s+(\S+)/);
  if (m1) return { clientName: m1[1].trim(), opposingName: m1[2].trim() };

  // Pattern 2: "車資-{A}-{B}-..." (dash-delimited, no " v ")
  const m2 = subject.match(/車資[-–]([^-–\d(（\s]+?)[-–]([^-–\d(（\s]+)/);
  if (m2) return { clientName: m2[1].trim(), opposingName: m2[2].trim() };

  return { clientName: '', opposingName: '' };
}

// Parse ride date from subject line: "260427" → "2026/04/27"
function parseSubjectDate(subject: string): string {
  const m = subject.match(/(?<!\d)([2][0-9])([0-1][0-9])([0-3][0-9])(?!\d)/);
  if (m) return `20${m[1]}/${m[2]}/${m[3]}`;
  return '';
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
  // "NT$267" or "NT$ 267"
  const m = text.match(/NT\$\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function extractUberDate(text: string): string {
  // Generic Chinese date: "2026年04月27日"
  const m = text.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (m) return `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
  return '';
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#\d]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function extractRequester(senderName: string): string {
  // "黃筱涵 Hannah Huang" → "黃筱涵", "張菀萱律師" → "張菀萱律師"
  const m = senderName.match(/^([一-鿿㐀-䶿]+)/);
  return m ? m[1] : (senderName.split(' ')[0] ?? senderName);
}

export function parseEmailFields(
  plainBody: string,
  htmlBody: string,
  senderName: string,
  subject: string = ''
): ParsedEmailFields {
  const text = plainBody || stripHtml(htmlBody);
  const { before, after } = splitAtForward(text);
  const fromSubject = parseSubjectForClients(subject);

  // Structured fields from pre-forward section, with subject as fallback
  const clientName = extractField(before, '客戶名稱') || fromSubject.clientName;
  const opposingName = extractField(before, '對造名稱') || fromSubject.opposingName;

  // Amount and ride date: search forwarded section first, then full text as fallback
  const amount =
    extractYoxiAmount(after) ?? extractUberAmount(after) ??
    extractYoxiAmount(text) ?? extractUberAmount(text);

  const rideDate =
    extractYoxiDate(after) || extractUberDate(after) ||
    extractYoxiDate(text) || extractUberDate(text) ||
    parseSubjectDate(subject);

  return {
    rideDate,
    clientName,
    opposingName,
    caseNumber: extractField(before, '案號'),
    destination: extractField(before, '抵達地點'),
    requester: extractRequester(senderName),
    amount,
    notes: extractField(before, '備註'),
  };
}

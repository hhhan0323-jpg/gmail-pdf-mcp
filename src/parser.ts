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

// ── Forward split ─────────────────────────────────────────────────────────────

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

// ── Label registry ────────────────────────────────────────────────────────────

// All known label variants (longest/most-specific first) used in regex lookahead
const ALL_LABEL_VARIANTS = [
  '客戶名稱', '客戶',
  '對造名稱', '對造',
  '案號',
  '抵達地點', '抵達地', '抵達',
  '請款人',
  '備註',
  '乘車日期', '日期',
  '金額',
];

// Per-field variants to try in order (most specific first)
const FIELD_VARIANTS: Record<string, string[]> = {
  '客戶名稱': ['客戶名稱', '客戶'],
  '對造名稱': ['對造名稱', '對造'],
  '案號': ['案號'],
  '抵達地點': ['抵達地點', '抵達地', '抵達'],
  '請款人': ['請款人'],
  '備註': ['備註'],
};

// Strip boilerplate and nested label prefixes from captured values
const NESTED_LABEL_RE = /^(?:抵達地點|抵達地|抵達|客戶名稱|客戶|對造名稱|對造|案號|備註)[：:]\s*/;

function cleanValue(val: string): string {
  return val
    .replace(NESTED_LABEL_RE, '')
    .replace(/\s*Sent from my iPhone.*/i, '')
    .replace(/\s*Begin forwarded message.*/i, '')
    .trim();
}

// Extract one field using a specific label string
function extractField(text: string, label: string): string {
  const lookaheadAlt = ALL_LABEL_VARIANTS.join('|');
  // Use [^\S\n]* (horizontal whitespace only) after the colon so the regex
  // never crosses a newline — prevents 案號 from capturing the next line's value.
  const re = new RegExp(
    `${label}[：:][^\\S\\n]*([^\\n]+?)(?=\\s*(?:${lookaheadAlt})[：:]|[ \\t]*$)`,
    'm'
  );
  const m = text.match(re);
  return m ? cleanValue(m[1].trim()) : '';
}

// Try all variants for a canonical field key
function extractFieldMulti(text: string, key: string): string {
  for (const variant of (FIELD_VARIANTS[key] ?? [key])) {
    const v = extractField(text, variant);
    if (v) return v;
  }
  return '';
}

// ── Receipt / ticket parsing ──────────────────────────────────────────────────

function extractYoxiDate(text: string): string {
  // "乘車時間 2026年 04月 27日，週一" or "乘車時間 *2026年 04月 29日*" (plain text bold)
  const m = text.match(/乘車時間\s+\*?(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (m) return `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
  return '';
}

function extractYoxiAmount(text: string): number | null {
  // "支付金額 NTD 334" or "支付金額 *NTD 105*" (plain text bold)
  const m = text.match(/支付金額\s+\*?NTD\s+([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function extractUberAmount(text: string): number | null {
  // "NT$267" or "NT$ 267"
  const m = text.match(/NT\$\s*([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function extractThsrAmount(text: string): number | null {
  // THSR e-ticket: "TWD 700" (per ticket) or "TWD 1,400" (total)
  // Take the largest valid amount (≥100) to capture the total ticket price
  const matches = [...text.matchAll(/TWD\s+([\d,]+)/g)];
  const amounts = matches
    .map(m => parseInt(m[1].replace(/,/g, ''), 10))
    .filter(n => n >= 100 && n <= 99999);
  return amounts.length ? Math.max(...amounts) : null;
}

function extractTaxiReceiptAmount(text: string): number | null {
  // English-format taxi receipt: "(Total,$): 280" or "(Fare, $):280"
  const m = text.match(/\((?:Total|Fare)[,\s]*\$\)[:\s]*([\d,]+)/i);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function extractUberPdfAmount(text: string): number | null {
  // Uber receipt PDFs rendered via Puppeteer produce "$xxx.xx" dollar amounts in OCR text
  // e.g. "$284.00 $8.00 $276.00 $284.00" — take the largest (≥100) as the total fare
  const matches = [...text.matchAll(/\$([\d,]+)\.(\d{2})/g)];
  const amounts = matches
    .map(m => parseInt(m[1].replace(/,/g, ''), 10))
    .filter(n => n >= 100 && n <= 99999);
  return amounts.length ? Math.max(...amounts) : null;
}

function extractUberChineseAmount(text: string): number | null {
  // "費用 $98.00", "實付金額 $445" — Chinese Uber/Google Maps receipt (plain $ prefix)
  // "總金額Total Amount：$580" — THSR T Express booking confirmation
  const m = text.match(/(?:費用|實付金額|付款金額|應付金額)\s+\$([\d,]+)/)
    ?? text.match(/Total Amount[：:]\s*\$([\d,]+)/i);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function extractThsrcBookingAmount(text: string): number | null {
  // THSRC online booking confirmation: "費用(NTD)：$2980.0"
  const m = text.match(/費用\s*\([^)]*\)\s*[：:]\s*\$?([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function extractUberDate(text: string): string {
  // Generic Chinese date in receipt: "2026年04月27日" or "2026 年 4 月 13 日"
  const m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
  return '';
}

function extractMinguoDate(text: string): string {
  // "民國115年4月27日" → "2026/04/27"
  const m = text.match(/民國\s*(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return '';
  const year = parseInt(m[1], 10) + 1911;
  return `${year}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
}

// Body-labelled amount: "金額：500" or "車資：NTD 500" etc.
function extractAmountFromBody(text: string): number | null {
  const patterns = [
    /金額[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /費用[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /票價[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /總計[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /合計[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /車資[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /車費[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /搭車費[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /計程車[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /高鐵費[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /台鐵費[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /捷運費[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    // Taiwan taxi apps / traditional receipts
    /應付金額[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /實付金額[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /付款金額[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /應收金額[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /計費金額[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /搭乘費[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /應付[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
    /實付[：:]\s*(?:NT\$|NTD\s*)?([\d,]+)/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  }
  return null;
}

// Receipt label with space separator: "票價 NTD 290" or "票價 290" (THSR e-tickets, no colon)
function extractReceiptLabelAmount(text: string): number | null {
  const patterns = [
    /票價\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /車資\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /費用\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /金額\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    // Taiwan taxi apps (space-separated, no colon)
    /應付金額\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /實付金額\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /付款金額\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /應收金額\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /計費金額\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /搭乘費\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /應付\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /實付\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /合計\s+(?:NT\$|NTD\s*)?([\d,]+)/,
    /總計\s+(?:NT\$|NTD\s*)?([\d,]+)/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (n >= 10 && n <= 99999) return n;
    }
  }
  return null;
}

// Body-labelled ride date: "乘車日期：2026/04/27"
function extractRideDateFromBody(text: string): string {
  const m = text.match(/(?:乘車日期|出發日期|搭乘日期)[：:]\s*([\d/年月日]+)/);
  if (!m) return '';
  const val = m[1];
  const dm = val.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (dm) return `${dm[1]}/${dm[2].padStart(2, '0')}/${dm[3].padStart(2, '0')}`;
  return val;
}

// ── OCR text parser (used by vision.ts after Google Vision OCR) ──────────────

/**
 * Parse raw OCR text from a receipt/ticket image to extract 金額 and 乘車日期.
 * Applies all receipt-specific patterns in priority order.
 */
export function parseReceiptOcrText(text: string): { amount: number | null; rideDate: string } {
  const amount =
    extractYoxiAmount(text) ?? extractUberAmount(text) ?? extractUberChineseAmount(text) ??
    extractThsrAmount(text) ?? extractTaxiReceiptAmount(text) ?? extractUberPdfAmount(text) ??
    extractAmountFromBody(text) ?? extractReceiptLabelAmount(text);

  const rideDate =
    extractYoxiDate(text) || extractMinguoDate(text) || extractUberDate(text) ||
    extractEnglishDate(text) || extractUberShortDate(text) ||
    extractRideDateFromBody(text) || extractSlashDate(text);

  return { amount, rideDate };
}

// "2026/04/27" or "2026-04-27" (fallback for OCR text without Chinese date labels)
function extractSlashDate(text: string): string {
  const m = text.match(/20\d{2}[\/\-]\d{1,2}[\/\-]\d{1,2}/);
  if (!m) return '';
  const parts = m[0].split(/[\/\-]/);
  return `${parts[0]}/${parts[1].padStart(2, '0')}/${parts[2].padStart(2, '0')}`;
}

const ENGLISH_MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// "Apr 28, 2026" or "April 28, 2026" — Uber receipt English date format
function extractEnglishDate(text: string): string {
  const m = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i
  );
  if (!m) return '';
  const month = ENGLISH_MONTHS[m[1].toLowerCase().slice(0, 3)];
  return month ? `${m[3]}/${month}/${m[2].padStart(2, '0')}` : '';
}

// "4/28/26" — Uber payment timestamp short date (M/D/YY)
function extractUberShortDate(text: string): string {
  const m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(2\d)\b/);
  if (!m) return '';
  return `20${m[3]}/${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}`;
}

// ── Subject fallbacks ─────────────────────────────────────────────────────────

// Parse client / opposing names from email subject
function parseSubjectForClients(subject: string): { clientName: string; opposingName: string } {
  // Pattern 1: "車資 - 德盛 v 富鴻網 260427 開庭"
  const m1 = subject.match(/車資\s*[-–]\s*(.+?)\s+v\s+(\S+)/);
  if (m1) return { clientName: m1[1].trim(), opposingName: m1[2].trim() };

  // Pattern 2: "車資-瓦城-翔盟-冷凍冷藏案"
  const m2 = subject.match(/車資[-–]([^-–\d(（\s]+?)[-–]([^-–\d(（\s]+)/);
  if (m2) return { clientName: m2[1].trim(), opposingName: m2[2].trim() };

  // Pattern 3: "xxx車資" — captures token immediately before 車資
  const m3 = subject.match(/[-–]([^-–(（\s]+)車資/);
  if (m3) return { clientName: m3[1].trim(), opposingName: '' };

  return { clientName: '', opposingName: '' };
}

// Parse date from 6-digit YYMMDD in subject: "260427" → "2026/04/27"
function parseSubjectDate(subject: string): string {
  const m = subject.match(/(?<!\d)([2][0-9])([0-1][0-9])([0-3][0-9])(?!\d)/);
  if (m) return `20${m[1]}/${m[2]}/${m[3]}`;
  return '';
}

// Parse M/D date in subject: "5/4車資-..." or "Fwd: 5/4 車資-..." → "2026/05/04"
// Matches M/D pattern appearing anywhere before 車資 (or just anywhere in subject)
function parseSubjectShortDate(subject: string): string {
  const m = subject.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return '';
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const year = new Date().getFullYear();
  return `${year}/${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}`;
}

// Extract case number embedded after opposing party in subject: "車資-瓦城-壹鈞921" → "921"
function parseSubjectCaseNumber(subject: string): string {
  // Match digits (1–5 chars, not a 6-digit YYMMDD date) appended to the opposing party token
  const m = subject.match(/車資[-–][^-–\d(（\s]+[-–][^-–\d(（\s]+?(\d{1,5})(?:\D|$)/);
  if (m && m[1].length <= 4) return m[1];
  return '';
}

// ── HTML stripping ────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z#\d]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract the Nth parenthesised item from a multi-trip field.
 * "(1)智財法院；(2)事務所" with n=1 → "智財法院", n=2 → "事務所".
 * Falls back to the original string when no "(n)" pattern is found.
 */
export function extractNthItem(text: string, n: number): string {
  if (!text) return text;
  const m = text.match(new RegExp(`\\(${n}\\)\\s*([^(）；;\\n]+)`));
  return m ? m[1].trim() : text;
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

  // For field extraction, prefer non-quoted lines (lines not starting with ">") so that
  // reply-correction emails use the new corrected values rather than the quoted original.
  const beforeUnquoted = before.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');

  const clientName = extractFieldMulti(beforeUnquoted, '客戶名稱') || extractFieldMulti(before, '客戶名稱') || extractFieldMulti(after, '客戶名稱') || fromSubject.clientName;
  const opposingName = extractFieldMulti(beforeUnquoted, '對造名稱') || extractFieldMulti(before, '對造名稱') || extractFieldMulti(after, '對造名稱') || fromSubject.opposingName;

  // Amount: receipt first, then full text, then body label
  const amount =
    extractYoxiAmount(after) ?? extractUberAmount(after) ?? extractUberChineseAmount(after) ??
    extractThsrcBookingAmount(after) ??
    extractYoxiAmount(text) ?? extractUberAmount(text) ?? extractUberChineseAmount(text) ??
    extractAmountFromBody(before);

  // Strip "Date: ..." forwarding-header lines from `after` so receipt content dates take priority
  // over the forwarding metadata dates (e.g. "Date: 2026年4月27日" beats the actual Uber trip date)
  const afterForDate = after.replace(/^Date:\s.+$/gm, '');

  // Ride date: receipt first, then body label, then subject date
  const rideDate =
    extractYoxiDate(afterForDate) || extractUberDate(afterForDate) || extractMinguoDate(afterForDate) ||
    extractEnglishDate(afterForDate) || extractUberShortDate(afterForDate) || extractSlashDate(afterForDate) ||
    extractYoxiDate(text) || extractUberDate(text) || extractMinguoDate(text) ||
    extractEnglishDate(text) || extractUberShortDate(text) || extractSlashDate(text) ||
    extractRideDateFromBody(text) ||
    parseSubjectDate(subject) || parseSubjectShortDate(subject);

  // Fall back to `after` (forwarded section) when the structured form fields appear
  // there rather than in the top portion of the email.
  const getField = (key: string) =>
    extractFieldMulti(beforeUnquoted, key) || extractFieldMulti(before, key) || extractFieldMulti(after, key);

  return {
    rideDate,
    clientName,
    opposingName,
    caseNumber: getField('案號') || parseSubjectCaseNumber(subject),
    destination: getField('抵達地點'),
    requester: extractRequester(senderName),
    amount,
    notes: getField('備註'),
  };
}

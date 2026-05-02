/**
 * Receipt / ticket OCR via Anthropic API (Claude vision).
 * Requires ANTHROPIC_API_KEY env var.
 * Supports: JPEG, PNG, GIF, WEBP images, and PDF documents.
 */

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
]);

export interface OcrResult {
  amount: number | null;
  rideDate: string;
}

/**
 * Send an attachment to Claude and ask it to extract 金額 and 乘車日期.
 * Returns empty result if API key is missing, MIME type is unsupported, or call fails.
 */
export async function ocrReceiptFields(
  buffer: Buffer,
  mimeType: string
): Promise<OcrResult> {
  const empty: OcrResult = { amount: null, rideDate: '' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return empty;

  const lowerMime = mimeType.toLowerCase().split(';')[0].trim();
  const isImage = SUPPORTED_IMAGE_TYPES.has(lowerMime);
  const isPdf = lowerMime === 'application/pdf';
  if (!isImage && !isPdf) return empty;

  const base64 = buffer.toString('base64');
  const mediaType = lowerMime === 'image/jpg' ? 'image/jpeg' : lowerMime;

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const prompt = `這是一張交通收據或票券。請從中找出金額與乘車日期。

請用以下格式回答（找不到的填 null）：
金額=數字（例如 334）
日期=YYYY/MM/DD（例如 2026/04/27）

只回這兩行，不要其他說明。`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [contentBlock, { type: 'text', text: prompt }],
        }],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[vision] Anthropic API error', resp.status, text.slice(0, 300));
      return empty;
    }

    const data = await resp.json() as { content: { type: string; text: string }[] };
    const rawText = data.content?.find(c => c.type === 'text')?.text ?? '';

    const amountMatch = rawText.match(/金額=(\d[\d,]*)/);
    const dateMatch = rawText.match(/日期=(\d{4}\/\d{2}\/\d{2})/);

    return {
      amount: amountMatch ? parseInt(amountMatch[1].replace(/,/g, ''), 10) : null,
      rideDate: dateMatch ? dateMatch[1] : '',
    };
  } catch (err) {
    console.error('[vision] fetch error:', (err as Error).message);
    return empty;
  }
}

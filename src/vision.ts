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
 * Returns empty result if API key is missing, MIME type unsupported, or call fails.
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

  const prompt = `Look at this receipt or transport ticket (may be in Chinese/Traditional Chinese).

Extract ONLY these two values:
1. Payment amount: search for labels like 總金額, 車資, 支付金額, 實付金額, 票價, 金額, 合計, 小計, NT$, NTD. Use the final/total amount.
2. Travel or purchase date: search for 乘車時間, 交易日期, 搭乘日期, 出發日期, or any date on the receipt. If the year is shown as 民國 (ROC calendar), add 1911 to get Western year (e.g. 民國115年 = 2026, 民國114年 = 2025).

Respond with ONLY valid JSON, nothing else:
{"amount": <integer or null>, "date": "<YYYY/MM/DD or null>"}

Examples:
{"amount": 334, "date": "2026/04/27"}
{"amount": 520, "date": null}
{"amount": null, "date": null}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
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
    const rawText = (data.content?.find(c => c.type === 'text')?.text ?? '').trim();

    // Parse JSON response (handle code blocks if present)
    const jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[vision] unexpected response:', rawText.slice(0, 200));
      return empty;
    }

    const parsed = JSON.parse(jsonMatch[0]) as { amount?: unknown; date?: unknown };

    const amount = typeof parsed.amount === 'number' && isFinite(parsed.amount)
      ? Math.round(parsed.amount)
      : null;

    const rideDate = typeof parsed.date === 'string' && /^\d{4}\/\d{2}\/\d{2}$/.test(parsed.date)
      ? parsed.date
      : '';

    return { amount, rideDate };
  } catch (err) {
    console.error('[vision] error:', (err as Error).message);
    return empty;
  }
}

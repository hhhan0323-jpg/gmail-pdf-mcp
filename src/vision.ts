/**
 * Receipt / ticket OCR via Anthropic Vision API.
 * Official spec: only base64 images (JPEG/PNG/GIF/WEBP) are accepted.
 * PDFs are first rendered to JPEG via headless Chrome (Puppeteer), then sent as images.
 * Requires ANTHROPIC_API_KEY env var.
 */

import puppeteer from 'puppeteer';

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
]);

export interface OcrResult {
  amount: number | null;
  rideDate: string;
}

// Render the first page of a PDF to a JPEG buffer using headless Chrome.
async function pdfToJpeg(pdfBuffer: Buffer): Promise<Buffer | null> {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754 });

    const dataUrl = `data:application/pdf;base64,${pdfBuffer.toString('base64')}`;
    await page.goto(dataUrl, { waitUntil: 'networkidle0', timeout: 15000 });
    // Give Chrome's PDF viewer time to render
    await new Promise(r => setTimeout(r, 1500));

    const shot = await page.screenshot({ type: 'jpeg', quality: 90 });
    return Buffer.from(shot);
  } catch (err) {
    console.error('[vision] pdfToJpeg error:', (err as Error).message);
    return null;
  } finally {
    await browser?.close();
  }
}

const VISION_PROMPT = `Look at this receipt or transport ticket (may be in Chinese/Traditional Chinese).

Extract ONLY these two values:
1. Payment amount: search for labels like 總金額, 車資, 支付金額, 實付金額, 票價, 金額, 合計, 小計, NT$, NTD. Use the final/total amount.
2. Travel or purchase date: search for 乘車時間, 交易日期, 搭乘日期, 出發日期, or any date on the receipt. If the year is shown as 民國 (ROC calendar), add 1911 to get Western year (e.g. 民國115年 = 2026, 民國114年 = 2025).

Respond with ONLY valid JSON, nothing else:
{"amount": <integer or null>, "date": "<YYYY/MM/DD or null>"}

Examples:
{"amount": 334, "date": "2026/04/27"}
{"amount": 520, "date": null}
{"amount": null, "date": null}`;

// Call Anthropic Vision API with a base64 image.
async function callVisionApi(
  imageBase64: string,
  mediaType: string,
  apiKey: string
): Promise<OcrResult> {
  const empty: OcrResult = { amount: null, rideDate: '' };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imageBase64 },
          },
          { type: 'text', text: VISION_PROMPT },
        ],
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

  // Strip code fences if present, then parse JSON
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
}

/**
 * Extract 金額 and 乘車日期 from an image or PDF attachment.
 * - Images (JPEG/PNG/GIF/WEBP): sent directly as base64 to Anthropic Vision.
 * - PDFs: first rendered to JPEG via Puppeteer, then sent as base64.
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

  try {
    let imageBase64: string;
    let mediaType: string;

    if (isPdf) {
      const jpegBuffer = await pdfToJpeg(buffer);
      if (!jpegBuffer) return empty;
      imageBase64 = jpegBuffer.toString('base64');
      mediaType = 'image/jpeg';
    } else {
      imageBase64 = buffer.toString('base64');
      mediaType = lowerMime === 'image/jpg' ? 'image/jpeg' : lowerMime;
    }

    return await callVisionApi(imageBase64, mediaType, apiKey);
  } catch (err) {
    console.error('[vision] error:', (err as Error).message);
    return empty;
  }
}

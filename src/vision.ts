/**
 * Receipt / ticket OCR via Google Cloud Vision API.
 * Supports images (JPEG/PNG/GIF/WEBP) and PDFs (converted to JPEG via Puppeteer).
 * HTML email bodies are rendered to JPEG via Puppeteer before OCR.
 * Requires GOOGLE_VISION_API_KEY env var.
 */

import puppeteer from 'puppeteer';
import { parseReceiptOcrText } from './parser.js';

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
]);

export interface OcrResult {
  amount: number | null;
  rideDate: string;
}

// Render the first page of a PDF to JPEG via headless Chrome.
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

// Render email HTML body to JPEG (first 3000px) for OCR.
async function htmlToJpeg(htmlContent: string): Promise<Buffer | null> {
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 3000 });
    await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const shot = await page.screenshot({
      type: 'jpeg',
      quality: 85,
      clip: { x: 0, y: 0, width: 1200, height: 3000 },
    });
    return Buffer.from(shot);
  } catch (err) {
    console.error('[vision] htmlToJpeg error:', (err as Error).message);
    return null;
  } finally {
    await browser?.close();
  }
}

// Call Google Cloud Vision DOCUMENT_TEXT_DETECTION. Returns raw OCR text.
async function callGoogleVision(imageBase64: string, apiKey: string): Promise<string> {
  const resp = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: imageBase64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
        }],
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    console.error('[vision] Google Vision error', resp.status, text.slice(0, 300));
    return '';
  }

  const data = await resp.json() as {
    responses?: { fullTextAnnotation?: { text?: string } }[];
  };
  const text = data.responses?.[0]?.fullTextAnnotation?.text ?? '';
  console.error(`[vision] OCR (${text.length}c): ${text.slice(0, 120).replace(/\n/g, ' ')}`);
  return text;
}

/**
 * Extract 金額 and 乘車日期 from an image or PDF attachment.
 */
export async function ocrReceiptFields(
  buffer: Buffer,
  mimeType: string
): Promise<OcrResult> {
  const empty: OcrResult = { amount: null, rideDate: '' };
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) return empty;

  const lowerMime = mimeType.toLowerCase().split(';')[0].trim();
  const isImage = SUPPORTED_IMAGE_TYPES.has(lowerMime);
  const isPdf = lowerMime === 'application/pdf';
  if (!isImage && !isPdf) return empty;

  try {
    let imageBase64: string;
    if (isPdf) {
      const jpegBuffer = await pdfToJpeg(buffer);
      if (!jpegBuffer) return empty;
      imageBase64 = jpegBuffer.toString('base64');
    } else {
      imageBase64 = buffer.toString('base64');
    }

    const ocrText = await callGoogleVision(imageBase64, apiKey);
    if (!ocrText) return empty;
    return parseReceiptOcrText(ocrText);
  } catch (err) {
    console.error('[vision] ocrReceiptFields error:', (err as Error).message);
    return empty;
  }
}

/**
 * OCR an email HTML body to extract 金額 and 乘車日期.
 * Renders the HTML to JPEG via Puppeteer, then calls Google Vision.
 */
export async function ocrHtmlBody(htmlBody: string): Promise<OcrResult> {
  const empty: OcrResult = { amount: null, rideDate: '' };
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey || !htmlBody) return empty;
  try {
    const jpegBuffer = await htmlToJpeg(htmlBody);
    if (!jpegBuffer) return empty;
    console.error(`[vision] html→jpeg ${jpegBuffer.length}b`);
    const ocrText = await callGoogleVision(jpegBuffer.toString('base64'), apiKey);
    if (!ocrText) return empty;
    return parseReceiptOcrText(ocrText);
  } catch (err) {
    console.error('[vision] ocrHtmlBody error:', (err as Error).message);
    return empty;
  }
}

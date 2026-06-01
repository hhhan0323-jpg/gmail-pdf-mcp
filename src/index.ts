import 'dotenv/config';
import { randomUUID } from 'crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  getAuthClientForSession, generateWebAuthUrl, completeOAuthCallback, getSessionAuthStatus,
  startMcpOAuthFlow, completeMcpOAuthCallback, exchangeMcpCode, validateBearerToken,
  initScheduleTokens, saveScheduleToken, getScheduleUserEmails,
  getOrCreateScheduleClient, generateAuthRefreshKey, validateAuthRefreshKey,
} from './auth.js';
import type { OAuth2Client } from 'google-auth-library';
import { searchEmails, fetchEmail, fetchAllAttachmentData, applyLabelToMessage, sendNotificationEmail } from './gmail.js';
import { convertEmailToPdfBuffer, closeBrowser } from './pdf-converter.js';
import { mergeEmailWithAttachments, countPdfPages } from './pdf-merger.js';
import { saveToLocal, saveToDrive, findDriveFile, saveExcelToDrive, createDateRangeDriveFolder } from './storage.js';
import { buildOutputPaths, getDefaultOutputDir, formatTimestamp } from './file-manager.js';
import type { ConversionResult, BatchConversionResult, EmailMessage } from './types.js';
import { parseEmailFields, extractNthItem } from './parser.js';
import type { ParsedEmailFields } from './parser.js';
import { generateExcelBuffer } from './excel.js';
import type { ExcelRow } from './excel.js';
import { ocrReceiptFields, ocrHtmlBody } from './vision.js';

// ── Tool helpers ───────────────────────────────────────────────────────────────

async function doConvertEmailMessage(
  auth: OAuth2Client,
  message: EmailMessage,
  outputDir: string,
  includeAttachments: boolean,
  driveFolderId?: string
): Promise<ConversionResult> {
  const paths = buildOutputPaths(outputDir, message.senderName, message.date);

  // Convert email HTML → PDF
  const emailPdf = await convertEmailToPdfBuffer(auth, message);

  let finalPdf = emailPdf;
  let attachmentsMerged = 0;
  const errors: string[] = [];

  if (includeAttachments && message.hasAttachments) {
    const attData = await fetchAllAttachmentData(auth, message);
    const { merged, attachmentsMerged: count, errors: mergeErrors } =
      await mergeEmailWithAttachments(emailPdf, attData);
    finalPdf = merged;
    attachmentsMerged = count;
    errors.push(...mergeErrors);
  }

  const pages = await countPdfPages(finalPdf);

  // Primary: upload to user's Google Drive
  let driveUrl: string | undefined;
  let driveFileId: string | undefined;
  let localPath: string | undefined;
  try {
    const drive = await saveToDrive(auth, finalPdf, message.senderName, paths.filename, driveFolderId);
    driveUrl = drive.driveUrl;
    driveFileId = drive.driveFileId;
  } catch (err) {
    // Fallback: save to local disk (local / stdio mode)
    errors.push(`Drive upload failed: ${(err as Error).message}`);
    localPath = await saveToLocal(finalPdf, paths.localDir, paths.filename);
  }

  return {
    success: true,
    messageId: message.messageId,
    subject: message.subject,
    senderName: message.senderName,
    filename: paths.filename,
    driveUrl,
    driveFileId,
    localPath,
    pages,
    attachmentsMerged,
    errors,
  };
}

async function doConvertEmail(
  auth: OAuth2Client,
  messageId: string,
  outputDir: string,
  includeAttachments: boolean
): Promise<ConversionResult> {
  const message = await fetchEmail(auth, messageId);
  return doConvertEmailMessage(auth, message, outputDir, includeAttachments);
}

// ── Tool definitions ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'authorize_gmail',
    description: '取得 Google 裝置授權碼，讓使用者在瀏覽器用自己的帳號登入 Gmail',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_gmail_auth',
    description: '檢查目前 session 的 Gmail 授權狀態',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_emails',
    description: '搜尋 Gmail 郵件列表（僅回傳摘要，不含正文）。此工具僅用於單純查詢郵件是否存在；若需要下載 PDF 或匯出 Excel，請改用 batch_export_excel，不要用此工具逐封讀取郵件。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '完整 Gmail 搜尋語法，例如 "subject:車資 from:user@example.com after:2026/4/27 before:2026/4/28"',
        },
        max_results: {
          type: 'number',
          description: '最多回傳幾封（預設 10，上限 50）',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_email_content',
    description: '取得單封郵件的完整內容（正文 + 附件列表）。此工具僅用於檢視單封郵件內容；若需要批次下載或匯出 Excel，請改用 batch_export_excel，不要用此工具逐封讀取再手動整理。',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: '郵件的 message_id（從 search_emails 取得）',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'convert_email_to_pdf',
    description: '將單封郵件（含附件）轉為 PDF 並儲存',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: '郵件的 message_id',
        },
        output_dir: {
          type: 'string',
          description: '本機儲存目錄（本機模式，預設使用 OUTPUT_DIR 環境變數）',
        },
        include_attachments: {
          type: 'boolean',
          description: '是否合併附件（預設 true）',
        },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'batch_convert_emails',
    description: '搜尋郵件並批次轉 PDF（主要使用工具），支援完整 Gmail 搜尋語法',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '完整 Gmail 搜尋語法，例如 "subject:車資 from:user@example.com after:2026/4/27 before:2026/4/28"',
        },
        max_results: {
          type: 'number',
          description: '最多處理幾封（預設 5）',
        },
        output_dir: {
          type: 'string',
          description: '本機儲存目錄（本機模式）',
        },
        include_attachments: {
          type: 'boolean',
          description: '是否合併附件（預設 true）',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'batch_export_excel',
    description: '【主要工具】完整車資處理流程，一步完成：① 搜尋郵件 → ② 逐封下載並轉為 PDF 上傳至 Google Drive → ③ 用 OCR 自動從附件圖片/PDF 抓取金額與乘車日期 → ④ 自動加上 Gmail 標籤「車資(已處理)」→ ⑤ 匯出 Excel 彙整表（欄位：乘車日期、客戶名稱、對造名稱、案號、抵達地點、請款人、金額、備註、Gmail 連結、PDF 檔名）。當任務包含「下載郵件」「轉 PDF」「匯出 Excel」「生成彙整表」等需求時，必須優先呼叫此工具，不可改用 search_emails + fetch_email_content 手動逐步完成。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '完整 Gmail 搜尋語法，例如 "subject:車資 from:user@example.com after:2026/4/1"',
        },
        max_results: {
          type: 'number',
          description: '最多處理幾封（預設 20，上限 50）',
        },
        include_attachments: {
          type: 'boolean',
          description: '是否合併附件至 PDF（預設 true）',
        },
        skip_existing_pdf: {
          type: 'boolean',
          description: '若 Drive 已有同名 PDF 則跳過重新轉換（預設 true）',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_schedule_token',
    description: '將目前的 Google 授權儲存為個人排程 token。呼叫後會回傳一個永久 bearer token，讓無人值守的排程任務可以用你自己的 Gmail 和 Google Drive 執行，不需要每次重新授權。每個 Google 帳號只需要設定一次。',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool handlers (all receive sessionId for per-session auth) ─────────────────

async function handleAuthorizeGmail(sessionId: string) {
  const authUrl = generateWebAuthUrl(sessionId);
  return {
    auth_url: authUrl,
    message: [
      '請點選以下連結完成 Gmail 授權（在瀏覽器開啟）：',
      '',
      authUrl,
      '',
      '完成授權後，連結頁面會顯示「授權成功」。',
      '之後即可直接使用 search_emails、batch_convert_emails 等工具。',
    ].join('\n'),
  };
}

async function handleCheckGmailAuth(sessionId: string) {
  const status = getSessionAuthStatus(sessionId);
  const messages: Record<string, string> = {
    authorized: '✅ 已授權，可以使用所有工具。',
    pending: '⏳ 等待授權中，請在瀏覽器完成 Google 登入。',
    none: '⚠️ 尚未授權。請呼叫 authorize_gmail 取得授權連結。',
  };
  return { status, message: messages[status] };
}

async function handleSearchEmails(sessionId: string, args: Record<string, unknown>) {
  const query = String(args['query']);
  const maxResults = Math.min(Number(args['max_results'] ?? 10), 50);
  const auth = await getAuthClientForSession(sessionId);
  const results = await searchEmails(auth, query, maxResults);
  return { emails: results, total_found: results.length };
}

async function handleFetchEmailContent(sessionId: string, args: Record<string, unknown>) {
  const messageId = String(args['message_id']);
  const auth = await getAuthClientForSession(sessionId);
  const message = await fetchEmail(auth, messageId);
  return {
    message_id: message.messageId,
    subject: message.subject,
    sender_name: message.senderName,
    sender_email: message.senderEmail,
    date: message.date.toISOString(),
    html_body: message.htmlBody,
    plain_body: message.plainBody,
    attachments: message.attachments.map(a => ({
      attachment_id: a.attachmentId,
      filename: a.filename,
      mime_type: a.mimeType,
      size: a.size,
    })),
  };
}

async function handleConvertEmailToPdf(sessionId: string, args: Record<string, unknown>) {
  const messageId = String(args['message_id']);
  const outputDir = args['output_dir'] ? String(args['output_dir']) : getDefaultOutputDir();
  const includeAttachments = args['include_attachments'] !== false;
  const auth = await getAuthClientForSession(sessionId);
  return doConvertEmail(auth, messageId, outputDir, includeAttachments);
}

async function handleSaveScheduleToken(sessionId: string) {
  const { token, email } = await saveScheduleToken(sessionId);
  return {
    email,
    token,
    instructions: [
      `✅ 排程 token 已儲存至 Key Vault（帳號：${email}）`,
      `請將以下設定加入 .claude.json 的 mcpServers.gmail-pdf：`,
      `"headers": { "Authorization": "Bearer ${token}" }`,
      `設定好後，排程任務即可使用你的 Gmail 和 Google Drive，不需要重新授權。`,
    ].join('\n'),
  };
}

async function handleBatchExportExcel(sessionId: string, args: Record<string, unknown>): Promise<unknown> {
  const query = String(args['query']);
  const maxResults = Math.min(Number(args['max_results'] ?? 20), 50);
  const includeAttachments = args['include_attachments'] !== false;
  const skipExisting = args['skip_existing_pdf'] !== false;
  const outputDir = getDefaultOutputDir();

  console.error(`[batch] start: query="${query}" max=${maxResults} skipExisting=${skipExisting}`);

  const auth = await getAuthClientForSession(sessionId);
  const emailSummaries = await searchEmails(auth, query, maxResults);
  console.error(`[batch] found ${emailSummaries.length} emails`);

  type RowResult = {
    messageId: string;
    subject: string;
    status: string;
    pdfFilename?: string;
    driveUrl?: string;
  };

  // Determine date range from email metadata → name the Drive folder
  function compactDate(d: Date) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }
  const validDates = emailSummaries.map(s => new Date(s.date)).filter(d => !isNaN(d.getTime()));
  const minDate = validDates.length ? new Date(Math.min(...validDates.map(d => d.getTime()))) : new Date();
  const maxDate = validDates.length ? new Date(Math.max(...validDates.map(d => d.getTime()))) : new Date();
  const dateRangeName = compactDate(minDate) === compactDate(maxDate)
    ? compactDate(minDate)
    : `${compactDate(minDate)}-${compactDate(maxDate)}`;

  // Create shared Drive folder for this batch: Gmail PDF MCP / {dateRange} /
  const dateRangeFolderId = await createDateRangeDriveFolder(auth, dateRangeName);

  const excelRows: ExcelRow[] = [];
  const results: RowResult[] = [];

  // Process one email and return its results (or an error entry)
  type AttOcr = { filename: string; amount: number | null; rideDate: string };
  type EmailResult = {
    ok: true;
    message: EmailMessage;
    rowFieldsList: ParsedEmailFields[];
    pdfFilename: string;
    driveUrl: string | undefined;
    gmailLink: string;
    status: string;
  } | {
    ok: false;
    messageId: string;
    subject: string;
    error: string;
  };

  const processOne = async (summary: { messageId: string; subject: string }): Promise<EmailResult> => {
    try {
      const message = await fetchEmail(auth, summary.messageId);
      console.error(`[fetch] ${message.senderName} | plain=${message.plainBody.length}b html=${message.htmlBody.length}b atts=${message.attachments.length}`);
      const baseFields = parseEmailFields(message.plainBody, message.htmlBody, message.senderName, message.subject);
      console.error(`[parse] ${message.senderName} | amount=${baseFields.amount} date=${baseFields.rideDate}`);

      const attOcrResults: AttOcr[] = [];
      const needOcr = baseFields.amount === null || !baseFields.rideDate;
      const hasMultipleAtt = message.attachments.length > 1;

      if (message.hasAttachments && process.env.GOOGLE_VISION_API_KEY && (needOcr || hasMultipleAtt)) {
        const attData = await fetchAllAttachmentData(auth, message);
        for (const att of attData) {
          console.error(`[ocr] trying ${att.filename} (${att.mimeType}, ${att.data.length}b)`);
          const ocr = await ocrReceiptFields(att.data, att.mimeType);
          console.error(`[ocr] result: amount=${ocr.amount} date=${ocr.rideDate}`);
          attOcrResults.push({ filename: att.filename, amount: ocr.amount, rideDate: ocr.rideDate });
        }
      }

      const receiptOcrs = attOcrResults.filter(r => r.amount !== null && (r.amount as number) > 0);
      console.error(`[ocr-check] ${message.senderName} | hasAtt=${message.hasAttachments} | keySet=${!!process.env.GOOGLE_VISION_API_KEY} | attCount=${message.attachments.length} | receipts=${receiptOcrs.length}`);

      let rowFieldsList: ParsedEmailFields[];
      if (receiptOcrs.length > 1) {
        rowFieldsList = receiptOcrs.map((r, i) => ({
          ...baseFields,
          destination: extractNthItem(baseFields.destination, i + 1),
          notes: baseFields.notes || (/去程/i.test(r.filename) ? '去程' : /回程/i.test(r.filename) ? '回程' : ''),
          amount: r.amount,
          rideDate: r.rideDate || baseFields.rideDate,
        }));
      } else {
        const fields: ParsedEmailFields = { ...baseFields };
        for (const r of attOcrResults) {
          if (fields.amount === null && r.amount !== null) fields.amount = r.amount;
          if (!fields.rideDate && r.rideDate) fields.rideDate = r.rideDate;
        }
        if ((fields.amount === null || !fields.rideDate) && message.htmlBody && process.env.GOOGLE_VISION_API_KEY) {
          console.error(`[ocr-html] ${message.senderName} | rendering body (${message.htmlBody.length}b)...`);
          const ocr = await ocrHtmlBody(message.htmlBody);
          console.error(`[ocr-html] result: amount=${ocr.amount} date=${ocr.rideDate}`);
          if (fields.amount === null && ocr.amount !== null) fields.amount = ocr.amount;
          if (!fields.rideDate && ocr.rideDate) fields.rideDate = ocr.rideDate;
        }
        rowFieldsList = [fields];
      }

      const paths = buildOutputPaths(outputDir, message.senderName, message.date);
      const gmailLink = `https://mail.google.com/mail/u/0/#all/${message.messageId}`;

      let pdfFilename: string | undefined;
      let driveUrl: string | undefined;
      let status = '';

      if (skipExisting) {
        const existing = await findDriveFile(auth, paths.filename);
        if (existing) {
          pdfFilename = paths.filename;
          driveUrl = existing.driveUrl;
          status = 'skipped';
        }
      }

      if (!pdfFilename) {
        const result = await doConvertEmailMessage(auth, message, outputDir, includeAttachments, dateRangeFolderId);
        pdfFilename = result.filename;
        driveUrl = result.driveUrl;
        status = result.success ? 'converted' : `failed: ${result.errors.join(', ')}`;
      }

      if (status === 'converted' || status === 'skipped') {
        try {
          await applyLabelToMessage(auth, message.messageId, '車資(已處理)');
        } catch (err) {
          console.error(`[label] failed for ${message.messageId}:`, (err as Error).message);
        }
      }

      return { ok: true, message, rowFieldsList, pdfFilename: pdfFilename!, driveUrl, gmailLink, status };
    } catch (err) {
      return { ok: false, messageId: summary.messageId, subject: summary.subject, error: (err as Error).message };
    }
  };

  // Process in parallel batches of 2 to stay within Azure timeout (4 min)
  const CONCURRENCY = 2;
  for (let i = 0; i < emailSummaries.length; i += CONCURRENCY) {
    const batch = emailSummaries.slice(i, i + CONCURRENCY);
    console.error(`[batch] processing emails ${i + 1}–${Math.min(i + CONCURRENCY, emailSummaries.length)} of ${emailSummaries.length}`);
    const batchResults = await Promise.all(batch.map(processOne));
    for (const r of batchResults) {
      if (r.ok) {
        for (const fields of r.rowFieldsList) {
          excelRows.push({ message: r.message, fields, pdfFilename: r.pdfFilename, gmailLink: r.gmailLink });
        }
        results.push({ messageId: r.message.messageId, subject: r.message.subject, status: r.status, pdfFilename: r.pdfFilename, driveUrl: r.driveUrl });
      } else {
        results.push({ messageId: r.messageId, subject: r.subject, status: `error: ${r.error}` });
      }
    }
  }

  console.error(`[batch] done: ${excelRows.length} excel rows, uploading...`);
  const excelBuffer = await generateExcelBuffer(excelRows);
  const excelFilename = `車資報表_${formatTimestamp(new Date())}.xlsx`;
  const { driveUrl: excelDriveUrl } = await saveExcelToDrive(auth, excelBuffer, excelFilename, dateRangeFolderId);
  console.error(`[batch] excel uploaded: ${excelFilename}`);

  return {
    processed: results.filter(r => r.status === 'converted' || r.status === 'skipped').length,
    failed: results.filter(r => r.status.startsWith('error') || r.status.startsWith('failed')).length,
    date_range: dateRangeName,
    drive_folder: `Gmail PDF MCP / ${dateRangeName}`,
    excel_url: excelDriveUrl,
    excel_filename: excelFilename,
    results,
  };
}

async function handleBatchConvertEmails(sessionId: string, args: Record<string, unknown>): Promise<BatchConversionResult> {
  const query = String(args['query']);
  const maxResults = Math.min(Number(args['max_results'] ?? 5), 20);
  const outputDir = args['output_dir'] ? String(args['output_dir']) : getDefaultOutputDir();
  const includeAttachments = args['include_attachments'] !== false;

  const auth = await getAuthClientForSession(sessionId);
  const emails = await searchEmails(auth, query, maxResults);

  let processed = 0, failed = 0;
  const results: ConversionResult[] = [];

  for (const email of emails) {
    try {
      results.push(await doConvertEmail(auth, email.messageId, outputDir, includeAttachments));
      processed++;
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`Failed to convert ${email.messageId}:`, msg);
      results.push({
        success: false,
        messageId: email.messageId,
        subject: email.subject,
        senderName: email.senderName,
        filename: '',
        pages: 0,
        attachmentsMerged: 0,
        errors: [msg],
      });
      failed++;
    }
  }

  return { processed, failed, results };
}

// ── MCP Server factory ─────────────────────────────────────────────────────────

function createMcpServer(sessionId: string): Server {
  const server = new Server(
    { name: 'gmail-pdf-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'authorize_gmail':
          result = await handleAuthorizeGmail(sessionId);
          break;
        case 'check_gmail_auth':
          result = await handleCheckGmailAuth(sessionId);
          break;
        case 'search_emails':
          result = await handleSearchEmails(sessionId, args as Record<string, unknown>);
          break;
        case 'fetch_email_content':
          result = await handleFetchEmailContent(sessionId, args as Record<string, unknown>);
          break;
        case 'convert_email_to_pdf':
          result = await handleConvertEmailToPdf(sessionId, args as Record<string, unknown>);
          break;
        case 'batch_convert_emails':
          result = await handleBatchConvertEmails(sessionId, args as Record<string, unknown>);
          break;
        case 'batch_export_excel':
          result = await handleBatchExportExcel(sessionId, args as Record<string, unknown>);
          break;
        case 'save_schedule_token':
          result = await handleSaveScheduleToken(sessionId);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = (err as Error).message;
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  const isAzure = process.env.AZURE_DEPLOYMENT === 'true';

  if (isAzure) {
    const port = parseInt(process.env.PORT ?? '8080', 10);
    const app = express();
    app.use(express.json());

    // CORS — required for browser-based MCP clients (claude.ai, Claude Desktop)
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-session-id');
      if (req.method === 'OPTIONS') { res.status(204).end(); return; }
      next();
    });

    // Per-session MCP transport map (keyed by MCP transport session ID)
    const transports = new Map<string, StreamableHTTPServerTransport>();

    // ── MCP Authorization spec endpoints ──────────────────────────────────────

    // RFC 9728 — Protected Resource Metadata
    app.get('/.well-known/oauth-protected-resource', (req, res) => {
      const base = `https://${req.hostname}`;
      res.json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
      });
    });

    // RFC 8414 — Authorization Server Metadata
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
      const base = `https://${req.hostname}`;
      res.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    });

    // RFC 7591 — Dynamic Client Registration
    app.post('/register', express.json(), (req, res) => {
      const { redirect_uris = [], client_name = 'mcp-client' } = req.body ?? {};
      res.status(201).json({
        client_id: randomUUID(),
        client_name,
        redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      });
    });

    // Authorization endpoint — redirect user through Google OAuth
    app.get('/authorize', (req, res) => {
      const { response_type, redirect_uri, state, code_challenge, code_challenge_method } = req.query;
      if (
        response_type !== 'code' ||
        code_challenge_method !== 'S256' ||
        !redirect_uri || !state || !code_challenge
      ) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const googleUrl = startMcpOAuthFlow({
        mcpRedirectUri: redirect_uri as string,
        mcpState: state as string,
        codeChallenge: code_challenge as string,
      });
      res.redirect(302, googleUrl);
    });

    // Token endpoint — exchange auth code for bearer token (PKCE verified)
    app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
      const { grant_type, code, redirect_uri, code_verifier } = req.body as Record<string, string>;
      if (grant_type !== 'authorization_code' || !code || !redirect_uri || !code_verifier) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const token = exchangeMcpCode(code, code_verifier, redirect_uri);
      if (!token) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      res.json({ access_token: token, token_type: 'bearer' });
    });

    // ── MCP endpoint (requires Bearer token) ──────────────────────────────────

    app.all('/mcp', async (req, res) => {
      // Validate Bearer token → resolve auth session
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        const base = `https://${req.hostname}`;
        res.status(401)
          .set('WWW-Authenticate', `Bearer realm="mcp", resource_metadata_url="${base}/.well-known/oauth-protected-resource"`)
          .json({ error: 'unauthorized' });
        return;
      }
      const authSessionId = validateBearerToken(authHeader.slice(7));
      if (!authSessionId) {
        res.status(401)
          .set('WWW-Authenticate', 'Bearer realm="mcp", error="invalid_token"')
          .json({ error: 'invalid_token' });
        return;
      }

      // Route MCP transport (separate from auth session)
      const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;
      if (mcpSessionId && transports.has(mcpSessionId)) {
        await transports.get(mcpSessionId)!.handleRequest(req, res, req.body);
        return;
      }

      // New transport bound to this authenticated user
      const newMcpSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newMcpSessionId,
      });
      transport.onclose = () => transports.delete(newMcpSessionId);
      transports.set(newMcpSessionId, transport);

      const server = createMcpServer(authSessionId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    // ── Weekly export trigger (called by GitHub Actions every Monday 08:00 UTC+8) ─

    app.post('/trigger/weekly-export', async (req, res) => {
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const authSessionId = validateBearerToken(authHeader.slice(7));
      if (!authSessionId) {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }

      // Calculate previous week range in Asia/Taipei (UTC+8), Saturday-to-Saturday
      const nowUtc = new Date();
      const localNow = new Date(nowUtc.getTime() + 8 * 3600000);
      const localDay = localNow.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
      const daysSinceSat = localDay === 6 ? 0 : localDay + 1;

      const thisSaturday = new Date(localNow);
      thisSaturday.setUTCDate(localNow.getUTCDate() - daysSinceSat);
      thisSaturday.setUTCHours(0, 0, 0, 0);

      const lastSaturday = new Date(thisSaturday);
      lastSaturday.setUTCDate(thisSaturday.getUTCDate() - 7);

      const fmt = (d: Date) =>
        `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;

      const query = `subject:車資 after:${fmt(lastSaturday)} before:${fmt(thisSaturday)}`;

      // Use per-user schedule tokens so the export runs under each user's Gmail/Drive.
      // Fall back to the deployer account (authSessionId) if no per-user tokens exist.
      const userEmails = getScheduleUserEmails();
      const sessionIds = userEmails.length > 0
        ? userEmails.map(email => `schedule:${email}`)
        : [authSessionId];

      console.error(`[trigger] weekly-export starting: ${query} for ${sessionIds.join(', ')}`);

      // Run export synchronously for all users (keeps HTTP connection open so the
      // container is not scaled down to 0 before the export finishes).
      const exportResults: Array<{ user: string; processed: number; failed: number; excel_url?: string }> = [];
      for (const sid of sessionIds) {
        const userEmail = sid.startsWith('schedule:') ? sid.slice(9) : 'deployer';
        try {
          const result = await handleBatchExportExcel(sid, { query, max_results: 50 }) as {
            processed?: number; failed?: number; excel_url?: string; date_range?: string;
          };
          console.error(`[trigger] weekly-export done [${userEmail}]: processed=${result.processed} excel=${result.excel_url}`);
          exportResults.push({ user: userEmail, processed: result.processed ?? 0, failed: result.failed ?? 0, excel_url: result.excel_url });

          // Send completion notification email
          try {
            const auth = await getAuthClientForSession(sid);
            const subject = `【自動通知】每週報表完成 ${result.date_range ?? ''}`;
            const body = [
              `${userEmail} 您好，`,
              ``,
              `本週車資報表已自動完成，摘要如下：`,
              ``,
              `  搜尋條件：${query}`,
              `  已處理：${result.processed ?? 0} 封`,
              `  失敗：${result.failed ?? 0} 封`,
              ``,
              `Excel 連結：`,
              `  ${result.excel_url ?? '（無法取得連結）'}`,
              ``,
              `此為自動排程通知，每週六 08:00 執行。`,
            ].join('\n');
            await sendNotificationEmail(auth, userEmail, subject, body);
            console.error(`[trigger] notification email sent to ${userEmail}`);
          } catch (err) {
            console.error(`[trigger] notification email failed [${userEmail}]:`, (err as Error).message);
          }
        } catch (err) {
          console.error(`[trigger] weekly-export error [${userEmail}]:`, (err as Error).message);
          exportResults.push({ user: userEmail, processed: 0, failed: -1 });
        }
      }

      res.json({ success: true, query, results: exportResults });
    });

    // ── Auth reminder: send weekly re-auth email before Saturday's export ──────

    app.post('/trigger/send-auth-reminder', async (req, res) => {
      const authHeader = req.headers['authorization'];
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const authSessionId = validateBearerToken(authHeader.slice(7));
      if (!authSessionId) {
        res.status(401).json({ error: 'invalid_token' });
        return;
      }

      const userEmails = getScheduleUserEmails();
      if (userEmails.length === 0) {
        res.json({ success: true, message: 'No scheduled users configured.', results: [] });
        return;
      }

      const base = `https://${req.hostname}`;
      const results: Array<{ email: string; status: string; error?: string }> = [];

      for (const email of userEmails) {
        try {
          const key = generateAuthRefreshKey(email);
          const authUrl = `${base}/auth-refresh?email=${encodeURIComponent(email)}&key=${key}`;

          const subject = '【提醒】週六自動匯出 — 請點選連結授權（30 秒）';
          const body = [
            `${email} 您好，`,
            ``,
            `每週六 08:00 的車資自動匯出即將執行。`,
            `請在今天點選以下連結完成授權，確保明天自動匯出順利執行：`,
            ``,
            `  ${authUrl}`,
            ``,
            `點選後選擇 ${email} 帳號，允許存取即可（約 30 秒）。`,
            `此連結可重複使用，無需每週申請新連結。`,
            ``,
            `— Gmail PDF 自動通知`,
          ].join('\n');

          const auth = await getOrCreateScheduleClient(email);
          await sendNotificationEmail(auth, email, subject, body);
          console.error(`[auth-reminder] Sent reminder to ${email}`);
          results.push({ email, status: 'sent' });
        } catch (err) {
          const msg = (err as Error).message;
          console.error(`[auth-reminder] Failed to send reminder to ${email}:`, msg);
          results.push({ email, status: 'failed', error: msg });
        }
      }

      res.json({ success: true, results });
    });

    // ── Auth refresh redirect: generates a fresh Google OAuth URL on click ─────

    app.get('/auth-refresh', (req, res) => {
      const { email, key } = req.query as Record<string, string>;
      if (!email || !key || !validateAuthRefreshKey(email, key)) {
        res.status(403).send('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>❌ 連結無效</h1><p>請聯繫管理員重新產生授權連結。</p></body></html>');
        return;
      }
      const url = generateWebAuthUrl(`schedule:${email}`);
      res.redirect(302, url);
    });

    // ── OAuth2 callback (handles both MCP flow and manual authorize_gmail) ────

    app.get('/oauth2callback', async (req, res) => {
      const { code, state, error } = req.query;
      if (error || !code || !state) {
        res.status(400).send('<h1 style="font-family:sans-serif">授權失敗，請重新呼叫 authorize_gmail。</h1>');
        return;
      }

      // MCP Authorization flow — redirect back to MCP client with our auth code
      const mcpResult = await completeMcpOAuthCallback(state as string, code as string);
      if (mcpResult) {
        const redirect = new URL(mcpResult.mcpRedirectUri);
        redirect.searchParams.set('code', mcpResult.mcpAuthCode);
        redirect.searchParams.set('state', mcpResult.mcpState);
        res.redirect(302, redirect.toString());
        return;
      }

      // Manual authorize_gmail tool flow — show success page
      try {
        await completeOAuthCallback(state as string, code as string);
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h1>✅ Gmail 授權成功！</h1>
          <p>你現在可以關閉此視窗，並在 Claude 中使用 search_emails、batch_convert_emails 等工具。</p>
        </body></html>`);
      } catch (err) {
        res.status(400).send(`<h1 style="font-family:sans-serif">❌ 授權失敗：${(err as Error).message}</h1>`);
      }
    });

    // Health check for Azure Container Apps
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));

    await initScheduleTokens();

    app.listen(port, () => {
      console.error(`Gmail PDF MCP Server listening on port ${port} (HTTP/SSE)`);
    });
  } else {
    const server = createMcpServer('local');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Gmail PDF MCP Server running on stdio');
  }

  // Cleanup browser on shutdown
  process.on('SIGTERM', async () => { await closeBrowser(); process.exit(0); });
  process.on('SIGINT', async () => { await closeBrowser(); process.exit(0); });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

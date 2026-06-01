import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type { EmailMessage, EmailSummary, EmailAttachment, AttachmentData } from './types.js';

type AuthClient = OAuth2Client;

function getGmailClient(auth: AuthClient) {
  return google.gmail({ version: 'v1', auth: auth as OAuth2Client });
}

// Decode Gmail's base64url-encoded body data
function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function decodeBase64UrlBuffer(data: string): Buffer {
  return Buffer.from(data, 'base64url');
}

// Parse sender header: "John Doe <john@example.com>" or "john@example.com"
export function parseSender(from: string): { name: string; email: string } {
  const match = from.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  const emailOnly = from.trim();
  const localPart = emailOnly.split('@')[0] ?? emailOnly;
  return { name: localPart, email: emailOnly };
}

interface MimePart {
  mimeType?: string | null;
  filename?: string | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
  body?: { data?: string | null; attachmentId?: string | null; size?: number | null } | null;
  parts?: MimePart[] | null;
}

function findHeader(headers: Array<{ name?: string | null; value?: string | null }> | null | undefined, name: string): string {
  return headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Recursively walk MIME tree to extract HTML body and attachments
function parseMimeTree(
  part: MimePart,
  result: { html: string; plain: string; attachments: EmailAttachment[] }
): void {
  const mime = part.mimeType ?? '';
  const headers = part.headers ?? [];
  const contentId = findHeader(headers, 'Content-ID').replace(/[<>]/g, '');

  if (mime === 'text/html' && part.body?.data) {
    // Keep the largest HTML part: forwarded emails often have a small wrapper (outer)
    // and a large inner HTML (the actual forwarded content). Taking the largest ensures
    // we capture the full content rather than just the forwarding note.
    const decoded = decodeBase64Url(part.body.data);
    if (decoded.length > result.html.length) result.html = decoded;
    return;
  }

  if (mime === 'text/plain' && part.body?.data) {
    // Accumulate all plain-text parts (forwarded emails add more text/plain sections).
    result.plain += (result.plain ? '\n' : '') + decodeBase64Url(part.body.data);
    return;
  }

  // Embedded RFC822 message (forwarded email stored as raw bytes with no parsed parts).
  // Decode and append to plain so amount-extraction patterns can match against it.
  if (mime === 'message/rfc822' && part.body?.data && !(part.parts?.length)) {
    result.plain += (result.plain ? '\n\n' : '') + decodeBase64Url(part.body.data);
    return;
  }

  // Attachment: has a filename OR an attachmentId
  if (part.body?.attachmentId) {
    const filename = part.filename ?? contentId ?? 'attachment';
    result.attachments.push({
      attachmentId: part.body.attachmentId,
      filename,
      mimeType: mime,
      size: part.body.size ?? 0,
      contentId: contentId || undefined,
    });
    return;
  }

  // Recurse into multipart (and message/rfc822 with exposed inner parts)
  if (part.parts) {
    for (const child of part.parts) {
      parseMimeTree(child, result);
    }
  }
}

export async function searchEmails(
  auth: AuthClient,
  query: string,
  maxResults = 10
): Promise<EmailSummary[]> {
  const gmail = getGmailClient(auth);

  // Collect message IDs with pagination until we hit maxResults
  const messageIds: Array<{ id: string; threadId?: string | null }> = [];
  let pageToken: string | undefined;

  while (messageIds.length < maxResults) {
    const remaining = maxResults - messageIds.length;
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(remaining, 500),
      pageToken,
    });

    for (const m of listRes.data.messages ?? []) {
      if (m.id) messageIds.push({ id: m.id, threadId: m.threadId });
    }
    pageToken = listRes.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  const messages = messageIds.slice(0, maxResults);
  if (messages.length === 0) return [];

  const summaries: EmailSummary[] = [];

  for (const msg of messages) {
    if (!msg.id) continue;

    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });

    const headers = detail.data.payload?.headers ?? [];
    const subject = findHeader(headers, 'Subject');
    const from = findHeader(headers, 'From');
    const dateStr = findHeader(headers, 'Date');
    const { name, email } = parseSender(from);

    summaries.push({
      messageId: msg.id,
      threadId: msg.threadId ?? '',
      subject,
      senderName: name,
      senderEmail: email,
      date: dateStr,
      snippet: detail.data.snippet ?? '',
      hasAttachments: (detail.data.payload?.parts ?? []).some(p => !!p.filename),
    });
  }

  return summaries;
}

export async function fetchEmail(
  auth: AuthClient,
  messageId: string
): Promise<EmailMessage> {
  const gmail = getGmailClient(auth);

  const detail = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const msg = detail.data;
  const headers = msg.payload?.headers ?? [];
  const subject = findHeader(headers, 'Subject');
  const from = findHeader(headers, 'From');
  const dateStr = findHeader(headers, 'Date');
  const { name, email } = parseSender(from);

  const parsed = { html: '', plain: '', attachments: [] as EmailAttachment[] };

  if (msg.payload) {
    parseMimeTree(msg.payload as MimePart, parsed);
  }

  // Some simple (non-multipart) messages store body directly in payload
  if (!parsed.html && msg.payload?.body?.data) {
    const mime = msg.payload.mimeType ?? '';
    if (mime === 'text/html') {
      parsed.html = decodeBase64Url(msg.payload.body.data);
    } else if (mime === 'text/plain') {
      parsed.plain = decodeBase64Url(msg.payload.body.data);
    }
  }

  return {
    messageId,
    threadId: msg.threadId ?? '',
    subject,
    senderName: name,
    senderEmail: email,
    date: new Date(dateStr),
    snippet: msg.snippet ?? '',
    htmlBody: parsed.html,
    plainBody: parsed.plain,
    hasAttachments: parsed.attachments.length > 0,
    attachments: parsed.attachments,
  };
}

export async function fetchAttachment(
  auth: AuthClient,
  messageId: string,
  attachmentId: string
): Promise<Buffer> {
  const gmail = getGmailClient(auth);

  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  const data = res.data.data ?? '';
  return decodeBase64UrlBuffer(data);
}

// Fetch all non-cid attachments as well as cid inline images
export async function fetchAllAttachmentData(
  auth: AuthClient,
  message: EmailMessage
): Promise<AttachmentData[]> {
  const results: AttachmentData[] = [];

  for (const att of message.attachments) {
    try {
      const data = await fetchAttachment(auth, message.messageId, att.attachmentId);
      results.push({ filename: att.filename, mimeType: att.mimeType, data });
    } catch (err) {
      console.error(`Failed to fetch attachment ${att.filename}:`, err);
    }
  }

  return results;
}

// Cache label IDs to avoid repeated labels.list API calls within the same server process
const labelIdCache = new Map<string, string>();

// Look up a Gmail label ID by display name. Returns null if not found.
export async function getLabelIdByName(
  auth: AuthClient,
  labelName: string
): Promise<string | null> {
  if (labelIdCache.has(labelName)) return labelIdCache.get(labelName)!;
  const gmail = getGmailClient(auth);
  const res = await gmail.users.labels.list({ userId: 'me' });
  const label = res.data.labels?.find(l => l.name === labelName);
  if (label?.id) labelIdCache.set(labelName, label.id);
  return label?.id ?? null;
}

// Apply a label (by display name) to a Gmail message.
export async function applyLabelToMessage(
  auth: AuthClient,
  messageId: string,
  labelName: string
): Promise<void> {
  const labelId = await getLabelIdByName(auth, labelName);
  if (!labelId) {
    console.error(`[gmail] Label not found: ${labelName}`);
    return;
  }
  const gmail = getGmailClient(auth);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

// Send a plain-text notification email from the authenticated account to `to`.
export async function sendNotificationEmail(
  auth: AuthClient,
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const gmail = getGmailClient(auth);
  const raw = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body).toString('base64'),
  ].join('\r\n');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw).toString('base64url') },
  });
}

// Standalone test
if (require.main === module) {
  (async () => {
    const { getAuthClient } = await import('./auth.js');
    const auth = await getAuthClient();
    const results = await searchEmails(auth, '發票', 3);
    console.log(JSON.stringify(results, null, 2));
  })().catch(console.error);
}

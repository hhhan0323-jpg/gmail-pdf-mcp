import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import type { OAuth2Client } from 'google-auth-library';

// Save PDF to local filesystem (local / stdio mode)
export async function saveToLocal(
  pdfBuffer: Buffer,
  dirPath: string,
  filename: string
): Promise<string> {
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, filename);
  await fs.writeFile(filePath, pdfBuffer);
  return filePath;
}

// ── Google Drive ───────────────────────────────────────────────────────────────

async function getOrCreateDriveFolder(
  drive: any,
  name: string,
  parentId?: string
): Promise<string> {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const parentQ = parentId ? `'${parentId}' in parents` : `'root' in parents`;
  const q = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false and ${parentQ}`;

  const res = await drive.files.list({ q, fields: 'files(id)', spaces: 'drive' });
  if (res.data.files?.length > 0) return res.data.files[0].id as string;

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
  });
  return folder.data.id as string;
}

/**
 * Search Drive for an existing file by exact filename (across all folders).
 * Returns its view link and file ID if found, null otherwise.
 */
export async function findDriveFile(
  auth: OAuth2Client,
  filename: string
): Promise<{ driveUrl: string; driveFileId: string } | null> {
  const { google } = await import('googleapis');
  const drive = google.drive({ version: 'v3', auth });

  const escaped = filename.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name='${escaped}' and mimeType='application/pdf' and trashed=false`;

  const res = await drive.files.list({
    q,
    fields: 'files(id,webViewLink)',
    spaces: 'drive',
    pageSize: 1,
  });

  const file = res.data.files?.[0];
  if (!file?.id || !file?.webViewLink) return null;
  return { driveUrl: file.webViewLink, driveFileId: file.id };
}

/**
 * Upload an Excel file to the user's Google Drive under:
 *   Gmail PDF MCP / {filename}
 */
export async function saveExcelToDrive(
  auth: OAuth2Client,
  buffer: Buffer,
  filename: string
): Promise<{ driveUrl: string; driveFileId: string }> {
  const { google } = await import('googleapis');
  const drive = google.drive({ version: 'v3', auth });

  const rootId = await getOrCreateDriveFolder(drive, 'Gmail PDF MCP');

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [rootId] },
    media: {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: Readable.from(buffer),
    },
    fields: 'id,webViewLink',
  });

  await drive.permissions.create({
    fileId: file.data.id!,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return { driveUrl: file.data.webViewLink!, driveFileId: file.data.id! };
}

/**
 * Upload a PDF to the user's Google Drive under:
 *   Gmail PDF MCP / {senderName} / {filename}
 * Returns a shareable view link (anyone with link can view).
 */
export async function saveToDrive(
  auth: OAuth2Client,
  pdfBuffer: Buffer,
  senderName: string,
  filename: string
): Promise<{ driveUrl: string; driveFileId: string }> {
  const { google } = await import('googleapis');
  const drive = google.drive({ version: 'v3', auth });

  const rootId = await getOrCreateDriveFolder(drive, 'Gmail PDF MCP');
  const senderId = await getOrCreateDriveFolder(drive, senderName, rootId);

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [senderId] },
    media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
    fields: 'id,webViewLink',
  });

  await drive.permissions.create({
    fileId: file.data.id!,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return { driveUrl: file.data.webViewLink!, driveFileId: file.data.id! };
}

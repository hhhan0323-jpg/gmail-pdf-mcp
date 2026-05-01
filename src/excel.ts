import ExcelJS from 'exceljs';
import type { EmailMessage } from './types.js';
import type { ParsedEmailFields } from './parser.js';

export interface ExcelRow {
  message: EmailMessage;
  fields: ParsedEmailFields;
  pdfFilename?: string;
  gmailLink: string;
}

const HEADERS = [
  '乘車日期', '客戶名稱', '對造名稱', '案號', '抵達地點',
  '請款人', '金額(NTD)', '備註', '郵件時間', '寄件人(From)',
  '主旨', '郵件連結', 'PDF檔案名稱',
];

const COL_WIDTHS = [12, 12, 12, 28, 10, 10, 12, 20, 18, 35, 40, 55, 40];

export async function generateExcelBuffer(rows: ExcelRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('車資明細');

  // Header row
  ws.addRow(HEADERS);
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

  // Data rows
  for (const { message, fields, gmailLink, pdfFilename } of rows) {
    const emailTime = message.date.toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    const row = ws.addRow([
      fields.rideDate,
      fields.clientName,
      fields.opposingName,
      fields.caseNumber,
      fields.destination,
      fields.requester,
      fields.amount ?? '',
      fields.notes,
      emailTime,
      `${message.senderName} <${message.senderEmail}>`,
      message.subject,
      gmailLink,
      pdfFilename ?? '',
    ]);
    row.alignment = { vertical: 'middle', wrapText: false };
  }

  // 合計 row
  const lastDataRow = rows.length + 1;
  const totalRow = ws.addRow([
    '合計', '', '', '', '', '',
    { formula: `SUM(G2:G${lastDataRow})` },
    '', '', '', '', '', '',
  ]);
  totalRow.font = { bold: true };
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE0B2' } };

  // Column widths and number format
  ws.columns.forEach((col, i) => {
    col.width = COL_WIDTHS[i] ?? 15;
  });
  ws.getColumn(7).numFmt = '#,##0';

  return Buffer.from(await wb.xlsx.writeBuffer());
}

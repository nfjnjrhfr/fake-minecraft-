/** 拍照擷取的結構化輸出 schema（給 output_config.format 用）。 */
const str = { type: 'string' };
const strArr = { type: 'array', items: str };

function obj(properties) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export const EXTRACTION_SCHEMA = obj({
  doc_type: { ...str, description: '文件類型，例如「LINE 對話截圖」「電子發票」「會議白板」「產品說明書」' },
  languages: { ...strArr, description: '畫面上出現的語言' },
  title: { ...str, description: '一句話標題；沒有明顯標題就自己下一個' },
  full_text: {
    ...str,
    description: '畫面上所有文字的完整逐字內容，保留原本順序與換行；多張圖片以「【圖 1】」分隔；看不清的字用 [?]',
  },
  summary: { ...strArr, description: '3–6 條重點' },
  key_values: {
    type: 'array',
    description: '重要欄位，例如金額、單號、日期、地址、姓名',
    items: obj({ label: str, value: str }),
  },
  action_items: {
    type: 'array',
    description: '要做的事；沒有就給空陣列',
    items: obj({
      title: str,
      owner: { ...str, description: '負責人，不明填空字串' },
      due: { ...str, description: 'YYYY-MM-DD，不明填空字串' },
      notes: str,
    }),
  },
  events: {
    type: 'array',
    description: '可加進行事曆的行程；沒有就給空陣列',
    items: obj({
      title: str,
      start: { ...str, description: 'YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，不明填空字串' },
      end: { ...str, description: '同上格式，不明填空字串' },
      location: str,
      notes: str,
    }),
  },
  tables: {
    type: 'array',
    description: '畫面上的表格；沒有就給空陣列',
    items: obj({
      title: str,
      columns: strArr,
      rows: { type: 'array', items: strArr },
    }),
  },
  contacts: {
    type: 'array',
    description: '聯絡資訊；沒有就給空陣列',
    items: obj({ name: str, phone: str, email: str, address: str }),
  },
  unreadable: { ...strArr, description: '看不清楚或無法確定的部分；沒有就給空陣列' },
});

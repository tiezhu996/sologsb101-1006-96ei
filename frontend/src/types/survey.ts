/** 复测：对同一条裂缝按测次追加的读数记录 */
export interface Survey {
  id: string
  crackId: string
  /** 测次序号，从 1 开始 */
  seq: number
  /** 复测日期 YYYY-MM-DD */
  date: string
  widthMm: number
  lengthMm: number
  /** 与上一次测次相比的宽度变化量（mm） */
  deltaWidthMm: number
  /** 复测人 */
  surveyor: string
  createdAt: number
  updatedAt: number
}

/** 复测日期占位：历史记录缺日期时标「待补」，不参与速率与观察判定 */
export const SURVEY_DATE_PENDING = '待补'

export function isPendingDate(date: string | null | undefined): boolean {
  return !date || date.trim().length === 0 || date === SURVEY_DATE_PENDING
}

/** 判断 YYYY-MM-DD 是否为可参与计算的有效日期（「待补」等占位值返回 false） */
export function isValidSurveyDate(date: string | null | undefined): date is string {
  if (isPendingDate(date)) return false
  return /^\d{4}-\d{2}-\d{2}$/.test(date as string) && !Number.isNaN(Date.parse(`${date}T00:00:00`))
}

export interface SurveyDraft {
  crackId: string
  date: string
  widthMm: number
  lengthMm: number
  surveyor: string
}

export const EMPTY_SURVEY_DRAFT: SurveyDraft = {
  crackId: '',
  date: '',
  widthMm: 0,
  lengthMm: 0,
  surveyor: ''
}

/** 单个测次在折线图上的取点 */
export interface SurveyPoint {
  seq: number
  date: string
  widthMm: number
  lengthMm: number
  deltaWidthMm: number
  /** 该测次距上一测次的月均速率（mm/月） */
  rate: number
}

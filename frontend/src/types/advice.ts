/** 整治建议：由裂缝发展速率分级带出，人工确认后下发 */
export type AdviceLevel = '一般' | '较重' | '严重'
export type AdviceMeasure = '观测' | '注浆' | '嵌缝' | '钢板带'
export type AdviceState = '待下发' | '已下发' | '已完成' | '已结案'

export interface Advice {
  id: string
  crackId: string
  level: AdviceLevel
  measure: AdviceMeasure
  /** 判定依据 */
  basis: string
  state: AdviceState
  /**
   * 整治完工日期（YYYY-MM-DD）。
   * 观察测次必须严格晚于该日期；整治前的稳定读数不得充作结案依据。
   * 老数据可能缺日期，缺时页面标「待补」且无法判定结案。
   */
  completedDate?: string
  createdAt: number
  updatedAt: number
}

export const ADVICE_LEVELS: AdviceLevel[] = ['一般', '较重', '严重']
export const ADVICE_MEASURES: AdviceMeasure[] = ['观测', '注浆', '嵌缝', '钢板带']
export const ADVICE_STATES: AdviceState[] = ['待下发', '已下发', '已完成', '已结案']

/** 建议状态机：待下发 → 已下发 → 已完成 → 已结案（结案由完工后观察判定驱动） */
export const ADVICE_STATE_FLOW: Record<AdviceState, AdviceState | null> = {
  待下发: '已下发',
  已下发: '已完成',
  已完成: '已结案',
  已结案: null
}

/** 依据速率等级自动带出的措施建议 */
export const LEVEL_MEASURE_SUGGEST: Record<AdviceLevel, AdviceMeasure> = {
  一般: '观测',
  较重: '嵌缝',
  严重: '钢板带'
}

/** 判断建议是否已进入「完工后观察」阶段（已完成待结案，或已结案） */
export function isPostCompletionState(state: AdviceState): boolean {
  return state === '已完成' || state === '已结案'
}

export interface AdviceDraft {
  crackId: string
  level: AdviceLevel
  measure: AdviceMeasure
  basis: string
  state: AdviceState
  completedDate?: string
}

export const EMPTY_ADVICE_DRAFT: AdviceDraft = {
  crackId: '',
  level: '一般',
  measure: '观测',
  basis: '',
  state: '待下发',
  completedDate: ''
}

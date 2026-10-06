/**
 * 整治后观察与结案判定
 *
 * 口径（必须以「整治建议完工日期」为准，不能按全部历史测次算）：
 * 1. 基线：完工日期之前的最后一次有效读数（完工当天不算观察期）；
 * 2. 观察测次：日期严格晚于完工日期的复测，按日期先后排列；
 * 3. 第一次观察与「完工前最后一次读数」对照，之后依次与上一观察测次对照；
 * 4. 结案条件：连续 3 次增幅均在 [0, 0.05] mm 内（回退即重新累计），
 *    且最新一次月均速率低于预警线；
 * 5. 中途出现回退（负增幅）或速率超线，连续计数清零，从下一次起重新累计；
 * 6. 历史记录缺日期标「待补」：不参与累计，并阻断结案（先补日期再判定）。
 */
import type { Advice } from '@/types/advice'
import type { Survey } from '@/types/survey'
import { isPendingDate, isValidSurveyDate } from '@/types/survey'
import { daysBetween, monthlyRate, RATE_WARNING, round } from '@/utils/rate'

/** 结案所需连续稳定次数 */
export const OBSERVATION_REQUIRED_COUNT = 3
/** 允许的单次最大增幅（mm） */
export const OBSERVATION_MAX_DELTA = 0.05

/** 观察阶段：观察期前 / 待补完工日期 / 观察中 / 可结案 / 已结案 */
export type ObservationPhase = 'before' | 'datePending' | 'watching' | 'canClose' | 'closed'

/** 观察中断原因 */
export type ObservationResetReason = '回退' | '超线' | null

export interface ObservationCheck {
  /** 该观察测次是否满足稳定条件（增幅 0~0.05mm 且速率低于预警线） */
  ok: boolean
  /** 对照上一次读数（基线或上一观察测次）的增幅，mm */
  delta: number
  /** 该测次月均速率，mm/月 */
  rate: number
  /** 不满足时的中断原因 */
  reason: ObservationResetReason
}

export interface ObservationStatus {
  /** 适用阶段（无完工后的建议时为 before） */
  phase: ObservationPhase
  /** 完工日期（空表示缺日期） */
  completedDate: string
  /** 基线读数（完工前最后一次），无则 null */
  baseline: Survey | null
  /** 观察期内测次（严格晚于完工日期，按日期升序；缺日期者排在最后） */
  postSurveys: Survey[]
  /** 各观察测次的判定结果，与 postSurveys 等长 */
  checks: ObservationCheck[]
  /** 当前尾部连续稳定次数（遇回退/超线即清零重累计） */
  streak: number
  /** 距结案还差的稳定次数 */
  remaining: number
  /** 最新一次观察测次的速率（mm/月），无观察测次时为 0 */
  latestRate: number
  /** 观察期内缺日期（待补）的测次数 */
  missingDateCount: number
  /** 是否满足结案条件 */
  canClose: boolean
  /** 最近一次中断原因（尾段非稳定时给出） */
  lastResetReason: ObservationResetReason
  /** 供页面直接展示的判定文案 */
  statusText: string
}

interface DatedSurvey {
  survey: Survey
  date: string
}

/** 结案速率是否低于预警线（0.10 mm/月） */
export function isRateBelowWarning(rate: number): boolean {
  return rate < RATE_WARNING
}

/** 增幅是否在允许的稳定区间内（回退为负值，按中断处理） */
export function isStableDelta(delta: number): boolean {
  return delta >= 0 && delta <= OBSERVATION_MAX_DELTA
}

function emptyStatus(phase: ObservationPhase, completedDate = ''): ObservationStatus {
  return {
    phase,
    completedDate,
    baseline: null,
    postSurveys: [],
    checks: [],
    streak: 0,
    remaining: phase === 'datePending' ? OBSERVATION_REQUIRED_COUNT : OBSERVATION_REQUIRED_COUNT,
    latestRate: 0,
    missingDateCount: 0,
    canClose: false,
    lastResetReason: null,
    statusText: ''
  }
}

/**
 * 评估一条「完工后」建议的观察状态。
 * 调用方需保证 advice 已完工（state 为「已完成」或「已结案」）。
 */
export function evaluateObservation(advice: Advice, surveys: Survey[]): ObservationStatus {
  const closed = advice.state === '已结案'
  const completedDate = advice.completedDate ?? ''
  if (!isValidSurveyDate(completedDate)) {
    const status = emptyStatus('datePending')
    status.statusText = '完工日期待补：补齐完工日期后才能划分观察起点'
    return status
  }

  const valid: DatedSurvey[] = []
  surveys.forEach((survey) => {
    if (isPendingDate(survey.date)) return // 缺日期记录稍后按测次序号定位
    if (isValidSurveyDate(survey.date)) valid.push({ survey, date: survey.date })
  })
  valid.sort((a, b) => (a.date === b.date ? a.survey.seq - b.survey.seq : a.date < b.date ? -1 : 1))

  // 基线：完工日期之前（严格）的最后一次有效读数
  let baseline: Survey | null = null
  for (const item of valid) {
    if (item.date < completedDate) baseline = item.survey
    else break
  }

  // 观察测次：严格晚于完工日期；缺日期的旧记录无法定位，按测次序号判断是否可能落入观察期：
  // 序号大于基线（完工前最后一测次）的缺日期记录视为观察期内「待补」，阻断结案；
  // 更早的老记录只做日期待补展示，不阻断。
  const postDated = valid.filter((item) => item.date > completedDate)
  const baselineSeq = baseline?.seq ?? 0
  const pendingSurveys = surveys
    .filter((survey) => isPendingDate(survey.date) && survey.seq > baselineSeq)
    .sort((a, b) => a.seq - b.seq)
  const missingDateCount = pendingSurveys.length
  const postSurveys = postDated.map((item) => item.survey)
  pendingSurveys.forEach((survey) => postSurveys.push(survey))

  const checks: ObservationCheck[] = []
  let previous = baseline
  let streak = 0
  let lastResetReason: ObservationResetReason = null

  const datedChecks: ObservationCheck[] = []
  postDated.forEach(({ survey, date }) => {
    let check: ObservationCheck
    if (!previous) {
      // 无基线时无法对照（不允许用更早的历史读数充数），该测次不计入稳定序列
      check = { ok: false, delta: 0, rate: 0, reason: null }
      previous = survey
    } else {
      const delta = round(survey.widthMm - previous.widthMm, 2)
      const rate = monthlyRate(delta, daysBetween(previous.date, date))
      let ok = false
      let reason: ObservationResetReason = null
      if (delta < 0) reason = '回退'
      else if (!isStableDelta(delta)) reason = '超线'
      else if (!isRateBelowWarning(rate)) reason = '超线'
      if (reason === null) {
        ok = true
        streak += 1
      } else {
        streak = 0
        lastResetReason = reason
      }
      check = { ok, delta, rate, reason }
      previous = survey
    }
    datedChecks.push(check)
    checks.push(check)
  })
  // 缺日期测次不参与累计，仅占位与列表对齐（reason 保留 null，页面显式标「待补」）
  pendingSurveys.forEach(() => checks.push({ ok: false, delta: 0, rate: 0, reason: null }))

  // 最新速率只取有日期的观察测次，不能被「待补」占位项置 0
  const latestRate = datedChecks.length > 0 ? datedChecks[datedChecks.length - 1].rate : 0
  // 缺日期记录阻断结案：防止未定位的测次藏在观察期内
  const canClose =
    baseline !== null &&
    postDated.length > 0 &&
    missingDateCount === 0 &&
    streak >= OBSERVATION_REQUIRED_COUNT &&
    isRateBelowWarning(latestRate)

  let phase: ObservationPhase
  if (closed) phase = 'closed'
  else if (canClose) phase = 'canClose'
  else phase = 'watching'

  const status: ObservationStatus = {
    phase,
    completedDate,
    baseline,
    postSurveys,
    checks,
    streak,
    remaining: Math.max(OBSERVATION_REQUIRED_COUNT - streak, 0),
    latestRate,
    missingDateCount,
    canClose,
    lastResetReason,
    statusText: ''
  }
  status.statusText = buildStatusText(status)
  return status
}

function buildStatusText(status: ObservationStatus): string {
  if (status.phase === 'closed') return '已结案：完工后连续三次稳定观察通过'
  if (status.phase === 'canClose') return '满足结案条件：连续三次增幅 ≤ 0.05 mm 且最新速率低于预警线，可结案'
  if (status.missingDateCount > 0) return `观察期内有 ${status.missingDateCount} 次复测日期待补，补齐后重新判定`
  if (!status.baseline) return '缺少完工前最后一次读数作为对照基线，无法开始观察累计'
  if (status.postSurveys.length === 0) return '完工后尚无复测，第一次复测将对照完工前最后一次读数'
  if (status.streak === 0 && status.lastResetReason) {
    return `${status.lastResetReason === '回退' ? '读数回退' : '增幅或速率超线'}，连续稳定计数已清零，还差 ${OBSERVATION_REQUIRED_COUNT} 次`
  }
  if (!isRateBelowWarning(status.latestRate)) {
    return `最新月均速率 ${status.latestRate.toFixed(3)} mm/月 未低于预警线 ${RATE_WARNING} mm/月，还差 ${status.remaining} 次`
  }
  if (status.streak < OBSERVATION_REQUIRED_COUNT) {
    return `已连续稳定 ${status.streak} 次，还差 ${status.remaining} 次（每次增幅 ≤ 0.05 mm）`
  }
  return '观察累计中'
}

/** 列表页一行展示的简短观察文案 */
export function observationBadgeText(status: ObservationStatus | null): string {
  if (!status) return ''
  switch (status.phase) {
    case 'before':
      return ''
    case 'datePending':
      return '完工日期待补'
    case 'watching':
      if (status.missingDateCount > 0) return `观察中 · ${status.missingDateCount} 次日期待补`
      if (status.streak === 0 && status.lastResetReason) return `观察中 · ${status.lastResetReason}重计 · 还差3次`
      return `观察中 · 已稳定${status.streak}次 · 还差${status.remaining}次`
    case 'canClose':
      return '可结案'
    case 'closed':
      return '已结案'
  }
}

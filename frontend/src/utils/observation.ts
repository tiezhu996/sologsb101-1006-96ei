/**
 * 整治完工后观察期判定
 *
 * 口径（务必以「整治建议完工日期」为观察起点，不能按全部历史测次起算）：
 * 1. 首次对照「完工日期之前最后一次有效读数」作为基准；
 * 2. 完工日期之后的测次依次与上一次读数比对，单次增幅 ≤ 0.05 mm
 *    且该测次月均速率 < 预警线（0.10 mm/月）记一次稳定；
 * 3. 连续三次稳定且最新速率低于预警线才可结案；
 * 4. 中途出现回退反弹（增幅 > 0.05 mm）或速率超线，已累计次数清零重新计数；
 * 5. 旧的已完成建议缺完工日期时标「待补」，不得用整治前稳定读数充数。
 */
import type { Survey } from '@/types/survey'
import type { AdviceState } from '@/types/advice'
import { daysBetween, monthlyRate, RATE_WARNING, round } from '@/utils/rate'

/** 连续稳定读数允许的单次最大增幅（mm） */
export const STABLE_DELTA_MAX = 0.05
/** 结案所需连续稳定测次次数 */
export const OBSERVATION_REQUIRED_COUNT = 3

/** 观察期所处阶段 */
export type ObservationPhase = '未完工' | '待补日期' | '缺基准' | '观察中' | '可结案'

/** 观察期内的单个测次（首个与完工前基准比对） */
export interface ObservationPoint {
  seq: number
  date: string
  widthMm: number
  /** 与上一次观察读数（首个为完工前基准）的宽度差 */
  deltaWidthMm: number
  /** 月均速率（mm/月） */
  rate: number
  /** 本次是否满足稳定条件 */
  stable: boolean
}

/** 完工前基准读数 */
export interface ObservationBaseline {
  seq: number
  date: string
  widthMm: number
}

export interface ObservationStatus {
  phase: ObservationPhase
  /** 实际起算的完工日期 */
  finishedAt: string
  /** 完工前最后一次读数（观察基准） */
  baseline: ObservationBaseline | null
  /** 完工后观察测次 */
  points: ObservationPoint[]
  /** 当前连续稳定次数（回退或超线后归零） */
  stableStreak: number
  /** 距结案还差的连续稳定次数 */
  remaining: number
  /** 缺日期无法参与判定的旧测次数量 */
  invalidDateCount: number
  /** 最近一次重新累计的原因 */
  lastResetReason: string | null
  /** 是否满足结案条件 */
  canClose: boolean
  /** 简短状态文案 */
  label: string
  /** 详细说明文案 */
  hint: string
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`))
}

interface EvaluateParams {
  /** 建议当前状态：仅「已完成」进入观察期判定 */
  state?: AdviceState | null
  /** 整治完工日期 YYYY-MM-DD，缺失或非法时标待补 */
  finishedAt?: string
  surveys: Survey[]
}

/**
 * 按完工日期评估观察期累计情况。
 * 纯函数，供 surveyStore / useCrackTrend / CSV 导出共用。
 */
export function evaluateObservation(params: EvaluateParams): ObservationStatus | null {
  const { state, finishedAt, surveys } = params

  const base: Omit<ObservationStatus, 'phase' | 'label' | 'hint'> = {
    finishedAt: isValidDateString(finishedAt) ? finishedAt : '',
    baseline: null,
    points: [],
    stableStreak: 0,
    remaining: OBSERVATION_REQUIRED_COUNT,
    invalidDateCount: 0,
    lastResetReason: null,
    canClose: false
  }

  // 建议尚未完成：整治未完工，谈不上观察期
  if (state !== '已完成') {
    return {
      ...base,
      phase: '未完工',
      label: '未到观察期',
      hint: '建议流转为「已完成」并登记完工日期后，从完工后测次开始累计观察。'
    }
  }

  // 旧记录缺完工日期：标待补，禁止用历史测次倒推起点
  if (!isValidDateString(finishedAt)) {
    return {
      ...base,
      phase: '待补日期',
      label: '完工日期待补',
      hint: '该建议已完成但漏填完工日期，观察起点无法确定，请先补填完工日期。'
    }
  }

  const finish = finishedAt as string
  const dated = surveys.filter((survey) => isValidDateString(survey.date))
  const sorted = [...dated].sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date.localeCompare(b.date)))

  // 完工前最后一次读数为基准（严格早于完工日期，完工当日读数不计入）
  const before = sorted.filter((survey) => survey.date < finish)
  const baselineRow = before.length > 0 ? before[before.length - 1] : null
  const after = sorted.filter((survey) => survey.date > finish)

  const invalidDateCount = surveys.length - dated.length

  if (!baselineRow) {
    return {
      ...base,
      finishedAt: finish,
      invalidDateCount,
      phase: '缺基准',
      label: '缺完工前基准',
      hint: `完工日期 ${finish} 之前没有有效复测读数，无法确定对照基准，请补测完工前末次读数。`
    }
  }

  const baseline: ObservationBaseline = {
    seq: baselineRow.seq,
    date: baselineRow.date,
    widthMm: baselineRow.widthMm
  }

  const points: ObservationPoint[] = []
  let streak = 0
  let lastResetReason: string | null = null
  let previous = baseline

  after.forEach((survey) => {
    const delta = round(survey.widthMm - previous.widthMm, 2)
    const rate = monthlyRate(delta, daysBetween(previous.date, survey.date))
    const reasons: string[] = []
    if (delta > STABLE_DELTA_MAX) reasons.push(`增幅 ${delta.toFixed(2)} mm 超过 ${STABLE_DELTA_MAX.toFixed(2)} mm`)
    if (rate >= RATE_WARNING) reasons.push(`月均速率 ${rate.toFixed(3)} mm/月 达到预警线`)
    const stable = reasons.length === 0
    if (stable) {
      streak += 1
    } else {
      streak = 0
      lastResetReason = `第 ${survey.seq} 测次${reasons.join('，')}，连续稳定次数重新累计`
    }
    points.push({ seq: survey.seq, date: survey.date, widthMm: survey.widthMm, deltaWidthMm: delta, rate, stable })
    previous = { seq: survey.seq, date: survey.date, widthMm: survey.widthMm }
  })

  const latest = points.length > 0 ? points[points.length - 1] : null
  const canClose = streak >= OBSERVATION_REQUIRED_COUNT && !!latest && latest.stable && latest.rate < RATE_WARNING
  const remaining = Math.max(OBSERVATION_REQUIRED_COUNT - streak, 0)

  if (canClose) {
    return {
      finishedAt: finish,
      baseline,
      points,
      stableStreak: streak,
      remaining: 0,
      invalidDateCount,
      lastResetReason,
      canClose: true,
      phase: '可结案',
      label: '满足结案条件',
      hint: `以 ${finish} 完工后复测观察，已连续 ${streak} 次增幅不超过 ${STABLE_DELTA_MAX.toFixed(2)} mm，最新速率 ${latest!.rate.toFixed(3)} mm/月 低于预警线，可结案。`
    }
  }

  let hint: string
  if (points.length === 0) {
    hint = `首次应对照完工前末次读数（${baseline.date}，${baseline.widthMm.toFixed(2)} mm），完工后尚无复测，需连续 ${OBSERVATION_REQUIRED_COUNT} 次稳定读数。`
  } else if (lastResetReason) {
    hint = `${lastResetReason}；当前连续稳定 ${streak}/${OBSERVATION_REQUIRED_COUNT}，还差 ${remaining} 次。`
  } else {
    hint = `当前连续稳定 ${streak}/${OBSERVATION_REQUIRED_COUNT}，还差 ${remaining} 次（单次增幅 ≤ ${STABLE_DELTA_MAX.toFixed(2)} mm 且月均速率 < ${RATE_WARNING.toFixed(2)} mm/月）。`
  }

  return {
    finishedAt: finish,
    baseline,
    points,
    stableStreak: streak,
    remaining,
    invalidDateCount,
    lastResetReason,
    canClose: false,
    phase: '观察中',
    label: `观察中 ${streak}/${OBSERVATION_REQUIRED_COUNT}`,
    hint
  }
}

/** 观察阶段对应的 Element Plus 标签语义色 */
export function observationTone(phase: ObservationPhase): 'success' | 'warning' | 'info' | 'primary' {
  switch (phase) {
    case '可结案':
      return 'success'
    case '观察中':
      return 'primary'
    case '待补日期':
    case '缺基准':
      return 'warning'
    case '未完工':
    default:
      return 'info'
  }
}

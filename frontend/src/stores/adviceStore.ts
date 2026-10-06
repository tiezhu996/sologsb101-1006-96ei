/**
 * 整治建议状态（Pinia）
 * 维护建议草稿、状态流转（含完工日期）与完工后观察结案判定。
 * 观察判定口径见 utils/observation.ts：必须以完工日期为观察起点。
 */
import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type AdviceRow } from '@/utils/db'
import {
  ADVICE_STATE_FLOW,
  isPostCompletionState,
  type Advice,
  type AdviceDraft
} from '@/types/advice'
import { evaluateObservation, type ObservationStatus } from '@/utils/observation'
import { isPendingDate } from '@/types/survey'
import { useSurveyStore } from '@/stores/surveyStore'

/** 观察判定结果缓存：crackId -> 完工后建议的观察状态 */
export type ObservationMap = Record<string, ObservationStatus>

export function draftOf(advice: Advice): AdviceDraft {
  return {
    crackId: advice.crackId,
    level: advice.level,
    measure: advice.measure,
    basis: advice.basis,
    state: advice.state,
    completedDate: advice.completedDate ?? ''
  }
}

export const useAdviceStore = defineStore('advice', () => {
  const adviceTable = useIdbTable<AdviceRow>((database) => database.advices, { sortByUpdatedAt: false })
  const surveyStore = useSurveyStore()

  const advices = computed<AdviceRow[]>(() => adviceTable.rows.value)

  function adviceOf(crackId: string): AdviceRow | null {
    return adviceTable.rows.value.find((row) => row.crackId === crackId) ?? null
  }

  function getById(id: string): AdviceRow | null {
    return adviceTable.rows.value.find((row) => row.id === id) ?? null
  }

  /**
   * 完工后观察判定映射（每条裂缝至多一条建议）。
   * 仅对「已完成 / 已结案」的建议求值，并实时关联复测测次。
   */
  const observationMap = computed<ObservationMap>(() => {
    const map: ObservationMap = {}
    adviceTable.rows.value.forEach((advice) => {
      if (!isPostCompletionState(advice.state)) return
      map[advice.crackId] = evaluateObservation(advice, surveyStore.surveysOf(advice.crackId))
    })
    return map
  })

  function observationOf(crackId: string): ObservationStatus | null {
    return observationMap.value[crackId] ?? null
  }

  /** 已结案数（统计徽标使用） */
  const closedCount = computed(() => adviceTable.rows.value.filter((item) => item.state === '已结案').length)
  /** 已完工待结案数 */
  const completedCount = computed(() => adviceTable.rows.value.filter((item) => item.state === '已完成').length)

  /**
   * 保存建议（新建或编辑）。
   * 进入完工阶段必须带完工日期；缺日期时阻止并给出原因。
   * @returns 错误信息，null 表示保存成功
   */
  async function saveAdvice(editingId: string | null, draft: AdviceDraft): Promise<string | null> {
    const completedDate = draft.completedDate?.trim() || undefined
    if (isPostCompletionState(draft.state) && (!completedDate || isPendingDate(completedDate))) {
      return '状态为「已完成 / 已结案」时必须先填写整治完工日期，否则无法确定观察起点'
    }
    if (editingId) {
      await adviceTable.update(editingId, {
        crackId: draft.crackId,
        level: draft.level,
        measure: draft.measure,
        basis: draft.basis.trim(),
        state: draft.state,
        completedDate
      })
      // 退回未完工阶段时清空观察起点，避免旧完工日期污染下一轮观察
      if (!isPostCompletionState(draft.state)) {
        await db.advices.update(editingId, { completedDate: undefined })
      }
    } else {
      await adviceTable.create(
        {
          crackId: draft.crackId,
          level: draft.level,
          measure: draft.measure,
          basis: draft.basis.trim(),
          state: draft.state,
          completedDate
        },
        'ad'
      )
    }
    return null
  }

  async function removeAdvice(id: string): Promise<void> {
    await adviceTable.remove(id)
  }

  /** 推进到下一状态；「已下发 → 已完成」必须提供完工日期，「已完成 → 已结案」走观察判定 */
  async function advanceState(advice: AdviceRow, completedDate?: string): Promise<string | null> {
    const next = ADVICE_STATE_FLOW[advice.state]
    if (!next) return '该建议已结案闭环'
    if (next === '已完成') {
      const date = (completedDate ?? '').trim()
      if (!date || isPendingDate(date)) return '请先填写整治完工日期，复测观察按完工日期起算'
      await adviceTable.update(advice.id, { state: next, completedDate: date })
      return null
    }
    if (next === '已结案') {
      return closeAdvice(advice.id)
    }
    await adviceTable.update(advice.id, { state: next })
    return null
  }

  /**
   * 结案：仅当完工后连续三次增幅稳定且最新速率低于预警线。
   * @returns 错误信息，null 表示结案成功
   */
  async function closeAdvice(id: string): Promise<string | null> {
    const advice = getById(id)
    if (!advice) return '建议不存在'
    if (advice.state === '已结案') return null
    if (!isPostCompletionState(advice.state)) return '建议尚未完工，不能结案'
    const status = observationOf(advice.crackId)
    if (!status) return '观察状态尚未就绪，稍后再试'
    if (status.phase === 'datePending') return '完工日期待补：补齐完工日期后才能划分观察起点'
    if (status.missingDateCount > 0) return `观察期内有 ${status.missingDateCount} 次复测日期待补，补齐后重新判定`
    if (!status.baseline) return '缺少完工前最后一次读数作为对照基线，不能用更早的历史读数充数'
    if (!status.canClose) return `尚不满足结案条件：${status.statusText}`
    await adviceTable.update(id, { state: '已结案' })
    return null
  }

  /** 补录完工日期（老建议已完工但缺日期） */
  async function patchCompletedDate(id: string, completedDate: string): Promise<string | null> {
    const advice = getById(id)
    if (!advice) return '建议不存在'
    const date = completedDate.trim()
    if (!date || isPendingDate(date)) return '请填写有效的完工日期'
    await adviceTable.update(id, { completedDate: date })
    return null
  }

  return {
    adviceTable,
    advices,
    observationMap,
    closedCount,
    completedCount,
    adviceOf,
    getById,
    observationOf,
    draftOf,
    saveAdvice,
    removeAdvice,
    advanceState,
    closeAdvice,
    patchCompletedDate
  }
})

/** 页面可直接调用的即时评估（脱离 store 缓存时使用） */
export async function fetchObservation(crackId: string): Promise<ObservationStatus | null> {
  const advice = await db.advices.where('crackId').equals(crackId).first()
  if (!advice || !isPostCompletionState(advice.state)) return null
  const surveys = await db.surveys.where('crackId').equals(crackId).toArray()
  return evaluateObservation(advice, surveys)
}
